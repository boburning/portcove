import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheckedGit, runCheckedGitSequence } from "./checked-git.mjs";

test("Unicode Git failures bound the complete diagnostic and retain raw stderr", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "git-error-"));
  const stderr = "界".repeat(20_000);
  try {
    assert.throws(
      () =>
        runCheckedGit(["missing"], {
          cwd,
          spawn: () => ({ status: 2, stderr }),
        }),
      (error) => {
        assert.ok(Buffer.byteLength(error.message) <= 16 * 1024);
        assert.equal(error.exitCode, 2);
        assert.equal(readFileSync(error.evidence.stderr, "utf8"), stderr);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unavailable evidence storage preserves the primary Git failure", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "git-evidence-"));
  try {
    writeFileSync(path.join(cwd, "work"), "owned blocking fixture");
    const cause = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    assert.throws(
      () =>
        runCheckedGit(["missing"], {
          cwd,
          spawn: () => ({ status: null, error: cause, stderr: "primary diagnostic" }),
        }),
      (error) => {
        assert.equal(error.cause, cause);
        assert.equal(error.code, "ENOENT");
        assert.match(error.message, /primary diagnostic/);
        assert.match(error.evidence.failure, /retention failed/);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failed revision lookup prevents the following Git mutation", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "checked-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd }).status, 0);
    assert.throws(
      () =>
        runCheckedGitSequence(
          [
            ["rev-parse", "--verify", "missing-revision"],
            ["config", "retro.marker", "changed"],
          ],
          { cwd },
        ),
      /Git command failed/,
    );
    assert.equal(spawnSync("git", ["config", "--get", "retro.marker"], { cwd }).status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exit, timeout and spawn failure stop a dependent sequence", () => {
  for (const first of [
    { status: 2, stderr: "failed" },
    { status: null, error: { code: "ETIMEDOUT" } },
    { status: null, error: { code: "ENOENT" } },
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        runCheckedGitSequence([["first"], ["mutate"]], {
          spawn: () => {
            calls++;
            return first;
          },
        }),
      /Git command failed/,
    );
    assert.equal(calls, 1);
  }
});

test("tree expressions and values with spaces reach Git literally", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "git space "));
  try {
    runCheckedGit(["init", "--quiet"], { cwd });
    runCheckedGit(["config", "retro.literal", "HEAD^{tree} $(literal) value with spaces"], { cwd });
    assert.equal(
      runCheckedGit(["config", "--get", "retro.literal"], { cwd }).trim(),
      "HEAD^{tree} $(literal) value with spaces",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
