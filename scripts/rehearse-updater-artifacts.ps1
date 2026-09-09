param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows-x86_64", "linux-x86_64", "macos-x86_64", "macos-aarch64")]
    [string]$PlatformLabel
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $root
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
$environmentNames = @("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "CARGO_TARGET_DIR")
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$privateKey = Join-Path $runRoot "disposable.key"
$publicKey = "$privateKey.pub"
$bundleRoot = Join-Path $root "target/release/bundle"
$cliRoot = Join-Path $root "release-assets"
$bundles = if ($IsWindows) { "nsis" } elseif ($IsLinux) { "appimage,deb,rpm" } else { "dmg" }
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

try {
    $env:CARGO_TARGET_DIR = Join-Path $root "target"
    # Suppress signer output: only the disposable public key belongs in evidence.
    Invoke-Checked "pnpm" @("--dir", "apps/desktop", "tauri", "signer", "generate", "--ci", "--write-keys", $privateKey) | Out-Null
    $env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    $configuration = Get-Content (Join-Path $root "release/tauri.updater.conf.json") -Raw | ConvertFrom-Json -AsHashtable
    $configuration.plugins.updater.pubkey = [IO.File]::ReadAllText($publicKey).Trim()
    $configPath = Join-Path $runRoot "rehearsal-config.json"
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
    Move-RehearsalInput $bundleRoot "previous-bundles"
    Move-RehearsalInput $cliRoot "previous-cli-assets"
    foreach ($version in @("0.1.0", "0.3.0")) {
        $cargo = [Text.Encoding]::UTF8.GetString($original["Cargo.toml"])
        $cargo = [regex]::Replace($cargo, '(?ms)(^\[workspace\.package\]\r?\n(?:(?!^\[).)*?^version\s*=\s*)"[^"]+"', ('$1"' + $version + '"'))
        [IO.File]::WriteAllText((Join-Path $root "Cargo.toml"), $cargo)
        foreach ($relative in @("apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json")) {
            $data = [Text.Encoding]::UTF8.GetString($original[$relative]) | ConvertFrom-Json
            $data.version = $version
            [IO.File]::WriteAllText((Join-Path $root $relative), ($data | ConvertTo-Json -Depth 30))
        }
        Invoke-Checked "node" @("scripts/check-release-metadata.mjs")
        Invoke-Checked "cargo" @("build", "--release", "-p", "portcove-cli", "-p", "portcove-release-tools")
        & (Join-Path $PSScriptRoot "package-cli.ps1") -PlatformLabel $PlatformLabel
        $cliName = (& node scripts/release-package-policy.mjs --platform $PlatformLabel --interface cli --version $version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Cannot select packaged CLI" }
        & (Join-Path $PSScriptRoot "smoke-test-cli-archive.ps1") -ArchivePath (Join-Path $cliRoot $cliName) -PlatformLabel $PlatformLabel -Version $version
        Invoke-Checked "pnpm" @("--dir", "apps/desktop", "tauri", "build", "--bundles", $bundles, "--config", $configPath, "--ci")
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
            if ($version -eq "0.3.0") {
                $predecessor = Join-Path $runRoot "0.1.0-$PlatformLabel/Portcove_0.1.0_x64-setup.exe"
                & (Join-Path $PSScriptRoot "test-windows-installer.ps1") -InstallerPath $installer -UpgradeFromInstallerPath $predecessor -ExpectedExecutablePath (Join-Path $root "target/release/portcove-desktop.exe") -TestBase (Join-Path $runRoot "installer-test") -EvidencePath (Join-Path $runRoot "windows-passive-upgrade.json") -InstallMode Passive -ExpectedVersion $version
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
} catch {
    [ordered]@{ source_commit = $revision; platform = $PlatformLabel; status = "failed"; failure = $_.Exception.Message } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "rehearsal-result.json") -Encoding utf8
    throw
} finally {
    foreach ($relative in $metadataPaths) { [IO.File]::WriteAllBytes((Join-Path $root $relative), $original[$relative]) }
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
    if ([IO.File]::Exists($privateKey)) { [IO.File]::Delete($privateKey) }
}
[ordered]@{ source_commit = $revision; platform = $PlatformLabel; status = "passed"; fixture_versions = @("0.1.0", "0.3.0"); production_signing = $false } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "rehearsal-result.json") -Encoding utf8
