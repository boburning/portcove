param([Parameter(Mandatory)][ValidateSet('msvc64','mingw64')][string]$Variant)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Directory([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -ErrorAction Stop
    while ($null -ne $Item) {
        if ($Item -isnot [IO.DirectoryInfo] -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Expected regular directory ancestry'
        }
        $Item = $Item.Parent
    }
}

function New-OwnedDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path) { throw 'Expected an absent fixture path' }
    New-Item -ItemType Directory -Path $Path | Out-Null
    Assert-Directory $Path
}

function Write-Json([string]$Path, $Value) {
    if (Test-Path -LiteralPath $Path) { throw 'Evidence already exists' }
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-FileSha256([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected regular file' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Inventory([string]$Root, [long]$MaxBytes, [int]$MaxEntries) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Assert-Directory $Root
    $Pending = [Collections.Generic.Queue[string]]::new()
    $Pending.Enqueue($Root)
    $Count = 0
    [long]$Bytes = 0
    while ($Pending.Count) {
        $Directory = $Pending.Dequeue()
        foreach ($Item in (Get-ChildItem -LiteralPath $Directory -Force)) {
            $Count++
            if ($Count -gt $MaxEntries -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Inventory count or link boundary refused'
            }
            $Relative = [IO.Path]::GetRelativePath($Root, $Item.FullName).Replace('\','/')
            if ($Item.PSIsContainer) {
                $Pending.Enqueue($Item.FullName)
                [ordered]@{ path = $Relative; directory = $true }
            } else {
                $Bytes += $Item.Length
                if ($Bytes -gt $MaxBytes) { throw 'Inventory byte boundary refused' }
                [ordered]@{ path = $Relative; bytes = $Item.Length; sha256 = (Get-FileSha256 $Item.FullName) }
            }
        }
    }
}

function Get-InventoryText([string]$Root, [long]$MaxBytes, [int]$MaxEntries) {
    $Rows = @(Get-Inventory $Root $MaxBytes $MaxEntries | Sort-Object { $_.path } -CaseSensitive)
    return ConvertTo-Json -InputObject $Rows -Depth 5 -Compress
}

function Expand-ReviewedArchive([string]$ZipPath, [string]$Destination, [string]$ExpectedRoot) {
    $Zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($Zip.Entries.Count -lt 1 -or $Zip.Entries.Count -gt 800) { throw 'ZIP member count refused' }
        $Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [long]$Total = 0
        foreach ($Member in $Zip.Entries) {
            $Name = $Member.FullName.TrimEnd('/')
            $Parts = $Name.Split('/')
            $Total += $Member.Length
            if ($Total -gt 180MB -or $Member.Length -gt 60MB -or $Name.Length -gt 180 -or
                -not $Member.FullName.StartsWith($ExpectedRoot + '/', [StringComparison]::Ordinal) -or
                $Parts.Count -gt 12 -or -not $Seen.Add($Name) -or
                (($Member.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or
                ($Member.ExternalAttributes -band 0x0400) -ne 0 -or
                @($Parts | Where-Object { $_ -notmatch '^[\x20-\x7E]+$' -or $_ -match '[<>:"\\|?*]' -or $_ -match '[ .]$' -or $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)' }).Count) {
                throw 'ZIP member identity or extraction scope refused'
            }
        }
    } finally { $Zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
}

function Resolve-ProfileCandidate([Environment+SpecialFolder]$Folder, [string]$AccountRoot) {
    $HomeDirectory = [Environment]::GetFolderPath($Folder)
    if (-not [IO.Path]::IsPathFullyQualified($HomeDirectory) -or
        -not $HomeDirectory.StartsWith($AccountRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Known Folder resolved outside the disposable account profile'
    }
    Assert-Directory $HomeDirectory
    $Candidate = Join-Path $HomeDirectory 'JA2'
    if (Test-Path -LiteralPath $Candidate) { throw 'Existing JA2 profile; refusing fixture' }
    return $Candidate
}

function Invoke-Probe([string]$Name, [string[]]$Arguments, [int]$ExpectedExit) {
    $Details = [ordered]@{ phase = $Name; arguments = @($Arguments | ForEach-Object { if ($_ -ceq $EmptyGame) { '<empty-owned-input>' } else { $_ } }); executable_sha256 = $Package.files['ja2.exe'].sha256 }
    $Details.before = [ordered]@{ application_data = (Get-InventoryText $AppData 1MB 32 | ConvertFrom-Json -NoEnumerate); documents = (Get-InventoryText $Documents 1MB 32 | ConvertFrom-Json -NoEnumerate) }
    $PhaseTemp = Join-Path $Owned ('temp-' + $Name)
    New-OwnedDirectory $PhaseTemp
    $Start = [Diagnostics.ProcessStartInfo]::new()
    $Start.FileName = $Executable
    $Start.WorkingDirectory = $Runtime
    $Start.UseShellExecute = $false
    $Start.CreateNoWindow = $true
    foreach ($Argument in $Arguments) { $Start.ArgumentList.Add($Argument) }
    foreach ($Key in @($Start.Environment.Keys)) {
        if ($Key -imatch '^(TMP|TEMP|.*TOKEN.*|.*SECRET.*|ACTIONS_RUNTIME_URL)$') { $Start.Environment.Remove($Key) | Out-Null }
    }
    $Start.Environment['TMP'] = $PhaseTemp
    $Start.Environment['TEMP'] = $PhaseTemp
    $Process = $null
    try {
        $Process = [Diagnostics.Process]::Start($Start)
        if ($null -eq $Process) { throw 'JA2 did not return an owned process handle' }
        $Details.pid = $Process.Id
        $Details.started_utc = $Process.StartTime.ToUniversalTime().ToString('o')
        $Details.observed_exit = $Process.WaitForExit(30000)
        if (-not $Details.observed_exit) {
            $Process.Kill()
            $Details.cleanup_observed_exit = $Process.WaitForExit(5000)
            throw 'Exact JA2 process exceeded bounded runtime'
        }
        $Details.exit_code = $Process.ExitCode
        if ($Process.ExitCode -ne $ExpectedExit) { throw 'JA2 exited with an unexpected status' }
        if ((Get-InventoryText $Runtime 180MB 900) -cne $InitialRuntime -or
            (Get-InventoryText $EmptyGame 1MB 32) -cne '[]') { throw 'JA2 changed the verified runtime or empty input' }
    } catch {
        $Details.failure = $_.Exception.GetType().Name
        throw
    } finally {
        if ($null -ne $Process) {
            try {
                if (-not $Process.HasExited -and -not $Details.Contains('cleanup_observed_exit')) {
                    $Process.Kill()
                    $Details.cleanup_observed_exit = $Process.WaitForExit(5000)
                }
            } finally { $Process.Dispose() }
        }
        $Details.after = [ordered]@{ application_data = (Get-InventoryText $AppData 1MB 32 | ConvertFrom-Json -NoEnumerate); documents = (Get-InventoryText $Documents 1MB 32 | ConvertFrom-Json -NoEnumerate); scratch_logs = (Get-InventoryText $PhaseTemp 1MB 32 | ConvertFrom-Json -NoEnumerate) }
        Write-Json (Join-Path $Evidence ($Name + '.json')) $Details
        $Log = Join-Path $PhaseTemp 'ja2.log'
        if (Test-Path -LiteralPath $Log) { Copy-Item -LiteralPath $Log -Destination (Join-Path $Evidence ($Name + '.log')) }
    }
}

if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:ImageOS -cne 'win22' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
    $env:GITHUB_JOB -cne 'ja2_native_witness' -or
    $env:GITHUB_WORKFLOW_REF -cne 'boburning/portcove/.github/workflows/native-design-compatibility.yml@refs/heads/feature/2583-ja2-native-witness' -or
    $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,15}$' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '^[1-9][0-9]{0,5}$' -or
    $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$') { throw 'Exact disposable Windows hosted witness context required' }
$Source = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $Source -cne $env:GITHUB_SHA) { throw 'Expected exact witness source' }
$Status = & git status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $Status) {
    throw 'Expected exact clean witness source'
}
Assert-Directory $env:RUNNER_TEMP
$Owned = Join-Path $env:RUNNER_TEMP ('portcove-ja2-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT + '-' + $Variant)
New-OwnedDirectory $Owned
$Evidence = Join-Path $Owned 'evidence'
New-OwnedDirectory $Evidence
$Fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ja2-native-witness.fixture.json') -Raw | ConvertFrom-Json -AsHashtable
$Package = $Fixture.packages[$Variant]
Write-Json (Join-Path $Evidence 'binding.json') ([ordered]@{
    port = 'jagged-alliance-2-ja2-stracciatella'; source = $Source; workflow = $env:GITHUB_WORKFLOW_REF
    run_id = $env:GITHUB_RUN_ID; run_attempt = $env:GITHUB_RUN_ATTEMPT; image_os = $env:ImageOS; image_version = $env:ImageVersion
    os = [Runtime.InteropServices.RuntimeInformation]::OSDescription; flavor = $Variant
    fixture_sha256 = (Get-FileSha256 (Join-Path $PSScriptRoot 'ja2-native-witness.fixture.json'))
    upstream = $Fixture.origin; release = $Fixture.release; package = $Package
})
$AccountRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile).TrimEnd('\')
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if ($Identity.IsSystem -or $Identity.Name -inotmatch '\\runneradmin$' -or
        $AccountRoot -inotmatch '^[A-Za-z]:\\Users\\runneradmin$') { throw 'Expected the standard hosted disposable Windows account' }
} finally { $Identity.Dispose() }
Assert-Directory $AccountRoot
$AppData = Resolve-ProfileCandidate ApplicationData $AccountRoot
$Documents = Resolve-ProfileCandidate MyDocuments $AccountRoot
if ($AppData -ieq $Documents) { throw 'Windows Known Folder roles are not distinct' }
Write-Json (Join-Path $Evidence 'known-folders.json') @{ application_data = [IO.Path]::GetRelativePath($AccountRoot, $AppData); documents = [IO.Path]::GetRelativePath($AccountRoot, $Documents); both_absent = $true }

$Archive = Join-Path $Owned $Package.archive.name
& curl.exe -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-redirs 4 --max-time 75 --max-filesize $Package.archive.size --output $Archive $Package.archive.browser_download_url
if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $Archive).Length -ne $Package.archive.size -or
    ('sha256:' + (Get-FileSha256 $Archive)) -cne $Package.archive.digest) { throw 'Official archive transfer or digest differs' }
$ArchiveRoot = [IO.Path]::GetFileNameWithoutExtension($Package.archive.name)
$Extracted = Join-Path $Owned 'extracted'
New-OwnedDirectory $Extracted
Expand-ReviewedArchive $Archive $Extracted $ArchiveRoot
$Runtime = Join-Path $Extracted $ArchiveRoot
foreach ($Program in $Package.files.Values) {
    $Path = Join-Path $Extracted $Program.package_member
    if ((Get-Item -LiteralPath $Path).Length -ne $Program.bytes -or (Get-FileSha256 $Path) -cne $Program.sha256) {
        throw 'Extracted program differs from pinned program'
    }
}
$Executable = Join-Path $Runtime 'ja2.exe'
$EmptyGame = Join-Path $Owned 'empty-game'
New-OwnedDirectory $EmptyGame
$InitialRuntime = Get-InventoryText $Runtime 180MB 900
$Help = @('-help', '-gamedir', $EmptyGame)

Invoke-Probe 'fresh-appdata' $Help 0
$NewConfig = Join-Path $AppData 'ja2.json'
$FreshSaves = Join-Path $AppData 'SavedGames'
if (-not (Test-Path -LiteralPath $FreshSaves -PathType Container) -or
    (Get-InventoryText $FreshSaves 1MB 32) -cne '[]' -or
    (Test-Path -LiteralPath $Documents) -or
    -not ([IO.File]::ReadAllText($NewConfig).Contains('"game_dir": "C:\\Program Files\\Jagged Alliance 2"'))) {
    throw 'Fresh startup did not initialize the supported AppData profile'
}
Move-Item -LiteralPath $AppData -Destination (Join-Path $Owned 'first-appdata')
New-OwnedDirectory $Documents
$DocsConfig = Join-Path $Documents 'ja2.json'
[IO.File]::WriteAllText($DocsConfig, '{"fullscreen":false}')
$DocsSentinel = Join-Path $Documents 'probe-owner.txt'
[IO.File]::WriteAllText($DocsSentinel, 'legacy-profile')
$DocsHash = Get-FileSha256 $DocsConfig
$DocsSentinelHash = Get-FileSha256 $DocsSentinel
Invoke-Probe 'legacy-documents' $Help 0
if ((Test-Path -LiteralPath $AppData) -or (Get-FileSha256 $DocsConfig) -cne $DocsHash -or
    (Get-FileSha256 $DocsSentinel) -cne $DocsSentinelHash -or
    -not (Test-Path -LiteralPath (Join-Path $Documents 'SavedGames') -PathType Container)) {
    throw 'Startup did not preserve and reuse the existing Documents profile'
}
$DocsInventory = Get-InventoryText $Documents 1MB 32
New-OwnedDirectory $AppData
[IO.File]::WriteAllText($NewConfig, '{"fullscreen":true}')
$AppDataHash = Get-FileSha256 $NewConfig
Invoke-Probe 'appdata-preferred' $Help 0
if ((Get-InventoryText $Documents 1MB 32) -cne $DocsInventory -or (Get-FileSha256 $NewConfig) -cne $AppDataHash -or
    -not (Test-Path -LiteralPath (Join-Path $AppData 'SavedGames') -PathType Container)) {
    throw 'Startup did not prefer the existing AppData profile while preserving Documents'
}
$AppDataInventory = Get-InventoryText $AppData 1MB 32
Invoke-Probe 'ordinary-missing-source' @() 1
$RefusalLog = Join-Path $Evidence 'ordinary-missing-source.log'
if (-not (Test-Path -LiteralPath $RefusalLog) -or
    -not (Select-String -LiteralPath $RefusalLog -SimpleMatch 'Vanilla game directory has to be set') -or
    (Get-InventoryText $AppData 1MB 32) -cne $AppDataInventory -or (Get-InventoryText $Documents 1MB 32) -cne $DocsInventory) {
    throw 'Ordinary launch did not demonstrate the expected missing-original refusal and profile preservation'
}
Write-Json (Join-Path $Evidence 'result.json') @{ status = 'passed'; flavor = $Variant; managed_install_exercised = $false; gameplay_exercised = $false; originals_used = $false }
