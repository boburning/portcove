param([string]$Version)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$storageScript = Join-Path $PSScriptRoot "dev-storage.mjs"
$storageJson = & node $storageScript preflight --json
if ($LASTEXITCODE -ne 0) { throw "Development storage preflight failed with exit code $LASTEXITCODE" }
$storage = $storageJson | ConvertFrom-Json
$outputRoot = [System.IO.Path]::GetFullPath($storage.output_root)
$targetRoot = [System.IO.Path]::GetFullPath($storage.target_directory)
$projectPrefix = $projectRoot.TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory escaped the Portcove workspace"
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($storage.temporary_directory) | Out-Null
[System.IO.Directory]::CreateDirectory($storage.pnpm_store) | Out-Null
$storageEnvironment = @{
    CARGO_TARGET_DIR = $targetRoot
    PORTCOVE_TEMP_DIR = $storage.temporary_directory
    PORTCOVE_OUTPUT_DIR = $outputRoot
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
    Copy-Item -LiteralPath (Join-Path $targetRoot "release\bundle\nsis\$installerName") -Destination (Join-Path $outputRoot $installerName) -Force
    Copy-Item -LiteralPath (Join-Path $targetRoot "release\portcove.exe") -Destination (Join-Path $outputRoot $cliName) -Force

    $temporaryArchive = Join-Path $outputRoot "portcove-${Version}-source.next.zip"
    $sourceArchive = Join-Path $outputRoot $sourceName
    if ([System.IO.File]::Exists($temporaryArchive)) {
        [System.IO.File]::Delete($temporaryArchive)
    }
    $excludedDirectories = @("target", "work", "outputs", "apps/desktop/node_modules", "apps/desktop/dist", "apps/desktop/src-tauri/gen", ".git", ".fallow", ".rscheck", ".semdup", "semdup.sqlite", "scripts/.fallow", "apps/desktop/.fallow", ".codex-remote-attachments")
    foreach ($storagePath in @($targetRoot, $outputRoot, $storage.temporary_directory, $storage.pnpm_store)) {
        $relative = [System.IO.Path]::GetRelativePath($projectRoot, $storagePath).Replace('\', '/')
        if ($relative -eq ".") { throw "Packaging storage cannot be the workspace root" }
        if (-not [System.IO.Path]::IsPathRooted($relative) -and $relative -ne ".." -and -not $relative.StartsWith("../")) {
            $excludedDirectories += $relative
        }
    }
    $archiveExclusions = @($excludedDirectories | ForEach-Object { "--exclude=./$_" })
    & tar -a -cf $temporaryArchive @archiveExclusions .
    if ($LASTEXITCODE -ne 0) { throw "Source archive failed with exit code $LASTEXITCODE" }
    $forbiddenArchiveEntries = & tar -tf $temporaryArchive | Where-Object {
        $entry = $_ -replace '^\./', ''
        $entry -match '(^|/)(\.git|\.fallow|\.rscheck|\.semdup|\.codex-remote-attachments)(/|$)' -or
        ($excludedDirectories | Where-Object { $entry -eq $_ -or $entry.StartsWith("$_/") })
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
    foreach ($name in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
    }
    Pop-Location
}
