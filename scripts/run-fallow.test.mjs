import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFallow } from "./run-fallow.mjs";

test("Fallow child and parse failures retain raw streams with bounded diagnostics", () => {
  const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), "fallow-error-"));
  try {
    for (const status of [2, 0]) {
      const stderr = "界".repeat(20_000);
      assert.throws(
        () =>
          runFallow({
            evidenceDirectory,
            spawn: () => ({ status, stdout: "invalid JSON", stderr }),
          }),
        (error) => {
          assert.ok(Buffer.byteLength(error.message) <= 16 * 1024);
          assert.equal(readFileSync(error.evidence.stderr, "utf8"), stderr);
          assert.equal(readFileSync(error.evidence.stdout, "utf8"), "invalid JSON");
          assert.match(error.message, status === 2 ? /exit 2/ : /invalid JSON/);
          return true;
        },
      );
    }
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});
