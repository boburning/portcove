import { errorCode, isRecord } from "./runtime-values.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface ProcessLockOwner {
  format_version: 1;
  pid: number;
  token: string;
  created_at: string;
  workspace?: unknown;
  command?: unknown;
  process_identity?: unknown;
  namespace_delegation?: unknown;
  legacy_token?: unknown;
  capacity_aware?: unknown;
}
export interface ProcessLockMetadata {
  workspace?: string | null | undefined;
  command?: string | null | undefined;
  profile?: string | null;
  scenarios?: readonly string[];
  namespaceDelegation?: boolean;
  capacity_aware?: boolean;
  namespace_delegation?: boolean;
  legacy_token?: string;
}
export interface ProcessLockOptions {
  label?: string;
  isProcessAlive?: (pid: number) => boolean;
  inheritedToken?: string | undefined;
  inspectProcessIdentity?: ((pid: number) => string | null) | undefined;
  verifyIdentity?: boolean;
  ownerToken?: string | undefined;
  canReclaim?: boolean;
  expectedStaleOwner?: Pick<ProcessLockOwner, "token" | "pid" | "created_at" | "process_identity">;
}
function diagnosticText(value: unknown): string {
  return String(value);
}

function isLockOwner(owner: unknown): owner is ProcessLockOwner {
  return (
    isRecord(owner) &&
    owner.format_version === 1 &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.created_at === "string" &&
    !Number.isNaN(Date.parse(owner.created_at))
  );
}

export function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readOwner(lockPath: string, label: string) {
  const ownerPath = path.join(lockPath, "owner.json");
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} lock exists but its owner is unreadable: ${ownerPath}`, {
      cause: error,
    });
  }
  if (!isLockOwner(owner)) {
    throw new Error(`${label} lock has invalid owner metadata: ${ownerPath}`);
  }
  return owner;
}

export const readProcessLockOwner = readOwner;

async function releaseOwnedLock(lockPath: string, token: string, label: string) {
  let owner;
  try {
    owner = await readOwner(lockPath, label);
  } catch (error) {
    if (isRecord(error) && errorCode(error.cause) === "ENOENT") return;
    throw error;
  }
  if (owner.token !== token)
    throw new Error(`${label} lock ownership changed before release; refusing removal`);
  const released = `${lockPath}.released-${token}`;
  await rename(lockPath, released);
  await rm(released, { recursive: true });
}

async function reclaimStaleOwner(
  resolved: string,
  active: ProcessLockOwner,
  verifiedActive: (owner: ProcessLockOwner) => boolean,
  label: string,
) {
  // Retain one exclusive claim for this exact stale owner, as the Rust-test
  // lock does. Deleting the claim would let a delayed observer claim the old
  // token again and rename a successor. Hash metadata before using it in a path.
  const identity = createHash("sha256")
    .update(JSON.stringify([active.token, active.pid, active.created_at, active.process_identity]))
    .digest("hex");
  const claim = `${resolved}.reclaim-${identity}`;
  try {
    await mkdir(claim);
  } catch (claimError) {
    if (errorCode(claimError) === "EEXIST") return;
    throw claimError;
  }
  const current = await readOwner(resolved, label);
  if (
    current.token !== active.token ||
    current.pid !== active.pid ||
    current.created_at !== active.created_at ||
    current.process_identity !== active.process_identity ||
    verifiedActive(current)
  )
    return;
  const stalePath = `${resolved}.stale-${randomUUID()}`;
  try {
    await rename(resolved, stalePath);
  } catch (renameError) {
    if (["ENOENT", "EEXIST"].includes(errorCode(renameError) ?? "")) return;
    throw renameError;
  }
  await rm(stalePath, { recursive: true });
}

export async function acquireOwnedProcessLock(
  lockPath: string,
  metadata: ProcessLockMetadata = {},
  options: ProcessLockOptions = {},
) {
  const resolved = path.resolve(lockPath);
  const label = options.label ?? "Process";
  const alive = options.isProcessAlive ?? isProcessAlive;
  const inheritedToken = options.inheritedToken;
  const inspectIdentity = options.inspectProcessIdentity ?? readProcessIdentity;
  const verifiedActive = (owner: ProcessLockOwner) =>
    options.verifyIdentity
      ? typeof owner.process_identity === "string" &&
        inspectIdentity(owner.pid) === owner.process_identity
      : alive(owner.pid);
  if (inheritedToken) {
    const owner = await readOwner(resolved, label);
    if (owner.token !== inheritedToken)
      throw new Error(`${label} inherited lock token does not match the active owner`);
    if (options.verifyIdentity && !verifiedActive(owner))
      throw new Error(`${label} inherited lock lacks a verified live creation identity`);
    return { lockPath: resolved, owner, inherited: true, release: async () => {} };
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = options.ownerToken ?? randomUUID();
    const owner = {
      format_version: 1 as const,
      token,
      pid: process.pid,
      created_at: new Date().toISOString(),
      process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      ...metadata,
      ...(options.verifyIdentity ? { process_identity: inspectIdentity(process.pid) } : {}),
    };
    if (options.verifyIdentity && !owner.process_identity)
      throw new Error(`${label} process creation identity is unavailable`);
    try {
      await mkdir(resolved);
      try {
        await writeFile(path.join(resolved, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          flag: "wx",
        });
      } catch (error) {
        await rm(resolved, { recursive: true }).catch(() => {});
        throw error;
      }
      let released: Promise<void> | undefined;
      return {
        lockPath: resolved,
        owner,
        inherited: false,
        release: () => (released ??= releaseOwnedLock(resolved, token, label)),
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const active = await readOwner(resolved, label);
      const expected = options.expectedStaleOwner;
      if (
        expected &&
        (active.token !== expected.token ||
          active.pid !== expected.pid ||
          active.created_at !== expected.created_at ||
          active.process_identity !== expected.process_identity)
      )
        throw Object.assign(new Error(`${label} recovery owner changed; retaining ${resolved}`), {
          code: "PORTCOVE_RESOURCE_RECOVERY_REQUIRED",
        });
      if (verifiedActive(active)) {
        throw Object.assign(
          new Error(
            `${label} is already owned by PID ${active.pid} since ${active.created_at}` +
              (active.workspace ? ` (workspace ${diagnosticText(active.workspace)})` : ""),
          ),
          { code: "PORTCOVE_RESOURCE_BUSY", owner: active },
        );
      }
      if (options.canReclaim === false)
        throw Object.assign(
          new Error(
            `${label} owner exited or changed identity without quiescence proof; retaining ${resolved}`,
          ),
          { code: "PORTCOVE_RESOURCE_RECOVERY_REQUIRED" },
        );
      await reclaimStaleOwner(resolved, active, verifiedActive, label);
    }
  }
  throw new Error(`${label} lock changed repeatedly; retry after the active run settles`);
}
