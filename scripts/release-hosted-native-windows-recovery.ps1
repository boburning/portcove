param([Parameter(Mandatory)][string]$Context,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,[switch]$Diagnostic)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$hostedRecoveryExecutionAuthorized=$false
$hostedDiagnosticRecoveryExecutionAuthorized=$false
if($Diagnostic){if(-not $hostedDiagnosticRecoveryExecutionAuthorized){throw 'Connected diagnostic original-session recovery awaits exact separate authority'}}
elseif(-not $hostedRecoveryExecutionAuthorized){throw 'Hosted original-session recovery awaits separate owner authority'}
function Read-RecoveryBytes([string]$File,[int]$Maximum) {
    $item=Get-Item -LiteralPath $File -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Original regular recovery file required'}
    $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{if($stream.Length -lt 1 -or $stream.Length -gt $Maximum){throw 'Original recovery file exceeds bound'};$bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes);if($stream.ReadByte() -ne -1 -or $stream.Length -ne $bytes.Length){throw 'Original recovery input changed'};return ,$bytes}finally{$stream.Dispose()}
}
$recoveryUtf8=[Text.UTF8Encoding]::new($false,$true)
$recoveryBytes=Read-RecoveryBytes $Context 65536
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($recoveryBytes)).ToLowerInvariant() -cne $ExpectedSha256){throw 'Original recovery input changed'}
$value=$recoveryUtf8.GetString($recoveryBytes)|ConvertFrom-Json
$recoveryKeys=if($Diagnostic){'account_sid,binding,broker_sid,description,original_owner_created_filetime,original_owner_pid,run_attempt,run_id,setup_sha256,source_commit,station'}else{'account_sid,binding,broker_sid,description,original_owner_created_filetime,original_owner_pid,setup_sha256,station'}
$fixedRecoveryContext=if($Diagnostic) {
    $env:GITHUB_JOB -ceq 'installed-prerequisite' -and $env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and
    $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/[.]github/workflows/hosted-native-continuity[.]yml@refs/heads/(main|feature/534-[A-Za-z0-9-]+)$' -and
    $value.source_commit -ceq $env:GITHUB_SHA -and $value.run_id -ceq $env:GITHUB_RUN_ID -and $value.run_attempt -eq 1 -and $env:GITHUB_RUN_ATTEMPT -ceq '1'
}else {
    $env:GITHUB_JOB -ceq 'native_windows' -and $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/[.]github/workflows/application-update-production[.]yml@refs/tags/[^/]+$'
}
if((@($value.PSObject.Properties.Name|Sort-Object)-join ',') -cne $recoveryKeys -or
    $value.original_owner_pid -lt 1 -or $value.original_owner_pid -gt [int]::MaxValue -or
    $value.original_owner_created_filetime -isnot [string] -or $value.original_owner_created_filetime -cnotmatch '^[1-9][0-9]{0,18}$' -or
    $value.binding -cnotmatch '^[a-f0-9]{64}$' -or $value.account_sid -cnotmatch '^S-1-5-21-[0-9-]+$' -or
    $value.description -cne ('Portcove hosted native '+$value.binding) -or $value.setup_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $value.broker_sid -or $value.account_sid -ceq $value.broker_sid -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    (-not $fixedRecoveryContext)){throw 'Original held recovery boundary differs'}
$original=$null
try{$original=[Diagnostics.Process]::GetProcessById([int]$value.original_owner_pid)}catch [ArgumentException]{$original=$null}
if($original){try{if($original.StartTime.ToFileTimeUtc().ToString() -ceq $value.original_owner_created_filetime){throw 'Original owner is still live; no competing recovery'}}finally{$original.Dispose()}}
$setup=Join-Path $PSScriptRoot 'release-hosted-native-windows-setup.cs.txt'
$setupBytes=Read-RecoveryBytes $setup 131072
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($setupBytes)).ToLowerInvariant() -cne $value.setup_sha256){throw 'Original recovery helper changed'}
Add-Type -TypeDefinition $recoveryUtf8.GetString($setupBytes)
if($Diagnostic){if(-not [Portcove.HostedNative.HostedDesktop]::HostedDiagnosticRecoveryAuthorized){throw 'Diagnostic recovery helper authority remains held'}}
elseif(-not [Portcove.HostedNative.HostedDesktop]::HostedCandidateRecoveryAuthorized){throw 'Original recovery helper authority remains held'}
$account=Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($value.account_sid)) -ErrorAction Stop
if($account.Name -cne 'PortcoveNativeQual' -or $account.Description -cne $value.description){throw 'Original recovery account identity differs; no adoption'}
Disable-LocalUser -SID $account.SID
$after=Get-LocalUser -SID $account.SID
if($after.Enabled -or $after.Description -cne $value.description){throw 'Original account disable readback differs'}
$restored=$null
if($null -ne $value.station){
    if((@($value.station.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'before_base64,proposed_base64' -or
        $value.station.before_base64.Length -gt 21848 -or $value.station.proposed_base64.Length -gt 21848){throw 'Original station recovery preimages exceed bound'}
    $before=[Convert]::FromBase64String($value.station.before_base64);$proposed=[Convert]::FromBase64String($value.station.proposed_base64)
    $restored=if($Diagnostic){[Portcove.HostedNative.HostedDesktop]::RecoverOriginalDiagnosticStation($before,$proposed,$value.broker_sid,$value.account_sid)}else{[Portcove.HostedNative.HostedDesktop]::RecoverOriginalStation($before,$proposed,$value.broker_sid,$value.account_sid)}
}
$record=[ordered]@{binding=$value.binding;account_sid=$value.account_sid;disabled=$true;station_restored=$restored;authority='none';scope='exact original disabled account and compare-before-restore only; no native acceptance'}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress))
$stream=[IO.FileStream]::new((Join-Path $PSScriptRoot 'recovery-result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
