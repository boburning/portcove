param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$UpgradeFromInstallerPath,
    [string]$ExpectedExecutablePath,
    [string]$TestBase = (Join-Path ([System.IO.Path]::GetTempPath()) "Portcove-Installer-Qualification")
)

$ErrorActionPreference = "Stop"

function Get-UninstallEntries([string]$InstallLocation) {
    $roots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    @($roots | ForEach-Object {
        Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue
    } | Where-Object {
        if (-not $InstallLocation) {
            return $_.DisplayName -eq "Portcove"
        }
        $location = [string]$_.InstallLocation
        $uninstallCommand = [string]$_.UninstallString
        $locationMatches = $false
        if ($location) {
            $locationMatches = [System.IO.Path]::GetFullPath($location.Trim('"')).TrimEnd('\') -eq $InstallLocation.TrimEnd('\')
        }
        $uninstallMatches = $uninstallCommand.Trim('"').StartsWith(
            $InstallLocation.TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )
        $locationMatches -or $uninstallMatches
    })
}

function Invoke-ApplicationSmoke([string]$Application) {
    $process = Start-Process -FilePath $Application -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            if ($process.HasExited) {
                throw "Installed application exited before the smoke check completed"
            }
        } while ((-not $process.Responding -or -not $process.MainWindowTitle) -and (Get-Date) -lt $deadline)
        if (-not $process.Responding -or -not $process.MainWindowTitle) {
            throw "Installed application did not reach a responsive named window"
        }
        $title = $process.MainWindowTitle
        $null = $process.CloseMainWindow()
        if (-not $process.WaitForExit(10000)) {
            throw "Installed application did not exit cleanly after its window closed"
        }
        if ($process.ExitCode -ne 0) {
            throw "Installed application exited with code $($process.ExitCode)"
        }
        [pscustomobject]@{ responding = $true; window_title = $title; exit_code = $process.ExitCode }
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        $process.Dispose()
    }
}

function Get-ExpectedBundledHash([string]$Executable) {
    $bytes = [System.IO.File]::ReadAllBytes($Executable)
    $rawHash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
    # Tauri patches its one bundle-type slot to NSS while packing NSIS, then
    # restores the build output to UNK. Compare against those exact bundled bytes.
    $marker = "__TAURI_BUNDLE_TYPE_VAR_UNK"
    $contents = [System.Text.Encoding]::ASCII.GetString($bytes)
    $index = $contents.IndexOf($marker, [System.StringComparison]::Ordinal)
    if ($index -ge 0) {
        if ($contents.IndexOf($marker, $index + $marker.Length, [System.StringComparison]::Ordinal) -ge 0) {
            throw "Expected executable has ambiguous Tauri bundle-type slots"
        }
        $replacement = [System.Text.Encoding]::ASCII.GetBytes("__TAURI_BUNDLE_TYPE_VAR_NSS")
        [System.Array]::Copy($replacement, 0, $bytes, $index, $replacement.Length)
    }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bundledHash = [System.BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
    [pscustomobject]@{ raw_sha256 = $rawHash; bundled_sha256 = $bundledHash; bundle_slot_patched = $index -ge 0 }
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([System.IO.Path]::GetExtension($installer) -ne ".exe") {
    throw "Installer must be an executable: $installer"
}
$predecessor = if ($UpgradeFromInstallerPath) { (Resolve-Path -LiteralPath $UpgradeFromInstallerPath).Path } else { $null }
if ($predecessor -and [System.IO.Path]::GetExtension($predecessor) -ne ".exe") {
    throw "Upgrade predecessor must be an executable"
}
$expected = if ($ExpectedExecutablePath) { Get-ExpectedBundledHash (Resolve-Path -LiteralPath $ExpectedExecutablePath).Path } else { $null }
if (@(Get-UninstallEntries "").Count -ne 0) {
    throw "A Portcove installer registration already exists. Refusing to replace another installation during qualification."
}

$base = [System.IO.Path]::GetFullPath($TestBase).TrimEnd('\')
$volumeRoot = [System.IO.Path]::GetPathRoot($base).TrimEnd('\')
if (-not $base -or $base -eq $volumeRoot) {
    throw "TestBase must be a dedicated directory below a volume root"
}
[System.IO.Directory]::CreateDirectory($base) | Out-Null
$base = (Resolve-Path -LiteralPath $base).Path.TrimEnd('\')

$runRoot = Join-Path $base ("run-" + [System.Guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $runRoot "installed"
$libraryRoot = Join-Path $runRoot "library"
$expectedPrefix = $base + [System.IO.Path]::DirectorySeparatorChar
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Generated test directory escaped TestBase"
}
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null

$completed = $false
$previousLibrary = [System.Environment]::GetEnvironmentVariable("PORTCOVE_LIBRARY", "Process")
try {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $application = Join-Path $installRoot "portcove-desktop.exe"
    $uninstaller = Join-Path $installRoot "uninstall.exe"
    [System.Environment]::SetEnvironmentVariable("PORTCOVE_LIBRARY", $libraryRoot, "Process")
    $upgrade = $null
    if ($predecessor) {
        $previousInstall = Start-Process -FilePath $predecessor -ArgumentList @("/S", "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
        if ($previousInstall.ExitCode -ne 0) {
            throw "Predecessor installer exited with code $($previousInstall.ExitCode)"
        }
        $previousSmoke = Invoke-ApplicationSmoke $application
        $previousHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
        $database = Join-Path $libraryRoot "portcove.sqlite3"
        if (-not [System.IO.File]::Exists($database)) {
            throw "Predecessor did not initialize the isolated library"
        }
        $upgrade = [pscustomobject]@{
            predecessor_installer_sha256 = (Get-FileHash -LiteralPath $predecessor -Algorithm SHA256).Hash.ToLowerInvariant()
            predecessor_executable_sha256 = $previousHash
            predecessor_smoke = $previousSmoke
        }
    }
    # This is a qualification marker, not a fabricated game save.
    $sentinelRoot = Join-Path $libraryRoot "user\installer-qualification"
    [System.IO.Directory]::CreateDirectory($sentinelRoot) | Out-Null
    $sentinel = Join-Path $sentinelRoot "preserve.txt"
    [System.IO.File]::WriteAllText($sentinel, [System.Guid]::NewGuid().ToString("N"))
    $sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
    if ($install.ExitCode -ne 0) {
        throw "Silent installer exited with code $($install.ExitCode)"
    }

    if (-not [System.IO.File]::Exists($application)) {
        throw "Installed application was not found at $application"
    }
    if (-not [System.IO.File]::Exists($uninstaller)) {
        throw "Uninstaller was not found at $uninstaller"
    }

    $installedHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -and $installedHash -ne $expected.bundled_sha256) {
        throw "Installer did not publish the expected application bytes"
    }
    $registryEntries = Get-UninstallEntries $installRoot
    if (@($registryEntries).Count -ne 1) {
        throw "Expected exactly one uninstall registration for the isolated installation"
    }
    $smoke = Invoke-ApplicationSmoke $application
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "Installation or application startup changed the isolated persistent-data marker"
    }

    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden
    if ($uninstall.ExitCode -ne 0) {
        throw "Silent uninstaller exited with code $($uninstall.ExitCode)"
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ([System.IO.Directory]::Exists($installRoot) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ([System.IO.File]::Exists($application) -or [System.IO.File]::Exists($uninstaller)) {
        throw "Uninstall left managed application files behind in $installRoot"
    }
    $remainingRegistryEntries = Get-UninstallEntries $installRoot
    if ($remainingRegistryEntries.Count -ne 0) {
        throw "Uninstall left registration entries behind for $installRoot"
    }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash -or
        -not [System.IO.File]::Exists((Join-Path $libraryRoot "portcove.sqlite3"))) {
        throw "Uninstall did not preserve the isolated library and persistent-data marker"
    }

    $completed = $true
    [pscustomobject]@{
        installer = $installer
        installer_sha256 = $installerHash
        signature_status = $signature.Status.ToString()
        install_exit_code = $install.ExitCode
        installed_executable_sha256 = $installedHash
        expected_executable = $expected
        uninstall_registration_count = $registryEntries.Count
        application_responding = $smoke.responding
        application_window_title = $smoke.window_title
        application_exit_code = $smoke.exit_code
        upgrade = $upgrade
        persistent_data_preserved = $true
        uninstall_exit_code = $uninstall.ExitCode
        managed_files_removed = $true
        registration_removed = $true
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    [System.Environment]::SetEnvironmentVariable("PORTCOVE_LIBRARY", $previousLibrary, "Process")
    if ($completed -and [System.IO.Directory]::Exists($runRoot)) {
        $resolvedRunRoot = (Resolve-Path -LiteralPath $runRoot).Path
        if (-not $resolvedRunRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean a test directory outside TestBase"
        }
        Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
    }
    elseif (-not $completed) {
        Write-Warning "Installer test evidence was preserved at $runRoot"
    }
}
