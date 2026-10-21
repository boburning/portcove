import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureActualWindowsNativeInvocation,
  requireActualWindowsNativeCapture,
  inspectWindowsNativeDriverResult,
} from "./release-native-windows-capture.mts";

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
