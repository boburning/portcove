param(
    [Parameter(Mandatory = $true)][string]$PlatformLabel,
    [string]$ProjectRoot,
    [string]$TargetRoot,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
else {
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
}
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    $TargetRoot = Join-Path $ProjectRoot "target"
}
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)

$scriptsRoot = Join-Path $ProjectRoot "scripts"
$metadataScript = Join-Path $scriptsRoot "check-release-metadata.mjs"
$policyScript = Join-Path $scriptsRoot "release-package-policy.mjs"
$version = (& node $metadataScript --print-version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
    throw "Could not resolve the verified release version"
}
$archiveName = (& node $policyScript --project-root $ProjectRoot --platform $PlatformLabel --interface cli --version $version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($archiveName)) {
    throw "Could not resolve the CLI archive name for $PlatformLabel"
}

$isWindowsPackage = $PlatformLabel -eq "windows-x86_64"
$executableName = if ($isWindowsPackage) { "portcove.exe" } else { "portcove" }
$executable = Join-Path (Join-Path $TargetRoot "release") $executableName
if (-not [System.IO.File]::Exists($executable)) {
    throw "CLI release executable is missing: $executable"
}

$releaseAssets = Join-Path $ProjectRoot "release-assets"
[System.IO.Directory]::CreateDirectory($releaseAssets) | Out-Null
$archive = Join-Path $releaseAssets $archiveName
if ([System.IO.File]::Exists($archive)) {
    if (-not $Force) { throw "CLI archive already exists: $archive" }
    [System.IO.File]::Delete($archive)
}

$temporaryParent = Join-Path (Join-Path $ProjectRoot "work") "cli-packaging"
[System.IO.Directory]::CreateDirectory($temporaryParent) | Out-Null
$temporaryDirectory = Join-Path $temporaryParent ([System.Guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
try {
    $temporaryExecutable = Join-Path $temporaryDirectory $executableName
    Copy-Item -LiteralPath $executable -Destination $temporaryExecutable
    if ($isWindowsPackage) {
        Compress-Archive -LiteralPath $temporaryExecutable -DestinationPath $archive
    }
    else {
        & chmod +x -- $temporaryExecutable
        if ($LASTEXITCODE -ne 0) { throw "Could not preserve CLI executable permissions" }
        & tar -czf $archive -C $temporaryDirectory $executableName
        if ($LASTEXITCODE -ne 0) { throw "CLI TAR.GZ creation failed with exit code $LASTEXITCODE" }
    }
}
finally {
    $resolvedParent = [System.IO.Path]::GetFullPath($temporaryParent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryDirectory)
    if ($resolvedTemporary.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output $archive
