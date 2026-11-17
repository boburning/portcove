$Dataset = 'restore'
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Get-Content -Raw input-cli.txt).Trim()
$root = Join-Path $env:RUNNER_TEMP ('cdogs-native-owned-'+$Dataset)
New-Item -ItemType Directory -Path $root | Out-Null
$library = Join-Path $root 'library'
$native = Join-Path $PWD 'evidence/desktop-verify/cdogs/native'
New-Item -ItemType Directory -Force -Path $native | Out-Null
$inputs = (Get-Content -Raw input-root.txt).Trim()
$expectedPlayer = Join-Path $inputs 'player/bin/cdogs-sdl.exe'
$profile = Join-Path $root 'profile'
$defaultProfile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'C-Dogs SDL'

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
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CdogsWindow {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,Input[] i,int size);
 [StructLayout(LayoutKind.Sequential)] struct Key {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit,Size=32)] struct Union {[FieldOffset(0)]public Key key;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Union data;}
 public static bool InputReleased = true;
 public static void KeyOwned(IntPtr h,uint pid,ushort vk){
  uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Key target owner differs");
  if(!SetForegroundWindow(h) && GetForegroundWindow()!=h)throw new Exception("Owned window could not become foreground");
  if(GetForegroundWindow()!=h)throw new Exception("Owned key target is not foreground");
  Rect r;if(!GetWindowRect(h,out r)||!SetCursorPos(r.Right-8,r.Bottom-8))throw new Exception("Owned cursor placement failed");
  if(Marshal.SizeOf(typeof(Input))!=40)throw new Exception("Unsupported native input ABI");
  uint extended = (vk>=0x25 && vk<=0x28) ? 1u : 0u;
  var down=new Input{type=1,data=new Union{key=new Key{vk=vk,flags=extended}}};
  var up=new Input{type=1,data=new Union{key=new Key{vk=vk,flags=extended|2u}}};
  InputReleased=false;
  if(SendInput(1,new[]{down},40)!=1)throw new Exception("Owned keydown failed");
  try{System.Threading.Thread.Sleep(120);}finally{if(SendInput(1,new[]{up},40)!=1)throw new Exception("Key release failed");InputReleased=true;}
  if(GetForegroundWindow()!=h)throw new Exception("Foreground changed during owned key");
 }
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
  if ([CdogsWindow]::Created($gameHandle) -ne $boundCreated) { throw 'Retained child creation identity differs before close' }
  [CdogsWindow]::CloseOwned($window,[uint32]$game.Id)
}
try {
  if (-not [IO.Path]::IsPathFullyQualified($defaultProfile) -or (Test-Path -LiteralPath $defaultProfile)) { throw 'Existing or unavailable default C-Dogs profile: preserve it; no trial' }
  New-Item -ItemType Directory -Path $profile | Out-Null
  $seed = Join-Path $PWD 'scripts/cdogs-earned-linux-autosave.json'
  $seedSha = '01d49050445e0dc85ea3031267926871de87ddc857d4f248d9d5d61fbdca9cc6'
  if (((Get-Item -LiteralPath $seed).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $seed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $seedSha) { throw 'Earned Linux save fixture identity differs' }
  $dataProfile = Join-Path $profile 'cdogs-sdl'
  New-Item -ItemType Directory -Path $dataProfile | Out-Null
  $activeSave = Join-Path $dataProfile 'autosave.json'
  Copy-Item -LiteralPath $seed -Destination $activeSave
  if ((Get-FileHash -LiteralPath $activeSave -Algorithm SHA256).Hash.ToLowerInvariant() -ne $seedSha) { throw 'Copied Linux save differs' }
  $env:XDG_CONFIG_HOME = $profile
  $env:SDL_RENDER_DRIVER = 'software'
  $env:SDL_AUDIODRIVER = 'dummy'
  @{dataset=$Dataset; profile_parent=$profile; renderer='upstream SDL software'; audio='dummy'; input_save_sha256=$seedSha; claim='Linux-earned save seeded unchanged; observe Windows Continue menu recognition only, not resumed mission or earned Windows progress'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-scenario.json")) -Encoding utf8
  if ((Get-FileHash -LiteralPath $expectedPlayer -Algorithm SHA256).Hash.ToLowerInvariant() -ne '3d766f2f36c533bbd08f2e198eda70c4f973b49287525d210cc4756f6dad56c6') { throw 'Selected publisher executable bytes differ before launch' }
  $selectArgs = @('c-dogs-sdl',$expectedPlayer,'--working-directory',(Split-Path $expectedPlayer))

  $preview = Invoke-CliJson 'select-preview' (@('external','select-preview')+$selectArgs)
  $selected = Invoke-CliJson 'select' (@('external','select')+$selectArgs+@('--expected-preview',$preview.data.preview_sha256,'--yes'))
  $status = Invoke-CliJson 'status' @('status','c-dogs-sdl')
  if (-not $status.data.readiness.launchable -or $status.data.successful_launches -ne 0) { throw 'External selection not fresh and launchable' }
  $expectedPlayer = [IO.Path]::GetFullPath($expectedPlayer)
  if ((Get-Item -LiteralPath $expectedPlayer).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Expected player is linked' }

  $request = [Guid]::NewGuid().ToString()
  $start = [Diagnostics.ProcessStartInfo]::new($cli)
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($a in @('--library',$library,'exec','--request-id',$request,'c-dogs-sdl')) { $start.ArgumentList.Add($a) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Owned CLI did not start' }
  $rootHandle = $process.SafeHandle
  $rootCreated = [CdogsWindow]::Created($rootHandle)
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
      $created = [CdogsWindow]::Created($gameHandle)
      if ($record.supervisor_pid -ne $process.Id -or $record.supervisor_identity -ne "windows-filetime:$rootCreated" -or $record.child_identity -ne "windows-filetime:$created" -or $created -lt $rootCreated) { throw 'Owned root/child chronology or identity differs' }
      $actualPlayer = [IO.Path]::GetFullPath($game.MainModule.FileName)
      @{expected_player=$expectedPlayer; actual_player=$actualPlayer; actual_session=$game.SessionId; expected_session=$process.SessionId; child_pid=$game.Id; child_identity=$record.child_identity} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-child-binding.json")) -Encoding utf8
      if ($actualPlayer -ne $expectedPlayer) { throw 'Actual child image differs from private installed file' }
      if ($game.SessionId -ne $process.SessionId) { throw 'Actual child session differs' }
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($game.Id)"
      if (-not $parent -or $parent.ParentProcessId -ne $process.Id) { throw 'Actual child parent differs from retained root' }
      $boundCreated = $created
      $gameBound = $true
      $window = [CdogsWindow]::Find([uint32]$game.Id)
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
  [void][CdogsWindow]::GetWindowThreadProcessId($window,[ref]$windowOwner)
  if ($windowOwner -ne $game.Id) { throw 'Window ownership changed' }
  foreach ($key in @(@{name='start-highlight';vk=38},@{name='continue-menu';vk=13})) {
    if ($game.HasExited -or [CdogsWindow]::Created($gameHandle) -ne $boundCreated) { throw 'Owned child identity lost before input' }
    [CdogsWindow]::KeyOwned($window,[uint32]$game.Id,[ushort]$key.vk)
    Start-Sleep -Milliseconds 900
    [uint32]$currentOwner=0
    [void][CdogsWindow]::GetWindowThreadProcessId($window,[ref]$currentOwner)
    if ($currentOwner -ne $game.Id -or $game.HasExited) { throw 'Owned capture target changed after input' }
    $stepRect = [CdogsWindow+Rect]::new()
    if (-not [CdogsWindow]::GetWindowRect($window,[ref]$stepRect)) { throw 'Step window geometry unavailable' }
    $sw=$stepRect.Right-$stepRect.Left; $sh=$stepRect.Bottom-$stepRect.Top
    if ($sw -lt 100 -or $sh -lt 80 -or $sw -gt 2560 -or $sh -gt 1600) { throw 'Step capture outside bounds' }
    $stepBitmap=[Drawing.Bitmap]::new($sw,$sh);$stepGraphics=[Drawing.Graphics]::FromImage($stepBitmap)
    try {$stepGraphics.CopyFromScreen($stepRect.Left,$stepRect.Top,0,0,$stepBitmap.Size);$stepBitmap.Save((Join-Path $native ("$Dataset-"+$key.name+'.png')),[Drawing.Imaging.ImageFormat]::Png)}
    finally {$stepGraphics.Dispose();$stepBitmap.Dispose()}
  }
  $rect = [CdogsWindow+Rect]::new()
  if (-not [CdogsWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Owned window geometry unavailable' }
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  if ($width -lt 100 -or $height -lt 80 -or $width -gt 2560 -or $height -gt 1600) { throw 'Owned window exceeds capture bounds' }
  $bitmap = [Drawing.Bitmap]::new($width,$height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size); $bitmap.Save((Join-Path $native ("$Dataset-player.png")),[Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  @{request=$request; root_pid=$process.Id; root_identity="windows-filetime:$rootCreated"; child_pid=$game.Id; child_identity=$record.child_identity; child_path=$actualPlayer; child_sha256=(Get-FileHash -LiteralPath $actualPlayer -Algorithm SHA256).Hash.ToLowerInvariant(); session=$game.SessionId; window=$window.ToInt64(); title=[CdogsWindow]::Title($window); width=$width; height=$height} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-observed.json")) -Encoding utf8
  Close-OwnedGameWindow
  if (-not $process.WaitForExit(20000)) { throw 'Owned CLI did not complete after normal close' }
  if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Game stream capture did not complete after normal exit' }
  $final = Invoke-CliJson 'launch' @('launch','show',$request)
  if ($process.ExitCode -ne 0 -or $final.data.outcome -ne 'succeeded' -or $final.data.exit_code -ne 0) { throw 'Actual external launch did not exit successfully' }
  if (-not $game.WaitForExit(5000)) { throw 'Owned child exit unproven before external removal' }
  if (Test-Path -LiteralPath $defaultProfile) { throw 'Unexpected writer outside the selected private profile; retain evidence' }
  if ((Get-FileHash -LiteralPath $seed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $seedSha) { throw 'Original earned-save fixture changed' }
  $state = Get-Content -Raw -LiteralPath $activeSave | ConvertFrom-Json
  if ($state.Version -ne 3 -or $state.Missions.Count -ne 1 -or $state.Missions[0].NextMission -ne 1 -or ($state.Missions[0].MissionsCompleted -join ',') -ne '0' -or $state.Missions[0].Campaign.Path -ne 'missions/most_classified_enemy.cdogscpn') { throw 'Restored progress was lost or changed' }
  @{source_sha256=$seedSha;output_sha256=(Get-FileHash -LiteralPath $activeSave -Algorithm SHA256).Hash.ToLowerInvariant();source_preserved=$true;next_mission=1;missions_completed=@(0);scope='upstream Windows profile retained Linux-earned progress; visual menu recognition still requires image inspection; no resumed-level claim'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-save-result.json")) -Encoding utf8
  $profileFiles = @(Get-ChildItem -LiteralPath $profile -Recurse -Force -File)
  if (-not $profileFiles.Count) { throw 'Native player produced no private profile evidence' }
  @{file_count=$profileFiles.Count; scope='Windows profile retained Linux-earned campaign progress; no Windows completion or resumed-level claim'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-profile-result.json")) -Encoding utf8
  function Snapshot-External {
    $map = [ordered]@{}
    foreach ($folder in @((Join-Path $inputs 'player'),$profile)) {
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
  $removal = Invoke-CliJson 'remove-preview' @('external','removal-preview','c-dogs-sdl')
  $removed = Invoke-CliJson 'remove' @('external','remove','c-dogs-sdl','--expected-preview',$removal.data.preview_sha256,'--yes')
  $after = Invoke-CliJson 'removed-status' @('status','c-dogs-sdl')
  $afterRemoval = Snapshot-External
  $afterRemoval | Set-Content (Join-Path $native ("$Dataset-external-after-removal.json")) -Encoding utf8
  if ($after.data.external_runtime -or $beforeRemoval -ne $afterRemoval) { throw 'Registration removal altered external files or retained registration' }
  @{phase='probe-complete-pending-image-inspection'; dataset=$Dataset; exit_code=0; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE; claim='ordinary external Windows C-Dogs player with SDL software renderer and private XDG profile; normal exit and registration-only removal preserve external bytes; screenshot requires inspection; save-menu recognition requires image inspection; no resumed level, Windows-earned progress, audio, retail, physical input or managed maintenance qualification'} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-result.json")) -Encoding utf8

} catch {
  $failure = $_
  @{phase='failed'; message=$_.Exception.Message; product=$env:PORTCOVE_PRODUCT_SOURCE; controller=$env:PORTCOVE_CONTROLLER_SOURCE} | ConvertTo-Json | Set-Content (Join-Path $native ("$Dataset-failure.json")) -Encoding utf8
} finally {
  if ($process -and -not $process.HasExited) {
    if ($gameBound -and -not $game.HasExited -and $window -ne [IntPtr]::Zero) { try { Close-OwnedGameWindow; [void]$process.WaitForExit(5000) } catch {} }
    if (-not $process.HasExited -and [CdogsWindow]::Created($rootHandle) -eq $rootCreated) {
      # Kill only the exact retained root handle; this does not prove descendant exit.
      # Core's keeper can retain the job. Forced cleanup retains native admission and fails.
      # No recursive process kill, name matching or PID-only cleanup is used.
      $forcedCleanup = $true
      $process.Kill()
      [void]$process.WaitForExit(5000)
    }
  }
  if ($game -and -not $game.HasExited) { [void]$game.WaitForExit(5000) }
  $positive = [CdogsWindow]::InputReleased -and (-not $forcedCleanup) -and ((-not $process) -or ($process.HasExited -and $gameBound -and $game.HasExited))
  @{input_released=[CdogsWindow]::InputReleased; positive_exit=$positive; root_exited=(-not $process -or $process.HasExited); observed_child_exited=(-not $game -or $game.HasExited); forced_cleanup=$forcedCleanup} | ConvertTo-Json | Set-Content evidence/cleanup.json -Encoding utf8
  if (-not $positive -and -not $failure) { $failure='Positive owned exit was not established' }
  foreach ($sink in @($stdoutSink,$stderrSink)) { if ($sink) { $sink.Flush() } }
  if ($stdoutSink -and $stdout.IsCompleted) { $stdoutSink.Dispose() }
  if ($stderrSink -and $stderr.IsCompleted) { $stderrSink.Dispose() }
  if ($game) { $game.Dispose() }
  if ($process) { $process.Dispose() }
}
if ($failure) { Write-Error $failure; exit 1 }
