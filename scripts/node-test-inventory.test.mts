import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkStagedNodeTestInventory, requireNodeTestInventory } from "./node-test-inventory.mts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-node-index-é-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q");
  git("config", "user.name", "Inventory fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", path.join(root, "disabled-hooks"));
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(root, "scripts"));
  for (const file of [".github/workflows/ci.yml", "justfile"])
    writeFileSync(path.join(root, file), "scripts/first.test.mts\n");
  writeFileSync(path.join(root, "scripts/run-windows-qualification.ps1"), "");
  writeFileSync(path.join(root, "scripts/first.test.mts"), "// owned test\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  return { root, git };
}

void test("the shared inventory check retains required and local coverage independently", () => {
  assert.throws(() => requireNodeTestInventory([], "", ""), /nonempty/);
  assert.throws(
    () => requireNodeTestInventory(["scripts/one.test.mts"], "", "scripts/one.test.mts"),
    /required CI/,
  );
  assert.throws(
    () => requireNodeTestInventory(["scripts/one.test.mts"], "scripts/one.test.mts", ""),
    /local quality/,
  );
  requireNodeTestInventory(
    ["scripts/one.test.mts"],
    "scripts/one.test.mts",
    "scripts/one.test.mts",
  );
});

void test("unrelated staged changes require no inventories or checkout mutation", () => {
  const { root, git } = fixture();
  writeFileSync(path.join(root, "note.txt"), "unrelated\n");
  git("add", "note.txt");
  const before = git("status", "--porcelain");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: false, files: 0 });
  assert.equal(git("status", "--porcelain"), before);
});

void test("unstaged registrations cannot hide an incomplete indexed test addition", () => {
  const { root, git } = fixture();
  writeFileSync(path.join(root, "scripts/new.test.mts"), "// new test\n");
  git("add", "scripts/new.test.mts");
  for (const file of [".github/workflows/ci.yml", "justfile"])
    writeFileSync(path.join(root, file), "scripts/first.test.mts scripts/new.test.mts\n");
  const before = git("diff");
  assert.throws(
    () => checkStagedNodeTestInventory(root),
    /new.test.mts is absent from required CI/,
  );
  assert.equal(git("diff"), before);
  git("add", ".github/workflows/ci.yml");
  assert.throws(() => checkStagedNodeTestInventory(root), /absent from local quality/);
  git("add", "justfile");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 2 });
  assert.equal(readFileSync(path.join(root, "scripts/new.test.mts"), "utf8"), "// new test\n");
});

void test("renamed tests and inventory-only removals are checked against the index", () => {
  const { root, git } = fixture();
  git("mv", "scripts/first.test.mts", "scripts/renamed.test.mts");
  assert.throws(() => checkStagedNodeTestInventory(root), /renamed.test.mts is absent/);
  for (const file of [".github/workflows/ci.yml", "justfile"])
    writeFileSync(path.join(root, file), "scripts/renamed.test.mts\n");
  git("add", ".");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 1 });
  git("commit", "-qm", "rename");
  writeFileSync(path.join(root, "justfile"), "");
  git("add", "justfile");
  assert.throws(() => checkStagedNodeTestInventory(root), /local quality/);
});
