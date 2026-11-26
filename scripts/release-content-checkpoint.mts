import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedEvidenceFile } from "./development-evidence.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { zipJsonEntry } from "./maintenance-release-health.mts";
import { readCompleteRunArtifactInventoryAsync } from "./release-run-artifact-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflowId = 417668017;
const archiveLimit = 8 * 1024 * 1024;
// Leave room for the ZIP container even when deflation does not save space.
const checkpointLimit = archiveLimit - 64 * 1024;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
export const releaseScanProducerQuery =
  "actions/workflows/release-content-scan.yml/runs?branch=main&event=schedule&status=success&per_page=1";

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release scan checkpoint: ${message}`);
}

function validateCheckpoint(value: unknown) {
  requireEvidence(
    isRecord(value) &&
      value.format_version === 1 &&
      [value.records, value.failures, value.retries, value.deferred_attempts].every(
        (entries) => Array.isArray(entries) && entries.every(isRecord),
      ),
    "invalid checkpoint document",
  );
  const serialized = `${JSON.stringify(value)}\n`;
  requireEvidence(Buffer.byteLength(serialized) <= checkpointLimit, "checkpoint exceeds budget");
  return serialized;
}

export async function loadReleaseScanCheckpoint(
  get: (endpoint: string) => Promise<unknown>,
  download: (id: number, bytes: number) => Promise<Buffer>,
  now: number,
) {
  const result = await get(releaseScanProducerQuery);
  requireEvidence(
    isRecord(result) &&
      Number.isSafeInteger(result.total_count) &&
      Number(result.total_count) >= 0 &&
      Array.isArray(result.workflow_runs) &&
      result.workflow_runs.length === Math.min(1, Number(result.total_count)),
    "incomplete successful schedule lookup",
  );
  if (!result.workflow_runs.length) return { source: "empty" } as const;
  const run: unknown = result.workflow_runs[0];
  requireEvidence(
    isRecord(run) &&
      Number.isSafeInteger(run.id) &&
      Number(run.id) > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      Number(run.run_attempt) > 0 &&
      run.workflow_id === workflowId &&
      isRecord(run.head_repository) &&
      run.head_repository.id === repositoryId &&
      run.head_branch === "main" &&
      run.event === "schedule" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      typeof run.head_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(run.head_sha) &&
      typeof run.updated_at === "string" &&
      Number.isFinite(Date.parse(run.updated_at)) &&
      Date.parse(run.updated_at) <= now,
    "unexpected producer identity",
  );
  const runPath = `actions/runs/${Number(run.id)}`;
  const { artifacts } = await readCompleteRunArtifactInventoryAsync((page) =>
    get(`${runPath}/artifacts?per_page=100&page=${page}`),
  );
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name === `release-content-checkpoint-${Number(run.id)}-${Number(run.run_attempt)}`,
  );
  requireEvidence(matches.length <= 1, "duplicate checkpoint artifacts");
  const artifact = matches[0];
  if (!artifact) {
    if (now - Date.parse(run.updated_at) >= retentionMs) return { source: "expired" } as const;
    // The exact attempt identifies the old cache producer during rollout.
    const jobs = await get(`${runPath}/attempts/${Number(run.run_attempt)}/jobs?per_page=100`);
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
    return { source: "legacy" } as const;
  }
  requireEvidence(
    isRecord(artifact.workflow_run) &&
      artifact.workflow_run.id === run.id &&
      artifact.workflow_run.repository_id === repositoryId &&
      artifact.workflow_run.head_repository_id === repositoryId &&
      artifact.workflow_run.head_branch === "main" &&
      artifact.workflow_run.head_sha === run.head_sha &&
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
  return { source: "artifact", checkpoint, run: run.id, attempt: run.run_attempt } as const;
}

async function main([mode, filename]: string[]) {
  requireEvidence(
    filename && (mode === "restore" || mode === "check"),
    "expected restore or check and a file",
  );
  if (mode === "check") {
    const { bytes } = await readBoundedEvidenceFile(filename, checkpointLimit);
    validateCheckpoint(JSON.parse(bytes.toString("utf8")));
    return;
  }
  const deadline = performance.now() + 120_000;
  const credential = localDeveloperCredential({ deadline });
  let requests = 0;
  const sdk = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 2 * 1024 * 1024,
    allowRequest: (method, url) =>
      method === "GET" && url.pathname.startsWith(`/repos/${repository}/actions/`),
    reserve() {
      requireEvidence(++requests <= 6, "lookup exceeded its request budget");
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
  );
  if (result.source === "artifact") {
    await writeFile(filename, result.checkpoint, { flag: "wx" });
    process.stderr.write(
      `Restored checkpoint from scheduled run ${String(result.run)} attempt ${String(result.attempt)}.\n`,
    );
  } else {
    process.stderr.write(`Release scan checkpoint source: ${result.source}.\n`);
  }
  process.stdout.write(`${result.source}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
