import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRustRunMode, runRustTests } from "./run-rust-tests.mjs";

const testCompilerIdentity = Object.freeze({
  verbose_version: "rustc test",
  sysroot: "test-sysroot",
  environment: [],
});

function supportCacheDoubles() {
  return {
    rustSupportCompilerIdentity: () => testCompilerIdentity,
    prepareSupportArtifact: ({ product, runSync }) => {
      const compiled = runSync("rustc", [product]);
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0)
        throw new Error(
          product === "host-tool-probe"
            ? "Host-tool fixture compilation failed"
            : "Windows process-tree supervisor compilation failed",
        );
      return {
        outcome: "built",
        fingerprint: "a".repeat(64),
        elapsed_ms: 1,
        output: { bytes: 1, sha256: "b".repeat(64) },
      };
    },
  };
}

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

test("runner distinguishes nextest, hosted preparation, and exact guarded commands", () => {
  const union = parseRustRunMode([
    "--impact-union",
    "portcove-core",
    "catalog-contract",
    "definition-delivery",
  ]);
  assert.equal(union.kind, "nextest");
  assert.deepEqual(
    parseRustRunMode([
      "--locked",
      "--impact-union",
      "portcove-core",
      "catalog-contract",
      "definition-delivery",
    ]),
    union,
  );
  assert.equal(union.executable, process.execPath);
  assert.deepEqual(union.args.slice(1), [
    "--run",
    "portcove-core",
    "catalog-contract",
    "definition-delivery",
  ]);
  assert.throws(() => parseRustRunMode(["--impact-union", "portcove-core", "--workspace", "all"]));
  assert.throws(() => parseRustRunMode(["--impact-union", "portcove-core", "catalog-contract"]));
  assert.deepEqual(parseRustRunMode(["--locked", "--workspace"]), {
    kind: "nextest",
    executable: "cargo-nextest",
    args: ["nextest", "run", "--locked", "--workspace"],
    description: "cargo-nextest nextest run --locked --workspace",
  });
  assert.deepEqual(parseRustRunMode(["--prepare-only"]), { kind: "prepare" });
  assert.deepEqual(parseRustRunMode(["--guard-command", "cargo", "check", "--locked"]), {
    kind: "guarded-command",
    executable: "cargo",
    args: ["check", "--locked"],
    description: "cargo check --locked",
  });
  assert.throws(
    () => parseRustRunMode(["--guard-command"]),
    /requires an executable and optional arguments/u,
  );
});

test("guarded command acquires admission before compilation and preserves exact execution", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  let spawnedOptions;
  try {
    const status = await runRustTests(
      ["--guard-command", "cargo", "check", "--locked", "--workspace", "--all-targets"],
      {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "win32",
        environment: { PATH: "fixture-path" },
        spawnSync: (command) => {
          events.push(`compile:${command}`);
          return { status: 0 };
        },
        spawn: (command, args, options) => {
          events.push(`spawn:${path.basename(command)}:${args.join(" ")}`);
          spawnedOptions = options;
          return childProcess(700, 9);
        },
        acquireLock: async (metadata) => {
          events.push(`acquire:${metadata.command}`);
          return {
            childEnvironment: { PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "guard-token" },
            registerChild: async (child) => events.push(`register:${child.pid}`),
            release: async () => events.push("release"),
          };
        },
      },
    );
    assert.equal(status, 9);
    assert.deepEqual(events.slice(0, 2), [
      "acquire:cargo check --locked --workspace --all-targets",
      "compile:rustc",
    ]);
    assert.match(
      events[2],
      /^spawn:portcove-process-tree-supervisor\.exe:.+registered\.gate cargo check --locked --workspace --all-targets$/u,
    );
    assert.deepEqual(events.slice(3), ["register:700", "release"]);
    assert.equal(spawnedOptions.env.PORTCOVE_HOST_TOOL_FIXTURE, undefined);
    assert.equal(spawnedOptions.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN, "guard-token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before its deadline");
}

test("runner holds the lock through nextest and preserves its exit status", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  let spawnedOptions;
  let registeredContainment;
  try {
    const status = await runRustTests(["--package", "portcove-core"], {
      ...supportCacheDoubles(),
      tempRoot,
      platform: "win32",
      environment: { PATH: "fixture-path" },
      spawnSync: (command) => {
        events.push(`compile:${command}`);
        return { status: 0 };
      },
      spawn: (command, args, options) => {
        events.push(`spawn:${path.basename(command)}:${args.join(" ")}`);
        spawnedOptions = options;
        return childProcess(701, 7);
      },
      acquireLock: async (metadata) => {
        events.push(`acquire:${metadata.command}`);
        return {
          childEnvironment: { PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "inherited-token" },
          registerChild: async (child, registration) => {
            registeredContainment = registration.containment;
            events.push(`register:${child.pid}`);
          },
          release: async () => events.push("release"),
        };
      },
    });
    assert.equal(status, 7);
    assert.deepEqual(events.slice(0, 3), [
      "acquire:cargo-nextest nextest run --package portcove-core",
      "compile:rustc",
      "compile:rustc",
    ]);
    assert.match(
      events[3],
      /^spawn:portcove-process-tree-supervisor\.exe:.+registered\.gate cargo-nextest nextest run --package portcove-core$/u,
    );
    assert.deepEqual(events.slice(4), ["register:701", "release"]);
    assert.equal(registeredContainment, "windows-job");
    assert.equal(spawnedOptions.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN, "inherited-token");
    assert.match(spawnedOptions.env.PORTCOVE_HOST_TOOL_FIXTURE, /portcove-host-tool-fixture-/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unix runner launches nextest in a detached process group", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  let spawnedOptions;
  let spawnedCommand;
  let spawnedArgs;
  let registeredContainment;
  let registeredCleanupReceipt;
  try {
    const status = await runRustTests(["--package", "portcove-core"], {
      ...supportCacheDoubles(),
      tempRoot,
      platform: "linux",
      spawnSync: (command) => {
        events.push(`compile:${command}`);
        return { status: 0 };
      },
      spawn: (command, args, options) => {
        spawnedCommand = command;
        spawnedArgs = args;
        spawnedOptions = options;
        return childProcess(708, 0);
      },
      acquireLock: async () => ({
        childEnvironment: {},
        registerChild: async (_child, registration) => {
          registeredContainment = registration.containment;
          registeredCleanupReceipt = registration.cleanupReceipt;
        },
        release: async () => events.push("release"),
      }),
      readUnixSupervisorStatus: () => 0,
      readCleanupReceipt: () => ({ outcome: "quiescent" }),
      killProcess: () => true,
    });
    assert.equal(status, 0);
    assert.deepEqual(events, ["compile:rustc", "release"]);
    assert.equal(spawnedCommand, process.execPath);
    assert.equal(spawnedArgs[0], path.resolve("scripts/rust-test-tree-supervisor.mjs"));
    assert.match(spawnedArgs[1], /registered\.gate$/u);
    assert.match(spawnedArgs[2], /nextest-status\.json$/u);
    assert.match(spawnedArgs[3], /containment-cleanup\.json$/u);
    assert.deepEqual(spawnedArgs.slice(4), [
      "cargo-nextest",
      "nextest",
      "run",
      "--package",
      "portcove-core",
    ]);
    assert.equal(spawnedOptions.detached, true);
    assert.equal(registeredContainment, "unix-watchdog");
    assert.match(registeredCleanupReceipt, /containment-cleanup\.json$/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inherited runner stays inside the recorded outer containment", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let spawned;
  try {
    const status = await runRustTests(["--package", "portcove-core"], {
      ...supportCacheDoubles(),
      tempRoot,
      platform: "linux",
      spawnSync: () => ({ status: 0 }),
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        return childProcess(710, 0);
      },
      acquireLock: async () => ({
        inherited: true,
        childEnvironment: { PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "outer-token" },
        registerChild: async () => assert.fail("inherited execution must not detach or register"),
        release: async () => {},
      }),
    });
    assert.equal(status, 0);
    assert.equal(spawned.command, "cargo-nextest");
    assert.deepEqual(spawned.args, ["nextest", "run", "--package", "portcove-core"]);
    assert.equal(spawned.options.detached, false);
    assert.equal(spawned.options.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN, "outer-token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

for (const [signal, expectedStatus] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`outer runner contains and reports ${signal} cancellation`, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
    const signalTarget = new EventEmitter();
    const events = [];
    let managed;
    try {
      const status = await runRustTests([], {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "linux",
        signalTarget,
        spawnSync: () => ({ status: 0 }),
        spawn: () => {
          managed = childProcess(713, null);
          return managed;
        },
        writeGate: () => queueMicrotask(() => signalTarget.emit(signal)),
        killProcess: (pid, deliveredSignal) => {
          events.push(`kill:${pid}:${deliveredSignal}`);
          queueMicrotask(() => managed.emit("close", 1));
          return true;
        },
        readCleanupReceipt: () => ({ outcome: "quiescent" }),
        acquireLock: async () => ({
          inherited: false,
          childEnvironment: {},
          registerChild: async () => ({ pid: 713 }),
          release: async () => events.push("release"),
        }),
      });
      assert.equal(status, expectedStatus);
      assert.deepEqual(events, ["kill:-713:SIGKILL", "release"]);
      assert.equal(signalTarget.listenerCount("SIGINT"), 0);
      assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

test("cancellation during registration never opens the supervisor gate", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const signalTarget = new EventEmitter();
  const events = [];
  let managed;
  try {
    const status = await runRustTests([], {
      ...supportCacheDoubles(),
      tempRoot,
      platform: "linux",
      signalTarget,
      spawnSync: () => ({ status: 0 }),
      spawn: () => {
        managed = childProcess(714, null);
        return managed;
      },
      writeGate: () => assert.fail("cancelled registration must not open the gate"),
      killProcess: (pid, signal) => {
        events.push(`kill:${pid}:${signal}`);
        queueMicrotask(() => managed.emit("close", 1));
        return true;
      },
      acquireLock: async () => ({
        inherited: false,
        childEnvironment: {},
        registerChild: async () => {
          signalTarget.emit("SIGINT");
          return { pid: 714 };
        },
        release: async () => events.push("release"),
      }),
    });
    assert.equal(status, 130);
    assert.deepEqual(events, ["kill:-714:SIGKILL", "release"]);
    assert.equal(signalTarget.listenerCount("SIGINT"), 0);
    assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner preserves a fast nextest exit when registration observes no live child", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    const status = await runRustTests(["--invalid-fast-option"], {
      ...supportCacheDoubles(),
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
        ...supportCacheDoubles(),
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
        ...supportCacheDoubles(),
        tempRoot,
        platform: "win32",
        spawnSync: (command) => {
          if (command === "taskkill.exe") {
            killed = true;
            queueMicrotask(() => child.emit("close", 1));
          }
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

test("Windows supervisor completion is the positive quiescence boundary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const events = [];
  try {
    const status = await runRustTests([], {
      ...supportCacheDoubles(),
      tempRoot,
      platform: "win32",
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      spawn: () => childProcess(704, 0),
      treePollMilliseconds: 0,
      acquireLock: async () => ({
        childEnvironment: {},
        registerChild: async () => ({ pid: 704 }),
        release: async () => events.push("release"),
      }),
    });
    assert.equal(status, 0);
    assert.deepEqual(events, ["release"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner retains ownership when a Windows supervisor cannot be terminated", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "win32",
        spawnSync: (command) =>
          command === "taskkill.exe"
            ? { status: 1, stdout: "", stderr: "not found" }
            : { status: 0, stdout: "", stderr: "" },
        spawn: () => childProcess(706, null),
        treeWaitMilliseconds: 0,
        treePollMilliseconds: 0,
        acquireLock: async () => ({
          childEnvironment: {},
          registerChild: async () => {
            throw new Error("registration failed");
          },
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

test("runner retains ownership when a published child cannot be stopped after gate failure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "win32",
        spawnSync: (command) =>
          command === "taskkill.exe"
            ? { status: 1, stdout: "", stderr: "not found" }
            : { status: 0, stdout: "", stderr: "" },
        spawn: () => childProcess(709, null),
        writeGate: () => {
          throw new Error("gate publication failed");
        },
        treeWaitMilliseconds: 0,
        acquireLock: async () => ({
          childEnvironment: {},
          registerChild: async () => ({ pid: 709 }),
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

test("runner retains ownership when an exited Unix supervisor has no cleanup receipt", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "linux",
        spawnSync: () => ({ status: 0 }),
        spawn: () => childProcess(711, 1),
        treeWaitMilliseconds: 0,
        acquireLock: async () => ({
          inherited: false,
          childEnvironment: {},
          registerChild: async () => ({ pid: 711 }),
          release: async () => {
            released = true;
          },
        }),
      }),
      /without containment cleanup evidence/u,
    );
    assert.equal(released, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner retains ownership when Unix cleanup reports failure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  let released = false;
  try {
    await assert.rejects(
      runRustTests([], {
        ...supportCacheDoubles(),
        tempRoot,
        platform: "linux",
        spawnSync: () => ({ status: 0 }),
        spawn: () => childProcess(712, 1),
        treeWaitMilliseconds: 0,
        readUnixSupervisorStatus: () => 0,
        readCleanupReceipt: () => ({ outcome: "failed:EPERM" }),
        acquireLock: async () => ({
          inherited: false,
          childEnvironment: {},
          registerChild: async () => ({ pid: 712 }),
          release: async () => {
            released = true;
          },
        }),
      }),
      /did not prove quiescence/u,
    );
    assert.equal(released, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test(
  "Windows Job Object supervisor kills a detached grandchild when its root exits",
  { skip: process.platform !== "win32" },
  async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-job-supervisor-"));
    const supervisor = path.join(tempRoot, "supervisor.exe");
    const gatePath = path.join(tempRoot, "registered.gate");
    const pidFile = path.join(tempRoot, "descendant.pid");
    try {
      const compiled = spawnSync(
        "rustc",
        [
          "--edition=2024",
          "--crate-name",
          "portcove_process_tree_supervisor_test",
          path.resolve("scripts/fixtures/windows-process-tree-supervisor.rs.txt"),
          "-o",
          supervisor,
        ],
        { stdio: "inherit", windowsHide: true },
      );
      assert.equal(compiled.status, 0);
      const rootScript = [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true })',
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
        "child.unref()",
      ].join(";");
      const managed = spawn(supervisor, [gatePath, process.execPath, "-e", rootScript], {
        stdio: "inherit",
        windowsHide: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(pidFile), false, "managed command started before registration gate");
      await writeFile(gatePath, "registered\n");
      const status = await new Promise((resolve, reject) => {
        managed.once("error", reject);
        managed.once("close", (code) => resolve(code));
      });
      assert.equal(status, 0);
      await waitUntil(() => existsSync(pidFile));
      const descendantPid = Number(await readFile(pidFile, "utf8"));
      await waitUntil(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test("prepare-only keeps the hosted fixture behavior without taking the heavy lock", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-runner-"));
  const environmentFile = path.join(tempRoot, "github-env.txt");
  try {
    const status = await runRustTests(["--prepare-only"], {
      ...supportCacheDoubles(),
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
