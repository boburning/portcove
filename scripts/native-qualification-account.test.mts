import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { readFileSync, copyFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { windowsOwnerEnvironment } from "./release-windows-owner-mechanism.mts";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";
import { homedir } from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { windowsSourceSystemExecutables } from "./release-native-runtime-custody.mts";

function actualDiagnosticOwnerEnvironment(directory: string): NodeJS.ProcessEnv {
  const controller = readFileSync(
    new URL("./release-hosted-native-windows-diagnostic.mts", import.meta.url),
    "utf8",
  );
  const start = controller.indexOf("function environment(root: string)");
  const end = controller.indexOf("\nasync function retain(", start);
  assert.ok(start > 0 && end > start);
  const jobEnvironment = {
    ...process.env,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_JOB: "installed-prerequisite",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-s2-20261028",
    PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "true",
    PORTCOVE_HOSTED_PLATFORM: "windows-x86_64",
    PORTCOVE_HOSTED_OBSERVATION_ONLY: "false",
  };
  // Execute the actual controller projection; richer workflow inputs must not mask A's narrower environment.
  const result = runInNewContext(
    stripTypeScriptTypes(controller.slice(start, end) + "\nenvironment(directory)"),
    {
      windowsOwnerEnvironment: (root: string) => windowsOwnerEnvironment(root, jobEnvironment),
      process: { env: jobEnvironment },
      directory,
    },
  ) as NodeJS.ProcessEnv;
  for (const key of [
    "PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC",
    "PORTCOVE_HOSTED_PLATFORM",
    "PORTCOVE_HOSTED_OBSERVATION_ONLY",
  ])
    assert.equal(Object.hasOwn(result, key), false);
  return result;
}

void test("actual bridge entry separates held production from fixed diagnostic scope before input reads", () => {
  const source = readFileSync(
    new URL("./native-qualification-account-bridge.ps1", import.meta.url),
    "utf8",
  );
  const boundary = source.indexOf("# This is fixed owner-side launch plumbing");
  assert.ok(boundary > 0);
  const prefix = source.slice(0, boundary);
  assert.equal(prefix.split("$hostedCandidateExecutionAuthorized = $false").length, 2);
  assert.equal(prefix.split("$hostedDiagnosticCandidateExecutionAuthorized = $false").length, 2);
  const script = String.raw`
$ErrorActionPreference='Stop'
$original=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PORTCOVE_TEST_BRIDGE_PREFIX))
$activated=$original.Replace('$hostedDiagnosticCandidateExecutionAuthorized = $false','$hostedDiagnosticCandidateExecutionAuthorized = $true')
# Inert entry-only fixture. No owner identity, ACL, credential, account, group or candidate operation is evaluated.
$activated=$activated.Replace('[Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT','$false')
$activated+=";Write-Output 'entry-only-diagnostic-accepted'"
function Invoke-Entry([string]$code,$memory,[string]$expected) {
 $accepted=$false
 try {$value=& ([scriptblock]::Create($code)) -Configuration 'nonexistent-input-must-not-be-read.json' -ExpectedConfigurationSha256 ('a'*64) -InvocationId ('b'*64) -HostedMemoryContext $memory
  if($expected -cne 'accept'){throw 'Unexpected entry acceptance'}
  if($value -cne 'entry-only-diagnostic-accepted'){throw 'Inert entry marker absent'};$accepted=$true
 }catch{if($expected -ceq 'accept' -or -not $_.Exception.Message.Contains($expected)){throw}}
 if($expected -ceq 'accept' -and -not $accepted){throw 'Expected inert entry did not return'}
}
$fixed=@{};($env:PORTCOVE_TEST_ACTUAL_A_ENVIRONMENT|ConvertFrom-Json).PSObject.Properties|ForEach-Object{$fixed[$_.Name]=[string]$_.Value}
foreach($key in $fixed.Keys){[Environment]::SetEnvironmentVariable($key,$fixed[$key])}
Invoke-Entry $original @{} 'awaits separate candidate execution authority'
Invoke-Entry $original @{diagnostic=$true} 'awaits separate diagnostic execution authority'
Invoke-Entry $activated @{} 'awaits separate candidate execution authority'
Invoke-Entry $activated @{diagnostic=$false} 'Fixed diagnostic memory scope required'
Invoke-Entry $activated @{diagnostic='true'} 'Fixed diagnostic memory scope required'
Invoke-Entry $activated @{diagnostic=$true} 'accept'
foreach($key in @($fixed.Keys|Where-Object{$_ -like 'GITHUB_*' -or $_ -ceq 'RUNNER_ENVIRONMENT'})){
 [Environment]::SetEnvironmentVariable($key,'wrong-context')
 Invoke-Entry $activated @{diagnostic=$true} 'Fixed hosted diagnostic bridge context required'
 [Environment]::SetEnvironmentVariable($key,$fixed[$key])
}
foreach($ref in @('boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/main','boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-other','boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/tags/feature/534-connected-native-s2-20261028')){
 $env:GITHUB_WORKFLOW_REF=$ref;Invoke-Entry $activated @{diagnostic=$true} 'Fixed hosted diagnostic bridge context required'
}
Write-Output 'held-production-fixed-diagnostic-entry-controls-pass'
`;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      PORTCOVE_TEST_BRIDGE_PREFIX: Buffer.from(prefix).toString("base64"),
      PORTCOVE_TEST_ACTUAL_A_ENVIRONMENT: JSON.stringify(
        actualDiagnosticOwnerEnvironment("C:\\inert-owner"),
      ),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /held-production-fixed-diagnostic-entry-controls-pass/u);
});

void test(
  "hosted candidate launcher and memory bridge refuse before effects under separate source holds",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_HELPER))
if ([Portcove.NativeQualification.AccountLauncher]::HostedCandidateExecutionAuthorized) { throw 'Candidate source hold changed' }
$refused=$false
try { [Portcove.NativeQualification.AccountLauncher]::StartHostedCandidateVerifiedInGroup($null,$null,$null,$null,$null,$null,$null,$null,$false,$null) | Out-Null }
catch { if (-not $_.Exception.Message.Contains('awaits separate owner authority')) { throw }; $refused=$true }
if (-not $refused) { throw 'Candidate launcher accepted an unowned group' }
$refused=$false
try { & ([scriptblock]::Create([IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_BRIDGE))) -Configuration 'C:\portcove-nonexistent-held-input.json' -ExpectedConfigurationSha256 ('a'*64) -InvocationId ('b'*64) -HostedMemoryContext @{} }
catch { if (-not $_.Exception.Message.Contains('awaits separate candidate execution authority')) { throw }; $refused=$true }
if (-not $refused) { throw 'Memory bridge reached an input or credential operation' }
Write-Output 'hosted-candidate-held-before-effects'
`;
    const result = spawnSync(
      windowsSourceSystemExecutables.powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PORTCOVE_TEST_NATIVE_HELPER: fileURLToPath(
            new URL("./native-qualification-account.cs.txt", import.meta.url),
          ),
          PORTCOVE_TEST_NATIVE_BRIDGE: fileURLToPath(
            new URL("./native-qualification-account-bridge.ps1", import.meta.url),
          ),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hosted-candidate-held-before-effects/);
  },
);

void test(
  "closed credential purpose keeps primary default and separately names public proof without reading credentials",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath $env:PORTCOVE_TEST_NATIVE_HELPER -Raw)
$config=[Portcove.NativeQualification.AccountConfiguration]::new()
if([Portcove.NativeQualification.AccountLauncher]::CredentialTargetFor($config) -cne 'Portcove/native-qualification/local-account/v1'){throw 'primary credential target changed'}
$config.CredentialPurpose=[Portcove.NativeQualification.AccountCredentialPurpose]::OrdinaryPublicProof
if([Portcove.NativeQualification.AccountLauncher]::CredentialTargetFor($config) -cne 'Portcove/public-update-proof/local-account/v1'){throw 'public credential target not distinct'}
$config.CredentialPurpose=[Enum]::ToObject([Portcove.NativeQualification.AccountCredentialPurpose],99)
$refused=$false;try{[Portcove.NativeQualification.AccountLauncher]::CredentialTargetFor($config)|Out-Null}catch{$refused=$true}
if(-not $refused){throw 'unknown credential target accepted'}
Write-Output 'closed-credential-purpose-pass'
`;
    const result = spawnSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          PORTCOVE_TEST_NATIVE_HELPER: fileURLToPath(
            new URL("./native-qualification-account.cs.txt", import.meta.url),
          ),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /closed-credential-purpose-pass/u);
  },
);

void test(
  "bridge state retains actual root image and startup identity for partial or complete capture",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_BRIDGE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'bridge parse failure'}
foreach($name in @('Save-State','Convert-Teardown')){
  $function=$ast.FindAll({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name
  if(@($function).Count -ne 1){throw 'missing fixed function'}
  Invoke-Expression $function.Extent.Text
}
function Write-Capture {param($Id,$Process)}
$capture=Join-Path ([IO.Path]::GetTempPath()) ('native-root-capture-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($capture)|Out-Null
try{
  $configurationValue=[pscustomobject]@{capture_root=$capture}
  $InvocationId='a'*64;$ExpectedConfigurationSha256='b'*64;$sequence=1
  $roots=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  $launchIdentities=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  $roots.Add('fixture-root',[pscustomobject]@{Id=123;CreatedFileTime=134000000000000000L;Path='C:\\fixed\\inert.exe';StartTime=[DateTime]::Parse('2026-10-20T12:00:00Z').ToUniversalTime();LastTeardown=$null})
  $launchIdentities.Add('fixture-root',[ordered]@{sha256=('c'*64)})
  $group=[pscustomobject]@{}; $group|Add-Member ScriptMethod RemainingPids {return @()}
  Save-State 'running'
  $stateText=Get-Content -LiteralPath (Join-Path $capture 'bridge-state.json') -Raw
  $state=$stateText|ConvertFrom-Json
  if($state.roots.Count -ne 1 -or $state.roots[0].path -cne 'C:\\fixed\\inert.exe' -or
    $state.roots[0].sha256 -cne ('c'*64) -or $stateText -cnotmatch '"started_at":\\s*"2026-10-20T12:00:00[.]000Z"' -or
    $null -ne $state.roots[0].teardown -or $state.native_acceptance -cne 'not-established'){throw 'root capture identity missing'}
  [ordered]@{roots=$state.roots.Count;partial_teardown=$true;scope='inert root projection; no process launch or native acceptance'}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $capture -Recurse -Force}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_BRIDGE: fileURLToPath(
          new URL("./native-qualification-account-bridge.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      roots: 1,
      partial_teardown: true,
      scope: "inert root projection; no process launch or native acceptance",
    });
  },
);

void test(
  "fixed Windows account helper compiles and validates inert requests without credentials or logon",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const helper = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath $env:PORTCOVE_TEST_NATIVE_HELPER -Raw)
$fixtureTokens = $null; $fixtureErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_FIXTURE, [ref]$fixtureTokens, [ref]$fixtureErrors)
if ($fixtureErrors.Count -ne 0) { throw 'Fixed inert GUI fixture did not parse' }
$null = [Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_BRIDGE, [ref]$fixtureTokens, [ref]$fixtureErrors)
if ($fixtureErrors.Count -ne 0) { throw 'Fixed native bridge did not parse' }
$null = [Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_CLIENT, [ref]$fixtureTokens, [ref]$fixtureErrors)
if ($fixtureErrors.Count -ne 0) { throw 'Fixed native client did not parse' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$configuration = [Portcove.NativeQualification.AccountConfiguration]::new()
$configuration.UserName = 'PortcoveNativeQualification'
$configuration.AccountSid = 'S-1-5-21-100-200-300-9999'
$configuration.BrokerSid = $owner
$configuration.ProfileRoot = 'C:\\Users\\PortcoveNativeQualification'
$configuration.WorkRoot = 'C:\\ProgramData\\PortcoveNativeQualification\\work'
$configuration.PrivateDesktop = 'PortcoveNative_0123456789abcdef0123456789abcdef\\Qualification'
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment['SystemRoot'] = $env:SystemRoot
$environment['WINDIR'] = $env:SystemRoot
$environment['PATH'] = Join-Path $env:SystemRoot 'System32'
$environment['USERPROFILE'] = $configuration.ProfileRoot
$environment['HOMEDRIVE'] = 'C:'
$environment['HOMEPATH'] = '\\Users\\PortcoveNativeQualification'
foreach ($name in @('APPDATA','LOCALAPPDATA','TEMP','TMP')) { $environment[$name] = $configuration.WorkRoot + '\\' + $name }
$executable = Join-Path $env:SystemRoot 'System32\\whoami.exe'
$directory = $configuration.WorkRoot + '\\attempt'
$validate = { [Portcove.NativeQualification.AccountLauncher]::Validate($configuration, $executable, [string[]]@('/user'), $directory, $environment) }
& $validate
$refusals = 0
function Refuses([scriptblock]$operation) {
  try { & $operation; throw 'MISSING REFUSAL' } catch { if ($_.Exception.Message -eq 'MISSING REFUSAL') { throw }; $script:refusals++ }
}
$environment['GH_TOKEN'] = 'inert-forbidden'
Refuses $validate
$environment.Remove('GH_TOKEN') | Out-Null
$environment['PATH'] = $configuration.WorkRoot
Refuses $validate
$environment['PATH'] = Join-Path $env:SystemRoot 'System32'
$environment['TEMP'] = $env:TEMP
Refuses $validate
$environment['TEMP'] = $configuration.WorkRoot + '\\TEMP'
$configuration.PrivateDesktop = 'WinSta0\\Default'
Refuses $validate
$configuration.PrivateDesktop = 'PortcoveNative_0123456789abcdef0123456789abcdef\\Qualification'
$configuration.AccountSid = $owner
Refuses $validate
$configuration.AccountSid = 'S-1-5-21-100-200-300-9999'
$configuration.BrokerSid = 'S-1-5-21-100-200-300-8888'
Refuses $validate
$configuration.BrokerSid = $owner
Refuses { [Portcove.NativeQualification.AccountLauncher]::Validate($configuration, $executable, [string[]]@('x' * 1024), $directory, $environment) }
Refuses { [Portcove.NativeQualification.AccountLauncher]::Validate($configuration, $executable, [string[]]@('/user'), $env:TEMP, $environment) }
Refuses { [Portcove.NativeQualification.AccountLauncher]::Start($configuration, $null, $executable, [string[]]@('/user'), $directory, $environment) }
$environment['PORTCOVE_LIBRARY'] = $configuration.WorkRoot + '\\library'
$environment['PORTCOVE_PREFERENCES'] = $configuration.WorkRoot + '\\preferences.json'
$environment['WEBVIEW2_USER_DATA_FOLDER'] = $configuration.WorkRoot + '\\webview'
$environment['TAURI_WEBDRIVER_PORT'] = '4445'
$environment['PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL'] = 'http://127.0.0.1:4446/fixture'
& $validate
$environment['PORTCOVE_LIBRARY'] = $env:TEMP
Refuses $validate
$environment['PORTCOVE_LIBRARY'] = $configuration.WorkRoot + '\\library'
$environment['TAURI_WEBDRIVER_PORT'] = '04445'
Refuses $validate
$environment['TAURI_WEBDRIVER_PORT'] = '4445'
$environment['PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL'] = 'https://example.com/fixture'
Refuses $validate
$environment['PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL'] = 'http://secret@127.0.0.1:4446/fixture'
Refuses $validate
$environment.Remove('PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL') | Out-Null
$environment['PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE'] = 'running'
Refuses $validate
$environment['PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE'] = 'closed'
& $validate
$environment['PORTCOVE_UNREVIEWED_EXECUTION_MODE'] = 'inert'
Refuses $validate
$environment.Remove('PORTCOVE_UNREVIEWED_EXECUTION_MODE') | Out-Null
$nsisTarget = $configuration.WorkRoot + '\\install with spaces'
$nsis = [Portcove.NativeQualification.AccountLauncher]::NsisCommandLine($executable, [string[]]@('/S', ('/D=' + $nsisTarget)), $configuration.WorkRoot)
Refuses { [Portcove.NativeQualification.AccountLauncher]::NsisCommandLine($executable, [string[]]@('/NCRC'), $configuration.WorkRoot) }
Refuses { [Portcove.NativeQualification.AccountLauncher]::NsisCommandLine($executable, [string[]]@('/S', '/D=C:\\outside'), $configuration.WorkRoot) }
Refuses { [Portcove.NativeQualification.AccountLauncher]::NsisCommandLine($executable, [string[]]@('/S', ('/D="' + $nsisTarget + '"')), $configuration.WorkRoot) }
[ordered]@{ refusals = $refusals; nsis_tail = $nsis.EndsWith('/S /D=' + $nsisTarget); quote = [Portcove.NativeQualification.AccountLauncher]::Quote('a"b\\'); logon_attempted = $false; credentials_supplied = $false; scope = 'compile and input-validation only' } | ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_HELPER: helper,
        PORTCOVE_TEST_NATIVE_FIXTURE: fileURLToPath(
          new URL("./fixtures/native-account-gui-probe.ps1", import.meta.url),
        ),
        PORTCOVE_TEST_NATIVE_BRIDGE: fileURLToPath(
          new URL("./native-qualification-account-bridge.ps1", import.meta.url),
        ),
        PORTCOVE_TEST_NATIVE_CLIENT: fileURLToPath(
          new URL("./native-qualification-account-client.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(observed, {
      refusals: 18,
      nsis_tail: true,
      quote: '"a\\"b\\\\"',
      logon_attempted: false,
      credentials_supplied: false,
      scope: "compile and input-validation only",
    });
  },
);

void test(
  "owner-side native pipe reader bounds actual bytes and rejects invalid UTF-8 without logon",
  { skip: process.platform !== "win32" },
  () => {
    const helper = fileURLToPath(new URL("./native-qualification-account.cs.txt", import.meta.url));
    // Same-owner pipes only: no credential, logon, desktop or candidate process.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath $env:PORTCOVE_TEST_NATIVE_HELPER -Raw)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class InertNativePipeFixture {
  [DllImport("kernel32", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
  public static string Capture(byte[] bytes) {
    IntPtr read, write;
    if (!CreatePipe(out read, out write, IntPtr.Zero, 0)) throw new Exception("CreatePipe fixture failed");
    Type process = null;
    foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
      process = assembly.GetType("Portcove.NativeQualification.AccountProcess");
      if (process != null) break;
    }
    if (process == null) throw new Exception("fixed helper not loaded");
    var captureType = process.Assembly.GetType("Portcove.NativeQualification.NativePipeCapture");
    var capture = Activator.CreateInstance(captureType, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { read }, null);
    var task = (Task<string>)captureType.GetProperty("Completion").GetValue(capture);
    using (var writer = new FileStream(new SafeFileHandle(write, true), FileAccess.Write)) {
      try { writer.Write(bytes, 0, bytes.Length); } catch (IOException) { }
    }
    try { return task.GetAwaiter().GetResult(); } catch (Exception error) { return "REFUSED:" + error.GetType().Name + ":" + ((byte[])captureType.GetMethod("Snapshot").Invoke(capture, null)).Length; }
  }
  public static string InvalidWhileWriterOpen() {
    IntPtr read, write;
    if (!CreatePipe(out read, out write, IntPtr.Zero, 0)) throw new Exception("CreatePipe fixture failed");
    Type captureType = null;
    foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
      captureType = assembly.GetType("Portcove.NativeQualification.NativePipeCapture");
      if (captureType != null) break;
    }
    var capture = Activator.CreateInstance(captureType, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { read }, null);
    var task = (Task<string>)captureType.GetProperty("Completion").GetValue(capture);
    using (var writer = new FileStream(new SafeFileHandle(write, true), FileAccess.Write)) {
      writer.Write(new byte[] { 65, 255 }, 0, 2); writer.Flush();
      // EOF has not occurred. An invalid byte must fail without waiting for it.
      if (Task.WhenAny(task, Task.Delay(3000)).GetAwaiter().GetResult() != task) throw new Exception("capture waited for EOF");
      if (!task.IsFaulted) throw new Exception("invalid stream accepted");
      var bytes = (byte[])captureType.GetMethod("Snapshot").Invoke(capture, null);
      return BitConverter.ToString(bytes);
    }
  }
}
'@
$small = [InertNativePipeFixture]::Capture([Text.Encoding]::UTF8.GetBytes('actual bounded pipe'))
$invalid = [InertNativePipeFixture]::Capture([byte[]]@(255))
$overflow = [InertNativePipeFixture]::Capture([byte[]]::new(4 * 1024 * 1024 + 1))
$openInvalid = [InertNativePipeFixture]::InvalidWhileWriterOpen()
$frameRefusals = 0
foreach ($bytes in @([byte[]]@(123,125), [byte[]]@(255,10), [Text.Encoding]::UTF8.GetBytes("{}\n{}\n"), [byte[]]::new(32769))) {
  $stream = [IO.MemoryStream]::new($bytes)
  try {
    try { $null = [Portcove.NativeQualification.OwnerCommandReader]::ReadOne($stream).GetAwaiter().GetResult(); throw 'MISSING FRAME REFUSAL' }
    catch { if ($_.Exception.Message -eq 'MISSING FRAME REFUSAL') { throw }; $frameRefusals++ }
  } finally { $stream.Dispose() }
}
$validStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes("{}\n"))
try { $validFrame = [Portcove.NativeQualification.OwnerCommandReader]::ReadOne($validStream).GetAwaiter().GetResult() } finally { $validStream.Dispose() }
[ordered]@{ small = $small; invalid = $invalid; overflow = $overflow; open_invalid = $openInvalid; frame_refusals = $frameRefusals; valid_frame = $validFrame; scope = 'same-owner anonymous pipe only' } | ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, PORTCOVE_TEST_NATIVE_HELPER: helper },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      small: "actual bounded pipe",
      invalid: "REFUSED:DecoderFallbackException:1",
      overflow: "REFUSED:IOException:4194304",
      open_invalid: "41-FF",
      frame_refusals: 4,
      valid_frame: "{}",
      scope: "same-owner anonymous pipe only",
    });
  },
);

void test(
  "shared native job settles one inert root separately and both roots at attempt teardown",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath $env:PORTCOVE_TEST_NATIVE_HELPER -Raw)
$config = [Portcove.NativeQualification.AccountConfiguration]::new()
$config.BrokerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$config.AccountSid = 'S-1-5-21-100-200-300-9999'
$group = [Portcove.NativeQualification.AccountLauncher]::CreateGroup($config)
$native = $group.GetType().Assembly.GetType('Portcove.NativeQualification.Native')
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$inner = $native.GetMethod('CreateBoundedJob', $flags).Invoke($null, @())
$roots = @()
function Read-GroupUntil([scriptblock]$Predicate) {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $observed = @($group.RemainingPids())
    if (& $Predicate $observed) { return ,$observed }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $deadline)
  throw ('inert job readback did not settle: ' + ($observed -join ','))
}
try {
  foreach ($index in 1..2) {
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($argument in @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30')) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear(); $start.Environment['SystemRoot'] = $env:SystemRoot
    $group.GetType().GetMethod('BeginLaunch', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($group, @($config, $start.FileName)) | Out-Null
    $process = [Diagnostics.Process]::Start($start); $roots += $process
    $group.GetType().GetMethod('Assign', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($group, @($config, $process.Handle)) | Out-Null
    if ($index -eq 1) {
      if (-not $native.GetMethod('AssignProcessToJobObject', $flags).Invoke($null, @($inner, $process.Handle))) { throw 'nested job assignment refused' }
    }
  }
  $initial = Read-GroupUntil { param($observed) $roots[0].Id -in $observed -and $roots[1].Id -in $observed }
  if (-not $native.GetMethod('TerminateJobObject', $flags).Invoke($null, @($inner, [uint32]125))) { throw 'inner termination refused' }
  if (-not $roots[0].WaitForExit(5000)) { throw 'first inert root did not exit' }
  $remaining = Read-GroupUntil { param($observed) $roots[0].Id -notin $observed -and $roots[1].Id -in $observed }
  $final = @($group.StopAndObserve(5000))
  if ($final.Count -ne 0 -or -not $roots[1].WaitForExit(5000)) { throw 'shared job did not settle all roots' }
  $latched = $false
  try { $group.StopAndObserve(5000) | Out-Null } catch { $latched = $true }
  if (-not $latched) { throw 'group repeated a termination effect' }
  [ordered]@{ observed_roots = 2; retained_other_root = ($roots[1].Id -in $remaining); after_group = $final.Count; scope = 'same-owner inert nested jobs; no logon or GUI' } | ConvertTo-Json -Compress
} finally {
  $group.Dispose()
  $native.GetMethod('CloseHandle', $flags).Invoke($null, @($inner)) | Out-Null
  foreach ($process in $roots) { if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }; $process.Dispose() }
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_HELPER: fileURLToPath(
          new URL("./native-qualification-account.cs.txt", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      observed_roots: 2,
      retained_other_root: true,
      after_group: 0,
      scope: "same-owner inert nested jobs; no logon or GUI",
    });
  },
);

function runMemoryBridgeFixture(context: test.TestContext, mutate: boolean, diagnostic = false) {
  const outer = disposableDirectory(context, path.join(homedir(), ".pc-memory-bridge-"));
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_SETUP))
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_HELPER))
if ([Portcove.NativeQualification.AccountLauncher]::HostedCandidateExecutionAuthorized) { throw 'Candidate launcher must stay held' }
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root=Join-Path $env:PORTCOVE_TEST_NATIVE_ROOT 'controller'
[Portcove.HostedNative.Setup]::Directory($root,$owner,$null,$false)
$scripts=Join-Path $root 'scripts';$null=New-Item -ItemType Directory -Path $scripts
$bridge=Join-Path $scripts 'native-qualification-account-bridge.ps1'
$source=[IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_BRIDGE)
$mutation=$env:PORTCOVE_TEST_NATIVE_MUTATE -ceq 'true'
if($mutation){
 Add-Type 'namespace Portcove { public static class MemoryBridgeClock { public static long Now; } }'
 [Portcove.MemoryBridgeClock]::Now=[Diagnostics.Stopwatch]::GetTimestamp()
 $source=$source.Replace('[Diagnostics.Stopwatch]::GetTimestamp()','[Portcove.MemoryBridgeClock]::Now')
}
$diagnostic=$env:PORTCOVE_TEST_NATIVE_DIAGNOSTIC -ceq 'true'
$held=if($diagnostic){'$hostedDiagnosticCandidateExecutionAuthorized = $false'}else{'$hostedCandidateExecutionAuthorized = $false'}
if($source.Split($held).Count -ne 2){throw 'Expected one shipping memory hold'}
# Only this disposable bridge copy exercises the owner-memory loop. C# launch stays false.
[IO.File]::WriteAllText($bridge,$source.Replace($held,$held.Replace('$false','$true')))
$helper=Join-Path $scripts 'native-qualification-account.cs.txt';[IO.File]::Copy($env:PORTCOVE_TEST_NATIVE_HELPER,$helper)
$capture=Join-Path $root 'capture';[Portcove.HostedNative.Setup]::Directory($capture,$owner,$null,$false)
$nonce='b'*64;$sid='S-1-5-21-100-200-300-9999'
$configuration=[ordered]@{schema_version=1;broker_sid=$owner;account_sid=$sid;account_name='PortcoveNativeQual';profile_root=(Join-Path $root 'profile');work_root=(Join-Path $root 'work');capture_root=$capture;helper_sha256=(Get-FileHash $helper).Hash.ToLowerInvariant();controller_root=$root}
$configPath=Join-Path $root 'boundary.json';[IO.File]::WriteAllText($configPath,($configuration|ConvertTo-Json -Compress))
# An elevated CI token may default new file owners to Administrators; exercise the shipping user-owner boundary.
foreach($ownedFile in @($bridge,$helper,$configPath)){
 $acl=Get-Acl -LiteralPath $ownedFile
 $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($owner))
 Set-Acl -LiteralPath $ownedFile -AclObject $acl
}
$configSha=(Get-FileHash $configPath).Hash.ToLowerInvariant()
$config=[Portcove.NativeQualification.AccountConfiguration]::new();$config.UserName=$configuration.account_name;$config.AccountSid=$sid;$config.BrokerSid=$owner;$config.ProfileRoot=$configuration.profile_root;$config.WorkRoot=$configuration.work_root
$group=[Portcove.NativeQualification.AccountLauncher]::CreateGroup($config)
$secret=ConvertTo-SecureString 'inert-not-an-account-password' -AsPlainText -Force;$secret.MakeReadOnly()
$initialTicks=[long][Diagnostics.Stopwatch]::GetTimestamp();if($mutation){$initialTicks=[Portcove.MemoryBridgeClock]::Now}
$memory=@{configuration=$config;credential=$secret;deadline_ticks=($initialTicks+10L*[Diagnostics.Stopwatch]::Frequency);frequency=[long][Diagnostics.Stopwatch]::Frequency;group=$group;desktop_name=('PortcoveHosted_'+('a'*32));helper_sha256=$configuration.helper_sha256;owner_pid=$PID;owner_created_filetime=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()}
if($diagnostic){$memory.diagnostic=$true}
$worker=[PowerShell]::Create();$client=$null;$pending=$null
try {
 $null=$worker.AddCommand($bridge).AddParameter('Configuration',$configPath).AddParameter('ExpectedConfigurationSha256',$configSha).AddParameter('InvocationId',$nonce).AddParameter('HostedMemoryContext',$memory)
 $pending=$worker.BeginInvoke()
 if($mutation){
  $wait=[Diagnostics.Stopwatch]::StartNew();$statePath=Join-Path $capture 'bridge-state.json'
  while(-not [IO.File]::Exists($statePath)){
   if($pending.IsCompleted){$null=$worker.EndInvoke($pending);throw ('Fixture bridge exited before prepare: '+($worker.Streams.Error|Out-String))}
   if($wait.Elapsed.TotalSeconds -gt 5){throw 'Fixture bridge did not prepare within its finite fixture wait'}
   Start-Sleep -Milliseconds 25
  }
  $originalDeadline=$memory.deadline_ticks
  $memory.deadline_ticks=$originalDeadline+500L*[Diagnostics.Stopwatch]::Frequency
  $memory.desktop_name='changed-after-original-context'
  [Portcove.MemoryBridgeClock]::Now=$originalDeadline+1L
  if(-not $pending.AsyncWaitHandle.WaitOne(5000)){throw 'Mutated context renewed original bridge deadline'}
  $clockRefused=$false
  try{$null=$worker.EndInvoke($pending)}catch{if(-not $_.Exception.Message.Contains('Original hosted bridge deadline exhausted')){throw};$clockRefused=$true}
  if(($worker.Streams.Error|Out-String).Contains('Original hosted bridge deadline exhausted')){$clockRefused=$true}
  if(-not $clockRefused){throw 'Original clock refusal missing'}
  $state=[IO.File]::ReadAllText($statePath)|ConvertFrom-Json
  if($state.phase -cne 'failed' -or @($state.roots).Count -ne 0 -or -not $state.failure.Contains('Original hosted bridge deadline exhausted')){throw 'Clock failure did not preserve empty-job state'}
  Write-Output 'memory-context-mutation-keeps-original-clock'
  return
 }
 $client=[IO.Pipes.NamedPipeClientStream]::new('.','PortcoveNative_'+$nonce,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
 try{$client.Connect(5000)}catch{
  if($pending.IsCompleted){$null=$worker.EndInvoke($pending);throw ('Fixture bridge exited before connection: '+($worker.Streams.Error|Out-String))}
  throw
 }
 [Portcove.NativeQualification.OwnerCommandReader]::VerifyServer($client.SafePipeHandle.DangerousGetHandle(),[uint32]$PID,[long]$memory.owner_created_filetime)
 $command=[ordered]@{schema_version=1;invocation_id=$nonce;sequence=1;operation='finish';id='fixture-empty-finish';launch=$null;target=$null}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($command|ConvertTo-Json -Compress)+[char]10);$client.Write($bytes);$client.Flush()
 $response=[Portcove.NativeQualification.OwnerCommandReader]::ReadResponse($client)
 if(-not $response.Wait(5000)){throw 'Bounded fixture response did not settle'}
 $value=$response.GetAwaiter().GetResult()|ConvertFrom-Json
 if(-not $value.value.group_empty -or $value.value.roots -ne 0){throw 'Empty fixture job did not settle'}
 if(-not $pending.AsyncWaitHandle.WaitOne(5000)){throw 'Memory bridge runspace remains active'}
 $null=$worker.EndInvoke($pending)
 if($worker.HadErrors){throw ($worker.Streams.Error|Out-String)}
 if(@($group.RemainingPids()).Count -ne 0 -or $secret.Length -ne 29){throw 'Bridge took owner resources'}
 $state=[IO.File]::ReadAllText((Join-Path $capture 'bridge-state.json'))|ConvertFrom-Json
 if($state.phase -cne 'settled' -or @($state.roots).Count -ne 0){throw 'Empty bridge settlement missing'}
 Write-Output 'empty-memory-bridge-no-account-no-launch-no-credential-store'
} finally {
 if($client){$client.Dispose()}
 if($pending -and -not $pending.IsCompleted){$worker.Stop()}
 $worker.Dispose();$group.Dispose();$secret.Dispose()
}
`;
  const result = spawnSync(
    windowsSourceSystemExecutables.powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_ROOT: outer,
        PORTCOVE_TEST_NATIVE_MUTATE: mutate ? "true" : "",
        PORTCOVE_TEST_NATIVE_DIAGNOSTIC: diagnostic ? "true" : "",
        ...(diagnostic ? actualDiagnosticOwnerEnvironment(outer) : {}),
        PORTCOVE_TEST_NATIVE_HELPER: fileURLToPath(
          new URL("./native-qualification-account.cs.txt", import.meta.url),
        ),
        PORTCOVE_TEST_NATIVE_SETUP: fileURLToPath(
          new URL("./release-hosted-native-windows-setup.cs.txt", import.meta.url),
        ),
        PORTCOVE_TEST_NATIVE_BRIDGE: fileURLToPath(
          new URL("./native-qualification-account-bridge.ps1", import.meta.url),
        ),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    mutate
      ? /memory-context-mutation-keeps-original-clock/
      : /empty-memory-bridge-no-account-no-launch-no-credential-store/,
  );
}

void test(
  "owned-copy hosted memory bridge settles an empty job without credential lookup or taking owner resources",
  { skip: process.platform !== "win32" },
  (context) => runMemoryBridgeFixture(context, false),
);
void test(
  "owned-copy hosted memory bridge cannot renew its original clock through context mutation",
  { skip: process.platform !== "win32" },
  (context) => runMemoryBridgeFixture(context, true),
);

void test(
  "owned-copy diagnostic memory bridge settles its original empty group while production remains held",
  { skip: process.platform !== "win32" },
  (context) => runMemoryBridgeFixture(context, false, true),
);
void test(
  "owned-copy diagnostic memory bridge cannot renew its original owner deadline",
  { skip: process.platform !== "win32" },
  (context) => runMemoryBridgeFixture(context, true, true),
);

void test(
  "owned broker monitor retains early and acknowledged worker failures without waiting for bridge or account effects",
  { skip: process.platform !== "win32", timeout: 30000 },
  (context) => {
    const root = disposableDirectory(context, path.join(homedir(), ".pc-broker-monitor-"));
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PORTCOVE_TEST_NATIVE_HELPER))
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_OWNER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Owner source parser failed'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Close-OwnerWorker'},$false)
if(-not $function){throw 'Actual owner worker cleanup boundary missing'}
. ([scriptblock]::Create($function.Extent.Text))
$results=@()
foreach($case in @('before-ready','after-ack','early-membership-refusal','early-zero','deadline')) {
 $root=Join-Path $env:PORTCOVE_TEST_NATIVE_ROOT $case;$null=New-Item -ItemType Directory -Path $root
 if($case -ceq 'after-ack'){[IO.File]::WriteAllText((Join-Path $root 'worker-start.json'),'owned current-token fixture acknowledgment')}
 $code=if($case -ceq 'deadline'){"process.stderr.write('deadline');setTimeout(()=>{},10000)"}elseif($case -ceq 'early-zero'){'process.exit(0)'}else{"process.stderr.write('$case');process.exit(7)"}
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$env:PORTCOVE_TEST_NATIVE_NODE;$start.WorkingDirectory=$root
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.ArgumentList.Add('-e');$start.ArgumentList.Add($code)
 $child=[Diagnostics.Process]::Start($start);$closed=$false;$pidValue=$child.Id
 try {
  $created=$child.StartTime.ToFileTimeUtc().ToString()
  $output=[Portcove.NativeQualification.NativePipeCapture]::new($child.StandardOutput.BaseStream)
  $workerError=[Portcove.NativeQualification.NativePipeCapture]::new($child.StandardError.BaseStream)
  $deadline=[Diagnostics.Stopwatch]::GetTimestamp()+$(if($case -ceq 'deadline'){1L}else{10L})*[Diagnostics.Stopwatch]::Frequency
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $monitor=[Portcove.NativeQualification.OwnedBrokerChildMonitor]::new($child,$output,$workerError,$root,$deadline)
  if($case -ceq 'early-membership-refusal'){
    if(-not $child.WaitForExit(5000)){throw 'Fixed early failure did not exit'}
    $cleanup=[Collections.Generic.List[string]]::new()
    try{throw 'inert membership refusal'}catch{Close-OwnerWorker $child $monitor $deadline ([Diagnostics.Stopwatch]::Frequency) $cleanup;$closed=$true}
    if($cleanup.Count){throw ($cleanup -join ';')}
  }
  if(-not $monitor.Completion.Wait(8000) -or $monitor.Completion.GetAwaiter().GetResult()){throw 'Worker failure monitor did not refuse promptly'}
  $record=Get-Content -LiteralPath (Join-Path $root 'worker-failure.json') -Raw|ConvertFrom-Json
  if($record.pid -ne $pidValue -or $record.created_filetime -cne $created -or $record.authority -cne 'none'){throw 'Original monitored generation differs'}
  $stderr=[IO.File]::ReadAllText((Join-Path $root 'worker-failure.stderr.bin'))
  if($case -in @('before-ready','after-ack','early-membership-refusal') -and ($record.exit_code -ne 7 -or $record.reason -cne 'nonzero' -or $stderr -cne $case)){throw 'Exact failure stderr/exit was lost'}
  if($case -ceq 'early-zero' -and $record.reason -cne 'early-zero'){throw 'Zero exit without protocol result was accepted'}
  if($case -ceq 'deadline' -and $record.reason -cne 'deadline'){throw 'Original monotonic deadline was renewed'}
  $results+=@{case=$case;reason=$record.reason;elapsed_ms=$clock.ElapsedMilliseconds;scope='current-token process/streams only; no account, station, installer or credential effects'}
 }finally{if(-not $closed){if(-not $child.HasExited){$child.Kill($true)};if(-not $child.WaitForExit(5000)){throw 'Owned fixture child exit unobserved'};$child.Dispose()}}
}
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`;
    const result = spawnSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          PORTCOVE_TEST_NATIVE_HELPER: fileURLToPath(
            new URL("./native-qualification-account.cs.txt", import.meta.url),
          ),
          PORTCOVE_TEST_NATIVE_ROOT: root,
          PORTCOVE_TEST_NATIVE_OWNER: fileURLToPath(
            new URL("./release-hosted-native-windows-owner-mechanism.ps1", import.meta.url),
          ),
          PORTCOVE_TEST_NATIVE_NODE: process.execPath,
        },
        encoding: "utf8",
        timeout: 25000,
        maxBuffer: 16384,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as {
      case: string;
      reason: string;
      elapsed_ms: number;
    }[];
    assert.deepEqual(
      observed.map((item) => item.case),
      ["before-ready", "after-ack", "early-membership-refusal", "early-zero", "deadline"],
    );
    assert.ok(observed.every((item) => item.elapsed_ms < 8000));
  },
);

void test(
  "diagnostic controller resolves the PATH-first Node and refuses a wrong first version before effects",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = disposableDirectory(t, path.join(homedir(), ".pc-diagnostic-node-"));
    const first = path.join(root, "first node"),
      second = path.join(root, "second node");
    mkdirSync(first);
    mkdirSync(second);
    const good = path.join(first, "node.exe"),
      bad = path.join(second, "node.exe");
    copyFileSync(process.execPath, good);
    // Reuse the existing Windows Framework compiler fixture route; PS7 cannot emit ConsoleApplication.
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const badSource = path.join(root, "NodeVersionFixture.cs");
    writeFileSync(
      badSource,
      'public static class NodeVersionFixture { public static int Main(string[] args) { System.Console.WriteLine("v0.0.0"); return 0; } }',
    );
    const compile = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${bad}`, badSource], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(compile.status, 0, compile.stderr);
    assert.equal(existsSync(bad), true);
    const source = readFileSync(
      new URL("./release-hosted-native-windows-diagnostic-launch.ps1", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("$nodeCommand="),
      end = source.indexOf("$setupBytes=Read-LaunchBytes");
    assert.ok(
      start > 0 && end > start && end < source.indexOf("[Portcove.HostedNative.Setup]::Directory"),
    );
    const resolver = source.slice(start, end);
    const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PORTCOVE_TEST_NODE_RESOLVER))
$env:PATH=$env:PORTCOVE_TEST_FIRST_NODE+';'+$env:PORTCOVE_TEST_SECOND_NODE+';'+$env:PATH
$commands=@(Get-Command node -CommandType Application)
if($commands.Count -lt 2 -or $commands[0].Source -cne (Join-Path $env:PORTCOVE_TEST_FIRST_NODE 'node.exe') -or $commands[1].Source -cne (Join-Path $env:PORTCOVE_TEST_SECOND_NODE 'node.exe')){throw 'Actual multiple Node applications were not established'}
$observed=& ([scriptblock]::Create($code+';Write-Output $node'))
if($observed -cne $commands[0].Source){throw 'PATH-first Node was not selected'}
$env:PATH=$env:PORTCOVE_TEST_SECOND_NODE+';'+$env:PORTCOVE_TEST_FIRST_NODE+';'+$env:PATH
$refused=$false
try{& ([scriptblock]::Create($code))}catch{if(-not $_.Exception.Message.Contains('Fixed existing Node24.22.1 runtime required')){throw};$refused=$true}
if(-not $refused){throw 'Wrong first Node version fell back or was accepted'}
Write-Output 'actual-multiple-node-path-and-wrong-first-version-controls-pass'
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        PORTCOVE_TEST_FIRST_NODE: first,
        PORTCOVE_TEST_SECOND_NODE: second,
        PORTCOVE_TEST_NODE_RESOLVER: Buffer.from(resolver).toString("base64"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /actual-multiple-node-path-and-wrong-first-version-controls-pass/u);
    assert.equal(
      existsSync(path.join(root, "portcove-hosted-windows-connected-diagnostic")),
      false,
    );
  },
);

void test(
  "diagnostic original controller reaches ready before ACK and retains startup refusal without private effects",
  { skip: process.platform !== "win32", timeout: 300000 },
  async (t) => {
    await assert.doesNotReject(
      import(new URL("./release-hosted-native-windows-diagnostic.mts", import.meta.url).href),
      "Original C fixture requires the real locked repository import closure before launch",
    );
    const root = disposableDirectory(t, path.join(homedir(), ".pc-diagnostic-startup-"));
    const emptyHooks = path.join(root, "empty hooks"),
      emptyGitConfig = path.join(root, "empty-git-config");
    mkdirSync(emptyHooks);
    writeFileSync(emptyGitConfig, "");
    const launcherOriginal = readFileSync(
      new URL("./release-hosted-native-windows-diagnostic-launch.ps1", import.meta.url),
      "utf8",
    );
    const controllerOriginal = readFileSync(
      new URL("./release-hosted-native-windows-diagnostic.mts", import.meta.url),
      "utf8",
    );
    const once = (value: string, before: string, after: string) => {
      assert.equal(
        value.split(before).length,
        2,
        `Owned startup control must replace exactly one ${before.slice(0, 70)}`,
      );
      return value.replace(before, after);
    };
    for (const variant of [
      "ready",
      "wrong-source",
      "wrong-pid",
      "wrong-birth",
      "refused-input",
      "exit-259",
      "unavailable-retention",
    ] as const) {
      const source = path.join(root, variant, "source with spaces"),
        temporary = path.join(root, variant, "temporary");
      mkdirSync(path.join(source, "scripts"), { recursive: true });
      mkdirSync(temporary);
      let launcher = once(
        launcherOriginal,
        "$connectedDiagnosticLaunchAuthorized=$false",
        "$connectedDiagnosticLaunchAuthorized=$true",
      );
      // This owned copy can never publish ACK or cross into tools/account/station effects.
      launcher = once(
        launcher,
        "$clock.ElapsedMilliseconds -ge 330000",
        "$clock.ElapsedMilliseconds -ge 20000",
      );
      launcher = once(
        launcher,
        "$ack=[ordered]@{schema_version=1;",
        "throw 'Owned startup control stops before ACK';\n    $ack=[ordered]@{schema_version=1;",
      );
      let controller = once(
        controllerOriginal,
        "hostedWindowsConnectedDiagnosticExecutionAuthorized = false",
        "hostedWindowsConnectedDiagnosticExecutionAuthorized = true",
      );
      const relativeImport = /from "(\.\/[^"\n]+[.]mts)"/gu;
      assert.ok([...controller.matchAll(relativeImport)].length > 0);
      controller = controller.replace(
        relativeImport,
        (_match: string, specifier: string) =>
          `from ${JSON.stringify(new URL(specifier, import.meta.url).href)}`,
      );
      assert.equal([...controller.matchAll(relativeImport)].length, 0);
      controller = once(
        controller,
        "const inputs = await readOriginalHostedWindowsDiagnosticInputs();",
        variant === "refused-input" || variant === "unavailable-retention"
          ? 'const inputs: Inputs = await (async () => { requireOriginalHostedWindowsDiagnosticContext(); throw Object.assign(new Error("synthetic-private-startup-marker"), {code:"ERR_ASSERTION"}); })();'
          : 'requireOriginalHostedWindowsDiagnosticContext(); const inputs = {source:process.env.GITHUB_SHA,tree:execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8",timeout:5000}).trim(),run_id:process.env.GITHUB_RUN_ID,workflow:process.env.GITHUB_WORKFLOW_REF} as Inputs;',
      );
      if (variant === "unavailable-retention")
        controller = once(
          controller,
          'throw Object.assign(new Error("synthetic-private-startup-marker")',
          'delete process.env.RUNNER_TEMP; throw Object.assign(new Error("synthetic-private-startup-marker")',
        );
      const budget =
        'const budget = await readOrdinaryHostedWindowsDiagnosticDeadline({\n    source: inputs.source,\n    run_id: inputs.run_id,\n    attempt: "1",\n  });'.replaceAll(
          "\\n",
          "\n",
        );
      controller = once(controller, budget, "const budget = {deadline:performance.now()+10000};");
      controller = once(
        controller,
        "const built = await freshTools(inputs, budget.deadline),",
        'await retain(path.join(controlRoot(),"fixture-effects-reached.json"),{unexpected:true}); throw new Error("Owned fixture must never cross ACK"); const built = await freshTools(inputs, budget.deadline),',
      );
      const start = controller.indexOf("async function acknowledgeOriginalControllerStart("),
        end = controller.indexOf("async function originalController(", start);
      assert.ok(start > 0 && end > start);
      let readiness = controller.slice(start, end);
      if (variant === "wrong-source")
        readiness = once(
          readiness,
          "source: inputs.source,",
          'source: inputs.source === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40),',
        );
      if (variant === "wrong-pid")
        readiness = once(readiness, "pid: process.pid,", "pid: process.pid+1,");
      if (variant === "wrong-birth")
        readiness = once(readiness, "created_filetime: created,", 'created_filetime:"1",');
      controller = controller.slice(0, start) + readiness + controller.slice(end);
      if (variant === "exit-259")
        controller = once(controller, "function held() {", "process.exit(259);\nfunction held() {");
      writeFileSync(
        path.join(source, "scripts/release-hosted-native-windows-diagnostic-launch.ps1"),
        launcher,
      );
      writeFileSync(
        path.join(source, "scripts/release-hosted-native-windows-diagnostic.mts"),
        controller,
      );
      copyFileSync(
        new URL("./release-hosted-native-windows-setup.cs.txt", import.meta.url),
        path.join(source, "scripts/release-hosted-native-windows-setup.cs.txt"),
      );
      const git = (args: string[]) => {
        const result = spawnSync(
          "git",
          [
            "-c",
            `core.hooksPath=${emptyHooks}`,
            "-c",
            "commit.gpgsign=false",
            "-C",
            source,
            ...args,
          ],
          {
            encoding: "utf8",
            timeout: 15000,
            windowsHide: true,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGitConfig },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git(["init", "--quiet"]);
      git(["config", "core.autocrlf", "false"]);
      git(["add", "scripts"]);
      git([
        "-c",
        "user.name=Portcove Startup Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "inert owned startup fixture",
      ]);
      const sha = git(["rev-parse", "HEAD"]),
        tree = git(["rev-parse", "HEAD^{tree}"]);
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(source, "scripts/release-hosted-native-windows-diagnostic-launch.ps1"),
        ],
        {
          encoding: "utf8",
          timeout: 35000,
          windowsHide: true,
          maxBuffer: 65536,
          cwd: source,
          env: {
            ...process.env,
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
            GITHUB_REPOSITORY: "boburning/portcove",
            GITHUB_JOB: "installed-prerequisite",
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_RUN_ID: "123",
            GITHUB_SHA: sha,
            GITHUB_WORKFLOW_REF:
              "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-owned-startup-fixture",
            RUNNER_TEMP: temporary,
            RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID ?? "owned-startup-fixture",
            PORTCOVE_HOSTED_PLATFORM: "windows-x86_64",
            PORTCOVE_HOSTED_OBSERVATION_ONLY: "false",
            PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "true",
          },
        },
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 1, result.stderr);
      const control = path.join(temporary, "portcove-hosted-windows-connected-diagnostic"),
        reportBytes = readFileSync(path.join(control, "controller-startup-public.json"));
      assert.ok(reportBytes.length <= 65536);
      t.diagnostic(
        "bounded-public-startup-observation " + variant + " " + reportBytes.toString("utf8"),
      );
      const report: unknown = JSON.parse(reportBytes.toString("utf8"));
      assert.ok(isRecord(report));
      const observedReadyPath = path.join(control, "controller-ready.json");
      if (existsSync(observedReadyPath)) {
        const observedReady = readFileSync(observedReadyPath);
        assert.ok(observedReady.length <= 16384);
        const ready: unknown = JSON.parse(observedReady.toString("utf8"));
        assert.ok(isRecord(ready));
        assert.match(String(ready.source), /^[a-f0-9]{40}$/u);
        assert.match(String(ready.tree), /^[a-f0-9]{40}$/u);
        assert.match(String(ready.run_id), /^[1-9][0-9]{0,15}$/u);
        assert.equal(ready.attempt, 1);
        assert.equal(ready.schema_version, 1);
        assert.equal(typeof ready.pid, "number");
        assert.ok(
          typeof ready.pid === "number" &&
            Number.isSafeInteger(ready.pid) &&
            ready.pid > 0 &&
            ready.pid <= 2147483647,
        );
        assert.match(String(ready.created_filetime), /^[1-9][0-9]{0,18}$/u);
        assert.equal(ready.authority, "none");
        assert.equal(
          ready.workflow,
          "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-owned-startup-fixture",
        );
        const readySha = createHash("sha256").update(observedReady).digest("hex");
        assert.equal(readySha, report.ready_sha256);
        t.diagnostic(
          "bounded-public-original-ready " +
            JSON.stringify({
              variant,
              schema_version: ready.schema_version,
              source: ready.source,
              tree: ready.tree,
              run_id: ready.run_id,
              attempt: ready.attempt,
              workflow: ready.workflow,
              pid: ready.pid,
              created_filetime: ready.created_filetime,
              authority: ready.authority,
              ready_sha256: readySha,
            }),
        );
      }
      assert.ok(isRecord(report.controller));
      const originalController = report.controller;
      assert.ok(isRecord(originalController.original_observation));
      assert.ok(isRecord(originalController.settled_observation));
      const before = originalController.original_observation,
        settled = originalController.settled_observation;
      assert.equal(report.source, sha);
      assert.equal(report.tree, tree);
      assert.equal(report.run_id, "123");
      assert.equal(report.attempt, 1);
      assert.equal(report.ack_publication_attempted, false);
      assert.equal(report.ack_durably_written, false);
      assert.equal(report.cleanup, "original-process-exit-observed");
      assert.equal(settled.Alive, false);
      assert.equal(typeof originalController.pid, "number");
      assert.ok(
        typeof originalController.pid === "number" &&
          Number.isSafeInteger(originalController.pid) &&
          originalController.pid > 0,
      );
      assert.equal(typeof originalController.created_filetime, "string");
      assert.match(String(originalController.created_filetime), /^[1-9][0-9]{0,18}$/u);
      assert.equal(
        report.ready_verified,
        variant === "ready",
        "bounded-public-startup-observation " + variant + " " + reportBytes.toString("utf8"),
      );
      if (
        variant !== "refused-input" &&
        variant !== "unavailable-retention" &&
        variant !== "exit-259"
      ) {
        const readyBytes = readFileSync(path.join(control, "controller-ready.json"));
        const ready: unknown = JSON.parse(readyBytes.toString("utf8"));
        assert.ok(isRecord(ready));
        assert.equal(
          ready.source,
          variant === "wrong-source"
            ? sha === "a".repeat(40)
              ? "b".repeat(40)
              : "a".repeat(40)
            : sha,
        );
        assert.equal(
          ready.pid,
          variant === "wrong-pid" ? Number(originalController.pid) + 1 : originalController.pid,
        );
        assert.equal(
          ready.created_filetime,
          variant === "wrong-birth" ? "1" : originalController.created_filetime,
        );
        assert.equal(ready.tree, tree);
        assert.equal(ready.run_id, "123");
        assert.equal(ready.attempt, 1);
        assert.equal(
          ready.workflow,
          "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-owned-startup-fixture",
        );
        assert.equal(ready.authority, "none");
        assert.equal(report.ready_sha256, createHash("sha256").update(readyBytes).digest("hex"));
        assert.equal(before.Alive, true);
        assert.equal(before.ExitCode, null);
      }

      assert.equal(existsSync(path.join(control, "controller-start-ack.json")), false);
      assert.equal(existsSync(path.join(control, "fixture-effects-reached.json")), false);
      assert.equal(
        existsSync(path.join(source, "work/hosted-windows-connected-diagnostic/owner")),
        false,
      );
      assert.equal(reportBytes.includes(Buffer.from("synthetic-private-startup-marker")), false);
      if (variant === "refused-input") {
        assert.equal(before.Alive, false);
        assert.equal(before.ExitCode, 2);
        assert.ok(isRecord(report.controller_failure));
        assert.equal(report.controller_failure.status, "retained");
        assert.equal(report.controller_failure.phase, "inputs-verifying");
        assert.ok(isRecord(report.controller_failure.error));
        assert.equal(report.controller_failure.error.code, "ERR_ASSERTION");
      } else if (variant === "unavailable-retention") {
        assert.equal(before.Alive, false);
        assert.equal(before.ExitCode, 2);
        assert.ok(isRecord(report.controller_failure));
        assert.equal(report.controller_failure.status, "missing");
        assert.equal(existsSync(path.join(control, "controller-failure.json")), false);
      } else if (variant === "exit-259") {
        assert.equal(before.Alive, false);
        assert.equal(before.ExitCode, 259);
      } else if (variant === "ready") {
        assert.equal(before.Alive, true);
        assert.equal(before.ExitCode, null);
        assert.equal(report.phase, "ready-verified");
      }
    }
  },
);
