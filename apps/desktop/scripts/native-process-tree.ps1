function Get-OwnedNativeProcessTree([int]$DriverProcessId, [string]$ApplicationPath) {
    $applicationFull = (Resolve-Path -LiteralPath $ApplicationPath).Path
    $processes = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($entry in $processes) { $byId[[int]$entry.ProcessId] = $entry }
    if (-not $byId.ContainsKey($DriverProcessId)) { throw 'Owned driver is no longer running.' }
    function Test-Descendant($Entry, [int]$AncestorId) {
        $ancestor = [int]$Entry.ParentProcessId
        $seen = [Collections.Generic.HashSet[int]]::new()
        while ($ancestor -ne $AncestorId -and $byId.ContainsKey($ancestor) -and $seen.Add($ancestor)) {
            $ancestor = [int]$byId[$ancestor].ParentProcessId
        }
        return $ancestor -eq $AncestorId
    }
    $applications = @($processes | Where-Object {
        $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $applicationFull, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Descendant $_ $DriverProcessId)
    })
    if ($applications.Count -ne 1) { throw 'Expected exactly one owned application descended from the selected driver.' }
    $application = $applications[0]
    $children = @($processes | Where-Object { Test-Descendant $_ ([int]$application.ProcessId) })
    return [pscustomobject]@{ application = $application; processes = @($application) + $children }
}
