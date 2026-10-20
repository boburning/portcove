import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
[ordered]@{ small = $small; invalid = $invalid; overflow = $overflow; open_invalid = $openInvalid; scope = 'same-owner anonymous pipe only' } | ConvertTo-Json -Compress
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
