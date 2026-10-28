import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";
import { homedir } from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { windowsSourceSystemExecutables } from "./release-native-runtime-custody.mts";

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

function runMemoryBridgeFixture(context: test.TestContext, mutate: boolean) {
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
$held='$hostedCandidateExecutionAuthorized = $false'
if($source.Split($held).Count -ne 2){throw 'Expected one shipping memory hold'}
# Only this disposable bridge copy exercises the owner-memory loop. C# launch stays false.
[IO.File]::WriteAllText($bridge,$source.Replace($held,'$hostedCandidateExecutionAuthorized = $true'))
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
