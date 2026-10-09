import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUDIT_STAGES, fingerprintInputs, planAudit, receiptEnvelope } from "./audit.mjs";
import { buildAuditBundle } from "./audit-evidence.mjs";
import {
  importAuditReceipts,
  validateAuditProducer,
  discoverAuditReceipts,
  describeAuditReuse,
} from "./audit-reuse.mjs";

function fixture() {
  const baseline = JSON.parse(
    readFileSync(new URL("./fixtures/audit-fingerprint-baseline.json", import.meta.url)),
  );
  const source = "a".repeat(40),
    main = "b".repeat(40),
    workflowBytes = Buffer.from("reviewed workflow fixture"),
    workflowDigest = createHash("sha256").update(workflowBytes).digest("hex");
  const identity = {
    repository: "boburning/portcove",
    source,
    workflowSha: source,
    workflowDigest,
    workflowRef: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/main",
    run: "123",
    attempt: "2",
  };
  const startedMs = Date.now() - 10000,
    completedMs = Date.now() - 1000;
  const stages = AUDIT_STAGES.filter((s) => !s.platforms || s.platforms.includes("linux"));
  const stageInputs = Object.fromEntries(
    stages.map((s) => [
      s.id,
      fingerprintInputs(s, baseline.cases[0].inventory, baseline.cases[0].runtime),
    ]),
  );
  const results = stages.map((s) => ({
    id: s.id,
    recipe: s.recipe,
    status: "passed",
    originatingHead: source,
    durationMs: 10,
    fingerprint: receiptEnvelope(stageInputs[s.id]).integrity,
  }));
  const aggregate = receiptEnvelope({
    format: 1,
    kind: "audit-run",
    head: source,
    profile: "complete",
    success: true,
    completedAt: new Date(completedMs - 1).toISOString(),
    stages: results,
  });
  const binding = {
    ...identity,
    startedMs,
    completedMs,
    exitCode: "0",
    receiptIntegrity: aggregate.integrity,
  };
  const capture = receiptEnvelope({
    format: 1,
    kind: "audit-inputs",
    head: source,
    profile: "complete",
    identity,
    capturedAt: new Date(startedMs + 1).toISOString(),
    stageInputs,
  });
  const receipts = Object.fromEntries(
    stages
      .filter((s) => s.reusable)
      .map((s) => [
        s.id,
        receiptEnvelope({
          format: 1,
          kind: "successful-stage",
          success: true,
          stageId: s.id,
          recipe: s.recipe,
          originatingHead: source,
          durationMs: 10,
          fingerprint: receiptEnvelope(stageInputs[s.id]).integrity,
          completedAt: new Date(completedMs - 2).toISOString(),
        }),
      ]),
  );
  const bundle = buildAuditBundle({ identity, binding, capture, aggregate, receipts });
  const repository = { id: 1, full_name: "boburning/portcove" };
  const run = {
    id: 123,
    run_attempt: 2,
    head_sha: source,
    head_branch: "main",
    repository,
    head_repository: repository,
    workflow_id: 4,
    path: ".github/workflows/deep-quality.yml",
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
  };
  const job = {
    id: 9,
    run_id: 123,
    run_attempt: 2,
    head_sha: source,
    name: "audit",
    status: "completed",
    conclusion: "success",
    started_at: new Date(startedMs - 1000).toISOString(),
    completed_at: new Date(completedMs + 100).toISOString(),
  };
  const artifact = {
    id: 8,
    name: "audit-evidence-123-2",
    size_in_bytes: 100,
    expired: false,
    expires_at: new Date(Date.now() + 100000).toISOString(),
    digest: "sha256:" + "d".repeat(64),
    workflow_run: {
      id: 123,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: "main",
      head_sha: source,
    },
  };
  const proof = {
    repository,
    mainSha: main,
    run,
    job,
    artifact,
    workflowDigest,
    workflowId: 4,
    ancestry: { base_commit: { sha: source }, merge_base_commit: { sha: source }, status: "ahead" },
  };
  const currentPlan = planAudit({
    inventory: baseline.cases[0].inventory,
    runtime: baseline.cases[0].runtime,
    fresh: false,
    receiptRoot: "unused",
  });
  return { bundle, proof, currentPlan, source, workflowBytes };
}

test("successful main producer imports exact original receipts with retained inputs and provenance", () => {
  const f = fixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-import-"));
  try {
    f.currentPlan.receiptRoot = root;
    const result = importAuditReceipts(f.bundle.files, f.proof, f.currentPlan, {
      workflowDigest: f.proof.workflowDigest,
    });
    assert.equal(result.imported.length, 9);
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          root,
          "stages",
          "rust",
          `${f.currentPlan.stages.find((s) => s.id === "rust").fingerprint}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(receipt.payload.originatingHead, f.source);
    assert.equal(receipt.payload.kind, "successful-stage");
    assert.equal(existsSync(path.join(result.provenance, "inputs.json")), true);
    assert.equal(
      importAuditReceipts(f.bundle.files, f.proof, f.currentPlan, {
        workflowDigest: f.proof.workflowDigest,
      }).imported.length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork, unmerged, failed, wrong attempt, expired and changed contract producers refuse before writes", () => {
  for (const mutate of [
    (f) => {
      f.proof.run.head_repository = { id: 2, full_name: "foreign/fork" };
    },
    (f) => {
      f.proof.ancestry.merge_base_commit.sha = "e".repeat(40);
    },
    (f) => {
      f.proof.run.conclusion = "failure";
    },
    (f) => {
      f.proof.job.conclusion = "failure";
    },
    (f) => {
      f.proof.run.run_attempt = 3;
    },
    (f) => {
      f.proof.artifact.expired = true;
    },
    (f) => {
      f.proof.workflowDigest = "f".repeat(64);
    },
    (f) => {
      f.proof.artifact.workflow_run.head_sha = "e".repeat(40);
    },
  ]) {
    const f = fixture();
    const expectedDigest = f.proof.workflowDigest;
    mutate(f);
    assert.throws(() =>
      validateAuditProducer(f.bundle.files, f.proof, { workflowDigest: expectedDigest }),
    );
  }
});

test("changed production inputs cause a named fingerprint miss and never import a receipt", () => {
  const f = fixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-miss-"));
  try {
    f.currentPlan.receiptRoot = root;
    f.currentPlan.runtime.node = "changed";
    const r = importAuditReceipts(f.bundle.files, f.proof, f.currentPlan, {
      workflowDigest: f.proof.workflowDigest,
    });
    assert.equal(r.imported.length, 0);
    assert.ok(r.misses.every((m) => m.reason === "fingerprint-mismatch"));
    assert.equal(existsSync(path.join(root, "stages")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered files and partial bundle coverage are rejected", () => {
  for (const mutate of [
    (f) => f.bundle.files.set("inputs.json", Buffer.from("{}")),
    (f) => f.bundle.files.delete("receipts/rust.json"),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      validateAuditProducer(f.bundle.files, f.proof, { workflowDigest: f.proof.workflowDigest }),
    );
  }
});

test("unavailable discovery and budget exhaustion are cache misses without dispatch or mutation", () => {
  const f = fixture();
  let calls = 0;
  const result = discoverAuditReceipts(f.currentPlan, {
    workflowDigest: f.proof.workflowDigest,
    request: () => {
      calls++;
      throw Error("inert unavailable");
    },
  });
  assert.equal(result.status, "cache-miss");
  assert.equal(result.reason, "provider-unavailable");
  assert.equal(calls, 1);
  let now = 0;
  const expired = discoverAuditReceipts(f.currentPlan, {
    clock: () => {
      now += 60001;
      return now;
    },
    request: () => {
      throw Error("must not dispatch");
    },
  });
  assert.equal(expired.status, "cache-miss");
  assert.equal(expired.reason, "collection-deadline");
});

test("reuse diagnostics name fingerprint misses within the shared output byte bound", () => {
  const text = describeAuditReuse({
    status: "cache-miss",
    reason: "no-compatible-main-evidence",
    imported: [],
    examinedRuns: 20,
    downloads: 3,
    misses: Array.from({ length: 180 }, () => ({ reason: "fingerprint-mismatch" })),
  });
  assert.match(text, /fingerprint-mismatch: 180/);
  assert.ok(Buffer.byteLength(`${text}\n`) <= 16 * 1024);
});

function transportFixture({ count = 1, mutate, invalidDigest = false } = {}) {
  const f = fixture();
  const bytes = createAuditZip([...f.bundle.files]);
  f.proof.artifact.size_in_bytes = bytes.length;
  f.proof.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const calls = [],
    runs = Array.from({ length: count }, (_, i) => ({ ...f.proof.run, id: 123 + i }));
  const route = "repos/boburning/portcove";
  const request = (endpoint, options) => {
    calls.push({ endpoint, ...options });
    let value;
    if (endpoint === route) value = f.proof.repository;
    else if (endpoint.endsWith("/git/ref/heads/main")) value = { object: { sha: f.proof.mainSha } };
    else if (endpoint.endsWith("/actions/workflows/deep-quality.yml"))
      value = { id: 4, path: ".github/workflows/deep-quality.yml" };
    else if (endpoint.includes("/contents/"))
      value = {
        type: "file",
        encoding: "base64",
        size: f.workflowBytes.length,
        content: f.workflowBytes.toString("base64"),
      };
    else if (endpoint.includes("/workflows/deep-quality.yml/runs?"))
      value = { total_count: count, workflow_runs: runs };
    else if (/\/actions\/runs\/\d+$/.test(endpoint))
      value = runs.find((r) => r.id === Number(endpoint.split("/").at(-1)));
    else if (endpoint.includes("/jobs?")) {
      const runId = Number(endpoint.match(/\/runs\/(\d+)/)[1]);
      value = { total_count: 1, jobs: [{ ...f.proof.job, run_id: runId }] };
    } else if (endpoint.includes("/artifacts?")) {
      const runId = Number(endpoint.match(/\/runs\/(\d+)/)[1]);
      value = { total_count: 1, artifacts: [{ id: runId, name: `audit-evidence-${runId}-2` }] };
    } else if (endpoint.endsWith("/zip")) {
      assert.equal(options.binary, true);
      value = invalidDigest ? Buffer.from("digest mismatch") : bytes;
    } else if (/\/actions\/artifacts\/\d+$/.test(endpoint)) {
      const id = Number(endpoint.split("/").at(-1));
      value = {
        ...f.proof.artifact,
        id,
        name: `audit-evidence-${id}-2`,
        workflow_run: { ...f.proof.artifact.workflow_run, id },
      };
    } else if (endpoint.includes("/compare/")) value = f.proof.ancestry;
    else assert.fail(`Unexpected endpoint: ${endpoint}`);
    return (
      mutate?.(
        endpoint,
        Buffer.isBuffer(value) ? Buffer.from(value) : structuredClone(value),
        calls,
      ) ?? value
    );
  };
  return { ...f, bytes, calls, request };
}

test("API discovery imports a real digest-bound ZIP and replanning reuses deterministic stages only", () => {
  const f = transportFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-discovery-"));
  try {
    f.currentPlan.receiptRoot = root;
    const result = discoverAuditReceipts(f.currentPlan, {
      request: f.request,
      workflowDigest: f.proof.workflowDigest,
    });
    assert.equal(result.status, "imported");
    assert.equal(result.imported.length, 9);
    assert.equal(result.downloads, 1);
    const plan = planAudit({
      inventory: f.currentPlan.inventory,
      runtime: f.currentPlan.runtime,
      receiptRoot: root,
    });
    assert.equal(plan.stages.filter((s) => s.action === "reuse").length, 9);
    assert.ok(plan.stages.filter((s) => !s.reusable).every((s) => s.action === "run"));
    const fresh = planAudit({
      inventory: f.currentPlan.inventory,
      runtime: f.currentPlan.runtime,
      receiptRoot: root,
      fresh: true,
    });
    assert.ok(fresh.stages.every((s) => s.action === "run"));
    assert.equal(
      discoverAuditReceipts(fresh, { fresh: true, request: () => assert.fail("fresh discovery") })
        .reason,
      "fresh-required",
    );
    assert.equal(f.calls.filter((c) => c.endpoint.endsWith("/actions/runs/123")).length, 2);
    assert.ok(
      f.calls.every(
        (c) => c.timeoutMs > 0 && c.timeoutMs <= 15000 && !c.endpoint.includes("dispatch"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newest twenty runs and at most three downloads bound failed discovery", () => {
  const f = transportFixture({ count: 20, invalidDigest: true });
  const result = discoverAuditReceipts(f.currentPlan, {
    request: f.request,
    workflowDigest: f.proof.workflowDigest,
  });
  assert.equal(result.status, "cache-miss");
  assert.equal(result.downloads, 3);
  assert.equal(f.calls.filter((c) => c.binary).length, 3);
  assert.ok(result.examinedRuns <= 20);
  assert.ok(result.misses.some((m) => m.reason === "artifact-digest-mismatch"));
  assert.ok(f.calls.some((c) => c.endpoint.endsWith("branch=main&status=completed&per_page=20")));
});

test("truncated collections, changed readback and unsafe ZIP fail without publishing receipts", () => {
  for (const mode of ["jobs", "artifacts", "run", "main", "zip", "window"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "audit-reject-"));
    const f = transportFixture({
      mutate: (endpoint, value, calls) => {
        if (mode === "jobs" && endpoint.includes("/jobs?")) value.total_count = 2;
        if (mode === "artifacts" && endpoint.includes("/artifacts?")) value.total_count = 2;
        if (
          mode === "run" &&
          endpoint.endsWith("/actions/runs/123") &&
          calls.filter((c) => c.endpoint === endpoint).length === 2
        )
          value.run_attempt = 3;
        if (
          mode === "main" &&
          endpoint.endsWith("/git/ref/heads/main") &&
          calls.filter((c) => c.endpoint === endpoint).length === 2
        )
          value.object.sha = "f".repeat(40);
        if (mode === "window" && endpoint.includes("/workflows/deep-quality.yml/runs?"))
          value.total_count = 2;
        return value;
      },
    });
    if (mode === "zip") {
      const bytes = createAuditZip([["../inputs.json", "{}"]]);
      const request = f.request;
      f.request = (endpoint, options) => {
        const value = request(endpoint, options);
        if (endpoint.endsWith("/zip")) return bytes;
        if (/\/actions\/artifacts\/\d+$/.test(endpoint))
          return {
            ...value,
            size_in_bytes: bytes.length,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          };
        return value;
      };
    }
    try {
      f.currentPlan.receiptRoot = root;
      const result = discoverAuditReceipts(f.currentPlan, {
        request: f.request,
        workflowDigest: f.proof.workflowDigest,
      });
      assert.equal(result.status, "cache-miss", mode);
      if (["run", "main"].includes(mode))
        assert.ok(
          result.misses.some((m) => m.reason === "producer-changed"),
          mode,
        );
      if (mode === "zip")
        assert.ok(
          result.misses.some((m) => m.reason === "invalid-evidence"),
          mode,
        );
      assert.equal(existsSync(path.join(root, "stages")), false, mode);
      assert.equal(existsSync(path.join(root, "imports")), false, mode);
      if (["jobs", "artifacts", "window"].includes(mode))
        assert.equal(f.calls.filter((c) => c.binary).length, 0, mode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
