import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mjs";

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
  });
}

function waitForExit(child) {
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
      owner({ pid: 903, identity: "old-wrapper" }, { pid: 904, identity: "old-child" }),
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
    assert.equal(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).token,
      current.owner.token,
    );
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
    await current.registerChild({ pid: 905 });
    const persisted = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    assert.deepEqual(persisted.child, { pid: 905, identity: "nextest-start" });
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
    assert.equal(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).token,
      parent.owner.token,
    );
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
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(changed));
    await assert.rejects(current.release(), /ownership changed/u);
    await writeFile(path.join(lockPath, "owner.json"), "not json");
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

test("bounded wait retries a live owner and reports the configured limit", async () => {
  const { root, lockPath } = await fixture();
  const identities = new Map([[process.pid, "current-process"]]);
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
          waitMilliseconds: 2,
          pollMilliseconds: 1,
          inspectProcessIdentity: identityInspector(identities),
        },
      ),
      /after waiting 2ms/u,
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
