param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][ValidateSet("windows-x86_64", "linux-x86_64", "macos-aarch64", "macos-x86_64")][string]$PlatformLabel,
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$temporaryParent = if ([string]::IsNullOrWhiteSpace($env:PORTCOVE_TEMP_DIR)) {
    Join-Path (Join-Path $projectRoot "work") "cli-smoke"
}
else {
    [System.IO.Path]::GetFullPath($env:PORTCOVE_TEMP_DIR)
}
[System.IO.Directory]::CreateDirectory($temporaryParent) | Out-Null
$temporaryDirectory = Join-Path $temporaryParent ([System.Guid]::NewGuid().ToString("N"))
$extractDirectory = Join-Path $temporaryDirectory "archive"
$library = Join-Path $temporaryDirectory "library"
[System.IO.Directory]::CreateDirectory($extractDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory($library) | Out-Null

try {
    $expectedExecutableName = if ($PlatformLabel -eq "windows-x86_64") { "portcove.exe" } else { "portcove" }
    if ($archive.EndsWith(".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
        if ($PlatformLabel -ne "windows-x86_64") { throw "Only the Windows CLI package may use ZIP" }
        $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
        try {
            $entries = @($zip.Entries | ForEach-Object { $_.FullName })
        }
        finally {
            $zip.Dispose()
        }
        if ($entries.Count -ne 1 -or $entries[0] -cne $expectedExecutableName) {
            throw "CLI archive must contain exactly one top-level executable named $expectedExecutableName"
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $extractDirectory
    }
    elseif ($archive.EndsWith(".tar.gz", [System.StringComparison]::OrdinalIgnoreCase)) {
        if ($PlatformLabel -eq "windows-x86_64") { throw "The Windows CLI package must use ZIP" }
        $entries = @(& tar -tzf $archive)
        if ($LASTEXITCODE -ne 0) { throw "CLI archive listing failed with exit code $LASTEXITCODE" }
        if ($entries.Count -ne 1 -or $entries[0] -cne $expectedExecutableName) {
            throw "CLI archive must contain exactly one top-level executable named $expectedExecutableName"
        }
        & tar -xzf $archive -C $extractDirectory
        if ($LASTEXITCODE -ne 0) { throw "CLI archive extraction failed with exit code $LASTEXITCODE" }
    }
    else {
        throw "Unsupported CLI archive format: $archive"
    }

    $files = @(Get-ChildItem -LiteralPath $extractDirectory -File -Recurse)
    if ($files.Count -ne 1 -or $files[0].Name -cne $expectedExecutableName) {
        throw "CLI archive must contain exactly one executable named $expectedExecutableName"
    }
    $executable = $files[0].FullName

    if ($PlatformLabel -eq "windows-x86_64") {
        $bytes = [System.IO.File]::ReadAllBytes($executable)
        if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "CLI executable is not a PE file" }
        $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
        if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length) { throw "CLI PE header is malformed" }
        $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
        if ($machine -ne 0x8664) { throw ("CLI PE architecture is 0x{0:x4}, expected x86_64" -f $machine) }
        $identity = "PE32+ x86_64"
    }
    else {
        $identity = (& file -b $executable | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect CLI executable architecture" }
        if ($PlatformLabel -eq "linux-x86_64" -and $identity -notmatch "ELF 64-bit.*x86-64") {
            throw "CLI archive does not contain a Linux x86_64 ELF executable: $identity"
        }
        if ($PlatformLabel -eq "macos-aarch64" -and $identity -notmatch "Mach-O 64-bit.*arm64") {
            throw "CLI archive does not contain a macOS arm64 executable: $identity"
        }
        if ($PlatformLabel -eq "macos-x86_64" -and $identity -notmatch "Mach-O 64-bit.*x86_64") {
            throw "CLI archive does not contain a macOS x86_64 executable: $identity"
        }
    }

    $versionOutput = (& $executable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -cne "portcove $Version") {
        throw "Packaged CLI version output must be exactly portcove $Version"
    }
    $doctorOutput = (& $executable --library $library --json doctor | Out-String).Trim() | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $doctorOutput.ok -ne $true -or $doctorOutput.command -ne "doctor") {
        throw "Packaged CLI failed its isolated-library doctor smoke test"
    }
    Write-Output "Packaged CLI smoke test passed: $PlatformLabel; $versionOutput; $identity"
}
finally {
    $resolvedParent = [System.IO.Path]::GetFullPath($temporaryParent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryDirectory)
    if ($resolvedTemporary.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}
