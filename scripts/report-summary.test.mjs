import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commandFailure,
  describeFailure,
  renderBoundedSummary,
  summarizeReport,
} from "./report-summary.mjs";

test("only structured launch facts classify prerequisites; exits, timeouts and signals stay unknown", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "missing-process-"));
  try {
    const missing = spawnSync(path.join(root, "unavailable-tool"), [], { encoding: "utf8" });
    assert.equal(describeFailure(missing).kind, "missing-prerequisite");
    assert.equal(
      describeFailure({ error: { code: "EACCES", syscall: "spawn tool" } }).kind,
      "executor-provider",
    );
    for (const result of [
      { status: 1 },
      { error: { code: "ETIMEDOUT", syscall: "spawnSync tool" } },
      { signal: "SIGTERM" },
      { error: new Error("ENOENT in unrelated log text") },
    ])
      assert.equal(describeFailure(result).kind, "unknown");
    for (const kind of ["source-check", "external-service", "evidence-collection"])
      assert.equal(describeFailure({ status: 1 }, kind).kind, kind);
    assert.equal(describeFailure({ status: 1 }, "__proto__").kind, "unknown");
    assert.equal(
      describeFailure({
        get error() {
          throw new Error("diagnostic getter");
        },
      }).kind,
      "unknown",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence collection failure remains secondary to the original failed command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "failure-evidence-"));
  try {
    const file = path.join(root, "not-a-directory");
    writeFileSync(file, "preserved");
    const cause = new Error("original scenario");
    const error = commandFailure(
      "original command failed",
      { status: 7, stderr: "original diagnostics" },
      file,
      cause,
    );
    assert.equal(error.cause, cause);
    assert.equal(error.exitCode, 7);
    assert.equal(error.failure.kind, "unknown");
    assert.match(error.message, /unknown\/unclassified: exit 7/);
    assert.match(error.message, /evidence-collection failure \(secondary\)/);
    assert.match(error.message, /original diagnostics/);
    assert.equal(readFileSync(file, "utf8"), "preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic summaries show the first recorded producer per job without guessing unknown order", () => {
  const context = { job: "contracts", run: "12", attempt: "1" };
  const first = {
    phase: "syntax",
    outcome: "failed",
    context,
    recorded_at: "2026-10-10T01:00:00Z",
    failure: { kind: "source-check", observation: "explicit checker findings" },
  };
  const later = {
    phase: "retain",
    outcome: "failed",
    context,
    recorded_at: "2026-10-10T01:00:01Z",
    failure: { kind: "evidence-collection", observation: "EIO" },
  };
  const result = summarizeReport("timings", { records: [later, first] }, "original");
  assert.match(
    result.text,
    /First recorded failing producer contracts\/12\/1 syntax: source\/check failure/,
  );
  assert.ok(result.text.indexOf("failing producer") < result.text.indexOf("retain:"));
  assert.doesNotMatch(result.text, /First recorded failing producer .* retain:/);
  const unknown = summarizeReport(
    "timings",
    { records: [later, { ...first, recorded_at: undefined, failure: { kind: "__proto__" } }] },
    "original",
  );
  assert.match(unknown.text, /Order unavailable/);
  assert.match(unknown.text, /unknown\/unclassified/);
  assert.doesNotMatch(unknown.text, /First recorded/);
  for (const records of [
    [first, { ...later, recorded_at: first.recorded_at }],
    [{ ...later, recorded_at: first.recorded_at }, first],
  ]) {
    const tied = summarizeReport("timings", { records }, "original");
    assert.match(tied.text, /Co-earliest recorded \(order ambiguous\).* syntax:/);
    assert.match(tied.text, /Co-earliest recorded \(order ambiguous\).* retain:/);
    assert.doesNotMatch(tied.text, /First recorded/);
  }
});

test("REST and gh IDs remain visible without claiming complete inventories", () => {
  for (const job of [{ id: 12 }, { databaseId: 12 }]) {
    const result = summarizeReport(
      "ci",
      { jobs: [{ ...job, name: "rust", status: "completed", conclusion: "failure" }] },
      "raw.json",
    );
    assert.match(result.text, /12: rust/);
    assert.match(result.text, /completeness must be verified separately/);
  }
});
test("timing and raw watch snapshots stay bounded and report unknown measurements", () => {
  const report = {
    records: Array.from({ length: 1000 }, () => ({
      phase: "🎮".repeat(500),
      context: { job: "rust", run: "12", attempt: "2" },
    })),
  };
  const summary = summarizeReport("timings", report, "metrics");
  assert.ok(Buffer.byteLength(summary.text) <= 16 * 1024);
  assert.ok(summary.omitted > 0);
  const watch = summarizeReport(
    "watch",
    {
      kind: "delivery-observation",
      head: "a".repeat(40),
      run: 12,
      attempt: 2,
      contexts: [{ context: "rust", outcome: "pending" }],
    },
    "raw.json",
  );
  assert.match(watch.text, /unmeasured/);
  assert.match(watch.text, /rust: pending/);
});

test("oversized Unicode findings retain truthful omission counts within the byte budget", () => {
  const entries = ["small", "🌍".repeat(100_000), "later"];
  const result = renderBoundedSummary("diagnostic", entries, { reference: "raw.json" });
  assert.ok(Buffer.byteLength(result.text) <= 16 * 1024);
  assert.equal(result.omitted, 2);
  assert.match(result.text, /Raw evidence: raw.json/);
  assert.match(result.text, /Findings: 3; shown: 1; omitted: 2/);
});

test("single-line CI JSON remains intact while the CLI emits a bounded summary", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "report-summary-"));
  try {
    const file = path.join(root, "raw.json");
    const bytes = JSON.stringify({
      total_count: 1000,
      jobs: Array.from({ length: 1000 }, (_, id) => ({
        id,
        name: "failure".repeat(100),
        conclusion: "failure",
      })),
    });
    writeFileSync(file, bytes);
    const result = spawnSync(process.execPath, ["scripts/report-summary.mjs", "ci", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024);
    assert.match(result.stdout, /omitted: [1-9]/);
    assert.equal(readFileSync(file, "utf8"), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
