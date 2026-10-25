import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import {
  replayRoadmapRuns,
  collectReplayWindows,
  journalCollectorRun,
  ReplayWindowFull,
  legacyRoadmapObservations,
  mergeRoadmapObservations,
  observationFromReceipt,
  renderRoadmapReport,
  reportDigest,
  reportMarker,
} from "./roadmap-report.mts";
import type { RoadmapReportState } from "./roadmap-report.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(root, "work/roadmap-publisher");
const repository = "boburning/portcove";
const prefix = `repos/${repository}`;
const api = new GitHubApiClient();
function readBounded(file: string, limit = 8 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error("Retained report is not a bounded regular file");
  return readFileSync(file, "utf8");
}
function command(executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(`Publication command failed: ${executable}; ${result.stderr}`);
  return result.stdout.trim();
}
function numeric(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Missing publication identity");
  return value;
}
function record(value: unknown) {
  if (!isRecord(value)) throw new Error("Missing publication object");
  return value;
}
type PublicationApi = Pick<GitHubApiClient, "paginateRest" | "request">;
function comments(transport: PublicationApi = api) {
  return transport
    .paginateRest(`${prefix}/issues/2414/comments?per_page=100`, {
      identity: (value) => record(value).id,
    })
    .filter((value) => {
      const comment = record(value),
        user = record(comment.user);
      return (
        user.type === "Bot" &&
        user.login === "github-actions[bot]" &&
        typeof comment.body === "string" &&
        comment.body.startsWith(reportMarker)
      );
    })
    .map(record);
}
function existing(transport: PublicationApi = api) {
  const found = comments(transport);
  if (found.length > 1)
    throw new Error("Multiple maintained reports; reconcile exact identities before publication");
  return found[0];
}

export function writeMaintainedRoadmapReport(
  body: string,
  previous: unknown,
  transport: PublicationApi = api,
) {
  if (!body.startsWith(reportMarker) || Buffer.byteLength(body) > 60000)
    throw new Error("Invalid maintained report candidate");
  const before = existing(transport);
  if (
    JSON.stringify(before ? { id: before.id, body: before.body } : null) !==
    JSON.stringify(previous)
  )
    throw new Error(
      "Maintained report changed outside the serialized publisher; refresh before writing",
    );
  if (before?.body === body) return numeric(before.id);
  const result = record(
    before
      ? transport.request("PATCH", `${prefix}/issues/comments/${numeric(before.id)}`, { body }).body
      : transport.request("POST", `${prefix}/issues/2414/comments`, { body }).body,
  );
  if (before && result.id !== before.id)
    throw new Error("Maintained report mutation identity differs; reconcile before retrying");
  const observed = record(
    transport.request("GET", `${prefix}/issues/comments/${numeric(result.id)}`).body,
  );
  if (observed.id !== result.id || observed.body !== body)
    throw new Error("Maintained report readback differs; reconcile before any retry");
  return numeric(result.id);
}
function download(run: number, name: string) {
  const artifacts = api.paginateRest(`${prefix}/actions/runs/${run}/artifacts?per_page=100`, {
    select: (value) => record(value).artifacts,
    totalCount: (value) => Number(record(value).total_count),
    identity: (value) => record(value).id,
  });
  const matches = artifacts.map(record).filter((artifact) => artifact.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.expired ||
    !Number.isSafeInteger(matches[0]?.size_in_bytes) ||
    Number(matches[0]?.size_in_bytes) > 16 * 1024 * 1024
  )
    throw new Error(`Missing, expired or oversized retained artifact: ${name}`);
  const destination = mkdtempSync(path.join(directory, "download-"));
  command("gh", [
    "run",
    "download",
    String(run),
    "--repo",
    repository,
    "--name",
    name,
    "--dir",
    destination,
  ]);
  return destination;
}
function readState(pointer: Record<string, unknown>): RoadmapReportState {
  const run = numeric(pointer.run),
    attempt = numeric(pointer.attempt);
  const retainedRun = record(api.request("GET", `${prefix}/actions/runs/${run}`).body);
  if (
    retainedRun.path !== ".github/workflows/roadmap-report.yml" ||
    retainedRun.head_branch !== "main"
  )
    throw new Error("State producer is not the trusted report workflow");
  const bytes = readBounded(
    path.join(download(run, `roadmap-report-state-${run}-${attempt}`), "state.json"),
  );
  if (reportDigest(bytes) !== pointer.sha256)
    throw new Error("Retained state digest differs from published pointer");
  const state: unknown = JSON.parse(bytes);
  if (
    !isRecord(state) ||
    state.format_version !== 1 ||
    typeof state.cursor !== "string" ||
    !Number.isFinite(Date.parse(state.cursor)) ||
    !isRecord(state.observations) ||
    !Array.isArray(state.publication_gaps)
  )
    throw new Error("Invalid retained report state");
  for (const [scope, value] of Object.entries(state.observations)) {
    if (
      !isRecord(value) ||
      value.scope !== scope ||
      typeof value.started_at !== "string" ||
      !Number.isFinite(Date.parse(value.started_at)) ||
      !["passed", "needs_attention", "unable_to_verify"].includes(String(value.status)) ||
      typeof value.evidence !== "string" ||
      !(
        value.evidence.startsWith(`https://github.com/${repository}/actions/runs/`) ||
        value.evidence.startsWith(`https://github.com/${repository}/issues/2414#issuecomment-`)
      ) ||
      typeof value.detail !== "string"
    )
      throw new Error("Invalid retained scope observation");
  }
  return state as unknown as RoadmapReportState;
}
async function prepare() {
  const previous = existing();
  let state: RoadmapReportState;
  if (previous) {
    const match = String(previous.body).match(/^<!-- portcove-roadmap-report:(\{[^\n]*\}) -->/u);
    if (!match?.[1]) throw new Error("Maintained report pointer is malformed");
    state = readState(record(JSON.parse(match[1])));
  } else {
    const since = command("git", [
      "log",
      "--first-parent",
      "--diff-filter=A",
      "--format=%cI",
      "-1",
      "--",
      ".github/workflows/roadmap-report.yml",
    ]);
    if (!Number.isFinite(Date.parse(since)))
      throw new Error("Publication cutover identity is unavailable");
    state = {
      format_version: 1,
      cursor: new Date(since).toISOString(),
      observations: {},
      publication_gaps: [],
    };
    state = mergeRoadmapObservations(
      state,
      legacyRoadmapObservations(
        api.paginateRest(`${prefix}/issues/2414/comments?per_page=100`, {
          identity: (value) => record(value).id,
        }),
        repository,
      ),
    );
  }
  try {
    const until = new Date().toISOString();
    const runs = collectReplayWindows(state.cursor, until, (since, end) => {
      const query = encodeURIComponent(`${since}..${end}`);
      return api
        .paginateRest(
          `${prefix}/actions/workflows/roadmap-report.yml/runs?per_page=100&created=${query}`,
          {
            select: (value) => record(value).workflow_runs,
            totalCount: (value) => {
              const count = Number(record(value).total_count);
              if (count >= 1000) throw new ReplayWindowFull();
              return count;
            },
            identity: (value) => record(value).id,
          },
        )
        .map(record);
    });
    const ownRun = record(
      api.request("GET", `${prefix}/actions/runs/${numeric(Number(process.env.GITHUB_RUN_ID))}`)
        .body,
    );
    if (!runs.some((run) => run.id === ownRun.id)) runs.push(ownRun);
    const trusted = runs.flatMap((entry) => {
      const journal = journalCollectorRun(entry);
      return journal ? [{ ...journal, completed: true }] : [];
    });
    state = replayRoadmapRuns(state, trusted, until, ({ run: id, attempt }) => {
      const collector = record(
        api.request("GET", `${prefix}/actions/runs/${id}/attempts/${attempt}`).body,
      );
      if (
        collector.id !== id ||
        collector.run_attempt !== attempt ||
        collector.path !== ".github/workflows/roadmap-health.yml" ||
        collector.head_branch !== "main" ||
        !["issues", "push", "workflow_dispatch"].includes(String(collector.event)) ||
        collector.status !== "completed"
      )
        throw new Error(
          "Journal collector identity or completion differs from the trusted workflow",
        );
      const destination = download(id, `roadmap-diagnostics-${id}-${attempt}`);
      const manifest = record(
        JSON.parse(readBounded(path.join(destination, "roadmap-health/publication.json"))),
      );
      if (manifest.format_version !== 1 || manifest.run !== id || manifest.attempt !== attempt)
        throw new Error("Collector manifest identity differs");
      return manifest.report === null
        ? []
        : observationFromReceipt(record(manifest.report), id, attempt, repository);
    });
  } catch (error) {
    state.publication_gaps = [
      `Unable to inventory retained publication results: ${sanitizeOperationError(error).message}. Preserve the cursor and resume the publisher after coverage is restored.`,
    ];
    writeFileSync(
      path.join(directory, "collection-error.json"),
      JSON.stringify(sanitizeOperationError(error)),
    );
  }
  const bytes = JSON.stringify(state);
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024)
    throw new Error("Retained state exceeds its bounded size");
  writeFileSync(path.join(directory, "state.json"), bytes);
  const body = renderRoadmapReport(state, {
    run: numeric(Number(process.env.GITHUB_RUN_ID)),
    attempt: numeric(Number(process.env.GITHUB_RUN_ATTEMPT)),
    sha256: reportDigest(bytes),
    repository,
  });
  writeFileSync(path.join(directory, "body.md"), body);
  writeFileSync(
    path.join(directory, "preimage.json"),
    JSON.stringify(previous ? { id: previous.id, body: previous.body } : null),
  );
}
function publish() {
  const previous: unknown = JSON.parse(readBounded(path.join(directory, "preimage.json")));
  const run = numeric(Number(process.env.GITHUB_RUN_ID)),
    attempt = numeric(Number(process.env.GITHUB_RUN_ATTEMPT));
  // Upload completes before making the snapshot pointer visible. An interrupted
  // publication leaves the old pointer, so the next event replays the receipts.
  const uploaded = readBounded(
    path.join(download(run, `roadmap-report-state-${run}-${attempt}`), "state.json"),
  );
  if (uploaded !== readBounded(path.join(directory, "state.json")))
    throw new Error("Uploaded report state differs from the candidate");
  const body = readBounded(path.join(directory, "body.md"), 60000);
  writeMaintainedRoadmapReport(body, previous);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(directory, { recursive: true });
  try {
    if (process.argv[2] === "prepare") await prepare();
    else if (process.argv[2] === "publish") publish();
    else
      throw new Error(
        "Usage: roadmap-publish.mts prepare|publish inside the serialized hosted publisher",
      );
  } catch (error) {
    const diagnostic = sanitizeOperationError(error);
    writeFileSync(path.join(directory, "error.json"), JSON.stringify(diagnostic));
    console.error(diagnostic.message);
    process.exitCode = 1;
  }
}
