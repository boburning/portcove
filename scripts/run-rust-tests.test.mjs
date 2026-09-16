import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRustTests } from "./run-rust-tests.mjs";

function childProcess(pid, exitCode) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => {
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  if (exitCode !== null) queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

test("runner holds the lock through nextest and preserves its exit status", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  let spawnedOptions;
  try {
    const status = await runRustTests(["--package", "portcove-core"], {
      tempRoot,
      environment: { PATH: "fixture-path" },
      spawnSync: (command) => {
        events.push(`compile:${command}`);
        return { status: 0 };
      },
      spawn: (command, args, options) => {
        events.push(`spawn:${command}:${args.join(" ")}`);
        spawnedOptions = options;
        return childProcess(701, 7);
      },
      acquireLock: async (metadata) => {
        events.push(`acquire:${metadata.command}`);
        return {
          childEnvironment: { PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "inherited-token" },
          registerChild: async (child) => events.push(`register:${child.pid}`),
          release: async () => events.push("release"),
        };
      },
      processTreeMembers: () => [],
    });
    assert.equal(status, 7);
    assert.deepEqual(events, [
      "acquire:cargo-nextest nextest run --package portcove-core",
      "compile:rustc",
      "spawn:cargo-nextest:nextest run --package portcove-core",
      "register:701",
      "release",
    ]);
    assert.equal(spawnedOptions.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN, "inherited-token");
    assert.match(spawnedOptions.env.PORTCOVE_HOST_TOOL_FIXTURE, /portcove-host-tool-fixture-/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner preserves a fast nextest exit when registration observes no live child", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    const status = await runRustTests(["--invalid-fast-option"], {
      tempRoot,
      spawnSync: () => ({ status: 0 }),
      spawn: () => childProcess(703, 42),
      acquireLock: async () => ({
        childEnvironment: {},
        registerChild: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return null;
        },
        release: async () => {
          released = true;
        },
      }),
      processTreeMembers: () => [],
    });
    assert.equal(status, 42);
    assert.equal(released, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compile failure releases the lock and never starts nextest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        tempRoot,
        spawnSync: () => ({ status: 1 }),
        spawn: () => assert.fail("nextest must not start after fixture compilation fails"),
        acquireLock: async () => ({
          childEnvironment: {},
          registerChild: async () => {},
          release: async () => {
            released = true;
          },
        }),
      }),
      /fixture compilation failed/u,
    );
    assert.equal(released, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("child registration failure terminates unguarded nextest and releases ownership", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let child;
  let released = false;
  let killed = false;
  try {
    await assert.rejects(
      runRustTests([], {
        tempRoot,
        spawnSync: (command) => {
          if (command === "taskkill.exe") killed = true;
          return { status: 0, stdout: "", stderr: "" };
        },
        spawn: () => {
          child = childProcess(702, null);
          const originalKill = child.kill;
          child.kill = () => originalKill();
          return child;
        },
        acquireLock: async () => ({
          childEnvironment: {},
          registerChild: async () => {
            throw new Error("registration failed");
          },
          release: async () => {
            released = true;
          },
        }),
        processTreeMembers: () => [],
      }),
      /registration failed/u,
    );
    assert.equal(killed, true);
    assert.equal(released, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner closes surviving descendants before releasing a completed supervisor", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  let inspection = 0;
  try {
    const status = await runRustTests([], {
      tempRoot,
      platform: "win32",
      spawnSync: (command, args) => {
        if (command === "taskkill.exe") events.push(`tree-kill:${args[1]}`);
        return { status: 0, stdout: "", stderr: "" };
      },
      spawn: () => childProcess(704, 0),
      processTreeMembers: () => (inspection++ === 0 ? [705] : []),
      treePollMilliseconds: 0,
      acquireLock: async () => ({
        childEnvironment: {},
        registerChild: async () => ({ pid: 704 }),
        release: async () => events.push("release"),
      }),
    });
    assert.equal(status, 0);
    assert.deepEqual(events, ["tree-kill:705", "release"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner retains ownership when a descendant tree cannot be closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        tempRoot,
        platform: "win32",
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
        spawn: () => childProcess(706, 0),
        processTreeMembers: () => [707],
        treeWaitMilliseconds: 0,
        treePollMilliseconds: 0,
        acquireLock: async () => ({
          childEnvironment: {},
          registerChild: async () => ({ pid: 706 }),
          release: async () => {
            released = true;
          },
        }),
      }),
      /retaining the shared lock/u,
    );
    assert.equal(released, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-only keeps the hosted fixture behavior without taking the heavy lock", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const environmentFile = path.join(tempRoot, "github-env.txt");
  try {
    const status = await runRustTests(["--prepare-only"], {
      tempRoot,
      environment: { GITHUB_ENV: environmentFile },
      spawnSync: () => ({ status: 0 }),
      spawn: () => assert.fail("prepare-only must not start nextest"),
      acquireLock: async () => assert.fail("prepare-only must not take the heavy lock"),
    });
    assert.equal(status, 0);
    assert.match(await readFile(environmentFile, "utf8"), /^PORTCOVE_HOST_TOOL_FIXTURE=.+/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
