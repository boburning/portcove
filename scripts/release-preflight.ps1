param([string]$Tag)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopRoot = Join-Path $projectRoot "apps\desktop"
$metadataScript = Join-Path $PSScriptRoot "check-release-metadata.mjs"
$metadataTest = Join-Path $PSScriptRoot "check-release-metadata.test.mjs"
$storageScript = Join-Path $PSScriptRoot "dev-storage.mjs"
$storageJson = & node $storageScript preflight --json
if ($LASTEXITCODE -ne 0) { throw "Development storage preflight failed with exit code $LASTEXITCODE" }
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
    if ($LASTEXITCODE -ne 0) { throw "Release metadata tests failed with exit code $LASTEXITCODE" }

    if ([string]::IsNullOrWhiteSpace($Tag)) {
        & node $metadataScript
    }
    else {
        & node $metadataScript --tag $Tag
    }
    if ($LASTEXITCODE -ne 0) { throw "Release metadata check failed with exit code $LASTEXITCODE" }

    Push-Location $desktopRoot
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency check failed with exit code $LASTEXITCODE" }
        pnpm audit --prod --audit-level high
        if ($LASTEXITCODE -ne 0) { throw "Frontend production dependency audit failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    & just audit
    if ($LASTEXITCODE -ne 0) { throw "Repository quality audit failed with exit code $LASTEXITCODE" }

    & node (Join-Path $PSScriptRoot "check-catalog-repositories.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Catalog repository check failed with exit code $LASTEXITCODE" }
    & node (Join-Path $PSScriptRoot "check-retcomm-upstreams.mjs")
    if ($LASTEXITCODE -ne 0) { throw "PS1 upstream ownership check failed with exit code $LASTEXITCODE" }

    Push-Location $desktopRoot
    try {
        pnpm tauri build
        if ($LASTEXITCODE -ne 0) { throw "Tauri bundle build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    $version = (& node $metadataScript --print-version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not resolve the verified release version" }
    $installer = Join-Path $storage.target_directory "release\bundle\nsis\Portcove_${version}_x64-setup.exe"
    & (Join-Path $PSScriptRoot "test-windows-installer.ps1") -InstallerPath $installer
    if ($LASTEXITCODE -ne 0) { throw "Windows installer lifecycle failed with exit code $LASTEXITCODE" }

    Write-Output "Portcove $version release preflight passed."
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
    }
    Pop-Location
}
