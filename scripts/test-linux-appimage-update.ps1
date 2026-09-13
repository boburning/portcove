param(
    [Parameter(Mandatory = $true)][string]$PredecessorPath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$TrustedRootPath,
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][string]$TargetsPath,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [int]$StartupTimeoutSeconds = 30
)

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
    schema_version = 1
    phase = "preparing"
    source_commit = (& git rev-parse HEAD | Out-String).Trim()
    platform = "linux-x86_64"
    predecessor = [ordered]@{ path = $predecessor; sha256 = $predecessorHash }
    candidate = [ordered]@{ path = $candidate; sha256 = $candidateHash }
    stable_path = $stable
    apply_revision = $null
    helper_exit_code = $null
    stable_sha256 = $null
    executable_mode = $null
    persistent_data_preserved = $false
    native_relaunch_observed = $false
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

$environmentNames = @(
    "APPIMAGE_EXTRACT_AND_RUN",
    "DISPLAY",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
    "PORTCOVE_APPLICATION_UPDATE_STAGING",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT",
    "PORTCOVE_LIBRARY",
    "PORTCOVE_PREFERENCES"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$xvfb = $null
try {
    Write-Evidence "preparing"
    $prepareOutput = & cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- prepare 0.1.0 $trustedRoot $metadata $targets $candidate $updatePreferences $updateRoot $libraryRoot | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Application update state preparation failed" }
    $prepared = $prepareOutput.Trim() | ConvertFrom-Json
    if ($prepared.candidate_version -ne "0.3.0" -or $prepared.candidate_sha256 -ne $candidateHash) {
        throw "Prepared update identity does not match the candidate AppImage"
    }
    $evidence.apply_revision = $prepared.apply_revision
    Write-Evidence "prepared"

    Remove-Item Env:APPIMAGE_EXTRACT_AND_RUN -ErrorAction SilentlyContinue
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = $updatePreferences
    $env:PORTCOVE_APPLICATION_UPDATE_SCHEDULE = Join-Path $state "application-update-schedule.json"
    $env:PORTCOVE_APPLICATION_UPDATE_STAGING = $updateRoot
    $env:PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT = "after-reconciliation"
    $env:PORTCOVE_LIBRARY = $libraryRoot
    $env:PORTCOVE_PREFERENCES = $hostPreferences
    $displayNumber = ":$([System.Random]::Shared.Next(100, 500))"
    $env:DISPLAY = $displayNumber
    $xvfb = Start-Process -FilePath "Xvfb" -ArgumentList @($displayNumber, "-screen", "0", "1280x720x24", "-nolisten", "tcp") -PassThru
    Start-Sleep -Milliseconds 500
    if ($xvfb.HasExited) { throw "Xvfb exited before the packaged update run" }

    Write-Evidence "helper-starting"
    & $stable --portcove-apply-update ([string]$prepared.apply_revision)
    $evidence.helper_exit_code = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Packaged AppImage update helper exited with code $LASTEXITCODE" }
    Write-Evidence "helper-complete"

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $reconciled = $false
    do {
        $applyPath = Join-Path $updateRoot "apply.json"
        if (Test-Path -LiteralPath $applyPath) {
            $apply = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
            $payloadPresent = Test-Path -LiteralPath (Join-Path $updateRoot "candidate.payload")
            $swapPresent = Test-Path -LiteralPath (Join-Path $installedRoot ".portcove-appimage-$($candidateHash.Substring(0, 16)).swap")
            if ($null -eq $apply.intent -and -not $payloadPresent -and -not $swapPresent) {
                $reconciled = $true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $reconciled) { throw "The candidate AppImage did not reconcile within $StartupTimeoutSeconds seconds" }

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
    $evidence.native_relaunch_observed = $true
    Write-Evidence "complete"
    $evidence | ConvertTo-Json -Depth 8 -Compress
} catch {
    $evidence.failure = $_.Exception.Message
    Write-Evidence "failed"
    throw
} finally {
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
