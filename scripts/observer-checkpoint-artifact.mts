/** Inert, bounded continuation data. Never source, artifact or publication authority. */
import { createHash, randomUUID } from "node:crypto";
import { crc32, inflateRawSync, gzipSync, gunzipSync } from "node:zlib";
import { lstat, mkdir, rename, rm, writeFile, open, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorCode } from "./runtime-values.mts";
import { readBoundedEvidenceFile } from "./development-evidence.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { GitHubApiClient, createGitHubRunner, rateLimitFromResponse } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { readCompleteRunArtifactInventory } from "./release-run-artifact-inventory.mts";
import {
  validateCatalogObserverCheckpoint,
  newCatalogObserverCheckpoint,
  catalogObservationSources,
} from "./catalog-upstream-observer.mts";
import {
  validateObserverCheckpoint,
  withCheckpointLock,
  observerCheckpointByteLimit,
} from "./observe-configured-upstream.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  decodeStoredObserverCheckpoint,
  encodeStoredObserverCheckpoint,
} from "./observer-checkpoint-storage.mts";

// One existing response envelope is reserved inside the sixteen-MiB output budget.
export const observerSnapshotLimit = 4 * 1024 * 1024;
const repository = "boburning/portcove",
  repositoryId = 1354613114;
const workflow = ".github/workflows/configured-upstream-observer.yml";
const workflowId = 354075266;
const maximumAge = 24 * 3600000;
const member = "checkpoint.json";
const binarySnapshotMagic = Buffer.from("PORTCOVE-OBSERVER-SNAPSHOT-3\n", "ascii");
// Already-compressed members can grow slightly under ZIP's deflate framing.
// Keep that packaging inside the existing four-MiB complete archive budget.
const binaryMemberLimit = observerSnapshotLimit - 16 * 1024;
// One owner-approved fresh baseline after the retained loss. Scheduled history,
// not an evictable checkpoint, consumes this sole opportunity even on failure.
export const observerBaselinePermit = {
  id: "2026-11-02-checkpoint-history-loss",
  after_run: 41476042003,
  after_source: "9b48f20021789ff1dee0217ed0865b06742e68db",
  after_created_at: "2026-11-02T15:53:33Z",
  main_anchor: "c66e450e0c63b1e77204f45f1edf2a60fdc54208",
  config_sha256: "d86c2102f21e1b1ce66b8a5de52de954250aaf4a037fdf6fab7887f622e19889",
} as const;
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Producer = { run: number; attempt: number; source: string };
type Snapshot = {
  format: 1;
  authority: "observer-checkpoint-cache-only";
  repository: typeof repository;
  repository_id: number;
  workflow: typeof workflow;
  ref: "refs/heads/main";
  config_sha256: string;
  created_at: string;
  producer: Producer;
  files: Record<string, unknown>;
};
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Observer recovery: ${message}`);
}
function exactKeys(raw: Record<string, unknown>, keys: string) {
  requireValue(
    Object.keys(raw).sort().join(",") === keys.split(",").sort().join(","),
    "unknown or missing fields",
  );
}
function producer(raw: unknown): asserts raw is Producer {
  requireValue(isRecord(raw), "producer missing");
  exactKeys(raw, "run,attempt,source");
  requireValue(
    Number.isSafeInteger(raw.run) &&
      Number(raw.run) > 0 &&
      Number.isSafeInteger(raw.attempt) &&
      Number(raw.attempt) > 0 &&
      typeof raw.source === "string" &&
      /^[a-f0-9]{40}$/u.test(raw.source),
    "producer identity invalid",
  );
}
export function snapshotName(config: string, value: Producer) {
  producer(value);
  requireValue(/^[a-f0-9]{64}$/u.test(config), "configuration digest invalid");
  return `upstream-observer-checkpoint-${config}-${value.run}-${value.attempt}`;
}

/** Validate the complete graph before any filesystem publication. Changed current
 * catalog/Core inputs are subsequently invalidated by their existing owners. */
export function validateObserverSnapshot(
  raw: unknown,
  config: string,
  now: number,
  deadline = Infinity,
  clock = Date.now,
) {
  requireValue(isRecord(raw), "snapshot missing");
  exactKeys(
    raw,
    "format,authority,repository,repository_id,workflow,ref,config_sha256,created_at,producer,files",
  );
  requireValue(
    raw.format === 1 &&
      raw.authority === "observer-checkpoint-cache-only" &&
      raw.repository === repository &&
      raw.repository_id === repositoryId &&
      raw.workflow === workflow &&
      raw.ref === "refs/heads/main" &&
      raw.config_sha256 === config &&
      /^[a-f0-9]{64}$/u.test(config),
    "snapshot scope differs",
  );
  producer(raw.producer);
  requireValue(
    typeof raw.created_at === "string" &&
      Number.isFinite(Date.parse(raw.created_at)) &&
      Date.parse(raw.created_at) <= now &&
      now - Date.parse(raw.created_at) <= maximumAge,
    "snapshot age unavailable",
  );
  requireValue(
    isRecord(raw.files) && Buffer.byteLength(JSON.stringify(raw)) <= observerCheckpointByteLimit,
    "decoded snapshot exceeds checkpoint read envelope",
  );
  const controller = validateCatalogObserverCheckpoint(raw.files["catalog/checkpoint.json"], now);
  const configs = new Map<
    string,
    NonNullable<(typeof controller.sources)[string]["current_config"]>
  >();
  const required = new Set<string>();
  for (const progress of Object.values(controller.sources)) {
    for (const config of [
      progress.current_config,
      progress.last_complete_config,
      ...progress.retired_configs,
    ])
      if (config) configs.set(`${observationHash(config)}/checkpoint.json`, config);
    if (progress.last_complete_config)
      required.add(`${observationHash(progress.last_complete_config)}/checkpoint.json`);
    if (progress.current_config)
      required.add(`${observationHash(progress.current_config)}/checkpoint.json`);
  }
  for (const [name, value] of Object.entries(raw.files)) {
    requireValue(clock() < deadline, "snapshot validation deadline exhausted");
    if (name === "catalog/checkpoint.json") continue;
    requireValue(
      /^[a-f0-9]{64}\/checkpoint\.json$/u.test(name) && configs.has(name),
      "foreign checkpoint path",
    );
    requireValue(value !== null, "missing checkpoint value");
    validateObserverCheckpoint(
      decodeStoredObserverCheckpoint(value, deadline, clock),
      configs.get(name)!,
    );
  }
  for (const name of required)
    requireValue(Object.hasOwn(raw.files, name), "referenced complete checkpoint missing");
  return raw as unknown as Snapshot;
}

async function optionalFile(root: string, filename: string, maximum = observerCheckpointByteLimit) {
  await assertOwnedUnlinkedPath(root, filename, "observer snapshot input");
  try {
    const metadata = await lstat(filename);
    requireValue(
      metadata.isFile() && metadata.nlink === 1,
      "checkpoint is not an unlinked regular file",
    );
    return (await readBoundedEvidenceFile(filename, maximum)).bytes;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
async function collectUnlockedObserverSnapshot(
  root: string,
  config: string,
  expected: Producer,
  now = Date.now(),
  deadline = Infinity,
  compact = false,
  log?: (value: Record<string, number>) => void,
) {
  requireValue(Date.now() < deadline, "snapshot collection deadline exhausted");
  const work = await assertOwnedUnlinkedPath(
      root,
      path.join(root, "work"),
      "observer work directory",
    ),
    directory = path.join(work, "upstream-observer");
  const bytes = await optionalFile(
    work,
    path.join(directory, "catalog/checkpoint.json"),
    observerCheckpointByteLimit,
  );
  requireValue(bytes, "controller checkpoint absent");
  const controller = validateCatalogObserverCheckpoint(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    now,
  );
  const files: Record<string, unknown> = { "catalog/checkpoint.json": controller };
  const configs = new Map<
    string,
    NonNullable<(typeof controller.sources)[string]["current_config"]>
  >();
  for (const progress of Object.values(controller.sources))
    for (const config of [
      progress.current_config,
      progress.last_complete_config,
      ...progress.retired_configs,
    ])
      if (config) configs.set(`${observationHash(config)}/checkpoint.json`, config);
  const metrics = {
    input_bytes: bytes.length,
    logical_json_bytes: Buffer.byteLength(JSON.stringify(controller)),
    stored_json_bytes: Buffer.byteLength(JSON.stringify(controller)),
    largest_source_json_bytes: 0,
    checkpoint_files: 1,
    compacted_sources: 0,
  };
  for (const [name, sourceConfig] of configs) {
    requireValue(Date.now() < deadline, "snapshot collection deadline exhausted");
    const value = await optionalFile(work, path.join(directory, name));
    if (!value) continue;
    metrics.input_bytes += value.length;
    const parsed = decodeStoredObserverCheckpoint(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
      deadline,
    );
    validateObserverCheckpoint(parsed, sourceConfig);
    const logicalBytes = Buffer.byteLength(JSON.stringify(parsed));
    const stored = compact ? encodeStoredObserverCheckpoint(parsed, deadline) : parsed;
    const storedBytes = Buffer.byteLength(JSON.stringify(stored));
    metrics.logical_json_bytes += logicalBytes;
    metrics.stored_json_bytes += compact ? storedBytes : value.length;
    metrics.largest_source_json_bytes = Math.max(metrics.largest_source_json_bytes, logicalBytes);
    metrics.checkpoint_files++;
    if (storedBytes < logicalBytes) metrics.compacted_sources++;
    if (metrics.stored_json_bytes > observerCheckpointByteLimit) log?.(metrics);
    requireValue(
      metrics.stored_json_bytes <= observerCheckpointByteLimit,
      "decoded snapshot exceeds checkpoint read envelope; checkpoints retained",
    );
    files[name] = stored;
  }
  requireValue(Date.now() < deadline, "snapshot collection deadline exhausted");
  log?.(metrics);
  return validateObserverSnapshot(
    {
      format: 1,
      authority: "observer-checkpoint-cache-only",
      repository,
      repository_id: repositoryId,
      workflow,
      ref: "refs/heads/main",
      config_sha256: config,
      created_at: new Date(now).toISOString(),
      producer: expected,
      files,
    },
    config,
    now,
    deadline,
  );
}

export async function collectCompactObserverSnapshot(
  root: string,
  config: string,
  expected: Producer,
  now = Date.now(),
  deadline = Infinity,
  log?: (value: Record<string, number>) => void,
) {
  await assertOwnedUnlinkedPath(root, path.join(root, "work"), "observer work directory");
  return withCheckpointLock(path.join(root, "work/upstream-observer/catalog/checkpoint.json"), () =>
    collectUnlockedObserverSnapshot(root, config, expected, now, deadline, true, log),
  );
}

export async function collectObserverSnapshot(
  root: string,
  config: string,
  expected: Producer,
  now = Date.now(),
  deadline = Infinity,
) {
  await assertOwnedUnlinkedPath(root, path.join(root, "work"), "observer work directory");
  return withCheckpointLock(path.join(root, "work/upstream-observer/catalog/checkpoint.json"), () =>
    collectUnlockedObserverSnapshot(root, config, expected, now, deadline),
  );
}

/** Transfer representation only. The complete graph is retained losslessly;
 * the physical artifact reserve remains four MiB. Expansion shares the existing
 * checkpoint reader's thirty-two-MiB bound, now across the entire snapshot. */
export function encodeObserverSnapshot(snapshot: Snapshot, deadline = Infinity) {
  requireValue(Date.now() < deadline, "snapshot encoding deadline exhausted");
  validateObserverSnapshot(snapshot, snapshot.config_sha256, Date.now(), deadline);
  const decoded = Buffer.from(JSON.stringify(snapshot));
  const compressed = gzipSync(decoded, { maxOutputLength: observerSnapshotLimit });
  const bytes = Buffer.from(
    JSON.stringify({
      format: 2,
      encoding: "gzip-base64",
      expanded_bytes: decoded.length,
      sha256: sha256(decoded),
      payload: compressed.toString("base64"),
    }),
  );
  requireValue(Date.now() < deadline, "snapshot encoding deadline exhausted");
  requireValue(
    bytes.length <= observerSnapshotLimit,
    "encoded snapshot exceeds reserved output envelope; checkpoints retained",
  );
  return {
    bytes,
    decoded_bytes: decoded.length,
    checkpoint_files: Object.keys(snapshot.files).length,
  };
}

/** Binary transfer avoids base64 expansion of the already compact stored graph.
 * The complete member stays four MiB, expansion stays thirty-two MiB. */
export function encodeCompactObserverSnapshot(snapshot: Snapshot, deadline = Infinity) {
  requireValue(Date.now() < deadline, "snapshot encoding deadline exhausted");
  validateObserverSnapshot(snapshot, snapshot.config_sha256, Date.now(), deadline);
  const decoded = Buffer.from(JSON.stringify(snapshot));
  const compressed = gzipSync(decoded, { level: 9, maxOutputLength: observerSnapshotLimit });
  const header = Buffer.from(
    JSON.stringify({
      format: 3,
      encoding: "gzip",
      expanded_bytes: decoded.length,
      sha256: sha256(decoded),
    }) + "\n",
  );
  requireValue(header.length <= 512, "binary snapshot header too large");
  const bytes = Buffer.concat([binarySnapshotMagic, header, compressed]);
  requireValue(
    Date.now() < deadline && bytes.length <= binaryMemberLimit,
    "encoded snapshot exceeds reserved output envelope; checkpoints retained",
  );
  return {
    bytes,
    decoded_bytes: decoded.length,
    checkpoint_files: Object.keys(snapshot.files).length,
  };
}

function decodeObserverSnapshot(bytes: Buffer, config: string, now: number, deadline: number) {
  requireValue(
    bytes.length <= observerSnapshotLimit && Date.now() < deadline,
    "snapshot transfer envelope unavailable",
  );
  if (bytes.subarray(0, binarySnapshotMagic.length).equals(binarySnapshotMagic)) {
    const end = bytes.indexOf(10, binarySnapshotMagic.length);
    requireValue(
      end > binarySnapshotMagic.length && end - binarySnapshotMagic.length <= 512,
      "binary snapshot header invalid",
    );
    const header: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(binarySnapshotMagic.length, end),
      ),
    );
    requireValue(isRecord(header), "binary snapshot header missing");
    exactKeys(header, "format,encoding,expanded_bytes,sha256");
    requireValue(
      header.format === 3 &&
        header.encoding === "gzip" &&
        Number.isSafeInteger(header.expanded_bytes) &&
        Number(header.expanded_bytes) > 0 &&
        Number(header.expanded_bytes) <= observerCheckpointByteLimit &&
        typeof header.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(header.sha256),
      "binary snapshot fields invalid",
    );
    const decoded = gunzipSync(bytes.subarray(end + 1), {
      maxOutputLength: Number(header.expanded_bytes),
    });
    requireValue(
      Date.now() < deadline &&
        decoded.length === header.expanded_bytes &&
        sha256(decoded) === header.sha256,
      "binary snapshot integrity differs",
    );
    return validateObserverSnapshot(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)),
      config,
      now,
      deadline,
    );
  }
  const wire: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  // Previously produced uncompressed artifacts keep their original wire bound.
  if (isRecord(wire) && wire.format === 1)
    return validateObserverSnapshot(wire, config, now, deadline);
  requireValue(isRecord(wire), "encoded snapshot missing");
  exactKeys(wire, "format,encoding,expanded_bytes,sha256,payload");
  requireValue(
    wire.format === 2 &&
      wire.encoding === "gzip-base64" &&
      Number.isSafeInteger(wire.expanded_bytes) &&
      Number(wire.expanded_bytes) > 0 &&
      Number(wire.expanded_bytes) <= observerCheckpointByteLimit &&
      typeof wire.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(wire.sha256) &&
      typeof wire.payload === "string" &&
      wire.payload.length > 0,
    "encoded snapshot fields invalid",
  );
  const compressed = Buffer.from(wire.payload, "base64");
  requireValue(compressed.toString("base64") === wire.payload, "snapshot base64 is not canonical");
  const decoded = gunzipSync(compressed, { maxOutputLength: Number(wire.expanded_bytes) });
  requireValue(
    Date.now() < deadline &&
      decoded.length === wire.expanded_bytes &&
      sha256(decoded) === wire.sha256,
    "decoded snapshot integrity differs",
  );
  return validateObserverSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)),
    config,
    now,
    deadline,
  );
}

export function readObserverSnapshotArchive(
  archive: Buffer,
  config: string,
  now: number,
  deadline: number,
) {
  const { entries } = inspectBoundedZip(
    archive,
    {
      compressedBytes: observerSnapshotLimit,
      expandedBytes: observerSnapshotLimit,
      files: 1,
      nameBytes: 32,
      allowedPaths: new Set([member]),
    },
    { deadline },
  );
  requireValue(entries.length === 1, "snapshot archive inventory differs");
  const entry = entries[0]!;
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
  requireValue(
    Date.now() < deadline && bytes.length === entry.bytes && crc32(bytes) === entry.crc,
    "snapshot archive integrity differs",
  );
  return decodeObserverSnapshot(bytes, config, now, deadline);
}

/** Publish an entirely absent tree in one rename. Never blend partial cache data. */
export async function publishObserverSnapshot(
  root: string,
  snapshot: Snapshot,
  deadline = Infinity,
  now = Date.now,
) {
  requireValue(now() < deadline, "snapshot publication deadline exhausted");
  validateObserverSnapshot(snapshot, snapshot.config_sha256, now(), deadline, now);
  const work = await assertOwnedUnlinkedPath(
    root,
    path.join(root, "work"),
    "observer work directory",
  );
  await mkdir(work, { recursive: true });
  const destination = await assertOwnedUnlinkedPath(
    work,
    path.join(work, "upstream-observer"),
    "observer restore",
  );
  const lock = await open(
    await assertOwnedUnlinkedPath(work, `${destination}.restore.lock`, "observer restore lock"),
    "wx",
  );
  const staging = path.join(work, `observer-restore-${randomUUID()}`);
  const absent = async () => {
    try {
      await lstat(destination);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    throw new Error("Observer recovery: destination exists; preserve it");
  };
  try {
    await absent();
    await mkdir(staging);
    for (const [name, value] of Object.entries(snapshot.files)) {
      requireValue(now() < deadline, "snapshot publication deadline exhausted");
      const filename = path.join(staging, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, JSON.stringify(value), { flag: "wx" });
    }
    await assertOwnedUnlinkedPath(work, destination, "observer restore");
    await absent();
    requireValue(now() < deadline, "snapshot publication deadline exhausted");
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await lock.close();
    await rm(`${destination}.restore.lock`);
  }
}

type RecoveryOptions = {
  root: string;
  config: string;
  current: Producer;
  deadline: number;
  api: GitHubRestReader;
  download?: typeof readGitHubArtifactArchive;
  now?: () => number;
  log?: (event: {
    route: string;
    response_bytes: number;
    total_bytes: number;
    requests: number;
  }) => void;
};

/** Complete ordered prefix through the retention boundary, not an all-history
 * inventory. Keep the existing hundred-record ceiling without eagerly fetching
 * a hundred large GitHub run records for a six-hour scheduled consumer. */
function scheduledRunWindow(read: (route: string) => unknown, currentRun: number, now: number) {
  const runs: Record<string, unknown>[] = [],
    seen = new Set<number>();
  let total: number | undefined,
    previousCreated = Infinity;
  for (let page = 1; page <= 10; page++) {
    const raw = read(
      `actions/workflows/${workflowId}/runs?branch=main&event=schedule&per_page=10&page=${page}`,
    );
    requireValue(
      isRecord(raw) &&
        Array.isArray(raw.workflow_runs) &&
        Number.isSafeInteger(raw.total_count) &&
        Number(raw.total_count) >= 0,
      "recent scheduled run inventory incomplete",
    );
    total ??= Number(raw.total_count);
    requireValue(
      raw.total_count === total &&
        raw.workflow_runs.length === Math.min(10, Math.max(0, total - runs.length)),
      "scheduled run inventory changed or omitted records",
    );
    for (const value of raw.workflow_runs) {
      requireValue(
        isRecord(value) &&
          Number.isSafeInteger(value.id) &&
          Number(value.id) > 0 &&
          !seen.has(Number(value.id)) &&
          typeof value.created_at === "string" &&
          Number.isFinite(Date.parse(value.created_at)) &&
          Date.parse(value.created_at) <= previousCreated,
        "run inventory invalid or unordered",
      );
      seen.add(Number(value.id));
      previousCreated = Date.parse(value.created_at);
      runs.push(value);
    }
    const boundary = runs.some(
      (value) =>
        value.id !== currentRun &&
        value.status === "completed" &&
        ["success", "failure"].includes(String(value.conclusion)) &&
        typeof value.created_at === "string" &&
        now - Date.parse(value.created_at) > maximumAge,
    );
    if (runs.length === total || boundary) return { runs, complete: runs.length === total };
  }
  return { runs, complete: runs.length === total };
}

/** No caller flag can renew this permit. Only the first natural schedule after
 * the pinned failed run may replace an absent tree with explicitly unknown data. */
async function initializeApprovedBaseline(
  read: (route: string) => unknown,
  inventory: ReturnType<typeof scheduledRunWindow>,
  options: RecoveryOptions,
  now: () => number,
) {
  const { current, root, config, deadline } = options;
  const permit = observerBaselinePermit;
  const currentIndex = inventory.runs.findIndex((run) => run.id === current.run);
  const anchorIndex = inventory.runs.findIndex((run) => run.id === permit.after_run);
  if (
    config !== permit.config_sha256 ||
    current.attempt !== 1 ||
    currentIndex < 0 ||
    anchorIndex !== currentIndex + 1
  )
    return null;
  const anchor = inventory.runs[anchorIndex]!,
    active = inventory.runs[currentIndex]!;
  const assertRun = (raw: unknown, expected: Producer, created: unknown) => {
    requireValue(
      isRecord(raw) &&
        raw.id === expected.run &&
        raw.run_attempt === expected.attempt &&
        raw.head_sha === expected.source &&
        raw.workflow_id === workflowId &&
        raw.path === workflow &&
        raw.event === "schedule" &&
        raw.head_branch === "main" &&
        isRecord(raw.repository) &&
        raw.repository.id === repositoryId &&
        isRecord(raw.head_repository) &&
        raw.head_repository.id === repositoryId &&
        raw.created_at === created &&
        typeof created === "string" &&
        Number.isFinite(Date.parse(created)) &&
        Date.parse(created) <= now(),
      "one-time baseline producer identity differs",
    );
  };
  assertRun(
    anchor,
    { run: permit.after_run, attempt: 1, source: permit.after_source },
    permit.after_created_at,
  );
  requireValue(
    anchor.status === "completed" &&
      anchor.conclusion === "failure" &&
      now() - Date.parse(permit.after_created_at) <= maximumAge &&
      typeof active.created_at === "string" &&
      Date.parse(active.created_at) > Date.parse(permit.after_created_at) &&
      inventory.runs.every(
        (run) =>
          run.id === current.run ||
          run.id === permit.after_run ||
          Date.parse(String(run.created_at)) > Date.parse(String(active.created_at)) ||
          Date.parse(String(run.created_at)) < Date.parse(permit.after_created_at),
      ),
    "one-time baseline schedule boundary differs",
  );
  assertRun(active, current, active.created_at);
  const verifyCurrent = () => {
    const raw = read(`actions/runs/${current.run}`);
    assertRun(raw, current, active.created_at);
    requireValue(
      isRecord(raw) && raw.status === "in_progress" && raw.conclusion === null,
      "baseline run is not active",
    );
  };
  verifyCurrent();
  const ancestry = read(`compare/${permit.main_anchor}...${current.source}?per_page=1&page=2`);
  requireValue(
    isRecord(ancestry) &&
      ["ahead", "identical"].includes(String(ancestry.status)) &&
      isRecord(ancestry.merge_base_commit) &&
      ancestry.merge_base_commit.sha === permit.main_anchor,
    "baseline source is not retained main ancestry",
  );
  const inputs: Record<string, string> = {};
  const documents: Record<string, unknown> = {};
  for (const [key, filename, limit] of [
    ["config", "release/upstream-observer.json", 16384],
    ["catalog", "crates/portcove-core/catalog/catalog.json", 4 * 1024 * 1024],
    ["listings", "crates/portcove-core/catalog/listings.json", 8 * 1024 * 1024],
  ] as const) {
    await assertOwnedUnlinkedPath(root, path.join(root, filename), "baseline source input");
    const local = (await readBoundedEvidenceFile(path.join(root, filename), limit)).bytes;
    const metadata = read(`contents/${filename}?ref=${current.source}`);
    const blob = createHash("sha1").update(`blob ${local.length}\0`).update(local).digest("hex");
    requireValue(
      isRecord(metadata) &&
        metadata.type === "file" &&
        metadata.path === filename &&
        metadata.size === local.length &&
        metadata.sha === blob,
      "baseline source input differs",
    );
    inputs[key] = sha256(local);
    documents[key] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(local));
  }
  requireValue(
    inputs.config === config &&
      isRecord(documents.catalog) &&
      isRecord(documents.listings) &&
      Array.isArray(documents.listings.listings),
    "baseline catalog/configuration differs",
  );
  catalogObservationSources({ ...documents.catalog, listings: documents.listings.listings });
  verifyCurrent();
  const after = scheduledRunWindow(read, current.run, now());
  const identities = (runs: typeof inventory.runs) =>
    JSON.stringify(runs.map((run) => [run.id, run.run_attempt, run.head_sha, run.created_at]));
  requireValue(
    identities(after.runs) === identities(inventory.runs) && after.complete === inventory.complete,
    "baseline schedule changed during admission",
  );
  for (const [key, filename, limit] of [
    ["config", "release/upstream-observer.json", 16384],
    ["catalog", "crates/portcove-core/catalog/catalog.json", 4 * 1024 * 1024],
    ["listings", "crates/portcove-core/catalog/listings.json", 8 * 1024 * 1024],
  ] as const) {
    await assertOwnedUnlinkedPath(root, path.join(root, filename), "baseline source readback");
    requireValue(
      sha256((await readBoundedEvidenceFile(path.join(root, filename), limit)).bytes) ===
        inputs[key],
      "baseline local input changed during admission",
    );
  }
  const baseline = {
    id: permit.id,
    continuity: "lost" as const,
    initial_freshness: "unknown" as const,
    initialized_at: new Date(now()).toISOString(),
    producer: current,
    inputs: {
      config_sha256: inputs.config,
      catalog_sha256: inputs.catalog!,
      listings_sha256: inputs.listings!,
    },
  };
  const receipt = await assertOwnedUnlinkedPath(
    root,
    path.join(root, "work", `${permit.id}.consumed.json`),
    "baseline consumption receipt",
  );
  verifyCurrent();
  requireValue(now() < deadline, "baseline publication deadline exhausted");
  // Retain even on failure: same-run invocation cannot renew a consumed permit.
  await writeFile(receipt, JSON.stringify(baseline), { flag: "wx" });
  await publishObserverSnapshot(
    root,
    {
      format: 1,
      authority: "observer-checkpoint-cache-only",
      repository,
      repository_id: repositoryId,
      workflow,
      ref: "refs/heads/main",
      config_sha256: config,
      created_at: baseline.initialized_at,
      producer: current,
      files: { "catalog/checkpoint.json": { ...newCatalogObserverCheckpoint(), baseline } },
    },
    deadline,
    now,
  );
  return { origin: "fresh-baseline", sequence: 0, baseline };
}
/** Public metadata locates inert bytes; no untrusted run chooses code to execute. */
export async function recoverObserverCheckpoint(options: RecoveryOptions) {
  const { root, config, current, deadline, api } = options,
    now = options.now ?? Date.now;
  producer(current);
  const work = await assertOwnedUnlinkedPath(
    root,
    path.join(root, "work"),
    "observer work directory",
  );
  await mkdir(work, { recursive: true });
  let requests = 0,
    bytes = 0;
  let providerRemaining: number | null = null,
    providerLimit: number | null = null;
  const remaining = () => {
    const left = Math.floor(deadline - now());
    requireValue(left > 0 && left <= 60000, "recovery collection deadline exhausted");
    return left;
  };
  const admit = () => {
    remaining();
    requireValue(++requests <= 256, "recovery request envelope exhausted");
    requireValue(
      providerRemaining === null ||
        providerRemaining > Math.max(1, Math.ceil((providerLimit ?? providerRemaining) * 0.05)),
      "recovery provider reserve exhausted",
    );
    if (providerRemaining !== null) providerRemaining--;
  };
  const read = (route: string) => {
    admit();
    const response = api.request("GET", `repos/${repository}${route ? `/${route}` : ""}`);
    remaining();
    requireValue(
      response.status === 200 &&
        response.bodyBytes !== undefined &&
        response.bodyBytes <= observerSnapshotLimit,
      "bounded metadata unavailable",
    );
    bytes += response.bodyBytes;
    options.log?.({ route, response_bytes: response.bodyBytes, total_bytes: bytes, requests });
    requireValue(bytes <= observerSnapshotLimit, "recovery metadata byte envelope exhausted");
    const rate = rateLimitFromResponse(response);
    if (rate.remaining !== null && rate.limit !== null && rate.remaining <= rate.limit) {
      providerRemaining = rate.remaining;
      providerLimit = rate.limit;
    }
    return response.body;
  };
  // The provider, not an environment or artifact claim, appoints the default branch.
  const repo = read("");
  requireValue(
    isRecord(repo) &&
      repo.id === repositoryId &&
      repo.full_name === repository &&
      repo.default_branch === "main",
    "default repository identity differs",
  );
  const cache = await optionalFile(
    path.join(root, "work"),
    path.join(root, "work/upstream-observer/catalog/checkpoint.json"),
  );
  if (cache) {
    const checkpoint = validateCatalogObserverCheckpoint(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(cache)),
      now(),
    );
    const configs = new Map<
      string,
      NonNullable<(typeof checkpoint.sources)[string]["current_config"]>
    >();
    const required = new Set<string>();
    for (const progress of Object.values(checkpoint.sources)) {
      for (const value of [
        progress.current_config,
        progress.last_complete_config,
        ...progress.retired_configs,
      ])
        if (value) configs.set(`${observationHash(value)}/checkpoint.json`, value);
      for (const value of [progress.current_config, progress.last_complete_config])
        if (value) required.add(`${observationHash(value)}/checkpoint.json`);
    }
    for (const [name, value] of configs) {
      remaining();
      const bytes = await optionalFile(
        path.join(root, "work"),
        path.join(root, "work/upstream-observer", name),
      );
      requireValue(
        bytes !== null || !required.has(name),
        "cached source checkpoint missing; preserve partial tree",
      );
      if (bytes)
        validateObserverCheckpoint(
          decodeStoredObserverCheckpoint(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            deadline,
            now,
          ),
          value,
        );
    }
    remaining();
    return { origin: "cache", sequence: checkpoint.sequence };
  }
  try {
    await lstat(path.join(root, "work/upstream-observer"));
    throw new Error("Observer recovery: partial cache tree present; preserve it");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const inventory = scheduledRunWindow(read, current.run, now());
  let expectedHistory = false;
  let reachedAgeBoundary = false;
  for (const raw of inventory.runs) {
    requireValue(isRecord(raw), "run inventory invalid");
    if (raw.id === current.run || raw.status !== "completed") continue;
    requireValue(
      raw.workflow_id === workflowId &&
        raw.path === workflow &&
        raw.event === "schedule" &&
        raw.head_branch === "main" &&
        isRecord(raw.repository) &&
        raw.repository.id === repositoryId &&
        isRecord(raw.head_repository) &&
        raw.head_repository.id === repositoryId,
      "foreign scheduled producer",
    );
    requireValue(
      typeof raw.created_at === "string" &&
        Number.isFinite(Date.parse(raw.created_at)) &&
        Date.parse(raw.created_at) <= now(),
      "producer age differs",
    );
    if (!["success", "failure"].includes(String(raw.conclusion))) continue;
    const source = {
      run: Number(raw.id),
      attempt: Number(raw.run_attempt),
      source: String(raw.head_sha),
    };
    producer(source);
    // GitHub includes file patches only on comparison page one. Global status
    // and merge-base identity remain present on page two, even with no commits.
    // No commit/file inventory is claimed or needed for this ancestry predicate.
    const comparison = read(`compare/${source.source}...${current.source}?per_page=1&page=2`);
    requireValue(
      isRecord(comparison) &&
        ["ahead", "identical"].includes(String(comparison.status)) &&
        isRecord(comparison.merge_base_commit) &&
        comparison.merge_base_commit.sha === source.source,
      "producer is not retained main ancestry",
    );
    const tooOld = now() - Date.parse(raw.created_at) > maximumAge;
    const artifacts = tooOld
      ? { artifacts: [] }
      : readCompleteRunArtifactInventory((page) =>
          read(`actions/runs/${source.run}/artifacts?per_page=100&page=${page}`),
        );
    const name = snapshotName(config, source),
      matches = artifacts.artifacts.filter((row) => row.name === name);
    requireValue(matches.length <= 1, "duplicate checkpoint artifact");
    if (!matches.length) {
      // Explicit migration only: inspect trusted old source, never silently cold-start
      // after a deployed snapshot publisher failed to retain its history.
      const oldWorkflow = read(`contents/${workflow}?ref=${source.source}`);
      const oldConfig = read(`contents/release/upstream-observer.json?ref=${source.source}`);
      requireValue(
        isRecord(oldWorkflow) &&
          oldWorkflow.encoding === "base64" &&
          typeof oldWorkflow.content === "string" &&
          isRecord(oldConfig) &&
          oldConfig.encoding === "base64" &&
          typeof oldConfig.content === "string",
        "cutover source inventory unavailable",
      );
      // A configuration edit is not authority to reset a deployed publisher's
      // missing history. Only the explicit one-shot admission below may do so.
      if (
        Buffer.from(oldWorkflow.content, "base64")
          .toString("utf8")
          .includes("observer-checkpoint-artifact.mts export")
      )
        expectedHistory = true;
      if (tooOld) {
        reachedAgeBoundary = true;
        break;
      }
      continue;
    }
    const artifact = matches[0]!;
    requireValue(
      artifact.expired === false &&
        Number.isSafeInteger(artifact.id) &&
        Number(artifact.id) > 0 &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        Number(artifact.size_in_bytes) >= 22 &&
        Number(artifact.size_in_bytes) <= observerSnapshotLimit &&
        typeof artifact.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) &&
        isRecord(artifact.workflow_run) &&
        artifact.workflow_run.id === source.run &&
        artifact.workflow_run.repository_id === repositoryId &&
        artifact.workflow_run.head_repository_id === repositoryId &&
        artifact.workflow_run.head_sha === source.source,
      "checkpoint artifact identity unavailable",
    );
    admit();
    const archive = (options.download ?? readGitHubArtifactArchive)(
      `repos/${repository}/actions/artifacts/${Number(artifact.id)}/zip`,
      { cwd: root, maxBytes: Number(artifact.size_in_bytes), timeoutMs: remaining() },
    );
    remaining();
    requireValue(
      archive.length === artifact.size_in_bytes && sha256(archive) === artifact.digest.slice(7),
      "checkpoint artifact digest differs",
    );
    const snapshot = readObserverSnapshotArchive(archive, config, now(), deadline);
    requireValue(
      snapshot.producer.run === source.run &&
        snapshot.producer.attempt === source.attempt &&
        snapshot.producer.source === source.source,
      "snapshot producer differs",
    );
    const after = read(`actions/artifacts/${Number(artifact.id)}`),
      runAfter = read(`actions/runs/${source.run}`);
    requireValue(
      isRecord(after) &&
        after.id === artifact.id &&
        after.name === artifact.name &&
        after.digest === artifact.digest &&
        after.size_in_bytes === artifact.size_in_bytes &&
        after.expired === false &&
        isRecord(after.workflow_run) &&
        after.workflow_run.id === source.run &&
        after.workflow_run.repository_id === repositoryId &&
        after.workflow_run.head_repository_id === repositoryId &&
        after.workflow_run.head_sha === source.source &&
        isRecord(runAfter) &&
        runAfter.id === source.run &&
        runAfter.workflow_id === workflowId &&
        runAfter.path === workflow &&
        runAfter.event === "schedule" &&
        runAfter.head_branch === "main" &&
        isRecord(runAfter.repository) &&
        runAfter.repository.id === repositoryId &&
        isRecord(runAfter.head_repository) &&
        runAfter.head_repository.id === repositoryId &&
        runAfter.head_sha === source.source &&
        runAfter.run_attempt === source.attempt &&
        runAfter.status === "completed" &&
        runAfter.conclusion === raw.conclusion,
      "producer changed during collection",
    );
    await publishObserverSnapshot(root, snapshot, deadline, now);
    remaining();
    return {
      origin: "artifact",
      producer: source,
      artifact: artifact.id,
      sequence: validateCatalogObserverCheckpoint(snapshot.files["catalog/checkpoint.json"], now())
        .sequence,
    };
  }
  requireValue(
    inventory.complete || reachedAgeBoundary,
    "scheduled history coverage incomplete; preserve evidence",
  );
  if (expectedHistory) {
    const baseline = await initializeApprovedBaseline(read, inventory, options, now);
    if (baseline) return baseline;
  }
  requireValue(
    !expectedHistory,
    "checkpoint history missing after cutover; explicit recovery required",
  );
  return {
    origin: "initial-baseline",
    continuity: "unestablished; no recoverable pre-cutover checkpoint",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    requireValue(
      process.env.GITHUB_REPOSITORY === repository &&
        process.env.GITHUB_REF === "refs/heads/main" &&
        ["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? ""),
      "only the appointed main observer may recover checkpoints",
    );
    const current = {
      run: Number(process.env.GITHUB_RUN_ID),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      source: process.env.GITHUB_SHA ?? "",
    };
    const config = sha256(
      (await readBoundedEvidenceFile(path.join(root, "release/upstream-observer.json"), 16384))
        .bytes,
    );
    if (process.argv[2] === "restore" && process.argv.length === 3) {
      const deadline = Math.min(
        Date.now() + 60000,
        Date.parse(process.env.PORTCOVE_OBSERVER_OPPORTUNITY_DEADLINE_UTC ?? ""),
      );
      const api = new GitHubApiClient((args, input) =>
        createGitHubRunner({
          cwd: root,
          maxBuffer: observerSnapshotLimit + 16384,
          timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())),
        })(args, input),
      );
      console.log(
        JSON.stringify(
          await recoverObserverCheckpoint({
            root,
            config,
            current,
            deadline,
            api,
            log: (event) =>
              console.log(JSON.stringify({ kind: "observer-recovery-metadata", ...event })),
          }),
        ),
      );
    } else if (process.argv[2] === "export" && process.argv.length === 3) {
      const deadline = Math.min(
        Date.now() + 60000,
        Date.parse(process.env.PORTCOVE_OBSERVER_OPPORTUNITY_DEADLINE_UTC ?? "") + 60000,
      );
      requireValue(Number.isFinite(deadline), "export deadline unavailable");
      const snapshot = await collectCompactObserverSnapshot(
        root,
        config,
        current,
        Date.now(),
        deadline,
        (metrics) =>
          console.log(JSON.stringify({ kind: "observer-checkpoint-collection", ...metrics })),
      );
      console.log(
        JSON.stringify({
          kind: "observer-checkpoint-input",
          checkpoint_files: Object.keys(snapshot.files).length,
          controller_bytes: Buffer.byteLength(
            JSON.stringify(snapshot.files["catalog/checkpoint.json"]),
          ),
          decoded_bytes: Buffer.byteLength(JSON.stringify(snapshot)),
          decoded_byte_limit: observerCheckpointByteLimit,
          artifact_byte_limit: observerSnapshotLimit,
        }),
      );
      const encoded = encodeCompactObserverSnapshot(snapshot, deadline);
      const output = await assertOwnedUnlinkedPath(
        root,
        path.join(root, "work/upstream-observer-snapshot/checkpoint.json"),
        "snapshot output",
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, encoded.bytes, { flag: "wx" });
      console.log(
        JSON.stringify({
          kind: "observer-checkpoint-snapshot",
          checkpoint_files: encoded.checkpoint_files,
          decoded_bytes: encoded.decoded_bytes,
          decoded_byte_limit: observerCheckpointByteLimit,
          artifact_bytes: encoded.bytes.length,
          artifact_byte_limit: observerSnapshotLimit,
        }),
      );
      requireValue(process.env.GITHUB_OUTPUT, "artifact output channel unavailable");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `artifact_name=${snapshotName(config, current)}\n`,
      );
    } else throw new Error("usage: observer-checkpoint-artifact.mts restore|export");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Observer recovery failed");
    process.exitCode = 1;
  }
}
