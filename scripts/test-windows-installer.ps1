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
    [string]$PayloadPrivateKeyPath,
    [string]$TufPrivateRootPath,
    [switch]$RequireSigningAuthorityAbsent,
    [string]$InstalledUpdateTrustedRootPath,
    [string]$InstalledUpdateMetadataPath,
    [string]$InstalledUpdateTargetsPath,
    [string]$InstalledUpdateCandidatePath,
    [string]$InstalledUpdatePredecessorVersion,
    [ValidateSet("", "post-spawn-verification")]
    [string]$TestFault = ""
)

$ErrorActionPreference = "Stop"
$null = $ProcessTimeoutSeconds, $TestFault
$ProcessIdentityClockToleranceMilliseconds = 1000

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

function Get-ComparableWindowsPath([string]$Path) {
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $Path = '\\' + $Path.Substring(8)
    } elseif ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        $Path = $Path.Substring(4)
    }
    if (-not [IO.Path]::IsPathFullyQualified($Path)) {
        throw "Worker binding path is not fully qualified"
    }
    [IO.Path]::GetFullPath($Path)
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
$installedUpdate = -not [string]::IsNullOrWhiteSpace($InstalledUpdateTrustedRootPath)
if ($installedUpdate -and (-not $predecessor -or -not $InstalledUpdateMetadataPath -or
        -not $InstalledUpdateTargetsPath -or -not $InstalledUpdateCandidatePath -or
        -not $InstalledUpdatePredecessorVersion -or -not $RequireSigningAuthorityAbsent)) {
    throw "Installed update qualification requires a predecessor, complete signed repository paths, and absent signing authority"
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
if ($RequireSigningAuthorityAbsent) {
    if ([string]::IsNullOrWhiteSpace($PayloadPrivateKeyPath)) {
        throw "PayloadPrivateKeyPath is required when signing authority must be absent"
    }
    if ($installedUpdate -and [string]::IsNullOrWhiteSpace($TufPrivateRootPath)) {
        throw "TufPrivateRootPath is required for installed application update qualification"
    }
    $privateSigningInputsAbsent = [ordered]@{
        payload_private_key = -not [System.IO.File]::Exists([System.IO.Path]::GetFullPath($PayloadPrivateKeyPath))
        tuf_private_root = -not $TufPrivateRootPath -or -not [System.IO.Directory]::Exists([System.IO.Path]::GetFullPath($TufPrivateRootPath))
        signing_private_key_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
        signing_private_key_path_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PATH", "Process")
        signing_password_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Process")
    }
    if ($evidence) { $evidence.private_signing_inputs_absent = $privateSigningInputsAbsent }
    Write-InstallerEvidence "signing_authority_checked"
    if ($privateSigningInputsAbsent.Values -contains $false) {
        throw "Disposable signing authority is available to the Windows package lifecycle"
    }
} else {
    Write-InstallerEvidence "initialized"
}

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
    if ($Role -eq "installed_update_helper") {
        $run.output_relative = "installed-update-helper.stdout.log"
        $run.error_relative = "installed-update-helper.stderr.log"
        $process = Start-Process -FilePath $exact -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot $run.output_relative) -RedirectStandardError (Join-Path $runRoot $run.error_relative)
    } else {
        $process = Start-Process -FilePath $exact -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    }
    try {
        $run.pid = $process.Id; $run.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $run.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $run.status = "running"
        if ($evidence) { Write-InstallerEvidence $evidence.phase }
        if ($TestFault -eq "post-spawn-verification") {
            throw "$Role injected post-spawn verification failure"
        }
        $startInfoPath = $process.StartInfo.FileName
        if ([string]::IsNullOrWhiteSpace($startInfoPath)) {
            if ($Role -ne "installed_update_helper") {
                throw "$Role retained handle omitted the requested launch path"
            }
            $run.start_info_observation = "Start-Process omitted StartInfo.FileName with redirected qualification output; live process image verification is required"
        } else {
            $launchedPath = [System.IO.Path]::GetFullPath($startInfoPath)
            if (-not $launchedPath.Equals($exact, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "$Role retained handle does not identify the exact requested launch path"
            }
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
            if ($Role -eq "installed_update_helper") {
                throw "Installed update helper exited before its executable image could be verified"
            }
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
            $cimPath = [string]$child.ExecutablePath
            # The parent can exit before this query and Windows may reuse its
            # PID. Ignore those unowned descendants before applying identity
            # checks to the exact session-owned self-copy.
            if ([string]::IsNullOrWhiteSpace($cimPath) -or
                -not $exact.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                -not $exact.Equals($cimPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $parentStarted = [DateTime]::Parse($ParentRun.start_time).ToUniversalTime()
            if ($started -lt $parentStarted.AddMilliseconds(-$ProcessIdentityClockToleranceMilliseconds) -or
                [Math]::Abs(($started - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt $ProcessIdentityClockToleranceMilliseconds) {
                throw "Owned uninstaller child process identity changed before observation"
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
$updateEnvironmentNames = @(
    "PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE",
    "PORTCOVE_APPLICATION_UPDATE_METADATA_URL",
    "PORTCOVE_APPLICATION_UPDATE_TARGETS_URL",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_STAGING",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE"
)
$previousUpdateEnvironment = @{}
foreach ($name in $updateEnvironmentNames) {
    $previousUpdateEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
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
    if ($installedUpdate) {
        $updateRoot = Join-Path $runRoot "application-update"
        $updatePreferences = Join-Path $runRoot "application-update-preferences.json"
        $qualificationStage = Join-Path $runRoot "application-update-qualification-stage.json"
        $trustedRoot = (Resolve-Path -LiteralPath $InstalledUpdateTrustedRootPath).Path
        $metadata = (Resolve-Path -LiteralPath $InstalledUpdateMetadataPath).Path
        $targets = (Resolve-Path -LiteralPath $InstalledUpdateTargetsPath).Path
        $candidate = (Resolve-Path -LiteralPath $InstalledUpdateCandidatePath).Path
        $preparedText = (& cargo run --locked --quiet -p portcove-desktop --example prepare_installed_update -- prepare $InstalledUpdatePredecessorVersion $trustedRoot $metadata $targets $candidate $updatePreferences $updateRoot $libraryRoot | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Signed Windows application update fixture could not be prepared" }
        $prepared = $preparedText | ConvertFrom-Json
        if ($prepared.candidate_sha256 -ne $installerHash -or
            [UInt64]$prepared.candidate_bytes -ne [UInt64](Get-Item -LiteralPath $installer).Length) {
            throw "Prepared Windows application update differs from the exact candidate installer"
        }
        $env:PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE = $trustedRoot
        $env:PORTCOVE_APPLICATION_UPDATE_METADATA_URL = ([Uri]::new($metadata.TrimEnd('\', '/') + '/')).AbsoluteUri
        $env:PORTCOVE_APPLICATION_UPDATE_TARGETS_URL = ([Uri]::new($targets.TrimEnd('\', '/') + '/')).AbsoluteUri
        $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = $updatePreferences
        $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $updateRoot
        $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT = "after-reconciliation"
        $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE = $qualificationStage
        Write-InstallerEvidence "installed_helper_starting" ([ordered]@{ prepared = $prepared; predecessor_executable_sha256 = $previousHash })
        $staging = Invoke-JournaledProcess -Role "installed_update_stage" -Executable $application -Arguments @("--portcove-stage-update-worker", [string]$prepared.apply_revision) -AllowedRelocationRoot $runRoot
        if ($staging.ExitCode -ne 0) {
            $stageErrorPath = Join-Path $updateRoot "worker-stage-error.txt"
            $stageError = if ([IO.File]::Exists($stageErrorPath)) { [IO.File]::ReadAllText($stageErrorPath) } else { "no stage diagnostic was recorded" }
            throw "Installed predecessor could not stage its update worker (exit $($staging.ExitCode)): $stageError"
        }
        $revisionRoot = Join-Path $updateRoot "workers\revision-$($prepared.apply_revision)"
        $attempts = @(Get-ChildItem -LiteralPath $revisionRoot -Directory -ErrorAction Stop)
        if ($attempts.Count -ne 1) { throw "Expected one revision-bound installed update worker attempt" }
        $worker = Join-Path $attempts[0].FullName "portcove-update-worker.exe"
        $workerManifest = Join-Path $attempts[0].FullName "worker.json"
        Assert-NoReparseAncestry $worker
        Assert-NoReparseAncestry $workerManifest
        if (-not [IO.File]::Exists($worker) -or -not [IO.File]::Exists($workerManifest)) {
            throw "Installed update worker or its binding was not published"
        }
        $workerHash = (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant()
        $binding = Get-Content -LiteralPath $workerManifest -Raw | ConvertFrom-Json
        $workerHashMatches = $workerHash -eq $previousHash
        $bindingHashMatches = $binding.installed_sha256 -eq $previousHash
        $revisionMatches = $binding.revision -eq $prepared.apply_revision
        $installedPathMatches = (Get-ComparableWindowsPath ([string]$binding.installed_executable)).Equals(
            (Get-ComparableWindowsPath $application), [StringComparison]::OrdinalIgnoreCase)
        if (-not ($workerHashMatches -and $bindingHashMatches -and $revisionMatches -and $installedPathMatches)) {
            throw "Installed update worker binding mismatch: worker_hash=$workerHashMatches manifest_hash=$bindingHashMatches revision=$revisionMatches installed_path=$installedPathMatches"
        }
        Write-InstallerEvidence "installed_worker_verified" ([ordered]@{ worker_path = $worker; worker_sha256 = $workerHash; binding = $binding })
        $helperStart = [DateTime]::UtcNow
        $install = Invoke-JournaledProcess -Role "installed_update_helper" -Executable $worker -Arguments @("--portcove-apply-update", [string]$prepared.apply_revision) -AllowedRelocationRoot $runRoot
        if ($install.ExitCode -ne 0) { throw "Installed application update helper exited with code $($install.ExitCode)" }
        $deadline = (Get-Date).AddSeconds(30)
        $stageReadError = $null
        do {
            if ([IO.File]::Exists($qualificationStage)) {
                try {
                    $stage = Get-Content -LiteralPath $qualificationStage -Raw | ConvertFrom-Json
                    $stageReadError = $null
                    if ($stage.stage -eq "Tauri setup") { break }
                } catch {
                    $stage = $null
                    $stageReadError = $_.Exception.Message
                }
            }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if (-not $stage -or $stage.stage -ne "Tauri setup") {
            throw "Updated installed application did not reach Tauri setup after helper relaunch; last stage read error: $stageReadError"
        }
        $applyReadError = $null
        do {
            try {
                $applyState = Get-Content -LiteralPath (Join-Path $updateRoot "apply.json") -Raw | ConvertFrom-Json
                $applyReadError = $null
                if (-not $applyState.intent) { break }
            } catch {
                $applyState = $null
                $applyReadError = $_.Exception.Message
            }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if (-not $applyState -or $applyState.intent) {
            throw "Updated installed application did not reconcile its durable apply intent; last state read error: $applyReadError"
        }
        $relaunchPid = [int]$stage.process_id
        if ($relaunchPid -le 0) { throw "Qualification stage omitted the candidate relaunch process ID" }
        $relaunch = try { [Diagnostics.Process]::GetProcessById($relaunchPid) } catch [ArgumentException] { $null }
        # GetProcessById attaches after the helper spawned the candidate. An
        # attached Process can observe a bounded exit but does not provide a
        # reliable ExitCode; candidate_smoke below owns an exit-code assertion.
        $relaunchExit = [ordered]@{ pid = $relaunchPid; observed = $null; exit_code = $null; observation = "not_present_at_attach" }
        if ($relaunch) {
            try {
                $relaunch.Refresh()
                if (-not $relaunch.HasExited) {
                    $observedPath = try { $relaunch.Path } catch {
                        if ($relaunch.HasExited) { $null } else { throw }
                    }
                    if ($observedPath) {
                        $observedPath = [IO.Path]::GetFullPath($observedPath)
                        if (-not $observedPath.Equals($application, [StringComparison]::OrdinalIgnoreCase) -or
                            $relaunch.StartTime.ToUniversalTime() -lt $helperStart.AddSeconds(-2)) {
                            throw "Qualification relaunch PID does not identify the installed candidate process"
                        }
                        $relaunchExit.observed = $observedPath
                    } elseif (-not $relaunch.HasExited) {
                        throw "Qualification relaunch is still running but its image path could not be observed"
                    }
                }
                if ($relaunchExit.observed -and -not $relaunch.HasExited) {
                    if (-not $relaunch.WaitForExit(30000)) {
                        Write-InstallerEvidence "installed_relaunch_exit_timeout" ([ordered]@{ prepared = $prepared; qualification_stage = $stage; relaunch = $relaunchExit })
                        throw "Updated installed application did not exit after qualification reconciliation"
                    }
                }
                $relaunchExit.observation = if ($relaunchExit.observed) { "identified_process_exited" } else { "exited_before_identity_observation" }
            } finally { $relaunch.Dispose() }
        }
        Write-InstallerEvidence "installed_helper_reconciled" ([ordered]@{ prepared = $prepared; qualification_stage = $stage; apply_state = $applyState; relaunch = $relaunchExit })
        # The next smoke is an ordinary interactive candidate launch. Keep the
        # saved values for the outer finally, but do not let the qualification
        # relaunch's immediate-exit mode suppress its window and close checks.
        [Environment]::SetEnvironmentVariable("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT", $null, "Process")
        [Environment]::SetEnvironmentVariable("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE", $null, "Process")
    } else {
        $installFlag = if ($InstallMode -eq "Passive") { "/P" } else { "/S" }
        # A predecessor establishes the registered destination. /UPDATE must
        # keep that identity without a caller-supplied destination.
        $candidateArguments = if ($predecessor) { @($installFlag, "/UPDATE") } else { @($installFlag, "/D=$installRoot") }
        $install = Invoke-JournaledProcess -Role "candidate_installer" -Executable $installer -Arguments $candidateArguments -AllowedRelocationRoot $runRoot
        if ($install.ExitCode -ne 0) { throw "$InstallMode installer exited with code $($install.ExitCode)" }
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
        update_path = if ($installedUpdate) { "installed_app_helper" } elseif ($predecessor) { "registered_nsis_update" } else { "explicit_bootstrap_destination" }
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
    foreach ($name in $updateEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousUpdateEnvironment[$name], "Process")
    }
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
