param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$UpgradeFromInstallerPath,
    [string]$ExpectedExecutablePath,
    [string]$TestBase,
    [string]$RetainedLibraryRoot,
    [string]$RetainExecutablePath,
    [string]$EvidencePath,
    [ValidateSet("Silent", "Passive")]
    [string]$InstallMode = "Silent",
    [string]$ExpectedVersion,
    [ValidateRange(1, 600)]
    [int]$ProcessTimeoutSeconds = 120,
    [ValidateRange(1, 60)]
    [int]$CleanupTimeoutSeconds = 15,
    [ValidateSet("", "post-spawn-verification")]
    [string]$TestFault = ""
)

$ErrorActionPreference = "Stop"
$null = $ProcessTimeoutSeconds, $TestFault

if ([string]::IsNullOrWhiteSpace($TestBase)) {
    $storageJson = & node (Join-Path $PSScriptRoot "dev-storage.mjs") preflight --json
    if ($LASTEXITCODE -ne 0) { throw "Development storage preflight failed with exit code $LASTEXITCODE" }
    $storage = $storageJson | ConvertFrom-Json
    $TestBase = Join-Path $storage.temporary_directory "installer-qualification"
}

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

function Assert-NoReparseAncestry([string]$Path) {
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a process path with reparse-point ancestry: $cursor"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Invoke-ApplicationSmoke([string]$Application, [string]$Role) {
    $launch = Start-JournaledProcess $Role $Application @()
    $process = $launch.process
    try {
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            if ($process.HasExited) {
                Complete-JournaledProcess $launch.run $process "exit_observed"
                throw "Installed application exited before the smoke check completed"
            }
        } while ((-not $process.Responding -or -not $process.MainWindowTitle) -and (Get-Date) -lt $deadline)
        if (-not $process.Responding -or -not $process.MainWindowTitle) {
            throw "Installed application did not reach a responsive named window"
        }
        $title = $process.MainWindowTitle
        $launch.run.close_request = [ordered]@{
            requested_at = (Get-Date).ToUniversalTime().ToString("o")
            window_title = $title
            window_handle = $process.MainWindowHandle.ToInt64()
            accepted = $process.CloseMainWindow()
        }
        Write-InstallerEvidence $evidence.phase
        if (-not $launch.run.close_request.accepted) {
            throw "Installed application did not accept the main-window close request"
        }
        if (-not $process.WaitForExit(10000)) {
            $process.Refresh()
            $launch.run.close_timeout = [ordered]@{
                observed_at = (Get-Date).ToUniversalTime().ToString("o")
                window_title = $process.MainWindowTitle
                window_handle = $process.MainWindowHandle.ToInt64()
                responding = $process.Responding
            }
            Write-InstallerEvidence $evidence.phase
            throw "Installed application did not exit within 10 seconds after accepting the close request"
        }
        Complete-JournaledProcess $launch.run $process "exit_observed"
        if ($process.ExitCode -ne 0) {
            throw "Installed application exited with code $($process.ExitCode)"
        }
        [pscustomobject]@{ responding = $true; window_title = $title; exit_code = $process.ExitCode }
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $launch.run.status = "forced_termination"
            $launch.run.exit_observation = "Installer smoke cleanup forced the process to stop"
            Write-InstallerEvidence $evidence.phase
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

function Get-RecursiveFileManifest([string]$Root) {
    if (-not [System.IO.Directory]::Exists($Root)) { throw "Manifest root does not exist: $Root" }
    @(Get-ChildItem -LiteralPath $Root -Force -Recurse | Sort-Object FullName | ForEach-Object {
            $item = $_
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to manifest a reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                [pscustomobject]@{ path = [System.IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\', '/') + '/'; type = "directory"; bytes = $null; sha256 = $null }
            } else {
                [pscustomobject]@{ path = [System.IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\', '/'); type = "file"; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
            }
        })
}

function Get-PreservationManifest([string]$LibraryRoot) {
    $preferences = [System.Environment]::GetEnvironmentVariable("PORTCOVE_PREFERENCES", "Process")
    [ordered]@{
        library = @(Get-RecursiveFileManifest $LibraryRoot)
        preferences = if ($preferences -and [System.IO.File]::Exists($preferences)) {
            [ordered]@{ present = $true; bytes = (Get-Item -LiteralPath $preferences).Length; sha256 = (Get-FileHash -LiteralPath $preferences -Algorithm SHA256).Hash.ToLowerInvariant() }
        } else { [ordered]@{ present = $false; bytes = $null; sha256 = $null } }
    }
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
$expectedPrefix = $base + [System.IO.Path]::DirectorySeparatorChar
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Generated test directory escaped TestBase"
}
$libraryRoot = if ($RetainedLibraryRoot) {
    $requested = [System.IO.Path]::GetFullPath($RetainedLibraryRoot).TrimEnd('\')
    $sessionRoot = [System.IO.Path]::GetDirectoryName($base).TrimEnd('\')
    $sessionPrefix = $sessionRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $requested.StartsWith($sessionPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $requested.Equals($base, [System.StringComparison]::OrdinalIgnoreCase) -or
        $requested.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
        $base.StartsWith($requested + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "RetainedLibraryRoot must be an isolated sibling below the TestBase parent"
    }
    if (-not [System.IO.Directory]::Exists($requested)) { throw "RetainedLibraryRoot must be an existing directory" }
    Assert-NoReparseAncestry $requested
    if (@(Get-ChildItem -LiteralPath $requested -Force).Count -ne 0) { throw "RetainedLibraryRoot must be empty before qualification" }
    $requested
} else {
    Join-Path $runRoot "library"
}
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null

$evidence = if ($EvidencePath) {
    $evidenceFull = [System.IO.Path]::GetFullPath($EvidencePath)
    $evidenceParent = [System.IO.Path]::GetDirectoryName($evidenceFull)
    if (-not [System.IO.Directory]::Exists($evidenceParent)) { throw "EvidencePath parent must exist" }
    if ([System.IO.File]::Exists($evidenceFull)) { throw "EvidencePath must be new: $evidenceFull" }
    [ordered]@{
        format = 1
        phase = "initialized"
        process_runs = @()
        owned_paths = [ordered]@{
            run_root_relative = [System.IO.Path]::GetRelativePath($base, $runRoot).Replace('\', '/')
            install_relative = [System.IO.Path]::GetRelativePath($base, $installRoot).Replace('\', '/')
            library_relative = [System.IO.Path]::GetRelativePath($base, $libraryRoot).Replace('\', '/')
        }
        failure = $null
    }
} else { $null }

function Write-InstallerEvidence([string]$Phase, $Details = $null) {
    if (-not $evidence) { return }
    $evidence.phase = $Phase
    if ($Details) { $evidence.details = $Details }
    $next = "$evidenceFull.next"
    $evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $next -Encoding utf8
    # Windows can deny replacing a file while a delete-sharing reader holds it.
    # Retain the previous journal and the staged update until the move succeeds.
    $wait = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try {
            [System.IO.File]::Move($next, $evidenceFull, $true)
            break
        } catch {
            $cause = $_.Exception.GetBaseException()
            $windowsError = $cause.HResult -band 0xffff
            if (-not $IsWindows -or $windowsError -notin @(5, 32, 33) -or $wait.ElapsedMilliseconds -ge 2000) { throw }
            Start-Sleep -Milliseconds 20
        }
    }
}
Write-InstallerEvidence "initialized"

function Stop-JournaledProcess($Run, $Process, [string]$Status, [string]$Reason) {
    $Run.status = $Status
    $journalFailure = $null
    $parentExited = $false
    try {
        $Process.Refresh()
        $parentExited = $Process.HasExited
    } catch {
        $Reason += "; retained parent state observation failed: $($_.Exception.Message)"
    }
    if ($parentExited) {
        $Run.exit_observation = "$Reason; the retained parent had already exited"
    } else {
        $Run.exit_observation = "$Reason; process-tree termination was requested"
    }
    if ($evidence) {
        try { Write-InstallerEvidence $evidence.phase } catch { $journalFailure = $_.Exception.Message }
    }
    if (-not $parentExited) {
        try {
            $Process.Kill($true)
            if ($Process.WaitForExit(5000)) {
                $Run.exit_observation += "; retained parent exit was observed after the termination request"
            } else {
                $Run.exit_observation += "; retained parent exit was not observed within 5 seconds"
            }
        } catch {
            $Run.exit_observation += "; termination request failed: $($_.Exception.Message)"
        }
    }
    if ($evidence) {
        try { Write-InstallerEvidence $evidence.phase } catch { if (-not $journalFailure) { $journalFailure = $_.Exception.Message } }
    }
    if ($journalFailure) {
        throw "Process cleanup evidence could not be persisted after the termination attempt: $journalFailure"
    }
}

function Start-JournaledProcess([string]$Role, [string]$Executable, [object[]]$Arguments, [string]$AllowedRelocationRoot = "") {
    $exact = [System.IO.Path]::GetFullPath($Executable)
    $requested = [DateTime]::UtcNow
    $run = [ordered]@{ id = [System.Guid]::NewGuid().ToString("N"); role = $Role; requested_at = $requested.ToString("o"); requested_at_filetime = $requested.ToFileTimeUtc(); executable_path = $exact; executable_sha256 = (Get-FileHash -LiteralPath $exact -Algorithm SHA256).Hash.ToLowerInvariant(); arguments = @($Arguments); status = "launch_pending"; pid = $null; start_time = $null; start_time_filetime = $null; exit_code = $null; exit_observation = $null }
    if ($evidence) { $evidence.process_runs += $run; Write-InstallerEvidence $evidence.phase }
    $process = Start-Process -FilePath $exact -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        $run.pid = $process.Id; $run.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $run.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $run.status = "running"
        if ($evidence) { Write-InstallerEvidence $evidence.phase }
        if ($TestFault -eq "post-spawn-verification") {
            throw "$Role injected post-spawn verification failure"
        }
        $launchedPath = [System.IO.Path]::GetFullPath($process.StartInfo.FileName)
        if (-not $launchedPath.Equals($exact, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "$Role retained handle does not identify the exact requested launch path"
        }
        $imageDeadline = (Get-Date).AddSeconds(2)
        $observedPath = $null
        do {
            $process.Refresh()
            $candidatePath = try { $process.Path } catch { $null }
            if (-not [string]::IsNullOrWhiteSpace($candidatePath) -and [System.IO.Path]::GetExtension($candidatePath).Equals(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
                $observedPath = $candidatePath
                break
            }
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 25
        } while ((Get-Date) -lt $imageDeadline)
        if ([string]::IsNullOrWhiteSpace($observedPath)) {
            if (-not $process.HasExited) { throw "$Role stable executable image path could not be observed while it was running" }
            $run.image_observation = "Process exited before a stable executable image path was observable; StartInfo and the retained handle identify the exact hash-journaled launch"
            if ($evidence) { Write-InstallerEvidence $evidence.phase }
        } else {
            $actualPath = [System.IO.Path]::GetFullPath($observedPath)
            $run.observed_image_path = $actualPath
            if ($evidence) { Write-InstallerEvidence $evidence.phase }
            if (-not $actualPath.Equals($exact, [System.StringComparison]::OrdinalIgnoreCase)) {
                if (-not $AllowedRelocationRoot) { throw "$Role process path does not match its write-ahead record" }
                $relocationRoot = [System.IO.Path]::GetFullPath($AllowedRelocationRoot).TrimEnd('\')
                if (-not $actualPath.StartsWith($relocationRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "$Role process relocated outside its owned temporary root"
                }
                Assert-NoReparseAncestry $actualPath
            }
            if ((Get-FileHash -LiteralPath $actualPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $run.executable_sha256) { throw "$Role process bytes do not match its write-ahead record" }
            $run.image_observation = "Observed the exact hash-journaled image or its exact session-owned temporary copy"
            if ($evidence) { Write-InstallerEvidence $evidence.phase }
        }
        [pscustomobject]@{ process = $process; run = $run }
    } catch {
        $failure = $_.Exception.Message
        Stop-JournaledProcess $run $process "verification_failed" "Post-spawn verification failed: $failure"
        throw
    }
}

function Complete-JournaledProcess($Run, $Process, [string]$Status) {
    $Run.status = $Status; $Run.exit_code = $Process.ExitCode; $Run.exit_observation = "Observed through the retained launch handle"
    if ($evidence) { Write-InstallerEvidence $evidence.phase }
}

function Wait-JournaledUninstallerChild($ParentRun, [string]$TemporaryRoot, [DateTime]$Deadline) {
    # NSIS's initial process starts an exact temporary self-copy and exits.
    # Its launcher's exit code does not establish completion of that child.
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($ParentRun.pid)" -OperationTimeoutSec 2)
    foreach ($child in $children) {
        $process = try { [System.Diagnostics.Process]::GetProcessById([int]$child.ProcessId) } catch { $null }
        if (-not $process) { continue }
        $verified = $false
        try {
            $null = $process.Handle
            if ($process.HasExited) { continue }
            $started = $process.StartTime.ToUniversalTime()
            if ($started -lt [DateTime]::Parse($ParentRun.start_time).ToUniversalTime() -or
                [Math]::Abs(($started - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
                throw "Uninstaller child process identity changed before observation"
            }
            try {
                $observedPath = $process.Path
            } catch {
                if ($process.HasExited) { continue }
                throw
            }
            if ([string]::IsNullOrWhiteSpace($observedPath)) {
                # A short-lived cleanup child can exit between the HasExited
                # observation above and reading its executable image. Treat it
                # like a child that was already gone when this scan began.
                if ($process.HasExited) { continue }
                throw "Uninstaller child executable image path could not be observed"
            }
            $exact = [System.IO.Path]::GetFullPath($observedPath)
            $prefix = [System.IO.Path]::GetFullPath($TemporaryRoot).TrimEnd('\') + '\'
            if (-not $exact.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                -not $exact.Equals($child.ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Uninstaller child is outside its owned temporary root"
            }
            Assert-NoReparseAncestry $exact
            $hash = (Get-FileHash -LiteralPath $exact -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -ne $ParentRun.executable_sha256) { throw "Uninstaller child differs from the exact self-copy" }
            $run = [ordered]@{
                id = [System.Guid]::NewGuid().ToString("N"); role = "candidate_uninstaller_child";
                parent_run_id = $ParentRun.id; parent_pid = $ParentRun.pid;
                requested_at = $ParentRun.requested_at; requested_at_filetime = $ParentRun.requested_at_filetime;
                executable_path = $exact; executable_sha256 = $hash; arguments = @();
                status = "running"; pid = $process.Id; start_time = $started.ToString("o"); start_time_filetime = $started.ToFileTimeUtc();
                exit_code = $null; exit_observation = $null;
                image_observation = "Observed the retained child handle, parent PID, start time and exact self-copy in the owned temporary root"
            }
            $verified = $true
            if ($evidence) { $evidence.process_runs += $run; Write-InstallerEvidence $evidence.phase }
            $remaining = [Math]::Max(0, [int]($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if (-not $process.WaitForExit($remaining)) {
                Stop-JournaledProcess $run $process "timed_out" "Uninstaller child exceeded the operation's $ProcessTimeoutSeconds second deadline"
                throw "candidate_uninstaller_child did not exit within $ProcessTimeoutSeconds seconds"
            }
            Complete-JournaledProcess $run $process "exit_observed"
            if ($process.ExitCode -ne 0) { throw "Uninstaller child exited with code $($process.ExitCode)" }
        } catch {
            if ($verified -and $run.status -eq "running") {
                Stop-JournaledProcess $run $process "process_wait_failed" "Uninstaller child observation failed"
            }
            throw
        } finally { $process.Dispose() }
    }
}

function Invoke-JournaledProcess([string]$Role, [string]$Executable, [object[]]$Arguments, [string]$AllowedRelocationRoot = "") {
    $deadline = [DateTime]::UtcNow.AddSeconds($ProcessTimeoutSeconds)
    $launch = Start-JournaledProcess -Role $Role -Executable $Executable -Arguments $Arguments -AllowedRelocationRoot $AllowedRelocationRoot
    try {
        $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $launch.process.WaitForExit($remaining)) {
            Stop-JournaledProcess $launch.run $launch.process "timed_out" "No exit was observed within $ProcessTimeoutSeconds seconds"
            throw "$Role did not exit within $ProcessTimeoutSeconds seconds"
        }
        Complete-JournaledProcess $launch.run $launch.process "exit_observed"
        if ($Role -eq "candidate_uninstaller" -and $launch.process.ExitCode -eq 0) {
            Wait-JournaledUninstallerChild $launch.run $AllowedRelocationRoot $deadline
        }
        [pscustomobject]@{ ExitCode = $launch.process.ExitCode }
    } catch {
        if ($launch.run.status -ne "timed_out" -and $launch.run.status -ne "process_wait_failed") {
            $failure = $_.Exception.Message
            Stop-JournaledProcess $launch.run $launch.process "process_wait_failed" "Retained-handle wait or completion failed: $failure"
        }
        throw
    } finally {
        $launch.process.Dispose()
    }
}

$completed = $false
$previousLibrary = [System.Environment]::GetEnvironmentVariable("PORTCOVE_LIBRARY", "Process")
$previousTemp = @{}
try {
    foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
        $previousTemp[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
        [System.Environment]::SetEnvironmentVariable($name, $runRoot, "Process")
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $application = Join-Path $installRoot "portcove-desktop.exe"
    $uninstaller = Join-Path $installRoot "uninstall.exe"
    [System.Environment]::SetEnvironmentVariable("PORTCOVE_LIBRARY", $libraryRoot, "Process")
    $upgrade = $null
    if ($predecessor) {
        Write-InstallerEvidence "predecessor_installing"
        $previousInstall = Invoke-JournaledProcess -Role "predecessor_installer" -Executable $predecessor -Arguments @("/S", "/D=$installRoot") -AllowedRelocationRoot $runRoot
        if ($previousInstall.ExitCode -ne 0) {
            throw "Predecessor installer exited with code $($previousInstall.ExitCode)"
        }
        if (-not [System.IO.File]::Exists($uninstaller)) { throw "Predecessor did not publish an uninstaller" }
        if ($evidence) {
            $evidence.uninstaller_sha256 = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-InstallerEvidence "predecessor_installed"
        }
        $previousSmoke = Invoke-ApplicationSmoke $application "predecessor_smoke"
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
        Write-InstallerEvidence "predecessor_verified" $upgrade
    }
    # This is a qualification marker, not a fabricated game save.
    $sentinelRoot = Join-Path $libraryRoot "user\installer-qualification"
    [System.IO.Directory]::CreateDirectory($sentinelRoot) | Out-Null
    $sentinel = Join-Path $sentinelRoot "preserve.txt"
    [System.IO.File]::WriteAllText($sentinel, [System.Guid]::NewGuid().ToString("N"))
    $sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    Write-InstallerEvidence "candidate_installing"
    $installFlag = if ($InstallMode -eq "Passive") { "/P" } else { "/S" }
    # A predecessor establishes the exact registered destination. Exercise the
    # same updater path used by the application instead of silently forcing a
    # destination with /D, which could conceal relocation or ownership drift.
    $candidateArguments = if ($predecessor) { @($installFlag, "/UPDATE") } else { @($installFlag, "/D=$installRoot") }
    $install = Invoke-JournaledProcess -Role "candidate_installer" -Executable $installer -Arguments $candidateArguments -AllowedRelocationRoot $runRoot
    if ($install.ExitCode -ne 0) {
        throw "$InstallMode installer exited with code $($install.ExitCode)"
    }

    if (-not [System.IO.File]::Exists($application)) {
        throw "Installed application was not found at $application"
    }
    if (-not [System.IO.File]::Exists($uninstaller)) {
        throw "Uninstaller was not found at $uninstaller"
    }
    if ($evidence) {
        $evidence.uninstaller_sha256 = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-InstallerEvidence "candidate_installed"
    }

    $installedHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -and $installedHash -ne $expected.bundled_sha256) {
        throw "Installer did not publish the expected application bytes"
    }
    $registryEntries = Get-UninstallEntries $installRoot
    if (@($registryEntries).Count -ne 1) {
        throw "Expected exactly one uninstall registration for the isolated installation"
    }
    if ($ExpectedVersion) {
        if ($registryEntries[0].DisplayVersion -ne $ExpectedVersion) {
            throw "Installed registration does not match expected version $ExpectedVersion"
        }
        if ($registryEntries[0].PSPath -notmatch 'HKEY_CURRENT_USER') {
            throw "Expected current-user installation ownership"
        }
    }
    $smoke = Invoke-ApplicationSmoke $application "candidate_smoke"
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "Installation or application startup changed the isolated persistent-data marker"
    }

    if ($RetainExecutablePath) {
        $retained = [System.IO.Path]::GetFullPath($RetainExecutablePath)
        $retainedParent = [System.IO.Path]::GetDirectoryName($retained)
        if (-not [System.IO.Directory]::Exists($retainedParent)) { throw "RetainExecutablePath parent must exist" }
        if ([System.IO.File]::Exists($retained)) { throw "RetainExecutablePath must be new: $retained" }
        Copy-Item -LiteralPath $application -Destination $retained
        if ((Get-FileHash -LiteralPath $retained -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installedHash) {
            throw "Retained executable does not match the installed application"
        }
    }
    $beforeUninstallManifest = Get-PreservationManifest $libraryRoot
    Write-InstallerEvidence "candidate_verified" ([ordered]@{
        installed_executable_sha256 = $installedHash
        retained_executable_sha256 = if ($RetainExecutablePath) { $installedHash } else { $null }
        preservation_manifest = $beforeUninstallManifest
    })

    Write-InstallerEvidence "uninstalling"
    # NSIS may continue from an exact self-copy below TEMP. The original bytes
    # are journaled before launch; permit only that same image below this run.
    $uninstall = Invoke-JournaledProcess -Role "candidate_uninstaller" -Executable $uninstaller -Arguments @("/S") -AllowedRelocationRoot $runRoot
    if ($uninstall.ExitCode -ne 0) {
        throw "Silent uninstaller exited with code $($uninstall.ExitCode)"
    }
    $deadline = (Get-Date).AddSeconds($CleanupTimeoutSeconds)
    do {
        $managedFilesRemain = [System.IO.File]::Exists($application) -or
            [System.IO.File]::Exists($uninstaller)
        $remainingRegistryEntries = @(Get-UninstallEntries $installRoot)
        if (-not $managedFilesRemain -and $remainingRegistryEntries.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $managedFilesRemain = [System.IO.File]::Exists($application) -or
        [System.IO.File]::Exists($uninstaller)
    $remainingRegistryEntries = @(Get-UninstallEntries $installRoot)
    Write-InstallerEvidence "cleanup_observed" ([ordered]@{
        application_present = [System.IO.File]::Exists($application)
        uninstaller_present = [System.IO.File]::Exists($uninstaller)
        remaining_registration_paths = @($remainingRegistryEntries | ForEach-Object { $_.PSPath })
        preservation_manifest = Get-PreservationManifest $libraryRoot
        observed_at = (Get-Date).ToUniversalTime().ToString("o")
    })
    if ($managedFilesRemain) {
        throw "Uninstall left managed application files behind in $installRoot"
    }
    if ($remainingRegistryEntries.Count -ne 0) {
        throw "Uninstall left registration entries behind for $installRoot"
    }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash -or
        -not [System.IO.File]::Exists((Join-Path $libraryRoot "portcove.sqlite3"))) {
        throw "Uninstall did not preserve the isolated library and persistent-data marker"
    }
    $afterUninstallManifest = Get-PreservationManifest $libraryRoot
    if (($beforeUninstallManifest | ConvertTo-Json -Depth 6 -Compress) -ne
        ($afterUninstallManifest | ConvertTo-Json -Depth 6 -Compress)) {
        throw "Uninstall changed the recursive isolated-library manifest"
    }

    $completed = $true
    $result = [pscustomobject]@{
        installer = $installer
        installer_sha256 = $installerHash
        signature_status = $signature.Status.ToString()
        install_exit_code = $install.ExitCode
        install_mode = $InstallMode
        update_path = if ($predecessor) { "registered_nsis_update" } else { "explicit_bootstrap_destination" }
        registered_version = $registryEntries[0].DisplayVersion
        registration_path = $registryEntries[0].PSPath
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
        preservation_manifest_before_uninstall = $beforeUninstallManifest
        preservation_manifest_after_uninstall = $afterUninstallManifest
    }
    Write-InstallerEvidence "complete" $result
    $result | ConvertTo-Json -Depth 10 -Compress
}
catch {
    if ($evidence) {
        $evidence.failure = $_.Exception.Message
        Write-InstallerEvidence "failed"
    }
    throw
}
finally {
    foreach ($name in $previousTemp.Keys) {
        if ($null -eq $previousTemp[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [System.Environment]::SetEnvironmentVariable($name, $previousTemp[$name], "Process") }
    }
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
