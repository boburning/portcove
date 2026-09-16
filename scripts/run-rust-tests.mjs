import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavyRustTestLock, processTreeMembers } from "./heavy-rust-test-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

function waitForChild(child) {
  let outcome = null;
  const completed = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      outcome = { error };
      reject(error);
    });
    child.once("close", (code) => {
      if (outcome?.error) return;
      outcome = { code: code ?? 1 };
      resolve(outcome.code);
    });
  });
  completed.catch(() => {});
  return { completed, outcome: () => outcome };
}

function terminateWindowsTree(pid, runSync) {
  const terminated = runSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  if (terminated.error)
    throw new Error(`Could not terminate Heavy Rust process tree ${pid}`, {
      cause: terminated.error,
    });
  return terminated.status === 0;
}

async function waitForBoundedExit(observation, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      observation.completed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function signalUnixTree(pid, dependencies) {
  try {
    (dependencies.killProcess ?? process.kill)(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function closeChildTree(child, observation, dependencies, force) {
  const platform = dependencies.platform ?? process.platform;
  const runSync = dependencies.spawnSync ?? spawnSync;
  const waitMilliseconds =
    dependencies.treeWaitMilliseconds === undefined ? 5_000 : dependencies.treeWaitMilliseconds;
  if (platform === "win32") {
    if (!force) {
      await observation.completed.catch(() => {});
      return;
    }
    const signalled = terminateWindowsTree(child.pid, runSync);
    if (signalled) child.kill();
    if (!(await waitForBoundedExit(observation, waitMilliseconds))) {
      const error = new Error(
        `Heavy Rust Job Object supervisor ${child.pid} did not exit; retaining the shared lock`,
      );
      error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
      throw error;
    }
    return;
  }
  if (force && signalUnixTree(child.pid, dependencies)) child.kill();
  await observation.completed.catch(() => {});

  const inspectTree = dependencies.processTreeMembers ?? processTreeMembers;
  const treeRecord = { pid: child.pid, tree_platform: platform };
  const inspectOptions = {
    platform,
    spawnSync: runSync,
    killProcess: dependencies.killProcess ?? process.kill,
  };
  const deadline = Date.now() + waitMilliseconds;
  const pollMilliseconds = dependencies.treePollMilliseconds ?? 50;
  let members = inspectTree(treeRecord, inspectOptions);
  while (members.length > 0) {
    if (platform === "win32") {
      for (const pid of members) terminateWindowsTree(pid, runSync);
    } else {
      signalUnixTree(child.pid, dependencies);
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `Heavy Rust process tree ${child.pid} did not become quiescent; retaining the shared lock`,
      );
      error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
    members = inspectTree(treeRecord, inspectOptions);
  }
}

export async function runRustTests(args, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const runSync = dependencies.spawnSync ?? spawnSync;
  const start = dependencies.spawn ?? spawn;
  const acquireLock = dependencies.acquireLock ?? acquireHeavyRustTestLock;
  const base = path.resolve(
    dependencies.tempRoot ?? environment.RUNNER_TEMP ?? environment.PORTCOVE_TEMP_DIR ?? tmpdir(),
  );
  const directory = mkdtempSync(path.join(base, "portcove-host-tool-fixture-"));
  const relative = path.relative(base, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Fixture escaped its temporary root");
  const platform = dependencies.platform ?? process.platform;
  const executable = path.join(directory, platform === "win32" ? "probe.exe" : "probe");
  const supervisor = path.join(directory, "portcove-process-tree-supervisor.exe");
  const prepareOnly = args.length === 1 && args[0] === "--prepare-only";
  let retained = false;
  let lock = null;
  let releaseLock = true;
  try {
    if (!prepareOnly) {
      lock = await acquireLock({
        workspace: root,
        command: `cargo-nextest nextest run ${args.join(" ")}`,
      });
    }
    const compiled = runSync(
      "rustc",
      [
        "--crate-name",
        "portcove_host_tool_fixture",
        path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
        "-o",
        executable,
      ],
      { stdio: "inherit", windowsHide: true },
    );
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0) throw new Error("Host-tool fixture compilation failed");
    if (prepareOnly) {
      if (!environment.GITHUB_ENV) throw new Error("--prepare-only requires GITHUB_ENV");
      appendFileSync(environment.GITHUB_ENV, `PORTCOVE_HOST_TOOL_FIXTURE=${executable}\n`);
      retained = true; // The runner owns cleanup after all test steps finish.
      return 0;
    }
    if (platform === "win32") {
      const supervisorCompiled = runSync(
        "rustc",
        [
          "--edition=2024",
          "--crate-name",
          "portcove_process_tree_supervisor",
          path.join(root, "scripts/fixtures/windows-process-tree-supervisor.rs.txt"),
          "-o",
          supervisor,
        ],
        { stdio: "inherit", windowsHide: true },
      );
      if (supervisorCompiled.error) throw supervisorCompiled.error;
      if (supervisorCompiled.status !== 0)
        throw new Error("Windows process-tree supervisor compilation failed");
    }
    const command = platform === "win32" ? supervisor : "cargo-nextest";
    const commandArgs =
      platform === "win32"
        ? ["cargo-nextest", "nextest", "run", ...args]
        : ["nextest", "run", ...args];
    const tested = start(command, commandArgs, {
      cwd: root,
      detached: platform !== "win32",
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...environment,
        ...lock.childEnvironment,
        PORTCOVE_HOST_TOOL_FIXTURE: executable,
      },
    });
    const observation = waitForChild(tested);
    const proveQuiescence = async (force) => {
      try {
        await closeChildTree(tested, observation, dependencies, force);
      } catch (error) {
        releaseLock = false;
        throw error;
      }
    };
    let registered;
    try {
      registered = await lock.registerChild(tested, {
        platform: platform === "win32" ? null : platform,
      });
    } catch (error) {
      const finished = observation.outcome();
      if (finished?.error) throw finished.error;
      if (finished && Object.hasOwn(finished, "code")) {
        await proveQuiescence(false);
        return finished.code;
      }
      await proveQuiescence(true);
      throw error;
    }
    if (registered === null) {
      const status = await observation.completed;
      await proveQuiescence(false);
      return status;
    }
    const status = await observation.completed;
    await proveQuiescence(false);
    return status;
  } finally {
    if (lock && releaseLock) await lock.release();
    if (!retained) rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    process.exitCode = await runRustTests(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
