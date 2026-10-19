import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildValidationPlan } from "./validation-plan.mts";
import {
  windowsHelperChecksRequired,
  windowsNativeToolsRequired,
} from "./windows-helper-checks.mts";
import { evaluateCiResults } from "./ci-result-gate.mts";

const sha = (character: string) => character.repeat(40);
const plan = (oldPath: string, newPath = oldPath, status = "M") =>
  buildValidationPlan({
    changes: [
      {
        oldPath,
        newPath,
        status,
        oldMode: "100644",
        newMode: status === "D" ? "000000" : "100644",
      },
    ],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
void test("native tool inputs retain affected Windows proof without frontend installation", () => {
  for (const file of [
    "apps/desktop/scripts/desktop-artwork-observations.mts",
    "apps/desktop/scripts/desktop-artwork-observations.native.test.mts",
    "apps/desktop/src/cli-command.ts",
    "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    "apps/desktop/scripts/desktop-install-fixture.native.test.mts",
    "apps/desktop/scripts/cli-command-shell.native.test.mts",
    "scripts/dev-storage.mts",
    "scripts/tool-cache.mts",
  ]) {
    for (const selected of [
      plan(file),
      plan(file, "docs/moved.md", "R100"),
      plan(file, file, "D"),
    ]) {
      assert.equal(windowsNativeToolsRequired(selected), true, file);
      assert.equal(windowsHelperChecksRequired(selected), true, file);
    }
  }
  assert.equal(windowsNativeToolsRequired(plan("apps/desktop/src/App.tsx")), false);
  assert.equal(
    windowsNativeToolsRequired({ ...plan("apps/desktop/src/App.tsx"), mode: "qualification" }),
    true,
  );
});

void test("Windows helper selection includes rename/delete sides and policy inputs without changing Rust selection", () => {
  for (const file of [
    "apps/desktop/scripts/native-window-discovery.ps1",
    "apps/desktop/scripts/desktop-native-confirmation.mts",
    "apps/desktop/scripts/browser-script.mts",
    "apps/desktop/scripts/browser-readiness.mts",
    "scripts/runtime-values.mts",
    "apps/desktop/scripts/desktop-test.mts",
    "scripts/frontend-command-preflight.mts",
    "scripts/viteplus-cli.mts",
    "scripts/desktop-verify.mts",
    ".github/workflows/ci.yml",
    ".config/powershell-resources.psd1",
  ]) {
    assert.equal(windowsHelperChecksRequired(plan(file)), true);
    assert.equal(windowsHelperChecksRequired(plan(file, "docs/moved-helper.md", "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan("docs/moved-helper.md", file, "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan(file, file, "D")), true);
  }
  for (const file of [
    "docs/README.md",
    "apps/desktop/src/App.tsx",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/src/library.rs",
  ])
    assert.equal(windowsHelperChecksRequired(plan(file)), false);
  const broad = plan("new-unknown-tool.xyz");
  assert.equal(windowsHelperChecksRequired(broad), true);
  assert(broad.groups.includes("rust"));
  assert.equal(windowsHelperChecksRequired({ ...broad, mode: "qualification" }), false);
});
void test("catalog aggregate rejects absent or failed selected Windows producer", () => {
  const input = {
    classifier: "success",
    plan: plan("scripts/desktop-verify.mts"),
    group: "catalog",
    prose: "skipped",
    fast: { fast_catalog: "success" },
    qualification: { catalog_full: "skipped" },
  };
  for (const status of [undefined, "skipped", "failure", "cancelled", "timed_out", ""])
    assert.throws(
      () =>
        evaluateCiResults({
          ...input,
          targeted: status === undefined ? {} : { windows_helpers: status },
        }),
      /windows_helpers.*expected success/,
    );
  assert.match(
    evaluateCiResults({ ...input, targeted: { windows_helpers: "success" } }),
    /Accepted fast/,
  );
  assert.throws(
    () =>
      evaluateCiResults({
        ...input,
        plan: plan("crates/portcove-core/catalog/catalog.json"),
        targeted: { windows_helpers: "success" },
      }),
    /expected skipped/,
  );
});
void test("workflow runs bounded Windows controls and pinned lint under the existing catalog aggregate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const windows = workflow.split("\n  windows_helpers:\n")[1];
  assert.ok(windows, "Windows helpers job must exist");
  const job = windows.split("\n  fast_catalog:")[0];
  assert.ok(job);
  assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /timeout-minutes: 10/);
  assert.match(job, /outputs.windows_helpers == 'true'/);
  assert.match(job, /--test-timeout=30000/);
  assert.match(job, /--test-concurrency=1/);
  assert.match(job, /native-confirmation.test.mts/);
  assert.match(job, /native-helper-dependencies.mts/);
  assert.match(job, /Import-PowerShellDataFile -LiteralPath .config\/powershell-resources.psd1/);
  assert.match(job, /Import-Module -Name PSScriptAnalyzer -RequiredVersion/);
  assert.match(job, /lint-tools.integration.mts psscriptanalyzer/);
  assert.doesNotMatch(
    job,
    /cargo (?:build|test)|desktop-verify.mts|desktop:build|bootstrap.*Desktop|native-driver|setup-vp|pnpm install/,
  );
  assert.match(
    job,
    /uses: \.\/\.github\/actions\/setup-rust\n\s+if: needs.classify.outputs.native_tools == 'true'/,
  );
  assert.match(
    job,
    /node --test --test-timeout=30000 apps\/desktop\/scripts\/\*\.native\.test\.mts/,
  );
  const catalogSection = workflow.split("\n  catalog:\n")[1];
  assert.ok(catalogSection, "catalog aggregate must exist");
  const catalog = catalogSection.split("\n  fast_dependency_review:")[0];
  assert.ok(catalog);
  assert.match(
    catalog,
    /needs: \[classify, prose_checks, fast_catalog, windows_helpers, catalog_full\]/,
  );
  assert.match(
    catalog,
    /PORTCOVE_TARGETED_RESULTS: '\{"windows_helpers":"\$\{\{ needs.windows_helpers.result \}\}"\}'/,
  );
  assert.equal((catalog.match(/PORTCOVE_TARGETED_RESULTS:/gu) ?? []).length, 1);
});

void test(
  "semantic storage accepts the observed Windows bus type and refuses unsafe disk associations",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const helper = fileURLToPath(
      new URL("./prepare-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'helper parse failed'}
$functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedDisk'},$true))
if($functions.Count -ne 1){throw 'exact production guard missing'}
foreach($command in $functions[0].FindAll({param($node)$node -is [Management.Automation.Language.CommandAst]},$true)){if($command.GetCommandName() -notin @('Get-DiskImage','Get-Disk')){throw 'guard contains an unexpected command'}}
Invoke-Expression $functions[0].Extent.Text
$image='X:/inert-only/reviewer.vhd'
$script:imageSet=@();$script:diskSet=@()
function Get-DiskImage {param($ImagePath,$ErrorAction) if($ImagePath -ne $image){throw 'wrong fixed path'};$script:imageSet}
function Get-Disk {param([Parameter(ValueFromPipeline=$true)]$InputObject) process{$script:diskSet}}
function Reset-Fixture {$script:imageSet=@([pscustomobject]@{Attached=$true});$script:diskSet=@([pscustomobject]@{UniqueId='observed-disk';Size=536870912;IsBoot=$false;IsSystem=$false;BusType='File Backed Virtual'})}
function Must-Refuse {try{$null=Get-OwnedDisk}catch{return};throw 'unsafe association was accepted'}
Reset-Fixture
if((Get-OwnedDisk).UniqueId -ne 'observed-disk'){throw 'observed provider representation was refused'}
$cases=1
foreach($change in @(@{UniqueId=''},@{Size=536870911},@{IsBoot=$true},@{IsSystem=$true},@{IsBoot=$null},@{IsSystem=$null},@{BusType='SATA'},@{BusType='Virtual'},@{BusType='FileBackedVirtual'})){
 Reset-Fixture
 foreach($key in $change.Keys){$script:diskSet[0].$key=$change[$key]}
 Must-Refuse;$cases++
}
Reset-Fixture;$script:imageSet[0].Attached=$false;Must-Refuse;$cases++
Reset-Fixture;$script:imageSet=@();Must-Refuse;$cases++
Reset-Fixture;$script:imageSet=@($script:imageSet[0],$script:imageSet[0]);Must-Refuse;$cases++
Reset-Fixture;$script:diskSet=@();Must-Refuse;$cases++
Reset-Fixture;$script:diskSet=@($script:diskSet[0],$script:diskSet[0]);Must-Refuse;$cases++
@{cases=$cases;mutations='none; extracted production guard with inert provider functions'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      cases: 15,
      mutations: "none; extracted production guard with inert provider functions",
    });
  },
);

void test(
  "semantic storage provisioning binds the returned partition object through its complete provider sequence",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const parent = await mkdtemp(path.join(tmpdir(), "portcove-storage-provider-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const helper = fileURLToPath(
      new URL("./prepare-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const root = path.join(parent, "owned").replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'helper parse failed'}
$guards=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-OwnedDisk'},$true))
$branches=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq "$"+"Operation -eq 'Provision'"},$true))
if($guards.Count -ne 1 -or $branches.Count -ne 1){throw 'exact production stages missing'}
$body=$branches[0].Clauses[0].Item2
foreach($command in $body.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)){
 if($command.GetCommandName() -notin @('Test-Path','New-Item','Set-Acl','Join-Path','diskpart.exe','Get-OwnedDisk','ConvertTo-Json','Set-Content','Initialize-Disk','New-Partition','Format-Volume','Add-PartitionAccessPath','Get-Content','Out-Null')){throw 'unexpected production command'}
}
Invoke-Expression $guards[0].Extent.Text
Invoke-Expression ('function Invoke-ProductionProvision '+$body.Extent.Text)
$root='${root}';$image=Join-Path $root 'reviewer.vhd';$mount=Join-Path $root 'data'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$ExpectedConfigurationSha256='a'*64
$script:disk=[pscustomobject]@{UniqueId='6002248094AE6EFC7984F0EC20A288AC';Path='provider-partition-disk-path';Size=536870912;IsBoot=$false;IsSystem=$false;BusType='File Backed Virtual';PartitionStyle='RAW'}
$script:partition=[pscustomobject]@{DiskId=$script:disk.Path;Offset=16777216}
$script:volume=[pscustomobject]@{Path='fixture-volume-guid';FileSystem='NTFS';Size=520024064}
$script:steps=[Collections.Generic.List[string]]::new()
function Get-DiskImage {param($ImagePath,$ErrorAction) if($ImagePath -ne $image){throw 'wrong image'};[pscustomobject]@{Attached=$true}}
function Get-Disk {param([Parameter(ValueFromPipeline=$true)]$InputObject) process{$script:disk}}
function Set-Acl {param($LiteralPath,$AclObject) if($LiteralPath -eq $root){$script:steps.Add('root-acl')}elseif($LiteralPath -eq $script:volume.Path){$script:steps.Add('volume-acl')}else{throw 'unexpected ACL target'}}
function diskpart.exe {param($s,$scriptFile) if($scriptFile -ne (Join-Path $root 'diskpart.txt')){throw 'wrong command file'};$script:steps.Add('attach');$global:LASTEXITCODE=0}
function Initialize-Disk {param($UniqueId,$PartitionStyle,$ErrorAction) if($UniqueId -ne $script:disk.UniqueId){throw 'wrong unique disk'};$script:steps.Add('initialize');$script:disk.PartitionStyle='GPT'}
function New-Partition {param($DiskId,[switch]$UseMaximumSize,$ErrorAction) if($DiskId -ne $script:disk.UniqueId){throw 'wrong partition input'};$script:steps.Add('partition');$script:partition}
function Format-Volume {param($Partition,$FileSystem,$NewFileSystemLabel,$Confirm,$ErrorAction) if(-not [object]::ReferenceEquals($Partition,$script:partition)){throw 'wrong format partition'};$script:steps.Add('format');$script:volume}
function Add-PartitionAccessPath {param($InputObject,$DiskId,$Offset,$AccessPath,$ErrorAction) if(-not [object]::ReferenceEquals($InputObject,$script:partition) -or $AccessPath -ne ($mount+'\\')){throw 'partition provider requires its returned object, not disk UniqueId'};$script:steps.Add('bind')}
$null=Invoke-ProductionProvision
$receipt=Get-Content -Raw -LiteralPath (Join-Path $root 'storage.json')|ConvertFrom-Json
if($receipt.disk_unique_id -ne $script:disk.UniqueId -or $receipt.volume_guid -ne $script:volume.Path -or $receipt.observed_volume_bytes -ne 520024064 -or $receipt.configuration_sha256 -ne $ExpectedConfigurationSha256){throw 'storage receipt differs'}
if(Test-Path -LiteralPath $image){throw 'inert provider test created an image'}
@{steps=@($script:steps);native_storage_calls=0;receipt='actual production branch'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      steps: ["root-acl", "attach", "initialize", "partition", "format", "bind", "volume-acl"],
      native_storage_calls: 0,
      receipt: "actual production branch",
    });
  },
);

void test(
  "retained storage completion verifies exact provider association and fresh mount readback",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const helper = fileURLToPath(
      new URL("./complete-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'completion parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Get-PreparedPartition','Connect-PreparedPartition')},$true))
if($functions.Count -ne 2){throw 'exact completion functions missing'}
foreach($function in $functions){
 foreach($command in $function.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)){
  if($command.GetCommandName() -notin @('Get-Partition','Where-Object','Get-Volume','Get-PreparedPartition','Add-PartitionAccessPath')){throw 'unexpected provider command'}
 }
 Invoke-Expression $function.Extent.Text
}
$mount='X:/inert-only/data';$script:disk=[pscustomobject]@{Path='partition-provider-id';UniqueId='physical-disk-id'}
function Reset-Fixture {
 $script:reserved=[pscustomobject]@{DiskId=$script:disk.Path;Offset=17408;Size=16759808}
 $script:data=[pscustomobject]@{DiskId=$script:disk.Path;Offset=16777216;Size=520028160;AccessPaths=@('fixture-volume-guid')}
 $script:volume=[pscustomobject]@{Path='fixture-volume-guid';UniqueId='fixture-volume-guid';FileSystem='NTFS';FileSystemLabel='PortcoveSemantic';Size=520024064}
 $script:binds=0;$script:omitReadback=$false
}
function Get-Partition {param($Disk,$ErrorAction) if(-not [object]::ReferenceEquals($Disk,$script:disk)){throw 'wrong disk object'};$script:reserved;$script:data}
function Get-Volume {param($Partition,$ErrorAction) if(-not [object]::ReferenceEquals($Partition,$script:data)){throw 'wrong volume association'};$script:volume}
function Add-PartitionAccessPath {param($InputObject,$AccessPath,$ErrorAction) if(-not [object]::ReferenceEquals($InputObject,$script:data) -or $AccessPath -ne ($mount+'\\')){throw 'wrong partition binding'};$script:binds++;if(-not $script:omitReadback){$script:data.AccessPaths+=($mount+'\\')}}
function Must-Refuse {try{$null=Connect-PreparedPartition $script:disk 'fixture-volume-guid'}catch{return};throw 'unsafe retained volume accepted'}
Reset-Fixture
if((Connect-PreparedPartition $script:disk 'fixture-volume-guid').Path -ne 'fixture-volume-guid' -or $script:binds -ne 1){throw 'valid retained volume refused'}
$cases=1
foreach($change in @(@{DiskId='physical-disk-id'},@{Offset=16777217},@{Size=520028159},@{AccessPaths=@('fixture-volume-guid','C:/unrelated/')})){
 Reset-Fixture;foreach($key in $change.Keys){$script:data.$key=$change[$key]};Must-Refuse;if($script:binds -ne 0){throw 'mutated before partition refusal'};$cases++
}
foreach($change in @(@{Path='other-volume'},@{UniqueId='other-volume'},@{FileSystem='FAT32'},@{FileSystemLabel='other-owner'},@{Size=520024065})){
 Reset-Fixture;foreach($key in $change.Keys){$script:volume.$key=$change[$key]};Must-Refuse;if($script:binds -ne 0){throw 'mutated before volume refusal'};$cases++
}
Reset-Fixture;$script:omitReadback=$true;Must-Refuse;if($script:binds -ne 1){throw 'ambiguous mount effect disappeared'};$cases++
@{cases=$cases;native_storage_calls=0;ambiguous_binding='retained; no automatic undo or retry'}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      cases: 11,
      native_storage_calls: 0,
      ambiguous_binding: "retained; no automatic undo or retry",
    });
  },
);

void test(
  "completion and incomplete recovery share one exclusive operator boundary before attach",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-completion-lock-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = fileURLToPath(
      new URL("./complete-semantic-storage.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'completion parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Open-CompletionOperationLock','Write-NewCompletionRecord')},$true))
if($functions.Count -ne 2){throw 'exact operator boundary missing'}
foreach($function in $functions){Invoke-Expression $function.Extent.Text}
$root='${root.replaceAll("'", "''")}'
$completion=Open-CompletionOperationLock $root
try{
 # Completion has persisted its intent, but has not reached the attach effect.
 Write-NewCompletionRecord (Join-Path $root 'completion-intent.json') @{phase='detached-before-completion'}
 $recovery=$null;$refused=$false
 try{$recovery=Open-CompletionOperationLock $root}catch{$refused=$true}finally{if($recovery){$recovery.Dispose()}}
 if(-not $refused){throw 'recovery entered while completion could still attach'}
}finally{$completion.Dispose()}
$settled=Open-CompletionOperationLock $root
try{
 # Recovery's sentinel and the launcher use the same CreateNew primitive. The
 # loser cannot start a reviewer or replace a preexisting ownership record.
 $marker=Join-Path $root 'reviewer-active.json'
 Write-NewCompletionRecord $marker @{kind='pre-fixture-completion-detach';fixture_started=$false}
 $launcher=$null;$refused=$false
 try{$launcher=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)}catch{$refused=$true}finally{if($launcher){$launcher.Dispose()}}
 if(-not $refused){throw 'launcher replaced recovery ownership'}
 try{Write-NewCompletionRecord $marker @{kind='replacement'};throw 'sentinel overwritten'}catch{if($_.Exception.Message -eq 'sentinel overwritten'){throw}}
}finally{$settled.Dispose()}
$locks=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains('$operationLock.Dispose()')},$true))
if($locks.Count -ne 1){throw 'operator lock not held to final readback'}
$commands=@($locks[0].Body.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object GetCommandName)
foreach($required in @('Mount-DiskImage','Dismount-DiskImage','Connect-PreparedPartition','Get-ExactImage')){if($required -notin $commands){throw 'mutation/readback escaped shared boundary'}}
@{live_completion='recovery refused';settled_completion='recovery lock acquired';recovery_marker='launcher refused';native_storage_calls=0}|ConvertTo-Json -Compress
`;
    const output = execFileSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(output), {
      live_completion: "recovery refused",
      settled_completion: "recovery lock acquired",
      recovery_marker: "launcher refused",
      native_storage_calls: 0,
    });
  },
);
