import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const guardedCommandMarker = "--guard-command";

export function parseRustRunMode(args) {
  if (args[0] === "--locked" && args[1] === "--impact-union") args = args.slice(1);
  if (args.length === 1 && args[0] === "--prepare-only") return { kind: "prepare" };
  if (args[0] === "--impact-union") {
    if (
      args.length < 4 ||
      args.slice(1).some((value) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
    )
      throw new Error("--impact-union requires one package and at least two group IDs");
    return {
      kind: "nextest",
      executable: process.execPath,
      args: [path.join(root, "scripts/rust-test-impact.mjs"), "--run", ...args.slice(1)],
      description: `Rust impact union ${args.slice(1).join(" ")}`,
    };
  }
  if (args[0] === guardedCommandMarker) {
    const executable = args[1];
    if (!executable)
      throw new Error(`${guardedCommandMarker} requires an executable and optional arguments`);
    const commandArgs = args.slice(2);
    return {
      kind: "guarded-command",
      executable,
      args: commandArgs,
      description: [executable, ...commandArgs].join(" "),
    };
  }
  return {
    kind: "nextest",
    executable: "cargo-nextest",
    args: ["nextest", "run", ...args],
    description: `cargo-nextest nextest run ${args.join(" ")}`.trim(),
  };
}

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

function observeCancellation(target) {
  let requestedSignal = null;
  let resolveCancellation;
  const pending = new Promise((resolve) => {
    resolveCancellation = resolve;
  });
  const listeners = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        if (requestedSignal) return;
        requestedSignal = signal;
        resolveCancellation({ signal });
      },
    ]),
  );
  for (const [signal, listener] of listeners) target.once(signal, listener);
  return {
    pending,
    requested: () => requestedSignal,
    dispose: () => {
      for (const [signal, listener] of listeners) target.off(signal, listener);
    },
  };
}

function cancellationExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
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
  if (!force) {
    await observation.completed.catch(() => {});
    return;
  }
  const signalled =
    platform === "win32"
      ? terminateWindowsTree(child.pid, runSync)
      : signalUnixTree(child.pid, dependencies);
  if (!signalled && observation.outcome()) return;
  if (!(await waitForBoundedExit(observation, waitMilliseconds))) {
    const error = new Error(
      `Heavy Rust containment supervisor ${child.pid} did not exit; retaining the shared lock`,
    );
    error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
    throw error;
  }
}

function unixSupervisorStatus(statusPath) {
  try {
    const value = JSON.parse(readFileSync(statusPath, "utf8"));
    if (!Number.isInteger(value.exit_code)) throw new Error("exit_code is not an integer");
    return value.exit_code;
  } catch (error) {
    throw new Error(`Unix Heavy Rust supervisor did not publish a valid result: ${error.message}`, {
      cause: error,
    });
  }
}

async function waitForUnixSupervisorStatus(statusPath, observation, dependencies) {
  const pollMilliseconds = dependencies.treePollMilliseconds ?? 25;
  const readStatus = dependencies.readUnixSupervisorStatus ?? unixSupervisorStatus;
  for (;;) {
    try {
      return readStatus(statusPath);
    } catch (error) {
      if (error.cause?.code !== "ENOENT") throw error;
    }
    const outcome = observation.outcome();
    if (outcome) return readStatus(statusPath);
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
}

function readUnixCleanupReceipt(receiptPath) {
  return JSON.parse(readFileSync(receiptPath, "utf8"));
}

async function waitForUnixCleanupReceipt(receiptPath, dependencies) {
  const waitMilliseconds =
    dependencies.treeWaitMilliseconds === undefined ? 5_000 : dependencies.treeWaitMilliseconds;
  const pollMilliseconds = dependencies.treePollMilliseconds ?? 25;
  const deadline = Date.now() + waitMilliseconds;
  const readReceipt = dependencies.readCleanupReceipt ?? readUnixCleanupReceipt;
  for (;;) {
    try {
      const value = readReceipt(receiptPath);
      if (value?.outcome !== "quiescent")
        throw new Error(
          `Unix Heavy Rust containment cleanup did not prove quiescence: ${value?.outcome ?? "invalid receipt"}`,
        );
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" && error.cause?.code !== "ENOENT") {
        const failure = new Error(
          `Unix Heavy Rust supervisor cleanup evidence is invalid; retaining the shared lock: ${error.message}`,
          { cause: error },
        );
        failure.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
        throw failure;
      }
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        "Unix Heavy Rust supervisor exited without containment cleanup evidence; retaining the shared lock",
      );
      error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
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
  const platform = dependencies.platform ?? process.platform;
  const mode = parseRustRunMode(args);
  const directory = mkdtempSync(path.join(base, "portcove-host-tool-fixture-"));
  const relative = path.relative(base, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Fixture escaped its temporary root");
  const fixtureExecutable = path.join(directory, platform === "win32" ? "probe.exe" : "probe");
  const supervisor = path.join(directory, "portcove-process-tree-supervisor.exe");
  const gatePath = path.join(directory, "registered.gate");
  const statusPath = path.join(directory, "nextest-status.json");
  const cleanupReceiptPath = path.join(directory, "containment-cleanup.json");
  const prepareOnly = mode.kind === "prepare";
  let retained = false;
  let lock = null;
  let releaseLock = true;
  let cancellation = null;
  try {
    if (!prepareOnly) {
      lock = await acquireLock({
        workspace: root,
        command: mode.description,
      });
    }
    if (mode.kind !== "guarded-command") {
      const compiled = runSync(
        "rustc",
        [
          "--crate-name",
          "portcove_host_tool_fixture",
          path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
          "-o",
          fixtureExecutable,
        ],
        { stdio: "inherit", windowsHide: true },
      );
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0) throw new Error("Host-tool fixture compilation failed");
    }
    if (prepareOnly) {
      if (!environment.GITHUB_ENV) throw new Error("--prepare-only requires GITHUB_ENV");
      appendFileSync(environment.GITHUB_ENV, `PORTCOVE_HOST_TOOL_FIXTURE=${fixtureExecutable}\n`);
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
    if (lock.inherited) {
      const nested = start(mode.executable, mode.args, {
        cwd: root,
        detached: false,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...environment,
          ...lock.childEnvironment,
          ...(mode.kind === "nextest" ? { PORTCOVE_HOST_TOOL_FIXTURE: fixtureExecutable } : {}),
        },
      });
      return await waitForChild(nested).completed;
    }
    cancellation = observeCancellation(dependencies.signalTarget ?? process);
    const command = platform === "win32" ? supervisor : process.execPath;
    const commandArgs =
      platform === "win32"
        ? [gatePath, mode.executable, ...mode.args]
        : [
            path.join(root, "scripts/rust-test-tree-supervisor.mjs"),
            gatePath,
            statusPath,
            cleanupReceiptPath,
            mode.executable,
            ...mode.args,
          ];
    const tested = start(command, commandArgs, {
      cwd: root,
      detached: platform !== "win32",
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...environment,
        ...lock.childEnvironment,
        ...(mode.kind === "nextest" ? { PORTCOVE_HOST_TOOL_FIXTURE: fixtureExecutable } : {}),
      },
    });
    const observation = waitForChild(tested);
    let gateOpened = false;
    let cleanupAttempted = false;
    const proveQuiescence = async (force) => {
      cleanupAttempted = true;
      try {
        await closeChildTree(tested, observation, dependencies, force);
        if (platform !== "win32" && gateOpened)
          await waitForUnixCleanupReceipt(cleanupReceiptPath, dependencies);
      } catch (error) {
        releaseLock = false;
        throw error;
      }
    };
    let registered;
    try {
      registered = await lock.registerChild(tested, {
        containment: platform === "win32" ? "windows-job" : "unix-watchdog",
        cleanupReceipt: platform === "win32" ? undefined : cleanupReceiptPath,
      });
    } catch (error) {
      if (cancellation.requested()) {
        await proveQuiescence(true);
        return cancellationExitCode(cancellation.requested());
      }
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
      return cancellation.requested() ? cancellationExitCode(cancellation.requested()) : status;
    }
    if (cancellation.requested()) {
      await proveQuiescence(true);
      return cancellationExitCode(cancellation.requested());
    }
    try {
      (dependencies.writeGate ?? writeFileSync)(gatePath, "registered\n", { flag: "wx" });
      gateOpened = true;
      const completion =
        platform === "win32"
          ? observation.completed
          : waitForUnixSupervisorStatus(statusPath, observation, dependencies);
      const first = await Promise.race([
        completion.then((status) => ({ status })),
        cancellation.pending,
      ]);
      if (first.signal) {
        await proveQuiescence(true);
        return cancellationExitCode(first.signal);
      }
      if (platform === "win32") await proveQuiescence(false);
      else if (!observation.outcome()) await proveQuiescence(true);
      else await waitForUnixCleanupReceipt(cleanupReceiptPath, dependencies);
      return cancellation.requested()
        ? cancellationExitCode(cancellation.requested())
        : first.status;
    } catch (error) {
      if (!cleanupAttempted) {
        if (platform !== "win32" && gateOpened && observation.outcome()) {
          try {
            await waitForUnixCleanupReceipt(cleanupReceiptPath, dependencies);
          } catch (cleanupError) {
            releaseLock = false;
            throw cleanupError;
          }
        } else {
          await proveQuiescence(!observation.outcome());
        }
      }
      throw error;
    }
  } finally {
    cancellation?.dispose();
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
