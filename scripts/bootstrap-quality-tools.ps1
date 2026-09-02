param([switch]$IncludeDeep)

$ErrorActionPreference = "Stop"
$runningOnWindows = $env:OS -eq "Windows_NT"

$requiredTools = @(
    @{ Crate = "just"; Version = "1.58.0"; Command = "just"; Arguments = @("--version") },
    @{ Crate = "cargo-shear"; Version = "1.13.4"; Command = "cargo"; Arguments = @("shear", "--version") },
    @{ Crate = "cargo-deny"; Version = "0.20.2"; Command = "cargo"; Arguments = @("deny", "--version") },
    @{ Crate = "cargo-modules"; Version = "0.27.0"; Command = "cargo"; Arguments = @("modules", "--version") },
    @{ Crate = "rscheck-cli"; Version = "0.1.0"; Command = "rscheck"; Arguments = @("--version") }
)

$optionalTools = @(
    @{ Crate = "semdup"; Version = "0.2.0"; Command = "semdup"; Arguments = @("--version") },
    @{ Crate = "cargo-mutants"; Version = "27.1.0"; Command = "cargo"; Arguments = @("mutants", "--version") }
)

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
            & rustup toolchain install 1.98.0 --component rustc-dev
            if ($LASTEXITCODE -ne 0) { throw "could not install Rust 1.98.0 with rustc-dev" }
            $hawkTool = @{ Crate = "cargo-hawk"; Version = "0.1.13"; Command = "cargo"; Arguments = @("+1.98.0", "hawk", "--version") }
            if (-not (Test-QualityToolVersion $hawkTool)) {
                $previousBootstrap = $env:RUSTC_BOOTSTRAP
                try {
                    $env:RUSTC_BOOTSTRAP = "1"
                    & cargo +1.98.0 install --locked --version 0.1.13 cargo-hawk
                    if ($LASTEXITCODE -ne 0) { throw "could not install cargo-hawk 0.1.13" }
                }
                finally {
                    $env:RUSTC_BOOTSTRAP = $previousBootstrap
                }
            }
            if (-not (Test-QualityToolVersion $hawkTool)) { throw "cargo-hawk did not report version 0.1.13" }
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
