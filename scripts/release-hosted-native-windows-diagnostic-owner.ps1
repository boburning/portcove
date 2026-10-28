param([Parameter(Mandatory)][string]$ContextBase64)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Fresh nonproduction candidate/account/recovery scope only; no production authority.
$hostedDiagnosticExecutionAuthorized=$true
if(-not $hostedDiagnosticExecutionAuthorized){throw 'Connected Windows diagnostic awaits exact source/account/candidate/recovery authority; no account or station effects'}
# Validate original hosted scope before even parsing caller context or reading files.
if(-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64' -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or $env:GITHUB_JOB -cne 'installed-prerequisite' -or
    $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,15}$' -or
    $env:GITHUB_WORKFLOW_REF -cne 'boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-node-canary-20261028'){throw 'Fixed hosted Windows diagnostic owner context required'}
function Read-OwnerWrapperBytes([string]$File,[int]$Maximum) {
    $item=Get-Item -LiteralPath $File -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Original unlinked owner file required'}
    $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if($stream.Length -lt 1 -or $stream.Length -gt $Maximum){throw 'Owner wrapper input exceeds bound'}
        $bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes)
        if($stream.ReadByte() -ne -1 -or $stream.Length -ne $bytes.Length){throw 'Owner wrapper input changed'}
        return ,$bytes
    }finally{$stream.Dispose()}
}
$ownerUtf8=[Text.UTF8Encoding]::new($false,$true)
if($ContextBase64.Length -gt 16384){throw 'Owner context exceeds bound'}
$ownerWrapperContext=$ownerUtf8.GetString([Convert]::FromBase64String($ContextBase64))|ConvertFrom-Json
if($ownerWrapperContext.tools_root -cne (Split-Path $PSScriptRoot)){throw 'Original owner tool root differs'}
$ownerMechanism=Join-Path $PSScriptRoot 'release-hosted-native-windows-owner-mechanism.ps1'
$ownerManifest=Join-Path $ownerWrapperContext.tools_root 'manifest.json'
$ownerManifestBytes=Read-OwnerWrapperBytes $ownerManifest 65536
$ownerManifestValue=$ownerUtf8.GetString($ownerManifestBytes)|ConvertFrom-Json
$ownerMechanismEntry=@($ownerManifestValue.files|Where-Object path -CEQ 'scripts/release-hosted-native-windows-owner-mechanism.ps1')
$ownerMechanismBytes=Read-OwnerWrapperBytes $ownerMechanism 131072
if($ownerMechanismEntry.Count -ne 1 -or $ownerMechanismEntry[0].bytes -ne $ownerMechanismBytes.Length -or
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($ownerMechanismBytes)).ToLowerInvariant() -cne $ownerMechanismEntry[0].sha256){throw 'Original owner mechanism source differs'}
. ([scriptblock]::Create($ownerUtf8.GetString($ownerMechanismBytes))) -ContextBase64 $ContextBase64 -OwnerProfile Diagnostic -OwnerScriptsRoot $PSScriptRoot
