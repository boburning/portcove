import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  symlinkSync,
  unlinkSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";

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
  ["Fallow report validation", process.execPath, ["scripts/check-fallow-report.mts", "--help"]],
  ["repository settings", process.execPath, ["scripts/repository-settings.mts", "--help"]],
  ["quality tool manifest", process.execPath, ["scripts/quality-tools.mts", "--help"]],
  ["catalog signing", process.execPath, ["scripts/sign-catalog.mts", "--help"]],
  ["release metadata", process.execPath, ["scripts/check-release-metadata.mts", "--help"]],
  [
    "PlayStation upstream checks",
    process.execPath,
    ["scripts/check-retcomm-upstreams.mts", "--help"],
  ],
  ["qualification report", process.execPath, ["scripts/qualification-report.mts", "--help"]],
  ["pull request delivery", process.execPath, ["scripts/pr-delivery.mts", "--help"]],
  ["handoff evidence", process.execPath, ["scripts/handoff-evidence.mts", "--help"]],
  ["optional container browser", process.execPath, ["scripts/container-browser.mts", "--help"]],
] satisfies [string, string, string[]][]) {
  void test(`${name} help is available without provisioning`, () => {
    const result = run(command, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/iu);
  });
}

void test(
  "Windows bootstrap help exits before cache setup",
  { skip: process.platform !== "win32" },
  () => {
    for (const flag of ["-Help", "--help"]) {
      const result = run("pwsh", [
        "-NoProfile",
        "-File",
        path.join(root, "scripts", "bootstrap-quality-tools.ps1"),
        flag,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/u);
    }
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
    assert.match(result.stdout, /Usage:/iu);
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

void test("release tool help works before inputs, dependencies, network, or output exist", (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "portcove-release-help-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  mkdirSync(path.join(fixtureRoot, "scripts"));
  function copyTool(name: string) {
    const target = path.join(fixtureRoot, "scripts", name);
    copyFileSync(new URL(`./${name}`, import.meta.url), target);
    return target;
  }
  for (const name of ["runtime-values.mts", "brand-vector-contract.mts"]) copyTool(name);
  const aliasRoot = fixtureRoot + "-alias";
  symlinkSync(fixtureRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  t.after(() => unlinkSync(aliasRoot));
  const preload = path.join(fixtureRoot, "deny-network.mjs");
  writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
  for (const name of [
    "check-release-metadata.mts",
    "check-retcomm-upstreams.mts",
    "qualification-report.mts",
  ]) {
    copyTool(name);
    for (const invokedRoot of [fixtureRoot, aliasRoot]) {
      const script = path.join(invokedRoot, "scripts", name);
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, script, "--help"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
          env: {
            ...process.env,
            PATH: "",
            RETCOMM_CATALOG_DIR: path.join(fixtureRoot, "missing-upstream"),
          },
        },
      );
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/u);
      assert.match(result.stdout, /Example:/u);
      assert.match(result.stdout, /--help/u);
      assert.equal(result.stderr, "");
    }
  }
  assert.deepEqual(readdirSync(fixtureRoot).sort(), ["deny-network.mjs", "scripts"]);
});
