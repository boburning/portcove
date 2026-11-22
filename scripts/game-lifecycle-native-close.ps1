param(
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OwnerPid,
    [Parameter(Mandatory)][long]$OwnerStartedFileTime,
    [Parameter(Mandatory)][string]$OwnerPath,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedApplicationSha256,
    [Parameter(Mandatory)][string]$SnapshotPath
)
$ErrorActionPreference = 'Stop'
$nativeRoot = Join-Path $PSScriptRoot '..\apps\desktop\scripts'
. (Join-Path $nativeRoot 'native-process-tree.ps1')
$nativeSession = Join-Path $nativeRoot 'native-session.ps1'
$owner = [Diagnostics.Process]::GetProcessById($OwnerPid)
try {
    if ($owner.StartTime.ToFileTimeUtc() -ne $OwnerStartedFileTime -or
        -not (Test-SameNativePath @($owner.MainModule.FileName, $OwnerPath)) -or
        $owner.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
        throw 'The original same-session Core launch owner changed.'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $candidate = $null
    do {
        $owner.Refresh()
        if ($owner.HasExited) { throw 'The Core launch exited before an owned game window was ready.' }
        $rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $OwnerPid" |
            Where-Object { $_.ExecutablePath -and (Test-SameNativePath @($_.ExecutablePath, $ApplicationPath)) })
        if ($rows.Count -gt 1) { throw 'More than one exact game process was observed.' }
        if ($rows.Count -eq 1) {
            $candidate = Get-Process -Id $rows[0].ProcessId -ErrorAction SilentlyContinue
            if ($candidate -and $candidate.SessionId -eq $owner.SessionId -and $candidate.MainWindowHandle -ne 0) { break }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The managed game did not open one owned window before the deadline.' }
        Start-Sleep -Milliseconds 150
    } while ($true)

    $null = & $nativeSession -Mode SnapshotApplication -DriverProcessId $candidate.Id `
        -ApplicationPath $ApplicationPath -ExpectedParentProcessId $OwnerPid `
        -ExpectedApplicationSha256 $ExpectedApplicationSha256 -SnapshotPath $SnapshotPath
    $close = & $nativeSession -Mode RequestClose -ApplicationPath $ApplicationPath `
        -ExpectedApplicationSha256 $ExpectedApplicationSha256 -SnapshotPath $SnapshotPath
    $wait = & $nativeSession -Mode Wait -SnapshotPath $SnapshotPath
    [pscustomobject]@{
        request = ($close | ConvertFrom-Json)
        quiescence = ($wait | ConvertFrom-Json)
    } | ConvertTo-Json -Depth 8 -Compress
} finally {
    $owner.Dispose()
}
