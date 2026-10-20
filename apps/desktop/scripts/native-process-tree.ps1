function Wait-OwnedNativeProcess(
    $Record,
    $Watch,
    [scriptblock]$ReadProcess = { param($processId) try { [Diagnostics.Process]::GetProcessById($processId) } catch [ArgumentException] { $null } },
    [scriptblock]$ReadCim = { param($processId) Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop }
) {
    $process = & $ReadProcess ([int]$Record.pid)
    if (-not $process) { return }
    $identityMatched = $false
    try {
        $started = try { $process.StartTime } catch { $null }
        if ($null -eq $started) {
            # Protected processes can expose neither .NET start time nor image.
            # CIM may prove a reused PID, but cannot grant authority over it.
            $current = @(& $ReadCim ([int]$Record.pid))
            if ($current.Count -ne 1 -or $current[0].ProcessId -ne $Record.pid -or
                $current[0].CreationDate -isnot [DateTime]) { throw 'Captured process identity is unavailable.' }
            $difference = [Math]::Abs($current[0].CreationDate.ToFileTimeUtc() - [long]$Record.started_filetime)
            # CIM and .NET can have different timestamp precision. A close value
            # is ambiguous, never evidence that the captured process exited.
            if ($difference -gt [TimeSpan]::TicksPerMillisecond) { return }
            throw 'Captured process identity is unavailable for the same or uncertain incarnation.'
        }
        # A reused PID proves the captured process already exited. Never act on it.
        if ($started.ToFileTimeUtc() -ne $Record.started_filetime) { return }
        $identityMatched = $true
        if (-not [string]::Equals($process.MainModule.FileName, $Record.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Captured process path changed.' }
        $remaining = [Math]::Max(0, 5000 - [int]$Watch.ElapsedMilliseconds)
        if (-not $process.WaitForExit($remaining)) { throw "Captured native process $($Record.pid) did not exit within the shared five-second bound." }
    } catch [InvalidOperationException] {
        if (-not $identityMatched -or -not [object]::Equals($process.HasExited, $true)) { throw }
    } finally { $process.Dispose() }
}

function Get-OwnedDriverProcessTree([int]$DriverProcessId) {
    $processes = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($entry in $processes) { $byId[[int]$entry.ProcessId] = $entry }
    if (-not $byId.ContainsKey($DriverProcessId)) { throw 'Owned driver is no longer running.' }
    function Test-Descendant($Entry, [int]$AncestorId) {
        if ([int]$Entry.ProcessId -eq $AncestorId) { return $false }
        $child = $Entry
        $seen = [Collections.Generic.HashSet[int]]::new()
        while ($seen.Add([int]$child.ProcessId)) {
            $parentId = [int]$child.ParentProcessId
            if (-not $byId.ContainsKey($parentId)) { return $false }
            $parent = $byId[$parentId]
            # Windows reuses PIDs. An older child cannot belong to this newer parent.
            if (-not $child.CreationDate -or -not $parent.CreationDate -or
                $parent.CreationDate -gt $child.CreationDate) { return $false }
            if ($parentId -eq $AncestorId) { return $true }
            $child = $parent
        }
        return $false
    }
    $descendants = @($processes | Where-Object { Test-Descendant $_ $DriverProcessId })
    return [pscustomobject]@{ driver = $byId[$DriverProcessId]; processes = $descendants }
}

function Get-OwnedNativeProcessTree([int]$DriverProcessId, [string]$ApplicationPath) {
    $applicationFull = (Resolve-Path -LiteralPath $ApplicationPath).Path
    $tree = Get-OwnedDriverProcessTree $DriverProcessId
    $applications = @($tree.processes | Where-Object {
        $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $applicationFull, [StringComparison]::OrdinalIgnoreCase) -and
        $_.CreationDate
    })
    if ($applications.Count -ne 1) {
        $descendants = @($tree.processes)
        $missingPaths = @($descendants | Where-Object { -not $_.ExecutablePath }).Count
        throw "Expected exactly one owned application descended from the selected driver. Found $($applications.Count); descendants=$($descendants.Count); missing_image_paths=$missingPaths."
    }
    $application = $applications[0]
    # Select the application's subtree from the already identity-checked driver tree.
    $ownedIds = [Collections.Generic.HashSet[int]]::new()
    [void]$ownedIds.Add([int]$application.ProcessId)
    do {
        $added = $false
        foreach ($entry in $tree.processes) {
            if ($ownedIds.Contains([int]$entry.ParentProcessId) -and $ownedIds.Add([int]$entry.ProcessId)) { $added = $true }
        }
    } while ($added)
    $children = @($tree.processes | Where-Object { $_.ProcessId -ne $application.ProcessId -and $ownedIds.Contains([int]$_.ProcessId) })
    return [pscustomobject]@{ driver = $tree.driver; application = $application; processes = @($application) + $children }
}
