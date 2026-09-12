import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireNativeSessionLock } from "./native-session-lock.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-native-lock-"));
  return { root, lockPath: path.join(root, "native-desktop") };
}

test("native lock blocks a live owner and reports its identity", async () => {
  const { root, lockPath } = await fixture();
  try {
    const first = await acquireNativeSessionLock(
      { workspace: "one", profile: "smoke" },
      { lockPath, isProcessAlive: () => true },
    );
    await assert.rejects(
      acquireNativeSessionLock(
        { workspace: "two", profile: "restart" },
        { lockPath, isProcessAlive: () => true },
      ),
      /already owned by PID/,
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native lock reclaims only a positively stale valid owner", async () => {
  const { root, lockPath } = await fixture();
  try {
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "stale",
        pid: 999999,
        created_at: "2026-01-01T00:00:00.000Z",
        workspace: "old",
      }),
    );
    const current = await acquireNativeSessionLock(
      { workspace: "new", scenarios: ["accessibility"] },
      { lockPath, isProcessAlive: () => false },
    );
    assert.equal(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).token,
      current.owner.token,
    );
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native lock refuses unreadable owner metadata", async () => {
  const { root, lockPath } = await fixture();
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), "not json");
    await assert.rejects(
      acquireNativeSessionLock({}, { lockPath, isProcessAlive: () => false }),
      /owner is unreadable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child harness can inherit but cannot forge a runner lock", async () => {
  const { root, lockPath } = await fixture();
  try {
    const runner = await acquireNativeSessionLock({}, { lockPath, isProcessAlive: () => true });
    const inherited = await acquireNativeSessionLock(
      {},
      { lockPath, inheritedToken: runner.owner.token },
    );
    assert.equal(inherited.inherited, true);
    await inherited.release();
    await assert.rejects(
      acquireNativeSessionLock({}, { lockPath, inheritedToken: "wrong" }),
      /does not match/,
    );
    await runner.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
