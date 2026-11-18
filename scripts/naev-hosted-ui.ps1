param([string]$Cli,[string]$Library,[string]$RequestId,[int]$RootPid,[string]$ExpectedPlayer,[string]$ExpectedSha256,[ValidateSet('fresh','reopen')][string]$TitleMode,[string]$Evidence,[string]$Prefix)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$true
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NaevWindow {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 public static void FocusOwned(IntPtr h,uint pid){
  uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Window owner differs");
  if(!SetForegroundWindow(h) && GetForegroundWindow()!=h)throw new Exception("Owned window could not become foreground");
  System.Threading.Thread.Sleep(300);GetWindowThreadProcessId(h,out owner);
  if(owner!=pid || GetForegroundWindow()!=h)throw new Exception("Owned foreground changed");
 }
 public static bool ForegroundOwned(IntPtr h,uint pid){uint owner;GetWindowThreadProcessId(h,out owner);return owner==pid && GetForegroundWindow()==h;}
 [DllImport("user32.dll",EntryPoint="MapVirtualKeyW",ExactSpelling=true)] static extern uint MapVirtualKey(uint code,uint type);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,Input[] i,int size);
 [StructLayout(LayoutKind.Sequential)] struct Key {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit,Size=32)] struct Union {[FieldOffset(0)]public Key key;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Union data;}
 public static bool InputReleased = true;
 public static int CompletedKeys = 0;
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
  try{System.Threading.Thread.Sleep(120);}finally{if(SendInput(1,new[]{up},40)!=1)throw new Exception("Key release failed");InputReleased=true;CompletedKeys++;}
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
$rootCreated=[NaevWindow]::Created($rootHandle)
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
 if(-not $bound -or $ownedGame.HasExited -or [NaevWindow]::Created($gameHandle) -ne $boundCreated){throw 'Owned game generation unavailable'}
 [uint32]$owner=0;[void][NaevWindow]::GetWindowThreadProcessId($window,[ref]$owner)
 if($owner -ne $ownedGame.Id){throw 'Owned window changed'}
}
function Capture([string]$label) {
 Assert-Owned
 $rect=[NaevWindow+Rect]::new()
 if(-not [NaevWindow]::GetWindowRect($window,[ref]$rect)){throw 'Window geometry unavailable'}
 $width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
 if($width -lt 100 -or $height -lt 80 -or $width -gt 2560 -or $height -gt 1600){throw 'Capture outside bounds'}
 $bitmap=[Drawing.Bitmap]::new($width,$height);$graphics=[Drawing.Graphics]::FromImage($bitmap)
 try{if(-not [NaevWindow]::ForegroundOwned($window,[uint32]$ownedGame.Id)){throw 'Owned window is not foreground immediately before capture'};$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save((Join-Path $Evidence "$Prefix-$label.png"),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
 $steps.Add(@{capture=$label;at=[DateTime]::UtcNow.ToString('o');width=$width;height=$height})
}
function Key([int]$vk,[bool]$expectExit=$false) {
 Assert-Owned
 $before=[NaevWindow]::CompletedKeys
 try{[NaevWindow]::KeyOwned($window,[uint32]$ownedGame.Id,[uint16]$vk)}catch{
  if(-not $expectExit -or [NaevWindow]::CompletedKeys -ne ($before+1) -or -not [NaevWindow]::InputReleased -or -not $ownedGame.WaitForExit(5000)){throw}
 }
 if([NaevWindow]::CompletedKeys -ne ($before+1)){throw 'No completed owned key pair'}
 $steps.Add(@{key=$vk;at=[DateTime]::UtcNow.ToString('o');input_released=[NaevWindow]::InputReleased;completed_pair=[NaevWindow]::CompletedKeys})
}
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(65)
 while([DateTime]::UtcNow -lt $deadline -and -not $ownedRoot.HasExited){
  $launch=Read-Launch
  if($launch.child_pid){
   if(-not $ownedGame){$ownedGame=[Diagnostics.Process]::GetProcessById([int]$launch.child_pid);$gameHandle=$ownedGame.SafeHandle}
   $created=[NaevWindow]::Created($gameHandle)
   if($launch.child_pid -ne $ownedGame.Id -or $launch.supervisor_pid -ne $RootPid -or $launch.supervisor_identity -ne "windows-filetime:$rootCreated" -or $launch.child_identity -ne "windows-filetime:$created" -or $created -lt $rootCreated){throw 'Core/OS process identities differ'}
   $actualPlayer=[IO.Path]::GetFullPath($ownedGame.MainModule.FileName)
   if((Canonical-DrivePath $actualPlayer) -ne (Canonical-DrivePath $ExpectedPlayer) -or $ownedGame.SessionId -ne $ownedRoot.SessionId){throw 'Owned player/session differs'}
   if((Get-FileHash -LiteralPath $actualPlayer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256){throw 'Executed game bytes differ'}
   $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($ownedGame.Id)"
   if(-not $parent -or $parent.ParentProcessId -ne $RootPid){throw 'Owned game parent differs'}
   $boundCreated=$created;$bound=$true;$window=[NaevWindow]::Find([uint32]$ownedGame.Id)
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
  if($ownedGame.HasExited -or [NaevWindow]::Created($gameHandle) -ne $boundCreated){throw 'Owned game changed during startup'}
  $candidate=[NaevWindow]::Find([uint32]$ownedGame.Id)
  if($candidate -eq [IntPtr]::Zero -or $candidate -ne $stable){$stable=$candidate;$stableSince=[DateTime]::UtcNow}
  elseif(([DateTime]::UtcNow-$stableSince).TotalMilliseconds -ge 500){$window=$candidate;$settled=$true;break}
  Start-Sleep -Milliseconds 100
 }
 if(-not $settled){throw 'No stable owned startup window'}
 Assert-Owned
 [NaevWindow]::FocusOwned($window,[uint32]$ownedGame.Id)
 Start-Sleep -Seconds 2
 Assert-Owned
 Capture 'client-window'
 if($TitleMode -eq 'fresh'){
  # Exact fresh v0.13.5 package shows the single-button Welcome dialog.
  Key 0x0D
  Start-Sleep -Seconds 1
  Assert-Owned
  Capture 'welcome-acknowledged-menu'
 }
 [NaevWindow]::CloseOwned($window,[uint32]$ownedGame.Id)
 Start-Sleep -Milliseconds 500
 if(-not $ownedGame.HasExited){
  Assert-Owned
  [NaevWindow]::FocusOwned($window,[uint32]$ownedGame.Id)
  Capture 'quit-confirmation'
  # Tagged dialogue_YesNoRaw binds SDL_Y to the Yes button.
  Key 0x59 $true
 }
 if(-not $ownedRoot.WaitForExit(20000) -or -not $ownedGame.WaitForExit(5000)){throw 'Normal owned exit not established'}
 $final=Read-Launch
 if($ownedRoot.ExitCode -ne 0 -or $final.outcome -ne 'succeeded' -or $final.exit_code -ne 0){throw 'Core launch did not report normal success'}
 $positive=[NaevWindow]::InputReleased
 @{request=$RequestId;root_pid=$RootPid;root_identity="windows-filetime:$rootCreated";child_pid=$ownedGame.Id;child_identity="windows-filetime:$boundCreated";player=$actualPlayer;player_sha256=$ExpectedSha256;session=$ownedGame.SessionId;mode=$TitleMode;steps=$steps;final_launch=$final;scope='real owned Core CLI/client window and normal close; owned fresh Welcome Enter and quit-confirmation Y with positive key release; image inspection still required'}|ConvertTo-Json -Depth 15|Set-Content (Join-Path $Evidence "$Prefix-ui.json") -Encoding utf8
}catch{
 @{error=$_.Exception.Message;steps=$steps;bound=$bound}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $Evidence "$Prefix-ui-failure.json") -Encoding utf8
 throw
 }finally{
 $forcedCleanup=$false
 if(-not $positive -and -not $ownedRoot.HasExited){
  if($bound -and -not $ownedGame.HasExited -and $window -ne [IntPtr]::Zero){try{Assert-Owned;[NaevWindow]::CloseOwned($window,[uint32]$ownedGame.Id);[void]$ownedRoot.WaitForExit(5000)}catch{}}
  if(-not $ownedRoot.HasExited -and [NaevWindow]::Created($rootHandle) -eq $rootCreated){$forcedCleanup=$true;$ownedRoot.Kill();[void]$ownedRoot.WaitForExit(5000)}
 }
 if($ownedGame -and -not $ownedGame.HasExited){[void]$ownedGame.WaitForExit(5000)}
 @{positive_exit=$positive;input_released=[NaevWindow]::InputReleased;root_exited=$ownedRoot.HasExited;child_exited=$(if($ownedGame){$ownedGame.HasExited}else{$false});forced_cleanup=$forcedCleanup}|ConvertTo-Json|Set-Content (Join-Path $Evidence "$Prefix-ui-cleanup.json") -Encoding utf8
}
