param(
    [Parameter(Mandatory = $true)][string]$QualifiedAppPath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
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

function Invoke-BundleSelection([string]$Executable) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.ArgumentList.Add("--portcove-qualify-update-selection")
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
            $process.Kill($true)
            throw "Installed macOS application selection timed out"
        }
        if ($stdout.Result.Length -gt 4096 -or $stderr.Result.Length -gt 4096) {
            throw "Installed macOS application selection output was oversized"
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
    $modeBefore = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
    try {
        & /bin/chmod 555 $installedRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not remove bundle-parent owner write permission" }
        $modeDenied = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
        $rejection = Invoke-BundleSelection $executable
    } finally {
        & /bin/chmod 755 $installedRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not restore bundle-parent owner write permission" }
    }
    $modeRestored = (& /usr/bin/stat -f %Lp $installedRoot | Out-String).Trim()
    $after = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($modeBefore -ne "755" -or $modeDenied -ne "555" -or $modeRestored -ne "755" -or
        $rejection.exit_code -ne 1 -or $rejection.stderr -notmatch 'not readable and writable by its owner' -or
        $after -ne $before) {
        throw "Installed macOS owner-write rejection or restoration was not established"
    }
    $state.phase = "complete"
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
    $state.private_signing_inputs_absent = $true
} catch {
    $state.phase = "failed"
    $state.failure = $_.Exception.Message
    throw
} finally {
    $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
    Remove-Item Env:PORTCOVE_APPLICATION_UPDATE_STAGING -ErrorAction SilentlyContinue
}
