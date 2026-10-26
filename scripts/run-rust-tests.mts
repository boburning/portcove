import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import type {
  CompilerRunner,
  CompilerIdentity,
  RustSupportOptions,
} from "./rust-support-cache.mts";
import type { HeavyRustLockOptions, HeavyRustLock } from "./heavy-rust-test-lock.mts";
import type {
  ResourceMetadata,
  ResourceCapacityOptions,
  ResourceLease,
} from "./resource-capacity.mts";
export type RustRunMode =
  | { kind: "prepare" }
  | {
      kind: "nextest" | "guarded-command";
      executable: string;
      args: string[];
      description: string;
    };
type ChildOutcome = { error: Error; code?: never } | { code: number; error?: never };
interface ChildObservation {
  completed: Promise<number>;
  outcome: () => ChildOutcome | null;
}
interface Cancellation {
  pending: Promise<{ signal: string }>;
  signal: AbortSignal;
  requested: () => string | null;
  dispose: () => void;
}
export interface ManagedRustChild extends Pick<EventEmitter, "once"> {
  pid?: number | undefined;
  stdin?: ChildProcess["stdin"];
}
export interface RustAdmission {
  inherited?: boolean;
  childEnvironment: NodeJS.ProcessEnv;
  registerChild: (
    child: { pid?: number | undefined },
    registration: import("./heavy-rust-test-lock.mts").ChildRegistration,
  ) => Promise<unknown>;
  release: () => Promise<unknown>;
}
type RustResources = ResourceLease | HeavyRustLock;
export interface RustResourceOptions extends ResourceCapacityOptions, HeavyRustLockOptions {}
export interface RustRunDependencies {
  /** Payload budget starts at the registered launch gate, excluding admission/setup. */
  executionTimeoutMilliseconds?: number;
  onExecutionTimeout?: (milliseconds: number) => void;
  output?: { stdout: number; stderr: number };
  environment?: NodeJS.ProcessEnv;
  metrics?: ReturnType<typeof createCiMetrics>;
  spawnSync?: CompilerRunner;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ManagedRustChild;
  acquireLock?: (
    metadata: ResourceMetadata,
    options: RustResourceOptions,
  ) => Promise<RustAdmission>;
  prepareSupportArtifact?: (
    options: RustSupportOptions,
  ) => Pick<
    ReturnType<typeof prepareRustSupportArtifact>,
    "outcome" | "fingerprint" | "elapsed_ms"
  >;
  rustSupportCompilerIdentity?: typeof rustSupportCompilerIdentity;
  tempRoot?: string;
  platform?: string;
  architecture?: string;
  cwd?: string;
  signalTarget?: Pick<EventEmitter, "once" | "off">;
  treeWaitMilliseconds?: number;
  treePollMilliseconds?: number;
  killProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
  closeLinuxControl?: (child: ManagedRustChild) => unknown;
  readLinuxSupervisor?: (file: string, child: ManagedRustChild) => { pid: number };
  readUnixSupervisorStatus?: (file: string) => number;
  readCleanupReceipt?: (file: string) => unknown;
  writeGate?: typeof writeFileSync;
}
function causeCode(value: unknown) {
  return isRecord(value) ? errorCode(value.cause) : undefined;
}
function diagnosticText(value: unknown) {
  return String(value);
}
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { acquireSourceBoundCapacity, frontendOutputResource } from "./resource-capacity.mts";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavyRustTestLock, readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { prepareRustSupportArtifact, rustSupportCompilerIdentity } from "./rust-support-cache.mts";
import { createCiMetrics } from "./ci-metrics.mts";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const guardedCommandMarker = "--guard-command";

export function parseRustRunMode(args: string[]): RustRunMode {
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
      args: [path.join(root, "scripts/rust-test-impact.mts"), "--run", ...args.slice(1)],
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
    executable: process.execPath,
    args: [path.join(root, "scripts/nextest-outcomes-cli.mts"), "--run", ...args],
    description: `cargo-nextest nextest run ${args.join(" ")}`.trim(),
  };
}

function waitForChild(child: ManagedRustChild): ChildObservation {
  let outcome: ChildOutcome | null = null;
  const completed = new Promise<number>((resolve, reject) => {
    child.once("error", (error: Error) => {
      outcome = { error };
      reject(error);
    });
    child.once("close", (code: number | null) => {
      if (outcome?.error) return;
      outcome = { code: code ?? 1 };
      resolve(outcome.code);
    });
  });
  void completed.catch(() => {});
  return { completed, outcome: () => outcome };
}

function observeCancellation(target: Pick<EventEmitter, "once" | "off">): Cancellation {
  let requestedSignal: string | null = null;
  const abort = new AbortController();
  let resolveCancellation: (value: { signal: string }) => void = () => {
    throw new Error("Cancellation promise is not initialized");
  };
  const pending = new Promise<{ signal: string }>((resolve) => {
    resolveCancellation = resolve;
  });
  const listeners = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        if (requestedSignal) return;
        requestedSignal = signal;
        abort.abort();
        resolveCancellation({ signal });
      },
    ]),
  );
  for (const [signal, listener] of listeners) target.once(signal, listener);
  return {
    pending,
    signal: abort.signal,
    requested: () => requestedSignal,
    dispose: () => {
      for (const [signal, listener] of listeners) target.off(signal, listener);
    },
  };
}

function cancellationExitCode(signal: string | null) {
  return signal === "SIGINT" ? 130 : 143;
}

function terminateWindowsTree(pid: number | undefined, runSync: CompilerRunner) {
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

async function waitForBoundedExit(observation: ChildObservation, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation.completed.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function signalUnixTree(pid: number | undefined, dependencies: RustRunDependencies) {
  try {
    if (pid === undefined) throw new Error("Cannot signal an unregistered child process");
    if (dependencies.killProcess) dependencies.killProcess(-pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

async function closeChildTree(
  child: ManagedRustChild,
  observation: ChildObservation,
  dependencies: RustRunDependencies,
  force: boolean,
) {
  const platform = dependencies.platform ?? process.platform;
  const runSync = dependencies.spawnSync ?? spawnSync;
  const waitMilliseconds =
    dependencies.treeWaitMilliseconds === undefined ? 5_000 : dependencies.treeWaitMilliseconds;
  if (platform === "linux") {
    // The direct child is the adopting reaper, not the registered payload group.
    // Pipe loss asks that ancestor to close only its own anchored Node group.
    if (force && !observation.outcome()) {
      await (
        dependencies.closeLinuxControl ??
        ((managed) =>
          new Promise<void>((resolve, reject) => {
            if (!managed.stdin) throw new Error("Linux reaper has no control pipe");
            managed.stdin.once("error", reject);
            managed.stdin.end(resolve);
          }))
      )(child);
    }
    if (!(await waitForBoundedExit(observation, waitMilliseconds))) {
      const error = new Error(
        "Linux Heavy Rust reaper did not exit; retaining the shared lock",
      ) as NodeJS.ErrnoException;
      error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
      throw error;
    }
    return;
  }
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
    const error: NodeJS.ErrnoException = new Error(
      `Heavy Rust containment supervisor ${child.pid} did not exit; retaining the shared lock`,
    );
    error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
    throw error;
  }
}

export function inspectLinuxSupervisor(
  value: unknown,
  reaperPid: number | undefined,
  read: (file: string, encoding: "utf8") => string = readFileSync,
) {
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    typeof value.identity !== "string"
  )
    throw new Error("Linux Heavy Rust registration handshake is malformed");
  const stat = read(`/proc/${value.pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  if (
    stat.lastIndexOf(")") < 0 ||
    !["R", "S", "D", "T", "t", "I", "W"].some((state) => state === fields[0]) ||
    Number(fields[1]) !== reaperPid ||
    Number(fields[2]) !== value.pid ||
    readProcessIdentity(value.pid, { platform: "linux", readFileSync: read }) !== value.identity
  )
    throw new Error("Linux Heavy Rust registration identity, parent or group does not match");
  return { pid: value.pid };
}

async function waitForLinuxSupervisor(
  registrationPath: string,
  child: ManagedRustChild,
  observation: ChildObservation,
  cancellation: Cancellation,
  dependencies: RustRunDependencies,
) {
  const deadline = Date.now() + 5_000;
  const inspect =
    dependencies.readLinuxSupervisor ??
    ((file, managed) =>
      inspectLinuxSupervisor(JSON.parse(readFileSync(file, "utf8")), managed.pid));
  for (;;) {
    if (cancellation.requested()) throw new Error("Linux Heavy Rust registration cancelled");
    try {
      const registered = inspect(registrationPath, child);
      if (observation.outcome())
        throw new Error("Linux Heavy Rust reaper exited during registration");
      return registered;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (observation.outcome() || Date.now() >= deadline)
        throw new Error("Linux Heavy Rust reaper did not publish its gated supervisor identity", {
          cause: error,
        });
    }
    await new Promise((resolve) => setTimeout(resolve, dependencies.treePollMilliseconds ?? 25));
  }
}

function unixSupervisorStatus(statusPath: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
    if (
      !isRecord(value) ||
      typeof value.exit_code !== "number" ||
      !Number.isInteger(value.exit_code)
    )
      throw new Error("exit_code is not an integer");
    return value.exit_code;
  } catch (error) {
    throw new Error(
      `Unix Heavy Rust supervisor did not publish a valid result: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function waitForUnixSupervisorStatus(
  statusPath: string,
  observation: ChildObservation,
  dependencies: RustRunDependencies,
) {
  const pollMilliseconds = dependencies.treePollMilliseconds ?? 25;
  const readStatus = dependencies.readUnixSupervisorStatus ?? unixSupervisorStatus;
  for (;;) {
    try {
      return readStatus(statusPath);
    } catch (error) {
      if (causeCode(error) !== "ENOENT") throw error;
    }
    const outcome = observation.outcome();
    if (outcome) return readStatus(statusPath);
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
}

function readUnixCleanupReceipt(receiptPath: string): unknown {
  return JSON.parse(readFileSync(receiptPath, "utf8"));
}

async function waitForUnixCleanupReceipt(receiptPath: string, dependencies: RustRunDependencies) {
  const waitMilliseconds =
    dependencies.treeWaitMilliseconds === undefined ? 5_000 : dependencies.treeWaitMilliseconds;
  const pollMilliseconds = dependencies.treePollMilliseconds ?? 25;
  const deadline = Date.now() + waitMilliseconds;
  const readReceipt = dependencies.readCleanupReceipt ?? readUnixCleanupReceipt;
  for (;;) {
    try {
      const value = readReceipt(receiptPath);
      if (!isRecord(value) || value.outcome !== "quiescent")
        throw new Error(
          `Unix Heavy Rust containment cleanup did not prove quiescence: ${diagnosticText(isRecord(value) ? (value.outcome ?? "invalid receipt") : "invalid receipt")}`,
        );
      return value;
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && causeCode(error) !== "ENOENT") {
        const failure: NodeJS.ErrnoException = new Error(
          `Unix Heavy Rust supervisor cleanup evidence is invalid; retaining the shared lock: ${errorMessage(error)}`,
          { cause: error },
        );
        failure.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
        throw failure;
      }
    }
    if (Date.now() >= deadline) {
      const error: NodeJS.ErrnoException = new Error(
        "Unix Heavy Rust supervisor exited without containment cleanup evidence; retaining the shared lock",
      );
      error.code = "PORTCOVE_HEAVY_RUST_TREE_ACTIVE";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
}

export async function acquireRustResources(
  metadata: ResourceMetadata,
  options: RustResourceOptions = {},
): Promise<RustResources> {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1")
    return acquireHeavyRustTestLock(metadata, options);
  const capacity = await acquireSourceBoundCapacity("rust", metadata, {
    ...options,
    environment,
    exclusive: [
      ...(options.exclusive ?? []),
      frontendOutputResource(
        path.resolve(
          metadata.cwd ?? root,
          environment.CARGO_TARGET_DIR ?? path.join(root, "target"),
        ),
      ),
    ],
  });
  const jobs = Number(environment.CARGO_BUILD_JOBS);
  return {
    ...capacity,
    childEnvironment: {
      ...capacity.childEnvironment,
      CARGO_BUILD_JOBS: String(Number.isInteger(jobs) && jobs > 0 ? Math.min(jobs, 2) : 2),
    },
  };
}

export async function runRustTests(
  args: string[],
  dependencies: RustRunDependencies = {},
): Promise<number> {
  const executionBudget = dependencies.executionTimeoutMilliseconds;
  if (
    executionBudget !== undefined &&
    (!Number.isSafeInteger(executionBudget) || executionBudget < 1 || executionBudget > 86_400_000)
  )
    throw new Error("Execution timeout must be an integer from 1 to 86400000 milliseconds");
  const environment = dependencies.environment ?? process.env;
  const metrics = dependencies.metrics ?? createCiMetrics({ environment });
  const runSync = dependencies.spawnSync ?? spawnSync;
  const start = dependencies.spawn ?? spawn;
  const acquireLock = dependencies.acquireLock ?? acquireRustResources;
  const prepareSupport = dependencies.prepareSupportArtifact ?? prepareRustSupportArtifact;
  const readCompilerIdentity =
    dependencies.rustSupportCompilerIdentity ?? rustSupportCompilerIdentity;
  const base = path.resolve(
    dependencies.tempRoot ?? environment.RUNNER_TEMP ?? environment.PORTCOVE_TEMP_DIR ?? tmpdir(),
  );
  const platform = dependencies.platform ?? process.platform;
  const mode = parseRustRunMode(args);
  const executionRoot = dependencies.cwd ?? root;
  const directory = mkdtempSync(path.join(base, "portcove-host-tool-fixture-"));
  const relative = path.relative(base, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Fixture escaped its temporary root");
  const fixtureExecutable = path.join(directory, platform === "win32" ? "probe.exe" : "probe");
  const supervisor = path.join(directory, "portcove-process-tree-supervisor.exe");
  const linuxReaper = path.join(directory, "portcove-linux-process-tree-reaper");
  const registrationPath = path.join(directory, "linux-supervisor.json");
  const gatePath = path.join(directory, "registered.gate");
  const statusPath = path.join(directory, "nextest-status.json");
  const cleanupReceiptPath = path.join(directory, "containment-cleanup.json");
  const prepareOnly = mode.kind === "prepare";
  let retained = false;
  let lock: RustAdmission | null = null;
  let releaseLock = true;
  let cancellation: Cancellation | null = null;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let compiler: CompilerIdentity | null = null;
  const prepareSupportProduct = (
    definition: Pick<RustSupportOptions, "product" | "source" | "output" | "rustcArgs">,
  ) => {
    compiler ??= metrics.measure("compiler-identity", () =>
      readCompilerIdentity({ runSync, environment, platform }),
    );
    const activeCompiler = compiler;
    const result = metrics.measure(`support-setup:${definition.product}`, () =>
      prepareSupport({
        root,
        environment,
        platform,
        architecture: dependencies.architecture ?? process.arch,
        runSync,
        compiler: activeCompiler,
        ...definition,
      }),
    );
    metrics.record(`support-cache:${definition.product}`, {
      cache_outcome: result.outcome,
      fingerprint: result.fingerprint,
      elapsed_ms: result.elapsed_ms,
    });
    console.error(
      `[rust-support] ${definition.product} ${result.outcome} ` +
        `${result.fingerprint.slice(0, 12)} in ${result.elapsed_ms}ms`,
    );
  };
  try {
    cancellation = observeCancellation(dependencies.signalTarget ?? process);
    const activeCancellation = cancellation;
    if (!prepareOnly) {
      lock = await metrics.measureAsync("rust-reservation-wait", () =>
        acquireLock(
          { workspace: root, cwd: executionRoot, command: mode.description },
          { signal: activeCancellation.signal },
        ),
      );
    }
    if (
      lock?.inherited &&
      platform !== "win32" &&
      platform !== "linux" &&
      (executionBudget !== undefined || dependencies.output)
    )
      throw new Error("Bounded inherited process custody is unavailable on this Unix platform");
    if (mode.kind !== "guarded-command") {
      prepareSupportProduct({
        product: "host-tool-probe",
        source: "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
        output: fixtureExecutable,
        rustcArgs: ["--edition=2024", "--crate-name", "portcove_host_tool_fixture"],
      });
    }
    if (prepareOnly) {
      if (!environment.GITHUB_ENV) throw new Error("--prepare-only requires GITHUB_ENV");
      appendFileSync(environment.GITHUB_ENV, `PORTCOVE_HOST_TOOL_FIXTURE=${fixtureExecutable}\n`);
      retained = true; // The runner owns cleanup after all test steps finish.
      return 0;
    }
    if (!lock) throw new Error("Rust execution requires an acquired reservation");
    if (
      platform === "win32" &&
      (!lock.inherited || executionBudget !== undefined || dependencies.output)
    ) {
      prepareSupportProduct({
        product: "windows-process-tree-supervisor",
        source: "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
        output: supervisor,
        rustcArgs: ["--edition=2024", "--crate-name", "portcove_process_tree_supervisor"],
      });
    }
    if (lock.inherited && executionBudget === undefined && !dependencies.output) {
      const nested = start(mode.executable, mode.args, {
        cwd: executionRoot,
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
    if (platform === "linux") {
      prepareSupportProduct({
        product: "linux-process-tree-reaper",
        source: "scripts/fixtures/linux-process-tree-reaper.rs.txt",
        output: linuxReaper,
        rustcArgs: ["--edition=2024", "--crate-name", "portcove_linux_process_tree_reaper"],
      });
    }
    const command =
      platform === "win32" ? supervisor : platform === "linux" ? linuxReaper : process.execPath;
    const commandArgs =
      platform === "win32"
        ? [gatePath, mode.executable, ...mode.args]
        : platform === "linux"
          ? [
              gatePath,
              statusPath,
              cleanupReceiptPath,
              registrationPath,
              requiredProcessIdentity(),
              process.execPath,
              path.join(root, "scripts/rust-test-tree-supervisor.mts"),
              mode.executable,
              ...mode.args,
            ]
          : [
              path.join(root, "scripts/rust-test-tree-supervisor.mts"),
              gatePath,
              statusPath,
              cleanupReceiptPath,
              mode.executable,
              ...mode.args,
            ];
    const tested = start(command, commandArgs, {
      cwd: executionRoot,
      detached: platform !== "win32" && platform !== "linux",
      stdio: dependencies.output
        ? [
            platform === "linux" ? "pipe" : "ignore",
            dependencies.output.stdout,
            dependencies.output.stderr,
          ]
        : platform === "linux"
          ? ["pipe", "inherit", "inherit"]
          : "inherit",
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
    const proveQuiescence = async (force: boolean) => {
      cleanupAttempted = true;
      try {
        await closeChildTree(tested, observation, dependencies, force);
        if (platform === "linux" || (platform !== "win32" && gateOpened))
          await waitForUnixCleanupReceipt(cleanupReceiptPath, dependencies);
        if (
          platform === "linux" &&
          (observation.outcome()?.error || observation.outcome()?.code !== 0)
        )
          throw new Error(
            "Linux Heavy Rust reaper failed after cleanup; retaining the shared lock",
          );
      } catch (error) {
        releaseLock = false;
        throw error;
      }
    };
    let registered;
    try {
      const registrationChild =
        platform === "linux"
          ? await waitForLinuxSupervisor(
              registrationPath,
              tested,
              observation,
              cancellation,
              dependencies,
            )
          : tested;
      registered = await lock.registerChild(registrationChild, {
        containment: platform === "win32" ? "windows-job" : "unix-watchdog",
        cleanupReceipt: platform === "win32" ? undefined : cleanupReceiptPath,
      });
    } catch (error) {
      if (cancellation.requested()) {
        await proveQuiescence(true);
        return cancellationExitCode(cancellation.requested());
      }
      if (platform === "linux") releaseLock = false;
      const finished = observation.outcome();
      if (finished?.error) throw finished.error;
      if (finished && Object.hasOwn(finished, "code")) {
        await proveQuiescence(false);
        if (platform === "linux") throw error;
        return finished.code;
      }
      await proveQuiescence(true);
      throw error;
    }
    if (registered === null) {
      const status = await observation.completed;
      await proveQuiescence(false);
      if (platform === "linux") {
        releaseLock = false;
        throw new Error("Linux Heavy Rust supervisor exited before registered payload admission");
      }
      return cancellation.requested() ? cancellationExitCode(cancellation.requested()) : status;
    }
    if (cancellation.requested()) {
      await proveQuiescence(true);
      return cancellationExitCode(cancellation.requested());
    }
    try {
      const deadline =
        executionBudget === undefined
          ? []
          : [
              new Promise<{ timedOut: number }>((resolve) => {
                executionTimer = setTimeout(
                  () => resolve({ timedOut: executionBudget }),
                  executionBudget,
                );
              }),
            ];
      (dependencies.writeGate ?? writeFileSync)(gatePath, "registered\n", { flag: "wx" });
      gateOpened = true;
      const completion =
        platform === "win32"
          ? observation.completed
          : waitForUnixSupervisorStatus(statusPath, observation, dependencies);
      const first = await Promise.race([
        completion.then((status) => ({ status })),
        cancellation.pending,
        ...deadline,
      ]);
      if ("timedOut" in first) {
        metrics.record("execution-timeout", { outcome: "failed", elapsed_ms: first.timedOut });
        console.error(
          `[resource] payload exceeded its ${first.timedOut}ms execution budget; proving owned-tree exit`,
        );
        try {
          dependencies.onExecutionTimeout?.(first.timedOut);
        } catch (error) {
          console.error(`Execution timeout observation failed: ${errorMessage(error)}`);
        }
        await proveQuiescence(true);
        return 124;
      }
      if ("signal" in first) {
        await proveQuiescence(true);
        return cancellationExitCode(first.signal);
      }
      if (platform === "linux") await proveQuiescence(!observation.outcome());
      else if (platform === "win32") await proveQuiescence(false);
      else if (!observation.outcome()) await proveQuiescence(true);
      else await waitForUnixCleanupReceipt(cleanupReceiptPath, dependencies);
      return cancellation.requested()
        ? cancellationExitCode(cancellation.requested())
        : first.status;
    } catch (error) {
      if (!cleanupAttempted) {
        if (platform !== "linux" && platform !== "win32" && gateOpened && observation.outcome()) {
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
  } catch (error) {
    if (!lock && cancellation?.requested()) return cancellationExitCode(cancellation.requested());
    throw error;
  } finally {
    cancellation?.dispose();
    if (executionTimer) clearTimeout(executionTimer);
    if (lock && releaseLock) await lock.release();
    if (!retained && releaseLock) rmSync(directory, { recursive: true, force: true });
  }
}

function requiredProcessIdentity(): string {
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish current process identity");
  return identity;
}

async function main() {
  try {
    process.exitCode = await runRustTests(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = errorCode(error) === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" ? 75 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
