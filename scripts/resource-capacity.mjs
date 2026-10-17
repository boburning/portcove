import { resourceDomainRoot, resourceConfiguration } from "./resource-paths.mjs";
import { resolvePhysicalPath } from "./dev-storage.mjs";
import { fallowSource } from "./fallow-source.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireHeavyRustTestLock,
  heavyRustOwnerActivity,
  readHeavyRustLockOwner,
  readProcessIdentity,
  releaseHeavyRustLock,
} from "./heavy-rust-test-lock.mjs";
import { acquireOwnedProcessLock, readProcessLockOwner } from "./process-lock.mjs";

const processToken = randomUUID().replaceAll("-", "").slice(0, 16);
let identityUsers = 0;
let originalTitle;
function retainIdentity() {
  if (identityUsers++ === 0 && process.platform === "darwin") {
    originalTitle = process.title;
    process.title = `portcove-rust:${processToken} ${originalTitle}`;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--identityUsers === 0 && process.platform === "darwin") process.title = originalTitle;
  };
}

const inheritedName = "PORTCOVE_RESOURCE_RESERVATION";
export const resourceProfiles = Object.freeze({ rust: 1, browser: 1, analysis: 1, container: 2 });

export { resourceDomainRoot } from "./resource-paths.mjs";

export function frontendOutputResource(workspace) {
  const physical = resolvePhysicalPath(workspace);
  return `exclusive-${createHash("sha256")
    .update(process.platform === "win32" ? physical.toLowerCase() : physical)
    .digest("hex")}`;
}

export { resourceConfiguration } from "./resource-paths.mjs";

function legacyRoots(config, environment) {
  const ordinary =
    process.platform === "win32"
      ? path.join(
          environment.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
          "Portcove",
          "tool-cache",
        )
      : path.join(homedir(), ".cache", "portcove");
  return [
    ...new Set(
      [
        ordinary,
        environment.PORTCOVE_SHARED_TOOL_CACHE,
        ...(environment.XDG_CACHE_HOME ? [path.join(environment.XDG_CACHE_HOME, "portcove")] : []),
        ...config.legacyRoots,
      ]
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  ];
}

async function missingAllowed(read) {
  try {
    return await read();
  } catch (error) {
    if ((error.cause?.code ?? error.code) === "ENOENT") return null;
    throw error;
  }
}

async function legacyBlocker(config, environment) {
  for (const root of legacyRoots(config, environment)) {
    const rust = await missingAllowed(() =>
      readHeavyRustLockOwner(path.join(root, "locks", "heavy-rust-tests")),
    );
    if (
      rust &&
      !rust.capacity_aware &&
      rust.token !== environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN &&
      heavyRustOwnerActivity(rust)
    )
      return { resource: "legacy-heavy-rust", ...rust };
    const native = await missingAllowed(() =>
      readProcessLockOwner(path.join(root, "locks", "native-desktop"), "Native desktop"),
    );
    // Legacy native records do not prove descendant quiescence even after the PID exits.
    if (
      native &&
      !native.capacity_aware &&
      native.token !== environment.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN
    )
      return { resource: "legacy-native-desktop (PID-only; inspect before recovery)", ...native };
  }
  return null;
}

// Handover only: hold the old guards while recording their retirement. No new
// payload runs under PID-only legacy ownership or a bridge daemon.
async function legacyBridge(config, environment, metadata, common) {
  const held = [];
  try {
    const { acquireNativeSessionLock, legacyNativeSessionLockPath } =
      await import("./native-session-lock.mjs");
    const primary = legacyNativeSessionLockPath();
    const current = await missingAllowed(() => readProcessLockOwner(primary, "Legacy native"));
    const token =
      environment.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN ??
      (current?.pid === process.pid && current.process_identity === readProcessIdentity(process.pid)
        ? current.token
        : undefined);
    const native = await acquireNativeSessionLock(
      { ...metadata, profile: "resource-transition" },
      { inheritedToken: token, retiringLegacy: true },
    );
    held.push(native);
    for (const root of legacyRoots(config, environment).sort()) {
      const nativePath = path.join(root, "locks", "native-desktop");
      if (path.resolve(nativePath) !== path.resolve(primary))
        held.push(
          await acquireOwnedProcessLock(
            nativePath,
            { ...metadata, capacity_aware: true },
            {
              label: "Legacy native transition",
              verifyIdentity: true,
              canReclaim: false,
            },
          ),
        );
    }
    for (const root of legacyRoots(config, environment).sort()) {
      const target = path.join(root, "locks", "heavy-rust-tests");
      const owner = await missingAllowed(() => readHeavyRustLockOwner(target));
      const lock = await acquireHeavyRustTestLock(
        { ...metadata, capacity_aware: true },
        {
          ...common,
          lockPath: target,
          inheritedToken:
            owner && owner.token === environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN ? owner.token : "",
        },
      );
      held.push(lock);
    }
    return { held };
  } catch (error) {
    for (const lock of held.reverse()) await lock.release();
    throw error;
  }
}

export async function observeCapacity(options = {}) {
  const root = options.root ?? resourceDomainRoot();
  const config = await resourceConfiguration(root);
  const files = (await missingAllowed(() => readdir(root))) ?? [];
  const running = [];
  for (const file of files.filter((name) => /^slot-\d+$/u.test(name))) {
    const owner = await missingAllowed(() => readHeavyRustLockOwner(path.join(root, file)));
    if (owner) running.push({ slot: file, ...owner, activity: heavyRustOwnerActivity(owner) });
  }
  const queued = await queueOwners(root, false);
  return {
    root,
    config,
    running,
    queued,
    limits:
      "Participating same-user commands only; missing records do not establish machine idle. Independent WSL and arbitrary third-party commands are unobserved.",
  };
}

async function queueOwners(
  root,
  activeOnly = true,
  inspectProcessIdentity = readProcessIdentity,
  options = {},
) {
  const files = (await missingAllowed(() => readdir(path.join(root, "queue")))) ?? [];
  const owners = [];
  for (const name of files.filter((value) => /^\d{13}-[a-f0-9-]{36}$/u.test(value)).sort()) {
    if (performance.now() >= (options.deadline ?? Infinity))
      throw Object.assign(
        new Error("Resource queue observation deadline reached; no payload started"),
        { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
      );
    const owner = await missingAllowed(() =>
      readHeavyRustLockOwner(path.join(root, "queue", name)),
    );
    if (owner) {
      const activity = heavyRustOwnerActivity(owner, { inspectProcessIdentity });
      if (!activeOnly || activity) owners.push({ name, ...owner, activity });
      if (activity && options.firstOnly) break;
    }
  }
  return owners;
}

function references(lease, root) {
  if (
    lease?.root !== root ||
    !Array.isArray(lease.slots) ||
    !lease.slots.length ||
    lease.slots.length > 8 ||
    lease.slots.some(
      (slot) => !/^slot-[0-7]$/u.test(slot.name) || typeof slot.token !== "string",
    ) ||
    new Set(lease.slots.map((slot) => slot.name)).size !== lease.slots.length
  )
    throw new Error("Inherited resource reservation has an invalid domain or slot inventory");
  const exclusive = lease.exclusive ?? [];
  if (
    !Array.isArray(exclusive) ||
    exclusive.some(
      (slot) => !/^exclusive-[a-f0-9]{64}$/u.test(slot.name) || typeof slot.token !== "string",
    )
  )
    throw new Error("Invalid exclusive output reservation");
  return [...lease.slots, ...exclusive].map((slot) => ({
    ...slot,
    path: path.join(root, slot.name),
  }));
}

/** Acquire all needed slots before payload launch, with FIFO waiting and no partial hold while queued. */
export async function acquireResourceCapacity(profile, metadata = {}, options = {}) {
  if (!Object.hasOwn(resourceProfiles, profile))
    throw new Error(`Unknown resource profile: ${profile}`);
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1")
    return {
      inherited: true,
      childEnvironment: {},
      registerChild: async () => {},
      release: async () => {},
      queueMs: 0,
    };
  const root = options.root ?? resourceDomainRoot();
  const config = await resourceConfiguration(root);
  const units = Math.min(config.slots, resourceProfiles[profile]);
  const exclusive = [...new Set(options.exclusive ?? [])].sort();
  if (exclusive.some((name) => !/^exclusive-[a-f0-9]{64}$/u.test(name)))
    throw new Error("Invalid output reservation identity");
  if (environment[inheritedName]) {
    const lease = JSON.parse(environment[inheritedName]);
    const slots = references(lease, root);
    if (lease.slots.length < units)
      throw new Error(
        "Nested resource upgrade refused; reserve the larger profile at the outer heavy phase",
      );
    for (const slot of slots) {
      const owner = await readHeavyRustLockOwner(slot.path);
      if (owner.token !== slot.token || !heavyRustOwnerActivity({ ...owner, external: undefined }))
        throw new Error("Inherited resource reservation no longer has verified live ownership");
    }
    if (exclusive.some((name) => !slots.some((slot) => slot.name === name)))
      throw new Error(
        "Nested output reservation upgrade refused; declare output ownership on the outer phase",
      );
    return {
      inherited: true,
      childEnvironment: { [inheritedName]: environment[inheritedName] },
      registerChild: async () => {},
      release: async () => {},
      queueMs: 0,
    };
  }
  await mkdir(path.join(root, "queue"), { recursive: true });
  const name = `${Date.now()}-${randomUUID()}`;
  const releaseIdentity = retainIdentity();
  let ownIdentity;
  try {
    ownIdentity = readProcessIdentity(process.pid, { processToken });
  } catch (error) {
    releaseIdentity();
    throw error;
  }
  const inspectProcessIdentity = (pid, options) =>
    pid === process.pid ? ownIdentity : readProcessIdentity(pid, options);
  const common = {
    inspectProcessIdentity,
    inheritedToken: "",
    processToken,
    manageProcessTitle: false,
    waitMilliseconds: 0,
    signal: options.signal,
  };
  const queued = await acquireHeavyRustTestLock(
    {
      ...metadata,
      command: `${profile}: ${metadata.command ?? "heavy phase"}`,
      capacity_aware: true,
    },
    { ...common, lockPath: path.join(root, "queue", name) },
  ).catch((error) => {
    releaseIdentity();
    throw error;
  });
  const started = performance.now();
  const waitMs = options.waitMs ?? config.waitMs;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3_600_000) {
    await queued.release();
    releaseIdentity();
    throw new Error("Resource waitMs must be 0..3600000");
  }
  const deadline = started + waitMs;
  let nextReport = 0;
  const acquired = [];
  let admitted = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const waiting = await queueOwners(root, true, inspectProcessIdentity, {
        firstOnly: true,
        deadline: waitMs === 0 ? started + 5_000 : deadline,
      });
      const legacy = await (options.legacyBlocker ?? legacyBlocker)(config, environment);
      const outsideConfiguredCapacity = (await readdir(root)).some(
        (file) => /^slot-\d+$/u.test(file) && Number(file.slice(5)) >= config.slots,
      );
      if (waiting[0]?.name === name && !legacy && !outsideConfiguredCapacity) {
        const currentConfig = await resourceConfiguration(root);
        if (currentConfig.legacyMode !== "coordinated") {
          if (performance.now() >= deadline)
            throw Object.assign(
              new Error(
                "Resource handover is pending; no payload started. Finish legacy work and run retire-legacy-entrypoints from an updated checkout.",
              ),
              { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
            );
          if (performance.now() >= nextReport) {
            (options.report ?? console.error)(
              `Resource handover pending; ${profile} queued ${Math.round(performance.now() - started)}ms. Drain old heavy/native/container work, retire old entrypoints, then run resource-command.mjs retire-legacy-entrypoints.`,
            );
            nextReport = performance.now() + 30_000;
          }
          await delay(
            Math.min(options.pollMs ?? 250, Math.max(1, deadline - performance.now())),
            undefined,
            { signal: options.signal },
          );
          continue;
        }
        if (
          currentConfig.slots !== config.slots ||
          JSON.stringify(currentConfig.legacyRoots) !== JSON.stringify(config.legacyRoots)
        )
          throw Object.assign(
            new Error("Resource configuration changed while queued; retry the intended command"),
            { code: "PORTCOVE_RESOURCE_CONFIGURATION_CHANGED" },
          );
        for (let slot = 0; slot < config.slots && acquired.length < units; slot++) {
          try {
            acquired.push(
              await acquireHeavyRustTestLock(
                {
                  ...metadata,
                  command: `${profile}: ${metadata.command ?? "heavy phase"}`,
                  capacity_aware: true,
                },
                { ...common, lockPath: path.join(root, `slot-${slot}`) },
              ),
            );
          } catch (error) {
            if (error.code !== "PORTCOVE_RESOURCE_BUSY" && error.cause?.code !== "ENOENT")
              throw error;
          }
        }
        if (acquired.length === units) {
          for (const name of exclusive) {
            try {
              acquired.push(
                await acquireHeavyRustTestLock(
                  {
                    ...metadata,
                    command: `${profile}: ${metadata.command ?? "heavy phase"}`,
                    capacity_aware: true,
                  },
                  { ...common, lockPath: path.join(root, name) },
                ),
              );
            } catch (error) {
              if (error.code !== "PORTCOVE_RESOURCE_BUSY" && error.cause?.code !== "ENOENT")
                throw error;
              break;
            }
          }
          if (acquired.length === units + exclusive.length) {
            if (waitMs > 0 && performance.now() >= deadline)
              throw Object.assign(
                new Error("Resource admission deadline reached; no payload started"),
                { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
              );
            admitted = true;
            break;
          }
        }
        for (const lock of acquired.splice(0)) await lock.release();
      }
      const elapsed = Math.round(performance.now() - started);
      if (performance.now() >= deadline)
        throw Object.assign(
          new Error(`Resource admission timed out after ${elapsed}ms; ${profile} has not started`),
          { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
        );
      if (performance.now() >= nextReport) {
        const holder =
          legacy ?? (await observeCapacity({ root })).running.find((entry) => entry.activity);
        (options.report ?? console.error)(
          `Waiting for host capacity (${profile}, ${units}/${config.slots} slots); queued ${elapsed}ms; owner ${holder?.workspace ?? waiting[0]?.workspace ?? "unknown"}, command ${holder?.command ?? waiting[0]?.command ?? "unknown"}.`,
        );
        nextReport = performance.now() + 30_000;
      }
      await delay(
        Math.min(options.pollMs ?? 250, Math.max(1, deadline - performance.now())),
        undefined,
        { signal: options.signal },
      );
    }
    const queueMs = Math.round(performance.now() - started);
    const lease = {
      root,
      profile,
      slots: acquired
        .filter((lock) => path.basename(lock.lockPath).startsWith("slot-"))
        .map((lock) => ({
          name: path.basename(lock.lockPath),
          token: lock.owner.token,
        })),
      exclusive: acquired
        .filter((lock) => path.basename(lock.lockPath).startsWith("exclusive-"))
        .map((lock) => ({ name: path.basename(lock.lockPath), token: lock.owner.token })),
    };
    let releasePromise;
    return {
      inherited: false,
      queueMs,
      reference: lease,
      childEnvironment: {
        [inheritedName]: JSON.stringify(lease),
        PORTCOVE_HEAVY_RUST_PROCESS_TOKEN: processToken,
      },
      registerChild: async (child, registration) => {
        let registered;
        for (const lock of acquired) {
          const current = await lock.registerChild(child, registration);
          if (current === null) return null;
          registered = current;
        }
        return registered;
      },
      registerExternal: async (external) => {
        for (const lock of acquired)
          await writeFile(
            `${lock.lockPath}.external-${lock.owner.token}`,
            JSON.stringify(external),
            { flag: "wx" },
          );
      },
      release: () =>
        (releasePromise ??= (async () => {
          const external = await missingAllowed(() =>
            readFile(`${acquired[0].lockPath}.external-${acquired[0].owner.token}`, "utf8"),
          );
          if (external) await releaseExternalRecords(lease, JSON.parse(external), root, false);
          else for (const lock of acquired) await lock.release();
          releaseIdentity();
        })()),
    };
  } finally {
    await queued.release();
    if (!admitted) {
      for (const lock of acquired) await lock.release();
      releaseIdentity();
    }
  }
}

// A durable decision precedes any removal. Retrying after a crash may observe
// missing slots or successors; the journal authorizes only the original tokens.
async function releaseExternalRecords(lease, external, root, requireDead) {
  const slots = references(lease, root);
  const decision = { format_version: 1, lease, external };
  const key = createHash("sha256").update(JSON.stringify(decision)).digest("hex");
  const directory = path.join(root, "recovery");
  const journal = path.join(directory, `${key}.json`);
  const releaseIdentity = retainIdentity();
  let guard;
  try {
    guard = await acquireHeavyRustTestLock(
      { command: "external capacity cleanup", workspace: root },
      {
        lockPath: `${journal}.lock`,
        inheritedToken: "",
        waitMilliseconds: 0,
        processToken,
        manageProcessTitle: false,
      },
    );
    const previous = await missingAllowed(() => readFile(journal, "utf8"));
    if (previous && previous !== JSON.stringify(decision))
      throw new Error("Resource recovery journal differs");
    if (!previous) {
      for (const slot of slots) {
        const owner = await readHeavyRustLockOwner(slot.path);
        if (
          owner.token !== slot.token ||
          (owner.external && JSON.stringify(owner.external) !== JSON.stringify(external))
        )
          throw new Error("External resource custody differs; retaining the reservation");
        if (requireDead && heavyRustOwnerActivity({ ...owner, external: undefined }))
          throw new Error(
            "External caller or contained descendants remain active; retaining custody",
          );
      }
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(journal, JSON.stringify(decision), { flag: "wx" });
      } catch (error) {
        if (
          error.code !== "EEXIST" ||
          (await readFile(journal, "utf8")) !== JSON.stringify(decision)
        )
          throw error;
      }
    }
    for (const slot of slots) {
      const owner = await missingAllowed(() => readHeavyRustLockOwner(slot.path));
      if (owner?.token === slot.token) {
        if (requireDead && heavyRustOwnerActivity({ ...owner, external: undefined }))
          throw new Error("Original resource caller remains active");
        await rm(`${slot.path}.external-${slot.token}`, { force: true });
        await releaseHeavyRustLock(slot.path, slot.token);
      }
    }
    return journal;
  } finally {
    if (guard) await guard.release();
    releaseIdentity();
  }
}

// Called only after the adapter proves this exact remote operation cannot restart.
export async function reconcileExternalCapacity(lease, external, proveStopped, options = {}) {
  if (!(await proveStopped())) throw new Error("External resource work is not proven stopped");
  return releaseExternalRecords(lease, external, options.root ?? resourceDomainRoot(), true);
}

export async function capacityChildrenStopped(lease, options = {}) {
  for (const slot of references(lease, options.root ?? resourceDomainRoot())) {
    const owner = await readHeavyRustLockOwner(slot.path);
    if (owner.token !== slot.token) throw new Error("Capacity child custody differs");
    if (
      heavyRustOwnerActivity(
        { ...owner, external: undefined },
        {
          inspectProcessIdentity: (pid, settings) =>
            pid === owner.process.pid ? null : readProcessIdentity(pid, settings),
        },
      )
    )
      return false;
  }
  return true;
}

/** Reuse the existing source custody primitive, including dirty/untracked bytes. */
export async function acquireSourceBoundCapacity(profile, metadata, options = {}) {
  const environment = options.environment ?? process.env;
  if (
    environment[inheritedName] ||
    environment.GITHUB_ACTIONS === "true" ||
    environment.PORTCOVE_CONTAINER_GUEST === "1"
  )
    return acquireResourceCapacity(profile, metadata, options);
  const snapshot =
    options.snapshot ?? (() => fallowSource(metadata.workspace, undefined, { includeAll: true }));
  const before = options.expectedSource ?? snapshot();
  const lease = await acquireResourceCapacity(profile, metadata, options);
  try {
    if (JSON.stringify(before) !== JSON.stringify(snapshot()))
      throw Object.assign(
        new Error("Source changed while queued; the requested candidate has not run"),
        { code: "PORTCOVE_RESOURCE_SOURCE_CHANGED" },
      );
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/** Explicit one-way handover. Older checkouts must be retired before invoking it. */
export async function retireLegacyEntrypoints(options = {}) {
  const root = options.root ?? resourceDomainRoot();
  const environment = options.environment ?? process.env;
  const config = await resourceConfiguration(root);
  if (config.legacyMode === "coordinated") return { unchanged: true, root, config };
  const bridge = await legacyBridge(
    config,
    environment,
    {
      workspace: options.workspace ?? process.cwd(),
      command: "retire legacy resource entrypoints",
    },
    { inheritedToken: "", waitMilliseconds: 0 },
  );
  try {
    const observed = await observeCapacity({ root });
    if (observed.running.length)
      throw new Error(
        "Cutover requires a drained resource domain; retain all existing reservations",
      );
    const receipt = {
      format_version: 1,
      created_at: new Date().toISOString(),
      workspace: options.workspace ?? process.cwd(),
      legacy_roots: legacyRoots(config, environment),
      previous: config,
      next: { ...config, legacyMode: "coordinated" },
      limitation:
        "Unmodified legacy entrypoints are retired; launch participating commands from updated checkouts",
    };
    await mkdir(path.join(root, "migrations"), { recursive: true });
    const evidence = path.join(root, "migrations", `${randomUUID()}.json`);
    await writeFile(evidence, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    const temporary = path.join(root, `config-${randomUUID()}.next`);
    await writeFile(temporary, JSON.stringify(receipt.next, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, path.join(root, "config.json"));
    return { root, config: receipt.next, evidence };
  } finally {
    for (const lock of bridge.held.reverse()) await lock.release();
  }
}
