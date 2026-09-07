param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("prepare", "checkpoint", "finish", "abort")]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$SessionRoot,
    [string]$CandidateCheckout,
    [string]$BuildRecordPath,
    [string]$ExpectedBuildRecordSha256,
    [string]$Label = "checkpoint",
    [switch]$Relaunch,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$SessionFormat = 2
# Windows exposes process start time through a different clock conversion path.
# Five seconds covers its observed timestamp granularity without admitting an old run.
$LaunchStartToleranceSeconds = 5

function Get-FullPath([string]$Path, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathFullyQualified($Path)) { throw "$Name must be an explicit absolute path" }
    [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Assert-NoReparseAncestry([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $cursor = $root
    foreach ($part in $full.Substring($root.Length).Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a path with reparse-point ancestry: $cursor" }
        }
    }
    $full
}

function Assert-SessionRoot([string]$Path, [bool]$MustExist) {
    $full = Get-FullPath $Path "SessionRoot"
    $volume = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
    if (-not $full -or $full -eq $volume) { throw "SessionRoot must be a dedicated directory below a volume root" }
    Assert-NoReparseAncestry $full | Out-Null
    if ($MustExist -and -not [System.IO.Directory]::Exists($full)) { throw "Qualification session does not exist: $full" }
    if (-not $MustExist -and [System.IO.Directory]::Exists($full)) { throw "Prepare requires a new SessionRoot: $full" }
    $parent = [System.IO.Path]::GetDirectoryName($full)
    if (-not [System.IO.Directory]::Exists($parent)) { throw "SessionRoot parent must already exist: $parent" }
    $full
}

function Resolve-ContainedPath([string]$Root, [string]$Relative, [string]$Kind = "Any") {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [System.IO.Path]::IsPathFullyQualified($Relative)) { throw "Metadata contains an invalid relative path" }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $Relative))
    if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw "Path escaped its validated root: $Relative" }
    Assert-NoReparseAncestry $full | Out-Null
    if ($Kind -eq "File" -and -not [System.IO.File]::Exists($full)) { throw "Required file is missing: $Relative" }
    if ($Kind -eq "Directory" -and -not [System.IO.Directory]::Exists($full)) { throw "Required directory is missing: $Relative" }
    $full
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Hash([string]$Path, [string]$Expected, [string]$Name) {
    if ($Expected -notmatch '^[0-9a-f]{64}$') { throw "$Name has an invalid expected SHA-256" }
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) { throw "$Name SHA-256 mismatch: expected $Expected, found $actual" }
}

function Get-UninstallEntries([string]$InstallLocation = "") {
    $roots = @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*")
    @($roots | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } | Where-Object {
        if (-not $InstallLocation) { return $_.DisplayName -eq "Portcove" }
        $location = [string]$_.InstallLocation; $command = [string]$_.UninstallString
        ($location -and ([System.IO.Path]::GetFullPath($location.Trim('"')).TrimEnd('\') -eq $InstallLocation.TrimEnd('\'))) -or
            ($command -and $command.Trim('"').StartsWith($InstallLocation.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase))
    })
}

function Read-BuildRecord {
    $checkout = Get-FullPath $CandidateCheckout "CandidateCheckout"
    $recordPath = Get-FullPath $BuildRecordPath "BuildRecordPath"
    Assert-NoReparseAncestry $checkout | Out-Null
    Assert-NoReparseAncestry $recordPath | Out-Null
    if (-not [System.IO.Directory]::Exists($checkout) -or -not [System.IO.File]::Exists((Join-Path $checkout "Cargo.toml"))) { throw "CandidateCheckout is not a checkout" }
    if (-not [System.IO.File]::Exists($recordPath)) { throw "BuildRecordPath does not exist" }
    $expected = $ExpectedBuildRecordSha256.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "ExpectedBuildRecordSha256 must be an explicit SHA-256" }
    Assert-Hash $recordPath $expected "build record"
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json -Depth 30
    if ($record.format -ne 1 -or $record.candidate.commit -notmatch '^[0-9a-f]{40}$' -or $record.candidate.tree -notmatch '^[0-9a-f]{40}$') { throw "Unsupported build record" }
    if ([string]::IsNullOrWhiteSpace($record.predecessor.version)) { throw "Build record does not bind a predecessor version" }
    $head = (& git -C $checkout rev-parse HEAD 2>$null | Out-String).Trim()
    $tree = (& git -C $checkout show -s --format=%T HEAD 2>$null | Out-String).Trim()
    $dirty = (& git -C $checkout status --porcelain --untracked-files=no 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $record.candidate.commit -or $tree -ne $record.candidate.tree -or $dirty) { throw "CandidateCheckout must be the exact clean checkout recorded by the build record" }
    $described = @($record.artifacts.installer, $record.artifacts.cli, $record.artifacts.desktop, $record.predecessor.installer) + @($record.tools.psobject.Properties.Value)
    foreach ($item in $described) {
        $path = Resolve-ContainedPath $checkout ([string]$item.relative_path) "File"
        Assert-Hash $path ([string]$item.sha256) ([string]$item.relative_path)
        if ((Get-Item -LiteralPath $path).Length -ne $item.bytes) { throw "Recorded byte length mismatch: $($item.relative_path)" }
    }
    [pscustomobject]@{ checkout = $checkout; path = $recordPath; sha256 = $expected; record = $record }
}

function Write-Session($Session, [string]$Root) {
    $path = Resolve-ContainedPath $Root "session.json"; $next = "$path.next"
    $Session.updated_at = (Get-Date).ToUniversalTime().ToString("o")
    $Session | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $next -Encoding utf8
    [System.IO.File]::Move($next, $path, $true)
}

function Verify-Checkpoints($Session, [string]$Root) {
    foreach ($checkpoint in @($Session.checkpoints)) {
        $metadata = Resolve-ContainedPath $Root $checkpoint.metadata "File"
        Assert-Hash $metadata $checkpoint.metadata_sha256 "checkpoint metadata"
        $data = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
        foreach ($file in @($data.files)) { $path = Resolve-ContainedPath $Root $file.path "File"; Assert-Hash $path $file.sha256 "checkpoint file" }
    }
}

function Read-Session([string]$Root) {
    $root = Assert-SessionRoot $Root $true
    $path = Resolve-ContainedPath $root "session.json" "File"
    $session = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 40
    if ($session.session_format -ne $SessionFormat) { throw "Unsupported session format" }
    foreach ($property in $session.paths.psobject.Properties) { Resolve-ContainedPath $root ([string]$property.Value) | Out-Null }
    foreach ($property in $session.files.psobject.Properties) { $file = Resolve-ContainedPath $root ([string]$property.Value.path) "File"; Assert-Hash $file ([string]$property.Value.sha256) $property.Name }
    Assert-Hash $PSCommandPath $session.files.session_tool.sha256 "running session tool"
    Verify-Checkpoints $session $root
    if ($session.finish_receipt) {
        $receiptPath = Resolve-ContainedPath $root $session.finish_receipt.path "File"; Assert-Hash $receiptPath $session.finish_receipt.sha256 "finish receipt"
        $snapshotPath = Resolve-ContainedPath $root $session.finish_receipt.pre_finish_session_path "File"; Assert-Hash $snapshotPath $session.finish_receipt.pre_finish_session_sha256 "pre-finish session snapshot"
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 30
        if ($receipt.pre_finish_session.path -ne $session.finish_receipt.pre_finish_session_path -or $receipt.pre_finish_session.sha256 -ne $session.finish_receipt.pre_finish_session_sha256) { throw "Finish receipt does not match final session metadata" }
        foreach ($entry in @($receipt.files)) {
            $entryPath = Resolve-ContainedPath $root $entry.path
            if ($entry.type -eq "file") { if (-not [System.IO.File]::Exists($entryPath)) { throw "Finish receipt file is missing: $($entry.path)" }; Assert-Hash $entryPath $entry.sha256 "finish receipt file"; if ((Get-Item -LiteralPath $entryPath).Length -ne $entry.bytes) { throw "Finish receipt byte length mismatch: $($entry.path)" } }
            elseif ($entry.type -eq "directory" -and -not [System.IO.Directory]::Exists($entryPath)) { throw "Finish receipt directory is missing: $($entry.path)" }
            elseif ($entry.type -eq "absent" -and ([System.IO.File]::Exists($entryPath) -or [System.IO.Directory]::Exists($entryPath))) { throw "Finish receipt absent path now exists: $($entry.path)" }
        }
    }
    [pscustomobject]@{ root = $root; session = $session }
}

function Get-Environment($Session, [string]$Root) {
    @{ PORTCOVE_LIBRARY = Resolve-ContainedPath $Root $Session.paths.library "Directory"; PORTCOVE_PREFERENCES = Resolve-ContainedPath $Root $Session.paths.preferences; PORTCOVE_TEMP_DIR = Resolve-ContainedPath $Root $Session.paths.temp "Directory"; TEMP = Resolve-ContainedPath $Root $Session.paths.temp "Directory"; TMP = Resolve-ContainedPath $Root $Session.paths.temp "Directory"; TMPDIR = Resolve-ContainedPath $Root $Session.paths.temp "Directory" }
}

function Invoke-WithEnvironment($Environment, [scriptblock]$Operation) {
    $old = @{}
    try {
        foreach ($name in $Environment.Keys) { $old[$name] = [Environment]::GetEnvironmentVariable($name, "Process"); [Environment]::SetEnvironmentVariable($name, $Environment[$name], "Process") }
        & $Operation
    } finally { foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name], "Process") } }
}

function Get-ActiveRun($Session) {
    if (-not $Session.active_run_id) { return $null }
    $matches = @($Session.process_runs | Where-Object { $_.id -eq $Session.active_run_id })
    if ($matches.Count -ne 1) { throw "Session active run identity is ambiguous" }
    $matches[0]
}

function Assert-ProcessIdentity($Process, $Run, [string]$Root) {
    $expectedPath = Resolve-ContainedPath $Root $Run.executable "File"
    $actualPath = try { [System.IO.Path]::GetFullPath($Process.Path) } catch { throw "Cannot read the candidate desktop process path" }
    if (-not $actualPath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Desktop process path does not match the journaled executable" }
    Assert-NoReparseAncestry $actualPath | Out-Null
    Assert-Hash $actualPath $Run.executable_sha256 "running desktop executable"
    $earliestStart = [DateTime]::FromFileTimeUtc([long]$Run.requested_at_filetime).AddSeconds(-$LaunchStartToleranceSeconds)
    if ($Process.StartTime.ToUniversalTime() -lt $earliestStart) { throw "Desktop process predates the journaled launch request: requested $($Run.requested_at), process $($Process.StartTime.ToUniversalTime().ToString('o'))" }
    if ($Run.start_time_filetime -and $Process.StartTime.ToFileTimeUtc() -ne [long]$Run.start_time_filetime) { throw "PID was reused; refusing to control an unrelated process" }
}

function Resolve-ActiveProcess($Session, [string]$Root) {
    $run = Get-ActiveRun $Session
    if (-not $run -or $run.status -notin @("launch_pending", "running_unverified", "running_verified", "running_recovered")) { return $null }
    if ($run.pid) {
        $process = Get-Process -Id $run.pid -ErrorAction SilentlyContinue
        if (-not $process) { $run.status = "exit_unobserved"; $run.exit_observation = "Process disappeared before an exit code could be observed"; Write-Session $Session $Root; return $null }
        Assert-ProcessIdentity $process $run $Root
        return $process
    }
    $expectedPath = Resolve-ContainedPath $Root $run.executable "File"
    $matches = @(Get-Process | ForEach-Object { try { if ($_.Path -and [System.IO.Path]::GetFullPath($_.Path).Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) { $_ } } catch {} })
    if ($matches.Count -ne 1) { throw "A launch-pending run could not be bound to one exact desktop process; refusing recovery" }
    $process = $matches[0]; Assert-ProcessIdentity $process $run $Root
    $run.pid = $process.Id; $run.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $run.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $run.status = "running_recovered"; Write-Session $Session $Root
    $process
}

function Stop-Desktop($Session, [string]$Root) {
    $run = Get-ActiveRun $Session
    if (-not $run -or $run.status -notin @("launch_pending", "running_unverified", "running_verified", "running_recovered")) { return }
    $process = Resolve-ActiveProcess $Session $Root
    if (-not $process) { return }
    $null = $process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) { throw "Desktop did not exit after a close request" }
    $run.status = "exit_unobserved"; $run.exit_code = $null; $run.exit_observation = "Exit followed the close request, but this invocation did not own the launch handle and cannot observe an exit code"; Write-Session $Session $Root
}

function Start-Desktop($Session, [string]$Root) {
    $application = Resolve-ContainedPath $Root $Session.paths.desktop "File"; Assert-Hash $application $Session.files.desktop.sha256 "packaged desktop"
    $requested = [DateTime]::UtcNow
    $run = [ordered]@{ id = [System.Guid]::NewGuid().ToString("N"); executable = $Session.paths.desktop; executable_sha256 = $Session.files.desktop.sha256; requested_at = $requested.ToString("o"); requested_at_filetime = $requested.ToFileTimeUtc(); status = "launch_pending"; pid = $null; start_time = $null; start_time_filetime = $null; window_title = $null; exit_code = $null; exit_observation = $null }
    $Session.process_runs += $run; $Session.active_run_id = $run.id; Write-Session $Session $Root
    $process = Invoke-WithEnvironment (Get-Environment $Session $Root) { Start-Process -FilePath $application -PassThru }
    $run.pid = $process.Id; $run.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $run.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $run.status = "running_unverified"; Write-Session $Session $Root
    Assert-ProcessIdentity $process $run $Root
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 200; $process.Refresh()
        if ($process.HasExited) { $run.status = "exit_observed"; $run.exit_code = $process.ExitCode; $run.exit_observation = "Observed through the retained launch handle"; Write-Session $Session $Root; throw "Desktop exited before a responsive window was observed (exit $($process.ExitCode))" }
    } while ((-not $process.Responding -or -not $process.MainWindowTitle) -and (Get-Date) -lt $deadline)
    if (-not $process.Responding -or -not $process.MainWindowTitle) { throw "Desktop did not reach a responsive named window" }
    $run.status = "running_verified"; $run.window_title = $process.MainWindowTitle; Write-Session $Session $Root
}

function Add-Checkpoint($Session, [string]$Root, [string]$CheckpointLabel, [string]$RunId = "") {
    Verify-Checkpoints $Session $Root
    $checkpointRoot = Resolve-ContainedPath $Root $Session.paths.checkpoints "Directory"
    $indexes = @([System.IO.Directory]::EnumerateDirectories($checkpointRoot) | ForEach-Object { if ([System.IO.Path]::GetFileName($_) -match '^(\d{4})-') { [int]$Matches[1] } })
    $index = if ($indexes.Count) { ($indexes | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    $safeLabel = ($CheckpointLabel -replace '[^A-Za-z0-9._-]', '-').Trim('-'); if (-not $safeLabel) { $safeLabel = "checkpoint" }
    $relativeDir = "checkpoints/{0:0000}-{1}" -f ([int]$index), $safeLabel; $output = Resolve-ContainedPath $Root $relativeDir
    if ([System.IO.Directory]::Exists($output)) { throw "Checkpoint destination already exists" }
    $cli = Resolve-ContainedPath $Root $Session.files.cli.path "File"; Assert-Hash $cli $Session.files.cli.sha256 "packaged CLI"
    $library = Resolve-ContainedPath $Root $Session.paths.library "Directory"; $report = Resolve-ContainedPath $Root $Session.files.report_tool.path "File"
    Invoke-WithEnvironment (Get-Environment $Session $Root) { & node $report --cli $cli --library $library --output $output }
    if ($LASTEXITCODE -ne 0) { throw "Qualification report failed with exit code $LASTEXITCODE" }
    $files = @("evidence.json", "checklist.md") | ForEach-Object { $path = Resolve-ContainedPath $Root "$relativeDir/$_" "File"; [ordered]@{ path = "$relativeDir/$_"; sha256 = Get-Sha256 $path; bytes = (Get-Item -LiteralPath $path).Length } }
    $metadataRelative = "$relativeDir/checkpoint.json"; $metadata = Resolve-ContainedPath $Root $metadataRelative
    [ordered]@{ format = 1; sequence = $index; label = $safeLabel; process_run_id = if ($RunId) { $RunId } else { $null }; captured_at = (Get-Date).ToUniversalTime().ToString("o"); files = $files; proprietary_and_human_evidence = "unassessed" } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $metadata -Encoding utf8
    $Session.checkpoints += [ordered]@{ metadata = $metadataRelative; metadata_sha256 = Get-Sha256 $metadata; process_run_id = if ($RunId) { $RunId } else { $null } }; Write-Session $Session $Root
}

function Get-RecursiveManifest([string]$Root, $RelativeRoots) {
    $result = @()
    foreach ($relative in $RelativeRoots) {
        $path = Resolve-ContainedPath $Root $relative
        if ([System.IO.File]::Exists($path)) { $result += [ordered]@{ path = $relative.Replace('\','/'); type = "file"; bytes = (Get-Item $path).Length; sha256 = Get-Sha256 $path } }
        elseif ([System.IO.Directory]::Exists($path)) {
            $result += [ordered]@{ path = $relative.Replace('\','/') + '/'; type = "directory"; bytes = $null; sha256 = $null }
            foreach ($item in Get-ChildItem -LiteralPath $path -Force -Recurse | Sort-Object FullName) { if (-not $item.PSIsContainer -and $item.Name -match '\.tmp-[0-9a-f]{32}$') { continue }; Assert-NoReparseAncestry $item.FullName | Out-Null; $rel = [System.IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\','/'); if ($item.PSIsContainer) { $result += [ordered]@{ path = $rel + '/'; type = "directory"; bytes = $null; sha256 = $null } } else { $result += [ordered]@{ path = $rel; type = "file"; bytes = $item.Length; sha256 = Get-Sha256 $item.FullName } } }
        } else { $result += [ordered]@{ path = $relative.Replace('\','/'); type = "absent"; bytes = $null; sha256 = $null } }
    }
    $result
}

function Assert-NoProcessAtPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($full)
    foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        $actual = try { [System.IO.Path]::GetFullPath($process.Path) } catch { throw "Cannot prove that process $($process.Id) is outside the owned path $full" }
        if ($actual.Equals($full, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Owned process is still running: $full (PID $($process.Id))" }
    }
}

function Get-AbortContext($Session, [string]$Root) {
    $evidencePath = Resolve-ContainedPath $Root "evidence/installer-lifecycle.json"
    if (-not [System.IO.File]::Exists($evidencePath)) { return [pscustomobject]@{ evidence = $null; evidence_path = $evidencePath; install = $null; uninstaller = $null } }
    if (-not $Session.files.installer_evidence) { return [pscustomobject]@{ evidence = $null; evidence_path = $evidencePath; install = $null; uninstaller = $null } }
    Assert-Hash $evidencePath $Session.files.installer_evidence.sha256 "installer evidence"
    $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -Depth 30
    $testBase = Resolve-ContainedPath $Root $Session.paths.installer_work "Directory"
    $install = Resolve-ContainedPath $testBase $evidence.owned_paths.install_relative
    [pscustomobject]@{ evidence = $evidence; evidence_path = $evidencePath; install = $install; uninstaller = Join-Path $install "uninstall.exe" }
}

function Assert-NoOwnedProcesses($Session, [string]$Root, $Context) {
    $knownPaths = @(
        (Resolve-ContainedPath $Root $Session.paths.desktop)
        (Resolve-ContainedPath $Root $Session.files.installer.path)
        (Resolve-ContainedPath $Root $Session.files.predecessor.path)
    )
    if ($Context.install) { $knownPaths += @(Join-Path $Context.install "portcove-desktop.exe", Join-Path $Context.install "uninstall.exe") }
    foreach ($path in $knownPaths) { Assert-NoProcessAtPath $path }
    $temporaryRoot = Resolve-ContainedPath $Root $Session.paths.temp "Directory"
    $temporaryPrefix = $temporaryRoot.TrimEnd('\') + '\'
    foreach ($process in @(Get-Process)) {
        $actual = try { [System.IO.Path]::GetFullPath($process.Path) } catch { continue }
        if ($actual.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Session-owned temporary process is still running: $actual (PID $($process.Id))"
        }
    }
    if ($Context.evidence) {
        foreach ($run in @($Context.evidence.process_runs)) {
            if (-not $run.executable_path) { continue }
            $candidate = [System.IO.Path]::GetFullPath($run.executable_path)
            if (-not ($candidate.StartsWith($Root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase))) { throw "Installer process journal contains a path outside SessionRoot" }
            Assert-NoReparseAncestry $candidate | Out-Null
            Assert-NoProcessAtPath $candidate
        }
    }
}

function Assert-AbortQuiescent($Session, [string]$Root, $Context) {
    Assert-NoOwnedProcesses $Session $Root $Context
    if ($Context.install -and [System.IO.Directory]::Exists($Context.install)) {
        $files = @(Get-ChildItem -LiteralPath $Context.install -File -Force -Recurse)
        if ($files.Count -ne 0) { throw "Managed install files remain after abort: $($files[0].FullName)" }
    }
    if (-not $Context.install) {
        $installerWork = Resolve-ContainedPath $Root $Session.paths.installer_work "Directory"
        $files = @(Get-ChildItem -LiteralPath $installerWork -File -Force -Recurse)
        if ($files.Count -ne 0) { throw "Unbound installer-owned files remain: $($files[0].FullName)" }
        foreach ($process in @(Get-Process)) {
            $actual = try { [System.IO.Path]::GetFullPath($process.Path) } catch { continue }
            if ($actual.StartsWith($installerWork.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unbound installer-owned process is still running: $actual" }
        }
    }
    if (@(Get-UninstallEntries).Count -ne 0) { throw "A Portcove installer registration remains after abort" }
}

function Assert-AbortProcessIdentity($Process, $Attempt, $Session, [string]$Root, [switch]$OwnedLaunchHandle) {
    $expected = Resolve-ContainedPath $Root $Attempt.executable "File"
    if ($OwnedLaunchHandle) {
        $launched = try { [System.IO.Path]::GetFullPath($Process.StartInfo.FileName) } catch { throw "Cannot read the abort launch path" }
        if (-not $launched.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Abort retained handle does not identify the journaled launch path" }
    }
    $earliest = [DateTime]::FromFileTimeUtc([long]$Attempt.requested_at_filetime).AddSeconds(-$LaunchStartToleranceSeconds)
    if ($Process.StartTime.ToUniversalTime() -lt $earliest) { throw "Abort process predates its write-ahead record" }
    if ($Attempt.start_time_filetime -and $Process.StartTime.ToFileTimeUtc() -ne [long]$Attempt.start_time_filetime) { throw "Abort PID was reused" }
    $deadline = (Get-Date).AddSeconds(2)
    $actual = $null
    do {
        $Process.Refresh()
        $candidate = try { $Process.Path } catch { $null }
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and [System.IO.Path]::GetExtension($candidate).Equals(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
            $actual = [System.IO.Path]::GetFullPath($candidate)
            break
        }
        if ($Process.HasExited) { break }
        Start-Sleep -Milliseconds 25
    } while ((Get-Date) -lt $deadline)
    if (-not $actual) {
        if ($OwnedLaunchHandle -and $Process.HasExited) { return }
        throw "Cannot observe a stable abort executable image path"
    }
    if (-not $actual.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        $temporaryRoot = Resolve-ContainedPath $Root $Session.paths.temp "Directory"
        if (-not $actual.StartsWith($temporaryRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Abort process relocated outside its session-owned temporary root"
        }
    }
    Assert-NoReparseAncestry $actual | Out-Null
    Assert-Hash $actual $Attempt.executable_sha256 "abort uninstaller executable"
}

function Resume-AbortAttempt($Session, [string]$Root, $Context) {
    $active = @($Session.abort_attempts | Where-Object { $_.status -in @("launch_pending", "running", "running_recovered", "exit_observed") } | Select-Object -Last 1)
    if (-not $active.Count) { return $false }
    $attempt = $active[0]
    if ($attempt.status -eq "exit_observed") {
        if ($attempt.exit_code -ne 0) { throw "The previous abort attempt exited with code $($attempt.exit_code); it remains failed and will not be relaunched implicitly" }
        Assert-AbortQuiescent $Session $Root $Context
        $attempt.status = "exit_observed_cleanup_proven"; $attempt.exit_observation = "Observed exit zero and complete owned-state cleanup were proven"; Write-Session $Session $Root
        return $true
    }
    $process = if ($attempt.pid) { Get-Process -Id $attempt.pid -ErrorAction SilentlyContinue } else { $null }
    if (-not $process -and -not $attempt.pid) {
        $expected = Resolve-ContainedPath $Root $attempt.executable
        $temporaryRoot = Resolve-ContainedPath $Root $Session.paths.temp "Directory"
        $temporaryPrefix = $temporaryRoot.TrimEnd('\') + '\'
        $earliest = [DateTime]::FromFileTimeUtc([long]$attempt.requested_at_filetime).AddSeconds(-$LaunchStartToleranceSeconds)
        $matches = @(Get-Process | Where-Object {
            try {
                $actual = [System.IO.Path]::GetFullPath($_.Path)
                $pathAllowed = $actual.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase) -or $actual.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)
                $pathAllowed -and $_.StartTime.ToUniversalTime() -ge $earliest -and (Get-Sha256 $actual) -eq $attempt.executable_sha256
            } catch { $false }
        })
        if ($matches.Count -gt 1) { throw "Abort launch-pending state matches multiple processes" }
        if ($matches.Count -eq 1) { $process = $matches[0]; Assert-AbortProcessIdentity $process $attempt $Session $Root; $attempt.pid = $process.Id; $attempt.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $attempt.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $attempt.status = "running_recovered"; Write-Session $Session $Root }
    }
    if ($process) { Assert-AbortProcessIdentity $process $attempt $Session $Root; throw "A journaled abort process is still running; retry after it exits" }
    try { Assert-AbortQuiescent $Session $Root $Context } catch { throw "Abort process outcome is ambiguous and cleanup is incomplete: $($_.Exception.Message)" }
    $attempt.status = "exit_unobserved_cleanup_proven"; $attempt.exit_observation = "Process absence and complete owned-state cleanup were proven"; Write-Session $Session $Root
    $true
}

function Invoke-QualificationFaultPoint([string]$Name) {
    if ([System.Environment]::GetEnvironmentVariable("PORTCOVE_QUALIFICATION_TEST_FAULTPOINT", "Process") -eq $Name) { throw "Qualification test faultpoint: $Name" }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { [System.BitConverter]::ToString($hasher.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant() } finally { $hasher.Dispose() }
}

function Publish-AtomicBytes([string]$FinalPath, [byte[]]$Bytes, [string]$FaultPoint) {
    if ([System.IO.File]::Exists($FinalPath)) { return }
    $expectedHash = Get-BytesSha256 $Bytes
    $matching = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetDirectoryName($FinalPath)) -File -Force | Where-Object { $_.Name.StartsWith([System.IO.Path]::GetFileName($FinalPath) + ".tmp-", [System.StringComparison]::Ordinal) -and $_.Length -eq $Bytes.Length -and (Get-Sha256 $_.FullName) -eq $expectedHash } | Sort-Object Name)
    if ($matching.Count) { [System.IO.File]::Move($matching[0].FullName, $FinalPath); return }
    $temporary = "$FinalPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
    $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Invoke-QualificationFaultPoint $FaultPoint
    [System.IO.File]::Move($temporary, $FinalPath)
}

function Complete-Finish($Session, [string]$Root) {
    $attempt = $Session.finish_attempt
    if (-not $attempt -or $attempt.id -notmatch '^[0-9a-f]{32}$') { throw "finish_pending session has no valid attempt" }
    $sessionPath = Resolve-ContainedPath $Root "session.json" "File"
    $snapshotPath = Resolve-ContainedPath $Root $attempt.snapshot_path
    $receiptPath = Resolve-ContainedPath $Root $attempt.receipt_path
    if ([System.IO.File]::Exists($snapshotPath)) {
        $snapshotHash = Get-Sha256 $snapshotPath
        if ($attempt.snapshot_sha256 -and $snapshotHash -ne $attempt.snapshot_sha256) { throw "Pre-finish snapshot changed during recovery" }
        $snapshot = Get-Content -LiteralPath $snapshotPath -Raw | ConvertFrom-Json -Depth 40
        if ($snapshot.phase -ne "finish_pending" -or $snapshot.finish_attempt.id -ne $attempt.id) { throw "Pre-finish snapshot belongs to another attempt" }
        $attempt.snapshot_sha256 = $snapshotHash
    } else {
        if ($attempt.stage -ne "pending") { throw "Finish snapshot is missing after its journaled creation" }
        Publish-AtomicBytes $snapshotPath ([System.IO.File]::ReadAllBytes($sessionPath)) "after_snapshot_temp"
        $attempt.snapshot_sha256 = Get-Sha256 $snapshotPath
    }
    $attempt.stage = "snapshot_written"; Write-Session $Session $Root
    Invoke-QualificationFaultPoint "after_snapshot"

    if ([System.IO.File]::Exists($receiptPath)) {
        $receiptHash = Get-Sha256 $receiptPath
        if ($attempt.receipt_sha256 -and $receiptHash -ne $attempt.receipt_sha256) { throw "Finish receipt changed during recovery" }
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 30
        if ($receipt.attempt_id -ne $attempt.id -or $receipt.pre_finish_session.sha256 -ne $attempt.snapshot_sha256) { throw "Finish receipt belongs to another attempt" }
        $attempt.receipt_sha256 = $receiptHash
    } else {
        $manifest = @(Get-RecursiveManifest $Root @($Session.paths.library, $Session.paths.preferences, $Session.paths.checkpoints, $Session.paths.evidence, "inputs", "tools", $Session.paths.desktop))
        $body = [ordered]@{ format = 1; attempt_id = $attempt.id; captured_at = $attempt.receipt_captured_at; pre_finish_session = [ordered]@{ path = $attempt.snapshot_path; sha256 = $attempt.snapshot_sha256 }; files = $manifest; proprietary_and_human_evidence = "unassessed" } | ConvertTo-Json -Depth 12
        $receiptBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($body + [Environment]::NewLine)
        Publish-AtomicBytes $receiptPath $receiptBytes "after_receipt_temp"
        $attempt.receipt_sha256 = Get-Sha256 $receiptPath
    }
    $attempt.stage = "receipt_written"; Write-Session $Session $Root
    Invoke-QualificationFaultPoint "after_receipt"
    $Session.finish_receipt = [ordered]@{ path = $attempt.receipt_path; sha256 = $attempt.receipt_sha256; pre_finish_session_path = $attempt.snapshot_path; pre_finish_session_sha256 = $attempt.snapshot_sha256 }
    $attempt.stage = "complete"; $Session.phase = "finished"; Write-Session $Session $Root
}

if ($Action -eq "prepare") {
    $root = Assert-SessionRoot $SessionRoot $false; $build = Read-BuildRecord
    if (@(Get-UninstallEntries).Count -ne 0) { throw "A Portcove installer registration already exists. Refusing qualification." }
    if ($ValidateOnly) { [ordered]@{ validated = $true; candidate_commit = $build.record.candidate.commit; candidate_tree = $build.record.candidate.tree; build_record_sha256 = $build.sha256; predecessor_version = $build.record.predecessor.version; predecessor_sha256 = $build.record.predecessor.installer.sha256 } | ConvertTo-Json -Compress; exit 0 }
    [System.IO.Directory]::CreateDirectory($root) | Out-Null
    foreach ($relative in @("inputs", "tools", "runtime", "library", "state", "temp", "evidence", "checkpoints", "installer-work")) { [System.IO.Directory]::CreateDirectory((Resolve-ContainedPath $root $relative)) | Out-Null }
    $copies = [ordered]@{}; $mapping = [ordered]@{
        installer = @($build.record.artifacts.installer, "inputs/installer.exe"); cli = @($build.record.artifacts.cli, "inputs/portcove.exe"); expected_desktop = @($build.record.artifacts.desktop, "inputs/expected-desktop.exe"); predecessor = @($build.record.predecessor.installer, "inputs/predecessor.exe"); session_tool = @($build.record.tools.'scripts/windows-qualification-session.ps1', "tools/windows-qualification-session.ps1"); installer_tool = @($build.record.tools.'scripts/test-windows-installer.ps1', "tools/test-windows-installer.ps1"); report_tool = @($build.record.tools.'scripts/qualification-report.mjs', "tools/qualification-report.mjs")
    }
    Copy-Item -LiteralPath $build.path -Destination (Resolve-ContainedPath $root "inputs/build-record.json"); $copies.build_record = [ordered]@{ path = "inputs/build-record.json"; sha256 = $build.sha256 }
    foreach ($name in $mapping.Keys) { $description, $destinationRelative = $mapping[$name]; $source = Resolve-ContainedPath $build.checkout $description.relative_path "File"; $destination = Resolve-ContainedPath $root $destinationRelative; Copy-Item -LiteralPath $source -Destination $destination; Assert-Hash $destination $description.sha256 $name; $copies[$name] = [ordered]@{ path = $destinationRelative; sha256 = $description.sha256 } }
    $session = [ordered]@{
        session_format = $SessionFormat; created_at = (Get-Date).ToUniversalTime().ToString("o"); updated_at = $null
        identity = [ordered]@{ candidate_commit = $build.record.candidate.commit; candidate_tree = $build.record.candidate.tree; build_record_sha256 = $build.sha256; predecessor_version = $build.record.predecessor.version; predecessor_sha256 = $build.record.predecessor.installer.sha256 }
        paths = [ordered]@{ library = "library"; preferences = "state/preferences.json"; temp = "temp"; evidence = "evidence"; checkpoints = "checkpoints"; installer_work = "installer-work"; desktop = "runtime/portcove-desktop.exe" }
        files = $copies; phase = "inputs_copied"; installer = $null; process_runs = @(); active_run_id = $null; abort_attempts = @(); checkpoints = @(); failure = $null; abort_cleanup = $null; finish_attempt = $null; finish_receipt = $null; scope = "Packaged lifecycle and core snapshots only; proprietary source and human observations remain unassessed."
    }
    Write-Session $session $root
    try {
        $session.phase = "installer_lifecycle_running"; Write-Session $session $root
        $arguments = @{ InstallerPath = Resolve-ContainedPath $root $session.files.installer.path "File"; UpgradeFromInstallerPath = Resolve-ContainedPath $root $session.files.predecessor.path "File"; ExpectedExecutablePath = Resolve-ContainedPath $root $session.files.expected_desktop.path "File"; TestBase = Resolve-ContainedPath $root $session.paths.installer_work "Directory"; RetainExecutablePath = Resolve-ContainedPath $root $session.paths.desktop; EvidencePath = Resolve-ContainedPath $root "evidence/installer-lifecycle.json" }
        $tool = Resolve-ContainedPath $root $session.files.installer_tool.path "File"; $raw = Invoke-WithEnvironment (Get-Environment $session $root) { & $tool @arguments }; $result = ($raw | Select-Object -Last 1) | ConvertFrom-Json
        $desktopHash = Get-Sha256 (Resolve-ContainedPath $root $session.paths.desktop "File"); if ($desktopHash -ne $result.installed_executable_sha256) { throw "Retained desktop does not match installer evidence" }
        $session.files.desktop = [ordered]@{ path = $session.paths.desktop; sha256 = $desktopHash }; $session.files.installer_evidence = [ordered]@{ path = "evidence/installer-lifecycle.json"; sha256 = Get-Sha256 (Resolve-ContainedPath $root "evidence/installer-lifecycle.json" "File") }
        $session.installer = $result; $session.phase = "installer_lifecycle_complete"; Write-Session $session $root
        Add-Checkpoint $session $root "baseline"; Start-Desktop $session $root; $session.phase = "prepared"; Write-Session $session $root; $session | ConvertTo-Json -Depth 8
    } catch {
        $journal = Resolve-ContainedPath $root "evidence/installer-lifecycle.json"
        if ([System.IO.File]::Exists($journal) -and -not $session.files.installer_evidence) { $session.files.installer_evidence = [ordered]@{ path = "evidence/installer-lifecycle.json"; sha256 = Get-Sha256 $journal } }
        $session.phase = "prepare_failed"; $session.failure = $_.Exception.Message; Write-Session $session $root; throw
    }
    exit 0
}

if ($ValidateOnly) { throw "ValidateOnly is supported only for prepare" }
$loaded = Read-Session $SessionRoot; $root = $loaded.root; $session = $loaded.session
if ($session.phase -in @("finished", "aborted")) { throw "Session is already $($session.phase)" }

if ($Action -eq "abort") {
    Stop-Desktop $session $root
    $context = Get-AbortContext $session $root
    if ([System.IO.File]::Exists($context.evidence_path) -and -not $session.files.installer_evidence) {
        try { Assert-AbortQuiescent $session $root $context } catch { throw "Installer evidence is not hash-bound into session metadata and cleanup is not already proven; refusing abort: $($_.Exception.Message)" }
    }
    $resumed = Resume-AbortAttempt $session $root $context
    if (-not $resumed -and $context.evidence -and [System.IO.File]::Exists($context.uninstaller)) {
        Assert-NoOwnedProcesses $session $root $context
        if (-not $context.evidence.uninstaller_sha256) { throw "A partial installer remains, but its uninstaller was not hash-journaled; evidence was retained" }
        Assert-NoReparseAncestry $context.uninstaller | Out-Null; Assert-Hash $context.uninstaller $context.evidence.uninstaller_sha256 "partial-run uninstaller"
        $relativeUninstaller = [System.IO.Path]::GetRelativePath($root, $context.uninstaller).Replace('\', '/')
        $requested = [DateTime]::UtcNow
        $attempt = [ordered]@{ id = [System.Guid]::NewGuid().ToString("N"); executable = $relativeUninstaller; executable_sha256 = $context.evidence.uninstaller_sha256; requested_at = $requested.ToString("o"); requested_at_filetime = $requested.ToFileTimeUtc(); status = "launch_pending"; pid = $null; start_time = $null; start_time_filetime = $null; exit_code = $null; exit_observation = $null }
        $session.abort_attempts += $attempt; Write-Session $session $root
        $process = Invoke-WithEnvironment (Get-Environment $session $root) { Start-Process -FilePath $context.uninstaller -ArgumentList "/S" -PassThru -WindowStyle Hidden }
        $attempt.pid = $process.Id; $attempt.start_time = $process.StartTime.ToUniversalTime().ToString("o"); $attempt.start_time_filetime = $process.StartTime.ToFileTimeUtc(); $attempt.status = "running"; Write-Session $session $root
        Assert-AbortProcessIdentity $process $attempt $session $root -OwnedLaunchHandle
        $process.WaitForExit(); $attempt.status = "exit_observed"; $attempt.exit_code = $process.ExitCode; $attempt.exit_observation = "Observed through the retained abort launch handle"; Write-Session $session $root
        $pause = [System.Environment]::GetEnvironmentVariable("PORTCOVE_QUALIFICATION_TEST_PAUSE_AFTER_ABORT_EXIT_MS", "Process")
        if ($pause) { Start-Sleep -Milliseconds ([int]$pause) }
        if ($process.ExitCode -ne 0) { throw "Partial-run uninstaller failed" }
        $deadline = (Get-Date).AddSeconds(15)
        while ([System.IO.File]::Exists($context.uninstaller) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    }
    Assert-AbortQuiescent $session $root $context
    $session.phase = "aborted"; $session.abort_cleanup = [ordered]@{ completed_at = (Get-Date).ToUniversalTime().ToString("o"); zero_owned_processes = $true; zero_managed_install_files = $true; zero_global_registrations = $true }; Write-Session $session $root; $session | ConvertTo-Json -Depth 10; exit 0
}

if ($Action -eq "finish" -and $session.phase -eq "finish_pending") {
    Complete-Finish $session $root; $session | ConvertTo-Json -Depth 10; exit 0
}
if ($session.phase -ne "prepared") { throw "Session is not ready for checkpoint or finish: $($session.phase)" }
$checkpointRunId = $session.active_run_id
Stop-Desktop $session $root; Add-Checkpoint $session $root $(if ($Action -eq "finish") { "final" } else { $Label }) $checkpointRunId
if ($Action -eq "checkpoint" -and $Relaunch) { Start-Desktop $session $root }
if ($Action -eq "finish") {
    $attemptId = [System.Guid]::NewGuid().ToString("N"); $attemptDirectory = "evidence/finish-$attemptId"; [System.IO.Directory]::CreateDirectory((Resolve-ContainedPath $root $attemptDirectory)) | Out-Null
    $session.finish_attempt = [ordered]@{ id = $attemptId; stage = "pending"; snapshot_path = "$attemptDirectory/pre-finish-session.json"; snapshot_sha256 = $null; receipt_path = "$attemptDirectory/finish-receipt.json"; receipt_sha256 = $null; receipt_captured_at = (Get-Date).ToUniversalTime().ToString("o") }
    $session.phase = "finish_pending"; Write-Session $session $root
    Complete-Finish $session $root
}
$session | ConvertTo-Json -Depth 8
