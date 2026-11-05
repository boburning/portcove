import type { WakeProvider } from "./release-wake-provider.mts";
/** Read existing qualification facts. No dispatch, version allocation, storage
 * writer or private authority is created by this reader. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { isRecord } from "./runtime-values.mts";
import { validateValidationPlan } from "./validation-plan.mts";

const repository = "repos/boburning/portcove";
const sharedAndWindowsJobs = Object.freeze([
  "classify-ci-plan",
  "record-workflow-provenance",
  "frontend-full",
  "catalog-full",
  "rust-quality-full",
  "rust-clippy",
  "windows-storage",
  "qualification-core-archive",
  "rust-test (workspace-other)",
  "rust-doc (windows-x86_64)",
  "rust-test (core-service-1)",
  "rust-test (core-service-2)",
  "rust-test (core-recovery)",
  "rust-test (core-other-1)",
  "rust-test (core-other-2)",
]);

const canonicalQualificationJobs = [
  "selection",
  "dependency-review",
  "package_qualification / package",
  "package_qualification / provenance",
] as const;

export function inspectWindowsApplicationQualification(
  run: unknown,
  rawJobs: unknown,
  rawPlan: unknown,
  source: string,
) {
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.ok(isRecord(run));
  assert.ok(Number.isSafeInteger(run.id) && Number(run.id) > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && Number(run.run_attempt) > 0);
  assert.ok(
    run.path === ".github/workflows/qualification.yml" ||
      run.path === ".github/workflows/application-release.yml",
  );
  assert.equal(run.head_sha, source);
  assert.equal(run.head_branch, "main");
  assert.ok(run.event === "schedule" || run.event === "workflow_dispatch");
  assert.equal(run.status, "completed");
  assert.ok(run.conclusion === "success" || run.conclusion === "failure");
  assert.ok(
    isRecord(run.repository) &&
      run.repository.id === 1354613114 &&
      run.repository.full_name === "boburning/portcove",
  );
  assert.ok(isRecord(run.head_repository) && run.head_repository.id === 1354613114);
  const plan = validateValidationPlan(rawPlan);
  assert.equal(plan.mode, "qualification");
  assert.equal(plan.discovery, "complete");
  assert.equal(plan.identities.checkout, source);
  assert.ok(plan.identities.head === null || plan.identities.head === source);
  assert.deepEqual([...plan.groups].sort(), [
    "catalog",
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
  ]);
  assert.ok(plan.platforms.includes("windows-x86_64"));
  assert.ok(isRecord(rawJobs) && Array.isArray(rawJobs.jobs));
  assert.equal(rawJobs.total_count, rawJobs.jobs.length);
  assert.ok(rawJobs.jobs.length > 0 && rawJobs.jobs.length < 100);
  const byName = new Map<string, Record<string, unknown>>();
  const ids = new Set<number>();
  for (const value of rawJobs.jobs) {
    assert.ok(isRecord(value) && typeof value.name === "string");
    assert.equal(value.run_id, run.id);
    assert.equal(value.run_attempt, run.run_attempt);
    assert.equal(value.head_sha, source);
    assert.ok(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0);
    assert.ok(!byName.has(value.name) && !ids.has(value.id));
    byName.set(value.name, value);
    ids.add(value.id);
  }
  const requiredJobs = sharedAndWindowsJobs.map((name) => `qualify / ${name}`);
  if (run.path === ".github/workflows/application-release.yml") {
    assert.equal(run.event, "workflow_dispatch");
    assert.equal(run.display_title, `Windows qualification ${source}`);
    assert.equal(plan.release_profile, "initial-beta-windows-x86_64-v1");
    assert.equal(run.conclusion, "success", "canonical Windows qualification did not succeed");
    requiredJobs.push(...canonicalQualificationJobs);
  }
  for (const name of requiredJobs) {
    const job = byName.get(name);
    assert.ok(job, `missing required qualification producer: ${name}`);
    assert.equal(job.status, "completed", name);
    assert.equal(job.conclusion, "success", name);
  }
  return {
    workflow: run.path,
    workflow_commit: source,
    run_id: Number(run.id),
    attempt: Number(run.run_attempt),
    plan_digest: plan.digest,
    scope: "Windows x86-64 and shared qualification producers only",
    original_run_conclusion: run.conclusion,
    required_jobs: requiredJobs,
    authority: "none",
  };
}

export function readApplicationQualificationPlan(archive: Buffer) {
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: 1024 * 1024,
      expandedBytes: 1024 * 1024,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set(["validation-plan.json"]),
    },
    { deadline: Date.now() + 5000 },
  );
  assert.equal(parsed.entries.length, 1);
  const entry = parsed.entries[0]!;
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
  assert.equal(bytes.length, entry.bytes);
  assert.equal(crc32(bytes), entry.crc);
  return validateValidationPlan(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

/** A bounded current-main inventory selects a candidate for the existing
 * qualification reader. Only that reader can admit the exact provider jobs. */
export function selectWindowsApplicationQualificationRun(raw: unknown, source: string) {
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.ok(isRecord(raw) && Array.isArray(raw.workflow_runs));
  assert.equal(raw.total_count, raw.workflow_runs.length);
  assert.ok(raw.workflow_runs.length < 100, "qualification run inventory may be truncated");
  const candidates = [];
  const ids = new Set<number>();
  for (const run of raw.workflow_runs as unknown[]) {
    assert.ok(isRecord(run));
    assert.equal(run.head_sha, source);
    assert.equal(run.head_branch, "main");
    assert.equal(run.path, ".github/workflows/application-release.yml");
    assert.equal(run.event, "workflow_dispatch");
    assert.ok(isRecord(run.head_repository) && run.head_repository.id === 1354613114);
    assert.ok(isRecord(run.repository) && run.repository.id === 1354613114);
    const { id, run_attempt, created_at } = run;
    assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0 && !ids.has(id));
    assert.ok(
      typeof run_attempt === "number" && Number.isSafeInteger(run_attempt) && run_attempt > 0,
    );
    assert.ok(typeof created_at === "string" && Number.isFinite(Date.parse(created_at)));
    ids.add(id);
    if (run.display_title === `Windows qualification ${source}`)
      candidates.push({
        id,
        run_attempt,
        created: Date.parse(created_at),
        status: run.status,
        conclusion: run.conclusion,
      });
  }
  candidates.sort((left, right) => right.created - left.created || right.id - left.id);
  const newest = candidates[0];
  if (!newest) return { decision: "absent", authority: "none" } as const;
  if (newest.status !== "completed" || newest.conclusion !== "success")
    return {
      decision: "held",
      run_id: newest.id,
      run_attempt: newest.run_attempt,
      authority: "none",
    } as const;
  return {
    decision: "candidate",
    run_id: newest.id,
    run_attempt: newest.run_attempt,
    authority: "none",
  } as const;
}

/** The fixed controller compares the qualification recipes with its reviewed
 * copies, then reads the exact source/run/attempt and bounded retained plan.
 * Missing/expired evidence holds; old successful source is never substituted. */
export async function readWindowsApplicationQualification(
  reader: Pick<WakeProvider, "run" | "file" | "jobs" | "artifacts">,
  runId: number,
  source: string,
  options: { deadline?: number; download?: typeof readGitHubArtifactArchive } = {},
) {
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  assert.match(source, /^[a-f0-9]{40}$/u);
  let requests = 0;
  const deadline = Math.min(performance.now() + 90000, options.deadline ?? Infinity);
  const get = async (read: () => Promise<unknown>) => {
    assert.ok(++requests <= 8 && performance.now() < deadline);
    const raw = await read();
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 2 * 1024 ** 2);
    assert.ok(performance.now() < deadline);
    return raw;
  };
  const id = String(runId);
  const run = await get(() => reader.run(id));
  assert.ok(isRecord(run) && Number.isSafeInteger(run.run_attempt) && Number(run.run_attempt) > 0);
  assert.equal(run.id, runId);
  const attempt = Number(run.run_attempt);
  for (const workflow of [
    "ci.yml",
    ...(run.path === ".github/workflows/application-release.yml"
      ? ["application-release.yml", "application-release-package.yml"]
      : ["qualification.yml"]),
  ]) {
    const remote = await get(() => reader.file(`.github/workflows/${workflow}`, source));
    assert.ok(
      isRecord(remote) &&
        remote.type === "file" &&
        remote.encoding === "base64" &&
        typeof remote.content === "string",
    );
    const bytes = Buffer.from(remote.content, "base64");
    assert.equal(remote.size, bytes.length);
    const reviewed = await readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url));
    assert.deepEqual(
      bytes,
      reviewed,
      "qualification recipe changed; qualify its new control source first",
    );
  }
  const jobs = await get(() => reader.jobs(id, attempt));
  const artifacts = await get(() => reader.artifacts(id));
  assert.ok(isRecord(artifacts) && Array.isArray(artifacts.artifacts));
  assert.equal(artifacts.total_count, artifacts.artifacts.length);
  assert.ok(artifacts.artifacts.length < 100);
  const matching = artifacts.artifacts.filter(
    (item: unknown) =>
      isRecord(item) && item.name === `validation-plan-qualification-${runId}-${attempt}`,
  );
  assert.equal(matching.length, 1);
  const artifact: unknown = matching[0];
  assert.ok(
    isRecord(artifact) &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.id) &&
      Number(artifact.id) > 0,
  );
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      Number(artifact.size_in_bytes) >= 22 &&
      Number(artifact.size_in_bytes) <= 1024 * 1024,
  );
  assert.ok(typeof artifact.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest));
  assert.ok(
    isRecord(artifact.workflow_run) &&
      artifact.workflow_run.id === runId &&
      artifact.workflow_run.head_sha === source &&
      artifact.workflow_run.repository_id === 1354613114,
  );
  const timeoutMs = Math.min(30000, Math.floor(deadline - performance.now()));
  assert.ok(timeoutMs > 0);
  const archive = (options.download ?? readGitHubArtifactArchive)(
    `${repository}/actions/artifacts/${Number(artifact.id)}/zip`,
    {
      cwd: process.cwd(),
      maxBytes: 1024 * 1024,
      timeoutMs,
    },
  );
  assert.equal(archive.length, artifact.size_in_bytes);
  assert.equal(createHash("sha256").update(archive).digest("hex"), artifact.digest.slice(7));
  const plan = readApplicationQualificationPlan(archive);
  const result = inspectWindowsApplicationQualification(run, jobs, plan, source);
  assert.deepEqual(
    await get(() => reader.run(id)),
    run,
    "qualification run changed during readback",
  );
  return {
    ...result,
    plan_artifact: Number(artifact.id),
    plan_artifact_sha256: artifact.digest.slice(7),
  };
}
