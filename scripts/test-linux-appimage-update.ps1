[CmdletBinding(DefaultParameterSetName = "Run")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$PredecessorPath,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$CandidatePath,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$TrustedRootPath,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$MetadataPath,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$TargetsPath,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$StateRoot,
    [Parameter(Mandatory = $true, ParameterSetName = "Run")][string]$EvidencePath,
    [Parameter(Mandatory = $true, ParameterSetName = "Describe")][switch]$DescribeContract,
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')]
    [string]$PredecessorVersion = "0.1.0",
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')]
    [string]$CandidateVersion = "0.3.0",
    [int]$StartupTimeoutSeconds = 30
)

$evidenceContract = [ordered]@{
    schema_version = 11
    predecessor_version = $PredecessorVersion
    candidate_version = $CandidateVersion
}
if ($DescribeContract) {
    $evidenceContract | ConvertTo-Json -Compress
    exit 0
}

$ErrorActionPreference = "Stop"
if (-not $IsLinux) { throw "The AppImage update harness requires Linux" }
if ($StartupTimeoutSeconds -lt 5 -or $StartupTimeoutSeconds -gt 120) { throw "StartupTimeoutSeconds must be between 5 and 120" }

function Resolve-ExistingFile([string]$Path, [string]$Label) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $resolved }
    throw "$Label must be a direct file"
}

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $resolved }
    throw "$Label must be a direct directory"
}

$predecessor = Resolve-ExistingFile $PredecessorPath "Predecessor AppImage"
$candidate = Resolve-ExistingFile $CandidatePath "Candidate AppImage"
$trustedRoot = Resolve-ExistingFile $TrustedRootPath "Trusted root"
$metadata = Resolve-ExistingDirectory $MetadataPath "TUF metadata"
$targets = Resolve-ExistingDirectory $TargetsPath "TUF targets"
$state = [IO.Path]::GetFullPath($StateRoot)
$evidenceFile = [IO.Path]::GetFullPath($EvidencePath)
if (Test-Path -LiteralPath $state) { throw "StateRoot must be new" }
if (Test-Path -LiteralPath $evidenceFile) { throw "EvidencePath must be new" }
New-Item -ItemType Directory -Path $state | Out-Null

$installedRoot = Join-Path $state "installed"
$libraryRoot = Join-Path $state "library"
$updateRoot = Join-Path $state "update-state"
$hostPreferences = Join-Path $state "host-preferences.json"
$updatePreferences = Join-Path $state "application-update-preferences.json"
$stable = Join-Path $installedRoot "Portcove.AppImage"
New-Item -ItemType Directory -Path $installedRoot, $libraryRoot | Out-Null
& /usr/bin/cp --preserve=mode,timestamps -- $predecessor $stable
if ($LASTEXITCODE -ne 0) { throw "Could not create the stable AppImage fixture" }
& chmod u+rwx,go+rx -- $stable
if ($LASTEXITCODE -ne 0) { throw "Could not make the stable AppImage executable" }

$predecessorHash = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
$sentinelRoot = Join-Path $libraryRoot "user/application-update-qualification"
New-Item -ItemType Directory -Path $sentinelRoot | Out-Null
$sentinel = Join-Path $sentinelRoot "preserve.txt"
[IO.File]::WriteAllText($sentinel, [Guid]::NewGuid().ToString("N"))
$sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash

$evidence = [ordered]@{
    schema_version = $evidenceContract.schema_version
    phase = "preparing"
    source_commit = (& git rev-parse HEAD | Out-String).Trim()
    platform = "linux-x86_64"
    predecessor = [ordered]@{ version = $evidenceContract.predecessor_version; path = $predecessor; sha256 = $predecessorHash }
    candidate = [ordered]@{ version = $evidenceContract.candidate_version; path = $candidate; sha256 = $candidateHash }
    stable_path = $stable
    apply_revision = $null
    truncated_payload_expected_bytes = $null
    truncated_payload_bytes = $null
    truncated_payload_exit_code = $null
    truncated_payload_rejected = $false
    truncated_payload_stable_preserved = $false
    truncated_payload_staging_empty = $false
    truncated_payload_data_preserved = $false
    interruption_exit_code = $null
    interruption_partial_bytes = $null
    interruption_recovery = "gui-independent-command"
    interruption_recovery_display = $null
    interruption_recovery_exit_code = $null
    interruption_recovered = $false
    interruption_stable_preserved = $false
    incompatible_schema_supported_version = $null
    incompatible_schema_version = 99
    incompatible_schema_exit_code = $null
    incompatible_schema_predecessor_restart_observed = $false
    incompatible_schema_state_preserved = $false
    incompatible_schema_recovery_action = "restore exact supported journal fixture"
    read_only_state_enforced = $false
    read_only_state_exit_code = $null
    read_only_state_predecessor_restart_observed = $false
    read_only_state_preserved = $false
    read_only_state_write_restored = $false
    read_only_state_recovery_action = "restore exact Unix modes"
    full_disk_state_enforced = $false
    full_disk_state_available_bytes = $null
    full_disk_state_exit_code = $null
    full_disk_state_predecessor_restart_observed = $false
    full_disk_state_preserved = $false
    full_disk_state_write_restored = $false
    full_disk_state_recovery_action = "remove bounded filler and unmount disposable tmpfs"
    full_appimage_filesystem_enforced = $false
    full_appimage_filesystem_available_bytes = $null
    full_appimage_filesystem_exit_code = $null
    full_appimage_filesystem_predecessor_restart_observed = $false
    full_appimage_filesystem_stable_preserved = $false
    full_appimage_filesystem_staging_preserved = $false
    full_appimage_filesystem_failed_revision = $null
    full_appimage_filesystem_retry_revision = $null
    full_appimage_filesystem_retryable_journal = $false
    full_appimage_filesystem_write_restored = $false
    full_appimage_filesystem_recovery_action = "remove bounded filler and unmount disposable tmpfs"
    runtime_contention_hold_seconds = 2
    runtime_contention_helper_blocked = $false
    runtime_contention_stable_preserved = $false
    runtime_contention_journal_preserved = $false
    post_exchange_exit_code = $null
    post_exchange_candidate_installed = $false
    post_exchange_backup_preserved = $false
    candidate_restart_exit_code = $null
    post_exchange_reconciled = $false
    stable_sha256 = $null
    executable_mode = $null
    persistent_data_preserved = $false
    candidate_restart_observed = $false
    production_signing = $false
    failure = $null
}

function Write-Evidence([string]$Phase) {
    $evidence.phase = $Phase
    $parent = [IO.Path]::GetDirectoryName($evidenceFile)
    if (-not [IO.Directory]::Exists($parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $temporary = "$evidenceFile.tmp"
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $evidenceFile -Force
}

function Wait-StablePredecessorRestart([string]$StagePath, [string]$RuntimeLockPath, [int]$TimeoutSeconds, [string]$FailureLabel) {
    $restartDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $restartStage = $null
    do {
        if (Test-Path -LiteralPath $StagePath -PathType Leaf) {
            try {
                $restartStage = Get-Content -LiteralPath $StagePath -Raw | ConvertFrom-Json
            } catch {
                $restartStage = $null
            }
        }
        if ($restartStage.stage -eq "Tauri setup") { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $restartDeadline)
    if ($restartStage.stage -ne "Tauri setup" -or $restartStage.process_id -le 0) {
        throw "$FailureLabel did not restart the stable predecessor through Tauri setup"
    }

    $restartExitDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        & flock --exclusive --nonblock $RuntimeLockPath /usr/bin/true 2>$null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $restartExitDeadline)
    throw "$FailureLabel predecessor restart did not release the runtime lock within $TimeoutSeconds seconds"
}

function Mount-BoundedTmpfs([string]$Path, [long]$SizeBytes) {
    if ($SizeBytes -le 0) { throw "Bounded tmpfs size must be positive" }
    if (Test-Path -LiteralPath $Path) { throw "Bounded tmpfs mount path must be new" }
    New-Item -ItemType Directory -Path $Path | Out-Null
    & /usr/bin/sudo -n /usr/bin/true
    if ($LASTEXITCODE -ne 0) { throw "Full-disk qualification requires non-interactive sudo" }
    $userId = (& /usr/bin/id -u | Out-String).Trim()
    $groupId = (& /usr/bin/id -g | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $userId -notmatch '^\d+$' -or $groupId -notmatch '^\d+$') {
        throw "Could not determine the qualification user identity"
    }
    $mountOptions = "size=$SizeBytes,mode=0700,uid=$userId,gid=$groupId"
    & /usr/bin/sudo -n /usr/bin/mount -t tmpfs -o $mountOptions tmpfs $Path
    if ($LASTEXITCODE -ne 0) { throw "Could not mount the bounded full-disk qualification filesystem" }
}

function Set-BoundedFilesystemFull([string]$Path, [string]$FillerPath, [string]$ProbePath, [string]$LogPath) {
    & /usr/bin/dd if=/dev/zero "of=$FillerPath" bs=1M status=none 2> $LogPath
    if ($LASTEXITCODE -eq 0) { throw "The bounded filesystem filler unexpectedly reached end-of-input" }
    $availableText = (& /usr/bin/df --output=avail -B1 -- $Path | Select-Object -Last 1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $availableText -notmatch '^\d+$') {
        throw "Could not measure the bounded filesystem after filling it"
    }
    $availableBytes = [uint64]::Parse($availableText, [Globalization.CultureInfo]::InvariantCulture)
    if ($availableBytes -ne 0) { throw "The bounded filesystem retained $availableBytes writable bytes" }
    & /usr/bin/dd if=/dev/zero "of=$ProbePath" bs=1 count=1 status=none 2> $null
    $probeExitCode = $LASTEXITCODE
    if (Test-Path -LiteralPath $ProbePath) { Remove-Item -LiteralPath $ProbePath -Force }
    if ($probeExitCode -eq 0) { throw "The full-disk qualification filesystem accepted a one-byte write" }
    return $availableBytes
}

function Restore-BoundedFilesystemWrites([string]$FillerPath, [string]$ProbePath) {
    Remove-Item -LiteralPath $FillerPath -Force
    [IO.File]::WriteAllText($ProbePath, "write-restored")
    Remove-Item -LiteralPath $ProbePath -Force
}

function Dismount-BoundedTmpfs([string]$Path) {
    & /usr/bin/sudo -n /usr/bin/umount -- $Path
    if ($LASTEXITCODE -ne 0) { throw "Could not unmount the full-disk qualification filesystem" }
    Remove-Item -LiteralPath $Path -Force
}

$environmentNames = @(
    "APPIMAGE_EXTRACT_AND_RUN",
    "DISPLAY",
    "PORTCOVE_APPLICATION_RUNTIME_LOCK",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
    "PORTCOVE_APPLICATION_UPDATE_STAGING",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE",
    "PORTCOVE_LIBRARY",
    "PORTCOVE_PREFERENCES"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$xvfb = $null
$runtimeHolder = $null
$updateHelper = $null
$fullDiskMount = Join-Path $state "full-disk-update-state"
$fullDiskFiller = Join-Path $fullDiskMount ".qualification-full-disk-filler"
$fullDiskMounted = $false
$fullAppImageMount = Join-Path $state "full-appimage-filesystem"
$fullAppImageStable = Join-Path $fullAppImageMount "Portcove.AppImage"
$fullAppImageFiller = Join-Path $fullAppImageMount ".qualification-full-disk-filler"
$fullAppImageState = Join-Path $state "full-appimage-update-state"
$fullAppImageMounted = $false
$truncatedCandidate = Join-Path $state "truncated-candidate.AppImage"
try {
    Write-Evidence "truncated-payload-preparing"
    & /usr/bin/cp --preserve=mode,timestamps -- $candidate $truncatedCandidate
    if ($LASTEXITCODE -ne 0) { throw "Could not create the truncated candidate fixture" }
    & /usr/bin/truncate --size=-1 -- $truncatedCandidate
    if ($LASTEXITCODE -ne 0) { throw "Could not truncate the candidate fixture" }
    $candidateBytes = (Get-Item -LiteralPath $candidate -Force).Length
    $truncatedBytes = (Get-Item -LiteralPath $truncatedCandidate -Force).Length
    if ($candidateBytes -le 1 -or $truncatedBytes -ne ($candidateBytes - 1)) {
        throw "The truncated candidate fixture does not omit exactly one byte"
    }
    $evidence.truncated_payload_expected_bytes = $candidateBytes
    $evidence.truncated_payload_bytes = $truncatedBytes

    $truncatedOutput = & cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- prepare $PredecessorVersion $trustedRoot $metadata $targets $truncatedCandidate $updatePreferences $updateRoot $libraryRoot 2>&1 | Out-String
    $evidence.truncated_payload_exit_code = $LASTEXITCODE
    Remove-Item -LiteralPath $truncatedCandidate -Force
    if ($evidence.truncated_payload_exit_code -eq 0 -or $truncatedOutput -notmatch "payload length mismatch") {
        throw "Truncated candidate preparation did not fail with an authenticated length mismatch"
    }
    $truncatedStagingPath = Join-Path $updateRoot "staging.json"
    if (-not (Test-Path -LiteralPath $truncatedStagingPath -PathType Leaf)) {
        throw "Truncated candidate failure did not retain an explicit empty staging journal"
    }
    $truncatedStaging = Get-Content -LiteralPath $truncatedStagingPath -Raw | ConvertFrom-Json
    if ($truncatedStaging.phase -ne "empty" -or $null -ne $truncatedStaging.candidate -or
        $null -ne $truncatedStaging.previous_candidate -or
        (Test-Path -LiteralPath (Join-Path $updateRoot "candidate.payload")) -or
        (Test-Path -LiteralPath (Join-Path $updateRoot ".candidate.payload.incoming")) -or
        (Test-Path -LiteralPath (Join-Path $updateRoot "apply.json"))) {
        throw "Truncated candidate failure retained staged or apply authority"
    }
    if ((Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash) {
        throw "Truncated candidate failure changed the stable AppImage"
    }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "Truncated candidate failure changed the persistent-data marker"
    }
    $evidence.truncated_payload_rejected = $true
    $evidence.truncated_payload_stable_preserved = $true
    $evidence.truncated_payload_staging_empty = $true
    $evidence.truncated_payload_data_preserved = $true
    Write-Evidence "truncated-payload-rejected"

    $prepareOutput = & cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- prepare $PredecessorVersion $trustedRoot $metadata $targets $candidate $updatePreferences $updateRoot $libraryRoot | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Application update state preparation failed" }
    $prepared = $prepareOutput.Trim() | ConvertFrom-Json
    if ($prepared.candidate_version -ne $CandidateVersion -or $prepared.candidate_sha256 -ne $candidateHash) {
        throw "Prepared update identity does not match the candidate AppImage"
    }
    $evidence.apply_revision = $prepared.apply_revision
    Write-Evidence "prepared"

    Remove-Item Env:APPIMAGE_EXTRACT_AND_RUN -ErrorAction SilentlyContinue
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = $updatePreferences
    $env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $state "application-runtime.lock"
    $env:PORTCOVE_APPLICATION_UPDATE_SCHEDULE = Join-Path $state "application-update-schedule.json"
    $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $updateRoot
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT = "after-reconciliation"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE = Join-Path $state "application-update-qualification-stage.json"
    $env:PORTCOVE_LIBRARY = $libraryRoot
    $env:PORTCOVE_PREFERENCES = $hostPreferences
    Remove-Item Env:DISPLAY -ErrorAction SilentlyContinue
    $swap = Join-Path $installedRoot ".portcove-appimage-$($candidateHash.Substring(0, 16)).swap"
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT = "during-swap-copy"
    Write-Evidence "interruption-helper-starting"
    & $stable --portcove-apply-update ([string]$prepared.apply_revision)
    $evidence.interruption_exit_code = $LASTEXITCODE
    if ($LASTEXITCODE -ne 86) { throw "Interrupted helper exited with code $LASTEXITCODE instead of 86" }
    Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT
    if (-not (Test-Path -LiteralPath $swap -PathType Leaf)) { throw "Interrupted helper did not retain a partial candidate swap" }
    $partialBytes = (Get-Item -LiteralPath $swap -Force).Length
    if ($partialBytes -le 0 -or $partialBytes -ge (Get-Item -LiteralPath $candidate -Force).Length) {
        throw "Interrupted helper did not stop during the candidate copy"
    }
    $evidence.interruption_partial_bytes = $partialBytes
    if ($null -ne [Environment]::GetEnvironmentVariable("DISPLAY", "Process")) {
        throw "GUI-independent recovery must run without a display environment"
    }
    $evidence.interruption_recovery_display = "unset"
    Write-Evidence "command-recovery-starting"

    & $stable --application-update-recovery recover interrupted-appimage
    $evidence.interruption_recovery_exit_code = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "GUI-independent recovery command exited with code $LASTEXITCODE" }
    $applyPath = Join-Path $updateRoot "apply.json"
    $recoveredApply = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
    if ($recoveredApply.native_launch -ne "failed" -or $null -ne $recoveredApply.native_replacement) {
        throw "Recovery command did not make the interrupted attempt retryable"
    }
    if (Test-Path -LiteralPath $swap) { throw "Recovery command retained the verified partial candidate swap" }
    if (-not (Test-Path -LiteralPath (Join-Path $updateRoot "candidate.payload") -PathType Leaf)) {
        throw "Recovery command removed the verified staged candidate"
    }
    if ((Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash) {
        throw "Recovery command changed the stable AppImage"
    }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "Recovery command changed the persistent-data marker"
    }
    $evidence.interruption_recovered = $true
    $evidence.interruption_stable_preserved = $true
    Write-Evidence "interruption-recovered"

    $retryOutput = & cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- prepare $PredecessorVersion $trustedRoot $metadata $targets $candidate $updatePreferences $updateRoot $libraryRoot | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Application update retry preparation failed" }
    $prepared = $retryOutput.Trim() | ConvertFrom-Json
    if ($prepared.candidate_version -ne $CandidateVersion -or $prepared.candidate_sha256 -ne $candidateHash) {
        throw "Retried update identity does not match the candidate AppImage"
    }
    $evidence.apply_revision = $prepared.apply_revision

    $displayNumber = ":$([System.Random]::Shared.Next(100, 500))"
    $env:DISPLAY = $displayNumber
    $xvfb = Start-Process -FilePath "Xvfb" -ArgumentList @($displayNumber, "-screen", "0", "1280x720x24", "-nolisten", "tcp") -PassThru
    Start-Sleep -Milliseconds 500
    if ($xvfb.HasExited) { throw "Xvfb exited before the packaged candidate launch" }

    $validApplyBytes = [IO.File]::ReadAllBytes($applyPath)
    $futureApply = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
    $supportedApplySchema = $futureApply.schema_version
    $evidence.incompatible_schema_supported_version = $supportedApplySchema
    $futureApply.schema_version = $evidence.incompatible_schema_version
    [IO.File]::WriteAllText(
        $applyPath,
        ($futureApply | ConvertTo-Json -Depth 8),
        [Text.UTF8Encoding]::new($false)
    )
    $futureApplyHash = (Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash
    $stagedCandidatePath = Join-Path $updateRoot "candidate.payload"
    $stagedCandidateHash = (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash
    $stagingPath = Join-Path $updateRoot "staging.json"
    $stagingHash = (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash
    $qualificationStage = $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE
    Remove-Item -LiteralPath $qualificationStage -Force -ErrorAction SilentlyContinue
    Write-Evidence "incompatible-schema-starting"
    & $stable --portcove-apply-update ([string]$prepared.apply_revision)
    $evidence.incompatible_schema_exit_code = $LASTEXITCODE
    if ($LASTEXITCODE -ne 1) { throw "Future-schema helper exited with code $LASTEXITCODE instead of 1" }

    Wait-StablePredecessorRestart $qualificationStage $env:PORTCOVE_APPLICATION_RUNTIME_LOCK $StartupTimeoutSeconds "Future-schema failure"
    $evidence.incompatible_schema_predecessor_restart_observed = $true

    if ((Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash -ne $futureApplyHash -or
        (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash -ne $stagedCandidateHash -or
        (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash -ne $stagingHash -or
        (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
        (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "Future-schema failure changed the journal, staging, stable AppImage, or persistent data"
    }
    $evidence.incompatible_schema_state_preserved = $true
    Write-Evidence "incompatible-schema-preserved"
    [IO.File]::WriteAllBytes($applyPath, $validApplyBytes)
    $restoredApply = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
    if ($restoredApply.schema_version -ne $supportedApplySchema -or
        $restoredApply.revision -ne $prepared.apply_revision) {
        throw "Future-schema fixture recovery did not restore the exact supported apply journal"
    }

    $readOnlyApplyHash = (Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash
    $readOnlyStagingHash = (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash
    $readOnlyCandidateHash = (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash
    $readOnlyItems = @((Get-Item -LiteralPath $updateRoot -Force)) +
        @(Get-ChildItem -LiteralPath $updateRoot -Recurse -Force)
    $readOnlyModes = @($readOnlyItems | ForEach-Object {
            if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Application update state contains an unexpected link: $($_.FullName)"
            }
            $mode = (& stat -c '%a' -- $_.FullName | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) { throw "Could not record the mode for application update state: $($_.FullName)" }
            [pscustomobject]@{ Path = $_.FullName; Mode = $mode }
        })
    & /usr/bin/test -w $updateRoot
    if ($LASTEXITCODE -ne 0) { throw "Application update state was not owner-writable before qualification" }
    & /usr/bin/test -w $applyPath
    if ($LASTEXITCODE -ne 0) { throw "Application update journal was not owner-writable before qualification" }
    $readOnlyApplied = $false
    try {
        $readOnlyApplied = $true
        & chmod --recursive u-w -- $updateRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not make the application update state read-only" }
        & /usr/bin/test '!' -w $updateRoot
        if ($LASTEXITCODE -ne 0) { throw "Application update state remained owner-writable" }
        & /usr/bin/test '!' -w $applyPath
        if ($LASTEXITCODE -ne 0) { throw "Application update journal remained owner-writable" }
        $evidence.read_only_state_enforced = $true

        Remove-Item -LiteralPath $qualificationStage -Force -ErrorAction SilentlyContinue
        Write-Evidence "read-only-state-starting"
        & $stable --portcove-apply-update ([string]$prepared.apply_revision)
        $evidence.read_only_state_exit_code = $LASTEXITCODE
        if ($LASTEXITCODE -ne 1) { throw "Read-only-state helper exited with code $LASTEXITCODE instead of 1" }
        Wait-StablePredecessorRestart $qualificationStage $env:PORTCOVE_APPLICATION_RUNTIME_LOCK $StartupTimeoutSeconds "Read-only-state failure"
        $evidence.read_only_state_predecessor_restart_observed = $true

        if ((Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash -ne $readOnlyApplyHash -or
            (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash -ne $readOnlyStagingHash -or
            (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash -ne $readOnlyCandidateHash -or
            (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
            (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
            throw "Read-only-state failure changed the journal, staging, stable AppImage, or persistent data"
        }
        $evidence.read_only_state_preserved = $true
        Write-Evidence "read-only-state-preserved"
    } finally {
        if ($readOnlyApplied) {
            foreach ($entry in $readOnlyModes) {
                & chmod $entry.Mode -- $entry.Path
                if ($LASTEXITCODE -ne 0) { throw "Could not restore an exact application update state mode" }
            }
        }
    }
    foreach ($entry in $readOnlyModes) {
        $restoredMode = (& stat -c '%a' -- $entry.Path | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $restoredMode -ne $entry.Mode) {
            throw "Application update state did not regain its exact Unix modes"
        }
    }
    & /usr/bin/test -w $updateRoot
    if ($LASTEXITCODE -ne 0) { throw "Application update state did not regain owner write permission" }
    & /usr/bin/test -w $applyPath
    if ($LASTEXITCODE -ne 0) { throw "Application update journal did not regain owner write permission" }
    $evidence.read_only_state_write_restored = $true
    Write-Evidence "read-only-state-recovered"

    $fullDiskBytes = (Get-Item -LiteralPath $stagedCandidatePath -Force).Length + (32 * 1024 * 1024)
    try {
        Mount-BoundedTmpfs $fullDiskMount $fullDiskBytes
        $fullDiskMounted = $true
        & /usr/bin/cp --archive -- "${updateRoot}/." "${fullDiskMount}/"
        if ($LASTEXITCODE -ne 0) { throw "Could not copy the pending update state into the bounded filesystem" }

        $fullDiskApplyPath = Join-Path $fullDiskMount "apply.json"
        $fullDiskStagingPath = Join-Path $fullDiskMount "staging.json"
        $fullDiskCandidatePath = Join-Path $fullDiskMount "candidate.payload"
        $fullDiskApplyHash = (Get-FileHash -LiteralPath $fullDiskApplyPath -Algorithm SHA256).Hash
        $fullDiskStagingHash = (Get-FileHash -LiteralPath $fullDiskStagingPath -Algorithm SHA256).Hash
        $fullDiskCandidateHash = (Get-FileHash -LiteralPath $fullDiskCandidatePath -Algorithm SHA256).Hash
        if ($fullDiskApplyHash -ne (Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash -or
            $fullDiskStagingHash -ne (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash -or
            $fullDiskCandidateHash -ne (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash) {
            throw "The bounded filesystem did not receive the exact pending update state"
        }
        $fullDiskEntries = @(Get-ChildItem -LiteralPath $fullDiskMount -Recurse -Force |
                ForEach-Object { [IO.Path]::GetRelativePath($fullDiskMount, $_.FullName) } |
                Sort-Object)

        $fullDiskProbe = Join-Path $fullDiskMount ".qualification-write-probe"
        $fillLog = Join-Path $state "full-disk-fill.log"
        $evidence.full_disk_state_available_bytes = Set-BoundedFilesystemFull $fullDiskMount $fullDiskFiller $fullDiskProbe $fillLog
        $evidence.full_disk_state_enforced = $true

        $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $fullDiskMount
        Remove-Item -LiteralPath $qualificationStage -Force -ErrorAction SilentlyContinue
        Write-Evidence "full-disk-state-starting"
        & $stable --portcove-apply-update ([string]$prepared.apply_revision)
        $evidence.full_disk_state_exit_code = $LASTEXITCODE
        if ($LASTEXITCODE -ne 1) { throw "Full-disk-state helper exited with code $LASTEXITCODE instead of 1" }
        Wait-StablePredecessorRestart $qualificationStage $env:PORTCOVE_APPLICATION_RUNTIME_LOCK $StartupTimeoutSeconds "Full-disk-state failure"
        $evidence.full_disk_state_predecessor_restart_observed = $true

        $fullDiskEntriesAfter = @(Get-ChildItem -LiteralPath $fullDiskMount -Recurse -Force |
                Where-Object FullName -ne $fullDiskFiller |
                ForEach-Object { [IO.Path]::GetRelativePath($fullDiskMount, $_.FullName) } |
                Sort-Object)
        $entryChanges = @(Compare-Object -ReferenceObject $fullDiskEntries -DifferenceObject $fullDiskEntriesAfter)
        if ($entryChanges.Count -ne 0 -or
            (Get-FileHash -LiteralPath $fullDiskApplyPath -Algorithm SHA256).Hash -ne $fullDiskApplyHash -or
            (Get-FileHash -LiteralPath $fullDiskStagingPath -Algorithm SHA256).Hash -ne $fullDiskStagingHash -or
            (Get-FileHash -LiteralPath $fullDiskCandidatePath -Algorithm SHA256).Hash -ne $fullDiskCandidateHash -or
            (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
            (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash -or
            (Test-Path -LiteralPath $swap)) {
            throw "Full-disk-state failure changed the pending inventory, journal, staging, stable AppImage, or persistent data"
        }
        $evidence.full_disk_state_preserved = $true
        Write-Evidence "full-disk-state-preserved"

        Restore-BoundedFilesystemWrites $fullDiskFiller $fullDiskProbe
        $evidence.full_disk_state_write_restored = $true
    } finally {
        $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $updateRoot
        if (Test-Path -LiteralPath $fullDiskFiller) { Remove-Item -LiteralPath $fullDiskFiller -Force }
        if ($fullDiskMounted) {
            Dismount-BoundedTmpfs $fullDiskMount
            $fullDiskMounted = $false
        }
        if (Test-Path -LiteralPath $fullDiskMount) { Remove-Item -LiteralPath $fullDiskMount -Force }
    }
    Write-Evidence "full-disk-state-recovered"

    $fullAppImageBytes = (Get-Item -LiteralPath $stable -Force).Length + (16 * 1024 * 1024)
    try {
        & /usr/bin/cp --archive -- $updateRoot $fullAppImageState
        if ($LASTEXITCODE -ne 0) { throw "Could not copy the pending update state for AppImage-filesystem qualification" }
        $fullAppImageApplyPath = Join-Path $fullAppImageState "apply.json"
        $fullAppImageStagingPath = Join-Path $fullAppImageState "staging.json"
        $fullAppImageCandidatePath = Join-Path $fullAppImageState "candidate.payload"
        $fullAppImageStagingHash = (Get-FileHash -LiteralPath $fullAppImageStagingPath -Algorithm SHA256).Hash
        $fullAppImageCandidateHash = (Get-FileHash -LiteralPath $fullAppImageCandidatePath -Algorithm SHA256).Hash
        $fullAppImageStateEntries = @(Get-ChildItem -LiteralPath $fullAppImageState -Recurse -Force |
                ForEach-Object { [IO.Path]::GetRelativePath($fullAppImageState, $_.FullName) } |
                Sort-Object)
        Mount-BoundedTmpfs $fullAppImageMount $fullAppImageBytes
        $fullAppImageMounted = $true
        & /usr/bin/cp --preserve=mode,timestamps -- $stable $fullAppImageStable
        if ($LASTEXITCODE -ne 0) { throw "Could not copy the stable AppImage into the bounded filesystem" }
        & chmod u+rwx,go+rx -- $fullAppImageStable
        if ($LASTEXITCODE -ne 0) { throw "Could not make the bounded stable AppImage executable" }
        $fullAppImageStableHash = (Get-FileHash -LiteralPath $fullAppImageStable -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($fullAppImageStableHash -ne $predecessorHash) {
            throw "The bounded filesystem did not receive the exact stable AppImage"
        }
        $fullAppImageStableMode = (& stat -c '%a' -- $fullAppImageStable | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or (([Convert]::ToInt32($fullAppImageStableMode, 8) -band 64) -eq 0)) {
            throw "The bounded stable AppImage was not owner-executable"
        }
        $fullAppImageEntries = @(Get-ChildItem -LiteralPath $fullAppImageMount -Recurse -Force |
                ForEach-Object { [IO.Path]::GetRelativePath($fullAppImageMount, $_.FullName) } |
                Sort-Object)
        $fullAppImageSwap = Join-Path $fullAppImageMount ".portcove-appimage-$($candidateHash.Substring(0, 16)).swap"
        $fullAppImageProbe = Join-Path $fullAppImageMount ".qualification-write-probe"
        $fullAppImageFillLog = Join-Path $state "full-appimage-fill.log"
        $evidence.full_appimage_filesystem_available_bytes = Set-BoundedFilesystemFull $fullAppImageMount $fullAppImageFiller $fullAppImageProbe $fullAppImageFillLog
        $evidence.full_appimage_filesystem_enforced = $true

        $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $fullAppImageState
        Remove-Item -LiteralPath $qualificationStage -Force -ErrorAction SilentlyContinue
        Write-Evidence "full-appimage-filesystem-starting"
        & $fullAppImageStable --portcove-apply-update ([string]$prepared.apply_revision)
        $evidence.full_appimage_filesystem_exit_code = $LASTEXITCODE
        if ($LASTEXITCODE -ne 1) { throw "Full-AppImage-filesystem helper exited with code $LASTEXITCODE instead of 1" }
        Wait-StablePredecessorRestart $qualificationStage $env:PORTCOVE_APPLICATION_RUNTIME_LOCK $StartupTimeoutSeconds "Full-AppImage-filesystem failure"
        $evidence.full_appimage_filesystem_predecessor_restart_observed = $true

        $fullAppImageEntriesAfter = @(Get-ChildItem -LiteralPath $fullAppImageMount -Recurse -Force |
                Where-Object FullName -ne $fullAppImageFiller |
                ForEach-Object { [IO.Path]::GetRelativePath($fullAppImageMount, $_.FullName) } |
                Sort-Object)
        $fullAppImageStateEntriesAfter = @(Get-ChildItem -LiteralPath $fullAppImageState -Recurse -Force |
                ForEach-Object { [IO.Path]::GetRelativePath($fullAppImageState, $_.FullName) } |
                Sort-Object)
        $appImageEntryChanges = @(Compare-Object -ReferenceObject $fullAppImageEntries -DifferenceObject $fullAppImageEntriesAfter)
        $appImageStateEntryChanges = @(Compare-Object -ReferenceObject $fullAppImageStateEntries -DifferenceObject $fullAppImageStateEntriesAfter)
        $fullAppImageApply = Get-Content -LiteralPath $fullAppImageApplyPath -Raw | ConvertFrom-Json
        $fullAppImageStableModeAfter = (& stat -c '%a' -- $fullAppImageStable | Out-String).Trim()
        if ($appImageEntryChanges.Count -ne 0 -or $appImageStateEntryChanges.Count -ne 0 -or
            (Get-FileHash -LiteralPath $fullAppImageStable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
            $fullAppImageStableModeAfter -ne $fullAppImageStableMode -or
            (Get-FileHash -LiteralPath $fullAppImageStagingPath -Algorithm SHA256).Hash -ne $fullAppImageStagingHash -or
            (Get-FileHash -LiteralPath $fullAppImageCandidatePath -Algorithm SHA256).Hash -ne $fullAppImageCandidateHash -or
            (Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash -ne $readOnlyApplyHash -or
            (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash -ne $readOnlyStagingHash -or
            (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash -ne $readOnlyCandidateHash -or
            (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
            (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
            throw "Full-AppImage-filesystem failure changed the AppImage, staging, inventory, or persistent data"
        }
        if (Test-Path -LiteralPath $fullAppImageSwap) {
            throw "Full-AppImage-filesystem failure retained a partial candidate swap"
        }
        if ($fullAppImageApply.revision -le $prepared.apply_revision -or
            $null -eq $fullAppImageApply.intent -or
            $fullAppImageApply.native_launch -ne "failed" -or
            $null -eq $fullAppImageApply.native_replacement -or
            $fullAppImageApply.native_replacement.source_path -ne $fullAppImageStable -or
            $fullAppImageApply.native_replacement.backup_path -ne $fullAppImageSwap -or
            $fullAppImageApply.native_replacement.previous_bytes -ne (Get-Item -LiteralPath $fullAppImageStable -Force).Length -or
            $fullAppImageApply.native_replacement.previous_sha256 -ne $predecessorHash) {
            throw "Full-AppImage-filesystem failure did not retain the exact failed replacement journal"
        }
        $evidence.full_appimage_filesystem_failed_revision = $fullAppImageApply.revision
        $evidence.full_appimage_filesystem_stable_preserved = $true
        $evidence.full_appimage_filesystem_staging_preserved = $true
        Write-Evidence "full-appimage-filesystem-preserved"

        $fullAppImageRetryOutput = & cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- prepare $PredecessorVersion $trustedRoot $metadata $targets $candidate $updatePreferences $fullAppImageState $libraryRoot | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Full-AppImage-filesystem explicit retry preparation failed" }
        $fullAppImageRetry = $fullAppImageRetryOutput.Trim() | ConvertFrom-Json
        $fullAppImageRetryApply = Get-Content -LiteralPath $fullAppImageApplyPath -Raw | ConvertFrom-Json
        $fullAppImageStateEntriesAfterRetry = @(Get-ChildItem -LiteralPath $fullAppImageState -Recurse -Force |
                ForEach-Object { [IO.Path]::GetRelativePath($fullAppImageState, $_.FullName) } |
                Sort-Object)
        $appImageRetryEntryChanges = @(Compare-Object -ReferenceObject $fullAppImageStateEntries -DifferenceObject $fullAppImageStateEntriesAfterRetry)
        if ($fullAppImageRetry.candidate_version -ne $CandidateVersion -or
            $fullAppImageRetry.candidate_sha256 -ne $candidateHash -or
            $fullAppImageRetry.apply_revision -ne $fullAppImageRetryApply.revision -or
            $fullAppImageRetryApply.revision -le $fullAppImageApply.revision -or
            $null -eq $fullAppImageRetryApply.intent -or
            $null -ne $fullAppImageRetryApply.native_launch -or
            $null -ne $fullAppImageRetryApply.native_replacement -or
            $appImageRetryEntryChanges.Count -ne 0 -or
            (Get-FileHash -LiteralPath $fullAppImageStable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash -or
            (& stat -c '%a' -- $fullAppImageStable | Out-String).Trim() -ne $fullAppImageStableMode -or
            (Get-FileHash -LiteralPath $fullAppImageStagingPath -Algorithm SHA256).Hash -ne $fullAppImageStagingHash -or
            (Get-FileHash -LiteralPath $fullAppImageCandidatePath -Algorithm SHA256).Hash -ne $fullAppImageCandidateHash -or
            (Get-FileHash -LiteralPath $applyPath -Algorithm SHA256).Hash -ne $readOnlyApplyHash -or
            (Get-FileHash -LiteralPath $stagingPath -Algorithm SHA256).Hash -ne $readOnlyStagingHash -or
            (Get-FileHash -LiteralPath $stagedCandidatePath -Algorithm SHA256).Hash -ne $readOnlyCandidateHash -or
            (Test-Path -LiteralPath $fullAppImageSwap)) {
            throw "Full-AppImage-filesystem failure could not be prepared for an explicit retry"
        }
        $evidence.full_appimage_filesystem_retry_revision = $fullAppImageRetryApply.revision
        $evidence.full_appimage_filesystem_retryable_journal = $true
        Write-Evidence "full-appimage-filesystem-retryable"

        Restore-BoundedFilesystemWrites $fullAppImageFiller $fullAppImageProbe
        $evidence.full_appimage_filesystem_write_restored = $true
    } finally {
        $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $updateRoot
        if (Test-Path -LiteralPath $fullAppImageFiller) { Remove-Item -LiteralPath $fullAppImageFiller -Force }
        if ($fullAppImageMounted) {
            Dismount-BoundedTmpfs $fullAppImageMount
            $fullAppImageMounted = $false
        }
        if (Test-Path -LiteralPath $fullAppImageMount) { Remove-Item -LiteralPath $fullAppImageMount -Force }
        if (Test-Path -LiteralPath $fullAppImageState) { Remove-Item -LiteralPath $fullAppImageState -Recurse -Force }
    }
    Write-Evidence "full-appimage-filesystem-recovered"

    $runtimeLockReady = Join-Path $state "runtime-lock-ready"
    $runtimeLockScript = Join-Path $state "hold-runtime-lock.sh"
    $runtimeLockBody = @'
#!/usr/bin/env bash
set -euo pipefail
exec 9>"$1"
flock --shared 9
: >"$2"
sleep "$3"
'@
    [IO.File]::WriteAllText($runtimeLockScript, $runtimeLockBody.Replace("`r`n", "`n"))
    $runtimeHolderStart = [Diagnostics.ProcessStartInfo]::new()
    $runtimeHolderStart.FileName = "/usr/bin/bash"
    $runtimeHolderStart.UseShellExecute = $false
    foreach ($argument in @(
        $runtimeLockScript,
        $env:PORTCOVE_APPLICATION_RUNTIME_LOCK,
        $runtimeLockReady,
        ([string]$evidence.runtime_contention_hold_seconds)
    )) {
        $runtimeHolderStart.ArgumentList.Add($argument)
    }
    $runtimeHolder = [Diagnostics.Process]::Start($runtimeHolderStart)
    if ($null -eq $runtimeHolder) { throw "Could not start the runtime lock holder" }
    $runtimeLockDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $runtimeLockReady -PathType Leaf)) {
        if ($runtimeHolder.HasExited) { throw "Runtime lock holder exited before acquiring the shared lock" }
        if ([DateTime]::UtcNow -ge $runtimeLockDeadline) { throw "Runtime lock holder did not acquire the shared lock" }
        Start-Sleep -Milliseconds 50
    }

    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT = "after-exchange-sync"
    Write-Evidence "runtime-contention-starting"
    $updateHelperStart = [Diagnostics.ProcessStartInfo]::new()
    $updateHelperStart.FileName = $stable
    $updateHelperStart.UseShellExecute = $false
    foreach ($argument in @(
        "--portcove-apply-update",
        ([string]$prepared.apply_revision)
    )) {
        $updateHelperStart.ArgumentList.Add($argument)
    }
    $updateHelper = [Diagnostics.Process]::Start($updateHelperStart)
    if ($null -eq $updateHelper) { throw "Could not start the packaged update helper" }
    Start-Sleep -Milliseconds 500
    if ($runtimeHolder.HasExited) { throw "Runtime peer released the shared lock before observation" }
    if ($updateHelper.HasExited) { throw "Packaged update helper did not wait for the live runtime peer" }
    if ((Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $predecessorHash) {
        throw "Packaged update helper changed the stable AppImage while a runtime peer held the lock"
    }
    $contendedApply = Get-Content -LiteralPath (Join-Path $updateRoot "apply.json") -Raw | ConvertFrom-Json
    if ($contendedApply.revision -ne $prepared.apply_revision -or $null -eq $contendedApply.intent -or
        $null -ne $contendedApply.native_launch -or $null -ne $contendedApply.native_replacement -or
        -not (Test-Path -LiteralPath (Join-Path $updateRoot "candidate.payload") -PathType Leaf)) {
        throw "Packaged update helper changed the journal while a runtime peer held the lock"
    }
    $evidence.runtime_contention_helper_blocked = $true
    $evidence.runtime_contention_stable_preserved = $true
    $evidence.runtime_contention_journal_preserved = $true
    Write-Evidence "runtime-contention-observed"

    Wait-Process -InputObject $runtimeHolder -Timeout 10
    $runtimeHolder.Refresh()
    if ($runtimeHolder.ExitCode -ne 0) { throw "Runtime lock holder exited with code $($runtimeHolder.ExitCode)" }
    $runtimeHolder.Dispose()
    $runtimeHolder = $null
    Wait-Process -InputObject $updateHelper -Timeout $StartupTimeoutSeconds
    $updateHelper.Refresh()
    $evidence.post_exchange_exit_code = $updateHelper.ExitCode
    $updateHelper.Dispose()
    $updateHelper = $null
    if ($evidence.post_exchange_exit_code -ne 87) {
        throw "Post-exchange helper exited with code $($evidence.post_exchange_exit_code) instead of 87"
    }
    Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT
    $postExchangeStableHash = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($postExchangeStableHash -ne $candidateHash) {
        throw "Post-exchange interruption did not retain the candidate at the stable path"
    }
    if (-not (Test-Path -LiteralPath $swap -PathType Leaf)) {
        throw "Post-exchange interruption did not retain the predecessor backup"
    }
    $postExchangeBackupHash = (Get-FileHash -LiteralPath $swap -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($postExchangeBackupHash -ne $predecessorHash) {
        throw "Post-exchange interruption did not retain the exact predecessor backup"
    }
    $interruptedApply = Get-Content -LiteralPath (Join-Path $updateRoot "apply.json") -Raw | ConvertFrom-Json
    if ($interruptedApply.native_launch -ne "starting" -or $null -eq $interruptedApply.native_replacement) {
        throw "Post-exchange interruption did not retain the starting replacement journal"
    }
    $evidence.post_exchange_candidate_installed = $true
    $evidence.post_exchange_backup_preserved = $true
    Write-Evidence "post-exchange-interrupted"

    & $stable
    $evidence.candidate_restart_exit_code = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Candidate recovery launch exited with code $LASTEXITCODE" }
    $evidence.candidate_restart_observed = $true
    Write-Evidence "candidate-restart-complete"

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $reconciled = $false
    do {
        $applyPath = Join-Path $updateRoot "apply.json"
        if (Test-Path -LiteralPath $applyPath) {
            $apply = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
            $payloadPresent = Test-Path -LiteralPath (Join-Path $updateRoot "candidate.payload")
            $swapPresent = Test-Path -LiteralPath $swap
            if ($null -eq $apply.intent -and -not $payloadPresent -and -not $swapPresent) {
                $reconciled = $true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $reconciled) { throw "The candidate AppImage did not reconcile within $StartupTimeoutSeconds seconds" }
    $evidence.post_exchange_reconciled = $true

    $stableHash = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stableHash -ne $candidateHash) { throw "The stable AppImage path does not contain the candidate bytes" }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) {
        throw "The packaged update changed the persistent-data marker"
    }
    $mode = (& stat -c '%a' -- $stable | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or (([Convert]::ToInt32($mode, 8) -band 64) -eq 0)) {
        throw "The replaced AppImage lost its owner executable bit"
    }
    $evidence.stable_sha256 = $stableHash
    $evidence.executable_mode = $mode
    $evidence.persistent_data_preserved = $true
    Write-Evidence "complete"
    $evidence | ConvertTo-Json -Depth 8 -Compress
} catch {
    $evidence.failure = $_.Exception.Message
    Write-Evidence "failed"
    throw
} finally {
    if (Test-Path -LiteralPath $truncatedCandidate) {
        Remove-Item -LiteralPath $truncatedCandidate -Force
    }
    if ($updateHelper) {
        try {
            if (-not $updateHelper.HasExited) { Stop-Process -InputObject $updateHelper -Force }
        } finally {
            $updateHelper.Dispose()
        }
    }
    if ($runtimeHolder) {
        try {
            if (-not $runtimeHolder.HasExited) { Stop-Process -InputObject $runtimeHolder -Force }
        } finally {
            $runtimeHolder.Dispose()
        }
    }
    if ($xvfb) {
        try {
            if (-not $xvfb.HasExited) { Stop-Process -InputObject $xvfb -Force }
        } finally {
            $xvfb.Dispose()
        }
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
}
