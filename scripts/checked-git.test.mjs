import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheckedGit, runCheckedGitSequence } from "./checked-git.mjs";

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
