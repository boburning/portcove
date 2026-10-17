import { errorCode, isRecord } from "./runtime-values.mts";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { AUDIT_STAGES, fingerprintStage } from "./audit.mts";
import { AUDIT_BUNDLE_LIMITS, buildAuditBundle } from "./audit-evidence.mts";
import { parseAuditArchive } from "./audit-archive.mts";
import { createGitHubRunner } from "./github-api.mts";
import { renderBoundedSummary } from "./report-summary.mts";

import {
  isValidationDomain,
  isFingerprintRuntime,
  validateReceipt,
} from "./validation-evidence.mts";
import type { FingerprintInventory, StageIdentity } from "./validation-evidence.mts";

import type { planAudit } from "./audit.mts";

type CurrentPlan = ReturnType<typeof planAudit>;
interface AuditMiss {
  reason: string;
  stage?: string;
  run?: unknown;
}
interface ReuseResult {
  status: "skipped" | "imported" | "cache-miss";
  reason: string;
  imported: string[];
  misses?: AuditMiss[];
  examinedRuns?: number;
  downloads?: number;
}
export interface AuditRequestOptions {
  binary: boolean;
  timeoutMs: number;
  cwd: string;
}
export interface AuditReuseOptions {
  workflowDigest?: string;
  fresh?: boolean;
  clock?: () => number;
  root?: string;
  request?: (endpoint: string, options: AuditRequestOptions) => unknown;
}
function record(value: unknown, reason = "invalid-bundle") {
  requireValid(isRecord(value), reason);
  return value;
}
function text(value: unknown, reason: string): string {
  requireValid(typeof value === "string", reason);
  return value;
}
function number(value: unknown, reason: string): number {
  requireValid(typeof value === "number", reason);
  return value;
}
function bytesAt(files: ReadonlyMap<string, Buffer>, name: string): Buffer {
  const bytes = files.get(name);
  requireValid(bytes, "incomplete-bundle");
  return bytes;
}
const repositoryName = "boburning/portcove",
  route = `repos/${repositoryName}`;
const workflowPath = ".github/workflows/deep-quality.yml";
const workflowRef = `${repositoryName}/${workflowPath}@refs/heads/main`;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = /^[a-f0-9]{40}$/;
export function describeAuditReuse(result: ReuseResult) {
  const reasons = new Map<string, number>();
  for (const miss of result.misses ?? [])
    reasons.set(miss.reason, (reasons.get(miss.reason) ?? 0) + 1);
  return renderBoundedSummary(`[audit-reuse] ${result.status}: ${result.reason}`, [
    `Imported ${result.imported.length}; examined ${result.examinedRuns ?? 0} main runs; downloaded ${result.downloads ?? 0} artifacts`,
    ...[...reasons].map(([reason, count]) => `${reason}: ${count}`),
  ]).text;
}
function reject(reason: string): never {
  throw Object.assign(new Error(`Audit reuse miss: ${reason}`), { code: reason });
}
function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) reject(reason);
}
function json(bytes: unknown, limit = 32 * 1024 * 1024) {
  requireValid(Buffer.isBuffer(bytes) && bytes.length <= limit, "invalid-bundle");
  // Bound parser-owned nesting and object work before allocating parsed records.
  let depth = 0,
    tokens = 0,
    string = false,
    escape = false;
  for (const byte of bytes) {
    if (string) {
      if (escape) escape = false;
      else if (byte === 92) escape = true;
      else if (byte === 34) string = false;
    } else if (byte === 34) string = true;
    else if (byte === 123 || byte === 91) {
      depth++;
      tokens++;
      requireValid(depth <= 32, "json-limits");
    } else if (byte === 125 || byte === 93) depth--;
    else if (byte === 44 || byte === 58) tokens++;
    requireValid(tokens <= 1_000_000, "json-limits");
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return value;
}

function recomputeOriginal(raw: unknown) {
  const inputs = record(raw, "invalid-inputs");
  requireValid(Array.isArray(inputs.inputs), "invalid-inputs");
  const rawFiles: unknown[] = inputs.inputs;
  const files: FingerprintInventory["files"] = rawFiles.map((rawFile) => {
    const f = record(rawFile, "invalid-inputs");
    requireValid(
      Array.isArray(f.modes) &&
        f.modes.length <= 3 &&
        f.modes.every((v: unknown) => typeof v === "string") &&
        Array.isArray(f.contentIdentities) &&
        f.contentIdentities.length <= 3 &&
        f.contentIdentities.every((v: unknown) => typeof v === "string") &&
        Array.isArray(f.domains) &&
        typeof f.path === "string" &&
        (f.kind === "file" || f.kind === "missing" || f.kind === "symlink" || f.kind === "other") &&
        (f.sha256 === null || typeof f.sha256 === "string") &&
        typeof f.ambiguous === "boolean",
      "invalid-inputs",
    );
    const domains = f.domains.map((domain: unknown) => {
      requireValid(isValidationDomain(domain), "invalid-inputs");
      return domain;
    });
    // Canonical lists have at most three entries; absence remains absence, not a fabricated identity.
    const modes: unknown[] = f.modes,
      identities: unknown[] = f.contentIdentities;
    const identity = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      path: f.path,
      kind: f.kind,
      sha256: f.sha256,
      domains,
      ambiguous: f.ambiguous,
      headMode: identity(modes[0]),
      indexMode: identity(modes[1]),
      worktreeMode: identity(modes[2]),
      headBlob: identity(identities[0]),
      indexBlob: identity(identities[1]),
      gitBlob: identity(identities[2]),
    };
  });
  const stage = record(inputs.stage, "invalid-inputs");
  requireValid(
    typeof stage.id === "string" &&
      typeof stage.recipe === "string" &&
      isValidationDomain(stage.domain) &&
      isFingerprintRuntime(inputs.runtime) &&
      (inputs.gitObjectFormat === "sha1" || inputs.gitObjectFormat === "sha256"),
    "invalid-inputs",
  );
  const checkedStage: StageIdentity = { id: stage.id, recipe: stage.recipe, domain: stage.domain };
  return fingerprintStage(
    checkedStage,
    { objectFormat: inputs.gitObjectFormat, files },
    inputs.runtime,
  );
}

export function validateAuditProducer(
  files: ReadonlyMap<string, Buffer>,
  rawProof: unknown,
  { workflowDigest }: Pick<AuditReuseOptions, "workflowDigest"> = {},
) {
  const proof = record(rawProof);
  const manifest = record(json(files.get("manifest.json"), 65536));
  const run = record(proof.run, "unsuccessful-main-producer"),
    job = record(proof.job, "unsuccessful-audit-job"),
    artifact = record(proof.artifact, "invalid-artifact"),
    repository = record(proof.repository, "foreign-repository"),
    ancestry = record(proof.ancestry, "not-merged-main");
  const identity = record(manifest.identity, "changed-contract-or-attempt");
  const runRepository = record(run.repository, "foreign-repository"),
    headRepository = record(run.head_repository, "foreign-repository");
  const artifactRun = record(artifact.workflow_run, "invalid-artifact");
  requireValid(
    repository?.full_name === repositoryName &&
      typeof repository.id === "number" &&
      Number.isSafeInteger(repository.id) &&
      repository.id > 0 &&
      runRepository.id === repository.id &&
      runRepository.full_name === repositoryName &&
      headRepository.id === repository.id &&
      headRepository.full_name === repositoryName,
    "foreign-repository",
  );
  requireValid(
    run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.path === workflowPath &&
      run.workflow_id === proof.workflowId &&
      typeof run.head_sha === "string" &&
      sha.test(run.head_sha) &&
      typeof run.id === "number" &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      typeof run.run_attempt === "number" &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.status === "completed" &&
      ["success", "failure"].includes(text(run.conclusion, "unsuccessful-main-producer")),
    "unsuccessful-main-producer",
  );
  requireValid(
    typeof proof.mainSha === "string" &&
      sha.test(proof.mainSha) &&
      record(ancestry.base_commit, "not-merged-main").sha === run.head_sha &&
      record(ancestry.merge_base_commit, "not-merged-main").sha === run.head_sha &&
      ["ahead", "identical"].includes(text(ancestry.status, "not-merged-main")),
    "not-merged-main",
  );
  requireValid(
    job?.name === "audit" &&
      job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.head_sha === run.head_sha &&
      typeof job.id === "number" &&
      Number.isSafeInteger(job.id) &&
      job.id > 0 &&
      job.status === "completed" &&
      ["success", "failure"].includes(text(job.conclusion, "unsuccessful-audit-job")) &&
      Number.isFinite(Date.parse(text(job.started_at, "invalid-producer-time"))) &&
      Number.isFinite(Date.parse(text(job.completed_at, "invalid-producer-time"))),
    "unsuccessful-audit-job",
  );
  requireValid(
    artifact?.expired === false &&
      Number.isFinite(Date.parse(text(artifact.expires_at, "invalid-producer-time"))) &&
      Date.parse(text(artifact.expires_at, "invalid-producer-time")) > Date.now() &&
      typeof artifact.id === "number" &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      typeof artifact.size_in_bytes === "number" &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      typeof artifact.size_in_bytes === "number" &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
      /^sha256:[a-f0-9]{64}$/.test(text(artifact.digest, "invalid-artifact")) &&
      artifact.name === `audit-evidence-${run.id}-${run.run_attempt}` &&
      artifactRun.id === run.id &&
      artifactRun.repository_id === repository.id &&
      artifactRun.head_repository_id === repository.id &&
      artifactRun.head_branch === "main" &&
      artifactRun.head_sha === run.head_sha,
    "invalid-artifact",
  );
  requireValid(
    manifest.format === 1 &&
      manifest.kind === "hosted-audit-evidence" &&
      typeof manifest.diagnosticOnly === "boolean" &&
      identity?.repository === repositoryName &&
      identity.source === run.head_sha &&
      identity.workflowSha === run.head_sha &&
      identity.workflowRef === workflowRef &&
      identity.run === String(run.id) &&
      identity.attempt === String(run.run_attempt) &&
      identity.workflowDigest === proof.workflowDigest &&
      identity.workflowDigest === workflowDigest,
    "changed-contract-or-attempt",
  );
  requireValid(
    Array.isArray(manifest.files) &&
      manifest.files.length + 1 === files.size &&
      files.size <= AUDIT_BUNDLE_LIMITS.files &&
      JSON.stringify(manifest.limits) === JSON.stringify(AUDIT_BUNDLE_LIMITS),
    "incomplete-bundle",
  );
  const seen = new Set<string>();
  let total = bytesAt(files, "manifest.json").length;
  const manifestFiles: unknown[] = manifest.files;
  for (const rawFile of manifestFiles) {
    const record = isRecord(rawFile) ? rawFile : {};
    requireValid(typeof record.path === "string", "bundle-integrity");
    const bytes = files.get(record.path);
    requireValid(
      record.path !== "manifest.json" &&
        !seen.has(record.path) &&
        Buffer.isBuffer(bytes) &&
        bytes.length === record.bytes &&
        hash(bytes) === record.sha256,
      "bundle-integrity",
    );
    seen.add(record.path);
    total += bytes.length;
    requireValid(total <= AUDIT_BUNDLE_LIMITS.expandedBytes, "bundle-limits");
  }
  const capture = record(json(files.get("inputs.json"))),
    aggregate = record(json(files.get("audit.json"), 131072)),
    binding = record(json(files.get("binding.json"), 16384));
  const aggregatePayload = record(aggregate.payload),
    capturePayload = record(capture.payload);
  requireValid(
    number(binding.startedMs, "job-time-binding") >=
      Date.parse(text(job.started_at, "invalid-producer-time")) &&
      number(binding.completedMs, "job-time-binding") <=
        Date.parse(text(job.completed_at, "invalid-producer-time")),
    "job-time-binding",
  );
  const receipts = Object.fromEntries(
    AUDIT_STAGES.filter((s) => s.reusable && files.has(`receipts/${s.id}.json`)).map((s) => [
      s.id,
      json(files.get(`receipts/${s.id}.json`), 16384),
    ]),
  );
  const rebuilt = buildAuditBundle({ identity, binding, capture, aggregate, receipts });
  requireValid(
    rebuilt.files.size === files.size && manifest.diagnosticOnly === !aggregatePayload.success,
    "incomplete-bundle",
  );
  for (const [name, bytes] of rebuilt.files)
    requireValid(
      files.has(name) && hash(bytes) === hash(bytesAt(files, name)),
      "unsupported-bundle-shape",
    );
  requireValid(
    typeof aggregatePayload.success === "boolean" && Array.isArray(aggregatePayload.stages),
    "incomplete-bundle",
  );
  const stageInputs = record(capturePayload.stageInputs);
  const rawStages: unknown[] = aggregatePayload.stages;
  const stages = rawStages.map((rawStage) => {
    const stage = record(rawStage);
    requireValid(typeof stage.id === "string", "invalid-inputs");
    requireValid(
      recomputeOriginal(stageInputs[stage.id]) === stage.fingerprint,
      "original-fingerprint-mismatch",
    );
    requireValid(typeof stage.status === "string", "invalid-inputs");
    return { ...stage, id: stage.id, status: stage.status };
  });
  const checkedReceipts = Object.fromEntries(
    Object.entries(receipts).map(([id, receipt]) => {
      const checked = validateReceipt(receipt);
      requireValid(checked.valid, "invalid-receipt");
      return [id, { ...record(receipt), payload: checked.payload }];
    }),
  );
  return {
    manifest,
    capture,
    aggregate: {
      ...aggregate,
      payload: { ...aggregatePayload, success: aggregatePayload.success, stages },
    },
    binding,
    receipts: checkedReceipts,
    proof: {
      run: { id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha },
      job: { id: job.id },
      artifact: { id: artifact.id, digest: text(artifact.digest, "invalid-artifact") },
      mainSha: proof.mainSha,
      workflowDigest: proof.workflowDigest,
    },
  };
}

function ensureDirectory(directory: string, root: string) {
  const relative = path.relative(root, directory);
  requireValid(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "unsafe-receipt-path",
  );
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      requireValid(stat.isDirectory() && !stat.isSymbolicLink(), "foreign-receipt-path");
    } else mkdirSync(current);
  }
}

interface ImportResult {
  imported: string[];
  misses: AuditMiss[];
  provenance: string | null;
}

export function importAuditReceipts(
  files: ReadonlyMap<string, Buffer>,
  rawProof: unknown,
  currentPlan: CurrentPlan,
  options: Pick<AuditReuseOptions, "workflowDigest"> = {},
): ImportResult {
  const bundle = validateAuditProducer(files, rawProof, options);
  const proof = bundle.proof;
  const matching = [];
  const misses: AuditMiss[] = [];
  for (const stage of currentPlan.stages.filter((s) => s.reusable)) {
    const receipt = bundle.receipts[stage.id];
    if (
      !receipt ||
      receipt.payload.fingerprint !==
        fingerprintStage(stage, currentPlan.inventory, currentPlan.runtime)
    ) {
      misses.push({ stage: stage.id, reason: "fingerprint-mismatch" });
      continue;
    }
    const file = path.join(
      currentPlan.receiptRoot,
      "stages",
      stage.id,
      `${receipt.payload.fingerprint}.json`,
    );
    if (existsSync(file)) {
      misses.push({ stage: stage.id, reason: "existing-local-receipt" });
      continue;
    }
    matching.push({ stage, receipt, file });
  }
  if (!matching.length) return { imported: [], misses, provenance: null };
  mkdirSync(path.dirname(currentPlan.receiptRoot), { recursive: true });
  ensureDirectory(path.dirname(currentPlan.receiptRoot), path.dirname(currentPlan.receiptRoot));
  ensureDirectory(currentPlan.receiptRoot, currentPlan.receiptRoot);
  const imports = path.join(currentPlan.receiptRoot, "imports");
  ensureDirectory(imports, currentPlan.receiptRoot);
  const id = `${proof.run.id}-${proof.run.run_attempt}-${proof.artifact.id}-${randomUUID()}`;
  const temporary = path.join(imports, `${id}.tmp`),
    provenance = path.join(imports, id);
  mkdirSync(temporary);
  for (const [name, bytes] of files) {
    const file = path.join(temporary, name);
    ensureDirectory(path.dirname(file), temporary);
    writeFileSync(file, bytes, { flag: "wx" });
  }
  const record = {
    format: 1,
    kind: "verified-main-audit-import",
    repository: repositoryName,
    source: proof.run.head_sha,
    main: proof.mainSha,
    run: proof.run.id,
    attempt: proof.run.run_attempt,
    job: proof.job.id,
    artifact: proof.artifact.id,
    artifactDigest: proof.artifact.digest,
    workflowDigest: proof.workflowDigest,
  };
  writeFileSync(path.join(temporary, "provenance.json"), JSON.stringify(record), { flag: "wx" });
  renameSync(temporary, provenance);
  const imported: string[] = [];
  for (const { stage, file } of matching) {
    ensureDirectory(path.dirname(file), currentPlan.receiptRoot);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, bytesAt(files, `receipts/${stage.id}.json`), { flag: "wx" });
    try {
      linkSync(temp, file);
      imported.push(stage.id);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      misses.push({ stage: stage.id, reason: "concurrent-local-receipt" });
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        misses.push({ stage: stage.id, reason: "temporary-cleanup-unavailable" });
      }
    }
  }
  return { imported, misses, provenance };
}

function defaultRequest(
  endpoint: string,
  { binary, timeoutMs, cwd }: AuditRequestOptions,
): unknown {
  if (!binary)
    return JSON.parse(
      createGitHubRunner({ cwd, timeoutMs, maxBuffer: 2 * 1024 * 1024 })(["api", endpoint]),
    );
  const result = spawnSync("gh", ["api", endpoint], {
    cwd,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer: AUDIT_BUNDLE_LIMITS.compressedBytes,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) reject("provider-unavailable");
  return result.stdout;
}

export function discoverAuditReceipts(
  currentPlan: CurrentPlan,
  options: AuditReuseOptions = {},
): ReuseResult {
  if (options.fresh || currentPlan.profile === "transition")
    return { status: "skipped", reason: "fresh-required", imported: [] };
  const needed = new Set(
    currentPlan.stages.filter((s) => s.reusable && s.action !== "reuse").map((s) => s.id),
  );
  if (!needed.size) return { status: "skipped", reason: "existing-local-evidence", imported: [] };
  const clock = options.clock ?? Date.now,
    deadline = clock() + 60000;
  const misses: AuditMiss[] = [],
    imported: string[] = [];
  let examinedRuns = 0,
    downloads = 0;
  const active = () => {
    requireValid(clock() < deadline, "collection-deadline");
  };
  const request = (endpoint: string, binary = false) => {
    active();
    const value = (options.request ?? defaultRequest)(endpoint, {
      binary,
      timeoutMs: Math.min(15000, Math.max(1, deadline - clock())),
      cwd: options.root ?? process.cwd(),
    });
    active();
    return value;
  };
  const requestRecord = (endpoint: string) =>
    record(request(endpoint), "provider-coverage-unavailable");
  const collection = (endpoint: string, key: string) => {
    const entries: Record<string, unknown>[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 10; page++) {
      const data = requestRecord(`${endpoint}?per_page=100&page=${page}`);
      const pageEntries = data[key];
      requireValid(
        typeof data.total_count === "number" &&
          Number.isSafeInteger(data.total_count) &&
          data.total_count >= 0 &&
          data.total_count <= 1000 &&
          Array.isArray(pageEntries) &&
          pageEntries.length <= 100,
        "provider-coverage-unavailable",
      );
      if (total === null) total = data.total_count;
      requireValid(total === data.total_count, "provider-coverage-unavailable");
      const rawEntries: unknown[] = pageEntries;
      entries.push(...rawEntries.map((entry) => record(entry, "provider-coverage-unavailable")));
      if (entries.length >= total) {
        requireValid(
          entries.length === total && new Set(entries.map((x) => x.id)).size === entries.length,
          "provider-coverage-unavailable",
        );
        return entries;
      }
      requireValid(pageEntries.length === 100, "provider-coverage-unavailable");
    }
    reject("provider-coverage-unavailable");
  };
  try {
    const repository = requestRecord(route),
      mainSha = record(
        requestRecord(`${route}/git/ref/heads/main`).object,
        "provider-identity-unavailable",
      ).sha;
    requireValid(
      repository.full_name === repositoryName && typeof mainSha === "string" && sha.test(mainSha),
      "provider-identity-unavailable",
    );
    const workflow = requestRecord(`${route}/actions/workflows/deep-quality.yml`);
    requireValid(
      workflow.path === workflowPath && Number.isSafeInteger(workflow.id),
      "provider-identity-unavailable",
    );
    const localDigest =
      options.workflowDigest ??
      hash(readFileSync(path.join(options.root ?? process.cwd(), workflowPath)));
    const mainWorkflow = requestRecord(`${route}/contents/${workflowPath}?ref=${mainSha}`);
    requireValid(
      mainWorkflow.encoding === "base64" &&
        mainWorkflow.type === "file" &&
        typeof mainWorkflow.size === "number" &&
        mainWorkflow.size > 0 &&
        mainWorkflow.size <= 131072 &&
        hash(Buffer.from(text(mainWorkflow.content, "changed-contract"), "base64")) === localDigest,
      "changed-contract",
    );
    const window = requestRecord(
      `${route}/actions/workflows/deep-quality.yml/runs?branch=main&status=completed&per_page=20`,
    );
    const runs = window.workflow_runs;
    requireValid(
      typeof window.total_count === "number" &&
        Number.isSafeInteger(window.total_count) &&
        window.total_count >= 0 &&
        Array.isArray(runs) &&
        runs.length === Math.min(window.total_count, 20) &&
        new Set(runs.map((r: unknown) => record(r, "provider-coverage-unavailable").id)).size ===
          runs.length,
      "provider-coverage-unavailable",
    );
    const rawRuns: unknown[] = runs;
    for (const rawCandidate of rawRuns) {
      const candidate = record(rawCandidate, "provider-coverage-unavailable");
      active();
      examinedRuns++;
      try {
        requireValid(
          candidate.head_branch === "main" &&
            candidate.status === "completed" &&
            ["success", "failure"].includes(
              text(candidate.conclusion, "unsuccessful-main-producer"),
            ) &&
            typeof candidate.id === "number" &&
            Number.isSafeInteger(candidate.id) &&
            candidate.id > 0,
          "unsuccessful-main-producer",
        );
        const run = requestRecord(`${route}/actions/runs/${candidate.id}`);
        requireValid(
          typeof run.id === "number" &&
            run.id === candidate.id &&
            typeof run.head_sha === "string" &&
            sha.test(run.head_sha) &&
            typeof run.run_attempt === "number" &&
            Number.isSafeInteger(run.run_attempt) &&
            run.run_attempt > 0 &&
            record(run.repository, "provider-identity-unavailable").id === repository.id &&
            record(run.head_repository, "provider-identity-unavailable").id === repository.id &&
            run.head_branch === "main" &&
            run.event === "workflow_dispatch" &&
            run.path === workflowPath &&
            run.workflow_id === workflow.id &&
            run.status === "completed" &&
            ["success", "failure"].includes(text(run.conclusion, "unsuccessful-main-producer")),
          "provider-identity-unavailable",
        );
        const jobs = collection(
          `${route}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
          "jobs",
        );
        const audits = jobs.filter((j) => j.name === "audit");
        requireValid(
          audits.length === 1 &&
            audits[0] !== undefined &&
            ["success", "failure"].includes(text(audits[0].conclusion, "unsuccessful-audit-job")),
          "unsuccessful-audit-job",
        );
        const artifactName = `audit-evidence-${run.id}-${run.run_attempt}`;
        const artifacts = collection(
          `${route}/actions/runs/${run.id}/artifacts`,
          "artifacts",
        ).filter((a) => a.name === artifactName);
        requireValid(
          artifacts.length === 1 &&
            artifacts[0] !== undefined &&
            typeof artifacts[0].id === "number" &&
            Number.isSafeInteger(artifacts[0].id) &&
            artifacts[0].id > 0,
          "artifact-unavailable",
        );
        const artifact = requestRecord(`${route}/actions/artifacts/${artifacts[0].id}`);
        requireValid(
          artifact.id === artifacts[0].id &&
            artifact.expired === false &&
            typeof artifact.size_in_bytes === "number" &&
            artifact.size_in_bytes > 0 &&
            artifact.size_in_bytes <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
            /^sha256:[a-f0-9]{64}$/.test(text(artifact.digest, "invalid-artifact")),
          "invalid-artifact",
        );
        const ancestry = requestRecord(`${route}/compare/${run.head_sha}...${mainSha}`);
        requireValid(
          record(ancestry.merge_base_commit, "not-merged-main").sha === run.head_sha &&
            ["ahead", "identical"].includes(text(ancestry.status, "not-merged-main")),
          "not-merged-main",
        );
        const content = requestRecord(`${route}/contents/${workflowPath}?ref=${run.head_sha}`);
        requireValid(
          content.encoding === "base64" &&
            content.type === "file" &&
            typeof content.size === "number" &&
            content.size <= 131072,
          "changed-contract",
        );
        const workflowDigest = hash(
          Buffer.from(text(content.content, "changed-contract"), "base64"),
        );
        requireValid(workflowDigest === localDigest, "changed-contract");
        if (downloads >= 3) break;
        downloads++;
        const bytes = request(`${route}/actions/artifacts/${artifact.id}/zip`, true);
        requireValid(
          Buffer.isBuffer(bytes) &&
            bytes.length <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
            hash(bytes) === text(artifact.digest, "invalid-artifact").slice(7),
          "artifact-digest-mismatch",
        );
        const files = parseAuditArchive(bytes, { deadline, clock });
        const finalRun = requestRecord(`${route}/actions/runs/${run.id}`),
          finalMain = record(
            requestRecord(`${route}/git/ref/heads/main`).object,
            "provider-identity-unavailable",
          ).sha;
        requireValid(
          finalRun.head_sha === run.head_sha &&
            finalRun.run_attempt === run.run_attempt &&
            finalRun.status === "completed" &&
            finalRun.conclusion === run.conclusion &&
            finalMain === mainSha,
          "producer-changed",
        );
        const proof = {
          repository,
          mainSha,
          run,
          job: audits[0],
          artifact,
          workflowDigest,
          workflowId: workflow.id,
          ancestry,
        };
        active();
        const result = importAuditReceipts(files, proof, currentPlan, {
          workflowDigest: localDigest,
        });
        imported.push(...result.imported);
        for (const stage of result.imported) needed.delete(stage);
        misses.push(...result.misses.map((m) => ({ run: run.id, ...m })));
        if (!needed.size) break;
      } catch (error) {
        misses.push({ run: candidate.id, reason: errorCode(error) ?? "invalid-evidence" });
        if (clock() >= deadline) reject("collection-deadline");
      }
    }
    return {
      status: imported.length ? "imported" : "cache-miss",
      reason: imported.length ? "verified-main-evidence" : "no-compatible-main-evidence",
      imported,
      examinedRuns,
      downloads,
      misses,
    };
  } catch (error) {
    return {
      status: imported.length ? "imported" : "cache-miss",
      reason: [
        "collection-deadline",
        "changed-contract",
        "provider-coverage-unavailable",
        "provider-identity-unavailable",
      ].includes(errorCode(error) ?? "")
        ? (errorCode(error) ?? "provider-unavailable")
        : "provider-unavailable",
      imported,
      examinedRuns,
      downloads,
      misses,
    };
  }
}
