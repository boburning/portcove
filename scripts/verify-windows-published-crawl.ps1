# Observe the published installer, signed Crawl revision, and ordinary embedded route.
param([Parameter(Mandatory=$true)][ValidateSet('binding','installer','crawl')][string]$Observation)

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

$sourceRoot = Split-Path -Parent $PSScriptRoot
$bindingPath = Join-Path $PSScriptRoot 'fixtures/published-windows-crawl-release.json'
$fixture = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
if ($fixture.schema_version -ne 1 -or $null -eq $fixture.release) {
    throw 'Exact normally published Windows release binding is pending'
}
$bound = $fixture.release
if ($bound.version -cnotmatch '^\d+\.\d+\.\d+-preview\.[1-9]\d*$' -or
    $bound.source -cnotmatch '^[a-f0-9]{40}$' -or $bound.release_id -le 0 -or
    $bound.minimum_webview2 -cnotmatch '^\d{1,10}(?:\.\d{1,10}){3}$' -or
    $bound.updater_key_sha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Invalid immutable Preview identity'
}
function Assert-ReviewedFilePin($Pin, [long]$Cap, [switch]$PublicAsset) {
    if ($Pin.bytes -le 0 -or $Pin.bytes -gt $Cap -or $Pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        ($PublicAsset -and $Pin.id -le 0)) { throw 'Invalid reviewed published file pin' }
}
Assert-ReviewedFilePin $bound.installer 150MB -PublicAsset
Assert-ReviewedFilePin $bound.signature 16KB -PublicAsset
Assert-ReviewedFilePin $bound.cli_archive 150MB -PublicAsset
Assert-ReviewedFilePin $bound.desktop_executable 150MB
Assert-ReviewedFilePin $bound.cli_executable 150MB
if (@($bound.installer.id, $bound.signature.id, $bound.cli_archive.id | Sort-Object -Unique).Count -ne 3) {
    throw 'Published asset identities must be distinct'
}
$version = [string]$bound.version
$tag = "nightly-$version"
$setupName = "Portcove_${version}_x64-setup.exe"
$cliName = "portcove-cli-$version-windows-x86_64.zip"
$minimum = [string]$bound.minimum_webview2
$repair = '63c2bb76e4430ca684bf14724f3c5de20d83b3fb'
& git -C $sourceRoot merge-base --is-ancestor $repair $bound.source
if ($LASTEXITCODE -ne 0) { throw 'Publication source does not include the reviewed embedded-floor repair' }
$tagCommit = (& git -C $sourceRoot rev-parse "refs/tags/$tag^{commit}" | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $tagCommit -cne $bound.source) { throw 'Local immutable tag source differs' }
function Read-PublishedObject([string]$Relative) {
    $body = (& git -C $sourceRoot show "$($bound.source):$Relative" | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Required publication input unavailable ($Relative)" }
    $body
}
$sourceConfig = Read-PublishedObject 'apps/desktop/src-tauri/tauri.conf.json' | ConvertFrom-Json
# A different release recipe may change the effective Windows startup policy.
# The reviewed ordinary Preview recipe only adds updater and macOS settings.
$recipe = Read-PublishedObject '.github/workflows/app-release-build.yml'
$configurationOptions = @($recipe -split '\r?\n' | Where-Object { $_ -match '(?:^|\s)--config\b' })
$ordinaryOverlay = '--config ''{"bundle":{"createUpdaterArtifacts":true,"macOS":{"signingIdentity":"-"}}}'''
if ($configurationOptions.Count -ne 1 -or $configurationOptions[0].Trim() -cne $ordinaryOverlay -or
    $recipe -match 'TAURI_CONFIG') { throw 'Ordinary Preview Tauri overlay differs from the reviewed build path' }
$windowsConfig = Read-PublishedObject 'apps/desktop/src-tauri/tauri.windows.conf.json' | ConvertFrom-Json
$windows = $windowsConfig.bundle.windows
$overlayMinimum = $windows.PSObject.Properties['minimumWebview2Version']
$overlayPlugins = $windowsConfig.PSObject.Properties['plugins']
if ($overlayPlugins -or ($overlayMinimum -and $overlayMinimum.Value -cne $minimum)) {
    throw 'Published Windows overlay changes reviewed minimum or updater policy'
}
$runnerConfig = Get-Content -LiteralPath (Join-Path $sourceRoot 'apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if ($sourceConfig.bundle.windows.minimumWebview2Version -cne $minimum -or
    $runnerConfig.bundle.windows.minimumWebview2Version -cne $minimum) {
    throw 'Published effective WebView2 floor differs from the approved hosted prerequisite floor'
}
$key = [Convert]::FromBase64String($sourceConfig.plugins.updater.pubkey)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $keyHash = [BitConverter]::ToString($hasher.ComputeHash($key)).Replace('-', '').ToLowerInvariant() }
finally { $hasher.Dispose() }
if ($keyHash -cne $bound.updater_key_sha256) { throw 'Published signature verification key differs' }

if ($Observation -ceq 'binding') {
    $headers = @{ Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28' }
    $publication = Invoke-RestMethod -Uri "https://api.github.com/repos/boburning/portcove/releases/tags/$tag" -TimeoutSec 45 -Headers $headers
    if ($publication.id -ne $bound.release_id -or $publication.tag_name -cne $tag -or
        $publication.target_commitish -cne $bound.source -or $publication.immutable -ne $true -or
        $publication.draft -ne $false -or $publication.prerelease -ne $true) {
        throw 'Actual immutable Preview publication differs'
    }
    function Assert-PublishedAsset([string]$Name, $Pin) {
        $rows = @($publication.assets | Where-Object { $_.id -eq $Pin.id })
        if ($rows.Count -ne 1 -or $rows[0].name -cne $Name -or $rows[0].size -ne $Pin.bytes -or
            $rows[0].digest -cne "sha256:$($Pin.sha256)") { throw "Actual public asset differs ($Name)" }
    }
    Assert-PublishedAsset $setupName $bound.installer
    Assert-PublishedAsset "$setupName.sig" $bound.signature
    Assert-PublishedAsset $cliName $bound.cli_archive
    $receipt = @{ binding_sha256=(Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant()
        source=$bound.source; release_id=$bound.release_id; version=$version; minimum_webview2=$minimum }
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:PORTCOVE_OUTPUT_DIR 'published-release.json')
    Write-Receipt 'binding' $receipt
    return
}
$admitted = Get-Content -LiteralPath (Join-Path $env:PORTCOVE_OUTPUT_DIR 'published-release.json') -Raw | ConvertFrom-Json
if ($admitted.binding_sha256 -cne (Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
    $admitted.source -cne $bound.source -or $admitted.release_id -ne $bound.release_id -or
    $admitted.version -cne $version -or $admitted.minimum_webview2 -cne $minimum) {
    throw 'Hosted preparation did not follow the exact release binding'
}
Import-Module (Join-Path $PSScriptRoot 'windows-webview-driver-policy.psm1') -ErrorAction Stop
$registeredRuntime = try { Get-WebViewRuntimeVersion } catch { $null }
Write-Receipt 'runtime-prerequisite' @{
    observation=$Observation; published_minimum=$minimum; registered_evergreen=$registeredRuntime
    registered_meets_floor=$(if ($registeredRuntime) { [version]$registeredRuntime -ge [version]$minimum } else { $null })
    scope='registered prerequisite only'
}
Write-Receipt 'host' @{ os=[Environment]::OSVersion.VersionString; image=$env:ImageOS
    image_version=$env:ImageVersion; observation=$Observation; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT }

$serviced = Get-Content -LiteralPath (Join-Path $env:PORTCOVE_OUTPUT_DIR 'webview2-runtime.json') -Raw | ConvertFrom-Json
if ($serviced.minimum -cne $minimum -or $registeredRuntime -cne $serviced.after -or
    [version]$registeredRuntime -lt [version]$minimum) { throw 'Maintained WebView2 preparation did not establish the binding floor' }
$root = Join-Path $env:RUNNER_TEMP ("published-crawl-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$release = "https://github.com/boburning/portcove/releases/download/$tag"
$desktopDigest = $bound.desktop_executable.sha256
$cliDigest = $bound.cli_executable.sha256
$port = 'dungeon-crawl-stone-soup'
$asset = 'a772f22db9dde5dfa85bcc1652dbf16e3d62ecd1173f27c39387403532507979'
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
$setup = Get-Artifact $setupName $bound.installer.bytes $bound.installer.sha256
$null = Get-Artifact "$setupName.sig" $bound.signature.bytes $bound.signature.sha256
Write-Receipt 'frozen-release' @{
    source=$bound.source; release_id=$bound.release_id; version=$version
    installer_asset_id=$bound.installer.id; signed_sidecar_asset_id=$bound.signature.id; cli_asset_id=$bound.cli_archive.id
}

# A single named extraction from the authenticated package gives the known
# executable. The installer cell independently checks the installed bytes.
$sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'Hosted 7-Zip prerequisite unavailable' }
$package = Join-Path $root 'package'
& $sevenZip x "-o$package" -y $setup 'portcove-desktop.exe' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the known NSIS executable' }
$desktop = Join-Path $package 'portcove-desktop.exe'
Assert-File $desktop $bound.desktop_executable.bytes $desktopDigest

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
        -ExpectedVersion $version -TestBase $root `
        -RetainExecutablePath $app -EvidencePath $installerReceipt
    $installerExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $installerReceipt -PathType Leaf) { Read-InstallerSummary $installerReceipt $installerExit }
    if ($installerExit -ne 0) { throw 'Owned installer smoke or removal failed' }
    Assert-File $app $bound.desktop_executable.bytes $desktopDigest
    return
}

# Observe signed selection and its retained state with the published CLI and
# ordinary fixed-anchor approval in an isolated library.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Get-Artifact $cliName $bound.cli_archive.bytes $bound.cli_archive.sha256
$cli = Join-Path $root 'portcove.exe'
$cliArchive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    if ($cliArchive.Entries.Count -ne 1 -or $cliArchive.Entries[0].FullName -cne 'portcove.exe' -or
        $cliArchive.Entries[0].Length -ne $bound.cli_executable.bytes) {
        throw 'Unexpected published CLI archive layout'
    }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($cliArchive.Entries[0], $cli, $false)
} finally { $cliArchive.Dispose() }
Assert-File $cli $bound.cli_executable.bytes $cliDigest
function Set-CrawlProfile([string]$Name) {
    $env:PORTCOVE_LIBRARY = Join-Path $root "$Name-library"
    $env:PORTCOVE_PREFERENCES = Join-Path $root "$Name-host-preferences.json"
    $env:PORTCOVE_APPLICATION_UPDATE_PREFERENCES = Join-Path $root "$Name-update-preferences.json"
    $env:PORTCOVE_APPLICATION_RUNTIME_LOCK = Join-Path $root "$Name-runtime.lock"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root "$Name-webview"
}
Set-CrawlProfile 'crawl-signed'
function Invoke-Cli([string[]]$Command) {
    $json = & $cli --library $env:PORTCOVE_LIBRARY --json --non-interactive @Command
    $cliExit = $LASTEXITCODE
    @{ exit=$cliExit; receipt=($json | ConvertFrom-Json) }
}
function Read-Cli([string[]]$Command) {
    $result = Invoke-Cli $Command
    if ($result.exit -ne 0 -or -not $result.receipt.ok) {
        throw "Published CLI operation failed ($($Command[0]))"
    }
    $result.receipt.data
}
if ((Read-Cli @('about')).version -cne $version) { throw 'Published CLI About version differs' }
$embedded = Read-Cli @('catalog','show',$port)
if ($embedded.id -cne $port -or $embedded.adapter -cne 'native-portable' -or
    $embedded.release.repository -cne 'crawl/crawl' -or 'windows-x86-64' -cnotin $embedded.platforms) {
    throw 'Ordinary embedded Crawl Windows route differs'
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
$index = 'dc0f562b37b80767baeed3ad5a575a9a1d1a34f06641df0a8d0ebcc0dbcd91a6'
$projection = 'ff36ac51cacb397fa1d006fecc1223fb1d2ba7b47ee9a611bf7a119a0ef7f90f'
function Read-PublicSignedSnapshot([string]$Label) {
    function Save-PublicMetadata([string]$Url, [string]$Name) {
        $path = Join-Path $root "$Label-$Name"
        & curl.exe -fsSL --proto '=https' --proto-redir '=https' --max-time 20 --max-filesize 1048576 --output $path $Url
        if ($LASTEXITCODE -ne 0) { throw "Could not read public Crawl metadata $Name" }
        $path
    }
    function Read-BoundJson([string]$Path, $Target) {
        Assert-File $Path $Target.length $Target.hashes.sha256
        Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    $timestamp = Save-PublicMetadata "$pages/metadata/timestamp.json" 'timestamp.json'
    $timestampHash = (Get-FileHash -LiteralPath $timestamp -Algorithm SHA256).Hash.ToLowerInvariant()
    $snapshotEntry = (Get-Content -LiteralPath $timestamp -Raw | ConvertFrom-Json).signed.meta.'snapshot.json'
    if ([int]$snapshotEntry.version -le 0) { throw 'Public snapshot version is absent' }
    $snapshot = Read-BoundJson (Save-PublicMetadata "$pages/metadata/$($snapshotEntry.version).snapshot.json" 'snapshot.json') $snapshotEntry
    $definitionsEntry = $snapshot.signed.meta.'official-definitions.json'
    if ([int]$definitionsEntry.version -le 0) { throw 'Public definition role version is absent' }
    $definitions = Read-BoundJson (Save-PublicMetadata "$pages/metadata/$($definitionsEntry.version).official-definitions.json" 'definitions.json') $definitionsEntry
    $indexEntry = $definitions.signed.targets.'definitions/index.json'
    $contractEntry = $definitions.signed.targets."sha256/$projection.json"
    if ($indexEntry.hashes.sha256 -cne $index -or $contractEntry.hashes.sha256 -cne $projection) {
        throw 'Current public roles do not name the reviewed Crawl revision 3 index and contract'
    }
    $null = Read-BoundJson (Save-PublicMetadata "$pages/targets/$index.definitions/index.json" 'index.json') $indexEntry
    $contract = Read-BoundJson (Save-PublicMetadata "$pages/targets/$projection.sha256/$projection.json" 'contract.json') $contractEntry
    if ($contract.representation -cne 'catalog_projection' -or $contract.catalog.schema_version -ne 2) {
        throw 'The exact signed Crawl contract has a different projection schema'
    }
    $timestampHash
}
$before = Read-PublicSignedSnapshot 'before'
$refresh = Invoke-Cli @('catalog','definition-refresh',$port,'--metadata-base-url',"$pages/metadata",'--targets-base-url',"$pages/targets")
$after = Read-PublicSignedSnapshot 'after'
if ($after -cne $before) { throw 'Public signed snapshot changed during the isolated refresh' }
if ($refresh.exit -eq 0 -and $refresh.receipt.ok) {
    $choice = $refresh.receipt.data.selection.selected
    if ($refresh.receipt.data.disposition -cne 'selected' -or $choice.stable_id -cne $port -or
        $choice.definition_revision -ne 3 -or $choice.provenance.index_sha256 -cne $index -or
        $choice.provenance.root_version -ne 1 -or $choice.provenance.root_sha256 -cne $rootDigest) {
        throw 'Authenticated Crawl refresh selected a different subject'
    }
    $signedOutcome = 'selected'
    $sameLibraryPlan = 'not-requested'
} else {
    $refreshError = $refresh.receipt.error
    if ($refresh.exit -ne 11 -or $refresh.receipt.ok -or $refreshError.code -cne 'verification' -or
        $refreshError.details.definition_refresh_phase -cne 'selection' -or
        $refreshError.details.definition_policy_changed -cne 'true' -or
        $refreshError.details.definition_launch_assessment_changed -cne 'true' -or
        $refreshError.message -cne 'selected definition changes catalog state outside its scope: catalog schema changed') {
        throw 'The isolated signed Crawl refresh failed at an unexpected boundary'
    }
    $readback = Read-Cli @('catalog','show',$port)
    if (($readback | ConvertTo-Json -Depth 40 -Compress) -cne ($embedded | ConvertTo-Json -Depth 40 -Compress) -or
        $null -ne (Read-Cli @('status',$port)).active) {
        throw 'Scoped selection refusal changed the ordinary embedded Crawl route or install state'
    }
    $restricted = Invoke-Cli @('installation','plan',$port)
    if ($restricted.exit -ne 3 -or $restricted.receipt.ok -or
        $restricted.receipt.error.code -cne 'unsupported' -or
        $restricted.receipt.error.message -cne 'restricted acquisition requires its exact selected definition') {
        throw 'The signed-policy library did not retain the exact restricted acquisition refusal'
    }
    $signedOutcome = 'verified-revision-refused-at-legacy-schema-transition'
    $sameLibraryPlan = 'restricted-acquisition-refused'
}
Write-Receipt 'signed-crawl-revision' @{ revision=3; catalog_schema=2; index_sha256=$index
    contract_sha256=$projection; timestamp_sha256=$before; outcome=$signedOutcome
    same_library_plan=$sameLibraryPlan }

# Independent stock Desktop journey before any explicit policy refresh. Keep
# it separate from the library that retained the authenticated restriction.
Set-CrawlProfile 'crawl-embedded'
if ($null -ne (Read-Cli @('status',$port)).active) { throw 'Expected a fresh embedded library' }
$plan = Read-Cli @('installation','plan',$port)
if ($null -ne $plan.selected_install -or $plan.plan.port_id -cne $port -or
    $plan.plan.platform -cne 'windows-x86-64' -or $plan.plan.channel -cne 'stable' -or
    @($plan.plan.source_requirements).Count -ne 0 -or $plan.plan.release.version -cne '0.34.1' -or
    $plan.plan.release.asset.url -cne 'https://github.com/crawl/crawl/releases/download/0.34.1/dcss-0.34.1-win32-tiles.zip' -or
    $plan.plan.release.asset.name -cne 'dcss-0.34.1-win32-tiles.zip' -or
    $plan.plan.release.asset.size -ne 26551751 -or $plan.plan.release.asset.sha256 -cne $asset -or
    $plan.plan_sha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Ordinary embedded Crawl installation identity differs'
}
Write-Receipt 'embedded-plan' @{ port_id=$port; package_sha256=$asset; plan_sha256=$plan.plan_sha256
    source='stock embedded catalog before explicit policy refresh'; version='0.34.1' }

# This independent cell observes the exact package-extracted executable.
# Use its normal accessibility tree and real managed installation controls.
$app = $desktop
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
. (Join-Path $sourceRoot 'apps/desktop/scripts/native-window-discovery.ps1')
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
        if (-not [PortcoveNativeWindows]::IsOwnedWindow($handle, $process.Id)) {
            throw 'Win32 top-level HWND does not belong to the held Desktop process'
        }
        $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $runtimeModal = $window.Current.ClassName -ceq '#32770' -and
            [PortcoveNativeWindows]::Matches($handle, $process.Id, 'Portcove runtime required')
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
        if (-not [PortcoveNativeWindows]::IsOwnedWindow($handle, $process.Id)) {
            throw 'Win32 HWND ownership changed during startup observation'
        }
        @{ hwnd=$handle; element=$window }
    }
    function Read-Controls([string]$Name, [switch]$Invokable) {
        $owned = Read-OwnedWindow
        if ($null -eq $owned) { return }
        $nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
        foreach ($control in $owned.element.FindAll([Windows.Automation.TreeScope]::Descendants, $nameCondition)) {
            if ($control.Current.IsOffscreen -or $control.Current.BoundingRectangle.IsEmpty) { continue }
            if ($Invokable) {
                $pattern = $null
                if (-not $control.Current.IsEnabled) { continue }
                if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                    @{ hwnd=$owned.hwnd; pattern=$pattern }
                } elseif ($control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                    @{ hwnd=$owned.hwnd; pattern=$pattern }
                }
            } else { @{ hwnd=$owned.hwnd; element=$control } }
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
        $selected = Wait-Control $Name -Invokable
        # The accessibility provider may be a WebView child. Require the exact
        # app-owned native boundary immediately before invoking a scoped control.
        $owned = Read-OwnedWindow
        if (-not $owned -or $owned.hwnd -ne $selected.hwnd) { throw 'Native HWND changed before control invocation' }
        if ($selected.pattern -is [Windows.Automation.SelectionItemPattern]) { $selected.pattern.Select() }
        else { $selected.pattern.Invoke() }
    }
    Select-Control 'Discover'
    $search = Wait-Control 'Search Discover'
    $native = Read-OwnedWindow
    $valuePattern = $null
    if (-not $native -or $native.hwnd -ne $search.hwnd -or
        -not $search.element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -or
        $valuePattern.Current.IsReadOnly) { throw 'Owned Discover search control is not writable' }
    $valuePattern.SetValue('Dungeon Crawl Stone Soup')
    Select-Control "Linley's Dungeon Crawl Dungeon Crawl Stone Soup. Setup available. View port"
    # The detail hero starts the normal managed review for a source-free port.
    $separator = [char]0x00b7
    $reviewAction = "Install: Linley's Dungeon Crawl $separator Dungeon Crawl Stone Soup"
    $approveAction = "Install $separator 25.3 MiB"
    Select-Control $reviewAction
    $null = Wait-Control '0.34.1'
    $null = Wait-Control $approveAction -Invokable
    Write-Receipt 'desktop-install-review' @{ action=$reviewAction; version='0.34.1'; download_bytes=26551751 }
    Select-Control $approveAction

    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $null = Read-OwnedWindow
        $active = (Read-Cli @('status',$port)).active
        if ($active) { break }
        Start-Sleep -Milliseconds 600
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $active -or $active.version -cne '0.34.1' -or $active.artifact.sha256 -cne $asset) {
        throw 'Ordinary Desktop install did not activate the exact reviewed artifact'
    }
    $verified = Read-Cli @('verify',$port)
    if ($verified.install_id -cne $active.id -or -not $verified.valid -or $verified.checked_files -ne 690) {
        throw 'Desktop-installed Crawl package failed independent published CLI verification'
    }
    Write-Receipt 'desktop-acquisition' @{ install_id=$active.id; source='stock embedded catalog before explicit policy refresh'
        package_sha256=$asset; verified_files=$verified.checked_files; version=$active.version }

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
        library='fresh stock embedded setup before explicit policy refresh'; install_id=$active.id; game='Dungeon Crawl Stone Soup'; action='Manage'
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
        if (-not $process.HasExited -and $process.StartTime.ToUniversalTime() -eq $created -and
            $process.Path -eq $app -and [PortcoveNativeWindows]::IsOwnedWindow($process.MainWindowHandle, $process.Id)) {
            $closed = $process.CloseMainWindow() -and $process.WaitForExit(10000)
            if ($closed) { $exitCode = $process.ExitCode }
        }
        $runtime = $null
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
        if (-not $observedFailure) {
            if (-not $closed -or $exitCode -ne 0 -or @($webviewExit | Where-Object { -not $_.exited }).Count -gt 0) {
                throw 'Normal closure of the owned Desktop process was not proved'
            }
            if (-not $runtime -or $runtime.result -cne 'runtime-selected' -or [version]$runtime.selected -lt [version]$minimum) {
                throw 'Packaged Desktop selected WebView2 at or above the reviewed floor was not observed'
            }
        }
    } finally {
        foreach ($browser in $browserProcesses) { $browser.Dispose() }
        $process.Dispose()
    }
}
Write-Receipt 'completed' @{ scope='authenticated package-extracted executable, ordinary embedded Desktop acquisition and management'
    limits='signed-policy library observes selection and restriction only; stock native scope excludes gameplay, next-artifact transition and minimum Windows' }
