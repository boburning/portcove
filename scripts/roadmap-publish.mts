import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";
import {
  replayRoadmapRuns,
  collectReplayWindows,
  mainPublicationJournals,
  unavailableRoadmapStateReport,
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
const prefix = `/repos/${repository}`;
type Sdk = Awaited<ReturnType<typeof createGitHubClient>>;
export interface PublicationApi {
  comments(): Promise<unknown[]>;
  create(body: string): Promise<unknown>;
  replace(id: number, body: string): Promise<unknown>;
  comment(id: number): Promise<unknown>;
}

/** The publisher owns identities/counts; the SDK owns page traversal. */
async function inventory(sdk: Sdk, endpoint: string, field?: "artifacts" | "workflow_runs") {
  const records: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  for await (const page of iterateGitHubPages(sdk, { url: endpoint })) {
    const data: unknown = page.data;
    const values = field ? record(data)[field] : data;
    if (!Array.isArray(values)) throw new Error("Publication inventory is incomplete");
    if (field) {
      const count = record(data).total_count;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        throw new Error("Publication inventory total is invalid");
      if (field === "workflow_runs" && count >= 1000) throw new ReplayWindowFull();
      total ??= count;
      if (count !== total) throw new Error("Publication inventory total changed");
    }
    for (const value of values as unknown[]) {
      const row = record(value),
        id = numeric(row.id);
      if (ids.has(id)) throw new Error("Publication inventory contains a duplicate identity");
      ids.add(id);
      records.push(row);
    }
    if (total !== undefined && records.length > total)
      throw new Error("Publication inventory exceeds its reported total");
  }
  if (total !== undefined && records.length !== total)
    throw new Error("Publication inventory does not match its reported total");
  return records;
}

export function createPublicationApi(sdk: Sdk): PublicationApi {
  const request = async (method: "GET" | "POST" | "PATCH", url: string, body?: string) =>
    (
      await sdk.request({
        method,
        url,
        ...(body === undefined ? {} : { data: { body } }),
        request: { portcove: { replay: method === "GET" ? "safe-read" : "once", attempts: 0 } },
      })
    ).data as unknown;
  return {
    comments: () => inventory(sdk, `${prefix}/issues/2414/comments?per_page=100`),
    create: (body) => request("POST", `${prefix}/issues/2414/comments`, body),
    replace: (id, body) => request("PATCH", `${prefix}/issues/comments/${numeric(id)}`, body),
    comment: (id) => request("GET", `${prefix}/issues/comments/${numeric(id)}`),
  };
}

async function publicationSdk() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Hosted report publication requires its explicit credential");
  let received = 0;
  return await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 10 * 60_000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) => {
      const route = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(`${prefix}/`)) return false;
      if (method === "POST") return route === "/issues/2414/comments";
      if (method === "PATCH") return /^\/issues\/comments\/[1-9]\d*$/u.test(route);
      return (
        method === "GET" &&
        (route === "/issues/2414/comments" ||
          /^\/issues\/comments\/[1-9]\d*$/u.test(route) ||
          /^\/actions\/runs\/[1-9]\d*(?:\/artifacts|\/attempts\/[1-9]\d*)?$/u.test(route) ||
          route === "/actions/workflows/roadmap-report.yml/runs")
      );
    },
    reserve: () => {
      const exhausted = () =>
        new GitHubApiError("budget_exhausted", "Publication metadata allowance exhausted");
      if (received >= 128 * 1024 * 1024) throw exhausted();
      return {
        consumeBytes(bytes) {
          received += bytes;
          if (received > 128 * 1024 * 1024) throw exhausted();
        },
        settle() {},
      };
    },
  });
}
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
  if (result.status !== 0) {
    const diagnostic = sanitizeOperationError(
      new Error(result.stderr || "Command execution failed"),
      {
        secrets: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter((value): value is string =>
          Boolean(value),
        ),
      },
    );
    throw new Error(`Publication command failed: ${executable}; ${diagnostic.message}`);
  }
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
async function comments(transport: PublicationApi) {
  return (await transport.comments())
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
async function existing(transport: PublicationApi) {
  const found = await comments(transport);
  if (found.length > 1)
    throw new Error("Multiple maintained reports; reconcile exact identities before publication");
  return found[0];
}

export async function writeMaintainedRoadmapReport(
  body: string,
  previous: unknown,
  transport: PublicationApi,
) {
  if (!body.startsWith(reportMarker) || Buffer.byteLength(body) > 65000)
    throw new Error("Invalid maintained report candidate");
  const before = await existing(transport);
  if (
    JSON.stringify(before ? { id: before.id, body: before.body } : null) !==
    JSON.stringify(previous)
  )
    throw new Error(
      "Maintained report changed outside the serialized publisher; refresh before writing",
    );
  if (before?.body === body) return numeric(before.id);
  const result = record(
    before ? await transport.replace(numeric(before.id), body) : await transport.create(body),
  );
  if (before && result.id !== before.id)
    throw new Error("Maintained report mutation identity differs; reconcile before retrying");
  const observed = record(await transport.comment(numeric(result.id)));
  if (observed.id !== result.id || observed.body !== body)
    throw new Error("Maintained report readback differs; reconcile before any retry");
  return numeric(result.id);
}
async function download(sdk: Sdk, run: number, name: string) {
  const artifacts = await inventory(
    sdk,
    `${prefix}/actions/runs/${run}/artifacts?per_page=100`,
    "artifacts",
  );
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
async function readState(sdk: Sdk, pointer: Record<string, unknown>): Promise<RoadmapReportState> {
  const run = numeric(pointer.run),
    attempt = numeric(pointer.attempt);
  const retainedRun = record((await sdk.request("GET " + `${prefix}/actions/runs/${run}`)).data);
  if (
    retainedRun.path !== ".github/workflows/roadmap-report.yml" ||
    retainedRun.head_branch !== "main"
  )
    throw new Error("State producer is not the trusted report workflow");
  const bytes = readBounded(
    path.join(await download(sdk, run, `roadmap-report-state-${run}-${attempt}`), "state.json"),
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
async function prepare(sdk: Sdk, api: PublicationApi) {
  const previous = await existing(api);
  let state: RoadmapReportState;
  if (previous) {
    try {
      const match = String(previous.body).match(/^<!-- portcove-roadmap-report:(\{[^\n]*\}) -->/u);
      if (!match?.[1]) throw new Error("Maintained report pointer is malformed");
      state = await readState(sdk, record(JSON.parse(match[1])));
    } catch (error) {
      const diagnostic = sanitizeOperationError(error);
      writeFileSync(path.join(directory, "state-error.json"), JSON.stringify(diagnostic));
      writeFileSync(
        path.join(directory, "body.md"),
        unavailableRoadmapStateReport(String(previous.body), diagnostic.message),
      );
      writeFileSync(
        path.join(directory, "preimage.json"),
        JSON.stringify({ id: previous.id, body: previous.body }),
      );
      writeFileSync(
        path.join(directory, "mode.json"),
        JSON.stringify({ mode: "state-unavailable" }),
      );
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, "state_available=false\n");
      return;
    }
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
      legacyRoadmapObservations(await api.comments(), repository),
    );
  }
  try {
    const until = new Date().toISOString();
    const runs = await collectReplayWindows(state.cursor, until, async (since, end) => {
      const query = encodeURIComponent(`${since}..${end}`);
      return await inventory(
        sdk,
        `${prefix}/actions/workflows/roadmap-report.yml/runs?per_page=100&branch=main&created=${query}`,
        "workflow_runs",
      );
    });
    const ownRun = record(
      (
        await sdk.request(
          "GET " + `${prefix}/actions/runs/${numeric(Number(process.env.GITHUB_RUN_ID))}`,
        )
      ).data,
    );
    if (!runs.some((run) => run.id === ownRun.id)) runs.push(ownRun);
    const trusted = mainPublicationJournals(runs);
    state = await replayRoadmapRuns(state, trusted, until, async ({ run: id, attempt }) => {
      const collector = record(
        (await sdk.request("GET " + `${prefix}/actions/runs/${id}/attempts/${attempt}`)).data,
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
      const destination = await download(sdk, id, `roadmap-diagnostics-${id}-${attempt}`);
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
  writeFileSync(path.join(directory, "mode.json"), JSON.stringify({ mode: "snapshot" }));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, "state_available=true\n");
}
async function publish(sdk: Sdk, api: PublicationApi) {
  const previous: unknown = JSON.parse(readBounded(path.join(directory, "preimage.json")));
  const mode = record(JSON.parse(readBounded(path.join(directory, "mode.json")))).mode;
  if (mode === "state-unavailable") {
    const body = readBounded(path.join(directory, "body.md"), 65000);
    if (
      !isRecord(previous) ||
      typeof previous.body !== "string" ||
      body.split("\n")[0] !== previous.body.split("\n")[0]
    )
      throw new Error("Unavailable-state publication must retain its original snapshot pointer");
    await writeMaintainedRoadmapReport(body, previous, api);
    return;
  }
  if (mode !== "snapshot") throw new Error("Publication mode is unavailable");
  const run = numeric(Number(process.env.GITHUB_RUN_ID)),
    attempt = numeric(Number(process.env.GITHUB_RUN_ATTEMPT));
  // Upload completes before making the snapshot pointer visible. An interrupted
  // publication leaves the old pointer, so the next event replays the receipts.
  const uploaded = readBounded(
    path.join(await download(sdk, run, `roadmap-report-state-${run}-${attempt}`), "state.json"),
  );
  if (uploaded !== readBounded(path.join(directory, "state.json")))
    throw new Error("Uploaded report state differs from the candidate");
  const body = readBounded(path.join(directory, "body.md"), 60000);
  await writeMaintainedRoadmapReport(body, previous, api);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(directory, { recursive: true });
  try {
    const operation = process.argv[2];
    if (!["prepare", "publish"].includes(operation ?? ""))
      throw new Error(
        "Usage: roadmap-publish.mts prepare|publish inside the serialized hosted publisher",
      );
    const sdk = await publicationSdk(),
      api = createPublicationApi(sdk);
    if (operation === "prepare") await prepare(sdk, api);
    else if (operation === "publish") await publish(sdk, api);
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
