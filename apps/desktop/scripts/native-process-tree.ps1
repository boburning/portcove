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
