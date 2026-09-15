param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows-x86_64", "linux-x86_64", "macos-x86_64", "macos-aarch64")]
    [string]$PlatformLabel,
    [ValidateSet("legacy-skipped", "preview-final")]
    [string]$TransitionProfile = "legacy-skipped",
    [switch]$DescribeTransition
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $root
if ($TransitionProfile -eq "preview-final" -and $PlatformLabel -notin @("windows-x86_64", "linux-x86_64")) {
    $message = "The preview-final packaged transition is currently qualified only for windows-x86_64 and linux-x86_64"
    [Console]::Error.WriteLine($message)
    throw $message
}
$transition = [ordered]@{
    profile = $TransitionProfile
    platform = $PlatformLabel
    predecessor_version = if ($TransitionProfile -eq "preview-final") { "1.0.0-rc.2" } else { "0.1.0" }
    candidate_version = if ($TransitionProfile -eq "preview-final") { "1.0.0" } else { "0.3.0" }
    candidate_production_eligible = $TransitionProfile -eq "preview-final"
}
if ($DescribeTransition) {
    $transition | ConvertTo-Json -Compress
    exit 0
}
$predecessorVersion = $transition.predecessor_version
$candidateVersion = $transition.candidate_version
$candidateProductionEligible = $transition.candidate_production_eligible
$fixtureVersions = @($predecessorVersion, $candidateVersion)
$pnpmSpec = (Get-Content (Join-Path $root "apps/desktop/package.json") -Raw | ConvertFrom-Json).packageManager
if ($pnpmSpec -notmatch '^pnpm@\d+\.\d+\.\d+$') { throw "Desktop packageManager must pin an exact pnpm version" }
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
& git diff --quiet HEAD
if ($LASTEXITCODE -ne 0) { throw "Rehearsal requires a checkout with no tracked changes" }
$revision = (& git rev-parse HEAD | Out-String).Trim()
$runRoot = Join-Path $root "work/updater-rehearsal"
if (Test-Path -LiteralPath $runRoot) { throw "Rehearsal evidence directory must be new" }
New-Item -ItemType Directory -Path $runRoot | Out-Null
$metadataPaths = @("Cargo.toml", "Cargo.lock", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json")
$original = @{}
foreach ($relative in $metadataPaths) { $original[$relative] = [IO.File]::ReadAllBytes((Join-Path $root $relative)) }
$environmentNames = @(
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "CARGO_TARGET_DIR",
    "PORTCOVE_PREFERENCES",
    "WEBVIEW2_USER_DATA_FOLDER",
    "PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE",
    "PORTCOVE_APPLICATION_UPDATE_METADATA_URL",
    "PORTCOVE_APPLICATION_UPDATE_TARGETS_URL"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$privateKey = Join-Path $runRoot "disposable.key"
$publicKey = "$privateKey.pub"
$wrongPrivateRoot = Join-Path $runRoot "windows-payload-consumer-private"
$wrongPassword = $null
$bundleRoot = Join-Path $root "target/release/bundle"
$cliRoot = Join-Path $root "release-assets"
$bundles = if ($IsWindows) { "nsis" } elseif ($IsLinux) { "appimage,deb,rpm" } else { "app,dmg" }
$suffix = if ($IsWindows) { ".exe" } else { "" }
$verifier = Join-Path $root "target/release/portcove-release-tools$suffix"

function Move-RehearsalInput([string]$Source, [string]$Name) {
    # Exact known workspace children only. Preserve prior outputs rather than delete them.
    $resolved = [IO.Path]::GetFullPath($Source)
    if ($resolved -notin @($bundleRoot, $cliRoot)) { throw "Unexpected rehearsal input path" }
    $ancestor = $resolved
    while ($ancestor -and $ancestor -ne $root) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked rehearsal input ancestor" }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    if (Test-Path -LiteralPath $resolved) {
        $item = Get-Item -LiteralPath $resolved -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked rehearsal input" }
        Move-Item -LiteralPath $resolved -Destination (Join-Path $runRoot $Name)
    }
}

function Set-FixtureVersion([string]$Version) {
    $cargo = [Text.Encoding]::UTF8.GetString($original["Cargo.toml"])
    $cargo = [regex]::Replace($cargo, '(?ms)(^\[workspace\.package\]\r?\n(?:(?!^\[).)*?^version\s*=\s*)"[^"]+"', ('$1"' + $Version + '"'))
    [IO.File]::WriteAllText((Join-Path $root "Cargo.toml"), $cargo)
    foreach ($relative in @("apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json")) {
        $data = [Text.Encoding]::UTF8.GetString($original[$relative]) | ConvertFrom-Json
        $data.version = $Version
        [IO.File]::WriteAllText((Join-Path $root $relative), ($data | ConvertTo-Json -Depth 30))
    }
    Invoke-Checked "node" @("scripts/check-release-metadata.mjs")
}

try {
    $env:CARGO_TARGET_DIR = Join-Path $root "target"
    $env:PORTCOVE_PREFERENCES = Join-Path $runRoot "preferences.json"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $runRoot "webview"
    [IO.File]::WriteAllText($env:PORTCOVE_PREFERENCES, '{"format_version":1,"library_root":null,"qualification_marker":"updater-package-rehearsal"}')
    $preferencesHash = (Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash
    # Suppress signer output: only the disposable public key belongs in evidence.
    Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "signer", "generate", "--ci", "--write-keys", $privateKey) | Out-Null
    $env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    $configuration = Get-Content (Join-Path $root "release/tauri.updater.conf.json") -Raw | ConvertFrom-Json -AsHashtable
    $configuration.plugins.updater.pubkey = [IO.File]::ReadAllText($publicKey).Trim()
    $configPath = Join-Path $runRoot "rehearsal-config.json"
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
    Move-RehearsalInput $bundleRoot "previous-bundles"
    Move-RehearsalInput $cliRoot "previous-cli-assets"
    foreach ($version in $fixtureVersions) {
        Set-FixtureVersion $version
        Invoke-Checked "cargo" @("build", "--release", "-p", "portcove-cli", "-p", "portcove-release-tools")
        & (Join-Path $PSScriptRoot "package-cli.ps1") -PlatformLabel $PlatformLabel
        $cliName = (& node scripts/release-package-policy.mjs --platform $PlatformLabel --interface cli --version $version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Cannot select packaged CLI" }
        & (Join-Path $PSScriptRoot "smoke-test-cli-archive.ps1") -ArchivePath (Join-Path $cliRoot $cliName) -PlatformLabel $PlatformLabel -Version $version
        $tauriArguments = @($pnpmSpec, "--dir", "apps/desktop", "tauri", "build", "--bundles", $bundles, "--config", $configPath, "--ci")
        if ($IsLinux) { $tauriArguments += @("--features", "application-update-qualification") }
        Invoke-Checked "corepack" $tauriArguments
        $stage = Join-Path $runRoot "$version-$PlatformLabel"
        Invoke-Checked "node" @("scripts/updater-artifact-inventory.mjs", "stage", "--output", $stage, "--label", $PlatformLabel, "--public-key", $publicKey, "--verifier", $verifier, "--revision", $revision)
        Invoke-Checked "node" @("scripts/updater-artifact-inventory.mjs", "verify", "--input", $stage, "--label", $PlatformLabel, "--public-key", $publicKey, "--verifier", $verifier, "--revision", $revision)
        $native = [ordered]@{ source_commit = $revision; version = $version; platform = $PlatformLabel; signing = "disposable test key" }
        $native.os_version = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        $native.process_architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        if ($IsWindows) {
            $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
            $native.elevated_administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            $installer = Join-Path $stage "Portcove_${version}_x64-setup.exe"
            $native.installer_product_version = (Get-Item -LiteralPath $installer).VersionInfo.ProductVersion
            if ($native.installer_product_version -notin @($version, "$version.0")) { throw "NSIS product version mismatch" }
            if ($version -eq $candidateVersion) {
                $predecessor = Join-Path $runRoot "$predecessorVersion-$PlatformLabel/Portcove_$($predecessorVersion)_x64-setup.exe"
                $candidateInventoryPath = Join-Path $stage "updater-inventory.json"
                $candidateInventory = Get-Content -LiteralPath $candidateInventoryPath -Raw | ConvertFrom-Json
                $consumerRoot = Join-Path $runRoot "windows-payload-consumer"
                $wrongPrivateKey = Join-Path $wrongPrivateRoot "wrong-disposable.key"
                $wrongPassword = [Guid]::NewGuid().ToString("N")
                $wrongCandidate = Join-Path $wrongPrivateRoot $candidateInventory.updater.filename
                $wrongSignatureRoot = Join-Path $consumerRoot "wrong-signature"
                $wrongSignature = Join-Path $wrongSignatureRoot $candidateInventory.updater.signature.filename
                New-Item -ItemType Directory -Path $wrongPrivateRoot, $wrongSignatureRoot | Out-Null
                Copy-Item -LiteralPath $installer -Destination $wrongCandidate
                Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "signer", "generate", "--ci", "--password", $wrongPassword, "--write-keys", $wrongPrivateKey) | Out-Null
                $wrongPublicKey = "$wrongPrivateKey.pub"
                $savedSigningPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY
                $savedSigningPrivateKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
                $savedSigningPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
                try {
                    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
                    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
                    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
                    Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "signer", "sign", "--private-key-path", $wrongPrivateKey, "--password", $wrongPassword, $wrongCandidate) | Out-Null
                } finally {
                    $env:TAURI_SIGNING_PRIVATE_KEY = $savedSigningPrivateKey
                    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $savedSigningPrivateKeyPath
                    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $savedSigningPassword
                    $wrongPassword = $null
                }
                $wrongVerificationText = (& $verifier verify $wrongCandidate "$wrongCandidate.sig" $wrongPublicKey $candidateInventory.updater.sha256 $candidateInventory.updater.bytes | Out-String).Trim()
                if ($LASTEXITCODE -ne 0) { throw "The distinct disposable Windows payload signature did not verify with its own key" }
                $wrongVerification = $wrongVerificationText | ConvertFrom-Json
                if ($wrongVerification.public_key_sha256 -eq $candidateInventory.updater.public_key_sha256) {
                    throw "The wrong-signature control did not use a distinct disposable key"
                }
                Copy-Item -LiteralPath "$wrongCandidate.sig" -Destination $wrongSignature
                Remove-Item -LiteralPath $privateKey -Force
                Remove-Item -LiteralPath $wrongPrivateRoot -Recurse -Force
                Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
                Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
                Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
                $native.private_signing_inputs_absent = [ordered]@{
                    payload_private_key = -not [IO.File]::Exists($privateKey)
                    wrong_payload_private_root = -not [IO.Directory]::Exists($wrongPrivateRoot)
                    wrong_payload_password = $null -eq $wrongPassword
                    signing_private_key_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
                    signing_private_key_path_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PATH", "Process")
                    signing_password_environment = $null -eq [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Process")
                }
                if ($native.private_signing_inputs_absent.Values -contains $false) {
                    throw "Disposable signing authority remained available before Windows consumer execution"
                }
                $consumerCases = [ordered]@{}
                foreach ($consumerCase in @(
                    [ordered]@{ name = "missing-signature"; signature = "-"; expected_outcome = "rejected"; error = "^authenticated update identity is invalid: Tauri signature$" },
                    [ordered]@{ name = "wrong-signature"; signature = $wrongSignature; expected_outcome = "rejected"; error = "signature does not use the selected key or streaming format|payload Minisign signature verification failed" },
                    [ordered]@{ name = "valid-signature"; signature = Join-Path $stage $candidateInventory.updater.signature.filename; expected_outcome = "staged"; error = $null }
                )) {
                    $consumerStaging = Join-Path $consumerRoot "staging-$($consumerCase.name)"
                    $consumerText = (& cargo run --locked --quiet --release -p portcove-desktop --example verify_packaged_application_update -- $consumerCase.name $candidateInventoryPath $installer $consumerCase.signature $publicKey $consumerStaging | Out-String).Trim()
                    if ($LASTEXITCODE -ne 0) { throw "Windows $($consumerCase.name) payload consumer failed" }
                    $consumer = $consumerText | ConvertFrom-Json
                    if ($consumer.outcome -ne $consumerCase.expected_outcome -or
                        $consumer.candidate_version -ne $candidateVersion -or
                        $consumer.candidate_sha256 -ne $candidateInventory.updater.sha256 -or
                        [UInt64]$consumer.candidate_bytes -ne [UInt64]$candidateInventory.updater.bytes -or
                        $consumer.payload_key_id -ne $candidateInventory.updater.public_key_sha256) {
                        throw "Windows $($consumerCase.name) payload consumer returned different candidate evidence"
                    }
                    if ($consumerCase.expected_outcome -eq "rejected") {
                        if ($consumer.staging_has_candidate -or $consumer.error -notmatch $consumerCase.error) {
                            throw "Windows $($consumerCase.name) payload rejection did not fail closed"
                        }
                    } elseif (-not $consumer.staging_has_candidate -or
                        $consumer.staged_payload_sha256 -ne $candidateInventory.updater.sha256 -or
                        [UInt64]$consumer.staged_payload_bytes -ne [UInt64]$candidateInventory.updater.bytes) {
                        throw "Windows valid-signature payload consumer did not stage the exact packaged bytes"
                    }
                    $consumerCases[$consumerCase.name] = $consumer
                    if (Test-Path -LiteralPath $consumerStaging) { Remove-Item -LiteralPath $consumerStaging -Recurse -Force }
                }
                [ordered]@{
                    schema_version = 1
                    source_commit = $revision
                    platform = $PlatformLabel
                    candidate_version = $candidateVersion
                    consumer_boundary = "ApplicationUpdateStagingStore with an inventory-bound synthetic SelectedCandidate; excludes selection, TUF, feed, network, and installer application"
                    production_signing = $false
                    private_signing_inputs_absent = $native.private_signing_inputs_absent
                    wrong_signature_verified_with_distinct_key = $true
                    wrong_public_key_sha256 = $wrongVerification.public_key_sha256
                    cases = $consumerCases
                } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRoot "windows-payload-consumer.json") -Encoding utf8
                & (Join-Path $PSScriptRoot "test-windows-installer.ps1") -InstallerPath $installer -UpgradeFromInstallerPath $predecessor -ExpectedExecutablePath (Join-Path $root "target/release/portcove-desktop.exe") -TestBase (Join-Path $runRoot "installer-test") -EvidencePath (Join-Path $runRoot "windows-passive-upgrade.json") -InstallMode Passive -ExpectedVersion $version -PayloadPrivateKeyPath $privateKey -RequireSigningAuthorityAbsent
                if ((Get-FileHash -LiteralPath $env:PORTCOVE_PREFERENCES -Algorithm SHA256).Hash -ne $preferencesHash) { throw "Installer rehearsal changed isolated host preferences" }
            }
        } elseif ($IsLinux) {
            $native.deb_version = (& dpkg-deb --field (Join-Path $stage "Portcove_${version}_amd64.deb") Version | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $native.deb_version -ne $version) { throw "DEB version mismatch" }
            $native.rpm_version = (& rpm -qp --qf '%{VERSION}-%{RELEASE}' (Join-Path $stage "Portcove-$version-1.x86_64.rpm") | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $native.rpm_version -ne "$version-1") { throw "RPM version mismatch" }
            Invoke-Checked "test" @("-x", (Join-Path $stage "Portcove_${version}_amd64.AppImage"))
            $debExtract = Join-Path $runRoot "$version-deb-extracted"
            Invoke-Checked "dpkg-deb" @("--extract", (Join-Path $stage "Portcove_${version}_amd64.deb"), $debExtract)
            Invoke-Checked "test" @("-x", (Join-Path $debExtract "usr/bin/portcove-desktop"))
            $rpmFiles = (& rpm -qp --dump (Join-Path $stage "Portcove-$version-1.x86_64.rpm") | Out-String)
            if ($LASTEXITCODE -ne 0 -or $rpmFiles -notmatch '(?m)^/usr/bin/portcove-desktop\s+\d+\s+\d+\s+\S+\s+0100755\s') { throw "RPM executable permissions mismatch" }
            $native.executable_permissions_verified = $true
        } else {
            $macExtract = Join-Path $runRoot "$version-mac-extracted"
            New-Item -ItemType Directory -Path $macExtract | Out-Null
            $architecture = $PlatformLabel.Replace("macos-", "")
            Invoke-Checked "tar" @("-xzf", (Join-Path $stage "Portcove_${version}_${architecture}.app.tar.gz"), "-C", $macExtract)
            $app = Join-Path $macExtract "Portcove.app"
            $plist = Join-Path $app "Contents/Info.plist"
            $native.bundle_version = (& /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' $plist | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $native.bundle_version -ne $version) { throw "macOS bundle version mismatch" }
            $native.bundle_identifier = (& /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' $plist | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $native.bundle_identifier -ne 'io.github.portcove.portcove') { throw "macOS bundle identity mismatch" }
            $native.bundle_build_version = (& /usr/libexec/PlistBuddy -c 'Print CFBundleVersion' $plist | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $native.bundle_build_version -ne $version) { throw "macOS build version mismatch" }
            Invoke-Checked "codesign" @("--verify", "--deep", "--strict", $app)
            $signingDetails = (& codesign -dv $app 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0 -or $signingDetails -notmatch 'Signature=adhoc') { throw "Expected ad-hoc signing on final macOS updater payload" }
            Invoke-Checked "test" @("-x", (Join-Path $app "Contents/MacOS/portcove-desktop"))
            $native.native_signing = "ad-hoc"
            $native.executable_permissions_verified = $true
        }
        $native | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runRoot "$version-native.json") -Encoding utf8
        & git diff --binary -- Cargo.toml Cargo.lock apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json | Set-Content -LiteralPath (Join-Path $runRoot "$version-fixture.patch") -Encoding utf8
        Move-RehearsalInput $bundleRoot "$version-bundles"
        Move-RehearsalInput $cliRoot "$version-cli-assets"
    }
    if ($IsLinux) {
        $fixtureRoot = Join-Path $runRoot "linux-appimage-qualification"
        Invoke-Checked "cargo" @("run", "--locked", "--quiet", "-p", "portcove-release-tools", "--example", "generate_test_updater_repository", "--", $fixtureRoot, $publicKey)
        $inputs = Join-Path $fixtureRoot "inputs"
        New-Item -ItemType Directory -Path $inputs | Out-Null
        $candidateStage = Join-Path $runRoot "$candidateVersion-$PlatformLabel"
        $candidateName = "Portcove_$($candidateVersion)_amd64.AppImage"
        $candidate = Join-Path $candidateStage $candidateName
        $candidateInventoryPath = Join-Path $candidateStage "updater-inventory.json"
        Copy-Item -LiteralPath $candidateInventoryPath -Destination (Join-Path $inputs "updater-inventory.json")
        Copy-Item -LiteralPath "$candidate.sig" -Destination (Join-Path $inputs "candidate.sig")
        $contractText = (& cargo run --locked --quiet -p portcove-desktop --example prepare_appimage_update -- describe $predecessorVersion | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not derive the Linux updater fixture contract" }
        $contract = $contractText | ConvertFrom-Json
        $sourceTree = (& git rev-parse "HEAD^{tree}" | Out-String).Trim()
        $runId = if ($env:GITHUB_RUN_ID -match '^\d+$' -and [UInt64]$env:GITHUB_RUN_ID -gt 0) { [UInt64]$env:GITHUB_RUN_ID } else { [UInt64]1 }
        $attempt = if ($env:GITHUB_RUN_ATTEMPT -match '^\d+$' -and [UInt64]$env:GITHUB_RUN_ATTEMPT -gt 0) { [UInt64]$env:GITHUB_RUN_ATTEMPT } else { [UInt64]1 }
        $descriptor = [ordered]@{
            schema_version = 1
            releases = @([ordered]@{
                inventory = "updater-inventory.json"
                signature = "candidate.sig"
                source_tree = $sourceTree
                qualified_run = [ordered]@{
                    workflow = ".github/workflows/updater-artifact-rehearsal.yml"
                    workflow_commit = $revision
                    run_id = $runId
                    attempt = $attempt
                }
                execution_context = "user-owned-appimage"
                compatibility = $contract.compatibility
                evidence_ids = @("updater-artifact-rehearsal-$runId-linux-x86_64")
            })
        }
        $descriptorPath = Join-Path $inputs "descriptor.json"
        $eligibilityPath = Join-Path $inputs "eligibility.json"
        $descriptor | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $descriptorPath -Encoding utf8
        $eligibility = [ordered]@{}
        $eligibility["v$candidateVersion"] = [ordered]@{
                version = $candidateVersion
                preview_eligible = $true
                production_eligible = $candidateProductionEligible
                targets = @("linux-x86_64")
        }
        $eligibility | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $eligibilityPath -Encoding utf8

        $wrongPayloadRoot = Join-Path $fixtureRoot "private/wrong-payload"
        New-Item -ItemType Directory -Path $wrongPayloadRoot | Out-Null
        $wrongPayloadPrivateKey = Join-Path $wrongPayloadRoot "wrong-disposable.key"
        $wrongPayloadCandidate = Join-Path $wrongPayloadRoot $candidateName
        Copy-Item -LiteralPath $candidate -Destination $wrongPayloadCandidate
        Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "signer", "generate", "--ci", "--write-keys", $wrongPayloadPrivateKey) | Out-Null
        $wrongPayloadPublicKey = Join-Path $runRoot "wrong-disposable.key.pub"
        Copy-Item -LiteralPath "$wrongPayloadPrivateKey.pub" -Destination $wrongPayloadPublicKey
        $savedSigningPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY
        try {
            Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
            Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "signer", "sign", "--private-key-path", $wrongPayloadPrivateKey, "--password", "", $wrongPayloadCandidate)
        } finally {
            $env:TAURI_SIGNING_PRIVATE_KEY = $savedSigningPrivateKey
        }
        $wrongPayloadSignature = "$wrongPayloadCandidate.sig"
        $candidateBytes = (Get-Item -LiteralPath $candidate -Force).Length
        $candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        $wrongVerificationText = (& $verifier verify $wrongPayloadCandidate $wrongPayloadSignature $wrongPayloadPublicKey $candidateHash $candidateBytes | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "The distinct disposable payload signature did not verify with its own key" }
        $wrongVerification = $wrongVerificationText | ConvertFrom-Json
        $candidateInventory = Get-Content -LiteralPath $candidateInventoryPath -Raw | ConvertFrom-Json -AsHashtable
        if (-not $wrongVerification.signature_verified -or
            $wrongVerification.sha256 -ne $candidateHash -or
            $wrongVerification.bytes -ne $candidateBytes -or
            $wrongVerification.public_key_sha256 -eq $candidateInventory.updater.public_key_sha256) {
            throw "The wrong-key payload fixture does not have a distinct verified identity"
        }
        $wrongTauriSignature = [IO.File]::ReadAllText($wrongPayloadSignature).TrimEnd([char[]]"`r`n")
        if ([string]::IsNullOrWhiteSpace($wrongTauriSignature) -or $wrongTauriSignature.Length -gt 16384) {
            throw "The wrong-key payload signature is missing or oversized"
        }

        $records = Join-Path $fixtureRoot "records"
        Invoke-Checked "node" @("scripts/reconstruct-application-update-records.mjs", "--input", $descriptorPath, "--eligibility", $eligibilityPath, "--output", $records)
        $missingRecords = Join-Path $fixtureRoot "records-missing-payload-signature"
        $wrongRecords = Join-Path $fixtureRoot "records-wrong-payload-signature"
        foreach ($recordVariant in @(
            [ordered]@{ label = "missing-signature"; root = $missingRecords; signature = $null },
            [ordered]@{ label = "wrong-key-signature"; root = $wrongRecords; signature = $wrongTauriSignature }
        )) {
            Copy-Item -LiteralPath $records -Destination $recordVariant.root -Recurse
            $manifestPath = Join-Path $recordVariant.root "reconstruction-manifest.json"
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
            $releaseRecords = @($manifest.records | Where-Object { $_.kind -eq "release" })
            if ($releaseRecords.Count -ne 1) { throw "The $($recordVariant.label) fixture requires exactly one release record" }
            $releaseRecord = $releaseRecords[0]
            $releasePath = Join-Path $recordVariant.root $releaseRecord.path
            $release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json -AsHashtable
            if (-not $release.artifact.Contains("tauri_signature")) { throw "The $($recordVariant.label) release omitted its payload signature before mutation" }
            if ($null -eq $recordVariant.signature) {
                $release.artifact.Remove("tauri_signature")
            } else {
                $release.artifact.tauri_signature = $recordVariant.signature
            }
            [IO.File]::WriteAllText($releasePath, ($release | ConvertTo-Json -Depth 20))
            $releaseRecord.bytes = (Get-Item -LiteralPath $releasePath -Force).Length
            $releaseRecord.sha256 = (Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $promotions = @($manifest.records | Where-Object { $_.kind -eq "promotion" } | ForEach-Object {
                    $promotionRecord = $_
                    $promotionPath = Join-Path $recordVariant.root $promotionRecord.path
                    $promotion = Get-Content -LiteralPath $promotionPath -Raw | ConvertFrom-Json -AsHashtable
                    if ($promotion.release_path -eq $releaseRecord.path) {
                        [pscustomobject]@{ record = $promotionRecord; path = $promotionPath; document = $promotion }
                    }
                })
            if ($promotions.Count -eq 0) { throw "The $($recordVariant.label) release fixture has no bound promotion" }
            foreach ($boundPromotion in $promotions) {
                $boundPromotion.document.release_sha256 = $releaseRecord.sha256
                [IO.File]::WriteAllText($boundPromotion.path, ($boundPromotion.document | ConvertTo-Json -Depth 20))
                $boundPromotion.record.bytes = (Get-Item -LiteralPath $boundPromotion.path -Force).Length
                $boundPromotion.record.sha256 = (Get-FileHash -LiteralPath $boundPromotion.path -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20))
        }

        $baseTufConfig = Get-Content -LiteralPath (Join-Path $fixtureRoot "build-tuf.json") -Raw | ConvertFrom-Json -AsHashtable
        function Get-TufVariantConfig(
            [string]$ReconstructedRecords,
            [string]$Output,
            [uint64]$TopLevelVersion,
            [uint64]$DelegatedVersion
        ) {
            $config = $baseTufConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
            $config.reconstructed_records = $ReconstructedRecords
            $config.output = $Output
            foreach ($role in @("targets", "snapshot", "timestamp")) {
                $config.versions[$role] = $TopLevelVersion
            }
            foreach ($role in @("releases", "preview", "stable")) {
                $config.versions[$role] = $DelegatedVersion
            }
            return $config
        }
        $tufVariantConfigs = @()
        # The consumer persists replay floors for top-level roles. Advance those for
        # recovery while delegated metadata remains a fresh version-1 fixture.
        foreach ($variant in @(
            [ordered]@{ name = "positive"; records = "records"; output = "repository/positive"; top_level_version = 1; delegated_version = 1 },
            [ordered]@{ name = "missing-payload-signature"; records = "records-missing-payload-signature"; output = "repository/missing-payload-signature"; top_level_version = 1; delegated_version = 1 },
            [ordered]@{ name = "wrong-payload-signature"; records = "records-wrong-payload-signature"; output = "repository/wrong-payload-signature"; top_level_version = 1; delegated_version = 1 },
            [ordered]@{ name = "recovery"; records = "records"; output = "repository/recovery"; top_level_version = 2; delegated_version = 1 }
        )) {
            $tufBuildConfigPath = Join-Path $fixtureRoot "build-tuf-$($variant.name).json"
            $tufBuildConfig = Get-TufVariantConfig $variant.records $variant.output $variant.top_level_version $variant.delegated_version
            [IO.File]::WriteAllText($tufBuildConfigPath, ($tufBuildConfig | ConvertTo-Json -Depth 20))
            $tufVariantConfigs += $tufBuildConfigPath
        }
        foreach ($tufBuildConfigPath in $tufVariantConfigs) {
            Invoke-Checked "cargo" @("run", "--locked", "--quiet", "-p", "portcove-release-tools", "--", "build-tuf", $tufBuildConfigPath)
        }

        Set-FixtureVersion $predecessorVersion
        $env:PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE = Join-Path $fixtureRoot "trusted-root.json"
        $positiveRepository = Join-Path $fixtureRoot "repository/positive"
        $metadataDirectory = (Resolve-Path -LiteralPath (Join-Path $positiveRepository "metadata")).Path
        $targetsDirectory = (Resolve-Path -LiteralPath (Join-Path $positiveRepository "targets")).Path
        $env:PORTCOVE_APPLICATION_UPDATE_METADATA_URL = ([Uri]::new($metadataDirectory.TrimEnd('/') + '/')).AbsoluteUri
        $env:PORTCOVE_APPLICATION_UPDATE_TARGETS_URL = ([Uri]::new($targetsDirectory.TrimEnd('/') + '/')).AbsoluteUri
        Invoke-Checked "corepack" @($pnpmSpec, "--dir", "apps/desktop", "tauri", "build", "--bundles", "appimage", "--config", $configPath, "--ci", "--features", "application-update-qualification")
        $predecessor = Join-Path $bundleRoot "appimage/Portcove_$($predecessorVersion)_amd64.AppImage"
        Remove-Item -LiteralPath $privateKey -Force
        Remove-Item -LiteralPath (Join-Path $fixtureRoot "private") -Recurse -Force
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
        foreach ($tufConfigPath in @((Join-Path $fixtureRoot "build-tuf.json")) + $tufVariantConfigs) {
            Remove-Item -LiteralPath $tufConfigPath -Force
        }
        $linuxHarnessArguments = @(
            "-NoProfile", "-File", (Join-Path $PSScriptRoot "test-linux-appimage-update.ps1"),
            "-PredecessorPath", $predecessor,
            "-CandidatePath", $candidate,
            "-TrustedRootPath", (Join-Path $fixtureRoot "trusted-root.json"),
            "-MetadataPath", $metadataDirectory,
            "-TargetsPath", $targetsDirectory,
            "-MissingSignatureRepositoryPath", (Join-Path $fixtureRoot "repository/missing-payload-signature"),
            "-WrongSignatureRepositoryPath", (Join-Path $fixtureRoot "repository/wrong-payload-signature"),
            "-RecoveryRepositoryPath", (Join-Path $fixtureRoot "repository/recovery"),
            "-WrongPayloadPublicKeySha256", $wrongVerification.public_key_sha256,
            "-PayloadPrivateKeyPath", $privateKey,
            "-TufPrivateRootPath", (Join-Path $fixtureRoot "private"),
            "-StateRoot", (Join-Path $fixtureRoot "state"),
            "-EvidencePath", (Join-Path $fixtureRoot "application-update-evidence.json"),
            "-PredecessorVersion", $predecessorVersion,
            "-CandidateVersion", $candidateVersion
        )
        Invoke-Checked "dbus-run-session" (@("--", "pwsh") + $linuxHarnessArguments)
        Move-RehearsalInput $bundleRoot "qualified-$predecessorVersion-bundles"
    }
} catch {
    [ordered]@{ source_commit = $revision; platform = $PlatformLabel; status = "failed"; transition_profile = $TransitionProfile; fixture_versions = $fixtureVersions; failure = $_.Exception.Message } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "rehearsal-result.json") -Encoding utf8
    throw
} finally {
    $wrongPassword = $null
    foreach ($relative in $metadataPaths) { [IO.File]::WriteAllBytes((Join-Path $root $relative), $original[$relative]) }
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
    if ([IO.File]::Exists($privateKey)) { [IO.File]::Delete($privateKey) }
    if ([IO.Directory]::Exists($wrongPrivateRoot)) { [IO.Directory]::Delete($wrongPrivateRoot, $true) }
    $fixturePrivate = Join-Path $runRoot "linux-appimage-qualification/private"
    if ([IO.Directory]::Exists($fixturePrivate)) { [IO.Directory]::Delete($fixturePrivate, $true) }
}
[ordered]@{ source_commit = $revision; platform = $PlatformLabel; status = "passed"; transition_profile = $TransitionProfile; fixture_versions = $fixtureVersions; production_signing = $false } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "rehearsal-result.json") -Encoding utf8
