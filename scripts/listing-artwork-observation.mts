import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { validArtworkCollection, validArtworkMapping } from "./catalog-cover-mapping.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { coverDeclarationScope } from "./listing-artwork-checkpoint.mts";
import {
  artworkHealthInventory,
  artworkHealthProducer,
  projectArtworkHealth,
} from "./maintenance-artwork-health.mts";
import { readCompleteRunArtifactInventoryAsync } from "./release-run-artifact-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflow = ".github/workflows/maintenance-inventory.yml";
const prefix = `/repos/${repository}/actions`;
const runPath = `${prefix}/workflows/maintenance-inventory.yml/runs`;
const listingsPath = "crates/portcove-core/catalog/listings.json";
const receiptPath = "cover-artwork-health.json";
const receiptEvidencePath = `maintenance-report/${receiptPath}`;
const evidencePath = "evidence.json";
const archiveLimit = 8 * 1024 * 1024;
const memberLimit = 256 * 1024;
const day = 24 * 60 * 60 * 1000;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface CoverHealthTransport {
  read: (path: string) => Promise<unknown>;
  download: (id: number, bytes: number) => Promise<Buffer>;
}

function readReviewedAncestor(revision: string, file: string) {
  execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], { timeout: 10_000 });
  return execFileSync("git", ["show", `${revision}:${file}`], {
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function hostedTransport(): Promise<CoverHealthTransport> {
  const deadline = performance.now() + 60_000;
  const credential = localDeveloperCredential({ deadline });
  let requests = 0;
  const client = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      (url.pathname === runPath ||
        /^\/repos\/boburning\/portcove\/actions\/runs\/[1-9][0-9]*\/artifacts$/u.test(
          url.pathname,
        )),
    reserve() {
      if (++requests > 5) throw new Error("Cover receipt request budget exceeded");
      return { consumeBytes() {}, settle() {} };
    },
  });
  return {
    read: async (path) =>
      (await client.request({ method: "GET", url: `https://api.github.com${path}` })).data,
    download: (id, bytes) =>
      downloadGitHubArtifactArchive(`repos/${repository}/actions/artifacts/${id}/zip`, {
        credential,
        deadline,
        maxBytes: bytes,
      }),
  };
}

function readReportMembers(archive: Buffer) {
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: archiveLimit,
    expandedBytes: 48 * 1024 * 1024,
    files: 64,
    nameBytes: 128,
    allowedPaths: new Set([receiptPath, evidencePath]),
    allowedFilePath: (name) => /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:jsonl?|md)$/u.test(name),
  });
  function read(name: string) {
    const entry = entries.find((member) => member.name === name);
    if (!entry || entry.bytes < 1 || entry.bytes > memberLimit)
      throw new Error("Missing or oversized cover receipt member");
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("Cover receipt member failed its integrity check");
    return bytes;
  }
  return { evidence: read(evidencePath), receipt: read(receiptPath) };
}

/** Authenticate an existing scheduled report as observation evidence only. */
export async function readHostedCoverHealth(
  readAncestorFile: (revision: string, file: string) => Buffer = readReviewedAncestor,
  options: { transport?: CoverHealthTransport; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const transport = options.transport ?? (await hostedTransport());
  const response = await transport.read(
    `${runPath}?event=schedule&branch=main&status=completed&per_page=1`,
  );
  if (
    !isRecord(response) ||
    !Array.isArray(response.workflow_runs) ||
    response.workflow_runs.length > 1
  )
    throw new Error("Invalid scheduled cover run inventory");
  const run: unknown = response.workflow_runs[0];
  if (run === undefined) return null;
  if (
    !isRecord(run) ||
    !positive(run.id) ||
    !positive(run.run_attempt) ||
    run.path !== workflow ||
    run.event !== "schedule" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    !isRecord(run.head_repository) ||
    run.head_repository.id !== repositoryId ||
    run.head_repository.full_name !== repository ||
    typeof run.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(run.head_sha) ||
    typeof run.run_started_at !== "string" ||
    typeof run.updated_at !== "string"
  )
    throw new Error("Unbound scheduled cover run");
  if (run.conclusion !== "success") return null;
  const started = Date.parse(run.run_started_at);
  const completed = Date.parse(run.updated_at);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started ||
    completed > now ||
    now - completed > day
  )
    return null;
  const artifacts = await readCompleteRunArtifactInventoryAsync((page) =>
    transport.read(`${prefix}/runs/${run.id}/artifacts?per_page=100&page=${page}`),
  );
  const matches = artifacts.artifacts.filter(
    (row) => row.name === `maintenance-report-${run.id}-${run.run_attempt}`,
  );
  if (!matches.length || (matches.length === 1 && matches[0]!.expired === true)) return null;
  const artifact = matches[0]!;
  if (
    matches.length !== 1 ||
    !positive(artifact.id) ||
    !positive(artifact.size_in_bytes) ||
    artifact.size_in_bytes > archiveLimit ||
    artifact.expired !== false ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.repository_id !== repositoryId ||
    artifact.workflow_run.head_repository_id !== repositoryId ||
    artifact.workflow_run.head_branch !== "main" ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
  )
    throw new Error("Unbound scheduled cover artifact");
  const listings = readAncestorFile(run.head_sha, listingsPath);
  const archive = await transport.download(artifact.id, artifact.size_in_bytes);
  if (archive.length !== artifact.size_in_bytes || `sha256:${hash(archive)}` !== artifact.digest)
    throw new Error("Scheduled cover artifact digest differs");
  const { evidence, receipt } = readReportMembers(archive);
  const recorded: unknown = JSON.parse(evidence.toString("utf8"));
  const report: unknown = JSON.parse(receipt.toString("utf8"));
  if (
    !isRecord(recorded) ||
    recorded.format !== "portcove-maintenance-hosted-evidence" ||
    recorded.format_version !== 1 ||
    recorded.purpose !== "schedule" ||
    !isRecord(recorded.run) ||
    recorded.run.id !== run.id ||
    recorded.run.attempt !== run.run_attempt ||
    recorded.run.event !== "schedule" ||
    recorded.run.head_sha !== run.head_sha ||
    !isRecord(recorded.outcomes) ||
    recorded.outcomes.collect !== "success" ||
    recorded.outcomes.report !== "success" ||
    !isRecord(recorded.files) ||
    !isRecord(recorded.files[receiptEvidencePath]) ||
    recorded.files[receiptEvidencePath].bytes !== receipt.length ||
    recorded.files[receiptEvidencePath].sha256 !== hash(receipt) ||
    !Array.isArray(recorded.sources) ||
    !isRecord(report) ||
    !digest(report.cli_sha256) ||
    typeof report.observed_at !== "string" ||
    !Number.isFinite(Date.parse(report.observed_at)) ||
    Date.parse(report.observed_at) < started ||
    Date.parse(report.observed_at) > completed
  )
    throw new Error("Unbound scheduled cover observation");
  const producer = artworkHealthProducer(
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_SHA: run.head_sha,
      GITHUB_WORKFLOW_SHA: run.head_sha,
      GITHUB_RUN_ID: String(run.id),
      GITHUB_RUN_ATTEMPT: String(run.run_attempt),
      GITHUB_REF: "refs/heads/main",
    },
    run.head_sha,
  );
  const producerDirectory: unknown = JSON.parse(listings.toString("utf8"));
  const projected = projectArtworkHealth(report, {
    inventory: artworkHealthInventory(producerDirectory),
    listingsSha256: hash(listings),
    cliSha256: report.cli_sha256,
    producer,
    now: Date.parse(report.observed_at),
  });
  const admissions = (recorded.sources as unknown[]).filter(
    (row) => isRecord(row) && row.source === "cover-artwork-health",
  );
  if (
    admissions.length !== 1 ||
    !isRecord(admissions[0]) ||
    admissions[0].source_revision !== projected.revision + "#sha256:" + hash(receipt) ||
    (admissions[0].coverage !== "complete" && admissions[0].coverage !== "partial")
  )
    throw new Error("Scheduled report did not admit the exact cover observation");
  return {
    ...projected,
    artifact: artifact.digest,
    producer,
    producerDirectory,
  };
}

/** Bind an observation to each current exact declaration, including collection
 * members. Changed data can be reviewed, but this path cannot accept new bytes.
 */
export function applicableCoverHealth(
  current: { listings: Record<string, unknown>[] },
  evidence: NonNullable<Awaited<ReturnType<typeof readHostedCoverHealth>>>,
) {
  const source = evidence.producerDirectory;
  if (!isRecord(source) || !Array.isArray(source.listings))
    throw new Error("Cover receipt has no producer declaration scope");
  const original = new Map(
    (source.listings as unknown[]).filter(isRecord).map((row) => [row.id, row]),
  );
  return current.listings.flatMap((row) => {
    const originalRow = original.get(row.id);
    if (typeof row.id !== "string" || !originalRow) return [];
    const covers = validArtworkMapping(row.artwork)
      ? [row.artwork]
      : validArtworkCollection(row.collection_covers)
        ? row.collection_covers
        : [];
    return covers.flatMap((artwork) => {
      const scope = coverDeclarationScope(row, artwork);
      const fact = evidence.facts.get(`port:${row.id}@${artwork.image_id}`);
      if (
        !isRecord(fact) ||
        (fact.status !== "unchanged" && fact.status !== "gone" && fact.status !== "mismatch") ||
        scope !== coverDeclarationScope(originalRow, artwork) ||
        orderedJsonSha256(fact.artwork) !== orderedJsonSha256(artwork)
      )
        return [];
      return [
        {
          id: row.id,
          artwork,
          scope,
          observed_at: fact.observed_at,
          report: evidence.artifact,
          status:
            fact.status === "mismatch"
              ? "hold_changed_bytes"
              : fact.status === "gone"
                ? "propose_fallback"
                : "verified_accepted_bytes",
        },
      ];
    });
  });
}
