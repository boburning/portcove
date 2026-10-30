import {
  updaterWorkflow,
  updaterWorkflowVariants,
  observeUpdaterCaller,
  observeLinuxDriver,
  observeHistoricalScope,
  observeRetainedRebootScope,
} from "./fixtures/updater-workflow-fixture.mts";
import { prerequisiteInvocation } from "./fixtures/linux-prerequisites-fixture.mts";
import { readWorkflow } from "./ci-workflow-fixture.mts";
import type { TestContext } from "node:test";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type {
  StageUpdaterOptions,
  VerifyUpdaterOptions,
  UpdaterInventory,
} from "./updater-artifact-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
} from "./release-package-policy.mts";
import {
  stageUpdaterInventory,
  updaterIdentity,
  verifyUpdaterInventory,
} from "./updater-artifact-inventory.mts";

const policy = await loadPackagePolicy();
const version = "0.3.0";
const revision = "a".repeat(40);

void test(
  "Windows smoke journals retain runtime diagnostics and the original failed exit",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-smoke-output-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const harness = fileURLToPath(new URL("./test-windows-installer.ps1", import.meta.url));
    const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${harness.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer harness parse failed' }
foreach ($name in @('Start-JournaledProcess', 'Complete-JournaledProcess')) {
 $functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true))
 if ($functions.Count -ne 1) { throw 'Missing journal function' }
 Invoke-Expression $functions[0].Extent.Text
}
function Write-InstallerEvidence { param($Phase) }
$evidence = @{ phase = 'fixture'; process_runs = @() }
$runRoot = '${root.replaceAll("'", "''")}'; $TestFault = ''
$program = (Get-Process -Id $PID).Path
$command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('[Console]::Out.WriteLine("fixture stdout"); [Console]::Error.WriteLine("insufficient runtime fixture"); Start-Sleep -Milliseconds 700; exit 1'))
foreach ($role in @('predecessor_smoke', 'candidate_smoke')) {
 $launch = Start-JournaledProcess $role $program @('-NoProfile', '-NonInteractive', '-EncodedCommand', $command)
 try {
  if (-not $launch.process.WaitForExit(10000)) { throw 'Fixture process did not exit' }
  Complete-JournaledProcess $launch.run $launch.process 'exit_observed'
  if ($launch.run.exit_code -ne 1) { throw 'Original failed exit lost' }
  if (-not $launch.run.observed_image_path) { throw 'Live executable identity was not verified' }
  if ((Get-Content (Join-Path $runRoot $launch.run.output_relative) -Raw).Trim() -ne 'fixture stdout') { throw 'stdout lost' }
  if ((Get-Content (Join-Path $runRoot $launch.run.error_relative) -Raw).Trim() -ne 'insufficient runtime fixture') { throw 'runtime diagnostic lost' }
 } finally {
  if (-not $launch.process.HasExited) { $launch.process.Kill(); $launch.process.WaitForExit() }
  $launch.process.Dispose()
 }
}
# A deterministic provider fixture models a child already gone before live
# image observation. Blank StartInfo must not become an identity fallback.
function Start-Process {
 param($FilePath, $ArgumentList, [switch]$PassThru, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
 $process = [pscustomobject]@{ Id = 123; StartTime = [DateTime]::UtcNow; StartInfo = @{ FileName = '' }; Path = $null; HasExited = $true }
 $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
 $process
}
function Stop-JournaledProcess { param($Run, $Process, $Status, $Reason) }
foreach ($role in @('predecessor_smoke', 'candidate_smoke')) {
 $refused = $false
 try { Start-JournaledProcess $role $program @() | Out-Null }
 catch {
  if ($_.Exception.Message -ne "$role exited before its executable image could be verified") { throw }
  $refused = $true
 }
 if (-not $refused) { throw 'Smoke without executable identity was accepted' }
}
@{ smoke_roles = 2; failed_exit_preserved = $true; unverified_smokes_refused = $true } | ConvertTo-Json -Compress
`;
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      smoke_roles: 2,
      failed_exit_preserved: true,
      unverified_smokes_refused: true,
    });
  },
);

void test(
  "Windows updater preflight records and refuses unsuitable runtimes before fixture builds",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-runtime-preflight-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workflow = await readWorkflow(
      new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    );
    const contract = updaterWorkflow(workflow, releaseLabels(policy));
    const step = String(contract.runtime.step.run);
    for (const [index, actual] of [
      "155.0.4283.60",
      "155.0.4283.62",
      "155.0.4283.63",
      "155.0.4283.62 dev",
      "",
    ].entries()) {
      const cwd = path.join(root, String(index));
      await mkdir(path.join(cwd, "apps/desktop/src-tauri"), { recursive: true });
      await writeFile(
        path.join(cwd, "apps/desktop/src-tauri/tauri.conf.json"),
        JSON.stringify({ bundle: { windows: { minimumWebview2Version: "155.0.4283.62" } } }),
      );
      const script = `$ErrorActionPreference = 'Stop'\nfunction node { if ($args.Count -ne 2 -or $args[0].Replace('\\','/') -notmatch '^(?:\\./)?scripts/tool-cache[.]mts$' -or $args[1] -ne '--state') { throw 'UPDATER_RUNTIME_PROBE_ARGUMENTS' }; $global:LASTEXITCODE = 0; '{"desktop":{"webview2_version":"${actual}"}}' }\n${step}`;
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { cwd, encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.equal(result.status, index === 1 || index === 2 ? 0 : 1, result.stderr);
      const receipt = object(
        JSON.parse(
          await readFile(path.join(cwd, "work/updater-prerequisites/windows-runtime.json"), "utf8"),
        ),
      );
      assert.equal(receipt.registered_webview2, actual);
      assert.equal(receipt.minimum_webview2, "155.0.4283.62");
      assert.match(
        text(receipt.observation),
        /application-selected runtime is recorded separately/,
      );
    }
  },
);

function runPowerShellScript(
  relativePath: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fileURLToPath(new URL(relativePath, import.meta.url)),
      ...args,
    ],
    { encoding: "utf8", ...options },
  );
}

void test("AppImage qualification refuses root and unknown identities before creating state", async (t) => {
  const harness = fileURLToPath(new URL("./test-linux-appimage-update.ps1", import.meta.url));
  const source = await readFile(harness, "utf8");
  assert.ok(
    source.indexOf("$qualificationIdentity = Get-RootlessQualificationIdentity") <
      source.indexOf("$predecessor = Resolve-ExistingFile"),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-rootless-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "identity.ps1");
  await writeFile(
    script,
    `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${harness.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'AppImage harness parse failed' }
$functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-RootlessQualificationIdentity'}, $true))
if ($functions.Count -ne 1) { throw 'Missing rootless identity preflight' }
Invoke-Expression $functions[0].Extent.Text
function Invoke-IdFixture {
 $Kind = $args[0]
 $global:LASTEXITCODE = if ($Kind -eq '-u') { $case.user_exit } else { $case.group_exit }
 if ($Kind -eq '-u') { $case.uid } else { $case.gid }
}
Set-Alias -Name /usr/bin/id -Value Invoke-IdFixture
$cases = @(
 @{ uid='0'; gid='0'; user_exit=0; group_exit=0; error='Root cannot qualify' },
 @{ uid=''; gid='1000'; user_exit=0; group_exit=0; error='user ID' },
 @{ uid='invalid'; gid='1000'; user_exit=0; group_exit=0; error='user ID' },
 @{ uid='1000'; gid='1000'; user_exit=1; group_exit=0; error='user ID' },
 @{ uid='1000'; gid=''; user_exit=0; group_exit=0; error='group ID' },
 @{ uid='1000'; gid='1000'; user_exit=0; group_exit=1; error='group ID' },
 @{ uid='1000'; gid='1000'; user_exit=0; group_exit=0; error=$null }
)
foreach ($case in $cases) {
 $refused = $false
 try {
  $identity = Get-RootlessQualificationIdentity
  if ($case.error) { throw 'Unexpected identity acceptance' }
  if ($identity.uid -ne $case.uid -or $identity.gid -ne $case.gid) { throw 'Identity changed' }
 } catch {
  if (-not $case.error -or $_.Exception.Message -notlike "*$($case.error)*") { throw }
  $refused = $true
 }
 if ($case.error -and -not $refused) { throw 'Missing refusal' }
}
@{ cases = $cases.Count; root_refused = $true; ordinary_identity_retained = $true } | ConvertTo-Json -Compress
`,
  );
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cases: 7,
    root_refused: true,
    ordinary_identity_retained: true,
  });
});

async function fixture(t: TestContext, label = "windows-x86_64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "release/package-policy.json"), JSON.stringify(policy));
  await writeFile(path.join(root, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
  for (const entry of packagesForPlatform(policy, label)) {
    const directory =
      entry.interface === "cli" ? "release-assets" : `target/release/bundle/${entry.format}`;
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(
      path.join(root, directory, artifactName(entry, version)),
      `${entry.id} final bytes`,
    );
  }
  const identity = updaterIdentity(policy, label, version);
  const bundle = path.join(root, "target/release/bundle", identity.bundle_directory);
  await mkdir(bundle, { recursive: true });
  const source = path.join(bundle, identity.source_filename);
  if (identity.format === "app.tar.gz") await writeFile(source, "mac final archive");
  await writeFile(`${source}.sig`, "signature fixture");
  const publicKey = path.join(root, "test-public.key");
  await writeFile(publicKey, "public key fixture");
  let verified = 0;
  const options: StageUpdaterOptions & VerifyUpdaterOptions = {
    projectRoot: root,
    label,
    revision,
    publicKey,
    output: path.join(root, "staged"),
    input: path.join(root, "staged"),
    // This seam tests inventory ownership only; Rust tests and native rehearsal
    // exercise the real Minisign implementation, including wrong-key signatures.
    verifySignature: async (_verifier, artifact, signature, key, expected) => {
      assert.equal((await readFile(artifact)).length, expected.bytes);
      assert.equal(await readFile(signature, "utf8"), "signature fixture");
      verified += 1;
      return createHash("sha256")
        .update(await readFile(key))
        .digest("hex");
    },
  };
  return { root, source, identity, options, verified: () => verified };
}

for (const label of releaseLabels(policy)) {
  void test(`stages and independently rechecks all required ${label} packages`, async (t) => {
    const f = await fixture(t, label);
    const staged = await stageUpdaterInventory(f.options);
    assert.deepEqual(await verifyUpdaterInventory(f.options), staged);
    assert.equal(f.verified(), 2);
    assert.equal(staged.packages.length, packagesForPlatform(policy, label).length);
    assert.equal(staged.updater.target, label.replace("macos", "darwin"));
    await assert.rejects(stageUpdaterInventory(f.options), /EEXIST/);
  });
}

void test("missing signatures and failed verification never produce successful evidence", async (t) => {
  const f = await fixture(t);
  await rm(`${f.source}.sig`);
  await assert.rejects(stageUpdaterInventory(f.options), /ENOENT/);
  await writeFile(`${f.source}.sig`, "signature fixture");
  f.options.verifySignature = async () => {
    throw new Error("wrong signing key");
  };
  await assert.rejects(stageUpdaterInventory(f.options), /wrong signing key/);
  await assert.rejects(readFile(path.join(f.options.output, "updater-inventory.json")), /ENOENT/);
});

void test("changing any final package or the public key invalidates recorded evidence", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const cli = inventory.packages.find((entry) => entry.id.startsWith("cli-"));
  assert.ok(cli);
  const file = path.join(f.options.output, cli.filename);
  const original = await readFile(file);
  await writeFile(file, "changed companion");
  await assert.rejects(verifyUpdaterInventory(f.options), /checksum mismatch/);
  await writeFile(file, original);
  await writeFile(f.options.publicKey, "substituted key");
  await assert.rejects(verifyUpdaterInventory(f.options), /public key mismatch/);
});

void test("rejects duplicate packages, wrong target/version/revision and extra assets", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const manifest = path.join(f.options.output, "updater-inventory.json");
  const mutations: ((data: UpdaterInventory) => void)[] = [
    (data) => data.packages.push(first(data.packages)),
    (data) => {
      data.updater.target = "darwin-aarch64";
    },
    (data) => {
      data.version = "0.2.0";
    },
    (data) => {
      data.source_commit = "b".repeat(40);
    },
    (data) => {
      first(data.packages).filename = "../outside";
    },
    (data) => {
      data.updater.signature.filename = "other.sig";
    },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(inventory);
    mutate(data);
    await writeFile(manifest, JSON.stringify(data));
    await assert.rejects(verifyUpdaterInventory(f.options), /mismatch|duplicate/);
  }
  await writeFile(manifest, JSON.stringify(inventory));
  await copyFile(f.source, path.join(f.options.output, "unexpected.exe"));
  await assert.rejects(verifyUpdaterInventory(f.options), /staged files mismatch/);
});

void test("rejects overlapping staging paths and version override inheritance", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageUpdaterInventory({
      ...f.options,
      output: path.join(f.root, "target/release/bundle/new"),
    }),
    /overlap/,
  );
  await stageUpdaterInventory(f.options);
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, version: "0.1.0" }),
    /identity mismatch/,
  );
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, revision: "HEAD" }),
    /exact source commit/,
  );
});

void test("release-only overlay preserves ordinary secret-free builds and updater package baseline", async () => {
  const base = object(
    JSON.parse(
      await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    ),
  );
  const overlay = object(
    JSON.parse(
      await readFile(new URL("../release/tauri.updater.conf.json", import.meta.url), "utf8"),
    ),
  );
  assert.equal(object(base.bundle).createUpdaterArtifacts, false);
  assert.equal(object(overlay.bundle).createUpdaterArtifacts, true);
  assert.equal(object(object(object(overlay.bundle).windows).nsis).installMode, "currentUser");
  assert.equal(object(object(overlay.bundle).macOS).signingIdentity, "-");
  assert.equal(object(object(object(overlay.plugins).updater).windows).installMode, "passive");
  assert.equal(overlay.identifier, undefined);
  assert.equal(object(object(overlay.plugins).updater).endpoints, undefined);
  assert.equal(object(object(overlay.plugins).updater).pubkey, undefined);
});

void test("manual rehearsal retains the complete matrix without production credentials or publication", async () => {
  const workflow = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  const contract = updaterWorkflow(workflow, releaseLabels(policy));
  for (const expression of ["${{ toJSON(secrets) }}", "${{ format('}}{0}', toJSON(secrets)) }}"]) {
    const secretContext = structuredClone(contract.workflow);
    object(secretContext.env).WHOLE_CONTEXT = expression;
    assert.throws(
      () => updaterWorkflow(JSON.stringify(secretContext), releaseLabels(policy)),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.message.includes("UPDATER_PRODUCTION_SECRET_BINDING"),
    );
  }
  for (const expression of [
    "${{ 'secrets.EXAMPLE is documentation' }}",
    "${{ '}} secrets.EXAMPLE is documentation' }}",
  ]) {
    const literal = structuredClone(contract.workflow);
    object(literal.env).DOCUMENTATION = expression;
    updaterWorkflow(JSON.stringify(literal), releaseLabels(policy));
  }
  const ownerKey = first(
    Object.entries(object(contract.workflow.jobs)).filter(([, value]) => value === contract.job),
  )[0];
  const narrow = structuredClone(contract.workflow);
  const copiedUploader = object(
    array(object(object(narrow.jobs)[ownerKey]).steps)[contract.upload.index],
  );
  object(copiedUploader.with).path = text(object(copiedUploader.with).path).replace(
    "windows-renderer-evidence/*.json",
    "windows-renderer-evidence/receipt.json",
  );
  assert.throws(
    () => updaterWorkflow(JSON.stringify(narrow), releaseLabels(policy)),
    (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes("UPDATER_EVIDENCE_FAMILY"),
  );
  for (const [field, value, refusal] of [
    ["if-no-files-found", undefined, "UPDATER_MISSING_EVIDENCE_REFUSAL"],
    [
      "path",
      text(object(contract.upload.step.with).path) +
        "\n!work/updater-rehearsal/windows-renderer-evidence/**",
      "UPDATER_UNMODELED_EVIDENCE_EXCLUSION",
    ],
  ] as const) {
    const missing = structuredClone(contract.workflow);
    const uploader = object(
      array(object(object(missing.jobs)[ownerKey]).steps)[contract.upload.index],
    );
    object(uploader.with)[field] = value;
    assert.throws(
      () => updaterWorkflow(JSON.stringify(missing), releaseLabels(policy)),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(refusal),
    );
  }
  for (const [role, field, value, refusal] of [
    ["rehearsal", "if", false, "UPDATER_REHEARSAL_REACHABILITY"],
    ["historicalScope", "if", false, "UPDATER_HISTORICAL_SCOPE_REACHABILITY"],
    ["verification", "if", false, "UPDATER_VERIFICATION_REACHABILITY"],
    ["rehearsal", "continue-on-error", true, "UPDATER_REHEARSAL_FAILURE_PROPAGATION"],
    ["upload", "if", "success()", "UPDATER_FAILURE_EVIDENCE"],
  ] as const) {
    const disabled = structuredClone(contract.workflow);
    const step = object(array(object(object(disabled.jobs)[ownerKey]).steps)[contract[role].index]);
    step[field] = value;
    assert.throws(
      () => updaterWorkflow(JSON.stringify(disabled), releaseLabels(policy)),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(refusal),
    );
  }
  const missingArtifacts = structuredClone(contract.workflow);
  const missingUploader = object(
    array(object(object(missingArtifacts.jobs)[ownerKey]).steps)[contract.upload.index],
  );
  delete object(missingUploader.with).path;
  assert.throws(
    () => updaterWorkflow(JSON.stringify(missingArtifacts), releaseLabels(policy)),
    (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes("UPDATER_EVIDENCE_INPUTS"),
  );
  const retainedPaths = contract.retainedPaths;
  const retained = (file: string) =>
    retainedPaths.some((pattern) => path.posix.matchesGlob(file, pattern));
  for (const label of releaseLabels(policy)) {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "1.0.0-rc.2", "1.0.0"])
      assert.ok(
        contract
          .retainedPathsFor(label)
          .some((pattern) =>
            path.posix.matchesGlob(
              `work/updater-rehearsal/${version}-${label}/updater-inventory.json`,
              pattern,
            ),
          ),
        `${label} loses ${version} candidate identity`,
      );
  }
  for (const preflight of ["baseline", "fixture-env"]) {
    const directory = `work/updater-rehearsal/installer-test/run-owned/driver-preflight-${preflight}`;
    for (const artifact of [
      "session-startup-0.jsonl",
      "session-startup-0.log",
      "session-startup-1.jsonl",
      "session-startup-1.log",
      "embedded-processes-0.json",
      "embedded-processes-1.json",
      "embedded-application.log",
    ])
      assert.ok(retained(`${directory}/${artifact}`), `${preflight} loses ${artifact}`);
    assert.equal(retained(`${directory}/session-startup-0.stop`), false);
    assert.equal(retained(`${directory}/private.key`), false);
  }
  for (const file of ["Portcove_0.1.0_x64-setup.exe", "Portcove_0.1.0_x64-setup.exe.sig"])
    assert.ok(
      retained(`work/updater-rehearsal/qualified-0.1.0-bundles/nsis/${file}`),
      `loses installed predecessor ${file}`,
    );
  assert.equal(retained("work/updater-rehearsal/qualified-0.1.0-bundles/nsis/private.key"), false);
  for (const required of [
    "work/updater-rehearsal/linux-appimage-qualification/application-update-evidence.json",
    "work/updater-rehearsal/installer-test/run-owned/renderer-qualification/evidence/evidence.json",
    "work/updater-rehearsal/windows-renderer-evidence/renderer-update-evidence.json",
    "work/updater-rehearsal/windows-renderer-evidence/native-processes-before-restart.json",
    "work/updater-rehearsal/windows-renderer-evidence/before-restart.png",
    "work/updater-rehearsal/windows-renderer-evidence/failure.png",
    "work/updater-rehearsal/qualified-0.1.0-bundles/appimage/Portcove.AppImage",
    "work/updater-rehearsal/qualified-0.1.0-bundles/macos/Portcove.app/Contents/MacOS/portcove-desktop",
    "work/updater-rehearsal/macos-installed-selection-qualification/application-update-evidence.json",
    "work/updater-rehearsal/macos-installed-selection-qualification/state/context.json",
    "work/updater-rehearsal/linux-appimage-qualification/state/update-state/state.json",
    "work/updater-rehearsal/macos-installed-selection-qualification/state/library/logs/portcove-desktop.jsonl",
  ])
    assert.ok(retained(required), `UPDATER_MANDATORY_EVIDENCE: ${required}`);
  for (const rejected of [
    "work/updater-rehearsal/installer-test/run-owned/renderer-qualification/private.key",
    "work/updater-rehearsal/macos-installed-selection-qualification/private/disposable.key",
    "work/updater-rehearsal/linux-appimage-qualification/private/disposable.key",
    "work/updater-rehearsal/linux-appimage-qualification/state/private.key",
  ])
    assert.equal(retained(rejected), false, `UPDATER_PRIVATE_EVIDENCE: ${rejected}`);
  const lifecycle = await readFile(
    new URL("./test-windows-installer.ps1", import.meta.url),
    "utf8",
  );
  assert.match(lifecycle, /\$InstallMode -eq "Passive".*"\/P"/);
  assert.match(lifecycle, /\$predecessor.*"\/UPDATE"/);
  assert.doesNotMatch(lifecycle, /@\(\$installFlag, "\/D=\$installRoot"\).*candidate_installer/);
  assert.match(lifecycle, /DisplayVersion -ne \$ExpectedVersion/);
  assert.match(lifecycle, /HKEY_CURRENT_USER/);
  assert.match(lifecycle, /installed_update_truncated_stage/);
  assert.match(lifecycle, /installed_truncated_stage_rejected/);
  assert.match(lifecycle, /desktop-windows-update-test\.mts/);
  assert.match(lifecycle, /ValidateSet\('official', 'embedded'\)/);
  assert.equal((lifecycle.match(/if \(\$RendererTransport -eq 'embedded'\)/g) ?? []).length, 2);
  assert.equal((lifecycle.match(/desktop-windows-embedded-preflight\.mts/g) ?? []).length, 2);
  assert.match(lifecycle, /\$rendererArguments \+= @\('--transport', \$RendererTransport\)/);
  assert.match(lifecycle, /installed_renderer_reconciled/);
  assert.match(lifecycle, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT = "1"/);
  assert.match(
    lifecycle,
    /Copy-Item -LiteralPath \$rendererEvidence -Destination \$retainedRendererEvidence -Recurse/,
  );
  assert.match(lifecycle, /installed_update_selection_stage/);
  assert.match(lifecycle, /--portcove-qualify-update-stage/);
  assert.match(lifecycle, /-- prepare-staged \$InstalledUpdatePredecessorVersion/);
  const rehearsal = await readFile(
    new URL("./rehearse-updater-artifacts.ps1", import.meta.url),
    "utf8",
  );
  assert.match(
    rehearsal,
    /--bundles", "nsis"[^\n]*"application-update-qualification,native-compatibility-qualification"/,
  );
  assert.match(rehearsal, /-RendererUpdate -RendererTransport embedded/);
  // A DMG-only Tauri build creates the bootstrap disk image but does not return
  // an app bundle target for updater archive/signature generation.
  assert.match(rehearsal, /else \{ "app,dmg" \}/);
  assert.match(
    rehearsal,
    /\$expectedMachOArchitecture = if \(\$PlatformLabel -eq "macos-x86_64"\) \{ "x86_64" \} else \{ "arm64" \}/,
  );
  assert.match(
    rehearsal,
    /\$expectedProcessArchitecture = if \(\$PlatformLabel -eq "macos-x86_64"\) \{ "X64" \} else \{ "Arm64" \}/,
  );
  assert.match(
    rehearsal,
    /\$native\.process_architecture -ne \$expectedProcessArchitecture[\s\S]*\$native\.executable_architecture = \(& lipo -archs \$executable \| Out-String\)\.Trim\(\)[\s\S]*\$native\.executable_architecture -ne \$expectedMachOArchitecture/,
  );
  assert.match(rehearsal, /test-linux-appimage-update\.ps1/);
  assert.match(rehearsal, /desktop-appimage-update-test\.mts/);
  assert.match(
    rehearsal,
    /-InstalledUpdatePredecessorVersion \$predecessorVersion -RendererUpdate/,
  );
  assert.match(rehearsal, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD = \$candidate/);
  const macInstalled = await readFile(
    new URL("./test-macos-installed-selection.ps1", import.meta.url),
    "utf8",
  );
  assert.match(macInstalled, /--portcove-qualify-update-stage/);
  assert.match(macInstalled, /payload length mismatch/);
  assert.match(macInstalled, /previous_candidate/);
  assert.match(macInstalled, /staged_payload_sha256/);
  assert.match(
    rehearsal,
    /Move-RehearsalInput \$bundleRoot \$qualifiedBundleName[\s\S]*\$qualifiedApp = Join-Path \$runRoot[\s\S]*test-macos-installed-selection\.ps1/,
  );
  assert.match(
    rehearsal,
    /\$qualifiedBundleName = "qualified-\$predecessorVersion-bundles"[\s\S]*Move-RehearsalInput \$bundleRoot \$qualifiedBundleName[\s\S]*\$predecessor = Join-Path \$runRoot[\s\S]*Invoke-Checked "dbus-run-session"/,
  );
  assert.match(rehearsal, /-PredecessorVersion/);
  assert.match(rehearsal, /-CandidateVersion/);
  assert.match(rehearsal, /application-update-qualification/);
  assert.match(rehearsal, /private_signing_inputs_absent/);
  assert.match(
    rehearsal,
    /-PayloadPrivateKeyPath \$privateKey -TufPrivateRootPath \(Join-Path \$fixtureRoot "private"\) -RequireSigningAuthorityAbsent/,
  );
  assert.match(rehearsal, /windows-payload-consumer\.json/);
  assert.match(rehearsal, /\$PlatformLabel-payload-consumer\.json/);
  assert.match(
    rehearsal,
    /\$qualifiedApp = Join-Path \$runRoot[\s\S]*Invoke-PackagedPayloadConsumer -Stage \$candidateStage -CandidateVersion \$candidateVersion -TufPrivateRootPath[\s\S]*test-macos-installed-selection\.ps1/,
  );
  assert.doesNotMatch(rehearsal, /Invoke-PackagedPayloadConsumer -Stage \$stage/);
  assert.match(rehearsal, /verify_packaged_application_update/);
  assert.match(rehearsal, /name = "missing-signature"/);
  assert.match(
    rehearsal,
    /error = "\^authenticated update identity is invalid: Tauri signature\$"/,
  );
  assert.match(rehearsal, /name = "wrong-signature"/);
  assert.match(rehearsal, /name = "valid-signature"/);
  assert.match(rehearsal, /wrong_signature_verified_with_distinct_key = \$true/);
  assert.match(rehearsal, /Remove-Item -LiteralPath \$wrongPrivateRoot -Recurse -Force/);
  const outerFinally = rehearsal.match(
    /} finally \{\r?\n(?<body>(?:    [^\r\n]*\r?\n)+)}\r?\nif\(\$captureFixtureDerivation\)\{/,
  );
  assert.ok(outerFinally?.groups?.body);
  assert.match(
    outerFinally.groups.body,
    /\[IO\.Directory\]::Exists\(\$wrongPrivateRoot\)[^\r\n]*\[IO\.Directory\]::Delete\(\$wrongPrivateRoot, \$true\)/,
  );
  assert.match(
    rehearsal,
    /\$script:wrongPassword = \[Guid\]::NewGuid\(\)\.ToString\("N"\)[\s\S]*"generate", "--ci", "--password", \$script:wrongPassword, "--write-keys", \$wrongPrivateKey[\s\S]*Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue[\s\S]*Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue[\s\S]*Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue[\s\S]*"sign", "--private-key-path", \$wrongPrivateKey, "--password", \$script:wrongPassword, \$wrongCandidate[\s\S]*\$script:wrongPassword = \$null/,
  );
  assert.doesNotMatch(rehearsal, /"--private-key-path", \$wrongPrivateKey, "--password", ""/);
  assert.match(rehearsal, /wrong_payload_password = \$null -eq \$script:wrongPassword/);
  const windowsConsumer = rehearsal.indexOf("verify_packaged_application_update");
  const windowsHarness = rehearsal.indexOf("test-windows-installer.ps1");
  const windowsPrivateKeyRemoval = rehearsal.lastIndexOf(
    "Remove-Item -LiteralPath $privateKey -Force",
    windowsHarness,
  );
  const windowsPrivateKeyEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue",
    windowsHarness,
  );
  const windowsPrivateKeyPathEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue",
    windowsHarness,
  );
  const windowsPasswordEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue",
    windowsHarness,
  );
  assert.ok(
    windowsConsumer >= 0 && windowsConsumer < windowsHarness,
    "packaged payload rejection and positive controls must precede Windows installation",
  );
  assert.ok(
    windowsPrivateKeyRemoval >= 0 && windowsPrivateKeyRemoval < windowsConsumer,
    "the disposable payload private key must be removed before Windows consumer execution",
  );
  const windowsWrongPrivateRootRemoval = rehearsal.lastIndexOf(
    "Remove-Item -LiteralPath $wrongPrivateRoot -Recurse -Force",
    windowsConsumer,
  );
  assert.ok(
    windowsWrongPrivateRootRemoval >= 0 && windowsWrongPrivateRootRemoval < windowsConsumer,
    "the wrong-signature private key root must be removed before Windows consumer execution",
  );
  assert.ok(
    windowsHarness >= 0 &&
      windowsPrivateKeyRemoval >= 0 &&
      windowsPrivateKeyRemoval < windowsHarness,
    "the disposable payload private key must be removed before Windows package execution",
  );
  assert.ok(
    windowsPrivateKeyEnvironmentRemoval >= 0 &&
      windowsPrivateKeyPathEnvironmentRemoval >= 0 &&
      windowsPasswordEnvironmentRemoval >= 0 &&
      windowsPrivateKeyEnvironmentRemoval < windowsHarness &&
      windowsPrivateKeyPathEnvironmentRemoval < windowsHarness &&
      windowsPasswordEnvironmentRemoval < windowsHarness,
    "the Tauri signing environment must be removed before Windows package execution",
  );
  assert.match(rehearsal, /Remove-Item -LiteralPath \(Join-Path \$fixtureRoot "private"\)/);
  assert.match(rehearsal, /Remove-Item -LiteralPath \$privateKey -Force/);
  const windowsConsumerExample = await readFile(
    new URL(
      "../apps/desktop/src-tauri/examples/verify_packaged_application_update.rs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(windowsConsumerExample, /ApplicationUpdateStagingStore::new/);
  assert.match(windowsConsumerExample, /store\.stage\(&mut payload, &candidate, &key\)\.await/);
  assert.match(windowsConsumerExample, /rejected packaged payload retained staged authority/);
  assert.match(windowsConsumerExample, /staged payload does not match the verified inventory/);
  const linuxConsumer = rehearsal.indexOf('Invoke-Checked "dbus-run-session"');
  const linuxPrivateKeyRemoval = rehearsal.lastIndexOf(
    "Remove-Item -LiteralPath $privateKey -Force",
    linuxConsumer,
  );
  const linuxPrivateKeyEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue",
    linuxConsumer,
  );
  const linuxPrivateKeyPathEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue",
    linuxConsumer,
  );
  const linuxPasswordEnvironmentRemoval = rehearsal.lastIndexOf(
    "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue",
    linuxConsumer,
  );
  assert.ok(
    linuxConsumer >= 0 && linuxPrivateKeyRemoval >= 0 && linuxPrivateKeyRemoval < linuxConsumer,
    "the disposable payload private key must be removed before consumer execution",
  );
  assert.ok(
    linuxPrivateKeyEnvironmentRemoval >= 0 &&
      linuxPrivateKeyPathEnvironmentRemoval >= 0 &&
      linuxPasswordEnvironmentRemoval >= 0 &&
      linuxPrivateKeyEnvironmentRemoval < linuxConsumer &&
      linuxPrivateKeyPathEnvironmentRemoval < linuxConsumer &&
      linuxPasswordEnvironmentRemoval < linuxConsumer,
    "the Tauri signing environment must be removed before consumer execution",
  );
  const linuxHarness = await readFile(
    new URL("./test-linux-appimage-update.ps1", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(linuxHarness, /WEBKIT_DISABLE_COMPOSITING_MODE/);
  assert.match(linuxHarness, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE/);
  assert.match(linuxHarness, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT/);
  assert.match(linuxHarness, /& \$stable --portcove-qualify-update-stage \$truncatedCandidate/);
  assert.match(linuxHarness, /& \$stable --portcove-qualify-update-stage \$candidate/);
  assert.match(linuxHarness, /-- prepare-staged \$PredecessorVersion/);
  assert.match(rehearsal, /wrong-disposable\.key/);
  assert.match(rehearsal, /repository\/missing-payload-signature/);
  assert.match(rehearsal, /repository\/wrong-payload-signature/);
  assert.match(rehearsal, /repository\/recovery/);
  assert.match(
    rehearsal,
    /name = "recovery"; records = "records"; output = "repository\/recovery"; top_level_version = 2; delegated_version = 1/,
  );
  assert.match(rehearsal, /Remove\("tauri_signature"\)/);
  assert.doesNotMatch(
    rehearsal,
    /Where-Object \{ \$_\.kind -eq "promotion" -and \$_\.release_path/,
  );
  assert.match(rehearsal, /if \(\$promotion\.release_path -eq \$releaseRecord\.path\)/);
  assert.match(rehearsal, /\$boundPromotion\.document\.release_sha256 = \$releaseRecord\.sha256/);
  assert.match(linuxHarness, /payload_signature_failures/);
  assert.match(linuxHarness, /wrong_disposable_public_key_sha256/);
  assert.match(linuxHarness, /private_signing_inputs_absent/);
  assert.match(linuxHarness, /Payload private key must be absent before consumer execution/);
  assert.match(linuxHarness, /TUF private root must be absent before consumer execution/);
  assert.match(linuxHarness, /Tauri signing environment must be absent before consumer execution/);
  assert.match(linuxHarness, /recovery_role_versions/);
  assert.match(linuxHarness, /rootless_lifecycle/);
  assert.match(linuxHarness, /install_scope = "current-user-direct-file"/);
  assert.match(linuxHarness, /current_user_owned = \$true/);
  assert.match(linuxHarness, /update_desktop_entry_preserved/);
  assert.match(linuxHarness, /update_user_paths_preserved/);
  assert.match(linuxHarness, /uninstall_stable_removed/);
  assert.match(linuxHarness, /uninstall_desktop_entry_removed/);
  assert.match(linuxHarness, /uninstall_user_paths_preserved/);
  for (const marker of ["library", "game_files", "saves", "backups", "logs"]) {
    assert.match(linuxHarness, new RegExp(`\\b${marker}\\s*=`));
  }
  assert.match(linuxHarness, /Remove-Item -LiteralPath \$desktopEntry -Force/);
  assert.match(linuxHarness, /Remove-Item -LiteralPath \$stable -Force/);
  assert.ok(
    linuxHarness.indexOf("candidate-restart-complete") <
      linuxHarness.indexOf("rootless-update-preserved") &&
      linuxHarness.indexOf("rootless-update-preserved") <
        linuxHarness.indexOf("rootless-uninstall-complete") &&
      linuxHarness.indexOf("rootless-uninstall-complete") <
        linuxHarness.indexOf('Write-Evidence "complete"'),
    "the packaged update must complete before bounded rootless uninstall and final evidence",
  );
  assert.match(linuxHarness, /authenticated update record is malformed:\.\*tauri_signature/);
  assert.match(
    linuxHarness,
    /payload verification material is invalid: signature does not use the selected key or streaming format/,
  );
  assert.match(linuxHarness, /Assert-NoStagedAuthority/);
  assert.ok(
    linuxHarness.indexOf('Test-PayloadSignatureFailure "missing-payload-signature"') <
      linuxHarness.indexOf('Test-PayloadSignatureFailure "wrong-key-payload-signature"') &&
      linuxHarness.indexOf('Test-PayloadSignatureFailure "wrong-key-payload-signature"') <
        linuxHarness.indexOf("truncated-payload-preparing"),
    "packaged signature rejection and recovery must precede the existing payload/replacement path",
  );
  assert.match(linuxHarness, /truncated_payload_expected_bytes/);
  assert.match(linuxHarness, /truncated_payload_bytes/);
  assert.match(linuxHarness, /truncated_payload_exit_code/);
  assert.match(linuxHarness, /truncated_payload_rejected/);
  assert.match(linuxHarness, /truncated_payload_stable_preserved/);
  assert.match(linuxHarness, /truncated_payload_staging_empty/);
  assert.match(linuxHarness, /truncated_payload_data_preserved/);
  assert.match(linuxHarness, /\/usr\/bin\/truncate --size=-1/);
  assert.match(linuxHarness, /payload length mismatch/);
  assert.ok(
    linuxHarness.indexOf("truncated-payload-preparing") <
      linuxHarness.indexOf("truncated-payload-rejected") &&
      linuxHarness.indexOf("truncated-payload-rejected") <
        linuxHarness.indexOf('Write-Evidence "prepared"'),
    "truncated payload rejection must precede successful staging and replacement",
  );
  assert.match(linuxHarness, /interruption_exit_code/);
  assert.match(linuxHarness, /interruption_recovery_exit_code/);
  assert.match(linuxHarness, /interruption_recovery_display/);
  assert.match(linuxHarness, /interruption_recovered/);
  assert.match(linuxHarness, /incompatible_schema_version = 99/);
  assert.match(linuxHarness, /incompatible_schema_supported_version/);
  assert.match(linuxHarness, /incompatible_schema_exit_code/);
  assert.match(linuxHarness, /incompatible_schema_predecessor_restart_observed/);
  assert.match(linuxHarness, /incompatible_schema_state_preserved/);
  assert.match(linuxHarness, /read_only_state_enforced/);
  assert.match(linuxHarness, /read_only_state_exit_code/);
  assert.match(linuxHarness, /read_only_state_predecessor_restart_observed/);
  assert.match(linuxHarness, /read_only_state_preserved/);
  assert.match(linuxHarness, /read_only_state_write_restored/);
  assert.match(linuxHarness, /full_disk_state_enforced/);
  assert.match(linuxHarness, /full_disk_state_available_bytes/);
  assert.match(linuxHarness, /full_disk_state_exit_code/);
  assert.match(linuxHarness, /full_disk_state_predecessor_restart_observed/);
  assert.match(linuxHarness, /full_disk_state_preserved/);
  assert.match(linuxHarness, /full_disk_state_write_restored/);
  assert.match(linuxHarness, /full_appimage_filesystem_enforced/);
  assert.match(linuxHarness, /full_appimage_filesystem_available_bytes/);
  assert.match(linuxHarness, /full_appimage_filesystem_exit_code/);
  assert.match(linuxHarness, /full_appimage_filesystem_predecessor_restart_observed/);
  assert.match(linuxHarness, /full_appimage_filesystem_stable_preserved/);
  assert.match(linuxHarness, /full_appimage_filesystem_staging_preserved/);
  assert.match(linuxHarness, /full_appimage_filesystem_failed_revision/);
  assert.match(linuxHarness, /full_appimage_filesystem_retry_revision/);
  assert.match(linuxHarness, /full_appimage_filesystem_retryable_journal/);
  assert.match(linuxHarness, /full_appimage_filesystem_write_restored/);
  assert.match(linuxHarness, /fullAppImageStableModeAfter -ne \$fullAppImageStableMode/);
  assert.match(linuxHarness, /\$applyPath -Algorithm SHA256\)\.Hash -ne \$readOnlyApplyHash/);
  assert.match(linuxHarness, /native_replacement\.source_path -ne \$fullAppImageStable/);
  assert.match(linuxHarness, /native_replacement\.backup_path -ne \$fullAppImageSwap/);
  assert.match(linuxHarness, /fullAppImageRetryApply\.native_launch/);
  assert.match(linuxHarness, /appImageRetryEntryChanges\.Count -ne 0/);
  assert.match(linuxHarness, /runtime_contention_helper_blocked/);
  assert.match(linuxHarness, /runtime_contention_stable_preserved/);
  assert.match(linuxHarness, /runtime_contention_journal_preserved/);
  assert.match(linuxHarness, /post_exchange_exit_code/);
  assert.match(linuxHarness, /post_exchange_backup_preserved/);
  assert.match(linuxHarness, /post_exchange_reconciled/);
  assert.match(linuxHarness, /-ne 86/);
  assert.match(linuxHarness, /-ne 87/);
  assert.match(linuxHarness, /after-exchange-sync/);
  assert.match(linuxHarness, /--application-update-recovery recover interrupted-appimage/);
  assert.match(linuxHarness, /Remove-Item Env:DISPLAY/);
  assert.match(linuxHarness, /flock --shared 9/);
  assert.match(linuxHarness, /flock --exclusive --nonblock/);
  assert.match(linuxHarness, /chmod --recursive u-w/);
  assert.match(linuxHarness, /chmod \$entry\.Mode -- \$entry\.Path/);
  assert.match(linuxHarness, /restoredMode -ne \$entry\.Mode/);
  assert.match(linuxHarness, /\/usr\/bin\/mount -t tmpfs/);
  assert.match(linuxHarness, /\/usr\/bin\/dd if=\/dev\/zero/);
  assert.match(linuxHarness, /availableBytes -ne 0/);
  assert.match(linuxHarness, /\/usr\/bin\/umount -- \$Path/);
  assert.match(linuxHarness, /Mount-BoundedTmpfs/);
  assert.match(linuxHarness, /Set-BoundedFilesystemFull/);
  assert.match(linuxHarness, /Restore-BoundedFilesystemWrites/);
  assert.match(linuxHarness, /Dismount-BoundedTmpfs/);
  assert.match(linuxHarness, /\.ArgumentList\.Add\(\$argument\)/);
  assert.ok(
    linuxHarness.indexOf("incompatible-schema-preserved") <
      linuxHarness.indexOf("read-only-state-starting") &&
      linuxHarness.indexOf("read-only-state-starting") <
        linuxHarness.indexOf("read-only-state-preserved") &&
      linuxHarness.indexOf("read-only-state-preserved") <
        linuxHarness.indexOf("read-only-state-recovered") &&
      linuxHarness.indexOf("read-only-state-recovered") <
        linuxHarness.indexOf("full-disk-state-starting") &&
      linuxHarness.indexOf("full-disk-state-starting") <
        linuxHarness.indexOf("full-disk-state-preserved") &&
      linuxHarness.indexOf("full-disk-state-preserved") <
        linuxHarness.indexOf("full-disk-state-recovered") &&
      linuxHarness.indexOf("full-disk-state-recovered") <
        linuxHarness.indexOf("full-appimage-filesystem-starting") &&
      linuxHarness.indexOf("full-appimage-filesystem-starting") <
        linuxHarness.indexOf("full-appimage-filesystem-preserved") &&
      linuxHarness.indexOf("full-appimage-filesystem-preserved") <
        linuxHarness.indexOf("full-appimage-filesystem-retryable") &&
      linuxHarness.indexOf("full-appimage-filesystem-retryable") <
        linuxHarness.indexOf("full-appimage-filesystem-recovered") &&
      linuxHarness.indexOf("full-appimage-filesystem-recovered") <
        linuxHarness.indexOf("runtime-contention-starting"),
    "read-only, full-state, and full-AppImage filesystems must fail closed before runtime contention and replacement",
  );
  assert.ok(
    linuxHarness.indexOf("incompatible-schema-starting") <
      linuxHarness.indexOf("incompatible-schema-preserved") &&
      linuxHarness.indexOf("incompatible-schema-preserved") <
        linuxHarness.indexOf("runtime-contention-starting"),
    "future apply schemas must fail closed before runtime contention and replacement",
  );
  assert.ok(
    linuxHarness.indexOf("command-recovery-starting") <
      linuxHarness.indexOf('Start-Process -FilePath "Xvfb"'),
    "interrupted AppImage recovery must complete before any GUI session starts",
  );
  assert.ok(
    linuxHarness.indexOf("$updateHelperStart.FileName = $stable") <
      linuxHarness.indexOf("runtime-contention-observed") &&
      linuxHarness.indexOf("runtime-contention-observed") <
        linuxHarness.indexOf("post-exchange-interrupted"),
    "a live runtime peer must block the packaged helper before replacement",
  );
  assert.ok(
    linuxHarness.indexOf(
      'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT = "after-exchange-sync"',
    ) < linuxHarness.indexOf("candidate-restart-complete"),
    "post-exchange interruption must precede candidate startup reconciliation",
  );
  const linuxAdapter = await readFile(
    new URL("../apps/desktop/src-tauri/src/application_update_linux.rs", import.meta.url),
    "utf8",
  );
  const launch = linuxAdapter.slice(
    linuxAdapter.indexOf("impl LinuxAppImageUpdateAdmission"),
    linuxAdapter.indexOf("/// Adds direct, user-owned AppImage replacement authority"),
  );
  assert.ok(
    launch.indexOf("sync_parent(&plan.source)") <
      launch.indexOf("interrupt_qualification_after_exchange_sync()") &&
      launch.indexOf("interrupt_qualification_after_exchange_sync()") <
        launch.indexOf("launch.record_succeeded()"),
    "post-exchange interruption must follow directory sync and precede journal success",
  );
  assert.match(linuxAdapter, /feature = "application-update-qualification"/);
  assert.match(linuxAdapter, /Some\(std::ffi::OsStr::new\("after-exchange-sync"\)\)/);
  assert.match(linuxAdapter, /std::process::exit\(87\)/);
  assert.match(rehearsal, /Invoke-Checked "dbus-run-session"/);
});

void test("updater workflow caller binds every platform and transition while preserving historical scope", async () => {
  const source = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  for (const contract of updaterWorkflowVariants(source, releaseLabels(policy))) {
    const profiles = ["legacy-adjacent", "legacy-skipped", "preview-final"];
    const scopes = [];
    for (const requested of ["all", ...releaseLabels(policy)])
      for (const profile of profiles)
        for (const historical of [false, true])
          scopes.push({
            requested,
            profile,
            historical,
            bindings: {
              "inputs.platform": requested,
              "inputs.transition_profile": profile,
              "inputs.historical_linux_bootstrap": String(historical),
            },
          });
    const decisions = observeHistoricalScope(contract.historicalScope.step, scopes);
    for (const [index, entry] of scopes.entries())
      assert.equal(
        decisions[index]?.admitted,
        !entry.historical ||
          (entry.requested === "linux-x86_64" && entry.profile !== "preview-final"),
        "UPDATER_HISTORICAL_SCOPE",
      );
    const offered = [];
    for (const label of releaseLabels(policy))
      for (const profile of profiles)
        for (const historical of [false, true]) {
          if (historical && (label !== "linux-x86_64" || profile === "preview-final")) continue;
          offered.push({
            label,
            profile,
            historical,
            bindings: {
              ["matrix." + contract.axis]: label,
              "inputs.transition_profile": profile,
              "inputs.historical_linux_bootstrap": String(historical),
            },
          });
        }
    const observations = observeUpdaterCaller(
      contract.rehearsal.step,
      "rehearse-updater-artifacts.ps1",
      offered,
    );
    assert.deepEqual(
      observations,
      offered.map(({ label, profile, historical }) => ({ platform: label, profile, historical })),
      "UPDATER_REHEARSAL_ARGUMENT_BINDING",
    );
  }
});

void test("updater workflow native driver calls consume the repository pins and public bootstrap flags", async () => {
  const source = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  for (const contract of updaterWorkflowVariants(source, releaseLabels(policy))) {
    assert.deepEqual(
      prerequisiteInvocation(String(contract.linuxPrerequisite.step.run)).toSorted(),
      ["--include-rpm", "--include-appimage-runtime", "--include-webdriver"].toSorted(),
      "UPDATER_LINUX_DEPENDENCIES",
    );
    const bootstrap = await readFile(
      new URL("../.config/tool-bootstrap.json", import.meta.url),
      "utf8",
    );
    const version = text(object(object(JSON.parse(bootstrap)).desktop).tauri_driver);
    const arguments_ = observeLinuxDriver(contract.linuxDriver.step, bootstrap);
    assert.deepEqual(arguments_.slice(0, 2), ["install", "tauri-driver"]);
    const options = arguments_.slice(2);
    assert.equal(options.length, 3);
    assert.equal(options.filter((value) => value === "--locked").length, 1);
    const at = options.indexOf("--version");
    assert.ok(at >= 0);
    assert.equal(options[at + 1], version, "UPDATER_PINNED_DRIVER_VERSION");
    const alternate = object(JSON.parse(bootstrap));
    object(alternate.desktop).tauri_driver = version === "0.0.1" ? "0.0.2" : "0.0.1";
    const alternativeArguments = observeLinuxDriver(
      contract.linuxDriver.step,
      JSON.stringify(alternate),
    );
    assert.equal(
      alternativeArguments[alternativeArguments.indexOf("--version") + 1],
      object(alternate.desktop).tauri_driver,
      "UPDATER_PIN_INPUT_CONSUMED",
    );
    assert.deepEqual(
      observeUpdaterCaller(contract.windowsDriver.step, "bootstrap-quality-tools.ps1", [
        { bindings: {} },
      ]),
      [{ desktop: true }],
      "UPDATER_WINDOWS_DESKTOP_BOOTSTRAP",
    );
  }
});

void test("packaged transition and evidence contracts execute exact profile semantics", () => {
  const rehearsalCases: {
    profile: string;
    platform?: string;
    expected: {
      profile: string;
      platform: string;
      predecessor_version: string;
      candidate_version: string;
      candidate_production_eligible: boolean;
    };
  }[] = [
    ...["windows-x86_64", "linux-x86_64", "macos-x86_64", "macos-aarch64"].map((platform) => ({
      profile: "legacy-adjacent",
      platform,
      expected: {
        profile: "legacy-adjacent",
        platform,
        predecessor_version: "0.1.0",
        candidate_version: "0.2.0",
        candidate_production_eligible: false,
      },
    })),
    {
      profile: "legacy-skipped",
      expected: {
        profile: "legacy-skipped",
        platform: "linux-x86_64",
        predecessor_version: "0.1.0",
        candidate_version: "0.3.0",
        candidate_production_eligible: false,
      },
    },
    {
      profile: "preview-final",
      platform: "linux-x86_64",
      expected: {
        profile: "preview-final",
        platform: "linux-x86_64",
        predecessor_version: "1.0.0-rc.2",
        candidate_version: "1.0.0",
        candidate_production_eligible: true,
      },
    },
    {
      profile: "preview-final",
      platform: "windows-x86_64",
      expected: {
        profile: "preview-final",
        platform: "windows-x86_64",
        predecessor_version: "1.0.0-rc.2",
        candidate_version: "1.0.0",
        candidate_production_eligible: true,
      },
    },
    {
      profile: "preview-final",
      platform: "macos-x86_64",
      expected: {
        profile: "preview-final",
        platform: "macos-x86_64",
        predecessor_version: "1.0.0-rc.2",
        candidate_version: "1.0.0",
        candidate_production_eligible: true,
      },
    },
    {
      profile: "preview-final",
      platform: "macos-aarch64",
      expected: {
        profile: "preview-final",
        platform: "macos-aarch64",
        predecessor_version: "1.0.0-rc.2",
        candidate_version: "1.0.0",
        candidate_production_eligible: true,
      },
    },
  ];
  for (const { profile, platform = "linux-x86_64", expected } of rehearsalCases) {
    const result = runPowerShellScript("./rehearse-updater-artifacts.ps1", [
      "-PlatformLabel",
      platform,
      "-TransitionProfile",
      profile,
      "-DescribeTransition",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      expected,
      `UPDATER_TRANSITION_METADATA:${platform}:${profile}`,
    );
  }

  const invalid = runPowerShellScript("./rehearse-updater-artifacts.ps1", [
    "-PlatformLabel",
    "windows-x86_64",
    "-TransitionProfile",
    "not-a-transition",
    "-DescribeTransition",
  ]);
  assert.equal(invalid.status, 1, "UPDATER_INVALID_PROFILE_REFUSAL");
  assert.match(invalid.stderr, /Cannot validate argument.*TransitionProfile/);

  const rehearsalPath = fileURLToPath(new URL("./rehearse-updater-artifacts.ps1", import.meta.url));
  const metadata = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference = 'Stop'
$command = Get-Command -Name '${rehearsalPath.replaceAll("'", "''")}'
$sets = @($command.Parameters['TransitionProfile'].Attributes | Where-Object { $_ -is [Management.Automation.ValidateSetAttribute] })
if ($sets.Count -ne 1) { throw 'Exactly one TransitionProfile validation set is required' }
ConvertTo-Json -InputObject @($sets[0].ValidValues) -Compress
`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(metadata.status, 0, `UPDATER_PROFILE_METADATA_COMPLETION: ${metadata.stderr}`);
  assert.deepEqual(
    array(JSON.parse(metadata.stdout)).map(text).sort(),
    ["legacy-adjacent", "legacy-skipped", "preview-final"],
    "UPDATER_PROFILE_ENUM",
  );

  const defaults = runPowerShellScript("./test-linux-appimage-update.ps1", ["-DescribeContract"]);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(
    JSON.parse(defaults.stdout),
    {
      schema_version: 15,
      predecessor_version: "0.1.0",
      candidate_version: "0.3.0",
    },
    "UPDATER_DEFAULT_EVIDENCE_CONTRACT",
  );

  const evidence = runPowerShellScript("./test-linux-appimage-update.ps1", [
    "-DescribeContract",
    "-PredecessorVersion",
    "1.0.0-rc.2",
    "-CandidateVersion",
    "1.0.0",
  ]);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.deepEqual(
    JSON.parse(evidence.stdout),
    {
      schema_version: 15,
      predecessor_version: "1.0.0-rc.2",
      candidate_version: "1.0.0",
    },
    "UPDATER_OVERRIDE_EVIDENCE_CONTRACT",
  );
});

void test(
  "Windows installer signing-authority guard executes before any process spawn",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-signing-authority-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const privateKey = path.join(root, "private.key");
    const removedPrivateKey = path.join(root, "removed-private.key");
    const tufPrivateRoot = path.join(root, "tuf-private");
    await writeFile(privateKey, "disposable private key fixture");
    await mkdir(tufPrivateRoot);
    const installer = path.join(text(process.env.SystemRoot), "System32", "where.exe");

    const environment = (signingAuthorityPresent: boolean, pathOnly = false) => {
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (
          name.toUpperCase() === "TAURI_SIGNING_PRIVATE_KEY" ||
          name.toUpperCase() === "TAURI_SIGNING_PRIVATE_KEY_PATH" ||
          name.toUpperCase() === "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
        )
          delete env[name];
      }
      if (signingAuthorityPresent) {
        env.TAURI_SIGNING_PRIVATE_KEY_PATH = privateKey;
        if (!pathOnly) {
          env.TAURI_SIGNING_PRIVATE_KEY = privateKey;
          env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "fixture-password";
        }
      }
      return env;
    };

    const runHarness = async (
      label: string,
      {
        requireAbsent,
        signingAuthorityPresent,
        pathOnly = false,
        tufAuthorityPresent = false,
      }: {
        requireAbsent: boolean;
        signingAuthorityPresent: boolean;
        pathOnly?: boolean;
        tufAuthorityPresent?: boolean;
      },
    ) => {
      const caseRoot = path.join(root, label);
      const evidencePath = path.join(caseRoot, "evidence.json");
      await mkdir(caseRoot);
      const args = [
        "-InstallerPath",
        installer,
        "-TestBase",
        path.join(caseRoot, "test-base"),
        "-EvidencePath",
        evidencePath,
        "-ProcessTimeoutSeconds",
        "10",
        "-CleanupTimeoutSeconds",
        "2",
      ];
      if (requireAbsent)
        args.push(
          "-PayloadPrivateKeyPath",
          signingAuthorityPresent && !pathOnly ? privateKey : removedPrivateKey,
          "-TufPrivateRootPath",
          tufAuthorityPresent ? tufPrivateRoot : path.join(root, "removed-tuf-private"),
          "-RequireSigningAuthorityAbsent",
        );
      const result = runPowerShellScript("./test-windows-installer.ps1", args, {
        env: environment(signingAuthorityPresent, pathOnly),
      });
      return { result, evidence: object(JSON.parse(await readFile(evidencePath, "utf8"))) };
    };

    const rejected = await runHarness("rejected", {
      requireAbsent: true,
      signingAuthorityPresent: true,
    });
    assert.equal(rejected.result.status, 1);
    assert.match(
      rejected.result.stderr.replace(/\s+/gu, " "),
      /Disposable signing authority is available to the Windows package lifecycle/,
    );
    assert.equal(rejected.evidence.phase, "signing_authority_checked");
    assert.deepEqual(rejected.evidence.private_signing_inputs_absent, {
      payload_private_key: false,
      tuf_private_root: true,
      signing_private_key_environment: false,
      signing_private_key_path_environment: false,
      signing_password_environment: false,
    });
    assert.deepEqual(rejected.evidence.process_runs, []);

    const pathOnlyRejected = await runHarness("path-only-rejected", {
      requireAbsent: true,
      signingAuthorityPresent: true,
      pathOnly: true,
    });
    assert.equal(pathOnlyRejected.result.status, 1);
    assert.match(
      pathOnlyRejected.result.stderr.replace(/\s+/gu, " "),
      /Disposable signing authority is available to the Windows package lifecycle/,
    );
    assert.deepEqual(pathOnlyRejected.evidence.private_signing_inputs_absent, {
      payload_private_key: true,
      tuf_private_root: true,
      signing_private_key_environment: true,
      signing_private_key_path_environment: false,
      signing_password_environment: true,
    });
    assert.deepEqual(pathOnlyRejected.evidence.process_runs, []);

    const tufRejected = await runHarness("tuf-root-rejected", {
      requireAbsent: true,
      signingAuthorityPresent: false,
      tufAuthorityPresent: true,
    });
    assert.equal(tufRejected.result.status, 1);
    assert.equal(
      object(tufRejected.evidence.private_signing_inputs_absent).tuf_private_root,
      false,
    );
    assert.deepEqual(tufRejected.evidence.process_runs, []);

    const accepted = await runHarness("accepted-positive-control", {
      requireAbsent: true,
      signingAuthorityPresent: false,
    });
    assert.equal(accepted.result.status, 1);
    assert.doesNotMatch(accepted.result.stderr, /signing authority/i);
    assert.deepEqual(accepted.evidence.private_signing_inputs_absent, {
      payload_private_key: true,
      tuf_private_root: true,
      signing_private_key_environment: true,
      signing_private_key_path_environment: true,
      signing_password_environment: true,
    });
    assert.equal(array(accepted.evidence.process_runs).length, 1);

    const compatibility = await runHarness("omitted-switch-compatibility", {
      requireAbsent: false,
      signingAuthorityPresent: true,
    });
    assert.equal(compatibility.result.status, 1);
    assert.doesNotMatch(compatibility.result.stderr, /signing authority/i);
    assert.equal("private_signing_inputs_absent" in compatibility.evidence, false);
    assert.equal(array(compatibility.evidence.process_runs).length, 1);
  },
);

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

void test("packaged AppImage JSON commands retain runtime diagnostics separately", async (t) => {
  const source = await readFile(
    new URL("./test-linux-appimage-update.ps1", import.meta.url),
    "utf8",
  );
  const statements = source
    .split(/\r?\n/u)
    .filter((line) =>
      /^\s+\$(?:selectionStderr|packagedSelectionOutput|stageStderr|stageOutput) = /u.test(line),
    );
  assert.equal(statements.length, 4);
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-appimage-streams-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const fixture = path.join(root, "fixture.cjs");
  await writeFile(
    fixture,
    `process.stderr.write("Portcove WebView runtime version: 2.52.6\\n");process.stdout.write(JSON.stringify({mode:process.argv[2],state:"update-available",version:"0.3.0"}));`,
  );
  const executable = path.join(root, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
  await writeFile(
    executable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  const script = path.join(root, "exercise.ps1");
  await writeFile(
    script,
    `$ErrorActionPreference='Stop'
$state=${quote(root)}
$stable=${quote(executable)}
$candidate='unused'
${statements.slice(0, 2).join("\n")}
$selectionExit=$LASTEXITCODE
${statements.slice(2).join("\n")}
$stageExit=$LASTEXITCODE
[ordered]@{ selection=($packagedSelectionOutput|ConvertFrom-Json); stage=($stageOutput|ConvertFrom-Json); selection_exit=$selectionExit; stage_exit=$stageExit; selection_stderr=[IO.File]::ReadAllText($selectionStderr); stage_stderr=[IO.File]::ReadAllText($stageStderr) }|ConvertTo-Json -Depth 4
`,
  );
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(observed));
  assert.ok(isRecord(observed.selection));
  assert.ok(isRecord(observed.stage));
  assert.equal(observed.selection.mode, "--portcove-qualify-update-selection");
  assert.equal(observed.stage.mode, "--portcove-qualify-update-stage");
  assert.equal(observed.selection_exit, 0);
  assert.equal(observed.stage_exit, 0);
  assert.match(text(observed.selection_stderr), /Portcove WebView runtime version: 2\.52\.6/u);
  assert.match(text(observed.stage_stderr), /Portcove WebView runtime version: 2\.52\.6/u);
});

void test("retained Linux reboot admits only its frozen independent mode and public evidence", async () => {
  const source = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  const contract = updaterWorkflow(source, releaseLabels(policy));
  const baseline = {
    PLATFORM: "linux-x86_64",
    PROFILE: "legacy-skipped",
    LINUX_RUNNER: "ubuntu-24.04",
    HISTORICAL: "false",
  };
  assert.equal(observeRetainedRebootScope(contract.retainedReboot.scope.step, baseline), 0);
  for (const [key, value] of Object.entries({
    PLATFORM: "all",
    PROFILE: "adjacent",
    LINUX_RUNNER: "ubuntu-26.04",
    HISTORICAL: "true",
  })) {
    assert.notEqual(
      observeRetainedRebootScope(contract.retainedReboot.scope.step, { ...baseline, [key]: value }),
      0,
    );
  }
  const mutations: ((workflow: Record<string, unknown>) => void)[] = [
    (w) => {
      object(object(object(w.on).workflow_dispatch).inputs).retained_reboot_only = {
        type: "boolean",
        default: true,
      };
    },
    (w) => {
      object(object(w.jobs)["linux-retained-reboot"]).if = "always()";
    },
    (w) => {
      object(object(w.jobs)["linux-retained-reboot"]).needs = "packages";
    },
    (w) => {
      object(object(w.jobs)["linux-retained-reboot"]).permissions = {
        contents: "read",
        actions: "write",
      };
    },
    (w) => {
      const steps = array(object(object(w.jobs)["linux-retained-reboot"]).steps);
      object(object(steps[3]).with).ref = "main";
    },
    (w) => {
      const steps = array(object(object(w.jobs)["linux-retained-reboot"]).steps);
      object(steps[12]).run = "python3 scripts/qualification/linux-reboot/controller.py";
    },
    (w) => {
      const steps = array(object(object(w.jobs)["linux-retained-reboot"]).steps);
      object(steps[13]).if = "success()";
    },
    (w) => {
      const steps = array(object(object(w.jobs)["linux-retained-reboot"]).steps);
      object(object(steps[14]).with).path = "work/";
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(contract.workflow);
    mutate(changed);
    assert.throws(
      () => updaterWorkflow(JSON.stringify(changed), releaseLabels(policy)),
      assert.AssertionError,
    );
  }
});
