import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeWindowsAccountCommand } from "./release-hosted-native-windows-observation.mts";

const script = fileURLToPath(new URL("./release-hosted-native-windows-setup.ps1", import.meta.url));
const primitive = fileURLToPath(
  new URL("./release-hosted-native-windows-setup.cs.txt", import.meta.url),
);
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const valid = {
  schema_version: 1,
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  binding: "c".repeat(64),
  broker_pid: 42,
  broker_created_ticks: "123456789",
  run_id: "123",
  run_attempt: 1,
};
void test("hosted account command accepts empty stderr and preserves operation failure when stream readback refuses", async (t) => {
  const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-command-test-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  const stderr = path.join(root, "account.stderr.bin");
  writeFileSync(stderr, "");
  const empty = await observeWindowsAccountCommand(root, 0, undefined, []);
  assert.equal(empty.status, 0);
  assert.equal(empty.resource_error, null);
  assert.deepEqual(empty.stderr, {
    observation: "read",
    bytes: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    prefix_base64: "",
    truncated: false,
  });
  rmSync(stderr);
  const missing = await observeWindowsAccountCommand(
    root,
    undefined,
    new Error("original operation refused"),
    ["retained record unavailable"],
  );
  assert.equal(missing.resource_error, "original operation refused");
  assert.deepEqual(missing.readback_failures, ["retained record unavailable"]);
  assert.equal(missing.stderr.observation, "refused");
  writeFileSync(stderr, Buffer.alloc(4 * 1024 * 1024 + 1));
  const oversized = await observeWindowsAccountCommand(
    root,
    125,
    new Error("original timeout"),
    [],
  );
  assert.equal(oversized.resource_error, "original timeout");
  assert.equal(oversized.stderr.observation, "refused");
});
function powershell(program: string, timeout = 15000) {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(program, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SystemDrive: process.env.SystemDrive,
      },
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

void test(
  "hosted adapter working directory and state environment satisfy the existing native launcher contract",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-launch-contract-"));
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
      rmSync(root, { recursive: true, force: true });
    });
    const launcher = fileURLToPath(
      new URL("./native-qualification-account.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}'))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$main=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
$statements=@($main.Body.Statements);$begin=-1;$end=-1
for($i=0;$i -lt $statements.Count;$i++){
 if($statements[$i].Extent.Text.StartsWith('$configuration=[Portcove.NativeQualification.AccountConfiguration]')){$begin=$i}
 if($statements[$i].Extent.Text.StartsWith('foreach($entry in')){$end=$i}
}
if($begin -lt 0 -or $end -lt $begin){throw 'Actual adapter configuration boundary absent'}
$root='${root.replaceAll("'", "''")}';$work=Join-Path $root 'work';$context=@{binding=('a'*64)};$attemptWork=Join-Path $work $context.binding
$roaming=Join-Path $attemptWork 'roaming';$local=Join-Path $attemptWork 'local';$nativeProfile='C:\Users\PortcoveNativeQual'
foreach($directory in @($work,$attemptWork,$roaming,$local)){[IO.Directory]::CreateDirectory($directory)|Out-Null}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent();$account=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'}}
. ([scriptblock]::Create(($statements[$begin..$end].Extent.Text -join [Environment]::NewLine)))
$launch=$ast.Find({param($n)$n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -ceq 'StartHostedVerifiedInGroup'},$true)
if($launch.Arguments.Count -ne 9){throw 'Existing launcher ABI differs'}
. ([scriptblock]::Create('$actualDirectory='+$launch.Arguments[6].Extent.Text))
$runtime=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
[Portcove.NativeQualification.AccountLauncher]::Validate($configuration,$runtime,@('-NoProfile'),$actualDirectory,$environment)
$refused=$false;try{[Portcove.NativeQualification.AccountLauncher]::Validate($configuration,$runtime,@('-NoProfile'),$work,$environment)}catch{$refused=$true}
if(-not $refused){throw 'Existing root-directory refusal was lost'}
'actual adapter composes with unchanged native launcher validation; no account launch'
`);
    assert.match(result, /no account launch/u);
  },
);

void test("hosted Windows setup parses its actual fixed context and refuses changed identity or attempts", () => {
  const cases = [
    { ...valid, extra: true },
    { ...valid, run_attempt: 2 },
    { ...valid, run_attempt: "1" },
    { ...valid, broker_pid: "42" },
    { ...valid, broker_pid: 0 },
    { ...valid, schema_version: "1" },
    { ...valid, source_commit: "A".repeat(40) },
    { ...valid, binding: "d".repeat(63) },
  ];
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Actual setup script parse failure'}
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-HostedNativeSetupContext'},$true)
& ([scriptblock]::Create($function.Extent.Text+";Read-HostedNativeSetupContext '${encoded(valid)}'"))|Out-Null
$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(cases)}'))|ConvertFrom-Json
foreach($case in $cases){
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($case|ConvertTo-Json -Compress)))
 $refused=$false;try{& ([scriptblock]::Create($function.Extent.Text+";Read-HostedNativeSetupContext '"+$payload+"'"))|Out-Null}catch{$refused=$true}
 if(-not $refused){throw 'Changed identity or attempt admitted'}
}
'actual context parser refusals passed'
`);
  assert.match(result, /actual context parser refusals passed/u);
});

void test("hosted Windows setup refuses an ordinary local caller before account or filesystem effects", () => {
  const result = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-ContextBase64", encoded(valid)],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
      windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_ACTIONS: "false" },
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only the fixed credential-free hosted tool diagnostic/u);
});

void test(
  "hosted Windows setup creates a fresh private directory atomically and never adopts retained bytes",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-setup-test-"));
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
      rmSync(root, { recursive: true, force: true });
    });
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root='${root.replaceAll("'", "''")}'
$private=Join-Path $root 'private'
[Portcove.HostedNative.Setup]::Directory($private,$owner,$null,$false)
$acl=Get-Acl -LiteralPath $private
if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner){throw 'Private directory owner/protection differs'}
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 2 -or @($rules|Where-Object {$_.IdentityReference.Value -notin @($owner,'S-1-5-18') -or $_.AccessControlType -ne 'Allow'}).Count){throw 'Private directory grants a foreign identity'}
[IO.File]::WriteAllText((Join-Path $private 'retained.txt'),'original bytes')
$refused=$false;try{[Portcove.HostedNative.Setup]::Directory($private,$owner,$null,$false)}catch{$refused=$true}
if(-not $refused -or [IO.File]::ReadAllText((Join-Path $private 'retained.txt')) -cne 'original bytes'){throw 'Retained directory was adopted or changed'}
$secret=[Portcove.HostedNative.Setup]::Password()
try{if($secret.Length -ne 68 -or -not $secret.IsReadOnly()){throw 'Generated credential format differs'}}finally{$secret.Dispose()}
'actual atomic private directory and in-memory credential bounds passed'
`);
    assert.match(result, /actual atomic private directory/u);
  },
);

void test(
  "hosted account cleanup still disables its exact identity after teardown fails and retains both outcomes",
  { timeout: 45000 },
  (t) => {
    const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-cleanup-test-"));
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
      rmSync(root, { recursive: true, force: true });
    });
    const result = powershell(
      String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Actual setup script parse failure'}
$write=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-HostedNativeSetupRecord'},$true)
. ([scriptblock]::Create($write.Extent.Text))
$export=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-HostedAuditRecovery'},$true);. ([scriptblock]::Create($export.Extent.Text))
$main=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($main.Count -ne 1){throw 'Actual cleanup boundary differs'}
$base='${root.replaceAll("'", "''")}';$nativeProfile='inert profile';$context=@{fixture='controlled-providers'}
foreach($failDisable in @($false,$true)){
$root=Join-Path $base ([string]$failDisable);[IO.Directory]::CreateDirectory($root)|Out-Null
$account=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'};Description='owned diagnostic';Enabled=$true}
$group=[pscustomobject]@{};$group|Add-Member ScriptMethod StopAndObserve {param($timeout)throw 'controlled group teardown failure'}
$group|Add-Member ScriptMethod Dispose {}
$child=[pscustomobject]@{Pid=42;CreatedFileTime=[long]123};$child|Add-Member ScriptMethod Dispose {}; $child|Add-Member ScriptMethod DrainHostedObserver {param($milliseconds)return $true}
$hostedDesktop=$null;$stationRestored=$null;$observerDrained=$null;$password=$null;$disabled=$false;$settled=$false;$failure='original observation refusal';$observation=$null
$actualProfile=$null;$registeredProfile=$null;$remaining=$null;$rootExited=$null
$cleanupFailures=[Collections.Generic.List[string]]::new()
function Get-LocalUser {param($SID)if($SID.Value -cne $account.SID.Value){throw 'Wrong cleanup SID'};return $account}
function Disable-LocalUser {param($SID)if($SID.Value -cne $account.SID.Value){throw 'Wrong disable SID'};if($failDisable){throw 'controlled disable failure'};$account.Enabled=$false}
. ([scriptblock]::Create(($main[0].Finally.Statements.Extent.Text -join [Environment]::NewLine)))
$record=Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw|ConvertFrom-Json
if($record.disabled -ne (-not $failDisable) -or $record.job_empty -or $record.failure -cne 'original observation refusal' -or
    @($record.cleanup_failures).Count -ne $(if($failDisable){2}else{1}) -or $record.cleanup_failures[0] -notmatch 'controlled group teardown failure' -or
    ($failDisable -and $record.cleanup_failures[1] -notmatch 'controlled disable failure') -or
    $null -ne $record.remaining_pids -or $null -ne $record.root_exited -or $record.root_identity.pid -ne 42){
    throw 'Actual cleanup lost the primary failure, skipped disabling or claimed settled effects'
}
}
'actual cleanup retains failure and independently disables exact account'
`,
      30000,
    );
    assert.match(result, /independently disables exact account/u);
  },
);

void test(
  "hosted setup checks original parent generation and deadline before its first directory effect",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-fence-test-"));
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
      rmSync(root, { recursive: true, force: true });
    });
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$fence=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-OriginalHostedSetup'},$true)
. ([scriptblock]::Create($fence.Extent.Text))
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))
$statements=@($ast.EndBlock.Statements);$index=-1
for($i=0;$i -lt $statements.Count;$i++){if($statements[$i].Extent.Text.StartsWith('[Portcove.HostedNative.Setup]::Directory($root,')){$index=$i;break}}
if($index -lt 1){throw 'Actual first-directory boundary absent'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
$context=@{broker_pid=$PID;broker_created_ticks=(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID)).CreationDate.ToUniversalTime().Ticks.ToString()}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalSeconds=0}}
Assert-OriginalHostedSetup
foreach($kind in @('generation','deadline')){
$root=Join-Path '${root.replaceAll("'", "''")}' ('not-created-'+$kind)
$context=@{broker_pid=$PID;broker_created_ticks=$(if($kind -ceq 'generation'){'1'}else{(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID)).CreationDate.ToUniversalTime().Ticks.ToString()})}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalSeconds=$(if($kind -ceq 'deadline'){120}else{0})}}
$refused=$false;try{. ([scriptblock]::Create(($statements[($index-1)..($index+1)].Extent.Text -join [Environment]::NewLine)))}catch{$refused=$true}
if(-not $refused -or (Test-Path -LiteralPath $root)){throw 'Stale parent permitted the first directory effect'}
}
'actual pre-effect parent-generation fence refused without directory creation'
`);
    assert.match(result, /without directory creation/u);
  },
);

void test(
  "hosted membership call binds the created LocalUser as a LocalPrincipal without group mutation",
  { skip: process.platform !== "win32" },
  () => {
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Import-Module Microsoft.PowerShell.LocalAccounts
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$call=$ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-LocalGroupMember'},$true)
if($call.Count -ne 1){throw 'Fixed membership call differs'}
$account=Get-LocalUser -SID ([Security.Principal.WindowsIdentity]::GetCurrent().User)
$script:observed=$false
function Add-LocalGroupMember {
param([Security.Principal.SecurityIdentifier]$SID,[Microsoft.PowerShell.Commands.LocalPrincipal[]]$Member)
if($SID.Value -cne 'S-1-5-32-545' -or $Member.Count -ne 1 -or $Member[0].SID.Value -cne $account.SID.Value){throw 'Membership identity differs'}
$script:observed=$true
}
. ([scriptblock]::Create($call[0].Extent.Text))
if(-not $observed){throw 'Actual membership call was not bound'}
'actual LocalPrincipal parameter binding passed; no group mutation'
`);
    assert.match(result, /actual LocalPrincipal parameter binding passed/u);
  },
);

void test("hosted probe stream readback bounds retained bytes and preserves empty output", () => {
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$reader=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-HostedNativeProbeStream'},$true)
. ([scriptblock]::Create($reader.Extent.Text))
foreach($size in @(0,20,16385)){
$stream=[pscustomobject]@{Bytes=[byte[]]::new($size)}
$stream|Add-Member ScriptMethod Snapshot {return ,$this.Bytes}
$actual=Read-HostedNativeProbeStream $stream
if($actual.bytes -ne $size -or [Convert]::FromBase64String($actual.prefix_base64).Length -ne [Math]::Min($size,16384) -or $actual.truncated -ne ($size -gt 16384)){throw 'Probe capture bound differs'}
}
'actual probe capture bounds passed'
`);
  assert.match(result, /actual probe capture bounds passed/u);
});

void test("registry startup markers are opt-in and preserve the ordinary silent-stderr prefix", () => {
  const registry = fileURLToPath(
    new URL("./native-qualification-account-registry.ps1", import.meta.url),
  );
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${registry.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Registry source syntax differs'}
$prefix=@($ast.EndBlock.Statements|Select-Object -First 3).Extent.Text -join [Environment]::NewLine
$entry=[scriptblock]::Create($ast.ParamBlock.Extent.Text+[Environment]::NewLine+$prefix)
$original=[Console]::Error;$capture=[IO.StringWriter]::new()
try{
[Console]::SetError($capture)
& $entry -Invocation ('a'*64)
if($capture.ToString().Length){throw 'Ordinary reader emitted diagnostic stderr'}
& $entry -Invocation ('a'*64) -DiagnosticStages
if($capture.ToString().Trim() -cne 'inert-registry:identity-begin'){throw 'Explicit fixture marker unavailable'}
}finally{[Console]::SetError($original);$capture.Dispose()}
'actual default and opt-in registry marker binding passed'
`);
  assert.match(result, /actual default and opt-in registry marker binding passed/u);
});

void test(
  "real Windows observer waits for an owned visible responsive inert form",
  { skip: process.platform !== "win32", timeout: 100000 },
  (t) => {
    const root = mkdtempSync(path.join(homedir(), ".portcove-observer-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const launcher = fileURLToPath(
      new URL("./native-qualification-account.cs.txt", import.meta.url),
    );
    const probe = fileURLToPath(
      new URL("./fixtures/native-desktop-observer.cs.txt", import.meta.url),
    );
    const quote = (value: string) => value.replaceAll("'", "''");
    const result = JSON.parse(
      powershell(
        `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${quote(launcher)}')+[Environment]::NewLine+[IO.File]::ReadAllText('${quote(probe)}'))
[Portcove.NativeQualification.DesktopObserverProbe]::Run('${quote(root)}')|ConvertTo-Json -Depth 4 -Compress
`,
        90000,
      ),
    ) as Record<string, unknown>;
    assert.equal(result.failure, undefined, JSON.stringify(result));
    assert.equal(result.cleanup_failure, undefined, JSON.stringify(result));
    assert.equal(result.observer_drain_failure, undefined, JSON.stringify(result));
    assert.equal(result.dispose_failure, undefined, JSON.stringify(result));
    assert.equal(result.capture_failure, undefined, JSON.stringify(result));
    assert.equal(result.thread_restore_failure, undefined, JSON.stringify(result));
    assert.equal(result.desktop_close_failure, undefined, JSON.stringify(result));
    assert.equal(result.owned_visible_responsive, true, JSON.stringify(result));
    assert.equal(result.root_exited, true, JSON.stringify(result));
    assert.equal(result.job_empty, true, JSON.stringify(result));
    assert.equal(result.observer_drained, true, JSON.stringify(result));
  },
);

void test("actual private-window lookup refuses enumeration failure without rejecting a found callback stop", () => {
  const launcher = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}')
$begin=$source.IndexOf('        IntPtr FindWindow(uint target) {')
$end=$source.IndexOf('        public IntPtr MainWindowHandle', $begin)
if($begin -lt 0 -or $end -le $begin){throw 'Actual lookup boundary differs'}
$method=$source.Substring($begin,$end-$begin)
$responseBegin=$source.IndexOf('        public bool Responding {')
$responseEnd=$source.IndexOf('        public bool HostedResponding', $responseBegin)
if($responseBegin -lt 0 -or $responseEnd -le $responseBegin){throw 'Actual response boundary differs'}
$response=$source.Substring($responseBegin,$responseEnd-$responseBegin)
$harness=@'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class Native {
 public delegate bool DesktopWindowCallback(IntPtr window, IntPtr unused);
 public static bool Fails, HasWindow, Responds;
 public static void SetLastError(uint error){Marshal.SetLastPInvokeError((int)error);}
 public static bool EnumDesktopWindows(IntPtr desktop, DesktopWindowCallback callback, IntPtr ignored) {
  if(HasWindow) return callback(new IntPtr(42), IntPtr.Zero);
  if(Fails) Marshal.SetLastPInvokeError(5);
  return false;
 }
 public static void GetWindowThreadProcessId(IntPtr window, out uint owner) { owner=7; }
 public static bool IsWindowVisible(IntPtr window) {return true;}
 public static int GetWindowLongW(IntPtr window, int index) {return 268435456;}
 public static IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result) {result=UIntPtr.Zero;return Responds ? new IntPtr(1) : IntPtr.Zero;}
 public static Exception Error(string operation) {return new InvalidOperationException(operation);}
}
public class Lookup {
 IntPtr desktop=IntPtr.Zero;
 public string LastWindowInspection {get; private set;}
 public string LastResponseInspection {get; private set;}
 public bool SawVisibleWindow {get; private set;}
 uint pid=7;
__METHOD__
__RESPONSE__
 public IntPtr Observe(){return FindWindow(7);}
}
'@
Add-Type -TypeDefinition $harness.Replace('__METHOD__',$method).Replace('__RESPONSE__',$response)
$lookup=[Lookup]::new()
[Runtime.InteropServices.Marshal]::SetLastPInvokeError(5)
if($lookup.Observe() -ne [IntPtr]::Zero){throw 'Empty desktop was not empty'}
[Native]::Fails=$true
$refused=$false;try{$lookup.Observe()|Out-Null}catch{if($_.Exception.ToString() -notmatch 'EnumDesktopWindows failed: win32='){throw};$refused=$true}
if(-not $refused){throw 'Enumeration failure became an empty desktop'}
[Native]::HasWindow=$true
if($lookup.Observe().ToInt64() -ne 42 -or $lookup.LastWindowInspection -cne '42:True:10000000' -or -not $lookup.SawVisibleWindow){throw 'Found callback stop or bounded inspection was lost'}
if($lookup.Responding -or $lookup.LastResponseInspection -notmatch '^42:0:'){throw 'Response refusal or its evidence was lost'}
[Native]::Responds=$true
if(-not $lookup.Responding -or $lookup.LastResponseInspection -notmatch '^42:1:'){throw 'Successful response or its evidence was lost'}
'actual lookup error, empty and found-callback semantics passed'
`);
  assert.match(result, /actual lookup error, empty and found-callback semantics passed/u);
});

void test(
  "inert own-window show refuses hidden state and leaves acceptance to the broker",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/native-account-gui-probe.ps1", import.meta.url),
    );
    const result = powershell(`
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText('${fixture.replaceAll("'", "''")}')
$start=$text.IndexOf('    $form.Show()')
$end=$text.IndexOf('    [Windows.Forms.Application]::Run($form)', $start)
if($start -lt 0 -or $end -lt $start){throw 'Own-window show boundary missing'}
$show=[scriptblock]::Create($text.Substring($start,$end-$start))
Add-Type -TypeDefinition @'
using System;
public static class InertProbeWindow {
 public static bool Visible;
 public static int Calls;
 public static bool ShowWindow(IntPtr window,int command){if(window.ToInt64()!=42 || command!=(Calls++%2==0 ? 0 : 5))throw new Exception("Wrong own-window hide/show order");return false;}
 public static bool IsWindowVisible(IntPtr window){if(window.ToInt64()!=42)throw new Exception("Wrong visibility target");return Visible;}
 public static int GetWindowLongW(IntPtr window,int index){if(index!=-16 || (window.ToInt64()!=42 && window.ToInt64()!=99))throw new Exception("Wrong own-window style target");return 0;}
 public static IntPtr GetAncestor(IntPtr window,uint flags){if(window.ToInt64()!=42 || flags!=1)throw new Exception("Wrong ancestor target");return new IntPtr(99);}
 public static IntPtr GetDesktopWindow(){return new IntPtr(99);}
}
'@
$form=[pscustomobject]@{Handle=[IntPtr]42}
$form|Add-Member ScriptMethod Show {}
$refused=$false
try{& $show}catch{if($_.Exception.Message -cne 'Inert own form remains hidden'){throw};$refused=$true}
if(-not $refused -or [InertProbeWindow]::Calls -ne 2){throw 'Hidden window accepted or startup show state not consumed'}
[InertProbeWindow]::Visible=$true
& $show
if([InertProbeWindow]::Calls -ne 4){throw 'Native hide/show sequence incomplete'}
'own-window show and refusal passed'
`);
    assert.match(result, /own-window show and refusal passed/u);
  },
);

void test(
  "hosted proposal preserves station ACEs and restricts the exact candidate SID without inheritance",
  { skip: process.platform !== "win32" },
  () => {
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))
$original=[Security.AccessControl.RawSecurityDescriptor]::new('O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BU)')
$bytes=[byte[]]::new($original.BinaryLength);$original.GetBinaryForm($bytes,0)
$sid='S-1-5-21-1-2-3-1001'
$proposed=[Portcove.HostedNative.HostedDesktop]::StationProposal($bytes,$sid)
$actual=[Security.AccessControl.RawSecurityDescriptor]::new($proposed,0)
if($actual.Owner.Value -cne $original.Owner.Value -or $actual.Group.Value -cne $original.Group.Value -or $actual.DiscretionaryAcl.Count -ne 4){throw 'Original identity or ACEs lost'}
$deny=$actual.DiscretionaryAcl[0];$allow=$actual.DiscretionaryAcl[1]
if($deny.SecurityIdentifier.Value -cne $sid -or $deny.AceQualifier -ne 'AccessDenied' -or $deny.AccessMask -ne 0xd031d -or $deny.AceFlags -ne 'None' -or
   $allow.SecurityIdentifier.Value -cne $sid -or $allow.AceQualifier -ne 'AccessAllowed' -or $allow.AccessMask -ne 0x20062 -or $allow.AceFlags -ne 'None'){throw 'Candidate station restriction differs'}
for($i=0;$i -lt 2;$i++){
  $a=[byte[]]::new($actual.DiscretionaryAcl[$i+2].BinaryLength);$b=[byte[]]::new($original.DiscretionaryAcl[$i].BinaryLength)
 $actual.DiscretionaryAcl[$i+2].GetBinaryForm($a,0);$original.DiscretionaryAcl[$i].GetBinaryForm($b,0)
 if([Convert]::ToBase64String($a) -cne [Convert]::ToBase64String($b)){throw 'Unrelated ACE changed'}
}
$refused=$false;try{[Portcove.HostedNative.HostedDesktop]::StationProposal($proposed,$sid)|Out-Null}catch{$refused=$true}
if(-not $refused -or -not [Portcove.HostedNative.HostedDesktop]::ExecutionAuthorized){throw 'Existing candidate adopted or approved hosted gate disabled'}
$refused=$false;try{[Portcove.HostedNative.HostedDesktop]::Prepare('invalid','invalid','invalid')|Out-Null}catch{$refused=$_.Exception.Message -match 'Distinct actual owner required'}
if(-not $refused){throw 'Invalid owner did not refuse before effects'}
$near=[Security.AccessControl.RawSecurityDescriptor]::new('O:SYG:SYD:')
$near.DiscretionaryAcl=[Security.AccessControl.RawAcl]::new(2,420)
$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
while($near.BinaryLength+20 -le 8192){$near.DiscretionaryAcl.InsertAce($near.DiscretionaryAcl.Count,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x20002,$everyone,$false,$null))}
$large=[byte[]]::new($near.BinaryLength);$near.GetBinaryForm($large,0)
$refused=$false;try{[Portcove.HostedNative.HostedDesktop]::StationProposal($large,$sid)|Out-Null}catch{if($_.Exception.ToString() -notmatch 'proposal exceeds recovery bound'){throw};$refused=$true}
if(-not $refused){throw 'Oversized postimage admitted before station write'}
'actual in-memory station proposal passed; no desktop/account/ACL mutation'
`);
    assert.match(result, /actual in-memory station proposal passed/u);
  },
);

void test("trusted hosted observer attaches a dedicated thread and refuses hidden, unresponsive or replaced windows", () => {
  const launcher = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}')
$begin=$source.IndexOf('        public bool HostedResponding {')
$end=$source.IndexOf('        public bool CloseMainWindow()', $begin)
if($begin -lt 0 -or $end -le $begin){throw 'Actual observer boundary missing'}
$method=$source.Substring($begin,$end-$begin)
$harness=@'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class Native {
 public static int ObserverThread, CallerThread;
 public static bool Hidden, Silent, Replaced, Input, Slow, Attached=true;
 public static bool SetThreadDesktop(IntPtr desktop){ObserverThread=Thread.CurrentThread.ManagedThreadId;return Attached;}
 public static void RequireNonInputDesktop(IntPtr desktop){if(Input)throw new Exception("input desktop");}
 public static void GetWindowThreadProcessId(IntPtr window,out uint pid){pid=Replaced?8u:7u;}
 public static bool IsWindowVisible(IntPtr window){return !Hidden;}
 public static Exception Error(string operation){return new Exception(operation);}
 public static IntPtr SendMessageTimeoutW(IntPtr window,uint message,UIntPtr first,IntPtr second,uint flags,uint timeout,out UIntPtr result){
  if(ObserverThread==CallerThread || message!=0 || flags!=0x23 || timeout!=1000)throw new Exception("Observer/message boundary differs");
  if(Slow)Thread.Sleep(2300);
  result=UIntPtr.Zero;return Silent?IntPtr.Zero:new IntPtr(1);
 }
}
public class Observer {
 IntPtr desktop=new IntPtr(99); uint pid=7; Thread hostedObserver;
 public bool HasExited;
 public string LastResponseInspection;
 public string LastHostedObserverFailure;
 IntPtr FindWindow(uint target){return Native.Hidden?IntPtr.Zero:new IntPtr(42);}
__METHOD__
}
'@
Add-Type -TypeDefinition $harness.Replace('__METHOD__',$method)
[Native]::CallerThread=[Threading.Thread]::CurrentThread.ManagedThreadId
$observer=[Observer]::new()
if(-not $observer.HostedResponding -or $observer.LastResponseInspection -notmatch '^42:1:'){throw 'Actual observer positive control failed'}
[Native]::Slow=$true;$refused=$false
try{[Observer].GetProperty('HostedResponding').GetValue($observer)|Out-Null}catch{if($_.Exception.ToString() -notmatch 'exceeded two seconds'){throw};$refused=$true}
if(-not $refused -or -not $observer.DrainHostedObserver(5000)){throw 'Observer deadline/drain was not enforced'}
[Native]::Slow=$false
foreach($flag in @('Hidden','Silent','Replaced')){
 [Native].GetField($flag).SetValue($null,$true)
 if($observer.HostedResponding){throw 'Invalid window accepted'}
 [Native].GetField($flag).SetValue($null,$false)
}
$observer.HasExited=$true;if($observer.HostedResponding){throw 'Exited root accepted'};$observer.HasExited=$false
[Native]::Input=$true;$refused=$false;try{[Observer].GetProperty('HostedResponding').GetValue($observer)|Out-Null}catch{$refused=$true}
if(-not $refused){throw 'Input desktop accepted'}
[Native]::Input=$false;[Native]::Attached=$false;$refused=$false;try{[Observer].GetProperty('HostedResponding').GetValue($observer)|Out-Null}catch{$refused=$true}
if(-not $refused){throw 'Failed thread attachment accepted'}
'actual dedicated observer controlled outcomes passed; no actual GUI acceptance'
`);
  assert.match(result, /actual dedicated observer controlled outcomes passed/u);
});

void test(
  "actual Windows access check enforces candidate deny against generic group grants",
  { skip: process.platform !== "win32" },
  () => {
    const launcher = fileURLToPath(
      new URL("./native-qualification-account.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}'))
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))

$creation=[Portcove.NativeQualification.AccountLauncher].GetMethod('CreationFlags',[Reflection.BindingFlags]'NonPublic,Static')
if($creation.Invoke($null,[object[]]@($null)) -ne 0x404 -or $creation.Invoke($null,@('PortcoveHosted_0123456789abcdef0123456789abcdef')) -ne 0x08000404){throw 'Hosted-only non-console flags changed'}
$type=[Portcove.NativeQualification.AccountLauncher].Assembly.GetType('Portcove.NativeQualification.Native')
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$open=$type.GetMethod('OpenProcessToken',$flags);$check=$type.GetMethod('GrantedRights',$flags);$close=$type.GetMethod('CloseHandle',$flags)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$identity.User.Value
$arguments=[object[]]@([Diagnostics.Process]::GetCurrentProcess().Handle,[uint32]8,[IntPtr]::Zero)
if(-not $open.Invoke($null,$arguments)){throw 'Actual query-only primary token open failed'}
$token=$arguments[2]
try{
 $observe=$type.GetMethod('ReadTokenObservation',$flags)
 $snapshot=$observe.Invoke($null,@($token));$brokerSnapshot=[Portcove.NativeQualification.AccountLauncher]::ObserveBrokerToken()
 if($snapshot.IntegritySid -cnotmatch '^S-1-16-[0-9]+$' -or $snapshot.IntegritySid -cne $brokerSnapshot.IntegritySid -or $snapshot.MandatoryPolicy -ne $brokerSnapshot.MandatoryPolicy){throw 'Query-only token integrity/policy observations differ'}
 $refused=$false;try{$observe.Invoke($null,@([IntPtr]::Zero))|Out-Null}catch{$refused=$true};if(-not $refused){throw 'Invalid token integrity query accepted'}

 foreach($station in @($true,$false)){
  $sddl=if($station){'O:SYG:SYD:(A;;GA;;;WD)'}else{'O:SYG:SYD:P(A;;0x200c7;;;'+$sid+')'}
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl);$bytes=[byte[]]::new($descriptor.BinaryLength);$descriptor.GetBinaryForm($bytes,0)
  if($station){$bytes=[Portcove.HostedNative.HostedDesktop]::StationProposal($bytes,$sid)}
  $granted=$check.Invoke($null,[object[]]@($bytes,$token,$station))
  if($granted -ne $(if($station){0x20062}else{0x200c7})){throw ('Effective rights differ: '+$granted)}
 }
 foreach($case in @('no-access','forbidden-switch')){
  $sddl=if($case -ceq 'no-access'){'O:SYG:SYD:'}else{'O:SYG:SYD:P(A;;0x201c7;;;'+$sid+')'}
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl);$bytes=[byte[]]::new($descriptor.BinaryLength);$descriptor.GetBinaryForm($bytes,0)
  $granted=$check.Invoke($null,[object[]]@($bytes,$token,$false))
  if($granted -ne $(if($case -ceq 'no-access'){0}else{0x201c7})){throw ('Actual access denial/forbidden-rights result differs: '+$case)}
 }
 $refused=$false;try{$check.Invoke($null,[object[]]@($bytes,[IntPtr]::Zero,$false))|Out-Null}catch{$refused=$true}
 if(-not $refused){throw 'Unavailable token gained ambient evaluator authority'}
}finally{$close.Invoke($null,@($token))|Out-Null;$identity.Dispose()}
'actual AuthzAccessCheck query-only primary-token controls passed; no object mutation'
`);
    assert.match(result, /actual AuthzAccessCheck query-only primary-token controls passed/u);
  },
);

void test("actual station recovery refuses concurrent drift and retains failed restoration outcomes", () => {
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}')
$source=$source.Replace('[DllImport("user32", SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor, uint length, out uint needed);',@'
public static byte[] TestAcl;
public static int Writes, WriteFailure;
public static bool ReadbackDrift;
static bool GetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor, uint length, out uint needed) {
 needed=(uint)TestAcl.Length;
 if(descriptor==null)return false;
 Array.Copy(TestAcl,descriptor,TestAcl.Length);
 if(ReadbackDrift && Writes>0)descriptor[0]=9;
 return true;
}
'@)
$source=$source.Replace('[DllImport("user32", SetLastError=true)] static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor);',@'
static bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor) {
 Writes++;
 if(WriteFailure==1)return false;
 TestAcl=(byte[])descriptor.Clone();
 return WriteFailure!=2;
}
'@)
$source=$source.Replace('[DllImport("user32", SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);','static bool CloseWindowStation(IntPtr station){return true;}')
Add-Type -TypeDefinition $source
$flags=[Reflection.BindingFlags]'NonPublic,Instance'
$before=[byte[]]::new(20);$before[0]=1;$applied=[byte[]]::new(20);$applied[0]=2;$drift=[byte[]]::new(20);$drift[0]=3
foreach($case in @('unchanged','restore','drift','write-before','write-after','readback')){
 $value=[Portcove.HostedNative.HostedDesktop]::new();$type=$value.GetType()
 foreach($entry in @{station=[IntPtr]42;before=$before;applied=$applied;changed=$true}.GetEnumerator()){$type.GetField($entry.Key,$flags).SetValue($value,$entry.Value)}
 [Portcove.HostedNative.HostedDesktop]::TestAcl=if($case -ceq 'unchanged'){$before}elseif($case -ceq 'drift'){$drift}else{$applied}
 [Portcove.HostedNative.HostedDesktop]::Writes=0
 [Portcove.HostedNative.HostedDesktop]::WriteFailure=if($case -ceq 'write-before'){1}elseif($case -ceq 'write-after'){2}else{0}
 [Portcove.HostedNative.HostedDesktop]::ReadbackDrift=$case -ceq 'readback'
 $refused=$false;try{$value.Dispose()}catch{$refused=$true}
 $success=$case -in @('unchanged','restore')
 if($refused -eq $success -or $value.Restored -ne $success){throw ('False restoration status: '+$case)}
 if($case -in @('unchanged','drift') -and [Portcove.HostedNative.HostedDesktop]::Writes -ne 0){throw 'Unexpected station write'}
 if($case -ceq 'drift' -and [Portcove.HostedNative.HostedDesktop]::TestAcl[0] -ne 3){throw 'Concurrent ACL overwritten'}
}
'actual restoration logic controlled outcomes passed; native object calls replaced'
`);
  assert.match(result, /actual restoration logic controlled outcomes passed/u);
});

void test(
  "actual Windows private desktop readback matches explicit rights and still refuses changed security",
  { skip: process.platform !== "win32" },
  () => {
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ActualDesktopReadback {
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public int length;public IntPtr descriptor;public int inherit; }
 [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref Attributes attributes);
 [DllImport("user32",SetLastError=true)] static extern bool CloseDesktop(IntPtr handle);
 [DllImport("user32",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr handle,ref uint information,byte[] descriptor,uint length,out uint needed);
 [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformationW(IntPtr handle,int index,out int value,uint length,out uint needed);
 public static byte[] Read(byte[] proposal) {
  var pin=GCHandle.Alloc(proposal,GCHandleType.Pinned);IntPtr desktop=IntPtr.Zero;
  try {
   var attributes=new Attributes{length=Marshal.SizeOf<Attributes>(),descriptor=pin.AddrOfPinnedObject()};
   desktop=CreateDesktopW("PortcoveAclControl_"+Guid.NewGuid().ToString("N"),IntPtr.Zero,IntPtr.Zero,0,0xf01ff,ref attributes);
   if(desktop==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Owned temporary desktop control refused; no escalation");
   uint needed,information=7;GetUserObjectSecurity(desktop,ref information,null,0,out needed);
   if(needed<20 || needed>8192)throw new Exception("Descriptor bound");byte[] actual=new byte[needed];
   if(!GetUserObjectSecurity(desktop,ref information,actual,needed,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());
   int input;if(!GetUserObjectInformationW(desktop,6,out input,4,out needed)||input!=0)throw new Exception("Owned control desktop is not non-input");
   return actual;
  } finally {pin.Free();if(desktop!=IntPtr.Zero && !CloseDesktop(desktop))throw new Win32Exception(Marshal.GetLastWin32Error(),"Owned desktop close failed");}
 }
}
'@
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$candidate='S-1-5-21-1-2-3-1001'
$type=[Portcove.HostedNative.HostedDesktop];$flags=[Reflection.BindingFlags]'NonPublic,Static'
$builder=$type.GetMethod('DesktopDescriptor',$flags);$matches=$type.GetMethod('DesktopMatches',$flags)
$expected=$builder.Invoke($null,@($owner,$candidate));$actual=[ActualDesktopReadback]::Read($expected)
if(-not $matches.Invoke($null,@($actual,$expected,$owner))){throw 'Production desktop descriptor did not survive actual Windows creation'}
foreach($change in @('owner','protection','candidate-rights','extra-ace')){
 $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($actual,0)
 switch($change){
  'owner' {$descriptor.Owner=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')}
  'protection' {$descriptor.SetFlags($descriptor.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected))}
  'candidate-rights' {$descriptor.DiscretionaryAcl[2].AccessMask=$descriptor.DiscretionaryAcl[2].AccessMask -bor 0x100}
  'extra-ace' {$descriptor.DiscretionaryAcl.InsertAce(3,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x200c7,[Security.Principal.SecurityIdentifier]::new('S-1-1-0'),$false,$null))}
 }
 $changed=[byte[]]::new($descriptor.BinaryLength);$descriptor.GetBinaryForm($changed,0)
 if($matches.Invoke($null,@($changed,$expected,$owner))){throw ('Changed desktop security accepted: '+$change)}
}
'actual owned temporary non-input desktop descriptor readback passed; no GUI/account/existing ACL mutation'
`);
    assert.match(result, /actual owned temporary non-input desktop descriptor readback passed/u);
  },
);

void test("actual hosted source receiver rejects tool-purpose, extra fields and changed source bytes", (t) => {
  const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-source-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = [
    "scripts/release-hosted-native-windows-setup.ps1",
    "scripts/release-hosted-native-windows-setup.cs.txt",
    "scripts/release-hosted-native-windows-audit.cs.txt",
    "scripts/native-qualification-account.cs.txt",
    "scripts/native-qualification-account-registry.ps1",
    "scripts/fixtures/native-account-gui-probe.ps1",
  ];
  const files = names.map((name, index) => {
    const file = path.join(root, name),
      bytes = Buffer.from(`fixed inert source ${index}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return {
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifest = {
    schema_version: 1,
    purpose: "ordinary-hosted-account-source",
    source_commit: valid.source_commit,
    source_tree: valid.source_tree,
    platform: "windows-x86_64",
    files,
  };
  writeFileSync(path.join(root, "native-account-source.json"), JSON.stringify(manifest));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}')
$begin=$text.IndexOf('$manifest=Get-Content');$end=$text.IndexOf('Add-Type -TypeDefinition',$begin)
if($begin -lt 0 -or $end -le $begin){throw 'Actual source reader boundary missing'}
$reader=[scriptblock]::Create($text.Substring($begin,$end-$begin))
$tools='${root.replaceAll("'", "''")}';$context=@{source_commit=('a'*40);source_tree=('b'*40)}
& $reader
$original=[IO.File]::ReadAllText((Join-Path $tools 'native-account-source.json'))
foreach($change in @('purpose','extra','schema','source')){
 $value=$original|ConvertFrom-Json
 switch($change){
  'purpose' {$value.purpose='controller-tools'}
  'extra' {$value|Add-Member NoteProperty arbitrary $true}
  'schema' {$value.schema_version='1'}
  'source' {$value.files[0].sha256='0'*64}
 }
 [IO.File]::WriteAllText((Join-Path $tools 'native-account-source.json'),($value|ConvertTo-Json -Depth 8 -Compress))
 $refused=$false;try{& $reader}catch{$refused=$true}
 if(-not $refused){throw ('Changed source input admitted: '+$change)}
}
'actual source-only purpose/schema/hash controls passed; no account effects'
`);
  assert.match(result, /actual source-only purpose\/schema\/hash controls passed/u);
});

void test(
  "mandatory label reads use existing READ_CONTROL and retain raw label-only descriptor",
  { skip: process.platform !== "win32" },
  () => {
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}'))
$type=[Portcove.HostedNative.HostedDesktop];$flags=[Reflection.BindingFlags]'NonPublic,Static'
$open=$type.GetMethod('OpenWindowStationW',$flags);$read=$type.GetMethod('ReadMandatoryLabel',$flags);$close=$type.GetMethod('CloseWindowStation',$flags)
$station=$open.Invoke($null,@('WinSta0',$false,[uint32]0x20000))
if($station -eq [IntPtr]::Zero){throw 'Read-control-only current station open unavailable'}
try{
 $label=$read.Invoke($null,@($station));$bytes=[Convert]::FromBase64String($label[0])
 if($bytes.Length -lt 20 -or $bytes.Length -gt 8192 -or $label[1] -match '[DOG]:'){throw 'Label read contains DACL/owner/group or exceeds bound'}
 [Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)|Out-Null
 $partial=[Portcove.HostedNative.HostedDesktop]::new()
 $type.GetField('station',[Reflection.BindingFlags]'NonPublic,Instance').SetValue($partial,$station)
 $observed=$partial.ObserveMandatoryLabels()
 if($observed.station_status -cne 'read' -or $observed.desktop_status -cne 'unknown' -or -not $observed.desktop_query_failure -or $observed.ContainsKey('desktop_descriptor_base64')){throw 'Partial label read lost success or inferred failed label'}
 $refused=$false;try{$read.Invoke($null,@([IntPtr]::Zero))|Out-Null}catch{$refused=$true}
 if(-not $refused){throw 'Failed label query credited as implicit medium'}
 'actual READ_CONTROL label-only query passed; no object changes'
}finally{$close.Invoke($null,@($station))|Out-Null}
`);
    assert.match(result, /label-only query passed/u);
  },
);

void test("startup thread diagnostics refuse replaced roots and overbound or foreign inventories", () => {
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-HostedStartupThreads'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$startup=[pscustomobject]@{Pid=42;CreatedFileTime=[long]134374550793111816}
foreach($case in @('success','replaced','foreign','oversized','unavailable','exited')){
 $script:threadCalls=0;$script:generationChecks=0
 $startup=[pscustomobject]@{Pid=42;CreatedFileTime=[long]134374550793111816}
 $startup|Add-Member ScriptMethod RequireAliveGeneration {$script:generationChecks++;if($case -ceq 'replaced' -or ($case -ceq 'exited' -and $script:generationChecks -eq 2)){throw 'controlled native generation refusal'}}
 function Get-CimInstance {
  param($ClassName,$Filter,$Property,$OperationTimeoutSec,$ErrorAction)
  if($OperationTimeoutSec -ne 5 -or $ClassName -cne 'Win32_Thread' -or $Filter -cne "ProcessHandle = '42'"){throw 'Thread query scope or budget differs'}
  $script:threadCalls++
  if($case -ceq 'unavailable'){throw 'controlled WMI unavailable'}
  1..$(if($case -ceq 'oversized'){65}else{1})|ForEach-Object {[pscustomobject]@{Handle=[string]$_;ProcessHandle=$(if($case -ceq 'foreign'){'43'}else{'42'});ThreadState=5;ThreadWaitReason=6;KernelModeTime=0;UserModeTime=0;StartAddress=0}}
 }
 $refused=$false;try{$observed=@(Read-HostedStartupThreads $startup)}catch{$refused=$true}
 if($refused -ne ($case -cne 'success') -or ($case -ceq 'replaced' -and $script:threadCalls -ne 0)){throw ('Thread diagnostic failed root/bound guard: '+$case)}
 if($case -ceq 'success' -and ($observed.Count -ne 1 -or $observed[0].thread_id -cne '1' -or $script:generationChecks -ne 2)){throw 'Thread state result or native guards differ'}
}
'actual startup thread guards passed six controlled cases; no native observation'
`);
  assert.match(result, /guards passed six controlled cases/u);
});

void test("startup context restores exactly its own suspend increment across injected API failures", () => {
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText('${primitive.replaceAll("'", "''")}')
$begin=$source.IndexOf('namespace Portcove.HostedNative {'+[char]10+'    // Fixed owner-side failure diagnosis only.',[StringComparison]::Ordinal)
if($begin -lt 0){throw 'Actual context diagnostic class absent'}
$source='using System;using System.ComponentModel;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;'+$source.Substring($begin)
$source=$source.Replace('public static class HostedStartupContext {','public static class HostedStartupContext { public static int Mode,Resumes,Closes;public static System.Threading.ManualResetEventSlim Gate=new System.Threading.ManualResetEventSlim(false);')
$replacements=@{
 '[DllImport("kernel32")] static extern IntPtr GetCurrentProcess();'='static IntPtr GetCurrentProcess(){return new IntPtr(1);}'
 '[DllImport("kernel32",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);'='static bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options){if(access!=0||inherit||options!=2)throw new Exception("Duplicate grant differs");copy=new IntPtr(handle.ToInt64()+10);return true;}'
 '[DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);'='static bool CloseHandle(IntPtr handle){System.Threading.Interlocked.Increment(ref Closes);return true;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint GetProcessId(IntPtr process);'='static uint GetProcessId(IntPtr process){return 42;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr thread);'='static uint GetProcessIdOfThread(IntPtr thread){return Mode==7?43u:42u;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint GetThreadId(IntPtr thread);'='static uint GetThreadId(IntPtr thread){return 8;}'
 '[DllImport("kernel32",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);'='static bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user){created=Mode==8?124:123;exited=kernel=user=0;return true;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);'='static uint WaitForSingleObject(IntPtr handle,uint milliseconds){return 0x102;}'
 '[DllImport("kernel32",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native);'='static bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native){machine=0;native=Mode==9?(ushort)0xaa64:(ushort)0x8664;return true;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint SuspendThread(IntPtr thread);'='static uint SuspendThread(IntPtr thread){return Mode==2?2u:Mode==3?0xffffffffu:0u;}'
 '[DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);'='static uint ResumeThread(IntPtr thread){Resumes++;return Mode==2?3u:Mode==4||Mode==6?0xffffffffu:1u;}'
 '[DllImport("kernel32",SetLastError=true)] static extern bool GetThreadContext(IntPtr thread,IntPtr context);'='static bool GetThreadContext(IntPtr thread,IntPtr context){if((context.ToInt64()&15)!=0||Marshal.ReadInt32(context,48)!=0x100003)throw new Exception("Context alignment/flags differ");if(Mode==5&&!Gate.Wait(5000))throw new Exception("Controlled gate timeout");Marshal.WriteInt64(context,248,0x1010);return Mode!=1&&Mode!=6;}'
 '[DllImport("kernel32",SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process,IntPtr address,out MemoryInformation info,UIntPtr size);'='static UIntPtr VirtualQueryEx(IntPtr process,IntPtr address,out MemoryInformation info,UIntPtr size){info=new MemoryInformation{allocation=new IntPtr(0x1000),type=0x1000000,state=Mode==11?0x2000u:0x1000u};return Mode==10?(UIntPtr)1:size;}'
 '[DllImport("psapi",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetMappedFileNameW(IntPtr process,IntPtr address,StringBuilder name,uint size);'='static uint GetMappedFileNameW(IntPtr process,IntPtr address,StringBuilder name,uint size){name.Append("controlled.dll");return 14;}'
 '[DllImport("kernel32",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);'='static IntPtr GetModuleHandleW(string name){return IntPtr.Zero;}'
}
foreach($entry in $replacements.GetEnumerator()){if(-not $source.Contains($entry.Key)){throw 'Actual diagnostic API seam differs'};$source=$source.Replace($entry.Key,$entry.Value)}
Add-Type -TypeDefinition $source
$capture=[Portcove.HostedNative.HostedStartupContext].GetMethod('Capture',[Reflection.BindingFlags]'NonPublic,Static')
foreach($mode in @(0,1,2,3,4,6,7,8,9,10,11)){
 [Portcove.HostedNative.HostedStartupContext]::Mode=$mode;[Portcove.HostedNative.HostedStartupContext]::Resumes=0
 $data=[Collections.Generic.Dictionary[string,string]]::new();$refused=$false
 try{$capture.Invoke($null,@([IntPtr]1,[IntPtr]2,[uint32]42,[long]123,$data))|Out-Null}catch{$refused=$true}
 if($refused -ne ($mode -ne 0) -or [Portcove.HostedNative.HostedStartupContext]::Resumes -ne $(if($mode -in @(3,7,8,9)){0}else{1})){throw ('Suspend restoration or refusal differs: '+$mode)}
 if($mode -eq 2 -and ($data['suspend_count_before'] -cne '2' -or $data['resume_count_returned'] -cne '3')){throw 'Preexisting suspend count was flattened'}
}
[Portcove.HostedNative.HostedStartupContext]::Mode=5;[Portcove.HostedNative.HostedStartupContext]::Closes=0;[Portcove.HostedNative.HostedStartupContext]::Resumes=0
try{
 $result=[Portcove.HostedNative.HostedStartupContext]::Observe([IntPtr]1,[IntPtr]2,42,123)
 if($result['status'] -cne 'unknown' -or [Portcove.HostedNative.HostedStartupContext]::Closes -ne 0){throw 'Timeout closed worker-owned handles or claimed success'}
}finally{[Portcove.HostedNative.HostedStartupContext]::Gate.Set()}
$clock=[Diagnostics.Stopwatch]::StartNew();while([Portcove.HostedNative.HostedStartupContext]::Closes -ne 2 -and $clock.ElapsedMilliseconds -lt 5000){Start-Sleep -Milliseconds 10}
if([Portcove.HostedNative.HostedStartupContext]::Closes -ne 2 -or [Portcove.HostedNative.HostedStartupContext]::Resumes -ne 1){throw 'Worker did not restore exactly one increment and close its own duplicates'}
'actual context compensation and timed worker ownership passed; controlled APIs only'
`);
  assert.match(result, /compensation and timed worker ownership passed/u);
});

void test("startup popup diagnostics constrain source/time/executable and bounded UTF8 without PID attribution", () => {
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-HostedStartupPopup'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$startup=[pscustomobject]@{CreatedFileTime=[DateTime]::UtcNow.AddSeconds(-10).ToFileTimeUtc()}
$startup|Add-Member ScriptMethod RequireAliveGeneration {$script:guards++;if($case -ceq 'generation'){throw 'controlled native generation refusal'}}
foreach($case in @('success','empty','source','log','foreign','oversized','unavailable','generation','time','unicode','prefix','suffix')){
 $script:guards=0;$script:queries=0
 function Get-CimInstance {
  param($ClassName,$Filter,$Property,$OperationTimeoutSec,$ErrorAction)
  $script:queries++
  if($ClassName -cne 'Win32_NTLogEvent' -or $OperationTimeoutSec -ne 5 -or $Filter -notlike "Logfile = 'System' AND SourceName = 'Application Popup' AND EventCode = 26 AND TimeGenerated >= '*' AND TimeGenerated <= '*' AND Message LIKE '%powershell.exe%'"){throw 'Popup query scope differs'}
  if($case -ceq 'unavailable'){throw 'controlled event service unavailable'}
  if($case -ceq 'empty'){return}
  1..$(if($case -ceq 'oversized'){9}else{1})|ForEach-Object {[pscustomobject]@{Logfile=$(if($case -ceq 'log'){'Security'}else{'System'});RecordNumber=$_;TimeGenerated=$(if($case -ceq 'time'){[DateTime]::UtcNow.AddMinutes(-5)}else{[DateTime]::FromFileTimeUtc($startup.CreatedFileTime).AddSeconds(5)});EventCode=26;SourceName=$(if($case -ceq 'source'){'other'}else{'Application Popup'});Message=$(if($case -ceq 'foreign'){'other.exe failure'}elseif($case -ceq 'prefix'){'notpowershell.exe failure'}elseif($case -ceq 'suffix'){'powershell.exe.other failure'}elseif($case -ceq 'unicode'){'powershell.exe '+(('重'+[char]1)*2000)}else{'powershell.exe controlled diagnostic error; no acceptance'})}}
 }
 $refused=$false;try{$observed=Read-HostedStartupPopup $startup}catch{$refused=$true}
 $accepted=$case -in @('success','empty','unicode')
 if($refused -eq $accepted -or ($case -ceq 'generation' -and $script:queries -ne 0)){throw ('Popup diagnostic guard differs: '+$case)}
 if($accepted){
  if($script:guards -ne 2 -or $observed.correlation -notmatch 'not exact PID' -or [Text.Encoding]::UTF8.GetByteCount(($observed|ConvertTo-Json -Depth 6 -Compress)) -gt 49152){throw 'Popup scope/byte evidence differs'}
  if($case -ceq 'empty' -and ($observed.status -cne 'queried_none' -or $observed.events.Count -ne 0)){throw 'Empty query was credited or relabeled unknown'}
  if($case -ceq 'unicode' -and (-not $observed.events[0].message_truncated -or [Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $observed.events[0].message -Compress)) -gt 4096)){throw 'NonASCII/control message export exceeds bound'}
 }
}
'actual popup query guards passed twelve controlled cases; no system events or GUI acceptance'
`);
  assert.match(result, /guards passed twelve controlled cases/u);
});

void test("original job admission accepts only exact membership and preserves failed root cleanup", () => {
  const launcher = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}')
$start=$text.IndexOf('    public sealed class AccountGroup');$end=$text.IndexOf('    // Raw evidence',$start)
$group=$text.Substring($start,$end-$start)
$harness=@'
using System;using System.Collections.Generic;using System.Diagnostics;using System.Text;using System.Threading;using System.Runtime.InteropServices;
public class AccountConfiguration {public string BrokerSid="broker",AccountSid="candidate";}
__GROUP__
static class Native {
 internal static int Mode,Assignments,Queries;internal static bool Exact;
 internal static IntPtr CreateBoundedJob(){return (IntPtr)42;}
 internal static uint GetProcessId(IntPtr p){return 7;}
 internal static bool GetProcessTimes(IntPtr p,out long c,out long e,out long k,out long u){c=123;e=k=u=0;return true;}
 internal static bool QueryFullProcessImageNameW(IntPtr p,uint flags,StringBuilder b,ref uint len){b.Append("fixed.exe");return true;}
 internal static uint WaitForSingleObject(IntPtr p,uint ms){return Mode==4?0u:258u;}
 internal static bool IsProcessInJob(IntPtr p,IntPtr j,out bool member){Queries++;member=j==IntPtr.Zero?(Mode==1||Mode==2||Exact):Exact;return Mode!=3;}
 internal static bool AssignProcessToJobObject(IntPtr j,IntPtr p){if(j!=(IntPtr)42)throw new Exception("wrong original handle");Assignments++;Exact=Mode!=5;return Mode!=2;}
 internal static Exception Error(string s){return new InvalidOperationException(s+": controlled native failure");}
 internal static bool GetExitCodeProcess(IntPtr p,out uint code){code=125;return true;}
 internal static bool TerminateJobObject(IntPtr j,uint c){return true;}
 internal static uint[] JobPids(IntPtr j){return new uint[0];}
 internal static bool CloseHandle(IntPtr p){return true;}
}
public static class Control {
 public static void Run(){
  var config=new AccountConfiguration();
  for(int mode=0;mode<=5;mode++){
   Native.Mode=mode;Native.Exact=mode==1;Native.Assignments=Native.Queries=0;
   using(var group=new AccountGroup(config)){
    group.BeginLaunch(config,"fixed.exe");bool refused=false;
    try{group.Assign(config,(IntPtr)7);}catch{refused=true;}
    if(refused!=(mode>=2))throw new Exception("admission differs: "+mode);
    if(Native.Assignments!=((mode==0||mode==2||mode==5)?1:0))throw new Exception("assignment was bypassed or repeated: "+mode);
    if(mode<2 && group.LastLaunchInspection["original_job_after"]!="True")throw new Exception("missing exact readback");
    group.RetainFailedRoot((IntPtr)7,7,"fixed.exe",258,true,true,0,0,0,0);
    if(group.LastLaunchInspection["failed_root_exit_code"]!="0x0000007d"||group.LastLaunchInspection["root_created_filetime"]!="123")throw new Exception("failed root identity/cleanup lost");
    group.BeginLaunch(config,"next.exe");if(group.LastLaunchInspection.ContainsKey("root_pid"))throw new Exception("stale launch reused");
    group.StopAndObserve(1);try{group.Assign(config,(IntPtr)7);throw new Exception("stopped group admitted");}catch(InvalidOperationException){}
   }
  }
 }
}
'@
Add-Type -TypeDefinition $harness.Replace('__GROUP__',$group)
[Control]::Run()
'actual exact-job admission and failed-root retention passed six controlled modes; no process launched'
`);
  assert.match(result, /passed six controlled modes/u);
});

void test("native teardown waits for root signal and empty membership in either order within its original budget", () => {
  const launcher = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop';$text=[IO.File]::ReadAllText('${launcher.replaceAll("'", "''")}')
$start=$text.IndexOf('        public TeardownObservation ReadTeardown(int milliseconds)');$end=$text.IndexOf('        public void Dispose()',$start);$method=$text.Substring($start,$end-$start)
$start=$text.IndexOf('    public sealed class TeardownObservation');$end=$text.IndexOf('    public sealed class AccountProcessIdentity',$start);$observation=$text.Substring($start,$end-$start)
$harness=@'
using System;using System.Diagnostics;using System.Threading;
__OBSERVATION__
static class Native {
 internal static int Mode,Queries,Waits;
 internal static uint[] JobPids(IntPtr j){Queries++;if(Mode==4)throw Error("job read");return Mode==1&&Queries<3?new uint[]{42}:new uint[0];}
 internal static uint WaitForSingleObject(IntPtr p,uint ms){Waits++;return Mode==3?0xffffffff:Mode==2||Mode==0&&Waits<3?258u:0u;}
 internal static bool GetExitCodeProcess(IntPtr p,out uint c){c=Mode==2?259u:125u;return Mode!=5;}
 internal static Exception Error(string s){return new InvalidOperationException(s+" controlled native failure");}
}
public class Control {
 IntPtr job=(IntPtr)42,process=(IntPtr)7;uint pid=42;long created=134374669087322706;
 public TeardownObservation LastTeardown;
 __METHOD__
 public static void Run(){
  for(int mode=0;mode<=5;mode++){
   Native.Mode=mode;Native.Queries=Native.Waits=0;bool refused=false;TeardownObservation result=null;
   try{result=new Control().ReadTeardown(mode==2?40:200);}catch(InvalidOperationException){refused=true;}
   if(refused!=(mode>=3))throw new Exception("native refusal differs: "+mode);
   if(mode<2&&(!result.RootExited||!result.JobEmpty||Native.Queries<3||result.RootCreatedFileTime!=134374669087322706))throw new Exception("early teardown or identity loss: "+mode);
   if(mode==2&&(result.RootExited||result.JobEmpty||Native.Waits<2))throw new Exception("timeout credited as settlement");
  }
 }
}
'@
Add-Type -TypeDefinition $harness.Replace('__METHOD__',$method).Replace('__OBSERVATION__',$observation)
[Control]::Run()
'actual native teardown passed six controlled completion/failure modes; no process launched'
`);
  assert.match(result, /teardown passed six controlled/u);
});

void test("required-root cleanup keeps account disabling independent of job, observer and unreturned-root failures", (t) => {
  const root = mkdtempSync(path.join(homedir(), ".portcove-required-root-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = powershell(String.raw`
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Required-root setup parse failed'}
$write=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-HostedNativeSetupRecord'},$true);. ([scriptblock]::Create($write.Extent.Text))
$export=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-HostedAuditRecovery'},$true);. ([scriptblock]::Create($export.Extent.Text))
$main=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
$base='${root.replaceAll("'", "''")}';$nativeProfile='inert';$context=@{fixture='controlled required-root cleanup'}
foreach($case in @('settled','stop','root','observer','unreturned-settled','unreturned-timeout','unreturned-unknown','unreturned-noidentity')){
 $root=Join-Path $base $case;[IO.Directory]::CreateDirectory($root)|Out-Null
 $account=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'};Description='owned';Enabled=$true}
 $script:stops=0;$script:drains=0
 $group=[pscustomobject]@{LastLaunchInspection=$null};$group|Add-Member ScriptMethod StopAndObserve {param($ms)$script:stops++;if($case -ceq 'stop'){throw 'controlled group stop refusal'};return @()};$group|Add-Member ScriptMethod Dispose {}
 $child=[pscustomobject]@{Pid=42;CreatedFileTime=[long]123};$child|Add-Member ScriptMethod WaitForExit {param($ms)return $case -cne 'root'};$child|Add-Member ScriptMethod DrainHostedObserver {param($ms)$script:drains++;return $case -cne 'observer'};$child|Add-Member ScriptMethod Dispose {}
 if($case -like 'unreturned-*'){
  $child=$null;$launch=[Collections.Generic.Dictionary[string,string]]::new();$launch['root_pid']='7';$launch['handle_returned']='False'
  if($case -cne 'unreturned-noidentity'){$launch['root_created_filetime']='123'}
  if($case -cne 'unreturned-unknown'){$launch['failed_root_wait_after']=$(if($case -ceq 'unreturned-timeout'){'258'}else{'0'})}
  $group.LastLaunchInspection=$launch
 }
 $password=$null;$hostedDesktop=$null;$actualProfile=$null;$registeredProfile=$null;$remaining=$null;$rootExited=$null;$probeCapture=$null;$stationRestored=$null;$observerDrained=$null
 $failure='original required form failed';$observation=$null;$disabled=$false;$settled=$false;$cleanupFailures=[Collections.Generic.List[string]]::new()
 function Get-LocalUser {param($SID)return $account};function Disable-LocalUser {param($SID)$account.Enabled=$false}
 . ([scriptblock]::Create(($main[0].Finally.Statements.Extent.Text -join [Environment]::NewLine)))
 $record=Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw|ConvertFrom-Json
 $expectedFailures=$(if($case -in @('settled','unreturned-settled')){0}else{1})
 if(-not $record.disabled -or $record.failure -cne $failure -or $script:stops -ne 1 -or @($record.cleanup_failures).Count -ne $expectedFailures){throw ('Cleanup lost independence or failure: '+$case)}
 if($case -like 'unreturned-*' -and $record.last_launch.root_pid -cne '7'){throw 'Unreturned launch identity lost'}
 if($case -ceq 'settled' -and (-not $record.root_exited -or -not $record.job_empty -or -not $record.observer_drained)){throw 'Settled required root not positively read back'}
}
'actual required-root cleanup passed eight controlled outcomes; no account or GUI effects'
`);
  assert.match(result, /cleanup passed eight controlled outcomes/u);
});

void test(
  "hosted-only access audit preserves SACL labels and rejects unrelated or overbound Security records",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Diagnostics.EventLog
$references=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+[System.Diagnostics.Eventing.Reader.EventLogReader].Assembly.Location
Add-Type -ReferencedAssemblies $references -TypeDefinition ([IO.File]::ReadAllText('${audit.replaceAll("'", "''")}'))
$refused=$false;try{[Portcove.HostedNative.AccessAudit]::Prepare('invalid','invalid','invalid')|Out-Null}catch{$refused=$_.Exception.Message -match 'Targeted access audit authority not granted'}
if(-not $refused -or [Portcove.HostedNative.AccessAudit]::ExecutionAuthorized){throw 'Hosted audit gate allowed invalid context or reactivated consumed owner grant'}
$sid='S-1-5-21-1-2-3-1001';$before=[Security.AccessControl.RawSecurityDescriptor]::new('O:SYG:SYD:P(A;;GA;;;SY)S:(ML;;NW;;;LW)')
$bytes=[byte[]]::new($before.BinaryLength);$before.GetBinaryForm($bytes,0)
$changed=[Security.AccessControl.RawSecurityDescriptor]::new([Portcove.HostedNative.AccessAudit]::Propose($bytes,$sid,0xf037f),0)
if($changed.GetSddlForm('Owner,Group,Access') -cne $before.GetSddlForm('Owner,Group,Access') -or $changed.SystemAcl.Count -ne 2){throw 'SACL proposal changed unrelated security'}
$left=[byte[]]::new($before.SystemAcl[0].BinaryLength);$right=[byte[]]::new($changed.SystemAcl[1].BinaryLength);$before.SystemAcl[0].GetBinaryForm($left,0);$changed.SystemAcl[1].GetBinaryForm($right,0)
if([Convert]::ToBase64String($left) -cne [Convert]::ToBase64String($right) -or $changed.SystemAcl[0].AceFlags -ne 'FailedAccess'){throw 'Mandatory label lost or broad success auditing added'}
$stamp=[DateTime]::UtcNow.AddSeconds(-1);$created=$stamp.AddSeconds(-1).ToFileTimeUtc();$image='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
foreach($case in @('valid','desktop','sid','logon','pid','provider-pid','provider','channel','event','object','mask','success','time','duplicate','dtd','oversized','record-id','system-duplicate')){
 $type=$(if($case -ceq 'desktop'){'Desktop'}else{'WindowStation'});$name=$(if($case -ceq 'desktop'){'PortcoveHosted_inert'}else{'WinSta0'})
 $xml='<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="Microsoft-Windows-Security-Auditing"/><EventID>4656</EventID><Channel>Security</Channel><Execution ProcessID="42"/><Keywords>0x8010000000000000</Keywords><EventRecordID>7</EventRecordID><TimeCreated SystemTime="'+$stamp.ToString('o')+'"/></System><EventData><Data Name="SubjectUserSid">'+$sid+'</Data><Data Name="SubjectLogonId">0xffffffffffff1234</Data><Data Name="ProcessId">0x2a</Data><Data Name="ProcessName">'+$image+'</Data><Data Name="ObjectType">'+$type+'</Data><Data Name="ObjectName">'+$name+'</Data><Data Name="AccessMask">0x2</Data></EventData></Event>'
 switch($case){sid{$xml=$xml.Replace($sid,'S-1-5-21-1-2-3-1002')}logon{$xml=$xml.Replace('0xffffffffffff1234','0x123')}pid{$xml=$xml.Replace('0x2a','0x2b')}provider-pid{$xml=$xml.Replace('0x2a','0x2b')}provider{$xml=$xml.Replace('Microsoft-Windows-Security-Auditing','other')}channel{$xml=$xml.Replace('Security</Channel>','Application</Channel>')}event{$xml=$xml.Replace('4656','4663')}object{$xml=$xml.Replace('>'+ $name+'<','>unrelated<')}mask{$xml=$xml.Replace('>0x2<','>0x100000000<')}success{$xml=$xml.Replace('0x8010000000000000','0x8020000000000000')}time{$xml=$xml.Replace($stamp.ToString('o'),$stamp.AddMinutes(-5).ToString('o'))}duplicate{$xml=$xml.Replace('</EventData>','<Data Name="ProcessId">0x2a</Data></EventData>')}record-id{$xml=$xml.Replace('<EventRecordID>7</EventRecordID>','<EventRecordID>18446744073709551616</EventRecordID>')}system-duplicate{$xml=$xml.Replace('<EventRecordID>7</EventRecordID>','<EventRecordID>7</EventRecordID><EventRecordID>8</EventRecordID>')}dtd{$xml='<!DOCTYPE x [<!ENTITY x SYSTEM "file:///untrusted">]>'+$xml}oversized{$xml+='x'*32769}}
 $refused=$false;try{$record=[Portcove.HostedNative.AccessAudit]::SelectRecord($xml,$sid,42,$created,$image,'0xffffffffffff1234',@($type+':'+$name),1)}catch{$refused=$true}
 if($refused -ne ($case -notin @('valid','desktop'))){throw ('Audit record boundary differs: '+$case)}
}
[Portcove.HostedNative.AccessAudit]::BoundRecords(@([Collections.Generic.Dictionary[string,string]]::new()))
$oversize=[Collections.Generic.Dictionary[string,string]]::new();$oversize['bounded-key']='x'*6000
$refused=$false;try{[Portcove.HostedNative.AccessAudit]::BoundRecords(@($oversize))}catch{$refused=$true};if(-not $refused){throw 'Aggregate export bound not enforced'}
'actual audit proposal/label/authority and eighteen XML controls passed; no privilege, SACL, policy or Security-log effects'
`);
    assert.match(result, /eighteen XML controls passed/u);
  },
);

void test(
  "audit recovery restores independent objects, policy and privilege without overwriting drift",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${audit.replaceAll("'", "''")}')
$retention=[regex]::Match($source,'(?s)  void RetainRecovery\(.*?(?=  public static AccessAudit Prepare)').Value
$command=[regex]::Match($source,'(?s)  static Policy RestorePolicyCommand\(.*?(?=  static byte\[\] PolicyBytes)').Value
$start=$source.IndexOf('  public void Dispose(){');$end=$source.IndexOf('  [StructLayout',$start);$dispose=$source.Substring($start,$end-$start)
$start=$source.IndexOf('  static string Sacl(');$end=$source.IndexOf('  sealed class AuditObject',$start);$comparison=$source.Substring($start,$end-$start)
$harness=@'
using System;using System.Collections.Generic;using System.Security.AccessControl;using System.Runtime.InteropServices;
public class RecoveryControl {
 class AuditObject {internal IntPtr handle;internal string type,name;internal byte[] original,proposed;internal bool attempted;}
 struct Policy {internal int flags;}
 readonly List<AuditObject> objects=new List<AuditObject>();readonly List<string> recovery=new List<string>();
 IntPtr token=(IntPtr)9;Policy before=new Policy{flags=0},applied=new Policy{flags=2};bool policyChanged=true,privilegeChanged,privilegeKnown=false;object originalPrivilege=null;
 public bool Restored {get;private set;}
 static string mode;static Dictionary<IntPtr,byte[]> states;static int closes,privilegeRestores,policyWrites;static Policy current;
 __COMPARE__
 static byte[] Read(IntPtr h){return states[h];}
 static void Write(IntPtr h,byte[] bytes){if(mode=="write"&&h==(IntPtr)1)throw new Exception("controlled object write refusal");states[h]=bytes;}
 static bool CloseDesktop(IntPtr h){closes++;return true;}static bool CloseWindowStation(IntPtr h){closes++;return true;}static bool CloseHandle(IntPtr h){closes++;return true;}
 static Policy Query(){return current;}static bool Equal(Policy a,Policy b){return a.flags==b.flags;}
 static bool AuditSetSystemPolicy(ref Policy p,uint n){policyWrites++;if(mode=="policy-write")return false;if(p.flags!=0)current=new Policy{flags=p.flags==4?0:p.flags};return true;}
 void EnablePrivilege(){if(mode=="enable")throw new Exception("controlled privilege unavailable");privilegeChanged=true;}
 void RestorePrivilege(){privilegeRestores++;if(mode=="privilege")throw new Exception("controlled privilege restore failure");privilegeChanged=false;}
 object ReadRestoredPrivilege(){return originalPrivilege;}
 readonly Dictionary<string,byte[]> saved=new Dictionary<string,byte[]>();
 static byte[] PolicyBytes(Policy value){return new[]{(byte)value.flags};}static byte[] PrivilegeBytes(object value){return new byte[1];}
 void Save(string name,byte[] bytes){if(mode=="retention-before"&&name=="audit-policy-recovery-before.bin"||mode=="retention-command"&&name=="audit-policy-restore-command.bin")throw new Exception("controlled recovery retention failure");saved.Add(name,bytes);}
 __COMMAND__
 __RETENTION__
 static Exception Error(string message){return new Exception(message);}
 __DISPOSE__
 static byte[] Descriptor(string level){var sd=new RawSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)S:(ML;;NW;;;"+level+")");var bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);return bytes;}
 public static void Run(){
  foreach(string selected in new[]{"settled","already","drift","write","policy-drift","policy-write","enable","privilege","success-before","retention-before","retention-command"}){
   mode=selected;closes=privilegeRestores=policyWrites=0;current=new Policy{flags=mode=="policy-drift"?1:mode=="already"?0:2};states=new Dictionary<IntPtr,byte[]>();var control=new RecoveryControl();if(mode=="success-before"){control.before=new Policy{flags=1};control.applied=new Policy{flags=3};current=new Policy{flags=3};}
   byte[] original=Descriptor("LW"),proposed=Descriptor("ME"),foreign=Descriptor("HI");
   for(int i=1;i<=2;i++){IntPtr h=(IntPtr)i;control.objects.Add(new AuditObject{handle=h,name="owned"+i,type=i==1?"Desktop":"WindowStation",original=original,proposed=proposed,attempted=true});states[h]=mode=="already"?original:mode=="drift"&&i==1?foreign:proposed;}
   control.Dispose();
   if(closes!=3||privilegeRestores!=1||Sacl(states[(IntPtr)2])!=Sacl(original))throw new Exception("Independent restore/close skipped: "+mode);
   bool failed=mode!="settled"&&mode!="already"&&mode!="success-before";if((control.recovery.Count>0)!=failed||control.Restored==failed)throw new Exception("Recovery outcome differs: "+mode);
   if(mode=="drift"&&Sacl(states[(IntPtr)1])!=Sacl(foreign))throw new Exception("Foreign SACL overwritten");
   if(mode=="policy-drift"&&current.flags!=1)throw new Exception("Foreign policy overwritten");
   if(mode=="settled"&&(control.saved["audit-policy-restore-command.bin"][0]!=4||control.saved["audit-policy-recovery-observed.bin"][0]!=0||current.flags!=0||control.before.flags!=0))throw new Exception("Queried zero was reused as unchanged setter command");
   if((mode=="retention-before"||mode=="retention-command")&&current.flags!=0)throw new Exception("Recovery retention failure skipped actual restoration");
   if(mode=="success-before"&&(current.flags!=1||control.saved["audit-policy-restore-command.bin"][0]!=1))throw new Exception("Existing success policy lost");
   if(mode=="policy-write"&&(control.saved["audit-policy-recovery-observed.bin"][0]!=2||control.saved.ContainsKey("audit-policy-restored.bin")))throw new Exception("Failed restoration query state not retained");
  }
 }
}
'@
Add-Type -TypeDefinition $harness.Replace('__COMPARE__',$comparison).Replace('__COMMAND__',$command).Replace('__RETENTION__',$retention).Replace('__DISPOSE__',$dispose)
[RecoveryControl]::Run()
'actual audit recovery passed eleven controlled modes; no native privilege, SACL or policy calls'
`);
    assert.match(result, /recovery passed eleven controlled modes/u);
  },
);

void test(
  "audit diagnostic retention keeps the primary failure after observation or record I/O fails",
  { skip: process.platform !== "win32" },
  () => {
    const script = fileURLToPath(
      new URL("./release-hosted-native-windows-setup.ps1", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}')
$block=[regex]::Match($source,'(?s)(        \$auditRecord=.*?)(?=        try\{\$position=)').Groups[1].Value
if(-not $block){throw 'Actual audit catch retention block missing'}
foreach($mode in @('read','unknown','inactive')){
 $cleanupFailures=[Collections.Generic.List[string]]::new();$primaryError=[Exception]::new('original GUI failure');$capture='C:\bounded';$context=@{};$runtime='fixed';$observedMode=$mode
 $child=[pscustomobject]@{Pid=42;CreatedFileTime=[long]1;HostedTokenObservation=[pscustomobject]@{AuthenticationId='0x1'}}
 $child|Add-Member ScriptMethod RequireAliveGeneration {}
 $audit=[pscustomobject]@{};$audit|Add-Member ScriptMethod Observe {if($observedMode -ceq 'unknown'){throw 'controlled observer refusal'};return @()};if($mode -ceq 'inactive'){$audit=$null}
 function Write-HostedNativeSetupRecord {$script:lastAuditRecord=$args[1];throw 'controlled record I/O refusal'}
 try{& ([scriptblock]::Create($block));throw $primaryError}catch{if($_.Exception.Message -cne 'original GUI failure'){throw 'Diagnostic replaced primary error'}}
 if($mode -ceq 'inactive' -and $script:lastAuditRecord.status -cne 'not_attempted'){throw 'Inactive audit was not retained as unattempted'}
 if($cleanupFailures.Count -ne 1 -or $cleanupFailures[0] -notmatch '^Audit diagnostic retention failed:'){throw 'Retention failure not isolated'}
}
'actual audit catch keeps primary failure in all controlled I/O modes'
`);
    assert.match(result, /keeps primary failure in all controlled I\/O modes/u);
  },
);

void test(
  "audit controls detach and close owned objects and read actual restored privilege",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${audit.replaceAll("'", "''")}')
$control=[regex]::Match($source,'(?s)  void ProveDenials\(\)\{.*?(?=  static Policy RestorePolicyCommand)').Value.Replace('Marshal.GetLastWin32Error()','5')
$enable=[regex]::Match($source,'(?s)  void EnablePrivilege\(\).*?(?=  Privileges ReadRestoredPrivilege)').Value.Replace('Marshal.GetLastWin32Error()','0')
$privilege=[regex]::Match($source,'(?s)  Privileges ReadRestoredPrivilege\(\).*?(?=  void Save)').Value.Replace('Marshal.GetLastWin32Error()','0')
$comparison=[regex]::Match($source,'(?s)  static string Sacl\(.*?(?=  sealed class AuditObject)').Value
$proposal=[regex]::Match($source,'(?s)  public static byte\[\] Propose\(.*?(?=  static string Sacl)').Value
$harness=@'
using System;using System.Collections.Generic;using System.Diagnostics;using System.IO;using System.Linq;using System.Runtime.InteropServices;using System.Security.AccessControl;using System.Security.Principal;using System.Text;using System.Threading;
public class AuditLifecycleControl {
 struct Attributes {internal uint length;internal IntPtr descriptor;}
 struct Luid {internal uint low;internal int high;}
 struct Privileges {internal uint count,attributes;internal Luid id;}
 readonly List<string> recovery=new List<string>();public Dictionary<string,string>[] CapabilityEvents;
 int session=1;IntPtr token=(IntPtr)9;bool privilegeKnown=true,privilegeChanged;Privileges originalPrivilege=new Privileges{count=1,id=new Luid{low=1,high=0},attributes=2};
 static string mode="";static IntPtr desktop=(IntPtr)1;static int closes,restores,adjusts;static bool written;static uint actualAttributes=2;
 static uint PrivilegeAttributes(Luid id){return actualAttributes;}
 static bool AdjustTokenPrivileges(IntPtr t,bool d,ref Privileges desired,uint length,out Privileges previous,out uint returned){adjusts++;previous=desired;returned=16;if(mode=="adjust-fail"||mode=="restore-fail")return false;actualAttributes=desired.attributes;return true;}
 static IntPtr GetCurrentProcess(){return (IntPtr)1;}static bool OpenProcessToken(IntPtr p,uint access,out IntPtr t){t=(IntPtr)9;return true;}static bool LookupPrivilegeValueW(string s,string n,out Luid id){id=new Luid{low=1,high=0};return true;}
 static Exception Error(string value){return new Exception(value);}
 static uint GetCurrentThreadId(){return 1;}static IntPtr GetThreadDesktop(uint thread){return desktop;}
 static bool SetThreadDesktop(IntPtr original){restores++;if(mode=="detach")return false;desktop=original;return true;}
 static IntPtr GetProcessWindowStation(){return (IntPtr)100;}static string stationName,desktopName;static string Name(IntPtr h){return h==(IntPtr)10?stationName:h==(IntPtr)20?desktopName:"WinSta0";}
 static IntPtr CreateWindowStationW(string n,uint f,uint a,ref Attributes at){stationName=n;written=false;return (IntPtr)10;}
 static IntPtr CreateDesktopW(string n,IntPtr d,IntPtr m,uint f,uint a,ref Attributes at){desktopName=n;written=false;if(mode!="unchanged")desktop=(IntPtr)20;return (IntPtr)20;}
 static bool CloseWindowStation(IntPtr h){closes++;return true;}
 static bool CloseDesktop(IntPtr h){closes++;return desktop!=h&&mode!="close";}
 static IntPtr OpenWindowStationW(string n,bool i,uint a){return IntPtr.Zero;}static IntPtr OpenDesktopW(string n,uint f,bool i,uint a){return IntPtr.Zero;}
 static byte[] Read(IntPtr h){var sd=new RawSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)");var b=new byte[sd.BinaryLength];sd.GetBinaryForm(b,0);if(written&&mode!="readback"){string sid=WindowsIdentity.GetCurrent().User.Value;sd=new RawSecurityDescriptor(Propose(b,sid,2),0);sd.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessDenied,2,new SecurityIdentifier(sid),false,null));b=new byte[sd.BinaryLength];sd.GetBinaryForm(b,0);}return b;}
 static bool SetUserObjectSecurity(IntPtr h,ref uint f,IntPtr data){written=true;return true;}
 static string CurrentLogon(){return "0x1";}
 static Dictionary<string,string>[] ReadEvents(string sid,uint pid,long since,string image,string logon,string[] names,int session){return new[]{new Dictionary<string,string>{{"access_mask","0x2"}}};}
 public static void BoundRecords(Dictionary<string,string>[] records){}
 static byte[] PrivilegeBytes(Privileges value){return new byte[1];}
 void Save(string n,byte[] b){if(mode=="preimage")throw new IOException("controlled preimage refusal");}
 __ENABLE__
 __COMPARISON__
 __PROPOSAL__
 __PRIVILEGE__
 __CONTROL__
 public static void Run(){
  foreach(string selected in new[]{"settled","unchanged","detach","close","readback"}){mode=selected;desktop=(IntPtr)1;closes=restores=0;var value=new AuditLifecycleControl();bool failed=false;try{value.ProveDenials();}catch{failed=true;}if(failed!=(mode!="settled"&&mode!="unchanged")||closes!=(mode=="readback"?1:2)||restores<(mode=="unchanged"||mode=="readback"?0:1))throw new Exception("Control lifecycle outcome differs: "+mode);if((mode=="settled"||mode=="unchanged")&&(desktop!=(IntPtr)1||value.CapabilityEvents.Length!=2||value.recovery.Count!=0))throw new Exception("Owned control desktop not restored");if(mode!="settled"&&mode!="unchanged"&&mode!="readback"&&value.recovery.Count==0)throw new Exception("Control cleanup failure lost");}
  foreach(string selected in new[]{"preimage","adjust-fail","restore-fail","disabled-roundtrip","enabled-roundtrip"}){mode=selected;actualAttributes=mode=="enabled-roundtrip"?2u:0u;adjusts=0;var value=new AuditLifecycleControl();value.privilegeKnown=false;value.token=IntPtr.Zero;bool failed=false;try{if(mode=="restore-fail")mode="disabled-roundtrip";value.EnablePrivilege();if(selected=="restore-fail")mode=selected;value.RestorePrivilege();value.ReadRestoredPrivilege();}catch{failed=true;}bool expected=selected=="preimage"||selected=="adjust-fail"||selected=="restore-fail";if(failed!=expected)throw new Exception("Enable/restore failure lost: "+selected);if(selected=="preimage"&&adjusts!=0)throw new Exception("Enabled privilege before persisted preimage");if(!expected&&actualAttributes!=(selected=="enabled-roundtrip"?2u:0u))throw new Exception("Privilege state changed after roundtrip");}
  foreach(string selected in new[]{"enabled","disabled","drift-enabled","drift-disabled","restoring"}){mode=selected;var value=new AuditLifecycleControl();value.originalPrivilege.attributes=mode.Contains("disabled")||mode=="restoring"?0u:2u;actualAttributes=mode.StartsWith("drift")?1u:mode=="restoring"?2u:value.originalPrivilege.attributes;value.privilegeChanged=mode=="restoring";bool refused=false;try{value.RestorePrivilege();var read=value.ReadRestoredPrivilege();if(read.attributes!=actualAttributes)throw new Exception("Invented privilege readback");}catch{refused=true;}if(refused!=mode.StartsWith("drift"))throw new Exception("Actual privilege drift guard differs: "+mode);}
 }
}
'@
if(-not $control -or -not $privilege -or -not $proposal){throw 'Actual lifecycle methods missing'}
Add-Type -TypeDefinition $harness.Replace('__ENABLE__',$enable).Replace('__COMPARISON__',$comparison).Replace('__PROPOSAL__',$proposal).Replace('__PRIVILEGE__',$privilege).Replace('__CONTROL__',$control)
[AuditLifecycleControl]::Run()
'actual lifecycle passed five object and ten privilege modes with fake native effects'
`);
    assert.match(result, /five object and ten privilege modes/u);
  },
);

void test(
  "finite Security event read timeout supplies no evidence and preserves other errors",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${audit.replaceAll("'", "''")}')
$query=[regex]::Match($source,'(?s)  static string BuildEventQuery\(.*?(?=  static Dictionary<string,string>\[\] ReadEventsCore)').Value
$method=[regex]::Match($source,'(?s)  static Dictionary<string,string>\[\] ReadEventsCore\(.*?(?=  public void Dispose)').Value
$harness=@'
using System;using System.Collections.Generic;using System.Diagnostics;using System.Diagnostics.Eventing.Reader;using System.Linq;using System.Xml;using System.Security.Principal;
public class ReaderControl {
 static string mode;static int closes,reads;
 class Stopwatch{internal static Stopwatch StartNew(){return new Stopwatch();}internal long ElapsedMilliseconds{get{return reads*250L;}}}
 enum PathType{LogName}
 class EventLogQuery {internal EventLogQuery(string p,PathType t,string q){}internal bool ReverseDirection{get;set;}}
 class Failure:EventLogException{internal Failure(int code):base(code){}}
 class EventRecord:IDisposable{public string ToXml(){if(mode=="render-timeout")throw new Failure(1460);return "fixed";}public void Dispose(){if(mode=="dispose-timeout")throw new Failure(1460);}}
 class EventLogReader:IDisposable{
  internal EventLogReader(EventLogQuery query){if(mode=="constructor-timeout")throw new Failure(1460);}
  internal int BatchSize{get;set;}=64;
  internal EventRecord ReadEvent(TimeSpan budget){reads++;if(BatchSize!=1)throw new Exception("Batch demand not bounded to one");if(budget.TotalMilliseconds!=250)throw new Exception("Read budget changed");if(mode=="timeout"||mode=="record-then-timeout"&&reads>1||(mode=="timeout-then-record"||mode=="timeout-then-invalid")&&reads==1)throw new Failure(1460);if(mode=="access")throw new UnauthorizedAccessException();if(mode=="invalid"||mode=="timeout-then-invalid")throw new Failure(15001);return (mode=="record"||mode=="record-then-timeout"||mode=="render-timeout"||mode=="dispose-timeout")&&reads==1||mode=="timeout-then-record"&&reads==2?new EventRecord():null;}
  public void Dispose(){closes++;}
 }
 static Dictionary<string,string> SelectRecord(string xml,string sid,uint pid,long created,string image,string logon,string[] names,int session){return new Dictionary<string,string>{{"record_id","1"}};}
 static void BoundRecords(Dictionary<string,string>[] records){if(records.Length>8)throw new Exception("Unbounded records");}
 __QUERY__
 __METHOD__
 public static void Run(){foreach(string value in new[]{"empty","timeout","record","access","invalid","constructor-timeout","render-timeout","dispose-timeout","record-then-timeout","timeout-then-record","timeout-then-invalid"}){mode=value;closes=reads=0;bool refused=false;Dictionary<string,string>[] records=null;try{records=ReadEventsCore("S-1-5-21-1-2-3-1001",42,DateTime.UtcNow.AddSeconds(-1).ToFileTimeUtc(),"fixed","0x1",new[]{"Desktop:owned"},1);}catch{refused=true;}bool expected=mode=="access"||mode=="invalid"||mode=="constructor-timeout"||mode=="render-timeout"||mode=="dispose-timeout"||mode=="timeout-then-invalid";if(refused!=expected||closes!=(mode=="constructor-timeout"?0:1))throw new Exception("Reader error/ownership differs: "+mode);if(!expected&&records.Length!=(mode=="record"||mode=="record-then-timeout"||mode=="timeout-then-record"?1:0))throw new Exception("Invented event evidence: "+mode);if((mode=="timeout"||mode=="record-then-timeout")&&reads!=8)throw new Exception("Original total read deadline not enforced");}}
}
'@
Add-Type -AssemblyName System.Diagnostics.EventLog
$references=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+[System.Diagnostics.Eventing.Reader.EventLogReader].Assembly.Location
Add-Type -ReferencedAssemblies $references -TypeDefinition $harness.Replace('__QUERY__',$query).Replace('__METHOD__',$method)
[ReaderControl]::Run()
'actual finite reader passed eleven fake modes; timeout is not event evidence'
`);
    assert.match(result, /eleven fake modes/u);
  },
);

void test(
  "owner audit station name query requires read attributes without privilege changes",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Diagnostics.EventLog
$references=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+[System.Diagnostics.Eventing.Reader.EventLogReader].Assembly.Location
Add-Type -ReferencedAssemblies $references -TypeDefinition ([IO.File]::ReadAllText('${audit.replaceAll("'", "''")}'))
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class AuditNameReadOnly {
 [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
 [DllImport("user32",SetLastError=true)] public static extern bool CloseWindowStation(IntPtr handle);
 [DllImport("user32")] public static extern IntPtr GetProcessWindowStation();
}
'@
$name=[Portcove.HostedNative.AccessAudit].GetMethod('Name',[Reflection.BindingFlags]'NonPublic,Static')
$original=[AuditNameReadOnly]::GetProcessWindowStation();$before=$name.Invoke($null,@($original))
foreach($mask in @(0x20000,0x20002)){
 $handle=[AuditNameReadOnly]::OpenWindowStationW('WinSta0',$false,$mask)
 if($handle -eq [IntPtr]::Zero){throw 'Readonly contract station open failed'}
 try{
  $refused=$false;$observed=$null
  try{$observed=$name.Invoke($null,@($handle))}catch{if($_.Exception.GetBaseException() -isnot [ComponentModel.Win32Exception] -or $_.Exception.GetBaseException().NativeErrorCode -ne 5 -or $_.Exception.Message -notmatch 'Win32=5'){throw};$refused=$true}
  if(($mask -eq 0x20000 -and -not $refused) -or ($mask -eq 0x20002 -and ($refused -or $observed -cne 'WinSta0'))){throw 'Actual object-name access contract differs'}
 }finally{if(-not [AuditNameReadOnly]::CloseWindowStation($handle)){throw 'Readonly station handle close failed'}}
}
if([AuditNameReadOnly]::GetProcessWindowStation() -ne $original -or $name.Invoke($null,@($original)) -cne $before){throw 'Readonly name query changed process station'}
'actual name helper: READ_CONTROL denied5, READ_CONTROL plus READATTRIBUTES read; no privilege, ACL, policy or desktop changes'
`);
    assert.match(result, /READ_CONTROL denied5/u);
  },
);

void test(
  "structured audit queries retain exact per-object selectors and compile without reading records",
  { skip: process.platform !== "win32" },
  () => {
    const audit = fileURLToPath(
      new URL("./release-hosted-native-windows-audit.cs.txt", import.meta.url),
    );
    const result = powershell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Diagnostics.EventLog
$references=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+[System.Diagnostics.Eventing.Reader.EventLogReader].Assembly.Location
Add-Type -ReferencedAssemblies $references -TypeDefinition ([IO.File]::ReadAllText('${audit.replaceAll("'", "''")}'))
$builder=[Portcove.HostedNative.AccessAudit].GetMethod('BuildEventQuery',[Reflection.BindingFlags]'NonPublic,Static')
$sid='S-1-5-21-1-2-3-1001';$stamp=[DateTime]::UtcNow.AddMinutes(-1).ToFileTimeUtc()
$objects=@('WindowStation:WinSta0','Desktop:PortcoveHosted_fixture','Desktop:Default','Desktop:Input_fixture')
foreach($count in 1..4){
 $selected=[string[]]$objects[0..($count-1)]
 $text=$builder.Invoke($null,@($sid,[uint32]42,[long]$stamp,'0x123',$selected,[int]2));$xml=[xml]$text
 $selectors=@($xml.QueryList.Query.Select)
 if($selectors.Count -ne $count -or $xml.QueryList.Query.Path -cne 'Security'){throw 'Structured query lost object selectors'}
 foreach($select in $selectors){
  $predicate=$select.InnerText
  if($select.Path -cne 'Security' -or [regex]::Matches($predicate,'=').Count -gt 20 -or -not $predicate.Contains("Data[@Name='SubjectUserSid']='$sid'") -or -not $predicate.Contains("Data[@Name='ProcessId']='0x2a'") -or -not $predicate.Contains("Data[@Name='SubjectLogonId']='0x123'")){throw 'Per-object subject/complexity boundary changed'}
 }
 # Compile the same selectors on a public channel; never call ReadEvent or open Security locally.
 $publicXml=$text.Replace('Path="Security"','Path="Application"')
 $query=[Diagnostics.Eventing.Reader.EventLogQuery]::new('Application',[Diagnostics.Eventing.Reader.PathType]::LogName,$publicXml)
 $reader=[Diagnostics.Eventing.Reader.EventLogReader]::new($query)
 $reader.Dispose()
}
foreach($bad in @(@('WindowStation:WinSta0','WindowStation:WinSta0'),@('Other:WinSta0'),@('Desktop:bad"name'),@('Desktop:a','Desktop:b','Desktop:c','Desktop:d','Desktop:e'))){
 $refused=$false;try{$builder.Invoke($null,@($sid,[uint32]42,[long]$stamp,'0x123',[string[]]$bad,[int]2))|Out-Null}catch{$refused=$true};if(-not $refused){throw 'Unsafe/duplicate/overbound object query accepted'}
}
'one-to-four structured selectors compiled; no record, Security, privilege, SACL or policy read/write'
`);
    assert.match(result, /structured selectors compiled/u);
  },
);
