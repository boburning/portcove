# Observe the published installer, cold signed Crawl revision, and default Desktop delivery.
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
    $json = @{phase=$Phase; evidence=$Evidence} | ConvertTo-Json -Depth 10 -Compress
    $json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $env:PORTCOVE_OUTPUT_DIR "receipt-$Phase.json")
    $json
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

function Read-ImmutableReleaseMetadata([string]$ReleaseTag, [string]$Token) {
    if ($ReleaseTag -cnotmatch '\Anightly-\d+\.\d+\.\d+-preview\.[1-9]\d*\z' -or
        -not $Token -or $Token.Length -gt 4096 -or $Token -cnotmatch '\A[A-Za-z0-9._~+/-]+=*\z') {
        throw 'Missing or invalid read-only release metadata credential or tag'
    }
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,
        "https://api.github.com/repos/boburning/portcove/releases/tags/$ReleaseTag")
    $response = $null
    try {
        $client.Timeout = [TimeSpan]::FromSeconds(45)
        $client.MaxResponseContentBufferSize = 1MB
        $request.Headers.Accept.ParseAdd('application/vnd.github+json')
        $request.Headers.UserAgent.ParseAdd('portcove-native-release-witness/1')
        $request.Headers.Add('X-GitHub-Api-Version', '2022-11-28')
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        Write-Host "Release metadata HTTP $status"
        if ($status -ne 200) { throw "Could not read the immutable public release (HTTP $status)" }
        $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    } finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
    }
}

if ($Observation -ceq 'binding') {
    try {
        $publication = Read-ImmutableReleaseMetadata $tag $env:GH_TOKEN
    } finally {
        Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    }
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
function Approve-ColdDefinitionAuthority {
    $authority = Read-Cli @('catalog','definition-authority')
    if (-not $authority.configured -or $authority.installed -or
        $authority.compiled_anchor_sha256 -cne $anchor -or $authority.expected_plan -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Fresh CLI library or compiled definition anchor differs'
    }
    $approved = Read-Cli @('catalog','definition-authority','--apply','--expected-plan',$authority.expected_plan,'--yes')
    if (-not $approved.changed -or -not $approved.review.installed -or $approved.review.installed_anchor_sha256 -cne $anchor) {
        throw 'Exact ordinary definition authority provisioning did not complete'
    }
}
Approve-ColdDefinitionAuthority

$pages = 'https://boburning.github.io/portcove/catalog'
$index = '59329fae59cb0018a24a3e6197ac8ea66ff17e775d858e5c6af7cb9b43c2e425'
$chameleon = 'chameleon-twist-jp-recompiled'
$dude = 'doom-3-classic-dude-doom-3-unified-development-engine'
$dudeEntry = 'e81559f432ab1e1a8089514ed742b62ac5da72929d324d8b1b2064c4fce91a28'
$dudeProjection = 'f0c4730cd5e10aa969d32c8923faaea87a28a4d73d2e1c1002c5bc2ef17636c0'
$crawlEntry = '43ccf30580b9d027274992278e4b2440707f4278db59ea7e929574af3fb27c60'
$chameleonEntry = '7094da5e80069bcd2ce69c6a6ac31027fce2e6d24172e0c21712ecfd4c8ef6b4'
$chameleonProjection = 'beaf84046b4bcbda4cf4ba79246faa688f643e134f35bd4a7cbfa38101624e8d'
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
    $indexDocument = Read-BoundJson (Save-PublicMetadata "$pages/targets/$index.definitions/index.json" 'index.json') $indexEntry
    foreach ($subject in @(
        @{ id=$port; revision=3; digest=$crawlEntry; projection=$projection },
        @{ id=$dude; revision=1; digest=$dudeEntry; projection=$dudeProjection },
        @{ id=$chameleon; revision=1; digest=$chameleonEntry; projection=$chameleonProjection }
    )) {
        $target = "sha256/$($subject.digest).json"
        $rows = @($indexDocument.definitions | Where-Object { $_.namespace -ceq 'official' -and $_.stable_id -ceq $subject.id })
        if ($rows.Count -ne 1 -or $rows[0].revision -ne $subject.revision -or $rows[0].target -cne $target) {
            throw "Public index does not contain the reviewed definition for $($subject.id)"
        }
        $entryPin = $definitions.signed.targets.PSObject.Properties[$target].Value
        if ($entryPin.hashes.sha256 -cne $subject.digest) { throw 'Public definition entry identity differs' }
        $entry = Read-BoundJson (Save-PublicMetadata "$pages/targets/$($subject.digest).$target" "$($subject.id)-entry.json") $entryPin
        if ($entry.stable_id -cne $subject.id -or $entry.revision -ne $subject.revision -or
            $entry.execution_contract -cne "sha256/$($subject.projection).json") { throw 'Public definition entry relationship differs' }
    }
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
if ($refresh.exit -ne 0 -or -not $refresh.receipt.ok) { throw 'Cold signed Crawl refresh failed' }
$choice = $refresh.receipt.data.selection.selected
if ($refresh.receipt.data.disposition -cne 'selected' -or $choice.stable_id -cne $port -or
    $choice.definition_revision -ne 3 -or $choice.provenance.index_sha256 -cne $index -or
    $choice.provenance.root_version -ne 1 -or $choice.provenance.root_sha256 -cne $rootDigest) {
    throw 'Authenticated Crawl refresh selected a different subject'
}
Write-Receipt 'signed-crawl-revision' @{ revision=3; catalog_schema=2; index_sha256=$index
    contract_sha256=$projection; timestamp_sha256=$before; outcome='selected-in-cold-cli-library' }

# The Chameleon publisher identity is explicitly addressable. The historical
# directory listing uses a different ID, so this is its own cold CLI witness.
Set-CrawlProfile 'chameleon-explicit'
Approve-ColdDefinitionAuthority
$chameleonBefore = Read-PublicSignedSnapshot 'chameleon-before'
$chameleonRefresh = Read-Cli @('catalog','definition-refresh',$chameleon,'--metadata-base-url',"$pages/metadata",'--targets-base-url',"$pages/targets")
if ((Read-PublicSignedSnapshot 'chameleon-after') -cne $chameleonBefore) {
    throw 'Public signed snapshot changed during explicit Chameleon refresh'
}
$chameleonChoice = $chameleonRefresh.selection.selected
if ($chameleonRefresh.disposition -cne 'selected' -or $chameleonChoice.stable_id -cne $chameleon -or
    $chameleonChoice.definition_revision -ne 1 -or $chameleonChoice.provenance.index_sha256 -cne $index -or
    $chameleonChoice.provenance.root_version -ne 1 -or $chameleonChoice.provenance.root_sha256 -cne $rootDigest) {
    throw 'Authenticated Chameleon refresh selected a different subject'
}
$chameleonPlan = Read-Cli @('installation','plan',$chameleon)
$originals = @($chameleonPlan.plan.source_requirements)
if ($null -ne $chameleonPlan.selected_install -or $chameleonPlan.plan.port_id -cne $chameleon -or
    $chameleonPlan.plan.release.version -cne 'v0.1' -or $chameleonPlan.plan.release.asset.size -ne 23929489 -or
    $chameleonPlan.plan.release.asset.sha256 -cne '8e705d3826ab413afac92ea753d7f11dbc93be9ea507a3ef86bb6003019b5c56' -or
    $originals.Count -ne 1 -or $originals[0].profile_id -cne 'chameleon-twist-jp' -or $originals[0].registered) {
    throw 'Explicit Chameleon install plan or private original boundary differs'
}
Write-Receipt 'explicit-chameleon-without-original' @{ revision=1; index_sha256=$index
    contract_sha256=$chameleonProjection; timestamp_sha256=$chameleonBefore; planned_release='v0.1'
    package_sha256=$chameleonPlan.plan.release.asset.sha256; original_required=$true; acquisition_attempted=$false }

# Desktop owns both scheduled selections in a different untouched library.
Set-CrawlProfile 'desktop-automatic'
foreach ($profilePath in @($env:PORTCOVE_LIBRARY,$env:PORTCOVE_PREFERENCES,$env:WEBVIEW2_USER_DATA_FOLDER)) {
    if (Test-Path -LiteralPath $profilePath) { throw 'Expected a private fresh Desktop profile' }
}
$desktopBefore = Read-PublicSignedSnapshot 'desktop-before'
function Assert-CrawlPlan($Plan) {
    if ($null -ne $plan.selected_install -or $plan.plan.port_id -cne $port -or
        $plan.plan.platform -cne 'windows-x86-64' -or $plan.plan.channel -cne 'stable' -or
        @($plan.plan.source_requirements).Count -ne 0 -or $plan.plan.release.version -cne '0.34.1' -or
        $plan.plan.release.asset.url -cne 'https://github.com/crawl/crawl/releases/download/0.34.1/dcss-0.34.1-win32-tiles.zip' -or
        $plan.plan.release.asset.name -cne 'dcss-0.34.1-win32-tiles.zip' -or
        $plan.plan.release.asset.size -ne 26551751 -or $plan.plan.release.asset.sha256 -cne $asset -or
        $plan.plan_sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Ordinary Crawl installation identity differs'
    }
}

function Wait-AutomaticDefinitions {
    $database = Join-Path $env:PORTCOVE_LIBRARY 'portcove.sqlite3'
    $probe = Join-Path $PSScriptRoot 'read-published-definition-witness.py'
    $until = [DateTime]::UtcNow.AddSeconds(180)
    do {
        $null = Read-OwnedWindow
        if (Test-Path -LiteralPath $database -PathType Leaf) {
            $rows = & python.exe $probe $database $index $rootDigest
            if ($LASTEXITCODE -eq 0) { return ($rows | ConvertFrom-Json) }
            if ($LASTEXITCODE -ne 3) { throw 'Unexpected persisted definition admission evidence' }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $until)
    throw 'Default Desktop startup did not retain both authenticated subjects within 180 seconds'
}

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
    $selected = @(Wait-AutomaticDefinitions)
    if ((Read-PublicSignedSnapshot 'desktop-after') -cne $desktopBefore) {
        throw 'Public signed snapshot changed during default Desktop pickup'
    }
    $current = Read-Cli @('catalog','export')
    $currentCrawl = @($current.ports | Where-Object { $_.id -ceq $port })
    $currentDude = @($current.ports | Where-Object { $_.id -ceq $dude })
    if ($currentCrawl.Count -ne 1 -or $currentDude.Count -ne 1 -or
        $currentCrawl[0].release.repository -cne 'crawl/crawl' -or
        $currentCrawl[0].reviewed_package_layouts.PSObject.Properties['windows-x86-64'].Value.executables -cnotcontains 'crawl.exe' -or
        $currentDude[0].release.repository -cne 'Inkub0/dude' -or
        -not $currentDude[0].reviewed_package_layouts.PSObject.Properties['linux-x86-64'].Value.classify_linux_programs_by_format) {
        throw 'Stored automatic selections did not compose both effective scoped definitions'
    }
    if ($null -ne (Read-Cli @('status',$port)).active) { throw 'Unexpected pre-existing Crawl install' }
    $plan = Read-Cli @('installation','plan',$port)
    Assert-CrawlPlan $plan
    $automatic = @{ definitions=$selected; default_desktop=$true; timestamp_sha256=$desktopBefore
        effective_subjects=@($port,$dude); crawl_plan_sha256=$plan.plan_sha256 }
    Write-Receipt 'automatic-definitions' $automatic

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
    $stillSelected = @(Wait-AutomaticDefinitions)
    Write-Receipt 'desktop-acquisition' @{ install_id=$active.id; source='default automatic official definition selection'
        package_sha256=$asset; verified_files=$verified.checked_files; version=$active.version; definitions=$stillSelected }

    Select-Control 'Manage'
    $null = Wait-Control 'Managed installation'
    Write-Receipt 'desktop-manage-tab' @{ install_id=$active.id; heading='Managed installation' }
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
        library='fresh Desktop library with two automatic definition selections'; install_id=$active.id; game='Dungeon Crawl Stone Soup'; action='Manage'
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
Write-Receipt 'completed' @{ scope='authenticated package-extracted executable, cold CLI Crawl and default Desktop two-subject pickup, Crawl acquisition and management'
    limits='Chameleon explicit definition and plan only; no DUDE acquisition; Crawl native scope excludes gameplay, next-artifact transition and minimum Windows' }
