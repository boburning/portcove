# One public packaged Desktop and signed retained Crawl setup on a disposable hosted VM.
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
Write-Receipt 'host' @{ os=[Environment]::OSVersion.VersionString; image=$env:ImageOS
    image_version=$env:ImageVersion; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT }

$root = Join-Path $env:RUNNER_TEMP ("preview9-crawl-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$tag = 'nightly-0.1.0-preview.9'
$release = "https://github.com/boburning/portcove/releases/download/$tag"
$desktopDigest = 'fae5ac4dfa597547d3ecb7c052589e6427a7577c516fcc3d06c8b022a6074b2a'
$cliDigest = 'bf579694dafefd2d119cbd2f7b889c6eef926c6b0f47821a884a942c36d6df59'
$port = 'dungeon-crawl-stone-soup'
$asset = 'a772f22db9dde5dfa85bcc1652dbf16e3d62ecd1173f27c39387403532507979'
$index = '3c1e99312a5215ab2a60387d039360b8ec5c390f739a16900c1e3555e760fa76'
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
$zip = Get-Artifact 'portcove-cli-0.1.0-preview.9-windows-x86_64.zip' 20008110 'a2a4930636b24765f6ffde88e92b2a5541ee2bb3973153cb20a4f6082cc3ccaf'
Write-Receipt 'frozen-release' @{ source='f4256f25615d75acc081afb984ab4195288db881'; release_id=451546466
    installer_asset_id=768235484; signed_sidecar_asset_id=768235603; cli_asset_id=768236038 }

# Fixture-only unpacking verifies the exact installed bytes independently of the
# run. The real smoke uses the maintained installer, not this extracted copy.
$sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'Hosted 7-Zip prerequisite unavailable' }
$package = Join-Path $root 'package'
& $sevenZip x "-o$package" -y $setup 'portcove-desktop.exe' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the known NSIS executable' }
$desktop = Join-Path $package 'portcove-desktop.exe'
Assert-File $desktop 82359808 $desktopDigest

$app = Join-Path $root 'portcove-desktop.exe'
$installerReceipt = Join-Path $root 'installer-receipt.json'
$env:PORTCOVE_PREFERENCES = Join-Path $root 'smoke-host-preferences.json'
$env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $root 'smoke-update-preferences.json'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'smoke-webview'
$pwsh = (Get-Command pwsh -CommandType Application).Source
& $pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'test-windows-installer.ps1') `
    -InstallerPath $setup -ExpectedExecutablePath $desktop -ExpectedExecutableSha256 $desktopDigest `
    -ExpectedVersion '0.1.0-preview.9' -TestBase $root `
    -RetainExecutablePath $app -EvidencePath $installerReceipt
$installerExit = $LASTEXITCODE
if (Test-Path -LiteralPath $installerReceipt -PathType Leaf) {
    $installed = Get-Content -LiteralPath $installerReceipt -Raw | ConvertFrom-Json
    Write-Receipt 'installer' @{ sha256=(Get-FileHash -LiteralPath $installerReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
        phase=$installed.phase; exit_status=$installerExit; desktop_sha256=$desktopDigest }
}
if ($installerExit -ne 0) { throw 'Owned installer smoke or removal failed' }
Assert-File $app 82359808 $desktopDigest

# Seed a new library using the exact published CLI and its ordinary fixed-anchor
# approval, signed refresh and reviewed install. No retained machine data enters.
Add-Type -AssemblyName System.IO.Compression.FileSystem
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
if ($refresh.disposition -cne 'selected' -or $choice.stable_id -cne $port -or
    $choice.definition_revision -ne 2 -or $choice.provenance.index_sha256 -cne $index) {
    throw 'Current signed Crawl selection differs from the reviewed public subject'
}
$plan = Read-Cli @('installation','plan',$port)
if ($null -ne $plan.selected_install -or $plan.plan.release.version -cne '0.34.1' -or
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

# Exercise only the published installed executable, from the owned copy after
# the installer smoke. Use its normal accessibility tree and exact control names.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$process = Start-Process -FilePath $app -WorkingDirectory $root -PassThru
$null = $process.Handle
$created = $process.StartTime.ToUniversalTime()
$observedFailure = $false
$browserProcesses = @()
try {
    function Read-OwnedWindow {
        $process.Refresh()
        if ($process.HasExited -or $process.StartTime.ToUniversalTime() -ne $created -or
            $process.Path -ne $app) { throw 'Owned Desktop process identity changed' }
        if ($process.MainWindowHandle -eq [IntPtr]::Zero) { return }
        [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
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
        library='fresh isolated signed v2 setup'; game='Dungeon Crawl Stone Soup'; action='Manage'
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
Write-Receipt 'completed' @{ scope='packaged installer smoke and retained installed executable, native visible management controls'
    limits='no GUI acquisition, gameplay, next-artifact transition or minimum Windows claim' }
