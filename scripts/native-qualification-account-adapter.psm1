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
    $harnessRoot=$binding.controller_root
    if ($binding.PSObject.Properties['hosted']) {
        $names+=@('hosted')
        if ((@($binding.hosted.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'harness_root,profile,registry_sha256' -or
            $binding.hosted.profile -cne 'hosted-windows-worker-v1' -or
            $binding.hosted.registry_sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Closed hosted harness binding required' }
        $harnessRoot=$binding.hosted.harness_root
        foreach($root in @($harnessRoot,$binding.controller_root,$binding.work_root)) {
            if ($root -isnot [string] -or $root.Length -gt 4096 -or $root -cnotmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':') -or
                [IO.Path]::GetFullPath($root) -cne $root) { throw 'Canonical local hosted binding roots required' }
            foreach($part in $root.Substring(3).Split('\')) {
                if (-not $part -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Hosted binding root alias refused' }
            }
        }
        if ([string]::Equals($harnessRoot,$binding.controller_root,[StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($binding.work_root) -cne 'work') { throw 'Separate fixed hosted roots required' }
    }
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
    if (-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $harnessRoot 'scripts')),[IO.Path]::GetFullPath($PSScriptRoot),[StringComparison]::OrdinalIgnoreCase)) {
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
    if ($null -ne $Session.keeper) { throw 'Native profile keeper cannot repeat' }
    if ($Session.binding.invocation_id -cnotmatch '^[a-f0-9]{64}$') { throw 'Native keeper requires exact invocation' }
    $work=[IO.Path]::GetFullPath($Session.binding.work_root)
    $cursor=$work
    while ($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native keeper work ancestry differs' }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor=$parent
    }
    $directory=Join-Path $work ('keeper-' + $Session.binding.invocation_id)
    # New-Item without Force refuses a retained directory. This is prepared
    # before any candidate root, never assumed to exist from manual setup.
    $null=New-Item -ItemType Directory -Path $directory -ErrorAction Stop
    $item=Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native keeper directory changed' }
    $Session | Add-Member NoteProperty keeper_directory $directory
    $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Fixed inert command only; no candidate script, profile or stdin.
    $identity=Start-PortcoveNativeAccountRoot $Session 'profile-keeper' $exe @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 1800') $directory
    $Session.keeper=$identity
    Get-PortcoveNativeRegistryRoot $Session
}

function Get-PortcoveNativeRegistryRoot {
    param([Parameter(Mandatory)]$Session)
    if ($null -eq $Session.keeper) { throw 'Native loaded-profile lifetime is not established' }
    $observed=Invoke-PortcoveNativeAccountCommand $Session observe 'profile-keeper'
    if ($observed.exited -isnot [bool] -or $observed.exited) { throw 'Native profile keeper exited; HKCU cannot be inferred' }
    $null=Read-PortcoveNativeOwnRegistry $Session
    return 'Registry::HKEY_CURRENT_USER'
}

function Read-PortcoveNativeOwnRegistry {
    param([Parameter(Mandatory)]$Session)
    if ($null -eq $Session.keeper) { throw 'Native loaded-profile lifetime is not established' }
    if (-not $Session.PSObject.Properties['registry_sequence']) { $Session | Add-Member NoteProperty registry_sequence 0 }
    # Lifetime roots remain inside the existing 64-root bound, including keeper,
    # installer, application, driver and cleanup roots. No retry launch on failure.
    if ($Session.registry_sequence -ge 16) { throw 'Fixed registry observation budget exhausted' }
    $Session.registry_sequence++
    $id='registry-' + $Session.registry_sequence.ToString('000')
    $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $reader=Join-Path $PSScriptRoot 'native-qualification-account-registry.ps1'
    if($Session.binding.PSObject.Properties['hosted']) {
        $reader=Join-Path ([IO.Path]::GetDirectoryName($Session.binding.work_root)) 'readonly/native-qualification-account-registry.ps1'
        $item=Get-Item -LiteralPath $reader -Force
        if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 131072 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            (Get-FileHash -LiteralPath $reader -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Session.binding.hosted.registry_sha256) { throw 'Hosted staged registry reader changed' }
    }
    $root=Start-PortcoveNativeAccountRoot $Session $id $exe @('-NoLogo','-NoProfile','-NonInteractive','-File',$reader,'-Invocation',$Session.binding.invocation_id) $Session.keeper_directory
    $done=Invoke-PortcoveNativeAccountCommand $Session readback $id
    if ($done.root_pid -ne $root.pid -or $done.root_created_filetime -cne $root.started_filetime -or
        $done.root_exited -isnot [bool] -or -not $done.root_exited -or $done.job_empty -isnot [bool] -or -not $done.job_empty -or @($done.remaining_pids).Count -ne 0 -or
        ($done.exit_code -isnot [int] -and $done.exit_code -isnot [long]) -or $done.exit_code -ne 0) { throw 'Fixed registry reader lacks successful exact-root settlement' }
    $streams=@{}
    foreach ($stream in @('stdout','stderr')) {
        $file=Join-Path $Session.binding.capture_root ($id+'.'+$stream+'.bin')
        $streams[$stream]=Read-PortcoveNativeRegistryCapture $file
    }
    if ($streams.stderr.Length -ne 0) { throw 'Fixed registry reader retained stderr' }
    $value=$streams.stdout | ConvertFrom-Json
    $expected=@('schema_version','invocation','pid','account_sid','profile','hive_present','provenance','authority','uninstall','webview')
    if ((@($value.PSObject.Properties.Name | Sort-Object) -join '|') -cne (($expected|Sort-Object)-join '|') -or
        $value.schema_version -ne 1 -or $value.invocation -cne $Session.binding.invocation_id -or $value.pid -ne $root.pid -or
        $value.account_sid -cne $Session.binding.account_sid -or $value.hive_present -isnot [bool] -or -not $value.hive_present -or
        $value.provenance -cne 'target-account-HKCU' -or $value.authority -cne 'none' -or
        -not [string]::Equals([IO.Path]::GetFullPath($value.profile),[IO.Path]::GetFullPath($Session.binding.profile_root),[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixed target-account registry identity differs' }
    foreach ($kind in @('uninstall','webview')) {
        $tail=if($kind -eq 'uninstall'){'Software\Microsoft\Windows\CurrentVersion\Uninstall\'}else{'Software\Microsoft\EdgeUpdate\Clients\'}
        $fields=if($kind -eq 'uninstall'){@('PSPath','account_sid','DisplayName','DisplayVersion','InstallLocation','UninstallString','QuietUninstallString')}else{@('PSPath','account_sid','name','pv')}
        if ($value.$kind -isnot [array] -or $value.$kind.Count -gt 128) { throw 'Fixed registry records exceed bounds' }
        foreach ($record in $value.$kind) {
            if ((@($record.PSObject.Properties.Name|Sort-Object)-join '|') -cne (($fields|Sort-Object)-join '|') -or
                $record.account_sid -cne $Session.binding.account_sid -or
                -not $record.PSPath.StartsWith('Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\'+$tail,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixed own-HKCU record provenance differs' }
            foreach($field in $fields) { if($record.$field -isnot [string] -or $record.$field.Length -gt 8192){throw 'Fixed registry record value exceeds bounds'} }
        }
    }
    return $value
}

function Read-PortcoveNativeRegistryCapture {
    param([Parameter(Mandatory)][string]$Path)
    $before=Get-Item -LiteralPath $Path -Force
    if ($before.PSIsContainer -or $before.Length -gt 65536 -or ($before.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixed registry capture exceeds bounds' }
    # Read sharing denies concurrent write/delete/replacement for the entire
    # held lifetime, including the final path/handle metadata comparison.
    $file=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $handle=$file.SafeFileHandle
        $created=[IO.File]::GetCreationTimeUtc($handle)
        $written=[IO.File]::GetLastWriteTimeUtc($handle)
        $attributes=[IO.File]::GetAttributes($handle)
        if ($file.Length -ne $before.Length -or $created -ne $before.CreationTimeUtc -or $written -ne $before.LastWriteTimeUtc -or
            ($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory))) { throw 'Fixed registry capture changed before held read' }
        $buffer=[byte[]]::new(65537);$count=0
        do {
            $read=$file.Read($buffer,$count,$buffer.Length-$count)
            $count+=$read
            if ($count -gt 65536) { throw 'Fixed registry capture overflow during held read' }
        } while ($read -gt 0)
        $after=Get-Item -LiteralPath $Path -Force
        if ($after.PSIsContainer -or ($after.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $count -ne $before.Length -or $file.Length -ne $count -or $after.Length -ne $count -or
            $after.CreationTimeUtc -ne $created -or $after.LastWriteTimeUtc -ne $written -or
            [IO.File]::GetCreationTimeUtc($handle) -ne $created -or [IO.File]::GetLastWriteTimeUtc($handle) -ne $written) { throw 'Fixed registry capture identity changed during held read' }
        return [Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$count)
    } finally { $file.Dispose() }
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

Export-ModuleMember -Function Open-PortcoveNativeAccountSession,Invoke-PortcoveNativeAccountCommand,Get-PortcoveNativeAccountEnvironment,Start-PortcoveNativeAccountRoot,Start-PortcoveNativeProfileKeeper,Get-PortcoveNativeRegistryRoot,Read-PortcoveNativeOwnRegistry,New-PortcoveNativeProcessProxy,Update-PortcoveNativeProcessProxy
