import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./release-local-worker-accounts.ps1", import.meta.url));
const validPlan = JSON.stringify({
  schema_version: 1,
  broker_sid: "S-1-5-21-1-2-3-1001",
  root: "C:\\ProgramData\\PortcoveNativeQualification",
});
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function powershell(script: string) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout.trim();
}
const ast = `$ErrorActionPreference='Stop'; $tokens=$null;$errors=$null;$tree=[Management.Automation.Language.Parser]::ParseFile(${quote(sourcePath)},[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};`;
const functions = `${ast}foreach($name in @('Assert-JsonNames','Read-BoundedJson','Assert-Keys','Assert-SetupPlan','Write-NewJson')){$node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);if(-not $node){throw 'Missing actual source function'};Invoke-Expression $node.Extent.Text};`;

void test(
  "documented initial bootstrap executes its ACL guard for generic and named rights without mutating the host",
  { skip: process.platform !== "win32" },
  () => {
    const document = fileURLToPath(
      new URL(
        "../docs/qualification/slice4-consolidated-initial-setup-2026-10-21.md",
        import.meta.url,
      ),
    );
    const output = powershell(`$ErrorActionPreference='Stop';
      $text=[IO.File]::ReadAllText(${quote(document)});
      $blocks=[regex]::Matches($text,'(?ms)^\x60\x60\x60powershell\\r?\\n(.*?)^\x60\x60\x60');
      if($blocks.Count -ne 5){throw 'Bootstrap command inventory differs'};
      $tokens=$null;$errors=$null;
      $tree=[Management.Automation.Language.Parser]::ParseInput($blocks[0].Groups[1].Value,[ref]$tokens,[ref]$errors);
      if($errors.Count){throw ($errors|Out-String)};
      $guards=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text.Contains('$taskRule.FileSystemRights')},$true));
      if($guards.Count -ne 1){throw 'Actual bootstrap ACL guard is missing or duplicated'};
      $guard=[scriptblock]::Create($guards[0].Clauses[0].Item1.Extent.Text);
      $broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $taskTrusted=@($broker,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
      $foreign='S-1-5-21-1-2-3-1009';
      foreach($rights in @([int64]0x10000000,[int64][Security.AccessControl.FileSystemRights]::FullControl,[int64][Security.AccessControl.FileSystemRights]::Delete,[int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[int64][Security.AccessControl.FileSystemRights]::ChangePermissions,[int64][Security.AccessControl.FileSystemRights]::TakeOwnership)){
        $taskRule=[pscustomobject]@{PropagationFlags=[Security.AccessControl.PropagationFlags]::None;AccessControlType='Allow';FileSystemRights=$rights;IdentityReference=@{Value=$foreign}};
        if(-not (& $guard)){throw 'Foreign replacement right was admitted'};
        $taskRule.IdentityReference.Value=$broker;if(& $guard){throw 'Trusted broker rejected'};
        $taskRule.IdentityReference.Value=$foreign;$taskRule.AccessControlType='Deny';if(& $guard){throw 'Deny ACE treated as an allow'};
        $taskRule.AccessControlType='Allow';$taskRule.PropagationFlags=[Security.AccessControl.PropagationFlags]::InheritOnly;if(& $guard){throw 'Inherit-only ACE treated as applying to parent'};
      };
      foreach($rights in @([Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.FileSystemRights]::CreateFiles,[Security.AccessControl.FileSystemRights]::CreateDirectories)){
        $taskRule=[pscustomobject]@{PropagationFlags=[Security.AccessControl.PropagationFlags]::None;AccessControlType='Allow';FileSystemRights=$rights;IdentityReference=@{Value=$foreign}};
        if(& $guard){throw 'Non-replacement parent access rejected'};
      };
      foreach($parent in @('C:\\ProgramData','C:\\')){
        foreach($taskRule in (Get-Acl -LiteralPath $parent).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){[void](& $guard)};
      };
      'actual-bootstrap-acl-cases-pass';`);
    assert.equal(output, "actual-bootstrap-acl-cases-pass");
  },
);

void test(
  "fixed account setup parses and compiles actual native interop without invoking it",
  { skip: process.platform !== "win32" },
  () => {
    const output = powershell(`${ast}
    $assignment=$tree.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$interop'},$true);
    Invoke-Expression $assignment.Extent.Text;Add-Type -TypeDefinition $interop;
    $target=[PortcoveAccountSetup].GetMethod('Target',[Reflection.BindingFlags]'Static,NonPublic');
    if($target.Invoke($null,@([int]0)) -cne 'Portcove/native-qualification/local-account/v1'){throw 'Native target differs'};
    if($target.Invoke($null,@([int]1)) -cne 'Portcove/public-update-proof/local-account/v1'){throw 'Public target differs'};
    $refused=$false;try{$target.Invoke($null,@([int]2))}catch{$refused=$true};if(-not $refused){throw 'Arbitrary target accepted'};'compiled-fixed-targets-only'`);
    assert.equal(output, "compiled-fixed-targets-only");
  },
);

void test(
  "actual closed setup plan refuses alternate roots, account selectors and schema coercion",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${functions}
    $valid=${quote(validPlan)};
    Assert-SetupPlan ($valid|ConvertFrom-Json);
    foreach($bad in @($valid.Replace('C:','E:'),$valid.Replace('"schema_version":1','"schema_version":"1"'),$valid.Replace('"root":','"account_name":"arbitrary","root":'),$valid.Replace('PortcoveNativeQualification','OtherRoot'))){
      $refused=$false;try{Assert-SetupPlan ($bad|ConvertFrom-Json)}catch{$refused=$true};if(-not $refused){throw 'Unsafe setup plan accepted'}
    }`);
  },
);

void test(
  "actual held setup reader hashes exact bytes and refuses overflow and duplicate names; receipts never overwrite",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pc-account-setup-"));
    try {
      const input = path.join(directory, "plan.json");
      const bytes = validPlan;
      await writeFile(input, bytes);
      const expected = createHash("sha256").update(bytes).digest("hex");
      powershell(`${functions}
      $read=Read-BoundedJson ${quote(input)};Assert-SetupPlan $read.value;if($read.sha256 -cne '${expected}'){throw 'Raw hash differs'};
      Write-NewJson ${quote(path.join(directory, "receipt.json"))} @{authority='none'};
      $refused=$false;try{Write-NewJson ${quote(path.join(directory, "receipt.json"))} @{authority='replacement'}}catch{$refused=$true};if(-not $refused){throw 'Receipt overwritten'};`);
      for (const invalid of [" ".repeat(65_537), '{"root":1,"ROOT":2}', '{"a":1,"a":2}']) {
        await writeFile(input, invalid);
        powershell(
          `${functions}$refused=$false;try{Read-BoundedJson ${quote(input)}|Out-Null}catch{$refused=$true};if(-not $refused){throw 'Invalid bounded input accepted'}`,
        );
      }
      const receipt: unknown = JSON.parse(
        await readFile(path.join(directory, "receipt.json"), "utf8"),
      );
      assert.ok(typeof receipt === "object" && receipt !== null && "authority" in receipt);
      assert.equal(receipt.authority, "none");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  "setup command boundaries retain disabled accounts, fixed intent custody and non-destructive recovery",
  { skip: process.platform !== "win32" },
  async () => {
    const source = await readFile(sourcePath, "utf8");
    // AST command inspection checks the actual operations, without running account/ACL/credential APIs.
    powershell(`${ast}
    $commands=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true));
    $create=@($commands|Where-Object {$_.GetCommandName() -ceq 'New-LocalUser'});if($create.Count -ne 1 -or $create[0].Extent.Text -notmatch '-Disabled'){throw 'Fresh account is not disabled'};
    foreach($forbidden in @('Remove-LocalUser','Remove-Item','Set-LocalUser','Start-Process','Register-ScheduledTask','Invoke-Command')){if(@($commands|Where-Object {$_.GetCommandName() -ceq $forbidden}).Count){throw 'Unexpected destructive/execution command'}};
    $prompts=@($commands|Where-Object {$_.GetCommandName() -ceq 'Read-Host'});if($prompts.Count -ne 2){throw 'Fixed password prompts differ'};foreach($prompt in $prompts){if($prompt.Extent.Text -notmatch '-AsSecureString'){throw 'Plain password prompt'}};`);
    assert.match(source, /FileMode\]::CreateNew/);
    assert.match(source, /credentials-intent\.json/);
    assert.match(source, /enable-intent\.json/);
    assert.match(source, /Marshal\.ZeroFreeGlobalAllocUnicode\(secret\)/);
    assert.doesNotMatch(source, /SecureStringToBSTR|PtrToStringUni|ConvertFrom-SecureString|E:\\/);
  },
);

void test(
  "actual ACL builder separates trusted RX, private custody and two account write leaves in memory",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${ast}
    $node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Set-ExactDirectoryAcl'},$true);Invoke-Expression $node.Extent.Text;
    function Set-Acl {param($LiteralPath,$AclObject)$script:observed=$AclObject};function Get-Acl {param($LiteralPath)return $script:observed};
    $broker='S-1-5-21-1-2-3-1001';$native='S-1-5-21-1-2-3-1002';$public='S-1-5-21-1-2-3-1003';
    $write=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership';
    Set-ExactDirectoryAcl 'inert-controller' $broker @($native,$public)|Out-Null;
    if(-not $script:observed.AreAccessRulesProtected -or $script:observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $broker){throw 'Owner/protection differs'};
    foreach($rule in $script:observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -in @($native,$public) -and ($rule.FileSystemRights -band $write)){throw 'Controller target can write'}};
    Set-ExactDirectoryAcl 'inert-private' $broker|Out-Null;
    foreach($rule in $script:observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -notin @($broker,'S-1-5-18')){throw 'Private reader differs'}};
    foreach($account in @($native,$public)){
      Set-ExactDirectoryAcl 'inert-work' $broker @() $account|Out-Null;
      $ownWrite=$false;foreach($rule in $script:observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.IdentityReference.Value -ceq $account -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)){$ownWrite=$true};
        if($rule.IdentityReference.Value -in @($native,$public) -and $rule.IdentityReference.Value -cne $account){throw 'Cross-account work access'}
      };if(-not $ownWrite){throw 'Own work not writable'}
    }`);
  },
);

void test(
  "actual New-LocalUser argv fits Windows limits and requests fixed non-expiring disabled account policy",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${ast}
    $assignment=$tree.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$names'},$true);Invoke-Expression $assignment.Extent.Text;
    $descriptionAssignment=$tree.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$description'},$true);
    $create=$tree.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'New-LocalUser'},$true);
    function New-LocalUser {param($Name,$Password,$Description,[switch]$AccountNeverExpires,[switch]$PasswordNeverExpires,[switch]$UserMayNotChangePassword,[switch]$Disabled)
      if($Name.Length -gt 20 -or $Description.Length -gt 48 -or -not $Disabled -or -not $AccountNeverExpires -or -not $PasswordNeverExpires -or -not $UserMayNotChangePassword -or $Password -isnot [Security.SecureString]){throw 'Actual fixed account arguments invalid'}
      $script:captured+=,$Name
    };
    $PlanSha256='a'*64;$captured=@();$password=[Security.SecureString]::new();$password.AppendChar('x');
    try{foreach($name in $names){Invoke-Expression $descriptionAssignment.Extent.Text;Invoke-Expression $create.Extent.Text}}finally{$password.Dispose()};
    if(($captured -join ',') -cne 'PortcoveNativeQual,PortcovePublicProof'){throw 'Fixed actual names differ'};
    $source=$tree.Extent.Text;$newOffset=$create.Extent.StartOffset;$sidOffset=$source.IndexOf('"account-$index-created.json"',$newOffset);$groupOffset=$source.IndexOf('Join-FixedUsers $user.SID.Value',$newOffset);
    if($sidOffset -le $newOffset -or $sidOffset -ge $groupOffset){throw 'SID not retained before group mutation'};`);
  },
);

void test(
  "actual partial GET reader preserves missing and unrecorded identities without complete receipts or writes",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${ast}
    foreach($name in @('Assert-Keys','Assert-SetupRoot','Read-PartialSetup')){$node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);Invoke-Expression $node.Extent.Text};
    Add-Type 'public static class PortcoveAccountSetup { public static string Metadata(int i,string user){return "missing";} }';
    $broker='S-1-5-21-1-2-3-1001';$Root='C:\\ProgramData\\PortcoveNativeQualification';$hash='a'*64;$source='b'*64;$exists=$false;$reads=0;
    function Assert-Ancestry {param($Path,$Broker)};function Open-SetupLock {param($Root,$Broker,$Create,$ReadOnly)return [IO.MemoryStream]::new()};function Get-ItemProperty {param($LiteralPath,$Name,$ErrorAction)return [pscustomobject]@{ProfileImagePath='C:\\Users\\PortcoveNativeQual.unexpected'}};
    function Test-Path {param($LiteralPath)if(-not $script:exists){return $false};return $LiteralPath -in @($Root,(Join-Path $Root 'intent.json'),(Join-Path $Root 'setup.lock'),(Join-Path $Root 'account-0-created.json'))};
    function Get-Acl {param($LiteralPath)$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner([Security.Principal.SecurityIdentifier]::new($broker));$a.SetAccessRuleProtection($true,$false);return $a};
    function Get-LocalUser {param($Name,$ErrorAction)$script:reads++;return [pscustomobject]@{Name=$Name;SID=[pscustomobject]@{Value=if($Name -ceq 'PortcoveNativeQual'){'S-1-5-21-1-2-3-1002'}else{'S-1-5-21-1-2-3-1999'}};Description='PC534:'+$hash.Substring(0,32);Enabled=$false;UserMayChangePassword=$false;PasswordExpires=$null;AccountExpires=$null}};
    function Read-BoundedJson {param($Path)
      if($Path.EndsWith('intent.json')){return @{value=[pscustomobject]@{plan_sha256=$hash;source_sha256=$source;broker_sid=$broker}}};
      if($Path.EndsWith('account-0-created.json')){return @{value=[pscustomobject]@{name='PortcoveNativeQual';sid='S-1-5-21-1-2-3-1002';description='PC534:'+$hash.Substring(0,32);plan_sha256=$hash;policy=@{}}}};
      throw 'Unexpected complete-receipt read'
    };
    function New-LocalUser {throw 'GET created an account'};function Disable-LocalUser {throw 'GET disabled an account'};function Enable-LocalUser {throw 'GET enabled an account'};function Write-NewJson {throw 'GET wrote a receipt'};
    $missing=Read-PartialSetup $Root $broker $hash $source;if($missing.root -cne 'missing' -or $reads -ne 0){throw 'Missing root acquired provider authority'};
    $exists=$true;$partial=Read-PartialSetup $Root $broker $hash $source;
    if(-not $partial.original_intent_matches -or $partial.accounts[0].credential -cne 'missing' -or $partial.accounts[0].profile -cne 'missing' -or $partial.accounts[1].owned_record -cne 'missing' -or $partial.accounts[1].provider.adopted -ne $false -or $partial.accounts[0].registered_profile.matches_fixed_profile -ne $false -or $partial.accounts[0].registered_profile.expanded -cne 'C:\\Users\\PortcoveNativeQual.unexpected'){throw 'Partial setup silently adopted or hid state'};
    if(@($partial.receipts|Where-Object {$_.status -ceq 'missing'}).Count -ne 7){throw 'Missing completion receipts hidden'};`);
  },
);

void test(
  "fixed Users helper observes existing membership and adds only one absent owned SID",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${ast}
    $node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Join-FixedUsers'},$true);Invoke-Expression $node.Extent.Text;
    $sid='S-1-5-21-1-2-3-1002';$present=$true;$adds=0;
    function Get-LocalGroupMember {param($SID,$ErrorAction)if($SID -cne 'S-1-5-32-545'){throw 'Other group read'};if($script:present){return [pscustomobject]@{SID=[pscustomobject]@{Value=$script:sid}}}};
    function Add-LocalGroupMember {param($SID,$Member)if($SID -cne 'S-1-5-32-545' -or $Member -cne $script:sid){throw 'Other membership mutation'};$script:adds++;$script:present=$true};
    $before=Join-FixedUsers $sid;if(-not $before.present_before -or $adds -ne 0){throw 'Existing membership repeated'};
    $present=$false;$after=Join-FixedUsers $sid;if($after.present_before -or -not $after.present_after -or $adds -ne 1){throw 'Absent fixed membership not added once'};`);
  },
);

void test(
  "disable recovery records intent before mutation, holds ambiguity and never repeats provider writes",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${ast}
    foreach($name in @('Assert-Keys','Disable-CreatedAccounts')){$node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);Invoke-Expression $node.Extent.Text};
    $root='C:\\ProgramData\\PortcoveNativeQualification';$hash='a'*64;$intent=$false;$writes=0;$mutations=0;$complete=$false;$ambiguous=$false;
    $names=@('PortcoveNativeQual','PortcovePublicProof');$enabled=@{PortcoveNativeQual=$true;PortcovePublicProof=$true};
    function Test-Path {param($LiteralPath)if($LiteralPath.EndsWith('disable-intent.json')){return $script:intent};return $LiteralPath.EndsWith('-created.json')};
    function Read-BoundedJson {param($Path)$i=if($Path.EndsWith('account-0-created.json')){0}else{1};return @{value=[pscustomobject]@{name=$names[$i];sid=('S-1-5-21-1-2-3-'+(1002+$i));description='PC534:'+$hash.Substring(0,32);plan_sha256=$hash;policy=@{}}}};
    function Get-LocalUser {param($Name)$i=[array]::IndexOf($names,$Name);if($i -lt 0){throw 'Unexpected account'};return [pscustomobject]@{SID=[pscustomobject]@{Value=('S-1-5-21-1-2-3-'+(1002+$i))};Description='PC534:'+$hash.Substring(0,32);Enabled=$enabled[$Name]}};
    function Write-NewJson {param($Path,$Value)$script:writes++;if($Path.EndsWith('disable-intent.json')){if($script:intent){throw 'Overwrite'};$script:intent=$true}elseif($Path.EndsWith('disabled.json')){$script:complete=$true}else{throw 'Unexpected write'}};
    function Disable-LocalUser {param($SID)if(-not $script:intent){throw 'No prior intent'};$script:mutations++;if(-not $script:ambiguous){$i=[int]($SID.Split('-')[-1])-1002;$script:enabled[$names[$i]]=$false}};
    Disable-CreatedAccounts $root $hash;if($mutations -ne 2 -or -not $complete){throw 'Exact disable/readback missing'};
    $held=$false;try{Disable-CreatedAccounts $root $hash}catch{$held=$true};if(-not $held -or $mutations -ne 2 -or $writes -ne 2){throw 'Disable replayed'};
    $intent=$false;$writes=0;$mutations=0;$complete=$false;$ambiguous=$true;$enabled=@{PortcoveNativeQual=$true;PortcovePublicProof=$true};
    $held=$false;try{Disable-CreatedAccounts $root $hash}catch{$held=$true};if(-not $held -or -not $intent -or $complete -or $mutations -ne 1){throw 'Ambiguous disable falsely completed'};
    try{Disable-CreatedAccounts $root $hash}catch{};if($mutations -ne 1){throw 'Ambiguous original retried'};'disable-recovery-cases-complete';`);
  },
);

void test(
  "actual retained setup file lock collides exclusively, never creates missing originals, and releases on dispose",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pc-setup-lock-"));
    try {
      powershell(`${ast}
      foreach($name in @('Open-SetupLock','Read-PartialSetup')){$node=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);Invoke-Expression $node.Extent.Text};
      function Assert-SetupRoot {param($Root,$Broker)};
      function Get-LocalUser {throw 'Lock called an account API'};function New-LocalUser {throw 'Lock created account'};function Disable-LocalUser {throw 'Lock disabled account'};
      $root=${quote(directory)};$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $held=Open-SetupLock $root $broker $true;
      try{
        foreach($readOnly in @($true,$false)){$refused=$false;try{$other=Open-SetupLock $root $broker $false $readOnly;$other.Dispose()}catch{$refused=$true};if(-not $refused){throw 'Concurrent setup lock admitted'}}
        $active=Read-PartialSetup $root $broker ('a'*64) ('b'*64);if($active.status -cne 'held-active-setup-or-lock-I/O'){throw 'Active readback not held'};
      }finally{$held.Dispose()};
      $read=Open-SetupLock $root $broker $false $true;$read.Dispose();
      $fresh=Join-Path $root 'not-created';[IO.Directory]::CreateDirectory($fresh)|Out-Null;
      $refused=$false;try{$missing=Open-SetupLock $fresh $broker $false;$missing.Dispose()}catch{$refused=$true};if(-not $refused -or [IO.File]::Exists((Join-Path $fresh 'setup.lock'))){throw 'Missing original lock adopted'};
      $missingRead=Read-PartialSetup $fresh $broker ('a'*64) ('b'*64);if($missingRead.status -cne 'held-original-lock-missing' -or [IO.File]::Exists((Join-Path $fresh 'setup.lock'))){throw 'GET adopted missing original lock'};
      if((Get-Item -LiteralPath (Join-Path $root 'setup.lock')).Length -ne 0){throw 'Transient lock became state journal'};'lock-cases-complete';`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  "actual atomic private root excludes inherited foreign access and refuses existing directory unchanged",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pc-atomic-root-"));
    try {
      powershell(`${ast}
      $assignment=$tree.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$interop'},$true);
      Invoke-Expression $assignment.Extent.Text;Add-Type -TypeDefinition $interop;
      $parent=${quote(directory)};$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$foreign='S-1-5-21-1-2-3-1009';
      $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($broker));$acl.SetAccessRuleProtection($true,$false);
      foreach($sid in @($broker,'S-1-5-18',$foreign)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};
      Set-Acl -LiteralPath $parent -AclObject $acl;
      $ordinary=Join-Path $parent 'inherited';[IO.Directory]::CreateDirectory($ordinary)|Out-Null;
      if(-not @((Get-Acl -LiteralPath $ordinary).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -ceq $foreign -and $_.IsInherited}).Count){throw 'Fixture did not inherit foreign writable ACE'};
      $private=Join-Path $parent 'private';$expected=[PortcoveAccountSetup]::CreatePrivateDirectory($private,$broker);$observed=Get-Acl -LiteralPath $private;
      if(-not $observed.AreAccessRulesProtected -or $observed.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access') -cne $expected){throw 'Actual atomic descriptor differs'};
      $rules=@($observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
      if($rules.Count -ne 2 -or @($rules|Where-Object {$_.IdentityReference.Value -notin @($broker,'S-1-5-18') -or $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl}).Count){throw 'Foreign access entered private root'};
      $marker=Join-Path $ordinary 'retained.txt';[IO.File]::WriteAllText($marker,'original');$before=(Get-Acl -LiteralPath $ordinary).Sddl;
      $refused=$false;try{[PortcoveAccountSetup]::CreatePrivateDirectory($ordinary,$broker)|Out-Null}catch{if($_.Exception.InnerException -is [ComponentModel.Win32Exception] -and $_.Exception.InnerException.NativeErrorCode -eq 183){$refused=$true}else{throw}};
      if(-not $refused -or (Get-Acl -LiteralPath $ordinary).Sddl -cne $before -or [IO.File]::ReadAllText($marker) -cne 'original'){throw 'Existing directory adopted or changed'};
      'atomic-root-cases-complete';`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
