import type { ResourceConfiguration, WindowsHostBridge } from "./resource-paths.mts";
import {
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { errorCode, isRecord } from "./runtime-values.mts";
import {
  resourceConfiguration,
  resourceDomainRoot,
  validWindowsHostBridge,
  recoverySlotInventory,
} from "./resource-paths.mts";
import { acquireResourceCapacity, runResourceHostTransition } from "./resource-capacity.mts";
import { verifyBridgedCapacity, observeBridgedCapacity } from "./resource-host-bridge.mts";
import { readScratchProfile, verifyScratchProfile } from "./development-scratch.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (file: string): string | null => {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error("Invalid transition input: " + file);
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Compare the saved preimage immediately before an atomic replacement. */
export function replaceResourceConfiguration(
  file: string,
  previous: string | null,
  next: string | null,
) {
  if (bytes(file) !== previous) throw new Error("Configuration changed before transition: " + file);
  if (next === null) {
    if (previous !== null) unlinkSync(file);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const pending = file + ".next-" + randomUUID();
  writeFileSync(pending, next, { flag: "wx", mode: 0o600 });
  if (bytes(file) !== previous) throw new Error("Configuration changed during transition: " + file);
  renameSync(pending, file);
}

export function hostTransitionConfiguration(
  previous: ResourceConfiguration,
  bridge?: WindowsHostBridge,
) {
  if (previous.legacyMode !== "coordinated")
    throw new Error("Resolve the retained pending transition before starting another");
  return { ...previous, slots: 1, nodeSuites: true, ...(bridge ? { hostBridge: bridge } : {}) };
}

export interface Change {
  file: string;
  previous: string | null;
  next: string | null;
}
export interface TransitionReceipt {
  format: 1;
  operation: "adopt" | "rollback" | "recover";
  id: string;
  createdAt: string;
  bridge: WindowsHostBridge;
  changes: Change[];
  linuxRoot: string;
  windowsRoot: string;
  windowsNativeRoot: string;
}
function parseReceipt(value: unknown): TransitionReceipt {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.operation !== "string" ||
    !["adopt", "rollback", "recover"].includes(value.operation) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.id) ||
    typeof value.createdAt !== "string" ||
    !validWindowsHostBridge(value.bridge) ||
    !Array.isArray(value.changes) ||
    value.changes.length !== 4 ||
    typeof value.linuxRoot !== "string" ||
    typeof value.windowsRoot !== "string" ||
    typeof value.windowsNativeRoot !== "string" ||
    !path.win32.isAbsolute(value.windowsNativeRoot)
  )
    throw new Error("Invalid resource transition receipt");
  const changes: unknown[] = value.changes;
  for (const change of changes)
    if (
      !isRecord(change) ||
      typeof change.file !== "string" ||
      !(change.previous === null || typeof change.previous === "string") ||
      !(change.next === null || typeof change.next === "string")
    )
      throw new Error("Invalid resource transition preimages");
  return value as unknown as TransitionReceipt;
}

function pendingConfiguration(previous: string | null) {
  const value: unknown = JSON.parse(previous ?? "{}");
  if (!isRecord(value)) throw new Error("Configuration preimage must be an object");
  return serialize({ ...value, legacyMode: "pending" });
}

/** Restore only a recorded predecessor, successor or exact staged pending
 * value. An unrelated edit is not evidence authorizing recovery. */
export function recoveryConfigurationChanges(changes: Change[], inspect = bytes): Change[] {
  if (changes.length !== 4) throw new Error("Recovery requires all four recorded files");
  return changes.map((change, index) => {
    const current = inspect(change.file);
    const allowed = [change.previous, change.next];
    if (index < 2)
      allowed.push(pendingConfiguration(change.previous), pendingConfiguration(change.next));
    if (!allowed.includes(current))
      throw new Error("Unknown interrupted-transition preimage: " + change.file);
    return { file: change.file, previous: current, next: change.previous };
  });
}

function profileFiles(windowsRoot: string) {
  return [
    path.join(os.homedir(), ".config/portcove/development-scratch.json"),
    path.join(path.dirname(path.dirname(windowsRoot)), ".config/portcove/development-scratch.json"),
  ];
}

async function applyTransition(operation: string, input: string, expectedDigest: string) {
  if (!process.env.PORTCOVE_RESOURCE_RESERVATION || !process.env.PORTCOVE_HOST_RESOURCE)
    throw new Error("Resource transition requires both original live reservations");
  const supplied = bytes(input);
  if (supplied === null) throw new Error("Missing transition input");
  if (digest(supplied) !== expectedDigest) throw new Error("Transition input changed while queued");
  const parsed: unknown = JSON.parse(supplied);
  const rollback = operation !== "adopt" ? parseReceipt(parsed) : undefined;
  const bridge = rollback?.bridge ?? parsed;
  if (!validWindowsHostBridge(bridge)) throw new Error("Invalid Windows bridge configuration");
  await verifyBridgedCapacity(bridge, process.env);
  const inherited: unknown = JSON.parse(process.env.PORTCOVE_RESOURCE_RESERVATION ?? "null");
  const host: unknown = JSON.parse(process.env.PORTCOVE_HOST_RESOURCE ?? "null");
  if (
    !isRecord(inherited) ||
    inherited.root !== resourceDomainRoot() ||
    !Array.isArray(inherited.slots) ||
    !isRecord(host) ||
    !isRecord(host.reference) ||
    typeof host.reference.root !== "string" ||
    !Array.isArray(host.reference.slots)
  )
    throw new Error("Resource transition requires both original live reservations");
  const windowsRoot = execFileSync("wslpath", ["-u", host.reference.root], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8192,
  }).trim();
  const linuxRoot = resourceDomainRoot();
  const configFiles = [path.join(linuxRoot, "config.json"), path.join(windowsRoot, "config.json")];
  const scratchFiles = profileFiles(windowsRoot);
  const linuxConfig = await resourceConfiguration();
  const observed: unknown = await observeBridgedCapacity(bridge);
  if (
    !isRecord(observed) ||
    !isRecord(observed.capacity) ||
    !isRecord(observed.capacity.config) ||
    observed.capacity.root !== host.reference.root
  )
    throw new Error("Host configuration observation is unavailable");
  const windowsConfig = observed.capacity.config as unknown as ResourceConfiguration;
  const requiredLinux = Math.max(
    linuxConfig.slots,
    operation === "recover" && rollback ? recoverySlotInventory(rollback.changes, 0) : 0,
  );
  const requiredWindows = Math.max(
    windowsConfig.slots,
    operation === "recover" && rollback ? recoverySlotInventory(rollback.changes, 1) : 0,
  );
  if (
    inherited.profile !== "maintenance" ||
    host.reference.profile !== "maintenance" ||
    inherited.slots.length !== requiredLinux ||
    host.reference.slots.length !== requiredWindows
  )
    throw new Error("Transition must hold every predecessor slot under maintenance ownership");
  const local = await acquireResourceCapacity("maintenance", { workspace: root });
  if (!local.inherited)
    throw new Error("Transition cannot create an independent local reservation");
  const files = [...configFiles, ...scratchFiles];
  let changes: Change[];
  if (rollback) {
    if (
      rollback.linuxRoot !== linuxRoot ||
      rollback.windowsRoot !== windowsRoot ||
      rollback.windowsNativeRoot !== host.reference.root ||
      rollback.changes.some((change, index) => change.file !== files[index])
    )
      throw new Error("Rollback targets differ from this user's resource/profile domain");
    const original = path.join(linuxRoot, "migrations", rollback.id + "-host-domain.json");
    const hostOriginal = path.join(windowsRoot, "migrations", rollback.id + "-host-domain.json");
    if (bytes(hostOriginal) !== supplied) throw new Error("Original host receipt differs");
    if (path.resolve(input) !== original || rollback.operation === "recover")
      throw new Error("Restore the original adoption/rollback receipt in this resource domain");
    if (
      operation === "rollback" &&
      (rollback.operation !== "adopt" ||
        bytes(original + ".applied") !== digest(supplied) ||
        bytes(hostOriginal + ".applied") !== digest(supplied))
    )
      throw new Error("Rollback is not bound to an applied original adoption receipt");
    changes =
      operation === "recover"
        ? recoveryConfigurationChanges(rollback.changes)
        : rollback.changes.map((change) => ({
            file: change.file,
            previous: change.next,
            next: change.previous,
          }));
  } else {
    const preparedLinux = readScratchProfile(
      scratchFiles[0]!.replace(/\.json$/u, ".prepared.json"),
    );
    if (!preparedLinux) throw new Error("Prepare and qualify the ext4 scratch profile first");
    verifyScratchProfile(preparedLinux);
    const workspaceOutput = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const workspaces = workspaceOutput
      .split("\0")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSync.native(line.slice(9)))
      .sort();
    const linuxProfile = { ...preparedLinux, workspaces };
    const winPrepared = bytes(scratchFiles[1]!.replace(/\.json$/u, ".prepared.json"));
    const winProfile: unknown = winPrepared === null ? null : JSON.parse(winPrepared);
    if (
      !isRecord(winProfile) ||
      winProfile.format !== 1 ||
      typeof winProfile.root !== "string" ||
      !path.win32.isAbsolute(winProfile.root) ||
      !Array.isArray(winProfile.workspaces) ||
      !winProfile.workspaces.length ||
      !winProfile.workspaces.every(
        (file: unknown) => typeof file === "string" && path.win32.isAbsolute(file),
      ) ||
      typeof winProfile.identity !== "string"
    )
      throw new Error("Prepare explicit Windows workspace scopes before adoption");
    const winScratch = execFileSync("wslpath", ["-u", winProfile.root], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const winMarker = bytes(path.join(winScratch, ".portcove-scratch.json"));
    const marker: unknown = winMarker === null ? null : JSON.parse(winMarker);
    if (!isRecord(marker) || marker.identity !== winProfile.identity)
      throw new Error("Prepared Windows scratch ownership differs");
    changes = [
      {
        file: files[0]!,
        previous: bytes(files[0]!),
        next: serialize(hostTransitionConfiguration(linuxConfig, bridge)),
      },
      {
        file: files[1]!,
        previous: bytes(files[1]!),
        next: serialize(hostTransitionConfiguration(windowsConfig)),
      },
      { file: files[2]!, previous: bytes(files[2]!), next: serialize(linuxProfile) },
      { file: files[3]!, previous: bytes(files[3]!), next: serialize(winProfile) },
    ];
  }
  if (changes.every((change) => change.previous === change.next)) {
    console.log(JSON.stringify({ unchanged: true, linuxRoot, windowsRoot }));
    return;
  }
  for (const change of changes)
    if (bytes(change.file) !== change.previous)
      throw new Error("Transition preimage changed: " + change.file);
  const receipt: TransitionReceipt = {
    format: 1,
    operation: operation === "adopt" ? "adopt" : operation === "rollback" ? "rollback" : "recover",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    bridge,
    changes,
    linuxRoot,
    windowsRoot,
    windowsNativeRoot: host.reference.root,
  };
  const receiptFile = commitConfigurationTransaction(receipt);
  console.log(
    JSON.stringify({ receipt: receiptFile, operation, result: "applied", linuxRoot, windowsRoot }),
  );
}

export function commitConfigurationTransaction(receipt: TransitionReceipt) {
  const changes = receipt.changes;
  for (const change of changes)
    if (bytes(change.file) !== change.previous)
      throw new Error("Transaction preimage changed: " + change.file);
  if (changes.every((change) => change.previous === change.next)) return null;
  const receiptBytes = serialize(receipt);
  const receiptFiles = [receipt.linuxRoot, receipt.windowsRoot].map((directory) =>
    path.join(directory, "migrations", receipt.id + "-host-domain.json"),
  );
  for (const file of receiptFiles) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, receiptBytes, { flag: "wx", mode: 0o600 });
  }
  // Both domains' full predecessor capacity remains reserved throughout writes.
  const applied: Change[] = [];
  try {
    for (const change of changes.slice(0, 2)) {
      const pending = pendingConfiguration(change.previous);
      replaceResourceConfiguration(change.file, change.previous, pending);
      applied.push({ file: change.file, previous: change.previous, next: pending });
    }
    for (const change of changes.slice(2)) {
      replaceResourceConfiguration(change.file, change.previous, change.next);
      applied.push(change);
    }
    for (const change of changes.slice(0, 2)) {
      const pending = applied.find((entry) => entry.file === change.file)!;
      replaceResourceConfiguration(change.file, pending.next, change.next);
      pending.next = change.next;
    }
    for (const change of changes)
      if (bytes(change.file) !== change.next)
        throw new Error("Transition readback differs: " + change.file);
    for (const file of receiptFiles)
      writeFileSync(file + ".applied", digest(receiptBytes), { flag: "wx", mode: 0o600 });
    return receiptFiles[0]!;
  } catch (error) {
    for (const change of applied.reverse())
      replaceResourceConfiguration(change.file, change.next, change.previous);
    throw error;
  }
}

export async function transitionHostResources(
  operation: "adopt" | "rollback" | "recover",
  input: string,
) {
  if (process.platform !== "linux") throw new Error("Run Windows-host adoption from its WSL user");
  if (process.env.PORTCOVE_RESOURCE_RESERVATION)
    throw new Error("Start a resource-domain transition outside an existing payload reservation");
  input = path.resolve(input);
  const raw = bytes(input);
  if (raw === null) throw new Error("Missing resource transition input");
  const value: unknown = JSON.parse(raw);
  const receipt = operation !== "adopt" ? parseReceipt(value) : undefined;
  if (receipt?.operation === "recover")
    throw new Error("Recover the original adoption/rollback receipt, not its recovery attempt");
  const bridge = receipt?.bridge ?? value;
  if (!validWindowsHostBridge(bridge)) throw new Error("Invalid Windows bridge configuration");
  const recovery =
    operation === "recover" && receipt
      ? {
          local: { file: input, sha256: digest(raw) },
          host: {
            file: path.win32.join(
              receipt.windowsNativeRoot,
              "migrations",
              receipt.id + "-host-domain.json",
            ),
            sha256: digest(raw),
          },
        }
      : undefined;
  return runResourceHostTransition(
    bridge,
    [script, "--apply", operation, input, digest(raw)],
    recovery,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const [action, operation, input, expectedDigest] = process.argv.slice(2);
  if (
    action !== "--apply" ||
    !["adopt", "rollback", "recover"].includes(operation ?? "") ||
    !input ||
    !expectedDigest ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest)
  )
    throw new Error("Resource adoption is entered through resource-command.mts");
  await applyTransition(operation!, path.resolve(input), expectedDigest);
}
