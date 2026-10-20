import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

void test(
  "profile keeper prepares its exact new working directory before requesting a launch",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference='Stop'
Import-Module $env:PORTCOVE_TEST_NATIVE_ADAPTER
$module=Get-Module native-qualification-account-adapter
& $module {
  $script:keeperStarts=0
  Set-Item Function:script:Start-PortcoveNativeAccountRoot -Value {
    param($Session,$Id,$Executable,$Arguments,$Directory)
    if($Id -cne 'profile-keeper' -or -not [IO.Directory]::Exists($Directory) -or
       $Directory -cne (Join-Path $Session.binding.work_root ('keeper-'+$Session.binding.invocation_id))){throw 'missing or wrong keeper CWD'}
    $script:keeperStarts++
    [pscustomobject]@{pid=456;path=$Executable;started_filetime='134000000000000000'}
  }
  Set-Item Function:script:Get-PortcoveNativeRegistryRoot -Value {param($Session);'inert-hive-projection'}
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('native-keeper-fixture-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
try {
  $binding=[pscustomobject]@{work_root=$root;invocation_id=('a'*64)}
  $session=[pscustomobject]@{binding=$binding;keeper=$null}
  Start-PortcoveNativeProfileKeeper $session|Out-Null
  if(-not [IO.Directory]::Exists($session.keeper_directory)){throw 'keeper directory not retained'}
  $repeat=$false;try{Start-PortcoveNativeProfileKeeper $session|Out-Null}catch{$repeat=$true}
  $collision=$false;try{Start-PortcoveNativeProfileKeeper ([pscustomobject]@{binding=$binding;keeper=$null})|Out-Null}catch{$collision=$true}
  $starts=& $module {$script:keeperStarts}
  if(-not $repeat -or -not $collision -or $starts -ne 1){throw 'keeper retained directory or launch was repeated'}
  [ordered]@{working_directory_exists_before_launch=$true;launch_requests=$starts;retained_directory_refused=$collision;scope='inert filesystem and injected launch only'}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_ADAPTER: fileURLToPath(
          new URL("./native-qualification-account-adapter.psm1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      working_directory_exists_before_launch: true,
      launch_requests: 1,
      retained_directory_refused: true,
      scope: "inert filesystem and injected launch only",
    });
  },
);

void test(
  "bridge capture appends only new bytes and preserves unexpected partial state",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_NATIVE_BRIDGE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'bridge parse failed'}
$definition=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Capture'},$true)
Invoke-Expression $definition[0].Extent.Text
$root=Join-Path ([IO.Path]::GetTempPath()) ('native-capture-fixture-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
try {
  $configurationValue=[pscustomobject]@{capture_root=$root}
  $captureLengths=[Collections.Generic.Dictionary[string,long]]::new([StringComparer]::OrdinalIgnoreCase)
  $capture=[pscustomobject]@{bytes=[byte[]]@(65,66)}
  $capture|Add-Member ScriptMethod Snapshot {return ,$this.bytes}
  $process=[pscustomobject]@{OutputCapture=$capture;ErrorCapture=$capture}
  Write-Capture 'fixture' $process
  $capture.bytes=[byte[]]@(65,66,67);Write-Capture 'fixture' $process;Write-Capture 'fixture' $process
  $file=Join-Path $root 'fixture.stdout.bin'
  if(([IO.File]::ReadAllBytes($file)-join ',') -cne '65,66,67'){throw 'capture did not append exact suffix'}
  [IO.File]::WriteAllBytes($file,[byte[]]@(88))
  $refused=$false;try{Write-Capture 'fixture' $process}catch{$refused=$true}
  if(-not $refused -or ([IO.File]::ReadAllBytes($file)-join ',') -cne '88'){throw 'unexpected partial state was overwritten'}
  [ordered]@{scope='inert stream snapshots only';exact_append=$true;changed_length_refused=$refused;partial_preserved=$true}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_BRIDGE: fileURLToPath(
          new URL("./native-qualification-account-bridge.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      scope: "inert stream snapshots only",
      exact_append: true,
      changed_length_refused: true,
      partial_preserved: true,
    });
  },
);

void test(
  "native process adapter refuses changed identity and uses one stop plus readback",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference='Stop'
Import-Module $env:PORTCOVE_TEST_NATIVE_ADAPTER
$module=Get-Module native-qualification-account-adapter
& $module {
  $script:fixtureMode='running'; $script:fixtureStops=0; $script:fixtureReads=0
  Set-Item Function:script:Invoke-PortcoveNativeAccountCommand -Value {
    param($Session,$Operation,$Id,$Launch=$null,$Target=$null)
    if ($Operation -eq 'observe') {
      $created=if ($script:fixtureMode -eq 'changed') {'134000000000000001'} else {'134000000000000000'}
      return [pscustomobject]@{exited=$false;exit_code=$null;responding=$true;window_title='inert';window_handle='123';processes=@([pscustomobject]@{pid=456;path='C:\\inert\\app.exe';started_filetime=$created})}
    }
    if ($Operation -eq 'stop') {$script:fixtureStops++}
    elseif ($Operation -eq 'readback') {$script:fixtureReads++}
    else {throw 'unexpected fixture command'}
    [pscustomobject]@{root_pid=456;root_created_filetime='134000000000000000';root_exited=$true;job_empty=$true;remaining_pids=@();exit_code=125}
  }
}
$session=[pscustomobject]@{binding=[pscustomobject]@{profile_root='C:\\Users\\InertNative';work_root='C:\\ProgramData\\InertNative\\work'}}
$environment=Get-PortcoveNativeAccountEnvironment $session @{PORTCOVE_LIBRARY='C:\\ProgramData\\InertNative\\work\\library'}
if ($environment.Count -ne 11 -or $environment.Contains('GH_TOKEN')) {throw 'environment not scrubbed'}
$refused=$false
try {Get-PortcoveNativeAccountEnvironment $session @{GH_TOKEN='inert-forbidden'} | Out-Null} catch {$refused=$true}
if (-not $refused) {throw 'credential field accepted'}
$proxy=New-PortcoveNativeProcessProxy $session 'candidate' ([pscustomobject]@{pid=456;path='C:\\inert\\app.exe';started_filetime='134000000000000000'})
$proxy.Refresh()
if ($proxy.HasExited -or -not $proxy.Responding -or $proxy.MainWindowTitle -cne 'inert') {throw 'fixture projection wrong'}
& $module {$script:fixtureMode='changed'}
$changedRefused=$false
try {$proxy.Refresh()} catch {$changedRefused=$true}
if (-not $changedRefused -or $proxy.HasExited) {throw 'changed identity replaced retained observation'}
$proxy.Kill($true); $proxy.Kill($true); $proxy.Dispose()
$counts=& $module {[pscustomobject]@{stops=$script:fixtureStops;reads=$script:fixtureReads}}
if (-not $proxy.HasExited -or $proxy.ExitCode -ne 125 -or $counts.stops -ne 1 -or $counts.reads -ne 1) {throw 'stop repeated or teardown not retained'}
[ordered]@{changed_identity_refused=$changedRefused;credential_field_refused=$refused;stop_effects=$counts.stops;readbacks=$counts.reads;scope='injected adapter observations only'} | ConvertTo-Json -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_NATIVE_ADAPTER: fileURLToPath(
          new URL("./native-qualification-account-adapter.psm1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      changed_identity_refused: true,
      credential_field_refused: true,
      stop_effects: 1,
      readbacks: 1,
      scope: "injected adapter observations only",
    });
  },
);

void test(
  "isolated NSIS completion observes broker job and requires exact-root empty readback",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'installer harness parse failed'}
$definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-JournaledUninstallerChild'},$true)
Invoke-Expression $definition[0].Extent.Text
$root=Join-Path ([IO.Path]::GetTempPath()) ('native-nsis-fixture-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  $file=Join-Path $root 'self-copy.exe'; [IO.File]::WriteAllText($file,'inert self-copy; never executed')
  $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  $nativeAccount=[pscustomobject]@{fixture=$true}; $evidence=$null; $script:poll=0; $script:bad=$false
  function Get-CimInstance {throw 'owner-account process discovery is forbidden in selected route'}
  function Assert-NoReparseAncestry {param($Path);if((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'fixture reparse'}}
  function Invoke-PortcoveNativeAccountCommand {
    param($Session,$Operation,$Id)
    if($Operation -eq 'observe') {
      $script:poll++
      return [pscustomobject]@{processes=$(if($script:poll -eq 1){@([pscustomobject]@{pid=456;path=$file;started_filetime='134000000000000001'})}else{@()})}
    }
    if($Operation -ne 'readback'){throw 'unexpected effect'}
    [pscustomobject]@{root_pid=123;root_created_filetime=$(if($script:bad){'134000000000000999'}else{'134000000000000000'});root_exited=$true;job_empty=$true;remaining_pids=@()}
  }
  $run=[ordered]@{pid=123;start_time_filetime='134000000000000000';native_root_id='uninstaller';executable_sha256=$hash}
  Wait-JournaledUninstallerChild $run $root ([DateTime]::UtcNow.AddSeconds(2))
  if(-not $run.native_teardown.job_empty -or $script:poll -ne 2){throw 'self-copy completion not established'}
  $script:bad=$true; $refused=$false
  try {Wait-JournaledUninstallerChild $run $root ([DateTime]::UtcNow.AddSeconds(2))}catch{$refused=$true}
  if(-not $refused){throw 'changed root identity accepted'}
  [ordered]@{scope='injected broker job observations only';changed_root_refused=$refused;owner_process_queries=0}|ConvertTo-Json -Compress
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PORTCOVE_TEST_INSTALLER: fileURLToPath(
          new URL("./test-windows-installer.ps1", import.meta.url),
        ),
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      scope: "injected broker job observations only",
      changed_root_refused: true,
      owner_process_queries: 0,
    });
  },
);
