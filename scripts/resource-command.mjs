import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRustTests, acquireRustResources } from "./run-rust-tests.mjs";
import {
  acquireSourceBoundCapacity,
  frontendOutputResource,
  retireLegacyEntrypoints,
} from "./resource-capacity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Existing supervisor contains the admitted command, including detached descendants. */
export async function runResourceCommand(profile, executable, args, options = {}) {
  const environment = {
    ...(options.environment ?? process.env),
    ...(profile === "rust" ? {} : { RUSTUP_AUTO_INSTALL: "0" }),
  };
  let queueMs = 0;
  const started = performance.now();
  const status = await (options.supervise ?? runRustTests)(
    ["--guard-command", executable, ...args],
    {
      environment,
      cwd: options.cwd ?? process.cwd(),
      acquireLock: async (metadata, admission) => {
        if (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1")
          return acquireHeavyRustTestLock(metadata, admission);
        const lease = await (
          profile === "rust"
            ? (ignored, metadata, options) => acquireRustResources(metadata, options)
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
        queueMs = lease.queueMs;
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

function admittedContext(profile, environment = process.env) {
  if (environment.PORTCOVE_RESOURCE_RESERVATION) return true;
  return (
    (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1") &&
    (profile !== "rust" || Boolean(environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN))
  );
}

/** Direct CLI entrypoints re-enter only under verified outer ownership. */
export async function resourceEntrypoint(profile, action, options = {}) {
  if (admittedContext(profile)) {
    const lease = await (
      profile === "rust"
        ? (ignored, metadata, options) => acquireRustResources(metadata, options)
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
    [path.resolve(process.argv[1]), ...process.argv.slice(2)],
    options,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") === "retire-legacy-entrypoints") {
    console.log(JSON.stringify(await retireLegacyEntrypoints({ workspace: root }), null, 2));
  } else if (process.argv.slice(2).join(" ") === "verify-bootstrap") {
    if (!process.env.PORTCOVE_RESOURCE_RESERVATION)
      throw new Error("Bootstrap requires verified outer resource ownership");
    const lease = await acquireRustResources(
      { workspace: root, cwd: root },
      { exclusive: [frontendOutputResource(root)] },
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
        "usage: resource-command.mjs rust|browser|analysis|container [--bootstrap] -- executable [args...]",
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
              exclusive: [frontendOutputResource(root)],
            }
          : {},
      );
    } catch (error) {
      console.error(error.message);
      if (bootstrap && /Could not establish rustc identity/.test(error.message))
        console.error(
          "Install the repository-pinned Rust toolchain with rustup toolchain install <rust-toolchain.toml channel> --profile minimal and the platform linker described in docs/DEVELOPMENT-TOOLS.md, then retry setup.",
        );
      process.exitCode = error.code === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" ? 75 : 1;
    }
  }
}

// Runtime-only scripts may be imported by the maintained CLI; direct launches use the same guard.
export async function reenterResourceCommand(profile, moduleUrl, options = {}) {
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
      ? (ignored, metadata, options) => acquireRustResources(metadata, options)
      : acquireSourceBoundCapacity
  )(
    profile,
    { workspace: root, cwd: options.cwd ?? process.cwd() },
    {
      exclusive: options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
    },
  );
}
