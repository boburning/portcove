param(
    [Parameter(Mandatory)][ValidateSet('Prepare', 'Run')][string]$Mode,
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ControllerRoot,
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$ControllerRoot = [IO.Path]::GetFullPath($ControllerRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
$planPath = Join-Path $ControllerRoot 'plan.json'
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
$script:step = 'preflight'
$script:commandNumber = 0
$script:activeLaunch = $null
$script:cleanupFailures = @()
$script:ownedCommands = [Collections.Generic.List[object]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Same-Path([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    $a = [IO.Path]::GetFullPath($Left.Replace('\\?\', '')).TrimEnd('\', '/')
    $b = [IO.Path]::GetFullPath($Right.Replace('\\?\', '')).TrimEnd('\', '/')
    [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
}
function Write-NewJson([string]$Path, $Value) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $utf8.GetBytes(($Value | ConvertTo-Json -Depth 40))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
function Append-Json([string]$Path, $Value) {
    [IO.File]::AppendAllText($Path, ($Value | ConvertTo-Json -Depth 40 -Compress) + "`n", $utf8)
}
function Mark([string]$Name) {
    $script:step = $Name
    Write-Host "onboarding-native: $Name"
    Append-Json (Join-Path $EvidenceRoot 'steps.jsonl') @{ at = [DateTime]::UtcNow.ToString('o'); step = $Name }
}
function Git-Text([string]$Root, [string[]]$Arguments) {
    $value = & git -C $Root @Arguments
    Require ($LASTEXITCODE -eq 0) 'Git source identity inspection failed.'
    (($value -join "`n").Trim())
}
function Execution([int]$Code, [string]$State, [string]$Failure) {
    $value = [ordered]@{}
    foreach ($key in @('source','controller','base','run','attempt','job','phase','binding_sha256')) { $value[$key] = $binding.$key }
    $value.exit_code = $Code
    $value.state = $State
    $value.last_step = $script:step
    $value.failure = $Failure
    $value.cleanup_failures = @($script:cleanupFailures)
    $value.completed_at = [DateTime]::UtcNow.ToString('o')
    $value.claim = $plan.claim
    $value
}
function Assert-Hosting {
    Require ($IsWindows -and [Environment]::Is64BitProcess) 'This observation requires native 64-bit Windows.'
    Require ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') 'Only the disposable standard GitHub-hosted job is admitted.'
    Require ($env:GITHUB_EVENT_NAME -eq 'push' -and $env:GITHUB_REPOSITORY -eq 'boburning/portcove') 'The fixed public push controller is required.'
    Require ($env:GITHUB_REF -eq 'refs/heads/test/onboarding-native-2404') 'Unexpected controller branch.'
    Require ($env:GITHUB_RUN_ATTEMPT -eq '1' -and $env:GITHUB_JOB -eq 'native') 'Reruns and alternate jobs are refused; retain the original attempt.'
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    Require ($event.repository.private -eq $false) 'Only the existing public repository is admitted.'
    Require ($env:ImageOS -eq 'win22') 'This plan admits only the windows-2022 image.'
    Require ($plan.source -match '^[0-9a-f]{40}$' -and $plan.base -match '^[0-9a-f]{40}$') 'Replace both reviewed full-SHA placeholders before publication.'
    Require ($plan.source -eq $env:PORTCOVE_ONCE_SOURCE) 'Workflow/source plan mismatch.'
    Require ((Git-Text $SourceRoot @('rev-parse','HEAD')) -eq $plan.source) 'Product checkout is not the reviewed source.'
    Require ((Git-Text $ControllerRoot @('rev-parse','HEAD')) -eq $env:GITHUB_SHA) 'Controller checkout is not the pushed controller.'
    Require ([string]::IsNullOrWhiteSpace((Git-Text $SourceRoot @('status','--porcelain','--untracked-files=all')))) 'Product checkout must be clean.'
    Require ([string]::IsNullOrWhiteSpace((Git-Text $ControllerRoot @('status','--porcelain','--untracked-files=all')))) 'Controller checkout must be clean.'
    & git -C $SourceRoot merge-base --is-ancestor $plan.base $plan.source
    Require ($LASTEXITCODE -eq 0) 'Reviewed base is not an ancestor of the candidate.'
    Require ((Get-Content (Join-Path $SourceRoot '.node-version') -Raw).Trim() -eq $plan.node) 'Node pin changed.'
    $toolchain = Get-Content (Join-Path $SourceRoot 'rust-toolchain.toml') -Raw
    Require ($toolchain -match ('(?m)^channel\s*=\s*"' + [regex]::Escape($plan.rust) + '"\s*$')) 'Rust pin changed.'
}

if ($Mode -eq 'Prepare') {
    Require (-not (Test-Path -LiteralPath $EvidenceRoot) -and -not (Test-Path -LiteralPath $WorkRoot)) 'Evidence and runtime roots must be fresh.'
    [void][IO.Directory]::CreateDirectory($EvidenceRoot)
    [void][IO.Directory]::CreateDirectory((Join-Path $EvidenceRoot 'native'))
    $binding = [pscustomobject]@{
        source = [string]$plan.source; controller = [string]$env:GITHUB_SHA; base = [string]$plan.base
        run = [string]$env:GITHUB_RUN_ID; attempt = [string]$env:GITHUB_RUN_ATTEMPT; job = [string]$env:GITHUB_JOB
        phase = 'native'; binding_sha256 = Hash $planPath
    }
    Write-NewJson (Join-Path $EvidenceRoot 'binding.json') $binding
    [IO.File]::Copy($planPath, (Join-Path $EvidenceRoot 'plan.json'))
    Write-NewJson (Join-Path $EvidenceRoot 'execution.json') (Execution 1 'incomplete-before-run' 'The fixed journey has not completed.')
    try {
        Assert-Hosting
        Require ($plan.repository -eq 'boburning/portcove' -and $plan.runner -eq 'windows-2022' -and $plan.port_id -eq 'fragglet-sdl-sopwith') 'Fixed scenario identity changed.'
        $inputs = @()
        foreach ($entry in @(
            @{ root=$ControllerRoot; path='.github/workflows/onboarding-native-once.yml'; kind='controller' },
            @{ root=$ControllerRoot; path='scripts/onboarding-native.ps1'; kind='controller' },
            @{ root=$ControllerRoot; path='scripts/owned-game-window.ps1'; kind='controller' },
            @{ root=$SourceRoot; path='apps/desktop/scripts/native-session.ps1'; kind='source' },
            @{ root=$SourceRoot; path='apps/desktop/scripts/native-process-tree.ps1'; kind='source' },
            @{ root=$SourceRoot; path='scripts/native-backup-evidence.mts'; kind='source' },
            @{ root=$SourceRoot; path='scripts/runtime-values.mts'; kind='source' },
            @{ root=$SourceRoot; path='scripts/dev-storage.mts'; kind='source' },
            @{ root=$SourceRoot; path='scripts/run-rust-tests.mts'; kind='source' },
            @{ root=$SourceRoot; path='Cargo.lock'; kind='source' },
            @{ root=$SourceRoot; path='rust-toolchain.toml'; kind='source' },
            @{ root=$SourceRoot; path='crates/portcove-core/catalog/ports/fragglet-sdl-sopwith.json'; kind='source' }
        )) {
            $file = Join-Path $entry.root $entry.path
            $bytes = [IO.File]::ReadAllBytes($file)
            $inputs += @{ kind=$entry.kind; path=$entry.path; sha256=Hash $file; bytes=$bytes.Length; content_base64=[Convert]::ToBase64String($bytes) }
        }
        Write-NewJson (Join-Path $EvidenceRoot 'source-inputs.json') $inputs
        $os = Get-CimInstance Win32_OperatingSystem
        Write-NewJson (Join-Path $EvidenceRoot 'host.json') @{
            runner='windows-2022'; image_os=$env:ImageOS; image_version=$env:ImageVersion; runner_arch=$env:RUNNER_ARCH
            os_caption=$os.Caption; os_version=$os.Version; os_build=$os.BuildNumber; architecture=$os.OSArchitecture
            process_architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
            powershell=$PSVersionTable.PSVersion.ToString(); session_id=[Diagnostics.Process]::GetCurrentProcess().SessionId
            user_interactive=[Environment]::UserInteractive; work_root=$WorkRoot; source_root=$SourceRoot; controller_root=$ControllerRoot
        }
        [void][IO.Directory]::CreateDirectory($WorkRoot)
        Mark 'prepared'
    } catch {
        Write-NewJson (Join-Path $EvidenceRoot 'preflight-failure.json') @{ message=$_.Exception.Message; step=$script:step }
        throw
    }
    exit
}

$binding = Get-Content -LiteralPath (Join-Path $EvidenceRoot 'binding.json') -Raw | ConvertFrom-Json
Require ($binding.binding_sha256 -eq (Hash $planPath)) 'Plan changed after preflight.'
$native = Join-Path $EvidenceRoot 'native'
$nativeHelper = Join-Path $SourceRoot 'apps/desktop/scripts/native-session.ps1'
$windowHelper = Join-Path $ControllerRoot 'scripts/owned-game-window.ps1'
$commandRoot = Join-Path $WorkRoot 'command-logs'
$library = Join-Path $WorkRoot 'library'
$gameProfile = Join-Path $WorkRoot 'game-profile'
# SDL2 resolves Windows Roaming AppData through the shell known-folder API,
# independently of our child environment overrides. Observe only this fixed
# upstream subdirectory in the disposable runner account, never a broad profile.
$roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$sopwithPreferences = if ([string]::IsNullOrWhiteSpace($roamingAppData)) { $null } else { Join-Path $roamingAppData 'SDL Sopwith' }
$preferences = Join-Path $WorkRoot 'preferences/preferences.json'
$externalParent = Join-Path $WorkRoot 'external'
$script:cli = Join-Path $WorkRoot 'target/release/portcove.exe'
$script:cliHash = $null
$buildEnvironment = [ordered]@{
    CARGO_TARGET_DIR=(Join-Path $WorkRoot 'target'); CARGO_INCREMENTAL='0'; CARGO_BUILD_JOBS='2'
    PORTCOVE_TEMP_DIR=(Join-Path $WorkRoot 'temp'); PORTCOVE_OUTPUT_DIR=(Join-Path $WorkRoot 'build-output')
}
$isolated = [ordered]@{
    PORTCOVE_LIBRARY=$library; PORTCOVE_PREFERENCES=$preferences
    APPDATA=(Join-Path $gameProfile 'AppData/Roaming'); LOCALAPPDATA=(Join-Path $gameProfile 'AppData/Local'); USERPROFILE=$gameProfile
    HOME=$gameProfile; HOMEDRIVE=[IO.Path]::GetPathRoot($gameProfile).TrimEnd('\'); HOMEPATH=$gameProfile.Substring([IO.Path]::GetPathRoot($gameProfile).Length - 1)
    TEMP=(Join-Path $WorkRoot 'temp'); TMP=(Join-Path $WorkRoot 'temp'); TMPDIR=(Join-Path $WorkRoot 'temp'); PORTCOVE_TEMP_DIR=(Join-Path $WorkRoot 'temp')
}
function Start-Owned([string]$File, [string[]]$Arguments, [string]$Directory, [string]$Name, [bool]$Isolate = $false, [bool]$AliasProbe = $false) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $resolvedFile = if ([IO.Path]::IsPathFullyQualified($File)) { $File } else { (Get-Command $File -CommandType Application -ErrorAction Stop).Source }
    $info.FileName = $resolvedFile; $info.WorkingDirectory = $Directory; $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.CreateNoWindow = $true
    foreach ($arg in $Arguments) { [void]$info.ArgumentList.Add($arg) }
    if ($Isolate) {
        if ($AliasProbe) {
            foreach ($key in $isolated.Keys) { $info.Environment[$key.ToLowerInvariant()] = 'unaccepted-alias'; $info.Environment[$key] = 'unaccepted-uppercase' }
        }
        # Enumerate the actual child map, removing every inherited casing before setting one reviewed value.
        foreach ($key in @($info.Environment.Keys)) {
            $upper = $key.ToUpperInvariant()
            if ($isolated.Contains($upper) -or $upper -match '^(PORTCOVE_|GH_|GITHUB_)' -or $upper -match '(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)') { [void]$info.Environment.Remove($key) }
        }
        foreach ($key in $isolated.Keys) { $info.Environment[$key] = $isolated[$key] }
    }
    if ($Name -eq 'build') {
        foreach ($key in @($info.Environment.Keys)) {
            if ($key.ToUpperInvariant() -in @('RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS') -or $buildEnvironment.Contains($key.ToUpperInvariant())) { [void]$info.Environment.Remove($key) }
        }
        foreach ($key in $buildEnvironment.Keys) { $info.Environment[$key] = $buildEnvironment[$key] }
    }
    $outPath = Join-Path $commandRoot "$Name.stdout.log"
    $errPath = Join-Path $commandRoot "$Name.stderr.log"
    $out = [IO.File]::Open($outPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $err = [IO.File]::Open($errPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $owned = $null
    try {
        Require ($process.Start()) 'The owned command did not start.'
        # Retain this spawn even if the following identity capture fails. Missing
        # identity can report a leak, but cannot authorize process termination.
        $owned = [pscustomobject]@{ process=$process; started=$null; file=$resolvedFile; arguments=$Arguments; name=$Name; out=$out; err=$err; outTask=$null; errTask=$null; outPath=$outPath; errPath=$errPath; completed=$false }
        $script:ownedCommands.Add($owned)
        $owned.outTask = $process.StandardOutput.BaseStream.CopyToAsync($out)
        $owned.errTask = $process.StandardError.BaseStream.CopyToAsync($err)
        $owned.started = $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        $owned
    } catch {
        if (-not $owned) { $out.Dispose(); $err.Dispose(); $process.Dispose() }
        throw
    }
}
function Complete-Owned($Owned, [int]$Seconds) {
    Require ($Owned.process.WaitForExit($Seconds * 1000)) "Owned command '$($Owned.name)' exceeded its finite budget; no subsequent product mutation is admitted."
    Require ($Owned.outTask.Wait(5000) -and $Owned.errTask.Wait(5000)) 'Owned command streams did not close positively.'
    $Owned.out.Dispose(); $Owned.err.Dispose(); $Owned.completed = $true
    $result = [pscustomobject]@{
        name=$Owned.name; executable=$Owned.file; arguments=$Owned.arguments; pid=$Owned.process.Id; started_filetime=$Owned.started
        exit_code=$Owned.process.ExitCode; stdout=[IO.File]::ReadAllText($Owned.outPath); stderr=[IO.File]::ReadAllText($Owned.errPath)
    }
    Append-Json (Join-Path $EvidenceRoot 'commands.jsonl') $result
    $result
}
function Invoke-Native([string]$ModeName, [string]$Snapshot, [string[]]$Extra = @()) {
    $script:commandNumber++
    $owned = Start-Owned 'pwsh' (@('-NoLogo','-NoProfile','-NonInteractive','-File',$nativeHelper,'-Mode',$ModeName,'-SnapshotPath',$Snapshot) + $Extra) $SourceRoot "native-$script:commandNumber"
    try {
        $result = Complete-Owned $owned ([int]$plan.bounds_seconds.native_helper)
        Require ($result.exit_code -eq 0) "Native identity helper $ModeName failed: $($result.stderr)"
        $result.stdout | ConvertFrom-Json
    } finally { if ($owned.completed) { $owned.process.Dispose() } }
}
function Invoke-Cli([string]$Name, [string[]]$Arguments, [int]$Seconds = 180) {
    Require ((Hash $script:cli) -eq $script:cliHash) 'CLI bytes changed during the journey.'
    $script:commandNumber++
    $owned = Start-Owned $script:cli (@('--library',$library,'--json','--non-interactive') + $Arguments) $WorkRoot "$Name-$script:commandNumber" $true
    try {
        $result = Complete-Owned $owned $Seconds
        Require ($result.exit_code -eq 0) "Production CLI $Name failed; see its retained command result."
        $response = $result.stdout | ConvertFrom-Json
        Require ($response.ok -eq $true) "Production CLI $Name did not return success."
        $response.data
    } finally { if ($owned.completed) { $owned.process.Dispose() } }
}
function Inventory([string]$Root) {
    Require (((Get-Item -LiteralPath $Root).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Inventory root must not be a reparse point.'
    $entries = [Collections.Generic.List[object]]::new()
    function Visit([string]$Directory) {
        foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force | Sort-Object Name)) {
            Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Reparse points are outside this fixed preservation observation.'
            $relative = [IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\','/')
            Require ($entries.Count -lt 4096) 'Preservation inventory exceeded its explicit bound.'
            if ($item.PSIsContainer) { $entries.Add([ordered]@{ path=$relative; kind='directory' }); Visit $item.FullName }
            else { $entries.Add([ordered]@{ path=$relative; kind='file'; bytes=$item.Length; sha256=Hash $item.FullName }) }
        }
    }
    Visit $Root
    @($entries.ToArray())
}
function Inventory-Text($Value) { ConvertTo-Json -InputObject $Value -Depth 10 -Compress }
function Sopwith-Preferences {
    [ordered]@{ path=$sopwithPreferences; exists=(Test-Path -LiteralPath $sopwithPreferences); inventory=@(if (Test-Path -LiteralPath $sopwithPreferences) { Inventory $sopwithPreferences }) }
}
function Check-Selection($Preview, [string]$Executable, [string]$Directory) {
    Require ($Preview.port_id -eq $plan.port_id -and (Same-Path $Preview.path $Directory) -and (Same-Path $Preview.executable $Executable)) 'Selected-runtime review names different launch paths.'
    $reviewedArgs = @($Preview.user_selected.arguments)
    Require ($reviewedArgs.Count -eq $plan.arguments.Count) 'Selected-runtime review has a different argument count.'
    for ($index=0; $index -lt $reviewedArgs.Count; $index++) { Require ($reviewedArgs[$index] -ceq $plan.arguments[$index]) 'Selected-runtime review has different literal arguments.' }
    Require ($Preview.preview_sha256 -match '^[0-9a-f]{64}$' -and [string]::IsNullOrEmpty($Preview.archive_sha256)) 'Selected-runtime review identity/trust is unexpected.'
}
function Assert-Ready($Status, $Registration, [string]$Executable, [string]$Directory) {
    Require ($Status.port_id -eq $plan.port_id -and $Status.external_runtime.id -eq $Registration.id) 'Fresh status did not retain the same registration.'
    Require ((Same-Path $Status.external_runtime.executable $Executable) -and (Same-Path $Status.external_runtime.path $Directory)) 'Fresh status did not retain the reviewed launch paths.'
    Require ($Status.readiness.launchable -eq $true -and @($Status.readiness.blockers).Count -eq 0) 'Fresh CLI status is not launchable.'
    Require ($null -eq $Status.active -and $null -eq $Status.previous -and $null -eq $Status.staged) 'A selected runtime unexpectedly became managed.'
}
function Observe-Launch([string]$Label, $Registration, [string]$Executable, [string]$Directory) {
    Mark "$Label-launch"
    foreach ($file in $plan.package_files) {
        $path = Join-Path $Directory $file.path
        Require ((Get-Item -LiteralPath $path).Length -eq $file.bytes -and (Hash $path) -eq $file.sha256) 'Pinned upstream game/package bytes changed before launch.'
    }
    $gameHash = Hash $Executable
    $request = [guid]::NewGuid().ToString()
    $owned = Start-Owned $script:cli @('--library',$library,'exec',$plan.port_id,'--request-id',$request) $WorkRoot "$Label-exec" $true
    $script:activeLaunch = [pscustomobject]@{ owned=$owned; gameSnapshot=$null; closeSnapshot=$null; executable=$Executable; label=$Label }
    Write-NewJson (Join-Path $native "$Label-request.json") @{ request_id=$request; supervisor_pid=$owned.process.Id; supervisor_started_filetime=$owned.started; executable=$Executable; working_directory=$Directory; arguments=$plan.arguments }
    $deadline = [DateTime]::UtcNow.AddSeconds([int]$plan.bounds_seconds.launch_ready)
    do {
        $remaining = [Math]::Max(1, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
        $session = Invoke-Cli "$Label-observe" @('launch','show',$request) ([Math]::Min(10,$remaining))
        Append-Json (Join-Path $native "$Label-observations.jsonl") @{ at=[DateTime]::UtcNow.ToString('o'); session=$session }
        if ($session) {
            Require ($null -eq $session.outcome) 'Game launch became terminal before owned window observation; retain the result.'
            if ($session.phase -eq 'running' -and $session.child_pid -and $session.child_identity -and $session.supervisor_identity) { break }
        }
        Require (-not $owned.process.HasExited) 'CLI exited before a live owned game was established.'
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    Require ($session -and $session.phase -eq 'running' -and $session.child_pid -and $session.child_identity) 'No complete running launch identity arrived within the fixed bound.'
    Require ($session.id -eq $request -and $session.port_id -eq $plan.port_id -and $session.owner_kind -eq 'external' -and $session.install_id -eq $Registration.id -and (Same-Path $session.install_root $Directory)) 'Launch record names a different runtime.'
    Require ($session.supervisor_pid -eq $owned.process.Id -and $session.supervisor_identity -eq "windows-filetime:$($owned.started)") 'Launch supervisor is not this exact owned CLI process.'
    $supervisorPath = Join-Path $native "$Label-supervisor.json"
    $supervisor = Invoke-Native 'SnapshotDriver' $supervisorPath @('-DriverProcessId', [string]$session.supervisor_pid)
    Require ((Same-Path $supervisor.driver.path $script:cli) -and $supervisor.driver.started_filetime -eq $owned.started -and (Hash $script:cli) -eq $script:cliHash) 'Supervisor binary/start identity mismatch.'
    $gamePath = Join-Path $native "$Label-game.json"
    Require ((Hash $Executable) -eq $gameHash) 'Game executable changed after the owned launch.'
    $game = Invoke-Native 'SnapshotApplication' $gamePath @('-DriverProcessId',[string]$session.child_pid,'-ExpectedParentProcessId',[string]$session.supervisor_pid,'-ApplicationPath',$Executable,'-ExpectedApplicationSha256',$gameHash)
    Require ("windows-filetime:$($game.driver.started_filetime)" -eq $session.child_identity) 'Game process identity differs from the Core launch record.'
    $script:activeLaunch.gameSnapshot = $gamePath
    $closePath = Join-Path $native "$Label-close-identity.json"
    $close = Invoke-Native 'Snapshot' $closePath @('-DriverProcessId',[string]$session.supervisor_pid,'-ApplicationPath',$Executable)
    Require ($close.application_pid -eq $session.child_pid -and $close.driver.started_filetime -eq $owned.started -and (Same-Path $close.driver.path $script:cli)) 'Close snapshot lost the owned supervisor/game binding.'
    $gameRecords = @($close.processes | Where-Object pid -eq $session.child_pid)
    Require ($gameRecords.Count -eq 1 -and $gameRecords[0].started_filetime -eq $game.driver.started_filetime -and (Same-Path $gameRecords[0].path $Executable)) 'Close snapshot game incarnation differs.'
    $script:activeLaunch.closeSnapshot = $closePath
    Mark "$Label-window"
    $screenshot = Join-Path $native "$Label-game.png"
    $window = Start-Owned 'pwsh' @('-NoLogo','-NoProfile','-NonInteractive','-File',$windowHelper,'-SnapshotPath',$closePath,'-ApplicationPath',$Executable,'-ApplicationSha256',$gameHash,'-ScreenshotPath',$screenshot,'-ObservationPath',(Join-Path $native "$Label-window.json"),'-ReadySeconds',[string]$plan.bounds_seconds.window_ready) $SourceRoot "$Label-window-helper"
    $windowResult = Complete-Owned $window ([int]$plan.bounds_seconds.window_ready + 10)
    $window.process.Dispose()
    Require ($windowResult.exit_code -eq 0) 'Owned game-window capture failed; no visual acceptance is established.'
    Mark "$Label-ordinary-close"
    $requested = Invoke-Native 'RequestClose' $closePath @('-ApplicationPath',$Executable)
    Write-NewJson (Join-Path $native "$Label-close-request.json") $requested
    $exited = Invoke-Native 'Wait' $closePath
    Write-NewJson (Join-Path $native "$Label-game-exit.json") $exited
    $execResult = Complete-Owned $owned ([int]$plan.bounds_seconds.supervisor_exit)
    [IO.File]::Copy($owned.outPath, (Join-Path $native "$Label-exec.stdout.log"))
    [IO.File]::Copy($owned.errPath, (Join-Path $native "$Label-exec.stderr.log"))
    # Read-only observation adds the independently captured supervisor to the wait inventory.
    $supervisorExitPath = Join-Path $native "$Label-supervisor-exit-identity.json"
    Write-NewJson $supervisorExitPath @{ captured_at=$supervisor.captured_at; driver=$supervisor.driver; processes=@($supervisor.driver); derivation='verified-supervisor-only-exit-observation' }
    $supervisorExit = Invoke-Native 'Wait' $supervisorExitPath
    Write-NewJson (Join-Path $native "$Label-supervisor-exit.json") $supervisorExit
    $terminal = Invoke-Cli "$Label-terminal" @('launch','show',$request)
    Write-NewJson (Join-Path $native "$Label-terminal.json") $terminal
    Require ($terminal.id -eq $session.id -and $terminal.install_id -eq $session.install_id -and $terminal.owner_kind -eq 'external' -and (Same-Path $terminal.install_root $Directory)) 'Terminal launch lost its exact runtime identity.'
    Require ($terminal.supervisor_identity -eq $session.supervisor_identity -and $terminal.child_identity -eq $session.child_identity -and $terminal.child_pid -eq $session.child_pid) 'Terminal launch changed the captured process identities.'
    Require ($terminal.outcome -eq 'succeeded' -and $terminal.exit_code -eq 0 -and $terminal.finished_at -and $execResult.exit_code -eq 0) 'Normal close did not produce a positive successful terminal launch result.'
    $owned.process.Dispose()
    $script:activeLaunch = $null
}

$failure = $null
try {
    Assert-Hosting
    Require ($binding.source -eq $plan.source -and $binding.controller -eq $env:GITHUB_SHA -and $binding.run -eq $env:GITHUB_RUN_ID -and $binding.attempt -eq '1') 'Prepared execution identity changed.'
    Require ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) 'Hosted Windows has no usable interactive session; do not change security or session configuration.'
    Require ($sopwithPreferences -and [IO.Path]::IsPathFullyQualified($sopwithPreferences) -and -not (Test-Path -LiteralPath $sopwithPreferences)) 'The fixed upstream known-folder subtree must be absent before this disposable observation; do not touch existing game preferences.'
    foreach ($path in @($commandRoot,$library,$gameProfile,$externalParent,(Split-Path $preferences),$isolated.APPDATA,$isolated.LOCALAPPDATA,$isolated.TEMP)) { [void][IO.Directory]::CreateDirectory($path) }
    foreach ($inputRecord in @(Get-Content (Join-Path $EvidenceRoot 'source-inputs.json') -Raw | ConvertFrom-Json)) {
        $root = if ($inputRecord.kind -eq 'controller') { $ControllerRoot } else { $SourceRoot }
        Require ((Hash (Join-Path $root $inputRecord.path)) -eq $inputRecord.sha256) 'A retained harness/source input changed before execution.'
    }
    Mark 'real-child-environment-alias-preflight'
    $probeCode = 'const names=' + (ConvertTo-Json -InputObject @($isolated.Keys) -Compress) + ';console.log(JSON.stringify(Object.entries(process.env).filter(([k])=>names.includes(k.toUpperCase())).map(([name,value])=>({name,value}))));'
    $probe = Start-Owned 'node' @('-e',$probeCode) $WorkRoot 'environment-probe' $true $true
    $probeResult = Complete-Owned $probe 10
    $probe.process.Dispose()
    Require ($probeResult.exit_code -eq 0) 'Actual child environment preflight failed.'
    $observed = @($probeResult.stdout | ConvertFrom-Json)
    foreach ($key in $isolated.Keys) {
        $matchingValues = @($observed | Where-Object { $_.name.ToUpperInvariant() -eq $key })
        Require ($matchingValues.Count -eq 1 -and $matchingValues[0].name -ceq $key -and $matchingValues[0].value -ceq $isolated[$key]) "Child environment did not establish one exact $key value."
    }
    Write-NewJson (Join-Path $EvidenceRoot 'environment.json') @{ aliases_removed=$true; actual_child_values=$observed; unrelated_environment_values_not_recorded=$true }
    Mark 'production-cli-build'
    $compilerArguments = @('build','--release','--locked','--no-default-features','-p','portcove-cli','--bin','portcove')
    $buildArguments = @('scripts/dev-storage.mts','run','--scope','rust','--','node','scripts/run-rust-tests.mts','--guard-command','cargo') + $compilerArguments
    Require ((ConvertTo-Json -InputObject @($plan.build) -Compress) -ceq (ConvertTo-Json -InputObject $compilerArguments -Compress)) 'Compiler arguments differ from the fixed plan.'
    Require ((ConvertTo-Json -InputObject @($plan.build_invocation) -Compress) -ceq (ConvertTo-Json -InputObject (@('node') + $buildArguments) -Compress)) 'Wrapper invocation differs from the fixed plan.'
    Require ($plan.build_jobs -eq 2 -and $plan.bounds_seconds.build -eq 2400) 'Fixed build jobs or budget changed.'
    $buildNode = (Get-Command 'node' -CommandType Application -ErrorAction Stop).Source
    Write-NewJson (Join-Path $EvidenceRoot 'build-invocation.json') @{
        executable=$buildNode; arguments=$buildArguments; working_directory=$SourceRoot
        compiler_executable='cargo'; compiler_arguments=$compilerArguments; environment=$buildEnvironment
        budget_seconds=[int]$plan.bounds_seconds.build; source=$plan.source
    }
    $build = Start-Owned $buildNode $buildArguments $SourceRoot 'build'
    try {
        $buildResult = Complete-Owned $build ([int]$plan.bounds_seconds.build)
        [IO.File]::Copy($build.outPath, (Join-Path $EvidenceRoot 'build.stdout.log'))
        [IO.File]::Copy($build.errPath, (Join-Path $EvidenceRoot 'build.stderr.log'))
        Require ($buildResult.exit_code -eq 0) 'Exact-source production CLI build failed.'
    } finally { if ($build.completed) { $build.process.Dispose() } }
    $script:cliHash = Hash $script:cli
    $rustc = (& rustc --version --verbose) -join "`n"
    Require ($LASTEXITCODE -eq 0 -and $rustc.Contains("release: $($plan.rust)")) 'The compiler differs from the reviewed source pin.'
    Require ((& node --version).Trim() -eq "v$($plan.node)") 'The evidence runtime differs from the reviewed source pin.'
    $about = Invoke-Cli 'about' @('about')
    Write-NewJson (Join-Path $EvidenceRoot 'binary.json') @{ source=$plan.source; path=$script:cli; bytes=(Get-Item $script:cli).Length; sha256=$script:cliHash; profile='release'; qualification_features=$false; rustc=$rustc; about=$about }
    Mark 'product-candidates-preview-download'
    $candidates = Invoke-Cli 'candidates' @('setup','candidates',$plan.port_id)
    $matches = @($candidates.candidates | Where-Object { $_.release_id -eq $plan.artifact.release_id -and $_.asset_id -eq $plan.artifact.asset_id })
    Require ($candidates.allowed -and $matches.Count -eq 1) 'The exact reviewed package was not returned by current production discovery; do not substitute another asset.'
    $downloadArgs = @($plan.port_id,'--release-id',[string]$plan.artifact.release_id,'--asset-id',[string]$plan.artifact.asset_id,'--destination-parent',$externalParent,'--extract')
    $preview = Invoke-Cli 'download-preview' (@('setup','preview') + $downloadArgs)
    foreach ($key in @('release_id','asset_id','release_tag','name','size','sha256','download_url')) { Require ($preview.artifact.$key -ceq $plan.artifact.$key) "Reviewed upstream $key changed; no package substitution is permitted." }
    Require ($preview.request.extract_archive -eq $true -and (Same-Path $preview.request.destination_parent $externalParent)) 'Download preview changed destination/extraction intent.'
    Require ((Same-Path (Split-Path $preview.destination_path) $externalParent) -and -not (Test-Path -LiteralPath $preview.destination_path)) 'Download target is not a fresh direct child of the isolated external destination.'
    Require ($preview.preview_sha256 -match '^[0-9a-f]{64}$') 'Download review digest is absent.'
    $pending = Invoke-Cli 'download' (@('setup','download') + $downloadArgs + @('--expected-preview',$preview.preview_sha256,'--yes'))
    Require ($pending.port_id -eq $plan.port_id -and $pending.state -eq 'downloaded' -and $pending.archive_sha256 -eq $plan.artifact.sha256 -and (Same-Path $pending.path $preview.destination_path)) 'Product acquisition did not retain the reviewed package identity.'
    $runtime = [IO.Path]::GetFullPath($pending.path.Replace('\\?\',''))
    $packageInventory = @(Inventory $runtime)
    $packageFiles = @($packageInventory | Where-Object path -ne '.portcove-download.json')
    Require ($packageFiles.Count -eq $plan.package_files.Count) 'Extracted package inventory differs from the reviewed nine files.'
    foreach ($file in $plan.package_files) {
        $found = @($packageFiles | Where-Object path -CEQ $file.path)
        Require ($found.Count -eq 1 -and $found[0].kind -eq 'file' -and $found[0].bytes -eq $file.bytes -and $found[0].sha256 -eq $file.sha256) "Extracted package member differs: $($file.path)"
    }
    $receipt = Get-Content (Join-Path $runtime '.portcove-download.json') -Raw | ConvertFrom-Json
    Require ($receipt.pending_id -eq $pending.id -and $receipt.preview_sha256 -eq $preview.preview_sha256 -and $receipt.archive_sha256 -eq $plan.artifact.sha256) 'Product handoff receipt differs from the reviewed download.'
    Write-NewJson (Join-Path $EvidenceRoot 'downloaded-package.json') @{ preview=$preview; pending=$pending; inventory=$packageInventory; receipt=$receipt }
    $freshPending = @(Invoke-Cli 'pending-after-restart' @('setup','pending'))
    Require (@($freshPending | Where-Object id -eq $pending.id).Count -eq 1) 'A fresh CLI did not retain downloaded setup.'
    [IO.File]::WriteAllText((Join-Path $runtime 'qualification-player-save.dat'), "Qualification preservation witness; not a game-authored save.`n", $utf8)
    $executable = Join-Path $runtime $plan.executable
    $selectionArgs = @($plan.port_id,$executable,'--working-directory',$runtime,'--arg=-n','--arg=-q')
    $pregame = @(Inventory $runtime)
    Write-NewJson (Join-Path $EvidenceRoot 'pregame.json') @{ runtime=$runtime; inventory=$pregame; profile=@(Inventory $gameProfile); sopwith_known_folder=(Sopwith-Preferences) }
    Mark 'reviewed-registration'
    $selectedPreview = Invoke-Cli 'selection-preview' (@('external','select-preview') + $selectionArgs)
    Check-Selection $selectedPreview $executable $runtime
    $registration = Invoke-Cli 'selection' (@('external','select') + $selectionArgs + @('--expected-preview',$selectedPreview.preview_sha256,'--yes'))
    Require ($registration.user_selected -and $registration.platform -eq 'windows-x86-64' -and $registration.id) 'Selection did not create a Windows user-selected registration.'
    Require ((Inventory-Text @(Inventory $runtime)) -ceq (Inventory-Text $pregame)) 'Registration changed external package/save bytes.'
    $afterRegistrationPending = @(Invoke-Cli 'pending-after-registration' @('setup','pending'))
    Require (@($afterRegistrationPending | Where-Object id -eq $pending.id).Count -eq 0) 'Matching pending setup was not retired after registration.'
    Assert-Ready (Invoke-Cli 'ready-after-registration' @('status',$plan.port_id)) $registration $executable $runtime
    Observe-Launch 'first' $registration $executable $runtime
    Mark 'fresh-cli-readiness-and-relink'
    $freshStatus = Invoke-Cli 'ready-after-first-exit' @('status',$plan.port_id)
    Assert-Ready $freshStatus $registration $executable $runtime
    Require ($freshStatus.successful_launches -ge 1) 'Fresh status did not retain the successful launch.'
    $replacement = Join-Path $externalParent 'sopwith-reviewed-relink-copy'
    Require (-not (Test-Path -LiteralPath $replacement)) 'Relink copy destination is not fresh.'
    $oldAtRelink = @(Inventory $runtime)
    Copy-Item -LiteralPath $runtime -Destination $replacement -Recurse
    Require ((Inventory-Text @(Inventory $replacement)) -ceq (Inventory-Text $oldAtRelink)) 'Qualification-owned relink copy is not byte-identical.'
    $replacementExecutable = Join-Path $replacement $plan.executable
    $relinkArgs = @($plan.port_id,$replacementExecutable,'--working-directory',$replacement,'--arg=-n','--arg=-q')
    $relinkPreview = Invoke-Cli 'relink-preview' (@('external','select-relink-preview') + $relinkArgs)
    Require ($relinkPreview.registration_id -eq $registration.id -and (Same-Path $relinkPreview.previous_path $runtime) -and $relinkPreview.external_files_will_be_preserved -eq $true) 'Relink review did not preserve the exact previous external registration.'
    Check-Selection $relinkPreview.proposed $replacementExecutable $replacement
    $relinked = Invoke-Cli 'relink' (@('external','select-relink') + $relinkArgs + @('--expected-preview',$relinkPreview.preview_sha256,'--yes'))
    Require ($relinked.id -eq $registration.id -and $relinked.registered_at -eq $registration.registered_at) 'Relink replaced the stable registration identity.'
    Require ((Inventory-Text @(Inventory $runtime)) -ceq (Inventory-Text $oldAtRelink) -and (Inventory-Text @(Inventory $replacement)) -ceq (Inventory-Text $oldAtRelink)) 'Relink modified old or new external files.'
    Write-NewJson (Join-Path $EvidenceRoot 'relink.json') @{ preview=$relinkPreview; record=$relinked; source_inventory=$oldAtRelink; replacement=$replacement }
    Assert-Ready (Invoke-Cli 'ready-after-relink' @('status',$plan.port_id)) $relinked $replacementExecutable $replacement
    Observe-Launch 'relinked' $relinked $replacementExecutable $replacement
    Assert-Ready (Invoke-Cli 'ready-after-second-exit' @('status',$plan.port_id)) $relinked $replacementExecutable $replacement
    Mark 'post-game-reviewed-registration-removal'
    $beforeRemoval = @{ original=@(Inventory $runtime); relinked=@(Inventory $replacement); isolated_game_profile=@(Inventory $gameProfile); sopwith_known_folder=(Sopwith-Preferences) }
    Write-NewJson (Join-Path $EvidenceRoot 'post-game-before-removal.json') $beforeRemoval
    $removal = Invoke-Cli 'removal-preview' @('external','removal-preview',$plan.port_id)
    Require ($removal.port_id -eq $plan.port_id -and (Same-Path $removal.path $replacement) -and $removal.external_files_will_be_preserved -eq $true -and $removal.preview_sha256 -match '^[0-9a-f]{64}$') 'Removal preview does not explicitly preserve the reviewed external files.'
    $removed = Invoke-Cli 'remove' @('external','remove',$plan.port_id,'--expected-preview',$removal.preview_sha256,'--yes')
    $finalStatus = Invoke-Cli 'status-after-removal' @('status',$plan.port_id)
    Require ($null -eq $finalStatus.external_runtime -and $finalStatus.readiness.launchable -ne $true) 'Fresh CLI still exposes the removed registration as launchable.'
    $afterRemoval = @{ original=@(Inventory $runtime); relinked=@(Inventory $replacement); isolated_game_profile=@(Inventory $gameProfile); sopwith_known_folder=(Sopwith-Preferences) }
    Write-NewJson (Join-Path $EvidenceRoot 'after-removal.json') $afterRemoval
    foreach ($key in $beforeRemoval.Keys) { Require ((Inventory-Text $beforeRemoval[$key]) -ceq (Inventory-Text $afterRemoval[$key])) "Registration removal changed $key bytes or entries." }
    Write-NewJson (Join-Path $EvidenceRoot 'removal-result.json') @{ preview=$removal; result=$removed; fresh_status=$finalStatus; inventories_equal=$true; original_runtime=$runtime; relinked_runtime=$replacement; game_profile=$gameProfile; sopwith_known_folder=$sopwithPreferences; preservation_scope='Exactly these recorded directories and entries; no whole-profile or gameplay claim.' }
    Require ((Hash $script:cli) -eq $script:cliHash) 'Production CLI binary changed before completion.'
    Assert-Hosting
    Mark 'journey-complete-awaiting-independent-pixel-review'
} catch {
    $failure = $_.Exception.Message
    Write-NewJson (Join-Path $EvidenceRoot 'failure.json') @{ at=[DateTime]::UtcNow.ToString('o'); step=$script:step; message=$failure; position=$_.InvocationInfo.PositionMessage }
} finally {
    # Force is cleanup only, after failure. It never satisfies the ordinary-close acceptance.
    if ($script:activeLaunch) {
        $active = $script:activeLaunch
        try {
            if ($active.gameSnapshot) {
                $cleanup = Invoke-Native 'StopApplication' $active.gameSnapshot
                Write-NewJson (Join-Path $native "$($active.label)-failed-owned-cleanup.json") $cleanup
                $cleanupExit = Invoke-Native 'Wait' $active.gameSnapshot
                Write-NewJson (Join-Path $native "$($active.label)-failed-cleanup-exit.json") $cleanupExit
            } else {
                # A root retained from this spawn may authorize its current isolated descendants.
                # The helper still checks every ancestry edge and the exact root incarnation.
                $snapshot = Join-Path $native "$($active.label)-failed-supervisor-tree.json"
                $tree = Invoke-Native 'SnapshotDriverTree' $snapshot @('-DriverProcessId',[string]$active.owned.process.Id)
                Require ($tree.driver.started_filetime -eq $active.owned.started -and (Same-Path $tree.driver.path $script:cli)) 'Failed-launch cleanup could not re-establish exact supervisor ownership.'
                $cleanup = Invoke-Native 'StopDriver' $snapshot
                Write-NewJson (Join-Path $native "$($active.label)-failed-owned-cleanup.json") $cleanup
                $cleanupExit = Invoke-Native 'Wait' $snapshot
                Write-NewJson (Join-Path $native "$($active.label)-failed-cleanup-exit.json") $cleanupExit
            }
            if (-not $active.owned.completed) { [void](Complete-Owned $active.owned 30) }
            $active.owned.process.Dispose()
        } catch { $script:cleanupFailures += $_.Exception.Message }
    }
    # Also close a timed-out build/management/helper root, if its retained
    # incarnation can still be positively re-established. No image-name kill.
    $unfinished = @($script:ownedCommands.ToArray() | Where-Object { -not $_.completed })
    [array]::Reverse($unfinished)
    foreach ($owned in $unfinished) {
        try {
            if (-not $owned.process.HasExited) {
                Require (-not [string]::IsNullOrWhiteSpace($owned.started)) 'Spawn succeeded but exact start identity is unavailable; cleanup authority is withheld.'
                $snapshot = Join-Path $native "$($owned.name)-failed-command-tree.json"
                $tree = Invoke-Native 'SnapshotDriverTree' $snapshot @('-DriverProcessId',[string]$owned.process.Id)
                Require ($tree.driver.started_filetime -eq $owned.started -and (Same-Path $tree.driver.path $owned.file)) 'Command timeout cleanup cannot establish the exact owned root.'
                $stopped = Invoke-Native 'StopDriver' $snapshot
                Write-NewJson (Join-Path $native "$($owned.name)-failed-command-stop.json") $stopped
                $waited = Invoke-Native 'Wait' $snapshot
                Write-NewJson (Join-Path $native "$($owned.name)-failed-command-exit.json") $waited
            }
            [void](Complete-Owned $owned 10)
            $owned.process.Dispose()
        } catch { $script:cleanupFailures += "$($owned.name): $($_.Exception.Message)" }
    }
    # Failed or incomplete journeys retain partial bytes. Successful command bytes
    # already exist in commands.jsonl and the normal build/native logs.
    if ($failure -or $script:cleanupFailures.Count -gt 0) {
        foreach ($name in @('build','first-exec','relinked-exec')) {
            foreach ($stream in @('stdout','stderr')) {
                $file = Join-Path $commandRoot "$name.$stream.log"
                $target = Join-Path $EvidenceRoot "$name.partial.$stream.log"
                if (Test-Path -LiteralPath $file) {
                    try { [IO.File]::Copy($file, $target) } catch { $script:cleanupFailures += "Could not retain $name $stream bytes: $($_.Exception.Message)" }
                }
            }
        }
    }
    if ($script:cleanupFailures.Count -gt 0 -and -not $failure) { $failure = 'Owned cleanup/evidence retention did not complete.' }
    $state = if ($failure) { 'failed' } else { 'completed-pending-independent-image-inspection' }
    $code = if ($failure) { 1 } else { 0 }
    $temporary = Join-Path $EvidenceRoot 'execution-final.json'
    Write-NewJson $temporary (Execution $code $state $failure)
    # Only this known incomplete terminal slot is replaced; detailed prior evidence is immutable.
    [IO.File]::Move($temporary, (Join-Path $EvidenceRoot 'execution.json'), $true)
}
if ($failure) { throw "Native observation failed at $script:step : $failure" }
