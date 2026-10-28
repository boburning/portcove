import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
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
      timeout: 45000,
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
