import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireHeavyRustTestLock,
  heavyRustLockTiming,
  processTreeMembers,
  readProcessIdentity,
} from "./heavy-rust-test-lock.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-heavy-rust-lock-"));
  return { root, lockPath: path.join(root, "heavy-rust-tests") };
}

function identityInspector(identities) {
  return (pid) => identities.get(pid) ?? null;
}

async function writeOwner(lockPath, owner) {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
}

async function readPersistedOwner(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (!["EISDIR", "EPERM"].includes(error.code)) throw error;
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  }
  try {
    owner.child = JSON.parse(await readFile(`${lockPath}.child-${owner.token}`, "utf8")).child;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return owner;
}

function owner(processRecord, child = null) {
  return {
    format_version: 1,
    token: "existing-token",
    process: processRecord,
    child,
    created_at: "2026-09-15T20:00:00.000Z",
    workspace: "C:/worktree-one",
    command: "cargo nextest run --workspace",
  };
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk) => {
      text += chunk;
      if (!text.includes(expected)) return;
      stream.off("data", onData);
      resolve(text);
    };
    stream.on("data", onData);
    stream.once("error", reject);
    stream.once("end", () => reject(new Error(`stream ended before ${expected}: ${text}`)));
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

test("separate processes cannot enter the same shared-host slot concurrently", async () => {
  const { root, lockPath } = await fixture();
  const moduleUrl = new URL("./heavy-rust-test-lock.mjs", import.meta.url).href;
  const helper = `
    import { acquireHeavyRustTestLock } from ${JSON.stringify(moduleUrl)};
    const lock = await acquireHeavyRustTestLock(
      { workspace: "child-worktree", command: "controlled fixture" },
      { lockPath: ${JSON.stringify(lockPath)}, waitMilliseconds: 0 },
    );
    console.log("LOCK_READY");
    process.stdin.resume();
    process.stdin.once("end", async () => { await lock.release(); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", helper], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = waitForExit(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForLine(child.stdout, "LOCK_READY");
    await assert.rejects(
      acquireHeavyRustTestLock({ workspace: "parent-worktree" }, { lockPath, waitMilliseconds: 0 }),
      /workspace child-worktree.*controlled fixture/u,
    );
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
    const after = await acquireHeavyRustTestLock(
      { workspace: "parent-worktree" },
      { lockPath, waitMilliseconds: 0 },
    );
    await after.release();
  } finally {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("heavy Rust lock blocks a matching live owner with actionable identity", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  try {
    const first = await acquireHeavyRustTestLock(
      { workspace: "one", command: "cargo nextest run --workspace" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    await assert.rejects(
      acquireHeavyRustTestLock(
        { workspace: "two" },
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /owner PID .*workspace one.*cargo nextest run --workspace/u,
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surviving registered child keeps a dead wrapper's lock active", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([
    [process.pid, "current-process"],
    [902, "nextest-start"],
  ]);
  try {
    await writeOwner(
      lockPath,
      owner({ pid: 901, identity: "dead-wrapper" }, { pid: 902, identity: "nextest-start" }),
    );
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /child PID 902/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dead and PID-reused records are reclaimed only when no identity matches", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([
    [process.pid, "current-process"],
    [903, "reused-wrapper"],
    [904, "reused-child"],
  ]);
  try {
    await writeOwner(
      lockPath,
      owner(
        { pid: 903, identity: "old-wrapper" },
        { pid: 904, identity: "old-child", containment: "windows-job" },
      ),
    );
    const current = await acquireHeavyRustTestLock(
      { workspace: "replacement" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    assert.equal(current.owner.workspace, "replacement");
    assert.equal((await readPersistedOwner(lockPath)).token, current.owner.token);
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered child identity is persisted before guarded work continues", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([
    [process.pid, "current-process"],
    [905, "nextest-start"],
  ]);
  try {
    const current = await acquireHeavyRustTestLock(
      {},
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    await current.registerChild({ pid: 905 }, { platform: null });
    const persisted = await readPersistedOwner(lockPath);
    assert.deepEqual(persisted.child, {
      pid: 905,
      identity: "nextest-start",
      process_token: current.owner.process.process_token,
    });
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inherited ownership accepts only the active token and never releases the parent lock", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  try {
    const parent = await acquireHeavyRustTestLock(
      {},
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    const inherited = await acquireHeavyRustTestLock(
      {},
      {
        lockPath,
        inheritedToken: parent.owner.token,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    assert.equal(inherited.inherited, true);
    await inherited.registerChild({ pid: 999 });
    await inherited.release();
    assert.equal((await readPersistedOwner(lockPath)).token, parent.owner.token);
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          inheritedToken: "forged-token",
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /token does not match/u,
    );
    await parent.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release refuses ownership changes and unreadable metadata remains fail closed", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  try {
    const current = await acquireHeavyRustTestLock(
      {},
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    const changed = { ...current.owner, token: "changed-token" };
    await writeFile(lockPath, JSON.stringify(changed));
    await assert.rejects(current.release(), /ownership changed/u);
    await writeFile(lockPath, "not json");
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /owner is unreadable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new lock publication and child replacement remain complete JSON records", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([
    [process.pid, "current-process"],
    [906, "nextest-start"],
  ]);
  try {
    const current = await acquireHeavyRustTestLock(
      { workspace: "atomic-worktree" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    assert.equal((await lstat(lockPath)).isFile(), true);
    assert.equal((await readPersistedOwner(lockPath)).child, null);
    await current.registerChild({ pid: 906 });
    assert.deepEqual((await readPersistedOwner(lockPath)).child, {
      pid: 906,
      identity: "nextest-start",
      process_token: current.owner.process.process_token,
    });
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded wait retries a live owner and reports the configured limit", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  const reports = [];
  try {
    const first = await acquireHeavyRustTestLock(
      {},
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 50,
          pollMilliseconds: 10,
          reportWait: (message) => reports.push(message),
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /after waiting 50ms/u,
    );
    assert.equal(reports.length >= 1, true);
    assert.match(reports[0], /owner PID/u);
    assert.match(reports[0], /queued \d+ms of 50ms/u);
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded wait admits the queued command after the exact owner releases", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  let first;
  let sleeps = 0;
  const reports = [];
  try {
    first = await acquireHeavyRustTestLock(
      { workspace: "first-worktree", command: "cargo check" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    const second = await acquireHeavyRustTestLock(
      { workspace: "second-worktree", command: "cargo clippy" },
      {
        lockPath,
        waitMilliseconds: 100,
        pollMilliseconds: 10,
        reportWait: (message) => reports.push(message),
        inspectProcessIdentity: identityInspector(identities),
        sleep: async () => {
          sleeps += 1;
          await first.release();
          first = null;
        },
      },
    );
    assert.equal(sleeps, 1);
    assert.equal(second.owner.workspace, "second-worktree");
    assert.equal(second.owner.command, "cargo clippy");
    assert.equal(reports.length, 2);
    assert.match(reports[0], /Waiting for the Heavy Rust validation slot/u);
    assert.match(reports[1], /Acquired the Heavy Rust validation slot after \d+ms/u);
    await second.release();
  } finally {
    if (first) await first.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("default admission timing is finite and probes live owners sparsely", () => {
  assert.deepEqual(heavyRustLockTiming, {
    defaultWaitMilliseconds: 3_600_000,
    maximumWaitMilliseconds: 3_600_000,
    defaultPollMilliseconds: 5_000,
    defaultReportIntervalMilliseconds: 30_000,
  });
});

test("admission overrides cannot exceed the maintained finite budget", async () => {
  await assert.rejects(
    acquireHeavyRustTestLock({}, { waitMilliseconds: 3_600_001 }),
    /integer from 0 through 3600000/u,
  );
});

test("live-owner diagnostics use monotonic elapsed intervals instead of every poll", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  const reports = [];
  let elapsed = 0;
  try {
    const first = await acquireHeavyRustTestLock(
      { workspace: "owner", command: "cargo check" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    await assert.rejects(
      acquireHeavyRustTestLock(
        { workspace: "waiter", command: "cargo clippy" },
        {
          lockPath,
          waitMilliseconds: 100,
          pollMilliseconds: 10,
          reportIntervalMilliseconds: 30,
          reportWait: (message) => reports.push(message),
          inspectProcessIdentity: identityInspector(identities),
          now: () => elapsed,
          sleep: async (milliseconds) => {
            elapsed += milliseconds;
          },
        },
      ),
      /after waiting 100ms/u,
    );
    assert.deepEqual(
      reports.map((message) => Number(message.match(/queued (\d+)ms/u)?.[1])),
      [0, 30, 60, 90],
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Darwin identity uses an exact per-process marker instead of a second-resolution start", () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: "node runner PORTCOVE_HEAVY_RUST_PROCESS_TOKEN=exact-marker",
      stderr: "",
    };
  };
  assert.equal(
    readProcessIdentity(907, {
      platform: "darwin",
      processToken: "exact-marker",
      spawnSync,
    }),
    "darwin:907:exact-marker",
  );
  assert.equal(
    readProcessIdentity(907, {
      platform: "darwin",
      processToken: "title-marker",
      spawnSync: () => ({
        status: 0,
        stdout: "portcove-rust:title-marker node runner",
        stderr: "",
      }),
    }),
    "darwin:907:title-marker",
  );
  assert.equal(
    readProcessIdentity(907, {
      platform: "darwin",
      processToken: "different-marker",
      spawnSync,
    }),
    null,
  );
  assert.equal(calls[0].options.timeout, 5_000);
});

test("legacy Darwin start identities remain readable only for lock migration", () => {
  assert.equal(
    readProcessIdentity(909, {
      platform: "darwin",
      spawnSync: () => ({
        status: 0,
        stdout: "Mon Sep 15 21:00:00 2026\n",
        stderr: "",
      }),
    }),
    "darwin:909:Mon Sep 15 21:00:00 2026",
  );
});

test("a surviving recorded process tree blocks after its supervisor exits", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  try {
    await writeOwner(lockPath, {
      ...owner(
        { pid: 910, identity: "dead-wrapper" },
        { pid: 911, identity: "dead-nextest", tree_platform: "win32" },
      ),
    });
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
          inspectProcessTree: () => [912],
        },
      ),
      /child tree PID 911/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unix watchdog cleanup must prove quiescence before a dead lock is reclaimed", async () => {
  const { root, lockPath } = await fixture();
  const receiptPath = path.join(root, "cleanup.json");
  const identities = new Map([[process.pid, "current-process"]]);
  const existing = owner(
    { pid: 915, identity: "dead-wrapper" },
    {
      pid: 916,
      identity: "dead-supervisor",
      containment: "unix-watchdog",
      cleanup_receipt: receiptPath,
    },
  );
  try {
    await writeOwner(lockPath, existing);
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /Unix cleanup pending/u,
    );
    await writeFile(receiptPath, `${JSON.stringify({ outcome: "failed:EPERM" })}\n`);
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /Unix cleanup failed:EPERM/u,
    );
    await writeFile(receiptPath, `${JSON.stringify({ outcome: "quiescent" })}\n`);
    const current = await acquireHeavyRustTestLock(
      { workspace: "replacement" },
      {
        lockPath,
        waitMilliseconds: 0,
        inspectProcessIdentity: identityInspector(identities),
      },
    );
    assert.equal(current.owner.workspace, "replacement");
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous legacy child containment blocks automatic reclamation", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
  try {
    await writeOwner(
      lockPath,
      owner({ pid: 917, identity: "dead-wrapper" }, { pid: 918, identity: "dead-child" }),
    );
    await assert.rejects(
      acquireHeavyRustTestLock(
        {},
        {
          lockPath,
          waitMilliseconds: 0,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /legacy child PID 918/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy Windows descendant metadata blocks automatic reclamation", () => {
  assert.throws(
    () => processTreeMembers({ pid: 913, tree_platform: "win32" }),
    /cannot be reclaimed automatically/u,
  );
});

test("legacy Unix process-group metadata blocks automatic reclamation", () => {
  assert.throws(
    () => processTreeMembers({ pid: 914, tree_platform: "linux" }),
    /cannot be reclaimed automatically/u,
  );
});

test("platform identity probes fail closed on their bounded timeout", () => {
  const error = Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT" });
  assert.throws(
    () =>
      readProcessIdentity(908, {
        platform: "win32",
        spawnSync: () => ({ error, status: null, stdout: "", stderr: "" }),
      }),
    /identity probe timed out/u,
  );
});
