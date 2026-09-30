import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./desktop-installed-update-harness.mjs";

const nativeSession = fileURLToPath(new URL("./native-session.ps1", import.meta.url));
export async function startEmbeddedInstalledSession(application, output, launchArguments = []) {
  assert.equal(process.platform, "win32");
  const identity = await hashFile(application);
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
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
  launched.catch(() => {});
  let log = "";
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log = (log + chunk).slice(-1024 * 1024);
    });
  let snapshotPath;
  let captureIndex = 0;
  const command = (mode, target = snapshotPath, extra = []) =>
    JSON.parse(
      execFileSync(
        "pwsh",
        ["-NoProfile", "-File", nativeSession, "-Mode", mode, "-SnapshotPath", target, ...extra],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 },
      ),
    );
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
    let unproven;
    try {
      capture();
    } catch (error) {
      unproven = `Application tree refresh failed: ${error.message}`;
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
  const session = {
    child,
    port,
    identity,
    listener: null,
    browser: null,
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
          const response = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) {
            session.listener = listener;
            const { Builder } = await import("selenium-webdriver");
            const connection = new Builder()
              .disableEnvironmentOverrides()
              .usingServer(`http://127.0.0.1:${port}`)
              .withCapabilities({ browserName: "tauri" })
              .build();
            let timer;
            try {
              session.browser = await Promise.race([
                connection,
                new Promise((_, reject) => {
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
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Embedded application cleanup timed out")), 5000),
            ),
          ]);
        }
        if (snapshotPath) command("Wait");
        if (result.unproven) throw new Error(result.unproven);
        return { forced: result.forced, exit_code: child.exitCode, signal: child.signalCode };
      } finally {
        await writeFile(path.join(output, "embedded-application.log"), log);
      }
    },
  };
  return session;
}
