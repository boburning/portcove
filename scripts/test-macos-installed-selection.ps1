param(
    [Parameter(Mandatory = $true)][string]$QualifiedAppPath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$ExpectedCandidateAppPath,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [Parameter(Mandatory = $true)][string]$PredecessorVersion,
    [Parameter(Mandatory = $true)][string]$CandidateVersion,
    [Parameter(Mandatory = $true)][string]$PayloadPrivateKeyPath,
    [Parameter(Mandatory = $true)][string]$TufPrivateRootPath
)

$ErrorActionPreference = "Stop"
if (-not $IsMacOS) { throw "This qualification requires macOS" }
if ([IO.File]::Exists($PayloadPrivateKeyPath) -or [IO.Directory]::Exists($TufPrivateRootPath) -or
    $env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_PATH -or $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    throw "Disposable signing authority remained available before installed application selection"
}

function Invoke-BundleSelection([string]$Executable, [string]$Payload = "") {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    if ($Payload) {
        $start.ArgumentList.Add("--portcove-qualify-update-stage")
        $start.ArgumentList.Add($Payload)
    } else {
        $start.ArgumentList.Add("--portcove-qualify-update-selection")
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Could not start the installed macOS application" }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) {
            if (-not $process.HasExited) { $process.Kill($true) }
            if (-not $process.WaitForExit(5000)) {
                throw "Installed macOS application update qualification timed out and process exit was not confirmed"
            }
            throw "Installed macOS application update qualification timed out"
        }
        if ($stdout.Result.Length -gt 4096 -or $stderr.Result.Length -gt 4096) {
            throw "Installed macOS application update qualification output was oversized"
        }
        return [ordered]@{
            exit_code = $process.ExitCode
            stdout = $stdout.Result.Trim()
            stderr = $stderr.Result.Trim()
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-InstalledProcess([string]$Executable, [string[]]$Arguments = @(), [int]$TimeoutMilliseconds = 90000) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Could not start the installed macOS application process" }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            if (-not $process.HasExited) { $process.Kill($true) }
            if (-not $process.WaitForExit(5000)) { throw "Installed macOS process timed out without confirmed exit" }
            throw "Installed macOS process timed out"
        }
        if ($stdout.Result.Length -gt 8192 -or $stderr.Result.Length -gt 8192) {
            throw "Installed macOS process output was oversized"
        }
        return [ordered]@{ exit_code = $process.ExitCode; stdout = $stdout.Result.Trim(); stderr = $stderr.Result.Trim() }
    } finally {
        $process.Dispose()
    }
}

$state = [ordered]@{
    schema_version = 1
    phase = "started"
    source_commit = (& git rev-parse HEAD | Out-String).Trim()
    platform = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -eq "Arm64") { "macos-aarch64" } else { "macos-x86_64" }
    os_version = (& /usr/bin/sw_vers -productVersion | Out-String).Trim()
    process_architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    production_signing = $false
    failure = $null
}
try {
    $installedRoot = Join-Path (Split-Path -Parent $EvidencePath) "state/user-home/Applications"
    New-Item -ItemType Directory -Path $installedRoot -Force | Out-Null
    $installedApp = Join-Path $installedRoot "Portcove.app"
    if (Test-Path -LiteralPath $installedApp) { throw "The installed app path must be new" }
    Copy-Item -LiteralPath $QualifiedAppPath -Destination $installedApp -Recurse
    $executable = Join-Path $installedApp "Contents/MacOS/portcove-desktop"
    & /usr/bin/codesign --verify --deep --strict $installedApp
    if ($LASTEXITCODE -ne 0) { throw "The installed copy did not retain its bundle signature" }
    $before = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    $candidate = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $StateRoot
    $selection = Invoke-BundleSelection $executable
    if ($selection.exit_code -ne 0) { throw "Installed macOS candidate selection failed: $($selection.stderr)" }
    $selected = $selection.stdout | ConvertFrom-Json
    if ($selected.state -ne "update-available" -or $selected.version -ne $CandidateVersion -or $selected.sha256 -ne $candidate) {
        throw "Installed macOS candidate selection did not match the signed packaged candidate"
    }
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $before) {
        throw "Installed macOS selection changed the running bundle"
    }
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $StateRoot "application-update-preferences.json"
    $env:PORTCOVE_APPLICATION_UPDATE_SCHEDULE = Join-Path $StateRoot "application-update-schedule.json"
    $truncatedCandidate = Join-Path $StateRoot "truncated-candidate.app.tar.gz"
    Copy-Item -LiteralPath $CandidatePath -Destination $truncatedCandidate
    $truncatedFile = [IO.File]::OpenWrite($truncatedCandidate)
    try { $truncatedFile.SetLength($truncatedFile.Length - 1) } finally { $truncatedFile.Dispose() }
    $truncated = Invoke-BundleSelection $executable $truncatedCandidate
    $stagingJournal = Join-Path $StateRoot "staging.json"
    if ($truncated.exit_code -eq 0 -or $truncated.stderr -notmatch "payload length mismatch" -or
        -not (Test-Path -LiteralPath $stagingJournal -PathType Leaf)) {
        throw "Installed macOS truncated archive was not rejected by the staging verifier"
    }
    $empty = Get-Content -LiteralPath $stagingJournal -Raw | ConvertFrom-Json
    if ($empty.phase -ne "empty" -or $null -ne $empty.candidate -or $null -ne $empty.previous_candidate -or
        (Test-Path -LiteralPath (Join-Path $StateRoot "candidate.payload")) -or
        (Test-Path -LiteralPath (Join-Path $StateRoot ".candidate.payload.incoming")) -or
        (Test-Path -LiteralPath (Join-Path $StateRoot "apply.json")) -or
        (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $before) {
        throw "Truncated macOS archive left staging authority or changed the installed predecessor"
    }
    $state.truncated_stage = [ordered]@{ exit_code = $truncated.exit_code; staging_empty = $true; predecessor_preserved = $true }
    $staged = Invoke-BundleSelection $executable $CandidatePath
    if ($staged.exit_code -ne 0) { throw "Installed macOS staging failed: $($staged.stderr)" }
    $stagedIdentity = $staged.stdout | ConvertFrom-Json
    $stagedPayload = Join-Path $StateRoot "candidate.payload"
    if (-not (Test-Path -LiteralPath $stagedPayload -PathType Leaf)) {
        throw "Installed macOS staging did not retain the authenticated archive"
    }
    $stagedPayloadBytes = (Get-Item -LiteralPath $stagedPayload).Length
    $stagedPayloadHash = (Get-FileHash -LiteralPath $stagedPayload -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedIdentity.version -ne $CandidateVersion -or $stagedIdentity.sha256 -ne $candidate -or
        $stagedIdentity.bytes -ne (Get-Item -LiteralPath $CandidatePath).Length -or
        $stagedPayloadBytes -ne $stagedIdentity.bytes -or $stagedPayloadHash -ne $candidate -or
        (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $before -or
        (Test-Path -LiteralPath (Join-Path $StateRoot ".candidate.payload.incoming")) -or
        (Test-Path -LiteralPath (Join-Path $StateRoot "apply.json"))) {
        throw "Installed macOS staging did not retain exactly the authenticated archive"
    }
    $state.installed_stage = [ordered]@{ version = $stagedIdentity.version; sha256 = $stagedIdentity.sha256; bytes = $stagedIdentity.bytes; staged_payload_sha256 = $stagedPayloadHash; staged_payload_bytes = $stagedPayloadBytes; predecessor_preserved = $true }
    $modeBefore = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
    $modeBits = [Convert]::ToInt32($modeBefore, 8)
    if (($modeBits -band 128) -eq 0) { throw "The installed bundle parent did not begin owner-writable" }
    $expectedDenied = [Convert]::ToString(($modeBits -band (-bnot 128)), 8)
    try {
        & /bin/chmod u-w $installedRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not remove bundle-parent owner write permission" }
        $modeDenied = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
        $rejection = Invoke-BundleSelection $executable
    } finally {
        & /bin/chmod $modeBefore $installedRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not restore bundle-parent owner write permission" }
    }
    $modeRestored = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
    $after = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($modeDenied -ne $expectedDenied -or $modeRestored -ne $modeBefore -or
        $rejection.exit_code -ne 1 -or $rejection.stderr -notmatch 'not readable and writable by its owner' -or
        $after -ne $before) {
        throw "Installed macOS owner-write rejection or restoration was not established"
    }
    $state.predecessor = [ordered]@{
        version = $PredecessorVersion
        retained_bundle = $QualifiedAppPath
        installed_bundle = $installedApp
        executable_sha256 = $before
        signature_verified = $true
    }
    $state.candidate = [ordered]@{ version = $CandidateVersion; path = $CandidatePath; sha256 = $candidate }
    $state.selection = [ordered]@{ exit_code = $selection.exit_code; state = $selected.state; version = $selected.version; sha256 = $selected.sha256; installed_executable_preserved = $true }
    $state.owner_write_rejection = [ordered]@{ exit_code = $rejection.exit_code; error = $rejection.stderr; mode_before = $modeBefore; mode_denied = $modeDenied; mode_restored = $modeRestored; executable_sha256_after_restore = $after }
    $expectedCandidateExecutable = Join-Path $ExpectedCandidateAppPath "Contents/MacOS/portcove-desktop"
    if (-not (Test-Path -LiteralPath $expectedCandidateExecutable -PathType Leaf)) { throw "The retained candidate bundle executable is unavailable" }
    $expectedExecutableHash = (Get-FileHash -LiteralPath $expectedCandidateExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $libraryRoot = Join-Path $StateRoot "library"
    $libraryMarker = Join-Path $libraryRoot "user/installer-qualification/preserve.txt"
    New-Item -ItemType Directory -Path (Split-Path -Parent $libraryMarker) -Force | Out-Null
    [IO.File]::WriteAllText($libraryMarker, "macOS installed-bundle preservation", [Text.UTF8Encoding]::new($false))
    $libraryMarkerHash = (Get-FileHash -LiteralPath $libraryMarker -Algorithm SHA256).Hash.ToLowerInvariant()
    $env:PORTCOVE_LIBRARY = $libraryRoot
    $env:PORTCOVE_PREFERENCES = Join-Path $StateRoot "host-preferences.json"
    $env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $StateRoot "application-runtime.lock"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT = "after-reconciliation"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE = Join-Path $StateRoot "candidate-startup-stage.json"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS = Join-Path $StateRoot "candidate-relaunch-process.json"
    $preparedText = (& cargo run --locked --quiet -p portcove-desktop --example prepare_installed_update -- prepare-staged $PredecessorVersion $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES $StateRoot $libraryRoot | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare the macOS installed-bundle apply intent" }
    $prepared = $preparedText | ConvertFrom-Json
    if ($prepared.candidate_version -ne $CandidateVersion -or $prepared.candidate_sha256 -ne $candidate) {
        throw "Prepared macOS apply identity differed from the authenticated staged candidate"
    }
    $applyPath = Join-Path $StateRoot "apply.json"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT = "after-bundle-swap"
    try {
        $interrupted = Invoke-InstalledProcess $executable @("--portcove-apply-update", [string]$prepared.apply_revision)
    } finally {
        Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT -ErrorAction SilentlyContinue
    }
    $backupApp = Join-Path $installedRoot ".portcove-update-$($candidate.Substring(0, 16))/Portcove.app"
    $backupExecutable = Join-Path $backupApp "Contents/MacOS/portcove-desktop"
    $applyAfterInterrupt = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
    $installedCandidateHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    $backupHash = if (Test-Path -LiteralPath $backupExecutable -PathType Leaf) { (Get-FileHash -LiteralPath $backupExecutable -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    if ($interrupted.exit_code -ne 86 -or $applyAfterInterrupt.native_launch -ne "starting" -or
        $installedCandidateHash -ne $expectedExecutableHash -or $backupHash -ne $before -or
        (Get-FileHash -LiteralPath $libraryMarker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $libraryMarkerHash) {
        throw "Interrupted macOS bundle exchange did not retain the exact candidate, predecessor, journal and library"
    }
    $state.interrupted_apply = [ordered]@{
        helper_exit_code = $interrupted.exit_code
        candidate_executable_sha256 = $installedCandidateHash
        predecessor_backup_executable_sha256 = $backupHash
        journal_state = $applyAfterInterrupt.native_launch
        library_marker_sha256 = $libraryMarkerHash
    }
    & /usr/bin/codesign --verify --deep --strict $installedApp
    if ($LASTEXITCODE -ne 0) { throw "The exchanged candidate bundle signature failed verification" }
    $candidateStartup = Invoke-InstalledProcess $executable @()
    $applyAfterStartup = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
    $installedVersion = (& /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' (Join-Path $installedApp 'Contents/Info.plist') | Out-String).Trim()
    if ($candidateStartup.exit_code -ne 0 -or $installedVersion -ne $CandidateVersion -or
        $null -ne $applyAfterStartup.intent -or $null -ne $applyAfterStartup.native_launch -or
        (Test-Path -LiteralPath $backupApp) -or
        (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedExecutableHash -or
        (Get-FileHash -LiteralPath $libraryMarker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $libraryMarkerHash) {
        throw "The installed macOS candidate did not reconcile after healthy startup"
    }
    $state.installed_apply = [ordered]@{
        candidate_startup_exit_code = $candidateStartup.exit_code
        installed_version = $installedVersion
        installed_executable_sha256 = $expectedExecutableHash
        backup_removed_after_healthy_startup = $true
        library_marker_preserved = $true
    }
    # A separate installed copy drives the ordinary renderer and lets its
    # post-exit helper finish without the interruption used above.
    $guiRoot = Join-Path (Split-Path -Parent $EvidencePath) "gui-user-home/Applications"
    New-Item -ItemType Directory -Path $guiRoot -Force | Out-Null
    $guiApp = Join-Path $guiRoot "Portcove.app"
    if (Test-Path -LiteralPath $guiApp) { throw "The GUI qualification installation must be new" }
    Copy-Item -LiteralPath $QualifiedAppPath -Destination $guiApp -Recurse
    $guiExecutable = Join-Path $guiApp "Contents/MacOS/portcove-desktop"
    & /usr/bin/codesign --verify --deep --strict $guiApp
    if ($LASTEXITCODE -ne 0) { throw "The GUI qualification predecessor signature failed verification" }
    $guiState = Join-Path (Split-Path -Parent $EvidencePath) "gui-update-state"
    New-Item -ItemType Directory -Path $guiState -Force | Out-Null
    $guiLibraryMarker = Join-Path $guiState "library/user/installer-qualification/preserve.txt"
    New-Item -ItemType Directory -Path (Split-Path -Parent $guiLibraryMarker) -Force | Out-Null
    [IO.File]::WriteAllText($guiLibraryMarker, "macOS renderer update preservation", [Text.UTF8Encoding]::new($false))
    $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $guiState
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD = $CandidatePath
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $guiState "application-update-preferences.json"
    $env:PORTCOVE_APPLICATION_UPDATE_SCHEDULE = Join-Path $guiState "application-update-schedule.json"
    $env:PORTCOVE_LIBRARY = Join-Path $guiState "library"
    $env:PORTCOVE_PREFERENCES = Join-Path $guiState "host-preferences.json"
    $env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $guiState "application-runtime.lock"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT = "1"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS = Join-Path $guiState "helper-process.json"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS = Join-Path $guiState "relaunch-process.json"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE = Join-Path $guiState "candidate-startup-stage.json"
    Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT -ErrorAction SilentlyContinue
    $guiEvidence = Join-Path (Split-Path -Parent $EvidencePath) "renderer-qualification"
    & corepack pnpm --dir apps/desktop test:macos-installed-update --app $guiExecutable --output $guiEvidence --staging $guiState --candidate-sha $expectedExecutableHash --candidate-archive-sha $candidate --candidate-version $CandidateVersion --helper-marker $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS --relaunch-marker $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS --stage-marker $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE --library-marker $guiLibraryMarker
    if ($LASTEXITCODE -ne 0) { throw "Installed macOS renderer restart qualification failed" }
    & /usr/bin/codesign --verify --deep --strict $guiApp
    if ($LASTEXITCODE -ne 0) { throw "The GUI-updated bundle signature failed verification" }
    $guiInstalledVersion = (& /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' (Join-Path $guiApp 'Contents/Info.plist') | Out-String).Trim()
    $guiBackup = Join-Path $guiRoot ".portcove-update-$($candidate.Substring(0, 16))/Portcove.app"
    if ($guiInstalledVersion -ne $CandidateVersion -or (Test-Path -LiteralPath $guiBackup)) {
        throw "Installed macOS renderer restart did not retain only the healthy candidate"
    }
    $state.renderer_restart = [ordered]@{
        evidence = $guiEvidence
        installed_version = $guiInstalledVersion
        candidate_executable_sha256 = (Get-FileHash -LiteralPath $guiExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
        signature_verified = $true
        backup_removed_after_healthy_startup = $true
    }
    $state.phase = "complete"
    $state.private_signing_inputs_absent = $true
} catch {
    $state.phase = "failed"
    $state.failure = $_.Exception.Message
    throw
} finally {
    $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
    Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_STAGING -ErrorAction SilentlyContinue
    foreach ($name in @("PORTCOVE_LIBRARY", "PORTCOVE_PREFERENCES", "PORTCOVE_APPLICATION_RUNTIME_LOCK", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT", "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT")) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}
