import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalogPath = "crates/portcove-core/catalog/catalog.json";
const substantialPaths = [
  ".github/roadmap.json",
  ".github/linux-beta-risk-706.json",
  "scripts/roadmap.mts",
  "scripts/roadmap-scoped.mts",
  "scripts/repository-issue-inventory.mts",
  ".github/workflows/roadmap-health.yml",
];
export type RoadmapHealthSelection =
  | { mode: "issues"; issue: number }
  | { mode: "global" }
  | { mode: "none" };

export function selectRoadmapHealth(
  eventName: string,
  event: unknown,
  readRevision: (revision: string, file: string) => string,
): RoadmapHealthSelection {
  if (!isRecord(event)) throw new Error("Roadmap event must be an object");
  const issueNumber = (value: unknown) => {
    const number = Number(value);
    if (!/^[1-9]\d*$/u.test(String(value)) || !Number.isSafeInteger(number))
      throw new Error("Invalid scoped issue number");
    return number;
  };
  if (eventName === "issues") {
    if (!isRecord(event.issue) || event.issue.pull_request)
      throw new Error("Expected a repository issue event");
    return { mode: "issues", issue: issueNumber(event.issue.number) };
  }
  if (eventName === "workflow_dispatch") {
    const value = isRecord(event.inputs) ? event.inputs.issue : undefined;
    return value == null || value === ""
      ? { mode: "global" }
      : { mode: "issues", issue: issueNumber(value) };
  }
  if (eventName !== "push") throw new Error("Unsupported Roadmap health event");
  if (
    typeof event.before !== "string" ||
    typeof event.after !== "string" ||
    !/^[a-f0-9]{40}$/u.test(event.before) ||
    !/^[a-f0-9]{40}$/u.test(event.after)
  )
    throw new Error("Invalid immutable push comparison");
  try {
    if (
      substantialPaths.some(
        (file) =>
          readRevision(event.before as string, file) !== readRevision(event.after as string, file),
      )
    )
      return { mode: "global" };
    const projection = (revision: string) => {
      const value: unknown = JSON.parse(readRevision(revision, catalogPath));
      if (!isRecord(value) || !Array.isArray(value.ports))
        throw new Error("Catalog projection is unavailable");
      return JSON.stringify({
        ports: value.ports
          .map((port: unknown) => {
            if (!isRecord(port) || typeof port.id !== "string")
              throw new Error("Invalid catalog identity");
            return {
              id: port.id,
              platforms: port.platforms,
              automated: port.automated_tested_platforms,
              manual: port.manually_validated_platforms,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
        qualification: isRecord(value.source_catalog)
          ? value.source_catalog.qualification
          : undefined,
      });
    };
    return { mode: projection(event.before) === projection(event.after) ? "none" : "global" };
  } catch {
    return { mode: "global" };
  }
}

const marker = "<!-- portcove-roadmap-health:";
export function roadmapHealthComment(
  report: Record<string, unknown>,
  previous: string | null,
  runUrl: string,
) {
  const declared = isRecord(report.scope) ? report.scope : {};
  const scope = JSON.stringify(
    declared.kind === "issues" && Array.isArray(declared.issues)
      ? {
          kind: "issues",
          issues: declared.issues
            .filter(
              (value): value is number => typeof value === "number" && Number.isSafeInteger(value),
            )
            .toSorted((a, b) => a - b),
        }
      : { kind: "global" },
  );
  const status = report.status === "passed" ? "passed" : "failed";
  const diagnosis = isRecord(report.diagnosis) ? report.diagnosis : {};
  const digest = createHash("sha256")
    .update(
      JSON.stringify([scope, status, diagnosis.kind, diagnosis.membership_mismatch, report.errors]),
    )
    .digest("hex");
  let old: Record<string, unknown> | null = null;
  const encoded = previous?.match(/<!-- portcove-roadmap-health:(\{[^\n]*\}) -->/u)?.[1];
  try {
    const parsed: unknown = encoded ? JSON.parse(encoded) : null;
    if (isRecord(parsed)) old = parsed;
  } catch {
    /* Unrecognized prior text is preserved by the caller. */
  }
  if (old?.digest === digest) return null;
  // A scoped success cannot clear an unrelated failure or global coverage gap.
  if (status === "passed" && (!old || old.scope !== scope || old.status === "passed")) return null;
  const kind = typeof diagnosis.kind === "string" ? diagnosis.kind : "planning_findings";
  const recovery =
    typeof diagnosis.recovery_condition === "string"
      ? diagnosis.recovery_condition
      : "Inspect the retained diagnostic artifact before changing Roadmap data.";
  return (
    `${marker}${JSON.stringify({ scope, status, digest })} -->\n` +
    `Latest Roadmap check: **${status}** (${scope.includes('"global"') ? "global" : "scoped"}).\n\n` +
    (status === "passed"
      ? "The previously reported check recovered. This observation establishes only its declared scope."
      : `Classification: \`${kind}\`. ${recovery}`) +
    `\n\n[Source-bound run and retained evidence](${runUrl}). Other Roadmap records and global coverage remain outside a scoped result.`
  );
}

async function main() {
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const selection = selectRoadmapHealth(
    process.env.GITHUB_EVENT_NAME ?? "",
    event,
    (revision, file) => {
      const result = spawnSync("git", ["show", `${revision}:${file}`], {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error("Immutable comparison input unavailable");
      return result.stdout;
    },
  );
  if (selection.mode === "none") {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "No substantial Roadmap change; full doctor not run.\n",
      );
    return;
  }
  const directory = path.join(root, "work/roadmap-health", randomUUID());
  mkdirSync(directory, { recursive: true });
  let report: Record<string, unknown>;
  if (!process.env.GH_TOKEN) {
    report = {
      status: "failed",
      scope:
        selection.mode === "global"
          ? { kind: "global" }
          : { kind: "issues", issues: [selection.issue] },
      coverage: "inconclusive",
      planning_findings_evaluated: false,
      diagnosis: {
        kind: "configuration_missing",
        recovery_condition:
          "An owner must configure PORTCOVE_ROADMAP_TOKEN with repository and Project access. No existing CLI credential is exported or reused.",
      },
    };
  } else {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (head.status !== 0) throw new Error("Source identity unavailable");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/roadmap.mts",
        "doctor",
        "--expected-head",
        head.stdout.trim(),
        "--json",
        ...(selection.mode === "issues" ? ["--issue", String(selection.issue)] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    writeFileSync(path.join(directory, "stdout.txt"), result.stdout ?? "");
    writeFileSync(path.join(directory, "stderr.txt"), result.stderr ?? "");
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isRecord(parsed) || !["passed", "failed"].includes(String(parsed.status)))
        throw new Error("Invalid doctor receipt");
      report = parsed;
      if (result.status !== 0 && report.status === "passed")
        throw new Error("Doctor exit contradicts receipt");
    } catch {
      report = {
        status: "failed",
        scope:
          selection.mode === "global"
            ? { kind: "global" }
            : { kind: "issues", issues: [selection.issue] },
        coverage: "inconclusive",
        planning_findings_evaluated: false,
        diagnosis: {
          kind: "transport",
          recovery_condition:
            "Inspect the retained command streams and restore a complete doctor receipt before retrying.",
        },
      };
    }
  }
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
  console.log(
    `Roadmap ${selection.mode} check: ${String(report.status)}; evidence: ${path.join(directory, "report.json")}`,
  );
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Roadmap ${selection.mode} check: **${String(report.status)}**. Coverage: ${String(report.coverage)}.\n\nEvidence is retained in the Roadmap diagnostic artifact. A scoped result does not establish global health.\n`,
    );
  if (process.env.GITHUB_TOKEN) {
    const api = new GitHubApiClient(
      createGitHubRunner({
        cwd: root,
        spawn: (command, args, options) =>
          spawnSync(command, args, {
            ...options,
            env: { ...(options.env ?? process.env), GH_TOKEN: process.env.GITHUB_TOKEN },
          }),
      }),
    );
    const comments = api.paginateRest(
      `repos/${process.env.GITHUB_REPOSITORY}/issues/2414/comments?per_page=100`,
      { identity: (value) => (isRecord(value) ? value.id : undefined) },
    );
    const owned = comments.filter(
      (value) =>
        isRecord(value) &&
        isRecord(value.user) &&
        value.user.type === "Bot" &&
        value.user.login === "github-actions[bot]" &&
        typeof value.body === "string" &&
        value.body.startsWith(marker),
    );
    // Concurrent first reports may both post. Preserve them and update the latest;
    // diagnostic history is never mutation authority or a reason to delete evidence.
    const previous = owned.at(-1);
    if (isRecord(previous) && typeof previous.id !== "number")
      throw new Error("Diagnostic comment identity is unavailable");
    const body = roadmapHealthComment(
      report,
      isRecord(previous) ? String(previous.body) : null,
      runUrl,
    );
    if (body) {
      const result = isRecord(previous)
        ? api.request(
            "PATCH",
            `repos/${process.env.GITHUB_REPOSITORY}/issues/comments/${String(previous.id)}`,
            { body },
          ).body
        : api.request("POST", `repos/${process.env.GITHUB_REPOSITORY}/issues/2414/comments`, {
            body,
          }).body;
      if (!isRecord(result) || typeof result.id !== "number")
        throw new Error(
          "Diagnostic comment outcome is unknown; inspect exact readback before retrying",
        );
      const readback = api.request(
        "GET",
        `repos/${process.env.GITHUB_REPOSITORY}/issues/comments/${result.id}`,
      ).body;
      if (!isRecord(readback) || readback.body !== body)
        throw new Error("Diagnostic comment readback differs; preserve the observed report");
    }
  }
  if (report.status !== "passed") process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
