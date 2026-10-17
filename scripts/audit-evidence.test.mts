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
} from "./audit.mts";
import { buildAuditBundle, AUDIT_BUNDLE_LIMITS } from "./audit-evidence.mts";

import { baseline, firstAuditBaseline } from "./fixtures/audit-baseline-fixture.mts";
import { isRecord } from "./runtime-values.mts";

void test("hosted input capture precedes stage execution and retains the actual original plan", () => {
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
    const entry = firstAuditBaseline();
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
        const capture: unknown = JSON.parse(
          readFileSync(path.join(root, "audit-inputs-123-2.json"), "utf8"),
        );
        assert(
          isRecord(capture) && isRecord(capture.payload) && isRecord(capture.payload.stageInputs),
        );
        assert.equal(receiptEnvelope(capture.payload.stageInputs.format).integrity, entry.expected);
        const firstFile = entry.inventory.files[0];
        assert(firstFile);
        firstFile.sha256 = "changed after capture";
        return { status: 0 };
      },
    });
    const capture: unknown = JSON.parse(
      readFileSync(path.join(root, "audit-inputs-123-2.json"), "utf8"),
    );
    assert(isRecord(capture) && isRecord(capture.payload) && isRecord(capture.payload.stageInputs));
    assert.equal(receiptEnvelope(capture.payload.stageInputs.format).integrity, entry.expected);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
void test("reviewed pre-change fingerprints and serialized input semantics are preserved", () => {
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

void test("capture failure does not replace audit execution or its primary failure", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-capture-failure-"));
  try {
    const entry = firstAuditBaseline();
    const plan = planAudit({
      inventory: entry.inventory,
      runtime: entry.runtime,
      stages: AUDIT_STAGES.filter((stage) => ["frontend-static", "rust"].includes(stage.id)),
      fresh: true,
      receiptRoot: path.join(root, "receipts"),
    });
    const calls: string[] = [];
    const result = executeAudit(plan, {
      captureHosted: true,
      captureInputs: () => {
        throw Object.assign(new Error("full disk"), { code: "ENOSPC" });
      },
      execute: (stage) => {
        calls.push(stage.id);
        return { status: stage.id === "frontend-static" ? 7 : 0 };
      },
    });
    assert.deepEqual(calls, ["frontend-static", "rust"]);
    assert.equal(result.captureAvailable, false);
    assert.equal(result.success, false);
    assert.equal(result.results[0]?.exitCode, 7);
    assert.equal(result.results[1]?.status, "passed");
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
      fingerprintInputs(stage, firstAuditBaseline().inventory, firstAuditBaseline().runtime),
    ]),
  );
  const results: {
    id: string;
    recipe: string;
    status: string;
    fingerprint: string;
    originatingHead: string;
    durationMs: number;
    exitCode?: number;
  }[] = stages.map((s) => ({
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

void test("attempt-bound bundle retains original inputs and receipt identities within fixed limits", () => {
  const f = fixture();
  const bundle = buildAuditBundle(f);
  assert.equal(bundle.manifest.diagnosticOnly, false);
  assert.deepEqual(
    JSON.parse(requiredFile(bundle.files, "inputs.json").toString("utf8")),
    f.capture,
  );
  assert.deepEqual(
    JSON.parse(requiredFile(bundle.files, "receipts/rust.json").toString("utf8")),
    f.receipts.rust,
  );
  assert.ok(bundle.files.size <= AUDIT_BUNDLE_LIMITS.files);
  assert.ok(
    [...bundle.files.values()].reduce((n, b) => n + b.length, 0) <=
      AUDIT_BUNDLE_LIMITS.expandedBytes,
  );
});

void test("failed audit is diagnostic only and never exports failed or stale stage receipts", () => {
  const f = fixture();
  const payload = f.aggregate.payload;
  payload.success = false;
  const rust = payload.stages.find((stage) => stage.id === "rust");
  assert(rust);
  rust.status = "failed";
  rust.exitCode = 1;
  f.aggregate = receiptEnvelope(payload);
  f.binding.exitCode = "1";
  f.binding.receiptIntegrity = f.aggregate.integrity;
  const b = buildAuditBundle(f);
  assert.equal(b.manifest.diagnosticOnly, true);
  assert.equal(b.files.has("receipts/rust.json"), false);
});

void test("wrong attempt, stale capture, incomplete aggregate and substituted inputs fail closed", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
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
      const rustInputs = f.capture.payload.stageInputs.rust;
      assert(rustInputs);
      rustInputs.runtime.rustc = "changed";
      f.capture = receiptEnvelope(f.capture.payload);
    },
    (f) => {
      const rustReceipt = f.receipts.rust;
      assert(rustReceipt);
      f.receipts.rust = receiptEnvelope({
        ...rustReceipt.payload,
        originatingHead: "b".repeat(40),
      });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildAuditBundle(f));
  }
});

void test("expanded input excess is rejected before compression", () => {
  const f = fixture();
  f.capture = structuredClone(f.capture);
  const frontendInputs = f.capture.payload.stageInputs["frontend-static"];
  assert(frontendInputs);
  frontendInputs.runtime.environment.EXTRA = "x".repeat(AUDIT_BUNDLE_LIMITS.expandedBytes);
  f.capture = receiptEnvelope(f.capture.payload);
  const frontendResult = f.aggregate.payload.stages.find((stage) => stage.id === "frontend-static");
  assert(frontendResult);
  frontendResult.fingerprint = receiptEnvelope(frontendInputs).integrity;
  f.aggregate = receiptEnvelope(f.aggregate.payload);
  f.binding.receiptIntegrity = f.aggregate.integrity;
  assert.throws(() => buildAuditBundle(f), /expanded byte limit/);
});

function requiredFile(files: ReadonlyMap<string, Buffer>, name: string) {
  const bytes = files.get(name);
  assert(bytes);
  return bytes;
}

void test("wire identity and timestamp coercion cannot authorize an audit bundle", () => {
  for (const key of ["workflowDigest", "run"] as const) {
    const f = fixture();
    const identity = { ...f.identity, [key]: [f.identity[key]] };
    const binding = { ...f.binding, [key]: identity[key] };
    const capture = receiptEnvelope({ ...f.capture.payload, identity });
    assert.throws(
      () => buildAuditBundle({ ...f, identity, binding, capture }),
      /producer identity/,
    );
  }
  const f = fixture();
  const aggregate = receiptEnvelope({
    ...f.aggregate.payload,
    completedAt: [f.aggregate.payload.completedAt],
  });
  assert.throws(
    () =>
      buildAuditBundle({
        ...f,
        aggregate,
        binding: { ...f.binding, receiptIntegrity: aggregate.integrity },
      }),
    /complete execution report/,
  );
});
