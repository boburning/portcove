#requires -Version 7.4
# Fixed recovery for the October 22 pre-account password-bounds failure only.
# No deletion, reset, adoption, credential write, enable or automatic retry.
[CmdletBinding()]
param([switch]$ExecuteApprovedArchiveAndCreate)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Read-RecoveryFile([string]$Path,[string]$Sha256,[long]$Length){
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $Length){throw 'Recovery file kind/length differs'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length -ne $Length -or $Length -gt 65536){throw 'Recovery file size differs'}
        $bytes=[byte[]]::new([int]$Length+1);$count=0
        while(($n=$stream.Read($bytes,$count,$bytes.Length-$count)) -gt 0){$count+=$n;if($count -gt $Length){throw 'Recovery file overflow'}}
        if($count -ne $Length){throw 'Recovery file truncated'}
        $raw=[byte[]]$bytes[0..($count-1)]
        if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant() -cne $Sha256){throw 'Recovery file identity differs'}
        return ,$raw
    }finally{$stream.Dispose()}
}
function Assert-RecoveryDirectory([string]$Path,[string]$Broker){
    $trusted=@($Broker,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $cursor=[IO.Path]::GetFullPath($Path);$depth=0
    while($cursor){
        if(++$depth -gt 64){throw 'Recovery ancestry exceeds bound'}
        $item=Get-Item -LiteralPath $cursor -Force
        if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Recovery ancestor kind differs'}
        $acl=Get-Acl -LiteralPath $cursor
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Recovery ancestor owner differs'}
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            $replace=[int64]0x10000000 -bor [int64][Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
            if($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([int64]$rule.FileSystemRights -band $replace) -and $rule.IdentityReference.Value -notin $trusted){throw 'Recovery ancestor permits foreign replacement'}
        }
        if($cursor -ceq [IO.Path]::GetFullPath($Path)){
            if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Broker){throw 'Recovery leaf custody differs'}
            foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
                if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($Broker,'S-1-5-18')){throw 'Recovery leaf has foreign access'}
            }
        }
        $next=[IO.Path]::GetDirectoryName($cursor);if($next -eq $cursor){break};$cursor=$next
    }
}
function Assert-RecoveryAbsent([string]$Path){
    try{$null=[IO.File]::GetAttributes($Path)}catch [IO.FileNotFoundException]{return}catch [IO.DirectoryNotFoundException]{return}
    throw 'Recovery destination or profile already exists'
}
function Assert-EmptyRecoveryContents([string]$Root,[IO.FileStream]$HeldLock=$null){
    $entries=@(Get-ChildItem -LiteralPath $Root -Force)
    if($entries.Count -ne 3 -or (@($entries.Name|Sort-Object)-join ',') -cne 'account-0-intent.json,intent.json,setup.lock'){throw 'Empty recovery namespace differs'}
    foreach($entry in $entries){
        $links=if($entry.Name -ceq 'setup.lock' -and $HeldLock){[PortcoveEmptyRecoveryIdentity]::HandleLinks($HeldLock.SafeFileHandle)}else{[PortcoveEmptyRecoveryIdentity]::Links($entry.FullName)}
        if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $links -ne 1){throw 'Empty recovery leaf is redirected or multiply linked'}
    }
    $null=Read-RecoveryFile (Join-Path $Root 'intent.json') '0358ba728d11d88b706ee73d206b989779c1da376a5eec18a6d3ee5c7c2a5c0f' 470
    $null=Read-RecoveryFile (Join-Path $Root 'account-0-intent.json') '488d26c546b18fe005fbd5d94753f2520a9c9e514b0d1e9ce6a9dbb1a996ddf6' 135
    if((Get-Item -LiteralPath (Join-Path $Root 'setup.lock')).Length -ne 0){throw 'Original lock bytes differ'}
}
function Assert-NoWorkerAccountsOrProfiles {
    $names=@('PortcoveNativeQual','PortcovePublicProof')
    $users=@(Get-LocalUser -ErrorAction Stop)
    if($users.Count -gt 1024 -or @($users|Where-Object Name -In $names).Count){throw 'Worker account exists or provider inventory exceeds bound'}
    foreach($name in $names){Assert-RecoveryAbsent ('C:\Users\'+$name)}
    $profiles=@(Get-ChildItem -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop)
    if($profiles.Count -gt 1024){throw 'Profile inventory exceeds bound'}
    foreach($profileItem in $profiles){
        $record=Get-ItemProperty -LiteralPath $profileItem.PSPath -ErrorAction Stop
        if($record.PSObject.Properties.Name -contains 'ProfileImagePath'){
            $image=[Environment]::ExpandEnvironmentVariables([string]$record.ProfileImagePath)
            foreach($name in $names){if($image -ieq ('C:\Users\'+$name) -or $image.StartsWith(('C:\Users\'+$name+'.'),[StringComparison]::OrdinalIgnoreCase)){throw 'Worker profile registration exists'}}
        }
    }
    $processes=@(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe' OR Name = 'powershell.exe'" -ErrorAction Stop)
    if($processes.Count -gt 1024){throw 'PowerShell process inventory exceeds bound'}
    foreach($process in $processes){
        if($process.ProcessId -eq $PID){continue}
        if(-not $process.CommandLine){throw ('PowerShell process command is unavailable for PID '+$process.ProcessId+'; no mutation')}
        if($process.CommandLine -match '(?i)(?:^|[\\/\s"''])accounts\.ps1(?:[\s"'']|$)'){throw 'Account helper process is still present'}
    }
}
function Move-EmptyRecovery([string]$Root,[string]$Archive,[string]$Intent,[string]$Broker){
    if([IO.Path]::GetDirectoryName($Root) -cne [IO.Path]::GetDirectoryName($Archive)){throw 'Recovery archive must be an exact same-parent rename'}
    Assert-RecoveryAbsent $Archive
    Assert-RecoveryAbsent $Intent
    Assert-RecoveryAbsent ($Intent+'.lock')
    $lock=[IO.File]::Open((Join-Path $Root 'setup.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Delete)
    $recoveryLock=$null
    try{
        Assert-RecoveryDirectory $Root $Broker
        Assert-EmptyRecoveryContents $Root $lock
        Assert-NoWorkerAccountsOrProfiles
        $before=(Get-Acl -LiteralPath $Root).Sddl
        $originalIntent=[Text.UTF8Encoding]::new($false,$true).GetString((Read-RecoveryFile (Join-Path $Root 'intent.json') '0358ba728d11d88b706ee73d206b989779c1da376a5eec18a6d3ee5c7c2a5c0f' 470))|ConvertFrom-Json -Depth 6
        if($originalIntent.root_sddl -cne $before){throw 'Original root ACL preimage differs'}
        $recoveryLock=[IO.File]::Open(($Intent+'.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        Write-NewJson $Intent @{schema_version=1;original=$Root;archive=$Archive;broker_sid=$Broker;root_sddl=$before;helper_sha256='ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10';plan_sha256='67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b';account_effects='both absent before archive';automatic_retry=$false}
        Assert-EmptyRecoveryContents $Root $lock
        Assert-NoWorkerAccountsOrProfiles
        # Windows refuses parent-directory rename with this child handle open,
        # even with FileShare.Delete. Hand off to the retained bootstrap lock.
        $lock.Dispose();$lock=$null
        [IO.Directory]::Move($Root,$Archive)
        if(Test-Path -LiteralPath $Root){throw 'Original path remains; retain and read back'}
        Assert-RecoveryDirectory $Archive $Broker
        Assert-EmptyRecoveryContents $Archive
        if((Get-Acl -LiteralPath $Archive).Sddl -cne $before){throw 'Archived ACL differs'}
        Assert-NoWorkerAccountsOrProfiles
        # Caller retains the separate exclusive recovery lock through the child.
        return $recoveryLock
    }catch{if($recoveryLock){$recoveryLock.Dispose()};throw}finally{if($lock){$lock.Dispose()}}
}
function Invoke-FreshAccountSetup([string]$Helper,[string]$Plan,[string]$Bootstrap,[string]$Archive){
    # Preserve the child outcome even in a caller that treats native exits as errors.
    $PSNativeCommandUseErrorActionPreference=$false
    Assert-RecoveryAbsent (Join-Path $Bootstrap 'empty-setup-recovery-result-20261022.json')
    Write-Information 'Previous failed attempt retained. Enter a new password at each prompt; typing is hidden. An empty entry is refused. Each password must contain 1-256 characters and satisfy Windows policy.' -InformationAction Continue
    & "$PSHOME\pwsh.exe" -NoProfile -File $Helper -Mode create -Plan $Plan -PlanSha256 67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b
    $childExit=$LASTEXITCODE
    Write-NewJson (Join-Path $Bootstrap 'empty-setup-recovery-result-20261022.json') @{schema_version=1;archive=$Archive;child_exit=$childExit;automatic_retry=$false;backing_records_retained=$true}
    if($childExit -ne 0){throw 'Fresh setup failed; preserve both attempts and copy the first child error above. No retry.'}
    [pscustomobject]@{archive_retained=$Archive;child_exit=$childExit;accounts='created disabled; ordinary credential/readback stage still required';automatic_retry=$false}|ConvertTo-Json
}

if(-not $IsWindows -or $PSVersionTable.PSEdition -cne 'Core'){throw 'Windows PowerShell 7.4+ required'}
$broker='S-1-5-21-1007133822-4277289207-646028416-1001'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -cne $broker){throw 'Appointed same-owner broker required'}
if($ExecuteApprovedArchiveAndCreate -and -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'One-time same-owner elevation required'}
$bootstrap='C:\ProgramData\PortcoveSlice4Bootstrap'
$root='C:\ProgramData\PortcoveNativeQualification'
$archive='C:\ProgramData\PortcoveNativeQualification.retained-20261022-password-bounds'
$intent=Join-Path $bootstrap 'empty-setup-recovery-20261022.json'
$helper=Join-Path $bootstrap 'accounts.ps1';$plan=Join-Path $bootstrap 'accounts.json'
Assert-RecoveryDirectory $bootstrap $broker
$source=Read-RecoveryFile $helper 'ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10' 33482
$null=Read-RecoveryFile $plan '67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b' 149
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Verified helper parse failed'}
$writer=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-NewJson'},$true)
if(-not $writer){throw 'Verified receipt writer missing'}
. ([scriptblock]::Create($writer.Extent.Text))
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PortcoveEmptyRecoveryIdentity {
  [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  public static uint HandleLinks(SafeFileHandle handle){Info info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception();return info.links;}
  public static uint Links(string path){using(var stream=System.IO.File.Open(path,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.ReadWrite|System.IO.FileShare.Delete)){return HandleLinks(stream.SafeFileHandle);}}
}
'@
Assert-RecoveryAbsent (Join-Path $bootstrap 'empty-setup-recovery-result-20261022.json')
if(-not $ExecuteApprovedArchiveAndCreate){
    Assert-RecoveryAbsent $archive;Assert-RecoveryAbsent $intent;Assert-RecoveryAbsent ($intent+'.lock')
    $readLock=[IO.File]::Open((Join-Path $root 'setup.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Delete)
    try{
        Assert-RecoveryDirectory $root $broker;Assert-EmptyRecoveryContents $root $readLock
        $originalIntent=[Text.UTF8Encoding]::new($false,$true).GetString((Read-RecoveryFile (Join-Path $root 'intent.json') '0358ba728d11d88b706ee73d206b989779c1da376a5eec18a6d3ee5c7c2a5c0f' 470))|ConvertFrom-Json -Depth 6
        if($originalIntent.root_sddl -cne (Get-Acl -LiteralPath $root).Sddl){throw 'Original root ACL preimage differs'}
        Assert-NoWorkerAccountsOrProfiles
    }finally{$readLock.Dispose()}
    [pscustomobject]@{observed_at=[DateTimeOffset]::UtcNow.ToString('o');eligible_for_proposed_recovery=$true;mutations='none';archive=$archive;automatic_retry=$false}|ConvertTo-Json
    return
}
$held=$null;$sourceLock=$null;$planLock=$null
try{
    $held=Move-EmptyRecovery $root $archive $intent $broker
    $sourceLock=[IO.File]::Open($helper,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $planLock=[IO.File]::Open($plan,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $null=Read-RecoveryFile $helper 'ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10' 33482
    $null=Read-RecoveryFile $plan '67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b' 149
    Invoke-FreshAccountSetup $helper $plan $bootstrap $archive
}finally{if($planLock){$planLock.Dispose()};if($sourceLock){$sourceLock.Dispose()};if($held){$held.Dispose()}}
