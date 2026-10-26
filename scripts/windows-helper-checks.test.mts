import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildValidationPlan } from "./validation-plan.mts";
import {
  windowsHelperChecksRequired,
  windowsNativeToolsRequired,
} from "./windows-helper-checks.mts";
import { evaluateCiResults } from "./ci-result-gate.mts";
import { executableNodeCommands, parseNodeTestSuites } from "./node-test-suites.mts";

const sha = (character: string) => character.repeat(40);

void test(
  "release PowerShell help is inert and preserves the required installer input",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, mkdir, copyFile, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-release-help-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "scripts"));
    for (const name of [
      "package-local.ps1",
      "release-preflight.ps1",
      "test-windows-installer.ps1",
    ]) {
      const script = path.join(root, "scripts", name);
      await copyFile(new URL(`./${name}`, import.meta.url), script);
      for (const help of ["-Help", "--help"]) {
        const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, help], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        });
        assert.equal(result.status, 0, `${name} ${help}: ${result.stderr}`);
        assert.match(result.stdout, /Usage:/u);
        assert.match(result.stdout, /Example:/u);
        assert.equal(result.stderr, "");
      }
    }
    const installer = path.join(root, "scripts/test-windows-installer.ps1");
    const required = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", installer], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.notEqual(required.status, 0);
    assert.match(required.stderr, /InstallerPath/u);
    const falseHelp = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", installer, "-Help:$false"],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.notEqual(falseHelp.status, 0);
    // ConciseView can wrap the same error with a leading pipe at console width.
    const falseHelpMessage = falseHelp.stderr.replace(/\r?\n\s*\|\s*/gu, " ");
    assert.match(falseHelpMessage, /Provide -InstallerPath to run the test/u);
    const bindingProbe = path.join(root, "scripts/installer-binding-probe.ps1");
    const bindingScript = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${installer.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer parameters did not parse' }
# ParamBlock.Extent starts at param, excluding its CmdletBinding attributes.
# Keep the real header so DefaultParameterSetName and every prior binding survive.
$header = [IO.File]::ReadAllText('${installer.replaceAll("'", "''")}').Substring(0, $ast.ParamBlock.Extent.EndOffset)
$body = @'
$parameters = [ordered]@{}
foreach ($entry in $PSBoundParameters.GetEnumerator()) {
    $value = $entry.Value
    if ($value -is [Management.Automation.SwitchParameter]) { $value = [bool]$value }
    $parameters[$entry.Key] = $value
}
@{parameters=$parameters; parameter_set=$PSCmdlet.ParameterSetName} | ConvertTo-Json -Depth 4 -Compress
'@
[IO.File]::WriteAllText('${bindingProbe.replaceAll("'", "''")}', $header + [Environment]::NewLine + $body)
`;
    const prepared = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(bindingScript, "utf16le").toString("base64"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    // Before help added named parameter sets, PowerShell assigned these 28
    // positions in declaration order, excluding switches. Exercise all of them
    // through the actual -File surface with an inert body, including late fields.
    const positional = {
      InstallerPath: "candidate.exe",
      UpgradeFromInstallerPath: "predecessor.exe",
      ExpectedExecutablePath: "expected.exe",
      TestBase: "test-base",
      RetainedLibraryRoot: "retained-library",
      RetainExecutablePath: "retained.exe",
      EvidencePath: "evidence.json",
      NormalPackageManifestPath: "package-manifest.json",
      NormalPackageAdmissionPath: "package-admission.json",
      NativeAccountBindingPath: "account-binding.json",
      NativeAccountBindingSha256: "account-sha256",
      OrdinaryPublicUpdateInputsPath: "public-inputs.json",
      OrdinaryPublicUpdateInputsSha256: "public-sha256",
      OrdinaryPublicUpdateRemainingMilliseconds: 1000,
      InstallMode: "Passive",
      ExpectedVersion: "0.2.0",
      ExpectedPredecessorVersion: "0.1.0",
      ProcessTimeoutSeconds: 121,
      CleanupTimeoutSeconds: 16,
      PayloadPrivateKeyPath: "payload-key",
      TufPrivateRootPath: "tuf-root",
      InstalledUpdateTrustedRootPath: "trusted-root.json",
      InstalledUpdateMetadataPath: "metadata",
      InstalledUpdateTargetsPath: "targets",
      InstalledUpdateCandidatePath: "update-candidate.exe",
      InstalledUpdatePredecessorVersion: "0.0.9",
      RendererTransport: "embedded",
      TestFault: "post-spawn-verification",
    };
    const switches = {
      NativeParentOwnsFinish: true,
      QualifyPackageRollback: true,
      RequireSigningAuthorityAbsent: true,
      RendererUpdate: true,
    };
    const cases: [string[], Record<string, string | number | boolean>][] = [
      [Object.values(positional).map(String), positional],
      [
        [
          ...Object.entries(positional).flatMap(([name, value]) => [`-${name}`, String(value)]),
          ...Object.keys(switches).map((name) => `-${name}`),
        ],
        { ...positional, ...switches },
      ],
    ];
    for (const [args, expected] of cases) {
      const binding = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", bindingProbe, ...args],
        {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        },
      );
      assert.equal(binding.status, 0, binding.stderr);
      assert.deepEqual(JSON.parse(binding.stdout), { parameters: expected, parameter_set: "Run" });
    }
    assert.deepEqual(await readdir(root), ["scripts"]);
  },
);

void test(
  "packaging refusals name containment and a complete single forbidden entry while preserving prior output",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-package-copy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "scripts"));
    await copyFile(
      new URL("./package-local.ps1", import.meta.url),
      path.join(root, "scripts/package-local.ps1"),
    );
    await writeFile(
      path.join(root, "scripts/package-cli.ps1"),
      `param([string]$PlatformLabel, [string]$ProjectRoot, [string]$TargetRoot, [switch]$Force)
$archive = Join-Path $ProjectRoot 'fixture-cli.zip'
[IO.File]::WriteAllText($archive, 'inert archive')
$global:LASTEXITCODE = 0
$archive
`,
    );
    await writeFile(
      path.join(root, "scripts/smoke-test-cli-archive.ps1"),
      "param([string]$ArchivePath, [string]$PlatformLabel, [string]$Version)\n$global:LASTEXITCODE = 0\n",
    );
    const script = `
$ErrorActionPreference = 'Stop'
# Called scripts establish a different script scope. Keep mock state explicitly
# owned by this isolated fixture process instead of reading their $script: scope.
$global:PortcovePackagingUxFixture = @{
  output = $PSScriptRoot
  target = Join-Path $PSScriptRoot 'target'
  temporary = Join-Path $PSScriptRoot 'temporary'
  store = Join-Path $PSScriptRoot 'store'
}
function node {
  $global:LASTEXITCODE = 0
  if ($args[0] -like '*dev-storage.mts') {
    $state = $global:PortcovePackagingUxFixture
    @{output_root=$state.output; target_directory=$state.target; temporary_directory=$state.temporary; pnpm_store=$state.store} | ConvertTo-Json -Compress
  }
}
function cargo { $global:LASTEXITCODE = 0 }
function tar {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq '-a') { [IO.File]::WriteAllText($args[2], 'inert temporary archive') }
  elseif ($args[0] -eq '-tf') { './.git/private-state' }
  else { throw 'Unexpected tar action' }
}
function Refusal([string]$expected) {
  $message = $null
  try { & (Join-Path $PSScriptRoot 'scripts/package-local.ps1') -Version 0.1.0 }
  catch { $message = $_.Exception.Message }
  if (-not $message -or $message -notlike "*$expected*") { throw "Expected '$expected'; received '$message'" }
  $message
}
Refusal 'inside, but not equal to'
$global:PortcovePackagingUxFixture.output = Join-Path $PSScriptRoot '../outside-packaging'
Refusal 'PORTCOVE_OUTPUT_DIR'
$global:PortcovePackagingUxFixture.output = Join-Path $PSScriptRoot 'packages'
$state = $global:PortcovePackagingUxFixture
$null = [IO.Directory]::CreateDirectory($state.output)
$null = [IO.Directory]::CreateDirectory((Join-Path $state.target 'release/bundle/nsis'))
[IO.File]::WriteAllText((Join-Path $state.target 'release/bundle/nsis/Portcove_0.1.0_x64-setup.exe'), 'inert installer')
$source = Join-Path $state.output 'portcove-0.1.0-source.zip'
[IO.File]::WriteAllText($source, 'prior usable source archive')
Refusal './.git/private-state'
if ([IO.File]::ReadAllText($source) -cne 'prior usable source archive') { throw 'Prior source archive changed' }
if ([IO.File]::Exists((Join-Path $state.output 'portcove-0.1.0-source.next.zip'))) { throw 'Rejected temporary archive remains' }
`;
    const fixture = path.join(root, "fixture.ps1");
    await writeFile(fixture, script);
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", fixture], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /item that must not be packaged: \.\/\.git\/private-state\./u);
    assert.match(result.stdout, /Check the configured storage paths and archive exclusions/u);
  },
);

void test(
  "release preflight failures preserve the child code, actual command, tag, and caller environment",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-preflight-copy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "apps/desktop"), { recursive: true });
    await copyFile(
      new URL("./release-preflight.ps1", import.meta.url),
      path.join(root, "scripts/release-preflight.ps1"),
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@1.0.0" }),
    );
    const script = `
$ErrorActionPreference = 'Stop'
$previousTemp = $env:TEMP
$previousStore = $env:pnpm_config_store_dir
# Functions are invoked from release-preflight.ps1's script scope. This state is
# deliberately global only inside the disposable fixture process.
$global:PortcovePreflightUxFixture = @{root=$PSScriptRoot; phase='metadata'}
function pnpm {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq '--version') { '1.0.0' }
}
function node {
  $global:LASTEXITCODE = 0
  $state = $global:PortcovePreflightUxFixture
  if ($args[0] -like '*dev-storage.mts') {
    @{output_root=(Join-Path $state.root 'packages'); target_directory=(Join-Path $state.root 'target'); temporary_directory=(Join-Path $state.root 'temporary'); pnpm_store=(Join-Path $state.root 'store')} | ConvertTo-Json -Compress
  }
  elseif ($args[0] -eq '--test') {
    if ($state.phase -eq 'tests') { $global:LASTEXITCODE = 17 }
  }
  elseif ($args[0] -like '*check-release-metadata.mts') {
    if ($state.phase -eq 'metadata') { $global:LASTEXITCODE = 23 }
  }
  else { throw 'A later command ran after the failed gate' }
}
function just {
  if ($global:PortcovePreflightUxFixture.phase -ne 'audit') { throw 'Audit ran after a failed gate' }
  $global:LASTEXITCODE = 29
}
foreach ($phase in @('tests', 'metadata', 'audit')) {
  $global:PortcovePreflightUxFixture.phase = $phase
  $message = $null
  try { & (Join-Path $PSScriptRoot 'scripts/release-preflight.ps1') -Tag v0.1.0 }
  catch { $message = $_.Exception.Message }
  if (-not $message) { throw 'Failed gate was accepted' }
  if ($env:TEMP -ne $previousTemp -or $env:pnpm_config_store_dir -ne $previousStore) { throw 'Caller environment was not restored' }
  $message
}
`;
    const fixture = path.join(root, "fixture.ps1");
    await writeFile(fixture, script);
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", fixture], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tests failed with exit code 17\. Command: node --test/u);
    assert.match(
      result.stdout,
      /check failed with exit code 23\. Command: node '[^\r\n]+' --tag 'v0\.1\.0'\./u,
    );
    assert.match(result.stdout, /audit failed with exit code 29\. Command: just audit --fresh\./u);
  },
);

void test(
  "installer responsive-window refusal retains evidence and the forced-cleanup failure state",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const installer = fileURLToPath(new URL("./test-windows-installer.ps1", import.meta.url));
    const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${installer.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer script did not parse' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-ApplicationSmoke' }, $true))
if ($functions.Count -ne 1) { throw 'Smoke function is absent or ambiguous' }
Invoke-Expression $functions[0].Extent.Text
$script:clock = 0
$script:disposed = $false
$script:stopped = $false
$nativeAccount = $null
$runRoot = 'retained-fixture-evidence'
$evidence = @{phase='candidate_smoke'}
$script:run = @{}
$script:process = [pscustomobject]@{HasExited=$false; Responding=$false; MainWindowTitle=''; Id=123}
$script:process | Add-Member ScriptMethod Refresh {}
$script:process | Add-Member ScriptMethod Dispose {$script:disposed=$true}
function Start-JournaledProcess { @{process=$script:process; run=$script:run} }
function Start-Sleep {}
function Get-Date { $script:clock += 31; [datetime]::new(2026, 1, 1).AddSeconds($script:clock) }
function Stop-Process { $script:stopped=$true; $script:process.HasExited=$true }
function Write-InstallerEvidence {}
$message = $null
try { Invoke-ApplicationSmoke 'inert-application' 'candidate_smoke' }
catch { $message = $_.Exception.Message }
if (-not $script:stopped -or -not $script:disposed -or $script:run.status -cne 'forced_termination') { throw 'Owned cleanup failure state changed' }
$message
`;
    const output = execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.match(output, /The installed app did not open a responsive Portcove window\./u);
    assert.match(output, /retained-fixture-evidence before retrying/u);
  },
);

void test(
  "next observation preserves marker bytes, partial effects and exclusive handoff",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-observation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const operator = fileURLToPath(new URL("./prepare-semantic-observation.ps1", import.meta.url));
    const launcher = fileURLToPath(new URL("./semantic-review-sandbox.ps1", import.meta.url));
    const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${operator.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'operator parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
if($functions.Count -ne 6){throw 'unexpected observation function surface'}
foreach($function in $functions){Invoke-Expression $function.Extent.Text}
$launchAst=[Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$handoff=@($launchAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-ObservationHandoff'},$true))
if($errors.Count -or $handoff.Count -ne 1){throw 'handoff unavailable'}
Invoke-Expression $handoff[0].Extent.Text
function Refuses([scriptblock]$action){$refused=$false;try{& $action|Out-Null}catch{$refused=$true};if(-not $refused){throw 'unsafe observation accepted'}}
$base='${root.replaceAll("'", "''")}';$script:serial=0
function Reset-Fixture {
 $script:serial++;$script:root=Join-Path $base "case-$script:serial";$null=[IO.Directory]::CreateDirectory($script:root)
 $script:active=Join-Path $script:root 'reviewer-active.json';$script:archive=Join-Path $script:root 'reviewer-active.semantic-isolation-MdzaNi.retained.json'
 [IO.File]::WriteAllText($script:active,'original evidence');$script:oldMarkerHash=(Get-FileHash $script:active).Hash.ToLowerInvariant()
 $script:image=Join-Path $script:root 'reviewer.vhd';[IO.File]::WriteAllText($script:image,'inert backing bytes')
 $script:mount=Join-Path $script:root 'data';$script:diskId='exact-disk';$script:volumeId='exact-volume'
 $script:imageState=[pscustomobject]@{ImagePath=$script:image;Size=536870912;FileSize=536871424;StorageType=2;Attached=$true;DevicePath='inert-device'}
 $script:disk=[pscustomobject]@{UniqueId=$script:diskId;Location=$script:image;Size=536870912;IsBoot=$false;IsSystem=$false;BusType='File Backed Virtual';PartitionStyle='GPT';IsReadOnly=$false;Path='provider-partition-id'}
 $script:reserved=[pscustomobject]@{Offset=17408;Size=16759808;DiskId=$script:disk.Path}
 $script:data=[pscustomobject]@{Offset=16777216;Size=520028160;DiskId=$script:disk.Path}
 $script:volume=[pscustomobject]@{Path=$script:volumeId;UniqueId=$script:volumeId;FileSystem='NTFS';FileSystemLabel='PortcoveSemantic';Size=520024064}
 $script:mounted=$script:volume.PSObject.Copy();$script:providerCalls=0;$script:throwAfterAttach=$false
 $script:intentPath=Join-Path $script:root 'privilege-observation-intent.json';$script:resultPath=Join-Path $script:root 'privilege-observation-result.json'
 $script:workspace=$script:root;$script:ExpectedSourceRevision='a'*40;$script:ownerSid='inert-owner'
 $script:configHash='c'*64;$script:nativeHash='d'*64;$script:launcherHash='e'*64;$script:qualifierHash='f'*64;$script:scriptHash='b'*64
 [IO.File]::WriteAllText((Join-Path $script:root 'completion-operation.lock'),'')
}
function Get-DiskImage {param($ImagePath,$ErrorAction) if($ImagePath -ne $script:image){throw 'wrong image'};$script:imageState}
function Get-Disk {param($UniqueId,$ErrorAction) if($UniqueId -ne $script:diskId){throw 'wrong opaque disk selection'};$script:disk}
function Get-Partition {param($Disk,$ErrorAction) if(-not [object]::ReferenceEquals($Disk,$script:disk)){throw 'wrong partition association'};$script:reserved;$script:data}
function Get-Volume {param($Partition,$FilePath,$ErrorAction) if($FilePath){if($FilePath -ne ($script:mount+'\\')){throw 'wrong mount'};$script:mounted}else{if(-not [object]::ReferenceEquals($Partition,$script:data)){throw 'wrong volume association'};$script:volume}}
function Mount-DiskImage {param($ImagePath,[switch]$NoDriveLetter,$ErrorAction)
 if(-not (Test-Path $script:intentPath) -or (Test-Path $script:active) -or -not (Test-Path $script:archive)){throw 'effect preceded durable intent/archive'}
 $script:providerCalls++;$script:imageState.Attached=$true;if($script:throwAfterAttach){throw 'ambiguous attachment response'}
}
function git {param($C,$Verb,$Arg,$Arg2) $global:LASTEXITCODE=0;if($Verb -eq 'rev-parse'){$script:ExpectedSourceRevision}}
Reset-Fixture;Confirm-ObservationMount
foreach($field in @('UniqueId','Location','IsBoot','IsSystem','Size','BusType','PartitionStyle','IsReadOnly')){
 Reset-Fixture;$script:disk.$field=$null;Refuses {Confirm-ObservationMount}
}
foreach($field in @('DiskId','Offset','Size')){Reset-Fixture;$script:data.$field=$null;Refuses {Confirm-ObservationMount}}
foreach($field in @('Path','UniqueId','FileSystem','FileSystemLabel','Size')){Reset-Fixture;$script:volume.$field=$null;Refuses {Confirm-ObservationMount}}
Reset-Fixture;$script:mounted.Path='other-volume';Refuses {Confirm-ObservationMount}
Reset-Fixture;$handle=[IO.File]::Open($active,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
try{Refuses {Archive-ObservationMarker}}finally{$handle.Dispose()}
Archive-ObservationMarker
if((Test-Path $active) -or [IO.File]::ReadAllText($archive) -ne 'original evidence'){throw 'old marker lost'}
Refuses {Archive-ObservationMarker}
Write-ObservationRecord $intentPath @{phase='first'};Refuses {Write-ObservationRecord $intentPath @{phase='replacement'}}
Refuses {Write-ObservationRecord $resultPath @{too_large=('x'*8193)}}
$operatorTry=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst] -and $_.Finally.Extent.Text.Contains('$gate.Dispose()')})
if($operatorTry.Count -ne 1){throw 'operator boundary missing'}
foreach($ambiguous in @($false,$true)){
 Reset-Fixture;$script:imageState.Attached=$false;$script:throwAfterAttach=$ambiguous;$Operation='Prepare'
 if($ambiguous){Refuses {Invoke-Expression (($operatorTry[0].Body.Statements|ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)}}else{Invoke-Expression (($operatorTry[0].Body.Statements|ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)|Out-Null}
 $result=Get-Content -Raw $resultPath|ConvertFrom-Json
 if($result.ready -eq $ambiguous -or $script:providerCalls -ne 1 -or -not $script:imageState.Attached -or $result.automatic_retry -or (Test-Path $active) -or -not (Test-Path $archive)){throw 'partial effect or readiness misrepresented'}
 if($ambiguous -and $result.provider_error -ne 'ambiguous attachment response'){throw 'original failure lost'}
 Refuses {Invoke-Expression (($operatorTry[0].Body.Statements|ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)}
 if($script:providerCalls -ne 1){throw 'automatic repeat'}
}
# Execute the real recovery branch with only its terminal exit omitted, so its
# resulting records can be asserted in this process. All provider effects are
# mocked; ordinary temporary files exercise the actual CreateNew transitions.
$recoverIf=$operatorTry[0].Body.Statements[0]
$recoverBody=($recoverIf.Clauses[0].Item2.Statements|Where-Object {$_ -isnot [Management.Automation.Language.ExitStatementAst]}|ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine
function Dismount-DiskImage {param($ImagePath,$ErrorAction)
 if($ImagePath -ne $image -or -not (Test-Path (Join-Path $root 'privilege-observation-recovery-intent.json')) -or -not (Test-Path $active)){throw 'detach without exclusive recovery intent/marker'}
 $script:providerCalls++;$script:imageState.Attached=$false;if($script:ambiguousDetach){throw 'ambiguous detach response'}
}
foreach($ambiguous in @($false,$true)){
 Reset-Fixture;$script:ambiguousDetach=$ambiguous
 Write-ObservationRecord $intentPath @{schema_version=1;operator_helper_sha256=$scriptHash;configuration_sha256=$configHash;owner_sid=$ownerSid;image=$image}
 Archive-ObservationMarker
 Invoke-Expression $recoverBody|Out-Null
 $recovered=Get-Content -Raw (Join-Path $root 'privilege-observation-recovery-result.json')|ConvertFrom-Json
 if(-not $recovered.detached_observed -or -not $recovered.markers_retained -or -not $recovered.backing_file_retained -or $recovered.automatic_retry -or $script:providerCalls -ne 1){throw 'actual recovery effects lost'}
 if($ambiguous -and $recovered.provider_error -ne 'ambiguous detach response'){throw 'ambiguous response replaced by success'}
 Refuses {Invoke-Expression $recoverBody}
 if($script:providerCalls -ne 1){throw 'repeated recovery effect'}
}
Reset-Fixture
Write-ObservationRecord $intentPath @{schema_version=1;operator_helper_sha256=$scriptHash;configuration_sha256=$configHash;owner_sid=$ownerSid;image=$image}
Archive-ObservationMarker;[IO.File]::WriteAllText($active,'new fixture ownership')
Refuses {Invoke-Expression $recoverBody}
if($script:providerCalls -or (Test-Path (Join-Path $root 'privilege-observation-recovery-intent.json'))){throw 'recovery crossed new fixture ownership'}
# Exercise the actual launcher gate using the retained real old marker bytes in
# an ordinary temporary directory; no native profile/storage operations occur.
Reset-Fixture
# Keep hosted tests self-contained: the old marker is an intentionally fixed
# fixture whose exact bytes are supplied alongside this test below.
$markerBytes=[Convert]::FromBase64String('__MARKER_BASE64__')
[IO.File]::WriteAllBytes($archive,$markerBytes)
$record=@{schema_version=1;owner_sid=$ownerSid;source_revision=('a'*40);image=$image;configuration_sha256=$configHash;native_helper_sha256=$nativeHash;launcher_sha256=$launcherHash;qualifier_sha256=$qualifierHash;operator_helper_sha256=$scriptHash;ready=$true;provider_error=$null;readback_error=$null}
function Open-Gate {Open-ObservationHandoff $root $configHash $nativeHash $launcherHash $scriptHash $qualifierHash $ownerSid}
$legacy=Open-Gate
try{
 Refuses {[IO.File]::Open((Join-Path $root 'completion-operation.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 # A preparation arriving after the legacy intent check cannot enter its lock,
 # so it cannot archive/attach while this launcher retains legacy ownership.
 if(Test-Path $intentPath){throw 'legacy fixture unexpectedly has intent'}
}finally{$legacy.Dispose()}
Write-ObservationRecord $intentPath $record;Refuses {Open-Gate}
Write-ObservationRecord $resultPath $record
$held=Open-Gate
try{Refuses {Open-Gate};Refuses {[IO.File]::Open((Join-Path $root 'completion-operation.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}}finally{$held.Dispose()}
foreach($field in @('owner_sid','source_revision','image','configuration_sha256','native_helper_sha256','launcher_sha256','qualifier_sha256','operator_helper_sha256','ready','provider_error','readback_error')){
 $bad=$record.Clone();$bad[$field]=if($field -eq 'ready'){$false}else{'wrong'}
 [IO.File]::WriteAllText($resultPath,($bad|ConvertTo-Json));Refuses {Open-Gate}
}
[IO.File]::WriteAllText($resultPath,($record|ConvertTo-Json))
Write-ObservationRecord (Join-Path $root 'privilege-observation-recovery-intent.json') @{claimed=$true};Refuses {Open-Gate}
@{provider_calls='mocked only';marker='byte preserved';partial_attach='retained, no retry';handoff='exclusive and identity bound'}|ConvertTo-Json -Compress
`;
    const marker = await readFile(
      new URL("./fixtures/semantic-review-MdzaNi-marker.json.txt", import.meta.url),
    );
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(
          script.replace("__MARKER_BASE64__", marker.toString("base64")),
          "utf16le",
        ).toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      provider_calls: "mocked only",
      marker: "byte preserved",
      partial_attach: "retained, no retry",
      handoff: "exclusive and identity bound",
    });
  },
);

void test(
  "suspended storage preflight refuses unknown access and always reverts a verified entry",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const helper = fileURLToPath(
      new URL("./fixtures/semantic-review-appcontainer.cs.txt", import.meta.url),
    ).replaceAll("'", "''");
    const source = await readFile(
      new URL("./fixtures/semantic-review-appcontainer.cs.txt", import.meta.url),
      "utf8",
    );
    const preflight = source.indexOf(
      "result.Storage=ObserveStorage(token,profile,storagePaths,stdout,cwd)",
    );
    const resume = source.indexOf('Require(ResumeThread(pi.thread)!=UInt32.MaxValue,"resume")');
    assert.ok(preflight > 0 && resume > preflight);
    assert.match(source, /if\(!result.Storage.Passed\)result.ForcedTermination=true/u);
    assert.match(source, /if\(!result.ForcedTermination\)\s*\{\s*Require\(ResumeThread/u);
    assert.match(source, /if\(result.ForcedTermination\)Require\(TerminateJobObject\(job,1\)/u);
    const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${helper}'))
Add-Type -TypeDefinition 'public static class StorageLookupFixture { public static System.Action Prepare(System.Action record,bool fail) { return ()=>{record();if(fail)throw new System.ComponentModel.Win32Exception(1314,"inert lookup refusal");}; } }'
function New-Paths {
 [PortcoveReviewContainer+StorageObservation[]]@(0..4|ForEach-Object {[PortcoveReviewContainer+StorageObservation]@{Path="C:\\inert\\directory$_";Sddl='O:SYD:(A;;FA;;;SY)'}})
}
function Invoke-Case([string]$kind) {
 $script:prepared=0;$script:entered=0;$script:verified=0;$script:observed=0;$script:reverted=0
 $paths=New-Paths
 $paths[0].BrokerAttributes=16;$paths[0].BrokerMetadataError=0
 if($kind -eq 'broker-denied'){$paths[0].BrokerMetadataError=5}
 if($kind -eq 'broker-unknown'){$paths[0].BrokerAttributes=$null}
 if($kind -eq 'broker-file'){$paths[0].BrokerAttributes=128}
 if($kind -eq 'bad-path'){$paths[0].Path='relative'}
 if($kind -eq 'oversized'){$paths[0].Sddl='x'*4097}
 if($kind -eq 'descriptor'){$paths[0].DescriptorError=5;$paths[0].Sddl=$null}
 if($kind -match '^descriptor-([1-4])$'){$paths[[int]$Matches[1]].DescriptorError=5;$paths[[int]$Matches[1]].Sddl=$null}
 $script:kind=$kind
 $prepare=[StorageLookupFixture]::Prepare([Action]{
  if($script:entered -or $script:verified -or $script:observed){throw 'lookup entered reviewer scope'}
  $script:prepared++
 },($kind -eq 'prepare-failed'))
 $result=[PortcoveReviewContainer]::CheckStorage($paths,[Func[bool]]{$script:entered++;$script:kind -ne 'enter-failed'},[Func[bool]]{$script:verified++;$script:kind -ne 'identity'},[Action[PortcoveReviewContainer+StorageObservation[]]]{param($rows)
  $script:observed++
  if($script:kind -eq 'throw'){throw 'inert metadata failure'}
  foreach($p in $rows){$p.Attributes=16}
  if($script:kind -eq 'root-denied'){$rows[0].Attributes=$null;$rows[0].MetadataError=5}
  if($script:kind -eq 'root-unknown'){$rows[0].Attributes=$null}
  if($script:kind -match '^child-([1-4])$'){$rows[[int]$Matches[1]].Attributes=$null;$rows[[int]$Matches[1]].MetadataError=5}
  if($script:kind -eq 'actual-denials'){foreach($p in $rows){$p.Attributes=$null;$p.MetadataError=5}}
  if($script:kind -eq 'denied'){$rows[2].Attributes=$null;$rows[2].MetadataError=5}
  if($script:kind -eq 'unknown'){$rows[2].Attributes=$null}
  if($script:kind -eq 'file'){$rows[2].Attributes=128}
 },[Func[bool]]{$script:reverted++;$script:kind -ne 'revert-failed'},$prepare)
 if($result.Passed -ne ($kind -in @('pass','root-denied','root-unknown'))){throw "incorrect acceptance: $kind"}
 $expectedPrepare=if($kind -in @('bad-path','oversized')){0}else{1}
 $expectedEnter=if($kind -in @('bad-path','oversized','prepare-failed')){0}else{1}
 $expectedRevert=if($kind -in @('bad-path','oversized','prepare-failed','enter-failed')){0}else{1}
 $expectedVerify=if($kind -in @('bad-path','oversized','prepare-failed','enter-failed')){0}else{1}
 $expectedObserve=if($kind -in @('bad-path','oversized','prepare-failed','enter-failed','identity')){0}else{1}
 if($script:prepared -ne $expectedPrepare){throw 'broker preparation count differs'}
 if($script:entered -ne $expectedEnter -or $script:verified -ne $expectedVerify -or $script:reverted -ne $expectedRevert -or $script:observed -ne $expectedObserve){throw "incorrect ownership flow: $kind"}
 if($kind -eq 'denied' -and $result.Paths[2].MetadataError -ne 5){throw 'native refusal lost'}
 if($kind -eq 'revert-failed' -and $result.Reverted){throw 'failed revert described as complete'}
 if($kind -eq 'prepare-failed' -and $result.NativeErrorCode -ne 1314){throw 'native error code lost'}
}
foreach($kind in @('pass','bad-path','oversized','prepare-failed','enter-failed','identity','descriptor','denied','unknown','file','throw','revert-failed','broker-unknown','broker-file','broker-denied','descriptor-1','descriptor-2','descriptor-3','descriptor-4','root-denied','root-unknown','child-1','child-2','child-3','child-4','actual-denials')){Invoke-Case $kind}
@{cases=26;native_processes=0;storage_operations=0}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), { cases: 26, native_processes: 0, storage_operations: 0 });
  },
);

void test(
  "storage preflight capture preserves teardown and keeps descriptors out of the recovery receipt",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-storage-capture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = fileURLToPath(
      new URL("./semantic-review-sandbox.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failure'}
$functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-StoragePreflightCapture'},$true))
if($functions.Count -ne 1){throw 'production capture helper missing'}
Invoke-Expression $functions[0].Extent.Text
$root='${root.replaceAll("'", "''")}'
$null=New-Item -ItemType Directory -Path (Join-Path $root 'capture')
$process=[pscustomobject]@{TreeEmpty=$true;ForcedTermination=$true;ReviewerResumed=$false;ExitCode=$null;Storage=[pscustomobject]@{Passed=$false;IdentityVerified=$true;Reverted=$true;BypassTraverseEnabled=$false;Error='inert refusal';NativeErrorCode=1314;Paths=@(0..4|ForEach-Object {[pscustomobject]@{Path="C:\\inert\\directory$_";Sddl=('x'*800);Attributes=$null;MetadataError=5;DescriptorError=0}})}}
$summary=Write-StoragePreflightCapture $root $process
if(-not $summary.TreeEmpty -or -not $summary.ForcedTermination -or $summary.ReviewerResumed -or $summary.Storage.Passed -or -not $summary.Storage.Reverted){throw 'refusal/teardown state lost'}
$capturePath=Join-Path $root 'capture/storage-preflight.json'
if((Get-FileHash -LiteralPath $capturePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $summary.Storage.CaptureSha256){throw 'capture hash differs'}
$capture=Get-Content -Raw -LiteralPath $capturePath|ConvertFrom-Json
if($capture.preflight.Paths.Count -ne 5 -or $capture.preflight.Paths[0].Sddl.Length -ne 800 -or $summary.Storage.Paths[0].PSObject.Properties.Name -contains 'Sddl' -or $capture.preflight.NativeErrorCode -ne 1314 -or $summary.Storage.NativeErrorCode -ne 1314){throw 'descriptor/error evidence/summary scope wrong'}
$isolation=@{process=$summary;profile_deleted=$true;cleanup_errors=@()}|ConvertTo-Json -Depth 7
if([Text.Encoding]::UTF8.GetByteCount($isolation) -ge 16384){throw 'recovery receipt exceeds helper bound'}
$hash=(Get-FileHash -LiteralPath $capturePath -Algorithm SHA256).Hash
$refused=$false;try{$null=Write-StoragePreflightCapture $root $process}catch{$refused=$true}
if(-not $refused -or (Get-FileHash -LiteralPath $capturePath -Algorithm SHA256).Hash -ne $hash){throw 'prior capture overwritten'}
$null=New-Item -ItemType Directory -Path (Join-Path $root 'oversized/capture')
$process.Storage.Paths[0].Sddl='x'*40000
$refused=$false;try{$null=Write-StoragePreflightCapture (Join-Path $root 'oversized') $process}catch{$refused=$true}
if(-not $refused -or (Test-Path -LiteralPath (Join-Path $root 'oversized/capture/storage-preflight.json'))){throw 'oversized capture was written'}
@{preserved_teardown=$true;bound_capture=$true;recovery_receipt_bounded=$true;overwrite_refused=$true;oversized_refused=$true;native_operations=0}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      preserved_teardown: true,
      bound_capture: true,
      recovery_receipt_bounded: true,
      overwrite_refused: true,
      oversized_refused: true,
      native_operations: 0,
    });
  },
);
const plan = (oldPath: string, newPath = oldPath, status = "M") =>
  buildValidationPlan({
    changes: [
      {
        oldPath,
        newPath,
        status,
        oldMode: "100644",
        newMode: status === "D" ? "000000" : "100644",
      },
    ],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
void test("native tool inputs retain affected Windows proof without frontend installation", () => {
  for (const file of [
    "apps/desktop/scripts/desktop-artwork-observations.mts",
    "apps/desktop/scripts/desktop-artwork-observations.native.test.mts",
    "apps/desktop/src/cli-command.ts",
    "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    "apps/desktop/scripts/desktop-install-fixture.native.test.mts",
    "apps/desktop/scripts/cli-command-shell.native.test.mts",
    "scripts/dev-storage.mts",
    "scripts/tool-cache.mts",
  ]) {
    for (const selected of [
      plan(file),
      plan(file, "docs/moved.md", "R100"),
      plan(file, file, "D"),
    ]) {
      assert.equal(windowsNativeToolsRequired(selected), true, file);
      assert.equal(windowsHelperChecksRequired(selected), true, file);
    }
  }
  assert.equal(windowsNativeToolsRequired(plan("apps/desktop/src/App.tsx")), false);
  assert.equal(
    windowsNativeToolsRequired({ ...plan("apps/desktop/src/App.tsx"), mode: "qualification" }),
    true,
  );
});

void test("Windows helper selection includes rename/delete sides and policy inputs without changing Rust selection", () => {
  for (const file of [
    "scripts/release-local-worker-accounts.ps1",
    "scripts/release-local-worker-accounts.test.mts",
    "scripts/recover-local-worker-empty-setup.ps1",
    "scripts/resume-local-worker-profile.ps1",
    "scripts/recover-local-worker-empty-setup.test.mts",
    "scripts/release-native-account-capability.mts",
    "scripts/release-native-account-capability.test.mts",
    "scripts/native-qualification-account-client.mts",
    "scripts/native-qualification-account-client.ps1",
    "scripts/native-qualification-account-bridge.ps1",
    "scripts/native-qualification-account.cs.txt",
    "scripts/fixtures/native-account-gui-probe.ps1",
    "scripts/daily-discovery-session.mts",
    "scripts/daily-discovery.test.mts",
    "apps/desktop/scripts/native-window-discovery.ps1",
    "apps/desktop/scripts/desktop-native-confirmation.mts",
    "apps/desktop/scripts/browser-script.mts",
    "apps/desktop/scripts/browser-readiness.mts",
    "scripts/runtime-values.mts",
    "apps/desktop/scripts/desktop-test.mts",
    "scripts/frontend-command-preflight.mts",
    "scripts/viteplus-cli.mts",
    "scripts/desktop-verify.mts",
    ".github/workflows/ci.yml",
    ".config/powershell-resources.psd1",
  ]) {
    assert.equal(windowsHelperChecksRequired(plan(file)), true);
    assert.equal(windowsHelperChecksRequired(plan(file, "docs/moved-helper.md", "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan("docs/moved-helper.md", file, "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan(file, file, "D")), true);
  }
  for (const file of [
    "docs/README.md",
    "apps/desktop/src/App.tsx",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/src/library.rs",
  ])
    assert.equal(windowsHelperChecksRequired(plan(file)), false);
  const broad = plan("new-unknown-tool.xyz");
  assert.equal(windowsHelperChecksRequired(broad), true);
  assert(broad.groups.includes("rust"));
  assert.equal(windowsHelperChecksRequired({ ...broad, mode: "qualification" }), false);
});
void test("catalog aggregate rejects absent or failed selected Windows producer", () => {
  const input = {
    classifier: "success",
    plan: plan("scripts/desktop-verify.mts"),
    group: "catalog",
    prose: "skipped",
    fast: { fast_catalog: "success" },
    qualification: { catalog_full: "skipped" },
  };
  for (const status of [undefined, "skipped", "failure", "cancelled", "timed_out", ""])
    assert.throws(
      () =>
        evaluateCiResults({
          ...input,
          targeted: status === undefined ? {} : { windows_helpers: status },
        }),
      /windows_helpers.*expected success/,
    );
  assert.match(
    evaluateCiResults({ ...input, targeted: { windows_helpers: "success" } }),
    /Accepted fast/,
  );
  assert.throws(
    () =>
      evaluateCiResults({
        ...input,
        plan: plan("crates/portcove-core/catalog/catalog.json"),
        targeted: { windows_helpers: "success" },
      }),
    /expected skipped/,
  );
});
void test("workflow runs bounded Windows controls and pinned lint under the existing catalog aggregate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const windows = workflow.split("\n  windows_helpers:\n")[1];
  assert.ok(windows, "Windows helpers job must exist");
  const job = windows.split("\n  fast_catalog:")[0];
  assert.ok(job);
  assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /timeout-minutes: 10/);
  assert.match(job, /outputs.windows_helpers == 'true'/);
  assert.match(job, /--test-timeout=30000/);
  assert.match(job, /--test-concurrency=1/);
  assert.match(job, /native-confirmation.test.mts/);
  assert.match(job, /native-helper-dependencies.mts/);
  assert.match(job, /Import-PowerShellDataFile -LiteralPath .config\/powershell-resources.psd1/);
  assert.match(job, /Import-Module -Name PSScriptAnalyzer -RequiredVersion/);
  assert.match(job, /lint-tools.integration.mts psscriptanalyzer/);
  assert.doesNotMatch(
    job,
    /cargo (?:build|test)|desktop-verify.mts|desktop:build|bootstrap.*Desktop|native-driver|setup-vp|pnpm install/,
  );
  assert.match(
    job,
    /uses: \.\/\.github\/actions\/setup-rust\n\s+if: needs.classify.outputs.native_tools == 'true'/,
  );
  const registry = parseNodeTestSuites(
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const native = executableNodeCommands(job, registry).filter(
    (command) => command.id === "native-tools",
  );
  assert.equal(native.length, 1);
  assert.deepEqual(native[0]?.arguments, [
    "--test",
    "--test-timeout=30000",
    "--test-reporter=./scripts/required-node-test-reporter.mts",
  ]);
  const catalogSection = workflow.split("\n  catalog:\n")[1];
  assert.ok(catalogSection, "catalog aggregate must exist");
  const catalog = catalogSection.split("\n  fast_dependency_review:")[0];
  assert.ok(catalog);
  assert.match(
    catalog,
    /needs: \[classify, prose_checks, fast_catalog, windows_helpers, catalog_full\]/,
  );
  assert.match(
    catalog,
    /PORTCOVE_TARGETED_RESULTS: '\{"windows_helpers":"\$\{\{ needs.windows_helpers.result \}\}"\}'/,
  );
  assert.equal((catalog.match(/PORTCOVE_TARGETED_RESULTS:/gu) ?? []).length, 1);
});

void test(
  "semantic storage accepts the observed Windows bus type and refuses unsafe disk associations",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const helper = fileURLToPath(
      new URL("./prepare-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'helper parse failed'}
$functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedDisk'},$true))
if($functions.Count -ne 1){throw 'exact production guard missing'}
foreach($command in $functions[0].FindAll({param($node)$node -is [Management.Automation.Language.CommandAst]},$true)){if($command.GetCommandName() -notin @('Get-DiskImage','Get-Disk')){throw 'guard contains an unexpected command'}}
Invoke-Expression $functions[0].Extent.Text
$image='X:/inert-only/reviewer.vhd'
$script:imageSet=@();$script:diskSet=@()
function Get-DiskImage {param($ImagePath,$ErrorAction) if($ImagePath -ne $image){throw 'wrong fixed path'};$script:imageSet}
function Get-Disk {param([Parameter(ValueFromPipeline=$true)]$InputObject) process{$script:diskSet}}
function Reset-Fixture {$script:imageSet=@([pscustomobject]@{Attached=$true});$script:diskSet=@([pscustomobject]@{UniqueId='observed-disk';Size=536870912;IsBoot=$false;IsSystem=$false;BusType='File Backed Virtual'})}
function Must-Refuse {try{$null=Get-OwnedDisk}catch{return};throw 'unsafe association was accepted'}
Reset-Fixture
if((Get-OwnedDisk).UniqueId -ne 'observed-disk'){throw 'observed provider representation was refused'}
$cases=1
foreach($change in @(@{UniqueId=''},@{Size=536870911},@{IsBoot=$true},@{IsSystem=$true},@{IsBoot=$null},@{IsSystem=$null},@{BusType='SATA'},@{BusType='Virtual'},@{BusType='FileBackedVirtual'})){
 Reset-Fixture
 foreach($key in $change.Keys){$script:diskSet[0].$key=$change[$key]}
 Must-Refuse;$cases++
}
Reset-Fixture;$script:imageSet[0].Attached=$false;Must-Refuse;$cases++
Reset-Fixture;$script:imageSet=@();Must-Refuse;$cases++
Reset-Fixture;$script:imageSet=@($script:imageSet[0],$script:imageSet[0]);Must-Refuse;$cases++
Reset-Fixture;$script:diskSet=@();Must-Refuse;$cases++
Reset-Fixture;$script:diskSet=@($script:diskSet[0],$script:diskSet[0]);Must-Refuse;$cases++
@{cases=$cases;mutations='none; extracted production guard with inert provider functions'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      cases: 15,
      mutations: "none; extracted production guard with inert provider functions",
    });
  },
);

void test(
  "semantic storage provisioning binds the returned partition object through its complete provider sequence",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const parent = await mkdtemp(path.join(tmpdir(), "portcove-storage-provider-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const helper = fileURLToPath(
      new URL("./prepare-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const root = path.join(parent, "owned").replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'helper parse failed'}
$guards=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-OwnedDisk'},$true))
$branches=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq "$"+"Operation -eq 'Provision'"},$true))
if($guards.Count -ne 1 -or $branches.Count -ne 1){throw 'exact production stages missing'}
$body=$branches[0].Clauses[0].Item2
foreach($command in $body.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)){
 if($command.GetCommandName() -notin @('Test-Path','New-Item','Set-Acl','Join-Path','diskpart.exe','Get-OwnedDisk','ConvertTo-Json','Set-Content','Initialize-Disk','New-Partition','Format-Volume','Add-PartitionAccessPath','Get-Content','Out-Null')){throw 'unexpected production command'}
}
Invoke-Expression $guards[0].Extent.Text
Invoke-Expression ('function Invoke-ProductionProvision '+$body.Extent.Text)
$root='${root}';$image=Join-Path $root 'reviewer.vhd';$mount=Join-Path $root 'data'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$ExpectedConfigurationSha256='a'*64
$script:disk=[pscustomobject]@{UniqueId='6002248094AE6EFC7984F0EC20A288AC';Path='provider-partition-disk-path';Size=536870912;IsBoot=$false;IsSystem=$false;BusType='File Backed Virtual';PartitionStyle='RAW'}
$script:partition=[pscustomobject]@{DiskId=$script:disk.Path;Offset=16777216}
$script:volume=[pscustomobject]@{Path='fixture-volume-guid';FileSystem='NTFS';Size=520024064}
$script:steps=[Collections.Generic.List[string]]::new()
function Get-DiskImage {param($ImagePath,$ErrorAction) if($ImagePath -ne $image){throw 'wrong image'};[pscustomobject]@{Attached=$true}}
function Get-Disk {param([Parameter(ValueFromPipeline=$true)]$InputObject) process{$script:disk}}
function Set-Acl {param($LiteralPath,$AclObject) if($LiteralPath -eq $root){$script:steps.Add('root-acl')}elseif($LiteralPath -eq $script:volume.Path){$script:steps.Add('volume-acl')}else{throw 'unexpected ACL target'}}
function diskpart.exe {param($s,$scriptFile) if($scriptFile -ne (Join-Path $root 'diskpart.txt')){throw 'wrong command file'};$script:steps.Add('attach');$global:LASTEXITCODE=0}
function Initialize-Disk {param($UniqueId,$PartitionStyle,$ErrorAction) if($UniqueId -ne $script:disk.UniqueId){throw 'wrong unique disk'};$script:steps.Add('initialize');$script:disk.PartitionStyle='GPT'}
function New-Partition {param($DiskId,[switch]$UseMaximumSize,$ErrorAction) if($DiskId -ne $script:disk.UniqueId){throw 'wrong partition input'};$script:steps.Add('partition');$script:partition}
function Format-Volume {param($Partition,$FileSystem,$NewFileSystemLabel,$Confirm,$ErrorAction) if(-not [object]::ReferenceEquals($Partition,$script:partition)){throw 'wrong format partition'};$script:steps.Add('format');$script:volume}
function Add-PartitionAccessPath {param($InputObject,$DiskId,$Offset,$AccessPath,$ErrorAction) if(-not [object]::ReferenceEquals($InputObject,$script:partition) -or $AccessPath -ne ($mount+'\\')){throw 'partition provider requires its returned object, not disk UniqueId'};$script:steps.Add('bind')}
$null=Invoke-ProductionProvision
$receipt=Get-Content -Raw -LiteralPath (Join-Path $root 'storage.json')|ConvertFrom-Json
if($receipt.disk_unique_id -ne $script:disk.UniqueId -or $receipt.volume_guid -ne $script:volume.Path -or $receipt.observed_volume_bytes -ne 520024064 -or $receipt.configuration_sha256 -ne $ExpectedConfigurationSha256){throw 'storage receipt differs'}
if(Test-Path -LiteralPath $image){throw 'inert provider test created an image'}
@{steps=@($script:steps);native_storage_calls=0;receipt='actual production branch'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      steps: ["root-acl", "attach", "initialize", "partition", "format", "bind", "volume-acl"],
      native_storage_calls: 0,
      receipt: "actual production branch",
    });
  },
);

void test(
  "retained storage completion verifies exact provider association and fresh mount readback",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const helper = fileURLToPath(
      new URL("./complete-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'completion parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Get-PreparedPartition','Connect-PreparedPartition')},$true))
if($functions.Count -ne 2){throw 'exact completion functions missing'}
foreach($function in $functions){
 foreach($command in $function.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)){
  if($command.GetCommandName() -notin @('Get-Partition','Where-Object','Get-Volume','Get-PreparedPartition','Add-PartitionAccessPath')){throw 'unexpected provider command'}
 }
 Invoke-Expression $function.Extent.Text
}
$mount='X:/inert-only/data';$script:disk=[pscustomobject]@{Path='partition-provider-id';UniqueId='physical-disk-id'}
function Reset-Fixture {
 $script:reserved=[pscustomobject]@{DiskId=$script:disk.Path;Offset=17408;Size=16759808}
 $script:data=[pscustomobject]@{DiskId=$script:disk.Path;Offset=16777216;Size=520028160;AccessPaths=@('fixture-volume-guid')}
 $script:volume=[pscustomobject]@{Path='fixture-volume-guid';UniqueId='fixture-volume-guid';FileSystem='NTFS';FileSystemLabel='PortcoveSemantic';Size=520024064}
 $script:binds=0;$script:omitReadback=$false
}
function Get-Partition {param($Disk,$ErrorAction) if(-not [object]::ReferenceEquals($Disk,$script:disk)){throw 'wrong disk object'};$script:reserved;$script:data}
function Get-Volume {param($Partition,$ErrorAction) if(-not [object]::ReferenceEquals($Partition,$script:data)){throw 'wrong volume association'};$script:volume}
function Add-PartitionAccessPath {param($InputObject,$AccessPath,$ErrorAction) if(-not [object]::ReferenceEquals($InputObject,$script:data) -or $AccessPath -ne ($mount+'\\')){throw 'wrong partition binding'};$script:binds++;if(-not $script:omitReadback){$script:data.AccessPaths+=($mount+'\\')}}
function Must-Refuse {try{$null=Connect-PreparedPartition $script:disk 'fixture-volume-guid'}catch{return};throw 'unsafe retained volume accepted'}
Reset-Fixture
if((Connect-PreparedPartition $script:disk 'fixture-volume-guid').Path -ne 'fixture-volume-guid' -or $script:binds -ne 1){throw 'valid retained volume refused'}
$cases=1
foreach($change in @(@{DiskId='physical-disk-id'},@{Offset=16777217},@{Size=520028159},@{AccessPaths=@('fixture-volume-guid','C:/unrelated/')})){
 Reset-Fixture;foreach($key in $change.Keys){$script:data.$key=$change[$key]};Must-Refuse;if($script:binds -ne 0){throw 'mutated before partition refusal'};$cases++
}
foreach($change in @(@{Path='other-volume'},@{UniqueId='other-volume'},@{FileSystem='FAT32'},@{FileSystemLabel='other-owner'},@{Size=520024065})){
 Reset-Fixture;foreach($key in $change.Keys){$script:volume.$key=$change[$key]};Must-Refuse;if($script:binds -ne 0){throw 'mutated before volume refusal'};$cases++
}
Reset-Fixture;$script:omitReadback=$true;Must-Refuse;if($script:binds -ne 1){throw 'ambiguous mount effect disappeared'};$cases++
@{cases=$cases;native_storage_calls=0;ambiguous_binding='retained; no automatic undo or retry'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      cases: 11,
      native_storage_calls: 0,
      ambiguous_binding: "retained; no automatic undo or retry",
    });
  },
);

void test(
  "completion and incomplete recovery share one exclusive operator boundary before attach",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-completion-lock-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = fileURLToPath(
      new URL("./complete-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'completion parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Open-CompletionOperationLock','Write-NewCompletionRecord')},$true))
if($functions.Count -ne 2){throw 'exact operator boundary missing'}
foreach($function in $functions){Invoke-Expression $function.Extent.Text}
$root='${root.replaceAll("'", "''")}'
$completion=Open-CompletionOperationLock $root
try{
 # Completion has persisted its intent, but has not reached the attach effect.
 Write-NewCompletionRecord (Join-Path $root 'completion-intent.json') @{phase='detached-before-completion'}
 $recovery=$null;$refused=$false
 try{$recovery=Open-CompletionOperationLock $root}catch{$refused=$true}finally{if($recovery){$recovery.Dispose()}}
 if(-not $refused){throw 'recovery entered while completion could still attach'}
}finally{$completion.Dispose()}
$settled=Open-CompletionOperationLock $root
try{
 # Recovery's sentinel and the launcher use the same CreateNew primitive. The
 # loser cannot start a reviewer or replace a preexisting ownership record.
 $marker=Join-Path $root 'reviewer-active.json'
 Write-NewCompletionRecord $marker @{kind='pre-fixture-completion-detach';fixture_started=$false}
 $launcher=$null;$refused=$false
 try{$launcher=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)}catch{$refused=$true}finally{if($launcher){$launcher.Dispose()}}
 if(-not $refused){throw 'launcher replaced recovery ownership'}
 try{Write-NewCompletionRecord $marker @{kind='replacement'};throw 'sentinel overwritten'}catch{if($_.Exception.Message -eq 'sentinel overwritten'){throw}}
}finally{$settled.Dispose()}
$locks=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains('$operationLock.Dispose()')},$true))
if($locks.Count -ne 1){throw 'operator lock not held to final readback'}
$commands=@($locks[0].Body.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object GetCommandName)
foreach($required in @('Mount-DiskImage','Dismount-DiskImage','Connect-PreparedPartition','Get-ExactImage')){if($required -notin $commands){throw 'mutation/readback escaped shared boundary'}}
@{live_completion='recovery refused';settled_completion='recovery lock acquired';recovery_marker='launcher refused';native_storage_calls=0}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      live_completion: "recovery refused",
      settled_completion: "recovery lock acquired",
      recovery_marker: "launcher refused",
      native_storage_calls: 0,
    });
  },
);
