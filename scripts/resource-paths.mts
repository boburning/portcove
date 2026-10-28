import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { errorCode, isRecord } from "./runtime-values.mts";

export interface ResourceConfiguration {
  slots: number;
  waitMs: number;
  legacyRoots: string[];
  legacyMode: "pending" | "coordinated";
  hostBridge?: WindowsHostBridge;
  nodeSuites?: boolean;
}

export interface ResourceRecoveryReference {
  file: string;
  sha256: string;
}

export function validResourceRecoveryReference(value: unknown): value is ResourceRecoveryReference {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === "file,sha256" &&
    typeof value.file === "string" &&
    path.isAbsolute(value.file) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}

/** Pending admission is available only to an all-slot maintenance request bound
 * to this domain's original immutable migration receipt. Never reclaims a lease. */
export async function verifyResourceRecoveryReference(
  root: string,
  reference: ResourceRecoveryReference,
) {
  if (
    !validResourceRecoveryReference(reference) ||
    path.dirname(reference.file) !== path.join(root, "migrations") ||
    !/^[a-f0-9-]{36}-host-domain\.json$/u.test(path.basename(reference.file))
  )
    throw new Error("Recovery receipt is outside this resource domain");
  const parent = await lstat(path.dirname(reference.file)),
    info = await lstat(reference.file);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024)
    throw new Error("Recovery receipt is not an ordinary bounded file");
  const bytes = await readFile(reference.file, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
    throw new Error("Recovery receipt identity changed");
  const value: unknown = JSON.parse(bytes);
  const recordedRoot = isRecord(value)
    ? value[process.platform === "win32" ? "windowsNativeRoot" : "linuxRoot"]
    : undefined;
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    recordedRoot !== root ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.id) ||
    reference.file !== path.join(root, "migrations", value.id + "-host-domain.json")
  )
    throw new Error("Recovery receipt belongs to another resource domain");
  return recoverySlotInventory(value.changes, process.platform === "win32" ? 1 : 0);
}

export function recoverySlotInventory(changes: unknown, domain: 0 | 1) {
  if (!Array.isArray(changes) || changes.length !== 4)
    throw new Error("Recovery receipt lacks its configuration inventory");
  const change: unknown = changes[domain];
  if (!isRecord(change)) throw new Error("Recovery receipt lacks domain preimages");
  const slots = [change.previous, change.next].map((raw) => {
    if (raw === null) return 2;
    if (typeof raw !== "string") throw new Error("Invalid recovery configuration preimage");
    const config: unknown = JSON.parse(raw);
    const count = isRecord(config) ? (config.slots ?? 2) : undefined;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 8)
      throw new Error("Invalid recovery slot inventory");
    return count;
  });
  return Math.max(...slots);
}

export interface WindowsHostBridge {
  closureSha256: string;
  executable: string;
  script: string;
  distribution: string;
  user: string;
  node: string;
  probe: string;
}

export function validWindowsHostBridge(value: unknown): value is WindowsHostBridge {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") ===
      "closureSha256,distribution,executable,node,probe,script,user" &&
    typeof value.closureSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.closureSha256) &&
    typeof value.executable === "string" &&
    path.posix.isAbsolute(value.executable) &&
    value.executable.endsWith(".exe") &&
    typeof value.script === "string" &&
    path.win32.isAbsolute(value.script) &&
    typeof value.distribution === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.distribution) &&
    typeof value.user === "string" &&
    /^[a-z_][a-z0-9_-]{0,31}$/u.test(value.user) &&
    typeof value.node === "string" &&
    path.posix.isAbsolute(value.node) &&
    typeof value.probe === "string" &&
    path.posix.isAbsolute(value.probe)
  );
}

// Same-user identity is independent of checkout, pins and writable cache settings.
export function resourceDomainRoot() {
  return path.join(homedir(), ".portcove", "resources");
}

export async function resourceConfiguration(root = resourceDomainRoot()) {
  let supplied: unknown = {};
  try {
    supplied = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!isRecord(supplied)) throw new Error("Resource config must be an object");
  const config: unknown = {
    slots: 2,
    waitMs: 900_000,
    legacyRoots: [],
    legacyMode: "pending",
    ...supplied,
  };
  function assertConfiguration(config: unknown): asserts config is ResourceConfiguration {
    if (
      !isRecord(config) ||
      Object.keys(config).some(
        (key) =>
          !["slots", "waitMs", "legacyRoots", "legacyMode", "hostBridge", "nodeSuites"].includes(
            key,
          ),
      ) ||
      (config.nodeSuites !== undefined && typeof config.nodeSuites !== "boolean") ||
      (config.hostBridge !== undefined &&
        (!validWindowsHostBridge(config.hostBridge) || config.slots !== 1)) ||
      (config.legacyMode !== "pending" && config.legacyMode !== "coordinated") ||
      typeof config.slots !== "number" ||
      !Number.isInteger(config.slots) ||
      config.slots < 1 ||
      config.slots > 8 ||
      typeof config.waitMs !== "number" ||
      !Number.isInteger(config.waitMs) ||
      config.waitMs < 0 ||
      config.waitMs > 3_600_000 ||
      !Array.isArray(config.legacyRoots) ||
      config.legacyRoots.some(
        (value: unknown) => typeof value !== "string" || !path.isAbsolute(value),
      )
    )
      throw new Error(
        "Resource config requires slots 1..8, waitMs 0..3600000 and absolute legacyRoots",
      );
  }
  assertConfiguration(config);
  return config;
}
