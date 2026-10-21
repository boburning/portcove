import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
}

for (const [name, command, args] of [
  ["capability selection", process.execPath, ["scripts/development-capabilities.mts", "--help"]],
  ["doctor", process.execPath, ["scripts/dev-doctor.mts", "--help"]],
  ["development storage", process.execPath, ["scripts/dev-storage.mts", "--help"]],
  ["local validation", process.execPath, ["scripts/local-validation.mts", "check", "--help"]],
  ["audit", process.execPath, ["scripts/audit.mts", "--help"]],
  ["desktop testing", process.execPath, ["scripts/desktop-test-cli.mts", "--help"]],
  ["desktop verification", process.execPath, ["scripts/desktop-verify.mts", "--help"]],
  ["roadmap", process.execPath, ["scripts/roadmap.mts", "--help"]],
  ["pull request delivery", process.execPath, ["scripts/pr-delivery.mts", "--help"]],
  ["handoff evidence", process.execPath, ["scripts/handoff-evidence.mts", "--help"]],
  ["optional container browser", process.execPath, ["scripts/container-browser.mts", "--help"]],
] satisfies [string, string, string[]][]) {
  void test(`${name} help is available without provisioning`, () => {
    const result = run(command, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/u);
  });
}

void test(
  "Windows bootstrap help exits before cache setup",
  { skip: process.platform !== "win32" },
  () => {
    const result = run("pwsh", [
      "-NoProfile",
      "-File",
      path.join(root, "scripts", "bootstrap-quality-tools.ps1"),
      "-Help",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/u);
  },
);

void test(
  "POSIX bootstrap help exits before cache setup",
  { skip: process.platform === "win32" },
  () => {
    const result = run("bash", [
      path.join(root, "scripts", "bootstrap-quality-tools.sh"),
      "--help",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/u);
  },
);

void test("capability selection rejects an unknown profile before any setup", () => {
  const result = run(process.execPath, [
    "scripts/development-capabilities.mts",
    "--profile",
    "unknown",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown development profile/);
});
