import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { toolCachePaths } from "./tool-cache.mjs";

export function nativeSessionLockPath() {
  return path.join(toolCachePaths().sharedRoot, "locks", "native-desktop");
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readOwner(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(`Native desktop lock exists but its owner is unreadable: ${ownerPath}`, {
      cause: error,
    });
  }
  if (
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    Number.isNaN(Date.parse(owner.created_at))
  )
    throw new Error(`Native desktop lock has invalid owner metadata: ${ownerPath}`);
  return owner;
}

async function releaseOwnedLock(lockPath, token) {
  let owner;
  try {
    owner = await readOwner(lockPath);
  } catch (error) {
    if (error.cause?.code === "ENOENT") return;
    throw error;
  }
  if (owner.token !== token)
    throw new Error("Native desktop lock ownership changed before release; refusing removal");
  const released = `${lockPath}.released-${token}`;
  await rename(lockPath, released);
  await rm(released, { recursive: true });
}

export async function acquireNativeSessionLock(metadata = {}, options = {}) {
  const lockPath = path.resolve(options.lockPath ?? nativeSessionLockPath());
  const alive = options.isProcessAlive ?? isProcessAlive;
  const inheritedToken = options.inheritedToken ?? process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN;
  if (inheritedToken) {
    const owner = await readOwner(lockPath);
    if (owner.token !== inheritedToken)
      throw new Error("Inherited native desktop lock token does not match the active owner");
    return { lockPath, owner, inherited: true, release: async () => {} };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const owner = {
      format_version: 1,
      token,
      pid: process.pid,
      created_at: new Date().toISOString(),
      process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      workspace: metadata.workspace ?? null,
      profile: metadata.profile ?? null,
      scenarios: metadata.scenarios ?? [],
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          flag: "wx",
        });
      } catch (error) {
        await rm(lockPath, { recursive: true }).catch(() => {});
        throw error;
      }
      return {
        lockPath,
        owner,
        inherited: false,
        release: () => releaseOwnedLock(lockPath, token),
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const active = await readOwner(lockPath);
      if (alive(active.pid)) {
        throw new Error(
          `Native desktop verification is already owned by PID ${active.pid} since ${active.created_at} ` +
            `(workspace ${active.workspace ?? "unknown"}, profile ${active.profile ?? "exact scenarios"})`,
        );
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (["ENOENT", "EEXIST"].includes(renameError.code)) continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true });
    }
  }
  throw new Error("Native desktop lock changed repeatedly; retry after the active run settles");
}
