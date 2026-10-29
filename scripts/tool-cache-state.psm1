# Checkout-local observation only. This writer grants no trust or execution authority.
function Write-PortcoveToolCacheState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StatePath,
        [Parameter(Mandatory)][string]$PinFingerprint,
        [Parameter(Mandatory)][string]$SharedRoot,
        [Parameter(Mandatory)][string]$ShimDirectory,
        [Parameter(Mandatory)][string]$Aqua,
        [Parameter(Mandatory)][string]$AquaRoot,
        [AllowNull()][object]$Desktop
    )
    $state = [ordered]@{
        format_version = 1
        pin_fingerprint = $PinFingerprint
        shared_root = $SharedRoot
        shim_directory = $ShimDirectory
        aqua = $Aqua
        aqua_root = $AquaRoot
        desktop = $Desktop
    }
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$StatePath.next" -Encoding utf8
    Move-Item -LiteralPath "$StatePath.next" -Destination $StatePath -Force
}
Export-ModuleMember -Function Write-PortcoveToolCacheState
