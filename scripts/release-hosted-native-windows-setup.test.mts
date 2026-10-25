import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  broker_created_filetime: "123456789",
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
function powershell(program: string) {
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
      timeout: 15000,
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
$launch=$ast.Find({param($n)$n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -ceq 'StartVerifiedInGroup'},$true)
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

void test("hosted account cleanup still disables its exact identity after teardown fails and retains both outcomes", (t) => {
  const root = mkdtempSync(path.join(homedir(), ".portcove-hosted-cleanup-test-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(homedir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  const result = powershell(String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Actual setup script parse failure'}
$write=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-HostedNativeSetupRecord'},$true)
. ([scriptblock]::Create($write.Extent.Text))
$main=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($main.Count -ne 1){throw 'Actual cleanup boundary differs'}
$base='${root.replaceAll("'", "''")}';$nativeProfile='inert profile';$context=@{fixture='controlled-providers'}
foreach($failDisable in @($false,$true)){
$root=Join-Path $base ([string]$failDisable);[IO.Directory]::CreateDirectory($root)|Out-Null
$account=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'};Description='owned diagnostic';Enabled=$true}
$group=[pscustomobject]@{};$group|Add-Member ScriptMethod StopAndObserve {param($timeout)throw 'controlled group teardown failure'}
$group|Add-Member ScriptMethod Dispose {}
$child=[pscustomobject]@{Pid=42;CreatedFileTime=[long]123};$child|Add-Member ScriptMethod Dispose {}
$password=$null;$disabled=$false;$settled=$false;$failure='original observation refusal';$observation=$null
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
`);
  assert.match(result, /independently disables exact account/u);
});

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
foreach($kind in @('generation','deadline')){
$root=Join-Path '${root.replaceAll("'", "''")}' ('not-created-'+$kind)
$context=@{broker_pid=$PID;broker_created_filetime=$(if($kind -ceq 'generation'){'1'}else{([Diagnostics.Process]::GetCurrentProcess()).StartTime.ToFileTimeUtc().ToString()})}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalSeconds=$(if($kind -ceq 'deadline'){60}else{0})}}
$refused=$false;try{. ([scriptblock]::Create(($statements[($index-1)..($index+1)].Extent.Text -join [Environment]::NewLine)))}catch{$refused=$true}
if(-not $refused -or (Test-Path -LiteralPath $root)){throw 'Stale parent permitted the first directory effect'}
}
'actual pre-effect parent-generation fence refused without directory creation'
`);
    assert.match(result, /without directory creation/u);
  },
);
