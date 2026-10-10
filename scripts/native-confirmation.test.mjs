import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test(
  "actual library picker input paths refuse foreign controls and changed process/window identities",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pcv-picker-input-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const confirmationPath = path.resolve("apps/desktop/scripts/native-confirmation.ps1");
    const discoveryPath = path.resolve("apps/desktop/scripts/native-window-discovery.ps1");
    const script = path.join(root, "input.ps1");
    await writeFile(
      script,
      `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ast = [Management.Automation.Language.Parser]::ParseFile('${confirmationPath.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$discoveryAst = [Management.Automation.Language.Parser]::ParseFile('${discoveryPath.replaceAll("'", "''")}', [ref]$null, [ref]$null)
foreach ($entry in @(@($ast, 'Get-PickerFieldEvidence'), @($ast, 'Assert-LiveApplication'), @($ast, 'Get-OwnedConfirmationWindows'), @($discoveryAst, 'Assert-ExactConfirmationWindow'), @($discoveryAst, 'Get-OwnedLibraryPickerWindows'))) {
    $definition = $entry[0].Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $entry[1] }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$discoveryLoop = $ast.Find({ param($node) $node -is [Management.Automation.Language.WhileStatementAst] -and $node.Body.Extent.Text.Contains('$targets = @()') }, $true).Extent.Text
$directoryInput = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($DirectoryPath)') -and $node.Extent.Text.Contains('.SetValue($selected)') }, $true).Extent.Text
$buttonSelection = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains('$buttonDeadline =') }, $true).Extent.Text
$buttonInput = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($Button -ne') -and $node.Extent.Text.Contains("GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()") }, $true).Extent.Text
if (-not $discoveryLoop -or -not $directoryInput -or -not $buttonSelection -or -not $buttonInput) { throw 'Production input inventory changed' }
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -ceq 'ProcessId = 42' -and $script:liveApp.ProcessId -eq 42) { $script:liveApp }
    if ($Filter -ceq 'ProcessId = 43' -and $script:liveDriver.ProcessId -eq 43) { $script:liveDriver }
}
function Write-ObservationProgress { param($stage) }
function Get-NativePickerHandles { if ($script:case -eq 'ambiguous') { 7; 8 } elseif ($script:replaceWindow) { 8 } else { 7 } }
function Test-NativePickerWindow { param($handle) $true }
function New-FakeControl($name, $type, $process) {
    $control = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $name; ControlType = $type; ProcessId = $process; IsEnabled = $true } }
    $control | Add-Member ScriptMethod GetCurrentPattern { param($pattern) $this }
    $control | Add-Member ScriptMethod SetValue { param($value) $script:values++; $script:selected = $value; if ($script:case -eq 'replaced-window') { $script:replaceWindow = $true } }
    $control | Add-Member ScriptMethod Invoke { $script:invocations++ }
    return $control
}
function Get-PickerFieldEvidence { throw 'secondary picker capture failure' }
function Get-NativePickerElement {
    param($handle)
    $window = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $Title; ControlType = [System.Windows.Automation.ControlType]::Window; ProcessId = 42; NativeWindowHandle = [int]$handle } }
    $window | Add-Member ScriptMethod FindAll { param($scope, $condition) $script:controls }
    return $window
}
$applicationId = 42; $DriverProcessId = 43; $Title = 'Choose Portcove library'; $ExpectedText = 'Folder'; $Button = 'Select Folder'
$DirectoryPath = '${root.replaceAll("'", "''")}'; $FilePath = $null
$application = [pscustomobject]@{ ProcessId = 42; CreationDate = 'app-birth'; ExecutablePath = 'owned-app' }
$tree = [pscustomobject]@{ driver = [pscustomobject]@{ ProcessId = 43; CreationDate = 'driver-birth'; ExecutablePath = 'owned-driver' } }
foreach ($script:case in @('valid', 'app-birth', 'app-image', 'app-pid', 'driver-birth', 'driver-image', 'driver-pid', 'foreign-field', 'foreign-button', 'replaced-window', 'ambiguous')) {
    $script:values = 0; $script:invocations = 0; $script:selected = $null; $script:replaceWindow = $false
    $script:liveApp = [pscustomobject]@{ ProcessId = 42; CreationDate = 'app-birth'; ExecutablePath = 'owned-app' }
    $script:liveDriver = [pscustomobject]@{ ProcessId = 43; CreationDate = 'driver-birth'; ExecutablePath = 'owned-driver' }
    switch ($script:case) {
        app-birth { $script:liveApp.CreationDate = 'changed' } app-image { $script:liveApp.ExecutablePath = 'changed' } app-pid { $script:liveApp.ProcessId = 99 }
        driver-birth { $script:liveDriver.CreationDate = 'changed' } driver-image { $script:liveDriver.ExecutablePath = 'changed' } driver-pid { $script:liveDriver.ProcessId = 99 }
    }
    $fieldProcess = if ($script:case -eq 'foreign-field') { 99 } else { 42 }
    $buttonProcess = if ($script:case -eq 'foreign-button') { 99 } else { 42 }
    $script:controls = @((New-FakeControl 'Folder:' ([System.Windows.Automation.ControlType]::Edit) $fieldProcess), (New-FakeControl 'Select Folder' ([System.Windows.Automation.ControlType]::Button) $buttonProcess))
    $window = $null; $children = @(); $deadline = [DateTime]::UtcNow.AddSeconds(1); $rejected = $false
    try {
        . ([scriptblock]::Create($discoveryLoop))
        . ([scriptblock]::Create($directoryInput))
        $selectedWindowHandle = $window.Current.NativeWindowHandle
        . ([scriptblock]::Create($buttonSelection))
        . ([scriptblock]::Create($buttonInput))
    } catch { $rejected = $true; $script:failureReason = $_.Exception.Message }
    if ($script:case -eq 'valid') {
        if ($rejected -or $script:values -ne 1 -or $script:invocations -ne 1 -or $script:selected -cne $DirectoryPath) { throw "Valid actual mutation path failed: values=$script:values invocations=$script:invocations reason=$script:failureReason" }
    } else {
        $expectedValues = if ($script:case -in @('foreign-button', 'replaced-window')) { 1 } else { 0 }
        if (-not $rejected -or $script:values -ne $expectedValues -or $script:invocations -ne 0) { throw "Unsafe actual input on $script:case" }
        if ($script:case -eq 'foreign-field' -and $script:failureReason -cne 'Expected one exact owned folder field in the library picker.') { throw 'Secondary picker capture replaced guard failure' }
    }
}
'actual-input-contract-passed'
`,
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /actual-input-contract-passed/);
  },
);

const helper = path.resolve("apps/desktop/scripts/native-confirmation.ps1");

test("bootstrap legacy Profile binding retains choices and default without acquiring tools", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcv-bootstrap-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrap = path.resolve("scripts/bootstrap-quality-tools.ps1");
  const script = path.join(root, "binding.ps1");
  await writeFile(
    script,
    `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile('${bootstrap.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$parameters = $ast.ParamBlock.Extent.Text
$probe = [scriptblock]::Create($parameters + [Environment]::NewLine + 'Write-Output $CapabilityProfile')
$parameter = $probe.Ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -ceq 'CapabilityProfile' }
if (@($parameter).Count -ne 1) { throw 'Nonautomatic profile parameter missing' }
if ((& $probe) -cne 'standard') { throw 'Default profile changed' }
$values = @('standard', 'frontend', 'core', 'daily', 'native-desktop')
foreach ($value in $values) {
    if ((& $probe -Profile $value) -cne $value) { throw 'Legacy named profile binding changed' }
    if ((& $probe -CapabilityProfile $value) -cne $value) { throw 'Internal named profile binding changed' }
    if ((& $probe $value) -cne $value) { throw 'Positional profile binding changed' }
}
$refused = $false
try { & $probe -Profile unsupported } catch { $refused = $true }
if (-not $refused) { throw 'Profile validation weakened' }
$source = [IO.File]::ReadAllText('${bootstrap.replaceAll("'", "''")}')
if ($source -notmatch '-Profile standard\\|frontend\\|core\\|daily\\|native-desktop') { throw 'Legacy documented command changed' }
'bootstrap-binding-preserved'
`,
  );
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bootstrap-binding-preserved/);
});

test("captured picker driver keeps explicit image and birth identity checks at every call", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcv-driver-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "identity.ps1");
  await writeFile(
    script,
    `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$guard = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-CapturedPickerDriver' }, $false)
. ([scriptblock]::Create($guard.Extent.Text))
$DriverProcessId = $PID
$process = [Diagnostics.Process]::GetCurrentProcess()
$image = $process.MainModule.FileName
$birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
Assert-CapturedPickerDriver $image $birth
Assert-CapturedPickerDriver $image.ToUpperInvariant() $birth
$refused = 0
foreach ($pair in @(@('not-the-driver', $birth), @($image, '1'))) {
    try { Assert-CapturedPickerDriver $pair[0] $pair[1] }
    catch { if ($_.Exception.Message -ne 'Captured picker driver identity changed; no input permitted.') { throw }; $refused++ }
}
if ($refused -ne 2) { throw 'Identity mismatch was not rejected' }
$calls = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Assert-CapturedPickerDriver' }, $true))
if ($calls.Count -ne 6) { throw 'Unexpected driver check inventory' }
foreach ($call in $calls) {
    if ($call.CommandElements.Count -ne 3 -or $call.CommandElements[1].Extent.Text -cne '$ExpectedDriverPath' -or $call.CommandElements[2].Extent.Text -cne '$ExpectedDriverStartedFiletime') { throw 'Driver check lost exact explicit identity inputs' }
}
'identity-preserved'
`,
  );
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /identity-preserved/);
});

async function isolatedConsumer(t, fixture) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcv-confirmation-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = "apps/desktop/scripts/desktop-native-confirmation.mjs";
  await mkdir(path.join(root, "apps/desktop/scripts"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "output"));
  await copyFile(modulePath, path.join(root, modulePath));
  await writeFile(
    path.join(root, "scripts/dev-storage.mjs"),
    `export function spawnCommand(...args) { globalThis.calls.push(args); return globalThis.result; }`,
  );
  const script = path.join(root, "fixture.mjs");
  await writeFile(
    script,
    `import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { nativeConfirmation } from './${modulePath}';
const output = path.resolve('output');
const artifacts = [];
globalThis.calls = [];
${fixture}
`,
  );
  return {
    root,
    result: spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }),
  };
}

test(
  "failed confirmation retains a redacted helper receipt before its original assertion",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const { root, result } = await isolatedConsumer(
      t,
      `
globalThis.result = { status: 1, signal: null, stdout: '', stderr: 'original failure C:\\private\\secret' };
const confirm = nativeConfirmation({ application: 'C:\\owned.exe', getDriverPid: () => 1, output, artifacts });
await assert.rejects(confirm('fixture', '__observe__', 'fixture', 'failed'), error => error.actual === 1 && error.message.includes('original failure'));
assert.deepEqual(artifacts, [path.join(output, 'failed-helper-result.json')]);
assert.equal(globalThis.calls.length, 1);
assert.deepEqual(globalThis.calls[0][2], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
`,
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = await readFile(path.join(root, "output/failed-helper-result.json"), "utf8");
    assert.doesNotMatch(receipt, /private|secret|original failure/);
    assert.equal(JSON.parse(receipt).status, 1);
  },
);

test("failure projection exists independently of screenshot capture", async () => {
  const source = await readFile(helper, "utf8");
  assert.match(source, /function Get-NativeFailureEvidence/);
  assert.match(source, /trap\s*\{/);
  const progress = source.slice(
    source.indexOf("function Write-ObservationProgress"),
    source.indexOf("Write-ObservationProgress 'automation-assemblies-start'"),
  );
  assert.ok(progress.indexOf("$script:lastNativeStage") < progress.indexOf("if ($progressPath)"));
});

async function isolatedPowerShell(t, fixture, { trap = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcv-confirmation-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "native-confirmation.ps1");
  await writeFile(
    script,
    `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$projection = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-NativeFailureEvidence' }, $false).Extent.Text
$pickerProjection = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PickerFieldEvidence' }, $false).Extent.Text
$progress = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-ObservationProgress' }, $false).Extent.Text
$trapText = $ast.Find({ param($node) $node -is [Management.Automation.Language.TrapStatementAst] }, $false).Extent.Text
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixture).toString("base64")}'))
. ([scriptblock]::Create($pickerProjection))
# Evaluate only diagnostic definitions and controlled exceptions: no assemblies,
# process discovery, picker enumeration or input from the production script.
& ([scriptblock]::Create($projection + "\n" + $progress + "\n" + ${trap ? "$trapText + [Environment]::NewLine +" : ""} $fixture))
`,
  );
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
}

test("actual PowerShell projection retains stage and nested HRESULT without private details", async (t) => {
  const result = await isolatedPowerShell(
    t,
    `
$progressPath = $null
Write-ObservationProgress 'candidate-descendants-start'
$inner = [Runtime.InteropServices.COMException]::new('secret C:\\private\\file', -2147467259)
$outer = [InvalidOperationException]::new('private outer', $inner)
$record = [Management.Automation.ErrorRecord]::new($outer, 'secret-id', [Management.Automation.ErrorCategory]::NotSpecified, 'secret-target')
Get-NativeFailureEvidence $record | ConvertTo-Json -Depth 5 -Compress
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret|private/);
  const record = JSON.parse(result.stdout);
  assert.equal(record.stage, "candidate-descendants-start");
  assert.equal(record.location, null);
  assert.deepEqual(record.exceptions, [
    { type: "System.InvalidOperationException", hresult: "0x80131509" },
    { type: "System.Runtime.InteropServices.COMException", hresult: "0x80004005" },
  ]);
});

test("picker field diagnostics distinguish absence, ambiguity and ownership without private text", async (t) => {
  const result = await isolatedPowerShell(
    t,
    `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$applicationId = 42
function New-Field($name, $id, $process) {
    [pscustomobject]@{ Current = [pscustomobject]@{ ControlType = [System.Windows.Automation.ControlType]::Edit; Name = $name; AutomationId = $id; ProcessId = $process; IsEnabled = $true; Value = 'secret-path' } }
}
$foreign = New-Field 'Folder:' '1152' 99
$private = New-Field 'secret-name' 'secret-id' 42
@(Get-PickerFieldEvidence @(); Get-PickerFieldEvidence @($foreign, $private); Get-PickerFieldEvidence @(1..33 | ForEach-Object { $foreign })) | ConvertTo-Json -Depth 7 -Compress
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret/);
  const [absent, mixed, bounded] = JSON.parse(result.stdout);
  assert.equal(absent.edit_count, 0);
  assert.deepEqual(absent.samples, []);
  assert.equal(absent.total_count, 0);
  assert.equal(mixed.owned_folder_matches, 0);
  assert.equal(mixed.folder_label_count, 1);
  assert.deepEqual(mixed.samples, [
    { name_kind: "folder", automation_id: "1152", owned: false, enabled: true },
    { name_kind: "other", automation_id: "other", owned: true, enabled: true },
  ]);
  assert.equal(bounded.edit_count, 33);
  assert.equal(bounded.samples.length, 32);
  assert.equal(bounded.truncated, true);
});

test("projection bounds chains and treats absent or unknown details explicitly", async (t) => {
  const result = await isolatedPowerShell(
    t,
    `
$script:lastNativeStage = 'secret-stage'
$empty = [Management.Automation.ErrorRecord]::new([Exception]::new(), 'id', [Management.Automation.ErrorCategory]::NotSpecified, $null)
$nested = [Exception]::new('secret')
for ($i = 0; $i -lt 9; $i++) { $nested = [Exception]::new('secret', $nested) }
$record = [Management.Automation.ErrorRecord]::new($nested, 'id', [Management.Automation.ErrorCategory]::NotSpecified, $null)
@(Get-NativeFailureEvidence $empty; Get-NativeFailureEvidence $record; Get-NativeFailureEvidence $null) | ConvertTo-Json -Depth 6 -Compress
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret/);
  const [empty, bounded, absent] = JSON.parse(result.stdout);
  assert.equal(empty.stage, "unknown");
  assert.equal(empty.exceptions.length, 1);
  assert.equal(bounded.exceptions.length, 4);
  assert.equal(bounded.exceptions_truncated, true);
  assert.deepEqual(absent.exceptions, []);
  assert.equal(absent.location, null);
});

test("actual trap preserves nonzero exit and original error despite diagnostic failure", async (t) => {
  for (const captureFails of [false, true]) {
    const result = await isolatedPowerShell(
      t,
      `
$progressPath = $null
Write-ObservationProgress 'nested-discovery-start'
${captureFails ? "function Get-NativeFailureEvidence { throw 'secondary capture failure' }" : ""}
throw [InvalidOperationException]::new('original controlled failure')
'must-not-run'
`,
      { trap: true },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /original controlled failure/);
    assert.doesNotMatch(result.stdout, /must-not-run/);
    assert.doesNotMatch(result.stderr, /secondary capture failure/);
    if (!captureFails) {
      const line = result.stderr
        .split(/\r?\n/u)
        .find((value) => value.startsWith("PORTCOVE_NATIVE_FAILURE "));
      const record = JSON.parse(line.slice("PORTCOVE_NATIVE_FAILURE ".length));
      assert.equal(record.stage, "nested-discovery-start");
      assert.ok(record.location.line > 0);
      assert.ok(record.location.column > 0);
      assert.equal(record.location.script, "other");
    }
  }
});

test(
  "malformed, oversized and private diagnostic fields cannot leak through receipts",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const { result } = await isolatedConsumer(
      t,
      `
const payload = { format_version: 1, stage: 'nested-discovery-start', location: { script: 'native-confirmation.ps1', line: 250, column: 4, path: 'secret' }, exceptions: [{ type: 'System.Exception', hresult: '0x80131500', message: 'secret' }], exceptions_truncated: false, secret: 'private', picker_fields: { folder_matches: 1, total_count: 1, automation_element_count: 1, folder_label_count: 1, owned_folder_matches: 0, folder_name_matches: 0, file_name_matches: 0, empty_name_matches: 0, edit_count: 1, samples: [{ name_kind: 'folder', automation_id: '1152', owned: false, enabled: true, value: 'secret' }], truncated: false, path: 'secret' } };
for (const [index, stderr] of ['PORTCOVE_NATIVE_FAILURE {bad', 'PORTCOVE_NATIVE_FAILURE ' + 'x'.repeat(5000), 'PORTCOVE_NATIVE_FAILURE ' + JSON.stringify(payload), 'PORTCOVE_NATIVE_FAILURE ' + JSON.stringify({ ...payload, stage: 'secret' })].entries()) {
  globalThis.result = { status: 1, signal: null, stdout: 'private', stderr };
  await assert.rejects(nativeConfirmation({ application: 'owned', getDriverPid: () => 1, output, artifacts })('fixture', '__observe__', 'fixture', 'case-' + index), error => error.actual === 1);
  const receipt = await readFile(path.join(output, 'case-' + index + '-helper-result.json'), 'utf8');
  assert.doesNotMatch(receipt, /private|secret/);
  assert.equal(JSON.parse(receipt).diagnostic === null, index !== 2);
  if (index === 2) assert.deepEqual(JSON.parse(receipt).diagnostic.picker_fields, { folder_matches: 1, total_count: 1, automation_element_count: 1, folder_label_count: 1, owned_folder_matches: 0, folder_name_matches: 0, file_name_matches: 0, empty_name_matches: 0, edit_count: 1, truncated: false, samples: [{ name_kind: 'folder', automation_id: '1152', owned: false, enabled: true }] });
}
`,
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "receipt write failure stays secondary and existing evidence is never overwritten",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const { result } = await isolatedConsumer(
      t,
      `
await writeFile(path.join(output, 'existing-helper-result.json'), 'retained');
globalThis.result = { status: 7, signal: null, stdout: '', stderr: 'original failure' };
await assert.rejects(nativeConfirmation({ application: 'owned', getDriverPid: () => 1, output, artifacts })('fixture', '__observe__', 'fixture', 'existing'), error => error.actual === 7 && error.message.includes('original failure'));
assert.deepEqual(artifacts, []);
assert.equal(await readFile(path.join(output, 'existing-helper-result.json'), 'utf8'), 'retained');
`,
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "successful child JSON and malformed-success behavior remain unchanged",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const { result } = await isolatedConsumer(
      t,
      `
const observation = { title: 'fixture', application_pid: 2, screenshot: null };
globalThis.result = { status: 0, stdout: JSON.stringify(observation), stderr: '' };
assert.deepEqual(await nativeConfirmation({ application: 'owned', getDriverPid: () => 1, output, artifacts })('fixture', '__observe__', 'fixture', 'success'), observation);
assert.deepEqual(artifacts, [path.join(output, 'success.json')]);
globalThis.result = { status: 0, stdout: '{invalid', stderr: '' };
await assert.rejects(nativeConfirmation({ application: 'owned', getDriverPid: () => 1, output, artifacts })('fixture', '__observe__', 'fixture', 'invalid'), SyntaxError);
assert.equal(artifacts.length, 1);
`,
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "library picker discovery excludes unrelated providers and refuses changed identities",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pcv-native-discovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = path.resolve("apps/desktop/scripts/native-window-discovery.ps1");
    const script = path.join(root, "probe.ps1");
    await writeFile(
      script,
      `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationTypes
$ast = [Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}', [ref]$null, [ref]$null)
foreach ($name in @('Assert-ExactConfirmationWindow', 'Get-OwnedLibraryPickerWindows')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$applicationId = 42; $Title = 'Choose Portcove library'; $DirectoryPath = 'owned-fixture'
$script:live = $true; $script:validHandle = $true; $script:visited = @(); $script:handles = @(7)
function Assert-LiveApplication { if (-not $script:live) { throw 'application identity changed' } }
function Write-ObservationProgress { param($stage) $script:lastStage = $stage }
function Get-NativePickerHandles { $script:handles }
function Test-NativePickerWindow { param($handle) $script:validHandle }
function Get-NativePickerElement {
    param($handle)
    $script:visited += [int]$handle
    if ($handle -eq 99) { throw 'unrelated WebView provider visited' }
    if ($script:providerFailure) { throw [Runtime.InteropServices.COMException]::new('exact candidate provider failed', -2147467259) }
    [pscustomobject]@{ Current = [pscustomobject]@{ NativeWindowHandle = $handle; ProcessId = $script:candidatePid; Name = $script:candidateTitle; ControlType = [System.Windows.Automation.ControlType]::Window } }
}
$script:candidatePid = 42; $script:candidateTitle = $Title
$found = @(Get-OwnedLibraryPickerWindows)
if ($found.Count -ne 1 -or $script:visited.Count -ne 1 -or $script:visited[0] -ne 7) { throw 'exact picker discovery failed' }
# Both candidates must reach the caller; discovery must never silently choose one.
$script:handles = @(7, 8)
if (@(Get-OwnedLibraryPickerWindows).Count -ne 2) { throw 'ambiguity hidden' }
$script:handles = @()
if (@(Get-OwnedLibraryPickerWindows).Count -ne 0) { throw 'absent picker accepted' }
$script:handles = @(7)
foreach ($case in @('pid', 'title', 'handle', 'application')) {
    $script:candidatePid = 42; $script:candidateTitle = $Title; $script:validHandle = $true; $script:live = $true
    switch ($case) { pid { $script:candidatePid = 43 } title { $script:candidateTitle = 'other' } handle { $script:validHandle = $false } application { $script:live = $false } }
    $rejected = $false
    try { Get-OwnedLibraryPickerWindows } catch { $rejected = $true }
    if (-not $rejected) { throw "changed $case identity accepted" }
}
$script:live = $true; $script:candidatePid = 42; $script:candidateTitle = $Title; $script:validHandle = $true; $script:providerFailure = $true
$rejected = $false
try { Get-OwnedLibraryPickerWindows } catch {
    $rejected = $_.Exception -is [Runtime.InteropServices.COMException] -and $_.Exception.HResult -eq -2147467259
}
if (-not $rejected -or $script:lastStage -ne 'exact-root-discovery-ready') { throw 'exact provider failure lost' }
'discovery-contract-passed'
`,
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /discovery-contract-passed/);
  },
);

test(
  "actual HWND selection algorithm filters, deduplicates and bounds enumeration",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pcv-hwnd-selection-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = path.resolve("apps/desktop/scripts/native-window-discovery.ps1");
    const script = path.join(root, "algorithm.ps1");
    await writeFile(
      script,
      `
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText('${helper.replaceAll("'", "''")}')
$code = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@").Groups[1].Value
if (-not $code) { throw 'production algorithm absent' }
# Replace only the five OS boundaries; compile the production Matches/Find bodies.
$pattern = '(?m)^    \\[DllImport[^\\r\\n]+private static extern[^\\r\\n]+;'
if ([regex]::Matches($code, $pattern).Count -ne 5) { throw 'OS boundary inventory changed' }
$code = [regex]::Replace($code, $pattern, '')
$boundary = @'
    public static bool overflow = false, failed = false, disappeared = false;
    private static bool EnumWindows(Visitor visit, IntPtr state) {
        if (failed) return false;
        int limit = overflow ? 5000 : 4;
        for (int i = 1; i <= limit; i++) if (!visit(new IntPtr(i), state)) return false;
        return true;
    }
    private static bool EnumChildWindows(IntPtr parent, Visitor visit, IntPtr state) {
        if (parent.ToInt32() == 1) { visit(new IntPtr(2), state); visit(new IntPtr(5), state); }
        return true;
    }
    private static uint GetWindowThreadProcessId(IntPtr handle, out uint process) {
        process = handle.ToInt32() == 3 ? 99u : 42u; return 1;
    }
    private static int GetWindowText(IntPtr handle, StringBuilder text, int capacity) {
        string title = handle.ToInt32() == 1 ? "Portcove" : handle.ToInt32() == 4 ? "other" : "Choose Portcove library";
        text.Append(title); return title.Length;
    }
    private static bool IsWindow(IntPtr handle) { return !disappeared; }
'@
$insertion = $code.IndexOf('    public static bool Matches')
$code = $code.Insert($insertion, $boundary + [Environment]::NewLine)
Add-Type -TypeDefinition $code
$handles = @([PortcoveNativeWindows]::Find(42, 'Choose Portcove library') | ForEach-Object { $_.ToInt32() } | Sort-Object)
if (($handles -join ',') -cne '2,5') { throw 'PID/title/child filtering or deduplication changed' }
[PortcoveNativeWindows]::disappeared = $true
if ([PortcoveNativeWindows]::Matches([IntPtr]2, 42, 'Choose Portcove library')) { throw 'disappeared HWND accepted' }
[PortcoveNativeWindows]::disappeared = $false
foreach ($case in @('overflow', 'failed')) {
    if ($case -eq 'overflow') { [PortcoveNativeWindows]::overflow = $true } else { [PortcoveNativeWindows]::overflow = $false; [PortcoveNativeWindows]::failed = $true }
    $rejected = $false
    try { [PortcoveNativeWindows]::Find(42, 'Choose Portcove library') } catch { $rejected = $true }
    if (-not $rejected) { throw "incomplete $case enumeration accepted" }
}
'hwnd-contract-passed'
`,
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hwnd-contract-passed/);
  },
);
