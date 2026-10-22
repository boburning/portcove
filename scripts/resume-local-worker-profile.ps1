#requires -Version 7.4
# Exact continuation of the recorded October 22 disabled-account profile failure.
# No account reset/removal, account-0 password/group replay, enable or retry.
[CmdletBinding()]
param([ValidateSet('Inspect','Complete','Readback')][string]$Operation='Inspect')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Open-ProfileResumeSource([byte[]]$Bytes,[string]$Sha256,[string]$Broker){
    if($Bytes.Length -lt 1 -or $Bytes.Length -gt 65536 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() -cne $Sha256){throw 'Bounded reviewed source bytes differ'}
    $path='C:\ProgramData\PortcoveSlice4Bootstrap\profile-resume.ps1'
    Assert-RecoveryDirectory ([IO.Path]::GetDirectoryName($path)) $Broker
    $security=[Security.AccessControl.FileSecurity]::new();$security.SetOwner([Security.Principal.SecurityIdentifier]::new($Broker));$security.SetAccessRuleProtection($true,$false)
    foreach($sid in @($Broker,'S-1-5-18')){$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))}
    $exists=$true;try{$null=[IO.File]::GetAttributes($path)}catch [IO.FileNotFoundException]{$exists=$false}
    $held=$null
    try{
        if($exists){$held=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
        else{
            $write=[IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($path),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security)
            try{$write.Write($Bytes);$write.Flush($true)}finally{$write.Dispose()}
            $held=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        }
        if([PortcoveEmptyRecoveryIdentity]::HandleLinks($held.SafeFileHandle) -ne 1){throw 'Protected source is multiply linked'}
        $null=Read-RecoveryFile $path $Sha256 $Bytes.Length
        if((Get-SetupAclIdentity (Get-Acl -LiteralPath $path)) -cne (Get-SetupAclIdentity $security)){throw 'Protected source ACL differs'}
        return $held
    }catch{if($held){$held.Dispose()};throw}
}
function Get-SetupAclIdentity($Acl){
    $raw=[Security.AccessControl.RawSecurityDescriptor]::new($Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access'))
    $raw.SetFlags($raw.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
    return $raw.GetSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')
}
function Get-ResumePrograms([string]$Original){
    $tokens=$null;$errors=$null
    $tree=[Management.Automation.Language.Parser]::ParseInput($Original,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Original template parse failed'}
    $loops=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.ForStatementAst] -and $n.Body.Extent.Text.Contains('Initial password for $name')},$true))
    if($loops.Count -ne 1){throw 'Original account loop inventory differs'}
    $loop=$loops[0]
    $body=$loop.Body.Extent.Text.Substring(1,$loop.Body.Extent.Text.Length-2)
    $marker='$createdProfile=[PortcoveAccountSetup]::Profile($user.SID.Value,$name)'
    if(($body.Split($marker,[StringSplitOptions]::None)).Count -ne 2){throw 'Original profile continuation boundary differs'}
    $create=$loop.Parent.Parent
    if($create -isnot [Management.Automation.Language.IfStatementAst]){throw 'Original create boundary differs'}
    $returns=@($create.Clauses[0].Item2.Statements|Where-Object {$_ -is [Management.Automation.Language.ReturnStatementAst]})
    if($returns.Count -ne 1){throw 'Original completion boundary differs'}
    $tail=$Original.Substring($loop.Extent.EndOffset,$returns[0].Extent.StartOffset-$loop.Extent.EndOffset)
    $receipt='source_sha256=$source;accounts=$accounts;'
    if(($tail.Split($receipt,[StringSplitOptions]::None)).Count -ne 2){throw 'Original completion receipt boundary differs'}
    $tail=$tail.Replace($receipt,'source_sha256=$source;continuation=$continuation;accounts=$accounts;')
    $assignments=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$interop'},$true))
    if($assignments.Count -ne 1){throw 'Original interop inventory differs'}
    $literal=$assignments[0].Right.Expression
    if($literal -isnot [Management.Automation.Language.StringConstantExpressionAst] -or $literal.StringConstantType -ne [Management.Automation.Language.StringConstantType]::SingleQuotedHereString){throw 'Original interop is not a literal'}
    $interop=$literal.Value
    if(($interop.Split('new StringBuilder(32768)',[StringSplitOptions]::None)).Count -ne 2){throw 'Original profile buffer differs'}
    $aclNode=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Set-ExactDirectoryAcl'},$true)
    $comparison='$observed.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]''Owner,Access'') -cne $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]''Owner,Access'')'
    if(($aclNode.Extent.Text.Split($comparison,[StringSplitOptions]::None)).Count -ne 2){throw 'Original ACL comparison differs'}
    $aclProgram=$aclNode.Extent.Text.Replace($comparison,'(Get-SetupAclIdentity $observed) -cne (Get-SetupAclIdentity $acl)')
    $aclWrite='Set-Acl -LiteralPath $Path -AclObject $acl'
    if(($aclProgram.Split($aclWrite,[StringSplitOptions]::None)).Count -ne 2){throw 'Original ACL write differs'}
    $aclProgram=$aclProgram.Replace($aclWrite,'[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$acl)')
    $keysNode=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-Keys'},$true)
    $keyRead='$Value.PSObject.Properties.Name'
    if(($keysNode.Extent.Text.Split($keyRead,[StringSplitOptions]::None)).Count -ne 2){throw 'Original key validation differs'}
    $keysProgram=$keysNode.Extent.Text.Replace($keyRead,'$(if($Value -is [Collections.IDictionary]){$Value.Keys}else{$Value.PSObject.Properties.Name})')
    return @{keys=$keysProgram;acl=$aclProgram;tree=$tree;body=$body;suffix=$body.Substring($body.IndexOf($marker,[StringComparison]::Ordinal));tail=$tail;interop=$interop.Replace('new StringBuilder(32768)','new StringBuilder(260)')}
}
function Assert-ResumeProvider {
    $users=@(Get-LocalUser -ErrorAction Stop)
    if($users.Count -gt 1024){throw 'Account inventory exceeds bound'}
    $owned=@($users|Where-Object Name -EQ 'PortcoveNativeQual')
    if($owned.Count -ne 1 -or @($users|Where-Object Name -EQ 'PortcovePublicProof').Count){throw 'Fixed account inventory differs'}
    $user=$owned[0]
    if($user.SID.Value -cne 'S-1-5-21-1007133822-4277289207-646028416-1008' -or $user.Description -cne 'PC534:67c28f511ddb23f6826d7025e8bc0127' -or $user.Enabled -or $user.UserMayChangePassword -or $null -ne $user.PasswordExpires -or $null -ne $user.AccountExpires){throw 'Recorded disabled account identity/policy differs'}
    $memberships=@()
    foreach($group in @(Get-LocalGroup -ErrorAction Stop)){
        $members=@(Get-LocalGroupMember -SID $group.SID -ErrorAction Stop)
        if($members.Count -gt 1024){throw 'Group inventory exceeds bound'}
        if(@($members|Where-Object {$_.SID.Value -ceq $user.SID.Value}).Count){$memberships+=,$group.SID.Value}
    }
    if($memberships.Count -ne 1 -or $memberships[0] -cne 'S-1-5-32-545'){throw 'Recorded account group membership differs'}
    foreach($name in @('PortcoveNativeQual','PortcovePublicProof')){Assert-RecoveryAbsent ('C:\Users\'+$name)}
    $profiles=@(Get-ChildItem -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop)
    if($profiles.Count -gt 1024){throw 'Profile inventory exceeds bound'}
    foreach($profileItem in $profiles){
        if($profileItem.PSChildName -ceq $user.SID.Value){throw 'Recorded account profile registration exists'}
        $row=Get-ItemProperty -LiteralPath $profileItem.PSPath -ErrorAction Stop
        if($row.PSObject.Properties.Name -contains 'ProfileImagePath'){
            $path=[Environment]::ExpandEnvironmentVariables([string]$row.ProfileImagePath)
            foreach($name in @('PortcoveNativeQual','PortcovePublicProof')){if($path -ieq ('C:\Users\'+$name) -or $path.StartsWith(('C:\Users\'+$name+'.'),[StringComparison]::OrdinalIgnoreCase)){throw 'Fixed or suffixed profile registration exists'}}
        }
    }
    return $user
}
function Get-ResumePreimage {
    $expected=@{
        'intent.json'=@(470,'e85e68d55f490ae3023666cfdb66359cccb6a57d2704f8d17c690f5b89f6d52e')
        'account-0-intent.json'=@(135,'5e3506d07d7af8373d9be17c13744e302daa7d51e8e29981994130c5a0fc2d2f')
        'account-0-created.json'=@(311,'59ad70147db00ed17d3418732f600f8bcd9ba479bdaca75775753e17279905ed')
        'account-0-group-intent.json'=@(172,'cb2a7c18514a6de67102e092cd812adc0e72fe30c832b1b2c96d5c93debba5c0')
        'account-0-group.json'=@(135,'89981af03c283b12f28f68487515e22a90c2bf2415bbd43e6641f8764377b37b')
    }
    return $expected
}
function Assert-ResumePreimage([string]$Root,$Recorded=$null){
    $expected=Get-ResumePreimage
    if($null -ne $Recorded){
        Assert-Keys $Recorded @($expected.Keys)
        foreach($name in $expected.Keys){if(@($Recorded.$name).Count -ne 2 -or $Recorded.$name[0] -ne $expected[$name][0] -or $Recorded.$name[1] -cne $expected[$name][1]){throw 'Recorded continuation preimage differs'}}
    }
    foreach($name in $expected.Keys){
        $file=Join-Path $Root $name
        if([PortcoveEmptyRecoveryIdentity]::Links($file) -ne 1){throw 'Original prefix record is multiply linked'}
        $null=Read-RecoveryFile $file $expected[$name][1] $expected[$name][0]
    }
}
function Assert-ResumeSnapshot([string]$Root,[string]$Broker,[IO.FileStream]$Lock){
    Assert-RecoveryDirectory $Root $Broker
    $expected=Get-ResumePreimage
    $entries=@(Get-ChildItem -LiteralPath $Root -Force)
    if($entries.Count -ne 6 -or (($entries.Name|Sort-Object)-join ',') -cne ((@($expected.Keys)+@('setup.lock')|Sort-Object)-join ',')){throw 'Partial setup namespace differs'}
    foreach($entry in $entries){
        $links=if($entry.Name -ceq 'setup.lock'){[PortcoveEmptyRecoveryIdentity]::HandleLinks($Lock.SafeFileHandle)}else{[PortcoveEmptyRecoveryIdentity]::Links($entry.FullName)}
        if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $links -ne 1){throw 'Partial setup leaf is redirected or multiply linked'}
    }
    if($Lock.Length -ne 0){throw 'Setup lock differs'}
    foreach($name in $expected.Keys){$null=Read-RecoveryFile (Join-Path $Root $name) $expected[$name][1] $expected[$name][0]}
    $intent=(Read-BoundedJson (Join-Path $Root 'intent.json')).value
    if((Get-Acl -LiteralPath $Root).Sddl -cne $intent.root_sddl){throw 'Original root ACL differs'}
    $null=Assert-ResumeProvider
    return $expected
}
function Invoke-ResumePrograms($Programs,$ExistingUser,[string]$Root,[string]$Broker,[string]$PlanSha256,$Continuation){
    $source='ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10'
    $names=@('PortcoveNativeQual','PortcovePublicProof');$accounts=@();$description=$ExistingUser.Description
    if($source -cne $Continuation.original_template_sha256 -or $description -cne 'PC534:'+$PlanSha256.Substring(0,32)){throw 'Original template context differs'}
    for($index=0;$index -lt 2;$index++){
        if($index -eq 0){$name=$names[0];$user=$ExistingUser;if($name -cne $user.Name -or $user.Enabled){throw 'Recorded continuation account differs'};. ([scriptblock]::Create($Programs.suffix))}
        else{. ([scriptblock]::Create($Programs.body))}
    }
    if($accounts.Count -ne 2 -or $accounts[0].sid -cne $ExistingUser.SID.Value -or $accounts[1].name -cne 'PortcovePublicProof'){throw 'Completed loop account identities differ'}
    . ([scriptblock]::Create($Programs.tail))
}
function Assert-ResumeCompletion([string]$Root,[string]$Bootstrap,[string]$ResumeSource){
    Assert-SetupRoot $Root $broker
    $intent=Read-BoundedJson (Join-Path $Bootstrap 'profile-resume-intent-20261022.json')
    $complete=Read-BoundedJson (Join-Path $Bootstrap 'profile-resume-complete-20261022.json')
    $created=Read-BoundedJson (Join-Path $Root 'created.json')
    Assert-Keys $intent.value @('schema_version','continuation','preimage','automatic_retry')
    Assert-Keys $complete.value @('schema_version','actual_continuation_sha256','intent_sha256','created_sha256','automatic_retry','accounts_remain_disabled')
    Assert-Keys $created.value @('schema_version','plan_sha256','source_sha256','continuation','accounts','acl_postimages','enabled')
    if($intent.value.schema_version -ne 1 -or $complete.value.schema_version -ne 1 -or $created.value.schema_version -ne 1 -or $intent.value.automatic_retry -ne $false -or $complete.value.automatic_retry -ne $false -or $complete.value.accounts_remain_disabled -ne $true -or $created.value.enabled -ne $false -or $created.value.plan_sha256 -cne '67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b'){throw 'Completion scope differs'}
    Assert-Keys $created.value.continuation @('kind','actual_continuation_sha256','original_template_sha256','original_intent_sha256','owned_account_sid','profile_buffer_characters')
    Assert-Keys $intent.value.continuation @('kind','actual_continuation_sha256','original_template_sha256','original_intent_sha256','owned_account_sid','profile_buffer_characters')
    foreach($key in $created.value.continuation.PSObject.Properties.Name){if($created.value.continuation.$key -cne $intent.value.continuation.$key){throw 'Intent/completion execution identity differs'}}
    if($created.value.continuation.kind -cne 'exact-recorded-profile-continuation-v1'){throw 'Unknown continuation kind'}
    Assert-ResumePreimage $Root $intent.value.preimage
    if($intent.value.continuation.actual_continuation_sha256 -cne $ResumeSource -or $complete.value.actual_continuation_sha256 -cne $ResumeSource -or $complete.value.intent_sha256 -cne $intent.sha256 -or $complete.value.created_sha256 -cne $created.sha256 -or $created.value.continuation.actual_continuation_sha256 -cne $ResumeSource -or $created.value.continuation.original_template_sha256 -cne $created.value.source_sha256 -or $created.value.source_sha256 -cne 'ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10' -or $created.value.continuation.original_intent_sha256 -cne 'e85e68d55f490ae3023666cfdb66359cccb6a57d2704f8d17c690f5b89f6d52e' -or $created.value.continuation.owned_account_sid -cne 'S-1-5-21-1007133822-4277289207-646028416-1008' -or $created.value.continuation.profile_buffer_characters -ne 260){throw 'Composite setup completion differs'}
    if(@($created.value.accounts).Count -ne 2 -or $created.value.accounts[0].sid -cne 'S-1-5-21-1007133822-4277289207-646028416-1008'){throw 'Completed account order/identity differs'}
    for($index=0;$index -lt 2;$index++){
        if($created.value.accounts[$index].name -cne @('PortcoveNativeQual','PortcovePublicProof')[$index] -or (Assert-Account $created.value.accounts[$index]).Enabled){throw 'Completed account is not exact and disabled'}
    }
    foreach($post in $created.value.acl_postimages){if((Get-Acl -LiteralPath $post.path).Sddl -cne $post.sddl){throw 'Completion ACL drifted'}}
    return @{completed=$true;accounts_remain_disabled=$true;created_sha256=$created.sha256;actual_continuation_sha256=$ResumeSource;original_template_sha256=$created.value.source_sha256;automatic_retry=$false}
}
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

if(-not $IsWindows){throw 'Windows required'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$broker='S-1-5-21-1007133822-4277289207-646028416-1001'
if($identity.User.Value -cne $broker){throw 'Appointed same-owner broker required'}
if($Operation -eq 'Complete' -and -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'One-time same-owner elevation required'}
$bootstrap='C:\ProgramData\PortcoveSlice4Bootstrap';$root='C:\ProgramData\PortcoveNativeQualification'
if($Operation -eq 'Complete' -and [IO.Path]::GetFullPath($PSCommandPath) -cne 'C:\ProgramData\PortcoveSlice4Bootstrap\profile-resume.ps1'){throw 'Complete requires the reviewed protected C: source'}
$PlanSha256='67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b'
Assert-RecoveryDirectory $bootstrap $broker
$resumeSource=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceLock=[IO.File]::Open((Join-Path $bootstrap 'accounts.ps1'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$planLock=$null;$held=$null
try{
    $original=Read-RecoveryFile (Join-Path $bootstrap 'accounts.ps1') 'ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10' 33482
    $planLock=[IO.File]::Open((Join-Path $bootstrap 'accounts.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $null=Read-RecoveryFile (Join-Path $bootstrap 'accounts.json') $PlanSha256 149
    $programs=Get-ResumePrograms ([Text.UTF8Encoding]::new($false,$true).GetString($original))
    foreach($node in $programs.tree.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($node.Extent.Text))}
    . ([scriptblock]::Create($programs.acl))
    . ([scriptblock]::Create($programs.keys))
    Add-Type -TypeDefinition $programs.interop
    Assert-SetupRoot $root $broker
    Assert-Ancestry 'C:\Users' $broker
    $held=Open-SetupLock $root $broker $false ($Operation -ne 'Complete')
    if($Operation -eq 'Readback'){Assert-ResumeCompletion $root $bootstrap $resumeSource|ConvertTo-Json -Depth 8;return}
    foreach($leaf in @('profile-resume-intent-20261022.json','profile-resume-complete-20261022.json')){Assert-RecoveryAbsent (Join-Path $bootstrap $leaf)}
    $snapshot=Assert-ResumeSnapshot $root $broker $held
    $continuation=@{kind='exact-recorded-profile-continuation-v1';actual_continuation_sha256=$resumeSource;original_template_sha256='ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10';original_intent_sha256='e85e68d55f490ae3023666cfdb66359cccb6a57d2704f8d17c690f5b89f6d52e';owned_account_sid='S-1-5-21-1007133822-4277289207-646028416-1008';profile_buffer_characters=260}
    if($Operation -eq 'Inspect'){@{eligible_for_completion=$true;account0='recorded-disabled-password-unchanged';profile0='absent';account1='absent';mutations='none'}|ConvertTo-Json;return}
    Write-NewJson (Join-Path $bootstrap 'profile-resume-intent-20261022.json') @{schema_version=1;continuation=$continuation;preimage=$snapshot;automatic_retry=$false}
    Invoke-ResumePrograms $programs (Assert-ResumeProvider) $root $broker $PlanSha256 $continuation
    Assert-ResumePreimage $root
    $created=Read-BoundedJson (Join-Path $root 'created.json')
    $resumeIntent=Read-BoundedJson (Join-Path $bootstrap 'profile-resume-intent-20261022.json')
    Write-NewJson (Join-Path $bootstrap 'profile-resume-complete-20261022.json') @{schema_version=1;actual_continuation_sha256=$resumeSource;intent_sha256=$resumeIntent.sha256;created_sha256=$created.sha256;automatic_retry=$false;accounts_remain_disabled=$true}
    Assert-ResumeCompletion $root $bootstrap $resumeSource|ConvertTo-Json -Depth 8
}finally{if($held){$held.Dispose()};if($planLock){$planLock.Dispose()};$sourceLock.Dispose()}