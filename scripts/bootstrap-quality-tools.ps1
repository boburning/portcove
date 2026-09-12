param(
    [switch]$IncludeDeep,
    [switch]$Desktop,
    [Alias("h")][switch]$Help
)

$ErrorActionPreference = "Stop"
if ($Help) {
    @"
usage: ./scripts/bootstrap-quality-tools.ps1 [-IncludeDeep] [-Desktop] [-Help]

Installs repository-pinned tools into a shared user cache and writes checkout-local
shims under work/tool-bin. It never changes persistent PATH or user environment
variables. -Desktop also provisions tauri-driver and a matching EdgeDriver.
"@ | Write-Output
    exit 0
}

$runningOnWindows = $env:OS -eq "Windows_NT"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$qualityManifest = Get-Content -LiteralPath (Join-Path $projectRoot ".github\quality-tools.json") -Raw | ConvertFrom-Json
$bootstrapManifest = Get-Content -LiteralPath (Join-Path $projectRoot ".config\tool-bootstrap.json") -Raw | ConvertFrom-Json
$requiredAqua = (Get-Content -LiteralPath (Join-Path $projectRoot ".aqua-version") -Raw).Trim()
$requiredAquaSemver = $requiredAqua.TrimStart("v")
$requiredNodeVersion = (Get-Content -LiteralPath (Join-Path $projectRoot ".node-version") -Raw).Trim()
$toolPathsJson = & node (Join-Path $PSScriptRoot "tool-cache.mjs") --paths
if ($LASTEXITCODE -ne 0) { throw "Could not resolve the checkout tool-cache contract" }
$toolPaths = $toolPathsJson | ConvertFrom-Json
$sharedRoot = [IO.Path]::GetFullPath([string]$toolPaths.sharedRoot)
$shimDirectory = [IO.Path]::GetFullPath([string]$toolPaths.shimDirectory)
$aquaRoot = [IO.Path]::GetFullPath([string]$toolPaths.aquaRoot)
$aquaExecutable = [IO.Path]::GetFullPath([string]$toolPaths.aquaExecutable)

function Assert-UnderRoot([string]$Candidate, [string]$Root, [string]$Label) {
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedCandidate.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must remain below $Root; received $resolvedCandidate"
    }
    return $resolvedCandidate
}

function Test-ReportedVersion([string]$Executable, [string[]]$Arguments, [string]$Version) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $reported = (& $Executable @Arguments 2>&1 | Out-String).Trim()
        return $LASTEXITCODE -eq 0 -and $reported -match "(?<![0-9])$([regex]::Escape($Version))(?![0-9])"
    }
    catch { return $false }
}

function Resolve-StableCommandPath([string]$CommandPath) {
    $resolved = (Resolve-Path -LiteralPath $CommandPath).Path
    $parent = Get-Item -LiteralPath (Split-Path -Parent $resolved) -Force
    if ($parent.LinkType) {
        $target = $parent.ResolveLinkTarget($true)
        if ($target) {
            $candidate = Join-Path $target.FullName (Split-Path -Leaf $resolved)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $resolved
}

function Write-CommandShim([string]$Name, [string]$Executable, [string[]]$Prefix = @()) {
    if (@($Executable, $Prefix) | Where-Object { $_ -match '["&|<>^%!\r\n]' }) {
        throw "Refusing unsafe command-shim content for $Name"
    }
    New-Item -ItemType Directory -Force -Path $shimDirectory | Out-Null
    $prefixText = if ($Prefix.Count) { " " + (($Prefix | ForEach-Object { '"' + $_ + '"' }) -join " ") } else { "" }
    $call = if ([IO.Path]::GetExtension($Executable) -in @(".cmd", ".bat")) { "call " } else { "" }
    Set-Content -LiteralPath (Join-Path $shimDirectory "$Name.cmd") -Value "@echo off`r`n$call`"$Executable`"$prefixText %*`r`n" -NoNewline -Encoding ascii
}

function Invoke-VerifiedDownload([string]$Uri, [string]$ExpectedSha256, [string]$Destination) {
    $stagingRoot = Assert-UnderRoot (Join-Path $sharedRoot ".staging\$([guid]::NewGuid())") $sharedRoot "download staging"
    New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
    $download = Join-Path $stagingRoot "download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $download
        $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedSha256) {
            throw "Downloaded SHA-256 mismatch for $Uri; expected $ExpectedSha256, received $actual"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $download -Destination $Destination
    }
    finally {
        $verifiedStaging = Assert-UnderRoot $stagingRoot $sharedRoot "download staging cleanup"
        Remove-Item -LiteralPath $verifiedStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-PinnedAqua {
    if (-not $runningOnWindows) {
        $existing = Get-Command aqua -ErrorAction SilentlyContinue
        if (-not $existing -or -not (Test-ReportedVersion $existing.Source @("--version") $requiredAquaSemver)) {
            throw "aqua $requiredAqua is required on this host; self-install currently supports Windows"
        }
        return $existing.Source
    }
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $artifactKey = switch ($architecture) {
        "x64" { "win32-x64" }
        "arm64" { "win32-arm64" }
        default { throw "Unsupported Windows architecture for Aqua: $architecture" }
    }
    $artifact = $bootstrapManifest.aqua.artifacts.$artifactKey
    if (-not $artifact) { throw "No checked-in Aqua artifact for $artifactKey" }
    $receipt = "$aquaExecutable.receipt.json"
    $receiptReady = $false
    if (Test-Path -LiteralPath $receipt -PathType Leaf) {
        try {
            $metadata = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
            $receiptReady = $metadata.version -eq $requiredAquaSemver -and
                $metadata.archive_sha256 -eq [string]$artifact.sha256
        }
        catch { $receiptReady = $false }
    }
    if ($receiptReady -and (Test-ReportedVersion $aquaExecutable @("--version") $requiredAquaSemver)) {
        Write-Information "Aqua cache hit: $aquaExecutable" -InformationAction Continue
        return $aquaExecutable
    }
    $uri = "$($bootstrapManifest.aqua.release_base)/$requiredAqua/$($artifact.archive)"
    $archive = Assert-UnderRoot "$aquaExecutable.archive.next" $sharedRoot "Aqua archive"
    $extractRoot = Assert-UnderRoot "$aquaExecutable.extract.next" $sharedRoot "Aqua extraction"
    $aquaNext = Join-Path (Split-Path -Parent $aquaExecutable) "aqua.$([guid]::NewGuid()).next.exe"
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    try {
        Invoke-VerifiedDownload $uri ([string]$artifact.sha256) $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot
        $candidate = Join-Path $extractRoot "aqua.exe"
        if (-not (Test-ReportedVersion $candidate @("--version") $requiredAquaSemver)) {
            throw "Downloaded Aqua did not report required version $requiredAquaSemver"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $aquaExecutable) | Out-Null
        Copy-Item -LiteralPath $candidate -Destination $aquaNext -Force
        if (-not (Test-ReportedVersion $aquaNext @("--version") $requiredAquaSemver)) {
            throw "Staged Aqua did not retain required version $requiredAquaSemver"
        }
        @{ version = $requiredAquaSemver; archive_sha256 = [string]$artifact.sha256 } |
            ConvertTo-Json | Set-Content -LiteralPath "$receipt.next" -Encoding utf8
        Move-Item -LiteralPath $aquaNext -Destination $aquaExecutable -Force
        Move-Item -LiteralPath "$receipt.next" -Destination $receipt -Force
    }
    finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Information "Aqua installed: $aquaExecutable" -InformationAction Continue
    return $aquaExecutable
}

function Tool-BinaryName([object]$Definition) {
    if ($Definition.id -eq "rscheck-cli") { return "rscheck" }
    return [string]$Definition.crate
}

function Install-CachedCargoTool([object]$Definition) {
    $binaryName = Tool-BinaryName $Definition
    $suffix = if ($runningOnWindows) { ".exe" } else { "" }
    $toolRoot = Join-Path ([string]$toolPaths.cargoRoot) "$($Definition.crate)\$($Definition.version)"
    $target = Join-Path $toolRoot "bin\$binaryName$suffix"
    if (-not (Test-ReportedVersion $target @("--version") ([string]$Definition.version))) {
        $next = Join-Path (Split-Path -Parent $target) "$binaryName.$([guid]::NewGuid()).next$suffix"
        $global = Get-Command $binaryName -All -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandType -eq "Application" -and [IO.Path]::GetExtension($_.Source) -eq $suffix } |
            Select-Object -First 1
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        if ($global -and (Test-ReportedVersion $global.Source @("--version") ([string]$Definition.version))) {
            Copy-Item -LiteralPath $global.Source -Destination $next -Force
        }
        else {
            $installRoot = Assert-UnderRoot (Join-Path $sharedRoot ".staging\cargo-$([guid]::NewGuid())") $sharedRoot "Cargo install staging"
            try {
                if (Get-Command cargo-binstall -ErrorAction SilentlyContinue) {
                    & cargo binstall --no-confirm --locked --root $installRoot "$($Definition.crate)@$($Definition.version)"
                }
                else {
                    & cargo install --locked --root $installRoot --version $Definition.version $Definition.crate
                }
                if ($LASTEXITCODE -ne 0) { throw "Could not install $($Definition.crate) $($Definition.version)" }
                Copy-Item -LiteralPath (Join-Path $installRoot "bin\$binaryName$suffix") -Destination $next -Force
            }
            finally {
                Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not (Test-ReportedVersion $next @("--version") ([string]$Definition.version))) {
            Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
            throw "$($Definition.crate) did not report required version $($Definition.version)"
        }
        Move-Item -LiteralPath $next -Destination $target -Force
        Write-Information "$($Definition.crate) installed: $target" -InformationAction Continue
    }
    else { Write-Information "$($Definition.crate) cache hit: $target" -InformationAction Continue }
    Write-CommandShim $binaryName $target
    return $target
}

function Install-CachedTauriDriver([string]$Version) {
    $suffix = if ($runningOnWindows) { ".exe" } else { "" }
    $toolRoot = Join-Path ([string]$toolPaths.cargoRoot) "tauri-driver\$Version"
    $target = Join-Path $toolRoot "bin\tauri-driver$suffix"
    $receipt = Join-Path $toolRoot "receipt.json"
    $ready = $false
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Test-Path -LiteralPath $receipt -PathType Leaf)) {
        try {
            $metadata = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
            $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            $ready = $metadata.version -eq $Version -and $metadata.sha256 -eq $actualHash
        }
        catch { $ready = $false }
    }
    if (-not $ready) {
        $installRoot = Assert-UnderRoot (Join-Path $sharedRoot ".staging\tauri-driver-$([guid]::NewGuid())") $sharedRoot "Tauri driver staging"
        try {
            if (Get-Command cargo-binstall -ErrorAction SilentlyContinue) {
                & cargo binstall --no-confirm --locked --root $installRoot "tauri-driver@$Version" | Out-Host
            }
            else {
                & cargo install --locked --root $installRoot --version $Version tauri-driver | Out-Host
            }
            if ($LASTEXITCODE -ne 0) { throw "Could not install tauri-driver $Version" }
            $candidate = Join-Path $installRoot "bin\tauri-driver$suffix"
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "tauri-driver installation did not produce $candidate"
            }
            $candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            $targetNext = Join-Path (Split-Path -Parent $target) "tauri-driver.$([guid]::NewGuid()).next$suffix"
            Copy-Item -LiteralPath $candidate -Destination $targetNext -Force
            @{ version = $Version; sha256 = $candidateHash } |
                ConvertTo-Json | Set-Content -LiteralPath "$receipt.next" -Encoding utf8
            Move-Item -LiteralPath $targetNext -Destination $target -Force
            Move-Item -LiteralPath "$receipt.next" -Destination $receipt -Force
        }
        finally {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Information "tauri-driver installed: $target" -InformationAction Continue
    }
    else { Write-Information "tauri-driver cache hit: $target" -InformationAction Continue }
    Write-CommandShim "tauri-driver" $target
    return $target
}

function Install-CachedPowerShellAnalyzer([string]$Version, [string]$Repository) {
    $moduleRoot = [string]$toolPaths.powershellModules
    $target = Join-Path $moduleRoot "PSScriptAnalyzer\$Version"
    $manifest = Join-Path $target "PSScriptAnalyzer.psd1"
    $ready = Test-Path -LiteralPath $manifest -PathType Leaf
    if ($ready) {
        try {
            $metadata = Import-PowerShellDataFile -LiteralPath $manifest
            $ready = [string]$metadata.ModuleVersion -eq $Version
        }
        catch { $ready = $false }
    }
    if (-not $ready) {
        $stagingRoot = Assert-UnderRoot (Join-Path $sharedRoot ".staging\pssa-$([guid]::NewGuid())") $sharedRoot "PSScriptAnalyzer staging"
        $next = Join-Path $moduleRoot "PSScriptAnalyzer\$Version.next"
        try {
            New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
            Save-PSResource -Name PSScriptAnalyzer -Version $Version -Repository $Repository -Path $stagingRoot -TrustRepository
            $candidate = Join-Path $stagingRoot "PSScriptAnalyzer\$Version"
            $candidateManifest = Join-Path $candidate "PSScriptAnalyzer.psd1"
            if (-not (Test-Path -LiteralPath $candidateManifest -PathType Leaf)) {
                throw "PSScriptAnalyzer download did not contain its module manifest"
            }
            $metadata = Import-PowerShellDataFile -LiteralPath $candidateManifest
            if ([string]$metadata.ModuleVersion -ne $Version) {
                throw "PSScriptAnalyzer did not contain required version $Version"
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction SilentlyContinue
            Copy-Item -LiteralPath $candidate -Destination $next -Recurse
            $backup = "$target.invalid-$([guid]::NewGuid())"
            if (Test-Path -LiteralPath $target) {
                Move-Item -LiteralPath $target -Destination $backup
                try { Move-Item -LiteralPath $next -Destination $target }
                catch {
                    Move-Item -LiteralPath $backup -Destination $target
                    throw
                }
                Remove-Item -LiteralPath $backup -Recurse -Force
            }
            else { Move-Item -LiteralPath $next -Destination $target }
        }
        finally {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Information "PSScriptAnalyzer installed: $target" -InformationAction Continue
    }
    else { Write-Information "PSScriptAnalyzer cache hit: $target" -InformationAction Continue }
}

function Get-WebViewRuntimeVersion {
    $registryPaths = @(
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\Software\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\*"
    )
    $versions = @($registryPaths | ForEach-Object {
        Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue |
            Where-Object { $_.name -eq "Microsoft Edge WebView2 Runtime" } |
            ForEach-Object { [string]$_.pv }
    } | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object -Unique)
    if ($versions.Count -ne 1) {
        throw "Expected exactly one registered Evergreen WebView2 version; observed $($versions.Count)"
    }
    return $versions[0]
}

function Install-DesktopTools {
    if (-not $runningOnWindows) { throw "-Desktop self-provisioning currently supports Windows only" }
    $tauriDriverVersion = [string]$bootstrapManifest.desktop.tauri_driver
    $tauriDriver = Install-CachedTauriDriver $tauriDriverVersion
    $runtimeVersion = Get-WebViewRuntimeVersion
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $archiveName = switch ($architecture) {
        "x64" { "edgedriver_win64.zip" }
        "arm64" { "edgedriver_arm64.zip" }
        default { throw "Unsupported Windows architecture for EdgeDriver: $architecture" }
    }
    $driverRoot = Join-Path $sharedRoot "desktop\msedgedriver\$runtimeVersion\$architecture"
    $nativeDriver = Join-Path $driverRoot "msedgedriver.exe"
    $reportedPattern = "(?<![0-9])$([regex]::Escape($runtimeVersion))(?![0-9])"
    $driverReady = $false
    if (Test-Path -LiteralPath $nativeDriver -PathType Leaf) {
        $reported = (& $nativeDriver --version 2>&1 | Out-String).Trim()
        $signature = Get-AuthenticodeSignature -LiteralPath $nativeDriver
        $driverReady = $LASTEXITCODE -eq 0 -and $reported -match $reportedPattern -and
            $signature.Status -eq "Valid" -and $signature.SignerCertificate.Subject -match "Microsoft Corporation"
    }
    if (-not $driverReady) {
        $stagingRoot = Assert-UnderRoot (Join-Path $sharedRoot ".staging\edge-$([guid]::NewGuid())") $sharedRoot "EdgeDriver staging"
        New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
        try {
            $archive = Join-Path $stagingRoot $archiveName
            Invoke-WebRequest -UseBasicParsing -Uri "$($bootstrapManifest.desktop.edge_driver_base)/$runtimeVersion/$archiveName" -OutFile $archive
            Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $stagingRoot "extract")
            $candidate = Join-Path $stagingRoot "extract\msedgedriver.exe"
            $reported = (& $candidate --version 2>&1 | Out-String).Trim()
            $signature = Get-AuthenticodeSignature -LiteralPath $candidate
            if ($LASTEXITCODE -ne 0 -or $reported -notmatch $reportedPattern) {
                throw "EdgeDriver does not exactly match WebView2 runtime $runtimeVersion"
            }
            if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
                throw "EdgeDriver does not have a valid Microsoft signature"
            }
            New-Item -ItemType Directory -Force -Path $driverRoot | Out-Null
            $nativeDriverNext = Join-Path $driverRoot "msedgedriver.$([guid]::NewGuid()).next.exe"
            Copy-Item -LiteralPath $candidate -Destination $nativeDriverNext -Force
            Move-Item -LiteralPath $nativeDriverNext -Destination $nativeDriver -Force
        }
        finally {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-CommandShim "msedgedriver" $nativeDriver
    return [ordered]@{
        tauri_driver = $tauriDriver
        tauri_driver_version = $tauriDriverVersion
        tauri_driver_sha256 = (Get-FileHash -LiteralPath $tauriDriver -Algorithm SHA256).Hash
        native_driver = $nativeDriver
        native_driver_version = $runtimeVersion
        native_driver_sha256 = (Get-FileHash -LiteralPath $nativeDriver -Algorithm SHA256).Hash
        webview2_version = $runtimeVersion
    }
}

$mutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($sharedRoot.ToLowerInvariant())))
$cacheMutex = [Threading.Mutex]::new($false, "Local\PortcoveToolCache-$($mutexHash.Substring(0, 24))")
$mutexHeld = $false
try {
    try { $mutexHeld = $cacheMutex.WaitOne([TimeSpan]::FromSeconds(55)) }
    catch [Threading.AbandonedMutexException] { $mutexHeld = $true }
    if (-not $mutexHeld) { throw "Timed out waiting for another Portcove tool-cache bootstrap" }
    New-Item -ItemType Directory -Force -Path $sharedRoot, $shimDirectory, $aquaRoot | Out-Null
    $stagingDirectory = Join-Path $sharedRoot ".staging"
    if (Test-Path -LiteralPath $stagingDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $stagingDirectory -Force | ForEach-Object {
            $stale = Assert-UnderRoot $_.FullName $sharedRoot "stale staging cleanup"
            Remove-Item -LiteralPath $stale -Recurse -Force
        }
    }
    $incompleteItems = @(Get-ChildItem -LiteralPath $sharedRoot -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.next(?:\.|$)' }) |
        Sort-Object { $_.FullName.Length } -Descending
    foreach ($item in $incompleteItems) {
        if (Test-Path -LiteralPath $item.FullName) {
            $stale = Assert-UnderRoot $item.FullName $sharedRoot "incomplete promotion cleanup"
            Remove-Item -LiteralPath $stale -Recurse -Force
        }
    }
$resolvedAqua = Install-PinnedAqua
Write-CommandShim "aqua" $resolvedAqua
$pnpmSpec = [string]$toolPaths.pins.packageManager
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node -or -not (Test-ReportedVersion $node.Source @("--version") $requiredNodeVersion)) {
    throw "Node $requiredNodeVersion is required before bootstrapping checkout shims"
}
$corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if (-not $corepack) { throw "Node's Corepack shim is unavailable; install the repository-pinned Node version" }
$resolvedNode = Resolve-StableCommandPath $node.Source
$resolvedCorepack = Resolve-StableCommandPath $corepack.Source
Write-CommandShim "node" $resolvedNode
Write-CommandShim "corepack" $resolvedCorepack
Write-CommandShim "pnpm" $resolvedCorepack @($pnpmSpec)

$oldPath = $env:PATH
$oldModulePath = $env:PSModulePath
$oldAquaRoot = $env:AQUA_ROOT_DIR
$oldChecksum = $env:AQUA_ENFORCE_CHECKSUM
$oldRequiredChecksum = $env:AQUA_ENFORCE_REQUIRE_CHECKSUM
try {
    $env:PATH = "$shimDirectory;$oldPath"
    $env:PSModulePath = "$($toolPaths.powershellModules);$oldModulePath"
    $env:AQUA_ROOT_DIR = $aquaRoot
    $env:AQUA_ENFORCE_CHECKSUM = "true"
    $env:AQUA_ENFORCE_REQUIRE_CHECKSUM = "true"
    & $resolvedAqua install
    if ($LASTEXITCODE -ne 0) { throw "Aqua could not install the pinned quality tools" }

    foreach ($tool in @($qualityManifest.tools | Where-Object { $_.tier -eq "required" })) {
        Install-CachedCargoTool $tool | Out-Null
    }

    if ($runningOnWindows) {
        $resourceFile = Join-Path $projectRoot ".config\powershell-resources.psd1"
        $resources = Import-PowerShellDataFile -LiteralPath $resourceFile
        $requiredPssa = [string]$resources.PSScriptAnalyzer.version
        Install-CachedPowerShellAnalyzer $requiredPssa ([string]$resources.PSScriptAnalyzer.repository)
    }

    if ($IncludeDeep) {
        foreach ($tool in @($qualityManifest.tools | Where-Object { $_.tier -eq "deep" -and $_.id -ne "cargo-hawk" })) {
            try { Install-CachedCargoTool $tool | Out-Null }
            catch { Write-Warning "$($tool.crate) remains unavailable: $($_.Exception.Message)" }
        }
        if ($runningOnWindows) { Write-Warning "Hawk does not publish Windows binaries" }
    }

    $desktopState = if ($Desktop) {
        Install-DesktopTools
    }
    else {
        $existingStateJson = & node (Join-Path $PSScriptRoot "tool-cache.mjs") --state
        if ($LASTEXITCODE -eq 0 -and $existingStateJson) {
            ($existingStateJson | ConvertFrom-Json).desktop
        }
    }
    $state = [ordered]@{
        format_version = 1
        pin_fingerprint = [string]$toolPaths.pins.fingerprint
        shared_root = $sharedRoot
        shim_directory = $shimDirectory
        aqua = $resolvedAqua
        aqua_root = $aquaRoot
        node = $resolvedNode
        corepack = $resolvedCorepack
        package_manager = $pnpmSpec
        desktop = $desktopState
    }
    $statePath = [string]$toolPaths.statePath
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$statePath.next" -Encoding utf8
    Move-Item -LiteralPath "$statePath.next" -Destination $statePath -Force
}
finally {
    $env:PATH = $oldPath
    $env:PSModulePath = $oldModulePath
    $env:AQUA_ROOT_DIR = $oldAquaRoot
    $env:AQUA_ENFORCE_CHECKSUM = $oldChecksum
    $env:AQUA_ENFORCE_REQUIRE_CHECKSUM = $oldRequiredChecksum
}

Write-Output "Pinned Portcove tools are ready in $sharedRoot."
Write-Output "Checkout shims are ready in $shimDirectory."
}
finally {
    if ($mutexHeld) { $cacheMutex.ReleaseMutex() }
    $cacheMutex.Dispose()
}
