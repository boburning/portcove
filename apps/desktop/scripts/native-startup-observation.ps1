param(
    [Parameter(Mandatory)][int]$DriverProcessId,
    [Parameter(Mandatory)][string]$DriverPath,
    [Parameter(Mandatory)][string]$ProfilePath,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$StopPath,
    [ValidateRange(1, 65)][int]$Samples = 65
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
$expectedPath = (Resolve-Path -LiteralPath $DriverPath).Path
$initial = Get-OwnedDriverProcessTree $DriverProcessId
if (-not $initial.driver.CreationDate -or
    -not [string]::Equals($initial.driver.ExecutablePath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Startup observer driver identity mismatch.'
}
$started = $initial.driver.CreationDate
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream)
try {
    for ($sample = 0; $sample -lt $Samples; $sample++) {
        $inventoryError = $null
        $tree = try { Get-OwnedDriverProcessTree $DriverProcessId } catch { $inventoryError = $_.Exception.Message; $null }
        $sameDriver = $tree -and $tree.driver.CreationDate -eq $started -and
            [string]::Equals($tree.driver.ExecutablePath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)
        $records = if ($sameDriver) { @($tree.driver) + @($tree.processes) } else { @() }
        $devTools = Join-Path $ProfilePath 'DevToolsActivePort'
        $entry = [ordered]@{
            captured_at = [DateTime]::UtcNow.ToString('o')
            driver_identity_present = [bool]$sameDriver
            inventory_error = $inventoryError
            process_count = $records.Count
            process_inventory_truncated = $records.Count -gt 128
            processes = @($records | Select-Object -First 128 | ForEach-Object {
                $version = if ($_.ExecutablePath) {
                    try { [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath).FileVersion } catch { $null }
                } else { $null }
                [ordered]@{
                    pid = $_.ProcessId
                    parent_pid = $_.ParentProcessId
                    created_at = $_.CreationDate.ToUniversalTime().ToString('o')
                    image = $_.ExecutablePath
                    image_version = $version
                    remote_debugging_argument_present = [bool]($_.CommandLine -match '--remote-debugging-(port|pipe)(=|\s|$)')
                }
            })
            devtools_active_port_present = [IO.File]::Exists($devTools)
            stop_requested = [IO.File]::Exists($StopPath)
            sampling_limit_reached = $sample -eq ($Samples - 1)
        }
        $writer.WriteLine(($entry | ConvertTo-Json -Depth 5 -Compress))
        $writer.Flush()
        if ($sample -eq 0) { Write-Output 'ready' }
        if (-not $sameDriver -or $entry.stop_requested) { break }
        Start-Sleep -Milliseconds 1000
    }
} finally { $writer.Dispose() }
