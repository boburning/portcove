import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUDIT_STAGES,
  executeAudit,
  fingerprintStage,
  fingerprintInputs,
  planAudit,
  receiptEnvelope,
} from "./audit.mjs";
import { buildAuditBundle, AUDIT_BUNDLE_LIMITS } from "./audit-evidence.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/audit-fingerprint-baseline.json", import.meta.url)),
);

test("hosted input capture precedes stage execution and retains the actual original plan", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-capture-"));
  const environment = {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_TEMP: root,
  };
  const original = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, environment);
    const entry = structuredClone(baseline.cases[0]);
    const plan = planAudit({
      inventory: entry.inventory,
      runtime: entry.runtime,
      stages: [entry.stage],
      fresh: true,
      receiptRoot: path.join(root, "receipts"),
    });
    executeAudit(plan, {
      captureHosted: true,
      execute: () => {
        const capture = JSON.parse(
          readFileSync(path.join(root, "audit-inputs-123-2.json"), "utf8"),
        );
        assert.equal(receiptEnvelope(capture.payload.stageInputs.format).integrity, entry.expected);
        entry.inventory.files[0].sha256 = "changed after capture";
        return { status: 0 };
      },
    });
    const capture = JSON.parse(readFileSync(path.join(root, "audit-inputs-123-2.json"), "utf8"));
    assert.equal(receiptEnvelope(capture.payload.stageInputs.format).integrity, entry.expected);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("reviewed pre-change fingerprints and serialized input semantics are preserved", () => {
  for (const entry of baseline.cases) {
    assert.equal(
      fingerprintStage(entry.stage, entry.inventory, entry.runtime),
      entry.expected,
      entry.label,
    );
    assert.equal(
      receiptEnvelope(fingerprintInputs(entry.stage, entry.inventory, entry.runtime)).integrity,
      entry.expected,
      entry.label,
    );
  }
});

test("capture failure does not replace audit execution or its primary failure", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-capture-failure-"));
  try {
    const entry = structuredClone(baseline.cases[0]);
    const plan = planAudit({
      inventory: entry.inventory,
      runtime: entry.runtime,
      stages: AUDIT_STAGES.slice(0, 2),
      fresh: true,
      receiptRoot: path.join(root, "receipts"),
    });
    const calls = [];
    const result = executeAudit(plan, {
      captureHosted: true,
      captureInputs: () => {
        throw Object.assign(new Error("full disk"), { code: "ENOSPC" });
      },
      execute: (stage) => {
        calls.push(stage.id);
        return { status: stage.id === "format" ? 7 : 0 };
      },
    });
    assert.deepEqual(calls, ["format", "rust"]);
    assert.equal(result.captureAvailable, false);
    assert.equal(result.success, false);
    assert.equal(result.results[0].exitCode, 7);
    assert.equal(result.results[1].status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const source = "a".repeat(40);
  const identity = {
    repository: "boburning/portcove",
    source,
    workflowSha: source,
    workflowRef: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/main",
    workflowDigest: "c".repeat(64),
    run: "123",
    attempt: "2",
  };
  const startedMs = Date.now() - 10_000;
  const completedMs = Date.now() - 1000;
  const stages = AUDIT_STAGES.filter((s) => !s.platforms || s.platforms.includes("linux"));
  const stageInputs = Object.fromEntries(
    stages.map((stage) => [
      stage.id,
      fingerprintInputs(stage, baseline.cases[0].inventory, baseline.cases[0].runtime),
    ]),
  );
  const results = stages.map((s) => ({
    id: s.id,
    recipe: s.recipe,
    status: "passed",
    fingerprint: receiptEnvelope(stageInputs[s.id]).integrity,
    originatingHead: source,
    durationMs: 10,
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
      .map((stage) => [
        stage.id,
        receiptEnvelope({
          format: 1,
          kind: "successful-stage",
          success: true,
          stageId: stage.id,
          recipe: stage.recipe,
          fingerprint: receiptEnvelope(stageInputs[stage.id]).integrity,
          originatingHead: source,
          durationMs: 10,
          completedAt: new Date(completedMs - 2).toISOString(),
        }),
      ]),
  );
  return { identity, binding, capture, aggregate, receipts };
}

test("attempt-bound bundle retains original inputs and receipt identities within fixed limits", () => {
  const f = fixture();
  const bundle = buildAuditBundle(f);
  assert.equal(bundle.manifest.diagnosticOnly, false);
  assert.deepEqual(JSON.parse(bundle.files.get("inputs.json")), f.capture);
  assert.deepEqual(JSON.parse(bundle.files.get("receipts/rust.json")), f.receipts.rust);
  assert.ok(bundle.files.size <= AUDIT_BUNDLE_LIMITS.files);
  assert.ok(
    [...bundle.files.values()].reduce((n, b) => n + b.length, 0) <=
      AUDIT_BUNDLE_LIMITS.expandedBytes,
  );
});

test("failed audit is diagnostic only and never exports failed or stale stage receipts", () => {
  const f = fixture();
  const payload = f.aggregate.payload;
  payload.success = false;
  payload.stages[1].status = "failed";
  payload.stages[1].exitCode = 1;
  f.aggregate = receiptEnvelope(payload);
  f.binding.exitCode = "1";
  f.binding.receiptIntegrity = f.aggregate.integrity;
  const b = buildAuditBundle(f);
  assert.equal(b.manifest.diagnosticOnly, true);
  assert.equal(b.files.has("receipts/rust.json"), false);
});

test("wrong attempt, stale capture, incomplete aggregate and substituted inputs fail closed", () => {
  for (const mutate of [
    (f) => {
      f.identity.attempt = "3";
    },
    (f) => {
      f.capture = receiptEnvelope({ ...f.capture.payload, capturedAt: new Date(0).toISOString() });
    },
    (f) => {
      f.aggregate = receiptEnvelope({
        ...f.aggregate.payload,
        stages: f.aggregate.payload.stages.slice(1),
      });
      f.binding.receiptIntegrity = f.aggregate.integrity;
    },
    (f) => {
      f.capture.payload.stageInputs.rust.runtime.rustc = "changed";
      f.capture = receiptEnvelope(f.capture.payload);
    },
    (f) => {
      f.receipts.rust = receiptEnvelope({
        ...f.receipts.rust.payload,
        originatingHead: "b".repeat(40),
      });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildAuditBundle(f));
  }
});

test("expanded input excess is rejected before compression", () => {
  const f = fixture();
  f.capture = JSON.parse(JSON.stringify(f.capture));
  f.capture.payload.stageInputs.format.runtime.environment.EXTRA = "x".repeat(
    AUDIT_BUNDLE_LIMITS.expandedBytes,
  );
  f.capture = receiptEnvelope(f.capture.payload);
  f.aggregate.payload.stages[0].fingerprint = receiptEnvelope(
    f.capture.payload.stageInputs.format,
  ).integrity;
  f.aggregate = receiptEnvelope(f.aggregate.payload);
  f.binding.receiptIntegrity = f.aggregate.integrity;
  f.receipts.format.payload.fingerprint = f.aggregate.payload.stages[0].fingerprint;
  f.receipts.format = receiptEnvelope(f.receipts.format.payload);
  assert.throws(() => buildAuditBundle(f), /expanded byte limit/);
});
