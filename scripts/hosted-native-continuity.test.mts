import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import test from "node:test";
import { runPythonSuite } from "./python-test-results.mts";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

void test("hosted Linux readiness preserves original-generation recovery and refusal outcomes", (context) => {
  runPythonSuite(new URL("./qualify-hosted-native-linux.test.py", import.meta.url), context, 30000);
});

const script = fileURLToPath(new URL("./rehearse-updater-artifacts.ps1", import.meta.url));
function describe(workflow: string, caller: string) {
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-PlatformLabel",
      "windows-x86_64",
      "-EvidenceWorkflow",
      workflow,
      "-DescribeWorkflow",
    ],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, GITHUB_WORKFLOW_REF: caller } },
  );
}
void test("rehearsal receipts bind only the actual allowlisted workflow before native effects", () => {
  for (const name of ["updater-artifact-rehearsal", "hosted-native-continuity"]) {
    const workflow = `.github/workflows/${name}.yml`;
    const result = describe(workflow, `boburning/portcove/${workflow}@refs/heads/reviewed`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      workflow,
      scope: "disposable-key installed updater rehearsal only",
    });
  }
  const wrong = describe(
    ".github/workflows/hosted-native-continuity.yml",
    "boburning/portcove/.github/workflows/untrusted.yml@refs/heads/reviewed",
  );
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /differs from the actual invocation/);
  const foreign = describe(
    ".github/workflows/hosted-native-continuity.yml",
    "foreign/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/reviewed",
  );
  assert.notEqual(foreign.status, 0);
  const unlisted = describe(".github/workflows/untrusted.yml", "");
  assert.notEqual(unlisted.status, 0);
  assert.match(unlisted.stderr, /EvidenceWorkflow/);
});
const helper = fileURLToPath(new URL("./prepare-hosted-windows-runtime.ps1", import.meta.url));
void test("standalone runtime source keeps its real gate closed and preserves exact failed inputs under inert peers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-runtime-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await readFile(helper, "utf8"),
    payload = Buffer.alloc(65537, 97),
    digest = createHash("sha256").update(payload).digest("hex");
  // Only the copied fixture changes host/source pins and supplies inert peers.
  // The real helper's execution gate remains false; no installer is executed.
  let controlled = original;
  for (const [before, after, occurrences] of [
    ["if (-not $IsWindows -or", "if (-not $true -or", 1],
    ["[Net.Http.HttpClientHandler]::new()", "[RuntimeSourceFixture.Handler]::new()", 2],
    ["[Net.Http.HttpClient]::new($handler)", "[RuntimeSourceFixture.Client]::new($handler)", 1],
    [
      "[Net.Http.HttpClient]::new($taskHandler)",
      "[RuntimeSourceFixture.Client]::new($taskHandler)",
      1,
    ],
    ["bytes=214884560", `bytes=${payload.length}`, 1],
    ["1c401b327fbc7bb9731b4e350a2194f083cbc3ede46508d52e1cae6610a39bea", digest, 1],
  ] as const) {
    assert.equal(
      controlled.split(before).length,
      occurrences + 1,
      `exact fixture boundary: ${before}`,
    );
    controlled = controlled.replaceAll(before, after);
  }
  const source = path.join(root, "source.ps1"),
    floor = path.join(root, "runtime_support.rs"),
    wrapper = path.join(root, "control.ps1");
  await writeFile(source, controlled);
  await copyFile(
    new URL("../apps/desktop/src-tauri/src/runtime_support.rs", import.meta.url),
    floor,
  );
  await writeFile(
    wrapper,
    String.raw`param([string]$Source,[string]$Floor,[string]$Root)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
namespace RuntimeSourceFixture {
 public sealed class Handler : IDisposable {
  public bool AllowAutoRedirect {get;set;} = true;
  public void Dispose() { Client.Disposals++; }
 }
 public sealed class Interrupted : MemoryStream {
  private int reads;
  public Interrupted(byte[] bytes):base(bytes) {}
  public override Task<int> ReadAsync(byte[] b,int o,int n,CancellationToken c) {
   if(reads++>0) return Task.FromException<int>(new IOException("inert body interrupted"));
   return base.ReadAsync(b,o,Math.Min(n,17),c);
  }
 }
 public sealed class Client : IDisposable {
  public static string Mode;
  public static int Calls,Disposals;
  public Client(Handler h) { if(h.AllowAutoRedirect) throw new Exception("redirects must stay manual"); }
  public Task<HttpResponseMessage> GetAsync(object uri,HttpCompletionOption option,CancellationToken token) {
   Calls++;
   if(!token.CanBeCanceled || option!=HttpCompletionOption.ResponseHeadersRead) throw new Exception("bounded streaming required");
   if(Calls==1) {
    if(uri.ToString()!="https://go.microsoft.com/fwlink/?linkid=2124701") throw new Exception("source differs");
    if(Mode=="timeout") return Task.FromCanceled<HttpResponseMessage>(new CancellationToken(true));
    var redirect=new HttpResponseMessage(HttpStatusCode.Found);
    redirect.Headers.Location=new Uri(Mode=="foreign-host"?"https://foreign.invalid/runtime.exe":"https://msedge.sf.dl.delivery.mp.microsoft.com/runtime.exe");
    return Task.FromResult(redirect);
   }
   if(Calls!=2 || uri.ToString()!="https://msedge.sf.dl.delivery.mp.microsoft.com/runtime.exe") throw new Exception("source retry or location differs");
   var body=new byte[Mode=="oversized"?65538:Mode=="truncated"?65536:65537];
   Array.Fill<byte>(body,97);
   if(Mode=="changed-bytes") body[0]=98;
   var response=new HttpResponseMessage(Mode=="second-redirect"?HttpStatusCode.Found:HttpStatusCode.OK);
   response.Content=new StreamContent(Mode=="interrupted"?(Stream)new Interrupted(body):new MemoryStream(body));
   response.Content.Headers.ContentLength=Mode=="declared-size"?65538:65537;
   if(Mode=="encoded") response.Content.Headers.ContentEncoding.Add("gzip");
   return Task.FromResult(response);
  }
  public void Dispose() { Disposals++; }
 }
}
'@
$global:fixtureInstalled=$false
$global:fixtureStarts=0
$global:fixtureSignatures=0
function Get-ItemProperty {
 [pscustomobject]@{name='Microsoft Edge WebView2 Runtime';pv=$(if($global:fixtureInstalled){'156.0.0.0'}else{'131.0.0.0'})}
}
function Get-AuthenticodeSignature {
 param([string]$LiteralPath)
 $global:fixtureSignatures++
 if([RuntimeSourceFixture.Client]::Mode -eq 'substitution' -and $global:fixtureSignatures -eq 2) {
  [IO.File]::WriteAllText($LiteralPath,'substituted after initial signature')
 }
 [pscustomobject]@{Status=$(if([RuntimeSourceFixture.Client]::Mode -eq 'signature'){'NotSigned'}else{'Valid'});
  SignerCertificate=[pscustomobject]@{Subject='CN=Microsoft Corporation, O=Microsoft Corporation';Thumbprint=('A'*40)}}
}
function Start-Process {
 $global:fixtureStarts++
 $global:fixtureInstalled=$true
 $process=[pscustomobject]@{ExitCode=0}
 $process|Add-Member ScriptMethod WaitForExit {param($budget) if($budget -ne 300000){throw 'installer budget changed'};return $true}
 $process|Add-Member ScriptMethod Dispose {}
 return $process
}
$rows=@(foreach($mode in @('held','valid','foreign-host','second-redirect','declared-size','encoded','timeout','interrupted','oversized','truncated','changed-bytes','signature','substitution')) {
 [RuntimeSourceFixture.Client]::Mode=$mode
 [RuntimeSourceFixture.Client]::Calls=0
 [RuntimeSourceFixture.Client]::Disposals=0
 $global:fixtureInstalled=$false;$global:fixtureStarts=0;$global:fixtureSignatures=0
 $directory=Join-Path $Root $mode
 New-Item -ItemType Directory -Path (Join-Path $directory 'scripts') -Force|Out-Null
 New-Item -ItemType Directory -Path (Join-Path $directory 'apps/desktop/src-tauri/src') -Force|Out-Null
 Copy-Item -LiteralPath $Floor -Destination (Join-Path $directory 'apps/desktop/src-tauri/src/runtime_support.rs')
 $text=[IO.File]::ReadAllText($Source)
 if($mode -ne 'held') {$text=$text.Replace('$taskStandaloneExecutionAuthorized = $false','$taskStandaloneExecutionAuthorized = $true')}
 $inputHelper=Join-Path $directory 'scripts/prepare-hosted-windows-runtime.ps1'
 [IO.File]::WriteAllText($inputHelper,$text)
 $failure=$null
 try {& $inputHelper -UseStandaloneInstaller} catch {$failure=$_.Exception.Message}
 $receiptPath=Join-Path $directory 'work/hosted-continuity-evidence/windows-runtime.json'
 $receipt=if(Test-Path -LiteralPath $receiptPath){Get-Content -Raw -LiteralPath $receiptPath|ConvertFrom-Json}else{$null}
 $installer=Join-Path $directory 'work/hosted-continuity-evidence/MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
 [ordered]@{mode=$mode;failure=$failure;receipt=$receipt;calls=[RuntimeSourceFixture.Client]::Calls;
  disposals=[RuntimeSourceFixture.Client]::Disposals;starts=$global:fixtureStarts;signatures=$global:fixtureSignatures;
  retained_bytes=$(if(Test-Path -LiteralPath $installer){(Get-Item -LiteralPath $installer).Length}else{$null})}
})
ConvertTo-Json -InputObject $rows -Depth 10 -Compress
`,
  );
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", wrapper, source, floor, root],
    {
      encoding: "utf8",
      // The complete inert source/refusal matrix exceeded45s under concurrent owning families.
      // This is only its outer harness; download, installer and cleanup bounds stay unchanged.
      timeout: 90000,
      maxBuffer: 131072,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "boburning/portcove",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "1".repeat(40),
        GITHUB_WORKFLOW_REF:
          "boburning/portcove/.github/workflows/hosted-runtime-readiness.yml@refs/heads/feature/534-runtime-fixture",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 13);
  for (const value of rows) {
    const row: unknown = value;
    assert.ok(isRecord(row) && typeof row.mode === "string");
    if (row.mode === "held") {
      assert.ok(typeof row.failure === "string");
      assert.match(
        row.failure,
        /awaits separately reviewed source\/storage and execution authority/,
      );
      assert.equal(row.calls, 0);
      assert.equal(row.starts, 0);
      assert.equal(row.receipt, null);
      continue;
    }
    assert.ok(isRecord(row.receipt));
    const receipt = row.receipt;
    assert.ok(isRecord(receipt.installer_input));
    const input = receipt.installer_input;
    assert.equal(input.bytes, payload.length, row.mode);
    assert.equal(input.sha256, digest, row.mode);
    assert.equal(input.runtime_version, null);
    assert.equal(input.download_seconds, 120);
    assert.equal(input.maximum_bytes, 256 * 1024 ** 2);
    assert.equal(row.disposals, 2, row.mode);
    assert.equal(receipt.automatic_retry, false);
    assert.equal(row.calls, ["foreign-host", "timeout"].includes(row.mode) ? 1 : 2, row.mode);
    if (row.mode === "valid") {
      assert.equal(row.failure, null);
      assert.equal(row.starts, 1);
      assert.equal(row.signatures, 3);
      assert.equal(row.retained_bytes, payload.length);
      assert.equal(receipt.stage, "ready-installed");
      assert.deepEqual(receipt.after, ["156.0.0.0"]);
      assert.equal(receipt.installer_sha256, digest);
    } else {
      assert.equal(row.starts, 0, row.mode);
      assert.ok(typeof row.failure === "string" && row.failure.length > 0, row.mode);
      assert.equal(receipt.failure, row.failure);
      assert.equal(receipt.installed, false);
      const expectedFailures: Record<string, RegExp> = {
        "foreign-host": /Official standalone download identity differs/,
        "second-redirect": /Official standalone response differs/,
        "declared-size": /Standalone declared byte identity differs/,
        encoded: /Official standalone response differs/,
        timeout: /cancel/i,
        interrupted: /inert body interrupted/,
        oversized: /Standalone actual byte bound exceeded/,
        truncated: /Standalone actual byte identity differs/,
        "changed-bytes": /Standalone bytes differ from the reviewed source proposal/,
        signature: /Standalone input lacks a valid Microsoft signature/,
        substitution: /Standalone file identity differs/,
      };
      const expectedFailure = expectedFailures[row.mode];
      assert.ok(expectedFailure, row.mode);
      assert.match(row.failure, expectedFailure);
      if (row.mode === "interrupted") assert.equal(row.retained_bytes, 17);
      if (row.mode === "truncated") assert.equal(row.retained_bytes, payload.length - 1);
      if (row.mode === "oversized") assert.equal(row.retained_bytes, 65536);
      if (row.mode === "changed-bytes") {
        assert.equal(row.signatures, 0);
        assert.equal(row.retained_bytes, payload.length);
      }
      if (row.mode === "substitution")
        assert.match(row.failure, /Standalone file identity differs/);
    }
  }
});
void test("standalone diagnostic workflow input selects only a held helper mode without becoming code or authority", async (t) => {
  const workflow: unknown = parseDocument(
    await readFile(
      new URL("../.github/workflows/hosted-runtime-readiness.yml", import.meta.url),
      "utf8",
    ),
  ).toJS();
  assert.ok(isRecord(workflow) && isRecord(workflow.on) && isRecord(workflow.on.workflow_dispatch));
  const dispatch = workflow.on.workflow_dispatch;
  assert.ok(isRecord(dispatch.inputs));
  assert.deepEqual(dispatch.inputs.use_standalone_installer, {
    description:
      "Select the source-gated standalone proposal; this input grants no execution authority",
    type: "boolean",
    default: false,
  });
  assert.ok(isRecord(workflow.jobs) && isRecord(workflow.jobs.runtime));
  const runtime = workflow.jobs.runtime;
  assert.ok(Array.isArray(runtime.steps));
  const steps: unknown[] = runtime.steps;
  const step = steps.find(
    (item) =>
      isRecord(item) && item.name === "Prepare and read back the maintained shipping engine floor",
  );
  assert.ok(isRecord(step) && isRecord(step.env) && typeof step.run === "string");
  assert.equal(step.env.PORTCOVE_RUNTIME_STANDALONE, "${{ inputs.use_standalone_installer }}");
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-runtime-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts/prepare-hosted-windows-runtime.ps1"),
    "param([switch]$UseStandaloneInstaller)\n@{standalone=$UseStandaloneInstaller.IsPresent;authority='none'}|ConvertTo-Json -Compress\n",
  );
  const wrapper = path.join(root, "step.ps1");
  await writeFile(wrapper, step.run);
  for (const [value, selected] of [
    ["true", true],
    ["false", false],
    ["TRUE", false],
    ["$(throw 'inert')", false],
  ] as const) {
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", wrapper], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PORTCOVE_RUNTIME_STANDALONE: value },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { standalone: selected, authority: "none" });
  }
});
void test("hosted runtime gate retains the shipping floor and rejects absent, malformed, preview and older engines", () => {
  for (const [version, eligible] of [
    ["155.0.4283.62", true],
    ["155.0.4283.63", true],
    ["156.0.0.0", true],
    ["155.0.4283.61", false],
    ["154.0.9999.99", false],
    ["155.0.4283.62 dev", false],
    ["unknown", false],
  ] as const) {
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", helper, "-InspectVersion", version],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      scope: "declared-version-only; no host observation or installation",
      minimum: "155.0.4283.62",
      eligible,
    });
  }
});
void test("owner-host invocation refuses before any runtime installation", () => {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", helper], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, GITHUB_ACTIONS: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only the reviewed standard hosted diagnostic/);
  const mixed = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helper,
      "-InspectVersion",
      "155.0.4283.62",
      "-UseStandaloneInstaller",
    ],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.notEqual(mixed.status, 0);
  assert.match(
    mixed.stderr,
    /Version inspection and standalone preparation are separate operations/,
  );
});
void test(
  "hosted runtime timings retain eligible and refused observations without installer effects",
  { skip: process.platform !== "win32" },
  async (t) => {
    for (const conflicting of [false, true]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "portcove-hosted-runtime-test-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, "apps/desktop/src-tauri/src"), { recursive: true });
      const copiedHelper = path.join(root, "scripts/prepare-hosted-windows-runtime.ps1");
      await copyFile(helper, copiedHelper);
      await copyFile(
        new URL("../apps/desktop/src-tauri/src/runtime_support.rs", import.meta.url),
        path.join(root, "apps/desktop/src-tauri/src/runtime_support.rs"),
      );
      const wrapper = path.join(root, "run.ps1");
      await writeFile(
        wrapper,
        `param([string]$FixtureHelper)
$ErrorActionPreference = 'Stop'
function Get-ItemProperty {
    [pscustomobject]@{name='Microsoft Edge WebView2 Runtime';pv='155.0.4283.62'}
    ${conflicting ? "[pscustomobject]@{name='Microsoft Edge WebView2 Runtime';pv='156.0.0.0'}" : ""}
}
function Start-Process { throw 'Fixture must never execute an installer' }
$LASTEXITCODE = 73
& $FixtureHelper
if ($LASTEXITCODE -ne 0) { throw 'Actual successful helper left a stale native exit code' }
`,
      );
      const invocationArgs = ["-NoProfile", "-NonInteractive", "-File", wrapper, copiedHelper];
      const invocationOptions = {
        encoding: "utf8" as const,
        timeout: 30000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "boburning/portcove",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "1".repeat(40),
          GITHUB_WORKFLOW_REF:
            "boburning/portcove/.github/workflows/hosted-runtime-readiness.yml@refs/heads/feature/534-runtime-fixture",
        },
      };
      const result = spawnSync("pwsh", invocationArgs, invocationOptions);
      if (conflicting) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Conflicting registered runtime versions/);
      } else assert.equal(result.status, 0, result.stderr);
      const receipt: unknown = JSON.parse(
        await readFile(
          path.join(root, "work/hosted-continuity-evidence/windows-runtime.json"),
          "utf8",
        ),
      );
      assert.ok(isRecord(receipt));
      assert.equal(receipt.stage, conflicting ? "observed" : "ready-existing");
      assert.equal(receipt.installed, false);
      assert.deepEqual(
        receipt.after,
        conflicting ? ["155.0.4283.62", "156.0.0.0"] : ["155.0.4283.62"],
      );
      assert.equal(receipt.automatic_retry, false);
      assert.equal(receipt.installer_sha256, undefined);
      if (conflicting)
        assert.match(String(receipt.failure), /Conflicting registered runtime versions/);
      const observation = receipt.runtime_preparation_observation;
      assert.ok(isRecord(observation) && Array.isArray(observation.phases));
      assert.match(String(observation.scope), /cold setup and final receipt write excluded/);
      let previous = 0;
      const phaseNames: unknown[] = [];
      for (const phase of observation.phases) {
        assert.ok(isRecord(phase));
        assert.ok(Number.isSafeInteger(phase.elapsed_milliseconds));
        assert.ok(Number(phase.elapsed_milliseconds) >= previous);
        previous = Number(phase.elapsed_milliseconds);
        phaseNames.push(phase.phase);
      }
      assert.equal(observation.elapsed_milliseconds, previous);
      assert.deepEqual(phaseNames, [
        "entry",
        "initial-runtime-readback",
        conflicting ? "failure" : "existing-runtime-eligible",
        "terminal-receipt-ready",
      ]);
      const receiptPath = path.join(root, "work/hosted-continuity-evidence/windows-runtime.json");
      const original = await readFile(receiptPath, "utf8");
      const replay = spawnSync("pwsh", invocationArgs, invocationOptions);
      assert.notEqual(replay.status, 0);
      assert.match(replay.stderr, /Retain original runtime attempt/);
      assert.equal(await readFile(receiptPath, "utf8"), original);
    }
  },
);

void test("ordinary Windows tool fixture binds the checked-out head before runtime effects and cannot select standalone", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-tool-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await readFile(helper, "utf8");
  assert.equal(original.split("if (-not $IsWindows -or").length, 2);
  for (const mode of [
    "pull",
    "push",
    "wrong-job",
    "wrong-ref",
    "wrong-event",
    "wrong-head",
    "dirty",
    "missing-source",
    "standalone",
  ]) {
    const directory = path.join(root, mode);
    await mkdir(path.join(directory, "scripts"), { recursive: true });
    await mkdir(path.join(directory, "apps/desktop/src-tauri/src"), { recursive: true });
    const source = path.join(directory, "scripts/prepare-hosted-windows-runtime.ps1");
    // Only this private copy changes host observation; git/registry/process peers
    // are inert. Actual source, workflow, first effects and receipt logic run.
    await writeFile(source, original.replace("if (-not $IsWindows -or", "if (-not $true -or"));
    await copyFile(
      new URL("../apps/desktop/src-tauri/src/runtime_support.rs", import.meta.url),
      path.join(directory, "apps/desktop/src-tauri/src/runtime_support.rs"),
    );
    const wrapper = path.join(directory, "control.ps1");
    await writeFile(
      wrapper,
      String.raw`param([string]$Source,[string]$Root,[string]$Mode)
$ErrorActionPreference='Stop'
$global:LASTEXITCODE=0
$env:GITHUB_ACTIONS='true';$env:GITHUB_REPOSITORY='boburning/portcove';$env:RUNNER_ENVIRONMENT='github-hosted'
$env:GITHUB_RUN_ID='12345';$env:GITHUB_RUN_ATTEMPT='1';$env:GITHUB_SHA='b'*40;$env:FIXTURE_SOURCE_SHA='a'*40
$env:GITHUB_JOB='windows-tools';$env:GITHUB_EVENT_NAME='pull_request'
$env:GITHUB_WORKFLOW_REF='boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/pull/17/merge'
if($Mode -eq 'push'){$env:GITHUB_EVENT_NAME='push';$env:GITHUB_SHA='a'*40;$env:GITHUB_WORKFLOW_REF='boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/heads/main'}
if($Mode -eq 'wrong-job'){$env:GITHUB_JOB='fixture'}
if($Mode -eq 'wrong-ref'){$env:GITHUB_WORKFLOW_REF='boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/heads/other'}
if($Mode -eq 'wrong-event'){$env:GITHUB_EVENT_NAME='workflow_dispatch'}
if($Mode -eq 'missing-source'){$env:FIXTURE_SOURCE_SHA=''}
function git {
  $global:LASTEXITCODE=0
  if($args -contains 'rev-parse'){if($Mode -eq 'wrong-head'){'c'*40}else{'a'*40}}
  elseif($args -contains 'status'){if($Mode -eq 'dirty'){' M tracked-source'}}
  else {throw 'Unexpected inert git operation'}
}
function Get-ItemProperty {
  Set-Content -LiteralPath (Join-Path $Root 'registry-observed') -Value 'observed'
  [pscustomobject]@{name='Microsoft Edge WebView2 Runtime';pv='155.0.4283.62'}
}
function Start-Process {throw 'No installer may execute in this existing-runtime fixture'}
& $Source -UseStandaloneInstaller:($Mode -eq 'standalone')
`,
    );
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", wrapper, source, directory, mode],
      { encoding: "utf8", timeout: 15000 },
    );
    const accepted = mode === "pull" || mode === "push";
    if (accepted) {
      assert.equal(result.status, 0, result.stderr);
      const receipt: unknown = JSON.parse(
        await readFile(
          path.join(directory, "work/hosted-continuity-evidence/windows-runtime.json"),
          "utf8",
        ),
      );
      assert.ok(isRecord(receipt));
      assert.equal(receipt.source, "a".repeat(40));
      assert.equal(receipt.stage, "ready-existing");
      assert.equal(receipt.installed, false);
    } else {
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, /reviewed standard hosted diagnostic|fixture|Fixed tool/);
      await assert.rejects(readFile(path.join(directory, "registry-observed")), { code: "ENOENT" });
      await assert.rejects(
        readFile(path.join(directory, "work/hosted-continuity-evidence/windows-runtime.json")),
        { code: "ENOENT" },
      );
    }
  }
});

void test("Windows tool fixture prepares the ordinary supported runtime before its driver build and retains selected JSON", async () => {
  const raw = await readFile(
    new URL("../.github/workflows/controller-tool-build-fixture.yml", import.meta.url),
    "utf8",
  );
  const workflow: unknown = parseDocument(raw).toJS();
  assert.ok(isRecord(workflow) && isRecord(workflow.on) && isRecord(workflow.jobs));
  for (const event of ["push", "pull_request"]) {
    const value = workflow.on[event];
    assert.ok(isRecord(value) && Array.isArray(value.paths));
    for (const file of [
      "scripts/prepare-hosted-windows-runtime.ps1",
      "apps/desktop/src-tauri/src/runtime_support.rs",
    ])
      assert.ok(value.paths.includes(file));
  }
  const job = workflow.jobs["windows-tools"];
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  assert.equal(job["timeout-minutes"], 15);
  const steps = job.steps.filter(isRecord);
  const preparation = steps.findIndex(
    (step) => step.run === "./scripts/prepare-hosted-windows-runtime.ps1",
  );
  const builder = steps.findIndex(
    (step) => step.run === "node scripts/qualify-controller-tools-windows.mts",
  );
  assert.ok(preparation > 0 && builder > preparation);
  assert.ok(isRecord(steps[preparation]!.env));
  assert.equal(
    steps[preparation]!.env.FIXTURE_SOURCE_SHA,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  const upload = steps.find(
    (step) => step.name === "Retain the original Windows runtime prerequisite",
  );
  assert.ok(upload && isRecord(upload.with) && typeof upload.with.path === "string");
  assert.equal(upload.with.path, "work/hosted-continuity-evidence/windows-runtime.json");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, false);
});

async function hostedResourceObservationFixture(context: test.TestContext) {
  const raw: unknown = parseDocument(
    await readFile(
      new URL("../.github/workflows/hosted-native-continuity.yml", import.meta.url),
      "utf8",
    ),
    { uniqueKeys: true },
  ).toJS();
  assert.ok(isRecord(raw) && isRecord(raw.jobs) && isRecord(raw.jobs["installed-prerequisite"]));
  const job = raw.jobs["installed-prerequisite"];
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const start = steps[0],
    stop = steps.find(
      (step) =>
        isRecord(step) &&
        step.name === "Stop the original resource observer and retain sampled coverage",
    );
  assert.ok(
    isRecord(start) &&
      typeof start.run === "string" &&
      isRecord(stop) &&
      typeof stop.run === "string",
  );
  assert.equal(start.name, "Start bounded runner resource observation before checkout");
  assert.ok(Buffer.byteLength(start.run) < 21000);
  assert.ok(Buffer.byteLength(start.run.replaceAll("\n", "\r\n")) < 21000);
  const observer = /\$taskObserverSource = @'\n([\s\S]*?)\n'@/u.exec(start.run)?.[1];
  assert.ok(observer);
  assert.ok(
    Buffer.byteLength(observer) > 0 &&
      Buffer.byteLength(observer) <= 32768 &&
      Buffer.byteLength(observer.replaceAll("\n", "\r\n")) <= 32768,
  );
  assert.ok(isRecord(steps[1]) && String(steps[1].uses).startsWith("actions/checkout@"));
  assert.equal(stop.if, "always()");
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-hosted-resource-")),
    temporary = path.join(root, "runner temp"),
    workspace = path.join(root, "workspace");
  await mkdir(temporary);
  await mkdir(workspace);
  const startPath = path.join(root, "start.ps1"),
    stopPath = path.join(root, "stop.ps1"),
    checkPath = path.join(root, "check.ps1");
  await writeFile(startPath, start.run);
  await writeFile(stopPath, stop.run);
  await writeFile(
    checkPath,
    "$ErrorActionPreference='Stop'\n& (Join-Path $env:RUNNER_TEMP 'portcove-hosted-job-observer.ps1') -Operation Check\nif($LASTEXITCODE -ne 0){throw 'Original observer check refused'}\n",
  );
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "boburning/portcove",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_JOB: "installed-prerequisite",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-hosted-job-usage",
    PORTCOVE_HOSTED_PLATFORM: process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
    PORTCOVE_HOSTED_OBSERVATION_ONLY: "false",
    RUNNER_TEMP: temporary,
    GITHUB_WORKSPACE: workspace,
    PORTCOVE_INERT_PRIVATE_VALUE: "never-collect-this-inert-value",
  };
  const invoke = (filename: string) =>
    spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", filename], {
      env: environment,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
    });
  const evidence = path.join(temporary, "portcove-hosted-resource-observation");
  const identityFunction = start.run.slice(
    start.run.indexOf("function Get-MeasurementBirth"),
    start.run.indexOf("function Get-MeasurementMemory"),
  );
  const identityScript = (pid: unknown, birth: unknown, action: string) =>
    `$ErrorActionPreference='Stop'\n$taskUtf8=[Text.UTF8Encoding]::new($false,$true)\n${identityFunction}\n$taskProcess=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue\nif($null -ne $taskProcess -and (Get-MeasurementBirth $taskProcess) -ceq '${String(birth)}'){${action}}\n`;
  context.after(async () => {
    try {
      await readFile(path.join(evidence, "observer-started.json"));
      try {
        await readFile(path.join(evidence, "stop"));
      } catch {
        invoke(stopPath);
      }
    } catch {
      /* Never started. */
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(evidence, name), "utf8"));
  return {
    root,
    temporary,
    workspace,
    evidence,
    startPath,
    stopPath,
    checkPath,
    environment,
    invoke,
    read,
    steps,
    identityScript,
  };
}

void test("hosted resource observation samples before checkout and stops only its original finite observer", async (context) => {
  const fixture = await hostedResourceObservationFixture(context),
    started = fixture.invoke(fixture.startPath);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const ready = await fixture.read("observer-ready.json"),
    intent = await fixture.read("intent.json");
  assert.ok(isRecord(ready) && isRecord(intent));
  assert.equal(intent.authority, "none");
  const samplesBefore = await readFile(path.join(fixture.evidence, "samples.jsonl"), "utf8");
  assert.ok(samplesBefore.endsWith("\n") && samplesBefore.length > 0);
  const checked = fixture.invoke(fixture.checkPath);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const heartbeat: unknown = JSON.parse(checked.stdout);
  assert.ok(isRecord(heartbeat));
  assert.equal(heartbeat.pid, ready.pid);
  const stopped = fixture.invoke(fixture.stopPath);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  const observation = await fixture.read("observation.json");
  assert.ok(isRecord(observation));
  assert.equal(observation.coverage_status, "sampled-through-finalizer");
  assert.equal(observation.forced_stop, false);
  assert.equal(observation.authority, "none");
  assert.equal(observation.continuous_peaks, "not-observed");
  assert.equal(observation.provider_setup, "not-observed");
  assert.equal(observation.post_last_sample, "not-observed");
  assert.ok(Number(observation.sample_count) >= 1 && Number(observation.sample_bytes) <= 8388608);
  const samples = await readFile(path.join(fixture.evidence, "samples.jsonl"));
  assert.equal(
    observation.sample_sha256,
    createHash("sha256").update(samples).digest("hex").toUpperCase(),
  );
  assert.ok(
    !JSON.stringify({ intent, ready, observation, samples: samples.toString("utf8") }).includes(
      "never-collect-this-inert-value",
    ),
  );
  const before = await readFile(path.join(fixture.evidence, "observer-started.json"));
  assert.notEqual(fixture.invoke(fixture.startPath).status, 0);
  assert.deepEqual(await readFile(path.join(fixture.evidence, "observer-started.json")), before);
  const publicUpload = fixture.steps.find(
    (step) =>
      isRecord(step) && step.name === "Retain bounded public resource observations separately",
  );
  assert.ok(isRecord(publicUpload) && isRecord(publicUpload.with));
  assert.equal(publicUpload.if, "always()");
  assert.equal(publicUpload.with["retention-days"], 7);
  assert.doesNotMatch(String(publicUpload.with.path), /stdout|stderr|\.ps1|\*|environment/u);
});

void test("hosted resource observation refuses foreign contexts before starting a sampler", async (context) => {
  for (const [key, value] of [
    ["GITHUB_JOB", "native_windows"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_REPOSITORY", "foreign/portcove"],
  ] as const) {
    const fixture = await hostedResourceObservationFixture(context);
    fixture.environment[key] = value;
    const result = fixture.invoke(fixture.startPath);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(fixture.evidence, "intent.json")), { code: "ENOENT" });
  }
});

void test("interrupted hosted resource observation retains sampled data without inventing completed coverage", async (context) => {
  const fixture = await hostedResourceObservationFixture(context),
    started = fixture.invoke(fixture.startPath);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const owner = await fixture.read("observer-started.json");
  assert.ok(isRecord(owner));
  const terminate = path.join(fixture.root, "terminate-owned.ps1");
  await writeFile(
    terminate,
    fixture.identityScript(
      owner.pid,
      owner.birth_ticks,
      "$taskProcess.Kill();if(-not $taskProcess.WaitForExit(5000)){throw 'Owned test observer did not stop'}",
    ),
  );
  const killed = fixture.invoke(terminate);
  assert.equal(killed.status, 0, killed.stderr || killed.stdout);
  assert.notEqual(fixture.invoke(fixture.checkPath).status, 0);
  const stopped = fixture.invoke(fixture.stopPath);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  const report = await fixture.read("observation.json");
  assert.ok(isRecord(report));
  assert.equal(report.coverage_status, "partial-or-interrupted");
  assert.equal(report.terminal, null);
  assert.ok(Number(report.sample_count) >= 1);
  assert.equal(report.continuous_peaks, "not-observed");
});

void test("hosted resource observation cleans its original observer on startup qualification failure", async (context) => {
  const fixture = await hostedResourceObservationFixture(context);
  const start = await readFile(fixture.startPath, "utf8");
  await writeFile(
    fixture.startPath,
    start.replace("if ($taskReady.pid", "throw 'Injected readiness failure'\nif ($taskReady.pid"),
  );
  const result = fixture.invoke(fixture.startPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected readiness failure/u);
  const owner = await fixture.read("observer-started.json");
  assert.ok(isRecord(owner));
  const verify = path.join(fixture.root, "verify-original-stopped.ps1");
  await writeFile(
    verify,
    fixture.identityScript(
      owner.pid,
      owner.birth_ticks,
      "throw 'Original startup observer still running'",
    ),
  );
  const checked = fixture.invoke(verify);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

void test("hosted resource observation refuses complete coverage for a truncated original sample log", async (context) => {
  const fixture = await hostedResourceObservationFixture(context);
  const started = fixture.invoke(fixture.startPath);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  await writeFile(path.join(fixture.evidence, "stop"), "");
  let terminal: unknown;
  for (let poll = 0; poll < 100; poll++) {
    try {
      terminal = await fixture.read("observer-terminal.json");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(isRecord(terminal));
  assert.equal(terminal.reason, "stop-requested");
  await rm(path.join(fixture.evidence, "stop"));
  const samplePath = path.join(fixture.evidence, "samples.jsonl"),
    samples = await readFile(samplePath);
  assert.ok(samples.length > 1 && samples.at(-1) === 10);
  await writeFile(samplePath, samples.subarray(0, samples.length - 1));
  const stopped = fixture.invoke(fixture.stopPath);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  const observation = await fixture.read("observation.json");
  assert.ok(isRecord(observation));
  assert.equal(observation.coverage_status, "partial-or-interrupted");
  assert.equal(observation.parse_error_rows, 0);
  assert.ok(Number(observation.sample_count) > 0);
  assert.equal(
    observation.terminal && isRecord(observation.terminal) ? observation.terminal.bytes : null,
    samples.length,
  );
});

void test("instrumentation-only workflow shares the observer with a three-minute bound and skips every native effect", async (context) => {
  const fixture = await hostedResourceObservationFixture(context);
  fixture.environment.PORTCOVE_HOSTED_OBSERVATION_ONLY = "true";
  fixture.environment.GITHUB_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const started = fixture.invoke(fixture.startPath);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const intent = await fixture.read("intent.json");
  assert.ok(isRecord(intent) && isRecord(intent.context));
  assert.equal(intent.maximum_milliseconds, 180000);
  assert.equal(intent.maximum_samples, 36);
  assert.equal(intent.maximum_bytes, 8388608);
  assert.equal(intent.context.mode, "true");
  const check = fixture.invoke(fixture.checkPath);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const probe = fixture.steps.find(
    (step) =>
      isRecord(step) &&
      step.name === "Qualify the original observer across independent runner steps",
  );
  assert.ok(isRecord(probe) && typeof probe.run === "string");
  const probePath = path.join(fixture.root, "actual-probe.ps1");
  await writeFile(probePath, probe.run);
  const before = Date.now(),
    observed = fixture.invoke(probePath);
  assert.equal(observed.status, 0, observed.stderr || observed.stdout);
  assert.ok(
    Date.now() - before >= 12000,
    "Canonical probe must complete all original cross-step waits",
  );
  const stopped = fixture.invoke(fixture.stopPath);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  const raw: unknown = parseDocument(
    await readFile(
      new URL("../.github/workflows/hosted-native-continuity.yml", import.meta.url),
      "utf8",
    ),
  ).toJS();
  assert.ok(
    isRecord(raw) &&
      isRecord(raw.on) &&
      isRecord(raw.on.workflow_dispatch) &&
      isRecord(raw.on.workflow_dispatch.inputs) &&
      isRecord(raw.on.workflow_dispatch.inputs.resource_observer_only) &&
      isRecord(raw.jobs) &&
      isRecord(raw.jobs["installed-prerequisite"]),
  );
  const input = raw.on.workflow_dispatch.inputs.resource_observer_only;
  assert.equal(input.default, false);
  assert.equal(input.type, "boolean");
  const job = raw.jobs["installed-prerequisite"];
  assert.equal(job["timeout-minutes"], "${{ inputs.resource_observer_only && 3 || 90 }}");
  for (const step of fixture.steps) {
    assert.ok(isRecord(step));
    const name = String(step.name ?? step.uses ?? step.run);
    if (
      name === "Start bounded runner resource observation before checkout" ||
      name === "Stop the original resource observer and retain sampled coverage" ||
      name === "Retain bounded public resource observations separately" ||
      name.startsWith("actions/checkout@")
    )
      continue;
    if (name === "Qualify the original observer across independent runner steps") {
      assert.equal(step.if, "inputs.resource_observer_only");
      assert.ok(String(step.run).includes("-Operation Check"));
      continue;
    }
    assert.ok(String(step.if).includes("!inputs.resource_observer_only"), name);
  }
  const start = await readFile(fixture.startPath, "utf8");
  assert.ok(start.includes("IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero"));
  assert.ok(
    !start.includes("BREAKAWAY") &&
      !start.includes("RUNNER_TRACKING_ID=") &&
      !start.includes("New-LocalUser"),
  );
});

void test("original observer heartbeat refuses stale samples while preserving the same bounded process", async (context) => {
  const fixture = await hostedResourceObservationFixture(context),
    started = fixture.invoke(fixture.startPath);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const samplesPath = path.join(fixture.evidence, "samples.jsonl"),
    original = await readFile(samplesPath, "utf8");
  await writeFile(
    samplesPath,
    original.replace(/"observed_at":"[0-9]{4}/gu, '"observed_at":"2000'),
  );
  const stale = fixture.invoke(fixture.checkPath);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /heartbeat stale/u);
});

void test("connected diagnostic workflow stays source-held and writes exactly the four fixed public upload paths", async (t) => {
  const workflow = parseDocument(
    await readFile(
      new URL("../.github/workflows/hosted-native-continuity.yml", import.meta.url),
      "utf8",
    ),
  ).toJS() as {
    on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
    jobs: Record<string, { steps: Record<string, unknown>[] }>;
  };
  assert.equal(workflow.on.workflow_dispatch.inputs.connected_private_diagnostic?.default, false);
  const steps = workflow.jobs["installed-prerequisite"]!.steps;
  const publicDiagnostics = steps.find(
    (step) => step.name === "Retain only selected public diagnostics",
  );
  assert.ok(publicDiagnostics && isRecord(publicDiagnostics.with));
  const publicPaths = String(publicDiagnostics.with.path).trim().split("\n");
  assert.deepEqual(
    publicPaths.filter((name) => name.includes("derivation")),
    ["work/updater-rehearsal/windows-fixture-derivation.json"],
  );
  assert.ok(!publicPaths.some((name) => /(?:^|\/)(?:private|owner)(?:\/|$)/u.test(name)));
  const producer = await readFile(
    new URL("./rehearse-updater-artifacts.ps1", import.meta.url),
    "utf8",
  );
  const publication = producer.slice(producer.lastIndexOf("if($captureFixtureDerivation){"));
  assert.match(publication, /Private rehearsal input remains before derivation publication/u);
  assert.match(
    publication,
    /if\(\$bytes.Length -gt 65536\)\{throw 'Fixture derivation report exceeds bound'\}/u,
  );
  assert.match(publication, /'windows-fixture-derivation.json'\),\[IO.FileMode\]::CreateNew/u);
  const record = publication.split("\n").find((line) => line.includes("$derivation=[ordered]"));
  assert.ok(record);
  assert.doesNotMatch(
    record,
    /\$(?:privateKey|password|credential)\b|\$env:(?!GITHUB_(?:RUN_ID|RUN_ATTEMPT|WORKFLOW_REF)\b)/iu,
  );
  const preflight = steps.findIndex((step) => step.id === "diagnostic_preflight"),
    native = steps.findIndex((step) => step.name === "Provision pinned Windows native driver");
  assert.ok(preflight > 0 && preflight < native);
  for (const name of ["diagnostic_pre_upload", "diagnostic_post_upload"]) {
    const step = steps.find((row) => row.id === name);
    assert.ok(step && isRecord(step.with));
    assert.equal(step.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    assert.equal(step.with["retention-days"], 7);
    assert.equal(step.with.overwrite, false);
    assert.equal(step.with["compression-level"], 0);
  }
  const settlement = steps.find(
    (row) => row.name === "Retain only bounded diagnostic source and cleanup records",
  );
  assert.ok(settlement && isRecord(settlement.with));
  assert.match(String(settlement.if), /always\(\)/u);
  assert.equal(
    settlement.with.path,
    "work/hosted-windows-connected-diagnostic/diagnostic-public-settlement.json\n${{ runner.temp }}/portcove-hosted-windows-connected-diagnostic/controller-ready.json\n",
  );
  assert.ok(
    !String(settlement.with.path).includes("owner/") &&
      !String(settlement.with.path).includes("stdout"),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-diagnostic-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ["diagnostic_pre", "diagnostic_post"]) {
    const step = steps.find((row) => row.id === id);
    assert.ok(typeof step?.run === "string");
    const output = path.join(root, id + ".output"),
      program = path.join(root, id + ".ps1"),
      request = {
        request_sha256: "a".repeat(64),
        name: "fixed-diagnostic-name",
        files: ["subject.json", "report.json", "capture.json", "bundle.json"],
      };
    await writeFile(
      program,
      `$ErrorActionPreference='Stop'\nfunction node { '${JSON.stringify(request)}'; $global:LASTEXITCODE=0 }\n` +
        step.run,
    );
    const observed = spawnSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", program],
      { encoding: "utf8", timeout: 15000, env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    assert.equal(observed.status, 0, observed.stderr);
    assert.deepEqual((await readFile(output, "utf8")).trim().split(/\r?\n/u), [
      "request_sha256=" + request.request_sha256,
      "name=" + request.name,
      "paths<<PORTCOVE_DIAGNOSTIC_PATHS",
      ...request.files,
      "PORTCOVE_DIAGNOSTIC_PATHS",
    ]);
  }
  const launch = fileURLToPath(
    new URL("./release-hosted-native-windows-diagnostic-launch.ps1", import.meta.url),
  );
  for (const operation of ["Preflight", "Start"]) {
    const result = spawnSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", launch, "-Operation", operation],
      {
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, RUNNER_TEMP: path.join(root, "must-not-create") },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Fixed hosted Windows diagnostic context required/u);
  }
});

void test("source-held diagnostic controller refuses every transport operation before storage and native work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-diagnostic-controller-held-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = fileURLToPath(
    new URL("./release-hosted-native-windows-diagnostic.mts", import.meta.url),
  );
  // Even a pre-existing control directory cannot receive a failure write from
  // an invocation outside the one hosted task scope.
  const control = path.join(root, "portcove-hosted-windows-connected-diagnostic");
  await mkdir(control);
  for (const operation of [
    ["run"],
    ["request", "payload-signing"],
    ["ack", "release-publication", "a".repeat(64), "1", "b".repeat(64)],
    ["abort"],
    ["settle"],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...operation], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, RUNNER_TEMP: root, PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "true" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(await readdir(control), []);
  }
});
