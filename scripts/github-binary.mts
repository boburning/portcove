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
export function readGitHubArtifactArchive(
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
): Buffer {
  if (
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]{0,15}\/zip$/u.test(
      endpoint,
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 22 ||
    maxBytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new Error("artifact transport requires a bounded exact GitHub route");
  const result = spawn("gh", ["api", "--hostname", "github.com", endpoint], {
    cwd,
    encoding: null,
    timeout: coordinatorCommandTimeout(timeoutMs),
    maxBuffer: maxBytes,
    killSignal: "SIGKILL",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
