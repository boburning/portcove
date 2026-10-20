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
      refusals: 12,
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
    var task = (Task<string>)process.GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { read });
    using (var writer = new FileStream(new SafeFileHandle(write, true), FileAccess.Write)) {
      try { writer.Write(bytes, 0, bytes.Length); } catch (IOException) { }
    }
    try { return task.GetAwaiter().GetResult(); } catch (Exception error) { return "REFUSED:" + error.GetType().Name; }
  }
}
'@
$small = [InertNativePipeFixture]::Capture([Text.Encoding]::UTF8.GetBytes('actual bounded pipe'))
$invalid = [InertNativePipeFixture]::Capture([byte[]]@(255))
$overflow = [InertNativePipeFixture]::Capture([byte[]]::new(4 * 1024 * 1024 + 1))
[ordered]@{ small = $small; invalid = $invalid; overflow = $overflow; scope = 'same-owner anonymous pipe only' } | ConvertTo-Json -Compress
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
      invalid: "REFUSED:DecoderFallbackException",
      overflow: "REFUSED:IOException",
      scope: "same-owner anonymous pipe only",
    });
  },
);
