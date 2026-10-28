param([Parameter(Mandatory)][string]$ContextBase64)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$hostedSessionExecutionAuthorized=$false
if(-not $hostedSessionExecutionAuthorized){throw 'Hosted persistent session awaits separate owner authority; no account or station effects'}

function Assert-OwnerMembers($Value,[string]$Keys) {
    if((@($Value.PSObject.Properties.Name|Sort-Object)-join ',') -cne $Keys){throw 'Closed hosted owner record required'}
}
function Write-OwnerRecord([string]$Name,$Value) {
    if($Name -cnotmatch '^[a-z][a-z0-9-]{0,95}[.]json$'){throw 'Fixed owner record name required'}
    $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress))
    if($bytes.Length -gt 16384){throw 'Owner record exceeds bound'}
    $file=[IO.FileStream]::new((Join-Path $context.root $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Assert-OwnerController {
    $node=[Diagnostics.Process]::GetProcessById([int]$context.node_pid)
    try {
        if($node.StartTime.ToFileTimeUtc().ToString() -cne $context.node_created_filetime -or $node.HasExited){throw 'Original controller generation stopped'}
    }finally{$node.Dispose()}
    if([Diagnostics.Stopwatch]::GetTimestamp() -ge $activeDeadlineTicks){throw 'Original hosted owner deadline exhausted'}
}
function Read-OwnerRequest([string]$Name,[long]$Sequence,[string]$Keys) {
    $file=Join-Path $context.root $Name
    while($true) {
        Assert-OwnerController
        if(Test-Path -LiteralPath $file) {
            $stream=$null
            try {
                $stream=[IO.FileStream]::new($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                if($stream.Length -lt 2 -or $stream.Length -gt 16384){throw 'Owner request exceeds bound'}
                $bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes)
                $value=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
                Assert-OwnerMembers $value $Keys
                if($value.binding -cne $context.binding -or $value.owner_pid -ne $PID -or
                    $value.owner_created_filetime -cne $ownerCreated -or $value.sequence -ne $Sequence){throw 'Original owner request identity differs'}
                return $value
            }catch [IO.IOException] {
                if(($_.Exception.HResult -band 65535) -notin @(32,33)){throw}
            }finally{if($stream){$stream.Dispose()}}
        }
        Start-Sleep -Milliseconds 50
    }
}
function Close-OwnerWorker([Diagnostics.Process]$Worker,$Monitor,[long]$DeadlineTicks,[long]$Frequency,$Cleanup) {
    try {
        if(-not $Worker.HasExited){$Worker.Kill($true)}
        if(-not $Worker.WaitForExit(5000)){$Cleanup.Add('B broker exit unobserved')}
    }catch{$Cleanup.Add('B broker cleanup unavailable')}
    finally {
        if($Monitor) {
            try {
                $remaining=[Math]::Min(6000,[Math]::Max(0,[long](($DeadlineTicks-[Diagnostics.Stopwatch]::GetTimestamp())*1000L/$Frequency)))
                if($remaining -le 0 -or -not $Monitor.Completion.Wait([int]$remaining)){$Cleanup.Add('B monitor retention incomplete; original handle retained')}
                else{$null=$Monitor.Completion.GetAwaiter().GetResult()}
            }catch{$Cleanup.Add('B failure stream/exit retention unavailable')}
        }
        # A still-running observer retains its process handle until original owner exit.
        if(-not $Monitor -or $Monitor.Completion.IsCompleted){$Worker.Dispose()}
    }
}
function Read-OriginalAccount([bool]$Enabled) {
    $current=Get-LocalUser -SID $account.SID -ErrorAction Stop
    if($current.SID.Value -cne $account.SID.Value -or $current.Name -cne 'PortcoveNativeQual' -or
        $current.Description -cne $description -or $current.Enabled -ne $Enabled){throw 'Original fresh account identity/state differs'}
    return $current
}
function Disable-OriginalAccount {
    $current=Get-LocalUser -SID $account.SID -ErrorAction Stop
    if($current.Name -cne 'PortcoveNativeQual' -or $current.Description -cne $description){throw 'Account recovery ownership differs; no adoption'}
    Disable-LocalUser -SID $account.SID
    $null=Read-OriginalAccount $false
}

if($ContextBase64.Length -gt 16384){throw 'Owner context exceeds bound'}
$context=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($ContextBase64))|ConvertFrom-Json
Assert-OwnerMembers $context 'binding,node_created_filetime,node_pid,root,run_attempt,run_id,schema_version,source_commit,source_root,source_tree,tools_root'
if($context.schema_version -ne 1 -or $context.binding -cnotmatch '^[a-f0-9]{64}$' -or $context.source_commit -cnotmatch '^[a-f0-9]{40}$' -or
    $context.source_tree -cnotmatch '^[a-f0-9]{40}$' -or $context.node_pid -lt 1 -or $context.node_pid -gt [int]::MaxValue -or
    $context.node_created_filetime -cnotmatch '^[1-9][0-9]{0,19}$' -or $context.run_id -cnotmatch '^[1-9][0-9]{0,19}$' -or $context.run_attempt -ne 1 -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:GITHUB_JOB -cne 'native_windows' -or $env:GITHUB_WORKFLOW_REF -cnotmatch '^boburning/portcove/[.]github/workflows/application-update-production[.]yml@refs/tags/[^/]+$' -or
    $env:GITHUB_RUN_ID -cne $context.run_id -or $env:GITHUB_RUN_ATTEMPT -cne '1'){throw 'Fixed held hosted owner context differs'}
foreach($root in @($context.root,$context.source_root,$context.tools_root)) {
    if($root -isnot [string] -or $root -cnotmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':') -or [IO.Path]::GetFullPath($root) -cne $root){throw 'Fixed local owner root required'}
}
if(-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $context.tools_root 'scripts')),[IO.Path]::GetFullPath($PSScriptRoot),[StringComparison]::OrdinalIgnoreCase)){throw 'Owner must execute from the original admitted tool root'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownerCreated=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()
$frequency=[Diagnostics.Stopwatch]::Frequency
$sample=[Diagnostics.Stopwatch]::GetTimestamp()
$activeDeadlineTicks=$sample+90L*$frequency
$fullDeadlineTicks=$activeDeadlineTicks
$manifest=Get-Content -LiteralPath (Join-Path $context.tools_root 'manifest.json') -Raw|ConvertFrom-Json
$helper=Join-Path $PSScriptRoot 'native-qualification-account.cs.txt'
$bridgeRoot=Join-Path $context.root 'bridge'
$bridge=Join-Path $bridgeRoot 'scripts/native-qualification-account-bridge.ps1'
foreach($name in @('release-hosted-native-windows-owner.ps1','release-hosted-native-windows-setup.cs.txt','native-qualification-account.cs.txt','native-qualification-account-bridge.ps1','native-qualification-account-registry.ps1')) {
    $entry=@($manifest.files|Where-Object path -CEQ ('scripts/'+$name));$file=Join-Path $PSScriptRoot $name
    if($entry.Count -ne 1 -or $entry[0].bytes -lt 1 -or $entry[0].bytes -gt 131072 -or (Get-Item -LiteralPath $file).Length -ne $entry[0].bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[0].sha256){throw 'Original owner tool source differs'}
}
$helperSha=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceHelper=Join-Path $context.source_root 'scripts/native-qualification-account.cs.txt'
if((Get-FileHash -LiteralPath $sourceHelper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $helperSha){throw 'Selected B and original A helper ABI differ before account effects'}
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-hosted-native-windows-setup.cs.txt') -Raw)
Add-Type -TypeDefinition (Get-Content -LiteralPath $helper -Raw)
if(-not [Portcove.NativeQualification.AccountLauncher]::HostedCandidateExecutionAuthorized -or
    -not [Portcove.HostedNative.HostedDesktop]::HostedCandidateRecoveryAuthorized){throw 'Candidate/recovery helpers remain held before account effects'}
[Portcove.HostedNative.Setup]::Directory($bridgeRoot,$owner,'',$false)
[Portcove.HostedNative.Setup]::Directory((Join-Path $bridgeRoot 'scripts'),$owner,'',$false)
foreach($name in @('native-qualification-account.cs.txt','native-qualification-account-bridge.ps1')) {
    $source=Join-Path $PSScriptRoot $name;$target=Join-Path $bridgeRoot ('scripts/'+$name)
    [IO.File]::Copy($source,$target,$false)
    if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash){throw 'Original bridge deployment copy differs'}
}
Write-OwnerRecord 'owner-ready.json' ([ordered]@{binding=$context.binding;owner_pid=$PID;owner_created_filetime=$ownerCreated;broker_sid=$owner;bridge_root=$bridgeRoot;sample_ticks=$sample.ToString();frequency=$frequency;authority='none'})
$start=Read-OwnerRequest 'owner-start.json' 1 'active_deadline_ticks,binding,full_deadline_ticks,owner_created_filetime,owner_pid,sequence'
if($start.full_deadline_ticks -cnotmatch '^[1-9][0-9]{0,18}$' -or $start.active_deadline_ticks -cnotmatch '^[1-9][0-9]{0,18}$'){throw 'Original owner clock fields differ'}
$fullDeadlineTicks=[long]$start.full_deadline_ticks;$activeDeadlineTicks=[long]$start.active_deadline_ticks
if($fullDeadlineTicks-$sample -gt 570L*$frequency -or $fullDeadlineTicks-$activeDeadlineTicks -ne 30L*$frequency){throw 'Original cleanup reserve/clock differs'}
Assert-OwnerController
$account=$null;$password=$null;$station=$null;$group=$null;$worker=$null;$workerMonitor=$null;$failure='';$cleanup=[Collections.Generic.List[string]]::new()
$description='Portcove hosted native '+$context.binding
try {
    if(Get-LocalUser -Name 'PortcoveNativeQual' -ErrorAction SilentlyContinue){throw 'Existing qualification account cannot be adopted'}
    $password=[Portcove.HostedNative.Setup]::Password()
    $account=New-LocalUser -Name 'PortcoveNativeQual' -Password $password -Description $description -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Disabled
    Write-OwnerRecord 'account-created.json' ([ordered]@{binding=$context.binding;owner_pid=$PID;owner_created_filetime=$ownerCreated;sid=$account.SID.Value;name=$account.Name;description=$description;enabled=$false;credential='memory-only';authority='none'})
    $ack=Read-OwnerRequest 'account-ack.json' 2 'account_sid,binding,owner_created_filetime,owner_pid,sequence'
    if($ack.account_sid -cne $account.SID.Value){throw 'Original controller account acknowledgment differs'}
    $null=Read-OriginalAccount $false
    $accountProfile=[Portcove.HostedNative.Setup]::Profile($account.SID.Value)
    Write-OwnerRecord 'account-ready.json' ([ordered]@{binding=$context.binding;sid=$account.SID.Value;profile_root=$accountProfile;credential='memory-only';authority='none'})
    $sequence=3L
    foreach($stage in @('payload-signing','release-publication')) {
        $prepare=Read-OwnerRequest ($stage+'-prepare.json') $sequence 'active_deadline_ticks,binding,owner_created_filetime,owner_pid,sequence'
        if($prepare.active_deadline_ticks -cnotmatch '^[1-9][0-9]{0,18}$' -or [long]$prepare.active_deadline_ticks -gt $activeDeadlineTicks -or [long]$prepare.active_deadline_ticks -le [Diagnostics.Stopwatch]::GetTimestamp()){throw 'Stage cannot renew the original owner deadline'}
        $activeDeadlineTicks=[long]$prepare.active_deadline_ticks
        $sequence++
        $stageRoot=Join-Path $context.root $stage
        [Portcove.HostedNative.Setup]::Directory($stageRoot,$owner,'',$false)
        foreach($leaf in @('work','readonly','capture')) {
            $sid=if($leaf -eq 'capture'){''}else{$account.SID.Value}
            [Portcove.HostedNative.Setup]::Directory((Join-Path $stageRoot $leaf),$owner,$sid,($leaf -eq 'work'))
        }
        $capture=Join-Path $stageRoot 'capture';$work=Join-Path $stageRoot 'work'
        Write-OwnerRecord ($stage+'-prepared.json') ([ordered]@{binding=$context.binding;stage=$stage;work_root=$work;readonly_root=(Join-Path $stageRoot 'readonly');capture_root=$capture;authority='none'})
        $request=Read-OwnerRequest ($stage+'-start.json') $sequence 'binding,configuration_sha256,invocation_id,owner_created_filetime,owner_pid,sequence,worker_request_sha256'
        $sequence++
        if($request.configuration_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $request.invocation_id -cnotmatch '^[a-f0-9]{64}$'){throw 'Fixed stage identity differs'}
        $configuration=Join-Path $capture 'bridge-configuration.json'
        if((Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.configuration_sha256){throw 'Stage bridge configuration changed'}
        $wire=Get-Content -LiteralPath $configuration -Raw|ConvertFrom-Json
        Assert-OwnerMembers $wire 'account_name,account_sid,broker_sid,capture_root,controller_root,helper_sha256,profile_root,schema_version,work_root'
        if($wire.schema_version -ne 1 -or $wire.account_name -cne 'PortcoveNativeQual' -or $wire.account_sid -cne $account.SID.Value -or $wire.broker_sid -cne $owner -or
            $wire.capture_root -cne $capture -or $wire.work_root -cne $work -or $wire.profile_root -cne $accountProfile -or $wire.controller_root -cne $bridgeRoot -or $wire.helper_sha256 -cne $helperSha){throw 'Original stage account boundary differs'}
        $workerInput=Join-Path $capture 'worker-input.json'
        if($request.worker_request_sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-Item -LiteralPath $workerInput).Length -gt 32768 -or
            (Get-FileHash -LiteralPath $workerInput -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.worker_request_sha256){throw 'Original B request differs before account effects'}
        $workerWire=Get-Content -LiteralPath $workerInput -Raw|ConvertFrom-Json
        $workerNode=Join-Path $context.tools_root 'bin/node.exe'
        $nodeEntry=@($manifest.files|Where-Object path -CEQ 'bin/node.exe')
        if($nodeEntry.Count -ne 1 -or $workerWire.tools.node.path -cne $workerNode -or $workerWire.tools.node.sha256 -cne $nodeEntry[0].sha256 -or
            (Get-FileHash -LiteralPath $workerNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nodeEntry[0].sha256 -or
            $workerWire.stage -cne $stage -or $workerWire.capture_root -cne $capture -or $workerWire.work_root -cne $work -or
            $workerWire.binding.path -cne (Join-Path $capture 'account-binding.json')){throw 'Fixed credential-free B worker differs'}
        $workerEntry=Join-Path $context.source_root 'scripts/release-native-worker.mts'
        if((Get-FileHash -LiteralPath $workerEntry -Algorithm SHA256).Hash.ToLowerInvariant() -cne $workerWire.worker_sha256){throw 'Selected B entry changed'}
        $config=[Portcove.NativeQualification.AccountConfiguration]::new()
        $config.UserName='PortcoveNativeQual';$config.AccountSid=$account.SID.Value;$config.BrokerSid=$owner;$config.ProfileRoot=$accountProfile;$config.WorkRoot=$work
        $config.PrivateDesktop='PortcoveNative_'+$request.invocation_id.Substring(0,32)+'\Qualification'
        $group=[Portcove.NativeQualification.AccountLauncher]::CreateGroup($config)
        $station=[Portcove.HostedNative.HostedDesktop]::Prepare($owner,$account.SID.Value,$capture)
        Write-OwnerRecord ($stage+'-station.json') ([ordered]@{binding=$context.binding;stage=$stage;desktop_name=$station.Name;account_sid=$account.SID.Value;enabled=$false;authority='none'})
        $ack=Read-OwnerRequest ($stage+'-enable.json') $sequence 'account_sid,binding,owner_created_filetime,owner_pid,sequence'
        $sequence++
        if($ack.account_sid -cne $account.SID.Value){throw 'Original stage station acknowledgment differs'}
        try {
            Enable-LocalUser -SID $account.SID
            $null=Read-OriginalAccount $true
            # B inherits this original supervisor job; it acquires no second resource lease.
            $startInfo=[Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName=$workerNode;$startInfo.WorkingDirectory=$context.source_root
            $startInfo.UseShellExecute=$false;$startInfo.CreateNoWindow=$true
            $startInfo.RedirectStandardOutput=$true;$startInfo.RedirectStandardError=$true
            foreach($argument in @($workerEntry,'--hosted-windows-stage',$workerInput,$request.worker_request_sha256)){$startInfo.ArgumentList.Add($argument)}
            $startInfo.Environment.Clear()
            $system=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
            $environment=@{SystemRoot=$system;WINDIR=$system;PATH=((Split-Path $workerNode)+';C:\Program Files\Git\cmd;'+(Join-Path $system 'System32'));PATHEXT='.EXE';USERPROFILE=$context.root;HOME=$context.root;TEMP=$context.root;TMP=$context.root}
            foreach($name in $environment.Keys){$startInfo.Environment[$name]=$environment[$name]}
            $workerMonitor=$null
            $worker=[Diagnostics.Process]::Start($startInfo)
            $workerCreated=$worker.StartTime.ToFileTimeUtc().ToString()
            $outputCapture=[Portcove.NativeQualification.NativePipeCapture]::new($worker.StandardOutput.BaseStream)
            $errorCapture=[Portcove.NativeQualification.NativePipeCapture]::new($worker.StandardError.BaseStream)
            $workerMonitor=[Portcove.NativeQualification.OwnedBrokerChildMonitor]::new($worker,$outputCapture,$errorCapture,$capture,$fullDeadlineTicks)
            $members=@([Portcove.NativeQualification.AccountLauncher]::CurrentSupervisorProcessIds())
            if($worker.HasExited -or $members -notcontains $PID -or $members -notcontains $worker.Id){throw 'B did not inherit the original prepared supervisor job'}
            Write-OwnerRecord ($stage+'-worker.json') ([ordered]@{binding=$context.binding;stage=$stage;pid=$worker.Id;created_filetime=$workerCreated;owner_pid=$PID;owner_created_filetime=$ownerCreated;image=$workerNode;request_sha256=$request.worker_request_sha256;supervisor_job_pids=$members;authority='none'})
            $memory=@{configuration=$config;credential=$password;group=$group;helper_sha256=$helperSha;owner_pid=$PID;owner_created_filetime=$ownerCreated;
                deadline_ticks=$activeDeadlineTicks;frequency=$frequency;desktop_name=$station.Name}
            & $bridge -Configuration $configuration -ExpectedConfigurationSha256 $request.configuration_sha256 -InvocationId $request.invocation_id -HostedMemoryContext $memory
        }finally {
            Disable-OriginalAccount
            if($group){$group.Dispose();$group=$null}
            if($station){$station.Dispose();if(-not $station.Restored){throw 'Stage station restoration not observed'};$station=$null}
        }
        if(-not $worker -or -not $worker.HasExited -or $worker.ExitCode -ne 0){throw 'B worker exit was not observed successful'}
        $monitorWait=[Math]::Min(6000,[Math]::Max(0,[long](($fullDeadlineTicks-[Diagnostics.Stopwatch]::GetTimestamp())*1000L/$frequency)))
        if($monitorWait -le 0 -or -not $workerMonitor.Completion.Wait([int]$monitorWait) -or -not $workerMonitor.Completion.GetAwaiter().GetResult()){throw 'B worker observation did not settle successful'}
        foreach($captureTask in @($outputCapture,$errorCapture)) {
            $remaining=[Math]::Min(5000,[Math]::Max(0,[long](($fullDeadlineTicks-[Diagnostics.Stopwatch]::GetTimestamp())*1000L/$frequency)))
            if($remaining -le 0 -or -not $captureTask.Completion.Wait([int]$remaining)){throw 'B output EOF unobserved inside original deadline'}
            $null=$captureTask.Completion.GetAwaiter().GetResult()
        }
        foreach($pair in @(@('harness.stdout.bin',$outputCapture),@('harness.stderr.bin',$errorCapture))) {
            $bytes=$pair[1].Snapshot();$file=[IO.FileStream]::new((Join-Path $capture $pair[0]),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
        }
        $members=@([Portcove.NativeQualification.AccountLauncher]::CurrentSupervisorProcessIds())
        if($members.Count -ne 1 -or $members[0] -ne $PID){throw 'Broker B or installer descendants remain in the original supervisor job'}
        $worker.Dispose();$worker=$null
        $state=Get-Content -LiteralPath (Join-Path $capture 'bridge-state.json') -Raw|ConvertFrom-Json
        if($state.phase -cne 'settled' -or @($state.group_remaining_pids).Count -ne 0 -or $state.failure){throw 'Original stage bridge did not settle'}
        Write-OwnerRecord ($stage+'-settled.json') ([ordered]@{binding=$context.binding;stage=$stage;account_sid=$account.SID.Value;disabled=$true;station_restored=$true;group_empty=$true;harness_exit_code=0;harness_drained=$true;broker_job_remaining_pids=$members;authority='none'})
    }
    $null=Read-OwnerRequest 'owner-finish.json' $sequence 'binding,owner_created_filetime,owner_pid,sequence'
}catch {
    $failure=$_.Exception.Message.Substring(0,[Math]::Min(1024,$_.Exception.Message.Length))
}finally {
    if($worker){Close-OwnerWorker $worker $workerMonitor $fullDeadlineTicks $frequency $cleanup}
    if($account){try{Disable-OriginalAccount}catch{$cleanup.Add('account disable/readback unavailable')}}
    if($group){try{$group.Dispose()}catch{$cleanup.Add('stage group cleanup unavailable')}}
    if($station){try{$station.Dispose();if(-not $station.Restored){$cleanup.Add('station restoration unobserved')}}catch{$cleanup.Add('station restoration unavailable')}}
    if($password){$password.Dispose()}
    Write-OwnerRecord 'owner-final.json' ([ordered]@{binding=$context.binding;owner_pid=$PID;owner_created_filetime=$ownerCreated;failure=$failure;cleanup_failures=@($cleanup);credential_disposed=$true;
        scope='original owner settlement data only; independent controller recovery/readback remains mandatory';authority='none'})
}
if($failure -or $cleanup.Count){throw 'Hosted owner refused; retain partial state and original recovery'}
