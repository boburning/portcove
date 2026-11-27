import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { validArtworkCollection, validArtworkMapping } from "./catalog-cover-mapping.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { listingDirectoryTextMaximum } from "./listing-directory-carrier.mts";
import {
  coverDeclarationScope,
  legacyCoverDeclarationScope,
} from "./listing-artwork-checkpoint.mts";
import {
  readScheduledGameMediaProposal,
  scheduledGameMediaFile,
  scheduledGameMediaLimit,
} from "./listing-scheduled-game-media.mts";
import {
  artworkHealthInventory,
  artworkHealthProducer,
  mediaHealthInventory,
  projectArtworkHealth,
  projectMediaArtworkHealth,
} from "./maintenance-artwork-health.mts";
import { readCompleteRunArtifactInventoryAsync } from "./release-run-artifact-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflow = ".github/workflows/maintenance-inventory.yml";
const prefix = `/repos/${repository}/actions`;
const runPath = `${prefix}/workflows/maintenance-inventory.yml/runs`;
const listingsPath = "crates/portcove-core/catalog/listings.json";
const artworkSources = {
  cover: { source: "cover-artwork-health", generation: "scheduled-artwork-health" },
  media: { source: "media-artwork-health", generation: "scheduled-media-health" },
} as const;
const evidencePath = "evidence.json";
const archiveLimit = 8 * 1024 * 1024;
const memberLimit = 256 * 1024;
const day = 24 * 60 * 60 * 1000;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface ArtworkHealthTransport {
  read: (path: string) => Promise<unknown>;
  download: (id: number, bytes: number) => Promise<Buffer>;
}

function readReviewedAncestor(revision: string, file: string) {
  execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], { timeout: 10_000 });
  return execFileSync("git", ["show", `${revision}:${file}`], {
    timeout: 10_000,
    maxBuffer: listingDirectoryTextMaximum,
  });
}

async function hostedTransport(): Promise<ArtworkHealthTransport> {
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
      if (++requests > 5) throw new Error("Artwork receipt request budget exceeded");
      return { consumeBytes() {}, settle() {} };
    },
  });
  return {
    read: async (path): Promise<unknown> => {
      const response = await client.request({
        method: "GET",
        url: `https://api.github.com${path}`,
      });
      const data: unknown = response.data;
      return data;
    },
    download: (id, bytes) =>
      downloadGitHubArtifactArchive(`repos/${repository}/actions/artifacts/${id}/zip`, {
        credential,
        deadline,
        maxBytes: bytes,
      }),
  };
}

function readReportMembers(archive: Buffer, allowedPaths?: ReadonlySet<string>) {
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: archiveLimit,
    expandedBytes: 48 * 1024 * 1024,
    files: 64,
    nameBytes: 128,
    // The successful producer emits this inert report alongside the receipt.
    // It participates in ZIP bounds but is never inflated or interpreted here.
    allowedPaths: allowedPaths ?? new Set([evidencePath, "report/index.html"]),
    ...(allowedPaths
      ? {}
      : {
          allowedFilePath: (name: string) =>
            /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:jsonl?|md)$/u.test(name),
        }),
  });
  function read(name: string, maximum = memberLimit) {
    const entry = entries.find((member) => member.name === name);
    if (!entry || entry.bytes < 1 || entry.bytes > maximum)
      throw new Error("Missing or oversized artwork receipt member");
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("Artwork receipt member failed its integrity check");
    return bytes;
  }
  return { read, has: (name: string) => entries.some((entry) => entry.name === name) };
}

type ArtworkReadOptions = { transport?: ArtworkHealthTransport; now?: number };
async function readRecentArtworkRun(options: ArtworkReadOptions) {
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
    throw new Error("Invalid scheduled artwork run inventory");
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
    throw new Error("Unbound scheduled artwork run");
  // Discovery and restore run alongside collection. Their failure does not
  // invalidate independently admitted observations in the exact report.
  if (run.conclusion !== "success" && run.conclusion !== "failure") return null;
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
  const { id: runId, run_attempt: runAttempt, head_sha: head } = run;
  const artifacts = await readCompleteRunArtifactInventoryAsync((page) =>
    transport.read(`${prefix}/runs/${runId}/artifacts?per_page=100&page=${page}`),
  );
  async function download(stem: string) {
    const matches = artifacts.artifacts.filter(
      (row) => row.name === `${stem}-${runId}-${runAttempt}`,
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
      artifact.workflow_run.id !== runId ||
      artifact.workflow_run.repository_id !== repositoryId ||
      artifact.workflow_run.head_repository_id !== repositoryId ||
      artifact.workflow_run.head_branch !== "main" ||
      artifact.workflow_run.head_sha !== head ||
      typeof artifact.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
    )
      throw new Error("Unbound scheduled artwork artifact");
    const archive = await transport.download(artifact.id, artifact.size_in_bytes);
    if (archive.length !== artifact.size_in_bytes || `sha256:${hash(archive)}` !== artifact.digest)
      throw new Error("Scheduled artwork artifact digest differs");
    return { archive, digest: artifact.digest };
  }
  return { runId, runAttempt, head, started, completed, download };
}

/** Authenticate an existing scheduled report as observation evidence only. */
export async function readHostedArtworkHealth(
  readAncestorFile: (revision: string, file: string) => Buffer = readReviewedAncestor,
  options: ArtworkReadOptions = {},
) {
  const run = await readRecentArtworkRun(options);
  if (!run) return null;
  const artifact = await run.download("maintenance-report");
  if (!artifact) return null;
  const { archive } = artifact;
  const { runId, runAttempt, started, completed } = run;
  const reportMembers = readReportMembers(archive);
  const recorded: unknown = JSON.parse(reportMembers.read(evidencePath).toString("utf8"));
  if (
    !isRecord(recorded) ||
    recorded.format !== "portcove-maintenance-hosted-evidence" ||
    recorded.format_version !== 1 ||
    recorded.purpose !== "schedule" ||
    !isRecord(recorded.run) ||
    recorded.run.id !== runId ||
    recorded.run.attempt !== runAttempt ||
    recorded.run.event !== "schedule" ||
    recorded.run.head_sha !== run.head ||
    !isRecord(recorded.outcomes) ||
    recorded.outcomes.collect !== "success" ||
    recorded.outcomes.report !== "success" ||
    !isRecord(recorded.files) ||
    !Array.isArray(recorded.sources)
  )
    throw new Error("Unbound scheduled artwork evidence");
  const files = recorded.files;
  const sources: readonly unknown[] = recorded.sources;
  const producer = artworkHealthProducer(
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_SHA: run.head,
      GITHUB_WORKFLOW_SHA: run.head,
      GITHUB_RUN_ID: String(runId),
      GITHUB_RUN_ATTEMPT: String(runAttempt),
      GITHUB_REF: "refs/heads/main",
    },
    run.head,
  );
  const artifactDigest = artifact.digest;
  let catalog: { producerDirectory: unknown; listingsSha256: string } | undefined;
  function boundReceipt(kind: keyof typeof artworkSources) {
    const { source, generation } = artworkSources[kind];
    const name = `${source}.json`;
    const file = files[`maintenance-report/${name}`];
    const boundGeneration = `${generation}:${runId}-${runAttempt}@${producer.revision}#sha256:`;
    const admissions = sources.filter(
      (row) =>
        isRecord(row) &&
        row.source === source &&
        typeof row.source_revision === "string" &&
        row.source_revision.startsWith(boundGeneration),
    );
    if (!reportMembers.has(name)) {
      if (file !== undefined || admissions.length)
        throw new Error(`Scheduled ${kind} report omitted referenced observation bytes`);
      return null;
    }
    const receipt = reportMembers.read(name);
    const receiptDigest = hash(receipt);
    if (!isRecord(file) || file.bytes !== receipt.length || file.sha256 !== receiptDigest)
      throw new Error(`Scheduled ${kind} observation differs from the evidence inventory`);
    if (!admissions.length) return null;
    const admission = admissions[0];
    if (
      admissions.length !== 1 ||
      !isRecord(admission) ||
      admission.source_revision !== boundGeneration + receiptDigest ||
      (admission.coverage !== "complete" && admission.coverage !== "partial")
    )
      throw new Error(`Scheduled report did not admit the exact ${kind} observation`);
    const report: unknown = JSON.parse(receipt.toString("utf8"));
    if (!isRecord(report) || !digest(report.cli_sha256) || typeof report.observed_at !== "string")
      throw new Error(`Unbound scheduled ${kind} observation`);
    const at = Date.parse(report.observed_at);
    if (!Number.isFinite(at) || at < started || at > completed)
      throw new Error(`Unbound scheduled ${kind} observation`);
    if (!catalog) {
      const listings = readAncestorFile(producer.revision, listingsPath);
      const producerDirectory: unknown = JSON.parse(listings.toString("utf8"));
      catalog = { producerDirectory, listingsSha256: hash(listings) };
    }
    return {
      report,
      ...catalog,
      cliSha256: report.cli_sha256,
      producer,
      now: at,
      artifact: artifactDigest,
      receiptDigest,
      coverage: admission.coverage,
    };
  }
  return {
    cover() {
      const context = boundReceipt("cover");
      if (!context) return null;
      return {
        ...projectArtworkHealth(context.report, {
          ...context,
          inventory: artworkHealthInventory(context.producerDirectory),
        }),
        artifact: context.artifact,
        producer: context.producer,
        producerDirectory: context.producerDirectory,
      };
    },
    media() {
      const context = boundReceipt("media");
      if (!context) return null;
      const projected = projectMediaArtworkHealth(context.report, {
        ...context,
        inventory: mediaHealthInventory(context.producerDirectory),
      });
      if (context.coverage !== (projected.complete ? "complete" : "partial"))
        throw new Error("Scheduled media coverage differs from the admitted observation");
      return {
        ...projected,
        revision: `${projected.revision}#sha256:${context.receiptDigest}`,
        artifact: context.artifact,
        producer: context.producer,
      };
    },
  };
}

/** Consume the narrow proposal only from authenticated scheduled-main custody. */
export async function readHostedScheduledGameMedia(
  readAncestorFile: (revision: string, file: string) => Buffer = readReviewedAncestor,
  options: ArtworkReadOptions = {},
) {
  const run = await readRecentArtworkRun(options);
  if (!run) return null;
  const artifact = await run.download("maintenance-game-media");
  if (!artifact) return null;
  const proposalFile = `proposal/${scheduledGameMediaFile}`;
  const archive = readReportMembers(
    artifact.archive,
    new Set([
      "status.json",
      proposalFile,
      "proposal/artwork-evidence.json",
      "proposal/catalog-proposal.json",
      "proposal/listing-media-proposal.json",
      "proposal/proposal-evidence.json",
    ]),
  );
  if (!archive.has(proposalFile)) return null;
  const status: unknown = JSON.parse(archive.read("status.json").toString("utf8"));
  if (
    !isRecord(status) ||
    status.format_version !== 1 ||
    (status.state !== "attempted" && status.state !== "partial") ||
    !positive(status.attempted) ||
    !positive(status.selected) ||
    status.selected > 48 ||
    status.attempted > status.selected
  )
    throw new Error("Scheduled media proposal has no completed artwork assessment");
  const proposal = readScheduledGameMediaProposal(
    JSON.parse(archive.read(proposalFile, scheduledGameMediaLimit).toString("utf8")),
  );
  if (
    proposal.selected_ids.length !== status.selected ||
    new Set(proposal.additions.map(({ id }) => id)).size > status.attempted
  )
    throw new Error("Scheduled media proposal exceeds its assessed workset");
  const producer: unknown = JSON.parse(readAncestorFile(run.head, listingsPath).toString("utf8"));
  if (
    !isRecord(producer) ||
    !Array.isArray(producer.listings) ||
    !producer.listings.every(isRecord)
  )
    throw new Error("Scheduled media proposal has no canonical producer directory");
  return {
    proposal,
    producerListings: producer.listings,
    artifact: artifact.digest,
  };
}

export async function readHostedCoverHealth(...args: Parameters<typeof readHostedArtworkHealth>) {
  return (await readHostedArtworkHealth(...args))?.cover() ?? null;
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
    const { id } = row;
    if (typeof id !== "string") return [];
    const originalRow = original.get(id);
    if (!originalRow) return [];
    const covers = validArtworkMapping(row.artwork)
      ? [row.artwork]
      : validArtworkCollection(row.collection_covers)
        ? row.collection_covers
        : [];
    return covers.flatMap((artwork) => {
      const scope = coverDeclarationScope(row, artwork);
      const fact = evidence.facts.get(`port:${id}@${artwork.image_id}`);
      if (
        !isRecord(fact) ||
        (fact.status !== "unchanged" && fact.status !== "gone" && fact.status !== "mismatch") ||
        !validArtworkMapping(fact.artwork) ||
        scope !== coverDeclarationScope(originalRow, fact.artwork)
      )
        return [];
      return [
        {
          id,
          artwork,
          scope,
          legacy_scopes: [
            ...new Set([
              legacyCoverDeclarationScope(row, artwork),
              legacyCoverDeclarationScope(originalRow, fact.artwork),
            ]),
          ],
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
