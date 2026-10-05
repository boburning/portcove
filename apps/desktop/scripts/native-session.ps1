param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'SnapshotDriver', 'SnapshotDriverTree', 'SnapshotApplication', 'ApplicationListener', 'RequestClose', 'Observe', 'StopApplication', 'StopDriver', 'Wait')][string]$Mode,
    [int]$DriverProcessId,
    [string]$ApplicationPath,
    [int]$ExpectedParentProcessId,
    [string]$ExpectedApplicationSha256,
    [int]$Port,
    [Parameter(Mandatory)][string]$SnapshotPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
if ($Mode -eq 'Snapshot' -or $Mode -eq 'SnapshotDriver' -or $Mode -eq 'SnapshotDriverTree' -or $Mode -eq 'SnapshotApplication') {
    $tree = if ($Mode -eq 'Snapshot') {
        Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
    } elseif ($Mode -eq 'SnapshotDriverTree') {
        Get-OwnedDriverProcessTree $DriverProcessId
    } elseif ($Mode -eq 'SnapshotApplication') {
        $owned = Get-OwnedDriverProcessTree $DriverProcessId
        $root = $owned.driver
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ExpectedParentProcessId"
        # Keep the existing short-circuit order and reject before publishing a
        # snapshot. Report the failed check, not paths, arguments or environment.
        $identityFailure = if ($ExpectedParentProcessId -le 0) { 'invalid-parent-id' }
            elseif (-not $parent) { 'parent-not-running' }
            elseif (-not $parent.CreationDate) { 'parent-creation-unavailable' }
            elseif ($root.ParentProcessId -ne $ExpectedParentProcessId) { 'parent-id-mismatch' }
            elseif (-not $root.CreationDate) { 'application-creation-unavailable' }
            elseif ($parent.CreationDate -gt $root.CreationDate) { 'parent-newer-than-application' }
            elseif (-not [string]::Equals($root.ExecutablePath, (Resolve-Path -LiteralPath $ApplicationPath).Path, [StringComparison]::OrdinalIgnoreCase)) { 'executable-path-mismatch' }
            elseif ($ExpectedApplicationSha256 -notmatch '^[0-9a-f]{64}$') { 'invalid-expected-hash' }
            elseif ((Get-FileHash -LiteralPath $ApplicationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedApplicationSha256) { 'executable-hash-mismatch' }
        if ($identityFailure) {
            throw "Embedded application identity rejected: $identityFailure."
        }
        [pscustomobject]@{ driver = $root; application = $root; processes = @($root) + @($owned.processes) }
    } else {
        $entry = Get-CimInstance Win32_Process -Filter "ProcessId = $DriverProcessId"
        if (-not $entry) { throw 'Owned driver is no longer running.' }
        [pscustomobject]@{ driver = $entry; application = $null; processes = @() }
    }
    $driverProcess = try { [Diagnostics.Process]::GetProcessById([int]$tree.driver.ProcessId) } catch [ArgumentException] { $null }
    if (-not $driverProcess) { throw 'Owned driver exited during snapshot.' }
    try {
        if ([Math]::Abs(($driverProcess.StartTime.ToUniversalTime() - $tree.driver.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
            -not [string]::Equals($driverProcess.MainModule.FileName, $tree.driver.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Owned driver identity changed during snapshot.' }
        $driverRecord = [pscustomobject]@{ pid = $tree.driver.ProcessId; path = $tree.driver.ExecutablePath; started_filetime = $driverProcess.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
    } finally { $driverProcess.Dispose() }
    $records = @($tree.processes | ForEach-Object {
        $entry = $_
        $process = try { [Diagnostics.Process]::GetProcessById([int]$entry.ProcessId) } catch [ArgumentException] { $null }
        if ($process) {
            try {
                $started = $process.StartTime.ToUniversalTime()
                if ([Math]::Abs(($started - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
                    -not [string]::Equals($process.MainModule.FileName, $entry.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native process identity changed during snapshot.' }
                [pscustomobject]@{ pid = $entry.ProcessId; path = $entry.ExecutablePath; started_filetime = $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
            } catch [InvalidOperationException] {
                if (-not $process.HasExited) { throw }
            } finally { $process.Dispose() }
        }
    })
    $applicationPid = if ($tree.application) { $tree.application.ProcessId } else { $null }
    $snapshot = [pscustomobject]@{ captured_at = [DateTime]::UtcNow.ToString('o'); driver = $driverRecord; application_pid = $applicationPid; processes = $records }
    if ($Mode -eq 'SnapshotApplication') {
        $snapshot | Add-Member root_kind 'direct-application'
        $snapshot | Add-Member executable_sha256 $ExpectedApplicationSha256
    }
    $stream = [IO.File]::Open($SnapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    $snapshot | ConvertTo-Json -Depth 4 -Compress
    exit
}
$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
if ($Mode -eq 'Observe') {
    $observed = foreach ($record in $snapshot.processes) {
        $process = try { [Diagnostics.Process]::GetProcessById([int]$record.pid) } catch [ArgumentException] { $null }
        $state = 'exited'
        if ($process) {
            try {
                if ($process.StartTime.ToFileTimeUtc() -eq $record.started_filetime) {
                    if (-not [string]::Equals($process.MainModule.FileName, $record.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured process path changed during observation.' }
                    $state = 'running'
                }
            } catch [InvalidOperationException] {
                if (-not $process.HasExited) { throw }
            } finally { $process.Dispose() }
        }
        [pscustomobject]@{ pid = $record.pid; started_filetime = $record.started_filetime; path = $record.path; state = $state }
    }
    [pscustomobject]@{ observed_at = [DateTime]::UtcNow.ToString('o'); processes = @($observed) } | ConvertTo-Json -Depth 4 -Compress
    exit
}
if ($Mode -eq 'RequestClose') {
    $records = @($snapshot.processes | Where-Object pid -eq $snapshot.application_pid)
    if ($records.Count -ne 1 -or $snapshot.application_pid -eq $snapshot.driver.pid -or
        -not [string]::Equals($records[0].path, (Resolve-Path -LiteralPath $ApplicationPath).Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Exactly one captured owned application is required for ordinary close.'
    }
    $driver = try { [Diagnostics.Process]::GetProcessById([int]$snapshot.driver.pid) } catch [ArgumentException] { $null }
    if (-not $driver) { throw 'Captured driver exited before ordinary close.' }
    try {
        if ($driver.StartTime.ToFileTimeUtc() -ne $snapshot.driver.started_filetime -or
            -not [string]::Equals($driver.MainModule.FileName, $snapshot.driver.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured driver identity changed before ordinary close.' }
    } finally { $driver.Dispose() }
    $record = $records[0]
    $process = try { [Diagnostics.Process]::GetProcessById([int]$record.pid) } catch [ArgumentException] { $null }
    if (-not $process) { throw 'Captured application exited before ordinary close.' }
    try {
        if ($process.StartTime.ToFileTimeUtc() -ne $record.started_filetime -or
            -not [string]::Equals($process.MainModule.FileName, $record.path, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Captured application identity changed before ordinary close.'
        }
        if (-not $process.CloseMainWindow()) { throw 'The ordinary close message was not sent; no enabled main window was found.' }
        # A sent native close request is not evidence that the application exited.
        # The caller retains a distinct identity-bound Wait observation.
        [pscustomobject]@{ requested_at = [DateTime]::UtcNow.ToString('o'); application_pid = $process.Id; started_filetime = $record.started_filetime; method = 'identity-bound-native-main-window-close-request'; message_sent = $true } | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
    exit
}
if ($Mode -eq 'ApplicationListener') {
    if ($snapshot.root_kind -ne 'direct-application' -or $Port -lt 1 -or $Port -gt 65535) { throw 'Invalid embedded listener identity request.' }
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$snapshot.driver.pid)"
    if (-not $entry -or [Math]::Abs(($entry.CreationDate.ToUniversalTime() - [DateTime]::FromFileTimeUtc([long]$snapshot.driver.started_filetime)).TotalMilliseconds) -gt 1 -or
        -not [string]::Equals($entry.ExecutablePath, $snapshot.driver.path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Embedded application identity changed before listener verification.'
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port)
    if ($listeners.Count -eq 0) { '{"ready":false}'; exit }
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $snapshot.driver.pid) {
        throw 'Embedded listener is not exclusively owned by the retained application on loopback.'
    }
    [pscustomobject]@{ ready = $true; pid = $snapshot.driver.pid; address = '127.0.0.1'; port = $Port; started_filetime = $snapshot.driver.started_filetime } | ConvertTo-Json -Compress
    exit
}
if ($Mode -eq 'StopDriver' -or $Mode -eq 'StopApplication') {
    if ($Mode -eq 'StopApplication' -and $snapshot.root_kind -ne 'direct-application') { throw 'Application cleanup requires an application-root snapshot.' }
    $process = try { [Diagnostics.Process]::GetProcessById([int]$snapshot.driver.pid) } catch [ArgumentException] { $null }
    if (-not $process -and $Mode -eq 'StopApplication') {
        $terminated = @()
        foreach ($record in $snapshot.processes) {
            $owned = try { [Diagnostics.Process]::GetProcessById([int]$record.pid) } catch [ArgumentException] { $null }
            if (-not $owned) { continue }
            try {
                # An exited root cannot confer authority over new descendants.
                # Stop only individually captured, still identical survivors.
                if ($owned.StartTime.ToFileTimeUtc() -ne $record.started_filetime) { continue }
                if (-not [string]::Equals($owned.MainModule.FileName, $record.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured application descendant path changed.' }
                $owned.Kill()
                $terminated += $owned.Id
            } catch [InvalidOperationException] {
                if (-not $owned.HasExited) { throw }
            } finally { $owned.Dispose() }
        }
        [pscustomobject]@{ method = 'captured-application-survivors'; terminated_survivors = $terminated } | ConvertTo-Json -Compress
        exit
    }
    if (-not $process) { throw 'Captured driver exited before isolated tree termination.' }
    try {
        if ($process.StartTime.ToFileTimeUtc() -ne $snapshot.driver.started_filetime -or
            -not [string]::Equals($process.MainModule.FileName, $snapshot.driver.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured driver identity changed before isolated tree termination.' }
        $output = & taskkill.exe /PID ([string]$process.Id) /T /F 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Could not terminate the captured isolated driver tree: $output" }
        $terminated = @()
        foreach ($record in $snapshot.processes) {
            $owned = try { [Diagnostics.Process]::GetProcessById([int]$record.pid) } catch [ArgumentException] { $null }
            if (-not $owned) { continue }
            try {
                if ($owned.StartTime.ToFileTimeUtc() -ne $record.started_filetime -or
                    -not [string]::Equals($owned.MainModule.FileName, $record.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured isolated process identity changed before termination.' }
                $owned.Kill($true)
                $terminated += $owned.Id
            } catch [InvalidOperationException] {
                if (-not $owned.HasExited) { throw }
            } finally { $owned.Dispose() }
        }
        [pscustomobject]@{ stopped_at = [DateTime]::UtcNow.ToString('o'); driver_pid = $process.Id; method = 'identity-bound-isolated-tree-termination'; terminated_survivors = $terminated } | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
    exit
}
$watch = [Diagnostics.Stopwatch]::StartNew()
foreach ($record in $snapshot.processes) {
    $process = try { [Diagnostics.Process]::GetProcessById([int]$record.pid) } catch [ArgumentException] { $null }
    if (-not $process) { continue }
    try {
        # A reused PID proves the captured process already exited. Never act on it.
        if ($process.StartTime.ToFileTimeUtc() -ne $record.started_filetime) { continue }
        if (-not [string]::Equals($process.MainModule.FileName, $record.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured process path changed.' }
        $remaining = [Math]::Max(0, 5000 - [int]$watch.ElapsedMilliseconds)
        if (-not $process.WaitForExit($remaining)) { throw "Captured native process $($record.pid) did not exit within the shared five-second bound." }
    } catch [InvalidOperationException] {
        if (-not $process.HasExited) { throw }
    } finally { $process.Dispose() }
}
[pscustomobject]@{ exited_at = [DateTime]::UtcNow.ToString('o'); observed_processes = @($snapshot.processes).Count; wait_ms = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
