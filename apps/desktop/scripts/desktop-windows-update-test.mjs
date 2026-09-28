import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { By } from "selenium-webdriver";
import { cachedDesktopDrivers } from "../../../scripts/tool-cache.mjs";
import { driveInstalledUpdateToRestart } from "./desktop-application-update-journey.mjs";
import {
  awaitInstalledUpdateDriver,
  connectInstalledUpdateDriver,
  hashFile,
  readJson,
  recordInstalledUpdateFailure,
  startInstalledUpdateDriver,
  verifyInstalledUpdateStaging,
  waitFor,
} from "./desktop-installed-update-harness.mjs";

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
    ].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of [
  "app",
  "output",
  "staging",
  "stage-marker",
  "helper-process-marker",
  "relaunch-process-marker",
])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`);
for (const name of ["candidate-installer-sha", "candidate-executable-sha"])
  assert.match(values[name] ?? "", /^[0-9a-f]{64}$/u);
assert.ok(values["candidate-version"]);
const drivers = cachedDesktopDrivers();
assert.ok(drivers, "Pinned Tauri and WebView2 drivers are unavailable");
await mkdir(values.output, { recursive: false });
const report = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  app: values.app,
  initial_executable_sha256: null,
  candidate_installer_sha256: values["candidate-installer-sha"],
  candidate_executable_sha256: values["candidate-executable-sha"],
  candidate_version: values["candidate-version"],
  actions: [],
  failure: null,
};
const evidencePath = path.join(values.output, "renderer-update-evidence.json");
const snapshotPath = path.join(values.output, "native-processes-before-restart.json");
const nativeSession = fileURLToPath(new URL("./native-session.ps1", import.meta.url));
let driver;
let browser;
let driverSession;
let snapshot;

async function save() {
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
function nativeSessionCommand(mode) {
  const args = ["-NoProfile", "-File", nativeSession, "-Mode", mode, "-SnapshotPath", snapshotPath];
  if (mode === "Snapshot")
    args.push("-DriverProcessId", String(driver.pid), "-ApplicationPath", values.app);
  return JSON.parse(
    execFileSync("pwsh", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    }),
  );
}

try {
  report.initial_executable_sha256 = (await hashFile(values.app)).sha256;
  driverSession = startInstalledUpdateDriver(drivers.driver, drivers.nativeDriver, {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: path.join(values.output, "webview2-profile"),
    },
  });
  driver = driverSession.driver;
  await awaitInstalledUpdateDriver(driver);
  browser = await connectInstalledUpdateDriver(values.app);
  await driveInstalledUpdateToRestart(browser, report.actions);
  const staged = await verifyInstalledUpdateStaging({
    stagingRoot: values.staging,
    payloadName: "candidate-installer.exe",
    candidateSha: values["candidate-installer-sha"],
    candidateVersion: values["candidate-version"],
    application: values.app,
    initialSha: report.initial_executable_sha256,
  });
  report.staged = staged;
  report.actions.push("renderer-downloaded-and-verified");
  await writeFile(path.join(values.output, "before-restart.png"), await browser.takeScreenshot(), {
    encoding: "base64",
  });
  snapshot = nativeSessionCommand("Snapshot");
  report.native_processes_before_restart = snapshot;
  await save();
  try {
    report.restart_action_attempted = true;
    await browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click();
    report.restart_click = "returned";
  } catch (error) {
    report.restart_click = `session-ended: ${String(error.message).slice(0, 300)}`;
  }
  const helper = await waitFor(
    () => readJson(values["helper-process-marker"]),
    "parent-owned helper process marker",
    20_000,
  );
  assert.equal(helper.schema_version, 1);
  assert.ok(Number.isInteger(helper.process_id) && helper.process_id > 0);
  const workerRelative = path.relative(values.staging, helper.executable).replaceAll("\\", "/");
  assert.match(
    workerRelative,
    /^workers\/revision-\d+\/attempt-[^/]+\/portcove-update-worker\.exe$/iu,
  );
  assert.equal((await hashFile(helper.executable)).sha256, report.initial_executable_sha256);
  report.helper_process_marker = helper;
  const relaunch = await waitFor(
    () => readJson(values["relaunch-process-marker"]),
    "helper-owned candidate process marker",
    90_000,
  );
  assert.equal(relaunch.schema_version, 1);
  assert.ok(Number.isInteger(relaunch.process_id) && relaunch.process_id > 0);
  assert.equal(
    path.win32.normalize(relaunch.executable).toLowerCase(),
    path.win32.normalize(values.app).toLowerCase(),
  );
  report.relaunch_process_marker = relaunch;
  report.restart = await waitFor(
    async () => {
      const marker = await readJson(values["stage-marker"]);
      if (marker.stage !== "Tauri setup" || marker.process_id !== relaunch.process_id) return null;
      if ((await hashFile(values.app)).sha256 !== values["candidate-executable-sha"]) return null;
      const apply = await readJson(path.join(values.staging, "apply.json"));
      if (apply.intent !== null) return null;
      return {
        marker,
        apply_phase: apply.phase,
        installed_executable_sha256: values["candidate-executable-sha"],
      };
    },
    "renderer-driven installed NSIS restart and reconciliation",
    90_000,
  );
  report.actions.push("candidate-restarted-and-reconciled");
  report.phase = "complete";
} catch (error) {
  await recordInstalledUpdateFailure(report, error, values["helper-process-marker"]);
  process.exitCode = 1;
} finally {
  if (!snapshot && browser && driver?.exitCode === null) {
    try {
      snapshot = nativeSessionCommand("Snapshot");
      report.native_processes_at_failure = snapshot;
    } catch (error) {
      report.native_snapshot_failure = String(error.message).slice(0, 300);
    }
  }
  if (browser)
    await Promise.race([
      browser.quit().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  if (snapshot) {
    try {
      report.driver_cleanup =
        driver.exitCode === null ? nativeSessionCommand("StopDriver") : "driver-exited";
      report.native_processes_after_stop = nativeSessionCommand("Wait");
    } catch (error) {
      report.phase = "failed";
      report.failure = `${report.failure ?? "Qualification failed"}; owned driver cleanup: ${error.message}`;
      process.exitCode = 1;
    }
  } else if (driver && driver.exitCode === null) {
    driver.kill();
    report.driver_cleanup = "direct owned driver stop before native snapshot";
  }
  await writeFile(path.join(values.output, "driver.log"), driverSession?.log ?? "");
  await save();
}
if (report.phase !== "complete")
  throw new Error(report.failure ?? "NSIS renderer qualification failed");
