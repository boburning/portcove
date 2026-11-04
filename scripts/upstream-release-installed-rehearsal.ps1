param([switch]$PublicConsumerOnly)
# Both modes use public outputs. The HTTPS consumer creates no local feed and
# never substitutes a local payload for the ordinary downloader.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" }
}
$public = Join-Path $root 'work/upstream-signed'
$description = & node scripts/upstream-release-rehearsal.mts inspect $public
if ($LASTEXITCODE -ne 0) { throw 'Original signed fixture identity refused' }
$origin = $description | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $public 'rehearsal.json') -Raw | ConvertFrom-Json
$candidate = Join-Path $public "Portcove_$($manifest.version)_x64-setup.exe"
$config = Get-Content apps/desktop/src-tauri/tauri.native-compatibility.conf.json -Raw | ConvertFrom-Json -AsHashtable
$config.bundle = @{ createUpdaterArtifacts = $false; windows = @{ nsis = @{ installMode = 'currentUser' } } }
$configPath = Join-Path $root 'work/upstream-predecessor.conf.json'
if ($PublicConsumerOnly) {
    if (Test-Path -LiteralPath (Join-Path $root 'work/upstream-public-feed')) { throw 'HTTPS consumer must not have an unpacked local feed' }
    foreach ($name in @('PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD', 'PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE', 'PORTCOVE_APPLICATION_UPDATE_METADATA_URL', 'PORTCOVE_APPLICATION_UPDATE_TARGETS_URL', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
        if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw "HTTPS consumer inherited forbidden authority or fixture substitution: $name" }
    }
    $previous = $origin.public_predecessor
    $predecessor = Join-Path $root "work/upstream-public-predecessor/Portcove_$($previous)_x64-setup.exe"
    $predecessorReport = Get-Content (Join-Path $root 'work/upstream-public-predecessor/public-predecessor.json') -Raw | ConvertFrom-Json
    if ($predecessorReport.public_base -cne $origin.public_base -or $predecessorReport.version -cne $previous -or
        (Get-FileHash $predecessor -Algorithm SHA256).Hash.ToLowerInvariant() -cne $predecessorReport.installer.sha256) { throw 'Verified public predecessor changed before installation' }
    $evidence = Join-Path $root 'work/upstream-public-installed-evidence'
} else {
    Invoke-Checked 'node' @('scripts/upstream-release-rehearsal.mts', 'prepare-predecessor', $public)
    $previous = $origin.predecessor
    $feed = Join-Path $root 'work/upstream-public-feed'
    $metadata = Join-Path $feed 'metadata'
    $targets = Join-Path $feed 'targets'
    $env:PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE = Join-Path $public 'trusted-root.json'
    $env:PORTCOVE_APPLICATION_UPDATE_METADATA_URL = ([Uri]::new($metadata.TrimEnd('/', '\') + '/')).AbsoluteUri
    $env:PORTCOVE_APPLICATION_UPDATE_TARGETS_URL = ([Uri]::new($targets.TrimEnd('/', '\') + '/')).AbsoluteUri
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30))
    Invoke-Checked 'pnpm' @('--dir', 'apps/desktop', 'tauri', 'build', '--ci', '--bundles', 'nsis', '--config', $configPath, '--features', 'application-update-qualification,native-compatibility-qualification')
    $predecessor = Join-Path $root "target/release/bundle/nsis/Portcove_$($previous)_x64-setup.exe"
    $evidence = Join-Path $root 'work/upstream-installed-evidence'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$env:PORTCOVE_PREFERENCES = Join-Path $evidence 'preferences.json'
[IO.File]::WriteAllText($env:PORTCOVE_PREFERENCES, '{"format_version":1,"library_root":null,"qualification_marker":"upstream-release-rehearsal"}')
$before = (Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash
$arguments = @{
    InstallerPath = $candidate; UpgradeFromInstallerPath = $predecessor
    ExpectedExecutablePath = (Join-Path $root 'work/upstream-candidate-executable/portcove-desktop.exe')
    TestBase = (Join-Path $evidence 'lifecycle'); EvidencePath = (Join-Path $evidence 'installed.json')
    InstallMode = 'Passive'; ExpectedVersion = $manifest.version
    PayloadPrivateKeyPath = (Join-Path $evidence 'absent-payload.key'); TufPrivateRootPath = (Join-Path $evidence 'absent-tuf-private')
    RequireSigningAuthorityAbsent = $true; InstalledUpdateTrustedRootPath = (Join-Path $public 'trusted-root.json')
    InstalledUpdateCandidatePath = $candidate; InstalledUpdatePredecessorVersion = $previous
    RendererUpdate = $true; RendererTransport = 'embedded'; VerifyStableWaiting = $true
}
if ($PublicConsumerOnly) { $arguments.ControlledPublicUpdate = $true }
else { $arguments.InstalledUpdateMetadataPath = $metadata; $arguments.InstalledUpdateTargetsPath = $targets }
& ./scripts/test-windows-installer.ps1 @arguments
if ($LASTEXITCODE -ne 0) { throw 'Installed updater fixture refused' }
if ((Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash -cne $before) { throw 'Isolated host preferences changed' }
Copy-Item (Join-Path $evidence 'windows-renderer-evidence/renderer-update-evidence.json') (Join-Path $evidence 'renderer-update-evidence.json')
[ordered]@{
    scope = $(if ($PublicConsumerOnly) { 'disposable-public-installed-fixture' } else { 'disposable-installed-fixture' })
    source = $origin.source; run_id = $origin.run_id; original_attempt = $origin.run_attempt; attempt = $origin.executor_attempt
    executor = $origin.executor
    candidate_version = $manifest.version; predecessor_version = $previous
    signed_manifest_sha256 = (Get-FileHash (Join-Path $public 'rehearsal.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    private_authority_transferred = $false
    metadata_transport = $(if ($PublicConsumerOnly) { 'compiled-https-and-normal-github-payload' } else { 'local-public-fixture' })
    production = $false
} | ConvertTo-Json | Set-Content (Join-Path $evidence 'summary.json') -Encoding utf8NoBOM
if (-not $PublicConsumerOnly) {
    # This distinct fixture version uses the compiled HTTPS provider. The
    # published candidate is never rebuilt for the public consumer.
    Invoke-Checked 'node' @('scripts/upstream-release-rehearsal.mts', 'prepare-public-predecessor', $public)
    $env:PORTCOVE_APPLICATION_UPDATE_METADATA_URL = $origin.public_base + 'metadata/'
    $env:PORTCOVE_APPLICATION_UPDATE_TARGETS_URL = $origin.public_base + 'targets/'
    Invoke-Checked 'pnpm' @('--dir', 'apps/desktop', 'tauri', 'build', '--ci', '--bundles', 'nsis', '--config', $configPath, '--features', 'application-update-qualification,native-compatibility-qualification')
    Invoke-Checked 'node' @('scripts/upstream-release-acceptance.mts', 'write-public-predecessor', (Join-Path $root 'work/upstream-public-predecessor'), $public)
    $emptyCheck = & cargo run --locked --release --quiet -p portcove-desktop --example prepare_installed_update -- check-empty-https $origin.public_predecessor (Join-Path $public 'trusted-root.json') ($origin.public_base + 'metadata/') ($origin.public_base + 'targets/') (Join-Path $evidence 'empty-https-trust')
    if ($LASTEXITCODE -ne 0) { throw 'Actual host consumer refused the empty public HTTPS baseline' }
    $summaryPath = Join-Path $evidence 'summary.json'
    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json -AsHashtable
    $summary.empty_https_feed = $emptyCheck | ConvertFrom-Json -AsHashtable
    $summary | ConvertTo-Json -Depth 10 | Set-Content $summaryPath -Encoding utf8NoBOM
    Invoke-Checked 'node' @('scripts/upstream-release-acceptance.mts', 'write', $evidence, $public)
}
