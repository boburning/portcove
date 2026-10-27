param([Parameter(Mandatory)][string]$Context,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$hostedRecoveryExecutionAuthorized=$false
if(-not $hostedRecoveryExecutionAuthorized){throw 'Hosted original-session recovery awaits separate owner authority'}
$item=Get-Item -LiteralPath $Context -Force
if($item.PSIsContainer -or $item.Length -lt 2 -or $item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $Context -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256){throw 'Original recovery input changed'}
$value=Get-Content -LiteralPath $Context -Raw|ConvertFrom-Json
if((@($value.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'account_sid,binding,broker_sid,description,original_owner_created_filetime,original_owner_pid,setup_sha256,station' -or
    $value.original_owner_pid -lt 1 -or $value.original_owner_pid -gt [int]::MaxValue -or
    $value.original_owner_created_filetime -isnot [string] -or $value.original_owner_created_filetime -cnotmatch '^[1-9][0-9]{0,18}$' -or
    $value.binding -cnotmatch '^[a-f0-9]{64}$' -or $value.account_sid -cnotmatch '^S-1-5-21-[0-9-]+$' -or
    $value.description -cne ('Portcove hosted native '+$value.binding) -or $value.setup_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $value.broker_sid -or $value.account_sid -ceq $value.broker_sid -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:GITHUB_JOB -cne 'native_windows' -or $env:GITHUB_WORKFLOW_REF -cnotmatch '^boburning/portcove/[.]github/workflows/application-update-production[.]yml@refs/tags/[^/]+$'){throw 'Original held recovery boundary differs'}
$original=$null
try{$original=[Diagnostics.Process]::GetProcessById([int]$value.original_owner_pid)}catch [ArgumentException]{}
if($original){try{if($original.StartTime.ToFileTimeUtc().ToString() -ceq $value.original_owner_created_filetime){throw 'Original owner is still live; no competing recovery'}}finally{$original.Dispose()}}
$setup=Join-Path $PSScriptRoot 'release-hosted-native-windows-setup.cs.txt'
if((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $value.setup_sha256){throw 'Original recovery helper changed'}
Add-Type -TypeDefinition (Get-Content -LiteralPath $setup -Raw)
if(-not [Portcove.HostedNative.HostedDesktop]::HostedCandidateRecoveryAuthorized){throw 'Original recovery helper authority remains held'}
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
    $restored=[Portcove.HostedNative.HostedDesktop]::RecoverOriginalStation($before,$proposed,$value.broker_sid,$value.account_sid)
}
$record=[ordered]@{binding=$value.binding;account_sid=$value.account_sid;disabled=$true;station_restored=$restored;authority='none';scope='exact original disabled account and compare-before-restore only; no native acceptance'}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress))
$stream=[IO.FileStream]::new((Join-Path $PSScriptRoot 'recovery-result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
