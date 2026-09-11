param([switch]$IncludeDeep)

$ErrorActionPreference = "Stop"
$runningOnWindows = $env:OS -eq "Windows_NT"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $projectRoot ".github\quality-tools.json"
$qualityManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$requiredAqua = (Get-Content -LiteralPath (Join-Path $projectRoot ".aqua-version") -Raw).Trim()
$aquaCommand = Get-Command aqua -ErrorAction SilentlyContinue
if (-not $aquaCommand) {
    throw "aqua $requiredAqua is required; install it before running this bootstrap"
}
$aquaReported = (& aqua --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $aquaReported -notmatch "(?<![0-9])$([regex]::Escape($requiredAqua.TrimStart('v')))(?![0-9])") {
    throw "aqua $requiredAqua is required; reported: $aquaReported"
}

$previousChecksum = $env:AQUA_ENFORCE_CHECKSUM
$previousRequiredChecksum = $env:AQUA_ENFORCE_REQUIRE_CHECKSUM
try {
    $env:AQUA_ENFORCE_CHECKSUM = "true"
    $env:AQUA_ENFORCE_REQUIRE_CHECKSUM = "true"
    & aqua install
    if ($LASTEXITCODE -ne 0) { throw "aqua could not install the pinned quality tools" }
}
finally {
    $env:AQUA_ENFORCE_CHECKSUM = $previousChecksum
    $env:AQUA_ENFORCE_REQUIRE_CHECKSUM = $previousRequiredChecksum
}

if ($runningOnWindows) {
    $resourceFile = Join-Path $projectRoot ".config\powershell-resources.psd1"
    $resources = Import-PowerShellDataFile -LiteralPath $resourceFile
    $requiredPssa = [string]$resources.PSScriptAnalyzer.version
    if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer | Where-Object Version -EQ $requiredPssa)) {
        Install-PSResource -RequiredResourceFile $resourceFile -Scope CurrentUser -TrustRepository
    }
    if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer | Where-Object Version -EQ $requiredPssa)) {
        throw "PSScriptAnalyzer did not install at required version $requiredPssa"
    }
    Write-Output "PSScriptAnalyzer ready: $requiredPssa"
}

function ConvertTo-QualityTool([object]$Definition) {
    return @{
        Crate = $Definition.crate
        Version = $Definition.version
        Command = $Definition.command[0]
        Arguments = @($Definition.command | Select-Object -Skip 1)
    }
}

$requiredTools = @($qualityManifest.tools | Where-Object { $_.tier -eq "required" -and -not $_.install } | ForEach-Object { ConvertTo-QualityTool $_ })
$optionalTools = @($qualityManifest.tools | Where-Object { $_.tier -eq "deep" -and $_.id -ne "cargo-hawk" -and -not $_.install } | ForEach-Object { ConvertTo-QualityTool $_ })
$hawkDefinition = $qualityManifest.tools | Where-Object { $_.id -eq "cargo-hawk" }

function Get-QualityToolVersion([hashtable]$Tool) {
    try {
        $arguments = @($Tool.Arguments)
        $output = (& $Tool.Command @arguments 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) { return $output }
    }
    catch {
        return $null
    }
    return $null
}

function Test-QualityToolVersion([hashtable]$Tool) {
    $reported = Get-QualityToolVersion $Tool
    return $null -ne $reported -and $reported -match "(?<![0-9])$([regex]::Escape($Tool.Version))(?![0-9])"
}

function Install-QualityTool([hashtable]$Tool) {
    if (Test-QualityToolVersion $Tool) {
        Write-Output "$($Tool.Crate) already pinned: $(Get-QualityToolVersion $Tool)"
        return
    }

    if (Get-Command cargo-binstall -ErrorAction SilentlyContinue) {
        & cargo binstall --no-confirm --locked "$($Tool.Crate)@$($Tool.Version)"
        if ($LASTEXITCODE -ne 0) { throw "cargo-binstall could not install $($Tool.Crate) $($Tool.Version)" }
    }
    else {
        & cargo install --locked --version $Tool.Version $Tool.Crate
        if ($LASTEXITCODE -ne 0) { throw "cargo install could not install $($Tool.Crate) $($Tool.Version)" }
    }

    $reported = Get-QualityToolVersion $Tool
    if (-not (Test-QualityToolVersion $Tool)) {
        throw "$($Tool.Crate) did not report the required version $($Tool.Version); reported: $reported"
    }
    Write-Output "$($Tool.Crate) installed: $reported"
}

foreach ($tool in $requiredTools) {
    Install-QualityTool $tool
}

$optionalFailures = @()
if ($IncludeDeep) {
    foreach ($tool in $optionalTools) {
        try {
            Install-QualityTool $tool
        }
        catch {
            $optionalFailures += $tool.Crate
            Write-Warning "$($tool.Crate) remains unavailable: $($_.Exception.Message)"
        }
    }

    if ($runningOnWindows) {
        $optionalFailures += "cargo-hawk"
        Write-Warning "Hawk does not publish Windows binaries. Run the deep audit in Linux or macOS for Hawk analysis."
    }
    else {
        try {
            & rustup toolchain install $hawkDefinition.rust_toolchain --component rustc-dev
            if ($LASTEXITCODE -ne 0) { throw "could not install Hawk's pinned Rust toolchain with rustc-dev" }
            $hawkTool = ConvertTo-QualityTool $hawkDefinition
            if (-not (Test-QualityToolVersion $hawkTool)) {
                $previousBootstrap = $env:RUSTC_BOOTSTRAP
                try {
                    $env:RUSTC_BOOTSTRAP = "1"
                    & cargo "+$($hawkDefinition.rust_toolchain)" install --locked --version $hawkDefinition.version $hawkDefinition.crate
                    if ($LASTEXITCODE -ne 0) { throw "could not install the pinned cargo-hawk release" }
                }
                finally {
                    $env:RUSTC_BOOTSTRAP = $previousBootstrap
                }
            }
            if (-not (Test-QualityToolVersion $hawkTool)) { throw "cargo-hawk did not report its pinned version" }
            Write-Output "cargo-hawk ready: $(Get-QualityToolVersion $hawkTool)"
        }
        catch {
            $optionalFailures += "cargo-hawk"
            Write-Warning "cargo-hawk remains unavailable: $($_.Exception.Message)"
        }
    }
}

Write-Output "Required pinned Portcove quality tools are ready."
if ($optionalFailures.Count -gt 0) {
    Write-Warning "Optional deep tools unavailable on this host: $(($optionalFailures | Select-Object -Unique) -join ', ')"
}
