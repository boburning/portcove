import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdtemp, writeFile, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import {
  captureActualWindowsNativeInvocation,
  requireActualWindowsNativeCapture,
  inspectWindowsNativeDriverResult,
  captureActualWindowsPublicJourney,
  requireActualWindowsPublicCapture,
} from "./release-native-windows-capture.mts";

void test("retained proof hashing handles empty streams and bounded raw preimages, refusing aliases and an expired original clock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-proof-"));
  try {
    await writeFile(path.join(directory, "empty.bin"), Buffer.alloc(0));
    const empty = await hashNativeCapturedFile(
      directory,
      "empty.bin",
      1,
      performance.now() + 10000,
    );
    assert.equal(empty.bytes, 0);
    assert.equal(empty.sha256, createHash("sha256").digest("hex"));
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    await writeFile(path.join(directory, "payload.bin"), bytes);
    const actual = await hashNativeCapturedFile(
      directory,
      "payload.bin",
      bytes.length,
      performance.now() + 10000,
    );
    assert.equal(actual.sha256, createHash("sha256").update(bytes).digest("hex"));
    await assert.rejects(
      hashNativeCapturedFile(directory, "payload.bin", 4 * 1024 * 1024, performance.now() + 10000),
    );
    await assert.rejects(
      hashNativeCapturedFile(directory, "missing.bin", 1, performance.now() - 1),
      /deadline exhausted/,
    );
    await link(path.join(directory, "payload.bin"), path.join(directory, "alias.bin"));
    await assert.rejects(
      hashNativeCapturedFile(directory, "payload.bin", bytes.length, performance.now() + 10000),
    );
  } finally {
    assert.ok(
      path.isAbsolute(directory) &&
        path.dirname(directory) === path.resolve(tmpdir()) &&
        path.basename(directory).startsWith("portcove-public-proof-"),
    );
    await rm(directory, { recursive: true });
  }
});

void test("copied public claims and captures cannot invoke the fixed Windows supervisor", async () => {
  await assert.rejects(
    captureActualWindowsPublicJourney({ phase: "initial-v0-v1" }),
    /actual freshly claimed public invocation/,
  );
  await assert.rejects(
    requireActualWindowsPublicCapture({ authority: "none" }),
    /actual fixed parent Windows public capture/,
  );
});

void test(
  "public Windows plan is a separate exact initial variant, without weakening pre-sign or publication selection",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_DRIVER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'driver parse failure'}
$function=@($ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ 'Assert-DriverStageSelection')
if($function.Count -ne 1){throw 'missing fixed driver selection'}
Invoke-Expression $function[0].Extent.Text
$plan=[ordered]@{schema_version=2;stage='ordinary-public-initial';journey=$null;predecessor=$null;boundary=@{};invocation_id='a'*64;request_sha256='b'*64;package=@{};tools=@{};version='0.1.0-beta.1';public_inputs=@{path='C:\capture\public-inputs.json';sha256='c'*64}}
Assert-DriverStageSelection ($plan|ConvertTo-Json -Depth 5|ConvertFrom-Json)
$park=$plan|ConvertTo-Json -Depth 5|ConvertFrom-Json;$park.stage='ordinary-public-park';Assert-DriverStageSelection $park
$original=$plan|ConvertTo-Json -Depth 5 -Compress
$refused=0
foreach($change in @({param($p)$p.stage='release-publication'},{param($p)$p.schema_version=1},{param($p)$p.predecessor=@{path='other'}},{param($p)$p.public_inputs.sha256='bad'},{param($p)$p|Add-Member -NotePropertyName accepted -NotePropertyValue $true})){
 $p=$original|ConvertFrom-Json;&$change $p
 try {Assert-DriverStageSelection $p}catch{$refused++}
}
if($refused -ne 5){throw 'public plan crossover accepted'}
Write-Output 'public-plan-contract-pass'
`;
    const result = spawnSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        env: {
          ...process.env,
          PORTCOVE_TEST_DRIVER: fileURLToPath(
            new URL("./release-native-windows-driver.ps1", import.meta.url),
          ),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /public-plan-contract-pass/u);
  },
);

void test(
  "package rollback assertion requires actual predecessor identity, launch and unchanged installer-time data",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'installer parse failure'}
$function=@($ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ 'Assert-NativePackageRollbackObservation')
if($function.Count -ne 1){throw 'missing package rollback assertion'}
Invoke-Expression $function[0].Extent.Text
$sha='a'*64;$sentinel='b'*64
$manifest=[ordered]@{library=@([ordered]@{path='portcove.sqlite3';bytes=123;sha256='c'*64});preferences=[ordered]@{present=$false}}
$inputValue=[ordered]@{install_exit_code=0;registered_version='0.1.0-beta.1';executable_sha256=$sha;registration_count=1;
smoke=[ordered]@{responding=$true;exit_code=0};database_present=$true;sentinel_sha256=$sentinel;
manifest_before_install=$manifest;manifest_after_install=$manifest}
Assert-NativePackageRollbackObservation $inputValue $sha '0.1.0-beta.1' $sentinel
$original=$inputValue|ConvertTo-Json -Depth 8 -Compress
$refused=0
foreach($case in @('version','hash','sentinel','database','missing-manifest','changed-manifest','exit','smoke')){
  $changed=$original|ConvertFrom-Json
  switch($case){
    'version' {$changed.registered_version='0.1.0-beta.2'}
    'hash' {$changed.executable_sha256='d'*64}
    'sentinel' {$changed.sentinel_sha256='d'*64}
    'database' {$changed.database_present=$false}
    'missing-manifest' {$changed.manifest_before_install=$null;$changed.manifest_after_install=$null}
    'changed-manifest' {$changed.manifest_after_install.library[0].sha256='d'*64}
    'exit' {$changed.install_exit_code=1}
    'smoke' {$changed.smoke.responding=$false}
  }
  try{Assert-NativePackageRollbackObservation $changed $sha '0.1.0-beta.1' $sentinel}catch{$refused++}
}
if($refused -ne 8){throw 'package rollback observation widened'}
[ordered]@{accepted=1;refused=$refused;scope='inert assertion only; no installer, rollback or account execution'}|ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_INSTALLER: fileURLToPath(
          new URL("./test-windows-installer.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      accepted: 1,
      refused: 8,
      scope: "inert assertion only; no installer, rollback or account execution",
    });
  },
);

void test("driver result distinguishes partial failure from complete child settlement and cannot mint capture provenance", async () => {
  const raw = {
    schema_version: 1,
    invocation_id: "a".repeat(64),
    request_sha256: "b".repeat(64),
    started_at: "2026-10-20T12:00:00.000Z",
    completed_at: "2026-10-20T12:00:01.000Z",
    failure: null,
    host_observation: null,
    finish_attempted: true,
    children: ["bridge", "harness"].map((role, index) => ({
      role,
      pid: 123 + index,
      created_filetime: "134000000000000000",
      exited: true,
      exit_code: 0,
    })),
    authority: "none",
    native_acceptance: "not-established",
  };
  const inspect = (value: unknown) =>
    inspectWindowsNativeDriverResult(value, raw.invocation_id, raw.request_sha256);
  assert.equal(inspect(raw).authority, "none");
  const failed = inspect({
    ...raw,
    failure: "actual failure retained",
    finish_attempted: false,
    children: [],
  });
  assert.equal(failed.failure, "actual failure retained");
  for (const changed of [
    { ...raw, invocation_id: "c".repeat(64) },
    { ...raw, request_sha256: "c".repeat(64) },
    { ...raw, children: raw.children.slice(0, 1) },
    { ...raw, children: [raw.children[0], raw.children[0]] },
    { ...raw, finish_attempted: false },
    {
      ...raw,
      children: raw.children.map((value) => ({ ...value, exited: false, exit_code: null })),
    },
    { ...raw, children: raw.children.map((value) => ({ ...value, created_filetime: "unknown" })) },
    { ...raw, completed_at: "2026-10-20T13:00:00.000Z" },
    { ...raw, native_acceptance: "passed" },
    { ...raw, accepted: true },
  ])
    assert.throws(() => inspect(changed));
  await assert.rejects(captureActualWindowsNativeInvocation({}), /actual freshly claimed/);
  await assert.rejects(requireActualWindowsNativeCapture({ ...raw }), /actual fixed parent/);
});

void test(
  "fixed native driver retains actual raw child prefixes and refuses invalid UTF8 or output overflow",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_DRIVER_FIXTURE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
foreach($name in @('Start-DriverChild','Save-DriverStreams')){
  $function=$ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name
  if(@($function).Count -ne 1){throw 'fixed driver function missing'}
  Invoke-Expression $function.Extent.Text
}
Add-Type -TypeDefinition (Get-Content -LiteralPath $env:PORTCOVE_DRIVER_HELPER -Raw)
$capture=Join-Path ([IO.Path]::GetTempPath()) ('native-driver-fixture-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($capture)|Out-Null
$planValue=[pscustomobject]@{tools=[pscustomobject]@{powershell=[pscustomobject]@{path=[Environment]::ProcessPath}}}
$boundary=[pscustomobject]@{controller_root=$capture}
$childEnvironment=@{SystemRoot=$env:SystemRoot;PATH=(Join-Path $env:SystemRoot 'System32')}
$children=[Collections.Generic.List[object]]::new();$refused=0
try{
  foreach($case in @('normal','invalid','overflow')){
    $command=switch($case){'normal' {'[Console]::Write("retained")'} 'invalid' {'[Console]::OpenStandardOutput().Write([byte[]]@(255),0,1)'} 'overflow' {'$b=[byte[]]::new(4194305);[Console]::OpenStandardOutput().Write($b,0,$b.Length)'}}
    $child=Start-DriverChild $case @('-NoProfile','-NonInteractive','-Command',$command);$children.Add($child)
    $clock=[Diagnostics.Stopwatch]::StartNew();$fault=$null
    try{
      do {Save-DriverStreams $child;if($clock.Elapsed.TotalSeconds -ge 15){throw 'fixture child deadline'};Start-Sleep -Milliseconds 25}while(-not $child.process.HasExited)
      foreach($stream in @($child.stdout,$child.stderr)){if(-not $stream.Completion.Wait(5000)){throw 'fixture stream deadline'}}
      Save-DriverStreams $child
    }catch{$fault=$_.Exception.Message;if(-not $child.process.HasExited){$child.process.Kill($true);$null=$child.process.WaitForExit(5000)};try{Save-DriverStreams $child}catch{}}
    if(-not $child.process.HasExited){throw 'fixture child not settled'}
    $bytes=[IO.File]::ReadAllBytes((Join-Path $capture ($case+'.stdout.bin')))
    if($case -eq 'normal'){if($fault -or [Text.Encoding]::UTF8.GetString($bytes) -cne 'retained'){throw 'normal direct bytes differ'}}
    else {if(-not $fault){throw 'invalid native output accepted'};$refused++;if($bytes.Length -ne $(if($case -eq 'invalid'){1}else{4194304})){throw 'failure prefix not retained'}}
  }
  [ordered]@{normal=1;refused=$refused;scope='actual inert child streams only; no native/account or task qualification'}|ConvertTo-Json -Compress
}finally{
  foreach($child in $children){if(-not $child.process.HasExited){$child.process.Kill($true);$null=$child.process.WaitForExit(5000)};$child.process.Dispose()}
  Remove-Item -LiteralPath $capture -Recurse -Force
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_DRIVER_FIXTURE: fileURLToPath(
          new URL("./release-native-windows-driver.ps1", import.meta.url),
        ),
        PORTCOVE_DRIVER_HELPER: fileURLToPath(
          new URL("./native-qualification-account.cs.txt", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      normal: 1,
      refused: 2,
      scope: "actual inert child streams only; no native/account or task qualification",
    });
  },
);

void test(
  "fixed driver admits only selected fresh initial or exact predecessor package stage without public updater flags",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_DRIVER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'driver parse failure'}
$function=@($ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ 'Assert-DriverStageSelection')
if($function.Count -ne 1){throw 'stage guard missing'}
Invoke-Expression $function[0].Extent.Text
$package=[ordered]@{bytes=123;sha256='a'*64}
$valid=@(
  [ordered]@{stage='payload-signing';journey=$null;predecessor=$null},
  [ordered]@{stage='release-publication';journey=[ordered]@{kind='initial-empty-feed'};predecessor=$null},
  [ordered]@{stage='release-publication';journey=[ordered]@{predecessor=[ordered]@{package=$package}};predecessor=$package}
)
foreach($value in $valid){$value['schema_version']=1;Assert-DriverStageSelection ($value|ConvertTo-Json -Depth 8|ConvertFrom-Json)}
$invalid=@(
  [ordered]@{stage='public-accepted';journey=$null;predecessor=$null},
  [ordered]@{stage='payload-signing';journey=[ordered]@{kind='initial-empty-feed'};predecessor=$null},
  [ordered]@{stage='release-publication';journey=$null;predecessor=$null},
  [ordered]@{stage='release-publication';journey=[ordered]@{kind='initial-empty-feed'};predecessor=$package},
  [ordered]@{stage='release-publication';journey=[ordered]@{predecessor=[ordered]@{package=$package}};predecessor=[ordered]@{bytes=124;sha256='a'*64}},
  [ordered]@{stage='release-publication';journey=[ordered]@{predecessor=[ordered]@{package=$package}};predecessor=[ordered]@{bytes=123;sha256='b'*64}}
)
$refused=0;foreach($value in $invalid){$value['schema_version']=1;try{Assert-DriverStageSelection ($value|ConvertTo-Json -Depth 8|ConvertFrom-Json)}catch{$refused++}}
if($refused -ne 6){throw 'native stage guard widened'}
[ordered]@{accepted=3;refused=6;scope='inert stage guard only'}|ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_DRIVER: fileURLToPath(
          new URL("./release-native-windows-driver.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      accepted: 3,
      refused: 6,
      scope: "inert stage guard only",
    });
  },
);
