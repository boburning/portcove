import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedEvidenceFile } from "./development-evidence.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { zipJsonEntry } from "./maintenance-release-health.mts";
import { RECORDED_FAILURES, retainedCheckpointLimit, SIGNAL_CAP } from "./release-content-scan.mts";
import { readCompleteRunArtifactInventoryAsync } from "./release-run-artifact-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflowId = 417668017;
const archiveLimit = 8 * 1024 * 1024;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const recentRunLimit = 20;
// Four natural runs per day. This covers the 30-day retention window.
const recentRunPages = 8;
const priorAttemptLimit = 20;
const scanRuns = "actions/workflows/release-content-scan.yml/runs?branch=main&event=schedule";
export const releaseScanProducerQuery = `${scanRuns}&per_page=${recentRunLimit}`;
export const releaseScanSuccessQuery = `${scanRuns}&status=success&per_page=1`;

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release scan checkpoint: ${message}`);
}

const wholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const presentText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const scanKey = (value: unknown): value is string =>
  presentText(value) && /^r[1-9][0-9]*\|(?:github|gitlab)\|[^|]+\|.+/u.test(value);
const signalKinds = new Set([
  "rom-or-disc-image",
  "original-executable",
  "cartridge-header",
  "console-bios",
  "shader-cache",
]);

function scanRecord(row: Record<string, unknown>) {
  const { repository, tag, asset, key, rules } = row;
  return (
    wholeNumber(rules) &&
    rules > 0 &&
    scanKey(key) &&
    presentText(repository) &&
    presentText(tag) &&
    presentText(asset) &&
    ["github", "gitlab"].some((provider) =>
      key.startsWith(`r${rules}|${provider}|${repository.toLowerCase()}|${tag}|${asset}|`),
    ) &&
    [row.id, row.platform].every(presentText) &&
    typeof row.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(row.sha256) &&
    wholeNumber(row.entries) &&
    wholeNumber(row.heads_unread) &&
    typeof row.heads_truncated === "boolean" &&
    Array.isArray(row.signals) &&
    row.signals.length <= SIGNAL_CAP &&
    wholeNumber(row.signal_count) &&
    row.signal_count >= row.signals.length &&
    row.signals.every(
      (signal: unknown) =>
        isRecord(signal) &&
        presentText(signal.path) &&
        presentText(signal.reason) &&
        typeof signal.kind === "string" &&
        signalKinds.has(signal.kind),
    )
  );
}

function scanAttempt(row: Record<string, unknown>) {
  return (
    wholeNumber(row.rules) &&
    row.rules > 0 &&
    scanKey(row.key) &&
    row.key.startsWith(`r${row.rules}|`) &&
    wholeNumber(row.checked_at)
  );
}

function validateRows(value: unknown, validate: (row: Record<string, unknown>) => boolean) {
  if (!Array.isArray(value)) return false;
  const entries: unknown[] = value;
  const keys = new Set<string>();
  for (const row of entries) {
    if (!isRecord(row) || !scanKey(row.key) || keys.has(row.key) || !validate(row)) return false;
    keys.add(row.key);
  }
  return true;
}

function validateCheckpoint(value: unknown) {
  requireEvidence(
    isRecord(value) &&
      value.format_version === 1 &&
      validateRows(value.records, scanRecord) &&
      validateRows(
        value.failures,
        (row) =>
          RECORDED_FAILURES.some((code) => code === row.code) && wholeNumber(row.max_asset_bytes),
      ) &&
      validateRows(value.retries, scanAttempt) &&
      validateRows(
        value.deferred_attempts,
        (row) =>
          scanAttempt(row) &&
          (row.capacity_required === undefined ||
            (wholeNumber(row.capacity_required) && row.capacity_required > 0)),
      ),
    "invalid checkpoint document",
  );
  const serialized = `${JSON.stringify(value)}\n`;
  requireEvidence(
    Buffer.byteLength(serialized) <= retainedCheckpointLimit,
    "checkpoint exceeds budget",
  );
  return serialized;
}

type RunLookup = (endpoint: string) => Promise<unknown>;
type CurrentSchedule = { id: number; number: number; attempt: number };

function scanRun(run: unknown, now: number) {
  requireEvidence(
    isRecord(run) &&
      Number.isSafeInteger(run.id) &&
      Number(run.id) > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      Number(run.run_attempt) > 0 &&
      Number.isSafeInteger(run.run_number) &&
      Number(run.run_number) > 0 &&
      run.workflow_id === workflowId &&
      isRecord(run.head_repository) &&
      run.head_repository.id === repositoryId &&
      run.head_branch === "main" &&
      run.event === "schedule" &&
      typeof run.status === "string" &&
      (run.status === "completed" ? typeof run.conclusion === "string" : run.conclusion === null) &&
      typeof run.head_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(run.head_sha) &&
      typeof run.updated_at === "string" &&
      Number.isFinite(Date.parse(run.updated_at)) &&
      Date.parse(run.updated_at) <= now,
    "unexpected producer identity",
  );
  return {
    id: Number(run.id),
    number: Number(run.run_number),
    attempt: Number(run.run_attempt),
    completed: run.status === "completed",
    success: run.conclusion === "success",
    sha: run.head_sha,
    updated: Date.parse(run.updated_at),
  };
}

async function latestScanProducer(get: RunLookup, now: number, current?: CurrentSchedule) {
  let total: number | undefined;
  let lastNumber = Infinity;
  const seen = new Set<number>();
  const accept = (producer: ReturnType<typeof scanRun>) => {
    requireEvidence(
      !current || producer.number <= current.number,
      "a newer schedule already advanced the checkpoint",
    );
    return producer;
  };
  // Reruns update the list entry for the original run. Inspect its exact
  // prior attempts before considering any older producer.
  let priorAttempts = 0;
  for (let page = 1; page <= recentRunPages; page++) {
    const result = await get(
      page === 1 ? releaseScanProducerQuery : `${releaseScanProducerQuery}&page=${page}`,
    );
    requireEvidence(
      isRecord(result) &&
        wholeNumber(result.total_count) &&
        (total === undefined || total === result.total_count) &&
        Array.isArray(result.workflow_runs) &&
        result.workflow_runs.length === Math.min(recentRunLimit, result.total_count - seen.size),
      "incomplete schedule lookup",
    );
    total = result.total_count;
    const rows: unknown[] = result.workflow_runs;
    const runs = rows.map((raw) => scanRun(raw, now));
    for (const run of runs) {
      requireEvidence(
        !seen.has(run.id) && run.number < lastNumber,
        "schedule lookup is not in producer order",
      );
      seen.add(run.id);
      lastNumber = run.number;
    }
    for (const listed of runs) {
      if (listed.id === current?.id)
        requireEvidence(listed.number === current.number, "running schedule identity differs");
      const beforeCurrent =
        listed.id === current?.id ? Math.min(current.attempt - 1, listed.attempt) : listed.attempt;
      for (let attempt = beforeCurrent; attempt > 0; attempt--) {
        let producer = listed;
        if (attempt !== listed.attempt) {
          requireEvidence(
            ++priorAttempts <= priorAttemptLimit,
            "previous attempt lookup exceeds budget",
          );
          producer = scanRun(await get(`actions/runs/${listed.id}/attempts/${attempt}`), now);
        }
        requireEvidence(
          producer.id === listed.id &&
            producer.number === listed.number &&
            producer.sha === listed.sha &&
            producer.attempt === attempt &&
            (producer === listed || producer.completed),
          "previous attempt identity differs",
        );
        if (producer.completed && producer.success) return accept(producer);
      }
    }
    if (total === seen.size) return undefined;
  }
  // The schedule window covers retention. An older successful run from the
  // server-filtered view can establish expiry if every recent schedule failed.
  const result = await get(releaseScanSuccessQuery);
  requireEvidence(
    isRecord(result) &&
      wholeNumber(result.total_count) &&
      Array.isArray(result.workflow_runs) &&
      result.workflow_runs.length === Math.min(1, result.total_count),
    "incomplete historical success lookup",
  );
  if (result.workflow_runs.length === 0) return undefined;
  const producer = scanRun(result.workflow_runs[0], now);
  requireEvidence(
    producer.completed &&
      producer.success &&
      producer.number < lastNumber &&
      now - producer.updated >= retentionMs,
    "successful producer is beyond the retained schedule lookup budget",
  );
  return accept(producer);
}

export async function loadReleaseScanCheckpoint(
  get: RunLookup,
  download: (id: number, bytes: number) => Promise<Buffer>,
  now: number,
  current?: CurrentSchedule,
) {
  const run = await latestScanProducer(get, now, current);
  if (!run) return { source: "empty" } as const;
  const runPath = `actions/runs/${run.id}`;
  const { artifacts } = await readCompleteRunArtifactInventoryAsync((page) =>
    get(`${runPath}/artifacts?per_page=100&page=${page}`),
  );
  const matches = artifacts.filter(
    (artifact) => artifact.name === `release-content-checkpoint-${run.id}-${run.attempt}`,
  );
  requireEvidence(matches.length <= 1, "duplicate checkpoint artifacts");
  const artifact = matches[0];
  if (!artifact) {
    if (now - run.updated >= retentionMs) return { source: "expired" } as const;
    // The exact attempt identifies the old cache producer during rollout.
    const jobs = await get(`${runPath}/attempts/${run.attempt}/jobs?per_page=100`);
    requireEvidence(
      isRecord(jobs) &&
        jobs.total_count === 1 &&
        Array.isArray(jobs.jobs) &&
        jobs.jobs.length === 1,
      "cannot confirm the preceding attempt used the cache",
    );
    const job: unknown = jobs.jobs[0];
    requireEvidence(
      isRecord(job) &&
        job.name === "scan" &&
        Array.isArray(job.steps) &&
        job.steps.some(
          (step: unknown) =>
            isRecord(step) &&
            step.name === "Preserve scanned-asset checkpoint" &&
            step.conclusion === "success",
        ),
      "checkpoint absent from an artifact-producing attempt",
    );
    return {
      source: "legacy",
      cache: `release-content-scan-v1-main-${run.id}-${run.attempt}`,
    } as const;
  }
  requireEvidence(
    isRecord(artifact.workflow_run) &&
      artifact.workflow_run.id === run.id &&
      artifact.workflow_run.repository_id === repositoryId &&
      artifact.workflow_run.head_repository_id === repositoryId &&
      artifact.workflow_run.head_branch === "main" &&
      artifact.workflow_run.head_sha === run.sha &&
      typeof artifact.expired === "boolean" &&
      typeof artifact.digest === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      Number(artifact.size_in_bytes) >= 22 &&
      Number(artifact.size_in_bytes) <= archiveLimit,
    "artifact metadata is unbound or exceeds budget",
  );
  if (artifact.expired) return { source: "expired" } as const;
  const archive = await download(Number(artifact.id), Number(artifact.size_in_bytes));
  requireEvidence(
    archive.length === artifact.size_in_bytes &&
      `sha256:${createHash("sha256").update(archive).digest("hex")}` === artifact.digest,
    "download size or digest differs from the run artifact",
  );
  const checkpoint = validateCheckpoint(zipJsonEntry(archive, "checkpoint.json"));
  return { source: "artifact", checkpoint, run: run.id, attempt: run.attempt } as const;
}

async function main([mode, filename]: string[]) {
  requireEvidence(
    filename && (mode === "restore" || mode === "check"),
    "expected restore or check and a file",
  );
  if (mode === "check") {
    const { bytes } = await readBoundedEvidenceFile(filename, retainedCheckpointLimit);
    validateCheckpoint(JSON.parse(bytes.toString("utf8")));
    return;
  }
  const deadline = performance.now() + 120_000;
  const current =
    process.env.GITHUB_EVENT_NAME === "schedule"
      ? {
          id: Number(process.env.GITHUB_RUN_ID),
          number: Number(process.env.GITHUB_RUN_NUMBER),
          attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        }
      : undefined;
  requireEvidence(
    !current || Object.values(current).every((value) => Number.isSafeInteger(value) && value > 0),
    "invalid running schedule identity",
  );
  const credential = localDeveloperCredential({ deadline });
  let requests = 0;
  const sdk = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 2 * 1024 * 1024,
    allowRequest: (method, url) =>
      method === "GET" && url.pathname.startsWith(`/repos/${repository}/actions/`),
    reserve() {
      requireEvidence(
        ++requests <= priorAttemptLimit + recentRunPages + 6,
        "lookup exceeded its request budget",
      );
      return { consumeBytes() {}, settle() {} };
    },
  });
  const result = await loadReleaseScanCheckpoint(
    async (endpoint) =>
      (
        await sdk.request({
          method: "GET",
          url: `https://api.github.com/repos/${repository}/${endpoint}`,
        })
      ).data as unknown,
    (id, maxBytes) =>
      downloadGitHubArtifactArchive(`repos/${repository}/actions/artifacts/${id}/zip`, {
        credential,
        deadline,
        maxBytes,
      }),
    Date.now(),
    current,
  );
  if (result.source === "artifact") {
    await writeFile(filename, result.checkpoint, { flag: "wx" });
    process.stderr.write(
      `Restored checkpoint from scheduled run ${String(result.run)} attempt ${String(result.attempt)}.\n`,
    );
  } else {
    process.stderr.write(`Release scan checkpoint source: ${result.source}.\n`);
  }
  process.stdout.write(`source=${result.source}\n`);
  if (result.source === "legacy") process.stdout.write(`cache=${result.cache}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
