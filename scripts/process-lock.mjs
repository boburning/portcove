import { readProcessIdentity } from "./heavy-rust-test-lock.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readOwner(lockPath, label) {
  const ownerPath = path.join(lockPath, "owner.json");
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} lock exists but its owner is unreadable: ${ownerPath}`, {
      cause: error,
    });
  }
  if (
    owner?.format_version !== 1 ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    Number.isNaN(Date.parse(owner.created_at))
  ) {
    throw new Error(`${label} lock has invalid owner metadata: ${ownerPath}`);
  }
  return owner;
}

export const readProcessLockOwner = readOwner;

async function releaseOwnedLock(lockPath, token, label) {
  let owner;
  try {
    owner = await readOwner(lockPath, label);
  } catch (error) {
    if (error.cause?.code === "ENOENT") return;
    throw error;
  }
  if (owner.token !== token)
    throw new Error(`${label} lock ownership changed before release; refusing removal`);
  const released = `${lockPath}.released-${token}`;
  await rename(lockPath, released);
  await rm(released, { recursive: true });
}

export async function acquireOwnedProcessLock(lockPath, metadata = {}, options = {}) {
  const resolved = path.resolve(lockPath);
  const label = options.label ?? "Process";
  const alive = options.isProcessAlive ?? isProcessAlive;
  const inheritedToken = options.inheritedToken;
  const inspectIdentity = options.inspectProcessIdentity ?? readProcessIdentity;
  const verifiedActive = (owner) =>
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
      format_version: 1,
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
      return {
        lockPath: resolved,
        owner,
        inherited: false,
        release: () => releaseOwnedLock(resolved, token, label),
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const active = await readOwner(resolved, label);
      if (verifiedActive(active)) {
        throw Object.assign(
          new Error(
            `${label} is already owned by PID ${active.pid} since ${active.created_at}` +
              (active.workspace ? ` (workspace ${active.workspace})` : ""),
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
      const stalePath = `${resolved}.stale-${randomUUID()}`;
      try {
        await rename(resolved, stalePath);
      } catch (renameError) {
        if (["ENOENT", "EEXIST"].includes(renameError.code)) continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true });
    }
  }
  throw new Error(`${label} lock changed repeatedly; retry after the active run settles`);
}
