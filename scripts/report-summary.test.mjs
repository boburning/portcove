import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderBoundedSummary } from "./report-summary.mjs";

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
