param(
    [Parameter(Mandatory)][ValidateSet('Capture', 'Wait', 'Stop')][string]$Mode,
    [Parameter(Mandatory)][string]$IdentityPath,
    [string]$MarkerPath,
    [string]$ExpectedPath,
    [string]$EarliestStart,
    [switch]$Helper
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Capture') {
    $marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    if ($marker.schema_version -ne 1 -or [int]$marker.process_id -le 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath($marker.executable), [IO.Path]::GetFullPath($ExpectedPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Marked updater process identity did not match the expected executable.'
    }
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$marker.process_id)"
    if (-not $entry) {
        [pscustomobject]@{ status = 'exited'; pid = [int]$marker.process_id } | ConvertTo-Json -Compress
        exit
    }
    $started = $entry.CreationDate.ToUniversalTime()
    $earliest = [DateTime]::Parse($EarliestStart).ToUniversalTime().AddSeconds(-2)
    $latest = (Get-Item -LiteralPath $MarkerPath).LastWriteTimeUtc.AddSeconds(2)
    if ($started -lt $earliest -or $started -gt $latest -or
        -not [string]::Equals($entry.ExecutablePath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        ($Helper -and $entry.CommandLine -notmatch '--portcove-apply-update')) {
        throw 'Marked updater PID was not the process spawned during this renderer action.'
    }
    $process = try { [Diagnostics.Process]::GetProcessById([int]$marker.process_id) } catch [ArgumentException] { $null }
    if (-not $process) {
        [pscustomobject]@{ status = 'exited'; pid = [int]$marker.process_id } | ConvertTo-Json -Compress
        exit
    }
    try {
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $started).TotalMilliseconds) -gt 1 -or
            -not [string]::Equals($process.MainModule.FileName, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Marked updater process changed during identity capture.'
        }
        $identity = [pscustomobject]@{
            pid = $process.Id
            path = $ExpectedPath
            started_filetime = $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        }
        $stream = [IO.File]::Open($IdentityPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(($identity | ConvertTo-Json -Compress))
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
        [pscustomobject]@{ status = 'captured'; pid = $identity.pid; path = $identity.path } | ConvertTo-Json -Compress
    } catch [InvalidOperationException] {
        if (-not $process.HasExited) { throw }
        [pscustomobject]@{ status = 'exited'; pid = [int]$marker.process_id } | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
    exit
}
$identity = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
if ($Mode -eq 'Wait') {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.ElapsedMilliseconds -lt 20000) {
        $observed = try { [Diagnostics.Process]::GetProcessById([int]$identity.pid) } catch [ArgumentException] { $null }
        if (-not $observed) {
            [pscustomobject]@{ status = 'exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
            exit
        }
        try {
            if ($observed.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $identity.started_filetime) {
                [pscustomobject]@{ status = 'prior-process-exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
                exit
            }
        } catch [InvalidOperationException] {
            if (-not $observed.HasExited) { throw }
            [pscustomobject]@{ status = 'exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
            exit
        } finally { $observed.Dispose() }
        Start-Sleep -Milliseconds 200
    }
    throw 'Marked updater process did not exit naturally within twenty seconds.'
}
$process = try { [Diagnostics.Process]::GetProcessById([int]$identity.pid) } catch [ArgumentException] { $null }
if (-not $process) {
    [pscustomobject]@{ status = 'exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
    exit
}
try {
    if ($process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $identity.started_filetime -or
        -not [string]::Equals($process.MainModule.FileName, $identity.path, [StringComparison]::OrdinalIgnoreCase)) {
        [pscustomobject]@{ status = 'prior-process-exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
        exit
    }
    $process.Kill($true)
    if (-not $process.WaitForExit(5000)) { throw 'Marked updater process did not exit within five seconds.' }
    [pscustomobject]@{ status = 'stopped'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
} catch [InvalidOperationException] {
    if (-not $process.HasExited) { throw }
    [pscustomobject]@{ status = 'exited'; pid = [int]$identity.pid } | ConvertTo-Json -Compress
} finally { $process.Dispose() }
