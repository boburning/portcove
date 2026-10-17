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

/** Direct CLI entrypoints re-enter only under verified outer ownership. */
export async function resourceEntrypoint(profile, action, options = {}) {
  if (
    process.env.PORTCOVE_RESOURCE_RESERVATION ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.PORTCOVE_CONTAINER_GUEST === "1"
  ) {
    await acquireSourceBoundCapacity(
      profile,
      { workspace: root },
      {
        exclusive:
          options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
      },
    );
    return action();
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
  } else {
    const [profile, separator, executable, ...args] = process.argv.slice(2);
    if (!profile || separator !== "--" || !executable)
      throw new Error(
        "usage: resource-command.mjs rust|browser|analysis|container -- executable [args...]",
      );
    try {
      process.exitCode = await runResourceCommand(profile, executable, args);
    } catch (error) {
      console.error(error.message);
      process.exitCode = error.code === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" ? 75 : 1;
    }
  }
}

// Runtime-only scripts may be imported by the maintained CLI; direct launches use the same guard.
export async function reenterResourceCommand(profile, moduleUrl, options = {}) {
  const environment = process.env;
  if (
    !environment.PORTCOVE_RESOURCE_RESERVATION &&
    environment.GITHUB_ACTIONS !== "true" &&
    environment.PORTCOVE_CONTAINER_GUEST !== "1"
  ) {
    const status = await runResourceCommand(
      profile,
      process.execPath,
      [fileURLToPath(moduleUrl), ...process.argv.slice(2)],
      options,
    );
    process.exit(status);
  }
  await acquireSourceBoundCapacity(
    profile,
    { workspace: root },
    {
      exclusive: options.exclusive ?? (profile === "browser" ? [frontendOutputResource(root)] : []),
    },
  );
}
