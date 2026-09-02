param([string]$Version)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = (Resolve-Path (Join-Path $projectRoot "outputs")).Path
if (-not $outputRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory escaped the Portcove workspace"
}

Push-Location $projectRoot
try {
    $metadataScript = Join-Path $projectRoot "scripts\check-release-metadata.mjs"
    if ([string]::IsNullOrWhiteSpace($Version)) {
        $Version = (& node $metadataScript --print-version | Out-String).Trim()
    }
    else {
        & node $metadataScript --expect-version $Version
    }
    if ($LASTEXITCODE -ne 0) { throw "Release metadata check failed with exit code $LASTEXITCODE" }

    cargo build -p portcove-cli --release
    if ($LASTEXITCODE -ne 0) { throw "CLI release build failed with exit code $LASTEXITCODE" }

    $installerName = "Portcove_${Version}_x64-setup.exe"
    $cliName = "portcove-${Version}-windows-x86_64.exe"
    $sourceName = "portcove-${Version}-source.zip"
    Copy-Item -LiteralPath (Join-Path $projectRoot "target\release\bundle\nsis\$installerName") -Destination (Join-Path $outputRoot $installerName) -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "target\release\portcove.exe") -Destination (Join-Path $outputRoot $cliName) -Force

    $temporaryArchive = Join-Path $outputRoot "$sourceName.next"
    $sourceArchive = Join-Path $outputRoot $sourceName
    if ([System.IO.File]::Exists($temporaryArchive)) {
        [System.IO.File]::Delete($temporaryArchive)
    }
    & tar -a -cf $temporaryArchive --exclude=./target --exclude=./work --exclude=./outputs --exclude=./apps/desktop/node_modules --exclude=./apps/desktop/dist --exclude=./apps/desktop/src-tauri/gen --exclude=./.git --exclude=./.fallow --exclude=./scripts/.fallow --exclude=./apps/desktop/.fallow --exclude=./.codex-remote-attachments .
    if ($LASTEXITCODE -ne 0) { throw "Source archive failed with exit code $LASTEXITCODE" }
    $forbiddenArchiveEntries = & tar -tf $temporaryArchive | Where-Object {
        $_ -match '(^|/)(\.git|\.fallow|\.codex-remote-attachments)(/|$)' -or
        $_ -match '^\./(target|work|outputs|apps/desktop/node_modules|apps/desktop/dist|apps/desktop/src-tauri/gen)(/|$)'
    }
    if ($LASTEXITCODE -ne 0) { throw "Source archive inspection failed with exit code $LASTEXITCODE" }
    if ($forbiddenArchiveEntries) {
        [System.IO.File]::Delete($temporaryArchive)
        throw "Source archive contains excluded workspace state: $($forbiddenArchiveEntries[0])"
    }
    [System.IO.File]::Move($temporaryArchive, $sourceArchive, $true)

    $artifacts = @(
        (Join-Path $outputRoot $installerName),
        (Join-Path $outputRoot $cliName),
        $sourceArchive
    )
    $hashes = Get-FileHash -Algorithm SHA256 $artifacts
    $hashes | ForEach-Object {
        "{0}  {1}" -f $_.Hash.ToLowerInvariant(), [System.IO.Path]::GetFileName($_.Path)
    } | Set-Content -LiteralPath (Join-Path $outputRoot "SHA256SUMS.txt") -Encoding utf8
    $hashes | Select-Object Hash, Path
}
finally {
    Pop-Location
}
