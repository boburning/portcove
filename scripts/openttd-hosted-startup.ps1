param([ValidateSet('new','replay')][string]$Dataset)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Get-Content -Raw input-cli.txt).Trim()
$root = Join-Path $env:RUNNER_TEMP ('openttd-native-owned-'+$Dataset)
New-Item -ItemType Directory -Path $root | Out-Null
$library = Join-Path $root 'library'
$native = Join-Path $PWD 'evidence/desktop-verify/openttd/native'
New-Item -ItemType Directory -Force -Path $native | Out-Null
$inputs = (Get-Content -Raw input-root.txt).Trim()
$expectedPlayer = Join-Path $inputs 'player/openttd.exe'
$profile = Join-Path $root 'profile'
$restoreRoot = Join-Path $root 'restored'
$saveRecord = Join-Path $PWD 'owned-save.json'
$saveInput = $null
$sourceSave = $null
$sourceSaveSha = $null
$defaultProfile = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OpenTTD'

$process = $null
$game = $null
$gameHandle = $null
$rootHandle = $null
$gameBound = $false
$window = [IntPtr]::Zero
$failure = $null
$stdoutSink = $null
$stderrSink = $null
$stdout = $null
$stderr = $null
$forcedCleanup = $false
function Invoke-CliJson([string]$name, [string[]]$arguments) {
  $name = "$Dataset-$name"
  $raw = & $cli --library $library @arguments --json 2> (Join-Path $native "$name.stderr.log")
  $code = $LASTEXITCODE
  $text = $raw -join "`n"
  $text | Set-Content (Join-Path $native "$name.json") -Encoding utf8
  if ($code -ne 0) { throw "CLI $name failed with exit $code" }
  $json = $text | ConvertFrom-Json
  if (-not $json.ok) { throw "CLI $name did not report success" }
  return $json
}
function Assert-PlainOwnedSave([string]$ownedRoot,[string]$savePath) {
  $expected = [IO.Path]::GetFullPath((Join-Path $ownedRoot 'profile/save/autosave/exit.sav'))
  if (-not [string]::Equals([IO.Path]::GetFullPath($savePath),$expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'Save path differs from the exact task-owned exit-save location' }
  foreach ($path in @($ownedRoot,(Join-Path $ownedRoot 'profile'),(Join-Path $ownedRoot 'profile/save'),(Join-Path $ownedRoot 'profile/save/autosave'),$expected)) {
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Owned save path contains a link' }
  }
}
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OpenttdWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(Microsoft.Win32.SafeHandles.SafeProcessHandle h,out long created,out long exited,out long kernel,out long user);
 public static long Created(Microsoft.Win32.SafeHandles.SafeProcessHandle h){long c,e,k,u;if(!GetProcessTimes(h,out c,out e,out k,out u))throw new Exception("Retained process creation identity unavailable");return c;}
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,IntPtr l,uint f,uint t,out UIntPtr r);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 public static IntPtr Find(uint pid) {IntPtr result=IntPtr.Zero; EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid && IsWindowVisible(h)){Rect r;if(GetWindowRect(h,out r)&&r.Right-r.Left>100&&r.Bottom-r.Top>80){result=h;return false;}}return true;},IntPtr.Zero);return result;}
 public static string Title(IntPtr h){var s=new StringBuilder(1024);GetWindowText(h,s,s.Capacity);return s.ToString();}
 public static void CloseOwned(IntPtr h,uint pid){uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Window owner changed before close");UIntPtr result; if(SendMessageTimeout(h,0x0010,UIntPtr.Zero,IntPtr.Zero,2,5000,out result)==IntPtr.Zero)throw new Exception("Owned normal window close was not acknowledged");}
}
'@
function Close-OwnedGameWindow {
  if (-not $gameBound -or $game.HasExited -or $window -eq [IntPtr]::Zero) { throw 'Bound live game window unavailable for close' }
  if ([OpenttdWindow]::Created($gameHandle) -ne $boundCreated) { throw 'Retained child creation identity differs before close' }
  [OpenttdWindow]::CloseOwned($window,[uint32]$game.Id)
}
try {
  if (-not [IO.Path]::IsPathFullyQualified($defaultProfile) -or (Test-Path -LiteralPath $defaultProfile)) { throw 'Existing or unavailable default OpenTTD profile: preserve it; no trial' }
  New-Item -ItemType Directory -Path $profile | Out-Null
  New-Item -ItemType Directory -Path $restoreRoot | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $profile 'baseset') | Out-Null
  Copy-Item -LiteralPath (Join-Path $inputs 'graphics/opengfx-8.0.tar') -Destination (Join-Path $profile 'baseset/opengfx-8.0.tar')
  $config = Join-Path $profile 'openttd.cfg'
  # Unversioned fresh configuration uses upstream's supported pre-split load and migration.
  # Private settings are deliberately supplied here; the app writes its own private.cfg on exit.
  @'
[game_creation]
map_x = 6
map_y = 6
starting_year = 1950
[gui]
autosave_on_exit = true
autosave_interval = 0
[network]
participate_survey = no
client_name = Player
'@ | Set-Content -LiteralPath $config -Encoding utf8
  $gameArgs = @('-c',$config,'-v','win32','-s','null','-m','null')
  if ($Dataset -eq 'new') { $gameArgs += @('-G','12345','-g') }
  else {
    $recordedSave = Get-Content -Raw -LiteralPath $saveRecord | ConvertFrom-Json
    $sourceSave = $recordedSave.path
    $sourceSaveSha = $recordedSave.sha256
    Assert-PlainOwnedSave (Join-Path $env:RUNNER_TEMP 'openttd-native-owned-new') $sourceSave
    $sourceItem = Get-Item -LiteralPath $sourceSave
    if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $sourceItem.Length -gt 16777216 -or $sourceItem.Length -lt 1024 -or (Get-FileHash -LiteralPath $sourceSave -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceSaveSha) { throw 'First scenario save identity differs' }
    $saveInput = Join-Path $restoreRoot 'map.sav'
    Copy-Item -LiteralPath $sourceSave -Destination $saveInput
    if ((Get-FileHash -LiteralPath $saveInput -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceSaveSha) { throw 'Copied save identity differs' }
    $gameArgs += @('-g',$saveInput)
  }
  @{dataset=$Dataset; config=$config; video='bundled win32 GDI'; map_bits=6; seed=$(if($Dataset -eq 'new'){12345}else{$null}); input_save_sha256=$sourceSaveSha; configured_survey='no'; config_version='deliberately unversioned; upstream migrates private settings'; audio='null drivers'; claim='seeded configuration and real native player, no default-setup, audio or retail claim'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-scenario.json")) -Encoding utf8
  if ((Get-FileHash -LiteralPath $expectedPlayer -Algorithm SHA256).Hash.ToLowerInvariant() -ne '360f615cb74cafcedf0486398a396577e8f1470e0f8158f66b7e29557fdb711d') { throw 'Selected publisher executable bytes differ before launch' }
  $selectArgs = @('transport-tycoon-deluxe-openttd-upstream',$expectedPlayer,'--working-directory',(Split-Path $expectedPlayer))
  foreach ($a in $gameArgs) { $selectArgs += "--arg=$a" }

  $preview = Invoke-CliJson 'select-preview' (@('external','select-preview')+$selectArgs)
  $selected = Invoke-CliJson 'select' (@('external','select')+$selectArgs+@('--expected-preview',$preview.data.preview_sha256,'--yes'))
  $status = Invoke-CliJson 'status' @('status','transport-tycoon-deluxe-openttd-upstream')
  if (-not $status.data.readiness.launchable -or $status.data.successful_launches -ne 0) { throw 'External selection not fresh and launchable' }
  $expectedPlayer = [IO.Path]::GetFullPath($expectedPlayer)
  if ((Get-Item -LiteralPath $expectedPlayer).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Expected player is linked' }

  $request = [Guid]::NewGuid().ToString()
  $start = [Diagnostics.ProcessStartInfo]::new($cli)
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($a in @('--library',$library,'exec','--request-id',$request,'transport-tycoon-deluxe-openttd-upstream')) { $start.ArgumentList.Add($a) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Owned CLI did not start' }
  $rootHandle = $process.SafeHandle
  $rootCreated = [OpenttdWindow]::Created($rootHandle)
  $stdoutSink = [IO.FileStream]::new((Join-Path $native ("$Dataset-player.stdout.log")),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,1,[IO.FileOptions]::WriteThrough)
  $stderrSink = [IO.FileStream]::new((Join-Path $native ("$Dataset-player.stderr.log")),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,1,[IO.FileOptions]::WriteThrough)
  $stdout = $process.StandardOutput.BaseStream.CopyToAsync($stdoutSink)
  $stderr = $process.StandardError.BaseStream.CopyToAsync($stderrSink)
  $deadline = [DateTime]::UtcNow.AddSeconds(65)
  $record = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
    $observed = Invoke-CliJson 'live-launch' @('launch','show',$request)
    $record = $observed.data
    if ($record -and $record.child_pid) {
      if (-not $game) {
        $game = [Diagnostics.Process]::GetProcessById([int]$record.child_pid)
        $gameHandle = $game.SafeHandle
      }
      if ($record.child_pid -ne $game.Id) { throw 'Retained child changed during observation' }
      $created = [OpenttdWindow]::Created($gameHandle)
      if ($record.supervisor_pid -ne $process.Id -or $record.supervisor_identity -ne "windows-filetime:$rootCreated" -or $record.child_identity -ne "windows-filetime:$created" -or $created -lt $rootCreated) { throw 'Owned root/child chronology or identity differs' }
      $actualPlayer = [IO.Path]::GetFullPath($game.MainModule.FileName)
      @{expected_player=$expectedPlayer; actual_player=$actualPlayer; actual_session=$game.SessionId; expected_session=$process.SessionId; child_pid=$game.Id; child_identity=$record.child_identity} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-child-binding.json")) -Encoding utf8
      if ($actualPlayer -ne $expectedPlayer) { throw 'Actual child image differs from private installed file' }
      if ($game.SessionId -ne $process.SessionId) { throw 'Actual child session differs' }
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($game.Id)"
      if (-not $parent -or $parent.ParentProcessId -ne $process.Id) { throw 'Actual child parent differs from retained root' }
      $boundCreated = $created
      $gameBound = $true
      $window = [OpenttdWindow]::Find([uint32]$game.Id)
      if ($window -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $gameBound -or $window -eq [IntPtr]::Zero) { throw 'No visible exact owned game window before finite deadline' }
  $startupCpu = $game.TotalProcessorTime.TotalSeconds
  Start-Sleep -Seconds 20
  if ($game.HasExited) { throw 'Owned player exited before capture' }
  @{settle_seconds=20; cpu_before=$startupCpu; cpu_after=$game.TotalProcessorTime.TotalSeconds; working_set=$game.WorkingSet64} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-startup-observation.json")) -Encoding utf8
  [uint32]$windowOwner = 0
  [void][OpenttdWindow]::GetWindowThreadProcessId($window,[ref]$windowOwner)
  if ($windowOwner -ne $game.Id) { throw 'Window ownership changed' }
  $rect = [OpenttdWindow+Rect]::new()
  if (-not [OpenttdWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Owned window geometry unavailable' }
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  if ($width -lt 100 -or $height -lt 80 -or $width -gt 2560 -or $height -gt 1600) { throw 'Owned window exceeds capture bounds' }
  $bitmap = [Drawing.Bitmap]::new($width,$height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size); $bitmap.Save((Join-Path $native ("$Dataset-player.png")),[Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  @{request=$request; root_pid=$process.Id; root_identity="windows-filetime:$rootCreated"; child_pid=$game.Id; child_identity=$record.child_identity; child_path=$actualPlayer; child_sha256=(Get-FileHash -LiteralPath $actualPlayer -Algorithm SHA256).Hash.ToLowerInvariant(); session=$game.SessionId; window=$window.ToInt64(); title=[OpenttdWindow]::Title($window); width=$width; height=$height} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-observed.json")) -Encoding utf8
  Close-OwnedGameWindow
  if (-not $process.WaitForExit(20000)) { throw 'Owned CLI did not complete after normal close' }
  if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Game stream capture did not complete after normal exit' }
  $final = Invoke-CliJson 'launch' @('launch','show',$request)
  if ($process.ExitCode -ne 0 -or $final.data.outcome -ne 'succeeded' -or $final.data.exit_code -ne 0) { throw 'Actual managed launch did not exit successfully' }
  if (-not $game.WaitForExit(5000)) { throw 'Owned child exit unproven before external removal' }
  $exitSave = Join-Path $profile 'save/autosave/exit.sav'
  Assert-PlainOwnedSave $root $exitSave
  $saveItem = Get-Item -LiteralPath $exitSave
  if (($saveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $saveItem.Length -gt 16777216 -or $saveItem.Length -lt 1024) { throw 'No bounded native exit save was produced' }
  $exitSha = (Get-FileHash -LiteralPath $exitSave -Algorithm SHA256).Hash.ToLowerInvariant()
  $privateConfig = Get-Content -Raw -LiteralPath (Join-Path $profile 'private.cfg')
  if ($privateConfig -notmatch '(?m)^participate_survey\s*=\s*no\s*$' -or $privateConfig -notmatch '(?m)^client_name\s*=\s*Player\s*$') { throw 'Native private settings did not retain neutral name and disabled survey' }
  if ($Dataset -eq 'new') { @{path=$exitSave;sha256=$exitSha;bytes=$saveItem.Length} | ConvertTo-Json | Set-Content -LiteralPath $saveRecord -Encoding utf8 }
  else {
    if ((Get-FileHash -LiteralPath $saveInput -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceSaveSha -or (Get-FileHash -LiteralPath $sourceSave -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceSaveSha) { throw 'Restored input or first save changed during replay' }
  }
  @{generated_save_sha256=$exitSha;generated_save_bytes=$saveItem.Length;input_save_sha256=$sourceSaveSha;input_preserved=$(if($Dataset -eq 'replay'){$true}else{$null});input_save_path=$saveInput;survey_disabled_in_written_private_config=$true;neutral_player_name=$true;scope='real native generated-map exit save; no earned economic progress or managed backup/restore claim'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-save-result.json")) -Encoding utf8
  function Snapshot-External {
    $map = [ordered]@{}
    foreach ($folder in @((Join-Path $inputs 'player'),$profile,$restoreRoot)) {
      if ((Get-Item -LiteralPath $folder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'External root became linked' }
      foreach ($f in Get-ChildItem -LiteralPath $folder -Recurse -Force | Sort-Object FullName) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'External entry became linked' }
        if ($f.PSIsContainer) { continue }
        $map[$f.FullName] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
    return ($map | ConvertTo-Json -Compress)
  }
  $beforeRemoval = Snapshot-External
  $beforeRemoval | Set-Content (Join-Path $native ("$Dataset-external-before-removal.json")) -Encoding utf8
  $removal = Invoke-CliJson 'remove-preview' @('external','removal-preview','transport-tycoon-deluxe-openttd-upstream')
  $removed = Invoke-CliJson 'remove' @('external','remove','transport-tycoon-deluxe-openttd-upstream','--expected-preview',$removal.data.preview_sha256,'--yes')
  $after = Invoke-CliJson 'removed-status' @('status','transport-tycoon-deluxe-openttd-upstream')
  $afterRemoval = Snapshot-External
  $afterRemoval | Set-Content (Join-Path $native ("$Dataset-external-after-removal.json")) -Encoding utf8
  if ($after.data.external_runtime -or $beforeRemoval -ne $afterRemoval) { throw 'Registration removal altered external files or retained registration' }
  @{phase='probe-complete-pending-image-inspection'; dataset=$Dataset; exit_code=0; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE; claim='ordinary external Windows player with explicit win32 renderer/config; normal exit generated a real map save; replay uses separate profile; removal preserves external bytes; screenshots require inspection; no audio, retail, physical input or managed maintenance qualification'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-result.json")) -Encoding utf8

} catch {
  $failure = $_
  @{phase='failed'; message=$_.Exception.Message; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-failure.json")) -Encoding utf8
} finally {
  if ($process -and -not $process.HasExited) {
    if ($gameBound -and -not $game.HasExited -and $window -ne [IntPtr]::Zero) { try { Close-OwnedGameWindow; [void]$process.WaitForExit(5000) } catch {} }
    if (-not $process.HasExited -and [OpenttdWindow]::Created($rootHandle) -eq $rootCreated) {
      # Kill only the exact retained root handle; this does not prove descendant exit.
      # Core's keeper can retain the job. Forced cleanup retains native admission and fails.
      # No recursive process kill, name matching or PID-only cleanup is used.
      $forcedCleanup = $true
      $process.Kill()
      [void]$process.WaitForExit(5000)
    }
  }
  if ($game -and -not $game.HasExited) { [void]$game.WaitForExit(5000) }
  $positive = (-not $forcedCleanup) -and ((-not $process) -or ($process.HasExited -and $gameBound -and $game.HasExited))
  @{positive_exit=$positive; root_exited=(-not $process -or $process.HasExited); observed_child_exited=(-not $game -or $game.HasExited); forced_cleanup=$forcedCleanup} | ConvertTo-Json | Set-Content evidence/cleanup.json -Encoding utf8
  if (-not $positive -and -not $failure) { $failure='Positive owned exit was not established' }
  foreach ($sink in @($stdoutSink,$stderrSink)) { if ($sink) { $sink.Flush() } }
  if ($stdoutSink -and $stdout.IsCompleted) { $stdoutSink.Dispose() }
  if ($stderrSink -and $stderr.IsCompleted) { $stderrSink.Dispose() }
  if ($game) { $game.Dispose() }
  if ($process) { $process.Dispose() }
}
if ($failure) { Write-Error $failure; exit 1 }
