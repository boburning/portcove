param(
    [Parameter(Mandatory = $true)][string]$ModulePath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
$resolvedModule = (Resolve-Path -LiteralPath $ModulePath).Path
$module = Import-Module -Name $resolvedModule -Force -PassThru
if ($module.Version.ToString() -ne $ExpectedVersion) {
    throw "PSScriptAnalyzer did not report required version $ExpectedVersion"
}
Write-Output "PSScriptAnalyzer $($module.Version)"
