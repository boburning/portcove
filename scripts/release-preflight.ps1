param([string]$Tag, [Alias("h", "-help")][switch]$Help)

if ($Help) {
    Write-Output @'
Run Windows release metadata, fresh quality, dependency, upstream, bundle, and isolated installer checks.

Usage: pwsh -File scripts/release-preflight.ps1 [-Tag TAG] [-Help | --help]

Options:
  -Tag TAG       Require this release tag to match central metadata.
  -Help, --help  Show this help without provisioning, checking storage, building, or installing.

Requires the repository-pinned Node/pnpm and quality tools, Rust/Tauri Windows
build prerequisites, network access for dependency/upstream checks, and a GitHub
token (GH_TOKEN, GITHUB_TOKEN or a github.com 'gh auth login') for the catalog
repository check; without one the preflight stops before any other work. Install
the pinned quality tools with scripts/bootstrap-quality-tools.ps1 first.
Failures stop the preflight and name the command and its exit code; retain that
command's output and reported evidence paths when diagnosing the failure.
This command does not create a tag, sign artifacts, or publish a release.

Example:
  pwsh -File scripts/release-preflight.ps1 -Tag v0.1.0
'@
    exit 0
}

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopRoot = Join-Path $projectRoot "apps\desktop"
$pnpmSpec = (Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).packageManager
$installedPnpm = (& pnpm --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or "pnpm@$installedPnpm" -ne $pnpmSpec) { throw "Provide the exact repository $pnpmSpec on PATH. Command 'pnpm --version' returned '$installedPnpm' with exit code $LASTEXITCODE." }
# The catalog repository check makes several hundred GitHub API requests, which
# exceeds GitHub's anonymous limit of 60 an hour. Credentials follow local tooling
# (docs/DEVELOPMENT-TOOLS.md): GH_TOKEN, then GITHUB_TOKEN, then the github.com
# gh login, never another host's. The token is never printed.
function Resolve-PortcoveGithubToken {
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }
    $savedHost = $env:GH_HOST
    $savedPrompt = $env:GH_PROMPT_DISABLED
    $env:GH_HOST = "github.com"
    $env:GH_PROMPT_DISABLED = "1"
    try {
        $output = & gh auth token --hostname github.com 2>$null
        $succeeded = $LASTEXITCODE -eq 0
    }
    finally {
        $env:GH_HOST = $savedHost
        $env:GH_PROMPT_DISABLED = $savedPrompt
    }
    if (-not $succeeded) { return $null }
    $token = ($output | Out-String).Trim()
    if ($token) { return $token }
    return $null
}
$catalogToken = Resolve-PortcoveGithubToken
if (-not $catalogToken) { throw "The catalog repository check needs a GitHub token: it makes several hundred GitHub API requests and anonymous access allows 60 an hour. Run 'gh auth login' for github.com or set GH_TOKEN or GITHUB_TOKEN, then rerun the preflight. Nothing has been checked or built yet." }
$metadataScript = Join-Path $PSScriptRoot "check-release-metadata.mts"
$metadataTest = Join-Path $PSScriptRoot "check-release-metadata.test.mts"
$storageScript = Join-Path $PSScriptRoot "dev-storage.mts"
$storageJson = & node $storageScript preflight --json
if ($LASTEXITCODE -ne 0) { throw "Development storage preflight failed with exit code $LASTEXITCODE. Command: node '$storageScript' preflight --json. See the command output above." }
$storage = $storageJson | ConvertFrom-Json
[System.IO.Directory]::CreateDirectory($storage.temporary_directory) | Out-Null
[System.IO.Directory]::CreateDirectory($storage.output_root) | Out-Null
[System.IO.Directory]::CreateDirectory($storage.pnpm_store) | Out-Null
$storageEnvironment = @{
    CARGO_TARGET_DIR = $storage.target_directory
    PORTCOVE_TEMP_DIR = $storage.temporary_directory
    PORTCOVE_OUTPUT_DIR = $storage.output_root
    PORTCOVE_PNPM_STORE_DIR = $storage.pnpm_store
    pnpm_config_store_dir = $storage.pnpm_store
    TEMP = $storage.temporary_directory
    TMP = $storage.temporary_directory
    TMPDIR = $storage.temporary_directory
}
$previousEnvironment = @{}


Push-Location $projectRoot
try {
    foreach ($name in $storageEnvironment.Keys) {
        $previousEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
        [System.Environment]::SetEnvironmentVariable($name, $storageEnvironment[$name], "Process")
    }
    & node --test $metadataTest
    if ($LASTEXITCODE -ne 0) { throw "Release metadata tests failed with exit code $LASTEXITCODE. Command: node --test '$metadataTest'. See the failing test and output above." }

    $metadataCommand = "node '$metadataScript'"
    if ([string]::IsNullOrWhiteSpace($Tag)) {
        & node $metadataScript
    }
    else {
        $metadataCommand += " --tag '$Tag'"
        & node $metadataScript --tag $Tag
    }
    if ($LASTEXITCODE -ne 0) { throw "Release metadata check failed with exit code $LASTEXITCODE. Command: $metadataCommand. See the reported metadata errors above." }

    Push-Location $projectRoot
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency check failed with exit code $LASTEXITCODE. Command: pnpm install --frozen-lockfile. See the command output above." }
        pnpm audit --prod --audit-level high
        if ($LASTEXITCODE -ne 0) { throw "Frontend production dependency audit failed with exit code $LASTEXITCODE. Command: pnpm audit --prod --audit-level high. See the advisory report above." }
    }
    finally {
        Pop-Location
    }

    & just audit --fresh
    if ($LASTEXITCODE -ne 0) { throw "Repository quality audit failed with exit code $LASTEXITCODE. Command: just audit --fresh. See the failing phase and retained log/report paths above." }

    $previousGithubToken = $env:GITHUB_TOKEN
    $env:GITHUB_TOKEN = $catalogToken
    try {
        & node (Join-Path $PSScriptRoot "check-catalog-repositories.mts")
        $catalogExit = $LASTEXITCODE
    }
    finally {
        $env:GITHUB_TOKEN = $previousGithubToken
    }
    if ($catalogExit -ne 0) { throw "Catalog repository check failed with exit code $catalogExit. Command: node scripts/check-catalog-repositories.mts. See the repository failures above." }
    & node (Join-Path $PSScriptRoot "check-retcomm-upstreams.mts")
    if ($LASTEXITCODE -ne 0) { throw "PlayStation upstream ownership check failed with exit code $LASTEXITCODE. Command: node scripts/check-retcomm-upstreams.mts. See the upstream failures above." }

    Push-Location $desktopRoot
    try {
        pnpm tauri build --bundles nsis
        if ($LASTEXITCODE -ne 0) { throw "Tauri bundle build failed with exit code $LASTEXITCODE. Command: pnpm tauri build --bundles nsis (from $desktopRoot). See the build output above." }
    }
    finally {
        Pop-Location
    }

    $version = (& node $metadataScript --print-version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not resolve the verified release version; command failed with exit code $LASTEXITCODE. Command: node '$metadataScript' --print-version. See the metadata errors above." }
    $installer = Join-Path $storage.target_directory "release\bundle\nsis\Portcove_${version}_x64-setup.exe"
    & (Join-Path $PSScriptRoot "test-windows-installer.ps1") -InstallerPath $installer
    if ($LASTEXITCODE -ne 0) { throw "Windows installer lifecycle failed with exit code $LASTEXITCODE. Command: pwsh -File scripts/test-windows-installer.ps1 -InstallerPath '$installer'. See the retained installer evidence path above." }

    Write-Output "Portcove $version release preflight passed."
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
    }
    Pop-Location
}
