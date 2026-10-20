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
[ordered]@{ refusals = $refusals; quote = [Portcove.NativeQualification.AccountLauncher]::Quote('a"b\\'); logon_attempted = $false; credentials_supplied = $false; scope = 'compile and input-validation only' } | ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, PORTCOVE_TEST_NATIVE_HELPER: helper },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(observed, {
      refusals: 9,
      quote: '"a\\"b\\\\"',
      logon_attempted: false,
      credentials_supplied: false,
      scope: "compile and input-validation only",
    });
  },
);
