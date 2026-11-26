import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
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
const maximumReceiptBytes = 16 * 1024 * 1024;
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
  const receipt = {
    format: receiptFormat,
    format_version: 1,
    run_id: positiveId(context.GITHUB_RUN_ID),
    run_attempt: positiveId(context.GITHUB_RUN_ATTEMPT),
    source_revision: head,
    preview_listed_date: report.automatic_listed_date,
    patch_sha256: report.admission.sha256,
    handoff_sha256: report.handoff_semantic_sha256,
    handoff,
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > maximumReceiptBytes)
    throw new Error("Scheduled discovery receipt exceeds its handoff byte bound.");
  return bytes;
}

// Only fixed GitHub REST paths and numeric IDs reach gh. Read the archive as
// bytes so no downloaded filename or Git patch is ever applied.
function githubApi(route: string, maxBuffer: number) {
  return execFileSync(
    "gh",
    ["api", "--method", "GET", "--hostname", "github.com", "--allow-escape-sequences", route],
    { timeout: 60_000, maxBuffer, windowsHide: true },
  );
}

export function verifyScheduledDiscoveryReplay(
  locator: string,
  read: (route: string, maximumBytes: number) => Buffer = githubApi,
) {
  const parts = locator.split("/");
  if (parts.length !== 2) throw new Error("Use RUN_ID/ATTEMPT for scheduled discovery replay.");
  const run = positiveId(parts[0]);
  const attempt = positiveId(parts[1]);
  const base = `repos/${repository}/actions/runs/${run}`;
  const attemptPath = `${base}/attempts/${attempt}`;
  const json = (route: string): unknown => readDocument(read(route, 4 * 1024 * 1024));
  const source = json(attemptPath);
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
  const jobs = json(`${attemptPath}/jobs?per_page=100`);
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
  const artifacts = json(`${base}/artifacts?name=${name}&per_page=100`);
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
  const archiveLimit = maximumReceiptBytes + 4096;
  const archive = read(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, archiveLimit);
  if (`sha256:${sha256(archive)}` !== artifact.digest)
    throw new Error("Discovery replay archive differs from the GitHub artifact digest.");
  const { entries } = inspectBoundedZip(
    archive,
    {
      compressedBytes: archiveLimit,
      expandedBytes: maximumReceiptBytes,
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
  if (bytes.length !== entry.bytes) throw new Error("Discovery replay receipt size differs.");
  const receipt = readDocument(bytes);
  if (
    !isRecord(receipt) ||
    receipt.format !== receiptFormat ||
    receipt.format_version !== 1 ||
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
