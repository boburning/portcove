import { errorCode, isRecord } from "./runtime-values.mts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProcessLockOwner {
  format_version: 1;
  pid: number;
  token: string;
  created_at: string;
  workspace?: unknown;
  command?: unknown;
}
export interface ProcessLockMetadata {
  workspace?: string | null;
  command?: string;
  profile?: string | null;
  scenarios?: readonly string[];
}
export interface ProcessLockOptions {
  label?: string;
  isProcessAlive?: (pid: number) => boolean;
  inheritedToken?: string | undefined;
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

export async function acquireOwnedProcessLock(
  lockPath: string,
  metadata: ProcessLockMetadata = {},
  options: ProcessLockOptions = {},
) {
  const resolved = path.resolve(lockPath);
  const label = options.label ?? "Process";
  const alive = options.isProcessAlive ?? isProcessAlive;
  const inheritedToken = options.inheritedToken;
  if (inheritedToken) {
    const owner = await readOwner(resolved, label);
    if (owner.token !== inheritedToken)
      throw new Error(`${label} inherited lock token does not match the active owner`);
    return { lockPath: resolved, owner, inherited: true, release: async () => {} };
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const owner = {
      format_version: 1,
      token,
      pid: process.pid,
      created_at: new Date().toISOString(),
      process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      ...metadata,
    };
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
      return {
        lockPath: resolved,
        owner,
        inherited: false,
        release: () => releaseOwnedLock(resolved, token, label),
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const active = await readOwner(resolved, label);
      if (alive(active.pid)) {
        throw new Error(
          `${label} is already owned by PID ${active.pid} since ${active.created_at}` +
            (active.workspace ? ` (workspace ${active.workspace})` : ""),
        );
      }
      const stalePath = `${resolved}.stale-${randomUUID()}`;
      try {
        await rename(resolved, stalePath);
      } catch (renameError) {
        if (["ENOENT", "EEXIST"].includes(errorCode(renameError) ?? "")) continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true });
    }
  }
  throw new Error(`${label} lock changed repeatedly; retry after the active run settles`);
}
