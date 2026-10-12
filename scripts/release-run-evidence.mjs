import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { GitHubApiClient, createGitHubRunner } from "./github-api.mjs";

const repository = "boburning/portcove";
const workflow = ".github/workflows/release.yml";
const maximumRecords = 1600;
const maximumRequests = 40;
const maximumDurationMs = 120_000;

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function hex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function nullableText(value, label) {
  return value === null ? null : text(value, label);
}

function validateRequest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "attempt,repository_id,revision,run_id,schema_version,tree,workflow_sha256" ||
    value.schema_version !== 1
  )
    throw new Error("release evidence request has an invalid schema");
  for (const key of ["repository_id", "run_id", "attempt"]) positive(value[key], key);
  hex(value.revision, 40, "revision");
  hex(value.tree, 40, "tree");
  hex(value.workflow_sha256, 64, "workflow SHA-256");
  return value;
}

function runIdentity(run, expected) {
  if (
    run?.id !== expected.run_id ||
    run.run_attempt !== expected.attempt ||
    run.head_sha !== expected.revision ||
    run.repository?.id !== expected.repository_id ||
    run.repository.full_name !== repository ||
    run.head_repository?.id !== expected.repository_id ||
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
export function collectReleaseRunEvidence(request, options = {}) {
  const expected = validateRequest(request);
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
  const read = (method, endpoint) => {
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
            !/^[1-9][0-9]{0,2}$/u.test(url.searchParams.get("page")))))
    )
      throw new Error("release evidence traversal escaped its read-only scope");
    if (++requests > maximumRequests || elapsed() - started >= maximumDurationMs)
      throw new Error("release evidence collection exhausted its bound");
    const response = api.request(method, endpoint);
    if (response.status !== 200 || elapsed() - started >= maximumDurationMs)
      throw new Error("release evidence response is unavailable or late");
    return response;
  };
  const get = (endpoint) => read("GET", endpoint).body;
  const page = (endpoint, key) =>
    GitHubApiClient.prototype.paginateRest.call({ request: read }, endpoint, {
      select(body) {
        if (!Number.isSafeInteger(body?.total_count) || body.total_count > maximumRecords)
          throw new Error(`${key} inventory exceeds its bound`);
        return body[key];
      },
      totalCount: (body) => body.total_count,
      identity: (record) => positive(record?.id, `${key} ID`),
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
  if (commit?.sha !== expected.revision || commit.tree?.sha !== expected.tree)
    throw new Error("release source tree differs");
  const source = get(`${base}/contents/${workflow}?ref=${expected.revision}`);
  if (
    source?.type !== "file" ||
    source.path !== workflow ||
    source.encoding !== "base64" ||
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
        job.run_id !== expected.run_id ||
        job.run_attempt !== expected.attempt ||
        job.head_sha !== expected.revision ||
        job.status !== "completed"
      )
        throw new Error("job run/attempt/source identity differs");
      return {
        id: job.id,
        name: text(job.name, "job name"),
        status: text(job.status, "job status"),
        conclusion: job.conclusion === null ? null : text(job.conclusion, "job conclusion"),
        runner_id: Number.isSafeInteger(job.runner_id) && job.runner_id >= 0 ? job.runner_id : null,
        runner_name: nullableText(job.runner_name, "runner name"),
        started_at: nullableText(job.started_at, "job start time"),
        completed_at: nullableText(job.completed_at, "job completion time"),
      };
    })
    .sort((left, right) => left.id - right.id);
  const artifacts = page(`${runPath}/artifacts?per_page=100`, "artifacts")
    .map((artifact) => {
      const producer = artifact.workflow_run;
      if (
        producer?.id !== expected.run_id ||
        producer.repository_id !== expected.repository_id ||
        producer.head_repository_id !== expected.repository_id ||
        producer.head_sha !== expected.revision ||
        typeof artifact.expired !== "boolean" ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes < 0
      )
        throw new Error("artifact run/source identity differs");
      return {
        id: artifact.id,
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

export async function readReleaseEvidenceRequest(filename, { openFile = open } = {}) {
  const handle = await openFile(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 16 * 1024)
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

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.length !== 3) throw new Error("usage: release-run-evidence.mjs REQUEST.json");
  const request = await readReleaseEvidenceRequest(process.argv[2]);
  console.log(JSON.stringify(collectReleaseRunEvidence(request), null, 2));
}
