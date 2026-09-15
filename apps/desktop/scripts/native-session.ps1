param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'StopDriver', 'Wait')][string]$Mode,
    [int]$DriverProcessId,
    [string]$ApplicationPath,
    [Parameter(Mandatory)][string]$SnapshotPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
if ($Mode -eq 'Snapshot') {
    $tree = Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
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
    $snapshot = [pscustomobject]@{ captured_at = [DateTime]::UtcNow.ToString('o'); driver = $driverRecord; application_pid = $tree.application.ProcessId; processes = $records }
    $stream = [IO.File]::Open($SnapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    $snapshot | ConvertTo-Json -Depth 4 -Compress
    exit
}
$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
if ($Mode -eq 'StopDriver') {
    $process = try { [Diagnostics.Process]::GetProcessById([int]$snapshot.driver.pid) } catch [ArgumentException] { $null }
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
