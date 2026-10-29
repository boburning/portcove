param([AllowEmptyString()][string]$InspectVersion, [switch]$UseStandaloneInstaller)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
# portcove-supported-runtime-prelude-begin
$taskFloorSource = Get-Content -LiteralPath (Join-Path $taskRepo 'apps/desktop/src-tauri/src/runtime_support.rs') -Raw
$taskFloorMatch = [regex]::Match($taskFloorSource, '(?s)#\[cfg\(windows\)\]\s*const ENGINE_FLOOR: &\[u32\] = &\[(\d+), (\d+), (\d+), (\d+)\];')
if (-not $taskFloorMatch.Success) { throw 'Reviewed Windows engine floor unavailable' }
$taskFloor = ($taskFloorMatch.Groups[1..4] | ForEach-Object Value) -join '.'
function Test-EngineVersion([string]$Value) {
    $Value -cmatch '^\d+\.\d+\.\d+\.\d+$' -and [version]$Value -ge [version]$taskFloor
}
# portcove-supported-runtime-prelude-end
if ($PSBoundParameters.ContainsKey('InspectVersion')) {
    if ($UseStandaloneInstaller) { throw 'Version inspection and standalone preparation are separate operations' }
    @{ scope='declared-version-only; no host observation or installation'; minimum=$taskFloor; eligible=(Test-EngineVersion $InspectVersion) } | ConvertTo-Json
    exit 0
}
$taskRuntimeSource = $env:GITHUB_SHA
$taskOrdinaryDiagnostic = $env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and
    $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/\.github/workflows/hosted-(native-continuity|runtime-readiness)\.yml@refs/heads/(main|feature/534-[A-Za-z0-9-]+)$'
$taskToolFixture = $env:GITHUB_JOB -ceq 'windows-tools' -and (
    ($env:GITHUB_EVENT_NAME -ceq 'push' -and $env:GITHUB_WORKFLOW_REF -ceq 'boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/heads/main') -or
    ($env:GITHUB_EVENT_NAME -ceq 'pull_request' -and $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/\.github/workflows/controller-tool-build-fixture\.yml@refs/pull/[1-9][0-9]*/merge$'))
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]+$' -or
    (-not $taskOrdinaryDiagnostic -and -not $taskToolFixture)) {
    throw 'Only the reviewed standard hosted diagnostic may prepare this runtime'
}
if ($taskToolFixture) {
    if ($UseStandaloneInstaller) { throw 'The tool fixture permits only the ordinary runtime bootstrapper' }
    if ($env:FIXTURE_SOURCE_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'Fixed tool fixture source unavailable' }
    $taskCheckedOutSource = (& git -C $taskRepo rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $taskCheckedOutSource -cne $env:FIXTURE_SOURCE_SHA) { throw 'Tool fixture checkout differs before runtime preparation' }
    $taskDirtySource = (& git -C $taskRepo -c core.fsmonitor=false status --porcelain=v1 --untracked-files=no | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $taskDirtySource.Length -ne 0) { throw 'Tool fixture checkout is not clean before runtime preparation' }
    # PR workflows identify their synthetic merge in GITHUB_SHA. The checked-out
    # source is the explicit head verified above and later by the tool qualifier.
    $taskRuntimeSource = $taskCheckedOutSource
}
if ($UseStandaloneInstaller) {
    # Source preparation only. A workflow input cannot authorize this proposed storage/input scope.
    $taskStandaloneExecutionAuthorized = $false -or ($env:GITHUB_WORKFLOW_REF -ceq 'boburning/portcove/.github/workflows/hosted-runtime-readiness.yml@refs/heads/feature/534-standalone-runtime-s1-20261029' -and $env:GITHUB_JOB -ceq 'runtime' -and $env:GITHUB_RUN_ATTEMPT -ceq '1')
    if (-not $taskStandaloneExecutionAuthorized) { throw 'Standalone runtime preparation awaits separately reviewed source/storage and execution authority' }
}
# portcove-supported-runtime-effects-begin
function Get-StandaloneRuntimeSource {
    # Exact previously observed official input, not an accepted runtime version or execution grant.
    [ordered]@{
        url='https://go.microsoft.com/fwlink/?linkid=2124701'
        filename='MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
        bytes=214884560
        sha256='1c401b327fbc7bb9731b4e350a2194f083cbc3ede46508d52e1cae6610a39bea'
        maximum_bytes=268435456
        download_seconds=120
        runtime_version=$null
        scope='proposed exact official source; no runtime, installation or protected authority'
    }
}
function Save-StandaloneRuntimeInstaller([string]$Destination) {
    $source=Get-StandaloneRuntimeSource
    if (Test-Path -LiteralPath $Destination) { throw 'Retain original standalone input; no automatic retry' }
    $handler=[Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect=$false
    $client=[Net.Http.HttpClient]::new($handler)
    $deadline=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($source.download_seconds))
    try {
        $redirect=$client.GetAsync($source.url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$deadline.Token).GetAwaiter().GetResult()
        try {
            if ([int]$redirect.StatusCode -notin @(301,302,303,307,308) -or -not $redirect.Headers.Location) { throw 'Official standalone source requires exactly one bounded redirect' }
            $location=[Uri]::new([Uri]$source.url,$redirect.Headers.Location)
            if ($location.Scheme -cne 'https' -or $location.Host -cne 'msedge.sf.dl.delivery.mp.microsoft.com' -or
                $location.Port -ne 443 -or $location.UserInfo -or $location.Fragment) { throw 'Official standalone download identity differs' }
        } finally { $redirect.Dispose() }
        $response=$client.GetAsync($location,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$deadline.Token).GetAwaiter().GetResult()
        try {
            if ([int]$response.StatusCode -ne 200 -or $response.Content.Headers.ContentEncoding.Count -ne 0) { throw 'Official standalone response differs; redirects and encoding refused' }
            if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $source.bytes) { throw 'Standalone declared byte identity differs' }
            $stream=$response.Content.ReadAsStreamAsync($deadline.Token).GetAwaiter().GetResult()
            try {
                $output=[IO.FileStream]::new($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                try {
                    $buffer=[byte[]]::new(65536)
                    $written=0L
                    while ($true) {
                        $length=$stream.ReadAsync($buffer,0,[int][math]::Min($buffer.Length,$source.bytes-$written+1),$deadline.Token).GetAwaiter().GetResult()
                        if ($length -eq 0) { break }
                        $written+=$length
                        if ($written -gt $source.bytes -or $written -gt $source.maximum_bytes) { throw 'Standalone actual byte bound exceeded; retain partial input' }
                        $output.Write($buffer,0,$length)
                    }
                    if ($written -ne $source.bytes) { throw 'Standalone actual byte identity differs; retain partial input' }
                    $output.Flush($true)
                } finally { $output.Dispose() }
            } finally { $stream.Dispose() }
        } finally { $response.Dispose() }
    } finally { $deadline.Dispose(); $client.Dispose(); $handler.Dispose() }
    return $source
}
function Get-VerifiedStandaloneRuntimeInstaller([string]$Installer) {
    $source=Get-StandaloneRuntimeSource
    $item=Get-Item -LiteralPath $Installer -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -ne $source.bytes -or $item.Length -gt $source.maximum_bytes) { throw 'Standalone file identity differs' }
    if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source.sha256) { throw 'Standalone bytes differ from the reviewed source proposal' }
    $signature=Get-AuthenticodeSignature -LiteralPath $Installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'Standalone input lacks a valid Microsoft signature' }
    return $source
}
$taskRuntimeClock = [Diagnostics.Stopwatch]::StartNew()
$taskRuntimeObservation = [ordered]@{ scope='reviewed diagnostic after workflow gate through terminal readback/disposal; cold setup and final receipt write excluded';
    elapsed_milliseconds=0; phases=[Collections.Generic.List[object]]::new() }
function Add-RuntimePhase([string]$Phase) {
    $taskElapsed = [math]::Floor($taskRuntimeClock.Elapsed.TotalMilliseconds)
    $taskRuntimeObservation.elapsed_milliseconds=$taskElapsed
    $taskRuntimeObservation.phases.Add([ordered]@{ phase=$Phase; elapsed_milliseconds=$taskElapsed })
}
Add-RuntimePhase 'entry'
function Read-EngineVersions {
    @('HKCU:\Software\Microsoft\EdgeUpdate\Clients\*', 'HKLM:\Software\Microsoft\EdgeUpdate\Clients\*', 'HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\*') |
        ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.name -eq 'Microsoft Edge WebView2 Runtime' } |
        ForEach-Object { [string]$_.pv } | Sort-Object -Unique
}
$taskEvidence = Join-Path $taskRepo 'work/hosted-continuity-evidence'
New-Item -ItemType Directory -Force -Path $taskEvidence | Out-Null
$taskReceiptPath = Join-Path $taskEvidence 'windows-runtime.json'
if (Test-Path -LiteralPath $taskReceiptPath) { throw 'Retain original runtime attempt; no automatic retry' }
$taskReceipt = [ordered]@{ source=$taskRuntimeSource; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT;
    workflow=$env:GITHUB_WORKFLOW_REF; scope='hosted runtime prerequisite only; not native acceptance';
    minimum=$taskFloor; before=@(Read-EngineVersions); after=@(); stage='observed'; installed=$false; automatic_retry=$false;
    runtime_preparation_observation=$taskRuntimeObservation }
Add-RuntimePhase 'initial-runtime-readback'
try {
    if ($taskReceipt.before.Count -gt 1) { throw 'Conflicting registered runtime versions; no mutation' }
    if ($taskReceipt.before.Count -eq 1 -and (Test-EngineVersion $taskReceipt.before[0])) {
        $taskReceipt.after=$taskReceipt.before
        $taskReceipt.stage='ready-existing'
        Add-RuntimePhase 'existing-runtime-eligible'
    } else {
        $taskInstaller = Join-Path $taskEvidence $(if ($UseStandaloneInstaller) {(Get-StandaloneRuntimeSource).filename} else {'MicrosoftEdgeWebview2Setup.exe'})
        if (Test-Path -LiteralPath $taskInstaller) { throw 'Retained installer already exists; reconcile before use' }
        Add-RuntimePhase 'download-starting'
        if ($UseStandaloneInstaller) {
            $taskReceipt.installer_input=Get-StandaloneRuntimeSource
            try {
                $null=Save-StandaloneRuntimeInstaller $taskInstaller
                $null=Get-VerifiedStandaloneRuntimeInstaller $taskInstaller
            } finally { Add-RuntimePhase 'download-disposed' }
        } else {
        $taskHandler = [Net.Http.HttpClientHandler]::new()
        $taskClient = [Net.Http.HttpClient]::new($taskHandler)
        $taskClient.MaxResponseContentBufferSize = 8MB
        $taskDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(60))
        try {
            $taskResponse = $taskClient.GetAsync('https://go.microsoft.com/fwlink/p/?LinkId=2124703', [Net.Http.HttpCompletionOption]::ResponseContentRead, $taskDeadline.Token).GetAwaiter().GetResult()
            try {
                $taskFinal = $taskResponse.RequestMessage.RequestUri
                if (-not $taskResponse.IsSuccessStatusCode -or $taskFinal.Scheme -cne 'https' -or $taskFinal.Host -cne 'msedge.sf.dl.delivery.mp.microsoft.com') { throw 'Official runtime download identity differs' }
                $taskBytes = $taskResponse.Content.ReadAsByteArrayAsync($taskDeadline.Token).GetAwaiter().GetResult()
                if ($taskBytes.Length -lt 1024 -or $taskBytes.Length -gt 8MB) { throw 'Runtime bootstrapper byte bound exceeded' }
                [IO.File]::WriteAllBytes($taskInstaller, $taskBytes)
            } finally { $taskResponse.Dispose() }
        } finally { $taskDeadline.Dispose(); $taskClient.Dispose(); $taskHandler.Dispose(); Add-RuntimePhase 'download-disposed' }
        }
        $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskInstaller
        if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'Runtime bootstrapper lacks valid Microsoft signature' }
        $taskReceipt.installer_sha256=(Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        $taskReceipt.signer_thumbprint=$taskSignature.SignerCertificate.Thumbprint
        $taskReceipt.stage='installer-admitted'
        Add-RuntimePhase 'signature-hash-verified'
        $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskReceiptPath
        if ($UseStandaloneInstaller) { $null=Get-VerifiedStandaloneRuntimeInstaller $taskInstaller }
        Add-RuntimePhase 'installer-starting'
        $taskProcess = Start-Process -FilePath $taskInstaller -ArgumentList @('/silent','/install') -WindowStyle Hidden -PassThru
        try {
            if (-not $taskProcess.WaitForExit(300000)) {
                $taskProcess.Kill($true)
                throw 'Runtime installer exceeded five minutes; retain ambiguous partial effect, no retry'
            }
            $taskReceipt.exit_code=$taskProcess.ExitCode
        } finally { $taskProcess.Dispose(); Add-RuntimePhase 'installer-process-disposed' }
        $taskReceipt.after=@(Read-EngineVersions)
        Add-RuntimePhase 'post-install-runtime-readback'
        if ($taskReceipt.exit_code -ne 0 -or $taskReceipt.after.Count -ne 1 -or -not (Test-EngineVersion $taskReceipt.after[0])) {
            throw 'Runtime installation did not establish the maintained shipping floor; retain actual readback'
        }
        $taskReceipt.installed=$true
        $taskReceipt.stage='ready-installed'
    }
} catch {
    Add-RuntimePhase 'failure'
    $taskReceipt.failure=$_.Exception.Message
    $taskReceipt.after=@(Read-EngineVersions)
    throw
} finally {
    Add-RuntimePhase 'terminal-receipt-ready'
    $taskReceipt.observed_at=[DateTime]::UtcNow.ToString('o')
    $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskReceiptPath
}
exit 0
# portcove-supported-runtime-effects-end
