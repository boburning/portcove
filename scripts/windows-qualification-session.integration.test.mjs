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
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./windows-qualification-session.ps1", import.meta.url));
const reportTool = fileURLToPath(new URL("./qualification-report.mjs", import.meta.url));
const recordTool = fileURLToPath(
  new URL("./write-windows-qualification-build.mjs", import.meta.url),
);
const installerLifecycleTool = fileURLToPath(
  new URL("./test-windows-installer.ps1", import.meta.url),
);
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function runPowerShell(args, options = {}) {
  return spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    ...options,
  });
}

let compiledFixtureRoot;
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

function csharpLiteral(value) {
  return `@"${value.replaceAll('"', '""')}"`;
}

function makeInstallerLifecycleFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-installer-lifecycle-"));
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
class Installer { static void Main(string[] args) { if (Environment.GetEnvironmentVariable("PORTCOVE_FIXTURE_HANG_INSTALLER") == "1") Thread.Sleep(60000); string install = null; foreach (var arg in args) if (arg.StartsWith("/D=")) install = arg.Substring(3); if (install == null) Environment.Exit(2); Directory.CreateDirectory(install); File.Copy(${csharpLiteral(desktop)}, Path.Combine(install, "portcove-desktop.exe"), true); File.Copy(${csharpLiteral(uninstaller)}, Path.Combine(install, "uninstall.exe"), true); using (var key = Registry.CurrentUser.CreateSubKey(${csharpLiteral(keyPath)})) { key.SetValue("DisplayName", "Portcove"); key.SetValue("InstallLocation", install); key.SetValue("UninstallString", "\\"" + Path.Combine(install, "uninstall.exe") + "\\""); } } }
`,
  );
  const installer = path.join(root, "installer.exe");
  execFileSync(csc, ["/nologo", `/out:${installer}`, installerSource], {
    windowsHide: true,
  });
  return { root, installer, keyPath };
}

function runInstallerLifecycle(
  item,
  name,
  environment,
  processTimeoutSeconds = "5",
  testFault = "",
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
  return spawnSync("pwsh.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, ...environment },
  });
}

function removeInstallerLifecycleRegistration(item) {
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

test(
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

test(
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
    const delayedEvidence = JSON.parse(
      readFileSync(path.join(item.root, "delayed", "evidence.json"), "utf8"),
    );
    assert.equal(delayedEvidence.phase, "complete");
    assert.equal(delayedEvidence.details.registration_removed, true);
    const childRun = delayedEvidence.process_runs.find(
      (run) => run.role === "candidate_uninstaller_child",
    );
    assert.equal(childRun.status, "exit_observed");
    assert.equal(childRun.exit_code, 0);
    assert.equal(childRun.executable_sha256, delayedEvidence.uninstaller_sha256);

    const hungChild = runInstallerLifecycle(
      item,
      "hung-child",
      { PORTCOVE_FIXTURE_HANG_CHILD: "1" },
      "3",
    );
    assert.notEqual(hungChild.status, 0);
    assert.match(hungChild.stderr, /candidate_uninstaller_child did not exit within 3 seconds/);
    const hungChildEvidence = JSON.parse(
      readFileSync(path.join(item.root, "hung-child", "evidence.json"), "utf8"),
    );
    const timedOutChild = hungChildEvidence.process_runs.find(
      (run) => run.role === "candidate_uninstaller_child",
    );
    assert.equal(timedOutChild.status, "timed_out");
    assert.match(
      timedOutChild.exit_observation,
      /retained parent exit was observed after the termination request/,
    );
    removeInstallerLifecycleRegistration(item);
    assert.equal(
      delayedEvidence.process_runs.find((run) => run.role === "candidate_smoke").close_request
        .accepted,
      true,
    );

    const persistent = runInstallerLifecycle(item, "persistent", {
      PORTCOVE_FIXTURE_KEEP_REGISTRATION: "1",
    });
    assert.notEqual(persistent.status, 0);
    assert.match(persistent.stderr, /Uninstall left registration entries behind/);
    const persistentEvidence = JSON.parse(
      readFileSync(path.join(item.root, "persistent", "evidence.json"), "utf8"),
    );
    assert.equal(persistentEvidence.details.application_present, false);
    assert.equal(persistentEvidence.details.uninstaller_present, false);
    assert.equal(persistentEvidence.details.remaining_registration_paths.length, 1);
    removeInstallerLifecycleRegistration(item);

    const hung = runInstallerLifecycle(
      item,
      "hung",
      { PORTCOVE_FIXTURE_HANG_UNINSTALLER: "1" },
      "1",
    );
    assert.notEqual(hung.status, 0);
    assert.match(hung.stderr, /candidate_uninstaller did not exit within 1 seconds/);
    const hungEvidence = JSON.parse(
      readFileSync(path.join(item.root, "hung", "evidence.json"), "utf8"),
    );
    const uninstallerRun = hungEvidence.process_runs.find(
      (run) => run.role === "candidate_uninstaller",
    );
    assert.equal(uninstallerRun.status, "timed_out");
    assert.match(
      uninstallerRun.exit_observation,
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
    const verificationEvidence = JSON.parse(
      readFileSync(path.join(item.root, "verification", "evidence.json"), "utf8"),
    );
    const installerRun = verificationEvidence.process_runs.find(
      (run) => run.role === "candidate_installer",
    );
    assert.equal(installerRun.status, "verification_failed");
    assert.match(
      installerRun.exit_observation,
      /retained parent exit was observed after the termination request/,
    );
    const task = spawnSync(
      "tasklist.exe",
      ["/FI", `PID eq ${installerRun.pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.doesNotMatch(task.stdout, new RegExp(`"${installerRun.pid}"`));
  },
);

function makeFixture(t) {
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
  copyFileSync(reportTool, path.join(repository, "scripts", "qualification-report.mjs"));
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
  const result = JSON.parse(
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
  );
  return {
    root,
    repository,
    record,
    recordHash: result.sha256,
    session: path.join(root, "session"),
    uninstaller,
    sleeper,
  };
}

function prepareArgs(item, validateOnly = false) {
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

test(
  "build-record validation binds a clean exact checkout, tools, artifacts, and predecessor",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const valid = runPowerShell(prepareArgs(item, true));
    assert.equal(valid.status, 0, valid.stderr);
    const result = JSON.parse(valid.stdout);
    assert.equal(result.validated, true);
    assert.equal(result.build_record_sha256, item.recordHash);
    assert.equal(result.predecessor_version, "0.1.0-alpha.1");
    assert.equal(existsSync(item.session), false);

    writeFileSync(path.join(item.repository, "scripts", "qualification-report.mjs"), "tampered\n", {
      flag: "a",
    });
    const dirty = runPowerShell(prepareArgs(item, true));
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /exact clean checkout/);
  },
);

test(
  "stateful fake packaged session prepares, journals process identity, checkpoints, relaunches, and finishes",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    let state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.phase, "prepared");
    assert.equal(state.process_runs.length, 1);
    assert.equal(state.process_runs[0].status, "running_verified");
    assert.equal(state.checkpoints.length, 1);
    assert.equal(state.checkpoints[0].process_run_id, null);
    assert.equal(state.installer.registration_removed, true);
    assert.ok(state.process_runs[0].pid);
    assert.ok(state.process_runs[0].start_time);
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
    state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.process_runs.length, 2);
    assert.equal(state.process_runs[1].status, "running_verified");
    assert.equal(state.checkpoints.length, 2);
    assert.match(state.checkpoints[1].metadata, /^checkpoints\/0010-/);
    assert.equal(state.checkpoints[1].process_run_id, state.process_runs[0].id);

    const finish = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
    assert.equal(finish.status, 0, finish.stderr);
    state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.phase, "finished");
    assert.equal(state.process_runs.length, 2);
    assert.equal(state.process_runs[1].status, "exit_unobserved");
    assert.equal(state.process_runs[1].exit_code, null);
    assert.equal(state.checkpoints.length, 3);
    assert.equal(state.checkpoints[2].process_run_id, state.process_runs[1].id);
    assert.ok(existsSync(path.join(item.session, state.finish_receipt.path)));
    assert.ok(existsSync(path.join(item.session, state.finish_receipt.pre_finish_session_path)));
    assert.equal(
      sha256(path.join(item.session, state.finish_receipt.pre_finish_session_path)),
      state.finish_receipt.pre_finish_session_sha256,
    );
    const closed = runPowerShell(["-Action", "checkpoint", "-SessionRoot", item.session]);
    assert.notEqual(closed.status, 0);
    assert.match(closed.stderr, /already finished/);
  },
);

test(
  "a checkpoint with changed evidence is rejected before another action",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    const evidencePath = path.join(
      item.session,
      state.checkpoints[0].metadata.replace("checkpoint.json", "evidence.json"),
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

test(
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
    let state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.phase, "prepare_failed");
    const installerEvidence = JSON.parse(
      readFileSync(path.join(item.session, "evidence", "installer-lifecycle.json"), "utf8"),
    );
    assert.equal(installerEvidence.phase, "failed");
    assert.equal(installerEvidence.owned_paths.install_relative, "run-fixture/installed");
    assert.equal(
      state.files.installer_evidence.sha256,
      sha256(path.join(item.session, "evidence", "installer-lifecycle.json")),
    );
    const aborted = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.equal(aborted.status, 0, aborted.stderr);
    state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.phase, "aborted");
    assert.equal(state.abort_cleanup.zero_owned_processes, true);
    assert.equal(state.abort_cleanup.zero_managed_install_files, true);
    assert.equal(state.abort_cleanup.zero_global_registrations, true);
    assert.equal(
      existsSync(
        path.join(item.session, "installer-work", "run-fixture", "installed", "uninstall.exe"),
      ),
      false,
    );
  },
);

for (const mode of ["missing", "wrong"]) {
  test(
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
      const state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
      assert.equal(state.phase, "prepare_failed");
      assert.ok(
        existsSync(
          path.join(item.session, "installer-work", "run-fixture", "installed", "uninstall.exe"),
        ),
      );
    },
  );
}

test(
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
    const state = JSON.parse(readFileSync(sessionPath, "utf8"));
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

test(
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
    const state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.phase, "prepare_failed");
  },
);

test(
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
        stdio: "ignore",
      },
    );
    const exited = once(child, "exit");
    const sessionPath = path.join(item.session, "session.json");
    let state;
    const deadline = Date.now() + 15_000;
    try {
      while (Date.now() < deadline) {
        state = JSON.parse(readFileSync(sessionPath, "utf8"));
        if (state.abort_attempts?.some((attempt) => attempt.status === "running")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(state.abort_attempts.some((attempt) => attempt.status === "running"));
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
    state = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(state.phase, "aborted");
    assert.equal(state.abort_attempts[0].status, "exit_unobserved_cleanup_proven");
  },
);

test(
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
    let state;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = JSON.parse(readFileSync(sessionPath, "utf8"));
      if (state.abort_attempts?.some((attempt) => attempt.status === "exit_observed")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state.abort_attempts[0].status, "exit_observed");
    assert.equal(state.abort_attempts[0].exit_code, 0);
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
    state = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(state.abort_attempts.length, 1);
    assert.equal(state.abort_attempts[0].status, "exit_observed_cleanup_proven");
  },
);

test(
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
    const state = JSON.parse(readFileSync(path.join(item.session, "session.json"), "utf8"));
    assert.equal(state.abort_attempts.length, 1);
    assert.equal(state.abort_attempts[0].status, "exit_observed");
    assert.equal(state.abort_attempts[0].exit_code, 7);
  },
);

test(
  "installer evidence waits for a reader and preserves the previous journal on persistent contention",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-journal-contention-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
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
      let reader = openSync(evidencePath, "r");
      const runner = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", runnerPath], {
        windowsHide: true,
        timeout: 10_000,
      });
      let output = "",
        errors = "",
        releaseTimer;
      runner.stdout.on("data", (chunk) => {
        output += chunk;
        if (releaseReader && !releaseTimer && output.includes("writer-ready")) {
          releaseTimer = setTimeout(() => {
            closeSync(reader);
            reader = undefined;
          }, 150);
        }
      });
      runner.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      try {
        const [code] = await once(runner, "close");
        assert.match(output, /writer-ready/);
        if (releaseReader) {
          assert.equal(code, 0, errors);
          assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).phase, "updated");
          assert.equal(existsSync(`${evidencePath}.next`), false);
        } else {
          assert.notEqual(code, 0);
          assert.match(errors, /Access to the path is denied|being used by another process/);
          assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).phase, "previous");
          assert.equal(JSON.parse(readFileSync(`${evidencePath}.next`, "utf8")).phase, "updated");
        }
      } finally {
        clearTimeout(releaseTimer);
        if (reader !== undefined) closeSync(reader);
      }
    }
  },
);

test(
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
    runner.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8192);
    });
    let evidence;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(evidencePath)) {
        try {
          evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        } catch {
          /* The writer may still be replacing this observation. */
        }
        if (
          evidence?.process_runs?.[0]?.status === "running" &&
          evidence.process_runs[0].image_observation &&
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
      evidence.process_runs[0].status,
      "running",
      JSON.stringify({ evidence, diagnostics, runner_exit: runner.exitCode }),
    );
    assert.equal(Number(readFileSync(ready, "utf8")), evidence.process_runs[0].pid);
    assert.equal(evidence.process_runs[0].executable_sha256, sha256(ownedSleeper));
    execFileSync("taskkill.exe", ["/PID", String(runner.pid), "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const ambiguous = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /installer_evidence SHA-256 mismatch/);
    const state = JSON.parse(readFileSync(sessionPath, "utf8"));
    state.files.installer_evidence.sha256 = sha256(evidencePath);
    writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`);
    const stillRunning = runPowerShell(["-Action", "abort", "-SessionRoot", item.session]);
    assert.notEqual(stillRunning.status, 0);
    assert.match(stillRunning.stderr, /Owned process is still running/);
    try {
      execFileSync("taskkill.exe", ["/PID", String(evidence.process_runs[0].pid), "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* The owned fixture may already have exited. */
    }
  },
);

test(
  "launch-pending recovery refuses completion when no unique exact process exists",
  { skip: process.platform !== "win32", timeout: 180_000 },
  (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const sessionPath = path.join(item.session, "session.json");
    const state = JSON.parse(readFileSync(sessionPath, "utf8"));
    const running = state.process_runs[0];
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
    assert.equal(JSON.parse(readFileSync(sessionPath, "utf8")).phase, "prepared");
  },
);

test(
  "launch-pending recovery rejects a matching process started before the request tolerance",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    const item = makeFixture(t);
    const prepared = runPowerShell(prepareArgs(item));
    assert.equal(prepared.status, 0, prepared.stderr);
    const sessionPath = path.join(item.session, "session.json");
    const state = JSON.parse(readFileSync(sessionPath, "utf8"));
    try {
      execFileSync("taskkill.exe", ["/PID", String(state.process_runs[0].pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* The owned fixture may already have exited. */
    }
    const desktopPath = path.join(item.session, state.files.desktop.path);
    const older = spawn(desktopPath, [], {
      windowsHide: true,
      stdio: "ignore",
    });
    try {
      await once(older, "spawn");
      state.process_runs[0].status = "exit_unobserved";
      const futureFiletime = (BigInt(Date.now() + 60_000 + 11644473600000) * 10000n).toString();
      const pending = {
        ...state.process_runs[0],
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
  test(
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
      let state = JSON.parse(readFileSync(sessionPath, "utf8"));
      assert.equal(state.phase, "finish_pending");
      const expectedStage =
        faultpoint === "after_snapshot_temp"
          ? "pending"
          : faultpoint === "after_snapshot" || faultpoint === "after_receipt_temp"
            ? "snapshot_written"
            : "receipt_written";
      assert.equal(state.finish_attempt.stage, expectedStage);
      const attemptId = state.finish_attempt.id;
      const checkpointCount = state.checkpoints.length;
      if (faultpoint === "after_snapshot_temp") {
        const attemptDirectory = path.dirname(
          path.join(item.session, state.finish_attempt.snapshot_path),
        );
        const temporary = readdirSync(attemptDirectory).find((name) =>
          name.startsWith("pre-finish-session.json.tmp-"),
        );
        assert.ok(temporary);
        writeFileSync(path.join(attemptDirectory, temporary), "partial");
      }
      const resumed = runPowerShell(["-Action", "finish", "-SessionRoot", item.session]);
      assert.equal(resumed.status, 0, resumed.stderr);
      state = JSON.parse(readFileSync(sessionPath, "utf8"));
      assert.equal(state.phase, "finished");
      assert.equal(state.finish_attempt.id, attemptId);
      assert.equal(state.checkpoints.length, checkpointCount);
      assert.equal(state.finish_attempt.stage, "complete");
    },
  );
}

test(
  "generator refuses to overwrite an immutable build record",
  { skip: process.platform !== "win32", timeout: 120_000 },
  (t) => {
    const item = makeFixture(t);
    const record = JSON.parse(readFileSync(item.record, "utf8"));
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
