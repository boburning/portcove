param(
    [ValidateSet('Preflight','Prepare','Start','Request','Ack','Settle','Abort','Publish')][string]$Operation='Start',
    [ValidateSet('payload-signing','release-publication')][string]$Stage,
    [string]$RequestHash,[string]$ArtifactId,[string]$ArtifactDigest
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Fresh S2 source/account/candidate/recovery scope only; neither S1 nor production.
$connectedDiagnosticLaunchAuthorized=$true
if(-not $connectedDiagnosticLaunchAuthorized){throw 'Connected Windows S2 diagnostic remains held pending the exact source/account/candidate/recovery/resource approval'}
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or $env:GITHUB_JOB -cne 'installed-prerequisite' -or
    $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,15}$' -or
    $env:GITHUB_WORKFLOW_REF -cnotmatch '^boburning/portcove/[.]github/workflows/hosted-native-continuity[.]yml@refs/heads/feature/534-connected-custody-canary-20261029$' -or
    $env:PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC -cne 'true' -or $env:PORTCOVE_HOSTED_PLATFORM -cne 'windows-x86_64' -or $env:PORTCOVE_HOSTED_OBSERVATION_ONLY -cne 'false' -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64' -or -not $IsWindows){throw 'Fixed hosted Windows diagnostic context required'}
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixedGit='C:\Program Files\Git\cmd\git.exe'
$actual=(& $fixedGit -c core.fsmonitor=false -C $source rev-parse HEAD|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -cne $env:GITHUB_SHA){throw 'Actual diagnostic source differs'}
& $fixedGit -c core.fsmonitor=false -C $source diff --quiet HEAD --
if($LASTEXITCODE -ne 0){throw 'Clean tracked diagnostic source required'}
$actualTree=(& $fixedGit -c core.fsmonitor=false -C $source rev-parse 'HEAD^{tree}'|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actualTree -cnotmatch '^[a-f0-9]{40}$'){throw 'Original diagnostic source tree unavailable'}
if($Operation -ceq 'Preflight'){return}
$originalStartupMaximumMilliseconds=330000
$originalStartupClock=[Diagnostics.Stopwatch]::StartNew()
if($Operation -cin @('Publish','Ack','Abort')){$originalStartupMaximumMilliseconds=45000}
function Read-LaunchBytes([string]$Path,[int]$Maximum,[bool]$AllowEmpty=$false){
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Original regular diagnostic launch input required'}
    $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{if($null -ne ('Portcove.HostedNative.Setup' -as [type])){[Portcove.HostedNative.Setup]::SingleLinkFile($stream.SafeFileHandle)};if($stream.Length -lt $(if($AllowEmpty){0}else{1}) -or $stream.Length -gt $Maximum){throw 'Diagnostic launch input exceeds bound'};$bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes);if($stream.ReadByte() -ne -1 -or $stream.Length -ne $bytes.Length){throw 'Diagnostic launch input changed'};return ,$bytes}finally{$stream.Dispose()}
}
function Select-ClosedCustodyReader([object]$r){
    if($null -eq $r){return $null}
    if((@($r.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'kind,ordinal,phase,principal_class,reason,rights,schema_version' -or
        $r.schema_version -ne 1 -or $r.reason -cnotin @('runtime','input','regular-path','owner','writer','os-read') -or
        $r.phase -cnotin @('entry','input','item','acl','owner','rules','complete') -or $r.kind -cnotin @('unknown','file','directory') -or
        $r.principal_class -cnotin @('unknown','everyone','authenticated-users','builtin-users','interactive','logon-session','creator-owner','other') -or
        ($null -ne $r.ordinal -and (($r.ordinal -isnot [long] -and $r.ordinal -isnot [int]) -or $r.ordinal -lt 0 -or $r.ordinal -ge 4096)) -or
        ($r.rights -isnot [long] -and $r.rights -isnot [int]) -or $r.rights -lt 0 -or $r.rights -gt 31){return $null}
    return @{schema_version=1;reason=$r.reason;phase=$r.phase;ordinal=$r.ordinal;kind=$r.kind;principal_class=$r.principal_class;rights=$r.rights}
}
$utf8=[Text.UTF8Encoding]::new($false,$true)
function Resolve-OriginalBootstrapNode {
# Resolve the original provider runtime ONLY during ordinary pre-private Prepare.
$nodeCommand=Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$node=$nodeCommand.Source
if($node -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($node) -or [IO.Path]::GetFileName($node) -cne 'node.exe'){throw 'Fixed existing Node24.22.1 runtime required'}
$nodeItem=Get-Item -LiteralPath $node -Force
if($nodeItem.PSIsContainer -or ($nodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Original regular Node executable required'}
if((& $node --version|Out-String).Trim() -cne 'v24.22.1' -or $LASTEXITCODE -ne 0){throw 'Fixed existing Node24.22.1 runtime required'}
    return $node
}
$workspace=$env:GITHUB_WORKSPACE
$publicTemp=$env:RUNNER_TEMP
if($Operation -ceq 'Prepare'){
    $node=Resolve-OriginalBootstrapNode
    & $node (Join-Path $source 'scripts/release-hosted-native-windows-diagnostic.mts') prepare
    if($LASTEXITCODE -ne 0){throw 'Bounded diagnostic closure preparation refused; retain original partial namespace'}
    $preparedRoot=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ('.pct-connected-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_SHA.Substring(0,12))
    $completed=$utf8.GetString((Read-LaunchBytes (Join-Path $preparedRoot 'preparation.json') 65536))|ConvertFrom-Json
    foreach($key in @('launcher_sha256','setup_sha256','node_sha256')){if($completed.$key -cnotmatch '^[a-f0-9]{64}$'){throw 'Complete prepared bootstrap integrity required'}}
    if($completed.source -cne $env:GITHUB_SHA -or $completed.run_id -cne $env:GITHUB_RUN_ID -or $completed.attempt -ne 1 -or $completed.workflow -cne $env:GITHUB_WORKFLOW_REF -or $completed.public_workspace -cne $workspace -or $completed.public_runner_temp -cne $publicTemp){throw 'Original preparation output context differs'}
    $output=@(('launcher_sha256='+$completed.launcher_sha256),('setup_sha256='+$completed.setup_sha256),('node_sha256='+$completed.node_sha256))
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT,($output -join "`n")+"`n")
    return
}
try{
if(-not [IO.Path]::IsPathFullyQualified($workspace) -or $env:DIAGNOSTIC_SETUP_SHA -cnotmatch '^[a-f0-9]{64}$' -or $env:DIAGNOSTIC_NODE_SHA -cnotmatch '^[a-f0-9]{64}$'){throw 'Sealed pre-private bootstrap context required'}
$derivedRoot=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ('.pct-connected-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_SHA.Substring(0,12))
if($source -cne (Join-Path $derivedRoot 'windows-source/source')){throw 'Later diagnostic operations require the captured launcher source'}
$setupBytes=Read-LaunchBytes (Join-Path $source 'scripts/release-hosted-native-windows-setup.cs.txt') 131072
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($setupBytes)).ToLowerInvariant() -cne $env:DIAGNOSTIC_SETUP_SHA){throw 'Captured setup differs from sealed bootstrap hash'}
Add-Type -TypeDefinition $utf8.GetString($setupBytes)
# The locator is data. Derive the only permitted roots from this original
# source/run/HOME tuple; it cannot appoint an executable or another controller.
$expectedRoot=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ('.pct-connected-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_SHA.Substring(0,12))
$prepared=$utf8.GetString((Read-LaunchBytes (Join-Path $workspace 'work/hosted-continuity-evidence/windows-diagnostic-preparation.json') 65536))|ConvertFrom-Json
$expectedSource=Join-Path $expectedRoot 'windows-source/source'
$expectedNode=Join-Path $expectedRoot 'tools/bin/node.exe'
$expectedTemp=Join-Path $expectedRoot 'temp'
if($prepared.schema_version -ne 1 -or $prepared.source -cne $env:GITHUB_SHA -or $prepared.tree -cne $actualTree -or
    $prepared.run_id -cne $env:GITHUB_RUN_ID -or $prepared.attempt -ne 1 -or $prepared.workflow -cne $env:GITHUB_WORKFLOW_REF -or
    $prepared.authority -cne 'none' -or $prepared.public_workspace -cne $workspace -or $prepared.public_runner_temp -cne $publicTemp -or
    $prepared.setup_sha256 -cne $env:DIAGNOSTIC_SETUP_SHA -or $prepared.node_sha256 -cne $env:DIAGNOSTIC_NODE_SHA -or $prepared.root -cne $expectedRoot -or $prepared.prepared_source -cne $expectedSource -or
    $prepared.node -cne $expectedNode -or $prepared.runner_temp -cne $expectedTemp -or $prepared.shared_cache -cne (Join-Path $expectedRoot 'cache') -or
    $prepared.node_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $prepared.controller_sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Original prepared diagnostic closure identity differs'}
$privatePreparation=Read-LaunchBytes (Join-Path $expectedRoot 'preparation.json') 65536
$publicPreparation=Read-LaunchBytes (Join-Path $workspace 'work/hosted-continuity-evidence/windows-diagnostic-preparation.json') 65536
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($privatePreparation)) -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($publicPreparation))){throw 'Retained protected preparation differs from public locator'}
$readerSource=$utf8.GetString((Read-LaunchBytes (Join-Path $expectedRoot 'tools/scripts/release-native-runtime-custody-reader.ps1') 16384))
if($prepared.imports -isnot [Array] -or $prepared.imports.Count -lt 1 -or $prepared.imports.Count -gt 512){throw 'Bounded prepared import closure required'}
$importFiles=[Collections.Generic.List[string]]::new()
$seenImports=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($member in $prepared.imports){
    if((@($member.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'bytes,path,sha256' -or $member.path -isnot [string] -or $member.path.Length -gt 4096 -or
        $member.sha256 -cnotmatch '^[a-f0-9]{64}$' -or ($member.bytes -isnot [long] -and $member.bytes -isnot [int]) -or $member.bytes -lt 0 -or $member.bytes -gt 134217728){throw 'Fixed prepared import member differs'}
    $filename=[IO.Path]::GetFullPath((Join-Path $expectedSource $member.path))
    if(-not $filename.StartsWith($expectedSource+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal) -or -not $seenImports.Add($filename)){throw 'Prepared import member escapes or aliases source'}
    $importFiles.Add($filename)
}
$yaml=$prepared.yaml_link
if($null -eq $yaml -or (@($yaml.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'identity,kind,path,resolved,target' -or
    $yaml.kind -cne 'link' -or $yaml.path -cne 'node_modules\yaml' -or $yaml.resolved -isnot [string] -or
    $prepared.yaml_link_native_identity -cnotmatch '^[a-f0-9]{8}(:[a-f0-9]{8}){4}$'){throw 'Original prepared dependency resolution record required'}
$yamlPath=Join-Path $expectedSource $yaml.path
$yamlTarget=[IO.Path]::GetFullPath((Join-Path $expectedSource $yaml.resolved))
if(-not $yamlTarget.StartsWith($expectedSource+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal) -or
    [Portcove.HostedNative.Setup]::LinkIdentity($yamlPath) -cne $prepared.yaml_link_native_identity -or
    ([IO.DirectoryInfo]::new($yamlPath)).ResolveLinkTarget($true).FullName -cne $yamlTarget){throw 'Original dependency link generation or resolution changed'}
$allInputs=@($expectedNode,(Join-Path $expectedSource 'scripts/release-hosted-native-windows-diagnostic.mts'),(Join-Path $expectedRoot 'preparation.json'),(Join-Path $expectedRoot 'tools/scripts/release-native-runtime-custody-reader.ps1'))+@($importFiles)
$observedCustody=@{}
for($offset=0;$offset -lt $allInputs.Count;$offset+=64){
    $inventory=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach($filename in $allInputs[$offset..([Math]::Min($allInputs.Count-1,$offset+63))]){
        $cursor=$filename;$depth=0
        while($true){
            if(++$depth -gt 64 -or $inventory.Count -ge 4096){throw 'Prepared custody ancestry bound exceeded'}
            $file=$cursor -ceq $filename
            if($inventory.ContainsKey($cursor)){if($inventory[$cursor].file -ne $file){throw 'Prepared custody file/directory alias'};break}
            if($file){$held=[IO.FileStream]::new($cursor,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Portcove.HostedNative.Setup]::SingleLinkFile($held.SafeFileHandle)}finally{$held.Dispose()}}
            $inventory.Add($cursor,@{path=$cursor;file=$file})
            $parent=[IO.Path]::GetDirectoryName($cursor)
            if(-not $parent -or $parent -ceq $cursor){break};$cursor=$parent
        }
    }
    $inputJson=ConvertTo-Json -InputObject @($inventory.Values) -Compress -Depth 4
    $readerBudget=[Math]::Min(15000,$originalStartupMaximumMilliseconds-$originalStartupClock.ElapsedMilliseconds-5000)
    if($readerBudget -lt 1){throw 'Original pre-import metadata/startup window exhausted'}
    $custody=[Portcove.HostedNative.Setup]::ReadCustody($readerSource,$inputJson,$env:RUNNER_TRACKING_ID,[int]$readerBudget)|ConvertFrom-Json
    if($custody.schema_version -ne 1 -or $custody.rows.Count -ne $inventory.Count){throw 'Complete prepared custody readback required'}
    $returnedPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach($row in $custody.rows){
        if(-not $inventory.ContainsKey($row.path) -or -not $returnedPaths.Add($row.path)){throw 'Prepared custody path substitution or duplicate'}
        $identity=$row.owner+'|'+$row.sddl
        if($observedCustody.ContainsKey($row.path) -and $observedCustody[$row.path] -cne $identity){throw 'Prepared custody changed between bounded batches'}
        $observedCustody[$row.path]=$identity
    }
}
foreach($member in $prepared.imports){
    $raw=Read-LaunchBytes ([IO.Path]::GetFullPath((Join-Path $expectedSource $member.path))) ([Math]::Max(1,$member.bytes)) ($member.bytes -eq 0)
    if($raw.Length -ne $member.bytes -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant() -cne $member.sha256){throw 'Prepared imported bytes changed'}
}
if([Portcove.HostedNative.Setup]::LinkIdentity($yamlPath) -cne $prepared.yaml_link_native_identity -or
    ([IO.DirectoryInfo]::new($yamlPath)).ResolveLinkTarget($true).FullName -cne $yamlTarget){throw 'Original dependency resolution changed during custody readback'}
$nodeBytes=Read-LaunchBytes $expectedNode 134217728
$entryBytes=Read-LaunchBytes (Join-Path $expectedSource 'scripts/release-hosted-native-windows-diagnostic.mts') 131072
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($nodeBytes)).ToLowerInvariant() -cne $prepared.node_sha256 -or
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($entryBytes)).ToLowerInvariant() -cne $prepared.controller_sha256){throw 'Original prepared diagnostic runtime/source bytes changed'}
}catch{
    $preimportOriginal=$_
    try{
        $readerFailure=$null;$readerStatus=$null;$exception=$preimportOriginal.Exception
        for($depth=0;$depth -lt 4 -and $null -ne $exception;$depth++){
            if($exception.Data.Contains('closed_custody_reader')){
                try{$text=$exception.Data['closed_custody_reader'];if($text -is [string] -and $utf8.GetByteCount($text) -le 2048){$readerFailure=Select-ClosedCustodyReader ($text|ConvertFrom-Json)}}catch{$readerFailure=$null}
            }
            if($exception.Data.Contains('custody_reader_status')){$value=$exception.Data['custody_reader_status'];if($value -is [int] -and $value -ge 0){$readerStatus=$value}}
            $exception=$exception.InnerException
        }
        $name=$preimportOriginal.Exception.GetType().Name
        if($name -cnotin @('RuntimeException','MethodInvocationException','InvalidOperationException','Win32Exception','IOException','UnauthorizedAccessException')){$name='unclassified'}
        $message=$utf8.GetBytes($preimportOriginal.Exception.Message)
        $sourceLine=$null;if($null -ne $preimportOriginal.InvocationInfo){$sourceLine=$preimportOriginal.InvocationInfo.ScriptLineNumber}
        $record=@{schema_version=1;source=$env:GITHUB_SHA;tree=$actualTree;run_id=$env:GITHUB_RUN_ID;attempt=1;workflow=$env:GITHUB_WORKFLOW_REF;authority='none';automatic_retry=$false;phase='prepared-closure-before-original-controller';outcome='refused';controller_create_attempted=$false;error=@{name=$name;source_line=$sourceLine;message_bytes=$message.Length;message_sha256=$(if($message.Length -le 16384){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($message)).ToLowerInvariant()}else{$null});custody_reader=$readerFailure;custody_reader_status=$readerStatus};scope='pre-import metadata only; no original C launched by this operation'}
        $bytes=$utf8.GetBytes(($record|ConvertTo-Json -Depth 8 -Compress));if($bytes.Length -gt 16384){throw 'Public pre-import projection exceeds bound'}
        $sinkRoot=Join-Path $publicTemp 'portcove-hosted-windows-connected-diagnostic'
        [IO.Directory]::CreateDirectory($sinkRoot)|Out-Null
        $sink=[IO.FileStream]::new((Join-Path $sinkRoot 'controller-preimport-public.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$sink.Write($bytes);$sink.Flush($true)}finally{$sink.Dispose()}
    }catch{[Console]::Error.WriteLine('Bounded pre-import public retention unavailable; preserve original refusal')}
    throw $preimportOriginal
}
$node=$expectedNode;$source=$expectedSource
$env:RUNNER_TEMP=$expectedTemp
$env:PORTCOVE_SHARED_TOOL_CACHE=$prepared.shared_cache
$env:PATH=(Split-Path -Parent $node)+';C:\Windows\System32;C:\Program Files\Git\cmd;C:\Program Files\PowerShell\7'
function Copy-FixedPublicDiagnosticRecords {
    $copyRefused=$false
    foreach($row in @(
        @((Join-Path $expectedTemp 'portcove-hosted-windows-connected-diagnostic/controller-ready.json'),(Join-Path $publicTemp 'portcove-hosted-windows-connected-diagnostic/controller-ready.json'),16384),
        @((Join-Path $expectedTemp 'portcove-hosted-windows-connected-diagnostic/controller-startup-public.json'),(Join-Path $publicTemp 'portcove-hosted-windows-connected-diagnostic/controller-startup-public.json'),65536),
        @((Join-Path $source 'work/hosted-windows-connected-diagnostic/diagnostic-public-settlement.json'),(Join-Path $workspace 'work/hosted-windows-connected-diagnostic/diagnostic-public-settlement.json'),262144)
    )){
        try{
        if(-not (Test-Path -LiteralPath $row[0])){continue}
        $bytes=Read-LaunchBytes $row[0] $row[2]
        $value=$utf8.GetString($bytes)|ConvertFrom-Json
        if($value.source -cne $env:GITHUB_SHA -or $value.tree -cne $actualTree -or $value.run_id -cne $env:GITHUB_RUN_ID -or $value.attempt -ne 1 -or $value.workflow -cne $env:GITHUB_WORKFLOW_REF -or $value.authority -cne 'none'){throw 'Public diagnostic sink identity differs'}
        [IO.Directory]::CreateDirectory((Split-Path -Parent $row[1]))|Out-Null
        if(Test-Path -LiteralPath $row[1]){if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData((Read-LaunchBytes $row[1] $row[2]))) -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))){throw 'Retained public diagnostic sink differs'};continue}
        $sink=[IO.FileStream]::new($row[1],[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$sink.Write($bytes);$sink.Flush($true)}finally{$sink.Dispose()}
        if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData((Read-LaunchBytes $row[1] $row[2]))) -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))){throw 'Public diagnostic sink readback differs'}
        }catch{$copyRefused=$true}
    }
    if($copyRefused){throw 'One or more fixed public diagnostic records refused'}
}
$closed=[ordered]@{}
foreach($name in @('SystemRoot','WINDIR','PATH','PATHEXT','USERPROFILE','HOME','TEMP','TMP','LOCALAPPDATA','RUNNER_TEMP','RUNNER_TRACKING_ID','RUSTUP_HOME','CARGO_HOME','PORTCOVE_SHARED_TOOL_CACHE','PORTCOVE_RESOURCE_RESERVATION','PORTCOVE_RESOURCE_PROCESS_TOKEN','PORTCOVE_HEAVY_RUST_LOCK_TOKEN','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_JOB','GITHUB_WORKFLOW_REF','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_EVENT_NAME','PORTCOVE_HOSTED_PLATFORM','PORTCOVE_HOSTED_OBSERVATION_ONLY','PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC')){
    $value=[Environment]::GetEnvironmentVariable($name,'Process')
    if($null -ne $value){if($value.Length -gt 32768 -or $value.Contains([char]0)){throw 'Closed diagnostic environment differs'};$closed[$name]=$value}
}
foreach($name in @('SystemRoot','PATH','RUNNER_TEMP','RUNNER_TRACKING_ID')){if(-not $closed.Contains($name) -or -not $closed[$name]){throw 'Original provider tracking/runtime context missing'}}
$closed.NODE_NO_WARNINGS='1'
if($Operation -ceq 'Publish'){Copy-FixedPublicDiagnosticRecords;return}
if($Operation -cne 'Start'){
    $arguments=@((Join-Path $source 'scripts/release-hosted-native-windows-diagnostic.mts'),$Operation.ToLowerInvariant())
    if($Operation -ceq 'Request' -or $Operation -ceq 'Ack'){if(-not $Stage){throw 'Fixed diagnostic stage required'};$arguments+=@($Stage)}
    if($Operation -ceq 'Ack'){
        if($RequestHash -cnotmatch '^[a-f0-9]{64}$' -or $ArtifactId -cnotmatch '^[1-9][0-9]{0,15}$' -or $ArtifactDigest -cnotmatch '^[a-f0-9]{64}$'){throw 'Original diagnostic provider acknowledgement differs'}
        $arguments+=@($RequestHash,$ArtifactId,$ArtifactDigest)
    }
    $savedEnvironment=@{}
    foreach($item in Get-ChildItem Env:){$savedEnvironment[$item.Name]=$item.Value}
    try{
        foreach($item in Get-ChildItem Env:){[Environment]::SetEnvironmentVariable($item.Name,$null,'Process')}
        foreach($key in $closed.Keys){[Environment]::SetEnvironmentVariable($key,$closed[$key],'Process')}
        & $node @arguments
        if($LASTEXITCODE -ne 0){throw 'Original prepared diagnostic relay refused'}
    }finally{
        foreach($item in Get-ChildItem Env:){[Environment]::SetEnvironmentVariable($item.Name,$null,'Process')}
        foreach($key in $savedEnvironment.Keys){[Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process')}
        try{Copy-FixedPublicDiagnosticRecords}catch{[Console]::Error.WriteLine('Bounded public diagnostic sink copy unavailable; retain original relay outcome')}
    }
    return
}
$control=Join-Path $env:RUNNER_TEMP 'portcove-hosted-windows-connected-diagnostic'
$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[Portcove.HostedNative.Setup]::Directory($control,$broker,'',$false)
$environment=(@($closed.Keys|Sort-Object|ForEach-Object {$_+'='+$closed[$_]})-join "`0")+"`0`0"
$controllerTypeSource=@'
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
  public sealed class Observation {public bool Alive;public uint? ExitCode;}
  public Observation Observe(){FileTime created,exit,kernel,user;if(handle==IntPtr.Zero||GetProcessId(handle)!=(uint)Pid||!GetProcessTimes(handle,out created,out exit,out kernel,out user)||created.Value.ToString(CultureInfo.InvariantCulture)!=Created)throw new InvalidOperationException("Original controller handle/generation differs");uint wait=WaitForSingleObject(handle,0);if(wait==258)return new Observation{Alive=true,ExitCode=null};if(wait!=0)throw new Win32Exception(Marshal.GetLastWin32Error(),"Original controller wait observation failed");uint code;if(!GetExitCodeProcess(handle,out code))throw new Win32Exception(Marshal.GetLastWin32Error());return new Observation{Alive=false,ExitCode=code};}
  public bool Alive(){return Observe().Alive;}
  public bool StopOriginal(){bool active=Alive();if(active&&!TerminateProcess(handle,2))throw new Win32Exception(Marshal.GetLastWin32Error());if(WaitForSingleObject(handle,5000)!=0)throw new InvalidOperationException("Original controller startup cleanup unobserved");return active;}
  public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
 }
}
'@
function Read-StartupFailureProjection([object]$Original){
    $file=Join-Path $control 'controller-failure.json'
    if(-not (Test-Path -LiteralPath $file)){return @{status='missing'}}
    try{
        $raw=Read-LaunchBytes $file 16384;$value=$utf8.GetString($raw)|ConvertFrom-Json
        $keys=@($value.PSObject.Properties.Name|Sort-Object)
        if(($keys -join ',') -cne 'attempt,authority,automatic_retry,created_filetime,error,phase,pid,run_id,schema_version,source,tree,workflow' -or
            $value.schema_version -ne 1 -or $value.source -cne $env:GITHUB_SHA -or $value.run_id -cne $env:GITHUB_RUN_ID -or $value.attempt -ne 1 -or
            $value.workflow -cne $env:GITHUB_WORKFLOW_REF -or $value.authority -cne 'none' -or $value.automatic_retry -ne $false -or
            $null -eq $Original -or $value.pid -ne $Original.Pid -or $value.created_filetime -cne $Original.Created -or
            $value.tree -cne $actualTree -or
            $value.phase -cnotin @('module-loaded','source-gate-verified','inputs-verifying','provider-clock-verifying','publishing-ready','awaiting-start-ack','start-ack-verified')){return @{status='identity-or-schema-unverified'}}
        $e=$value.error
        if((@($e.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'code,custody,message_disposition,message_sha256,message_utf8_bytes,name,source_site' -or
            $e.name -cnotin @('Error','AssertionError','TypeError','RangeError','SyntaxError','unclassified') -or
            $e.code -cnotin @('ERR_ASSERTION','ERR_WINDOWS_CUSTODY_REFUSED','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_ARG_VALUE','ERR_INVALID_ARG_TYPE','ENOENT','EACCES','EPERM','EINVAL','ETIMEDOUT','unclassified') -or
            $e.message_disposition -cnotin @('unavailable','digest-only','oversize-not-retained') -or
            ($e.message_disposition -ceq 'digest-only' -and ($e.message_utf8_bytes -isnot [long] -and $e.message_utf8_bytes -isnot [int] -or $e.message_utf8_bytes -lt 0 -or $e.message_utf8_bytes -gt 16384 -or $e.message_sha256 -cnotmatch '^[a-f0-9]{64}$')) -or
            ($e.message_disposition -cne 'digest-only' -and $null -ne $e.message_sha256) -or
            ($e.message_disposition -ceq 'unavailable' -and $null -ne $e.message_utf8_bytes) -or
            ($e.message_disposition -ceq 'oversize-not-retained' -and (($e.message_utf8_bytes -isnot [long] -and $e.message_utf8_bytes -isnot [int]) -or $e.message_utf8_bytes -le 16384 -or $e.message_utf8_bytes -gt 2147483647))){return @{status='classification-unverified'}}
        $publicCustody=$null
        if($null -ne $e.custody){
            $c=$e.custody
            if((@($c.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'child_signal,child_status,reader,schema_version,spawn_code' -or
                $c.schema_version -ne 1 -or
                ($null -ne $c.child_status -and (($c.child_status -isnot [long] -and $c.child_status -isnot [int]) -or $c.child_status -lt 0 -or $c.child_status -gt 4294967295)) -or
                ($null -ne $c.child_signal -and $c.child_signal -cnotin @('SIGTERM','SIGKILL')) -or
                $c.spawn_code -cnotin @('unknown','ETIMEDOUT','ENOENT','EACCES','EPERM','ENOBUFS')){return @{status='custody-classification-unverified'}}
            $publicReader=$null
            if($null -ne $c.reader){
                $publicReader=Select-ClosedCustodyReader $c.reader
                if($null -eq $publicReader){return @{status='custody-classification-unverified'}}
            }
            $publicCustody=@{schema_version=1;child_status=$c.child_status;child_signal=$c.child_signal;spawn_code=$c.spawn_code;reader=$publicReader}
        }
        if($null -ne $e.source_site -and ((@($e.source_site.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'column,line,script' -or
            $e.source_site.script -cnotin @('diagnostic-controller','diagnostic-inputs','diagnostic-preparation','hosted-runtime-input','webview-driver','owner-mechanism','native-custody','controller-tools') -or
            ($e.source_site.line -isnot [long] -and $e.source_site.line -isnot [int]) -or $e.source_site.line -lt 1 -or $e.source_site.line -gt 9999999 -or
            ($e.source_site.column -isnot [long] -and $e.source_site.column -isnot [int]) -or $e.source_site.column -lt 1 -or $e.source_site.column -gt 99999)){return @{status='source-site-unverified'}}
        return @{status='retained';bytes=$raw.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant();phase=$value.phase;error=@{custody=$publicCustody;source_site=$(if($null -ne $e.source_site){@{script=$e.source_site.script;line=$e.source_site.line;column=$e.source_site.column}}else{$null});name=$e.name;code=$e.code;message_disposition=$e.message_disposition;message_utf8_bytes=$e.message_utf8_bytes;message_sha256=$e.message_sha256}}
    }catch{return @{status='unreadable-invalid-or-oversize'}}
}
$launch=$null;$createProcessAttempted=$false;$ackPublicationAttempted=$false;$ackDurablyWritten=$false;$readyVerified=$false;$readyBytes=$null
$clock=$originalStartupClock;$startupPhase='controller-type';$outcome='refused';$originalObservation=$null;$originalObservationAttempted=$false;$settledObservation=$null;$cleanup='not-requested';$cleanupTerminationRequested=$null;$original=$null
try{
    Add-Type -TypeDefinition $controllerTypeSource
    if($clock.ElapsedMilliseconds -ge $originalStartupMaximumMilliseconds){throw 'Original controller startup window exhausted before launch'}
    $startupPhase='create-original-controller'
    $createProcessAttempted=$true
    $launch=[Portcove.Diagnostic.OriginalController]::Start($node,$source,$environment)
    $startupPhase='awaiting-ready';$readyPath=Join-Path $control 'controller-ready.json'
    while($null -eq $readyBytes){
        if($clock.ElapsedMilliseconds -ge $originalStartupMaximumMilliseconds -or -not $launch.Alive()){throw 'Original controller startup/source preflight failed or expired'}
        try{if(Test-Path -LiteralPath $readyPath){$readyBytes=Read-LaunchBytes $readyPath 16384}}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -notin @(32,33)){throw}}
        if($null -eq $readyBytes){Start-Sleep -Milliseconds 100}
    }
    $ready=$utf8.GetString($readyBytes)|ConvertFrom-Json
    if($ready.schema_version -ne 1 -or $ready.pid -ne $launch.Pid -or $ready.created_filetime -cne $launch.Created -or
        $ready.source -cne $env:GITHUB_SHA -or $ready.tree -cne $actualTree -or $ready.run_id -cne $env:GITHUB_RUN_ID -or $ready.attempt -ne 1 -or
        $ready.workflow -cne $env:GITHUB_WORKFLOW_REF -or $ready.authority -cne 'none' -or -not $launch.Alive()){throw 'Original diagnostic startup receipt differs'}
    $readyVerified=$true;$startupPhase='ready-verified'
    $ack=[ordered]@{schema_version=1;pid=$launch.Pid;created_filetime=$launch.Created;ready_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($readyBytes)).ToLowerInvariant()}
    $startupPhase='ack-publication';$ackPublicationAttempted=$true
    $bytes=$utf8.GetBytes(($ack|ConvertTo-Json -Compress));$stream=[IO.FileStream]::new((Join-Path $control 'controller-start-ack.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes);$stream.Flush($true);$ackDurablyWritten=$true}finally{$stream.Dispose()}
    $startupPhase='ack-durable';$outcome='acknowledged'
    [ordered]@{source=$env:GITHUB_SHA;run_id=$env:GITHUB_RUN_ID;attempt=1;pid=$launch.Pid;created_filetime=$launch.Created;phase='original controller acknowledged; connected effects remain separately gated';authority='none'}|ConvertTo-Json -Compress
}catch{
    $original=$_
    if($createProcessAttempted -and $null -eq $launch){$cleanup='Unknown-before-original-handle-returned'}
    if($launch){$originalObservationAttempted=$true;try{$originalObservation=$launch.Observe()}catch{$originalObservation=$null}}
    if($launch -and -not $ackPublicationAttempted){try{$cleanupTerminationRequested=$launch.StopOriginal();$settledObservation=$launch.Observe();$cleanup='original-process-exit-observed'}catch{$cleanup='Unknown';[Console]::Error.WriteLine('Original controller startup cleanup remains Unknown; retain provider generation evidence')}}
    elseif($launch){
        $cleanup='original-abort-request-attempted'
        # A flushed acknowledgement may already have enabled the original owner.
        # Retain that controller for its one exact recovery instead of killing it.
        try{$bytes=$utf8.GetBytes((@{pid=$launch.Pid;created_filetime=$launch.Created;source=$env:GITHUB_SHA;run_id=$env:GITHUB_RUN_ID;authority='none'}|ConvertTo-Json -Compress));$abort=[IO.FileStream]::new((Join-Path $control 'abort-request.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$abort.Write($bytes);$abort.Flush($true)}finally{$abort.Dispose()}}catch{[Console]::Error.WriteLine('Original controller abort request unavailable; retain its bounded deadline and provider cleanup')}
    }
    throw $original
}finally{
    try{
        if($launch -and -not $originalObservationAttempted){$originalObservationAttempted=$true;try{$originalObservation=$launch.Observe()}catch{$originalObservation=$null}}
        $launcherFailure=$null
        if($null -ne $original){
            $name=$original.Exception.GetType().Name;if($name -cnotin @('RuntimeException','MethodInvocationException','InvalidOperationException','Win32Exception','IOException','UnauthorizedAccessException')){$name='unclassified'}
            $nativeError=$null;$exception=$original.Exception
            for($depth=0;$depth -lt 3 -and $null -ne $exception;$depth++){if($exception -is [ComponentModel.Win32Exception]){$nativeError=$exception.NativeErrorCode;break};$exception=$exception.InnerException}
            $line=$null;if($null -ne $original.InvocationInfo){$line=$original.InvocationInfo.ScriptLineNumber}
            $launcherFailure=@{name=$name;hresult=$original.Exception.HResult;native_error_code=$nativeError;source_line=$line}
        }
        $public=[ordered]@{schema_version=1;source=$env:GITHUB_SHA;tree=$actualTree;run_id=$env:GITHUB_RUN_ID;attempt=1;workflow=$env:GITHUB_WORKFLOW_REF;authority='none';automatic_retry=$false;phase=$startupPhase;outcome=$outcome;create_process_attempted=$createProcessAttempted;controller_handle_returned=($null -ne $launch);elapsed_milliseconds=$clock.ElapsedMilliseconds;ready_verified=$readyVerified;ready_sha256=$(if($readyBytes){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($readyBytes)).ToLowerInvariant()}else{$null});ack_publication_attempted=$ackPublicationAttempted;ack_durably_written=$ackDurablyWritten;controller=$(if($launch){@{pid=$launch.Pid;created_filetime=$launch.Created;original_observation=$originalObservation;settled_observation=$settledObservation}}else{$null});cleanup=$cleanup;cleanup_termination_requested=$cleanupTerminationRequested;launcher_failure=$launcherFailure;controller_failure=(Read-StartupFailureProjection $launch);scope='original diagnostic startup observations only; not private account or production acceptance'}
        $bytes=$utf8.GetBytes(($public|ConvertTo-Json -Depth 10 -Compress));if($bytes.Length -lt 1 -or $bytes.Length -gt 65536){throw 'Public startup projection exceeds bound'}
        $file=[IO.FileStream]::new((Join-Path $control 'controller-startup-public.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
    }catch{[Console]::Error.WriteLine('Bounded original startup public retention unavailable; no replacement of original failure')}
    finally{try{Copy-FixedPublicDiagnosticRecords}catch{[Console]::Error.WriteLine('Bounded public diagnostic sink copy unavailable')};if($launch){$launch.Dispose()}}
}
