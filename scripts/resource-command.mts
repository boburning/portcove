import { errorCode, errorMessage } from "./runtime-values.mts";
import type { RustRunDependencies, RustResourceOptions } from "./run-rust-tests.mts";
import type { ResourceMetadata } from "./resource-capacity.mts";
interface ResourceCommandOptions {
  executionTimeoutMilliseconds?: number;
  onExecutionTimeout?: (milliseconds: number) => void;
  output?: { stdout: number; stderr: number };
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  exclusive?: readonly string[];
  supervise?: (args: string[], options: RustRunDependencies) => Promise<number>;
  /** Optional absolute monotonic admission deadline; never a payload timeout. */
  queueDeadline?: number;
}
import { toolCachePaths } from "./tool-cache.mts";
import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRustTests, acquireRustResources } from "./run-rust-tests.mts";
import {
  acquireSourceBoundCapacity,
  frontendOutputResource,
  retireLegacyEntrypoints,
} from "./resource-capacity.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

// Bootstrap publishes shared pinned tools, receipts and shims as well as checkout
// outputs. The physical cache key varies only when the actual writable location does.
export function bootstrapOutputResources(environment = process.env) {
  return [
    frontendOutputResource(root),
    frontendOutputResource(toolCachePaths({ environment }).sharedRoot),
  ];
}

/** Existing supervisor contains the admitted command, including detached descendants. */
export async function runResourceCommand(
  profile: string,
  executable: string,
  args: string[],
  options: ResourceCommandOptions = {},
) {
  const queueDeadline = options.queueDeadline;
  const remainingQueue = () => {
    if (queueDeadline === undefined) return undefined;
    const remaining = Math.floor(queueDeadline - performance.now());
    if (!Number.isFinite(queueDeadline) || remaining < 1)
      throw Object.assign(new Error("Resource admission deadline exhausted; no payload started"), {
        code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT",
      });
    return Math.min(3_600_000, remaining);
  };
  remainingQueue();
  const afterAdmission = async <T extends { release: () => Promise<void> }>(lease: T) => {
    try {
      remainingQueue();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  };
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    ...(profile === "rust" ? {} : { RUSTUP_AUTO_INSTALL: "0" }),
  };
  let queueMs = 0;
  const started = performance.now();
  const status = await (options.supervise ?? runRustTests)(
    ["--guard-command", executable, ...args],
    {
      environment,
      ...(options.executionTimeoutMilliseconds === undefined
        ? {}
        : {
            executionTimeoutMilliseconds: options.executionTimeoutMilliseconds,
          }),
      ...(options.onExecutionTimeout ? { onExecutionTimeout: options.onExecutionTimeout } : {}),
      ...(options.output ? { output: options.output } : {}),
      cwd: options.cwd ?? process.cwd(),
      acquireLock: async (metadata, admission) => {
        const remaining = remainingQueue();
        if (remaining !== undefined)
          admission = {
            ...admission,
            waitMs: Math.min(admission.waitMs ?? remaining, remaining),
            waitMilliseconds: Math.min(
              admission.waitMilliseconds === ""
                ? remaining
                : Number(admission.waitMilliseconds ?? remaining),
              remaining,
            ),
          };
        if (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1")
          return afterAdmission(await acquireHeavyRustTestLock(metadata, admission));
        const lease = await (
          profile === "rust"
            ? (ignored: string, metadata: ResourceMetadata, options: RustResourceOptions) =>
                acquireRustResources(metadata, options)
            : acquireSourceBoundCapacity
        )(
          profile,
          { ...metadata, workspace: root },
          {
            ...admission,
            environment,
            exclusive:
              options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
          },
        );
        await afterAdmission(lease);
        queueMs = "queueMs" in lease ? lease.queueMs : 0;
        if (!lease.inherited)
          console.error(
            `[resource] ${profile} admitted; queue ${queueMs}ms; execution starts after supervisor setup`,
          );
        return lease;
      },
    },
  );
  console.error(
    `[resource] ${profile} exited ${status}; total ${Math.round(performance.now() - started)}ms; queue ${queueMs}ms (setup included in total)`,
  );
  return status;
}

function admittedContext(profile: string, environment = process.env) {
  if (environment.PORTCOVE_RESOURCE_RESERVATION) return true;
  return (
    (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1") &&
    (profile !== "rust" || Boolean(environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN))
  );
}

/** Direct CLI entrypoints re-enter only under verified outer ownership. */
export async function resourceEntrypoint(
  profile: string,
  action: () => number | Promise<number>,
  options: ResourceCommandOptions = {},
) {
  if (admittedContext(profile)) {
    const lease = await (
      profile === "rust"
        ? (ignored: string, metadata: ResourceMetadata, options: RustResourceOptions) =>
            acquireRustResources(metadata, options)
        : acquireSourceBoundCapacity
    )(
      profile,
      { workspace: root, cwd: options.cwd ?? process.cwd() },
      {
        exclusive:
          options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
      },
    );
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }
  return runResourceCommand(
    profile,
    process.execPath,
    [path.resolve(process.argv[1] ?? ""), ...process.argv.slice(2)],
    options,
  );
}

if (process.argv[1] && path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") === "retire-legacy-entrypoints") {
    console.log(JSON.stringify(await retireLegacyEntrypoints({ workspace: root }), null, 2));
  } else if (process.argv.slice(2).join(" ") === "verify-bootstrap") {
    if (!process.env.PORTCOVE_RESOURCE_RESERVATION)
      throw new Error("Bootstrap requires verified outer resource ownership");
    const lease = await acquireRustResources(
      { workspace: root, cwd: root },
      { exclusive: bootstrapOutputResources() },
    );
    if (!lease.inherited)
      throw new Error("Bootstrap verification must not create another reservation");
  } else {
    const commandArgs = process.argv.slice(2);
    const profile = commandArgs.shift();
    const bootstrap = commandArgs[0] === "--bootstrap";
    if (bootstrap) commandArgs.shift();
    const [separator, executable, ...args] = commandArgs;
    if (!profile || separator !== "--" || !executable)
      throw new Error(
        "usage: resource-command.mts rust|browser|analysis|container [--bootstrap] -- executable [args...]",
      );
    try {
      if (bootstrap && profile !== "rust")
        throw new Error("Bootstrap uses the existing Rust containment profile");
      process.exitCode = await runResourceCommand(
        profile,
        executable,
        args,
        bootstrap
          ? {
              cwd: root,
              environment: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
              exclusive: bootstrapOutputResources(),
            }
          : {},
      );
    } catch (error) {
      console.error(errorMessage(error));
      if (bootstrap && /Could not establish rustc identity/.test(errorMessage(error)))
        console.error(
          "Install the repository-pinned Rust toolchain with rustup toolchain install <rust-toolchain.toml channel> --profile minimal and the platform linker described in docs/DEVELOPMENT-TOOLS.md, then retry setup.",
        );
      process.exitCode = errorCode(error) === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" ? 75 : 1;
    }
  }
}

// Runtime-only scripts may be imported by the maintained CLI; direct launches use the same guard.
export async function reenterResourceCommand(
  profile: string,
  moduleUrl: string,
  options: ResourceCommandOptions = {},
) {
  if (!admittedContext(profile)) {
    const status = await runResourceCommand(
      profile,
      process.execPath,
      [fileURLToPath(moduleUrl), ...process.argv.slice(2)],
      options,
    );
    process.exit(status);
  }
  await (
    profile === "rust"
      ? (ignored: string, metadata: ResourceMetadata, options: RustResourceOptions) =>
          acquireRustResources(metadata, options)
      : acquireSourceBoundCapacity
  )(
    profile,
    { workspace: root, cwd: options.cwd ?? process.cwd() },
    {
      exclusive: options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
    },
  );
}
