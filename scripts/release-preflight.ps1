param([string]$Tag)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopRoot = Join-Path $projectRoot "apps\desktop"
$metadataScript = Join-Path $PSScriptRoot "check-release-metadata.mjs"
$metadataTest = Join-Path $PSScriptRoot "check-release-metadata.test.mjs"

Push-Location $projectRoot
try {
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
    $installer = Join-Path $projectRoot "target\release\bundle\nsis\Portcove_${version}_x64-setup.exe"
    & (Join-Path $PSScriptRoot "test-windows-installer.ps1") -InstallerPath $installer
    if ($LASTEXITCODE -ne 0) { throw "Windows installer lifecycle failed with exit code $LASTEXITCODE" }

    Write-Output "Portcove $version release preflight passed."
}
finally {
    Pop-Location
}
