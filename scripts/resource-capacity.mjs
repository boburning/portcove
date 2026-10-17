import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
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
import { readProcessLockOwner } from "./process-lock.mjs";

const inheritedName = "PORTCOVE_RESOURCE_RESERVATION";
export const resourceProfiles = Object.freeze({ rust: 1, browser: 1, analysis: 1, container: 2 });

// Identity deliberately excludes checkout, tool pins, cache overrides and XDG cache settings.
export function resourceDomainRoot() {
  return path.join(homedir(), ".portcove", "resources");
}

export async function resourceConfiguration(root = resourceDomainRoot()) {
  let supplied = {};
  try { supplied = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = { slots: 2, waitMs: 900_000, legacyRoots: [], ...supplied };
  if (Object.keys(config).some((key) => !["slots", "waitMs", "legacyRoots"].includes(key)) ||
      !Number.isInteger(config.slots) || config.slots < 1 || config.slots > 8 ||
      !Number.isInteger(config.waitMs) || config.waitMs < 0 || config.waitMs > 3_600_000 ||
      !Array.isArray(config.legacyRoots) || config.legacyRoots.some((value) => typeof value !== "string" || !path.isAbsolute(value)))
    throw new Error("Resource config requires slots 1..8, waitMs 0..3600000 and absolute legacyRoots");
  return config;
}

function legacyRoots(config, environment) {
  const ordinary = process.platform === "win32"
    ? path.join(environment.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "Portcove", "tool-cache")
    : path.join(homedir(), ".cache", "portcove");
  return [...new Set([ordinary, environment.PORTCOVE_SHARED_TOOL_CACHE,
    ...(environment.XDG_CACHE_HOME ? [path.join(environment.XDG_CACHE_HOME, "portcove")] : []),
    ...config.legacyRoots].filter(Boolean).map((value) => path.resolve(value)))];
}

async function missingAllowed(read) {
  try { return await read(); }
  catch (error) { if ((error.cause?.code ?? error.code) === "ENOENT") return null; throw error; }
}

async function legacyBlocker(config, environment) {
  for (const root of legacyRoots(config, environment)) {
    const rust = await missingAllowed(() => readHeavyRustLockOwner(path.join(root, "locks", "heavy-rust-tests")));
    if (rust && !rust.capacity_aware && rust.token !== environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN && heavyRustOwnerActivity(rust))
      return { resource: "legacy-heavy-rust", ...rust };
    const native = await missingAllowed(() => readProcessLockOwner(path.join(root, "locks", "native-desktop"), "Native desktop"));
    // Legacy native records do not prove descendant quiescence even after the PID exits.
    if (native && !native.capacity_aware && native.token !== environment.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN)
      return { resource: "legacy-native-desktop (PID-only; inspect before recovery)", ...native };
  }
  return null;
}

export async function observeCapacity(options = {}) {
  const root = options.root ?? resourceDomainRoot();
  const config = await resourceConfiguration(root);
  const files = await missingAllowed(() => readdir(root)) ?? [];
  const running = [];
  for (const file of files.filter((name) => /^slot-\d+$/u.test(name))) {
    const owner = await missingAllowed(() => readHeavyRustLockOwner(path.join(root, file)));
    if (owner) running.push({ slot: file, ...owner, activity: heavyRustOwnerActivity(owner) });
  }
  const queued = await queueOwners(root);
  return { root, config, running, queued, limits: "Participating same-user commands only; missing records do not establish machine idle. Independent WSL and arbitrary third-party commands are unobserved." };
}

async function queueOwners(root) {
  const files = await missingAllowed(() => readdir(path.join(root, "queue"))) ?? [];
  const owners = [];
  for (const name of files.filter((value) => /^\d{13}-[a-f0-9-]{36}$/u.test(value)).sort()) {
    const owner = await missingAllowed(() => readHeavyRustLockOwner(path.join(root, "queue", name)));
    if (owner && heavyRustOwnerActivity(owner)) owners.push({ name, ...owner });
  }
  return owners;
}

function references(lease, root) {
  if (lease?.root !== root || !Array.isArray(lease.slots) || !lease.slots.length || lease.slots.length > 8 ||
      lease.slots.some((slot) => !/^slot-[0-7]$/u.test(slot.name) || typeof slot.token !== "string") ||
      new Set(lease.slots.map((slot) => slot.name)).size !== lease.slots.length)
    throw new Error("Inherited resource reservation has an invalid domain or slot inventory");
  return lease.slots.map((slot) => ({ ...slot, path: path.join(root, slot.name) }));
}

/** Acquire all needed slots before payload launch, with FIFO waiting and no partial hold while queued. */
export async function acquireResourceCapacity(profile, metadata = {}, options = {}) {
  if (!Object.hasOwn(resourceProfiles, profile)) throw new Error(`Unknown resource profile: ${profile}`);
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS === "true" || environment.PORTCOVE_CONTAINER_GUEST === "1")
    return { inherited: true, childEnvironment: {}, registerChild: async () => {}, release: async () => {}, queueMs: 0 };
  const root = options.root ?? resourceDomainRoot();
  const config = await resourceConfiguration(root);
  const units = Math.min(config.slots, resourceProfiles[profile]);
  if (environment[inheritedName]) {
    const lease = JSON.parse(environment[inheritedName]);
    const slots = references(lease, root);
    if (slots.length < units) throw new Error("Nested resource upgrade refused; reserve the larger profile at the outer heavy phase");
    for (const slot of slots) {
      const owner = await readHeavyRustLockOwner(slot.path);
      if (owner.token !== slot.token || !heavyRustOwnerActivity({ ...owner, external: undefined }))
        throw new Error("Inherited resource reservation no longer has verified live ownership");
    }
    return { inherited: true, childEnvironment: { [inheritedName]: environment[inheritedName] }, registerChild: async () => {}, release: async () => {}, queueMs: 0 };
  }
  await mkdir(path.join(root, "queue"), { recursive: true });
  const name = `${Date.now()}-${randomUUID()}`;
  const processToken = randomUUID().replaceAll("-", "").slice(0, 16);
  const originalTitle = process.title;
  if (process.platform === "darwin") process.title = `portcove-rust:${processToken} ${originalTitle}`;
  const common = { inheritedToken: "", processToken, manageProcessTitle: false, waitMilliseconds: 0, signal: options.signal };
  const queued = await acquireHeavyRustTestLock({ ...metadata, command: `${profile}: ${metadata.command ?? "heavy phase"}`, capacity_aware: true },
    { ...common, lockPath: path.join(root, "queue", name) });
  const started = performance.now();
  const deadline = started + (options.waitMs ?? config.waitMs);
  let nextReport = 0;
  const acquired = [];
  let admitted = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const waiting = await queueOwners(root);
      const legacy = await legacyBlocker(config, environment);
      if (waiting[0]?.name === name && !legacy) {
        for (let slot = 0; slot < config.slots && acquired.length < units; slot++) {
          try {
            acquired.push(await acquireHeavyRustTestLock({ ...metadata, command: `${profile}: ${metadata.command ?? "heavy phase"}`, capacity_aware: true },
              { ...common, lockPath: path.join(root, `slot-${slot}`) }));
          } catch (error) { if (error.code !== "PORTCOVE_RESOURCE_BUSY") throw error; }
        }
        if (acquired.length === units) { admitted = true; break; }
        for (const lock of acquired.splice(0)) await lock.release();
      }
      const elapsed = Math.round(performance.now() - started);
      if (performance.now() >= deadline)
        throw Object.assign(new Error(`Resource admission timed out after ${elapsed}ms; ${profile} has not started`), { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" });
      if (performance.now() >= nextReport) {
        const holder = legacy ?? (await observeCapacity({ root })).running.find((entry) => entry.activity);
        (options.report ?? console.error)(`Waiting for host capacity (${profile}, ${units}/${config.slots} slots); queued ${elapsed}ms; owner ${holder?.workspace ?? waiting[0]?.workspace ?? "unknown"}, command ${holder?.command ?? waiting[0]?.command ?? "unknown"}.`);
        nextReport = performance.now() + 30_000;
      }
      await delay(Math.min(options.pollMs ?? 250, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
    }
    const queueMs = Math.round(performance.now() - started);
    const lease = { root, profile, slots: acquired.map((lock) => ({ name: path.basename(lock.lockPath), token: lock.owner.token })) };
    return {
      inherited: false, queueMs, reference: lease,
      childEnvironment: { [inheritedName]: JSON.stringify(lease), PORTCOVE_HEAVY_RUST_PROCESS_TOKEN: processToken },
      registerChild: async (child, registration) => {
        for (const lock of acquired) await lock.registerChild(child, registration);
      },
      registerExternal: async (external) => {
        for (const lock of acquired) await writeFile(`${lock.lockPath}.external-${lock.owner.token}`, JSON.stringify(external), { flag: "wx" });
      },
      release: async () => {
        for (const lock of acquired) {
          await rm(`${lock.lockPath}.external-${lock.owner.token}`, { force: true });
          await lock.release();
        }
        if (process.platform === "darwin") process.title = originalTitle;
      },
    };
  } finally {
    await queued.release();
    if (!admitted) {
      for (const lock of acquired) await lock.release();
      if (process.platform === "darwin") process.title = originalTitle;
    }
  }
}

// Called only after the existing adapter proves the exact labelled remote workload stopped.
export async function reconcileExternalCapacity(lease, external, proveStopped) {
  if (!await proveStopped()) throw new Error("External resource work is not proven stopped");
  for (const slot of references(lease, resourceDomainRoot())) {
    const owner = await readHeavyRustLockOwner(slot.path);
    if (owner.token !== slot.token || JSON.stringify(owner.external) !== JSON.stringify(external))
      throw new Error("External resource custody differs; retaining the reservation");
    if (readProcessIdentity(owner.process.pid, { processToken: owner.process.process_token }) === owner.process.identity)
      throw new Error("External resource caller is still active; let it finish its own cleanup");
    await rm(`${slot.path}.external-${slot.token}`);
    await releaseHeavyRustLock(slot.path, slot.token);
  }
}
