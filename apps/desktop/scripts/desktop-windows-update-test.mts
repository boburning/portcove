import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { By } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { EmbeddedSession, EmbeddedCleanup } from "./desktop-windows-embedded-session.mts";
import type { InstalledUpdateFailure } from "./desktop-installed-update-harness.mts";
import type {
  NativeSessionMode,
  NativeSessionObservations,
  NativeProcessSnapshot,
} from "./desktop-owned-native-session.mts";
import { readNativeSessionObservation } from "./desktop-owned-native-session.mts";
import { cachedDesktopDrivers } from "../../../scripts/tool-cache.mts";
import { driveInstalledUpdateToRestart } from "./desktop-application-update-journey.mts";
import { startEmbeddedInstalledSession } from "./desktop-windows-embedded-session.mts";
import {
  awaitInstalledUpdateDriver,
  connectInstalledUpdateDriver,
  hashFile,
  readJson,
  recordInstalledUpdateFailure,
  startInstalledUpdateDriver,
  verifyInstalledUpdateStaging,
  waitFor,
} from "./desktop-installed-update-harness.mts";

assert.equal(process.platform, "win32", "Installed NSIS renderer qualification requires Windows");
const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "app",
      "output",
      "staging",
      "stage-marker",
      "helper-process-marker",
      "relaunch-process-marker",
      "candidate-installer-sha",
      "candidate-executable-sha",
      "candidate-version",
      "transport",
    ].map((name) => [name, { type: "string" }] as const),
  ),
});
function requiredOption(name: string): string {
  const value = values[name];
  assert.ok(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}
function absoluteOption(name: string): string {
  const value = requiredOption(name);
  assert.ok(path.isAbsolute(value), `--${name} must be absolute`);
  return value;
}
const app = absoluteOption("app"),
  output = absoluteOption("output"),
  staging = absoluteOption("staging");
const stageMarker = absoluteOption("stage-marker"),
  helperMarker = absoluteOption("helper-process-marker"),
  relaunchMarker = absoluteOption("relaunch-process-marker");
const installerSha = requiredOption("candidate-installer-sha"),
  executableSha = requiredOption("candidate-executable-sha"),
  candidateVersion = requiredOption("candidate-version");
for (const sha of [installerSha, executableSha]) assert.match(sha, /^[0-9a-f]{64}$/u);
const embedded = values.transport === "embedded";
assert.ok(
  !values.transport ||
    (typeof values.transport === "string" && ["official", "embedded"].includes(values.transport)),
);
const drivers = embedded ? null : cachedDesktopDrivers();
assert.ok(embedded || drivers, "Pinned Tauri and WebView2 drivers are unavailable");
await mkdir(output, { recursive: false });
interface ProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}
interface MarkedObservation {
  status: "captured" | "exited" | "prior-process-exited" | "stopped";
  pid: number;
  path?: string;
}
interface MarkedExit {
  capture: MarkedObservation;
  exit: MarkedObservation;
}
interface MarkedCleanup {
  capture: MarkedObservation;
  stop: MarkedObservation | null;
}
type ProcessLabel = "candidate" | "helper";
interface WindowsUpdateReport extends InstalledUpdateFailure {
  schema_version: 1;
  source_commit: string;
  app: string;
  initial_executable_sha256: string | null;
  candidate_installer_sha256: string;
  candidate_executable_sha256: string;
  candidate_version: string;
  actions: string[];
  transport: "embedded" | "official";
  embedded_listener?: EmbeddedSession["listener"];
  embedded_startup?: EmbeddedSession["startup"];
  staged?: Awaited<ReturnType<typeof verifyInstalledUpdateStaging>>;
  ordinary_staging?: Awaited<ReturnType<typeof driveInstalledUpdateToRestart>>;
  native_processes_before_restart?: NativeProcessSnapshot;
  bootstrap_before_restart?: unknown;
  restart_action_attempted?: boolean;
  restart_click?: string;
  helper_process_marker?: ProcessMarker;
  relaunch_process_marker?: ProcessMarker;
  restart?: {
    marker: Record<string, unknown>;
    apply_phase: unknown;
    installed_executable_sha256: string;
  };
  helper_result?: Record<string, unknown>;
  natural_process_exit?: Record<ProcessLabel, MarkedExit>;
  restart_command?: unknown;
  failure_capture?: string;
  native_processes_at_failure?: NativeProcessSnapshot;
  native_snapshot_failure?: string;
  driver_only_snapshot?: NativeProcessSnapshot;
  driver_snapshot_failure?: string;
  updater_process_cleanup?: Partial<
    Record<ProcessLabel, MarkedCleanup | { status: "marker-absent" } | string>
  >;
  embedded_cleanup?: EmbeddedCleanup;
  driver_cleanup?: NativeSessionObservations["StopDriver"] | string;
  native_processes_after_stop?: NativeSessionObservations["Wait"];
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function positivePid(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}
function processMarker(value: unknown): ProcessMarker {
  const marker = object(value);
  assert.equal(marker.schema_version, 1);
  assert.ok(typeof marker.executable === "string" && path.win32.isAbsolute(marker.executable));
  return {
    ...marker,
    schema_version: 1,
    process_id: positivePid(marker.process_id),
    executable: marker.executable,
  };
}
function markedObservation(value: unknown): MarkedObservation {
  const observation = object(value);
  const status = observation.status;
  assert.ok(
    status === "captured" ||
      status === "exited" ||
      status === "prior-process-exited" ||
      status === "stopped",
  );
  const result: MarkedObservation = { ...observation, status, pid: positivePid(observation.pid) };
  if (observation.path !== undefined) {
    assert.ok(typeof observation.path === "string" && path.win32.isAbsolute(observation.path));
    result.path = observation.path;
  }
  return result;
}
const report: WindowsUpdateReport = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  app,
  initial_executable_sha256: null,
  candidate_installer_sha256: installerSha,
  candidate_executable_sha256: executableSha,
  candidate_version: candidateVersion,
  actions: [],
  transport: embedded ? "embedded" : "official",
  failure: null,
};
const evidencePath = path.join(output, "renderer-update-evidence.json");
const snapshotPath = path.join(output, "native-processes-before-restart.json");
const driverOnlySnapshotPath = path.join(output, "native-driver-at-failure.json");
const nativeSession = fileURLToPath(new URL("./native-session.ps1", import.meta.url));
const markedProcess = fileURLToPath(new URL("./native-marked-update-process.ps1", import.meta.url));
const webviewProfile = path.join(output, "webview2-profile");
let driver: ReturnType<typeof startInstalledUpdateDriver>["driver"] | undefined;
let browser: WebDriver | undefined;
let driverSession: ReturnType<typeof startInstalledUpdateDriver> | undefined;
let snapshot: NativeProcessSnapshot | undefined;
let activeSnapshotPath = snapshotPath;
let restartStarted: string | undefined;
let embeddedSession: EmbeddedSession | undefined;

async function save() {
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
function nativeSessionCommand<Mode extends NativeSessionMode>(
  mode: Mode,
): NativeSessionObservations[Mode] {
  const target = mode === "SnapshotDriver" ? driverOnlySnapshotPath : activeSnapshotPath;
  const args = ["-NoProfile", "-File", nativeSession, "-Mode", mode, "-SnapshotPath", target];
  if (mode === "Snapshot" || mode === "SnapshotDriver") {
    assert.ok(driver?.pid, "Owned driver PID required");
    args.push("-DriverProcessId", String(driver.pid));
  }
  if (mode === "Snapshot") args.push("-ApplicationPath", app);
  return readNativeSessionObservation(
    mode,
    JSON.parse(
      execFileSync("pwsh", args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      }),
    ),
  );
}
function markedProcessCommand(
  mode: "Capture" | "Wait" | "Stop",
  args: string[],
): MarkedObservation {
  return markedObservation(
    JSON.parse(
      execFileSync("pwsh", ["-NoProfile", "-File", markedProcess, "-Mode", mode, ...args], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 25_000,
      }),
    ),
  );
}
function workerRelativePath(executable: string) {
  return path.win32
    .relative(path.win32.toNamespacedPath(staging), path.win32.toNamespacedPath(executable))
    .replaceAll("\\", "/");
}
async function cleanupMarkedProcess(
  markerPath: string,
  label: ProcessLabel,
): Promise<MarkedCleanup | { status: "marker-absent" }> {
  const rawMarker = await readJson(markerPath).catch(() => null);
  if (!rawMarker) return { status: "marker-absent" };
  const marker = processMarker(rawMarker);
  const expected = label === "candidate" ? app : marker.executable;
  if (label === "helper") {
    const relative = workerRelativePath(expected);
    assert.match(relative, /^workers\/revision-\d+\/attempt-[^/]+\/portcove-update-worker\.exe$/iu);
  }
  const identityPath = path.join(output, `${label}-process-identity.json`);
  const capturedEarlier = await readJson(identityPath).catch(() => null);
  assert.ok(restartStarted, "Restart timestamp required for marked-process capture");
  const capture: MarkedObservation = capturedEarlier
    ? { status: "captured", pid: positivePid(object(capturedEarlier).pid) }
    : markedProcessCommand("Capture", [
        "-MarkerPath",
        markerPath,
        "-IdentityPath",
        identityPath,
        "-ExpectedPath",
        expected,
        "-EarliestStart",
        restartStarted,
        ...(label === "helper" ? ["-Helper"] : []),
      ]);
  return {
    capture,
    stop:
      capture.status === "captured"
        ? markedProcessCommand("Stop", ["-IdentityPath", identityPath])
        : null,
  };
}
async function awaitMarkedProcessExit(
  markerPath: string,
  label: ProcessLabel,
): Promise<MarkedExit> {
  const marker = processMarker(await readJson(markerPath));
  assert.ok(restartStarted, "Restart timestamp required for marked-process capture");
  const identityPath = path.join(output, `${label}-process-identity.json`);
  const capture = markedProcessCommand("Capture", [
    "-MarkerPath",
    markerPath,
    "-IdentityPath",
    identityPath,
    "-ExpectedPath",
    label === "candidate" ? app : marker.executable,
    "-EarliestStart",
    restartStarted,
    ...(label === "helper" ? ["-Helper"] : []),
  ]);
  const exit =
    capture.status === "captured"
      ? markedProcessCommand("Wait", ["-IdentityPath", identityPath])
      : capture;
  assert.ok(["exited", "prior-process-exited"].includes(exit.status));
  return { capture, exit };
}

try {
  report.initial_executable_sha256 = (await hashFile(app)).sha256;
  if (embedded) {
    embeddedSession = await startEmbeddedInstalledSession(app, output);
    browser = await embeddedSession.connect();
    report.embedded_listener = embeddedSession.listener;
    report.embedded_startup = embeddedSession.startup;
    assert.equal(embeddedSession.identity.sha256, report.initial_executable_sha256);
  } else {
    assert.ok(drivers);
    driverSession = startInstalledUpdateDriver(drivers.driver, drivers.nativeDriver, {
      windowsHide: true,
      env: {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
      },
    });
    driver = driverSession.driver;
    await awaitInstalledUpdateDriver(driver);
    browser = await connectInstalledUpdateDriver(app, webviewProfile);
  }
  report.ordinary_staging = await driveInstalledUpdateToRestart(
    browser,
    report.actions,
    candidateVersion,
  );
  const staged = await verifyInstalledUpdateStaging({
    stagingRoot: staging,
    payloadName: "candidate-installer.exe",
    candidateSha: installerSha,
    candidateVersion,
    application: app,
    initialSha: report.initial_executable_sha256,
  });
  report.staged = staged;
  report.actions.push("renderer-downloaded-and-verified");
  await writeFile(path.join(output, "before-restart.png"), await browser.takeScreenshot(), {
    encoding: "base64",
  });
  snapshot = embeddedSession ? embeddedSession.capture() : nativeSessionCommand("Snapshot");
  report.native_processes_before_restart = snapshot;
  report.bootstrap_before_restart = JSON.parse(
    await browser.executeAsyncScript<string>((done: (value: string) => void) => {
      const runtime = window as Window & {
        __TAURI_INTERNALS__?: { invoke(command: string): Promise<unknown> };
      };
      if (!runtime.__TAURI_INTERNALS__) throw new Error("Native bridge unavailable");
      void runtime.__TAURI_INTERNALS__.invoke("get_bootstrap_status").then(
        (value) => done(JSON.stringify({ ok: true, value })),
        (error: unknown) => done(JSON.stringify({ ok: false, error })),
      );
    }),
  );
  await executeBrowserScript(browser, () => {
    const runtime = window as Window & {
      __TAURI_INTERNALS__?: {
        invoke(command: string, args?: unknown, options?: unknown): Promise<unknown>;
      };
      __portcoveRestartResult?: unknown;
    };
    const internals = runtime.__TAURI_INTERNALS__;
    if (!internals) throw new Error("Native bridge unavailable");
    const original = internals.invoke.bind(internals);
    runtime.__portcoveRestartResult = null;
    internals.invoke = (command, args, options) => {
      const result = original(command, args, options);
      if (command === "restart_to_apply_application_update") {
        void result.then(
          () => {
            runtime.__portcoveRestartResult = { ok: true };
          },
          (error: unknown) => {
            runtime.__portcoveRestartResult = {
              ok: false,
              code:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "code" in error
                  ? error.code
                  : undefined,
              message:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "message" in error
                  ? error.message
                  : undefined,
              details:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "details" in error
                  ? error.details
                  : undefined,
            };
          },
        );
      }
      return result;
    };
  });
  await save();
  try {
    report.restart_action_attempted = true;
    restartStarted = new Date().toISOString();
    await browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click();
    report.restart_click = "returned";
  } catch (error) {
    report.restart_click = `session-ended: ${String(errorMessage(error)).slice(0, 300)}`;
  }
  const helper = processMarker(
    await waitFor(() => readJson(helperMarker), "parent-owned helper process marker", 20_000),
  );
  assert.equal(helper.schema_version, 1);
  assert.ok(Number.isInteger(helper.process_id) && helper.process_id > 0);
  const workerRelative = workerRelativePath(helper.executable);
  assert.match(
    workerRelative,
    /^workers\/revision-\d+\/attempt-[^/]+\/portcove-update-worker\.exe$/iu,
  );
  assert.equal((await hashFile(helper.executable)).sha256, report.initial_executable_sha256);
  report.helper_process_marker = helper;
  const relaunch = processMarker(
    await waitFor(() => readJson(relaunchMarker), "helper-owned candidate process marker", 90_000),
  );
  assert.equal(relaunch.schema_version, 1);
  assert.ok(Number.isInteger(relaunch.process_id) && relaunch.process_id > 0);
  assert.equal(
    path.win32.toNamespacedPath(relaunch.executable).toLowerCase(),
    path.win32.toNamespacedPath(app).toLowerCase(),
  );
  report.relaunch_process_marker = relaunch;
  report.restart = await waitFor(
    async () => {
      const marker = object(await readJson(stageMarker));
      if (marker.stage !== "Tauri setup" || marker.process_id !== relaunch.process_id) return null;
      if ((await hashFile(app)).sha256 !== executableSha) return null;
      const apply = object(await readJson(path.join(staging, "apply.json")));
      if (apply.intent !== null) return null;
      return {
        marker,
        apply_phase: apply.phase,
        installed_executable_sha256: executableSha,
      };
    },
    "renderer-driven installed NSIS restart and reconciliation",
    90_000,
  );
  const helperResult = object(
    await waitFor(
      () => readJson(path.join(path.dirname(helperMarker), "helper-result.json")),
      "revision-bound helper result marker",
      20_000,
    ),
  );
  assert.equal(helperResult.schema_version, 1);
  assert.equal(helperResult.process_id, helper.process_id);
  assert.equal(helperResult.exit_code, 0);
  report.helper_result = helperResult;
  report.natural_process_exit = {
    candidate: await awaitMarkedProcessExit(relaunchMarker, "candidate"),
    helper: await awaitMarkedProcessExit(helperMarker, "helper"),
  };
  report.actions.push("candidate-restarted-and-reconciled");
  report.phase = "complete";
} catch (error) {
  if (browser) {
    try {
      report.restart_command = await executeBrowserScript(
        browser,
        () => (window as Window & { __portcoveRestartResult?: unknown }).__portcoveRestartResult,
      );
      await Promise.race([
        Promise.all([
          browser
            .takeScreenshot()
            .then((png) =>
              writeFile(path.join(output, "failure.png"), png, { encoding: "base64" }),
            ),
          browser
            .getPageSource()
            .then((html) => writeFile(path.join(output, "failure.html"), html)),
        ]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("failure capture timed out")), 5_000),
        ),
      ]);
    } catch (captureError) {
      report.failure_capture = String(errorMessage(captureError)).slice(0, 300);
    }
  }
  await recordInstalledUpdateFailure(report, error, helperMarker);
  process.exitCode = 1;
} finally {
  if (!snapshot && driver?.exitCode === null) {
    try {
      snapshot = nativeSessionCommand("Snapshot");
      report.native_processes_at_failure = snapshot;
    } catch (error) {
      report.native_snapshot_failure = String(errorMessage(error)).slice(0, 300);
      try {
        snapshot = nativeSessionCommand("SnapshotDriver");
        activeSnapshotPath = driverOnlySnapshotPath;
        report.driver_only_snapshot = snapshot;
      } catch (driverError) {
        report.driver_snapshot_failure = String(errorMessage(driverError)).slice(0, 300);
      }
    }
  }
  if (browser)
    await Promise.race([
      browser.quit().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  if (restartStarted) {
    report.updater_process_cleanup = {};
    for (const [label, markerPath] of [
      ["candidate", relaunchMarker],
      ["helper", helperMarker],
    ] as const) {
      if (report.natural_process_exit?.[label]) {
        report.updater_process_cleanup[label] = "exited naturally before cleanup";
        continue;
      }
      try {
        const cleanup = await cleanupMarkedProcess(markerPath, label);
        report.updater_process_cleanup[label] = cleanup;
        if (
          report.phase === "complete" &&
          "stop" in cleanup &&
          cleanup.stop?.status === "stopped"
        ) {
          report.phase = "failed";
          report.failure = `${label} process required forced cleanup after reported success`;
          process.exitCode = 1;
        }
      } catch (error) {
        report.updater_process_cleanup[label] =
          `uncertain: ${String(errorMessage(error)).slice(0, 300)}`;
        report.phase = "failed";
        report.failure = `${report.failure ?? "Qualification failed"}; ${label} process cleanup uncertain`;
        process.exitCode = 1;
      }
    }
  }
  if (embeddedSession) {
    if (report.phase === "complete") {
      try {
        const installedPredecessor = embeddedSession.child;
        await waitFor(
          async () =>
            installedPredecessor.exitCode !== null || installedPredecessor.signalCode !== null,
          "installed predecessor natural exit",
          5000,
        );
      } catch (error) {
        report.phase = "failed";
        report.failure = errorMessage(error);
        process.exitCode = 1;
      }
    }
    try {
      report.embedded_cleanup = await embeddedSession.close();
      if (report.phase === "complete" && report.embedded_cleanup.forced) {
        report.phase = "failed";
        report.failure = "Installed predecessor required forced cleanup after reported success";
        process.exitCode = 1;
      }
    } catch (error) {
      report.phase = "failed";
      report.failure = `${report.failure ?? "Qualification failed"}; embedded application cleanup: ${errorMessage(error)}`;
      process.exitCode = 1;
    }
  } else if (snapshot) {
    try {
      report.driver_cleanup =
        driver?.exitCode === null ? nativeSessionCommand("StopDriver") : "driver-exited";
      report.native_processes_after_stop = nativeSessionCommand("Wait");
    } catch (error) {
      report.phase = "failed";
      report.failure = `${report.failure ?? "Qualification failed"}; owned driver cleanup: ${errorMessage(error)}`;
      process.exitCode = 1;
    }
  } else if (driver && driver.exitCode === null) {
    driver.kill();
    report.driver_cleanup = "direct owned driver stop before native snapshot";
  }
  await writeFile(path.join(output, "driver.log"), driverSession?.log ?? "");
  await save();
}
if (report.phase !== "complete")
  throw new Error(report.failure ?? "NSIS renderer qualification failed");
