import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireOwnedProcessLock } from "./process-lock.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-process-lock-"));
  return { root, lockPath: path.join(root, "shared", "roadmap") };
}

test("generic process locks serialize sibling workspaces and preserve owner identity", async () => {
  const { root, lockPath } = await fixture();
  try {
    const first = await acquireOwnedProcessLock(
      lockPath,
      { workspace: "worktree-one", command: "doctor" },
      { label: "Roadmap", isProcessAlive: () => true },
    );
    await assert.rejects(
      acquireOwnedProcessLock(
        lockPath,
        { workspace: "worktree-two", command: "set-many" },
        { label: "Roadmap", isProcessAlive: () => true },
      ),
      /already owned.*worktree-one/,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).command,
      "doctor",
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic process locks reclaim only valid positively dead owners", async () => {
  const { root, lockPath } = await fixture();
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "dead",
        pid: 999999,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const current = await acquireOwnedProcessLock(
      lockPath,
      { workspace: "current" },
      { label: "Roadmap", isProcessAlive: () => false },
    );
    assert.notEqual(current.owner.token, "dead");
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
