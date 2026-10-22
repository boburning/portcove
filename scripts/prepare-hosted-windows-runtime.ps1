param([AllowEmptyString()][string]$InspectVersion)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskFloorSource = Get-Content -LiteralPath (Join-Path $taskRepo 'apps/desktop/src-tauri/src/runtime_support.rs') -Raw
$taskFloorMatch = [regex]::Match($taskFloorSource, '(?s)#\[cfg\(windows\)\]\s*const ENGINE_FLOOR: &\[u32\] = &\[(\d+), (\d+), (\d+), (\d+)\];')
if (-not $taskFloorMatch.Success) { throw 'Reviewed Windows engine floor unavailable' }
$taskFloor = ($taskFloorMatch.Groups[1..4] | ForEach-Object Value) -join '.'
function Test-EngineVersion([string]$Value) {
    $Value -cmatch '^\d+\.\d+\.\d+\.\d+$' -and [version]$Value -ge [version]$taskFloor
}
if ($PSBoundParameters.ContainsKey('InspectVersion')) {
    @{ scope='declared-version-only; no host observation or installation'; minimum=$taskFloor; eligible=(Test-EngineVersion $InspectVersion) } | ConvertTo-Json
    exit 0
}
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]+$' -or
    $env:GITHUB_WORKFLOW_REF -cnotmatch '^boburning/portcove/\.github/workflows/hosted-(native-continuity|runtime-readiness)\.yml@refs/heads/(main|feature/534-[A-Za-z0-9-]+)$') {
    throw 'Only the reviewed standard hosted diagnostic may prepare this runtime'
}
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
$taskReceipt = [ordered]@{ source=$env:GITHUB_SHA; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT;
    workflow=$env:GITHUB_WORKFLOW_REF; scope='hosted runtime prerequisite only; not native acceptance';
    minimum=$taskFloor; before=@(Read-EngineVersions); after=@(); stage='observed'; installed=$false; automatic_retry=$false }
try {
    if ($taskReceipt.before.Count -gt 1) { throw 'Conflicting registered runtime versions; no mutation' }
    if ($taskReceipt.before.Count -eq 1 -and (Test-EngineVersion $taskReceipt.before[0])) {
        $taskReceipt.after=$taskReceipt.before
        $taskReceipt.stage='ready-existing'
    } else {
        $taskInstaller = Join-Path $taskEvidence 'MicrosoftEdgeWebview2Setup.exe'
        if (Test-Path -LiteralPath $taskInstaller) { throw 'Retained installer already exists; reconcile before use' }
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
        } finally { $taskDeadline.Dispose(); $taskClient.Dispose(); $taskHandler.Dispose() }
        $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskInstaller
        if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'Runtime bootstrapper lacks valid Microsoft signature' }
        $taskReceipt.installer_sha256=(Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        $taskReceipt.signer_thumbprint=$taskSignature.SignerCertificate.Thumbprint
        $taskReceipt.stage='installer-admitted'
        $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskReceiptPath
        $taskProcess = Start-Process -FilePath $taskInstaller -ArgumentList @('/silent','/install') -WindowStyle Hidden -PassThru
        try {
            if (-not $taskProcess.WaitForExit(300000)) {
                $taskProcess.Kill($true)
                throw 'Runtime installer exceeded five minutes; retain ambiguous partial effect, no retry'
            }
            $taskReceipt.exit_code=$taskProcess.ExitCode
        } finally { $taskProcess.Dispose() }
        $taskReceipt.after=@(Read-EngineVersions)
        if ($taskReceipt.exit_code -ne 0 -or $taskReceipt.after.Count -ne 1 -or -not (Test-EngineVersion $taskReceipt.after[0])) {
            throw 'Runtime installation did not establish the maintained shipping floor; retain actual readback'
        }
        $taskReceipt.installed=$true
        $taskReceipt.stage='ready-installed'
    }
} catch {
    $taskReceipt.failure=$_.Exception.Message
    $taskReceipt.after=@(Read-EngineVersions)
    throw
} finally {
    $taskReceipt.observed_at=[DateTime]::UtcNow.ToString('o')
    $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskReceiptPath
}
exit 0
