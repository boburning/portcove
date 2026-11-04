# Actual installed Windows fixture, using only public outputs of the isolated signer.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" }
}
$public = Join-Path $root 'work/upstream-signed'
Invoke-Checked 'node' @('scripts/upstream-release-rehearsal.mts', 'prepare-predecessor', $public)
$manifest = Get-Content -LiteralPath (Join-Path $public 'rehearsal.json') -Raw | ConvertFrom-Json
$previous = '0.0.0-rehearsal.0'
$candidate = Join-Path $public "Portcove_$($manifest.version)_x64-setup.exe"
$feed = Join-Path $root 'work/upstream-public-feed'
$metadata = Join-Path $feed 'metadata'
$targets = Join-Path $feed 'targets'
$env:PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE = Join-Path $public 'trusted-root.json'
$env:PORTCOVE_APPLICATION_UPDATE_METADATA_URL = ([Uri]::new($metadata.TrimEnd('/', '\') + '/')).AbsoluteUri
$env:PORTCOVE_APPLICATION_UPDATE_TARGETS_URL = ([Uri]::new($targets.TrimEnd('/', '\') + '/')).AbsoluteUri
$config = Get-Content apps/desktop/src-tauri/tauri.native-compatibility.conf.json -Raw | ConvertFrom-Json -AsHashtable
$config.bundle = @{ createUpdaterArtifacts = $false; windows = @{ nsis = @{ installMode = 'currentUser' } } }
$configPath = Join-Path $root 'work/upstream-predecessor.conf.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30))
Invoke-Checked 'pnpm' @('--dir', 'apps/desktop', 'tauri', 'build', '--ci', '--bundles', 'nsis', '--config', $configPath, '--features', 'application-update-qualification,native-compatibility-qualification')
$predecessor = Join-Path $root "target/release/bundle/nsis/Portcove_$($previous)_x64-setup.exe"
$evidence = Join-Path $root 'work/upstream-installed-evidence'
New-Item -ItemType Directory -Path $evidence | Out-Null
$env:PORTCOVE_PREFERENCES = Join-Path $evidence 'preferences.json'
[IO.File]::WriteAllText($env:PORTCOVE_PREFERENCES, '{"format_version":1,"library_root":null,"qualification_marker":"upstream-release-rehearsal"}')
$before = (Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash
# Both absent paths are fresh names in this runner, never producer private artifacts.
& ./scripts/test-windows-installer.ps1 -InstallerPath $candidate -UpgradeFromInstallerPath $predecessor -ExpectedExecutablePath (Join-Path $root 'work/upstream-candidate-executable/portcove-desktop.exe') -TestBase (Join-Path $evidence 'lifecycle') -EvidencePath (Join-Path $evidence 'installed.json') -InstallMode Passive -ExpectedVersion $manifest.version -PayloadPrivateKeyPath (Join-Path $evidence 'absent-payload.key') -TufPrivateRootPath (Join-Path $evidence 'absent-tuf-private') -RequireSigningAuthorityAbsent -InstalledUpdateTrustedRootPath $env:PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE -InstalledUpdateMetadataPath $metadata -InstalledUpdateTargetsPath $targets -InstalledUpdateCandidatePath $candidate -InstalledUpdatePredecessorVersion $previous -RendererUpdate -RendererTransport embedded -VerifyStableWaiting
if ($LASTEXITCODE -ne 0) { throw 'Installed updater fixture refused' }
if ((Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash -cne $before) { throw 'Isolated host preferences changed' }
[ordered]@{ scope = 'disposable-installed-fixture'; source = $env:GITHUB_SHA; run_id = $env:GITHUB_RUN_ID; attempt = [int]$env:GITHUB_RUN_ATTEMPT; candidate_version = $manifest.version; predecessor_version = $previous; signed_manifest_sha256 = (Get-FileHash (Join-Path $public 'rehearsal.json') -Algorithm SHA256).Hash.ToLowerInvariant(); private_authority_transferred = $false; metadata_transport = 'local-public-fixture'; production = $false } | ConvertTo-Json | Set-Content (Join-Path $evidence 'summary.json') -Encoding utf8NoBOM
