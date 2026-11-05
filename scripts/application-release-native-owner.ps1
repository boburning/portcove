param([Parameter(Mandatory)][string]$ContextBase64)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Source-prepared entry only. The calling Node producer checks the appointed
# control source, ACTIVE/pause/spending/classification before any owner launch.
$hostedSessionExecutionAuthorized=$true
$ownerUtf8=[Text.UTF8Encoding]::new($false,$true)
function Read-OwnerWrapperBytes([string]$File,[int]$Maximum) {
    $item=Get-Item -LiteralPath $File -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 1 -or $item.Length -gt $Maximum){throw 'Bounded original owner source required'}
    return ,[IO.File]::ReadAllBytes($File)
}
$mechanism=Join-Path $PSScriptRoot 'release-hosted-native-windows-owner-mechanism.ps1'
$manifest=$ownerUtf8.GetString((Read-OwnerWrapperBytes (Join-Path (Split-Path $PSScriptRoot) 'manifest.json') 65536))|ConvertFrom-Json
$entry=@($manifest.files|Where-Object path -CEQ 'scripts/release-hosted-native-windows-owner-mechanism.ps1')
$bytes=Read-OwnerWrapperBytes $mechanism 131072
if($entry.Count -ne 1 -or $entry[0].bytes -ne $bytes.Length -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $entry[0].sha256){throw 'Original owner mechanism differs'}
. ([scriptblock]::Create($ownerUtf8.GetString($bytes))) -ContextBase64 $ContextBase64 -OwnerProfile Application -OwnerScriptsRoot $PSScriptRoot
