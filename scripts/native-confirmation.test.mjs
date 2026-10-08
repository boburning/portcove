import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const helper = path.resolve("apps/desktop/scripts/native-confirmation.ps1");

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
$progress = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-ObservationProgress' }, $false).Extent.Text
$trapText = $ast.Find({ param($node) $node -is [Management.Automation.Language.TrapStatementAst] }, $false).Extent.Text
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixture).toString("base64")}'))
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
const payload = { format_version: 1, stage: 'nested-discovery-start', location: { script: 'native-confirmation.ps1', line: 250, column: 4, path: 'secret' }, exceptions: [{ type: 'System.Exception', hresult: '0x80131500', message: 'secret' }], exceptions_truncated: false, secret: 'private' };
for (const [index, stderr] of ['PORTCOVE_NATIVE_FAILURE {bad', 'PORTCOVE_NATIVE_FAILURE ' + 'x'.repeat(5000), 'PORTCOVE_NATIVE_FAILURE ' + JSON.stringify(payload), 'PORTCOVE_NATIVE_FAILURE ' + JSON.stringify({ ...payload, stage: 'secret' })].entries()) {
  globalThis.result = { status: 1, signal: null, stdout: 'private', stderr };
  await assert.rejects(nativeConfirmation({ application: 'owned', getDriverPid: () => 1, output, artifacts })('fixture', '__observe__', 'fixture', 'case-' + index), error => error.actual === 1);
  const receipt = await readFile(path.join(output, 'case-' + index + '-helper-result.json'), 'utf8');
  assert.doesNotMatch(receipt, /private|secret/);
  assert.equal(JSON.parse(receipt).diagnostic === null, index !== 2);
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
