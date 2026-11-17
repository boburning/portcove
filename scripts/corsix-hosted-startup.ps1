$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Get-Content -Raw input-cli.txt).Trim()
$root = Join-Path $env:RUNNER_TEMP 'corsix-native-owned'
New-Item -ItemType Directory -Path $root | Out-Null
$library = Join-Path $root 'library'
$native = Join-Path $PWD 'evidence/desktop-verify/corsix/native'
New-Item -ItemType Directory -Force -Path $native | Out-Null
$profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'CorsixTH'
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
  $raw = & $cli --library $library @arguments --json 2> (Join-Path $native "$name.stderr.log")
  $code = $LASTEXITCODE
  $text = $raw -join "`n"
  $text | Set-Content (Join-Path $native "$name.json") -Encoding utf8
  if ($code -ne 0) { throw "CLI $name failed with exit $code" }
  $json = $text | ConvertFrom-Json
  if (-not $json.ok) { throw "CLI $name did not report success" }
  return $json
}
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CorsixWindow {
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
  if ([CorsixWindow]::Created($gameHandle) -ne $boundCreated) { throw 'Retained child creation identity differs before close' }
  [CorsixWindow]::CloseOwned($window,[uint32]$game.Id)
}
try {
  if (Test-Path -LiteralPath $profile) { throw 'Pre-existing CorsixTH profile: preserve it; no native trial started' }
  $install = Invoke-CliJson 'install' @('install','corsixth-corsixth')
  if ($install.data.artifact.sha256 -ne '751f837e79ada345f60fba9c97b4d0b2ad7cedcc157b5dd3c257ab7047d24ea2') { throw 'Actual selected publisher package differs' }
  $verify = Invoke-CliJson 'verify' @('verify','corsixth-corsixth')
  if (-not $verify.data.valid) { throw 'Installed runtime did not verify' }
  # CLI report paths are escaped presentation strings. Bind the actual private files instead.
  $versions = @(Get-ChildItem -LiteralPath (Join-Path $library 'versions/corsixth-corsixth') -Directory)
  if ($versions.Count -ne 1 -or $versions[0].Name -ne $install.data.artifact.sha256 -or ($versions[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -or $install.data.selected_executable -ne 'CorsixTH.exe' -or $verify.data.install_id -ne $install.data.id) { throw 'Actual private installation identity differs' }
  $expectedPlayer = [IO.Path]::GetFullPath((Join-Path $versions[0].FullName 'CorsixTH.exe'))
  if ((Get-Item -LiteralPath $expectedPlayer).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Expected player is linked' }

  $request = [Guid]::NewGuid().ToString()
  $start = [Diagnostics.ProcessStartInfo]::new($cli)
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($a in @('--library',$library,'exec','--request-id',$request,'corsixth-corsixth')) { $start.ArgumentList.Add($a) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Owned CLI did not start' }
  $rootHandle = $process.SafeHandle
  $rootCreated = [CorsixWindow]::Created($rootHandle)
  $stdoutSink = [IO.FileStream]::new((Join-Path $native 'player.stdout.log'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,1,[IO.FileOptions]::WriteThrough)
  $stderrSink = [IO.FileStream]::new((Join-Path $native 'player.stderr.log'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,1,[IO.FileOptions]::WriteThrough)
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
      $created = [CorsixWindow]::Created($gameHandle)
      if ($record.supervisor_pid -ne $process.Id -or $record.supervisor_identity -ne "windows-filetime:$rootCreated" -or $record.child_identity -ne "windows-filetime:$created" -or $created -lt $rootCreated) { throw 'Owned root/child chronology or identity differs' }
      $actualPlayer = [IO.Path]::GetFullPath($game.MainModule.FileName)
      @{expected_player=$expectedPlayer; actual_player=$actualPlayer; reported_install_path=$install.data.path; actual_session=$game.SessionId; expected_session=$process.SessionId; child_pid=$game.Id; child_identity=$record.child_identity} | ConvertTo-Json | Set-Content (Join-Path $native 'child-binding.json') -Encoding utf8
      if ($actualPlayer -ne $expectedPlayer) { throw 'Actual child image differs from private installed file' }
      if ($game.SessionId -ne $process.SessionId) { throw 'Actual child session differs' }
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($game.Id)"
      if (-not $parent -or $parent.ParentProcessId -ne $process.Id) { throw 'Actual child parent differs from retained root' }
      $boundCreated = $created
      $gameBound = $true
      $window = [CorsixWindow]::Find([uint32]$game.Id)
      if ($window -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $gameBound -or $window -eq [IntPtr]::Zero) { throw 'No visible exact owned game window before finite deadline' }
  $startupCpu = $game.TotalProcessorTime.TotalSeconds
  Start-Sleep -Seconds 20
  if ($game.HasExited) { throw 'Owned player exited before capture' }
  @{settle_seconds=20; cpu_before=$startupCpu; cpu_after=$game.TotalProcessorTime.TotalSeconds; working_set=$game.WorkingSet64; profile_config_exists=(Test-Path -LiteralPath (Join-Path $profile 'config.txt'))} | ConvertTo-Json | Set-Content (Join-Path $native 'startup-observation.json') -Encoding utf8
  [uint32]$windowOwner = 0
  [void][CorsixWindow]::GetWindowThreadProcessId($window,[ref]$windowOwner)
  if ($windowOwner -ne $game.Id) { throw 'Window ownership changed' }
  $rect = [CorsixWindow+Rect]::new()
  if (-not [CorsixWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Owned window geometry unavailable' }
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  if ($width -lt 100 -or $height -lt 80 -or $width -gt 2560 -or $height -gt 1600) { throw 'Owned window exceeds capture bounds' }
  $bitmap = [Drawing.Bitmap]::new($width,$height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size); $bitmap.Save((Join-Path $native 'fresh-picker.png'),[Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  @{request=$request; root_pid=$process.Id; root_identity="windows-filetime:$rootCreated"; child_pid=$game.Id; child_identity=$record.child_identity; child_path=$actualPlayer; child_sha256=(Get-FileHash -LiteralPath $actualPlayer -Algorithm SHA256).Hash.ToLowerInvariant(); session=$game.SessionId; window=$window.ToInt64(); title=[CorsixWindow]::Title($window); width=$width; height=$height} | ConvertTo-Json | Set-Content (Join-Path $native 'observed.json') -Encoding utf8
  Close-OwnedGameWindow
  if (-not $process.WaitForExit(20000)) { throw 'Owned CLI did not complete after normal close' }
  if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Game stream capture did not complete after normal exit' }
  $final = Invoke-CliJson 'launch' @('launch','show',$request)
  if ($process.ExitCode -ne 0 -or $final.data.outcome -ne 'succeeded' -or $final.data.exit_code -ne 0) { throw 'Actual managed launch did not exit successfully' }
  $config = Join-Path $profile 'config.txt'
  $configText = Get-Content -LiteralPath $config -Raw
  $configText | Set-Content (Join-Path $native 'fresh-profile.log') -Encoding utf8
  if (-not $configText.Contains('player_name = [[PLAYER]]')) { throw 'Upstream fresh profile did not retain neutral PLAYER' }
  @{phase='probe-complete-pending-image-inspection'; fresh_profile=$true; player_name='PLAYER'; exit_code=0; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE; claim='ordinary managed Windows fresh-profile startup only; screenshot requires independent inspection'} | ConvertTo-Json | Set-Content (Join-Path $native 'result.json') -Encoding utf8
} catch {
  $failure = $_
  @{phase='failed'; message=$_.Exception.Message; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE} | ConvertTo-Json | Set-Content (Join-Path $native 'failure.json') -Encoding utf8
} finally {
  if ($process -and -not $process.HasExited) {
    if ($gameBound -and -not $game.HasExited -and $window -ne [IntPtr]::Zero) { try { Close-OwnedGameWindow; [void]$process.WaitForExit(5000) } catch {} }
    if (-not $process.HasExited -and [CorsixWindow]::Created($rootHandle) -eq $rootCreated) {
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
  if (Test-Path -LiteralPath (Join-Path $profile 'config.txt')) { Copy-Item -LiteralPath (Join-Path $profile 'config.txt') -Destination (Join-Path $native 'profile-at-cleanup.log') }
  foreach ($sink in @($stdoutSink,$stderrSink)) { if ($sink) { $sink.Flush() } }
  if ($stdoutSink -and $stdout.IsCompleted) { $stdoutSink.Dispose() }
  if ($stderrSink -and $stderr.IsCompleted) { $stderrSink.Dispose() }
  if ($game) { $game.Dispose() }
  if ($process) { $process.Dispose() }
}
if ($failure) { Write-Error $failure; exit 1 }
