import { replacePreparedFile } from "./prepared-file-replacement.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type {
  ResourceConfiguration,
  WindowsHostBridge,
  ResourceRecoveryReference,
} from "./resource-paths.mts";
import type {
  HeavyRustLock,
  HeavyRustLockOptions,
  HeavyRustMetadata,
  HeavyProcessRecord,
  ProcessIdentityOptions,
  ChildRegistration,
} from "./heavy-rust-test-lock.mts";

type ResourceProfile = "rust" | "browser" | "analysis" | "container" | "maintenance";
interface ReservationSlot {
  name: string;
  token: string;
}
export interface ResourceReference {
  root: string;
  slots: ReservationSlot[];
  exclusive?: ReservationSlot[];
  profile?: string;
}
export interface ResourceLease {
  inherited: boolean;
  queueMs: number;
  reference?: ResourceReference;
  childEnvironment: NodeJS.ProcessEnv;
  registerChild: (
    child: { pid?: number | undefined },
    registration?: ChildRegistration,
  ) => Promise<HeavyProcessRecord | null | undefined>;
  registerExternal?: (external: unknown) => Promise<void>;
  release: () => Promise<void>;
}
export interface ResourceMetadata extends HeavyRustMetadata {
  cwd?: string;
}
export interface ResourceCapacityOptions {
  recoveryReceipt?: ResourceRecoveryReference;
  hostRecoveryReceipt?: ResourceRecoveryReference;
  root?: string;
  environment?: NodeJS.ProcessEnv;
  exclusive?: readonly string[];
  signal?: AbortSignal | undefined;
  waitMs?: number;
  command?: string;
  pollMs?: number;
  report?: (message: string) => void;
  legacyBlocker?: typeof legacyBlocker;
  snapshot?: () => unknown;
  expectedSource?: unknown;
}
function causeCode(value: unknown) {
  return isRecord(value) ? errorCode(value.cause) : undefined;
}
function diagnosticText(value: unknown) {
  return String(value);
}
import {
  resourceDomainRoot,
  resourceConfiguration,
  verifyResourceRecoveryReference,
} from "./resource-paths.mts";
import { resolvePhysicalPath } from "./dev-storage.mts";
import { fallowSource } from "./fallow-source.mts";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireHeavyRustTestLock,
  heavyRustOwnerActivity,
  readHeavyRustLockOwner,
  readProcessIdentity,
  releaseHeavyRustLock,
} from "./heavy-rust-test-lock.mts";
import { acquireOwnedProcessLock, readProcessLockOwner } from "./process-lock.mts";

const processToken = randomUUID().replaceAll("-", "").slice(0, 16);
let identityUsers = 0;
let originalTitle = "";
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
const resourceProfiles = Object.freeze({
  rust: 1,
  browser: 1,
  analysis: 1,
  container: 2,
  maintenance: 8,
});

export { resourceDomainRoot } from "./resource-paths.mts";

export function frontendOutputResource(workspace: string) {
  const physical = resolvePhysicalPath(workspace);
  return `exclusive-${createHash("sha256")
    .update(process.platform === "win32" ? physical.toLowerCase() : physical)
    .digest("hex")}`;
}

export { resourceConfiguration } from "./resource-paths.mts";

function legacyRoots(config: ResourceConfiguration, environment: NodeJS.ProcessEnv) {
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
        .filter((value): value is string => Boolean(value))
        .map((value) => path.resolve(value)),
    ),
  ];
}

async function missingAllowed<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if ((causeCode(error) ?? errorCode(error)) === "ENOENT") return null;
    throw error;
  }
}

async function legacyBlocker(config: ResourceConfiguration, environment: NodeJS.ProcessEnv) {
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
async function legacyBridge(
  config: ResourceConfiguration,
  environment: NodeJS.ProcessEnv,
  metadata: HeavyRustMetadata,
  common: HeavyRustLockOptions,
) {
  const held: { release: () => Promise<void> }[] = [];
  try {
    const { acquireNativeSessionLock, legacyNativeSessionLockPath } =
      await import("./native-session-lock.mts");
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

export async function observeCapacity(options: { root?: string } = {}) {
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
  root: string,
  activeOnly = true,
  inspectProcessIdentity = readProcessIdentity,
  options: { deadline?: number; firstOnly?: boolean } = {},
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

function references(lease: unknown, root: string) {
  if (
    !isRecord(lease) ||
    lease.root !== root ||
    !Array.isArray(lease.slots) ||
    !lease.slots.length ||
    lease.slots.length > 8 ||
    lease.slots.some(
      (slot: unknown) =>
        !isRecord(slot) ||
        typeof slot.name !== "string" ||
        !/^slot-[0-7]$/u.test(slot.name) ||
        typeof slot.token !== "string",
    ) ||
    new Set((lease.slots as ReservationSlot[]).map((slot) => slot.name)).size !== lease.slots.length
  )
    throw new Error("Inherited resource reservation has an invalid domain or slot inventory");
  const exclusive = lease.exclusive ?? [];
  if (
    !Array.isArray(exclusive) ||
    exclusive.some(
      (slot: unknown) =>
        !isRecord(slot) ||
        typeof slot.name !== "string" ||
        !/^exclusive-[a-f0-9]{64}$/u.test(slot.name) ||
        typeof slot.token !== "string",
    )
  )
    throw new Error("Invalid exclusive output reservation");
  // Both inventories have just been checked element by element above.
  return [...(lease.slots as ReservationSlot[]), ...(exclusive as ReservationSlot[])].map(
    (slot) => ({
      ...slot,
      path: path.join(root, slot.name),
    }),
  );
}

/** Acquire all needed slots before payload launch, with FIFO waiting and no partial hold while queued. */
export async function acquireResourceCapacity(
  profile: string,
  metadata: ResourceMetadata = {},
  options: ResourceCapacityOptions = {},
): Promise<ResourceLease> {
  const environment = options.environment ?? process.env;
  if (
    process.platform === "linux" &&
    environment.GITHUB_ACTIONS !== "true" &&
    environment.PORTCOVE_CONTAINER_GUEST !== "1"
  ) {
    const config = await resourceConfiguration(options.root ?? resourceDomainRoot());
    if (config.hostBridge) {
      const { acquireBridgedCapacity, verifyBridgedCapacity } =
        await import("./resource-host-bridge.mts");
      if (environment[inheritedName]) {
        await verifyBridgedCapacity(config.hostBridge, environment);
        return acquireLocalResourceCapacity(profile, metadata, options);
      }
      return acquireBridgedCapacity(
        config.hostBridge,
        profile,
        metadata,
        { ...options, waitMs: options.waitMs ?? config.waitMs },
        (remaining) =>
          acquireLocalResourceCapacity(profile, metadata, { ...options, waitMs: remaining }),
      );
    }
  }
  return acquireLocalResourceCapacity(profile, metadata, options);
}

async function acquireLocalResourceCapacity(
  profile: string,
  metadata: ResourceMetadata = {},
  options: ResourceCapacityOptions = {},
): Promise<ResourceLease> {
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
  let capacity = config.slots;
  if (options.recoveryReceipt)
    capacity = Math.max(
      capacity,
      await verifyResourceRecoveryReference(root, options.recoveryReceipt),
    );
  const units = Math.min(capacity, resourceProfiles[profile as ResourceProfile]);
  if (options.recoveryReceipt) {
    if (profile !== "maintenance")
      throw new Error("Recovery admission requires the all-slot maintenance profile");
    await verifyResourceRecoveryReference(root, options.recoveryReceipt);
  }
  const exclusive = [...new Set(options.exclusive ?? [])].sort();
  if (exclusive.some((name) => !/^exclusive-[a-f0-9]{64}$/u.test(name)))
    throw new Error("Invalid output reservation identity");
  if (environment[inheritedName]) {
    const lease: unknown = JSON.parse(environment[inheritedName]);
    const slots = references(lease, root);
    if (slots.filter((slot) => slot.name.startsWith("slot-")).length < units)
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
  const inspectProcessIdentity = (pid: number, options?: ProcessIdentityOptions) =>
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
  if (options.recoveryReceipt) {
    try {
      await writeFile(
        path.join(root, "queue", name) + ".recovery-" + queued.owner.token,
        JSON.stringify(options.recoveryReceipt),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await queued.release();
      releaseIdentity();
      throw error;
    }
  }
  const started = performance.now();
  const waitMs = options.waitMs ?? config.waitMs;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3_600_000) {
    await rm(path.join(root, "queue", name) + ".recovery-" + queued.owner.token, { force: true });
    await queued.release();
    releaseIdentity();
    throw new Error("Resource waitMs must be 0..3600000");
  }
  const deadline = started + waitMs;
  let nextReport = 0;
  const acquired: HeavyRustLock[] = [];
  let admitted = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        const currentConfig = await resourceConfiguration(root);
        const inventory = await readdir(root);
        const pendingRecovery =
          options.recoveryReceipt &&
          (currentConfig.legacyMode !== "coordinated" ||
            inventory.some(
              (file) => /^slot-\d+$/u.test(file) && Number(file.slice(5)) >= currentConfig.slots,
            ));
        const waiting = await queueOwners(root, true, inspectProcessIdentity, {
          firstOnly: !pendingRecovery,
          deadline: waitMs === 0 ? started + 5_000 : deadline,
        });
        const legacy = await (options.legacyBlocker ?? legacyBlocker)(config, environment);
        const outsideConfiguredCapacity = inventory.some(
          (file) => /^slot-\d+$/u.test(file) && Number(file.slice(5)) >= capacity,
        );
        let eligible = waiting[0]?.name;
        if (pendingRecovery) {
          eligible = undefined;
          for (const owner of waiting) {
            const raw = await missingAllowed(() =>
              readFile(path.join(root, "queue", owner.name) + ".recovery-" + owner.token, "utf8"),
            );
            if (raw === null) continue;
            if (raw.length > 8192) throw new Error("Recovery queue reference exceeds bound");
            const reference: unknown = JSON.parse(raw);
            if (
              !isRecord(reference) ||
              typeof reference.file !== "string" ||
              typeof reference.sha256 !== "string"
            )
              throw new Error("Invalid recovery queue reference");
            await verifyResourceRecoveryReference(root, {
              file: reference.file,
              sha256: reference.sha256,
            });
            eligible = owner.name;
            break;
          }
        }
        if (eligible === name && !legacy && !outsideConfiguredCapacity) {
          if (currentConfig.legacyMode !== "coordinated" && !options.recoveryReceipt) {
            if (performance.now() >= deadline)
              throw Object.assign(
                new Error(
                  "Resource handover is pending; no payload started. Finish legacy work and run retire-legacy-entrypoints from an updated checkout.",
                ),
                { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
              );
            if (performance.now() >= nextReport) {
              (options.report ?? console.error)(
                `Resource handover pending; ${profile} queued ${Math.round(performance.now() - started)}ms. Drain old heavy/native/container work, retire old entrypoints, then run resource-command.mts retire-legacy-entrypoints.`,
              );
              nextReport = performance.now() + 30_000;
            }
            await delay(
              Math.min(options.pollMs ?? 5_000, Math.max(1, deadline - performance.now())),
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
          if (options.recoveryReceipt)
            await verifyResourceRecoveryReference(root, options.recoveryReceipt);
          for (let slot = 0; slot < capacity && acquired.length < units; slot++) {
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
              if (errorCode(error) !== "PORTCOVE_RESOURCE_BUSY" && causeCode(error) !== "ENOENT")
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
                if (errorCode(error) !== "PORTCOVE_RESOURCE_BUSY" && causeCode(error) !== "ENOENT")
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
            new Error(
              `Resource admission timed out after ${elapsed}ms; ${profile} has not started`,
            ),
            { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
          );
        if (performance.now() >= nextReport) {
          const holder =
            legacy ?? (await observeCapacity({ root })).running.find((entry) => entry.activity);
          (options.report ?? console.error)(
            `Waiting for host capacity (${profile}, ${units}/${config.slots} slots); queued ${elapsed}ms; owner ${diagnosticText(holder?.workspace ?? waiting[0]?.workspace ?? "unknown")}, command ${diagnosticText(holder?.command ?? waiting[0]?.command ?? "unknown")}.`,
          );
          nextReport = performance.now() + 30_000;
        }
        await delay(
          Math.min(options.pollMs ?? 5_000, Math.max(1, deadline - performance.now())),
          undefined,
          { signal: options.signal },
        );
      } catch (error) {
        if (errorCode(error) !== "PORTCOVE_PROCESS_IDENTITY_UNAVAILABLE") throw error;
        for (const lock of acquired.splice(0)) await lock.release();
        if (performance.now() >= deadline)
          throw Object.assign(
            new Error(
              "Resource admission timed out with process identity unavailable; no payload started",
            ),
            { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
          );
        if (performance.now() >= nextReport) {
          (options.report ?? console.error)(
            `Waiting for verified process identity (${profile}); queued ${Math.round(performance.now() - started)}ms; ${errorMessage(error)}. No payload started.`,
          );
          nextReport = performance.now() + 30_000;
        }
        await delay(
          Math.min(options.pollMs ?? 5_000, Math.max(1, deadline - performance.now())),
          undefined,
          { signal: options.signal },
        );
      }
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
    let releasePromise: Promise<void> | undefined;
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
          const first = acquired[0];
          if (!first) throw new Error("Admitted resource reservation has no slots");
          const external = await missingAllowed(() =>
            readFile(`${first.lockPath}.external-${first.owner.token}`, "utf8"),
          );
          if (external) await releaseExternalRecords(lease, JSON.parse(external), root, false);
          else for (const lock of acquired) await lock.release();
          releaseIdentity();
        })()),
    };
  } finally {
    await rm(path.join(root, "queue", name) + ".recovery-" + queued.owner.token, { force: true });
    await queued.release();
    if (!admitted) {
      for (const lock of acquired) await lock.release();
      releaseIdentity();
    }
  }
}

/** Maintenance uses the same all-slot leases on both sides, including rollback
 * after Linux has already opted into host forwarding. No payload bypass flag. */
export async function runResourceHostTransition(
  bridge: WindowsHostBridge,
  args: string[],
  recovery?: { local: ResourceRecoveryReference; host: ResourceRecoveryReference },
) {
  const { acquireBridgedCapacity } = await import("./resource-host-bridge.mts");
  const { runRustTests } = await import("./run-rust-tests.mts");
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  const before = fallowSource(workspace, undefined, { includeAll: true });
  return runRustTests(["--guard-command", process.execPath, ...args], {
    executionTimeoutMilliseconds: 120_000,
    acquireLock: async (metadata, options) => {
      const lease = await acquireBridgedCapacity(
        bridge,
        "maintenance",
        metadata,
        {
          ...options,
          waitMs: 900_000,
          ...(recovery ? { hostRecoveryReceipt: recovery.host } : {}),
        },
        (remaining) =>
          acquireLocalResourceCapacity("maintenance", metadata, {
            ...options,
            waitMs: remaining,
            ...(recovery ? { recoveryReceipt: recovery.local } : {}),
          }),
      );
      if (
        JSON.stringify(before) !==
        JSON.stringify(fallowSource(workspace, undefined, { includeAll: true }))
      ) {
        await lease.release();
        throw new Error("Transition source changed while waiting; no configuration changed");
      }
      return lease;
    },
  });
}

// A durable decision precedes any removal. Retrying after a crash may observe
// missing slots or successors; the journal authorizes only the original tokens.
async function releaseExternalRecords(
  lease: unknown,
  external: unknown,
  root: string,
  requireDead: boolean,
) {
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
          errorCode(error) !== "EEXIST" ||
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
export async function reconcileExternalCapacity(
  lease: unknown,
  external: unknown,
  proveStopped: () => boolean | Promise<boolean>,
  options: { root?: string } = {},
) {
  if (!(await proveStopped())) throw new Error("External resource work is not proven stopped");
  return releaseExternalRecords(lease, external, options.root ?? resourceDomainRoot(), true);
}

export async function capacityChildrenStopped(lease: unknown, options: { root?: string } = {}) {
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
export async function acquireSourceBoundCapacity(
  profile: string,
  metadata: ResourceMetadata,
  options: ResourceCapacityOptions = {},
) {
  const environment = options.environment ?? process.env;
  if (
    environment[inheritedName] ||
    environment.GITHUB_ACTIONS === "true" ||
    environment.PORTCOVE_CONTAINER_GUEST === "1"
  )
    return acquireResourceCapacity(profile, metadata, options);
  const workspace = metadata.workspace;
  if (!options.snapshot && typeof workspace !== "string")
    throw new Error("Source-bound capacity requires a workspace");
  const snapshot =
    options.snapshot ??
    (() => {
      if (typeof workspace !== "string")
        throw new Error("Source-bound capacity requires a workspace");
      return fallowSource(workspace, undefined, { includeAll: true });
    });
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
export async function retireLegacyEntrypoints(
  options: { root?: string; environment?: NodeJS.ProcessEnv; workspace?: string } = {},
) {
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
    await replacePreparedFile(temporary, path.join(root, "config.json"));
    return { root, config: receipt.next, evidence };
  } finally {
    for (const lock of bridge.held.reverse()) await lock.release();
  }
}
