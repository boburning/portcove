param(
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigurationSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$InvocationId,
    [object]$HostedMemoryContext = $null
)
$ErrorActionPreference = 'Stop'
$hostedMode = $null -ne $HostedMemoryContext
if ($hostedMode) {
    $hostedCandidateExecutionAuthorized = $false
    if (-not $hostedCandidateExecutionAuthorized) { throw 'Hosted memory bridge awaits separate candidate execution authority' }
}

# This is fixed owner-side launch plumbing, not an acceptance report importer.
# It receives no issuer credential and never produces a CheckRun.
function Assert-ExactMembers($Value, [string[]]$Names) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    if (($actual -join '|') -cne (($Names | Sort-Object) -join '|')) { throw 'Unexpected bridge fields' }
}
function Assert-OwnerFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bridge input reparse point refused' }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $script:owner) { throw 'Bridge input owner mismatch' }
    $write = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and
            $rule.IdentityReference.Value -notin @($script:owner,'S-1-5-18','S-1-5-32-544')) { throw 'Bridge input writable by another identity' }
    }
    $ancestor=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    $ancestorWrite=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    $depth=0
    while ($ancestor) {
        if (++$depth -gt 64) { throw 'Bridge input ancestry exceeds bound' }
        $item=Get-Item -LiteralPath $ancestor -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bridge input ancestor reparse point refused' }
        foreach ($rule in (Get-Acl -LiteralPath $ancestor).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
                $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $ancestorWrite) -and
                $rule.IdentityReference.Value -notin @($script:owner,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
                throw 'Bridge input ancestor permits replacement by another identity'
            }
        }
        $parent=[IO.Path]::GetDirectoryName($ancestor)
        if (-not $parent -or $parent -eq $ancestor) { break }
        $ancestor=$parent
    }
}
function Write-Capture([string]$Id, $Process) {
    foreach ($stream in @(@('stdout',$Process.OutputCapture),@('stderr',$Process.ErrorCapture))) {
        $path = Join-Path $configurationValue.capture_root ($Id + '.' + $stream[0] + '.bin')
        $snapshot=$stream[1].Snapshot()
        $known=$captureLengths.ContainsKey($path)
        $offset=if ($known) { $captureLengths[$path] } else { 0L }
        if ($snapshot.Length -lt $offset) { throw 'Native capture cannot shrink' }
        # Retain each byte once. Rewriting an unchanged 4 MiB stream on every
        # observation would multiply bounded capture into gigabytes of I/O.
        $mode=if ($known) { [IO.FileMode]::Open } else { [IO.FileMode]::CreateNew }
        $file=[IO.FileStream]::new($path,$mode,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try {
            if ($file.Length -ne $offset) { throw 'Native capture retained length changed' }
            $file.Position=$offset
            if ($snapshot.Length -gt $offset) { $file.Write($snapshot,[int]$offset,$snapshot.Length-[int]$offset); $file.Flush($true) }
            $captureLengths[$path]=[long]$snapshot.Length
        } finally { $file.Dispose() }
    }
}
function Convert-Teardown($Value) {
    if ($null -eq $Value) { return $null }
    [ordered]@{ root_pid=$Value.RootPid; root_created_filetime=$Value.RootCreatedFileTime.ToString(); exit_code=$Value.ExitCode;
        root_exited=$Value.RootExited; job_empty=$Value.JobEmpty; remaining_pids=@($Value.RemainingPids); observed_at=$Value.ObservedAt }
}
function Save-State([string]$Phase, [string]$Failure = '') {
    $records = @($roots.GetEnumerator() | ForEach-Object {
        Write-Capture $_.Key $_.Value
        $launchIdentity=$launchIdentities[$_.Key]
        [ordered]@{ id=$_.Key; pid=$_.Value.Id; created_filetime=$_.Value.CreatedFileTime.ToString();
            path=$_.Value.Path; sha256=$(if ($launchIdentity) {$launchIdentity.sha256} else {$null});
            started_at=$_.Value.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
            teardown=(Convert-Teardown $_.Value.LastTeardown) }
    })
    $state = [ordered]@{ schema_version=1; authority='none'; invocation_id=$InvocationId; configuration_sha256=$ExpectedConfigurationSha256;
        broker_pid=$PID; broker_created_filetime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()); sequence=$sequence;
        observed_at=[DateTime]::UtcNow.ToString('o'); phase=$Phase; failure=$Failure;
        roots=$records; group_remaining_pids=@($group.RemainingPids()); native_acceptance='not-established' }
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($state|ConvertTo-Json -Depth 8 -Compress))
    if($bytes.Length -gt 65536){throw 'Native bridge state exceeds readback bound'}
    $file=[IO.FileStream]::new((Join-Path $configurationValue.capture_root 'bridge-state.json'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Assert-CaptureHealthy {
    foreach ($process in $roots.Values) { $process.RefuseFaultedCapture() }
}

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Assert-OwnerFile $PSCommandPath
Assert-OwnerFile $Configuration
if ((Get-FileHash -LiteralPath $Configuration -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedConfigurationSha256) { throw 'Bridge configuration changed' }
$configurationValue = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$boundaryNames=@('schema_version','broker_sid','account_sid','account_name','profile_root','work_root','capture_root','helper_sha256','controller_root')
if($configurationValue.schema_version -eq 2){$boundaryNames+=@('purpose');if($configurationValue.purpose -cne 'ordinary-public-proof'){throw 'Unknown public account purpose'}}
Assert-ExactMembers $configurationValue $boundaryNames
if ($configurationValue.schema_version -notin @(1,2) -or $configurationValue.broker_sid -cne $owner -or $configurationValue.account_sid -eq $owner) { throw 'Unratified bridge account boundary' }
Assert-OwnerFile $configurationValue.controller_root
if (-not (Get-Acl -LiteralPath $configurationValue.controller_root).AreAccessRulesProtected -or
    -not [string]::Equals([IO.Path]::GetFullPath((Join-Path $configurationValue.controller_root 'scripts')),[IO.Path]::GetFullPath($PSScriptRoot),[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixed native helper must execute from the protected controller staging root'
}
$helper = Join-Path $PSScriptRoot 'native-qualification-account.cs.txt'
Assert-OwnerFile $helper
if ($configurationValue.helper_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configurationValue.helper_sha256) { throw 'Fixed bridge helper changed' }
Assert-OwnerFile $configurationValue.capture_root
if (-not (Get-Acl -LiteralPath $configurationValue.capture_root).AreAccessRulesProtected) { throw 'Capture inheritance is not protected' }
if (Test-Path -LiteralPath (Join-Path $configurationValue.capture_root 'bridge-state.json')) { throw 'Retained bridge invocation cannot be repeated' }
if (-not $hostedMode -or -not ('Portcove.NativeQualification.AccountLauncher' -as [type])) { Add-Type -TypeDefinition (Get-Content -LiteralPath $helper -Raw) }
$config = [Portcove.NativeQualification.AccountConfiguration]::new()
$config.UserName=$configurationValue.account_name; $config.AccountSid=$configurationValue.account_sid; $config.BrokerSid=$owner
if($configurationValue.schema_version -eq 2){$config.CredentialPurpose=[Portcove.NativeQualification.AccountCredentialPurpose]::OrdinaryPublicProof}
$config.ProfileRoot=$configurationValue.profile_root; $config.WorkRoot=$configurationValue.work_root
$config.PrivateDesktop='PortcoveNative_' + $InvocationId.Substring(0,32) + '\Qualification'
$roots = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$launchIdentities = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$captureLengths = [Collections.Generic.Dictionary[string,long]]::new([StringComparer]::OrdinalIgnoreCase)
if ($hostedMode) {
    if ($HostedMemoryContext -isnot [hashtable]) { throw 'Original in-process hosted memory context required' }
    $hostedMemory = $HostedMemoryContext.Clone()
    if (
        (@($hostedMemory.Keys | Sort-Object) -join ',') -cne $(if($hostedMemory.ContainsKey('diagnostic')){'configuration,credential,deadline_ticks,desktop_name,diagnostic,frequency,group,helper_sha256,owner_created_filetime,owner_pid'}else{'configuration,credential,deadline_ticks,desktop_name,frequency,group,helper_sha256,owner_created_filetime,owner_pid'}) -or
        $hostedMemory.credential -isnot [Security.SecureString] -or
        -not $hostedMemory.credential.IsReadOnly() -or
        $hostedMemory.configuration -isnot [Portcove.NativeQualification.AccountConfiguration] -or
        $hostedMemory.group -isnot [Portcove.NativeQualification.AccountGroup] -or
        $hostedMemory.helper_sha256 -cne $configurationValue.helper_sha256 -or
        $hostedMemory.owner_pid -ne $PID -or
        $hostedMemory.owner_created_filetime -cne ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()) -or
        $hostedMemory.deadline_ticks -isnot [long] -or
        $hostedMemory.frequency -isnot [long] -or
        $hostedMemory.frequency -ne [Diagnostics.Stopwatch]::Frequency -or
        $hostedMemory.deadline_ticks -le [Diagnostics.Stopwatch]::GetTimestamp() -or
        $hostedMemory.deadline_ticks - [Diagnostics.Stopwatch]::GetTimestamp() -gt 570L * [Diagnostics.Stopwatch]::Frequency -or
        $hostedMemory.desktop_name -cnotmatch '^PortcoveHosted_[a-f0-9]{32}$') { throw 'Original in-process hosted memory context required' }
    if($hostedMemory.ContainsKey('diagnostic') -and $hostedMemory.diagnostic -isnot [bool]){throw 'Fixed diagnostic memory scope required'}
    $memoryConfig = $hostedMemory.configuration
    foreach ($field in @('UserName','AccountSid','BrokerSid','ProfileRoot','WorkRoot')) {
        if ($memoryConfig.$field -cne $config.$field) { throw 'Hosted memory account context differs' }
    }
    $group = $hostedMemory.group
    $hostedDeadlineTicks = [long]$hostedMemory.deadline_ticks
    $hostedDesktopName = [string]$hostedMemory.desktop_name
    $hostedCredential = $hostedMemory.credential
} else { $group = [Portcove.NativeQualification.AccountLauncher]::CreateGroup($config) }
function Assert-BridgeDeadline {
    if ($hostedMode) {
        if ([Diagnostics.Stopwatch]::GetTimestamp() -ge $hostedDeadlineTicks) { throw 'Original hosted bridge deadline exhausted' }
    } elseif ($clock.Elapsed.TotalSeconds -ge 1800) { throw 'Native bridge fixed 1800-second deadline reached' }
}
$credential = $null; $pipe = $null; $groupStopped = $false; $finished = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$sequence=0
try {
    Save-State 'prepared'
    $credential = if ($hostedMode) { $hostedCredential } else { [Portcove.NativeQualification.AccountLauncher]::ReadAccountCredential($config) }
    # One owner-only connection per command. Candidate roots have null stdin and
    # never receive this pipe name in their explicit environment.
    for ($sequence = 1; $sequence -le 512; $sequence++) {
        $pipe = [IO.Pipes.NamedPipeServerStream]::new('PortcoveNative_' + $InvocationId,
            [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte,
            [IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly)
        $waiting = $pipe.WaitForConnectionAsync()
        while (-not $waiting.IsCompleted) {
            Assert-CaptureHealthy
            Assert-BridgeDeadline
            Start-Sleep -Milliseconds 25
        }
        $waiting.GetAwaiter().GetResult()
        $reading = [Portcove.NativeQualification.OwnerCommandReader]::ReadOne($pipe)
        $commandClock = [Diagnostics.Stopwatch]::StartNew()
        while (-not $reading.IsCompleted) {
            Assert-CaptureHealthy
            if ($commandClock.Elapsed.TotalSeconds -ge 5) { throw 'Incomplete bridge command deadline reached' }
            Assert-BridgeDeadline
            Start-Sleep -Milliseconds 25
        }
        Assert-BridgeDeadline
        $request = $reading.GetAwaiter().GetResult() | ConvertFrom-Json
        Assert-ExactMembers $request @('schema_version','invocation_id','sequence','operation','id','launch','target')
        if ($request.schema_version -ne 1 -or $request.invocation_id -cne $InvocationId -or $request.sequence -ne $sequence -or $request.id -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'Bridge command identity mismatch' }
        Assert-CaptureHealthy
        if ($request.operation -cnotin @('close','window') -and $null -ne $request.target) { throw 'Only close/window accepts an exact owned child target' }
        $value = $null
        switch -CaseSensitive ($request.operation) {
            'start' {
                if ($roots.Count -ge 64 -or $roots.ContainsKey($request.id)) { throw 'Bridge launch is bounded and one-shot per identity' }
                $launch=$request.launch
                Assert-ExactMembers $launch @('executable','sha256','arguments','directory','environment','nsis')
                if ($launch.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $launch.nsis -isnot [bool] -or $launch.arguments -isnot [array]) { throw 'Malformed fixed launch' }
                if ((Get-FileHash -LiteralPath $launch.executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $launch.sha256) { throw 'Native launch bytes changed' }
                $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($property in $launch.environment.PSObject.Properties) {
                    if ($property.Value -isnot [string]) { throw 'Native environment must contain explicit strings' }
                    $environment.Add($property.Name,$property.Value)
                }
                Assert-BridgeDeadline
                $process = if ($hostedMode) {
                    $(if($hostedMemory.ContainsKey('diagnostic') -and $hostedMemory.diagnostic){[Portcove.NativeQualification.AccountLauncher]::StartHostedDiagnosticCandidateVerifiedInGroup($group,$config,$credential,$launch.executable,$launch.sha256,[string[]]$launch.arguments,$launch.directory,$environment,$launch.nsis,$hostedDesktopName)}else{[Portcove.NativeQualification.AccountLauncher]::StartHostedCandidateVerifiedInGroup($group,$config,$credential,$launch.executable,$launch.sha256,[string[]]$launch.arguments,$launch.directory,$environment,$launch.nsis,$hostedDesktopName)})
                } else { [Portcove.NativeQualification.AccountLauncher]::StartVerifiedInGroup($group,$config,$credential,$launch.executable,$launch.sha256,[string[]]$launch.arguments,$launch.directory,$environment,$launch.nsis) }
                $roots.Add($request.id,$process)
                # This digest is bound by StartVerifiedInGroup's deny-write /
                # delete handle through suspended creation and resume. Retain
                # it with the actual returned process identity, not a report.
                $launchIdentities.Add($request.id,[ordered]@{sha256=$launch.sha256})
                $value=[ordered]@{ pid=$process.Id; path=$process.Path; started_filetime=$process.CreatedFileTime.ToString(); started_at=$process.StartTime.ToUniversalTime().ToString('o') }
            }
            'observe' {
                if ($null -ne $request.launch -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $process=$roots[$request.id]
                $exited=$process.HasExited
                $identities=@($process.SnapshotOwnedJob() | ForEach-Object { [ordered]@{ pid=$_.Pid; path=$_.Path; started_filetime=$_.CreatedFileTime.ToString() } })
                $value=[ordered]@{ exited=$exited; exit_code=$(if ($exited) {$process.ExitCode} else {$null}); processes=$identities;
                    responding=$(if ($hostedMode) {$process.HostedResponding} else {$process.Responding}); window_title=$process.MainWindowTitle; window_handle=$process.MainWindowHandle.ToInt64().ToString() }
            }
            'window' {
                if ($null -ne $request.launch -or -not $roots.ContainsKey($request.id) -or $null -eq $request.target) { throw 'Unknown native window root/target' }
                Assert-ExactMembers $request.target @('pid','started_filetime')
                if (($request.target.pid -isnot [long] -and $request.target.pid -isnot [int]) -or
                    $request.target.pid -lt 1 -or $request.target.pid -gt [int]::MaxValue -or $request.target.started_filetime -cnotmatch '^[1-9][0-9]+$') { throw 'Invalid window identity' }
                $value=[ordered]@{ title=$roots[$request.id].OwnedVisibleWindowTitle([uint32]$request.target.pid,[long]$request.target.started_filetime) }
            }
            'close' {
                if ($null -ne $request.launch -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                if ($null -eq $request.target) { $accepted=$roots[$request.id].CloseMainWindow() }
                else {
                    Assert-ExactMembers $request.target @('pid','started_filetime')
                    if ($request.target.pid -isnot [long] -and $request.target.pid -isnot [int]) { throw 'Exact positive close PID required' }
                    if ($request.target.pid -lt 1 -or $request.target.pid -gt [int]::MaxValue -or $request.target.started_filetime -cnotmatch '^[1-9][0-9]+$') { throw 'Invalid close identity' }
                    $accepted=$roots[$request.id].CloseOwnedWindow([uint32]$request.target.pid,[long]$request.target.started_filetime)
                }
                $value=[ordered]@{ accepted=$accepted }
            }
            'stop' {
                if ($null -ne $request.launch -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $value=Convert-Teardown ($roots[$request.id].StopAndObserve(5000))
            }
            'readback' {
                if ($null -ne $request.launch -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $value=Convert-Teardown ($roots[$request.id].ReadTeardown(5000))
                if ($value.root_exited -and $value.job_empty) {
                    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($roots[$request.id].Output,$roots[$request.id].ErrorOutput),5000)) { throw 'Native readback capture did not reach EOF' }
                    $roots[$request.id].RefuseFaultedCapture()
                }
            }
            'finish' {
                if ($null -ne $request.launch) { throw 'Finish cannot import launch data' }
                $groupStopped=$true
                $remaining=@($group.StopAndObserve(5000))
                if ($remaining.Count -ne 0) { throw 'Native group teardown remains incomplete' }
                foreach ($process in $roots.Values) {
                    $observed=$process.ReadTeardown(5000)
                    if (-not $observed.RootExited -or -not $observed.JobEmpty) { throw 'Native root teardown remains incomplete' }
                    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($process.Output,$process.ErrorOutput),5000)) { throw 'Native pipe completion remains incomplete' }
                    $process.RefuseFaultedCapture()
                    if ($hostedMode -and -not $process.DrainHostedObserver(5000)) { throw 'Hosted bridge observer has not drained' }
                }
                $finished=$true; $value=[ordered]@{ group_empty=$true; roots=$roots.Count }
            }
            default { throw 'Unsupported fixed native operation' }
        }
        Save-State $(if ($finished) {'settled'} else {'running'})
        $response=[ordered]@{ schema_version=1; invocation_id=$InvocationId; sequence=$sequence; broker_pid=$PID; value=$value }
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($response | ConvertTo-Json -Depth 8 -Compress) + "`n")
        if ($bytes.Length -gt 65536) { throw 'Native response exceeded 64 KiB' }
        $pipe.Write($bytes,0,$bytes.Length); $pipe.Flush(); $pipe.Dispose(); $pipe=$null
        if ($finished) { break }
    }
    if (-not $finished) { throw 'Native bridge command limit reached without teardown' }
} catch {
    $failure=$_.Exception.Message
    if (-not $groupStopped) {
        $groupStopped=$true
        try { $null=$group.StopAndObserve(5000) } catch { $failure += '; group termination: ' + $_.Exception.Message }
    }
    foreach ($process in $roots.Values) { try { $null=$process.ReadTeardown(5000) } catch { $failure += '; root readback: ' + $_.Exception.Message } }
    Save-State 'failed' $failure
    throw
} finally {
    if ($pipe) { $pipe.Dispose() }
    # Credential release and success are different: only a complete actual stage
    # with positive teardown may obtain a distinct issuer credential later.
    if ($credential -and -not $hostedMode) { $credential.Dispose() }
    foreach ($process in $roots.Values) { $process.Dispose() }
    if (-not $hostedMode) { $group.Dispose() }
}
