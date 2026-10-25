import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGitHubBody, readGitHubBody, validateGitHubBody } from "./github-body.mts";
import type { BodyApi, BodyWriteOptions } from "./github-body.mts";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { isRoadmapSpecification, validateLiveRoadmapReplacement } from "./roadmap-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import config from "../.github/roadmap.json" with { type: "json" };

/** All candidates pass before the first mutation. Each actual write rereads its
 * preimage/Project state. Later concurrent edits can still cause a partial batch. */
export async function editRoadmapBatch(
  edits: readonly BodyWriteOptions[],
  api: BodyApi,
  finish: (issues: readonly number[], mode: "issues" | "global") => Promise<unknown>,
) {
  if (!edits.length || edits.length > 100) throw new Error("Batch requires 1 to 100 issue edits");
  const numbers = new Set<number>();
  for (const edit of edits) {
    const number = Number(edit.target);
    if (
      edit.operation !== "issue-edit" ||
      !/^[1-9]\d*$/u.test(String(edit.target)) ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      numbers.has(number)
    )
      throw new Error("Batch needs distinct positive issue identities");
    numbers.add(number);
    validateGitHubBody(edit.body);
    if (typeof edit.previousBody !== "string" || typeof edit.body !== "string")
      throw new Error("Batch edits require body and exact preimage");
    const before = api.request("GET", `repos/${config.repository}/issues/${number}`).body;
    if (!isRecord(before) || before.number !== number || before.body !== edit.previousBody)
      throw new Error(`Issue #${number} preimage changed before batch publication`);
    if (!isRoadmapSpecification(before))
      throw new Error(`Issue #${number} is not a durable Roadmap specification`);
    (api.validateRoadmapReplacement ?? validateLiveRoadmapReplacement)(
      number,
      edit.previousBody,
      edit.body,
    );
  }
  const results = edits.map((edit) => writeGitHubBody(edit, api));
  const issues = [...numbers];
  const mode = issues.length > 10 ? "global" : "issues";
  const check = await finish(issues, mode);
  return { results, mode, check };
}

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.join(root, "work/roadmap-edit", randomUUID());
  mkdirSync(directory, { recursive: true });
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--spec-file")
      throw new Error(
        "Usage: roadmap-edit.mts --spec-file FILE (JSON array of {target, body_file, previous_body_file})",
      );
    const spec: unknown = JSON.parse(readGitHubBody(process.argv[3] ?? ""));
    if (!Array.isArray(spec)) throw new Error("Batch specification must be an array");
    const edits = spec.map((value: unknown, index) => {
      if (
        !isRecord(value) ||
        typeof value.body_file !== "string" ||
        typeof value.previous_body_file !== "string"
      )
        throw new Error("Invalid batch entry");
      const body = readGitHubBody(value.body_file);
      const previousBody = readFileSync(value.previous_body_file, "utf8");
      writeFileSync(path.join(directory, `${index}-candidate.md`), body);
      writeFileSync(path.join(directory, `${index}-preimage.md`), previousBody);
      return {
        operation: "issue-edit",
        target: value.target,
        body,
        previousBody,
        observe: (observation: unknown) =>
          writeFileSync(
            path.join(directory, `${index}-${Date.now()}-${randomUUID()}.json`),
            JSON.stringify(observation),
          ),
      };
    });
    const result = await editRoadmapBatch(edits, new GitHubApiClient(), async (issues, mode) => {
      const scopes = mode === "global" ? [[]] : issues.map((issue) => ["--issue", String(issue)]);
      const receipts: unknown[] = [];
      for (const [index, args] of scopes.entries()) {
        const check = spawnSync(
          process.execPath,
          ["scripts/roadmap.mts", "doctor", "--json", ...args],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 360000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
        );
        writeFileSync(path.join(directory, `doctor-${index}.stdout.json`), check.stdout ?? "");
        writeFileSync(path.join(directory, `doctor-${index}.stderr.txt`), check.stderr ?? "");
        const parsed: unknown = JSON.parse(check.stdout);
        if (
          check.status !== 0 ||
          !isRecord(parsed) ||
          parsed.status !== "passed" ||
          parsed.coverage !== "complete" ||
          (mode === "global" && parsed.global_health !== "passed")
        )
          throw new Error(
            `Batch writes finished; ${mode} verification did not establish complete success. Preserve the receipt and resume after writes stabilize.`,
          );
        receipts.push(parsed);
      }
      return receipts;
    });
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
    console.log(JSON.stringify({ ...result, evidence: directory }));
  } catch (error) {
    const diagnostic = sanitizeOperationError(error);
    writeFileSync(path.join(directory, "error.json"), JSON.stringify(diagnostic));
    console.error(`${diagnostic.message}; retained evidence: ${directory}`);
    process.exitCode = 1;
  }
}
