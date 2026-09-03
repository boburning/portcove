import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  childEnvironment, isWindowsSystemDrivePath, minimumFreeGiB, parseArguments,
  preflight, resolvePhysicalPath, spawnCommand, validateCleanTarget, windowsSystemDriveViolations,
} from "./dev-storage.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(t) {
  const scratch = path.join(projectRoot, "work/temp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "storage-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), scratch);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function workspace(t) {
  const root = fixture(t);
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(new URL("./dev-storage.mjs", import.meta.url), path.join(root, "scripts/dev-storage.mjs"));
  writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "storage-fixture"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n');
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/lib.rs"), "");
  return root;
}

function environment(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(PORTCOVE_|CARGO_TARGET_DIR$|pnpm_config_store_dir$)/i.test(key)));
  return { ...env, ...overrides };
}

function cli(root, args, overrides = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts/dev-storage.mjs"), ...args], {
    cwd: root, env: environment(overrides), encoding: "utf8", windowsHide: true,
  });
}

test("recognizes only the configured Windows system drive", () => {
  assert.equal(isWindowsSystemDrivePath("C:\\work\\portcove", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("c:/work/portcove/target", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("\\\\?\\C:\\work\\target", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("E:\\Portcove-Development", "C:"), false);
  assert.equal(isWindowsSystemDrivePath("/home/runner/work/portcove", "C:"), false);
});

test("resolves missing descendants through junctions and rejects files and dangling links", t => {
  const root = fixture(t);
  const destination = path.join(root, "physical");
  const link = path.join(root, "alias");
  mkdirSync(destination);
  symlinkSync(destination, link, "junction");
  assert.equal(resolvePhysicalPath(path.join(link, "not/created")), path.join(destination, "not/created"));
  writeFileSync(path.join(root, "file"), "content");
  assert.throws(() => resolvePhysicalPath(path.join(root, "file/child")), /directory|ENOTDIR/);
  symlinkSync(path.join(root, "missing"), path.join(root, "dangling"), "junction");
  assert.throws(() => resolvePhysicalPath(path.join(root, "dangling/child")), /ENOENT/);
});

test("Windows preflight rejects a system-drive junction even when descendants are missing", { skip: process.platform !== "win32" }, t => {
  const root = fixture(t);
  const link = path.join(root, "redirected");
  symlinkSync(`${process.env.SystemDrive || "C:"}\\`, link, "junction");
  assert.throws(() => preflight({ target_directory: path.join(link, "missing-portcove-target") }, 1), /system drive/);
});

test("clean accepts only the default target and refuses linked ancestors", t => {
  const root = fixture(t);
  const target = path.join(root, "target");
  assert.equal(validateCleanTarget({ workspace: root, target_directory: target }), target);
  for (const candidate of [root, path.dirname(root), path.join(root, "src"), path.join(root, "custom/target")]) {
    assert.throws(() => validateCleanTarget({ workspace: root, target_directory: candidate }), /except this workspace/);
  }
  const real = path.join(root, "real");
  mkdirSync(real);
  symlinkSync(real, target, "junction");
  assert.throws(() => validateCleanTarget({ workspace: root, target_directory: target }), /symlink, junction/);
  const alias = path.join(root, "alias");
  symlinkSync(real, alias, "junction");
  assert.throws(() => validateCleanTarget({ workspace: alias, target_directory: path.join(alias, "target") }), /symlink, junction/);
});

test("rejects malformed invocations and invalid free-space margins", () => {
  for (const args of [["run"], ["typo"], ["preflight", "--", "cargo"], ["preflight", "--minimum-free-gib"], ["run", "--json", "--", "cargo"]]) {
    assert.throws(() => parseArguments(args));
  }
  for (const value of ["", "0", "-1", "NaN", "Infinity"]) assert.throws(() => minimumFreeGiB(value), /positive/);
  assert.equal(minimumFreeGiB("20.5"), 20.5);
});

test("preflight is read-only and machine-readable, and low space prevents child execution", t => {
  const root = workspace(t);
  const result = cli(root, ["preflight", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workspace, root);
  assert.equal(report.target_directory, path.join(root, "target"));
  assert.equal(existsSync(path.join(root, "work")), false);
  assert.equal(existsSync(path.join(root, "outputs")), false);
  const blocked = cli(root, ["run", "--minimum-free-gib", "1000000000", "--", process.execPath, "-e", "require('fs').writeFileSync('ran', '')"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /needs at least/);
  assert.equal(existsSync(path.join(root, "ran")), false);
});

test("run creates configured scratch directories, exports matching paths, and preserves exit status", t => {
  const root = workspace(t);
  const overrides = {
    CARGO_TARGET_DIR: path.join(root, "build target"),
    PORTCOVE_TEMP_DIR: "scratch temp", PORTCOVE_OUTPUT_DIR: "packages", PORTCOVE_PNPM_STORE_DIR: "package store",
    TMPDIR: path.join(root, "wrong"), pnpm_config_store_dir: path.join(root, "wrong-store"),
  };
  const probe = `const fs = require('fs'); const os = require('os'); const {CARGO_TARGET_DIR, TMPDIR, pnpm_config_store_dir} = process.env; fs.writeFileSync('probe.json', JSON.stringify({env: {CARGO_TARGET_DIR, TMPDIR, pnpm_config_store_dir}, temp: os.tmpdir(), exists: fs.existsSync(os.tmpdir())})); process.exit(17);`;
  const result = cli(root, ["run", "--", process.execPath, "-e", probe], overrides);
  assert.equal(result.status, 17, result.stderr);
  const report = JSON.parse(readFileSync(path.join(root, "probe.json"), "utf8"));
  assert.equal(report.exists, true);
  assert.equal(report.temp, path.join(root, "scratch temp"));
  assert.equal(report.env.CARGO_TARGET_DIR, path.join(root, "build target"));
  assert.equal(report.env.TMPDIR, report.temp);
  assert.equal(report.env.pnpm_config_store_dir, path.join(root, "package store"));
  assert.equal(existsSync(path.join(root, "packages")), true);
});

test("pnpm uses the configured store instead of the workspace YAML default", t => {
  const root = workspace(t);
  mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
  writeFileSync(path.join(root, "apps/desktop/pnpm-workspace.yaml"), "storeDir: ../../work/pnpm-store\n");
  const store = path.join(root, "custom store");
  const result = cli(root, ["run", "--", "pnpm", "--dir", "apps/desktop", "store", "path"], {
    PORTCOVE_PNPM_STORE_DIR: store, PNPM_CONFIG_STORE_DIR: path.join(root, "wrong-store"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), path.join(store, "v11"));
});

test("direct just recipes initialize a fresh checkout and preserve storage overrides", t => {
  const root = workspace(t);
  copyFileSync(new URL("../justfile", import.meta.url), path.join(root, "justfile"));
  mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
  writeFileSync(path.join(root, "apps/desktop/package.json"), JSON.stringify({ name: "storage-probe", scripts: { build: "node ../../probe.mjs" } }));
  writeFileSync(path.join(root, "probe.mjs"), "import fs from 'node:fs'; import os from 'node:os'; if (!fs.existsSync(os.tmpdir())) process.exit(3); fs.writeFileSync('../../result.json', JSON.stringify({temp: os.tmpdir(), store: process.env.pnpm_config_store_dir}));");
  const result = spawnCommand("just", ["ui-build"], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: environment({ PORTCOVE_TEMP_DIR: "custom/temp", PORTCOVE_PNPM_STORE_DIR: "custom/store" }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "result.json"), "utf8")), {
    temp: path.join(root, "custom/temp"), store: path.join(root, "custom/store"),
  });
});

test("Windows shims preserve spaced arguments and exit status and reject shell injection", { skip: process.platform !== "win32" }, t => {
  const root = fixture(t);
  const shim = path.join(root, "test shim.cmd");
  writeFileSync(shim, '@echo off\r\necho [%~1] [%~2]\r\nexit /b 23\r\n');
  const options = { cwd: root, encoding: "utf8", windowsHide: true };
  const result = spawnCommand(shim, ["has spaces", ""], options);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout.trim(), "[has spaces] []");
  for (const token of ['bad"quote', "bad&command", "%TEMP%", "!TEMP!", "line\nbreak"]) {
    assert.throws(() => spawnCommand(shim, [token], options), /shell metacharacters/);
  }
  assert.throws(() => spawnCommand("missing&command", [], options), /shell metacharacters/);
});

test("child environment covers POSIX and Windows temp consumers", () => {
  const paths = { target_directory: "target", temporary_directory: "scratch", output_root: "packages", pnpm_store: "store" };
  const env = childEnvironment(paths);
  assert.equal(env.TEMP, "scratch");
  assert.equal(env.TMP, "scratch");
  assert.equal(env.TMPDIR, "scratch");
  assert.equal(env.pnpm_config_store_dir, "store");
});

test("clean remains available below the free-space margin and preserves source files", t => {
  const root = workspace(t);
  mkdirSync(path.join(root, "target"));
  writeFileSync(path.join(root, "target/disposable-build"), "test output");
  const result = cli(root, ["clean"], { PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-clean" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, "target")), false);
  assert.equal(existsSync(path.join(root, "src/lib.rs")), true);
  const rejected = cli(root, ["clean"], { CARGO_TARGET_DIR: path.join(root, "src") });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /except this workspace/);
  assert.equal(existsSync(path.join(root, "src/lib.rs")), true);
});

test("local packaging honors custom storage, produces a ZIP without generated data, and restores the environment", { skip: process.platform !== "win32" }, t => {
  const root = workspace(t);
  copyFileSync(new URL("./package-local.ps1", import.meta.url), path.join(root, "scripts/package-local.ps1"));
  writeFileSync(path.join(root, "scripts/check-release-metadata.mjs"), "process.exit(0);\n");
  const target = path.join(root, "custom target");
  mkdirSync(path.join(target, "release/bundle/nsis"), { recursive: true });
  writeFileSync(path.join(target, "release/bundle/nsis/Portcove_0.1.0_x64-setup.exe"), "installer fixture");
  writeFileSync(path.join(target, "release/portcove.exe"), "CLI fixture");
  writeFileSync(path.join(root, "package-test.ps1"), `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
$previousStore = $env:pnpm_config_store_dir
function cargo {
    @{ target = $env:CARGO_TARGET_DIR; temp = $env:TEMP; store = $env:pnpm_config_store_dir } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "build-env.json")
    $global:LASTEXITCODE = 0
}
& (Join-Path $PSScriptRoot "scripts/package-local.ps1") -Version 0.1.0
if ($env:TEMP -ne $previousTemp -or $env:pnpm_config_store_dir -ne $previousStore) { throw "Caller environment was not restored" }
`);
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", path.join(root, "package-test.ps1")], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: environment({ CARGO_TARGET_DIR: target, PORTCOVE_OUTPUT_DIR: "packages", PORTCOVE_TEMP_DIR: "scratch", PORTCOVE_PNPM_STORE_DIR: "package store" }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "build-env.json"), "utf8")), {
    target, temp: path.join(root, "scratch"), store: path.join(root, "package store"),
  });
  const archive = path.join(root, "packages/portcove-0.1.0-source.zip");
  assert.equal(readFileSync(archive).subarray(0, 4).toString("hex"), "504b0304");
  const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8", windowsHide: true });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /src\/lib.rs/);
  assert.doesNotMatch(listing.stdout, /custom target|packages\/|scratch\/|package store/);
  assert.equal(readFileSync(path.join(root, "packages/SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/).length, 3);
});

test("release preflight restores caller storage variables after a failed gate", { skip: process.platform !== "win32" }, t => {
  const root = workspace(t);
  copyFileSync(new URL("./release-preflight.ps1", import.meta.url), path.join(root, "scripts/release-preflight.ps1"));
  for (const name of ["check-release-metadata.mjs", "check-release-metadata.test.mjs"]) {
    writeFileSync(path.join(root, "scripts", name), "process.exit(0);\n");
  }
  mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
  writeFileSync(path.join(root, "release-test.ps1"), `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
function pnpm { $global:LASTEXITCODE = 0 }
function just {
    if ($env:TEMP -ne (Join-Path $PSScriptRoot "scratch")) { throw "Wrong temporary path" }
    if ($env:pnpm_config_store_dir -ne (Join-Path $PSScriptRoot "store")) { throw "Wrong pnpm store" }
    throw "Expected test gate failure"
}
try { & (Join-Path $PSScriptRoot "scripts/release-preflight.ps1"); throw "Gate did not fail" }
catch { if ($_.Exception.Message -ne "Expected test gate failure") { throw } }
if ($env:TEMP -ne $previousTemp) { throw "Caller environment was not restored" }
`);
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", path.join(root, "release-test.ps1")], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: environment({ PORTCOVE_TEMP_DIR: "scratch", PORTCOVE_PNPM_STORE_DIR: "store" }),
  });
  assert.equal(result.status, 0, result.stderr);
});

test("installer qualification resolves relative scratch paths, isolates process temp, and retains failure evidence", { skip: process.platform !== "win32" }, t => {
  const root = workspace(t);
  copyFileSync(new URL("./test-windows-installer.ps1", import.meta.url), path.join(root, "scripts/test-windows-installer.ps1"));
  writeFileSync(path.join(root, "installer.exe"), "fixture");
  writeFileSync(path.join(root, "installer-test.ps1"), `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
function Get-AuthenticodeSignature { @{ Status = "NotSigned" } }
function Start-Process {
    @{ temp = $env:TEMP; tmp = $env:TMP; tmpdir = $env:TMPDIR } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "installer-env.json")
    throw "Expected test installer failure"
}
try { & (Join-Path $PSScriptRoot "scripts/test-windows-installer.ps1") -InstallerPath (Join-Path $PSScriptRoot "installer.exe"); throw "Installer did not fail" }
catch { if ($_.Exception.Message -ne "Expected test installer failure") { throw } }
if ($env:TEMP -ne $previousTemp) { throw "Caller environment was not restored" }
`);
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", path.join(root, "installer-test.ps1")], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true,
    env: environment({ PORTCOVE_TEMP_DIR: "scratch" }),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(root, "installer-env.json"), "utf8"));
  assert.equal(path.dirname(report.temp), path.join(root, "scratch/installer-qualification"));
  assert.equal(report.tmp, report.temp);
  assert.equal(report.tmpdir, report.temp);
  assert.equal(existsSync(report.temp), true);
  assert.match(result.stdout, /evidence was preserved/);
});

test("reports every heavy path that would write to the system drive", () => {
  assert.deepEqual(
    windowsSystemDriveViolations({
      workspace: "E:\\Portcove-Development",
      target_directory: "C:\\temp\\target",
      output_root: "c:/temp/outputs",
      pnpm_store: "E:\\Portcove-Development\\work\\pnpm-store",
    }),
    ["target_directory=C:\\temp\\target", "output_root=c:/temp/outputs"],
  );
});
