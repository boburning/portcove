#requires -Version 7.4
# One-time conditional setup only. Never called by a candidate or scheduled worker.
# Plan: {"schema_version":1,"broker_sid":"<appointed actual broker SID>",
#        "root":"C:\\ProgramData\\PortcoveNativeQualification"} (UTF-8, pinned raw SHA256).
# Under the future consolidated setup grant, from the protected independent C: source:
#   pwsh -NoProfile -File THIS.ps1 -Mode create -Plan PLAN.json -PlanSha256 SHA
# Run create as the SAME broker via UAC; then credentials/readback unelevated.
# Complete all separate protected source/config/task/WSL readbacks before enable.
# Enable is explicit, elevated same broker, additionally requiring raw hashes of
# created.json and credentials-complete.json. It does not certify those other readbacks.
# disable is the only recovery mutation: exact recorded SIDs, no delete/ACL restore.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('create','credentials','readback','enable','disable')][string]$Mode,
    [Parameter(Mandatory)][string]$Plan,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$CreatedSha256,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$BrokerReceiptSha256
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Read-BoundedJson([string]$Path,[int]$Limit=65536) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor){
        $entry=Get-Item -LiteralPath $cursor -Force
        if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Setup path is aliased'}
        $next=[IO.Path]::GetDirectoryName($cursor);if($next -eq $cursor){break};$cursor=$next
    }
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if($stream.Length -lt 2 -or $stream.Length -gt $Limit){throw 'Setup JSON size differs'}
        $bytes=[byte[]]::new($Limit+1);$count=0
        while(($n=$stream.Read($bytes,$count,$bytes.Length-$count)) -gt 0){$count+=$n;if($count -gt $Limit){throw 'Setup JSON overflow'}}
        $raw=$bytes[0..($count-1)]
        $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
        $text=[Text.UTF8Encoding]::new($false,$true).GetString($raw)
        $document=[Text.Json.JsonDocument]::Parse($text)
        try{Assert-JsonNames $document.RootElement 0}finally{$document.Dispose()}
        return @{value=($text|ConvertFrom-Json);sha256=$hash}
    } finally {$stream.Dispose()}
}
function Assert-JsonNames($Element,[int]$Depth){
    if($Depth -gt 12){throw 'Setup JSON nesting exceeds bound'}
    if($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object){
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($property in $Element.EnumerateObject()){
            if(-not $seen.Add($property.Name)){throw 'Duplicate setup JSON field'}
            Assert-JsonNames $property.Value ($Depth+1)
        }
    } elseif($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array){foreach($child in $Element.EnumerateArray()){Assert-JsonNames $child ($Depth+1)}}
}
function Assert-Keys($Value,[string[]]$Names){
    if((@($Value.PSObject.Properties.Name|Sort-Object)-join ',') -cne (($Names|Sort-Object)-join ',')){throw 'Setup fields differ'}
}
function Assert-SetupPlan($Value){
    Assert-Keys $Value @('schema_version','broker_sid','root')
    if($Value.schema_version -isnot [long] -or $Value.schema_version -ne 1 -or $Value.root -isnot [string] -or $Value.root -cne 'C:\ProgramData\PortcoveNativeQualification' -or $Value.broker_sid -isnot [string] -or $Value.broker_sid -cnotmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$'){throw 'Fixed setup plan differs'}
}
function Write-NewJson([string]$Path,$Value){
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress)+"`n")
    if($bytes.Length -gt 65536){throw 'Setup receipt exceeds bound'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Assert-Ancestry([string]$Path,[string]$Broker){
    $allowed=@($Broker,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $replace=[Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    $cursor=[IO.Path]::GetFullPath($Path);$depth=0
    while($cursor){
        if(++$depth -gt 64){throw 'Setup ancestry exceeds bound'}
        $entry=Get-Item -LiteralPath $cursor -Force
        if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Setup ancestor kind differs'}
        $acl=Get-Acl -LiteralPath $cursor
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Setup ancestor owner differs'}
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -and $rule.IdentityReference.Value -notin $allowed){throw 'Setup ancestor permits foreign replacement'}
        }
        $next=[IO.Path]::GetDirectoryName($cursor);if($next -eq $cursor){break};$cursor=$next
    }
}
function Set-ExactDirectoryAcl([string]$Path,[string]$Broker,[string[]]$ReadSids=@(),[string]$ModifySid=''){
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($Broker));$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($Broker,'S-1-5-18')){
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    foreach($sid in $ReadSids){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))}
    if($ModifySid){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($ModifySid),'Modify','ContainerInherit,ObjectInherit','None','Allow'))}
    Set-Acl -LiteralPath $Path -AclObject $acl
    $observed=Get-Acl -LiteralPath $Path
    if($observed.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access') -cne $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')){throw 'Setup ACL readback differs'}
    return $observed.Sddl
}
function Assert-SetupRoot([string]$Root,[string]$Broker){
    Assert-Ancestry $Root $Broker
    $acl=Get-Acl -LiteralPath $Root
    if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Broker){throw 'Setup root custody differs'}
    $write=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin @($Broker,'S-1-5-18')){throw 'Setup records permit a foreign writer'}
    }
}
function Open-SetupLock([string]$Root,[string]$Broker,[bool]$Create,[bool]$ReadOnly=$false){
    $file=Join-Path $Root 'setup.lock'
    if(-not $Create){
        $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne 0 -or (Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Broker){throw 'Original owned setup lock differs'}
    }
    if($Create){
        # Appoint exact ownership and private access atomically at creation;
        # elevated token defaults can otherwise appoint Administrators as owner.
        $security=[Security.AccessControl.FileSecurity]::new()
        $security.SetOwner([Security.Principal.SecurityIdentifier]::new($Broker));$security.SetAccessRuleProtection($true,$false)
        foreach($sid in @($Broker,'S-1-5-18')){$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))}
        $stream=[IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($file),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security)
    }else{
        $access=if($ReadOnly){[IO.FileAccess]::Read}else{[IO.FileAccess]::ReadWrite}
        $stream=[IO.File]::Open($file,[IO.FileMode]::Open,$access,[IO.FileShare]::None)
    }
    try{
        if($Create){$stream.Flush($true)}
        $again=Get-Item -LiteralPath $file -Force
        if($again.PSIsContainer -or ($again.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stream.Length -ne 0 -or (Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Broker){throw 'Held setup lock differs'}
        return $stream
    }catch{$stream.Dispose();throw}
}
function Assert-Account($Record){
    Assert-Keys $Record @('name','sid','profile','work','description','policy')
    $user=Get-LocalUser -Name $Record.name
    if($user.SID.Value -cne $Record.sid -or $user.Description -cne $Record.description){throw 'Created account identity differs'}
    if($user.UserMayChangePassword -or $null -ne $user.PasswordExpires -or $null -ne $user.AccountExpires){throw 'Fixed account password/expiry policy differs'}
    $groups=@(Get-LocalGroup|Where-Object { @(Get-LocalGroupMember -SID $_.SID -ErrorAction Stop|Where-Object {$_.SID.Value -ceq $Record.sid}).Count -gt 0 })
    if(@($groups|Where-Object {$_.SID.Value -cne 'S-1-5-32-545'}).Count -gt 0){throw 'Setup account has unexpected group membership'}
    $registered=[Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$Record.sid) -Name ProfileImagePath).ProfileImagePath)
    if(-not [string]::Equals($registered,$Record.profile,[StringComparison]::OrdinalIgnoreCase)){throw 'Created profile registration differs'}
    return $user
}
function Join-FixedUsers([string]$Sid){
    $before=@(Get-LocalGroupMember -SID 'S-1-5-32-545' -ErrorAction Stop)
    if($before.Count -gt 1024){throw 'Fixed Users membership exceeds bound'}
    $existingMembers=@($before|Where-Object {$_.SID.Value -ceq $Sid})
    if($existingMembers.Count -gt 1){throw 'Repeated fixed Users member'}
    if($existingMembers.Count -eq 0){Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Sid}
    $after=@(Get-LocalGroupMember -SID 'S-1-5-32-545' -ErrorAction Stop)
    if($after.Count -gt 1024 -or @($after|Where-Object {$_.SID.Value -ceq $Sid}).Count -ne 1){throw 'Fixed Users membership readback differs'}
    return @{group_sid='S-1-5-32-545';account_sid=$Sid;present_before=($existingMembers.Count -eq 1);present_after=$true}
}
function Disable-CreatedAccounts([string]$Root,[string]$PlanHash){
    $names=@('PortcoveNativeQual','PortcovePublicProof')
    $intent=Join-Path $Root 'disable-intent.json'
    if(Test-Path -LiteralPath $intent){throw 'Original disable intent retained; GET readback only, no replay'}
    $owned=@()
    for($index=0;$index -lt 2;$index++){
        $file=Join-Path $Root "account-$index-created.json"
        if(Test-Path -LiteralPath $file){
            $record=(Read-BoundedJson $file).value
            Assert-Keys $record @('name','sid','description','plan_sha256','policy')
            $user=Get-LocalUser -Name $names[$index]
            if($record.plan_sha256 -cne $PlanHash -or $record.name -cne $names[$index] -or $user.SID.Value -cne $record.sid -or $user.Description -cne $record.description -or $record.description -cne ('PC534:'+$PlanHash.Substring(0,32))){throw 'Partial account identity differs'}
            $owned+=@{name=$record.name;sid=$record.sid;description=$record.description;enabled_before=[bool]$user.Enabled}
        }
    }
    Write-NewJson $intent @{plan_sha256=$PlanHash;accounts=$owned;process_closure='unknown; disabling an account does not terminate existing processes'}
    foreach($record in $owned){
        if($record.enabled_before){Disable-LocalUser -SID $record.sid}
        $again=Get-LocalUser -Name $record.name
        if($again.SID.Value -cne $record.sid -or $again.Description -cne $record.description -or $again.Enabled){throw 'Disable readback differs; original intent retained'}
    }
    Write-NewJson (Join-Path $Root 'disabled.json') @{plan_sha256=$PlanHash;account_sids=@($owned|ForEach-Object {$_.sid});retained_profiles_files_credentials=$true;process_closure='not established; existing owned-group recovery required before any later candidate or credential release'}
}
function Read-PartialSetup([string]$Root,[string]$Broker,[string]$PlanHash,[string]$SourceHash){
    $names=@('PortcoveNativeQual','PortcovePublicProof')
    if(-not (Test-Path -LiteralPath $Root)){return @{schema_version=1;root='missing';accounts='unknown-no-owned-records';action='none'}}
    Assert-SetupRoot $Root $Broker
    if(-not (Test-Path -LiteralPath (Join-Path $Root 'setup.lock'))){return @{schema_version=1;root='present';status='held-original-lock-missing';action='GET-only; no lock creation/adoption'}}
    try{$held=Open-SetupLock $Root $Broker $false $true}catch{
        if($_.Exception -is [IO.IOException] -or $_.Exception.InnerException -is [IO.IOException]){return @{schema_version=1;root='present';status='held-active-setup-or-lock-I/O';action='GET-only; no retries'}}
        throw
    }
    try{
    $intentPath=Join-Path $Root 'intent.json';$trusted=$false
    if(Test-Path -LiteralPath $intentPath){$intent=(Read-BoundedJson $intentPath).value;$trusted=($intent.plan_sha256 -ceq $PlanHash -and $intent.source_sha256 -ceq $SourceHash -and $intent.broker_sid -ceq $Broker)}
    $rows=@()
    for($index=0;$index -lt 2;$index++){
        $name=$names[$index];$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
        $row=[ordered]@{name=$name;owned_record='missing';provider='missing';credential='unknown';registered_profile='unknown';profile='unknown';work='unknown'}
        if($user){$row.provider=@{sid=$user.SID.Value;enabled=[bool]$user.Enabled;user_may_change_password=[bool]$user.UserMayChangePassword;password_expires=$user.PasswordExpires;account_expires=$user.AccountExpires;adopted=$false}}
        $recordPath=Join-Path $Root "account-$index-created.json"
        if($trusted -and (Test-Path -LiteralPath $recordPath)){
            $record=(Read-BoundedJson $recordPath).value
            Assert-Keys $record @('name','sid','description','plan_sha256','policy')
            if($record.name -cne $name -or $record.plan_sha256 -cne $PlanHash -or $record.description -cne ('PC534:'+$PlanHash.Substring(0,32))){throw 'Partial owned record differs'}
            $row.owned_record='retained'
            if($user -and $user.SID.Value -ceq $record.sid -and $user.Description -ceq $record.description){
                $row.provider.record_identity_matches=$true
                $row.credential=[PortcoveAccountSetup]::Metadata($index,$name)
                $registration=Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$record.sid) -Name ProfileImagePath -ErrorAction SilentlyContinue
                if($registration){
                    $raw=[string]$registration.ProfileImagePath
                    if($raw.Length -gt 1024){throw 'Registered profile path exceeds bound'}
                    $expanded=[Environment]::ExpandEnvironmentVariables($raw)
                    if($expanded.Length -gt 1024){throw 'Expanded registered profile exceeds bound'}
                    $row.registered_profile=@{raw=$raw;expanded=$expanded;matches_fixed_profile=[string]::Equals($expanded,('C:\Users\'+$name),[StringComparison]::OrdinalIgnoreCase)}
                }else{$row.registered_profile='missing'}
                foreach($kind in @('profile','work')){
                    $fixed=if($kind -ceq 'profile'){'C:\Users\'+$name}else{Join-Path $Root "work-$index"}
                    if(Test-Path -LiteralPath $fixed){$item=Get-Item -LiteralPath $fixed -Force;$leafAcl=Get-Acl -LiteralPath $fixed;$row[$kind]=@{path=$fixed;directory=[bool]$item.PSIsContainer;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint);sddl=$leafAcl.Sddl}}
                    else{$row[$kind]='missing'}
                }
            } else {$row.provider=@{status='identity-mismatch-or-missing-held';adopted=$false}}
        }
        $rows+=,$row
    }
    $receipts=@();foreach($name in @('created.json','credentials-intent.json','credentials-complete.json','enable-intent.json','enabled.json','disable-intent.json','disabled.json')){
        $file=Join-Path $Root $name
        if(Test-Path -LiteralPath $file){$read=Read-BoundedJson $file;$receipts+=@{name=$name;sha256=$read.sha256}}else{$receipts+=@{name=$name;status='missing'}}
    }
    return @{schema_version=1;plan_sha256=$PlanHash;original_intent_matches=$trusted;accounts=$rows;receipts=$receipts;action='GET-only; no adoption/retry/activation or proof of password/logon/capability'}
    }finally{$held.Dispose()}
}

# These native APIs are setup-only. The password remains SecureString/unmanaged memory;
# no secret is included in JSON, command arguments, environment, or managed strings.
$interop=@'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
public static class PortcoveAccountSetup {
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateProfile(string sid,string name,StringBuilder path,uint size);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Credential {public uint flags,type; public string target,comment;public long written; public uint size;public IntPtr blob;public uint persist,count;public IntPtr attributes;public string alias,user;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWriteW(ref Credential value,uint flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static string Profile(string sid,string name){var path=new StringBuilder(32768);int code=CreateProfile(sid,name,path,(uint)path.Capacity);if(code!=0)Marshal.ThrowExceptionForHR(code);return path.ToString();}
 static string Target(int index){if(index==0)return "Portcove/native-qualification/local-account/v1";if(index==1)return "Portcove/public-update-proof/local-account/v1";throw new ArgumentException("Fixed purpose required");}
 public static void AssertAbsent(int index){IntPtr value;if(CredReadW(Target(index),1,0,out value)){CredFree(value);throw new InvalidOperationException("Existing credential retained; no overwrite");}if(Marshal.GetLastWin32Error()!=1168)throw new Win32Exception();}
 public static string Metadata(int index,string user){IntPtr value;if(!CredReadW(Target(index),1,0,out value)){if(Marshal.GetLastWin32Error()==1168)return "missing";throw new Win32Exception();}try{var c=Marshal.PtrToStructure<Credential>(value);return c.type==1&&c.target==Target(index)&&c.user==Environment.MachineName+"\\"+user&&c.persist==2&&c.size>=2&&c.size<=512&&c.size%2==0&&c.blob!=IntPtr.Zero?"present-format-verified-password-not-tested":"present-metadata-mismatch-held";}finally{CredFree(value);}}
 public static void Check(int index,string user){IntPtr value;if(!CredReadW(Target(index),1,0,out value))throw new Win32Exception();try{var c=Marshal.PtrToStructure<Credential>(value);if(c.type!=1||c.target!=Target(index)||c.user!=Environment.MachineName+"\\"+user||c.persist!=2||c.size<2||c.size>512||c.size%2!=0||c.blob==IntPtr.Zero)throw new InvalidOperationException("Stored credential readback differs");}finally{CredFree(value);}}
 public static void Store(int index,string user,string sid,SecureString password){
  if(password==null||password.Length<1||password.Length>256)throw new ArgumentException("Bounded password required");AssertAbsent(index);
  IntPtr secret=Marshal.SecureStringToGlobalAllocUnicode(password);
  try{for(int n=0;n<password.Length;n++)if(Marshal.ReadInt16(secret,n*2)==0)throw new ArgumentException("Null password character refused");
   var c=new Credential{type=1,target=Target(index),size=(uint)(password.Length*2),blob=secret,persist=2,user=Environment.MachineName+"\\"+user};
   if(!CredWriteW(ref c,0))throw new Win32Exception();Check(index,user);
   IntPtr observed;if(!CredReadW(Target(index),1,0,out observed))throw new Win32Exception();try{var read=Marshal.PtrToStructure<Credential>(observed);if(read.size!=c.size)throw new InvalidOperationException("Credential byte count differs");for(int n=0;n<c.size;n++)if(Marshal.ReadByte(read.blob,n)!=Marshal.ReadByte(secret,n))throw new InvalidOperationException("Credential byte readback differs");}finally{CredFree(observed);}
  }finally{Marshal.ZeroFreeGlobalAllocUnicode(secret);}
 }
}
'@

$inputPlan=Read-BoundedJson $Plan
if($inputPlan.sha256 -cne $PlanSha256){throw 'Setup plan SHA differs'}
$selected=$inputPlan.value;Assert-SetupPlan $selected
if(-not $IsWindows){throw 'Fixed Windows setup requires PowerShell 7 on Windows'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -cne $selected.broker_sid){throw 'Setup requires the appointed broker, including UAC elevation'}
$elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(($Mode -in @('create','enable','disable')) -ne $elevated){throw 'Create/enable/disable require same-broker elevation; credentials/readback require ordinary broker'}
$root=[string]$selected.root;$broker=[string]$selected.broker_sid
$source=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$names=@('PortcoveNativeQual','PortcovePublicProof')
Add-Type -TypeDefinition $interop
Assert-Ancestry ([IO.Path]::GetDirectoryName($root)) $broker
if($Mode -eq 'readback'){Read-PartialSetup $root $broker $PlanSha256 $source|ConvertTo-Json -Depth 10;return}

$setupLock=$null
try{
if($Mode -eq 'create'){
    if(Test-Path -LiteralPath $root){throw 'Setup root exists; use readback/disable, never replay creation'}
    foreach($name in $names){
        if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'Setup account exists; no adoption'}
        if(Test-Path -LiteralPath ('C:\Users\'+$name)){throw 'Fixed profile path already exists; no adoption'}
    }
    New-Item -ItemType Directory -Path $root -ErrorAction Stop|Out-Null
    $rootSddl=Set-ExactDirectoryAcl $root $broker
    $setupLock=Open-SetupLock $root $broker $true
    Write-NewJson (Join-Path $root 'intent.json') @{schema_version=1;plan_sha256=$PlanSha256;source_sha256=$source;broker_sid=$broker;root_sddl=$rootSddl;authority='conditional-setup-only'}
    $accounts=@()
    for($index=0;$index -lt 2;$index++){
        $name=$names[$index];$description='PC534:'+$PlanSha256.Substring(0,32)
        Write-NewJson (Join-Path $root "account-$index-intent.json") @{name=$name;description=$description;absent_before=$true;profile_absent_before=$true}
        $password=Read-Host "Initial password for $name (enter again in ordinary-broker credentials stage)" -AsSecureString
        try{if($password.Length -lt 1 -or $password.Length -gt 256){throw 'Setup password exceeds fixed credential bounds'};$user=New-LocalUser -Name $name -Password $password -Description $description -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Disabled}
        finally{if($password){$password.Dispose()}}
        # Persist SID before profile creation so partial failure still permits exact disable.
        Write-NewJson (Join-Path $root "account-$index-created.json") @{name=$name;sid=$user.SID.Value;description=$description;plan_sha256=$PlanSha256;policy=@{user_may_change_password=[bool]$user.UserMayChangePassword;password_expires=$user.PasswordExpires;account_expires=$user.AccountExpires}}
        Write-NewJson (Join-Path $root "account-$index-group-intent.json") @{plan_sha256=$PlanSha256;account_sid=$user.SID.Value;group_sid='S-1-5-32-545'}
        $membership=Join-FixedUsers $user.SID.Value
        Write-NewJson (Join-Path $root "account-$index-group.json") $membership
        $createdProfile=[PortcoveAccountSetup]::Profile($user.SID.Value,$name)
        if(-not [string]::Equals($createdProfile,('C:\Users\'+$name),[StringComparison]::OrdinalIgnoreCase)){throw 'Fresh profile is not the fixed C: profile; retain partial setup'}
        Assert-Ancestry ([IO.Path]::GetDirectoryName($createdProfile)) $broker
        $work=Join-Path $root "work-$index";New-Item -ItemType Directory -Path $work -ErrorAction Stop|Out-Null
        $record=@{name=$name;sid=$user.SID.Value;profile=$createdProfile;work=$work;description=$description;policy=@{user_may_change_password=[bool]$user.UserMayChangePassword;password_expires=$user.PasswordExpires;account_expires=$user.AccountExpires}}
        Write-NewJson (Join-Path $root "account-$index.json") $record
        $accounts+=,$record
    }
    # CreateProfile owns OS profile contents. Protect only the appointed profile root;
    # do not follow/rewrite standard profile junctions or unrelated OS-managed ACLs.
    foreach($account in $accounts){
        Write-NewJson (Join-Path $root ($account.name+'-profile-preimage.json')) @{path=$account.profile;sddl=(Get-Acl -LiteralPath $account.profile).Sddl}
        Set-ExactDirectoryAcl $account.profile $broker @() $account.sid|Out-Null
        Set-ExactDirectoryAcl $account.work $broker @() $account.sid|Out-Null
    }
    $sids=@($accounts|ForEach-Object {$_.sid})
    foreach($leaf in @('controller','inputs','config','credentials','capture')){
        $directory=Join-Path $root $leaf;New-Item -ItemType Directory -Path $directory -ErrorAction Stop|Out-Null
        $read=@();if($leaf -in @('controller','inputs')){$read=$sids}
        Set-ExactDirectoryAcl $directory $broker $read|Out-Null
    }
    # Candidate traversal of the common container does not grant private child access.
    Set-ExactDirectoryAcl $root $broker $sids|Out-Null
    foreach($account in $accounts){if((Assert-Account $account).Enabled){throw 'Created setup account unexpectedly enabled'}}
    $post=@();foreach($entry in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Directory) + @($accounts|ForEach-Object {Get-Item -LiteralPath $_.profile})){$post+=@{path=$entry.FullName;sddl=(Get-Acl -LiteralPath $entry.FullName).Sddl}}
    Write-NewJson (Join-Path $root 'created.json') @{schema_version=1;plan_sha256=$PlanSha256;source_sha256=$source;accounts=$accounts;acl_postimages=$post;enabled=$false}
    return
}
Assert-SetupRoot $root $broker
$setupLock=Open-SetupLock $root $broker $false
if($Mode -ne 'disable' -and (Test-Path -LiteralPath (Join-Path $root 'disable-intent.json'))){throw 'Recovery disable is retained; GET readback and existing owned-group recovery required, no credential/enable continuation'}
$intent=(Read-BoundedJson (Join-Path $root 'intent.json')).value
if($intent.plan_sha256 -cne $PlanSha256 -or $intent.source_sha256 -cne $source -or $intent.broker_sid -cne $broker){throw 'Original setup intent/source differs'}
if($Mode -eq 'disable'){
    # Does not restore ACLs, remove credentials/files/profiles, reset passwords, or adopt names.
    Disable-CreatedAccounts $root $PlanSha256
    return
}
$created=(Read-BoundedJson (Join-Path $root 'created.json')).value
if($created.plan_sha256 -cne $PlanSha256 -or $created.source_sha256 -cne $source -or @($created.accounts).Count -ne 2){throw 'Complete setup receipt differs'}
foreach($post in $created.acl_postimages){Assert-Ancestry ([IO.Path]::GetDirectoryName($post.path)) $broker;if((Get-Acl -LiteralPath $post.path).Sddl -cne $post.sddl){throw 'Recorded ACL postimage drifted'}}
for($index=0;$index -lt 2;$index++){if($created.accounts[$index].name -cne $names[$index]){throw 'Fixed account order differs'};Assert-Account $created.accounts[$index]|Out-Null}
if($Mode -eq 'enable'){
    if(-not $CreatedSha256 -or -not $BrokerReceiptSha256){throw 'Explicit original receipt hashes required for activation'}
    if((Read-BoundedJson (Join-Path $root 'created.json')).sha256 -cne $CreatedSha256 -or (Read-BoundedJson (Join-Path $root 'credentials-complete.json')).sha256 -cne $BrokerReceiptSha256){throw 'Activation receipt hashes differ'}
    $credentialReceipt=(Read-BoundedJson (Join-Path $root 'credentials-complete.json')).value
    if($credentialReceipt.plan_sha256 -cne $PlanSha256 -or $credentialReceipt.broker_sid -cne $broker -or $credentialReceipt.fixed_targets_read_back -ne $true){throw 'Ordinary broker credential receipt differs'}
    foreach($account in $created.accounts){if((Assert-Account $account).Enabled){throw 'Partial activation retained; disable/readback before any new action'}}
    Write-NewJson (Join-Path $root 'enable-intent.json') @{plan_sha256=$PlanSha256;created_sha256=$CreatedSha256;credentials_sha256=$BrokerReceiptSha256;purpose='Explicit final setup activation after all independent source/config/task/custody readbacks; not proof of those readbacks'}
    foreach($account in $created.accounts){Enable-LocalUser -SID $account.sid;if(-not (Assert-Account $account).Enabled){throw 'Account enable readback differs'}}
    Write-NewJson (Join-Path $root 'enabled.json') @{plan_sha256=$PlanSha256;created_sha256=$CreatedSha256;credentials_sha256=$BrokerReceiptSha256;account_sids=@($created.accounts|ForEach-Object {$_.sid})}
    return
}
if($Mode -eq 'credentials'){
    if(Test-Path -LiteralPath (Join-Path $root 'credentials-intent.json')){throw 'Original credential intent exists; readback/disable only'}
    foreach($account in $created.accounts){if((Assert-Account $account).Enabled){throw 'Credentials require the original disabled accounts'}}
    for($index=0;$index -lt 2;$index++){[PortcoveAccountSetup]::AssertAbsent($index)}
    Write-NewJson (Join-Path $root 'credentials-intent.json') @{plan_sha256=$PlanSha256;broker_sid=$broker;targets_absent_before=$true}
    for($index=0;$index -lt 2;$index++){
        $account=$created.accounts[$index];$password=Read-Host "Store fixed credential for $($account.name)" -AsSecureString
        try{[PortcoveAccountSetup]::Store($index,$account.name,$account.sid,$password)}finally{if($password){$password.Dispose()}}
    }
    Write-NewJson (Join-Path $root 'credentials-complete.json') @{plan_sha256=$PlanSha256;broker_sid=$broker;fixed_targets_read_back=$true;accounts_remain_disabled=$true}
}
for($index=0;$index -lt 2;$index++){[PortcoveAccountSetup]::Check($index,$created.accounts[$index].name)}
[ordered]@{schema_version=1;plan_sha256=$PlanSha256;accounts=$created.accounts;credentials_verified=$true;activation='Not performed. After all protected source/config/task/WSL readbacks, same-broker elevated fixed -Mode enable -CreatedSha256 HASH -BrokerReceiptSha256 HASH, then ordinary setup readback. No target interactive sign-in required.';scope='Exact trusted roots and account work/profile permissions; standard Windows account is not universal filesystem write containment.'}|ConvertTo-Json -Depth 6
}finally{if($setupLock){$setupLock.Dispose()}}
