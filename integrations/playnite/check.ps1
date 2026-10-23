param([string]$Cli, [string]$Library, [switch]$ContractsOnly, [string[]]$Scenario, [switch]$ListScenarios)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
if (($Cli -or $Library) -and (!$Cli -or !$Library)) { throw 'Pass both -Cli and an isolated -Library for compiled CLI checks.' }
if ($PSBoundParameters.ContainsKey('Scenario') -and (!$Scenario -or @($Scenario | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count)) { throw '-Scenario requires nonempty exact scenario names.' }
if ($ListScenarios -and ($Cli -or $Library -or $Scenario)) { throw '-ListScenarios cannot be combined with CLI paths or scenario selections.' }
$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $locator)) { throw 'Visual Studio Build Tools with MSBuild is required.' }
$msbuild = & $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
if (!$msbuild) { throw 'MSBuild was not found. Install Visual Studio Build Tools.' }
foreach ($project in @('Portcove.Playnite.csproj', 'tests/ContractTests.csproj')) {
    & $msbuild (Join-Path $projectRoot $project) /restore /p:RestoreLockedMode=true /p:Configuration=Release /verbosity:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "Reference-client build failed: $project" }
}
$executable = Join-Path $projectRoot 'tests/bin/Release/Portcove.ContractTests.exe'
if (!$Scenario -and !$ListScenarios) {
    & (Join-Path $projectRoot 'tests/runner-check.ps1') -Executable $executable
}
$arguments = @()
if ($Cli -or $Library) {
    if (!$Cli -or !$Library) { throw 'Pass both -Cli and an isolated -Library for compiled CLI checks.' }
    $arguments = @($Cli, $Library)
}
foreach ($name in $Scenario) { $arguments += @('--scenario', $name) }
if ($ListScenarios) { $arguments = @('--list-scenarios') }
& $executable @arguments
if ($LASTEXITCODE -ne 0) { throw 'Reference-client contract checks failed.' }
$output = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'bin/Release') -File | Select-Object -ExpandProperty Name)
if (@($output | Where-Object { $_ -notin @('Portcove.Playnite.dll', 'extension.yaml') }).Count) {
    throw 'Unexpected files in plugin output. Do not ship SDK or private Playnite assemblies.'
}
if ($ContractsOnly -or $Scenario -or $ListScenarios) { return }
node (Join-Path $projectRoot 'lifecycle-check.mts')
if ($LASTEXITCODE -ne 0) { throw 'Reference-client real lifecycle qualification failed.' }
$outputRoot = if ($env:PORTCOVE_OUTPUT_DIR) { [IO.Path]::GetFullPath($env:PORTCOVE_OUTPUT_DIR) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot '../../outputs')) }
$packageRoot = Join-Path (Join-Path $outputRoot 'playnite') ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
& (Join-Path $projectRoot 'pack.ps1') -OutputDirectory $packageRoot
if ($LASTEXITCODE -ne 0) { throw 'Playnite package creation failed.' }
