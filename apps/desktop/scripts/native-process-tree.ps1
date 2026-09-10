function Get-OwnedNativeProcessTree([int]$DriverProcessId, [string]$ApplicationPath) {
    $applicationFull = (Resolve-Path -LiteralPath $ApplicationPath).Path
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
    $applications = @($processes | Where-Object {
        $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $applicationFull, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Descendant $_ $DriverProcessId)
    })
    if ($applications.Count -ne 1) {
        $descendants = @($processes | Where-Object { Test-Descendant $_ $DriverProcessId })
        $missingPaths = @($descendants | Where-Object { -not $_.ExecutablePath }).Count
        throw "Expected exactly one owned application descended from the selected driver. Found $($applications.Count); descendants=$($descendants.Count); missing_image_paths=$missingPaths."
    }
    $application = $applications[0]
    $children = @($processes | Where-Object { Test-Descendant $_ ([int]$application.ProcessId) })
    return [pscustomobject]@{ application = $application; processes = @($application) + $children }
}
