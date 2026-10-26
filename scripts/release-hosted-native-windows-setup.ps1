param([Parameter(Mandatory)][string]$ContextBase64)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Read-HostedNativeSetupContext([string]$Encoded) {
    if($Encoded.Length -gt 8192){throw 'Hosted setup context exceeds bound'}
    $value=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($Encoded))|ConvertFrom-Json
    if(($value.PSObject.Properties.Name|Sort-Object)-join ',' -cne 'binding,broker_created_ticks,broker_pid,run_attempt,run_id,schema_version,source_commit,source_tree' -or
        $value.schema_version -isnot [long] -or $value.schema_version -ne 1 -or $value.binding -cnotmatch '^[a-f0-9]{64}$' -or
        $value.source_commit -cnotmatch '^[a-f0-9]{40}$' -or $value.source_tree -cnotmatch '^[a-f0-9]{40}$' -or
        $value.run_id -cnotmatch '^[1-9][0-9]{0,19}$' -or $value.run_attempt -isnot [long] -or $value.run_attempt -ne 1 -or
        $value.broker_pid -isnot [long] -or $value.broker_pid -lt 1 -or $value.broker_pid -gt 4294967295 -or
        $value.broker_created_ticks -cnotmatch '^[1-9][0-9]{0,19}$'){throw 'Fixed hosted setup context differs'}
    return $value
}
function Write-HostedNativeSetupRecord([string]$Path,$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress))
    if($bytes.Length -gt 65536){throw 'Hosted setup record exceeds bound'}
    $file=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Read-HostedNativeProbeStream($Stream) {
    $bytes=$Stream.Snapshot()
    return [ordered]@{bytes=$bytes.Length;prefix_base64=[Convert]::ToBase64String($bytes,0,[Math]::Min($bytes.Length,16384));truncated=($bytes.Length -gt 16384)}
}
function Read-HostedStartupThreads($Startup) {
    $Startup.RequireAliveGeneration()
    $threads=@(Get-CimInstance Win32_Thread -Filter ("ProcessHandle = '"+$Startup.Pid+"'") -Property Handle,ProcessHandle,ThreadState,ThreadWaitReason,KernelModeTime,UserModeTime,StartAddress -OperationTimeoutSec 5 -ErrorAction Stop|Select-Object -First 65)
    if($threads.Count -gt 64 -or @($threads|Where-Object ProcessHandle -NE ([string]$Startup.Pid)).Count){throw 'Startup thread diagnostic inventory outside bound or root'}
    $Startup.RequireAliveGeneration()
    return @($threads|ForEach-Object {[ordered]@{thread_id=$_.Handle;state=$_.ThreadState;wait_reason=$_.ThreadWaitReason;kernel_time=$_.KernelModeTime;user_time=$_.UserModeTime;start_address=$_.StartAddress}})
}
function Read-HostedStartupPopup($Startup) {
    $Startup.RequireAliveGeneration()
    $since=[DateTime]::FromFileTimeUtc($Startup.CreatedFileTime).AddSeconds(-1)
    $until=[DateTime]::UtcNow.AddSeconds(1)
    $stamp=$since.ToString('yyyyMMddHHmmss.ffffff',[Globalization.CultureInfo]::InvariantCulture)+'+000'
    $endStamp=$until.ToString('yyyyMMddHHmmss.ffffff',[Globalization.CultureInfo]::InvariantCulture)+'+000'
    $filter="Logfile = 'System' AND SourceName = 'Application Popup' AND EventCode = 26 AND TimeGenerated >= '"+$stamp+"' AND TimeGenerated <= '"+$endStamp+"' AND Message LIKE '%powershell.exe%'"
    $events=@(Get-CimInstance Win32_NTLogEvent -Filter $filter -Property Logfile,RecordNumber,TimeGenerated,EventCode,SourceName,Message -OperationTimeoutSec 5 -ErrorAction Stop|Select-Object -First 9)
    if($events.Count -gt 8 -or @($events|Where-Object {$_.Logfile -ine 'System' -or $_.EventCode -ne 26 -or $_.SourceName -ine 'Application Popup' -or $_.Message -notmatch '(?i)(?<![A-Za-z0-9_.-])powershell[.]exe(?![A-Za-z0-9_.-])' -or $_.TimeGenerated.ToUniversalTime() -lt $since -or $_.TimeGenerated.ToUniversalTime() -gt $until}).Count){throw 'Startup popup records exceed bound or correlation scope'}
    $Startup.RequireAliveGeneration()
    $observed=@($events|ForEach-Object {
        $text=$_.Message.Substring(0,[Math]::Min(1024,$_.Message.Length))
        while([Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $text -Compress)) -gt 4096){$text=$text.Substring(0,[int]($text.Length/2))}
        [ordered]@{record_number=$_.RecordNumber;time_generated=$_.TimeGenerated.ToUniversalTime().ToString('o');message=$text;message_truncated=($text.Length -lt $_.Message.Length)}
    })
    $result=[ordered]@{status=$(if($events.Count){'read'}else{'queried_none'});since=$since.ToString('o');until=$until.ToString('o');correlation='same executable/time only; not exact PID attribution';events=$observed}
    if([Text.Encoding]::UTF8.GetByteCount(($result|ConvertTo-Json -Depth 6 -Compress)) -gt 49152){throw 'Startup popup exported JSON exceeds bound'}
    return $result
}
function Write-HostedAuditRecovery($Root,$Context) {
    $capture=Join-Path $Root 'capture'
    foreach($index in 0..3){foreach($phase in @('before','proposed','observed','restored')){
        $file=Join-Path $capture ("audit-$index-$phase.bin")
        if(Test-Path -LiteralPath $file){
            if((Get-Item -LiteralPath $file).Length -gt 16384){throw 'Audit recovery descriptor exceeds bound'}
            Write-HostedNativeSetupRecord (Join-Path $capture ("audit-$index-$phase.json")) ([ordered]@{context=$Context;object_index=$index;phase=$phase;full_descriptor_base64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file));scope='exact full SACL/MIC recovery preimage/postimage; no GUI acceptance'})
        }
    }}
    $state=[ordered]@{context=$Context;scope='exact audit policy/privilege recovery; no GUI acceptance'}
    foreach($name in @('bindings','control-WindowStation','control-Desktop','control-WindowStation-prepared','control-WindowStation-denied','control-Desktop-prepared','control-Desktop-denied','policy-before','policy-proposed','policy-observed','policy-recovery-before','policy-restore-command','policy-recovery-observed','policy-restored','privilege-before','privilege-before-launch','privilege-restored')){
        $file=Join-Path $capture ("audit-$name.bin")
        if(Test-Path -LiteralPath $file){if((Get-Item -LiteralPath $file).Length -gt $(if($name -ceq 'bindings' -or $name.StartsWith('control-')){4096}else{128})){throw 'Audit state preimage exceeds bound'};$state[$name]=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file))}
    }
    if($state.Count -gt 2){Write-HostedNativeSetupRecord (Join-Path $capture 'audit-state.json') $state}
}

function Assert-HostedNativeAccount($Expected,[bool]$Enabled) {
    $actual=Get-LocalUser -SID $Expected.SID -ErrorAction Stop
    if($actual.Name -cne 'PortcoveNativeQual' -or $actual.SID.Value -cne $Expected.SID.Value -or
        $actual.Description -cne $Expected.Description -or $actual.Enabled -ne $Enabled -or
        $actual.UserMayChangePassword -or $actual.PasswordExpires -or $actual.AccountExpires){throw 'Hosted account identity or policy differs'}
    $groups=@(Get-LocalGroup|ForEach-Object {
        $group=$_
        if(@(Get-LocalGroupMember -SID $group.SID -ErrorAction Stop|Where-Object {$_.SID.Value -ceq $Expected.SID.Value}).Count){$group.SID.Value}
    })
    if(($groups|Sort-Object)-join ',' -cne 'S-1-5-32-545'){throw 'Hosted candidate must have exactly ordinary Users membership'}
}

$context=Read-HostedNativeSetupContext $ContextBase64
$diagnosticRef=($env:GITHUB_EVENT_NAME -ceq 'pull_request' -and
    $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/\.github/workflows/controller-tool-build-fixture\.yml@refs/pull/[1-9][0-9]*/merge$') -or
    ($env:GITHUB_EVENT_NAME -ceq 'push' -and $env:GITHUB_WORKFLOW_REF -ceq 'boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/heads/main')
if(-not $IsWindows -or $PSVersionTable.PSVersion.Major -ne 7 -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $diagnosticRef -or
    $env:GITHUB_RUN_ID -cne $context.run_id -or $env:GITHUB_RUN_ATTEMPT -cne '1'){
    throw 'Only the fixed credential-free hosted tool diagnostic may prepare this account'
}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($owner)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Hosted runner lacks required account-setup capability; no elevation or retry'
}
$clock=[Diagnostics.Stopwatch]::StartNew()
function Assert-OriginalHostedSetup {
    $parent=Get-Process -Id $context.broker_pid -ErrorAction Stop
    try{
        if($parent.HasExited -or (Get-CimInstance Win32_Process -Filter ('ProcessId = '+$context.broker_pid) -OperationTimeoutSec 5 -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks.ToString() -cne $context.broker_created_ticks -or
            $clock.Elapsed.TotalSeconds -ge 120){throw 'Original hosted setup parent or lifetime unavailable'}
    }finally{$parent.Dispose()}
}
Assert-OriginalHostedSetup
$tools=Split-Path -Parent $PSScriptRoot
$manifest=Get-Content -LiteralPath (Join-Path $tools 'native-account-source.json') -Raw|ConvertFrom-Json
if(($manifest.PSObject.Properties.Name|Sort-Object)-join ',' -cne 'files,platform,purpose,schema_version,source_commit,source_tree' -or $manifest.schema_version -isnot [long] -or $manifest.schema_version -ne 1 -or $manifest.purpose -cne 'ordinary-hosted-account-source' -or $manifest.files.Count -ne 6 -or $manifest.source_commit -cne $context.source_commit -or $manifest.source_tree -cne $context.source_tree -or
    $manifest.platform -cne 'windows-x86_64'){throw 'Original Windows primitive source differs'}
$names=@('scripts/release-hosted-native-windows-setup.ps1','scripts/release-hosted-native-windows-setup.cs.txt',
    'scripts/native-qualification-account.cs.txt','scripts/native-qualification-account-registry.ps1','scripts/fixtures/native-account-gui-probe.ps1','scripts/release-hosted-native-windows-audit.cs.txt')
foreach($name in $names){
    $entry=@($manifest.files|Where-Object path -CEQ $name)
    $file=Join-Path $tools $name
    if($entry.Count -ne 1 -or $entry[0].path -isnot [string] -or $entry[0].bytes -isnot [long] -or $entry[0].bytes -lt 1 -or $entry[0].bytes -gt 131072 -or $entry[0].sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-Item -LiteralPath $file).Length -ne $entry[0].bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[0].sha256){throw 'Fixed hosted setup source changed'}
}
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-hosted-native-windows-setup.cs.txt') -Raw)
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-qualification-account.cs.txt') -Raw)
Add-Type -AssemblyName System.Diagnostics.EventLog
$auditReferences=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+[System.Diagnostics.Eventing.Reader.EventLogReader].Assembly.Location
if($auditReferences.Count -gt 256){throw 'Audit compiler reference inventory exceeds bound'}
Add-Type -ReferencedAssemblies $auditReferences -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-hosted-native-windows-audit.cs.txt') -Raw)
if($env:SystemRoot -ine [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) -or $env:SystemDrive -ine 'C:'){
    throw 'Fixed hosted Windows system paths differ'
}
if(-not [Portcove.HostedNative.HostedDesktop]::ExecutionAuthorized){throw 'Hosted WinSta0 proposal awaits owner authority; no account or station effects'}
$root='C:\ProgramData\PortcoveHostedNativeQualification'
$nativeProfile='C:\Users\PortcoveNativeQual'
if(@(Get-LocalUser|Where-Object Name -IEQ 'PortcoveNativeQual').Count -or (Test-Path -LiteralPath $nativeProfile) -or
    @(Get-CimInstance Win32_UserProfile -ErrorAction Stop|Where-Object {$_.LocalPath -ieq $nativeProfile}).Count){throw 'Existing hosted account/profile is retained; no adoption'}
Assert-OriginalHostedSetup
[Portcove.HostedNative.Setup]::Directory($root,$owner.User.Value,$null,$false)
Assert-OriginalHostedSetup
Write-HostedNativeSetupRecord (Join-Path $root 'intent.json') ([ordered]@{schema_version=1;context=$context;broker_sid=$owner.User.Value;account_name='PortcoveNativeQual';automatic_retry=$false;authority='none'})
$audit=$null;$account=$null;$password=$null;$group=$null;$child=$null;$disabled=$false;$settled=$false;$failure=$null;$observation=$null
$actualProfile=$null;$registeredProfile=$null;$remaining=$null;$rootExited=$null
$cleanupFailures=[Collections.Generic.List[string]]::new()
$probeCapture=$null;$hostedDesktop=$null;$stationRestored=$null;$observerDrained=$null
try {
    Assert-OriginalHostedSetup
    $password=[Portcove.HostedNative.Setup]::Password()
    $description='PC534-hosted:'+$context.binding.Substring(0,32)
    $account=New-LocalUser -Name 'PortcoveNativeQual' -Password $password -Description $description -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Disabled
    Write-HostedNativeSetupRecord (Join-Path $root 'account-created.json') ([ordered]@{context=$context;sid=$account.SID.Value;name=$account.Name;description=$description;enabled=$false;credential='memory-only SecureString; never persisted';authority='none'})
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $account
    Assert-HostedNativeAccount $account $false
    Assert-OriginalHostedSetup
    $actualProfile=[Portcove.HostedNative.Setup]::Profile($account.SID.Value)
    if($actualProfile -ine $nativeProfile){throw 'Actual hosted profile differs; preserve registered partial state'}
    $registeredProfile=Get-ItemPropertyValue -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$account.SID.Value) -Name ProfileImagePath
    if([Environment]::ExpandEnvironmentVariables($registeredProfile) -ine $nativeProfile){throw 'Hosted profile registration differs'}
    $work=Join-Path $root 'work';$capture=Join-Path $root 'capture'
    [Portcove.HostedNative.Setup]::Directory($work,$owner.User.Value,$account.SID.Value,$true)
    $attemptWork=Join-Path $work $context.binding
    [Portcove.HostedNative.Setup]::Directory($attemptWork,$owner.User.Value,$account.SID.Value,$true)
    $roaming=Join-Path $attemptWork 'roaming';$local=Join-Path $attemptWork 'local'
    [Portcove.HostedNative.Setup]::Directory($roaming,$owner.User.Value,$account.SID.Value,$true)
    [Portcove.HostedNative.Setup]::Directory($local,$owner.User.Value,$account.SID.Value,$true)
    [Portcove.HostedNative.Setup]::Directory($capture,$owner.User.Value,$null,$false)
    # Grant traversal only on this fresh root, without inheritance into capture.
    $acl=Get-Acl -LiteralPath $root
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root),$acl)
    $source=Join-Path $root 'controller';[Portcove.HostedNative.Setup]::Directory($source,$owner.User.Value,$account.SID.Value,$false)
    New-Item -ItemType Directory -Path (Join-Path $source 'scripts\fixtures')|Out-Null
    foreach($name in @('scripts/native-qualification-account-registry.ps1','scripts/fixtures/native-account-gui-probe.ps1')){
        Copy-Item -LiteralPath (Join-Path $tools $name) -Destination (Join-Path $source $name)
        if((Get-FileHash -LiteralPath (Join-Path $source $name)).Hash -cne (Get-FileHash -LiteralPath (Join-Path $tools $name)).Hash){throw 'Hosted inert source copy differs'}
    }
    $runtime=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $signature=Get-AuthenticodeSignature -LiteralPath $runtime
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)'){throw 'Fixed Windows PowerShell lacks valid Microsoft signature'}
    $runtimeSha=(Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant()
    $configuration=[Portcove.NativeQualification.AccountConfiguration]::new()
    $configuration.UserName=$account.Name;$configuration.AccountSid=$account.SID.Value;$configuration.BrokerSid=$owner.User.Value
    $configuration.ProfileRoot=$nativeProfile;$configuration.WorkRoot=$work;$configuration.PrivateDesktop='PortcoveNative_'+$context.binding.Substring(0,32)+'\Qualification'
    $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($entry in @{SystemRoot=$env:SystemRoot;WINDIR=$env:SystemRoot;PATH=(Join-Path $env:SystemRoot 'System32');USERPROFILE=$nativeProfile;HOMEDRIVE=$env:SystemDrive;HOMEPATH='\Users\PortcoveNativeQual';APPDATA=$roaming;LOCALAPPDATA=$local;TEMP=$attemptWork;TMP=$attemptWork}.GetEnumerator()){$environment[$entry.Key]=$entry.Value}
    Assert-OriginalHostedSetup
    Enable-LocalUser -SID $account.SID
    Assert-HostedNativeAccount $account $true
    $hostedDesktop=[Portcove.HostedNative.HostedDesktop]::Prepare($owner.User.Value,$account.SID.Value,$capture)
    $labelObservation=$null;$labelFailure=$null;$brokerToken=$null;$brokerFailure=$null
    try{$labelObservation=$hostedDesktop.ObserveMandatoryLabels()}catch{$labelFailure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))}
    try{$brokerToken=[Portcove.NativeQualification.AccountLauncher]::ObserveBrokerToken()}catch{$brokerFailure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))}
    Write-HostedNativeSetupRecord (Join-Path $capture 'security-before-launch.json') ([ordered]@{context=$context;labels=$labelObservation;label_query_failure=$labelFailure;broker_token=$brokerToken;broker_token_status=$(if($brokerFailure){'unknown'}else{'read'});broker_query_failure=$brokerFailure;scope='read-only mandatory-label/token diagnostics; no GUI acceptance';authority='none'})
    if($labelFailure -or $brokerFailure -or $labelObservation.station_status -cne 'read' -or $labelObservation.desktop_status -cne 'read'){throw 'Mandatory security diagnostics unavailable; retained observations remain Unknown'}
    # The finite privileged-audit grant is consumed; ordinary GUI qualification does not audit.
    $group=[Portcove.NativeQualification.AccountLauncher]::CreateGroup($configuration)
    Assert-OriginalHostedSetup
    $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $source 'scripts\fixtures\native-account-gui-probe.ps1'),'-Invocation',$context.binding)
    $child=[Portcove.NativeQualification.AccountLauncher]::StartHostedVerifiedInGroup($group,$configuration,$password,$runtime,$runtimeSha,$arguments,$attemptWork,$environment,$hostedDesktop.Name)
    Write-HostedNativeSetupRecord (Join-Path $capture 'startup-token.json') ([ordered]@{context=$context;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();status='read';runtime_path=$runtime;runtime_sha256=$runtimeSha;job_admission=$group.LastLaunchInspection;token=$child.HostedTokenObservation;scope='required fixed PowerShell form root; suspended token QUERY-only snapshot before resume';authority='none'})
    $gui=$false
    while(-not $child.HasExited -and $clock.Elapsed.TotalSeconds -lt 110){
        Assert-OriginalHostedSetup
        $child.RefuseFaultedCapture()
        $hostedDesktop.AssertNonInput()
        if($child.HostedResponding){$gui=$true;break}
        Start-Sleep -Milliseconds 100
    }
    if(-not $gui){throw 'Actual private-desktop inert GUI unavailable'}
    do {
        Assert-OriginalHostedSetup
        $child.RefuseFaultedCapture()
        $snapshot=$child.OutputCapture.Snapshot()
        if($snapshot.Length -gt 65536){throw 'Hosted inert output exceeds bound'}
        if($snapshot.Length -and $snapshot[$snapshot.Length-1] -eq 10){break}
        if($child.HasExited -or $clock.Elapsed.TotalSeconds -ge 110){throw 'Hosted inert stdout incomplete'}
        Start-Sleep -Milliseconds 25
    } while($true)
    if($snapshot.Length -gt 65536){throw 'Hosted inert output exceeds bound'}
    $observation=[Text.UTF8Encoding]::new($false,$true).GetString($snapshot)|ConvertFrom-Json
    if($observation.account_sid -cne $account.SID.Value -or $observation.pid -ne $child.Pid -or $observation.profile -ine $nativeProfile -or
        $observation.invocation -cne $context.binding -or $observation.registry.hive_present -ne $true -or $observation.registry.provenance -cne 'target-account-HKCU'){
        throw 'Actual isolated profile/HKCU observation differs'
    }
    $members=@($child.SnapshotOwnedJob())
    if(@($members|Where-Object Pid -EQ $observation.child_pid).Count -ne 1){throw 'Inert descendant absent from original job'}
    Write-HostedNativeSetupRecord (Join-Path $capture 'observed.json') ([ordered]@{context=$context;observation=$observation;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();members=$members;hosted_desktop=$hostedDesktop.Name;private_gui=$gui;runtime_sha256=$runtimeSha;authority='none'})
} catch {
    $primaryError=$_
    $failure=$_.Exception.Message
    if(-not $hostedDesktop){$stationRestored=[Portcove.HostedNative.HostedDesktop]::FailedPreparationRestored}
    if($group -and -not $child){
        try{Write-HostedNativeSetupRecord (Join-Path $capture 'startup-token.json') ([ordered]@{context=$context;status='unknown';token=$null;query_failure=$failure.Substring(0,[Math]::Min(1024,$failure.Length));scope='launch or token query failed before observation returned; no inferred label or root state';authority='none'})}catch{$cleanupFailures.Add('Startup token retention failed: '+$_.Exception.Message)}
    }
    foreach($problem in [Portcove.HostedNative.AccessAudit]::LastPreparationRecoveryFailures){$cleanupFailures.Add('Audit preparation recovery: '+$problem)}
    if($child){
        $auditRecord=[ordered]@{context=$context;status='not_attempted';reason='Finite privileged-audit grant consumed; no audit operations'}
        if($audit){try{$child.RequireAliveGeneration();$events=@($audit.Observe($child.Pid,$child.CreatedFileTime,$runtime,$child.HostedTokenObservation.AuthenticationId));$child.RequireAliveGeneration();$auditRecord=[ordered]@{context=$context;root_pid=$child.Pid;created_filetime=$child.CreatedFileTime.ToString();events=$events;scope='exact root/SID/logon/object/time requested-access failures only; not initialization cause or GUI acceptance'}}catch{$auditRecord=[ordered]@{context=$context;status='unknown';failure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))}}}
        try{Write-HostedNativeSetupRecord (Join-Path $capture 'access-audit.json') $auditRecord}catch{$cleanupFailures.Add('Audit diagnostic retention failed: '+$_.Exception.Message)}
        try{$position=[Portcove.HostedNative.HostedStartupContext]::Observe($child.Handle,$child.HostedInitialThreadHandle,$child.Pid,$child.CreatedFileTime);Write-HostedNativeSetupRecord (Join-Path $capture 'startup-position.json') ([ordered]@{context=$context;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();position=$position;scope='temporary owned-thread suspension; mapped instruction/export hints only, not stack or GUI evidence';authority='none'})}catch{$cleanupFailures.Add('Startup position retention failed: '+$_.Exception.Message)}
        $popup=$null
        try{$popup=Read-HostedStartupPopup $child}catch{$popup=[ordered]@{status='unknown';query_failure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))}}
        try{Write-HostedNativeSetupRecord (Join-Path $capture 'startup-popup.json') ([ordered]@{context=$context;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();popup=$popup;scope='bounded System Application Popup26 executable/time correlation only; no GUI acceptance';authority='none'})}catch{$cleanupFailures.Add('Startup popup retention failed: '+$_.Exception.Message)}
        $threadDiagnostic=$null;$threadFailure=$null
        try{$threadDiagnostic=@(Read-HostedStartupThreads $child)}catch{$threadFailure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))}
        try{Write-HostedNativeSetupRecord (Join-Path $capture 'startup-threads.json') ([ordered]@{context=$context;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();threads=$threadDiagnostic;query_failure=$threadFailure;scope='bounded exact-generation thread states; not stack or GUI evidence';authority='none'})}catch{$cleanupFailures.Add('Startup diagnostic retention failed: '+$_.Exception.Message)}

    }
    throw $primaryError
}
finally {
    try {
        if($group){
            $remaining=@($group.StopAndObserve(5000))
            if($child){$rootExited=$child.WaitForExit(5000)}
            if($remaining.Count -ne 0 -or ($child -and -not $rootExited)){throw 'Original hosted native job teardown incomplete'}
            $settled=$true
        }
    } catch {$cleanupFailures.Add($_.Exception.Message)}
    try {if($child){$observerDrained=$child.DrainHostedObserver(5000);if(-not $observerDrained){throw 'Trusted hosted observer did not drain; retained handle closes only with bounded owner exit'}}} catch {$cleanupFailures.Add($_.Exception.Message)}
    try {
        if($group -and $group.LastLaunchInspection){
            $lastLaunch=$group.LastLaunchInspection
            if($lastLaunch.ContainsKey('root_pid') -and $lastLaunch['handle_returned'] -cne 'True' -and
                ($lastLaunch['failed_root_wait_after'] -cne '0' -or -not $lastLaunch.ContainsKey('root_created_filetime'))){throw 'Unreturned hosted launch root settlement Unknown; original-job emptiness does not qualify this root'}
        }
    }catch{$cleanupFailures.Add($_.Exception.Message)}
    # Disabling the exact created identity is independent of process settlement.
    # It prevents further logons but never claims to terminate existing children.
    try {
        if($account){
            $current=Get-LocalUser -SID $account.SID
            if($current.Name -cne $account.Name -or $current.Description -cne $account.Description){throw 'Hosted cleanup account identity differs'}
            Disable-LocalUser -SID $account.SID
            $disabled= -not (Get-LocalUser -SID $account.SID).Enabled
            if(-not $disabled){throw 'Hosted account disable readback failed'}
        }
    } catch {$cleanupFailures.Add($_.Exception.Message)}
    finally {
        if($child){
            try {$probeCapture=@{stdout=(Read-HostedNativeProbeStream $child.OutputCapture);stderr=(Read-HostedNativeProbeStream $child.ErrorCapture);exit_code=$(if($rootExited){$child.ExitCode}else{$null})}}
            catch {$probeCapture=@{error=$_.Exception.Message}}
        }
        try{if($audit){$audit.Dispose();foreach($problem in $audit.RecoveryFailures){$cleanupFailures.Add('Audit recovery: '+$problem)}}}catch{$cleanupFailures.Add('Audit recovery: '+$_.Exception.Message)}
        try{Write-HostedAuditRecovery $root $context}catch{$cleanupFailures.Add('Audit recovery export: '+$_.Exception.Message)}
        try {if($hostedDesktop){$hostedDesktop.Dispose();$stationRestored=$hostedDesktop.Restored}} catch {$cleanupFailures.Add($_.Exception.Message)}
        try {
            $recovery=[ordered]@{context=$context;station='WinSta0';session_id=[Diagnostics.Process]::GetCurrentProcess().SessionId;original_base64=$null;proposed_base64=$null;desktop_proposed_base64=$null;desktop_observed_base64=$null;automatic_retry=$false}
            foreach($entry in @{original_base64='station-dacl-before.bin';proposed_base64='station-dacl-proposed.bin';desktop_proposed_base64='desktop-dacl-proposed.bin';desktop_observed_base64='desktop-dacl-observed.bin'}.GetEnumerator()){
                $file=Join-Path (Join-Path $root 'capture') $entry.Value
                if(Test-Path -LiteralPath $file){
                    if((Get-Item -LiteralPath $file).Length -gt 8192){throw 'Station recovery ACL exceeds bound'}
                    $recovery[$entry.Key]=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
                }
            }
            if($recovery.original_base64 -or $recovery.proposed_base64){Write-HostedNativeSetupRecord (Join-Path (Join-Path $root 'capture') 'station-recovery.json') $recovery}
        } catch {$cleanupFailures.Add($_.Exception.Message)}
        if($child){$child.Dispose()};if($group){$group.Dispose()};if($password){$password.Dispose()}
        if(-not $failure -and $cleanupFailures.Count){$failure='Hosted cleanup refused; retained details require recovery'}
        Write-HostedNativeSetupRecord (Join-Path $root 'result.json') ([ordered]@{schema_version=1;context=$context;account_sid=$(if($account){$account.SID.Value}else{$null});profile=$nativeProfile;actual_profile=$actualProfile;registered_profile=$registeredProfile;root_identity=$(if($child){@{pid=$child.Pid;created_filetime=$child.CreatedFileTime.ToString()}}else{$null});root_exited=$rootExited;initial_suspend_count=$(if($child){$child.InitialSuspendCount}else{$null});remaining_pids=$remaining;disabled=$disabled;job_empty=$settled;hosted_desktop=$(if($hostedDesktop){$hostedDesktop.Name}else{$null});station_restored=$stationRestored;observer_drained=$observerDrained;audit_restored=$(if($audit){$audit.Restored}else{$null});failure=$failure;cleanup_failures=@($cleanupFailures.ToArray());probe_capture=$probeCapture;last_launch=$(if($group){$group.LastLaunchInspection}else{$null});window_inspection=$(if($child){$child.LastWindowInspection}else{$null});hosted_observer_failure=$(if($child){$child.LastHostedObserverFailure}else{$null});response_inspection=$(if($child){$child.LastResponseInspection}else{$null});saw_visible_window=$(if($child){$child.SawVisibleWindow}else{$null});observed=$observation;automatic_retry=$false;authority='none';scope='inert hosted account/profile/private GUI/job primitive only; no package or native acceptance'})
    }
}
if(-not $disabled -or -not $settled -or $failure){throw 'Hosted inert account setup did not complete'}
Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw
