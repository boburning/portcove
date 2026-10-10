import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatFallowFailure, runFallow } from "./run-fallow.mjs";

test("Fallow child and parse failures retain raw streams with bounded diagnostics", () => {
  const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), "fallow-error-"));
  try {
    for (const [status, stderr] of [
      [2, "x".repeat(15_850)],
      [2, "界".repeat(20_000)],
      [0, "界".repeat(20_000)],
    ]) {
      assert.throws(
        () =>
          runFallow({
            evidenceDirectory,
            spawn: () => ({ status, stdout: "invalid JSON", stderr }),
          }),
        (error) => {
          const displayed = formatFallowFailure(error);
          assert.ok(Buffer.byteLength(displayed) + 1 <= 16 * 1024);
          assert.ok(displayed.includes(error.evidence.stdout));
          assert.ok(displayed.includes(error.evidence.stderr));
          assert.equal(readFileSync(error.evidence.stderr, "utf8"), stderr);
          assert.equal(readFileSync(error.evidence.stdout, "utf8"), "invalid JSON");
          assert.match(displayed, status === 2 ? /exit 2/ : /invalid JSON/);
          assert.equal(error.failure.kind, "unknown");
          return true;
        },
      );
    }
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test("validated Fallow findings and failed evidence retention remain distinct failures", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-verdict-"));
  try {
    const stdout = JSON.stringify({
      check: { total_issues: 1 },
      dupes: { stats: { duplication_percentage: 0 } },
      health: { summary: { severity_critical_count: 0 }, findings: [] },
    });
    const spawn = () => ({ status: 1, stdout, stderr: "original analyzer output" });
    const result = runFallow({ evidenceDirectory: directory, spawn });
    assert.equal(result.exitCode, 1);
    assert.match(result.text, /source\/check failure/);
    assert.match(result.text, /1 dead-code or dependency findings/);
    const blocked = path.join(directory, "not-a-directory");
    writeFileSync(blocked, "preserved");
    assert.throws(
      () => runFallow({ evidenceDirectory: blocked, spawn }),
      (error) => {
        assert.equal(error.failure.kind, "evidence-collection");
        assert.match(error.message, /evidence could not be retained/);
        return true;
      },
    );
    assert.equal(readFileSync(blocked, "utf8"), "preserved");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
