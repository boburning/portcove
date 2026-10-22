import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sourcePath = fileURLToPath(
  new URL("./recover-local-worker-empty-setup.ps1", import.meta.url),
);
const helperPath = fileURLToPath(new URL("./release-local-worker-accounts.ps1", import.meta.url));
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const originalIntent =
  '{"root_sddl":"O:S-1-5-21-1007133822-4277289207-646028416-1001G:S-1-5-21-1007133822-4277289207-646028416-1001D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1007133822-4277289207-646028416-1001)","schema_version":1,"authority":"conditional-setup-only","source_sha256":"ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10","plan_sha256":"67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b","broker_sid":"S-1-5-21-1007133822-4277289207-646028416-1001"}\n';
const originalAccount =
  '{"description":"PC534:67c28f511ddb23f6826d7025e8bc0127","name":"PortcoveNativeQual","absent_before":true,"profile_absent_before":true}\n';
const load = `$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$tree=[Management.Automation.Language.Parser]::ParseFile(${quote(sourcePath)},[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};foreach($node in $tree.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $node.Extent.Text};$native=$tree.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true);Invoke-Expression $native.Extent.Text;$old=[Management.Automation.Language.Parser]::ParseFile(${quote(helperPath)},[ref]$tokens,[ref]$errors);$writer=$old.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-NewJson'},$true);Invoke-Expression $writer.Extent.Text;`;
function run(script: string) {
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", load + script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout || String(r.error));
  return r.stdout;
}
const windows = { skip: process.platform !== "win32" };
void test(
  "empty setup archive preserves bytes and hands off to the exclusive recovery lock across actual same-volume rename",
  windows,
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "pc-empty-recovery-"));
    try {
      run(`$parent=${quote(temp)};$root=Join-Path $parent 'original';$archive=Join-Path $parent 'retained';$intent=Join-Path $parent 'recovery.json';[IO.Directory]::CreateDirectory($root)|Out-Null;
 [IO.File]::WriteAllText((Join-Path $root 'intent.json'),${quote(originalIntent)},[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $root 'account-0-intent.json'),${quote(originalAccount)},[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllBytes((Join-Path $root 'setup.lock'),[byte[]]@());
 # Controlled provider/ACL seam: file bytes, native link counts, rename and lock are real.
 function Assert-RecoveryDirectory {param($Path,$Broker)};function Assert-NoWorkerAccountsOrProfiles {};
 function Get-Acl {param($LiteralPath)return [pscustomobject]@{Sddl=(${quote(originalIntent)}|ConvertFrom-Json).root_sddl}};
 $held=Move-EmptyRecovery $root $archive $intent 'fixture-broker';try{
 if([IO.Directory]::Exists($root) -or -not [IO.Directory]::Exists($archive) -or -not [IO.File]::Exists($intent)){throw 'Archive/intent missing'};
 Assert-EmptyRecoveryContents $archive;
 $refused=$false;try{$other=[IO.File]::Open(($intent+'.lock'),'Open','ReadWrite','None');$other.Dispose()}catch{$refused=$true};if(-not $refused){throw 'Exclusive recovery lock lost'};
 $refused=$false;try{Move-EmptyRecovery $root $archive $intent 'fixture-broker'}catch{$refused=$true};if(-not $refused){throw 'Recovery replay admitted'};
 }finally{$held.Dispose()};`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
void test(
  "retained empty-state readers refuse changed bytes, additional effects and multiply linked evidence",
  windows,
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "pc-empty-refusals-"));
    try {
      run(`$root=${quote(temp)};[IO.File]::WriteAllText((Join-Path $root 'intent.json'),${quote(originalIntent)},[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $root 'account-0-intent.json'),${quote(originalAccount)},[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllBytes((Join-Path $root 'setup.lock'),[byte[]]@());Assert-EmptyRecoveryContents $root;
 [IO.File]::AppendAllText((Join-Path $root 'account-0-intent.json'),'x');$refused=$false;try{Assert-EmptyRecoveryContents $root}catch{$refused=$true};if(-not $refused){throw 'Changed bytes admitted'};
 [IO.File]::WriteAllText((Join-Path $root 'account-0-intent.json'),${quote(originalAccount)},[Text.UTF8Encoding]::new($false));
 [IO.File]::WriteAllText((Join-Path $root 'created.json'),'effect');$refused=$false;try{Assert-EmptyRecoveryContents $root}catch{$refused=$true};if(-not $refused){throw 'Additional effect admitted'};[IO.File]::Delete((Join-Path $root 'created.json'));
 $link=Join-Path $root 'alias';New-Item -ItemType HardLink -Path $link -Target (Join-Path $root 'intent.json')|Out-Null;
 $outside=Join-Path ([IO.Path]::GetDirectoryName($root)) (([IO.Path]::GetFileName($root))+'-alias');[IO.File]::Move($link,$outside);try{$refused=$false;try{Assert-EmptyRecoveryContents $root}catch{$refused=$true};if(-not $refused){throw 'Multiply linked evidence admitted'}}finally{[IO.File]::Delete($outside)};`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
void test(
  "fresh setup child failure is retained once and cannot replay after its result exists",
  windows,
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "pc-empty-child-"));
    try {
      run(`$PSNativeCommandUseErrorActionPreference=$true;$root=${quote(temp)};$child=Join-Path $root 'inert.ps1';$counter=Join-Path $root 'called.txt';[IO.File]::WriteAllText($child,('[IO.File]::AppendAllText('+"'"+$counter+"'"+",'called');exit 7"));
 $refused=$false;try{Invoke-FreshAccountSetup $child 'inert-plan' $root 'inert-archive'}catch{$refused=$true};if(-not $refused){throw 'Child failure accepted'};
 $result=[IO.File]::ReadAllText((Join-Path $root 'empty-setup-recovery-result-20261022.json'))|ConvertFrom-Json;if($result.child_exit -ne 7 -or $result.automatic_retry){throw 'Failed effect lost'};
 try{Invoke-FreshAccountSetup $child 'inert-plan' $root 'inert-archive'}catch{};if([IO.File]::ReadAllText($counter) -cne 'called'){throw 'Child replayed'};'child-failure-cases-complete';`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
void test(
  "provider presence, unavailable process evidence and profile registration refuse recovery",
  windows,
  () => {
    run(String.raw`function Get-LocalUser {return [pscustomobject]@{Name='PortcoveNativeQual'}};$refused=$false;try{Assert-NoWorkerAccountsOrProfiles}catch{$refused=$true};if(-not $refused){throw 'Account present admitted'};
 function Get-LocalUser {return @()};function Assert-RecoveryAbsent {param($Path)};function Get-ChildItem {return @()};function Get-CimInstance {return [pscustomobject]@{ProcessId=999999;CommandLine=$null}};
 $refused=$false;try{Assert-NoWorkerAccountsOrProfiles}catch{$refused=$true};if(-not $refused){throw 'Unknown process admitted'};
 function Get-CimInstance {return @()};function Get-ChildItem {return [pscustomobject]@{PSPath='inert'}};function Get-ItemProperty {return [pscustomobject]@{ProfileImagePath='C:\Users\PortcoveNativeQual'}};
 $refused=$false;try{Assert-NoWorkerAccountsOrProfiles}catch{if($_.Exception.Message -cne 'Worker profile registration exists'){throw};$refused=$true};if(-not $refused){throw 'Profile registration admitted'};'provider-refusal-cases-complete';`);
  },
);

void test(
  "actual trusted-writer dot-source defines the original receipt writer in caller scope",
  windows,
  () => {
    run(`$expectedDefinition=(Get-Command Write-NewJson -CommandType Function).Definition;Remove-Item Function:\\Write-NewJson;
  $dot=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot -and $n.Extent.Text.Contains('$writer.Extent.Text')},$true));
  if($dot.Count -ne 1){throw 'Trusted writer statement missing or duplicated'};
  Invoke-Expression $dot[0].Extent.Text;
  $actual=Get-Command Write-NewJson -CommandType Function -ErrorAction Stop;
  if($actual.Definition -cne $expectedDefinition){throw 'Original writer definition differs'};
  'trusted-writer-scope-pass';`);
  },
);
