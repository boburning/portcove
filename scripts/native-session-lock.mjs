import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireOwnedProcessLock, isProcessAlive } from "./process-lock.mjs";
import { readProcessLockOwner } from "./process-lock.mjs";
import { toolCachePaths } from "./tool-cache.mjs";
import { resourceDomainRoot, resourceConfiguration } from "./resource-paths.mjs";

export function nativeSessionLockPath() {
  return path.join(resourceDomainRoot(), "native-desktop");
}

export function legacyNativeSessionLockPath() {
  return path.join(toolCachePaths().sharedRoot, "locks", "native-desktop");
}

export async function acquireNativeSessionLock(metadata = {}, options = {}) {
  const environment = options.environment ?? process.env;
  if (
    (!options.lockPath || options.readConfiguration) &&
    !options.retiringLegacy &&
    environment.GITHUB_ACTIONS !== "true" &&
    environment.PORTCOVE_CONTAINER_GUEST !== "1" &&
    (await (options.readConfiguration ?? resourceConfiguration)()).legacyMode !== "coordinated"
  )
    throw Object.assign(
      new Error(
        "Native admission requires the drained resource handover; no session acquired. Run resource-command.mjs retire-legacy-entrypoints after old work finishes.",
      ),
      { code: "PORTCOVE_RESOURCE_HANDOVER_PENDING" },
    );
  const lockPath = path.resolve(options.lockPath ?? nativeSessionLockPath());
  const inheritedToken = options.inheritedToken ?? environment.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN;
  const details = {
    workspace: metadata.workspace ?? null,
    profile: metadata.profile ?? null,
    scenarios: metadata.scenarios ?? [],
    capacity_aware: true,
  };
  const acquire = (target, token, metadata = details, ownerToken) =>
    acquireOwnedProcessLock(target, metadata, {
      label: "Native desktop verification",
      inheritedToken: token,
      isProcessAlive: options.isProcessAlive ?? isProcessAlive,
      verifyIdentity: true,
      inspectProcessIdentity: options.inspectProcessIdentity,
      canReclaim: false,
      ownerToken,
    });
  if (options.lockPath) return acquire(lockPath, inheritedToken);
  const legacyToken = inheritedToken ?? randomUUID();
  let hostToken;
  if (inheritedToken) {
    const parent = await readProcessLockOwner(lockPath, "Native host session");
    if (parent.legacy_token !== inheritedToken)
      throw new Error("Native inherited host ownership does not match");
    hostToken = parent.token;
  }
  const host = await acquire(lockPath, hostToken, { ...details, legacy_token: legacyToken });
  try {
    const legacy = await acquire(
      legacyNativeSessionLockPath(),
      inheritedToken,
      details,
      legacyToken,
    );
    return {
      ...legacy,
      host,
      release: async () => {
        await legacy.release();
        await host.release();
      },
    };
  } catch (error) {
    await host.release();
    throw error;
  }
}

export { isProcessAlive };
