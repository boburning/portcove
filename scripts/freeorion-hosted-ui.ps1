param([string]$Cli,[string]$Library,[string]$RequestId,[int]$RootPid,[string]$ExpectedPlayer,[string]$ExpectedSha256,[ValidateSet('fresh','singleplayer','reopen')][string]$TitleMode,[string]$Evidence,[string]$Prefix)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$true
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FreeOrionWindow {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 public static void FocusOwned(IntPtr h,uint pid){
  uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Window owner differs");
  if(!SetForegroundWindow(h) && GetForegroundWindow()!=h)throw new Exception("Owned window could not become foreground");
  System.Threading.Thread.Sleep(300);GetWindowThreadProcessId(h,out owner);
  if(owner!=pid || GetForegroundWindow()!=h)throw new Exception("Owned foreground changed");
 }
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
 public static void MoveOwned(IntPtr h,uint pid){uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid||GetForegroundWindow()!=h)throw new Exception("Owned move target differs");if(!SetWindowPos(h,IntPtr.Zero,24,24,0,0,0x0001u|0x0004u|0x0010u))throw new Exception("Owned native window move failed");}
 public static bool ForegroundOwned(IntPtr h,uint pid){uint owner;GetWindowThreadProcessId(h,out owner);return owner==pid && GetForegroundWindow()==h;}
 [DllImport("user32.dll",EntryPoint="MapVirtualKeyW",ExactSpelling=true)] static extern uint MapVirtualKey(uint code,uint type);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,Input[] i,int size);
 [StructLayout(LayoutKind.Sequential)] struct Key {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit,Size=32)] struct Union {[FieldOffset(0)]public Key key;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Union data;}
 public static bool InputReleased = true;
 public static void KeyOwned(IntPtr h,uint pid,ushort vk){
  uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Key target owner differs");
  if(!SetForegroundWindow(h) && GetForegroundWindow()!=h)throw new Exception("Owned window could not become foreground");
  if(GetForegroundWindow()!=h)throw new Exception("Owned key target is not foreground");
  // Give SDL time to process its focus event before sending the first key.
  // Keyboard ownership follows foreground/PID identity; do not warp the mouse.
  System.Threading.Thread.Sleep(300);
  GetWindowThreadProcessId(h,out owner);
  if(owner!=pid || GetForegroundWindow()!=h)throw new Exception("Owned key target changed while focus settled");
  if(Marshal.SizeOf(typeof(Input))!=40)throw new Exception("Unsupported native input ABI");
  uint extended = (vk>=0x25 && vk<=0x28) ? 1u : 0u;
  uint scan=MapVirtualKey(vk,0);
  if(scan==0 || scan>255)throw new Exception("Unmapped physical scan code");
  // KEYEVENTF_SCANCODE uses physical key identity; virtual-key field is ignored.
  // https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput
  var down=new Input{type=1,data=new Union{key=new Key{scan=(ushort)scan,flags=extended|8u}}};
  var up=new Input{type=1,data=new Union{key=new Key{scan=(ushort)scan,flags=extended|8u|2u}}};
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

$ownedRoot=[Diagnostics.Process]::GetProcessById($RootPid)
$rootHandle=$ownedRoot.SafeHandle
$rootCreated=[FreeOrionWindow]::Created($rootHandle)
$companions=[Collections.Generic.List[object]]::new();$companionsQuiescent=$false
$ownedGame=$null;$gameHandle=$null;$window=[IntPtr]::Zero;$bound=$false;$positive=$false;$steps=[Collections.Generic.List[object]]::new()
function Read-Launch {
 $nativeErrors=$PSNativeCommandUseErrorActionPreference
 try {
  $PSNativeCommandUseErrorActionPreference=$false
  $text=(& $Cli --library $Library launch show $RequestId --json 2> (Join-Path $Evidence "$Prefix-live-launch.stderr.log")) -join "`n"
  $observedCode=$LASTEXITCODE
 }finally{$PSNativeCommandUseErrorActionPreference=$nativeErrors}
 @{exit_code=$observedCode;request=$RequestId}|ConvertTo-Json|Set-Content (Join-Path $Evidence "$Prefix-live-observation.json") -Encoding utf8
 $text|Set-Content (Join-Path $Evidence "$Prefix-live-launch.json") -Encoding utf8
 if($observedCode -ne 0){throw "Launch observation failed with exit $observedCode; retained JSON/stderr"}
 $value=$text|ConvertFrom-Json
 if(-not $value.ok){throw 'Launch observation envelope failed'}
 return $value.data
}
function Canonical-DrivePath([string]$value) {
 $full=[IO.Path]::GetFullPath($value)
 if($full -match '^\\\\\?\\[A-Za-z]:\\'){return $full.Substring(4)}
 return $full
}
function Assert-Owned {
 if(-not $bound -or $ownedGame.HasExited -or [FreeOrionWindow]::Created($gameHandle) -ne $boundCreated){throw 'Owned game generation unavailable'}
 [uint32]$owner=0;[void][FreeOrionWindow]::GetWindowThreadProcessId($window,[ref]$owner)
 if($owner -ne $ownedGame.Id){throw 'Owned window changed'}
}
function Capture([string]$label) {
 Assert-Owned
 $rect=[FreeOrionWindow+Rect]::new()
 if(-not [FreeOrionWindow]::GetWindowRect($window,[ref]$rect)){throw 'Window geometry unavailable'}
 $width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
 if($width -lt 100 -or $height -lt 80 -or $width -gt 2560 -or $height -gt 1600){throw 'Capture outside bounds'}
 $bitmap=[Drawing.Bitmap]::new($width,$height);$graphics=[Drawing.Graphics]::FromImage($bitmap)
 try{if(-not [FreeOrionWindow]::ForegroundOwned($window,[uint32]$ownedGame.Id)){throw 'Owned window is not foreground immediately before capture'};$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save((Join-Path $Evidence "$Prefix-$label.png"),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
 $steps.Add(@{capture=$label;at=[DateTime]::UtcNow.ToString('o');width=$width;height=$height})
}

function Observe-Companions {
 if(-not $bound){throw 'No selected-player generation for family observation'}
 $package=Split-Path -Parent $ExpectedPlayer
 $rows=@(Get-CimInstance Win32_Process -Filter "Name = 'FreeOrionD.exe' OR Name = 'FreeOrionCA.exe'" | Sort-Object @{Expression={if($_.Name -eq 'FreeOrionD.exe'){0}else{1}}})
 foreach($row in $rows){
  if(-not $row.ExecutablePath -or (Canonical-DrivePath (Split-Path -Parent $row.ExecutablePath)) -ne (Canonical-DrivePath $package)){continue}
  $existing=@($companions|Where-Object {$_.pid -eq $row.ProcessId})
  if($existing.Count){continue}
  $process=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId);$handle=$process.SafeHandle;$created=[FreeOrionWindow]::Created($handle)
  if($created -lt $boundCreated -or $process.SessionId -ne $ownedRoot.SessionId){throw 'Private companion generation/session differs'}
  if($row.Name -eq 'FreeOrionD.exe'){$digest='318e8ff748df4bae09bf4b7e3b80d9b8bda4ec9557852fa3edab6715ffb98c69';if($row.ParentProcessId -ne $ownedGame.Id){throw 'Private server parent differs'}}
  else{$digest='2fb39806340a7e6f4b5ffc3353e97ea30cfa4a9c06f8e3f9dda649a1a1fa27e0';if(-not @($companions|Where-Object {$_.name -eq 'FreeOrionD.exe' -and $_.pid -eq $row.ParentProcessId}).Count){throw 'Private AI parent differs'}}
  $actual=$process.MainModule.FileName
  if((Canonical-DrivePath $actual) -ne (Canonical-DrivePath $row.ExecutablePath) -or (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw 'Private companion bytes differ'}
  $companions.Add(@{pid=$process.Id;name=$row.Name;parent=[int]$row.ParentProcessId;created=$created;sha256=$digest;path=$actual;process=$process;handle=$handle})
 }
}
function Write-Family([string]$label) {
 $observed=@($companions|ForEach-Object{@{pid=$_.pid;name=$_.name;parent=$_.parent;identity="windows-filetime:$($_.created)";sha256=$_.sha256;path=$_.path;exited=$_.process.HasExited}})
 @{label=$label;at=[DateTime]::UtcNow.ToString('o');selected_player_exited=$ownedGame.HasExited;companions=$observed;scope='exact private observed server/AI generations; selected-player supervision remains distinct'}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $Evidence "$Prefix-family-$label.json") -Encoding utf8
}
function Wait-Companions {
 $until=[DateTime]::UtcNow.AddSeconds(30)
 do {
  Observe-Companions
  if(-not @($companions|Where-Object{-not $_.process.HasExited}).Count){Start-Sleep -Milliseconds 500;Observe-Companions;if(-not @($companions|Where-Object{-not $_.process.HasExited}).Count){return $true}}
  Start-Sleep -Milliseconds 250
 }while([DateTime]::UtcNow -lt $until)
 return $false
}
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(65)
 while([DateTime]::UtcNow -lt $deadline -and -not $ownedRoot.HasExited){
  $launch=Read-Launch
  if($launch.child_pid){
   if(-not $ownedGame){$ownedGame=[Diagnostics.Process]::GetProcessById([int]$launch.child_pid);$gameHandle=$ownedGame.SafeHandle}
   $created=[FreeOrionWindow]::Created($gameHandle)
   if($launch.child_pid -ne $ownedGame.Id -or $launch.supervisor_pid -ne $RootPid -or $launch.supervisor_identity -ne "windows-filetime:$rootCreated" -or $launch.child_identity -ne "windows-filetime:$created" -or $created -lt $rootCreated){throw 'Core/OS process identities differ'}
   $actualPlayer=[IO.Path]::GetFullPath($ownedGame.MainModule.FileName)
   if((Canonical-DrivePath $actualPlayer) -ne (Canonical-DrivePath $ExpectedPlayer) -or $ownedGame.SessionId -ne $ownedRoot.SessionId){throw 'Owned player/session differs'}
   if((Get-FileHash -LiteralPath $actualPlayer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256){throw 'Executed game bytes differ'}
   $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($ownedGame.Id)"
   if(-not $parent -or $parent.ParentProcessId -ne $RootPid){throw 'Owned game parent differs'}
   $boundCreated=$created;$bound=$true;$window=[FreeOrionWindow]::Find([uint32]$ownedGame.Id)
   if($window -ne [IntPtr]::Zero){break}
  }
  Start-Sleep -Milliseconds 250
 }
 if(-not $bound -or $window -eq [IntPtr]::Zero){throw 'No exact owned interactive game window'}
 Start-Sleep -Seconds 2
 # SDL may replace its startup window while selecting the configured video mode.
 # Settle only before input, against the retained same-generation game process.
 $settleDeadline=[DateTime]::UtcNow.AddSeconds(15)
 $stable=[IntPtr]::Zero;$stableSince=[DateTime]::UtcNow;$settled=$false
 while([DateTime]::UtcNow -lt $settleDeadline){
  if($ownedGame.HasExited -or [FreeOrionWindow]::Created($gameHandle) -ne $boundCreated){throw 'Owned game changed during startup'}
  $candidate=[FreeOrionWindow]::Find([uint32]$ownedGame.Id)
  if($candidate -eq [IntPtr]::Zero -or $candidate -ne $stable){$stable=$candidate;$stableSince=[DateTime]::UtcNow}
  elseif(([DateTime]::UtcNow-$stableSince).TotalMilliseconds -ge 500){$window=$candidate;$settled=$true;break}
  Start-Sleep -Milliseconds 100
 }
 if(-not $settled){throw 'No stable owned startup window'}
 Assert-Owned
 [FreeOrionWindow]::FocusOwned($window,[uint32]$ownedGame.Id)
 Start-Sleep -Seconds 2
 Assert-Owned
 Capture 'client-window'
 if($TitleMode -eq 'fresh'){
  # Upstream HandleWindowMove commits actual settings; ordinary startup alone need not.
  Assert-Owned;[FreeOrionWindow]::MoveOwned($window,[uint32]$ownedGame.Id)
  $settings=Join-Path $env:APPDATA 'FreeOrion/config.xml'
  $settingsDeadline=[DateTime]::UtcNow.AddSeconds(5)
  while(-not (Test-Path -LiteralPath $settings) -and [DateTime]::UtcNow -lt $settingsDeadline){Assert-Owned;Start-Sleep -Milliseconds 100}
  if(-not (Test-Path -LiteralPath $settings)){throw 'Actual native window move did not commit settings'}
  $steps.Add(@{operation='native-owned-window-move';x=24;y=24;settings=$settings;at=[DateTime]::UtcNow.ToString('o')})
  Capture 'settings-window-moved'
 }
 if($TitleMode -eq 'singleplayer'){
  $ready=$false;$gameDeadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $gameDeadline){
   Assert-Owned;Observe-Companions
   $saves=@(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'FreeOrion') -Recurse -File -Filter '*.sav'|Where-Object {$_.Length -gt 1024})
   if($saves.Count -gt 0 -and @($companions|Where-Object {$_.name -eq 'FreeOrionCA.exe'}).Count -gt 0){$ready=$true;break}
   Start-Sleep -Milliseconds 500
  }
  if(-not $ready){Write-Family 'singleplayer-incomplete';throw 'Quickstart AI plus populated autosave not established'}
  Start-Sleep -Seconds 3
  [FreeOrionWindow]::FocusOwned($window,[uint32]$ownedGame.Id)
  Capture 'singleplayer-ai'
  Write-Family 'singleplayer'
  # A reviewed upstream quit.hotkey binding invokes ResetToIntro, not app exit.
  Assert-Owned;[FreeOrionWindow]::KeyOwned($window,[uint32]$ownedGame.Id,0x7A)
  $steps.Add(@{key='F11';binding='quit.hotkey=GGK_F11';purpose='upstream ResetToIntro';at=[DateTime]::UtcNow.ToString('o')})
  $companionsQuiescent=Wait-Companions
  Write-Family 'after-return'
  if(-not $companionsQuiescent){throw 'Companion shutdown remains active after return; no preservation snapshot allowed'}
  Assert-Owned;[FreeOrionWindow]::FocusOwned($window,[uint32]$ownedGame.Id)
  Capture 'returned-menu'
 }
 [FreeOrionWindow]::CloseOwned($window,[uint32]$ownedGame.Id)
 if(-not $ownedRoot.WaitForExit(20000) -or -not $ownedGame.WaitForExit(5000)){throw 'Normal owned exit not established'}
 $companionsQuiescent=Wait-Companions
 Write-Family 'after-client-exit'
 if(-not $companionsQuiescent){throw 'Observed companion writers still live after client exit'}
 $final=Read-Launch
 if($ownedRoot.ExitCode -ne 0 -or $final.outcome -ne 'succeeded' -or $final.exit_code -ne 0){throw 'Core launch did not report normal success'}
 $positive=[FreeOrionWindow]::InputReleased
 @{request=$RequestId;root_pid=$RootPid;root_identity="windows-filetime:$rootCreated";child_pid=$ownedGame.Id;child_identity="windows-filetime:$boundCreated";player=$actualPlayer;player_sha256=$ExpectedSha256;session=$ownedGame.SessionId;mode=$TitleMode;steps=$steps;final_launch=$final;scope='real owned Core CLI/client window and normal close; singleplayer mode sends only owned F11 down/up; screenshots and game logs require inspection'}|ConvertTo-Json -Depth 15|Set-Content (Join-Path $Evidence "$Prefix-ui.json") -Encoding utf8
}catch{
 @{error=$_.Exception.Message;steps=$steps;bound=$bound}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $Evidence "$Prefix-ui-failure.json") -Encoding utf8
 throw
 }finally{
 if($bound){Write-Family 'cleanup'}
 $forcedCleanup=$false
 if(-not $positive -and -not $ownedRoot.HasExited){
  if($bound -and -not $ownedGame.HasExited -and $window -ne [IntPtr]::Zero){try{Assert-Owned;[FreeOrionWindow]::CloseOwned($window,[uint32]$ownedGame.Id);[void]$ownedRoot.WaitForExit(5000)}catch{}}
  if(-not $ownedRoot.HasExited -and [FreeOrionWindow]::Created($rootHandle) -eq $rootCreated){$forcedCleanup=$true;$ownedRoot.Kill();[void]$ownedRoot.WaitForExit(5000)}
 }
 if($ownedGame -and -not $ownedGame.HasExited){[void]$ownedGame.WaitForExit(5000)}
 @{positive_exit=$positive;input_released=[FreeOrionWindow]::InputReleased;root_exited=$ownedRoot.HasExited;child_exited=$(if($ownedGame){$ownedGame.HasExited}else{$false});forced_cleanup=$forcedCleanup;companions_quiescent=$companionsQuiescent}|ConvertTo-Json|Set-Content (Join-Path $Evidence "$Prefix-ui-cleanup.json") -Encoding utf8
}
