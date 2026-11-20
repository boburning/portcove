# One public packaged Desktop and signed retained Crawl setup on a disposable hosted VM.
param([Parameter(Mandatory=$true)][ValidateSet('installer','crawl')][string]$Observation)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ARCH -cne 'X64' -or -not [Environment]::UserInteractive -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) {
    throw 'Expected an isolated interactive GitHub-hosted Windows x64 job'
}
function Write-Receipt([string]$Phase, [object]$Evidence) {
    @{phase=$Phase; evidence=$Evidence} | ConvertTo-Json -Depth 8 -Compress
}
function Read-RuntimeSignal([string]$Text) {
    if ($Text -match 'Portcove cannot start with WebView runtime (\d{1,10}(?:\.\d{1,10}){3})\. Install or update the WebView2 Evergreen production Runtime to (\d{1,10}(?:\.\d{1,10}){3}) or later') {
        return @{ result='below-published-floor'; selected=$Matches[1]; minimum=$Matches[2] }
    }
    if ($Text.Contains('Portcove could not find its required WebView runtime:')) {
        return @{ result='runtime-lookup-failed' }
    }
    if ($Text.Contains('This Portcove build lacks a valid WebView2 runtime minimum.')) {
        return @{ result='invalid-embedded-floor' }
    }
    if ($Text -match 'Portcove WebView runtime version: (\d{1,10}(?:\.\d{1,10}){3})(?:\r?\n|$)') {
        return @{ result='runtime-selected'; selected=$Matches[1] }
    }
}

$minimum = '155.0.4283.62' # Frozen f4256f256 Portcove bundle.windows.minimumWebview2Version.
Import-Module (Join-Path $PSScriptRoot 'windows-webview-driver-policy.psm1') -ErrorAction Stop
$registeredRuntime = try { Get-WebViewRuntimeVersion } catch { $null }
Write-Receipt 'runtime-prerequisite' @{
    observation=$Observation; published_minimum=$minimum; registered_evergreen=$registeredRuntime
    registered_meets_floor=$(if ($registeredRuntime) { [version]$registeredRuntime -ge [version]$minimum } else { $null })
    scope='registered prerequisite only'
}
Write-Receipt 'host' @{ os=[Environment]::OSVersion.VersionString; image=$env:ImageOS
    image_version=$env:ImageVersion; observation=$Observation; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT }

$root = Join-Path $env:RUNNER_TEMP ("preview9-crawl-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$tag = 'nightly-0.1.0-preview.9'
$release = "https://github.com/boburning/portcove/releases/download/$tag"
$desktopDigest = 'fae5ac4dfa597547d3ecb7c052589e6427a7577c516fcc3d06c8b022a6074b2a'
$cliDigest = 'bf579694dafefd2d119cbd2f7b889c6eef926c6b0f47821a884a942c36d6df59'
$port = 'dungeon-crawl-stone-soup'
$asset = 'a772f22db9dde5dfa85bcc1652dbf16e3d62ecd1173f27c39387403532507979'
$reviewedIndexes = @{
    2 = '3c1e99312a5215ab2a60387d039360b8ec5c390f739a16900c1e3555e760fa76'
    3 = 'dc0f562b37b80767baeed3ad5a575a9a1d1a34f06641df0a8d0ebcc0dbcd91a6'
}
$rootDigest = '743432a536ad25ba6f9544b0ce4e62c79fd941e84c722e22a79a4b315d55d849'
$anchor = '748bf3e9ec10a585ea62beb6228379642de3b33d0f2d94272ce0bd42d6e35e7b'

function Assert-File([string]$Path, [long]$Bytes, [string]$Digest) {
    if ((Get-Item -LiteralPath $Path).Length -ne $Bytes -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) {
        throw "Frozen file identity differs ($([IO.Path]::GetFileName($Path)))"
    }
}
function Get-Artifact([string]$Name, [long]$Bytes, [string]$Digest) {
    $path = Join-Path $root $Name
    & curl.exe -fsSL --proto '=https' --proto-redir '=https' --max-time 90 --max-filesize $Bytes --output $path "$release/$Name"
    if ($LASTEXITCODE -ne 0) { throw "Could not acquire exact public release file $Name" }
    Assert-File $path $Bytes $Digest
    $path
}
$setupName = 'Portcove_0.1.0-preview.9_x64-setup.exe'
$setup = Get-Artifact $setupName 20547701 'da133337b4b0e0e08bde940fe81fc6ffb20921b466dc83ece804588cd8e54132'
$null = Get-Artifact "$setupName.sig" 464 '47be86fa8d7db3a6c59bf92268c826b91b8e771451463ecc4a08ea2f615bd1f3'
Write-Receipt 'frozen-release' @{ source='f4256f25615d75acc081afb984ab4195288db881'; release_id=451546466
    installer_asset_id=768235484; signed_sidecar_asset_id=768235603; cli_asset_id=768236038 }

# A single named extraction from the authenticated package gives the known
# executable. The installer cell independently checks the installed bytes.
$sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'Hosted 7-Zip prerequisite unavailable' }
$package = Join-Path $root 'package'
& $sevenZip x "-o$package" -y $setup 'portcove-desktop.exe' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the known NSIS executable' }
$desktop = Join-Path $package 'portcove-desktop.exe'
Assert-File $desktop 82359808 $desktopDigest

function Read-InstallerSummary([string]$Receipt, [int]$ExitStatus) {
    $journal = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
    $smokes = @($journal.process_runs | Where-Object { $_.role -ceq 'candidate_smoke' })
    $summary = @{
        sha256=(Get-FileHash -LiteralPath $Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
        phase=$journal.phase; exit_status=$ExitStatus; desktop_sha256=$desktopDigest
        candidate_smoke_count=$smokes.Count
    }
    if ($smokes.Count -eq 1) {
        $smoke = $smokes[0]
        $summary.candidate_smoke = @{
            pid=$smoke.pid; start_filetime=$smoke.start_time_filetime; status=$smoke.status
            executable_sha256=$smoke.executable_sha256
        }
    }
    $details = $journal.PSObject.Properties['details']
    if ($journal.phase -ceq 'complete' -and $details.Value) {
        $summary.completed = @{
            initialized_database_required=$true; registered_version=$details.Value.registered_version
            responding=$details.Value.application_responding; exit_code=$details.Value.application_exit_code
            persistent_data_preserved=$details.Value.persistent_data_preserved
            registration_removed=$details.Value.registration_removed
        }
    }
    $relative = $journal.owned_paths.run_root_relative
    if ($relative -cmatch '^run-[a-f0-9]{32}$') {
        $ownedRun = Join-Path $root $relative
        $database = Get-Item -LiteralPath (Join-Path $ownedRun 'library\portcove.sqlite3') -ErrorAction SilentlyContinue
        $summary.initialized_database_observed = $database -and $database.Length -gt 0
        $declaredStderr = if ($smokes.Count -eq 1) { $smokes[0].PSObject.Properties['error_relative'] }
        $stderr = if ($declaredStderr -and $declaredStderr.Value -ceq 'candidate-smoke.stderr.log') {
            Get-Item -LiteralPath (Join-Path $ownedRun $declaredStderr.Value) -ErrorAction SilentlyContinue
        }
        $summary.stderr_journal_bound = [bool]$stderr
        if ($stderr) {
            $summary.stderr_bytes = $stderr.Length
            $summary.stderr_sha256 = (Get-FileHash -LiteralPath $stderr.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($stderr.Length -le 65536) {
                $text = Get-Content -LiteralPath $stderr.FullName -Raw
                $summary.runtime = Read-RuntimeSignal ([string]$text)
                $startupCodes = [regex]::Matches([string]$text, '(?im)Portcove could not (open its library|open host preferences|open its runtime lease)[^\r\n]{0,200}\[([a-z_]{1,32})\]')
                $summary.startup_error_codes = @($startupCodes | ForEach-Object {
                    @{ failure=$_.Groups[1].Value; code=$_.Groups[2].Value }
                } | Select-Object -First 8)
            }
        }
    }
    Write-Receipt 'installer' $summary
}
if ($Observation -ceq 'installer') {
    $app = Join-Path $root 'portcove-desktop.exe'
    $installerReceipt = Join-Path $root 'installer-receipt.json'
    $env:PORTCOVE_PREFERENCES = Join-Path $root 'smoke-host-preferences.json'
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $root 'smoke-update-preferences.json'
    $env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $root 'smoke-runtime.lock'
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'smoke-webview'
    $pwsh = (Get-Command pwsh -CommandType Application).Source
    & $pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'test-windows-installer.ps1') `
        -InstallerPath $setup -ExpectedExecutablePath $desktop -ExpectedExecutableSha256 $desktopDigest `
        -ExpectedVersion '0.1.0-preview.9' -TestBase $root `
        -RetainExecutablePath $app -EvidencePath $installerReceipt
    $installerExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $installerReceipt -PathType Leaf) { Read-InstallerSummary $installerReceipt $installerExit }
    if ($installerExit -ne 0) { throw 'Owned installer smoke or removal failed' }
    Assert-File $app 82359808 $desktopDigest
    return
}

# Seed a new library using the exact published CLI and its ordinary fixed-anchor
# approval, signed refresh and reviewed install. No retained machine data enters.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Get-Artifact 'portcove-cli-0.1.0-preview.9-windows-x86_64.zip' 20008110 'a2a4930636b24765f6ffde88e92b2a5541ee2bb3973153cb20a4f6082cc3ccaf'
$cli = Join-Path $root 'portcove.exe'
$cliArchive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    if ($cliArchive.Entries.Count -ne 1 -or $cliArchive.Entries[0].FullName -cne 'portcove.exe' -or
        $cliArchive.Entries[0].Length -lt 1 -or $cliArchive.Entries[0].Length -gt 120MB) {
        throw 'Unexpected published CLI archive layout'
    }
    $cliBytes = $cliArchive.Entries[0].Length
    [IO.Compression.ZipFileExtensions]::ExtractToFile($cliArchive.Entries[0], $cli, $false)
} finally { $cliArchive.Dispose() }
Assert-File $cli $cliBytes $cliDigest
$library = Join-Path $root 'crawl-library'
$env:PORTCOVE_LIBRARY = $library
$env:PORTCOVE_PREFERENCES = Join-Path $root 'crawl-host-preferences.json'
$env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $root 'crawl-update-preferences.json'
$env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $root 'crawl-runtime.lock'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'crawl-webview'
function Read-Cli([string[]]$Command) {
    $json = & $cli --library $library --json --non-interactive @Command
    if ($LASTEXITCODE -ne 0) { throw "Published CLI operation failed ($($Command[0]))" }
    $result = $json | ConvertFrom-Json
    if (-not $result.ok) { throw 'Published CLI did not return a success receipt' }
    $result.data
}
$authority = Read-Cli @('catalog','definition-authority')
if (-not $authority.configured -or $authority.installed -or
    $authority.compiled_anchor_sha256 -cne $anchor -or $authority.expected_plan -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Fresh CLI library or compiled definition anchor differs'
}
$approved = Read-Cli @('catalog','definition-authority','--apply','--expected-plan',$authority.expected_plan,'--yes')
if (-not $approved.changed -or -not $approved.review.installed -or $approved.review.installed_anchor_sha256 -cne $anchor) {
    throw 'Exact ordinary definition authority provisioning did not complete'
}
$pages = 'https://boburning.github.io/portcove/catalog'
$refresh = Read-Cli @('catalog','definition-refresh',$port,'--metadata-base-url',"$pages/metadata",'--targets-base-url',"$pages/targets")
$choice = $refresh.selection.selected
$definitionRevision = [int]$choice.definition_revision
$index = $reviewedIndexes[$definitionRevision]
if ($refresh.disposition -cne 'selected' -or $choice.stable_id -cne $port -or -not $index -or
    $choice.provenance.index_sha256 -cne $index -or
    $choice.provenance.root_version -ne 1 -or $choice.provenance.root_sha256 -cne $rootDigest) {
    throw 'Current signed Crawl selection differs from the reviewed public subject'
}
$plan = Read-Cli @('installation','plan',$port)
if ($null -ne $plan.selected_install -or $plan.plan.port_id -cne $port -or
    $plan.plan.platform -cne 'windows-x86-64' -or $plan.plan.channel -cne 'stable' -or
    @($plan.plan.source_requirements).Count -ne 0 -or $plan.plan.release.version -cne '0.34.1' -or
    $plan.plan.release.asset.url -cne 'https://github.com/crawl/crawl/releases/download/0.34.1/dcss-0.34.1-win32-tiles.zip' -or
    $plan.plan.release.asset.name -cne 'dcss-0.34.1-win32-tiles.zip' -or
    $plan.plan.release.asset.size -ne 26551751 -or $plan.plan.release.asset.sha256 -cne $asset -or
    $plan.plan_sha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Crawl reviewed installation identity differs'
}
$null = Read-Cli @('installation','run',$port,'--expected-plan',$plan.plan_sha256,'--yes')
$active = (Read-Cli @('status',$port)).active
$verified = Read-Cli @('verify',$port)
if ($active.artifact.sha256 -cne $asset -or $verified.install_id -cne $active.id -or
    -not $verified.valid -or $verified.checked_files -ne 690) { throw 'Exact managed Crawl installation did not verify' }
Write-Receipt 'cli-seed' @{ install_id=$active.id; package_sha256=$asset; definition_index_sha256=$index
    definition_revision=$choice.definition_revision; files=$verified.checked_files }

# This independent cell observes the exact package-extracted executable.
# Use its normal accessibility tree and real managed installation controls.
$app = $desktop
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$stdout = Join-Path $root 'crawl-desktop.stdout.log'
$stderr = Join-Path $root 'crawl-desktop.stderr.log'
$process = Start-Process -FilePath $app -WorkingDirectory $root -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$null = $process.Handle
$created = $process.StartTime.ToUniversalTime()
$observedFailure = $false
$browserProcesses = @()
$windowsObserved = @{}
try {
    function Read-OwnedWindow {
        $process.Refresh()
        if ($process.HasExited -or $process.StartTime.ToUniversalTime() -ne $created -or
            $process.Path -ne $app) { throw 'Owned Desktop process identity changed' }
        if ($process.MainWindowHandle -eq [IntPtr]::Zero) { return }
        $handle = $process.MainWindowHandle
        $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($window.Current.ProcessId -ne $process.Id) { throw 'Desktop window belongs to another process' }
        $runtimeModal = $window.Current.ClassName -ceq '#32770' -and
            $window.Current.Name -ceq 'Portcove runtime required'
        $windowKind = if ($runtimeModal) { 'runtime-required' }
            elseif ($window.Current.ClassName -ceq '#32770') { 'other-native-dialog' }
            else { 'other-owned-window' }
        $windowKey = "$($handle.ToInt64())/$windowKind"
        if ($windowsObserved.Count -lt 8 -and -not $windowsObserved.ContainsKey($windowKey)) {
            $windowsObserved[$windowKey] = $true
            $runtime = $null
            if ($runtimeModal) {
                $textCondition = [Windows.Automation.PropertyCondition]::new(
                    [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
                $labels = @($window.FindAll([Windows.Automation.TreeScope]::Children, $textCondition) |
                    Select-Object -First 8 | ForEach-Object { $_.Current.Name } |
                    Where-Object { $_.Length -le 2048 })
                $runtime = Read-RuntimeSignal ($labels -join "`n")
            }
            Write-Host (Write-Receipt 'owned-startup-window' @{
                kind=$windowKind; pid=$process.Id; start_filetime=$created.ToFileTimeUtc()
                hwnd=$handle.ToInt64(); runtime=$runtime
            })
        }
        if ($runtimeModal) { throw 'The owned Desktop displayed its fixed WebView2 runtime-required prompt' }
        $window
    }
    function Read-Controls([string]$Name, [switch]$Invokable) {
        $window = Read-OwnedWindow
        if ($null -eq $window) { return }
        $nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
        foreach ($control in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $nameCondition)) {
            if ($control.Current.IsOffscreen -or $control.Current.BoundingRectangle.IsEmpty) { continue }
            if ($Invokable) {
                $pattern = $null
                if (-not $control.Current.IsEnabled) { continue }
                if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                    $pattern
                } elseif ($control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                    $pattern
                }
            } else { $control }
        }
    }
    function Wait-Control([string]$Name, [switch]$Invokable) {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $items = @(Read-Controls $Name -Invokable:$Invokable)
            if ($items.Count -eq 1) { return $items[0] }
            Start-Sleep -Milliseconds 400
        } while ($timer.Elapsed.TotalSeconds -lt 30)
        throw "No unique visible owned control ($Name)"
    }
    function Select-Control([string]$Name) {
        $pattern = Wait-Control $Name -Invokable
        if ($pattern -is [Windows.Automation.SelectionItemPattern]) { $pattern.Select() }
        else { $pattern.Invoke() }
    }
    Select-Control 'Library'
    Select-Control 'Dungeon Crawl Stone Soup'
    $null = Wait-Control 'Dungeon Crawl Stone Soup'
    Select-Control 'Manage'
    $null = Wait-Control 'Technical details'
    Select-Control 'Versions & updates'
    $null = Wait-Control 'Installation and release versions'
    $null = Wait-Control '0.34.1'
    $nativeBrowsers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id) AND Name = 'msedgewebview2.exe'")
    foreach ($child in $nativeBrowsers) {
        if ($child.CreationDate.ToUniversalTime() -lt $created.AddSeconds(-1) -or
            [string]::IsNullOrWhiteSpace($child.ExecutablePath) -or
            ([string]$child.CommandLine).IndexOf($env:WEBVIEW2_USER_DATA_FOLDER, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            continue
        }
        $browser = [Diagnostics.Process]::GetProcessById([int]$child.ProcessId)
        $null = $browser.Handle
        if ($browser.HasExited -or $browser.Path -ne $child.ExecutablePath -or
            [Math]::Abs(($browser.StartTime.ToUniversalTime() - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1000) {
            $browser.Dispose()
            throw 'Native WebView process identity changed'
        }
        $browserProcesses += $browser
    }
    if ($browserProcesses.Count -ne 1) { throw 'Expected one identity-bound WebView browser in its private profile' }
    Write-Receipt 'desktop-management' @{ pid=$process.Id; start_filetime=$created.ToFileTimeUtc()
        library='fresh isolated signed setup'; definition_revision=$definitionRevision; game='Dungeon Crawl Stone Soup'; action='Manage'
        visible_section='Versions & updates'; version='0.34.1'; desktop_sha256=$desktopDigest
        webview_pid=$browserProcesses[0].Id; webview_version=$browserProcesses[0].MainModule.FileVersionInfo.ProductVersion }
} catch {
    $observedFailure = $true
    Write-Receipt 'desktop-management-failed' @{ message=$_.Exception.Message }
    throw
} finally {
    $closed = $false
    $exitCode = $null
    try {
        $process.Refresh()
        if (-not $process.HasExited -and $process.StartTime.ToUniversalTime() -eq $created -and $process.Path -eq $app) {
            $closed = $process.CloseMainWindow() -and $process.WaitForExit(10000)
            if ($closed) { $exitCode = $process.ExitCode }
        }
        if (Test-Path -LiteralPath $stderr -PathType Leaf) {
            $capture = Get-Item -LiteralPath $stderr
            $runtime = if ($capture.Length -le 65536) {
                Read-RuntimeSignal ([string](Get-Content -LiteralPath $stderr -Raw))
            }
            Write-Receipt 'desktop-startup-stderr' @{
                bytes=$capture.Length; sha256=(Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash.ToLowerInvariant()
                runtime=$runtime
            }
        }
        $webviewExit = @($browserProcesses | ForEach-Object { @{ pid=$_.Id; exited=$_.WaitForExit(10000) } })
        Write-Receipt 'desktop-close' @{ pid=$process.Id; closed=$closed; exit_code=$exitCode
            owned_webview_exit=$webviewExit; forced=$false }
        if ((-not $closed -or $exitCode -ne 0 -or @($webviewExit | Where-Object { -not $_.exited }).Count -gt 0) -and
            -not $observedFailure) {
            throw 'Normal closure of the owned Desktop process was not proved'
        }
    } finally {
        foreach ($browser in $browserProcesses) { $browser.Dispose() }
        $process.Dispose()
    }
}
Write-Receipt 'completed' @{ scope='authenticated package-extracted executable and native visible management controls'
    limits='no GUI acquisition, gameplay, next-artifact transition or minimum Windows claim' }
