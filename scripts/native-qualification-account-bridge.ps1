param(
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigurationSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$InvocationId
)
$ErrorActionPreference = 'Stop'

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
}
function Write-Capture([string]$Id, $Process) {
    foreach ($stream in @(@('stdout',$Process.OutputCapture),@('stderr',$Process.ErrorCapture))) {
        $path = Join-Path $configurationValue.capture_root ($Id + '.' + $stream[0] + '.bin')
        [IO.File]::WriteAllBytes($path, $stream[1].Snapshot())
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
        [ordered]@{ id=$_.Key; pid=$_.Value.Id; created_filetime=$_.Value.CreatedFileTime.ToString(); teardown=(Convert-Teardown $_.Value.LastTeardown) }
    })
    $state = [ordered]@{ schema_version=1; authority='none'; invocation_id=$InvocationId; configuration_sha256=$ExpectedConfigurationSha256;
        broker_pid=$PID; broker_created_filetime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()); sequence=$sequence;
        observed_at=[DateTime]::UtcNow.ToString('o'); phase=$Phase; failure=$Failure;
        roots=$records; group_remaining_pids=@($group.RemainingPids()); native_acceptance='not-established' }
    [IO.File]::WriteAllText((Join-Path $configurationValue.capture_root 'bridge-state.json'), ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
function Assert-CaptureHealthy {
    foreach ($process in $roots.Values) { $process.RefuseFaultedCapture() }
}

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Assert-OwnerFile $Configuration
if ((Get-FileHash -LiteralPath $Configuration -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedConfigurationSha256) { throw 'Bridge configuration changed' }
$configurationValue = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
Assert-ExactMembers $configurationValue @('schema_version','broker_sid','account_sid','account_name','profile_root','work_root','capture_root','helper_sha256')
if ($configurationValue.schema_version -ne 1 -or $configurationValue.broker_sid -cne $owner -or $configurationValue.account_sid -eq $owner) { throw 'Unratified bridge account boundary' }
$helper = Join-Path $PSScriptRoot 'native-qualification-account.cs.txt'
Assert-OwnerFile $helper
if ($configurationValue.helper_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configurationValue.helper_sha256) { throw 'Fixed bridge helper changed' }
Assert-OwnerFile $configurationValue.capture_root
if (-not (Get-Acl -LiteralPath $configurationValue.capture_root).AreAccessRulesProtected) { throw 'Capture inheritance is not protected' }
if (Test-Path -LiteralPath (Join-Path $configurationValue.capture_root 'bridge-state.json')) { throw 'Retained bridge invocation cannot be repeated' }
Add-Type -TypeDefinition (Get-Content -LiteralPath $helper -Raw)
$config = [Portcove.NativeQualification.AccountConfiguration]::new()
$config.UserName=$configurationValue.account_name; $config.AccountSid=$configurationValue.account_sid; $config.BrokerSid=$owner
$config.ProfileRoot=$configurationValue.profile_root; $config.WorkRoot=$configurationValue.work_root
$config.PrivateDesktop='PortcoveNative_' + $InvocationId.Substring(0,32) + '\Qualification'
$roots = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$group = [Portcove.NativeQualification.AccountLauncher]::CreateGroup($config)
$credential = $null; $pipe = $null; $groupStopped = $false; $finished = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$sequence=0
try {
    Save-State 'prepared'
    $credential = [Portcove.NativeQualification.AccountLauncher]::ReadAccountCredential($config)
    # One owner-only connection per command. Candidate roots have null stdin and
    # never receive this pipe name in their explicit environment.
    for ($sequence = 1; $sequence -le 512; $sequence++) {
        $pipe = [IO.Pipes.NamedPipeServerStream]::new('PortcoveNative_' + $InvocationId,
            [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte,
            [IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly)
        $waiting = $pipe.WaitForConnectionAsync()
        while (-not $waiting.IsCompleted) {
            Assert-CaptureHealthy
            if ($clock.Elapsed.TotalSeconds -ge 1800) { throw 'Native bridge fixed 1800-second deadline reached' }
            Start-Sleep -Milliseconds 25
        }
        $waiting.GetAwaiter().GetResult()
        $reading = [Portcove.NativeQualification.OwnerCommandReader]::ReadOne($pipe)
        $commandClock = [Diagnostics.Stopwatch]::StartNew()
        while (-not $reading.IsCompleted) {
            Assert-CaptureHealthy
            if ($commandClock.Elapsed.TotalSeconds -ge 5 -or $clock.Elapsed.TotalSeconds -ge 1800) { throw 'Incomplete bridge command deadline reached' }
            Start-Sleep -Milliseconds 25
        }
        $request = $reading.GetAwaiter().GetResult() | ConvertFrom-Json
        Assert-ExactMembers $request @('schema_version','invocation_id','sequence','operation','id','launch')
        if ($request.schema_version -ne 1 -or $request.invocation_id -cne $InvocationId -or $request.sequence -ne $sequence -or $request.id -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'Bridge command identity mismatch' }
        Assert-CaptureHealthy
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
                $process=[Portcove.NativeQualification.AccountLauncher]::StartVerifiedInGroup($group,$config,$credential,$launch.executable,$launch.sha256,[string[]]$launch.arguments,$launch.directory,$environment,$launch.nsis)
                $roots.Add($request.id,$process)
                $value=[ordered]@{ pid=$process.Id; path=$process.Path; started_filetime=$process.CreatedFileTime.ToString(); started_at=$process.StartTime.ToUniversalTime().ToString('o') }
            }
            'observe' {
                if ($request.launch -ne $null -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $process=$roots[$request.id]
                $exited=$process.HasExited
                $identities=@($process.SnapshotOwnedJob() | ForEach-Object { [ordered]@{ pid=$_.Pid; path=$_.Path; started_filetime=$_.CreatedFileTime.ToString() } })
                $value=[ordered]@{ exited=$exited; exit_code=$(if ($exited) {$process.ExitCode} else {$null}); processes=$identities; responding=$process.Responding; window_title=$process.MainWindowTitle }
            }
            'close' {
                if ($request.launch -ne $null -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $value=[ordered]@{ accepted=$roots[$request.id].CloseMainWindow() }
            }
            'stop' {
                if ($request.launch -ne $null -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $value=Convert-Teardown ($roots[$request.id].StopAndObserve(5000))
            }
            'readback' {
                if ($request.launch -ne $null -or -not $roots.ContainsKey($request.id)) { throw 'Unknown native root' }
                $value=Convert-Teardown ($roots[$request.id].ReadTeardown(5000))
            }
            'finish' {
                if ($request.launch -ne $null) { throw 'Finish cannot import launch data' }
                $groupStopped=$true
                $remaining=@($group.StopAndObserve(5000))
                if ($remaining.Count -ne 0) { throw 'Native group teardown remains incomplete' }
                foreach ($process in $roots.Values) {
                    $observed=$process.ReadTeardown(5000)
                    if (-not $observed.RootExited -or -not $observed.JobEmpty) { throw 'Native root teardown remains incomplete' }
                    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($process.Output,$process.ErrorOutput),5000)) { throw 'Native pipe completion remains incomplete' }
                    $process.RefuseFaultedCapture()
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
    if ($credential) { $credential.Dispose() }
    foreach ($process in $roots.Values) { $process.Dispose() }
    $group.Dispose()
}
