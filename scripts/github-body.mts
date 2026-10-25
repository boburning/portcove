import { validateGitHubBody } from "./github-body-text.mts";
import { isRoadmapSpecification, validateLiveRoadmapReplacement } from "./roadmap-authoring.mts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { checkClosureIntent, readClosingRelationships } from "./closure-intent.mts";
import { isRecord } from "./runtime-values.mts";
import config from "../.github/roadmap.json" with { type: "json" };

export interface BodyObservation {
  phase: "mutation" | "preimage" | "closure-preimage" | "readback" | "closure-readback";
  result: unknown;
}
export interface BodyWriteOptions {
  operation: string;
  body: unknown;
  previousBody?: unknown;
  target?: unknown;
  title?: unknown;
  head?: unknown;
  base?: unknown;
  closureIntent?: unknown;
  observe?: (observation: BodyObservation) => void;
}
export interface BodyApi {
  request(method: string, endpoint: string, payload?: unknown): { body: unknown };
  validateRoadmapReplacement?: (number: number, previousBody: string, body: string) => void;
  graphql?: Parameters<typeof readClosingRelationships>[0]["graphql"];
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function closingRelationships(api: BodyApi, number: unknown) {
  if (!api.graphql || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("PR closure identity or reader is unavailable; reconcile before retrying");
  return readClosingRelationships(
    {
      graphql: (query, variables) => {
        if (!api.graphql) throw new Error("PR closure reader became unavailable");
        return api.graphql(query, variables);
      },
    },
    repository,
    number,
  );
}
function readClosureIntent(file: string): unknown {
  return JSON.parse(readGitHubBody(file));
}
function headSha(item: Record<string, unknown>): unknown {
  return isRecord(item.head) ? item.head.sha : undefined;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = config.repository;

export { validateGitHubBody } from "./github-body-text.mts";

export function readGitHubBody(file: string) {
  return validateGitHubBody(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)));
}

function targetNumber(target: unknown, type: "pr" | "issue") {
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

export function writeGitHubBody(options: BodyWriteOptions, api: BodyApi = new GitHubApiClient()) {
  const { operation, previousBody, target, title, head, base } = options;
  const body = validateGitHubBody(options.body);
  if (["pr-create", "pr-edit"].includes(operation))
    checkClosureIntent(options.closureIntent, { repository, texts: [body] });
  if (!["issue-edit", "issue-comment", "pr-edit", "pr-comment", "pr-create"].includes(operation))
    throw new Error("Unsupported GitHub body operation");
  const prefix = `repos/${repository}`;
  let result: unknown;
  let endpoint: string;
  if (operation === "pr-create") {
    for (const value of [title, head, base]) validateGitHubBody(value);
    result = api.request("POST", `${prefix}/pulls`, { title, head, base, body }).body;
    options.observe?.({ phase: "mutation", result });
    if (!isRecord(result) || !positiveId(result.id) || !positiveId(result.number))
      throw new Error("Created PR identity unavailable; do not retry automatically");
    endpoint = `${prefix}/pulls/${result.number}`;
  } else {
    const number = targetNumber(target, operation.startsWith("pr-") ? "pr" : "issue");
    if (!Number.isSafeInteger(number)) throw new Error("Invalid target number");
    const item = `${prefix}/${operation.startsWith("pr-") ? "pulls" : "issues"}/${number}`;
    const before = api.request("GET", item).body;
    options.observe?.({ phase: "preimage", result: before });
    if (!isRecord(before) || !positiveId(before.id) || before.number !== number)
      throw new Error("Target identity unavailable");
    if (operation.endsWith("edit")) {
      if (typeof previousBody !== "string") throw new Error("Edits require --previous-body-file");
      if ((before.body ?? "") !== previousBody)
        throw new Error("Remote body changed; refresh the preimage before editing");
      if (operation === "issue-edit" && isRoadmapSpecification(before))
        (api.validateRoadmapReplacement ?? validateLiveRoadmapReplacement)(
          number,
          previousBody,
          body,
        );
      if (operation === "pr-edit") {
        const closing = closingRelationships(api, number);
        options.observe?.({ phase: "closure-preimage", result: closing });
        if (closing.body !== previousBody || closing.head !== headSha(before))
          throw new Error("Remote PR closure preimage changed; refresh before editing");
        checkClosureIntent(options.closureIntent, {
          repository,
          texts: [body],
          relationships: closing.relationships,
        });
      }
      result = api.request("PATCH", item, { body }).body;
      options.observe?.({ phase: "mutation", result });
      if (!isRecord(result) || result.id !== before.id)
        throw new Error("Mutation identity mismatch; reconcile before retrying");
      endpoint = item;
    } else {
      result = api.request("POST", `${prefix}/issues/${number}/comments`, { body }).body;
      options.observe?.({ phase: "mutation", result });
      if (!isRecord(result) || !positiveId(result.id))
        throw new Error("Comment identity unavailable; do not retry automatically");
      endpoint = `${prefix}/issues/comments/${result.id}`;
    }
  }
  const observed = api.request("GET", endpoint).body;
  options.observe?.({ phase: "readback", result: observed });
  if (
    !isRecord(observed) ||
    !positiveId(observed.id) ||
    !isRecord(result) ||
    observed.id !== result.id ||
    observed.body !== body
  )
    throw new Error("GitHub body readback mismatch; reconcile before retrying");
  if (["pr-create", "pr-edit"].includes(operation)) {
    const closing = closingRelationships(api, observed.number);
    options.observe?.({ phase: "closure-readback", result: closing });
    if (closing.body !== body || closing.head !== headSha(observed))
      throw new Error("PR closure readback changed; reconcile before retrying");
    checkClosureIntent(options.closureIntent, {
      repository,
      texts: [body],
      relationships: closing.relationships,
    });
  }
  const url = observed.html_url;
  const number = observed.number;
  if (
    (url !== undefined && typeof url !== "string") ||
    (number !== undefined && number !== null && !positiveId(number))
  )
    throw new Error("GitHub body response metadata is invalid; reconcile before retrying");
  return {
    operation,
    url,
    id: observed.id,
    number: number ?? null,
    verified: true,
  };
}

export function parseBodyArguments(
  argv: readonly string[],
): Record<string, string | undefined> & { operation: string; "--body-file": string } {
  const [operation, ...args] = argv;
  const options: Record<string, string | undefined> & { operation?: string } =
    operation === undefined ? {} : { operation };
  const allowed = new Set([
    "--body-file",
    "--previous-body-file",
    "--target",
    "--title",
    "--head",
    "--base",
    "--closure-intent-file",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || Object.hasOwn(options, key) || !value)
      throw new Error("Invalid or duplicate GitHub body option");
    options[key] = value;
  }
  if (!options["--body-file"]) throw new Error("--body-file is required");
  if (
    operation !== "check" &&
    !["issue-edit", "issue-comment", "pr-edit", "pr-comment", "pr-create"].includes(operation ?? "")
  )
    throw new Error("Unknown operation");
  const keys =
    operation === "check"
      ? ["--body-file"]
      : operation === "pr-create"
        ? ["--body-file", "--title", "--head", "--base", "--closure-intent-file"]
        : [
            "--body-file",
            "--target",
            ...(operation?.endsWith("edit") ? ["--previous-body-file"] : []),
            ...(operation === "pr-edit" ? ["--closure-intent-file"] : []),
          ];
  if (
    keys.some((key) => !options[key]) ||
    Object.keys(options).some((key) => key !== "operation" && !keys.includes(key))
  )
    throw new Error("Missing or unexpected options for body operation");
  return { ...options, operation: operation ?? "", "--body-file": options["--body-file"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let evidence: string | null = null;
  try {
    if (["--help", "help"].includes(process.argv[2] ?? "")) {
      console.log(
        "usage: github-body.mts check --body-file FILE\n  github-body.mts issue-edit|pr-edit --target NUMBER_OR_URL --body-file FILE --previous-body-file FILE [--closure-intent-file FILE (required for pr-edit)]\n  github-body.mts issue-comment|pr-comment --target NUMBER_OR_URL --body-file FILE\n  github-body.mts pr-create --title TITLE --head BRANCH --base BRANCH --body-file FILE --closure-intent-file FILE",
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
        const evidenceDirectory = path.join(root, "work/github-body", randomUUID());
        evidence = evidenceDirectory;
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(path.join(evidenceDirectory, "candidate.md"), body, { flag: "wx" });
        if (previousBody !== undefined)
          writeFileSync(path.join(evidenceDirectory, "preimage.md"), previousBody, { flag: "wx" });
        const result = writeGitHubBody({
          operation: options.operation,
          body,
          previousBody,
          target: options["--target"],
          title: options["--title"],
          head: options["--head"],
          base: options["--base"],
          closureIntent: options["--closure-intent-file"]
            ? readClosureIntent(options["--closure-intent-file"])
            : undefined,
          observe: (observation) =>
            writeFileSync(
              path.join(evidenceDirectory, `${observation.phase}.json`),
              JSON.stringify(observation),
              { flag: "wx" },
            ),
        });
        writeFileSync(path.join(evidenceDirectory, "result.json"), JSON.stringify(result), {
          flag: "wx",
        });
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
