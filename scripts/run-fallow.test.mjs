import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
          return true;
        },
      );
    }
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});
