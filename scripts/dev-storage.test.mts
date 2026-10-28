import type { TestContext } from "node:test";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  readScratchProfile,
  scratchAllocation,
  scratchCargoTarget,
  verifyScratchProfile,
  validateScratchBacking,
} from "./development-scratch.mts";
import {
  type CompilerRunner,
  prepareRustSupportArtifact,
  rustSupportCompilerIdentity,
} from "./rust-support-cache.mts";

import {
  childEnvironment,
  canonicalCheckoutCommand,
  getPaths,
  nodeSuiteAdmissionEnabled,
  isSideEffectFreeHelpCommand,
  isWindowsSystemDrivePath,
  minimumFreeGiB,
  parseArguments,
  preflight,
  readStoragePolicy,
  resolvePhysicalPath,
  spawnCommand,
  validateCleanTarget,
  validateIncrementalCache,
  windowsSystemDriveViolations,
} from "./dev-storage.mts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

void test("portable contributors keep Node defaults until their own machine explicitly opts in", (t) => {
  const root = fixture(t),
    config = path.join(root, "resources.json");
  assert.equal(nodeSuiteAdmissionEnabled(config), false);
  for (const value of [{}, { slots: 2 }, { nodeSuites: false }]) {
    writeFileSync(config, JSON.stringify(value));
    assert.equal(nodeSuiteAdmissionEnabled(config), false);
  }
  writeFileSync(config, JSON.stringify({ nodeSuites: true }));
  assert.equal(nodeSuiteAdmissionEnabled(config), true);
  writeFileSync(config, JSON.stringify({ nodeSuites: "yes" }));
  assert.throws(() => nodeSuiteAdmissionEnabled(config), /Invalid Node-suite/u);
});

void test("machine scratch allocations are stable and separate by workspace and platform", (t) => {
  const root = fixture(t);
  const profile = { format: 1 as const, identity: randomUUID(), root };
  const first = scratchAllocation(profile, projectRoot);
  assert.deepEqual(scratchAllocation(profile, projectRoot), first);
  assert.notDeepEqual(scratchAllocation(profile, root), first);
  assert.notDeepEqual(
    scratchAllocation(profile, projectRoot, process.platform === "win32" ? "linux" : "win32"),
    first,
  );
  assert.equal(
    scratchCargoTarget(path.join(projectRoot, "target"), projectRoot, first.target, {}),
    first.target,
  );
  assert.equal(
    scratchCargoTarget(path.join(root, "custom"), projectRoot, first.target, {}),
    path.join(root, "custom"),
  );
  assert.equal(
    scratchCargoTarget(path.join(projectRoot, "target"), projectRoot, first.target, {
      CARGO_TARGET_DIR: path.join(projectRoot, "target"),
    }),
    path.join(projectRoot, "target"),
  );
});

void test("machine scratch refuses unknown profiles, foreign markers and missing ext4 mounts", (t) => {
  const root = fixture(t),
    file = path.join(root, "profile.json");
  assert.equal(readScratchProfile(file), undefined);
  writeFileSync(file, "{}");
  assert.throws(() => readScratchProfile(file), /Invalid machine scratch profile/u);
  const profile = {
    format: 1 as const,
    root,
    identity: randomUUID(),
    distribution: "FixtureLinux",
    backingDirectory: root,
    filesystemUuid: randomUUID(),
    windowsNode: "/mnt/z/node.exe",
    backingVhd: "Z:\\fixture\\scratch\\ext4.vhdx",
  };
  writeFileSync(file, JSON.stringify(profile));
  assert.deepEqual(readScratchProfile(file), profile);
  writeFileSync(
    path.join(root, ".portcove-scratch.json"),
    JSON.stringify({ format: 1, identity: randomUUID() }),
  );
  assert.throws(() => verifyScratchProfile(profile), /marker differs/u);
  writeFileSync(path.join(root, ".portcove-scratch.json"), JSON.stringify(profile));
  if (process.platform === "linux")
    assert.throws(() => verifyScratchProfile(profile), /scratch ownership|mount identity/u);
});

void test("machine scratch backing checks reject a moved distro even when its UUID is unchanged", () => {
  const directory = "Z:\\fixture\\scratch",
    vhd = directory + "\\ext4.vhdx";
  assert.deepEqual(validateScratchBacking(directory, vhd, { basePath: directory, vhdPath: vhd }), {
    basePath: directory,
    vhdPath: vhd,
  });
  assert.throws(
    () =>
      validateScratchBacking(directory, vhd, {
        basePath: "E:\\moved-scratch",
        vhdPath: "E:\\moved-scratch\\ext4.vhdx",
      }),
    /backing VHD differs/u,
  );
  assert.throws(
    () =>
      validateScratchBacking(directory, vhd, {
        basePath: directory,
        vhdPath: "C:\\other\\ext4.vhdx",
      }),
    /backing VHD differs/u,
  );
});
function fixtureRecord(text: string) {
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value), "fixture output must be an object");
  return value;
}

void test("only maintained read-only CLI help bypasses storage preparation", () => {
  for (const script of [
    "scripts/local-validation.mts",
    "scripts/audit.mts",
    "scripts/desktop-test-cli.mts",
  ])
    assert.equal(isSideEffectFreeHelpCommand(["node", script, "--help"]), true);
  assert.equal(isSideEffectFreeHelpCommand(["node", "scripts/audit.mts", "--plan"]), false);
  assert.equal(isSideEffectFreeHelpCommand(["cargo", "--help"]), false);
  assert.equal(isSideEffectFreeHelpCommand(["node", "untrusted.mjs", "--help"]), false);
});

void test("storage wrapper resolves canonical pnpm commands from the package authority", () => {
  const { packageManager } = fixtureRecord(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(canonicalCheckoutCommand("corepack", ["pnpm", "--version"]), [
    "corepack",
    [packageManager, "--version"],
  ]);
  assert.deepEqual(canonicalCheckoutCommand("cargo", ["check"]), ["cargo", ["check"]]);
});

void test("storage wrapper keeps the active Node runtime and explicit executable paths", () => {
  for (const command of ["node", "node.exe", "NODE.EXE"])
    assert.deepEqual(canonicalCheckoutCommand(command, ["--version"]), [
      process.execPath,
      ["--version"],
    ]);
  for (const command of [process.execPath, `.${path.sep}node`])
    assert.deepEqual(canonicalCheckoutCommand(command, ["--version"]), [command, ["--version"]]);
});

function fixture(t: TestContext, retain?: () => boolean) {
  const scratch = path.join(projectRoot, "work/temp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "storage-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), scratch);
    if (retain?.()) {
      t.diagnostic(
        `Failed real Cargo smoke fixture retained at ${root}; command evidence: ${path.join(root, "cargo-smoke-evidence.log")}`,
      );
      return;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

void test(
  "CLI smoke binds every executable observation inside its isolated scope",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fixture(t);
    const script = path.join(root, "smoke-arguments.ps1");
    const source = path.join(projectRoot, "scripts/smoke-test-cli-archive.ps1");
    writeFileSync(
      script,
      `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$calls = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.CommandElements[0].Extent.Text -ceq '$executable' }, $true))
if ($calls.Count -ne 4) { throw 'Unexpected smoke executable inventory' }
foreach ($call in $calls) {
    if ($call.CommandElements[1].Extent.Text -cne '--library' -or $call.CommandElements[2].Extent.Text -cne '$library') { throw 'Smoke child lost its owned library argument' }
    $parent = $call.Parent
    while ($null -ne $parent -and $parent -isnot [Management.Automation.Language.ScriptBlockExpressionAst]) { $parent = $parent.Parent }
    if ($null -eq $parent -or $parent.Parent -isnot [Management.Automation.Language.CommandAst] -or $parent.Parent.GetCommandName() -cne 'Invoke-IsolatedCliSmoke') { throw 'Smoke child escaped its isolated environment scope' }
    if ($parent.Parent.Extent.Text -notmatch '-LibraryPath \\$library -PreferencePath \\(Join-Path \\$temporaryDirectory "preferences.json"\\) -Operation') { throw 'Scope paths escaped the private smoke run' }
}
'smoke-arguments-isolated'
`,
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /smoke-arguments-isolated/u);
  },
);

void test("CLI smoke decodes native UTF-8 paths and restores the caller encoding", (t) => {
  const root = fixture(t);
  const script = path.join(root, "smoke-encoding.ps1");
  const emitter = path.join(root, "emit.cjs");
  writeFileSync(emitter, "process.stdout.write(JSON.stringify({root:process.argv[2]}));");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(
    script,
    `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(path.join(projectRoot, "scripts/smoke-test-cli-archive.ps1"))}, [ref]$null, [ref]$null)
$helper = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-IsolatedCliSmoke'}, $false)
if ($null -eq $helper) { throw 'Actual isolated smoke helper missing' }
. ([scriptblock]::Create($helper.Extent.Text))
$node = ${quote(process.execPath)}
$emitter = ${quote(emitter)}
$library = Join-Path $PSScriptRoot ('Library ' + [char]0x03A9 + ' space')
[IO.Directory]::CreateDirectory($library) | Out-Null
$original = [Console]::OutputEncoding
try {
 [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)
 $control = (& $node $emitter $library | Out-String).Trim() | ConvertFrom-Json
 if ($LASTEXITCODE -ne 0 -or $control.root -ceq $library) { throw 'OEM decoding negative control did not reproduce' }
 foreach ($fail in @($false, $true)) {
  $observed = $null
  try {
   Invoke-IsolatedCliSmoke -LibraryPath $library -PreferencePath (Join-Path $PSScriptRoot 'preferences.json') -Operation {
    $data = (& $node $emitter $library | Out-String).Trim() | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $data.root -cne $library -or -not (Test-Path -LiteralPath $data.root)) { throw 'UTF-8 path identity lost' }
    if ($fail) { throw 'intentional-encoding-smoke-failure' }
   }
  } catch { $observed = $_.Exception.Message }
  if ($fail -and $observed -cne 'intentional-encoding-smoke-failure') { throw 'Original failure lost' }
  if (-not $fail -and $null -ne $observed) { throw $observed }
  if ([Console]::OutputEncoding.CodePage -ne 437) { throw 'Caller encoding not restored' }
 }
} finally { [Console]::OutputEncoding = $original }
'native-utf8-paths-and-encoding-restoration-passed'
`,
  );
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-utf8-paths-and-encoding-restoration-passed/u);
});

void test(
  "CLI smoke restores absent empty and conflicting bindings after success and failure",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fixture(t);
    const script = path.join(root, "smoke-environment.ps1");
    const source = path.join(projectRoot, "scripts/smoke-test-cli-archive.ps1");
    writeFileSync(
      script,
      `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$helper = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-IsolatedCliSmoke' }, $false)
if ($null -eq $helper) { throw 'Actual isolated smoke helper missing' }
. ([scriptblock]::Create($helper.Extent.Text))
$ownedLibrary = Join-Path $PSScriptRoot 'Library Ω space'
$ownedPreferences = Join-Path $PSScriptRoot 'preferences.json'
$names = @('PORTCOVE_LIBRARY', 'PORTCOVE_PREFERENCES')
$checks = 0
foreach ($state in @('absent', 'empty', 'conflicting')) {
    foreach ($name in $names) {
        if ($state -eq 'absent') { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        elseif ($state -eq 'empty') { [Environment]::SetEnvironmentVariable($name, '', 'Process') }
        else { [Environment]::SetEnvironmentVariable($name, (Join-Path $PSScriptRoot "caller-$name"), 'Process') }
    }
    $before = @{}
    foreach ($name in $names) { $before[$name] = @{ present = Test-Path -LiteralPath "Env:$name"; value = [Environment]::GetEnvironmentVariable($name, 'Process') } }
    if ($state -eq 'empty' -and @($names | Where-Object { -not $before[$_].present }).Count -ne 0) { throw 'Runtime did not establish the empty-variable case' }
    foreach ($fail in @($false, $true)) {
        $observedFailure = $null
        try {
            Invoke-IsolatedCliSmoke -LibraryPath $ownedLibrary -PreferencePath $ownedPreferences -Operation {
                if ($env:PORTCOVE_LIBRARY -cne $ownedLibrary -or $env:PORTCOVE_PREFERENCES -cne $ownedPreferences) { throw 'Parent bindings not isolated' }
                $child = (& pwsh -NoProfile -NonInteractive -Command '[pscustomobject]@{library=$env:PORTCOVE_LIBRARY;preferences=$env:PORTCOVE_PREFERENCES}|ConvertTo-Json -Compress' | Out-String).Trim()
                if ($LASTEXITCODE -ne 0) { throw 'Child environment observation failed' }
                $child = $child | ConvertFrom-Json
                if ($child.library -cne $ownedLibrary -or $child.preferences -cne $ownedPreferences) { throw 'Child did not inherit isolated bindings' }
                if ($fail) { throw 'intentional-smoke-failure' }
            }
        } catch { $observedFailure = $_.Exception.Message }
        if ($fail -and $observedFailure -cne 'intentional-smoke-failure') { throw 'Original smoke error was masked' }
        if (-not $fail -and $null -ne $observedFailure) { throw $observedFailure }
        foreach ($name in $names) {
            $present = Test-Path -LiteralPath "Env:$name"
            if ($present -ne $before[$name].present -or ($present -and [Environment]::GetEnvironmentVariable($name, 'Process') -cne $before[$name].value)) { throw "Caller binding not restored: $state/$name" }
        }
        $checks++
    }
}
if ($checks -ne 6) { throw 'Incomplete success/failure restoration matrix' }
foreach ($name in $names) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
function Remove-Item {
    [CmdletBinding()]
    param([string]$LiteralPath)
    if ($LiteralPath.StartsWith('Env:')) { throw 'intentional-restoration-failure' }
    Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters
}
$WarningPreference = 'Stop'
$observedFailure = $null
try {
    Invoke-IsolatedCliSmoke -LibraryPath $ownedLibrary -PreferencePath $ownedPreferences -Operation { throw 'original-command-failure' }
} catch { $observedFailure = $_.Exception.Message }
finally {
    $WarningPreference = 'Continue'
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath Function:Remove-Item
    foreach ($name in $names) { Microsoft.PowerShell.Management\\Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
}
if ($observedFailure -cne 'original-command-failure') { throw "Restoration warning masked command failure: $observedFailure" }
'smoke-environment-restored-six-cases'
`,
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        PORTCOVE_LIBRARY: path.join(root, "caller-library"),
        PORTCOVE_PREFERENCES: path.join(root, "caller-preferences.json"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /smoke-environment-restored-six-cases/u);
  },
);

function workspace(t: TestContext, retain?: () => boolean) {
  const root = fixture(t, retain);
  mkdirSync(path.join(root, "scripts"));
  for (const file of ["development-scratch.mts", "node-test-suites.mts"])
    copyFileSync(new URL("./" + file, import.meta.url), path.join(root, "scripts", file));
  copyFileSync(
    new URL("./runtime-values.mts", import.meta.url),
    path.join(root, "scripts/runtime-values.mts"),
  );
  copyFileSync(
    new URL("./dev-storage.mts", import.meta.url),
    path.join(root, "scripts/dev-storage.mts"),
  );
  copyFileSync(
    new URL("./tool-cache.mts", import.meta.url),
    path.join(root, "scripts/tool-cache.mts"),
  );
  for (const name of [
    ".aqua-version",
    "aqua.yaml",
    "aqua-checksums.json",
    ".github/quality-tools.json",
    ".config/tool-bootstrap.json",
    "package.json",
    "apps/desktop/package.json",
  ]) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(projectRoot, name), destination);
  }
  writeFileSync(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "storage-fixture"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n',
  );
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/lib.rs"), "");
  return root;
}

function environment(overrides: NodeJS.ProcessEnv = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(PORTCOVE_|CARGO_TARGET_DIR$|pnpm_config_store_dir$)/i.test(key),
    ),
  );
  return { ...env, ...overrides };
}

function cli(root: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts/dev-storage.mts"), ...args], {
    cwd: root,
    env: environment(overrides),
    encoding: "utf8",
    windowsHide: true,
  });
}

void test("recognizes only the configured Windows system drive", () => {
  assert.equal(isWindowsSystemDrivePath("C:\\work\\portcove", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("c:/work/portcove/target", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("\\\\?\\C:\\work\\target", "C:"), true);
  assert.equal(isWindowsSystemDrivePath("E:\\Portcove-Development", "C:"), false);
  assert.equal(isWindowsSystemDrivePath("/home/runner/work/portcove", "C:"), false);
});

void test("preflight preserves arbitrary storage labels and widens resolved lexical paths", () => {
  const lexical = { docker_disk: ".", custom_cache: "." } as const;
  const result = preflight(lexical, 1, { blockSystemDrive: false });
  assert.deepEqual(Object.keys(result.paths), ["docker_disk", "custom_cache"]);
  assert.ok(path.isAbsolute(result.paths.docker_disk));
  assert.equal(result.paths.custom_cache, result.paths.docker_disk);
  // @ts-expect-error Physical resolution must not promise the original relative-path literal.
  const originalLiteral: typeof lexical.docker_disk = result.paths.docker_disk;
  assert.equal(originalLiteral, result.paths.docker_disk);
});

void test("resolves missing descendants through junctions and rejects files and dangling links", (t) => {
  const root = fixture(t);
  const destination = path.join(root, "physical");
  const link = path.join(root, "alias");
  mkdirSync(destination);
  symlinkSync(destination, link, "junction");
  assert.equal(
    resolvePhysicalPath(path.join(link, "not/created")),
    path.join(destination, "not/created"),
  );
  const file = path.join(root, "file");
  writeFileSync(file, "content");
  for (const candidate of [file, path.join(file, "child")]) {
    assert.throws(
      () => resolvePhysicalPath(candidate),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(candidate), error.message);
        assert.match(error.message, /Choose a (?:readable )?directory/);
        return true;
      },
    );
  }
  assert.equal(readFileSync(file, "utf8"), "content");
  const dangling = path.join(root, "dangling");
  symlinkSync(path.join(root, "missing"), dangling, "junction");
  assert.throws(
    () => resolvePhysicalPath(path.join(dangling, "child")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(dangling), error.message);
      assert.match(error.message, /ENOENT.*repair the unavailable link destination/s);
      return true;
    },
  );
});

void test("an unavailable storage root reports the original path and a safe recovery action", () => {
  const candidate = path.join(path.parse(projectRoot).root, "unavailable-volume", "scratch");
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolvePhysicalPath } from ${JSON.stringify(new URL("./dev-storage.mts", import.meta.url).href)};
    const previous = fs.lstatSync;
    try {
      fs.lstatSync = () => { throw Object.assign(new Error('fixture volume unavailable'), { code: 'ENOENT' }); };
      syncBuiltinESMExports();
      assert.throws(() => resolvePhysicalPath(${JSON.stringify(candidate)}), (error) => {
        assert.ok(error.message.includes(${JSON.stringify(candidate)}));
        assert.match(error.message, /No existing parent directory.*Connect the intended volume/);
        return true;
      });
    } finally { fs.lstatSync = previous; syncBuiltinESMExports(); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

void test(
  "Windows preflight rejects a system-drive junction even when descendants are missing",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fixture(t);
    const link = path.join(root, "redirected");
    symlinkSync(`${process.env.SystemDrive || "C:"}\\`, link, "junction");
    assert.throws(
      () =>
        preflight({ target_directory: path.join(link, "missing-portcove-target") }, 1, {
          blockSystemDrive: true,
        }),
      /system drive/,
    );
  },
);

void test("portable defaults and explicit machine/environment restrictions are distinct", (t) => {
  const configPath = path.join(fixture(t), "policy.json");
  assert.deepEqual(readStoragePolicy({ configPath, environment: {} }), { blockSystemDrive: false });
  assert.deepEqual(
    readStoragePolicy({ configPath, environment: { PORTCOVE_BLOCK_SYSTEM_DRIVE: "1" } }),
    { blockSystemDrive: true },
  );
  writeFileSync(configPath, JSON.stringify({ format: 1, blockSystemDrive: true }));
  assert.equal(
    readStoragePolicy({ configPath, environment: { PORTCOVE_BLOCK_SYSTEM_DRIVE: "0" } })
      .blockSystemDrive,
    true,
  );
  for (const contents of [
    "broken",
    '{"format":2,"blockSystemDrive":true}',
    '{"format":1,"blockSystemDrive":"false"}',
    '{"format":1,"blockSystemDrive":false,"unknown":true}',
  ]) {
    writeFileSync(configPath, contents);
    assert.throws(() => readStoragePolicy({ configPath, environment: {} }), /policy/);
  }
  writeFileSync(configPath, '{"format":1,"blockSystemDrive":false}');
  assert.throws(
    () => readStoragePolicy({ configPath, environment: { PORTCOVE_BLOCK_SYSTEM_DRIVE: "false" } }),
    /must be 0 or 1/,
  );
});

void test("light storage never resolves Cargo; Rust resolves actual metadata and unknown scopes fail", () => {
  let calls = 0;
  const metadataProvider = () => {
    calls += 1;
    return {
      workspace_root: projectRoot,
      target_directory: path.join(projectRoot, "redirected-target"),
    };
  };
  for (const scope of ["frontend", "tooling"]) {
    const paths = getPaths(scope, { metadataProvider });
    assert.equal(paths.target_directory, undefined);
    assert.equal(paths.rust_support_cache, undefined);
    assert.equal(paths.tauri_generated, undefined);
  }
  assert.equal(calls, 0);
  const rust = getPaths("rust", { metadataProvider });
  assert.equal(calls, 1);
  assert.equal(rust.target_directory, path.join(projectRoot, "redirected-target"));
  assert.equal(rust.rust_support_cache, `${rust.target_directory}.portcove-rust-support`);
  assert.equal(rust.frontend_dependencies, undefined);
  assert.equal(rust.pnpm_store, undefined);
  assert.equal(rust.tauri_generated, path.join(projectRoot, "apps/desktop/src-tauri/gen"));
  const complete = getPaths("all", { metadataProvider });
  assert.equal(calls, 2);
  assert.equal(complete.rust_support_cache, `${complete.target_directory}.portcove-rust-support`);
  assert.ok(complete.tauri_generated);
  assert.ok(complete.frontend_dependencies);
  assert.throws(() => getPaths("unknown", { metadataProvider }), /Unknown storage task/);
  assert.throws(
    () =>
      getPaths("rust", {
        metadataProvider: () => ({
          workspace_root: path.dirname(projectRoot),
          target_directory: "target",
        }),
      }),
    /does not match/,
  );
});

void test("Rust support cache admission follows the physical Cargo target exported to preparation", (t) => {
  const root = fixture(t);
  const target = path.join(root, "physical", "target");
  mkdirSync(target, { recursive: true });
  const alias = path.join(root, "redirected-target");
  symlinkSync(target, alias, "junction");
  writeFileSync(`${alias}.portcove-rust-support`, "preserve unrelated alias sibling");
  const configured = getPaths("rust", {
    metadataProvider: () => ({ workspace_root: projectRoot, target_directory: alias }),
  });
  const { paths } = preflight(configured, 1, { blockSystemDrive: false });
  const physicalTarget = resolvePhysicalPath(target);
  assert.equal(paths.target_directory, physicalTarget);
  assert.equal(paths.rust_support_cache, `${physicalTarget}.portcove-rust-support`);
  const env = childEnvironment(paths);
  assert.equal(env.CARGO_TARGET_DIR, physicalTarget);
  const source = path.join(root, "fixture.rs");
  writeFileSync(source, "fixture source");
  const prepared = prepareRustSupportArtifact({
    root,
    product: "storage-path-fixture",
    source,
    output: path.join(root, "fixture-output"),
    rustcArgs: [],
    compiler: { verbose_version: "fixture", sysroot: "fixture", commands: [], environment: [] },
    environment: env,
    runSync: (command, args) => {
      assert.equal(command, "rustc");
      const output = args.at(-1);
      assert.ok(output);
      writeFileSync(output, "fake compiler output for path admission only");
      return { status: 0 };
    },
  });
  assert.equal(prepared.outcome, "built");
  assert.ok(paths.rust_support_cache);
  assert.equal(
    readFileSync(
      path.join(
        paths.rust_support_cache,
        "v1",
        "storage-path-fixture",
        prepared.fingerprint,
        "artifact",
      ),
      "utf8",
    ),
    "fake compiler output for path admission only",
  );
  assert.equal(
    readFileSync(`${alias}.portcove-rust-support`, "utf8"),
    "preserve unrelated alias sibling",
  );

  const blockedTarget = path.join(root, "another-target");
  const blockedCache = `${blockedTarget}.portcove-rust-support`;
  writeFileSync(blockedCache, "preserve non-directory cache path");
  assert.throws(
    () =>
      preflight({ target_directory: blockedTarget, rust_support_cache: blockedCache }, 20, {
        blockSystemDrive: false,
      }),
    /Storage path is not a directory.*preserve the existing file/u,
  );
  assert.equal(readFileSync(blockedCache, "utf8"), "preserve non-directory cache path");
  assert.equal(existsSync(blockedTarget), false);
});

void test("Rust support cache on a separate parent volume retains the 20 GiB admission floor", (t) => {
  const root = fixture(t);
  const selected = path.join(root, "target-mount");
  mkdirSync(selected);
  const target = resolvePhysicalPath(selected);
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { preflight } from ${JSON.stringify(new URL("./dev-storage.mts", import.meta.url).href)};
    const target = ${JSON.stringify(target)};
    const originalStat = fs.statSync;
    const originalStatfs = fs.statfsSync;
    const probes = [];
    try {
      fs.statSync = (candidate, ...args) => {
        const stats = originalStat(candidate, ...args);
        stats.dev = path.resolve(String(candidate)) === target ? 101 : 202;
        return stats;
      };
      fs.statfsSync = (candidate, ...args) => {
        const absolute = path.resolve(String(candidate));
        probes.push(absolute);
        return { ...originalStatfs(candidate, ...args), bsize: 1024 ** 3, bavail: absolute === target ? 30 : 19 };
      };
      syncBuiltinESMExports();
      assert.throws(
        () => preflight({ target_directory: target, rust_support_cache: target + '.portcove-rust-support' }, 20, { blockSystemDrive: false }),
        /needs at least 20\\.0 GiB free;.*19\\.00 GiB/,
      );
      assert.deepEqual(probes, [target, path.dirname(target)]);
      probes.length = 0;
      assert.throws(
        () => preflight({ temporary_directory: target, scratch_backing_volume: path.dirname(target) }, 20, { blockSystemDrive: false }),
        /needs at least 20\\.0 GiB free;.*19\\.00 GiB/,
      );
      assert.deepEqual(probes, [target, path.dirname(target)]);
      console.log('separate support-cache volume refused at unchanged 20 GiB');
    } finally {
      fs.statSync = originalStat;
      fs.statfsSync = originalStatfs;
      syncBuiltinESMExports();
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /separate support-cache volume refused at unchanged 20 GiB/u);
});

void test(
  "Rust-generated Tauri storage remains subject to strict physical-path checks",
  { skip: process.platform !== "win32" },
  (t) => {
    const link = path.join(fixture(t), "tauri-gen");
    symlinkSync(`${process.env.SystemDrive || "C:"}\\`, link, "junction");
    const paths = getPaths("rust", {
      metadataProvider: () => ({
        workspace_root: projectRoot,
        target_directory: path.join(projectRoot, "target"),
      }),
    });
    paths.tauri_generated = path.join(link, "not-created-schema");
    assert.throws(
      () => preflight(paths, 1, { blockSystemDrive: true }),
      /tauri_generated=.*system drive|system drive.*tauri_generated/,
    );
  },
);

void test("frontend setup and execution work without Cargo or native output resolution", (t) => {
  const root = workspace(t);
  const overrides = { PATH: "", CARGO_TARGET_DIR: path.join(root, "not-a-directory") };
  writeFileSync(overrides.CARGO_TARGET_DIR, "unrelated Rust path must not be inspected");
  const result = cli(root, ["preflight", "--scope", "frontend", "--json"], overrides);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixtureRecord(result.stdout).target_directory, undefined);
  const executed = cli(
    root,
    [
      "run",
      "--scope",
      "frontend",
      "--",
      process.execPath,
      "-e",
      "require('fs').writeFileSync('ran', 'frontend')",
    ],
    overrides,
  );
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(readFileSync(path.join(root, "ran"), "utf8"), "frontend");
  const unknown = cli(root, ["run", "--", process.execPath, "-e", "process.exit(0)"], overrides);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /cargo|ENOENT/);
});

void test(
  "ordinary Windows system-drive paths pass capacity checks while strict policy refuses",
  { skip: process.platform !== "win32" },
  () => {
    const paths = { temporary_directory: `${process.env.SystemDrive || "C:"}\\` };
    assert.doesNotThrow(() => preflight(paths, 1, { blockSystemDrive: false }));
    assert.throws(() => preflight(paths, 1, { blockSystemDrive: true }), /system drive/);
    assert.throws(
      () => preflight(paths, 1_000_000_000, { blockSystemDrive: false }),
      /needs at least/,
    );
  },
);

void test("clean accepts only the default target and refuses linked ancestors", (t) => {
  const root = fixture(t);
  const target = path.join(root, "target");
  assert.equal(validateCleanTarget({ workspace: root, target_directory: target }), target);
  for (const candidate of [
    root,
    path.dirname(root),
    path.join(root, "src"),
    path.join(root, "custom/target"),
  ]) {
    assert.throws(
      () => validateCleanTarget({ workspace: root, target_directory: candidate }),
      /except this workspace/,
    );
  }
  const real = path.join(root, "real");
  mkdirSync(real);
  writeFileSync(path.join(real, "retained-evidence"), "preserve");
  symlinkSync(real, target, "junction");
  assert.throws(
    () => validateCleanTarget({ workspace: root, target_directory: target }),
    /symlink, junction.*Leave that path and its contents unchanged/,
  );
  const alias = path.join(root, "alias");
  symlinkSync(real, alias, "junction");
  assert.throws(
    () =>
      validateCleanTarget({
        workspace: alias,
        target_directory: path.join(alias, "target"),
      }),
    /symlink, junction.*Leave that path and its contents unchanged/,
  );
  assert.equal(readFileSync(path.join(real, "retained-evidence"), "utf8"), "preserve");
});

void test("incremental pruning accepts only an ordinary unlinked cache", (t) => {
  const root = fixture(t);
  const paths = { workspace: root, target_directory: path.join(root, "target") };
  assert.equal(validateIncrementalCache(paths), path.join(root, "target", "debug", "incremental"));

  const redirected = path.join(root, "redirected");
  mkdirSync(redirected);
  mkdirSync(path.join(root, "target"));
  symlinkSync(redirected, path.join(root, "target", "debug"), "junction");
  assert.throws(
    () => validateIncrementalCache(paths),
    /symlink, junction.*Leave that path and its contents unchanged/,
  );
  rmSync(path.join(root, "target", "debug"));
  mkdirSync(path.join(root, "target", "debug"));
  writeFileSync(path.join(root, "target", "debug", "incremental"), "not a cache");
  assert.throws(
    () => validateIncrementalCache(paths),
    /non-directory.*prune only an ordinary target\/debug\/incremental/,
  );
  assert.equal(
    readFileSync(path.join(root, "target", "debug", "incremental"), "utf8"),
    "not a cache",
  );
});

void test("rejects malformed invocations and invalid free-space margins", () => {
  for (const args of [
    ["run"],
    ["typo"],
    ["typo", "--help"],
    ["--unknown", "--help"],
    ["preflight", "--", "cargo"],
    ["preflight", "--minimum-free-gib"],
    ["run", "--json", "--", "cargo"],
  ]) {
    assert.throws(() => parseArguments(args));
  }
  for (const value of ["", "0", "-1", "NaN", "Infinity"])
    assert.throws(() => minimumFreeGiB(value), /positive/);
  assert.equal(minimumFreeGiB("20.5"), 20.5);
});

void test("storage help exits before tool discovery, path checks, preparation or cleanup", (t) => {
  const root = workspace(t);
  const retained = path.join(root, "target/debug/incremental/retained");
  mkdirSync(path.dirname(retained), { recursive: true });
  writeFileSync(retained, "preserve existing cache");
  writeFileSync(path.join(root, "not-a-directory"), "preserve source input");
  rmSync(path.join(root, "Cargo.toml"));
  rmSync(path.join(root, "package.json"));
  const overrides = {
    PATH: "",
    PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-help",
    PORTCOVE_BLOCK_SYSTEM_DRIVE: "invalid-but-irrelevant-to-help",
    PORTCOVE_TEMP_DIR: path.join(root, "not-a-directory/child"),
  };
  for (const args of [
    ["--help"],
    ["preflight", "--help"],
    ["preflight", "--scope", "tooling", "--help"],
    ["run", "--help"],
    ["clean", "--help"],
    ["prune-incremental", "--help"],
    ["run", "--help", "--", process.execPath, "-e", "require('fs').writeFileSync('ran', '')"],
  ]) {
    const result = cli(root, args, overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage: node scripts\/dev-storage\.mts/);
    assert.match(result.stdout, /--minimum-free-gib/);
    assert.match(result.stdout, /PORTCOVE_MIN_FREE_GIB/);
    assert.match(result.stdout, /Examples:/);
  }
  assert.equal(readFileSync(retained, "utf8"), "preserve existing cache");
  assert.equal(readFileSync(path.join(root, "not-a-directory"), "utf8"), "preserve source input");
  for (const name of ["work", "outputs", "ran"])
    assert.equal(existsSync(path.join(root, name)), false);
});

void test("storage help after -- remains an argument to the child command", (t) => {
  const root = workspace(t);
  const result = cli(root, [
    "run",
    "--scope",
    "tooling",
    "--",
    process.execPath,
    "-e",
    "require('fs').writeFileSync('child-arguments.json', JSON.stringify(process.argv.slice(1)))",
    "--",
    "--help",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "child-arguments.json"), "utf8")), [
    "--help",
  ]);
  assert.doesNotMatch(result.stdout, /Usage: node scripts\/dev-storage\.mts/);
});

void test("invalid storage margins report the effective input and an actionable correction", (t) => {
  const root = workspace(t);
  for (const { args, value, received } of [
    { args: [], value: "invalid environment value", received: '"invalid environment value"' },
    { args: [], value: "", received: '""' },
    { args: [], value: "invalid\nvalue", received: '"invalid\\nvalue"' },
    { args: ["--minimum-free-gib", "0"], value: "invalid environment value", received: '"0"' },
  ]) {
    const result = cli(root, ["preflight", "--scope", "tooling", "--json", ...args], {
      PATH: "",
      PORTCOVE_MIN_FREE_GIB: value,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`received ${received}.`), result.stderr);
    assert.match(result.stderr, /Set --minimum-free-gib or PORTCOVE_MIN_FREE_GIB/);
    assert.doesNotMatch(result.stderr, /received undefined/);
  }
  const explicit = cli(
    root,
    ["preflight", "--scope", "tooling", "--json", "--minimum-free-gib", "20"],
    { PATH: "", PORTCOVE_MIN_FREE_GIB: "invalid environment value" },
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(fixtureRecord(explicit.stdout).minimum_free_gib, 20);
  assert.equal(existsSync(path.join(root, "work")), false);
  assert.equal(existsSync(path.join(root, "outputs")), false);
});

void test("preflight is read-only and machine-readable, and low space prevents child execution", (t) => {
  const root = workspace(t);
  const result = cli(root, ["preflight", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = fixtureRecord(result.stdout);
  assert.equal(report.minimum_free_gib, 20);
  assert.equal(report.workspace, root);
  assert.equal(report.target_directory, path.join(root, "target"));
  assert.equal(report.rust_support_cache, path.join(root, "target.portcove-rust-support"));
  assert.equal(report.frontend_dependencies, path.join(root, "node_modules"));
  assert.equal(report.desktop_dependencies, path.join(root, "apps/desktop/node_modules"));
  assert.equal(existsSync(path.join(root, "work")), false);
  assert.equal(existsSync(path.join(root, "outputs")), false);
  const blocked = cli(root, [
    "run",
    "--minimum-free-gib",
    "1000000000",
    "--",
    process.execPath,
    "-e",
    "require('fs').writeFileSync('ran', '')",
  ]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /needs at least/);
  assert.match(
    blocked.stderr,
    /preserve source inputs, recovery material and verification evidence/,
  );
  assert.equal(existsSync(path.join(root, "ran")), false);
});

void test("run creates configured scratch directories, exports matching paths, and preserves exit status", (t) => {
  const root = workspace(t);
  const overrides = {
    CARGO_TARGET_DIR: path.join(root, "build target"),
    PORTCOVE_TEMP_DIR: "scratch temp",
    PORTCOVE_OUTPUT_DIR: "packages",
    PORTCOVE_PNPM_STORE_DIR: "package store",
    TMPDIR: path.join(root, "wrong"),
    pnpm_config_store_dir: path.join(root, "wrong-store"),
  };
  const probe = `const fs = require('fs'); const os = require('os'); const {CARGO_TARGET_DIR, TMPDIR, pnpm_config_store_dir} = process.env; fs.writeFileSync('probe.json', JSON.stringify({env: {CARGO_TARGET_DIR, TMPDIR, pnpm_config_store_dir}, temp: os.tmpdir(), exists: fs.existsSync(os.tmpdir())})); process.exit(17);`;
  const result = cli(root, ["run", "--", process.execPath, "-e", probe], overrides);
  assert.equal(result.status, 17, result.stderr);
  const report = fixtureRecord(readFileSync(path.join(root, "probe.json"), "utf8"));
  assert.equal(report.exists, true);
  assert.equal(report.temp, path.join(root, "scratch temp"));
  assert.ok(isRecord(report.env));
  assert.equal(report.env.CARGO_TARGET_DIR, path.join(root, "build target"));
  assert.equal(report.env.TMPDIR, report.temp);
  assert.equal(report.env.pnpm_config_store_dir, path.join(root, "package store"));
  assert.equal(existsSync(path.join(root, "packages")), true);
});

void test("pnpm uses the configured store instead of the workspace YAML default", (t) => {
  const root = workspace(t);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "storeDir: work/pnpm-store\n");
  const store = path.join(root, "custom store");
  const result = cli(root, ["run", "--", "corepack", "pnpm", "store", "path"], {
    PORTCOVE_PNPM_STORE_DIR: store,
    PNPM_CONFIG_STORE_DIR: path.join(root, "wrong-store"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), path.join(store, "v11"));
});

void test("direct just recipes initialize a fresh checkout and preserve storage overrides", (t) => {
  const root = workspace(t);
  for (const name of ["run-viteplus.mts", "viteplus-cli.mts"])
    copyFileSync(new URL(`./${name}`, import.meta.url), path.join(root, "scripts", name));
  // This storage/recipe fixture runs only the fixed inert vp probe below.
  // Resolve the real wrapper's import, and refuse any unexpected heavy route;
  // resource-command controls and native observations own actual admission.
  writeFileSync(
    path.join(root, "scripts/resource-command.mts"),
    'export const resourceEntrypoint=()=>{throw new Error("Storage fixture unexpectedly requested heavy admission");};',
  );
  copyFileSync(new URL("../justfile", import.meta.url), path.join(root, "justfile"));
  mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "storage-repository",
      private: true,
      packageManager: "pnpm@12.4.1",
      scripts: { build: "node probe.mjs" },
    }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/desktop\n");
  writeFileSync(
    path.join(root, "apps/desktop/package.json"),
    JSON.stringify({
      name: "storage-probe",
    }),
  );
  writeFileSync(
    path.join(root, "probe.mjs"),
    "import fs from 'node:fs'; import os from 'node:os'; if (!fs.existsSync(os.tmpdir())) process.exit(3); fs.writeFileSync('result.json', JSON.stringify({temp: os.tmpdir(), store: process.env.pnpm_config_store_dir}));",
  );
  const installed = path.join(root, "node_modules/vite-plus");
  mkdirSync(path.join(installed, "bin"), { recursive: true });
  writeFileSync(
    path.join(installed, "package.json"),
    JSON.stringify({
      name: "vite-plus",
      version: "1.2.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      bin: { vp: "bin/vp" },
    }),
  );
  writeFileSync(
    path.join(installed, "bin/vp"),
    '#!/usr/bin/env node\nimport assert from "node:assert/strict"; assert.deepEqual(process.argv.slice(2),["run","frontend:build"]); await import("../../../probe.mjs");\n',
  );
  const result = spawnCommand("just", ["ui-build"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: environment({
      PORTCOVE_TEMP_DIR: "custom/temp",
      PORTCOVE_PNPM_STORE_DIR: "custom/store",
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixtureRecord(readFileSync(path.join(root, "result.json"), "utf8")), {
    temp: path.join(root, "custom/temp"),
    store: path.join(root, "custom/store"),
  });
});

void test(
  "Windows shims preserve spaced arguments and exit status and reject shell injection",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fixture(t);
    const shim = path.join(root, "test shim.cmd");
    writeFileSync(shim, "@echo off\r\necho [%~1] [%~2]\r\nexit /b 23\r\n");
    const options = { cwd: root, encoding: "utf8" as const, windowsHide: true };
    const result = spawnCommand(shim, ["has spaces", ""], options);
    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.stdout.trim(), "[has spaces] []");
    const fromUrl = spawnCommand(path.basename(shim), ["has spaces", ""], {
      ...options,
      cwd: pathToFileURL(root + path.sep),
    });
    assert.equal(fromUrl.status, 23, fromUrl.stderr);
    assert.equal(fromUrl.stdout.trim(), "[has spaces] []");
    const withoutOptions = spawnCommand(shim, ["has spaces", ""]);
    assert.equal(withoutOptions.status, 23, withoutOptions.stderr?.toString());
    assert.equal(withoutOptions.stdout?.toString().trim(), "[has spaces] []");
    for (const token of ['bad"quote', "bad&command", "%TEMP%", "!TEMP!", "line\nbreak"]) {
      assert.throws(() => spawnCommand(shim, [token], options), /shell metacharacters/);
    }
    assert.throws(() => spawnCommand("missing&command", [], options), /shell metacharacters/);
  },
);

void test("child environment covers POSIX and Windows temp consumers", () => {
  const paths = {
    target_directory: "target",
    temporary_directory: "scratch",
    output_root: "packages",
    pnpm_store: "store",
  };
  const env = childEnvironment(paths);
  assert.equal(env.TEMP, "scratch");
  assert.equal(env.TMP, "scratch");
  assert.equal(env.TMPDIR, "scratch");
  assert.equal(env.pnpm_config_store_dir, "store");
});

void test("clean remains available below the free-space margin and preserves source files", (t) => {
  const root = workspace(t);
  const sibling = path.join(root, "target.portcove-rust-support");
  writeFileSync(sibling, "preserve unrelated sibling cache path");
  mkdirSync(path.join(root, "target"));
  writeFileSync(
    path.join(root, "target/CACHEDIR.TAG"),
    "Signature: 8a477f597d28d172789f06886806bc55\n",
  );
  writeFileSync(path.join(root, "target/disposable-build"), "test output");
  const result = cli(root, ["clean"], {
    PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-clean",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, "target")), false);
  assert.equal(existsSync(path.join(root, "src/lib.rs")), true);
  assert.equal(readFileSync(sibling, "utf8"), "preserve unrelated sibling cache path");
  assert.equal(
    cli(root, ["clean"], { PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-clean" }).status,
    0,
  );
  const rejected = cli(root, ["clean"], {
    CARGO_TARGET_DIR: path.join(root, "src"),
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /except this workspace/);
  assert.ok(rejected.stderr.includes(path.join(root, "src")), rejected.stderr);
  assert.ok(rejected.stderr.includes(path.join(root, "target")), rejected.stderr);
  assert.match(rejected.stderr, /Preserve the custom target and use its owning cleanup workflow/);
  assert.equal(existsSync(path.join(root, "src/lib.rs")), true);
});

for (const markerKind of ["missing", "invalid", "short", "directory", "link"] as const) {
  void test(`clean preserves an unknown target with a ${markerKind} Cargo marker`, (t) => {
    const root = workspace(t);
    const target = path.join(root, "target");
    const marker = path.join(target, "CACHEDIR.TAG");
    const retained = path.join(root, "retained-evidence");
    mkdirSync(target);
    mkdirSync(retained);
    writeFileSync(path.join(target, "unknown-content"), "preserve target contents");
    writeFileSync(path.join(retained, "sentinel"), "preserve unrelated evidence");
    const invalidMarker =
      markerKind === "short" ? "unknown" : "This is not a Cargo ownership marker.\n".repeat(2);
    if (markerKind === "invalid" || markerKind === "short") writeFileSync(marker, invalidMarker);
    if (markerKind === "directory") {
      mkdirSync(marker);
      writeFileSync(path.join(marker, "sentinel"), "preserve non-marker directory");
    }
    if (markerKind === "link") symlinkSync(retained, marker, "junction");
    const entries = readdirSync(target).sort();

    const result = cli(root, ["clean"], {
      PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-clean",
    });
    assert.equal(result.status, 101, result.stderr);
    assert.match(result.stderr, /cannot clean/u);
    assert.match(result.stderr, /aborted to prevent accidental deletion of unrelated files/u);
    assert.match(result.stderr, /No fallback deletion was attempted/u);
    assert.match(result.stderr, /Preserve and review the remaining contents/u);
    assert.match(result.stderr, /do not create or replace CACHEDIR\.TAG/u);
    assert.match(result.stderr, /fresh owned checkout on a volume that passes storage preflight/u);
    assert.match(result.stderr, /keeping the old target for separate ownership review/u);
    assert.deepEqual(readdirSync(target).sort(), entries);
    assert.equal(
      readFileSync(path.join(target, "unknown-content"), "utf8"),
      "preserve target contents",
    );
    assert.equal(
      readFileSync(path.join(retained, "sentinel"), "utf8"),
      "preserve unrelated evidence",
    );
    assert.equal(readFileSync(path.join(root, "src/lib.rs"), "utf8"), "");
    if (markerKind === "missing") assert.equal(existsSync(marker), false);
    if (markerKind === "invalid" || markerKind === "short")
      assert.equal(readFileSync(marker, "utf8"), invalidMarker);
    if (markerKind === "directory")
      assert.equal(
        readFileSync(path.join(marker, "sentinel"), "utf8"),
        "preserve non-marker directory",
      );
    if (markerKind === "link") assert.equal(lstatSync(marker).isSymbolicLink(), true);
  });
}

void test("checked cleanup refuses an ordinary file in place of the target directory", (t) => {
  const root = workspace(t);
  const target = path.join(root, "target");
  writeFileSync(target, "preserve unknown file");
  const result = cli(root, ["clean"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Refusing to clean through a symlink, junction, or non-directory/u);
  assert.equal(readFileSync(target, "utf8"), "preserve unknown file");
  assert.equal(readFileSync(path.join(root, "src/lib.rs"), "utf8"), "");
});

for (const order of ["support-first", "Cargo-first"] as const) {
  const name = `real Cargo owns target initialization and checked cleanup after ${order} preparation`;
  void test(name, { timeout: 120_000 }, (t) => {
    let completed = false;
    const root = workspace(t, () => !completed);
    const observe = (message: string) => {
      appendFileSync(path.join(root, "cargo-smoke-evidence.log"), `${message}\n`);
      t.diagnostic(message);
    };
    const target = path.join(root, "target");
    const storage = path.join(root, "scripts/dev-storage.mts");
    const env = environment({
      CARGO_HOME: path.join(root, "cargo-home"),
      CARGO_TARGET_DIR: target,
      CARGO_BUILD_BUILD_DIR: undefined,
      CARGO_BUILD_TARGET_DIR: undefined,
      RUSTC: undefined,
      RUSTC_WRAPPER: undefined,
      RUSTC_WORKSPACE_WRAPPER: undefined,
      RUSTUP_AUTO_INSTALL: "0",
      PORTCOVE_BLOCK_SYSTEM_DRIVE: process.env.PORTCOVE_BLOCK_SYSTEM_DRIVE,
    });
    const runSync: CompilerRunner = (command, args, options) => {
      const result = spawnSync(command, args, {
        ...options,
        cwd: root,
        env,
        stdio: "pipe",
        encoding: "utf8",
        // Cold compiler startup exceeded 10s in the complete cohort; keep other commands bounded.
        timeout: command === "rustc" ? 30_000 : 10_000,
        windowsHide: true,
      });
      observe(
        JSON.stringify({
          cwd: root,
          command: [command, ...args],
          status: result.status,
          signal: result.signal,
          stdout: result.stdout?.trim(),
          stderr: result.stderr?.trim(),
        }),
      );
      assert.ifError(result.error);
      return result;
    };
    const admission = runSync(
      process.execPath,
      [storage, "preflight", "--scope", "rust", "--json"],
      {},
    );
    if (
      admission.status !== 0 &&
      !process.env.CI &&
      !process.env.GITHUB_ACTIONS &&
      /Portcove needs at least 20\.0 GiB free;/u.test(String(admission.stderr))
    ) {
      completed = true;
      t.skip(
        `Real Cargo acceptance was not observed: unchanged 20 GiB reserve blocks local compilation. ${String(admission.stderr).trim()}`,
      );
      return;
    }
    assert.equal(admission.status, 0, String(admission.stderr));
    assert.equal(fixtureRecord(String(admission.stdout)).minimum_free_gib, 20);
    assert.equal(existsSync(target), false);

    const pinnedToolchain = /channel\s*=\s*"([^"]+)"/u.exec(
      readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8"),
    )?.[1];
    assert.ok(pinnedToolchain);
    const cargo = runSync("cargo", ["--version", "--verbose"], {});
    assert.equal(cargo.status, 0, String(cargo.stderr));
    assert.ok(String(cargo.stdout).startsWith(`cargo ${pinnedToolchain} `), String(cargo.stdout));
    const compiler = rustSupportCompilerIdentity({ runSync, environment: env });
    assert.ok(compiler.verbose_version.split(/\r?\n/u).includes(`release: ${pinnedToolchain}`));

    const source = path.join(root, "support.rs");
    const output = path.join(root, process.platform === "win32" ? "support.exe" : "support");
    const sentinel = path.join(root, "retained-evidence");
    writeFileSync(source, "fn main() {}\n");
    writeFileSync(sentinel, "preserve unrelated evidence");
    const build = () => {
      const result = runSync(
        process.execPath,
        [storage, "run", "--scope", "rust", "--", "cargo", "build", "--offline"],
        {},
      );
      assert.equal(result.status, 0, String(result.stderr));
      const marker = readFileSync(path.join(target, "CACHEDIR.TAG"), "utf8");
      assert.match(marker, /^Signature: 8a477f597d28d172789f06886806bc55/u);
      observe(`Cargo created ${path.join(target, "CACHEDIR.TAG")}: ${JSON.stringify(marker)}`);
      return marker;
    };
    const priorMarker = order === "Cargo-first" ? build() : undefined;
    const prepared = prepareRustSupportArtifact({
      root,
      product: "storage-smoke",
      source,
      output,
      rustcArgs: ["--edition=2021"],
      compiler,
      environment: env,
      runSync,
    });
    assert.equal(prepared.outcome, "built");
    if (order === "support-first") {
      assert.equal(
        existsSync(target),
        false,
        "support preparation must leave Cargo's target absent",
      );
      build();
    } else {
      assert.equal(readFileSync(path.join(target, "CACHEDIR.TAG"), "utf8"), priorMarker);
    }
    const cache = path.join(
      `${target}.portcove-rust-support`,
      "v1",
      "storage-smoke",
      prepared.fingerprint,
    );
    const cachedArtifact = readFileSync(path.join(cache, "artifact"));
    const cachedManifest = readFileSync(path.join(cache, "manifest.json"), "utf8");
    assert.deepEqual(readFileSync(output), cachedArtifact);

    const cleaned = runSync(process.execPath, [storage, "clean"], {});
    assert.equal(cleaned.status, 0, String(cleaned.stderr));
    assert.equal(existsSync(target), false);
    assert.deepEqual(readFileSync(path.join(cache, "artifact")), cachedArtifact);
    assert.equal(readFileSync(path.join(cache, "manifest.json"), "utf8"), cachedManifest);
    assert.deepEqual(readFileSync(output), cachedArtifact);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve unrelated evidence");
    assert.equal(readFileSync(source, "utf8"), "fn main() {}\n");
    assert.equal(readFileSync(path.join(root, "src/lib.rs"), "utf8"), "");
    completed = true;
  });
}

void test("incremental prune preserves reusable Cargo artifacts and works below the margin", (t) => {
  const root = workspace(t);
  const sibling = path.join(root, "target.portcove-rust-support");
  writeFileSync(sibling, "preserve unrelated sibling cache path");
  mkdirSync(path.join(root, "target/debug/incremental/unit"), { recursive: true });
  mkdirSync(path.join(root, "target/debug/deps"), { recursive: true });
  writeFileSync(path.join(root, "target/debug/incremental/unit/cache"), "discard");
  writeFileSync(path.join(root, "target/debug/deps/reusable"), "preserve");

  const result = cli(root, ["prune-incremental"], {
    PORTCOVE_MIN_FREE_GIB: "invalid-but-irrelevant-to-prune",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, "target/debug/incremental")), false);
  assert.equal(existsSync(path.join(root, "target/debug/deps/reusable")), true);
  assert.equal(existsSync(path.join(root, "src/lib.rs")), true);
  assert.equal(readFileSync(sibling, "utf8"), "preserve unrelated sibling cache path");
  assert.equal(cli(root, ["prune-incremental"]).status, 0);

  const custom = path.join(root, "custom-target", "debug", "incremental");
  mkdirSync(custom, { recursive: true });
  writeFileSync(path.join(custom, "cache"), "preserve");
  const rejected = cli(root, ["prune-incremental"], {
    CARGO_TARGET_DIR: path.join(root, "custom-target"),
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /except this workspace/);
  assert.equal(existsSync(path.join(custom, "cache")), true);
});

void test("routine and exhaustive Rust gates preserve incremental reuse without duplicate checking", () => {
  const recipes = readFileSync(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /^default: local-check$/m);
  assert.match(
    recipes,
    /^prune-incremental:\r?\n\s+node scripts\/dev-storage\.mts prune-incremental$/m,
  );
  assert.match(
    recipes,
    /^check-rust: rustfmt-check clippy rust-test shear architecture process-policy transport-contract$/m,
  );
  const exhaustiveRust = recipes.match(/^check-rust:.+$/m)?.[0] ?? "";
  assert.doesNotMatch(exhaustiveRust, /prune-incremental|rust-check/);
  for (const focused of ["rustfmt-check", "rust-check", "clippy", "rust-test"]) {
    assert.doesNotMatch(
      recipes.match(new RegExp(`^${focused}:\\r?\\n([\\s\\S]*?)(?=^\\S)`, "m"))?.[0] ?? "",
      /prune-incremental/,
    );
  }
  assert.match(
    recipes,
    /^rust-check:\r?\n\s+\{\{storage\}\} node scripts\/run-rust-tests\.mts --guard-command cargo check --workspace --all-targets$/m,
  );
  assert.match(
    recipes,
    /^clippy:\r?\n\s+\{\{storage\}\} node scripts\/run-rust-tests\.mts --guard-command cargo clippy --workspace --all-targets -- -D warnings$/m,
  );
  assert.match(
    recipes,
    /^rust-test:\r?\n\s+\{\{storage\}\} node scripts\/run-rust-tests\.mts --locked --workspace\r?\n\s+\{\{storage\}\} node scripts\/run-rust-tests\.mts --guard-command node scripts\/qualification-rustdoc\.mts workspace\r?\n\s+\{\{storage\}\} node scripts\/run-rust-tests\.mts --guard-command node scripts\/qualification-rustdoc\.mts desktop$/m,
  );
});

void test(
  "local packaging honors custom storage, produces a ZIP without generated data, and restores the environment",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = workspace(t);
    copyFileSync(
      new URL("./package-local.ps1", import.meta.url),
      path.join(root, "scripts/package-local.ps1"),
    );
    writeFileSync(path.join(root, "scripts/check-release-metadata.mts"), "process.exit(0);\n");
    writeFileSync(
      path.join(root, "scripts/package-cli.ps1"),
      `
param([string]$PlatformLabel, [string]$ProjectRoot, [string]$TargetRoot, [switch]$Force)
$assets = Join-Path $ProjectRoot "release-assets"
[System.IO.Directory]::CreateDirectory($assets) | Out-Null
$staging = Join-Path $ProjectRoot "cli-staging"
[System.IO.Directory]::CreateDirectory($staging) | Out-Null
Copy-Item -LiteralPath (Join-Path $TargetRoot "release/portcove.exe") -Destination (Join-Path $staging "portcove.exe")
$archive = Join-Path $assets "portcove-cli-0.1.0-windows-x86_64.zip"
Compress-Archive -LiteralPath (Join-Path $staging "portcove.exe") -DestinationPath $archive
Remove-Item -LiteralPath $staging -Recurse -Force
Write-Output $archive
`,
    );
    writeFileSync(
      path.join(root, "scripts/smoke-test-cli-archive.ps1"),
      "param([string]$ArchivePath, [string]$PlatformLabel, [string]$Version)\n$global:LASTEXITCODE = 0\n",
    );
    const target = path.join(root, "custom target");
    mkdirSync(path.join(target, "release/bundle/nsis"), { recursive: true });
    writeFileSync(
      path.join(target, "release/bundle/nsis/Portcove_0.1.0_x64-setup.exe"),
      "installer fixture",
    );
    writeFileSync(path.join(target, "release/portcove.exe"), "CLI fixture");
    writeFileSync(
      path.join(root, "package-test.ps1"),
      `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
$previousStore = $env:pnpm_config_store_dir
function cargo {
    @{ target = $env:CARGO_TARGET_DIR; temp = $env:TEMP; store = $env:pnpm_config_store_dir } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "build-env.json")
    $global:LASTEXITCODE = 0
}
& (Join-Path $PSScriptRoot "scripts/package-local.ps1") -Version 0.1.0
if ($env:TEMP -ne $previousTemp -or $env:pnpm_config_store_dir -ne $previousStore) { throw "Caller environment was not restored" }
`,
    );
    const result = spawnSync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-File", path.join(root, "package-test.ps1")],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: environment({
          CARGO_TARGET_DIR: target,
          PORTCOVE_OUTPUT_DIR: "packages",
          PORTCOVE_TEMP_DIR: "scratch",
          PORTCOVE_PNPM_STORE_DIR: "package store",
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixtureRecord(readFileSync(path.join(root, "build-env.json"), "utf8")), {
      target,
      temp: path.join(root, "scratch"),
      store: path.join(root, "package store"),
    });
    const archive = path.join(root, "packages/portcove-0.1.0-source.zip");
    assert.equal(readFileSync(archive).subarray(0, 4).toString("hex"), "504b0304");
    const listing = spawnSync("tar", ["-tf", archive], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /src\/lib.rs/);
    assert.doesNotMatch(listing.stdout, /custom target|packages\/|scratch\/|package store/);
    assert.equal(
      existsSync(path.join(root, "packages/portcove-cli-0.1.0-windows-x86_64.zip")),
      true,
    );
    assert.equal(
      readFileSync(path.join(root, "packages/SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/).length,
      3,
    );
  },
);

void test(
  "release preflight restores caller storage variables after a failed gate",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = workspace(t);
    copyFileSync(
      new URL("./release-preflight.ps1", import.meta.url),
      path.join(root, "scripts/release-preflight.ps1"),
    );
    for (const name of ["check-release-metadata.mts", "check-release-metadata.test.mts"]) {
      writeFileSync(path.join(root, "scripts", name), "process.exit(0);\n");
    }
    mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
    writeFileSync(
      path.join(root, "release-test.ps1"),
      `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
function pnpm {
    if ($args[0] -eq '--version') {
        $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json
        $manifest.packageManager -replace '^pnpm@', '' -replace '\\+.*$', ''
    }
    $global:LASTEXITCODE = 0
}
function just {
    if ($env:TEMP -ne (Join-Path $PSScriptRoot "scratch")) { throw "Wrong temporary path" }
    if ($env:pnpm_config_store_dir -ne (Join-Path $PSScriptRoot "store")) { throw "Wrong pnpm store" }
    throw "Expected test gate failure"
}
try { & (Join-Path $PSScriptRoot "scripts/release-preflight.ps1"); throw "Gate did not fail" }
catch { if ($_.Exception.Message -ne "Expected test gate failure") { throw } }
if ($env:TEMP -ne $previousTemp) { throw "Caller environment was not restored" }
`,
    );
    const result = spawnSync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-File", path.join(root, "release-test.ps1")],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: environment({
          PORTCOVE_TEMP_DIR: "scratch",
          PORTCOVE_PNPM_STORE_DIR: "store",
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

void test(
  "installer qualification resolves relative scratch paths, isolates process temp, and retains failure evidence",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = workspace(t);
    copyFileSync(
      new URL("./test-windows-installer.ps1", import.meta.url),
      path.join(root, "scripts/test-windows-installer.ps1"),
    );
    writeFileSync(path.join(root, "installer.exe"), "fixture");
    writeFileSync(
      path.join(root, "installer-test.ps1"),
      `
$ErrorActionPreference = "Stop"
$previousTemp = $env:TEMP
function Get-AuthenticodeSignature { @{ Status = "NotSigned" } }
function Get-ItemProperty {
    param([string]$Path, [string]$ErrorAction)
    if ($Path -notmatch '^HK(CU|LM):.*Uninstall') { throw "Unexpected registry query in storage fixture" }
    # This storage unit fixture models an empty registry without consulting the host installation.
    @()
}
function Start-Process {
    @{ temp = $env:TEMP; tmp = $env:TMP; tmpdir = $env:TMPDIR } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "installer-env.json")
    throw "Expected test installer failure"
}
try { & (Join-Path $PSScriptRoot "scripts/test-windows-installer.ps1") -InstallerPath (Join-Path $PSScriptRoot "installer.exe"); throw "Installer did not fail" }
catch { if ($_.Exception.Message -ne "Expected test installer failure") { throw } }
if ($env:TEMP -ne $previousTemp) { throw "Caller environment was not restored" }
`,
    );
    const result = spawnSync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-File", path.join(root, "installer-test.ps1")],
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
        env: environment({ PORTCOVE_TEMP_DIR: "scratch" }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = fixtureRecord(readFileSync(path.join(root, "installer-env.json"), "utf8"));
    assert.ok(typeof report.temp === "string");
    assert.equal(path.dirname(report.temp), path.join(root, "scratch/installer-qualification"));
    assert.equal(report.tmp, report.temp);
    assert.equal(report.tmpdir, report.temp);
    assert.equal(existsSync(report.temp), true);
    assert.match(result.stdout, /evidence was preserved/);
  },
);

void test("reports every heavy path that would write to the system drive", () => {
  assert.deepEqual(
    windowsSystemDriveViolations({
      workspace: "E:\\Portcove-Development",
      target_directory: "C:\\temp\\target",
      output_root: "c:/temp/outputs",
      pnpm_store: "E:\\Portcove-Development\\work\\pnpm-store",
      browser_cache: "C:\\temp\\browser-cache",
    }),
    [
      "target_directory=C:\\temp\\target",
      "output_root=c:/temp/outputs",
      "browser_cache=C:\\temp\\browser-cache",
    ],
  );
});
