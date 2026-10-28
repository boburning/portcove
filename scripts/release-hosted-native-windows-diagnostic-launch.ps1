param([ValidateSet('Preflight','Start')][string]$Operation='Start')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Fresh S2 source/account/candidate/recovery scope only; neither S1 nor production.
$connectedDiagnosticLaunchAuthorized=$false
if(-not $connectedDiagnosticLaunchAuthorized){throw 'Connected Windows S2 diagnostic remains held pending the exact source/account/candidate/recovery/resource approval'}
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or $env:GITHUB_JOB -cne 'installed-prerequisite' -or
    $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,15}$' -or
    $env:GITHUB_WORKFLOW_REF -cnotmatch '^boburning/portcove/[.]github/workflows/hosted-native-continuity[.]yml@refs/heads/(main|feature/534-[A-Za-z0-9-]+)$' -or
    $env:PORTCOVE_HOSTED_PLATFORM -cne 'windows-x86_64' -or $env:PORTCOVE_HOSTED_OBSERVATION_ONLY -cne 'false' -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64' -or -not $IsWindows){throw 'Fixed hosted Windows diagnostic context required'}
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$actual=(& git -C $source rev-parse HEAD|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -cne $env:GITHUB_SHA){throw 'Actual diagnostic source differs'}
& git -C $source diff --quiet HEAD --
if($LASTEXITCODE -ne 0){throw 'Clean tracked diagnostic source required'}
if($Operation -ceq 'Preflight'){return}
function Read-LaunchBytes([string]$Path,[int]$Maximum){
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Original regular diagnostic launch input required'}
    $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{if($stream.Length -lt 1 -or $stream.Length -gt $Maximum){throw 'Diagnostic launch input exceeds bound'};$bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes);if($stream.ReadByte() -ne -1 -or $stream.Length -ne $bytes.Length){throw 'Diagnostic launch input changed'};return ,$bytes}finally{$stream.Dispose()}
}
$utf8=[Text.UTF8Encoding]::new($false,$true)
$setupBytes=Read-LaunchBytes (Join-Path $source 'scripts/release-hosted-native-windows-setup.cs.txt') 131072
Add-Type -TypeDefinition $utf8.GetString($setupBytes)
$control=Join-Path $env:RUNNER_TEMP 'portcove-hosted-windows-connected-diagnostic'
$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[Portcove.HostedNative.Setup]::Directory($control,$broker,'',$false)
$node=(Get-Command node -CommandType Application).Source
if([IO.Path]::GetFileName($node) -cne 'node.exe' -or (& $node --version|Out-String).Trim() -cne 'v24.22.1' -or $LASTEXITCODE -ne 0){throw 'Fixed existing Node24.22.1 runtime required'}
$closed=[ordered]@{}
foreach($name in @('SystemRoot','WINDIR','PATH','PATHEXT','USERPROFILE','HOME','TEMP','TMP','LOCALAPPDATA','RUNNER_TEMP','RUNNER_TRACKING_ID','RUSTUP_HOME','CARGO_HOME','PORTCOVE_SHARED_TOOL_CACHE','PORTCOVE_RESOURCE_RESERVATION','PORTCOVE_RESOURCE_PROCESS_TOKEN','PORTCOVE_HEAVY_RUST_LOCK_TOKEN','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_JOB','GITHUB_WORKFLOW_REF','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_EVENT_NAME','PORTCOVE_HOSTED_PLATFORM','PORTCOVE_HOSTED_OBSERVATION_ONLY')){
    $value=[Environment]::GetEnvironmentVariable($name,'Process')
    if($null -ne $value){if($value.Length -gt 32768 -or $value.Contains([char]0)){throw 'Closed diagnostic environment differs'};$closed[$name]=$value}
}
foreach($name in @('SystemRoot','PATH','RUNNER_TEMP','RUNNER_TRACKING_ID')){if(-not $closed.Contains($name) -or -not $closed[$name]){throw 'Original provider tracking/runtime context missing'}}
$closed.NODE_NO_WARNINGS='1'
$environment=(@($closed.Keys|Sort-Object|ForEach-Object {$_+'='+$closed[$_]})-join "`0")+"`0`0"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
namespace Portcove.Diagnostic {
 public sealed class OriginalController : IDisposable {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int cb;public string reserved;public string desktop;public string title;public int x,y,cx,cy,xc,yc,fill,flags;public short show,reservedSize;public IntPtr reserved2,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct FileTime {public uint low,high;public long Value {get{return ((long)high<<32)|low;}}}
  [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string image,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo information);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exit,out FileTime kernel,out FileTime user);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  IntPtr handle;public int Pid {get;private set;}public string Created {get;private set;}
  OriginalController(IntPtr process,uint pid,long created){handle=process;Pid=checked((int)pid);Created=created.ToString(CultureInfo.InvariantCulture);}
  public static OriginalController Start(string node,string source,string environment){
   string entry=Path.Combine(source,"scripts","release-hosted-native-windows-diagnostic.mts");
   if(!Path.IsPathFullyQualified(node)||!Path.IsPathFullyQualified(source)||Path.GetFileName(node)!="node.exe"||node.Contains("\"")||source.Contains("\"")||!File.Exists(entry)||!environment.EndsWith("\0\0",StringComparison.Ordinal))throw new InvalidOperationException("Fixed diagnostic executable/source/environment required");
   IntPtr block=Marshal.StringToHGlobalUni(environment);ProcessInfo info=new ProcessInfo();bool launched=false;
   try{var startup=new Startup{cb=Marshal.SizeOf<Startup>()};if(!CreateProcessW(node,new StringBuilder("\""+node+"\" \""+entry+"\" run"),IntPtr.Zero,IntPtr.Zero,false,0x08000400,block,source,ref startup,out info))throw new Win32Exception(Marshal.GetLastWin32Error(),"Start original diagnostic controller without inherited handles");launched=true;
    FileTime created,exit,kernel,user;if(!GetProcessTimes(info.process,out created,out exit,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error(),"Original controller generation unavailable");
    var result=new OriginalController(info.process,info.pid,created.Value);info.process=IntPtr.Zero;return result;
   }catch{if(launched&&info.process!=IntPtr.Zero){TerminateProcess(info.process,2);WaitForSingleObject(info.process,5000);}throw;}
   finally{if(info.thread!=IntPtr.Zero)CloseHandle(info.thread);if(info.process!=IntPtr.Zero)CloseHandle(info.process);Marshal.FreeHGlobal(block);}
  }
  public bool Alive(){FileTime created,exit,kernel,user;uint code;if(handle==IntPtr.Zero||GetProcessId(handle)!=(uint)Pid||!GetProcessTimes(handle,out created,out exit,out kernel,out user)||created.Value.ToString(CultureInfo.InvariantCulture)!=Created)throw new InvalidOperationException("Original controller handle/generation differs");if(!GetExitCodeProcess(handle,out code))throw new Win32Exception(Marshal.GetLastWin32Error());return code==259;}
  public void StopOriginal(){if(Alive()&&!TerminateProcess(handle,2))throw new Win32Exception(Marshal.GetLastWin32Error());if(WaitForSingleObject(handle,5000)!=0)throw new InvalidOperationException("Original controller startup cleanup unobserved");}
  public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
 }
}
'@
$launch=$null;$ackPublicationAttempted=$false
try{
    $launch=[Portcove.Diagnostic.OriginalController]::Start($node,$source,$environment)
    $clock=[Diagnostics.Stopwatch]::StartNew();$readyPath=Join-Path $control 'controller-ready.json';$readyBytes=$null
    while($null -eq $readyBytes){
        if($clock.ElapsedMilliseconds -ge 330000 -or -not $launch.Alive()){throw 'Original controller startup/source preflight failed or expired'}
        try{if(Test-Path -LiteralPath $readyPath){$readyBytes=Read-LaunchBytes $readyPath 16384}}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -notin @(32,33)){throw}}
        if($null -eq $readyBytes){Start-Sleep -Milliseconds 100}
    }
    $ready=$utf8.GetString($readyBytes)|ConvertFrom-Json
    if($ready.schema_version -ne 1 -or $ready.pid -ne $launch.Pid -or $ready.created_filetime -cne $launch.Created -or
        $ready.source -cne $env:GITHUB_SHA -or $ready.run_id -cne $env:GITHUB_RUN_ID -or $ready.attempt -ne 1 -or
        $ready.workflow -cne $env:GITHUB_WORKFLOW_REF -or $ready.authority -cne 'none' -or -not $launch.Alive()){throw 'Original diagnostic startup receipt differs'}
    $ack=[ordered]@{schema_version=1;pid=$launch.Pid;created_filetime=$launch.Created;ready_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($readyBytes)).ToLowerInvariant()}
    $ackPublicationAttempted=$true
    $bytes=$utf8.GetBytes(($ack|ConvertTo-Json -Compress));$stream=[IO.FileStream]::new((Join-Path $control 'controller-start-ack.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
    [ordered]@{source=$env:GITHUB_SHA;run_id=$env:GITHUB_RUN_ID;attempt=1;pid=$launch.Pid;created_filetime=$launch.Created;phase='original controller acknowledged; connected effects remain separately gated';authority='none'}|ConvertTo-Json -Compress
}catch{
    $original=$_
    if($launch -and -not $ackPublicationAttempted){try{$launch.StopOriginal()}catch{[Console]::Error.WriteLine('Original controller startup cleanup remains Unknown; retain provider generation evidence')}}
    elseif($launch){
        # A flushed acknowledgement may already have enabled the original owner.
        # Retain that controller for its one exact recovery instead of killing it.
        try{$bytes=$utf8.GetBytes((@{pid=$launch.Pid;created_filetime=$launch.Created;source=$env:GITHUB_SHA;run_id=$env:GITHUB_RUN_ID;authority='none'}|ConvertTo-Json -Compress));$abort=[IO.FileStream]::new((Join-Path $control 'abort-request.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$abort.Write($bytes);$abort.Flush($true)}finally{$abort.Dispose()}}catch{[Console]::Error.WriteLine('Original controller abort request unavailable; retain its bounded deadline and provider cleanup')}
    }
    throw $original
}finally{if($launch){$launch.Dispose()}}
