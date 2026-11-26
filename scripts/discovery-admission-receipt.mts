import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import {
  downloadGitHubArtifactArchive,
  observerCheckpointArchiveLimit,
} from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflowId = 416797406;
const workflowPath = ".github/workflows/maintenance-inventory.yml";
const preparationStep = "Prepare listing admission from scheduled discovery evidence";
const uploadStep = "Retain scheduled listing admission replay receipt";
const receiptFile = "listing-admission-replay.json";
const receiptFormat = "portcove-scheduled-listing-admission-replay";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitSha = /^[a-f0-9]{40}$/u;
const sha = /^[a-f0-9]{64}$/u;

function positiveId(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Scheduled discovery requires positive numeric run and attempt IDs.");
  return Number(value);
}

function readDocument(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8"));
}

export function scheduledDiscoveryReplayReceipt(
  report: {
    admission: { sha256: string } | null;
    released_validation?: { status: string };
    automatic_listed_date?: string | undefined;
    handoff_semantic_sha256: string;
    changed_records: readonly string[];
  },
  handoff: unknown,
  context: NodeJS.ProcessEnv,
) {
  if (!report.admission) return null;
  const head = context.GITHUB_SHA ?? "";
  if (
    context.GITHUB_EVENT_NAME !== "schedule" ||
    context.GITHUB_REPOSITORY !== repository ||
    context.GITHUB_WORKFLOW_REF !== `${repository}/${workflowPath}@refs/heads/main` ||
    context.GITHUB_WORKFLOW_SHA !== head ||
    !gitSha.test(head) ||
    report.released_validation?.status !== "validated" ||
    report.handoff_semantic_sha256 !== orderedJsonSha256(handoff)
  )
    throw new Error("Scheduled discovery receipt requires the approved read-only producer.");
  const prepared = new Set(report.changed_records);
  if (
    !prepared.size ||
    prepared.size !== report.changed_records.length ||
    !isRecord(handoff) ||
    !Array.isArray(handoff.candidates)
  )
    throw new Error("Scheduled discovery receipt requires unique prepared candidates.");
  const candidates = (handoff.candidates as unknown[]).filter(
    (row) => isRecord(row) && typeof row.id === "string" && prepared.delete(row.id),
  );
  if (prepared.size || candidates.length !== report.changed_records.length)
    throw new Error("Prepared discovery candidates differ from the approved handoff.");
  const replayHandoff = { ...handoff, candidates };
  const receipt = {
    format: receiptFormat,
    format_version: 2,
    run_id: positiveId(context.GITHUB_RUN_ID),
    run_attempt: positiveId(context.GITHUB_RUN_ATTEMPT),
    source_revision: head,
    preview_listed_date: report.automatic_listed_date,
    patch_sha256: report.admission.sha256,
    source_handoff_sha256: report.handoff_semantic_sha256,
    handoff_sha256: orderedJsonSha256(replayHandoff),
    handoff: replayHandoff,
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > observerCheckpointArchiveLimit)
    throw new Error("Scheduled discovery receipt exceeds its handoff byte bound.");
  return bytes;
}

async function githubReplayReader(paths: readonly string[]) {
  const deadline = performance.now() + 120_000;
  const credential = localDeveloperCredential({ deadline });
  const client = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 4 * 1024 * 1024,
    allowRequest: (method, url) =>
      method === "GET" && paths.includes(`${url.pathname.slice(1)}${url.search}`),
  });
  return async (route: string): Promise<unknown> =>
    paths.includes(route)
      ? (await client.request({ method: "GET", url: `https://api.github.com/${route}` })).data
      : downloadGitHubArtifactArchive(route, {
          credential,
          deadline,
          maxBytes: observerCheckpointArchiveLimit,
          bufferAllowance: "observer-checkpoint",
        });
}

export async function verifyScheduledDiscoveryReplay(
  locator: string,
  read?: (route: string) => Promise<unknown>,
) {
  const parts = locator.split("/");
  if (parts.length !== 2) throw new Error("Use RUN_ID/ATTEMPT for scheduled discovery replay.");
  const run = positiveId(parts[0]);
  const attempt = positiveId(parts[1]);
  const base = `repos/${repository}/actions/runs/${run}`;
  const attemptPath = `${base}/attempts/${attempt}`;
  const artifactList = `${base}/artifacts?name=listing-admission-replay-${run}-${attempt}&per_page=100`;
  const jobsPath = `${attemptPath}/jobs?per_page=100`;
  const load = read ?? (await githubReplayReader([attemptPath, jobsPath, artifactList]));
  const source = await load(attemptPath);
  if (
    !isRecord(source) ||
    source.id !== run ||
    source.run_attempt !== attempt ||
    source.workflow_id !== workflowId ||
    source.path !== workflowPath ||
    source.status !== "completed" ||
    source.event !== "schedule" ||
    source.head_branch !== "main" ||
    !isRecord(source.repository) ||
    source.repository.id !== repositoryId ||
    !isRecord(source.head_repository) ||
    source.head_repository.id !== repositoryId ||
    typeof source.head_sha !== "string" ||
    !gitSha.test(source.head_sha)
  )
    throw new Error("Expected a completed scheduled Portcove maintenance attempt on main.");

  // An unrelated job may fail after discovery succeeds. Require the one
  // discovery job and both successful steps within the exact attempt.
  const jobs = await load(jobsPath);
  if (!isRecord(jobs) || !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw new Error("Scheduled discovery job enumeration is incomplete.");
  const discovery = jobs.jobs.filter((job: unknown) => isRecord(job) && job.name === "discover");
  const job: unknown = discovery[0];
  if (
    discovery.length !== 1 ||
    !isRecord(job) ||
    job.run_id !== run ||
    job.run_attempt !== attempt ||
    job.head_sha !== source.head_sha ||
    job.conclusion !== "success" ||
    !Array.isArray(job.steps) ||
    ![preparationStep, uploadStep].every(
      (name) =>
        (job.steps as unknown[]).filter(
          (step) => isRecord(step) && step.name === name && step.conclusion === "success",
        ).length === 1,
    )
  )
    throw new Error("Expected a successful scheduled discovery preparation and receipt upload.");

  const name = `listing-admission-replay-${run}-${attempt}`;
  const artifacts = await load(artifactList);
  if (!isRecord(artifacts) || artifacts.total_count !== 1 || !Array.isArray(artifacts.artifacts))
    throw new Error("Expected exactly one retained discovery replay artifact.");
  const artifact: unknown = artifacts.artifacts[0];
  if (
    artifacts.artifacts.length !== 1 ||
    !isRecord(artifact) ||
    artifact.name !== name ||
    artifact.expired !== false ||
    typeof artifact.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== run ||
    artifact.workflow_run.repository_id !== repositoryId ||
    artifact.workflow_run.head_repository_id !== repositoryId ||
    artifact.workflow_run.head_branch !== "main" ||
    artifact.workflow_run.head_sha !== source.head_sha
  )
    throw new Error("Discovery replay artifact metadata differs from the scheduled source.");
  const archivePath = `repos/${repository}/actions/artifacts/${artifact.id}/zip`;
  const archive = await load(archivePath);
  if (!Buffer.isBuffer(archive) || `sha256:${sha256(archive)}` !== artifact.digest)
    throw new Error("Discovery replay archive differs from the GitHub artifact digest.");
  const { entries } = inspectBoundedZip(
    archive,
    {
      compressedBytes: observerCheckpointArchiveLimit,
      expandedBytes: observerCheckpointArchiveLimit,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set([receiptFile]),
    },
    { deadline: Date.now() + 30_000 },
  );
  const entry = entries[0];
  if (entries.length !== 1 || !entry) throw new Error("Discovery replay archive has no receipt.");
  const payload = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? payload
      : inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.bytes) });
  if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
    throw new Error("Discovery replay receipt member integrity differs.");
  const receipt = readDocument(bytes);
  if (
    !isRecord(receipt) ||
    receipt.format !== receiptFormat ||
    (receipt.format_version !== 1 && receipt.format_version !== 2) ||
    (receipt.format_version === 2 &&
      (typeof receipt.source_handoff_sha256 !== "string" ||
        !sha.test(receipt.source_handoff_sha256))) ||
    receipt.run_id !== run ||
    receipt.run_attempt !== attempt ||
    receipt.source_revision !== source.head_sha ||
    typeof receipt.preview_listed_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(receipt.preview_listed_date) ||
    typeof receipt.patch_sha256 !== "string" ||
    !sha.test(receipt.patch_sha256) ||
    !isRecord(receipt.handoff) ||
    receipt.handoff_sha256 !== orderedJsonSha256(receipt.handoff)
  )
    throw new Error("Discovery replay receipt differs from its scheduled source or handoff.");
  return {
    handoff: receipt.handoff,
    revision: source.head_sha,
    expectedPatchSha256: receipt.patch_sha256,
    previewListedDate: receipt.preview_listed_date,
  };
}
