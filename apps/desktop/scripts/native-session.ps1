param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'Wait')][string]$Mode,
    [int]$DriverProcessId,
    [string]$ApplicationPath,
    [Parameter(Mandatory)][string]$SnapshotPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
if ($Mode -eq 'Snapshot') {
    $tree = Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
    $records = @($tree.processes | ForEach-Object {
        $entry = $_
        $process = try { [Diagnostics.Process]::GetProcessById([int]$entry.ProcessId) } catch [ArgumentException] { $null }
        if ($process) {
            try {
                $started = $process.StartTime.ToUniversalTime()
                if ([Math]::Abs(($started - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
                    -not [string]::Equals($process.MainModule.FileName, $entry.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native process identity changed during snapshot.' }
                [pscustomobject]@{ pid = $entry.ProcessId; path = $entry.ExecutablePath; started_filetime = $process.StartTime.ToFileTimeUtc() }
            } catch [InvalidOperationException] {
                if (-not $process.HasExited) { throw }
            } finally { $process.Dispose() }
        }
    })
    $snapshot = [pscustomobject]@{ captured_at = [DateTime]::UtcNow.ToString('o'); application_pid = $tree.application.ProcessId; processes = $records }
    $stream = [IO.File]::Open($SnapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    $snapshot | ConvertTo-Json -Depth 4 -Compress
    exit
}
$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
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
