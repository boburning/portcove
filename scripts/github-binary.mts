import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { spawnSync } from "node:child_process";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import type { SpawnSyncOptionsWithBufferEncoding } from "node:child_process";

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithBufferEncoding,
) => { status: number | null; stdout: Buffer; error?: Error | null };

/** Opaque GitHub artifact transport. Enforce collection bounds in the child
 * process before buffering; never extract, log provider output or run a shell.
 */
function readOpaqueGitHubBytes(
  endpoint: string,
  {
    cwd,
    maxBytes,
    timeoutMs,
    spawn = spawnSync,
  }: {
    cwd: string;
    maxBytes: number;
    timeoutMs: number;
    spawn?: Spawn;
  },
  asset: boolean,
): Buffer {
  if (
    !(asset
      ? /^repos\/boburning\/portcove\/releases\/assets\/[1-9][0-9]{0,15}$/u.test(endpoint)
      : /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]{0,15}\/zip$/u.test(
          endpoint,
        )) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < (asset ? 1 : 22) ||
    maxBytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new Error("artifact transport requires a bounded exact GitHub route");
  const result = spawn(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      ...(asset ? ["-H", "Accept: application/octet-stream"] : []),
      endpoint,
    ],
    {
      cwd,
      ...(readOnlyReleaseChildEnvironment() === undefined ? {} : { env: readOnlyReleaseChildEnvironment() }),
      encoding: null,
      timeout: coordinatorCommandTimeout(timeoutMs),
      maxBuffer: maxBytes,
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  checkCoordinatorDeadline();
  if (
    result.error ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > maxBytes
  )
    throw new Error("bounded GitHub artifact transport failed");
  return result.stdout;
}

export function readGitHubArtifactArchive(
  endpoint: string,
  options: Parameters<typeof readOpaqueGitHubBytes>[1],
): Buffer {
  return readOpaqueGitHubBytes(endpoint, options, false);
}
/** Exact immutable Release asset bytes only. Metadata, digest and authority are
 * independently verified by the owning caller; no URL or credential is input. */
export function readGitHubReleaseAsset(
  endpoint: string,
  options: Parameters<typeof readOpaqueGitHubBytes>[1],
): Buffer {
  return readOpaqueGitHubBytes(endpoint, options, true);
}
