import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { TestContext } from "node:test";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";

// Consumed test projections of PowerShell-owned journals, not a second acceptance
// schema. Preserve unconsumed fields when deliberately mutating recovery fixtures.
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function numberValue(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isFinite(value));
  return value;
}
function booleanValue(value: unknown): boolean {
  assert.ok(typeof value === "boolean");
  return value;
}
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null | undefined {
  return value === null || value === undefined ? value : parse(value);
}
function fileRecord(value: unknown) {
  const raw = object(value);
  return { ...raw, path: text(raw.path), sha256: text(raw.sha256) };
}
function sessionRun(value: unknown) {
  const raw = object(value);
  return {
    ...raw,
    id: text(raw.id),
    status: text(raw.status),
    pid: nullable(raw.pid, numberValue),
    start_time: nullable(raw.start_time, text),
    exit_code: nullable(raw.exit_code, numberValue),
  };
}
function sessionValue(value: unknown) {
  const raw = object(value);
  const files = Object.fromEntries(
    Object.entries(object(raw.files)).map(([key, value]) => [key, fileRecord(value)]),
  );
  return {
    ...raw,
    phase: text(raw.phase),
    files,
    process_runs: array(raw.process_runs).map(sessionRun),
    checkpoints: array(raw.checkpoints).map((value) => {
      const raw = object(value);
      return {
        ...raw,
        metadata: text(raw.metadata),
        process_run_id: nullable(raw.process_run_id, text),
      };
    }),
    abort_attempts: array(raw.abort_attempts).map((value) => {
      const raw = object(value);
      return { ...raw, status: text(raw.status), exit_code: nullable(raw.exit_code, numberValue) };
    }),
    active_run_id: nullable(raw.active_run_id, text),
    installer: nullable(raw.installer, (value) => {
      const raw = object(value);
      return { ...raw, registration_removed: nullable(raw.registration_removed, booleanValue) };
    }),
    abort_cleanup: nullable(raw.abort_cleanup, (value) => {
      const raw = object(value);
      return {
        ...raw,
        zero_owned_processes: booleanValue(raw.zero_owned_processes),
        zero_managed_install_files: booleanValue(raw.zero_managed_install_files),
        zero_global_registrations: booleanValue(raw.zero_global_registrations),
      };
    }),
    finish_attempt: nullable(raw.finish_attempt, (value) => {
      const raw = object(value);
      return {
        ...raw,
        id: text(raw.id),
        stage: text(raw.stage),
        snapshot_path: text(raw.snapshot_path),
      };
    }),
    finish_receipt: nullable(raw.finish_receipt, (value) => {
      const raw = object(value);
      return {
        ...raw,
        path: text(raw.path),
        pre_finish_session_path: text(raw.pre_finish_session_path),
        pre_finish_session_sha256: text(raw.pre_finish_session_sha256),
      };
    }),
  };
}
function lifecycleRun(value: unknown) {
  const raw = object(value);
  return {
    ...raw,
    role: text(raw.role),
    status: text(raw.status),
    pid: nullable(raw.pid, numberValue),
    executable_sha256: nullable(raw.executable_sha256, text),
    exit_code: nullable(raw.exit_code, numberValue),
    exit_observation: nullable(raw.exit_observation, text),
    image_observation: raw.image_observation,
    close_request: nullable(raw.close_request, (value) => {
      const raw = object(value);
      return { ...raw, accepted: booleanValue(raw.accepted) };
    }),
  };
}
function lifecycleValue(value: unknown) {
  const raw = object(value);
  return {
    ...raw,
    phase: text(raw.phase),
    process_runs: nullable(raw.process_runs, (value) => array(value).map(lifecycleRun)),
    uninstaller_sha256: nullable(raw.uninstaller_sha256, text),
    details: nullable(raw.details, (value) => {
      const raw = object(value);
      return {
        ...raw,
        update_path: nullable(raw.update_path, text),
        upgrade: raw.upgrade,
        registration_removed: nullable(raw.registration_removed, booleanValue),
        application_present: nullable(raw.application_present, booleanValue),
        uninstaller_present: nullable(raw.uninstaller_present, booleanValue),
        remaining_registration_paths: nullable(raw.remaining_registration_paths, (value) =>
          array(value).map(text),
        ),
        current_installed_boundary: nullable(raw.current_installed_boundary, (value) => {
          const raw = object(value);
          return { ...raw, execution_context: text(raw.execution_context) };
        }),
      };
    }),
  };
}
function boundaryObservation(value: unknown) {
  const raw = object(value),
    ready = object(raw.ready),
    details = object(ready.details);
  return {
    ...raw,
    app: text(raw.app),
    ready: {
      ...ready,
      details: { ...details, registration_path: text(details.registration_path) },
    },
  };
}
function buildRecord(value: unknown) {
  const raw = object(value),
    artifacts = object(raw.artifacts),
    predecessor = object(raw.predecessor);
  const artifact = (value: unknown) => {
    const raw = object(value);
    return { ...raw, relative_path: text(raw.relative_path) };
  };
  return {
    ...raw,
    artifacts: {
      ...artifacts,
      installer: artifact(artifacts.installer),
      cli: artifact(artifacts.cli),
      desktop: artifact(artifacts.desktop),
    },
    predecessor: {
      ...predecessor,
      version: text(predecessor.version),
      installer: artifact(predecessor.installer),
    },
  };
}
function imageObservations(value: unknown) {
  return array(value).map((value) => {
    const raw = object(value);
    return {
      ...raw,
      mode: text(raw.mode),
      path: nullable(raw.path, text),
      exited: nullable(raw.exited, booleanValue),
      error: nullable(raw.error, text),
      cim_path: nullable(raw.cim_path, text),
      observations: numberValue(raw.observations),
      queries: numberValue(raw.queries),
    };
  });
}

const script = fileURLToPath(new URL("./windows-qualification-session.ps1", import.meta.url));
const reportTool = fileURLToPath(new URL("./qualification-report.mts", import.meta.url));
const recordTool = fileURLToPath(
  new URL("./write-windows-qualification-build.mts", import.meta.url),
);
const installerLifecycleTool = fileURLToPath(
  new URL("./test-windows-installer.ps1", import.meta.url),
);
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

type ChildProjection = {
  cim_pid: number | null;
  cim_parent_pid: number | null;
  retained_pid: number | null;
  cim_creation_time: string | null;
  retained_start_time: string | null;
  initial_has_exited: boolean | null;
  refusal_has_exited: boolean | null;
  cim_path_present: boolean | null;
  image_read_state: "null" | "blank" | null;
};
function unverifiedChildCaptureFailed(evidence: unknown) {
  const value = isRecord(evidence) ? evidence.unverified_child_capture_failed : undefined;
  return typeof value === "boolean" ? value : null;
}
function unverifiedChildProjection(evidence: unknown) {
  const records = isRecord(evidence) ? evidence.unverified_child_observations : undefined;
  if (!Array.isArray(records)) return [];
  const entries: unknown[] = records;
  return entries.slice(0, 1).map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const projected: ChildProjection = {
      cim_pid: null,
      cim_parent_pid: null,
      retained_pid: null,
      cim_creation_time: null,
      retained_start_time: null,
      initial_has_exited: null,
      refusal_has_exited: null,
      cim_path_present: null,
      image_read_state: null,
    };
    for (const key of ["cim_pid", "cim_parent_pid", "retained_pid"] as const) {
      const value = record[key];
      projected[key] =
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    for (const key of ["cim_creation_time", "retained_start_time"] as const) {
      const value = record[key];
      projected[key] =
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}(?:Z|[+-]\d{2}:\d{2})$/.test(value)
          ? value
          : null;
    }
    for (const key of ["initial_has_exited", "refusal_has_exited", "cim_path_present"] as const) {
      const value = record[key];
      projected[key] = typeof value === "boolean" ? value : null;
    }
    const imageState = record.image_read_state;
    projected.image_read_state =
      imageState === "null" || imageState === "blank" ? imageState : null;
    return projected;
  });
}

void test("unverified child failure projection bounds and sanitizes diagnostic scalars", () => {
  const record = {
    cim_pid: 42,
    cim_parent_pid: Infinity,
    retained_pid: "private process text",
    cim_creation_time: "2026-10-09T04:00:00.0000000Z",
    retained_start_time: "private path",
    initial_has_exited: false,
    refusal_has_exited: "private text",
    cim_path_present: true,
    image_read_state: "blank",
    executable_path: "private path",
  };
  assert.deepEqual(unverifiedChildProjection({ unverified_child_observations: [record, record] }), [
    {
      cim_pid: 42,
      cim_parent_pid: null,
      retained_pid: null,
      cim_creation_time: "2026-10-09T04:00:00.0000000Z",
      retained_start_time: null,
      initial_has_exited: false,
      refusal_has_exited: null,
      cim_path_present: true,
      image_read_state: "blank",
    },
  ]);
  assert.deepEqual(unverifiedChildProjection({}), []);
  assert.equal(unverifiedChildCaptureFailed({ unverified_child_capture_failed: true }), true);
  assert.equal(unverifiedChildCaptureFailed({ unverified_child_capture_failed: false }), false);
  assert.equal(
    unverifiedChildCaptureFailed({ unverified_child_capture_failed: "private text" }),
    null,
  );
  assert.equal(unverifiedChildCaptureFailed({}), null);
});

function runPowerShell(
  args: readonly string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
) {
  return spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    ...options,
  });
}

void test(
  "uninstaller image observation settles only the same retained identity within its deadline",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "portcove-child-image-observer-"));
    try {
      const fixture = path.join(temporary, "observer.ps1");
      writeFileSync(
        fixture,
        String.raw`
param([string]$Source)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production PowerShell source did not parse' }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-UninstallerChildImage'
}, $false))
if ($functions.Count -ne 1) { throw 'Expected one production image observer' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$script:created = [DateTime]::UtcNow
$script:observations = 0
$script:queries = 0
function Get-CimInstance($ClassName, $Filter, $OperationTimeoutSec) {
    if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 700' -or $OperationTimeoutSec -ne 1) { throw 'Unexpected process query' }
    $script:queries++
    if ($script:mode -eq 'late_cim') { Start-Sleep -Milliseconds 1700 }
    $item = [pscustomobject]@{ ProcessId = 700; ParentProcessId = 600; CreationDate = $script:created; ExecutablePath = 'C:\owned\child.exe' }
    switch ($script:mode) {
        'wrong_pid' { $item.ProcessId = 701 }
        'wrong_parent' { $item.ParentProcessId = 601 }
        'wrong_creation' { $item.CreationDate = $script:created.AddTicks(1) }
        { $_ -in @('persistent','cim_pending') } { $item.ExecutablePath = $null }
        'ambiguous' { return @($item, $item) }
    }
    $item
}
$reports = foreach ($mode in @('settled','exited','persistent','cim_pending','wrong_pid','wrong_parent','wrong_creation','ambiguous','expired','near_expiry','late_cim')) {
    $script:mode = $mode; $script:observations = 0; $script:queries = 0
    $child = [pscustomobject]@{ ProcessId = 700; ParentProcessId = 600; CreationDate = $script:created; ExecutablePath = $null }
    $retained = [pscustomobject]@{ Id = 700 }
    $retained | Add-Member ScriptMethod Refresh { $script:observations++ }
    $retained | Add-Member ScriptMethod WaitForExit { param($milliseconds)
        if ($milliseconds -ne 0) { throw 'Observer must not wait or reset the operation deadline' }
        return ($script:mode -eq 'exited' -and $script:observations -gt 1)
    }
    $retained | Add-Member ScriptProperty Path {
        if ($script:mode -eq 'late_cim') { return 'C:\owned\child.exe' }
        if ($script:mode -in @('settled','cim_pending') -and $script:observations -gt 1) { return 'C:\owned\child.exe' }
        return $null
    }
    $deadline = switch ($mode) {
        'expired' { [DateTime]::UtcNow.AddMilliseconds(-1) }
        'near_expiry' { [DateTime]::UtcNow.AddMilliseconds(500) }
        'late_cim' { [DateTime]::UtcNow.AddMilliseconds(1500) }
        default { [DateTime]::UtcNow.AddSeconds(5) }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $result = Read-UninstallerChildImage $retained $child $deadline
        [pscustomobject]@{ mode = $mode; exited = $result.exited; path = $result.path; cim_path = $result.child.ExecutablePath; error = $null; observations = $script:observations; queries = $script:queries; milliseconds = $clock.ElapsedMilliseconds }
    } catch {
        [pscustomobject]@{ mode = $mode; exited = $null; path = $null; error = $_.Exception.Message; observations = $script:observations; queries = $script:queries; milliseconds = $clock.ElapsedMilliseconds }
    }
}
$waitFunctions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-JournaledUninstallerChild'
}, $false))
if ($waitFunctions.Count -ne 1) { throw 'Expected one production child ownership waiter' }
$waitSource = $waitFunctions[0].Extent.Text
$filter = @($waitFunctions[0].Body.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.Contains('$exact.StartsWith($prefix') -and
    $node.Extent.Text.Contains('$exact.Equals($cimPath')
}, $false))
if ($filter.Count -ne 1) { throw 'Expected one ownership filter' }
$nativeAccount = $null; $evidence = $null; $ProcessIdentityClockToleranceMilliseconds = 1000
$parent = [pscustomobject]@{ pid = 600; start_time = [DateTime]::UtcNow.AddMinutes(1).ToString('o') }
function Get-CimInstance($ClassName, $Filter, $OperationTimeoutSec) {
    if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ParentProcessId = 600' -or $OperationTimeoutSec -ne 2) { throw 'Unexpected ownership query' }
    [pscustomobject]@{ ProcessId = $PID; ParentProcessId = 600; CreationDate = [DateTime]::UtcNow.AddHours(-1); ExecutablePath = $script:ownershipPath }
}
function Read-UninstallerChildImage($Process, $Child, $Deadline) {
    [pscustomobject]@{ exited = $false; path = $script:ownershipPath; child = $Child }
}
function Assert-NoReparseAncestry { throw 'Unverified ownership reached filesystem authority' }
function Get-FileHash { throw 'Unverified ownership reached hashing authority' }
function Stop-JournaledProcess { throw 'Control must never signal a process' }
function Complete-JournaledProcess { throw 'Control must never acquire completion authority' }
$ownership = foreach ($variant in @('original','renamed','removed-filter')) {
    $executable = $waitSource
    if ($variant -eq 'renamed') { $executable = $executable.Replace('$parentStarted','$retainedParentStarted') }
    if ($variant -eq 'removed-filter') { $executable = $executable.Replace($filter[0].Extent.Text,'') }
    . ([scriptblock]::Create($executable))
    foreach ($mode in @('unowned','owned-wrong-generation')) {
        $script:ownershipPath = if ($mode -eq 'unowned') {
            [IO.Path]::Combine([IO.Path]::GetPathRoot($PSScriptRoot),'foreign-uninstaller.exe')
        } else { [IO.Path]::Combine($PSScriptRoot,'child.exe') }
        try {
            Wait-JournaledUninstallerChild $parent $PSScriptRoot ([DateTime]::UtcNow.AddSeconds(5))
            [pscustomobject]@{ variant = $variant; mode = $mode; error = $null }
        } catch {
            [pscustomobject]@{ variant = $variant; mode = $mode; error = $_.Exception.Message }
        }
    }
}
ConvertTo-Json -InputObject @{ images = @($reports); ownership = @($ownership) } -Depth 8 -Compress
`,
      );
      const result = spawnSync(
        "pwsh.exe",
        ["-NoLogo", "-NoProfile", "-File", fixture, "-Source", installerLifecycleTool],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const observations = object(JSON.parse(result.stdout));
      const reports = imageObservations(observations.images);
      assert.equal(reports.length, 11);
      const byMode = new Map(reports.map((report) => [report.mode, report]));
      const modeReport = (mode: string) => required(byMode.get(mode));
      assert.equal(modeReport("settled").path, "C:\\owned\\child.exe");
      assert.equal(modeReport("settled").exited, false);
      assert.ok(modeReport("settled").observations >= 2);
      assert.equal(modeReport("exited").exited, true);
      assert.equal(modeReport("cim_pending").exited, false);
      assert.equal(modeReport("cim_pending").cim_path, null);
      for (const mode of ["persistent", "expired", "near_expiry", "late_cim"]) {
        assert.equal(modeReport(mode).exited, false);
        assert.equal(modeReport(mode).path, null);
        assert.equal(modeReport(mode).error, null);
      }
      assert.equal(modeReport("expired").queries, 0);
      assert.equal(modeReport("near_expiry").queries, 0);
      assert.equal(modeReport("late_cim").queries, 1);
      for (const mode of ["wrong_pid", "wrong_parent", "wrong_creation", "ambiguous"]) {
        assert.match(text(modeReport(mode).error), /process identity (?:changed|is ambiguous)/);
        assert.equal(modeReport(mode).path, null);
      }
      const ownership = array(observations.ownership).map(object);
      assert.equal(ownership.length, 6);
      const assertOwnership = (variant: string) => {
        const unowned = required(
          ownership.find((item) => item.variant === variant && item.mode === "unowned"),
        );
        const owned = required(
          ownership.find(
            (item) => item.variant === variant && item.mode === "owned-wrong-generation",
          ),
        );
        assert.equal(
          unowned.error,
          null,
          "a reused parent PID cannot grant authority over an unowned descendant",
        );
        assert.match(
          text(owned.error),
          /Owned uninstaller child process identity changed before observation/u,
        );
      };
      assertOwnership("original");
      assertOwnership("renamed");
      assert.throws(() => assertOwnership("removed-filter"), { name: "AssertionError" });
      for (const observation of ownership)
        assert.doesNotMatch(
          String(observation.error),
          /filesystem authority|hashing authority|signal a process|completion authority/u,
        );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

let compiledFixtureRoot: string | undefined;
after(() => {
  if (compiledFixtureRoot) rmSync(compiledFixtureRoot, { recursive: true, force: true });
});

function compiledFixtures() {
  if (compiledFixtureRoot) return compiledFixtureRoot;
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-session-compiled-"));
  compiledFixtureRoot = root;
  const artifacts = root;
  const desktopSource = path.join(root, "desktop.cs");
  writeFileSync(
    desktopSource,
    String.raw`using System; using System.Windows.Forms;
class Desktop { [STAThread] static void Main() { Application.EnableVisualStyles(); var f = new Form(); f.Text = "Portcove fixture"; Application.Run(f); } }
`,
  );
  const desktop = path.join(artifacts, "desktop.exe");
  execFileSync(
    csc,
    [
      "/nologo",
      "/target:winexe",
      "/reference:System.Windows.Forms.dll",
      `/out:${desktop}`,
      desktopSource,
    ],
    { windowsHide: true },
  );
  const cliSource = path.join(root, "cli.cs");
  writeFileSync(
    cliSource,
    String.raw`using System;
class Cli { static void Main(string[] a) { string data = "{}"; for (int i=0;i<a.Length;i++) { if (a[i]=="catalog") data="{\"schema_version\":2,\"ports\":[]}"; else if (a[i]=="status" || a[i]=="activity" || (a[i]=="source" && i+1<a.Length && a[i+1]=="list")) data="[]"; } Console.Write("{\"ok\":true,\"data\":"+data+"}"); } }
`,
  );
  const cli = path.join(artifacts, "cli.exe");
  execFileSync(csc, ["/nologo", `/out:${cli}`, cliSource], {
    windowsHide: true,
  });
  const installer = path.join(artifacts, "installer.exe");
  const predecessor = path.join(artifacts, "predecessor.exe");
  copyFileSync(desktop, installer);
  copyFileSync(desktop, predecessor);
  const uninstallerSource = path.join(root, "uninstaller.cs");
  writeFileSync(
    uninstallerSource,
    String.raw`using System; using System.IO; using System.Diagnostics; using System.Reflection; using System.Threading;
class Uninstaller { static int Main() {
  var release = Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_UNINSTALL_RELEASE");
  if (release != null) {
    var waiting = Stopwatch.StartNew();
    while (!File.Exists(release)) {
      if (waiting.ElapsedMilliseconds >= 15000) return 94;
      Thread.Sleep(20);
    }
  }
  var delay = Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_UNINSTALL_DELAY_MS"); if (delay != null) Thread.Sleep(Int32.Parse(delay)); var requestedExit = Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_UNINSTALL_EXIT"); if (requestedExit != null) return Int32.Parse(requestedExit); if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_UNINSTALL_LEAVE") == "1") return 0; var self = Assembly.GetExecutingAssembly().Location; var command = "/c ping 127.0.0.1 -n 2 > nul & del /f /q \"" + self + "\""; Process.Start(new ProcessStartInfo("cmd.exe", command) { CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden }); return 0;
} }
`,
  );
  const uninstaller = path.join(artifacts, "uninstaller.exe");
  execFileSync(csc, ["/nologo", "/target:winexe", `/out:${uninstaller}`, uninstallerSource], {
    windowsHide: true,
  });
  const sleeperSource = path.join(root, "sleeper.cs");
  writeFileSync(
    sleeperSource,
    'using System; using System.IO; using System.Diagnostics; using System.Threading; class Sleeper { static void Main() { var ready = Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_READY"); if (ready != null) File.WriteAllText(ready, Process.GetCurrentProcess().Id.ToString()); Thread.Sleep(Int32.Parse(Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_SLEEP_MS") ?? "10000")); } }\n',
  );
  const sleeper = path.join(artifacts, "sleeper.exe");
  // This process must outlive its launcher, independently of console teardown.
  execFileSync(csc, ["/nologo", "/target:winexe", `/out:${sleeper}`, sleeperSource], {
    windowsHide: true,
  });
  return root;
}

function csharpLiteral(value: string) {
  return `@"${value.replaceAll('"', '""')}"`;
}

function makeInstallerLifecycleFixture(t: TestContext) {
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "portcove-installer-lifecycle-")),
  );
  const keyName = `PortcoveHarness-${path.basename(root)}`;
  const keyPath = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${keyName}`;
  t.after(() => {
    removeInstallerLifecycleRegistration({ keyPath });
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });

  const desktopSource = path.join(root, "desktop.cs");
  writeFileSync(
    desktopSource,
    String.raw`using System; using System.IO; using System.Runtime.InteropServices; using System.Windows.Forms;
class Desktop { [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command); [STAThread] static void Main() { var library = Environment.GetEnvironmentVariable("PORTCOVE_LIBRARY"); Directory.CreateDirectory(library); File.WriteAllText(Path.Combine(library, "portcove.sqlite3"), "fixture-db"); Application.EnableVisualStyles(); var form = new Form(); form.Text = "Portcove fixture"; form.Shown += (sender, args) => ShowWindow(form.Handle, 5); Application.Run(form); } }
`,
  );
  const desktop = path.join(root, "desktop.exe");
  execFileSync(
    csc,
    [
      "/nologo",
      "/target:winexe",
      "/reference:System.Windows.Forms.dll",
      `/out:${desktop}`,
      desktopSource,
    ],
    { windowsHide: true },
  );

  const uninstallerSource = path.join(root, "uninstaller.cs");
  writeFileSync(
    uninstallerSource,
    `using System; using System.Diagnostics; using System.IO; using System.Threading; using Microsoft.Win32;
class Uninstaller {
  static void Main(string[] args) {
    if (args.Length == 2 && args[0] == "--cleanup") {
      if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_HANG_CHILD") == "1") Thread.Sleep(60000);
      var install = args[1];
      Thread.Sleep(100);
      for (var i = 0; i < 100; i++) {
        try { File.Delete(Path.Combine(install, "portcove-desktop.exe")); File.Delete(Path.Combine(install, "uninstall.exe")); } catch {}
        if (!File.Exists(Path.Combine(install, "portcove-desktop.exe")) && !File.Exists(Path.Combine(install, "uninstall.exe"))) break;
        Thread.Sleep(25);
      }
      var delay = Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_REGISTRATION_DELAY_MS");
      if (delay != null) Thread.Sleep(Int32.Parse(delay));
      if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_KEEP_REGISTRATION") != "1") Registry.CurrentUser.DeleteSubKeyTree(${csharpLiteral(keyPath)}, false);
      return;
    }
    if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_HANG_UNINSTALLER") == "1") Thread.Sleep(60000);
    var self = Process.GetCurrentProcess().MainModule.FileName;
    var target = Path.Combine(Path.GetTempPath(), "cleanup-" + Guid.NewGuid().ToString("N") + ".exe");
    File.Copy(self, target);
    Process.Start(new ProcessStartInfo(target, "--cleanup \\"" + Path.GetDirectoryName(self) + "\\"") { CreateNoWindow = true, UseShellExecute = false });
  }
}
`,
  );
  const uninstaller = path.join(root, "uninstaller.exe");
  execFileSync(csc, ["/nologo", `/out:${uninstaller}`, uninstallerSource], {
    windowsHide: true,
  });

  const installerSource = path.join(root, "installer.cs");
  writeFileSync(
    installerSource,
    `using System; using System.IO; using System.Threading; using Microsoft.Win32;
class Installer {
  static void Main(string[] args) {
    if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_HANG_INSTALLER") == "1") Thread.Sleep(60000);
    string install = null;
    bool update = false;
    foreach (var arg in args) {
      if (arg.StartsWith("/D=")) install = arg.Substring(3);
      if (arg == "/UPDATE") update = true;
    }
    if (install == null && update) {
      using (var key = Registry.CurrentUser.OpenSubKey(${csharpLiteral(keyPath)})) {
        if (key != null) install = key.GetValue("InstallLocation") as string;
      }
    }
    if (install == null) Environment.Exit(2);
    Directory.CreateDirectory(install);
    File.Copy(${csharpLiteral(desktop)}, Path.Combine(install, "portcove-desktop.exe"), true);
    File.Copy(${csharpLiteral(uninstaller)}, Path.Combine(install, "uninstall.exe"), true);
    using (var key = Registry.CurrentUser.CreateSubKey(${csharpLiteral(keyPath)})) {
      key.SetValue("DisplayName", "Portcove");
      key.SetValue("InstallLocation", install);
      key.SetValue("DisplayVersion", "0.1.0-alpha.2");
      key.SetValue("UninstallString", "\\"" + Path.Combine(install, "uninstall.exe") + "\\"");
    }
  }
}
`,
  );
  const installer = path.join(root, "installer.exe");
  execFileSync(csc, ["/nologo", `/out:${installer}`, installerSource], {
    windowsHide: true,
  });
  return { root, installer, desktop, keyPath };
}

void test(
  "current-installed boundary runs before uninstall and preserves failed or unproven native outcomes",
  { skip: process.platform !== "win32", timeout: 90_000 },
  (t) => {
    const item = makeInstallerLifecycleFixture(t);
    const repository = path.join(item.root, "boundary-repository");
    mkdirSync(path.join(repository, "scripts"), { recursive: true });
    copyFileSync(
      installerLifecycleTool,
      path.join(repository, "scripts", "test-windows-installer.ps1"),
    );
    for (const name of [
      "desktop-test-cli.mts",
      "runtime-values.mts",
      "native-session-lock.mts",
      "process-lock.mts",
      "heavy-rust-test-lock.mts",
      "resource-paths.mts",
      "development-evidence.mts",
    ]) {
      copyFileSync(
        fileURLToPath(new URL(`./${name}`, import.meta.url)),
        path.join(repository, "scripts", name),
      );
    }
    writeFileSync(
      path.join(repository, "scripts", "tool-cache.mts"),
      'export const readToolPins=()=>({packageManager:"pnpm@12.8.1"}); export const toolCachePaths=()=>({sharedRoot:process.env.PORTCOVE_SHARED_TOOL_CACHE});',
    );
    writeFileSync(
      path.join(repository, "scripts", "dev-storage.mts"),
      'export {spawnSync as spawnCommand} from "node:child_process";',
    );
    // This existing isolated lifecycle fixture does not exercise capacity or
    // containment. Real resource controls and the current-installed native run
    // cover those boundaries; retain actual native ownership and creation checks.
    writeFileSync(
      path.join(repository, "scripts", "resource-command.mts"),
      'import assert from "node:assert/strict"; export const resourceEntrypoint=async(profile,action)=>{assert.equal(profile,"browser"); return await action();};',
    );
    // Controlled doctor refusal tests the fixed route's ordering, not real tools.
    writeFileSync(
      path.join(repository, "scripts", "dev-doctor.mts"),
      'export const collectDoctor=async()=>({ok:process.env.PORTCOVE_FIXTURE_PREFLIGHT_FAILURE!=="1"});',
    );
    const selenium = path.join(repository, "node_modules", "selenium-webdriver");
    mkdirSync(selenium, { recursive: true });
    writeFileSync(path.join(selenium, "package.json"), '{"main":"index.js"}');
    writeFileSync(
      path.join(selenium, "index.js"),
      "// Resolution fixture, never imported or executed.",
    );
    const configurationRoot = path.join(repository, "apps", "desktop", "src-tauri");
    mkdirSync(configurationRoot, { recursive: true });
    const configuration = ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"].map(
      (name: string) => {
        const file = path.join(configurationRoot, name);
        writeFileSync(file, "owned ordinary package configuration fixture");
        return { path: file, sha256: sha256(file) };
      },
    );
    const harnessRoot = path.join(repository, "apps", "desktop", "scripts");
    mkdirSync(harnessRoot);
    // Fixed-path stub: lifecycle ordering/refusal, not actual WebDriver acceptance.
    writeFileSync(
      path.join(harnessRoot, "desktop-test.mts"),
      String.raw`
import assert from "node:assert/strict";
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import path from "node:path";
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const app = value("--app"), output = value("--output");
const manifest = JSON.parse(readFileSync(value("--package-evidence"), "utf8"));
const ready = JSON.parse(readFileSync(manifest.installer_evidence.path, "utf8"));
assert.equal(manifest.installer_evidence.bytes, readFileSync(manifest.installer_evidence.path).length);
assert.equal(manifest.execution_context, "current-installed");
assert.equal(ready.phase, "current_installed_boundary_ready");
assert.equal(ready.details.installed_executable_path, app);
assert.equal(ready.details.uninstall_registration_count, 1);
assert.equal(ready.details.application_exit_code, 0);
assert.ok(existsSync(app));
assert.ok(existsSync(path.join(path.dirname(app), "uninstall.exe")));
const owner=JSON.parse(readFileSync(path.join(process.env.PORTCOVE_SHARED_TOOL_CACHE,"locks","native-desktop","owner.json"),"utf8"));
assert.equal(owner.token,process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN);
process.kill(owner.pid,0); // Read-only liveness check: parent holds admission during callback.
mkdirSync(output);
writeFileSync(path.join(output, "callback-observed.json"), JSON.stringify({app, ready}));
if (process.env.PORTCOVE_FIXTURE_BOUNDARY_FAILURE === "1") process.exit(7);
writeFileSync(path.join(output, "evidence.json"), JSON.stringify({
  outcome: "passed", revision: manifest.revision,
  executable: {path: app, sha256: ready.details.installed_executable_sha256},
  checks: [{scenario: "native-normal-package-webview-boundary", outcome: "passed"}]
}));
const snapshot=path.join(output,"normal-package-boundary-exit-inventory.json");
const driver={pid:11,path:"owned-driver-fixture.exe",started_filetime:"133000000000000000"};
const application={pid:22,path:app,started_filetime:"133000000000000001"};
const processes=process.env.PORTCOVE_FIXTURE_APPLICATION_RECORD === "missing" ? [driver] :
  process.env.PORTCOVE_FIXTURE_APPLICATION_RECORD === "duplicate" ? [driver,application,{...application,pid:23}] :
  process.env.PORTCOVE_FIXTURE_APPLICATION_RECORD === "identity" ? [driver,{...application,started_filetime:null}] : [driver,application];
writeFileSync(snapshot,JSON.stringify({driver,application_pid:null,
  derivation:"include-captured-driver-root-in-positive-exit-inventory",
  processes}));
writeFileSync(path.join(output, "normal-package-boundary-cleanup.json"), JSON.stringify({
  snapshot,
  exited: process.env.PORTCOVE_FIXTURE_BOUNDARY_UNPROVEN === "1" ? null : {observed_processes: processes.length}
}));
`,
    );
    execFileSync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
    execFileSync("git", ["add", "."], { cwd: repository, windowsHide: true });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Portcove fixture",
        "-c",
        "user.email=fixture@portcove.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixed lifecycle fixture",
      ],
      { cwd: repository, windowsHide: true },
    );
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const manifestPath = path.join(item.root, "ordinary-package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        revision,
        build_command: ["pnpm", "--dir", "apps/desktop", "desktop:build", "--bundles", "nsis"],
        qualification_features: [],
        configuration,
        installer: { path: item.installer, sha256: sha256(item.installer) },
      }),
    );
    const parentIdentity = readProcessIdentity(process.pid);
    assert.ok(parentIdentity);
    const cases: [string, NodeJS.ProcessEnv, RegExp | null][] = [
      ["success", {}, null],
      [
        "preflight",
        { PORTCOVE_FIXTURE_PREFLIGHT_FAILURE: "1" },
        /Desktop doctor failed before installation/,
      ],
      ["failed", { PORTCOVE_FIXTURE_BOUNDARY_FAILURE: "1" }, /native boundary failed/],
      [
        "unproven",
        { PORTCOVE_FIXTURE_BOUNDARY_UNPROVEN: "1" },
        /lacks positive owned exit evidence/,
      ],
      [
        "missing-app",
        { PORTCOVE_FIXTURE_APPLICATION_RECORD: "missing" },
        /lacks positive owned exit evidence/,
      ],
      [
        "duplicate-app",
        { PORTCOVE_FIXTURE_APPLICATION_RECORD: "duplicate" },
        /lacks positive owned exit evidence/,
      ],
      [
        "invalid-app-identity",
        { PORTCOVE_FIXTURE_APPLICATION_RECORD: "identity" },
        /lacks positive owned exit evidence/,
      ],
      ["locked", {}, /already owned by PID/],
    ];
    for (const [name, environment, expectedError] of cases) {
      const caseRoot = path.join(item.root, name);
      mkdirSync(caseRoot);
      const resourceRoot = path.join(caseRoot, ".portcove", "resources");
      mkdirSync(resourceRoot, { recursive: true });
      writeFileSync(
        path.join(resourceRoot, "config.json"),
        JSON.stringify({ legacyMode: "coordinated" }),
      );
      const fixtureCache = path.join(item.root, "native-cache");
      const caseEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...environment,
        HOME: caseRoot,
        USERPROFILE: caseRoot,
        PORTCOVE_SHARED_TOOL_CACHE: fixtureCache,
      };
      for (const variable of [
        "PORTCOVE_NATIVE_SESSION_LOCK_TOKEN",
        "PORTCOVE_RESOURCE_RESERVATION",
        "PORTCOVE_HEAVY_RUST_LOCK_TOKEN",
        "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN",
        "PORTCOVE_CONTAINER_GUEST",
        "GITHUB_ACTIONS",
      ])
        delete caseEnvironment[variable];
      let lockedOwner;
      if (name === "locked") {
        const lockDirectory = path.join(fixtureCache, "locks", "native-desktop");
        mkdirSync(lockDirectory, { recursive: true });
        lockedOwner = JSON.stringify({
          format_version: 1,
          pid: process.pid,
          process_identity: parentIdentity,
          token: "owned-test-fixture",
          created_at: new Date().toISOString(),
        });
        writeFileSync(path.join(lockDirectory, "owner.json"), lockedOwner);
      }
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            os.tmpdir(),
            path.basename(item.root),
            "boundary-repository",
            "scripts",
            "desktop-test-cli.mts",
          ),
          "--current-installed",
          "--installer",
          item.installer,
          "--expected-app",
          item.desktop,
          "--expected-version",
          "0.1.0-alpha.2",
          "--test-base",
          path.join(caseRoot, "runs"),
          "--evidence",
          path.join(caseRoot, "lifecycle.json"),
          "--package-evidence",
          manifestPath,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
          env: caseEnvironment,
        },
      );
      if (name === "preflight" || name === "locked") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, required(expectedError));
        assert.equal(existsSync(path.join(caseRoot, "lifecycle.json")), false);
        assert.equal(existsSync(path.join(caseRoot, "runs")), false);
        if (name === "locked")
          assert.equal(
            readFileSync(path.join(fixtureCache, "locks", "native-desktop", "owner.json"), "utf8"),
            lockedOwner,
          );
        if (name === "preflight") {
          const doctor = object(
            JSON.parse(
              readFileSync(path.join(caseRoot, "lifecycle.json.native-doctor.json"), "utf8"),
            ),
          );
          assert.equal(doctor.ok, false);
        }
        continue;
      }
      assert.ok(
        existsSync(path.join(caseRoot, "lifecycle.json")),
        JSON.stringify({
          name,
          status: result.status,
          error: result.error,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
      const evidence = lifecycleValue(
        JSON.parse(readFileSync(path.join(caseRoot, "lifecycle.json"), "utf8")),
      );
      const observed = boundaryObservation(
        JSON.parse(
          readFileSync(
            path.join(caseRoot, "current-installed-boundary", "native", "callback-observed.json"),
            "utf8",
          ),
        ),
      );
      assert.equal(observed.ready.details.registration_path.includes("HKEY_CURRENT_USER"), true);
      if (expectedError) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expectedError);
        assert.equal(evidence.phase, "failed");
        assert.equal(
          required(evidence.process_runs).some((run) =>
            run.role.startsWith("candidate_uninstaller"),
          ),
          false,
        );
        assert.ok(existsSync(observed.app));
        removeInstallerLifecycleRegistration(item);
      } else {
        if (result.status !== 0) {
          t.diagnostic(
            JSON.stringify({
              unverified_child_observations: unverifiedChildProjection(evidence),
              unverified_child_capture_failed: unverifiedChildCaptureFailed(evidence),
            }),
          );
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(evidence.phase, "complete");
        assert.equal(
          required(required(evidence.details).current_installed_boundary).execution_context,
          "current-installed",
        );
        assert.equal(required(evidence.details).registration_removed, true);
        assert.equal(existsSync(observed.app), false);
      }
    }
  },
);

function runInstallerLifecycle(
  item: ReturnType<typeof makeInstallerLifecycleFixture>,
  name: string,
  environment: NodeJS.ProcessEnv,
  processTimeoutSeconds = "5",
  testFault = "",
  upgradeFrom = false,
) {
  const caseRoot = path.join(item.root, name);
  mkdirSync(caseRoot);
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-File",
    installerLifecycleTool,
    "-InstallerPath",
    item.installer,
    "-TestBase",
    path.join(caseRoot, "runs"),
    "-EvidencePath",
    path.join(caseRoot, "evidence.json"),
    "-ProcessTimeoutSeconds",
    processTimeoutSeconds,
    "-CleanupTimeoutSeconds",
    "2",
  ];
  if (testFault) args.push("-TestFault", testFault);
  if (upgradeFrom) args.push("-UpgradeFromInstallerPath", item.installer);
  return spawnSync("pwsh.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, ...environment },
  });
}

void test(
  "installer lifecycle uses registered ownership for an actual update-mode upgrade",
  { skip: process.platform !== "win32", timeout: 60_000 },
  (t) => {
    const item = makeInstallerLifecycleFixture(t);
    t.after(() => removeInstallerLifecycleRegistration(item));
    const upgraded = runInstallerLifecycle(item, "update-mode", {}, "5", "", true);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const evidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "update-mode", "evidence.json"), "utf8")),
    );
    assert.equal(evidence.phase, "complete");
    assert.equal(required(evidence.details).update_path, "registered_nsis_update");
    assert.ok(required(evidence.details).upgrade);
    assert.equal(
      required(evidence.process_runs).filter((run) => run.role === "predecessor_installer").length,
      1,
    );
    assert.equal(
      required(evidence.process_runs).filter((run) => run.role === "candidate_installer").length,
      1,
    );
  },
);

function removeInstallerLifecycleRegistration(item: { keyPath: string }) {
  const registryPath = `HKCU\\${item.keyPath}`;
  const deadline = Date.now() + 5_000;
  const waitSignal = new Int32Array(new SharedArrayBuffer(4));
  let deletion;
  let query;
  do {
    deletion = spawnSync("reg.exe", ["delete", registryPath, "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (deletion.error) throw deletion.error;
    query = spawnSync("reg.exe", ["query", registryPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (query.error) throw query.error;
    if (query.status === 1) return;
    Atomics.wait(waitSignal, 0, 0, 50);
  } while (Date.now() < deadline);

  assert.fail(
    `Fixture uninstall registration remained after bounded cleanup: ${JSON.stringify({
      registryPath,
      deleteStatus: deletion?.status,
      deleteError: deletion?.stderr?.trim(),
      queryStatus: query?.status,
      queryError: query?.stderr?.trim(),
    })}`,
  );
}

void test(
  "prepare still rejects an existing Portcove installer registration",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const keyPath = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PortcoveHarness-blocker-${path.basename(item.root)}`;
    const registryPath = `HKCU\\${keyPath}`;
    const added = spawnSync(
      "reg.exe",
      ["add", registryPath, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Portcove", "/f"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(added.status, 0, added.stderr);
    try {
      const prepared = runPowerShell(prepareArgs(item));
      assert.notEqual(prepared.status, 0);
      assert.match(prepared.stderr, /installer registration already exists/);
    } finally {
      removeInstallerLifecycleRegistration({ keyPath });
    }
  },
);

void test(
  "installer lifecycle behavior handles delayed, persistent, and hung uninstall cleanup",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeInstallerLifecycleFixture(t);

    const delayed = runInstallerLifecycle(
      item,
      "delayed",
      { PORTCOVE_FIXTURE_REGISTRATION_DELAY_MS: "3000" },
      "8",
    );
    assert.equal(delayed.status, 0, delayed.stderr);
    const delayedEvidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "delayed", "evidence.json"), "utf8")),
    );
    assert.equal(delayedEvidence.phase, "complete");
    assert.equal(required(delayedEvidence.details).registration_removed, true);
    const childRun = required(delayedEvidence.process_runs).find(
      (run) => run.role === "candidate_uninstaller_child",
    );
    assert.equal(required(childRun).status, "exit_observed");
    assert.equal(required(childRun).exit_code, 0);
    assert.equal(required(childRun).executable_sha256, delayedEvidence.uninstaller_sha256);

    const hungChild = runInstallerLifecycle(
      item,
      "hung-child",
      { PORTCOVE_FIXTURE_HANG_CHILD: "1" },
      "3",
    );
    assert.notEqual(hungChild.status, 0);
    assert.match(hungChild.stderr, /candidate_uninstaller_child did not exit within 3 seconds/);
    const hungChildEvidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "hung-child", "evidence.json"), "utf8")),
    );
    const timedOutChild = required(hungChildEvidence.process_runs).find(
      (run) => run.role === "candidate_uninstaller_child",
    );
    assert.equal(required(timedOutChild).status, "timed_out");
    assert.match(
      text(required(timedOutChild).exit_observation),
      /retained parent exit was observed after the termination request/,
    );
    removeInstallerLifecycleRegistration(item);
    const smoke = required(
      required(delayedEvidence.process_runs).find((run) => run.role === "candidate_smoke"),
    );
    assert.equal(required(smoke.close_request).accepted, true);

    const persistent = runInstallerLifecycle(item, "persistent", {
      PORTCOVE_FIXTURE_KEEP_REGISTRATION: "1",
    });
    assert.notEqual(persistent.status, 0);
    assert.match(persistent.stderr, /Uninstall left registration entries behind/);
    const persistentEvidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "persistent", "evidence.json"), "utf8")),
    );
    assert.equal(required(persistentEvidence.details).application_present, false);
    assert.equal(required(persistentEvidence.details).uninstaller_present, false);
    assert.equal(
      required(required(persistentEvidence.details).remaining_registration_paths).length,
      1,
    );
    removeInstallerLifecycleRegistration(item);

    const hung = runInstallerLifecycle(
      item,
      "hung",
      { PORTCOVE_FIXTURE_HANG_UNINSTALLER: "1" },
      "3",
    );
    assert.notEqual(hung.status, 0);
    assert.match(hung.stderr, /candidate_uninstaller did not exit within 3 seconds/);
    const hungEvidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "hung", "evidence.json"), "utf8")),
    );
    const uninstallerRun = required(hungEvidence.process_runs).find(
      (run) => run.role === "candidate_uninstaller",
    );
    assert.equal(required(uninstallerRun).status, "timed_out");
    assert.match(
      text(required(uninstallerRun).exit_observation),
      /retained parent exit was observed after the termination request/,
    );
    removeInstallerLifecycleRegistration(item);

    const verification = runInstallerLifecycle(
      item,
      "verification",
      { PORTCOVE_FIXTURE_HANG_INSTALLER: "1" },
      "5",
      "post-spawn-verification",
    );
    assert.notEqual(verification.status, 0);
    assert.match(
      verification.stderr,
      /candidate_installer injected post-spawn verification failure/,
    );
    const verificationEvidence = lifecycleValue(
      JSON.parse(readFileSync(path.join(item.root, "verification", "evidence.json"), "utf8")),
    );
    const installerRun = required(verificationEvidence.process_runs).find(
      (run) => run.role === "candidate_installer",
    );
    assert.equal(required(installerRun).status, "verification_failed");
    assert.match(
      text(required(installerRun).exit_observation),
      /retained parent exit was observed after the termination request/,
    );
    const task = spawnSync(
      "tasklist.exe",
      ["/FI", `PID eq ${required(installerRun).pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.doesNotMatch(task.stdout, new RegExp(`"${required(installerRun).pid}"`));
  },
);

function makeFixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-session-stateful-"));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    }),
  );
  const repository = path.join(root, "repository");
  mkdirSync(path.join(repository, "scripts"), { recursive: true });
  writeFileSync(path.join(repository, "Cargo.toml"), "[workspace]\n");
  copyFileSync(script, path.join(repository, "scripts", "windows-qualification-session.ps1"));
  copyFileSync(reportTool, path.join(repository, "scripts", "qualification-report.mts"));
  writeFileSync(
    path.join(repository, "scripts", "test-windows-installer.ps1"),
    String.raw`param(
  [string]$InstallerPath, [string]$UpgradeFromInstallerPath, [string]$ExpectedExecutablePath,
  [string]$TestBase, [string]$RetainedLibraryRoot, [string]$RetainExecutablePath, [string]$EvidencePath
)
$ErrorActionPreference = "Stop"
$run = Join-Path $TestBase "run-fixture"
$install = Join-Path $run "installed"
$library = $RetainedLibraryRoot
[IO.Directory]::CreateDirectory($install) | Out-Null
[IO.Directory]::CreateDirectory($library) | Out-Null
[ordered]@{ format=1; phase="initialized"; owned_paths=[ordered]@{ run_root_relative="run-fixture"; install_relative="run-fixture/installed"; library_relative="../library" }; failure=$null } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
if ($env:PORTCOVE_FIXTURE_FAIL -eq "1") {
  $fakeUninstaller = Join-Path $install "uninstall.exe"
  Copy-Item -LiteralPath $env:PORTCOVE_FIXTURE_UNINSTALLER -Destination $fakeUninstaller
  $journal = [ordered]@{ format=1; phase="failed"; owned_paths=[ordered]@{ run_root_relative="run-fixture"; install_relative="run-fixture/installed"; library_relative="../library" }; failure="fixture interruption" }
  if ($env:PORTCOVE_FIXTURE_UNINSTALLER_HASH -eq "correct") { $journal.uninstaller_sha256 = (Get-FileHash $fakeUninstaller -Algorithm SHA256).Hash.ToLowerInvariant() }
  elseif ($env:PORTCOVE_FIXTURE_UNINSTALLER_HASH -eq "wrong") { $journal.uninstaller_sha256 = "0" * 64 }
  $journal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  throw "fixture interruption"
}
[IO.File]::WriteAllText((Join-Path $library "portcove.sqlite3"), "fixture-db")
Copy-Item -LiteralPath $ExpectedExecutablePath -Destination $RetainExecutablePath
$hash = (Get-FileHash -LiteralPath $RetainExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{ format=1; phase="complete"; owned_paths=[ordered]@{ test_base=$TestBase; run_root_relative="run-fixture"; install_relative="run-fixture/installed"; library_relative="../library" }; failure=$null } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
[ordered]@{ installed_executable_sha256=$hash; managed_files_removed=$true; registration_removed=$true; persistent_data_preserved=$true; upgrade=[ordered]@{ predecessor_installer_sha256=(Get-FileHash $UpgradeFromInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant() } } | ConvertTo-Json -Compress
`,
  );
  execFileSync("git", ["init", "--quiet"], {
    cwd: repository,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "Portcove test"], {
    cwd: repository,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.email", "test@portcove.invalid"], {
    cwd: repository,
    windowsHide: true,
  });
  execFileSync("git", ["add", "."], { cwd: repository, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture candidate"], {
    cwd: repository,
    windowsHide: true,
  });

  const artifacts = path.join(repository, "artifacts");
  mkdirSync(artifacts);
  const compiled = compiledFixtures();
  const desktop = path.join(artifacts, "desktop.exe");
  copyFileSync(path.join(compiled, "desktop.exe"), desktop);
  const cli = path.join(artifacts, "cli.exe");
  copyFileSync(path.join(compiled, "cli.exe"), cli);
  const installer = path.join(artifacts, "installer.exe");
  copyFileSync(path.join(compiled, "installer.exe"), installer);
  const predecessor = path.join(artifacts, "predecessor.exe");
  copyFileSync(path.join(compiled, "predecessor.exe"), predecessor);
  const uninstaller = path.join(artifacts, "uninstaller.exe");
  copyFileSync(path.join(compiled, "uninstaller.exe"), uninstaller);
  const sleeper = path.join(artifacts, "sleeper.exe");
  copyFileSync(path.join(compiled, "sleeper.exe"), sleeper);
  const record = path.join(root, "build-record.json");
  const result = object(
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          recordTool,
          "--repository",
          repository,
          "--installer",
          installer,
          "--cli",
          cli,
          "--desktop",
          desktop,
          "--predecessor",
          predecessor,
          "--predecessor-version",
          "0.1.0-alpha.1",
          "--output",
          record,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    ),
  );
  return {
    root,
    repository,
    record,
    recordHash: text(result.sha256),
    session: path.join(root, "session"),
    uninstaller,
    sleeper,
  };
}

function prepareArgs(item: ReturnType<typeof makeFixture>, validateOnly = false) {
  const args = [
    "-Action",
    "prepare",
    "-SessionRoot",
    item.session,
    "-CandidateCheckout",
    item.repository,
    "-BuildRecordPath",
    item.record,
    "-ExpectedBuildRecordSha256",
    item.recordHash,
  ];
  if (validateOnly) args.push("-ValidateOnly");
  return args;
}

void test(
  "build-record validation binds a clean exact checkout, tools, artifacts, and predecessor",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const valid = runPowerShell(prepareArgs(item, true));
    assert.equal(valid.status, 0, valid.stderr);
    const result = object(JSON.parse(valid.stdout));
    assert.equal(result.validated, true);
    assert.equal(result.build_record_sha256, item.recordHash);
    assert.equal(result.predecessor_version, "0.1.0-alpha.1");
    assert.equal(existsSync(item.session), false);

    writeFileSync(path.join(item.repository, "scripts", "qualification-report.mts"), "tampered\n", {
      flag: "a",
    });
    const dirty = runPowerShell(prepareArgs(item, true));
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /exact clean checkout/);
  },
);

void test(
  "stateful fake packaged session prepares, journals process identity, checkpoints, relaunches, and finishes",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    let state = sessionValue(
      JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
    );
    assert.equal(state.phase, "prepared");
    assert.equal(state.process_runs.length, 1);
    assert.equal(required(state.process_runs[0]).status, "running_verified");
    assert.equal(state.checkpoints.length, 1);
    assert.equal(required(state.checkpoints[0]).process_run_id, null);
    assert.equal(required(state.installer).registration_removed, true);
    assert.ok(required(state.process_runs[0]).pid);
    assert.ok(required(state.process_runs[0]).start_time);
    assert.ok(existsSync(path.join(item.session, "library", "portcove.sqlite3")));

    mkdirSync(path.join(item.session, "checkpoints", "0009-interrupted"));
    const checkpoint = runPowerShell([
      "-Action",
      "checkpoint",
      "-SessionRoot",
      item.session,
      "-Label",
      "automated",
      "-Relaunch",
    ]);
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    state = sessionValue(JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")));
    assert.equal(state.process_runs.length, 2);
    assert.equal(required(state.process_runs[1]).status, "running_verified");
    assert.equal(state.checkpoints.length, 2);
    assert.match(required(state.checkpoints[1]).metadata, /^checkpoints\/0010-/);
    assert.equal(required(state.checkpoints[1]).process_run_id, required(state.process_runs[0]).id);

    const finish = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
    assert.equal(finish.status, 0, finish.stderr);
    state = sessionValue(JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")));
    assert.equal(state.phase, "finished");
    assert.equal(state.process_runs.length, 2);
    assert.equal(required(state.process_runs[1]).status, "exit_unobserved");
    assert.equal(required(state.process_runs[1]).exit_code, null);
    assert.equal(state.checkpoints.length, 3);
    assert.equal(required(state.checkpoints[2]).process_run_id, required(state.process_runs[1]).id);
    assert.ok(existsSync(path.join(item.session, required(state.finish_receipt).path)));
    assert.ok(
      existsSync(path.join(item.session, required(state.finish_receipt).pre_finish_session_path)),
    );
    assert.equal(
      sha256(path.join(item.session, required(state.finish_receipt).pre_finish_session_path)),
      required(state.finish_receipt).pre_finish_session_sha256,
    );
    const closed = runPowerShell(["-Action", "checkpoint", "-SessionRoot", item.session]);
    assert.notEqual(closed.status, 0);
    assert.match(closed.stderr, /already finished/);
  },
);

void test(
  "a checkpoint with changed evidence is rejected before another action",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const state = sessionValue(
      JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
    );
    const evidencePath = path.join(
      item.session,
      required(state.checkpoints[0]).metadata.replace("checkpoint.json", "evidence.json"),
    );
    const evidence = readFileSync(evidencePath);
    try {
      writeFileSync(evidencePath, "tampered\n", { flag: "a" });
      const result = runPowerShell(["-Action", "checkpoint", "-SessionRoot", item.session]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checkpoint file SHA-256 mismatch/);
    } finally {
      writeFileSync(evidencePath, evidence);
      const finished = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
      assert.equal(finished.status, 0, finished.stderr);
    }
  },
);

void test(
  "an interrupted prepare binds its journal and runs only a correctly hashed harmless uninstaller",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const failed = runPowerShell(prepareArgs(item), {
      env: {
        ...process.env,
        PORTCOVE_FIXTURE_FAIL: "1",
        PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
        PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
      },
    });
    assert.notEqual(failed.status, 0);
    let state = sessionValue(
      JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
    );
    assert.equal(state.phase, "prepare_failed");
    const installerEvidence = object(
      JSON.parse(
        readFileSync(path.join(item.session, "evidence", "installer-lifecycle.json"), "utf8"),
      ),
    );
    assert.equal(installerEvidence.phase, "failed");
    assert.equal(object(installerEvidence.owned_paths).install_relative, "run-fixture/installed");
    assert.equal(
      required(state.files.installer_evidence).sha256,
      sha256(path.join(item.session, "evidence", "installer-lifecycle.json")),
    );
    const aborted = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.equal(aborted.status, 0, aborted.stderr);
    state = sessionValue(JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")));
    assert.equal(state.phase, "aborted");
    assert.equal(required(state.abort_cleanup).zero_owned_processes, true);
    assert.equal(required(state.abort_cleanup).zero_managed_install_files, true);
    assert.equal(required(state.abort_cleanup).zero_global_registrations, true);
    assert.equal(
      existsSync(
        path.join(item.session, "installer-work", "run-fixture", "installed", "uninstall.exe"),
      ),
      false,
    );
  },
);

for (const mode of ["missing", "wrong"]) {
  void test(
    `abort retains evidence when the uninstaller hash is ${mode}`,
    { skip: process.platform !== "win32", timeout: 120_000 },
    (t) => {
      const item = makeFixture(t);
      const failed = runPowerShell(prepareArgs(item), {
        env: {
          ...process.env,
          PORTCOVE_FIXTURE_FAIL: "1",
          PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
          PORTCOVE_FIXTURE_UNINSTALLER_HASH: mode,
        },
      });
      assert.notEqual(failed.status, 0);
      const aborted = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
      assert.notEqual(aborted.status, 0);
      assert.match(
        aborted.stderr,
        mode === "missing"
          ? /uninstaller was not hash-journaled/
          : /partial-run uninstaller SHA-256 mismatch/,
      );
      const state = sessionValue(
        JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
      );
      assert.equal(state.phase, "prepare_failed");
      assert.ok(
        existsSync(
          path.join(item.session, "installer-work", "run-fixture", "installed", "uninstall.exe"),
        ),
      );
    },
  );
}

void test(
  "abort refuses an installer journal that was never hash-bound after a hard interruption",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const failed = runPowerShell(prepareArgs(item), {
      env: {
        ...process.env,
        PORTCOVE_FIXTURE_FAIL: "1",
        PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
        PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
      },
    });
    assert.notEqual(failed.status, 0);
    const sessionPath = path.join(item.session, "session.json");
    const state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    delete state.files.installer_evidence;
    writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`);
    const aborted = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.notEqual(aborted.status, 0);
    assert.match(aborted.stderr, /not hash-bound into session metadata/);
    assert.ok(
      existsSync(
        path.join(item.session, "installer-work", "run-fixture", "installed", "uninstall.exe"),
      ),
    );
  },
);

void test(
  "abort refuses success when a hash-verified uninstaller leaves managed install files",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const environment = {
      ...process.env,
      PORTCOVE_FIXTURE_FAIL: "1",
      PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
      PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
      PORTCOVE_FIXTURE_UNINSTALL_LEAVE: "1",
    };
    assert.notEqual(runPowerShell(prepareArgs(item), { env: environment }).status, 0);
    const aborted = runPowerShell(["-Action", "abort", "-SessionRoot", item.session], {
      env: environment,
    });
    assert.notEqual(aborted.status, 0);
    assert.match(aborted.stderr, /Managed install files remain after abort/);
    const state = sessionValue(
      JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
    );
    assert.equal(state.phase, "prepare_failed");
  },
);

void test(
  "a killed abort runner resumes only after exact uninstaller absence and owned cleanup are proven",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    const item = makeFixture(t);
    const baseEnvironment = {
      ...process.env,
      PORTCOVE_FIXTURE_FAIL: "1",
      PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
      PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
    };
    assert.notEqual(runPowerShell(prepareArgs(item), { env: baseEnvironment }).status, 0);
    const releaseMarker = path.join(item.root, "release-uninstaller");
    const child = spawn(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-File", script, "-Action", "abort", "-SessionRoot", item.session],
      {
        windowsHide: true,
        env: {
          ...baseEnvironment,
          PORTCOVE_FIXTURE_UNINSTALL_RELEASE: releaseMarker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Retain only bounded output from this owned fixture, including early abort
    // errors that otherwise leave a generic running-attempt assertion behind.
    let abortStdout = "";
    let abortStderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      abortStdout = (abortStdout + chunk.toString()).slice(-16_384);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      abortStderr = (abortStderr + chunk.toString()).slice(-16_384);
    });
    const exited = once(child, "exit");
    const sessionPath = path.join(item.session, "session.json");
    let state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    const deadline = Date.now() + 15_000;
    try {
      while (Date.now() < deadline) {
        state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
        if (state.abort_attempts?.some((attempt) => attempt.status === "running")) break;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        state.abort_attempts.some((attempt) => attempt.status === "running"),
        JSON.stringify({
          abort_exit_code: child.exitCode,
          abort_signal: child.signalCode,
          journal: state,
          stdout_tail: abortStdout,
          stderr_tail: abortStderr,
        }),
      );
      assert.equal(child.exitCode, null);
      assert.ok(child.kill(), "the owned runner must still be alive at interruption");
      await exited;
    } finally {
      // Keep the fixture alive until its owner can no longer journal its exit.
      // Release on failure too, so the bounded native fixture can clean itself up.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      writeFileSync(releaseMarker, "release");
    }
    const uninstallerPath = path.join(
      item.session,
      "installer-work",
      "run-fixture",
      "installed",
      "uninstall.exe",
    );
    const cleanupDeadline = Date.now() + 15_000;
    while (existsSync(uninstallerPath) && Date.now() < cleanupDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(uninstallerPath), false);
    const resumed = runPowerShell(["-Action", "abort", "-SessionRoot", item.session], {
      env: baseEnvironment,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    assert.equal(state.phase, "aborted");
    assert.equal(required(state.abort_attempts[0]).status, "exit_unobserved_cleanup_proven");
  },
);

void test(
  "a runner killed after an observed zero exit proves quiescence without relaunch",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    const item = makeFixture(t);
    const baseEnvironment = {
      ...process.env,
      PORTCOVE_FIXTURE_FAIL: "1",
      PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
      PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
    };
    assert.notEqual(runPowerShell(prepareArgs(item), { env: baseEnvironment }).status, 0);
    const child = spawn(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-File", script, "-Action", "abort", "-SessionRoot", item.session],
      {
        windowsHide: true,
        env: {
          ...baseEnvironment,
          PORTCOVE_QUALIFICATION_TEST_PAUSE_AFTER_ABORT_EXIT_MS: "5000",
        },
        stdio: "ignore",
      },
    );
    const sessionPath = path.join(item.session, "session.json");
    let state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
      if (state.abort_attempts?.some((attempt) => attempt.status === "exit_observed")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(required(state.abort_attempts[0]).status, "exit_observed");
    assert.equal(required(state.abort_attempts[0]).exit_code, 0);
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const uninstallerPath = path.join(
      item.session,
      "installer-work",
      "run-fixture",
      "installed",
      "uninstall.exe",
    );
    const cleanupDeadline = Date.now() + 15_000;
    while (existsSync(uninstallerPath) && Date.now() < cleanupDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const resumed = runPowerShell(["-Action", "abort", "-SessionRoot", item.session], {
      env: baseEnvironment,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    assert.equal(state.abort_attempts.length, 1);
    assert.equal(required(state.abort_attempts[0]).status, "exit_observed_cleanup_proven");
  },
);

void test(
  "an observed nonzero abort attempt remains failed and is not relaunched",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const environment = {
      ...process.env,
      PORTCOVE_FIXTURE_FAIL: "1",
      PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
      PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
      PORTCOVE_FIXTURE_UNINSTALL_EXIT: "7",
    };
    assert.notEqual(runPowerShell(prepareArgs(item), { env: environment }).status, 0);
    const first = runPowerShell(["-Action", "abort", "-SessionRoot", item.session], {
      env: environment,
    });
    assert.notEqual(first.status, 0);
    const second = runPowerShell(["-Action", "abort", "-SessionRoot", item.session], {
      env: environment,
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /previous abort attempt exited with code 7/);
    const state = sessionValue(
      JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8")),
    );
    assert.equal(state.abort_attempts.length, 1);
    assert.equal(required(state.abort_attempts[0]).status, "exit_observed");
    assert.equal(required(state.abort_attempts[0]).exit_code, 7);
  },
);

void test(
  "installer evidence waits for a reader and preserves the previous journal on persistent contention",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-journal-contention-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    for (const releaseReader of [true, false]) {
      const evidencePath = path.join(root, `${releaseReader}.json`);
      const runnerPath = path.join(root, `${releaseReader}.ps1`);
      writeFileSync(evidencePath, '{"phase":"previous"}');
      writeFileSync(
        runnerPath,
        `$ErrorActionPreference = "Stop"
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(installerLifecycleTool)}, [ref]$null, [ref]$null)
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Write-InstallerEvidence" }, $true)
if (-not $function) { throw "Missing evidence writer" }
Invoke-Expression $function.Extent.Text
$evidenceFull = ${quote(evidencePath)}
$evidence = [ordered]@{ phase = "previous" }
[Console]::Out.WriteLine("writer-ready")
Write-InstallerEvidence "updated"
`,
      );
      let reader: number | undefined = openSync(evidencePath, "r");
      const runner = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", runnerPath], {
        windowsHide: true,
        timeout: 10_000,
      });
      let output = "",
        errors = "",
        releaseTimer: ReturnType<typeof setTimeout> | undefined;
      runner.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (releaseReader && !releaseTimer && output.includes("writer-ready")) {
          releaseTimer = setTimeout(() => {
            closeSync(required(reader));
            reader = undefined;
          }, 150);
        }
      });
      runner.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      try {
        const closed: unknown = await once(runner, "close");
        const code = array(closed)[0];
        assert.match(output, /writer-ready/);
        if (releaseReader) {
          assert.equal(code, 0, errors);
          assert.equal(object(JSON.parse(readFileSync(evidencePath, "utf8"))).phase, "updated");
          assert.equal(existsSync(`${evidencePath}.next`), false);
        } else {
          assert.notEqual(code, 0);
          assert.match(errors, /Access to the path is denied|being used by another process/);
          assert.equal(object(JSON.parse(readFileSync(evidencePath, "utf8"))).phase, "previous");
          assert.equal(
            object(JSON.parse(readFileSync(`${evidencePath}.next`, "utf8"))).phase,
            "updated",
          );
        }
      } finally {
        clearTimeout(releaseTimer);
        if (reader !== undefined) closeSync(reader);
      }
    }
  },
);

void test(
  "a killed real lifecycle runner leaves readable inner WAL and outer ambiguity fails closed",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    const item = makeFixture(t);
    const failureEnvironment = {
      ...process.env,
      PORTCOVE_FIXTURE_FAIL: "1",
      PORTCOVE_FIXTURE_UNINSTALLER: item.uninstaller,
      PORTCOVE_FIXTURE_UNINSTALLER_HASH: "correct",
    };
    assert.notEqual(runPowerShell(prepareArgs(item), { env: failureEnvironment }).status, 0);
    const sessionPath = path.join(item.session, "session.json");
    const evidencePath = path.join(item.session, "evidence", "installer-lifecycle.json");
    rmSync(evidencePath);
    const ownedSleeper = path.join(item.session, "inputs", "lifecycle-sleeper.exe");
    copyFileSync(item.sleeper, ownedSleeper);
    const ready = path.join(item.root, "sleeper-ready.txt");
    const runner = spawn(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        installerLifecycleTool,
        "-InstallerPath",
        ownedSleeper,
        "-UpgradeFromInstallerPath",
        ownedSleeper,
        "-TestBase",
        path.join(item.session, "installer-work"),
        "-EvidencePath",
        evidencePath,
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PORTCOVE_FIXTURE_SLEEP_MS: "12000",
          PORTCOVE_FIXTURE_READY: ready,
          PORTCOVE_PREFERENCES: path.join(item.session, "state", "preferences.json"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostics = "";
    runner.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
    });
    let evidence: ReturnType<typeof lifecycleValue> | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(evidencePath)) {
        try {
          evidence = lifecycleValue(JSON.parse(readFileSync(evidencePath, "utf8")));
        } catch {
          /* The writer may still be replacing this observation. */
        }
        if (
          evidence?.process_runs?.[0]?.status === "running" &&
          required(required(evidence).process_runs?.[0]).image_observation &&
          existsSync(ready)
        )
          break;
      }
      if (runner.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      evidence?.process_runs?.[0]?.role,
      "predecessor_installer",
      JSON.stringify({ evidence, diagnostics, runner_exit: runner.exitCode }),
    );
    assert.equal(
      required(required(evidence).process_runs?.[0]).status,
      "running",
      JSON.stringify({ evidence, diagnostics, runner_exit: runner.exitCode }),
    );
    assert.equal(
      Number(readFileSync(ready, "utf8")),
      required(required(evidence).process_runs?.[0]).pid,
    );
    assert.equal(
      required(required(evidence).process_runs?.[0]).executable_sha256,
      sha256(ownedSleeper),
    );
    execFileSync("taskkill.exe", ["/PID", String(runner.pid), "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const ambiguous = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /installer_evidence SHA-256 mismatch/);
    const state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    required(state.files.installer_evidence).sha256 = sha256(evidencePath);
    writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`);
    const stillRunning = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.notEqual(stillRunning.status, 0);
    assert.match(stillRunning.stderr, /Owned process is still running/);
    try {
      execFileSync(
        "taskkill.exe",
        ["/PID", String(required(required(evidence).process_runs?.[0]).pid), "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      /* The owned fixture may already have exited. */
    }
  },
);

void test(
  "launch-pending recovery refuses completion when no unique exact process exists",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const sessionPath = path.join(item.session, "session.json");
    const state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    const running = required(state.process_runs[0]);
    try {
      execFileSync("taskkill.exe", ["/PID", String(running.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* The owned fixture may already have exited. */
    }
    running.status = "exit_unobserved";
    const pending = {
      ...running,
      id: "pending-fixture",
      requested_at: new Date().toISOString(),
      status: "launch_pending",
      pid: null,
      start_time: null,
      start_time_filetime: null,
      window_title: null,
      exit_code: null,
      exit_observation: null,
    };
    state.process_runs.push(pending);
    state.active_run_id = pending.id;
    writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`);
    const finish = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
    assert.notEqual(finish.status, 0);
    assert.match(
      finish.stderr,
      /launch-pending run could not be bound to one exact desktop process/,
    );
    assert.equal(object(JSON.parse(readFileSync(sessionPath, "utf8"))).phase, "prepared");
  },
);

void test(
  "launch-pending recovery rejects a matching process started before the request tolerance",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const sessionPath = path.join(item.session, "session.json");
    const state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
    try {
      execFileSync(
        "taskkill.exe",
        ["/PID", String(required(state.process_runs[0]).pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      /* The owned fixture may already have exited. */
    }
    const desktopPath = path.join(item.session, required(state.files.desktop).path);
    const older = spawn(desktopPath, [], {
      windowsHide: true,
      stdio: "ignore",
    });
    try {
      await once(older, "spawn");
      required(state.process_runs[0]).status = "exit_unobserved";
      const futureFiletime = (BigInt(Date.now() + 60_000 + 11644473600000) * 10000n).toString();
      const pending = {
        ...required(state.process_runs[0]),
        id: "future-pending",
        requested_at: new Date(Date.now() + 60_000).toISOString(),
        requested_at_filetime: futureFiletime,
        status: "launch_pending",
        pid: null,
        start_time: null,
        start_time_filetime: null,
        window_title: null,
        exit_code: null,
        exit_observation: null,
      };
      state.process_runs.push(pending);
      state.active_run_id = pending.id;
      writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`);
      const finish = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
      assert.notEqual(finish.status, 0);
      assert.match(finish.stderr, /predates the journaled launch request/);
    } finally {
      try {
        execFileSync("taskkill.exe", ["/PID", String(older.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        /* The owned fixture may already have exited. */
      }
    }
  },
);

for (const faultpoint of [
  "after_snapshot_temp",
  "after_snapshot",
  "after_receipt_temp",
  "after_receipt",
]) {
  void test(
    `finish resumes the same attempt after ${faultpoint}`,
    { skip: process.platform !== "win32", timeout: 180_000 },
    (t) => {
      const item = makeFixture(t);
      const prepared = runPowerShell(prepareArgs(item));
      assert.equal(prepared.status, 0, prepared.stderr);
      const interrupted = runPowerShell(["-Action", "finish", "-SessionRoot", item.session], {
        env: {
          ...process.env,
          PORTCOVE_QUALIFICATION_TEST_FAULTPOINT: faultpoint,
        },
      });
      assert.notEqual(interrupted.status, 0);
      const sessionPath = path.join(item.session, "session.json");
      let state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
      assert.equal(state.phase, "finish_pending");
      const expectedStage =
        faultpoint === "after_snapshot_temp"
          ? "pending"
          : faultpoint === "after_snapshot" || faultpoint === "after_receipt_temp"
            ? "snapshot_written"
            : "receipt_written";
      assert.equal(required(state.finish_attempt).stage, expectedStage);
      const attemptId = required(state.finish_attempt).id;
      const checkpointCount = state.checkpoints.length;
      if (faultpoint === "after_snapshot_temp") {
        const attemptDirectory = path.dirname(
          path.join(item.session, required(state.finish_attempt).snapshot_path),
        );
        const temporary = readdirSync(attemptDirectory).find((name: string) =>
          name.startsWith("pre-finish-session.json.tmp-"),
        );
        assert.ok(temporary);
        writeFileSync(path.join(attemptDirectory, temporary), "partial");
      }
      const resumed = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
      assert.equal(resumed.status, 0, resumed.stderr);
      state = sessionValue(JSON.parse(readFileSync(sessionPath, "utf8")));
      assert.equal(state.phase, "finished");
      assert.equal(required(state.finish_attempt).id, attemptId);
      assert.equal(state.checkpoints.length, checkpointCount);
      assert.equal(required(state.finish_attempt).stage, "complete");
    },
  );
}

void test(
  "generator refuses to overwrite an immutable build record",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const record = buildRecord(JSON.parse(readFileSync(item.record, "utf8")));
    const args = [
      recordTool,
      "--repository",
      item.repository,
      "--installer",
      path.join(item.repository, record.artifacts.installer.relative_path),
      "--cli",
      path.join(item.repository, record.artifacts.cli.relative_path),
      "--desktop",
      path.join(item.repository, record.artifacts.desktop.relative_path),
      "--predecessor",
      path.join(item.repository, record.predecessor.installer.relative_path),
      "--predecessor-version",
      record.predecessor.version,
      "--output",
      item.record,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(sha256(item.record), item.recordHash);
  },
);
