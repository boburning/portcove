import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = JSON.parse(
  readFileSync(path.join(root, ".github/roadmap.json"), "utf8"),
).repository;

export function validateGitHubBody(body) {
  if (typeof body !== "string" || !body.trim())
    throw new Error("GitHub body must be nonempty text");
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    const invalid =
      code === 13
        ? body.charCodeAt(index + 1) !== 10
        : code === 127 || (code < 32 && code !== 9 && code !== 10);
    if (invalid) throw new Error(`Unexpected control character at text offset ${index}`);
  }
  // JSON/string input also must not contain malformed Unicode surrogate pairs.
  if (!body.isWellFormed()) throw new Error("GitHub body contains malformed Unicode");
  return body;
}

export function readGitHubBody(file) {
  return validateGitHubBody(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)));
}

function targetNumber(target, type) {
  if (/^[1-9]\d*$/u.test(String(target))) return Number(target);
  const prefix = `https://github.com/${repository}/${type === "pr" ? "pull" : "issues"}/`;
  if (
    typeof target === "string" &&
    target.startsWith(prefix) &&
    /^[1-9]\d*$/u.test(target.slice(prefix.length))
  )
    return Number(target.slice(prefix.length));
  throw new Error("Target must identify an issue/PR in the configured repository");
}

export function writeGitHubBody(options, api = new GitHubApiClient()) {
  const { operation, body, previousBody, target, title, head, base } = options;
  validateGitHubBody(body);
  if (!["issue-edit", "issue-comment", "pr-edit", "pr-comment", "pr-create"].includes(operation))
    throw new Error("Unsupported GitHub body operation");
  const prefix = `repos/${repository}`;
  let before = null;
  let result;
  let endpoint;
  if (operation === "pr-create") {
    for (const value of [title, head, base]) validateGitHubBody(value);
    result = api.request("POST", `${prefix}/pulls`, { title, head, base, body }).body;
    options.observe?.({ phase: "mutation", result });
    if (!Number.isSafeInteger(result?.number) || result.number < 1)
      throw new Error("Created PR identity unavailable; do not retry automatically");
    endpoint = `${prefix}/pulls/${result.number}`;
  } else {
    const number = targetNumber(target, operation.startsWith("pr-") ? "pr" : "issue");
    if (!Number.isSafeInteger(number)) throw new Error("Invalid target number");
    const item = `${prefix}/${operation.startsWith("pr-") ? "pulls" : "issues"}/${number}`;
    before = api.request("GET", item).body;
    options.observe?.({ phase: "preimage", result: before });
    if (!Number.isSafeInteger(before?.id) || before.number !== number)
      throw new Error("Target identity unavailable");
    if (operation.endsWith("edit")) {
      if (typeof previousBody !== "string") throw new Error("Edits require --previous-body-file");
      if ((before.body ?? "") !== previousBody)
        throw new Error("Remote body changed; refresh the preimage before editing");
      result = api.request("PATCH", item, { body }).body;
      options.observe?.({ phase: "mutation", result });
      if (result?.id !== before.id)
        throw new Error("Mutation identity mismatch; reconcile before retrying");
      endpoint = item;
    } else {
      result = api.request("POST", `${prefix}/issues/${number}/comments`, { body }).body;
      options.observe?.({ phase: "mutation", result });
      if (!Number.isSafeInteger(result?.id) || result.id < 1)
        throw new Error("Comment identity unavailable; do not retry automatically");
      endpoint = `${prefix}/issues/comments/${result.id}`;
    }
  }
  const observed = api.request("GET", endpoint).body;
  options.observe?.({ phase: "readback", result: observed });
  if (observed?.id !== result?.id || observed?.body !== body)
    throw new Error("GitHub body readback mismatch; reconcile before retrying");
  return {
    operation,
    url: observed.html_url,
    id: observed.id,
    number: observed.number ?? null,
    verified: true,
  };
}

export function parseBodyArguments(argv) {
  const [operation, ...args] = argv;
  const options = { operation };
  const allowed = new Set([
    "--body-file",
    "--previous-body-file",
    "--target",
    "--title",
    "--head",
    "--base",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.has(key) || Object.hasOwn(options, key) || !args[index + 1])
      throw new Error("Invalid or duplicate GitHub body option");
    options[key] = args[index + 1];
  }
  if (!options["--body-file"]) throw new Error("--body-file is required");
  if (
    operation !== "check" &&
    !["issue-edit", "issue-comment", "pr-edit", "pr-comment", "pr-create"].includes(operation)
  )
    throw new Error("Unknown operation");
  const keys =
    operation === "check"
      ? ["--body-file"]
      : operation === "pr-create"
        ? ["--body-file", "--title", "--head", "--base"]
        : [
            "--body-file",
            "--target",
            ...(operation.endsWith("edit") ? ["--previous-body-file"] : []),
          ];
  if (
    keys.some((key) => !options[key]) ||
    Object.keys(options).some((key) => key !== "operation" && !keys.includes(key))
  )
    throw new Error("Missing or unexpected options for body operation");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let evidence = null;
  try {
    if (["--help", "help"].includes(process.argv[2])) {
      console.log(
        "usage: github-body.mjs check --body-file FILE\n  github-body.mjs issue-edit|pr-edit --target NUMBER_OR_URL --body-file FILE --previous-body-file FILE\n  github-body.mjs issue-comment|pr-comment --target NUMBER_OR_URL --body-file FILE\n  github-body.mjs pr-create --title TITLE --head BRANCH --base BRANCH --body-file FILE",
      );
    } else {
      const options = parseBodyArguments(process.argv.slice(2));
      const body = readGitHubBody(options["--body-file"]);
      if (options.operation === "check") console.log("GitHub body is valid UTF-8 Markdown text.");
      else {
        const previousBody = options["--previous-body-file"]
          ? new TextDecoder("utf-8", { fatal: true }).decode(
              readFileSync(options["--previous-body-file"]),
            )
          : undefined;
        evidence = path.join(root, "work/github-body", randomUUID());
        mkdirSync(evidence, { recursive: true });
        writeFileSync(path.join(evidence, "candidate.md"), body, { flag: "wx" });
        if (previousBody !== undefined)
          writeFileSync(path.join(evidence, "preimage.md"), previousBody, { flag: "wx" });
        const result = writeGitHubBody({
          operation: options.operation,
          body,
          previousBody,
          target: options["--target"],
          title: options["--title"],
          head: options["--head"],
          base: options["--base"],
          observe: (observation) =>
            writeFileSync(
              path.join(evidence, `${observation.phase}.json`),
              JSON.stringify(observation),
              { flag: "wx" },
            ),
        });
        writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result), { flag: "wx" });
        console.log(JSON.stringify({ ...result, evidence }));
      }
    }
  } catch (error) {
    const safe = sanitizeOperationError(error);
    if (evidence) {
      try {
        writeFileSync(
          path.join(evidence, "error.json"),
          JSON.stringify({
            ...safe,
            next_action:
              "Reconcile remote state before retrying; no automatic retry was attempted.",
          }),
          { flag: "wx" },
        );
      } catch {
        /* Original failure remains visible. */
      }
    }
    console.error(`${safe.message}${evidence ? `; evidence: ${evidence}` : ""}`);
    process.exitCode = 1;
  }
}
