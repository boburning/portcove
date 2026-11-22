import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { isRecord } from "./runtime-values.mts";

const execute = promisify(execFile);

export interface VerifiedWindowsGameLaunch {
  cli: string;
  cli_sha256: string;
  library: string;
  port_id: string;
  executable: string;
  executable_sha256: string;
  output: string;
}

async function verifyExecutable(filename: string, digest: string) {
  if (!path.isAbsolute(filename) || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("Game lifecycle executable path or digest is invalid");
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > 512 * 1024 * 1024 ||
    path.normalize(await realpath(filename)).toLowerCase() !==
      path.normalize(filename).toLowerCase()
  )
    throw new Error("Game lifecycle executable is outside regular verified custody");
  const hash = createHash("sha256");
  const stream: AsyncIterable<unknown> = createReadStream(filename);
  for await (const bytes of stream) {
    if (!Buffer.isBuffer(bytes)) throw new Error("Native file read did not return bytes");
    hash.update(bytes);
  }
  if (hash.digest("hex") !== digest)
    throw new Error("Game lifecycle executable differs from review");
}

/** Invoke ordinary Core launch. The caller owns browser capacity and verified
 * runtime/variant inputs. A failed close leaves the native lock for recovery. */
export async function launchAndCloseVerifiedWindowsGame(
  scope: VerifiedWindowsGameLaunch,
  environment: NodeJS.ProcessEnv,
) {
  if (process.platform !== "win32" || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(scope.port_id))
    throw new Error("Native game lifecycle requires an exact Windows port");
  await verifyExecutable(scope.cli, scope.cli_sha256);
  await verifyExecutable(scope.executable, scope.executable_sha256);
  const session = await acquireNativeSessionLock({
    workspace: fileURLToPath(new URL("..", import.meta.url)),
    scenarios: ["exact-game-lifecycle-launch-and-close"],
  });
  let mayHaveStarted = false;
  let quiescent = false;
  try {
    const child = spawn(
      scope.cli,
      ["--library", scope.library, "--non-interactive", "exec", scope.port_id],
      {
        cwd: scope.output,
        env: environment,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    void exit.catch(() => undefined);
    const owner = child.pid;
    if (!owner) {
      await exit;
      throw new Error("Core native launch did not start");
    }
    mayHaveStarted = true;
    const { stdout: filetime } = await execute(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${owner} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
      ],
      { timeout: 5000, maxBuffer: 1024, windowsHide: true, env: environment },
    );
    if (!/^\d{1,20}$/u.test(filetime.trim()))
      throw new Error("Core launch owner has no creation identity");
    const snapshot = path.join(scope.output, "native-process-custody.json");
    const { stdout } = await execute(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./game-lifecycle-native-close.ps1", import.meta.url)),
        "-OwnerPid",
        String(owner),
        "-OwnerStartedFileTime",
        filetime.trim(),
        "-OwnerPath",
        scope.cli,
        "-ApplicationPath",
        scope.executable,
        "-ExpectedApplicationSha256",
        scope.executable_sha256,
        "-SnapshotPath",
        snapshot,
      ],
      { timeout: 55000, maxBuffer: 32 * 1024, windowsHide: true, env: environment },
    );
    const result: unknown = JSON.parse(stdout);
    if (
      !isRecord(result) ||
      !isRecord(result.request) ||
      result.request.message_sent !== true ||
      !isRecord(result.quiescence) ||
      typeof result.quiescence.exited_at !== "string"
    )
      throw new Error("Native close and process exit were not independently observed");
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Core launch owner did not exit")), 5000);
      void exit.then(resolve, reject).finally(() => clearTimeout(deadline));
    });
    quiescent = true;
    if (code !== 0) throw new Error("Native game or Core launch exited unsuccessfully");
    return {
      executable_sha256: scope.executable_sha256,
      method: result.request.method,
      exited_at: result.quiescence.exited_at,
      exit_code: code,
    };
  } finally {
    if (!mayHaveStarted || quiescent) await session.release();
  }
}
