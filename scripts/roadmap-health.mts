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
const configurationScope = JSON.stringify({
  kind: "configuration",
  key: "PORTCOVE_ROADMAP_TOKEN",
});
function configurationMissing(report: Record<string, unknown>) {
  return (
    report.status !== "passed" &&
    isRecord(report.diagnosis) &&
    report.diagnosis.kind === "configuration_missing"
  );
}
function roadmapHealthScope(report: Record<string, unknown>) {
  // Comment identity groups the shared setup incident; receipts keep the
  // original requested issue/global scope and inconclusive coverage.
  if (configurationMissing(report)) return configurationScope;
  const declared = isRecord(report.scope) ? report.scope : {};
  return JSON.stringify(
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
}
function commentState(body: string | null): Record<string, unknown> | null {
  const encoded = body?.match(/^<!-- portcove-roadmap-health:(\{[^\n]*\}) -->/u)?.[1];
  try {
    const parsed: unknown = encoded ? JSON.parse(encoded) : null;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function findRoadmapHealthComment(
  comments: readonly unknown[],
  report: Record<string, unknown>,
) {
  const scope = roadmapHealthScope(report);
  const authored = comments.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) &&
      isRecord(value.user) &&
      value.user.type === "Bot" &&
      value.user.login === "github-actions[bot]" &&
      typeof value.body === "string" &&
      value.body.startsWith(marker) &&
      commentState(value.body) !== null,
  );
  const isConfiguration = (value: Record<string, unknown>) => {
    const body = String(value.body);
    const state = commentState(body);
    return (
      state?.scope === configurationScope ||
      (state?.status === "failed" && body.includes("Classification: `configuration_missing`."))
    );
  };
  if (configurationMissing(report)) {
    // Reuse one existing incident, including the legacy per-scope format. Pick
    // deterministically so concurrent scopes cannot migrate different comments.
    const rank = (value: Record<string, unknown>) => {
      const previousScope = commentState(String(value.body))?.scope;
      if (previousScope === configurationScope) return 0;
      return previousScope === JSON.stringify({ kind: "global" }) ? 1 : 2;
    };
    return authored.filter(isConfiguration).toSorted((a, b) => {
      const order = rank(a) - rank(b);
      if (order !== 0) return order;
      return Number(a.id) - Number(b.id);
    })[0];
  }
  // A real scoped result must not overwrite setup history or treat it as a
  // planning failure that an unrelated scoped success can clear.
  return authored.findLast(
    (value) => !isConfiguration(value) && commentState(String(value.body))?.scope === scope,
  );
}
function canonicalDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(canonicalDiagnosticValue)
      .sort((a, b) => String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b))));
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalDiagnosticValue(value[key])]),
    );
  return value;
}
function declaredScope(report: Record<string, unknown>) {
  const scope = isRecord(report.scope) ? report.scope : {};
  return scope.kind === "issues" && Array.isArray(scope.issues)
    ? `issues ${scope.issues.map((issue) => `#${String(issue)}`).join(", ")}`
    : "global audit";
}
function observationEvidence(report: Record<string, unknown>, runUrl: string) {
  const observation = isRecord(report.observation) ? report.observation : {};
  const checkout =
    typeof observation.checkout_head === "string" &&
    /^[a-f0-9]{40}$/u.test(observation.checkout_head)
      ? `\`${observation.checkout_head}\``
      : "unavailable";
  const scoped = isRecord(report.scope) && report.scope.kind === "issues";
  const checked = isRecord(report.scope) ? report.scope.checked_issues : undefined;
  const checkedScope = Array.isArray(checked)
    ? `Checked issues: ${checked.map((issue) => `#${String(issue)}`).join(", ")}. `
    : "The checked issue set was not retained. ";
  return (
    `Observed: ${typeof observation.observed_at === "string" ? observation.observed_at : "not retained"}. ` +
    `Actual checkout: ${checkout}.\n\n` +
    `[Workflow attempt and retained evidence](${runUrl}).\n\n` +
    (configurationMissing(report)
      ? "The doctor did not run; planning findings are unevaluated and coverage is inconclusive."
      : scoped
        ? `Coverage: **${String(report.coverage ?? "not retained")}**. ${checkedScope}This result applies only to its checked records; global health was not evaluated.`
        : `Global audit coverage: **${String(report.coverage ?? "not retained")}**. Global health: **${String(report.global_health ?? "not retained")}**.`) +
    " Unchanged results do not refresh diagnostic comments."
  );
}
export function roadmapHealthSummary(report: Record<string, unknown>, runUrl: string) {
  const diagnosis = isRecord(report.diagnosis) ? report.diagnosis : {};
  return (
    `Roadmap observation: **${configurationMissing(report) ? "not configured" : String(report.status)}** — ${declaredScope(report)}.\n\n` +
    (typeof diagnosis.kind === "string"
      ? `Classification: \`${diagnosis.kind}\`. ${typeof diagnosis.recovery_condition === "string" ? diagnosis.recovery_condition : "Inspect the retained diagnostic artifact."}\n\n`
      : "") +
    observationEvidence(report, runUrl) +
    "\n"
  );
}
export function roadmapHealthComment(
  report: Record<string, unknown>,
  previous: string | null,
  runUrl: string,
) {
  const scope = roadmapHealthScope(report);
  const status = report.status === "passed" ? "passed" : "failed";
  const diagnosis = isRecord(report.diagnosis) ? report.diagnosis : {};
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        status,
        diagnosis.kind,
        canonicalDiagnosticValue(diagnosis.membership_mismatch),
        canonicalDiagnosticValue(report.errors),
      ]),
    )
    .digest("hex");
  const old = commentState(previous);
  if (old?.digest === digest) return null;
  // A scoped success cannot clear an unrelated failure or global coverage gap.
  if (status === "passed" && (!old || old.scope !== scope || old.status === "passed")) return null;
  const kind = typeof diagnosis.kind === "string" ? diagnosis.kind : "planning_findings";
  const recovery =
    typeof diagnosis.recovery_condition === "string"
      ? diagnosis.recovery_condition
      : "Inspect the retained diagnostic artifact before changing Roadmap data.";
  if (configurationMissing(report))
    return (
      `${marker}${JSON.stringify({ scope, status, digest })} -->\n` +
      "Hosted Roadmap checks: **not configured** (repository-wide setup incident).\n\n" +
      `Classification: \`${kind}\`. ${recovery}\n\n` +
      "The same missing credential affects every requested scope. Unchanged repeats share this diagnostic; " +
      "each executed check retains its original scope and failure evidence.\n\n" +
      `Requested scope: ${declaredScope(report)}.\n\n` +
      observationEvidence(report, runUrl) +
      "\n\nKeep this incident as setup history until owner activation is verified by a real scoped check."
    );
  return (
    `${marker}${JSON.stringify({ scope, status, digest })} -->\n` +
    `Roadmap observation: **${status}** — ${declaredScope(report)}.\n\n` +
    (status === "passed"
      ? "The previously reported check recovered. This observation establishes only its declared scope."
      : `Classification: \`${kind}\`. ${recovery}`) +
    `\n\n${observationEvidence(report, runUrl)}`
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
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  const checkoutHead =
    head.status === 0 && /^[a-f0-9]{40}$/u.test(head.stdout.trim()) ? head.stdout.trim() : null;
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
          "An owner must add the dedicated Actions secret PORTCOVE_ROADMAP_TOKEN with read:project access, then run the workflow on main with issue=2414 and inspect its receipt. See docs/PROJECT-GOVERNANCE.md#hosted-activation. No existing CLI credential is exported or reused.",
      },
    };
  } else {
    if (!checkoutHead) throw new Error("Source identity unavailable");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/roadmap.mts",
        "doctor",
        "--expected-head",
        checkoutHead,
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
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
  report.observation = {
    observed_at: new Date().toISOString(),
    checkout_head: checkoutHead,
    run_url: runUrl,
  };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
  console.log(
    `Roadmap ${selection.mode} check: ${String(report.status)}; evidence: ${path.join(directory, "report.json")}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, roadmapHealthSummary(report, runUrl));
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
    // Missing configuration shares one serialized incident; configured checks
    // keep independent scope comments. Historical comments retain their evidence.
    const previous = findRoadmapHealthComment(comments, report);
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
