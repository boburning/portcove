import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
}

for (const [name, command, args] of [
  ["doctor", process.execPath, ["scripts/dev-doctor.mjs", "--help"]],
  ["local validation", process.execPath, ["scripts/local-validation.mjs", "check", "--help"]],
  ["desktop testing", process.execPath, ["scripts/desktop-test-cli.mjs", "--help"]],
]) {
  test(`${name} help is available without provisioning`, () => {
    const result = run(command, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/u);
  });
}

test(
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

test(
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
