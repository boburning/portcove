import path from "node:path";
import { acquireOwnedProcessLock, isProcessAlive } from "./process-lock.mjs";
import { toolCachePaths } from "./tool-cache.mjs";

export function nativeSessionLockPath() {
  return path.join(toolCachePaths().sharedRoot, "locks", "native-desktop");
}

export async function acquireNativeSessionLock(metadata = {}, options = {}) {
  const lockPath = path.resolve(options.lockPath ?? nativeSessionLockPath());
  const inheritedToken = options.inheritedToken ?? process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN;
  return acquireOwnedProcessLock(
    lockPath,
    {
      workspace: metadata.workspace ?? null,
      profile: metadata.profile ?? null,
      scenarios: metadata.scenarios ?? [],
    },
    {
      label: "Native desktop verification",
      inheritedToken,
      isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    },
  );
}

export { isProcessAlive };
