param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
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

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([System.IO.Path]::GetExtension($installer) -ne ".exe") {
    throw "Installer must be an executable: $installer"
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
$launchedProcess = $null
$previousLibrary = [System.Environment]::GetEnvironmentVariable("PORTCOVE_LIBRARY", "Process")
try {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
    if ($install.ExitCode -ne 0) {
        throw "Silent installer exited with code $($install.ExitCode)"
    }

    $application = Join-Path $installRoot "portcove-desktop.exe"
    $uninstaller = Join-Path $installRoot "uninstall.exe"
    if (-not [System.IO.File]::Exists($application)) {
        throw "Installed application was not found at $application"
    }
    if (-not [System.IO.File]::Exists($uninstaller)) {
        throw "Uninstaller was not found at $uninstaller"
    }

    $installedHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
    $registryEntries = Get-UninstallEntries $installRoot
    [System.Environment]::SetEnvironmentVariable("PORTCOVE_LIBRARY", $libraryRoot, "Process")
    $launchedProcess = Start-Process -FilePath $application -PassThru -WindowStyle Hidden
    $launchDeadline = (Get-Date).AddSeconds(20)
    $responding = $false
    $windowTitle = ""
    do {
        Start-Sleep -Milliseconds 250
        $launchedProcess.Refresh()
        if ($launchedProcess.HasExited) {
            throw "Installed application exited before the smoke check completed"
        }
        $responding = $launchedProcess.Responding
        $windowTitle = $launchedProcess.MainWindowTitle
    } while ((-not $responding -or -not $windowTitle) -and (Get-Date) -lt $launchDeadline)
    if (-not $responding -or -not $windowTitle) {
        throw "Installed application did not reach a responsive named window"
    }

    $null = $launchedProcess.CloseMainWindow()
    if (-not $launchedProcess.WaitForExit(10000)) {
        Stop-Process -Id $launchedProcess.Id -Force
        $launchedProcess.WaitForExit()
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

    $completed = $true
    [pscustomobject]@{
        installer = $installer
        installer_sha256 = $installerHash
        signature_status = $signature.Status.ToString()
        install_exit_code = $install.ExitCode
        installed_executable_sha256 = $installedHash
        uninstall_registration_count = $registryEntries.Count
        application_responding = $responding
        application_window_title = $windowTitle
        uninstall_exit_code = $uninstall.ExitCode
        managed_files_removed = $true
        registration_removed = $true
    } | ConvertTo-Json -Compress
}
finally {
    [System.Environment]::SetEnvironmentVariable("PORTCOVE_LIBRARY", $previousLibrary, "Process")
    if ($launchedProcess -and -not $launchedProcess.HasExited) {
        Stop-Process -Id $launchedProcess.Id -Force -ErrorAction SilentlyContinue
    }
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
