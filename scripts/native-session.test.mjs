import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../apps/desktop/scripts/native-session.ps1", import.meta.url),
);
const windows = { skip: process.platform !== "win32", timeout: 20_000 };
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

test(
  "native ancestry refuses missing parent timestamps and cyclic metadata",
  windows,
  async () => {
    for (const records of [
      [
        { ...processRecord(100, 0, 10), CreationDate: null },
        processRecord(200, 100, 20),
      ],
      [
        processRecord(100, 0, 10),
        { ...processRecord(200, 100, 20), CreationDate: null },
      ],
      [
        processRecord(100, 0, 10),
        processRecord(200, 300, 20),
        processRecord(300, 200, 20),
      ],
    ]) {
      const result = await inspectProcessGraph(records);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /exactly one owned application/);
    }
  },
);

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
        record.started_filetime = (
          BigInt(record.started_filetime) - 10_000n
        ).toString();
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

test(
  "native process discovery refuses ambiguous application descendants",
  windows,
  async () => {
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
  },
);
