import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { sanitizeOperationError } from "./github-api.mts";

export interface RoadmapObservation {
  scope: string;
  started_at: string;
  run: number;
  attempt: number;
  status: "passed" | "needs_attention" | "unable_to_verify";
  kind: string;
  incident: string;
  detail: string;
  evidence: string;
}
export interface RoadmapReportState {
  format_version: 1;
  cursor: string;
  observations: Record<string, RoadmapObservation>;
  publication_gaps: string[];
  processed?: Record<string, string>;
}
export const reportMarker = "<!-- portcove-roadmap-report:";

export function unavailableRoadmapStateReport(previous: string, reason: string) {
  if (!previous.startsWith(reportMarker) || !previous.includes("\n"))
    throw new Error("Previous report identity is unavailable");
  const end = previous.indexOf("\n");
  const history = previous
    .slice(end + 1)
    .replace(
      /<!-- portcove-roadmap-state-unavailable -->[\s\S]*?<!-- \/portcove-roadmap-state-unavailable -->\n?/gu,
      "",
    );
  const body =
    previous.slice(0, end + 1) +
    "<!-- portcove-roadmap-state-unavailable -->\n" +
    `Roadmap: **Unable to verify** — retained report state is unavailable. ${safeText(reason)}\n\n` +
    "Restore the referenced state artifact or reconstruct its observations from retained results through reviewed recovery, then resume journal replay. New collector results remain retained. Missing history cannot seed a clean state.\n\n" +
    "The previous summary below is historical; current coverage is unknown.\n" +
    "<!-- /portcove-roadmap-state-unavailable -->\n" +
    history;
  if (Buffer.byteLength(body) > 65000)
    throw new Error("Unavailable-state diagnostic exceeds the bounded comment size");
  return body;
}

/** Import outstanding legacy diagnostics once; existing comments remain intact. */
export function legacyRoadmapObservations(comments: readonly unknown[], repository: string) {
  const observations: RoadmapObservation[] = [];
  for (const value of comments) {
    if (
      !isRecord(value) ||
      !isRecord(value.user) ||
      value.user.type !== "Bot" ||
      value.user.login !== "github-actions[bot]" ||
      typeof value.body !== "string"
    )
      continue;
    const encoded = value.body.match(/^<!-- portcove-roadmap-health:(\{[^\n]*\}) -->/u)?.[1];
    if (!encoded) continue;
    const state: unknown = JSON.parse(encoded);
    if (!isRecord(state) || typeof state.scope !== "string")
      throw new Error("Legacy diagnostic scope is malformed");
    const scope: unknown = JSON.parse(state.scope);
    if (!isRecord(scope) || scope.kind === "configuration") continue; // Verified setup history has its own activation receipt.
    const started = value.body.match(/Observed: ([\dT:.Z+-]+)\./u)?.[1] ?? value.updated_at;
    if (typeof started !== "string" || !Number.isFinite(Date.parse(started)))
      throw new Error("Legacy diagnostic observation time is unavailable");
    const id = Number(value.id);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Legacy diagnostic comment identity is unavailable");
    const kind = value.body.match(/Classification: `([^`]+)`/u)?.[1] ?? "planning_findings";
    if (kind === "configuration_missing") continue;
    const scopes =
      scope.kind === "global"
        ? ["global"]
        : scope.kind === "issues" && Array.isArray(scope.issues)
          ? scope.issues.map((issue) => {
              if (!Number.isSafeInteger(issue) || Number(issue) < 1)
                throw new Error("Legacy diagnostic issue identity is invalid");
              return `issue:${String(issue)}`;
            })
          : [];
    const status =
      state.status === "passed"
        ? "passed"
        : kind === "planning_findings"
          ? "needs_attention"
          : "unable_to_verify";
    for (const scope of scopes)
      observations.push({
        scope,
        started_at: started,
        run: id,
        attempt: 0,
        status,
        kind,
        incident: kind === "rate_limit" || kind === "authentication" ? kind : "",
        detail: safeText(value.body.split("\n").slice(1).join("\n")),
        evidence: `https://github.com/${repository}/issues/2414#issuecomment-${id}`,
      });
  }
  return observations;
}
export function reportDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function safeText(value: string) {
  return sanitizeOperationError({ message: value })
    .message.replace(/[\r\n]+/gu, " ")
    .replace(/[\\`*_{}[\]()<>#!|@]/gu, "\\$&")
    .slice(0, 600);
}
export function observationStatus(report: Record<string, unknown>): RoadmapObservation["status"] {
  if (report.coverage !== "complete") return "unable_to_verify";
  return report.status === "passed" ? "passed" : "needs_attention";
}
export function observationFromReceipt(
  report: Record<string, unknown>,
  run: number,
  attempt: number,
  repository: string,
): RoadmapObservation[] {
  if (!isRecord(report.scope) || !isRecord(report.observation))
    throw new Error("Receipt lacks scope/observation identity");
  const started = report.observation.started_at;
  if (typeof started !== "string" || !Number.isFinite(Date.parse(started)))
    throw new Error("Receipt lacks a valid observation start");
  const status = observationStatus(report);
  const scope = report.scope;
  const issues = scope.issues;
  if (
    scope.kind === "issues" &&
    (!Array.isArray(issues) ||
      !issues.length ||
      issues.some((issue) => !Number.isSafeInteger(issue) || Number(issue) < 1) ||
      new Set(issues).size !== issues.length)
  )
    throw new Error("Receipt issue scope is invalid");
  if (scope.kind !== "issues" && scope.kind !== "global") throw new Error("Unknown receipt scope");
  const checked = scope.checked_issues;
  if (
    status === "passed" &&
    scope.kind === "issues" &&
    (!Array.isArray(checked) || (issues as number[]).some((issue) => !checked.includes(issue)))
  )
    throw new Error("Passing receipt lacks complete checked records");
  if (status === "passed" && scope.kind === "global" && report.global_health !== "passed")
    throw new Error("Global passing receipt lacks global health");
  const diagnosis = isRecord(report.diagnosis) ? report.diagnosis : {};
  const kind = typeof diagnosis.kind === "string" ? diagnosis.kind : "planning_findings";
  const provider = isRecord(diagnosis.provider) ? diagnosis.provider : {};
  const rate = isRecord(provider.rate) ? provider.rate : {};
  const errors = Array.isArray(report.errors)
    ? report.errors.filter((error): error is string => typeof error === "string")
    : [];
  const reason = errors.length
    ? errors.join("; ")
    : isRecord(diagnosis.error) && typeof diagnosis.error.message === "string"
      ? diagnosis.error.message
      : "See retained check receipt.";
  const recovery =
    typeof diagnosis.recovery_condition === "string"
      ? diagnosis.recovery_condition
      : "Repeat the affected check after authorized correction.";
  const detail = safeText(
    `${reason} ${typeof rate.resetAt === "string" ? `Reset: ${rate.resetAt}. ` : ""}${typeof rate.remaining === "number" ? `Remaining quota: ${rate.remaining}. ` : ""}${recovery}`,
  );
  const incident = [
    "rate_limit",
    "authentication",
    "configuration_missing",
    "transport",
    "provider_inconsistent",
  ].includes(kind)
    ? `${kind}:${typeof provider.status === "number" ? provider.status : ""}:${typeof rate.resetAt === "string" ? rate.resetAt : ""}`
    : "";
  return (
    scope.kind === "global" ? ["global"] : (issues as number[]).map((issue) => `issue:${issue}`)
  ).map((scope) => ({
    scope,
    started_at: started,
    run,
    attempt,
    status,
    kind,
    incident,
    detail,
    evidence: `https://github.com/${repository}/actions/runs/${run}/attempts/${attempt}`,
  }));
}
function newer(candidate: RoadmapObservation, previous: RoadmapObservation) {
  return (
    Date.parse(candidate.started_at) > Date.parse(previous.started_at) ||
    (Date.parse(candidate.started_at) === Date.parse(previous.started_at) &&
      (candidate.run > previous.run ||
        (candidate.run === previous.run && candidate.attempt > previous.attempt)))
  );
}
export function mergeRoadmapObservations(
  state: RoadmapReportState,
  incoming: readonly RoadmapObservation[],
) {
  const observations = { ...state.observations };
  for (const observation of incoming) {
    const previous = observations[observation.scope];
    if (!previous || newer(observation, previous)) observations[observation.scope] = observation;
  }
  return { ...state, observations };
}

export interface RoadmapReplayRun {
  run: number;
  attempt: number;
  created_at: string;
  completed: boolean;
}
export class ReplayWindowFull extends Error {}
export function journalCollectorRun(entry: Record<string, unknown>) {
  if (
    entry.path !== ".github/workflows/roadmap-report.yml" ||
    entry.head_branch !== "main" ||
    !["workflow_run", "workflow_dispatch"].includes(String(entry.event))
  )
    throw new Error("Untrusted publication journal entry");
  if (entry.event === "workflow_dispatch") return null;
  const match =
    typeof entry.display_title === "string"
      ? entry.display_title.match(/^Roadmap publication ([1-9]\d*) \/ ([1-9]\d*)$/u)
      : null;
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !Number.isSafeInteger(Number(match[2])) ||
    typeof entry.created_at !== "string" ||
    !Number.isFinite(Date.parse(entry.created_at))
  )
    throw new Error("Publication journal lacks an exact collector attempt");
  return { run: Number(match[1]), attempt: Number(match[2]), created_at: entry.created_at };
}

export function mainPublicationJournals(entries: readonly Record<string, unknown>[]) {
  return entries
    .filter((entry) => entry.head_branch === "main")
    .flatMap((entry) => {
      const journal = journalCollectorRun(entry);
      return journal ? [{ ...journal, completed: true }] : [];
    });
}
/** GitHub caps filtered Actions searches at 1,000 records. Split complete time
 * windows and deduplicate inclusive boundaries instead of trusting a prefix. */
export function collectReplayWindows(
  since: string,
  until: string,
  collect: (since: string, until: string) => Record<string, unknown>[],
  deadline = Date.now() + 120000,
): Record<string, unknown>[] {
  if (Date.now() >= deadline)
    throw new Error("Replay inventory deadline exhausted; retain the previous cursor");
  try {
    return collect(since, until);
  } catch (error) {
    if (!(error instanceof ReplayWindowFull)) throw error;
    const start = Date.parse(since),
      end = Date.parse(until);
    const middle = Math.floor((start + end) / 2000) * 1000;
    if (middle <= start || middle >= end)
      throw new Error(
        "More than 1,000 collector runs share one second; complete replay remains unavailable",
      );
    const boundary = new Date(middle).toISOString();
    const values = [
      ...collectReplayWindows(since, boundary, collect, deadline),
      ...collectReplayWindows(boundary, until, collect, deadline),
    ];
    return [...new Map(values.map((value) => [value.id, value])).values()];
  }
}
/** Bounded replay, independent of notification ordering or queued publisher identity. */
export function replayRoadmapRuns(
  previous: RoadmapReportState,
  runs: readonly RoadmapReplayRun[],
  until: string,
  read: (run: RoadmapReplayRun) => readonly RoadmapObservation[],
  limit = 200,
) {
  let state = {
    ...previous,
    processed: { ...previous.processed },
    publication_gaps: [] as string[],
  };
  let cursor = until,
    downloaded = 0;
  const latest = new Map<number, RoadmapReplayRun>();
  for (const run of runs) {
    const existing = latest.get(run.run);
    if (!existing || run.attempt > existing.attempt) latest.set(run.run, run);
  }
  for (const run of [...latest.values()].toSorted(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.run - b.run,
  )) {
    const key = `${run.run}/${run.attempt}`;
    if (state.processed[key]) continue;
    try {
      if (!run.completed) throw new Error(`Collector ${key} is pending or running`);
      if (downloaded++ >= limit)
        throw new Error(
          "Retained results remain unpublished; next event or manual replay resumes without repeating checks",
        );
      const observations = read(run);
      state = {
        ...mergeRoadmapObservations(state, observations),
        processed: state.processed,
        publication_gaps: state.publication_gaps,
      };
      state.processed[key] = run.created_at;
    } catch (error) {
      state.publication_gaps.push(sanitizeOperationError(error).message);
      if (Date.parse(run.created_at) < Date.parse(cursor)) cursor = run.created_at;
    }
  }
  state.cursor = cursor;
  state.processed = Object.fromEntries(
    Object.entries(state.processed).filter(
      ([, created]) => Date.parse(created) >= Date.parse(cursor),
    ),
  );
  return state;
}
export function renderRoadmapReport(
  state: RoadmapReportState,
  snapshot: { run: number; attempt: number; sha256: string; repository: string },
) {
  const active = Object.values(state.observations)
    .filter((entry) => entry.status !== "passed")
    .sort((a, b) => a.scope.localeCompare(b.scope, undefined, { numeric: true }));
  const affected = active.filter((entry) => entry.scope !== "global").length;
  const unknown =
    state.publication_gaps.length > 0 ||
    active.some((entry) => entry.status === "unable_to_verify");
  const global = state.observations.global;
  const stateUrl = `https://github.com/${snapshot.repository}/actions/runs/${snapshot.run}/attempts/${snapshot.attempt}`;
  const lines = [
    `${reportMarker}${JSON.stringify({ format_version: 1, ...snapshot })} -->`,
    `Roadmap ${unknown ? "**Unable to verify**" : active.length ? "**needs attention**" : "**no outstanding findings in observed scopes**"}: ${affected} affected issues.`,
    "",
    `Global Roadmap health: **${global?.status === "passed" ? `passed at ${global.started_at}` : "not established by these scoped checks"}**. A scoped recovery clears only that issue's observation.`,
    "",
    `[Complete maintained report state and retained results](${stateUrl}) (artifact \`roadmap-report-state-${snapshot.run}-${snapshot.attempt}\`). Historical diagnostics remain preserved.`,
  ];
  if (state.publication_gaps.length)
    lines.push(
      "",
      "Publication coverage is incomplete:",
      "",
      ...state.publication_gaps.slice(0, 10).map((gap) => `- ${safeText(gap)}`),
      "",
      "Resume publication after the missing artifact or interrupted collector is reconciled; do not infer global success.",
    );
  const incidents = new Map<string, RoadmapObservation[]>();
  for (const entry of active) {
    const key = entry.incident || entry.scope;
    const group = incidents.get(key) ?? [];
    group.push(entry);
    incidents.set(key, group);
  }
  if (active.length)
    lines.push(
      "",
      "| Classification | Affected scopes and exact check results | Finding / recovery |",
      "| --- | --- | --- |",
    );
  let rows = 0;
  for (const group of incidents.values()) {
    if (rows++ >= 60) {
      lines.push(
        "",
        "Additional active findings and every scope are retained in the complete report-state artifact.",
      );
      break;
    }
    const first = group[0]!;
    const links = group
      .slice(0, 20)
      .map(
        (entry) =>
          `[${entry.scope === "global" ? "Global audit" : `#${entry.scope.slice(6)}`}](${entry.evidence})`,
      )
      .join(", ");
    lines.push(
      `| ${first.status === "unable_to_verify" ? "Unable to verify: " : ""}${safeText(first.kind)} | ${links}${group.length > 20 ? `; ${group.length - 20} more in the artifact` : ""} | ${first.detail} |`,
    );
  }
  const body = lines.join("\n");
  if (Buffer.byteLength(body, "utf8") > 60000)
    throw new Error(
      "Maintained diagnostic exceeds the bounded publication size; state remains retained",
    );
  return body;
}
