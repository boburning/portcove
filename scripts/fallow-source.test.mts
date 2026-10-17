import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fallowSource } from "./fallow-source.mts";

void test("candidate fingerprint detects same-HEAD dirty edits, untracked inputs, renames and deletions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fallow-source-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-b", "main");
    writeFileSync(path.join(root, "helper.mjs"), "export const value=1;");
    git("add", ".");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "base",
    );
    const clean = fallowSource(root, "main");
    const allInputs = fallowSource(root, undefined, { includeAll: true });
    writeFileSync(path.join(root, "native.rs"), "fn main() {}\n");
    const nativeInputs = fallowSource(root, undefined, { includeAll: true });
    assert.notEqual(allInputs.source_sha256, nativeInputs.source_sha256);
    writeFileSync(path.join(root, "native.rs"), "fn changed() {}\n");
    assert.notEqual(
      nativeInputs.source_sha256,
      fallowSource(root, undefined, { includeAll: true }).source_sha256,
    );
    const beforeMode = fallowSource(root, undefined, { includeAll: true });
    git("update-index", "--chmod=+x", "helper.mjs");
    assert.notEqual(
      beforeMode.source_sha256,
      fallowSource(root, undefined, { includeAll: true }).source_sha256,
    );
    git("update-index", "--chmod=-x", "helper.mjs");
    rmSync(path.join(root, "native.rs"));

    writeFileSync(path.join(root, "helper.mjs"), "export const value=2;");
    const dirty = fallowSource(root, "main");
    assert.equal(clean.head, dirty.head);
    assert.notEqual(clean.source_sha256, dirty.source_sha256);
    assert.equal(dirty.dirty, true);
    writeFileSync(path.join(root, "new.mts"), "export const value=3;");
    const untracked = fallowSource(root, "main");
    assert.notEqual(dirty.source_sha256, untracked.source_sha256);
    renameSync(path.join(root, "helper.mjs"), path.join(root, "renamed.mts"));
    const renamed = fallowSource(root, "main");
    assert.notEqual(untracked.source_sha256, renamed.source_sha256);
    rmSync(path.join(root, "renamed.mts"));
    assert.notEqual(renamed.source_sha256, fallowSource(root, "main").source_sha256);
    assert.throws(() => fallowSource(root, "missing-ref"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
