import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderBoundedSummary, summarizeReport } from "./report-summary.mjs";

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
