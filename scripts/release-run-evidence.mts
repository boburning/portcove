import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { isRecord } from "./runtime-values.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";

export interface ReleaseEvidenceRequest {
  schema_version: 1;
  repository_id: number;
  run_id: number;
  attempt: number;
  revision: string;
  tree: string;
  workflow_sha256: string;
}
export interface EvidenceFileMetadata {
  isFile(): boolean;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
}
export interface EvidenceFileHandle {
  stat(): Promise<EvidenceFileMetadata>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export type EvidenceFileOpener = (filename: string, flags: number) => Promise<EvidenceFileHandle>;
export interface ReleaseEvidenceOptions {
  api?: GitHubRestReader;
  elapsed?: () => number;
  now?: () => number;
  openFile?: EvidenceFileOpener;
}

const repository = "boburning/portcove";
const workflow = ".github/workflows/release.yml";
const maximumRecords = 1600;
const maximumRequests = 40;
const maximumDurationMs = 120_000;

function positive(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} is invalid`);
  return value;
}

function hex(value: unknown, length: number, label: string) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some(
      (character: string) =>
        (character.codePointAt(0) ?? 0) < 32 || character.codePointAt(0) === 127,
    )
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function nullableText(value: unknown, label: string) {
  return value === null ? null : text(value, label);
}

export function inspectReleaseEvidenceRequest(value: unknown): ReleaseEvidenceRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "attempt,repository_id,revision,run_id,schema_version,tree,workflow_sha256" ||
    value.schema_version !== 1
  )
    throw new Error("release evidence request has an invalid schema");
  return {
    schema_version: 1,
    repository_id: positive(value.repository_id, "repository_id"),
    run_id: positive(value.run_id, "run_id"),
    attempt: positive(value.attempt, "attempt"),
    revision: hex(value.revision, 40, "revision"),
    tree: hex(value.tree, 40, "tree"),
    workflow_sha256: hex(value.workflow_sha256, 64, "workflow SHA-256"),
  };
}

function runIdentity(run: unknown, expected: ReleaseEvidenceRequest) {
  if (
    !isRecord(run) ||
    run.id !== expected.run_id ||
    run.run_attempt !== expected.attempt ||
    run.head_sha !== expected.revision ||
    !isRecord(run.repository) ||
    run.repository.id !== expected.repository_id ||
    run.repository.full_name !== repository ||
    !isRecord(run.head_repository) ||
    run.head_repository.id !== expected.repository_id ||
    typeof run.path !== "string" ||
    run.path.split("@")[0] !== workflow ||
    run.status !== "completed"
  )
    throw new Error("release run identity or terminal state differs");
  return {
    id: run.id,
    attempt: run.run_attempt,
    revision: run.head_sha,
    workflow_id: positive(run.workflow_id, "workflow ID"),
    path: text(run.path, "workflow path"),
    event: text(run.event, "workflow event"),
    status: run.status,
    conclusion: text(run.conclusion, "run conclusion"),
    updated_at: text(run.updated_at, "run update time"),
  };
}

/** Read-only API identities. This never downloads or executes candidate bytes,
 * associates an artifact with a producing job, or grants release eligibility.
 */
export function collectReleaseRunEvidence(request: unknown, options: ReleaseEvidenceOptions = {}) {
  const expected = inspectReleaseEvidenceRequest(request);
  const api =
    options.api ?? new GitHubApiClient(createGitHubRunner({ maxBuffer: 2 * 1024 * 1024 }));
  const elapsed = options.elapsed ?? (() => performance.now());
  const started = elapsed();
  let requests = 0;
  const base = `repos/${repository}`;
  const allowedPaths = new Set([
    `/repos/${repository}/actions/runs/${expected.run_id}`,
    `/repos/${repository}/actions/runs/${expected.run_id}/attempts/${expected.attempt}`,
    `/repos/${repository}/actions/runs/${expected.run_id}/attempts/${expected.attempt}/jobs`,
    `/repos/${repository}/actions/runs/${expected.run_id}/artifacts`,
    `/repos/${repository}/git/commits/${expected.revision}`,
    `/repos/${repository}/contents/${workflow}`,
  ]);
  const read = (method: string, endpoint: string) => {
    const url = new URL(
      endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
    );
    const collection = url.pathname.endsWith("/jobs") || url.pathname.endsWith("/artifacts");
    const contents = url.pathname === `/repos/${repository}/contents/${workflow}`;
    const keys = [...url.searchParams.keys()];
    if (
      method !== "GET" ||
      url.origin !== "https://api.github.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !allowedPaths.has(url.pathname) ||
      new Set(keys).size !== keys.length ||
      keys.some(
        (key) => !(collection ? ["per_page", "page"] : contents ? ["ref"] : []).includes(key),
      ) ||
      (contents && url.searchParams.get("ref") !== expected.revision) ||
      (collection &&
        (url.searchParams.get("per_page") !== "100" ||
          (url.searchParams.has("page") &&
            !/^[1-9][0-9]{0,2}$/u.test(url.searchParams.get("page") ?? ""))))
    )
      throw new Error("release evidence traversal escaped its read-only scope");
    if (++requests > maximumRequests || elapsed() - started >= maximumDurationMs)
      throw new Error("release evidence collection exhausted its bound");
    const response = api.request(method, endpoint);
    if (response.status !== 200 || elapsed() - started >= maximumDurationMs)
      throw new Error("release evidence response is unavailable or late");
    return response;
  };
  const get = (endpoint: string) => read("GET", endpoint).body;
  const page = (endpoint: string, key: "jobs" | "artifacts") =>
    GitHubApiClient.prototype.paginateRest.call({ request: read }, endpoint, {
      select(body) {
        if (
          !isRecord(body) ||
          typeof body.total_count !== "number" ||
          !Number.isSafeInteger(body.total_count) ||
          body.total_count > maximumRecords
        )
          throw new Error(`${key} inventory exceeds its bound`);
        return body[key];
      },
      totalCount: (body) => {
        if (!isRecord(body) || typeof body.total_count !== "number")
          throw new Error(`${key} total is invalid`);
        return body.total_count;
      },
      identity: (record) => positive(isRecord(record) ? record.id : undefined, `${key} ID`),
      label: `release ${key}`,
    });

  const runPath = `${base}/actions/runs/${expected.run_id}`;
  const initial = runIdentity(get(runPath), expected);
  const attempt = runIdentity(get(`${runPath}/attempts/${expected.attempt}`), expected);
  const { updated_at: attemptUpdatedAt, ...attemptIdentity } = attempt;
  const { updated_at: _initialUpdatedAt, ...initialIdentity } = initial;
  if (JSON.stringify(attemptIdentity) !== JSON.stringify(initialIdentity))
    throw new Error("release attempt differs from the current terminal run");
  const commit = get(`${base}/git/commits/${expected.revision}`);
  if (
    !isRecord(commit) ||
    commit.sha !== expected.revision ||
    !isRecord(commit.tree) ||
    commit.tree.sha !== expected.tree
  )
    throw new Error("release source tree differs");
  const source = get(`${base}/contents/${workflow}?ref=${expected.revision}`);
  if (
    !isRecord(source) ||
    source.type !== "file" ||
    source.path !== workflow ||
    source.encoding !== "base64" ||
    typeof source.size !== "number" ||
    !Number.isSafeInteger(source.size) ||
    source.size < 1 ||
    source.size > 256 * 1024 ||
    typeof source.content !== "string" ||
    source.content.length > 512 * 1024
  )
    throw new Error("release workflow source is unavailable or oversized");
  const bytes = Buffer.from(source.content, "base64");
  if (
    bytes.length !== source.size ||
    createHash("sha256").update(bytes).digest("hex") !== expected.workflow_sha256
  )
    throw new Error("release workflow bytes differ");

  const jobs = page(`${runPath}/attempts/${expected.attempt}/jobs?per_page=100`, "jobs")
    .map((job) => {
      if (
        !isRecord(job) ||
        job.run_id !== expected.run_id ||
        job.run_attempt !== expected.attempt ||
        job.head_sha !== expected.revision ||
        job.status !== "completed"
      )
        throw new Error("job run/attempt/source identity differs");
      return {
        id: positive(job.id, "jobs ID"),
        name: text(job.name, "job name"),
        status: text(job.status, "job status"),
        conclusion: job.conclusion === null ? null : text(job.conclusion, "job conclusion"),
        runner_id:
          typeof job.runner_id === "number" &&
          Number.isSafeInteger(job.runner_id) &&
          job.runner_id >= 0
            ? job.runner_id
            : null,
        runner_name: nullableText(job.runner_name, "runner name"),
        started_at: nullableText(job.started_at, "job start time"),
        completed_at: nullableText(job.completed_at, "job completion time"),
      };
    })
    .sort((left, right) => left.id - right.id);
  const artifacts = page(`${runPath}/artifacts?per_page=100`, "artifacts")
    .map((artifact) => {
      if (!isRecord(artifact)) throw new Error("artifact run/source identity differs");
      const producer = artifact.workflow_run;
      if (
        !isRecord(producer) ||
        producer.id !== expected.run_id ||
        producer.repository_id !== expected.repository_id ||
        producer.head_repository_id !== expected.repository_id ||
        producer.head_sha !== expected.revision ||
        typeof artifact.expired !== "boolean" ||
        typeof artifact.size_in_bytes !== "number" ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes < 0
      )
        throw new Error("artifact run/source identity differs");
      return {
        id: positive(artifact.id, "artifacts ID"),
        name: text(artifact.name, "artifact name"),
        bytes: artifact.size_in_bytes,
        archive_sha256:
          artifact.digest === null || artifact.digest === undefined
            ? null
            : hex(
                typeof artifact.digest === "string" && artifact.digest.startsWith("sha256:")
                  ? artifact.digest.slice(7)
                  : null,
                64,
                "artifact archive digest",
              ),
        expired: artifact.expired,
        created_at: text(artifact.created_at, "artifact creation time"),
        expires_at: nullableText(artifact.expires_at, "artifact expiry time"),
        producer_attempt: null,
        producer_job_id: null,
      };
    })
    .sort((left, right) => left.id - right.id);
  const final = runIdentity(get(runPath), expected);
  if (JSON.stringify(final) !== JSON.stringify(initial))
    throw new Error("release run changed during evidence collection");
  const evidence = {
    schema_version: 1,
    kind: "release-run-api-evidence",
    repository,
    repository_id: expected.repository_id,
    source_tree: expected.tree,
    source_workflow_sha256: expected.workflow_sha256,
    execution_workflow_binding: "unproven; source bytes at head are not execution lineage",
    observed_at: new Date((options.now ?? Date.now)()).toISOString(),
    run: final,
    attempt_updated_at: attemptUpdatedAt,
    jobs,
    artifacts,
    artifact_scope:
      "complete run inventory across attempts; API does not report producing job or attempt",
    qualification:
      "API identity only; no artifact-byte, isolation, custody, signing or publication acceptance",
  };
  const receipt = {
    ...evidence,
    evidence_sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
  if (elapsed() - started >= maximumDurationMs)
    throw new Error("release evidence collection exhausted its bound");
  return receipt;
}

export async function readReleaseEvidenceRequest(
  filename: string,
  { openFile = open }: Pick<ReleaseEvidenceOptions, "openFile"> = {},
): Promise<unknown> {
  const handle = await openFile(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      typeof metadata.size !== "number" ||
      metadata.size < 1 ||
      metadata.size > 16 * 1024
    )
      throw new Error("release evidence request must be a bounded regular file");
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const final = await handle.stat();
    if (
      length !== metadata.size ||
      final.size !== metadata.size ||
      final.mtimeMs !== metadata.mtimeMs ||
      final.ctimeMs !== metadata.ctimeMs
    )
      throw new Error("release evidence request changed during collection");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Compare retained opaque artifact bytes with fresh provider metadata. No
 * extraction, execution, producing-job attribution or release eligibility. */
export async function verifyReleaseArtifactBytes(
  request: unknown,
  artifactId: number,
  filename: string,
  options: ReleaseEvidenceOptions = {},
) {
  const expected = structuredClone(inspectReleaseEvidenceRequest(request));
  positive(artifactId, "artifact ID");
  const elapsed = options.elapsed ?? (() => performance.now());
  const started = elapsed();
  const withinBound = () => {
    if (elapsed() - started >= maximumDurationMs)
      throw new Error("artifact byte verification exhausted its bound");
  };
  const api =
    options.api ?? new GitHubApiClient(createGitHubRunner({ maxBuffer: 2 * 1024 * 1024 }));
  let requests = 0;
  const collectionOptions = {
    ...options,
    elapsed,
    api: {
      request(...args: Parameters<GitHubRestReader["request"]>) {
        withinBound();
        if (++requests > maximumRequests)
          throw new Error("artifact byte verification exhausted its request bound");
        const response = api.request(...args);
        withinBound();
        return response;
      },
    },
  };
  const before = collectReleaseRunEvidence(expected, collectionOptions);
  withinBound();
  const selected = before.artifacts.find((artifact) => artifact.id === artifactId);
  const maximumBytes = 512 * 1024 * 1024;
  if (
    !selected ||
    selected.expired ||
    !selected.archive_sha256 ||
    selected.bytes < 1 ||
    selected.bytes > maximumBytes
  )
    throw new Error("artifact has no current bounded provider byte identity");
  const selectedIdentity = JSON.stringify(selected);
  const handle = await (options.openFile ?? open)(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  let digest;
  try {
    withinBound();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== selected.bytes)
      throw new Error("artifact must be a regular file with the provider byte count");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    while (length <= selected.bytes) {
      withinBound();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, selected.bytes + 1 - length),
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > selected.bytes) throw new Error("artifact grew during verification");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const final = await handle.stat();
    if (
      length !== selected.bytes ||
      final.size !== metadata.size ||
      final.mtimeMs !== metadata.mtimeMs ||
      final.ctimeMs !== metadata.ctimeMs ||
      final.dev !== metadata.dev ||
      final.ino !== metadata.ino
    )
      throw new Error("artifact changed during verification");
    digest = hash.digest("hex");
    if (digest !== selected.archive_sha256)
      throw new Error("artifact bytes differ from provider digest");
  } finally {
    await handle.close();
  }
  withinBound();
  const after = collectReleaseRunEvidence(expected, collectionOptions);
  withinBound();
  if (
    JSON.stringify(after.artifacts.find((artifact) => artifact.id === artifactId)) !==
      selectedIdentity ||
    JSON.stringify(after.run) !== JSON.stringify(before.run)
  )
    throw new Error("artifact or run changed during byte verification");
  const evidence = {
    schema_version: 1,
    kind: "release-artifact-byte-evidence",
    repository,
    repository_id: expected.repository_id,
    run_id: expected.run_id,
    attempt: expected.attempt,
    revision: expected.revision,
    source_tree: expected.tree,
    source_workflow_sha256: expected.workflow_sha256,
    artifact_id: artifactId,
    artifact_name: selected.name,
    bytes: selected.bytes,
    sha256: digest,
    before_api_evidence_sha256: before.evidence_sha256,
    after_api_evidence_sha256: after.evidence_sha256,
    before_api_evidence: before,
    after_api_evidence: after,
    producer_attempt: null,
    producer_job_id: null,
    qualification:
      "Opaque provider byte identity only; producer attempt/job, execution lineage, package contents, isolation, custody, signing and publication remain unproven",
  };
  const receipt = {
    ...evidence,
    evidence_sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
  withinBound();
  return receipt;
}

const scriptPath = fileURLToPath(import.meta.url);
async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    if (![3, 5].includes(process.argv.length))
      throw new Error("usage: release-run-evidence.mts REQUEST.json [ARTIFACT_ID RETAINED_FILE]");
    const request = await readReleaseEvidenceRequest(process.argv[2] ?? "");
    const evidence =
      process.argv.length === 3
        ? collectReleaseRunEvidence(request)
        : await verifyReleaseArtifactBytes(request, Number(process.argv[3]), process.argv[4] ?? "");
    console.log(JSON.stringify(evidence, null, 2));
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
