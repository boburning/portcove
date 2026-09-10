param([string]$Cli, [string]$Library)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $locator)) { throw 'Visual Studio Build Tools with MSBuild is required.' }
$msbuild = & $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
if (!$msbuild) { throw 'MSBuild was not found. Install Visual Studio Build Tools.' }
foreach ($project in @('Portcove.Playnite.csproj', 'tests/ContractTests.csproj')) {
    & $msbuild (Join-Path $projectRoot $project) /restore /p:RestoreLockedMode=true /p:Configuration=Release /verbosity:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "Reference-client build failed: $project" }
}
$arguments = @()
if ($Cli -or $Library) {
    if (!$Cli -or !$Library) { throw 'Pass both -Cli and an isolated -Library for compiled CLI checks.' }
    $arguments = @($Cli, $Library)
}
& (Join-Path $projectRoot 'tests/bin/Release/Portcove.ContractTests.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw 'Reference-client contract checks failed.' }
$output = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'bin/Release') -File | Select-Object -ExpandProperty Name)
if (@($output | Where-Object { $_ -notin @('Portcove.Playnite.dll', 'extension.yaml') }).Count) {
    throw 'Unexpected files in plugin output. Do not ship SDK or private Playnite assemblies.'
}
