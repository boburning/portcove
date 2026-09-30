import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeStartup } from "../apps/desktop/scripts/desktop-startup-observation.mjs";
import { startEmbeddedInstalledSession } from "../apps/desktop/scripts/desktop-windows-embedded-session.mjs";

const script = fileURLToPath(
  new URL("../apps/desktop/scripts/native-session.ps1", import.meta.url),
);
const windows = { skip: process.platform !== "win32", timeout: 20_000 };

test(
  "embedded startup root exit cannot claim cleanup of later descendants",
  { ...windows, timeout: 45_000 },
  async () => {
    const root = await temporaryRoot();
    const marker = path.join(root, "late-child.json");
    const release = path.join(root, "release-late-child");
    let session;
    let descendant;
    try {
      session = await startEmbeddedInstalledSession(process.execPath, root, [
        "-e",
        `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const watchdog=setTimeout(()=>process.exit(2),20000);
const gate=setInterval(()=>{
  if(!fs.existsSync(${JSON.stringify(release)}))return;
  clearInterval(gate);
  clearTimeout(watchdog);
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),12000)'],{stdio:'ignore',windowsHide:true,detached:true});
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));
  child.unref();
  process.exit(0);
},20);`,
      ]);
      // Establish the actual initial inventory before releasing the later
      // descendant. Host/CIM startup speed must not decide this ordering.
      session.startup = session.capture();
      const rootExited = once(session.child, "exit");
      await writeFile(release, "initial snapshot retained");
      let timer;
      try {
        const [code] = await Promise.race([
          rootExited,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Fixture root did not exit after release")),
              5000,
            );
          }),
        ]);
        assert.equal(code, 0);
      } finally {
        clearTimeout(timer);
      }
      await assert.rejects(session.connect());
      descendant = JSON.parse(await readFile(marker, "utf8")).pid;
      const alive = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-Command",
          `$entry=Get-CimInstance Win32_Process -Filter 'ProcessId = ${descendant}'; $entry | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      assert.equal(alive.status, 0, alive.stderr);
      const surviving = JSON.parse(alive.stdout);
      assert.equal(surviving.ProcessId, descendant);
      assert.equal(surviving.ParentProcessId, session.child.pid);
      assert.equal(surviving.ExecutablePath.toLowerCase(), process.execPath.toLowerCase());
      assert.ok(
        !session.startup.processes.some((entry) => entry.pid === descendant),
        "fixture descendant must be created after initial capture",
      );
      await assert.rejects(session.close(), /cleanup is unproven|tree refresh failed/);
    } finally {
      if (session?.child.exitCode === null && session.child.signalCode === null)
        await session.close().catch(() => {});
      // The late fixture child has its own finite lifetime. Wait for it rather
      // than using an unbound PID termination to hide the missing cleanup proof.
      if (!descendant)
        descendant = await readFile(marker, "utf8")
          .then(JSON.parse)
          .then((value) => value.pid)
          .catch(() => null);
      if (descendant) {
        const exited = spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-Command",
            `$p=Get-Process -Id ${descendant} -ErrorAction SilentlyContinue; if($p -and -not $p.WaitForExit(20000)){exit 1}; exit 0`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 25_000 },
        );
        assert.equal(exited.status, 0, exited.stderr);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "embedded installed listener requires the exact direct child and loopback owner",
  { ...windows, timeout: 60_000 },
  async () => {
    const root = await temporaryRoot();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require('node:net');
net.createServer().listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port));});`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const ready = once(child.stdout, "data");
    const foreign = await ownedChild();
    try {
      const [bytes] = await ready;
      const port = Number(String(bytes));
      const sha = createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex");
      const invoke = (mode, target, extra = []) =>
        spawnSync(
          "pwsh",
          ["-NoProfile", "-File", script, "-Mode", mode, "-SnapshotPath", target, ...extra],
          { encoding: "utf8", windowsHide: true, timeout: 15_000 },
        );
      const args = (pid, parent = process.pid, hash = sha) => [
        "-DriverProcessId",
        String(pid),
        "-ApplicationPath",
        process.execPath,
        "-ExpectedParentProcessId",
        String(parent),
        "-ExpectedApplicationSha256",
        hash,
      ];
      const rejected = path.join(root, "rejected.json");
      assert.notEqual(
        invoke("SnapshotApplication", rejected, args(child.pid, foreign.pid)).status,
        0,
      );
      assert.notEqual(
        invoke("SnapshotApplication", rejected, args(child.pid, process.pid, "0".repeat(64)))
          .status,
        0,
      );
      const snapshot = path.join(root, "application.json");
      const captured = invoke("SnapshotApplication", snapshot, args(child.pid));
      assert.equal(captured.status, 0, captured.stderr);
      const identity = JSON.parse(captured.stdout);
      assert.equal(identity.root_kind, "direct-application");
      assert.equal(identity.application_pid, child.pid);
      const listener = invoke("ApplicationListener", snapshot, ["-Port", String(port)]);
      assert.equal(listener.status, 0, listener.stderr);
      assert.equal(JSON.parse(listener.stdout).pid, child.pid);
      const wrong = path.join(root, "foreign.json");
      assert.equal(invoke("SnapshotApplication", wrong, args(foreign.pid)).status, 0);
      const foreignListener = invoke("ApplicationListener", wrong, ["-Port", String(port)]);
      assert.notEqual(foreignListener.status, 0);
      assert.match(foreignListener.stderr, /not exclusively owned/);
      const exited = once(child, "exit");
      const cleanup = invoke("StopApplication", snapshot);
      assert.equal(cleanup.status, 0, cleanup.stderr);
      await exited;
      assert.equal(invoke("Wait", snapshot).status, 0);
      assert.equal(foreign.exitCode, null, "foreign sibling must remain alive");
    } finally {
      await stop(child);
      await stop(foreign);
      await rm(root, { recursive: true, force: true });
    }
  },
);
const run = (mode, snapshot) =>
  spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      script,
      "-Mode",
      mode,
      "-DriverProcessId",
      String(process.pid),
      "-ApplicationPath",
      process.execPath,
      "-SnapshotPath",
      snapshot,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );

async function ownedChild() {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  await once(child.stdout, "data");
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function temporaryRoot() {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "portcove-native-session-"));
  assert.equal(path.dirname(path.resolve(root)), parent);
  assert.ok(path.basename(root).startsWith("portcove-native-session-"));
  return root;
}

function processRecord(id, parent, seconds) {
  return {
    ProcessId: id,
    ParentProcessId: parent,
    CreationDate: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(),
    ExecutablePath: process.execPath,
  };
}

async function inspectProcessGraph(records) {
  const root = await temporaryRoot();
  try {
    const fixture = path.join(root, "graph.ps1");
    const data = path.join(root, "records.json");
    await writeFile(data, JSON.stringify(records));
    await writeFile(
      fixture,
      `param([string]$Helper, [string]$Data, [string]$Application)
$ErrorActionPreference = 'Stop'
$script:records = @(Get-Content -LiteralPath $Data -Raw | ConvertFrom-Json)
foreach ($record in $script:records) {
    if ($null -ne $record.CreationDate) { $record.CreationDate = [DateTime]$record.CreationDate }
}
function Get-CimInstance { $script:records }
. $Helper
$tree = Get-OwnedNativeProcessTree 100 $Application
[pscustomobject]@{application_pid=$tree.application.ProcessId; processes=@($tree.processes.ProcessId)} | ConvertTo-Json -Compress
`,
    );
    return spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        fixture,
        "-Helper",
        path.join(path.dirname(script), "native-process-tree.ps1"),
        "-Data",
        data,
        "-Application",
        process.execPath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "native ancestry rejects a reused driver PID without selecting the old process",
  windows,
  async () => {
    const result = await inspectProcessGraph([
      processRecord(100, 0, 10),
      processRecord(200, 100, 0),
    ]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /exactly one owned application/);
  },
);

test(
  "native ancestry ignores stale parent references beside the real application",
  windows,
  async () => {
    const result = await inspectProcessGraph([
      processRecord(100, 0, 10),
      processRecord(200, 100, 20),
      processRecord(300, 100, 0),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      application_pid: 200,
      processes: [200],
    });
  },
);

test(
  "native ancestry checks each intermediate parent and child creation time",
  windows,
  async () => {
    const broker = {
      ...processRecord(150, 100, 20),
      ExecutablePath: "owned-broker",
    };
    const helper = {
      ...processRecord(201, 200, 40),
      ExecutablePath: "owned-helper",
    };
    const staleHelper = {
      ...processRecord(301, 200, 25),
      ExecutablePath: "old-helper",
    };
    const result = await inspectProcessGraph([
      processRecord(100, 0, 10),
      broker,
      processRecord(200, 150, 30),
      helper,
      processRecord(300, 150, 15),
      staleHelper,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      application_pid: 200,
      processes: [200, 201],
    });
  },
);

test("native ancestry refuses missing parent timestamps and cyclic metadata", windows, async () => {
  for (const records of [
    [{ ...processRecord(100, 0, 10), CreationDate: null }, processRecord(200, 100, 20)],
    [processRecord(100, 0, 10), { ...processRecord(200, 100, 20), CreationDate: null }],
    [processRecord(100, 0, 10), processRecord(200, 300, 20), processRecord(300, 200, 20)],
  ]) {
    const result = await inspectProcessGraph(records);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /exactly one owned application/);
  }
});

test(
  "native ancestry accepts equal timestamps without treating the driver as its own child",
  windows,
  async () => {
    const result = await inspectProcessGraph([
      processRecord(100, 0, 10),
      processRecord(200, 100, 10),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      application_pid: 200,
      processes: [200],
    });
  },
);

test(
  "native shutdown wait is bounded, preserves a live process, and accepts its later exit",
  windows,
  async () => {
    const root = await temporaryRoot();
    const child = await ownedChild();
    try {
      const snapshot = path.join(root, "processes.json");
      const captured = run("Snapshot", snapshot);
      assert.equal(captured.status, 0, captured.stderr);
      assert.equal(JSON.parse(captured.stdout).application_pid, child.pid);
      const start = performance.now();
      const blocked = run("Wait", snapshot);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /five-second bound/);
      assert.ok(performance.now() - start < 9000);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      process.kill(child.pid, 0);
      const recorded = JSON.parse(await readFile(snapshot, "utf8"));
      for (const record of recorded.processes)
        record.started_filetime = (BigInt(record.started_filetime) - 10_000n).toString();
      const stale = path.join(root, "stale.json");
      await writeFile(stale, JSON.stringify(recorded));
      const staleResult = run("Wait", stale);
      assert.equal(
        staleResult.status,
        0,
        `A reused PID must not be treated as the captured process: ${staleResult.stderr}; ${JSON.stringify(recorded)}`,
      );
      process.kill(child.pid, 0);
      await stop(child);
      const ended = run("Wait", snapshot);
      assert.equal(ended.status, 0, ended.stderr);
    } finally {
      await stop(child);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("isolated driver stop refuses stale identity without acting", windows, async () => {
  const root = await temporaryRoot();
  const child = await ownedChild();
  try {
    const snapshot = path.join(root, "processes.json");
    const captured = run("Snapshot", snapshot);
    assert.equal(captured.status, 0, captured.stderr);
    const recorded = JSON.parse(await readFile(snapshot, "utf8"));
    recorded.driver.started_filetime = (
      BigInt(recorded.driver.started_filetime) - 10_000n
    ).toString();
    await writeFile(snapshot, JSON.stringify(recorded));

    const result = run("StopDriver", snapshot);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /driver identity changed before isolated tree termination/);
    process.kill(child.pid, 0);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("native process discovery refuses ambiguous application descendants", windows, async () => {
  const root = await temporaryRoot();
  const children = [await ownedChild(), await ownedChild()];
  try {
    const result = run("Snapshot", path.join(root, "ambiguous.json"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one owned application/);
    for (const child of children) process.kill(child.pid, 0);
  } finally {
    for (const child of children) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "startup inventory error retains a partial trace and fails the observer",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    try {
      const fixture = path.join(output, "inventory-failure.ps1");
      const trace = path.join(output, "trace.jsonl");
      await writeFile(
        fixture,
        `param([string]$Observer, [string]$Image, [string]$Trace, [string]$Profile)
$script:calls = 0
function Get-CimInstance {
    $script:calls++
    if ($script:calls -gt 2) { throw 'synthetic inventory unavailable' }
    [pscustomobject]@{ ProcessId=100; ParentProcessId=0; CreationDate=[DateTime]'2026-01-01'; ExecutablePath=$Image; CommandLine='' }
}
& $Observer -DriverProcessId 100 -DriverPath $Image -ProfilePath $Profile -OutputPath $Trace -StopPath (Join-Path $Profile 'stop') -Samples 3
exit $LASTEXITCODE
`,
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          fixture,
          "-Observer",
          fileURLToPath(
            new URL("../apps/desktop/scripts/native-startup-observation.ps1", import.meta.url),
          ),
          "-Image",
          process.execPath,
          "-Trace",
          trace,
          "-Profile",
          output,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      const records = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.length, 2);
      assert.equal(records[0].driver_identity_present, true);
      assert.match(records[1].inventory_error, /synthetic inventory unavailable/);
      assert.equal(records[1].driver_departed, false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);

test(
  "startup observer retains only owned descendants and missing endpoint evidence",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    const driver = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      { windowsHide: true },
    );
    await once(driver.stdout, "data");
    try {
      const finish = await observeStartup({
        driver,
        driverPath: process.execPath,
        profile: output,
        output,
        attempt: 0,
      });
      const result = await finish();
      assert.equal(result.successful, true);
      const records = (await readFile(result.artifacts[0], "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(records[0].driver_identity_present, true);
      assert.equal(records[0].devtools_active_port_present, false);
      assert.ok(records[0].processes.some((record) => record.pid === driver.pid));
      assert.ok(
        records.every((record) => !record.processes.some((entry) => entry.pid === process.pid)),
      );
      assert.equal(records.at(-1).stop_requested, true);
      assert.equal(driver.exitCode, null, "observer must not terminate the owned driver");
    } finally {
      const exited = once(driver, "exit");
      driver.kill();
      await exited;
      await rm(output, { recursive: true, force: true });
    }
  },
);

test(
  "startup identity mismatch retains error without claiming an empty process inventory",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    try {
      const finish = await observeStartup({
        driver: { pid: process.pid, exitCode: null, signalCode: null },
        driverPath: process.env.ComSpec,
        profile: output,
        output,
        attempt: 0,
      });
      const result = await finish();
      assert.equal(result.successful, false);
      assert.equal(result.artifacts.length, 1);
      assert.match(await readFile(result.artifacts[0], "utf8"), /identity mismatch/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);
