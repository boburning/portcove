/** Inert, bounded continuation data. Never source, artifact or publication authority. */
import { createHash, randomUUID } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { lstat, mkdir, rename, rm, writeFile, open, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorCode } from "./runtime-values.mts";
import { readBoundedEvidenceFile } from "./development-evidence.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { readCompleteRunArtifactInventory } from "./release-run-artifact-inventory.mts";
import { validateCatalogObserverCheckpoint } from "./catalog-upstream-observer.mts";
import { validateObserverCheckpoint, withCheckpointLock } from "./observe-configured-upstream.mts";
import { observationHash } from "./upstream-observer.mts";

// One existing response envelope is reserved inside the sixteen-MiB output budget.
export const observerSnapshotLimit = 4 * 1024 * 1024;
const repository = "boburning/portcove",
  repositoryId = 1354613114;
const workflow = ".github/workflows/configured-upstream-observer.yml";
const workflowId = 354075266;
const maximumAge = 24 * 3600000;
const member = "checkpoint.json";
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
export function validateObserverSnapshot(raw: unknown, config: string, now: number) {
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
    isRecord(raw.files) && Buffer.byteLength(JSON.stringify(raw)) <= observerSnapshotLimit,
    "snapshot bytes unavailable",
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
    if (name === "catalog/checkpoint.json") continue;
    requireValue(
      /^[a-f0-9]{64}\/checkpoint\.json$/u.test(name) && configs.has(name),
      "foreign checkpoint path",
    );
    requireValue(value !== null, "missing checkpoint value");
    validateObserverCheckpoint(value, configs.get(name)!);
  }
  for (const name of required)
    requireValue(Object.hasOwn(raw.files, name), "referenced complete checkpoint missing");
  return raw as unknown as Snapshot;
}

async function optionalFile(root: string, filename: string, maximum = 32 * 1024 * 1024) {
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
    observerSnapshotLimit,
  );
  requireValue(bytes, "controller checkpoint absent");
  const controller = validateCatalogObserverCheckpoint(JSON.parse(bytes.toString("utf8")), now);
  const files: Record<string, unknown> = { "catalog/checkpoint.json": controller };
  const configs = new Map<string, unknown>();
  for (const progress of Object.values(controller.sources))
    for (const config of [
      progress.current_config,
      progress.last_complete_config,
      ...progress.retired_configs,
    ])
      if (config) configs.set(`${observationHash(config)}/checkpoint.json`, config);
  let used = bytes.length;
  for (const name of configs.keys()) {
    requireValue(Date.now() < deadline, "snapshot collection deadline exhausted");
    const value = await optionalFile(work, path.join(directory, name), observerSnapshotLimit);
    if (!value) continue;
    used += value.length;
    requireValue(
      used <= observerSnapshotLimit,
      "complete snapshot exceeds reserved output envelope; checkpoints retained",
    );
    files[name] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  }
  requireValue(Date.now() < deadline, "snapshot collection deadline exhausted");
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
  );
}

export async function collectObserverSnapshot(
  root: string,
  config: string,
  expected: Producer,
  now = Date.now(),
  deadline = Infinity,
) {
  return withCheckpointLock(path.join(root, "work/upstream-observer/catalog/checkpoint.json"), () =>
    collectUnlockedObserverSnapshot(root, config, expected, now, deadline),
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
  return validateObserverSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    config,
    now,
  );
}

/** Publish an entirely absent tree in one rename. Never blend partial cache data. */
export async function publishObserverSnapshot(
  root: string,
  snapshot: Snapshot,
  deadline = Infinity,
) {
  requireValue(Date.now() < deadline, "snapshot publication deadline exhausted");
  validateObserverSnapshot(snapshot, snapshot.config_sha256, Date.now());
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
      requireValue(Date.now() < deadline, "snapshot publication deadline exhausted");
      const filename = path.join(staging, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, JSON.stringify(value), { flag: "wx" });
    }
    await assertOwnedUnlinkedPath(work, destination, "observer restore");
    await absent();
    requireValue(Date.now() < deadline, "snapshot publication deadline exhausted");
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
};
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
  const remaining = () => {
    const left = Math.floor(deadline - now());
    requireValue(left > 0 && left <= 60000, "recovery collection deadline exhausted");
    return left;
  };
  const read = (route: string) => {
    remaining();
    requireValue(++requests <= 256, "recovery request envelope exhausted");
    const response = api.request("GET", `repos/${repository}${route ? `/${route}` : ""}`);
    remaining();
    requireValue(
      response.status === 200 &&
        response.bodyBytes !== undefined &&
        response.bodyBytes <= observerSnapshotLimit,
      "bounded metadata unavailable",
    );
    bytes += response.bodyBytes;
    requireValue(bytes <= observerSnapshotLimit, "recovery metadata byte envelope exhausted");
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
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
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
  const inventory = read(
    `actions/workflows/${workflowId}/runs?branch=main&event=schedule&per_page=100`,
  );
  requireValue(
    isRecord(inventory) &&
      Array.isArray(inventory.workflow_runs) &&
      Number.isSafeInteger(inventory.total_count) &&
      Number(inventory.total_count) >= 0 &&
      Math.min(Number(inventory.total_count), 100) === inventory.workflow_runs.length,
    "recent scheduled run inventory incomplete",
  );
  let expectedHistory = false;
  let reachedAgeBoundary = false;
  let previousCreated = Infinity;
  const seenRuns = new Set<number>();
  for (const raw of inventory.workflow_runs) {
    requireValue(
      isRecord(raw) &&
        Number.isSafeInteger(raw.id) &&
        Number(raw.id) > 0 &&
        !seenRuns.has(Number(raw.id)) &&
        typeof raw.created_at === "string" &&
        Number.isFinite(Date.parse(raw.created_at)) &&
        Date.parse(raw.created_at) <= previousCreated,
      "run inventory invalid or unordered",
    );
    seenRuns.add(Number(raw.id));
    previousCreated = Date.parse(raw.created_at);
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
    const comparison = read(`compare/${source.source}...${current.source}?per_page=1`);
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
      if (
        sha256(Buffer.from(oldConfig.content, "base64")) === config &&
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
    await publishObserverSnapshot(root, snapshot, deadline);
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
    !expectedHistory && (Number(inventory.total_count) <= 100 || reachedAgeBoundary),
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
        JSON.stringify(await recoverObserverCheckpoint({ root, config, current, deadline, api })),
      );
    } else if (process.argv[2] === "export" && process.argv.length === 3) {
      const deadline = Math.min(
        Date.now() + 60000,
        Date.parse(process.env.PORTCOVE_OBSERVER_OPPORTUNITY_DEADLINE_UTC ?? "") + 60000,
      );
      requireValue(Number.isFinite(deadline), "export deadline unavailable");
      const snapshot = await collectObserverSnapshot(root, config, current, Date.now(), deadline);
      const output = await assertOwnedUnlinkedPath(
        root,
        path.join(root, "work/upstream-observer-snapshot/checkpoint.json"),
        "snapshot output",
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(snapshot), { flag: "wx" });
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
