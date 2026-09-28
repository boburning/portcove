import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { By } from "selenium-webdriver";
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

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "app",
      "driver",
      "native-driver",
      "output",
      "staging",
      "stage-marker",
      "relaunch-process-marker",
      "helper-process-marker",
      "candidate-sha",
      "candidate-version",
    ].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of [
  "app",
  "driver",
  "native-driver",
  "output",
  "staging",
  "stage-marker",
  "relaunch-process-marker",
  "helper-process-marker",
])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`);
assert.match(values["candidate-sha"] ?? "", /^[0-9a-f]{64}$/u);
assert.ok(values["candidate-version"]);
const output = values.output;
await mkdir(output, { recursive: false });
const report = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  app: values.app,
  initial_sha256: null,
  candidate_sha256: values["candidate-sha"],
  candidate_version: values["candidate-version"],
  actions: [],
  failure: null,
};
const evidencePath = path.join(output, "renderer-update-evidence.json");
async function save() {
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
async function procIdentity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const rest = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const command = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .replaceAll("\0", " ")
      .slice(0, 400);
    return rest[0] !== "Z" && rest[19] ? { pid, start_ticks: rest[19], command } : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}
async function verifiedRelaunchIdentity(marker) {
  assert.equal(marker?.schema_version, 1, "Relaunch process marker schema changed");
  assert.ok(Number.isInteger(marker.process_id) && marker.process_id > 0);
  assert.equal(marker.executable, values.app, "Relaunch process marker executable changed");
  const identity = await procIdentity(marker.process_id);
  if (!identity) return null;
  const environment = await readRelaunchEnvironment(identity);
  if (!environment) return null;
  const after = await procIdentity(marker.process_id);
  if (!after) return null;
  assert.equal(after.start_ticks, identity.start_ticks, "Relaunched process identity changed");
  assertRelaunchEnvironment(environment);
  return after;
}
async function readRelaunchEnvironment(identity) {
  let environment;
  try {
    environment = (await readFile(`/proc/${identity.pid}/environ`, "utf8")).split("\0");
  } catch (error) {
    const after = await procIdentity(identity.pid);
    if (!after) return null;
    if (after.start_ticks !== identity.start_ticks)
      throw new Error("Relaunched process identity changed while reading its environment");
    throw error;
  }
  return environment;
}
function assertRelaunchEnvironment(environment) {
  for (const expected of [
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE=${values["stage-marker"]}`,
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS=${values["relaunch-process-marker"]}`,
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation",
  ])
    if (!environment.includes(expected))
      throw new Error("Relaunched process did not retain the exact qualification identity");
}
async function verifiedHelperIdentity(marker) {
  assert.equal(marker?.schema_version, 1, "Helper process marker schema changed");
  assert.ok(Number.isInteger(marker.process_id) && marker.process_id > 0);
  const identity = await procIdentity(marker.process_id);
  if (!identity) return null;
  const environment = await readRelaunchEnvironment(identity);
  if (!environment) return null;
  const after = await procIdentity(marker.process_id);
  if (!after) return null;
  assert.equal(after.start_ticks, identity.start_ticks, "Helper process identity changed");
  assert.ok(after.command.includes("--portcove-apply-update"), "Marked process is not the helper");
  assert.ok(
    environment.includes(
      `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS=${values["helper-process-marker"]}`,
    ),
    "Helper process lost its qualification identity",
  );
  return after;
}
async function terminateVerifiedProcess(live, label) {
  try {
    process.kill(live.pid, "SIGTERM");
  } catch {
    /* already exited */
  }
  await waitFor(async () => !(await procIdentity(live.pid)), label, 5_000).catch(async () => {
    if ((await procIdentity(live.pid))?.start_ticks === live.start_ticks)
      try {
        process.kill(live.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
  });
}
async function cleanupRelaunch() {
  const marker =
    report.relaunch_process_marker ?? (await readJson(values["relaunch-process-marker"]));
  const live = await verifiedRelaunchIdentity(marker);
  if (live) {
    if (report.relaunch_identity && live.start_ticks !== report.relaunch_identity.start_ticks)
      throw new Error("Relaunched process identity changed before cleanup");
    await terminateVerifiedProcess(live, "owned candidate exit");
  }
  const remaining = await procIdentity(marker.process_id);
  if (live && remaining?.start_ticks === live.start_ticks)
    throw new Error("Relaunched candidate did not exit after identity-bound cleanup");
  return "candidate-exited";
}
async function cleanupHelper() {
  const marker = report.helper_process_marker ?? (await readJson(values["helper-process-marker"]));
  const live = await verifiedHelperIdentity(marker);
  if (live) {
    if (report.helper_identity && live.start_ticks !== report.helper_identity.start_ticks)
      throw new Error("Helper process identity changed before cleanup");
    await terminateVerifiedProcess(live, "owned helper exit");
  }
  const remaining = await procIdentity(marker.process_id);
  if (live && remaining?.start_ticks === live.start_ticks)
    throw new Error("Helper process did not exit after identity-bound cleanup");
  return "helper-exited";
}
async function ownedProcessTree(rootPid) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of rows)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  return (await Promise.all([...owned].map(procIdentity))).filter(Boolean);
}
let driver;
let browser;
let driverSession;
try {
  report.initial_sha256 = (await hashFile(values.app)).sha256;
  driverSession = startInstalledUpdateDriver(values.driver, values["native-driver"], {
    detached: true,
    env: process.env,
  });
  driver = driverSession.driver;
  report.driver = await awaitInstalledUpdateDriver(driver, procIdentity);
  assert.ok(report.driver);
  browser = await connectInstalledUpdateDriver(values.app);
  await driveInstalledUpdateToRestart(browser, report.actions);
  const stagedPayload = path.join(values.staging, "candidate.payload");
  const staged = await verifyInstalledUpdateStaging({
    stagingRoot: values.staging,
    payloadName: "candidate.payload",
    candidateSha: values["candidate-sha"],
    candidateVersion: values["candidate-version"],
    application: values.app,
    initialSha: report.initial_sha256,
  });
  report.staged = staged;
  report.actions.push("renderer-downloaded-and-verified");
  await writeFile(path.join(output, "before-restart.png"), await browser.takeScreenshot(), {
    encoding: "base64",
  });
  report.processes_before_restart = await ownedProcessTree(driver.pid);
  await save();
  try {
    report.restart_action_attempted = true;
    await browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click();
    report.restart_click = "returned";
  } catch (error) {
    report.restart_click = `session-ended: ${String(error.message).slice(0, 300)}`;
  }
  report.helper_process_marker = await waitFor(
    () => readJson(values["helper-process-marker"]),
    "parent-owned helper process marker",
    15_000,
  );
  report.helper_identity = await verifiedHelperIdentity(report.helper_process_marker);
  const initialApplication = report.processes_before_restart.find((entry) =>
    entry.command.includes("portcove-desktop"),
  );
  report.initial_application_after_helper_spawn = initialApplication
    ? await procIdentity(initialApplication.pid)
    : null;
  report.relaunch_process_marker = await waitFor(
    () => readJson(values["relaunch-process-marker"]),
    "helper-owned candidate process marker",
    60_000,
  );
  report.relaunch_identity = await verifiedRelaunchIdentity(report.relaunch_process_marker);
  const restart = await waitFor(
    async () => {
      const marker = await readJson(values["stage-marker"]);
      if (marker.stage !== "Tauri setup" || marker.process_id <= 0) return null;
      if ((await hashFile(values.app)).sha256 !== values["candidate-sha"]) return null;
      const apply = await readJson(path.join(values.staging, "apply.json"));
      if (apply.intent !== null) return null;
      try {
        await stat(stagedPayload);
        return null;
      } catch {
        /* retired after healthy startup */
      }
      return { marker, apply_phase: apply.phase, stable_sha256: values["candidate-sha"] };
    },
    "renderer-driven restart and healthy-startup reconciliation",
    90_000,
  );
  report.restart = restart;
  await waitFor(
    async () => !(await procIdentity(restart.marker.process_id)),
    "candidate healthy-startup qualification exit",
    15_000,
  );
  report.restart.candidate_exit_observed = true;
  report.actions.push("candidate-restarted-and-reconciled");
  report.phase = "complete";
} catch (error) {
  await recordInstalledUpdateFailure(report, error, values["helper-process-marker"]);
  if (report.processes_before_restart) {
    const initialApplication = report.processes_before_restart.find((entry) =>
      entry.command.includes("portcove-desktop"),
    );
    report.initial_application_at_failure = initialApplication
      ? await procIdentity(initialApplication.pid)
      : null;
  }
  process.exitCode = 1;
} finally {
  if (report.restart_action_attempted) {
    try {
      report.helper_cleanup = await cleanupHelper();
    } catch (error) {
      report.phase = "failed";
      report.helper_cleanup = `uncertain: ${String(error.message).slice(0, 300)}`;
      report.failure = `${report.failure ?? "Qualification failed"}; ${report.helper_cleanup}`;
      process.exitCode = 1;
    }
  }
  if (driver && !report.processes_before_restart)
    report.processes_before_restart = await ownedProcessTree(driver.pid).catch(() => []);
  if (browser)
    await Promise.race([
      browser.quit().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  if (driver) {
    const current = await procIdentity(driver.pid);
    if (current && report.driver && current.start_ticks === report.driver.start_ticks) {
      try {
        process.kill(-driver.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      await waitFor(
        async () => !(await procIdentity(driver.pid)),
        "owned tauri-driver exit",
        5_000,
      ).catch(() => {
        if (driver.pid && report.driver?.start_ticks === current.start_ticks)
          try {
            process.kill(-driver.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
      });
    }
    for (const entry of [...report.processes_before_restart].reverse()) {
      const live = await procIdentity(entry.pid);
      if (live?.start_ticks !== entry.start_ticks) continue;
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    report.processes_after_driver_stop = (
      await Promise.all(report.processes_before_restart.map((entry) => procIdentity(entry.pid)))
    ).filter(
      (entry, index) =>
        entry && entry.start_ticks === report.processes_before_restart[index].start_ticks,
    );
    if (report.processes_after_driver_stop.length) {
      report.phase = "failed";
      report.failure = `${report.failure ?? "Qualification failed"}; owned WebDriver or application processes remained after bounded cleanup`;
      process.exitCode = 1;
    }
  }
  if (report.restart_action_attempted) {
    try {
      report.relaunch_cleanup = await cleanupRelaunch();
    } catch (error) {
      report.phase = "failed";
      report.relaunch_cleanup = `uncertain: ${String(error.message).slice(0, 300)}`;
      report.failure = `${report.failure ?? "Qualification failed"}; ${report.relaunch_cleanup}`;
      process.exitCode = 1;
    }
  }
  await writeFile(path.join(output, "driver.log"), driverSession?.log ?? "");
  await save();
}
if (report.phase !== "complete")
  throw new Error(report.failure ?? "AppImage renderer qualification failed");
