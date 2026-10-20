Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

# Fixed harness transport only. These functions neither accept a native stage
# nor read a Checks/signing credential. The producer must own its invocation.
function Open-PortcoveNativeAccountSession {
    param([Parameter(Mandatory)][string]$BindingPath,
          [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBindingSha256)
    $item=Get-Item -LiteralPath $BindingPath -Force
    if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 16384 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native binding must be a bounded regular file' }
    if ((Get-FileHash -LiteralPath $BindingPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedBindingSha256) { throw 'Native binding changed' }
    $binding=Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json
    $names=@('invocation_id','configuration_sha256','helper_sha256','broker_pid','broker_created_filetime','capture_root','account_sid','profile_root','work_root','powershell','desktop_tools','controller_root')
    if ((@($binding.PSObject.Properties.Name | Sort-Object) -join '|') -cne (($names | Sort-Object) -join '|')) { throw 'Native binding schema differs' }
    foreach ($name in @('invocation_id','configuration_sha256','helper_sha256')) {
        if ($binding.$name -isnot [string] -or $binding.$name -cnotmatch '^[a-f0-9]{64}$') { throw 'Native binding digest absent' }
    }
    if ($binding.broker_created_filetime -isnot [string] -or $binding.broker_created_filetime -cnotmatch '^[1-9][0-9]+$' -or
        $binding.broker_pid -lt 1 -or $binding.broker_pid -gt [int]::MaxValue) { throw 'Native broker identity absent' }
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ([Security.Principal.SecurityIdentifier]::new($binding.account_sid).Value -eq $owner) { throw 'Candidate account must differ from harness owner' }
    foreach ($name in @('capture_root','profile_root','work_root')) {
        if (-not [IO.Path]::IsPathFullyQualified($binding.$name) -or $binding.$name.StartsWith('\\')) { throw 'Native binding requires local absolute roots' }
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $binding.controller_root 'scripts')),[IO.Path]::GetFullPath($PSScriptRoot),[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer account adapter must use the fixed protected controller root'
    }
    if ([IO.Path]::GetFullPath($binding.capture_root).StartsWith([IO.Path]::GetFullPath($binding.work_root).TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals([IO.Path]::GetFullPath($binding.capture_root),[IO.Path]::GetFullPath($binding.work_root),[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Owner capture cannot be candidate-writable work storage'
    }
    $runtime=[Environment]::ProcessPath
    if (-not [string]::Equals([IO.Path]::GetFullPath($runtime),[IO.Path]::GetFullPath($binding.powershell.path),[StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant() -cne $binding.powershell.sha256) { throw 'Native harness PowerShell runtime differs' }
    [pscustomobject]@{ binding=$binding; ambiguous=$false; failures=[Collections.Generic.List[object]]::new(); authority='none'; keeper=$null }
}

function Invoke-PortcoveNativeAccountCommand {
    param([Parameter(Mandatory)]$Session,
          [Parameter(Mandatory)][ValidateSet('start','observe','close','stop','readback','finish')][string]$Operation,
          [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,63}$')][string]$Id,
          $Launch=$null,$Target=$null)
    if ($Session.ambiguous -and $Operation -notin @('observe','readback','finish')) { throw 'Native outcome requires explicit recovery; effect cannot repeat' }
    $binding=$Session.binding
    $statePath=Join-Path $binding.capture_root 'bridge-state.json'
    $stateItem=Get-Item -LiteralPath $statePath -Force
    if ($stateItem.Length -gt 65536 -or ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native bridge state exceeds bounds' }
    $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.schema_version -ne 1 -or $state.authority -cne 'none' -or
        $state.invocation_id -cne $binding.invocation_id -or $state.configuration_sha256 -cne $binding.configuration_sha256 -or
        $state.broker_pid -ne $binding.broker_pid -or $state.broker_created_filetime -cne $binding.broker_created_filetime -or
        $state.phase -notin @('prepared','running') -or $state.sequence -lt 0 -or $state.sequence -ge 512) { throw 'Native bridge identity or state differs' }
    $sequence=[int]$state.sequence+1
    $request=[ordered]@{ schema_version=1; invocation_id=$binding.invocation_id; sequence=$sequence; operation=$Operation; id=$Id; launch=$Launch; target=$Target }
    $text=$request | ConvertTo-Json -Depth 8 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 24000) { throw 'Native request exceeds fixed bound' }
    $arguments=@{ InvocationId=$binding.invocation_id; BrokerPid=$binding.broker_pid; BrokerCreatedFileTime=$binding.broker_created_filetime;
        ExpectedHelperSha256=$binding.helper_sha256; RequestBase64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
    try {
        $replyText=& (Join-Path $PSScriptRoot 'native-qualification-account-client.ps1') @arguments
        $reply=$replyText | ConvertFrom-Json
        if ($reply.schema_version -ne 1 -or $reply.invocation_id -cne $binding.invocation_id -or $reply.sequence -ne $sequence -or $reply.broker_pid -ne $binding.broker_pid) { throw 'Native reply identity differs' }
        return $reply.value
    } catch {
        $Session.ambiguous=$true
        $Session.failures.Add([ordered]@{ operation=$Operation; id=$Id; sequence=$sequence; message=$_.Exception.Message })
        throw
    }
}

function Get-PortcoveNativeAccountEnvironment {
    param([Parameter(Mandatory)]$Session,[hashtable]$Runtime=@{})
    $binding=$Session.binding
    $profile=[IO.Path]::GetFullPath($binding.profile_root)
    $drive=[IO.Path]::GetPathRoot($profile)
    $result=[ordered]@{ SystemRoot=$env:SystemRoot; WINDIR=$env:SystemRoot; PATH=(Join-Path $env:SystemRoot 'System32');
        USERPROFILE=$profile; HOMEDRIVE=$drive.TrimEnd('\'); HOMEPATH=$profile.Substring($drive.Length-1);
        APPDATA=(Join-Path $binding.work_root 'APPDATA'); LOCALAPPDATA=(Join-Path $binding.work_root 'LOCALAPPDATA');
        TEMP=(Join-Path $binding.work_root 'TEMP'); TMP=(Join-Path $binding.work_root 'TMP') }
    $allowed=@('PORTCOVE_LIBRARY','PORTCOVE_PREFERENCES','PORTCOVE_APPLICATION_UPDATE_PREFERENCES','PORTCOVE_APPLICATION_UPDATE_SCHEDULE',
        'PORTCOVE_APPLICATION_UPDATE_STAGING','WEBVIEW2_USER_DATA_FOLDER','PORTCOVE_QUALIFICATION_CATALOG','PORTCOVE_QUALIFICATION_CHECKPOINT',
        'PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL','TAURI_WEBDRIVER_PORT','PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE')
    foreach ($entry in $Runtime.GetEnumerator()) {
        if ($entry.Key -cnotin $allowed -or $entry.Value -isnot [string]) { throw 'Unreviewed runtime environment field' }
        $result[$entry.Key]=$entry.Value
    }
    return $result
}

function Start-PortcoveNativeAccountRoot {
    param([Parameter(Mandatory)]$Session,[Parameter(Mandatory)][string]$Id,
          [Parameter(Mandatory)][string]$Executable,[string[]]$Arguments=@(),
          [Parameter(Mandatory)][string]$Directory,[hashtable]$Runtime=@{},[switch]$Nsis,[string]$TemporaryRoot)
    $environment=Get-PortcoveNativeAccountEnvironment $Session $Runtime
    if ($TemporaryRoot) {
        $exactTemp=[IO.Path]::GetFullPath($TemporaryRoot)
        if (-not $exactTemp.StartsWith([IO.Path]::GetFullPath($Session.binding.work_root).TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Native temporary root escaped qualification work storage'
        }
        $environment.TEMP=$exactTemp; $environment.TMP=$exactTemp
    }
    $launch=[ordered]@{ executable=[IO.Path]::GetFullPath($Executable);
        sha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant();
        arguments=@($Arguments); directory=$Directory; environment=$environment; nsis=[bool]$Nsis }
    Invoke-PortcoveNativeAccountCommand $Session start $Id $launch
}

function Start-PortcoveNativeProfileKeeper {
    param([Parameter(Mandatory)]$Session)
    if ($Session.keeper -ne $null) { throw 'Native profile keeper cannot repeat' }
    $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Fixed inert command only; no candidate script, profile or stdin.
    $identity=Start-PortcoveNativeAccountRoot $Session 'profile-keeper' $exe @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 1800') (Join-Path $Session.binding.work_root 'keeper')
    $Session.keeper=$identity
    Get-PortcoveNativeRegistryRoot $Session
}

function Get-PortcoveNativeRegistryRoot {
    param([Parameter(Mandatory)]$Session)
    if ($Session.keeper -eq $null) { throw 'Native loaded-profile lifetime is not established' }
    $observed=Invoke-PortcoveNativeAccountCommand $Session observe 'profile-keeper'
    if ($observed.exited -isnot [bool] -or $observed.exited) { throw 'Native profile keeper exited; HKCU cannot be inferred' }
    $root='Registry::HKEY_USERS\' + $Session.binding.account_sid
    if (-not (Test-Path -LiteralPath $root)) { throw 'Actual qualification-account hive is unavailable' }
    return $root
}

function Update-PortcoveNativeProcessProxy {
    param([Parameter(Mandatory)]$Process)
    $observed=Invoke-PortcoveNativeAccountCommand $Process.NativeSession observe $Process.NativeRootId
    if ($observed.exited -isnot [bool] -or $observed.responding -isnot [bool]) { throw 'Native process observation incomplete' }
    if (-not $observed.exited) {
        $root=@($observed.processes | Where-Object { $_.pid -eq $Process.Id })
        if ($root.Count -ne 1 -or $root[0].started_filetime -cne $Process.NativeCreatedFileTime -or
            -not [string]::Equals($root[0].path,$Process.Path,[StringComparison]::OrdinalIgnoreCase)) { throw 'Native root identity changed' }
    } elseif ($observed.exit_code -isnot [int] -and $observed.exit_code -isnot [long]) { throw 'Native exit code unavailable' }
    $Process.HasExited=$observed.exited
    $Process.ExitCode=$observed.exit_code
    $Process.Responding=$observed.responding
    $Process.MainWindowTitle=[string]$observed.window_title
    $Process.MainWindowHandle=[IntPtr]::new([long]$observed.window_handle)
    $Process.NativeInventory=@($observed.processes)
}

function New-PortcoveNativeProcessProxy {
    param([Parameter(Mandatory)]$Session,[Parameter(Mandatory)][string]$Id,[Parameter(Mandatory)]$Identity)
    if ($Identity.pid -lt 1 -or $Identity.started_filetime -isnot [string] -or $Identity.started_filetime -cnotmatch '^[1-9][0-9]+$' -or
        -not [IO.Path]::IsPathFullyQualified($Identity.path)) { throw 'Native launch identity incomplete' }
    # These are a cached observation and explicit remote methods, not fabricated
    # local kernel handles. Every Refresh/Wait/Kill goes through the verified
    # owner pipe. Failed methods throw before replacing the last observation.
    $process=[pscustomobject]@{ NativeSession=$Session; NativeRootId=$Id; NativeCreatedFileTime=$Identity.started_filetime;
        NativeInventory=@(); NativeStopped=$false; NativeDisposed=$false; Id=[int]$Identity.pid;
        Path=[string]$Identity.path; StartInfo=[pscustomobject]@{ FileName=[string]$Identity.path };
        StartTime=[DateTime]::FromFileTimeUtc([long]$Identity.started_filetime); HasExited=$false; ExitCode=$null;
        Responding=$false; MainWindowTitle=''; MainWindowHandle=[IntPtr]::Zero }
    $process | Add-Member ScriptMethod Refresh { Update-PortcoveNativeProcessProxy $this }
    $process | Add-Member ScriptMethod WaitForExit {
        param([int]$Milliseconds)
        if ($Milliseconds -lt 0 -or $Milliseconds -gt 600000) { throw 'Invalid native wait budget' }
        $clock=[Diagnostics.Stopwatch]::StartNew()
        do {
            Update-PortcoveNativeProcessProxy $this
            if ($this.HasExited) { return $true }
            if ($clock.ElapsedMilliseconds -ge $Milliseconds) { return $false }
            Start-Sleep -Milliseconds 100
        } while ($true)
    }
    $process | Add-Member ScriptMethod Kill {
        param([bool]$EntireProcessTree)
        if (-not $EntireProcessTree) { throw 'Native cleanup always owns the complete root job' }
        if ($this.NativeStopped) { $observation=Invoke-PortcoveNativeAccountCommand $this.NativeSession readback $this.NativeRootId }
        else {
            # Latch before the request; an ambiguous reply cannot repeat stop.
            $this.NativeStopped=$true
            $observation=Invoke-PortcoveNativeAccountCommand $this.NativeSession stop $this.NativeRootId
        }
        if ($observation.root_pid -ne $this.Id -or $observation.root_created_filetime -cne $this.NativeCreatedFileTime -or
            $observation.root_exited -isnot [bool] -or -not $observation.root_exited -or
            $observation.job_empty -isnot [bool] -or -not $observation.job_empty -or @($observation.remaining_pids).Count -ne 0 -or
            ($observation.exit_code -isnot [int] -and $observation.exit_code -isnot [long])) { throw 'Native cleanup lacks positive exact-root teardown' }
        $this.HasExited=$true; $this.ExitCode=[long]$observation.exit_code
    }
    $process | Add-Member ScriptMethod CloseMainWindow {
        $value=Invoke-PortcoveNativeAccountCommand $this.NativeSession close $this.NativeRootId
        if ($value.accepted -isnot [bool]) { throw 'Native close result unavailable' }
        return $value.accepted
    }
    $process | Add-Member ScriptMethod Dispose {
        # Actual handles remain with the broker until all stage groups settle.
        # Disposing this local view is not positive teardown or credential release.
        $this.NativeDisposed=$true
    }
    return $process
}

Export-ModuleMember -Function Open-PortcoveNativeAccountSession,Invoke-PortcoveNativeAccountCommand,Get-PortcoveNativeAccountEnvironment,Start-PortcoveNativeAccountRoot,Start-PortcoveNativeProfileKeeper,Get-PortcoveNativeRegistryRoot,New-PortcoveNativeProcessProxy,Update-PortcoveNativeProcessProxy
