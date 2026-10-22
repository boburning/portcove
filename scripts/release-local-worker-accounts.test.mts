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

const resumeRecordBytes = {
  "intent.json":
    "eyJzY2hlbWFfdmVyc2lvbiI6MSwiYXV0aG9yaXR5IjoiY29uZGl0aW9uYWwtc2V0dXAtb25seSIsInJvb3Rfc2RkbCI6Ik86Uy0xLTUtMjEtMTAwNzEzMzgyMi00Mjc3Mjg5MjA3LTY0NjAyODQxNi0xMDAxRzpTLTEtNS0yMS0xMDA3MTMzODIyLTQyNzcyODkyMDctNjQ2MDI4NDE2LTEwMDFEOlAoQTtPSUNJO0ZBOzs7U1kpKEE7T0lDSTtGQTs7O1MtMS01LTIxLTEwMDcxMzM4MjItNDI3NzI4OTIwNy02NDYwMjg0MTYtMTAwMSkiLCJzb3VyY2Vfc2hhMjU2IjoiZWYyZjg4ODk2ZjMzZjQ5MDUzYzM2N2FhMTYyMTIzNDUyN2I5YmExMzA2NjgxNzc2Mjg3ZmI1ZDJiYTUzMmMxMCIsInBsYW5fc2hhMjU2IjoiNjdjMjhmNTExZGRiMjNmNjgyNmQ3MDI1ZThiYzAxMjcyNzYwOGI4YjdkM2RmOWJlYWFiM2IwZTI4MmUzNDY3YiIsImJyb2tlcl9zaWQiOiJTLTEtNS0yMS0xMDA3MTMzODIyLTQyNzcyODkyMDctNjQ2MDI4NDE2LTEwMDEifQo=",
  "account-0-intent.json":
    "eyJwcm9maWxlX2Fic2VudF9iZWZvcmUiOnRydWUsImFic2VudF9iZWZvcmUiOnRydWUsIm5hbWUiOiJQb3J0Y292ZU5hdGl2ZVF1YWwiLCJkZXNjcmlwdGlvbiI6IlBDNTM0OjY3YzI4ZjUxMWRkYjIzZjY4MjZkNzAyNWU4YmMwMTI3In0K",
  "account-0-created.json":
    "eyJwbGFuX3NoYTI1NiI6IjY3YzI4ZjUxMWRkYjIzZjY4MjZkNzAyNWU4YmMwMTI3Mjc2MDhiOGI3ZDNkZjliZWFhYjNiMGUyODJlMzQ2N2IiLCJwb2xpY3kiOnsicGFzc3dvcmRfZXhwaXJlcyI6bnVsbCwiYWNjb3VudF9leHBpcmVzIjpudWxsLCJ1c2VyX21heV9jaGFuZ2VfcGFzc3dvcmQiOmZhbHNlfSwibmFtZSI6IlBvcnRjb3ZlTmF0aXZlUXVhbCIsImRlc2NyaXB0aW9uIjoiUEM1MzQ6NjdjMjhmNTExZGRiMjNmNjgyNmQ3MDI1ZThiYzAxMjciLCJzaWQiOiJTLTEtNS0yMS0xMDA3MTMzODIyLTQyNzcyODkyMDctNjQ2MDI4NDE2LTEwMDgifQo=",
  "account-0-group-intent.json":
    "eyJwbGFuX3NoYTI1NiI6IjY3YzI4ZjUxMWRkYjIzZjY4MjZkNzAyNWU4YmMwMTI3Mjc2MDhiOGI3ZDNkZjliZWFhYjNiMGUyODJlMzQ2N2IiLCJhY2NvdW50X3NpZCI6IlMtMS01LTIxLTEwMDcxMzM4MjItNDI3NzI4OTIwNy02NDYwMjg0MTYtMTAwOCIsImdyb3VwX3NpZCI6IlMtMS01LTMyLTU0NSJ9Cg==",
  "account-0-group.json":
    "eyJhY2NvdW50X3NpZCI6IlMtMS01LTIxLTEwMDcxMzM4MjItNDI3NzI4OTIwNy02NDYwMjg0MTYtMTAwOCIsInByZXNlbnRfYmVmb3JlIjpmYWxzZSwiZ3JvdXBfc2lkIjoiUy0xLTUtMzItNTQ1IiwicHJlc2VudF9hZnRlciI6dHJ1ZX0K",
};
const resumePath = fileURLToPath(new URL("./resume-local-worker-profile.ps1", import.meta.url));
const resumeFunctions = `${ast}
$original=[IO.File]::ReadAllText(${quote(sourcePath)});
foreach($n in $tree.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($n.Extent.Text))};
$resumeTree=[Management.Automation.Language.Parser]::ParseFile(${quote(resumePath)},[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};
foreach($n in $resumeTree.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($n.Extent.Text))};
$linkInterop=$resumeTree.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true);. ([scriptblock]::Create($linkInterop.Extent.Text));
$programs=Get-ResumePrograms $original;. ([scriptblock]::Create($programs.acl));. ([scriptblock]::Create($programs.keys));Set-StrictMode -Version Latest;`;

void test(
  "profile continuation extracts the exact original suffix and refuses changed template boundaries",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${resumeFunctions}
    if($programs.suffix.Contains('New-LocalUser') -or $programs.suffix.Contains('Read-Host') -or $programs.suffix.Contains('Join-FixedUsers')){throw 'Account0 effects replayed'};
    if(-not $programs.body.Contains('New-LocalUser') -or -not $programs.tail.Contains('Assert-Account')){throw 'Original remaining path missing'};
    if(-not $programs.interop.Contains('new StringBuilder(260)') -or $programs.interop.Contains('new StringBuilder(32768)')){throw 'Profile buffer repair missing'};
    foreach($bad in @($original.Replace('new StringBuilder(32768)','new StringBuilder(1024)'),$original.Replace('$createdProfile=[PortcoveAccountSetup]::Profile($user.SID.Value,$name)','$createdProfile=Changed'),$original.Replace('source_sha256=$source;accounts=$accounts;','source_sha256=$source;different=$accounts;'))){
      $refused=$false;try{$null=Get-ResumePrograms $bad}catch{$refused=$true};if(-not $refused){throw 'Changed extraction boundary admitted'}
    };
    'exact-continuation-boundaries-pass';`);
  },
);

void test(
  "actual continued loop, real temporary ACL tail and credentials to enable retain the existing account",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pc-profile-resume-"));
    try {
      powershell(`${resumeFunctions}
      $base=${quote(directory)};$root=Join-Path $base 'root';$bootstrap=Join-Path $base 'bootstrap';
      [IO.Directory]::CreateDirectory($root)|Out-Null;[IO.Directory]::CreateDirectory($bootstrap)|Out-Null;
      $broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $PlanSha256='67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b';$source='ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10';$resumeSource='c'*64;
      $sid0='S-1-5-21-1007133822-4277289207-646028416-1008';$sid1='S-1-5-21-1007133822-4277289207-646028416-1009';
      $aclCalls=0;$description='PC534:'+$PlanSha256.Substring(0,32);$users=@{};$prompts=@();$newUsers=@();$enables=@();
      $users.PortcoveNativeQual=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value=$sid0};Description=$description;Enabled=$false;UserMayChangePassword=$false;PasswordExpires=$null;AccountExpires=$null};
      $maps=@{'C:\\Users\\PortcoveNativeQual'=(Join-Path $base 'profile0');'C:\\Users\\PortcovePublicProof'=(Join-Path $base 'profile1')};
      foreach($p in $maps.Values){[IO.Directory]::CreateDirectory($p)|Out-Null};
      function Map-Path($p){if($maps.ContainsKey($p)){return $maps[$p]};return $p};
      function Get-Acl {param($LiteralPath)$physical=Map-Path $LiteralPath;if($physical.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){return Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $physical};$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner([Security.Principal.SecurityIdentifier]::new($broker));$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($broker),'FullControl','Allow'));return $a};
      . ([scriptblock]::Create($programs.acl.Replace('function Set-ExactDirectoryAcl','function Set-TestMappedAclCore')));
      function Set-ExactDirectoryAcl {param($Path,$Broker,[string[]]$ReadSids=@(),[string]$ModifySid='')Set-TestMappedAclCore (Map-Path $Path) $Broker $ReadSids $ModifySid};
      function Get-Item {param($LiteralPath,[switch]$Force)Microsoft.PowerShell.Management\\Get-Item -LiteralPath (Map-Path $LiteralPath) -Force};
      function Get-LocalUser {param($Name)if(-not $users.ContainsKey($Name)){throw 'Unknown user'};return $users[$Name]};
      function New-LocalUser {param($Name,$Password,$Description,[switch]$AccountNeverExpires,[switch]$PasswordNeverExpires,[switch]$UserMayNotChangePassword,[switch]$Disabled)
        if($Name -cne 'PortcovePublicProof' -or -not $Disabled -or $Password -isnot [Security.SecureString]){throw 'Existing account recreated or wrong new-account policy'};
        $script:newUsers+=,$Name;$users[$Name]=[pscustomobject]@{Name=$Name;SID=[pscustomobject]@{Value=$sid1};Description=$Description;Enabled=$false;UserMayChangePassword=$false;PasswordExpires=$null;AccountExpires=$null};return $users[$Name]
      };
      function Get-LocalGroup {return [pscustomobject]@{SID=[pscustomobject]@{Value='S-1-5-32-545'}}};
      function Get-LocalGroupMember {param($SID,$ErrorAction)return @($users.Values|ForEach-Object {[pscustomobject]@{SID=$_.SID}})};
      function Add-LocalGroupMember {throw 'Fixture members already observed; no repeated group add'};
      function Get-ItemProperty {param($LiteralPath,$Name)if($LiteralPath.EndsWith($sid0)){return [pscustomobject]@{ProfileImagePath='C:\\Users\\PortcoveNativeQual'}};if($LiteralPath.EndsWith($sid1)){return [pscustomobject]@{ProfileImagePath='C:\\Users\\PortcovePublicProof'}};throw 'Unknown profile'};
      function Read-Host {param($Prompt,[switch]$AsSecureString)if(-not $AsSecureString){throw 'Plain prompt'};$script:prompts+=,$Prompt;$s=[Security.SecureString]::new();$s.AppendChar('x');return $s};
      function Enable-LocalUser {param($SID)$match=@($users.Values|Where-Object {$_.SID.Value -ceq $SID});if($match.Count -ne 1){throw 'Unknown activation SID'};$script:enables+=,$SID;$match[0].Enabled=$true};
      Add-Type 'public static class PortcoveAccountSetup { public static int stores=0; public static int failStore=-1; public static string Profile(string sid,string name){var path=@"C:\\Users\\"+name;System.Console.Error.WriteLine("inert Profile("+name+")="+path);return path;} public static void AssertAbsent(int index){} public static void Store(int index,string name,string sid,System.Security.SecureString password){if(index==failStore)throw new System.InvalidOperationException("inert store refusal");stores++;} public static void Check(int index,string name){if(stores!=2)throw new System.InvalidOperationException("incomplete inert credentials");} }';
      Set-ExactDirectoryAcl $base $broker|Out-Null;Set-ExactDirectoryAcl $root $broker|Out-Null;
      $prefixBytes=${quote(JSON.stringify(resumeRecordBytes))}|ConvertFrom-Json;foreach($p in $prefixBytes.PSObject.Properties){[IO.File]::WriteAllBytes((Join-Path $root $p.Name),[Convert]::FromBase64String($p.Value))};
      $continuation=@{kind='exact-recorded-profile-continuation-v1';actual_continuation_sha256=$resumeSource;original_template_sha256=$source;original_intent_sha256='e85e68d55f490ae3023666cfdb66359cccb6a57d2704f8d17c690f5b89f6d52e';owned_account_sid=$sid0;profile_buffer_characters=260};
      Invoke-ResumePrograms $programs $users.PortcoveNativeQual $root $broker $PlanSha256 $continuation;
      $createdRead=Read-BoundedJson (Join-Path $root 'created.json');$created=$createdRead.value;
      if(($newUsers -join ',') -cne 'PortcovePublicProof' -or $prompts.Count -ne 1 -or $created.accounts[0].sid -cne $sid0 -or $created.accounts[1].sid -cne $sid1 -or $created.source_sha256 -cne $source -or $created.continuation.actual_continuation_sha256 -cne $resumeSource){throw 'Continuation identity/effect accounting differs'};
      foreach($account in $created.accounts){$acl=Get-Acl -LiteralPath $account.work;$foreign=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -in @($sid0,$sid1) -and $_.IdentityReference.Value -cne $account.sid});if($foreign.Count){throw 'Cross-account work access'}};
      foreach($leaf in @('config','credentials','capture')){foreach($ace in (Get-Acl -LiteralPath (Join-Path $root $leaf)).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($ace.IdentityReference.Value -in @($sid0,$sid1)){throw 'Private leaf readable'}}};
      Write-NewJson (Join-Path $bootstrap 'profile-resume-intent-20261022.json') @{schema_version=1;continuation=$continuation;preimage=(Get-ResumePreimage);automatic_retry=$false};$intentRead=Read-BoundedJson (Join-Path $bootstrap 'profile-resume-intent-20261022.json');
      Write-NewJson (Join-Path $bootstrap 'profile-resume-complete-20261022.json') @{schema_version=1;actual_continuation_sha256=$resumeSource;intent_sha256=$intentRead.sha256;created_sha256=$createdRead.sha256;automatic_retry=$false;accounts_remain_disabled=$true};
      $refused=$false;try{$null=Assert-ResumeCompletion $root $bootstrap ('d'*64)}catch{$refused=$true};if(-not $refused){throw 'Wrong actual source accepted'};
      $completion=Assert-ResumeCompletion $root $bootstrap $resumeSource;if(-not $completion.accounts_remain_disabled){throw 'Premature activation'};
      $prefixFile=Join-Path $root 'account-0-created.json';$prefixOriginal=[IO.File]::ReadAllBytes($prefixFile);[IO.File]::WriteAllBytes($prefixFile,($prefixOriginal+[byte]32));
      $refused=$false;try{$null=Assert-ResumeCompletion $root $bootstrap $resumeSource}catch{$refused=$true};if(-not $refused){throw 'Changed original record accepted'};[IO.File]::WriteAllBytes($prefixFile,$prefixOriginal);
      $wrongPreimage=(Get-ResumePreimage);$wrongPreimage['account-0-created.json']=@(311,('f'*64));$refused=$false;try{Assert-ResumePreimage $root $wrongPreimage}catch{$refused=$true};if(-not $refused){throw 'Changed preimage map accepted'};
      $originalKeys=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-Keys'},$true);. ([scriptblock]::Create($originalKeys.Extent.Text));
      $credentialBranch=$tree.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -ceq '$Mode -eq ''credentials'''},$true);
      $enableBranch=$tree.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -ceq '$Mode -eq ''enable'''},$true);
      $names=@('PortcoveNativeQual','PortcovePublicProof');$Mode='credentials';. ([scriptblock]::Create($credentialBranch.Extent.Text));
      if([PortcoveAccountSetup]::stores -ne 2 -or $enables.Count){throw 'Credentials/enable boundary crossed'};
      $CreatedSha256='f'*64;$BrokerReceiptSha256=(Read-BoundedJson (Join-Path $root 'credentials-complete.json')).sha256;$Mode='enable';
      $refused=$false;try{. ([scriptblock]::Create($enableBranch.Extent.Text))}catch{$refused=$true};if(-not $refused -or $enables.Count){throw 'Wrong receipt hash admitted'};
      $CreatedSha256=$createdRead.sha256;. ([scriptblock]::Create($enableBranch.Extent.Text));
      if($enables.Count -ne 2 -or -not (Test-Path -LiteralPath (Join-Path $root 'enabled.json'))){throw 'Exact original activation path failed'};
      $refused=$false;try{. ([scriptblock]::Create($enableBranch.Extent.Text))}catch{$refused=$true};if(-not $refused -or $enables.Count -ne 2){throw 'Activation replayed'};
      foreach($u in $users.Values){$u.Enabled=$false};$enables=@();$root=Join-Path $base 'partial-credentials';[IO.Directory]::CreateDirectory($root)|Out-Null;
      [PortcoveAccountSetup]::stores=0;[PortcoveAccountSetup]::failStore=1;$Mode='credentials';$failed=$false;
      try{. ([scriptblock]::Create($credentialBranch.Extent.Text))}catch{if($_.Exception.Message -notmatch 'inert store refusal'){throw};$failed=$true};
      if(-not $failed -or [PortcoveAccountSetup]::stores -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $root 'credentials-intent.json')) -or (Test-Path -LiteralPath (Join-Path $root 'credentials-complete.json')) -or $enables.Count){throw 'Partial credential effects lost or activated'};
      $failed=$false;try{. ([scriptblock]::Create($credentialBranch.Extent.Text))}catch{$failed=$true};if(-not $failed -or [PortcoveAccountSetup]::stores -ne 1){throw 'Credential ambiguity retried'};
      'complete-controlled-journey-pass';`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
void test(
  "recorded profile continuation refuses changed users, policy, groups and existing or unavailable profiles",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${resumeFunctions}
    $case='valid';$sid='S-1-5-21-1007133822-4277289207-646028416-1008';
    function Get-LocalUser {param($ErrorAction)
      $row=[pscustomobject]@{Name='PortcoveNativeQual';SID=[pscustomobject]@{Value=$sid};Description='PC534:67c28f511ddb23f6826d7025e8bc0127';Enabled=($case -ceq 'enabled');UserMayChangePassword=($case -ceq 'policy');PasswordExpires=$null;AccountExpires=$null};
      if($case -ceq 'sid'){$row.SID.Value='S-1-5-21-1-2-3-9999'};if($case -ceq 'description'){$row.Description='foreign'};
      if($case -ceq 'unknown-user'){throw 'unavailable SAM'};if($case -ceq 'missing'){return};if($case -in @('second','second-case')){return @($row,[pscustomobject]@{Name=if($case -ceq 'second-case'){'portcovepublicproof'}else{'PortcovePublicProof'}})};return $row
    };
    function Get-LocalGroup {param($ErrorAction)if($case -ceq 'group'){return [pscustomobject]@{SID=[pscustomobject]@{Value='S-1-5-32-544'}}};return [pscustomobject]@{SID=[pscustomobject]@{Value='S-1-5-32-545'}}};
    function Get-LocalGroupMember {param($SID,$ErrorAction)return [pscustomobject]@{SID=[pscustomobject]@{Value='S-1-5-21-1007133822-4277289207-646028416-1008'}}};
    function Assert-RecoveryAbsent {param($Path)if($case -ceq 'directory'){throw 'existing fixed path'}};
    function Get-ChildItem {param($LiteralPath,$ErrorAction)if($case -ceq 'unknown-profile'){throw 'unavailable ProfileList'};if($case -in @('registered','suffix')){return [pscustomobject]@{PSChildName=if($case -ceq 'registered'){$sid}else{'other'};PSPath='inert'}}};
    function Get-ItemProperty {param($LiteralPath,$ErrorAction)return [pscustomobject]@{ProfileImagePath='C:\\Users\\PortcoveNativeQual.other'}};
    $null=Assert-ResumeProvider;
    foreach($case in @('enabled','policy','sid','description','unknown-user','missing','second','second-case','group','directory','unknown-profile','registered','suffix')){
      $refused=$false;try{$null=Assert-ResumeProvider}catch{$refused=$true};if(-not $refused){throw ('Unsafe resume admitted: '+$case)}
    };
    'recorded-provider-refusals-pass';`);
  },
);

void test(
  "ACL identity ignores only auto-inherited bookkeeping and retains protection owner and foreign-grant refusals",
  { skip: process.platform !== "win32" },
  () => {
    powershell(`${resumeFunctions}
    $owner='S-1-5-21-1-2-3-1001';$base='O:'+$owner+'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;'+$owner+')';
    $make={param($s)$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetSecurityDescriptorSddlForm($s);return $a};
    $expected=& $make $base;$auto=& $make ($base.Replace('D:P','D:PAI'));
    if((Get-SetupAclIdentity $expected) -cne (Get-SetupAclIdentity $auto)){throw 'Benign auto-inherited flag rejected'};
    foreach($bad in @($base.Replace('D:P','D:'),$base.Replace('O:'+$owner,'O:S-1-5-21-1-2-3-9999'),($base+'(A;OICI;FA;;;S-1-5-21-1-2-3-9999)'))){if((Get-SetupAclIdentity (& $make $bad)) -ceq (Get-SetupAclIdentity $expected)){throw 'Material ACL change ignored'}};
    'exact-acl-permissions-pass';`);
  },
);

void test(
  "reviewed source installation is private atomic hash-bound held against writers and never overwrites retained source",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pc-profile-source-"));
    const installed = path.join(directory, "profile-resume.ps1");
    try {
      powershell(`${resumeFunctions}
      $directory=${quote(directory)};$target=${quote(installed)};$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      Set-ExactDirectoryAcl $directory $broker|Out-Null;
      function Assert-RecoveryDirectory {param($Path,$Broker)if($Path -cne $directory){throw 'Other installer directory'};$a=Get-Acl -LiteralPath $Path;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Broker){throw 'Unowned installer fixture'}};
      $installNode=$resumeTree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Open-ProfileResumeSource'},$true);
      . ([scriptblock]::Create($installNode.Extent.Text.Replace(${quote("'C:\\ProgramData\\PortcoveSlice4Bootstrap\\profile-resume.ps1'")},${quote(quote(installed))})));
      $payload='Write-Output ''inert-reviewed-source''';$bytes=[Text.Encoding]::UTF8.GetBytes($payload);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant();
      $held=Open-ProfileResumeSource $bytes $hash $broker;
      try{
        if(-not $held.CanRead -or $held.CanWrite -or [IO.File]::ReadAllText($target) -cne $payload){throw 'Installed bytes/hold differ'};
        $child=& "$PSHOME\\pwsh.exe" -NoProfile -NonInteractive -File $target;if($LASTEXITCODE -ne 0 -or $child -cne 'inert-reviewed-source'){throw 'Held source child startup failed'};
        $acl=Get-Acl -LiteralPath $target;if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $broker){throw 'Installed source custody differs'};
        foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($ace.IdentityReference.Value -notin @($broker,'S-1-5-18')){throw 'Foreign source access'}};
        $refused=$false;try{$other=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$other.Dispose()}catch [IO.IOException]{$refused=$true};if(-not $refused){throw 'Source changed during execution hold'};
      }finally{$held.Dispose()};
      $before=(Get-Item -LiteralPath $target).LastWriteTimeUtc;$reused=Open-ProfileResumeSource $bytes $hash $broker;$reused.Dispose();if((Get-Item -LiteralPath $target).LastWriteTimeUtc -ne $before){throw 'Existing source rewritten'};
      $changed=[Text.Encoding]::UTF8.GetBytes('different-reviewed-source');$changedHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($changed)).ToLowerInvariant();
      $refused=$false;try{$other=Open-ProfileResumeSource $changed $changedHash $broker;$other.Dispose()}catch{$refused=$true};if(-not $refused -or [IO.File]::ReadAllText($target) -cne $payload){throw 'Retained source overwritten'};
      $refused=$false;try{$other=Open-ProfileResumeSource ([byte[]]::new(65537)) ('f'*64) $broker;$other.Dispose()}catch{$refused=$true};if(-not $refused){throw 'Unbounded source admitted'};
      'private-source-installation-pass';`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
