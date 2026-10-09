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
import { AUDIT_STAGES, fingerprintStage } from "./audit.mjs";
import { AUDIT_BUNDLE_LIMITS, buildAuditBundle } from "./audit-evidence.mjs";
import { parseAuditArchive } from "./audit-archive.mjs";
import { createGitHubRunner } from "./github-api.mjs";

const repositoryName = "boburning/portcove",
  route = `repos/${repositoryName}`;
const workflowPath = ".github/workflows/deep-quality.yml";
const workflowRef = `${repositoryName}/${workflowPath}@refs/heads/main`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = /^[a-f0-9]{40}$/;
function reject(reason) {
  throw Object.assign(new Error(`Audit reuse miss: ${reason}`), { code: reason });
}
function requireValid(condition, reason) {
  if (!condition) reject(reason);
}
function json(bytes, limit = 32 * 1024 * 1024) {
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
  return JSON.parse(bytes.toString("utf8"));
}

function recomputeOriginal(inputs) {
  requireValid(
    Array.isArray(inputs?.inputs) &&
      inputs.inputs.every(
        (f) =>
          Array.isArray(f.modes) &&
          f.modes.length <= 3 &&
          Array.isArray(f.contentIdentities) &&
          f.contentIdentities.length <= 3 &&
          Array.isArray(f.domains),
      ),
    "invalid-inputs",
  );
  const files = inputs.inputs.map((f) => ({
    path: f.path,
    kind: f.kind,
    sha256: f.sha256,
    domains: f.domains,
    ambiguous: f.ambiguous,
    headMode: f.modes[0],
    indexMode: f.modes[1],
    worktreeMode: f.modes[2],
    headBlob: f.contentIdentities[0],
    indexBlob: f.contentIdentities[1],
    gitBlob: f.contentIdentities[2],
  }));
  return fingerprintStage(
    inputs.stage,
    { objectFormat: inputs.gitObjectFormat, files },
    inputs.runtime,
  );
}

export function validateAuditProducer(files, proof, { workflowDigest } = {}) {
  const manifest = json(files.get("manifest.json"), 65536);
  const { run, job, artifact, repository, ancestry } = proof;
  const identity = manifest.identity;
  requireValid(
    repository?.full_name === repositoryName &&
      Number.isSafeInteger(repository.id) &&
      repository.id > 0 &&
      run?.repository?.id === repository.id &&
      run.repository.full_name === repositoryName &&
      run.head_repository?.id === repository.id &&
      run.head_repository.full_name === repositoryName,
    "foreign-repository",
  );
  requireValid(
    run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.path === workflowPath &&
      run.workflow_id === proof.workflowId &&
      sha.test(run.head_sha) &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.status === "completed" &&
      run.conclusion === "success",
    "unsuccessful-main-producer",
  );
  requireValid(
    sha.test(proof.mainSha) &&
      ancestry?.base_commit?.sha === run.head_sha &&
      ancestry.merge_base_commit?.sha === run.head_sha &&
      ["ahead", "identical"].includes(ancestry.status),
    "not-merged-main",
  );
  requireValid(
    job?.name === "audit" &&
      job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.head_sha === run.head_sha &&
      Number.isSafeInteger(job.id) &&
      job.id > 0 &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      Number.isFinite(Date.parse(job.started_at)) &&
      Number.isFinite(Date.parse(job.completed_at)),
    "unsuccessful-audit-job",
  );
  requireValid(
    artifact?.expired === false &&
      Number.isFinite(Date.parse(artifact.expires_at)) &&
      Date.parse(artifact.expires_at) > Date.now() &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
      artifact.name === `audit-evidence-${run.id}-${run.run_attempt}` &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run.repository_id === repository.id &&
      artifact.workflow_run.head_repository_id === repository.id &&
      artifact.workflow_run.head_branch === "main" &&
      artifact.workflow_run.head_sha === run.head_sha,
    "invalid-artifact",
  );
  requireValid(
    manifest.format === 1 &&
      manifest.kind === "hosted-audit-evidence" &&
      manifest.diagnosticOnly === false &&
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
  const seen = new Set();
  let total = files.get("manifest.json").length;
  for (const record of manifest.files) {
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
  const capture = json(files.get("inputs.json")),
    aggregate = json(files.get("audit.json"), 131072),
    binding = json(files.get("binding.json"), 16384);
  requireValid(
    binding.startedMs >= Date.parse(job.started_at) &&
      binding.completedMs <= Date.parse(job.completed_at),
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
    rebuilt.files.size === files.size && aggregate.payload.success === true,
    "incomplete-bundle",
  );
  for (const [name, bytes] of rebuilt.files)
    requireValid(
      files.has(name) && hash(bytes) === hash(files.get(name)),
      "unsupported-bundle-shape",
    );
  for (const stage of aggregate.payload.stages)
    requireValid(
      recomputeOriginal(capture.payload.stageInputs[stage.id]) === stage.fingerprint,
      "original-fingerprint-mismatch",
    );
  return { manifest, capture, aggregate, binding, receipts };
}

function ensureDirectory(directory, root) {
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

export function importAuditReceipts(files, proof, currentPlan, options = {}) {
  const bundle = validateAuditProducer(files, proof, options);
  const matching = [],
    misses = [];
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
  const imported = [];
  for (const { stage, file } of matching) {
    ensureDirectory(path.dirname(file), currentPlan.receiptRoot);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, files.get(`receipts/${stage.id}.json`), { flag: "wx" });
    try {
      linkSync(temp, file);
      imported.push(stage.id);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
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

function defaultRequest(endpoint, { binary, timeoutMs, cwd }) {
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

export function discoverAuditReceipts(currentPlan, options = {}) {
  if (options.fresh || currentPlan.profile === "transition")
    return { status: "skipped", reason: "fresh-required", imported: [] };
  const needed = new Set(
    currentPlan.stages.filter((s) => s.reusable && s.action !== "reuse").map((s) => s.id),
  );
  if (!needed.size) return { status: "skipped", reason: "existing-local-evidence", imported: [] };
  const clock = options.clock ?? Date.now,
    deadline = clock() + 60000;
  const misses = [],
    imported = [];
  let examinedRuns = 0,
    downloads = 0;
  const active = () => {
    requireValid(clock() < deadline, "collection-deadline");
  };
  const request = (endpoint, binary = false) => {
    active();
    const value = (options.request ?? defaultRequest)(endpoint, {
      binary,
      timeoutMs: Math.min(15000, Math.max(1, deadline - clock())),
      cwd: options.root ?? process.cwd(),
    });
    active();
    return value;
  };
  const collection = (endpoint, key) => {
    const entries = [];
    let total = null;
    for (let page = 1; page <= 10; page++) {
      const data = request(`${endpoint}?per_page=100&page=${page}`);
      requireValid(
        Number.isSafeInteger(data.total_count) &&
          data.total_count >= 0 &&
          data.total_count <= 1000 &&
          Array.isArray(data[key]) &&
          data[key].length <= 100,
        "provider-coverage-unavailable",
      );
      if (total === null) total = data.total_count;
      requireValid(total === data.total_count, "provider-coverage-unavailable");
      entries.push(...data[key]);
      if (entries.length >= total) {
        requireValid(
          entries.length === total && new Set(entries.map((x) => x.id)).size === entries.length,
          "provider-coverage-unavailable",
        );
        return entries;
      }
      requireValid(data[key].length === 100, "provider-coverage-unavailable");
    }
    reject("provider-coverage-unavailable");
  };
  try {
    const repository = request(route),
      mainSha = request(`${route}/git/ref/heads/main`).object?.sha;
    requireValid(
      repository.full_name === repositoryName && sha.test(mainSha),
      "provider-identity-unavailable",
    );
    const workflow = request(`${route}/actions/workflows/deep-quality.yml`);
    requireValid(
      workflow.path === workflowPath && Number.isSafeInteger(workflow.id),
      "provider-identity-unavailable",
    );
    const localDigest =
      options.workflowDigest ??
      hash(readFileSync(path.join(options.root ?? process.cwd(), workflowPath)));
    const mainWorkflow = request(`${route}/contents/${workflowPath}?ref=${mainSha}`);
    requireValid(
      mainWorkflow.encoding === "base64" &&
        mainWorkflow.type === "file" &&
        mainWorkflow.size > 0 &&
        mainWorkflow.size <= 131072 &&
        hash(Buffer.from(mainWorkflow.content, "base64")) === localDigest,
      "changed-contract",
    );
    const window = request(
      `${route}/actions/workflows/deep-quality.yml/runs?branch=main&status=completed&per_page=20`,
    );
    const runs = window.workflow_runs;
    requireValid(
      Number.isSafeInteger(window.total_count) &&
        window.total_count >= 0 &&
        Array.isArray(runs) &&
        runs.length === Math.min(window.total_count, 20) &&
        new Set(runs.map((r) => r.id)).size === runs.length,
      "provider-coverage-unavailable",
    );
    for (const candidate of runs) {
      active();
      examinedRuns++;
      try {
        requireValid(
          candidate.head_branch === "main" &&
            candidate.status === "completed" &&
            candidate.conclusion === "success" &&
            Number.isSafeInteger(candidate.id) &&
            candidate.id > 0,
          "unsuccessful-main-producer",
        );
        const run = request(`${route}/actions/runs/${candidate.id}`);
        requireValid(
          run.id === candidate.id &&
            sha.test(run.head_sha) &&
            Number.isSafeInteger(run.run_attempt) &&
            run.run_attempt > 0 &&
            run.repository?.id === repository.id &&
            run.head_repository?.id === repository.id &&
            run.head_branch === "main" &&
            run.event === "workflow_dispatch" &&
            run.path === workflowPath &&
            run.workflow_id === workflow.id &&
            run.status === "completed" &&
            run.conclusion === "success",
          "provider-identity-unavailable",
        );
        const jobs = collection(
          `${route}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
          "jobs",
        );
        const audits = jobs.filter((j) => j.name === "audit");
        requireValid(
          audits.length === 1 && audits[0].conclusion === "success",
          "unsuccessful-audit-job",
        );
        const artifacts = collection(
          `${route}/actions/runs/${run.id}/artifacts`,
          "artifacts",
        ).filter((a) => a.name === `audit-evidence-${run.id}-${run.run_attempt}`);
        requireValid(
          artifacts.length === 1 && Number.isSafeInteger(artifacts[0].id) && artifacts[0].id > 0,
          "artifact-unavailable",
        );
        const artifact = request(`${route}/actions/artifacts/${artifacts[0].id}`);
        requireValid(
          artifact.id === artifacts[0].id &&
            artifact.expired === false &&
            artifact.size_in_bytes > 0 &&
            artifact.size_in_bytes <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
            /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
          "invalid-artifact",
        );
        const ancestry = request(`${route}/compare/${run.head_sha}...${mainSha}`);
        requireValid(
          ancestry.merge_base_commit?.sha === run.head_sha &&
            ["ahead", "identical"].includes(ancestry.status),
          "not-merged-main",
        );
        const content = request(`${route}/contents/${workflowPath}?ref=${run.head_sha}`);
        requireValid(
          content.encoding === "base64" && content.type === "file" && content.size <= 131072,
          "changed-contract",
        );
        const workflowDigest = hash(Buffer.from(content.content, "base64"));
        requireValid(workflowDigest === localDigest, "changed-contract");
        if (downloads >= 3) break;
        downloads++;
        const bytes = request(`${route}/actions/artifacts/${artifact.id}/zip`, true);
        requireValid(
          Buffer.isBuffer(bytes) &&
            bytes.length <= AUDIT_BUNDLE_LIMITS.compressedBytes &&
            hash(bytes) === artifact.digest.slice(7),
          "artifact-digest-mismatch",
        );
        const files = parseAuditArchive(bytes, { deadline, clock });
        const finalRun = request(`${route}/actions/runs/${run.id}`),
          finalMain = request(`${route}/git/ref/heads/main`).object?.sha;
        requireValid(
          finalRun.head_sha === run.head_sha &&
            finalRun.run_attempt === run.run_attempt &&
            finalRun.status === "completed" &&
            finalRun.conclusion === "success" &&
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
        misses.push({ run: candidate.id, reason: error.code ?? "invalid-evidence" });
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
      ].includes(error.code)
        ? error.code
        : "provider-unavailable",
      imported,
      examinedRuns,
      downloads,
      misses,
    };
  }
}
