import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function waitUntil(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before its deadline");
}

test(
  "Unix supervisor gates launch and kills a surviving grandchild after wrapper loss",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-unix-supervisor-"));
    const gatePath = path.join(root, "registered.gate");
    const statusPath = path.join(root, "status.json");
    const startedPath = path.join(root, "started.txt");
    const descendantPath = path.join(root, "descendant.txt");
    const rootScript = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      `writeFileSync(${JSON.stringify(startedPath)}, "started")`,
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid))`,
      "child.unref()",
    ].join(";");
    const supervisor = spawn(
      process.execPath,
      [
        path.resolve("scripts/rust-test-tree-supervisor.mjs"),
        gatePath,
        statusPath,
        process.execPath,
        "-e",
        rootScript,
      ],
      { detached: true, stdio: "ignore" },
    );
    let descendantPid;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(startedPath), false, "managed command started before registration");
      await writeFile(gatePath, "registered\n");
      await waitUntil(() => existsSync(statusPath), 5_000);
      assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), { exit_code: 0 });
      descendantPid = Number(await readFile(descendantPath, "utf8"));
      const outcome = await new Promise((resolve, reject) => {
        supervisor.once("error", reject);
        supervisor.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(outcome.signal, "SIGKILL");
      await waitUntil(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      }, 5_000);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        try {
          process.kill(-supervisor.pid, "SIGKILL");
        } catch {}
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
