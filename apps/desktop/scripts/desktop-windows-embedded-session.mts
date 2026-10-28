import { errorMessage } from "../../../scripts/runtime-values.mts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashFile } from "./desktop-installed-update-harness.mts";

import type { WebDriver } from "selenium-webdriver";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  NativeSessionMode,
  NativeSessionObservations,
} from "./desktop-owned-native-session.mts";
import { readNativeSessionObservation } from "./desktop-owned-native-session.mts";
interface EmbeddedBaseReport {
  revision: string;
  working_tree: string;
  method: string;
  outcome: "failed" | "passed";
}
interface StatusProbe {
  started_at: string;
  finished_at?: string;
  status?: number;
  error?: string;
}
export interface EmbeddedCleanup {
  forced: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
}
export interface EmbeddedSession {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  identity: Awaited<ReturnType<typeof hashFile>>;
  listener: Extract<NativeSessionObservations["ApplicationListener"], { ready: true }> | null;
  browser: WebDriver | null;
  statusProbes: StatusProbe[];
  startupComplete: boolean;
  startup?: NativeSessionObservations["SnapshotApplication"];
  connectedProcesses?: NativeSessionObservations["SnapshotApplication"];
  capture(): NativeSessionObservations["SnapshotApplication"];
  connect(): Promise<WebDriver>;
  close(): Promise<EmbeddedCleanup>;
}
const nativeSession = fileURLToPath(new URL("./native-session.ps1", import.meta.url));
export async function beginEmbeddedEvidence(method: string) {
  const { values } = parseArgs({
    options: { app: { type: "string" }, output: { type: "string" } },
  });
  const app = values.app,
    output = values.output;
  assert.ok(app && path.isAbsolute(app));
  assert.ok(output && path.isAbsolute(output));
  await mkdir(output, { recursive: false });
  const report: EmbeddedBaseReport = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    working_tree: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    method,
    outcome: "failed",
  };
  return { values: { app, output }, report };
}

export async function probeOwnedListener(port: number, remaining: number, probes: StatusProbe[]) {
  const probe: StatusProbe = { started_at: new Date().toISOString() };
  probes.push(probe);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(Math.min(1000, remaining)),
    });
    probe.status = response.status;
  } catch (error) {
    probe.error = String(error);
    // An owned listening socket can precede its HTTP server readiness.
    // Keep polling within the original deadline; other failures are fatal.
    const name =
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      "name" in error
        ? error.name
        : undefined;
    if (typeof name !== "string" || !["TimeoutError", "AbortError"].includes(name)) throw error;
  } finally {
    probe.finished_at = new Date().toISOString();
  }
  return response;
}

export async function startEmbeddedInstalledSession(
  application: string,
  output: string,
  launchArguments: string[] = [],
): Promise<EmbeddedSession> {
  assert.equal(process.platform, "win32");
  const identity = await hashFile(application);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(application, launchArguments, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, "webview2-profile"),
    },
  });
  const launched = once(child, "spawn");
  void launched.catch(() => {});
  let log = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-1024 * 1024);
    });
  let snapshotPath: string | undefined;
  let captureIndex = 0;
  function command<Mode extends NativeSessionMode>(
    mode: Mode,
    target = snapshotPath,
    extra: string[] = [],
  ): NativeSessionObservations[Mode] {
    assert.ok(target, "Native command requires the captured process inventory");
    const value: unknown = JSON.parse(
      execFileSync(
        "pwsh",
        ["-NoProfile", "-File", nativeSession, "-Mode", mode, "-SnapshotPath", target, ...extra],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 },
      ),
    );
    return readNativeSessionObservation(mode, value);
  }
  const capture = () => {
    const target = path.join(output, `embedded-processes-${captureIndex++}.json`);
    const result = command("SnapshotApplication", target, [
      "-DriverProcessId",
      String(child.pid),
      "-ApplicationPath",
      application,
      "-ExpectedParentProcessId",
      String(process.pid),
      "-ExpectedApplicationSha256",
      identity.sha256,
    ]);
    snapshotPath = target;
    return result;
  };
  const rootIsLive = () => child.exitCode === null && child.signalCode === null && child.pid;
  const stopLiveRoot = () => {
    if (!snapshotPath) {
      // Only the retained direct launch handle is available before capture.
      child.kill();
      return {
        forced: true,
        unproven: "No application tree was captured; descendant cleanup is unproven",
      };
    }
    let unproven: string | undefined;
    try {
      capture();
    } catch (error) {
      unproven = `Application tree refresh failed: ${errorMessage(error)}`;
    }
    command("StopApplication");
    return { forced: true, unproven };
  };
  const cleanupExitedRoot = () => {
    if (!snapshotPath)
      return {
        forced: false,
        unproven: child.pid
          ? "Application exited before tree capture; descendant cleanup is unproven"
          : null,
      };
    const cleanup = command("StopApplication");
    return {
      forced: cleanup.terminated_survivors.length > 0,
      unproven: !session.startupComplete
        ? "Application exited during startup; later descendant cleanup is unproven"
        : null,
    };
  };
  const session: EmbeddedSession = {
    child,
    port,
    identity,
    listener: null,
    browser: null,
    statusProbes: [],
    startupComplete: false,
    capture,
    async connect() {
      await launched;
      session.startup = capture();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Embedded installed application exited during startup");
        const listener = command("ApplicationListener", snapshotPath, ["-Port", String(port)]);
        if (listener.ready) {
          // Verify listener ownership before contacting or connecting to it.
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const response = await probeOwnedListener(port, remaining, session.statusProbes);
          if (response?.ok) {
            session.listener = listener;
            const { Builder } = await import("selenium-webdriver");
            const connection = new Builder()
              .disableEnvironmentOverrides()
              .usingServer(`http://127.0.0.1:${port}`)
              .withCapabilities({
                browserName: "tauri",
                "wdio:tauriServiceOptions": { windowLabel: "main" },
              })
              .build();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              session.browser = await Promise.race([
                connection,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Embedded session creation timed out")),
                    15_000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            // Refresh after WebView/session startup, rather than relying on the
            // immediate post-spawn inventory for later renderer qualification.
            session.connectedProcesses = capture();
            session.startupComplete = true;
            return session.browser;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("Owned embedded installed WebDriver did not become ready within 15 seconds");
    },
    async close() {
      try {
        const result = rootIsLive() ? stopLiveRoot() : cleanupExitedRoot();
        if (rootIsLive()) {
          await Promise.race([
            once(child, "exit"),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Embedded application cleanup timed out")), 5000),
            ),
          ]);
        }
        if (snapshotPath) command("Wait");
        if (result.unproven) throw new Error(result.unproven);
        return { forced: result.forced, exit_code: child.exitCode, signal: child.signalCode };
      } finally {
        await writeFile(path.join(output, "embedded-application.log"), log);
        await writeFile(
          path.join(output, "embedded-status-probes.json"),
          `${JSON.stringify(session.statusProbes, null, 2)}\n`,
        );
      }
    },
  };
  return session;
}
