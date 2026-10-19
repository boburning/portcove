import { isRecord } from "./runtime-values.mts";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { acquireOwnedProcessLock } from "./process-lock.mts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-process-lock-"));
  return { root, lockPath: path.join(root, "shared", "roadmap") };
}

void test("generic process locks serialize sibling workspaces and preserve owner identity", async () => {
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
      record(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).command,
      "doctor",
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("a delayed stale reclaimer cannot replace a live successor", async () => {
  const { root, lockPath } = await fixture();
  const ready = path.join(root, "ready");
  const resume = path.join(root, "resume");
  const result = path.join(root, "result.json");
  let worker: ReturnType<typeof spawn> | undefined;
  let winner: Awaited<ReturnType<typeof acquireOwnedProcessLock>> | undefined;
  const waitFor = async (file: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      await delay(5);
    }
    throw new Error(`Lock fixture did not publish ${file}`);
  };
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "stale",
        pid: 999999,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const script = path.join(root, "contender.mjs");
    await writeFile(
      script,
      `
      import { acquireOwnedProcessLock, isProcessAlive } from ${JSON.stringify(new URL("./process-lock.mts", import.meta.url).href)};
      import { existsSync, writeFileSync } from 'node:fs';
      const waiting = new Int32Array(new SharedArrayBuffer(4));
      try {
        const lease = await acquireOwnedProcessLock(${JSON.stringify(lockPath)}, {}, {
          ownerToken: 'delayed',
          isProcessAlive(pid) {
            if (pid !== 999999) return isProcessAlive(pid);
            writeFileSync(${JSON.stringify(ready)}, 'observed-stale');
            const deadline = Date.now() + 15000;
            while (!existsSync(${JSON.stringify(resume)})) {
              if (Date.now() >= deadline) throw new Error('fixture resume timed out');
              Atomics.wait(waiting, 0, 0, 5);
            }
            return false;
          },
        });
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({acquired: true, token: lease.owner.token}));
      } catch (error) {
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({acquired: false, code: error.code, message: error.message}));
      }
    `,
    );
    worker = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<void>((resolve, reject) => {
      worker!.once("error", reject);
      worker!.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Contender exited ${code}`)),
      );
    });
    await waitFor(ready);
    winner = await acquireOwnedProcessLock(lockPath, {}, { ownerToken: "winner" });
    const before = await readFile(path.join(lockPath, "owner.json"), "utf8");
    await writeFile(resume, "resume");
    const observed = record(JSON.parse(await waitFor(result)));
    await exited;
    assert.equal(
      observed.acquired,
      false,
      "the delayed contender must not acquire over the live winner",
    );
    assert.equal(observed.code, "PORTCOVE_RESOURCE_BUSY");
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), before);
    await winner.release();
    winner = undefined;
  } finally {
    worker?.kill();
    await rm(root, { recursive: true, force: true });
  }
});

void test("generic process locks reclaim only valid positively dead owners", async () => {
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

void test("stale recovery rechecks the canonical owner after claiming recovery", async () => {
  const { root, lockPath } = await fixture();
  const successor = JSON.stringify({
    format_version: 1,
    token: "successor",
    pid: process.pid,
    created_at: new Date().toISOString(),
  });
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "stale",
        pid: 999999,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await assert.rejects(
      acquireOwnedProcessLock(
        lockPath,
        {},
        {
          isProcessAlive(pid) {
            if (pid !== 999999) return true;
            renameSync(lockPath, `${lockPath}.prior`);
            mkdirSync(lockPath);
            writeFileSync(path.join(lockPath, "owner.json"), successor);
            return false;
          },
        },
      ),
      { code: "PORTCOVE_RESOURCE_BUSY" },
    );
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), successor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("duplicate lease release is idempotent and cannot affect the next owner", async () => {
  const { root, lockPath } = await fixture();
  try {
    const first = await acquireOwnedProcessLock(lockPath);
    await Promise.all([first.release(), first.release()]);
    const next = await acquireOwnedProcessLock(lockPath);
    const before = await readFile(path.join(lockPath, "owner.json"), "utf8");
    await first.release();
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), before);
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
