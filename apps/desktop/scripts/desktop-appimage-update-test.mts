import { errorMessage, errorCode } from "../../../scripts/runtime-values.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { By } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { InstalledUpdateFailure } from "./desktop-installed-update-harness.mts";
import { driveInstalledUpdateToRestart } from "./desktop-application-update-journey.mts";
import { loadedWebKitLibraries } from "./desktop-linux-webkit-inspector.mts";
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
  driverPath = absoluteOption("driver"),
  nativeDriver = absoluteOption("native-driver"),
  output = absoluteOption("output"),
  staging = absoluteOption("staging");
const stageMarker = absoluteOption("stage-marker"),
  relaunchMarker = absoluteOption("relaunch-process-marker"),
  helperMarker = absoluteOption("helper-process-marker");
const candidateSha = requiredOption("candidate-sha"),
  candidateVersion = requiredOption("candidate-version");
assert.match(candidateSha, /^[0-9a-f]{64}$/u);
await mkdir(output, { recursive: false });
interface ProcIdentity {
  pid: number;
  start_ticks: string;
  command: string;
}
interface ProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}
interface AppImageRestart {
  marker: { stage: "Tauri setup"; process_id: number };
  apply_phase: unknown;
  stable_sha256: string;
  candidate_exit_observed?: boolean;
}
interface AppImageUpdateReport extends InstalledUpdateFailure {
  schema_version: 1;
  source_commit: string;
  app: string;
  initial_sha256: string | null;
  candidate_sha256: string;
  candidate_version: string;
  actions: string[];
  driver?: ProcIdentity;
  staged?: Awaited<ReturnType<typeof verifyInstalledUpdateStaging>>;
  ordinary_staging?: Awaited<ReturnType<typeof driveInstalledUpdateToRestart>>;
  processes_before_restart?: ProcIdentity[];
  loaded_engine_before_restart?: Awaited<ReturnType<typeof loadedWebKitLibraries>>;
  restart_action_attempted?: boolean;
  restart_click?: string;
  helper_process_marker?: ProcessMarker;
  helper_identity?: ProcIdentity | null;
  relaunch_process_marker?: ProcessMarker;
  relaunch_identity?: ProcIdentity | null;
  initial_application_after_helper_spawn?: ProcIdentity | null;
  initial_application_at_failure?: ProcIdentity | null;
  restart?: AppImageRestart;
  helper_cleanup?: string;
  relaunch_cleanup?: string;
  processes_after_driver_stop?: ProcIdentity[];
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
  assert.ok(typeof marker.executable === "string" && path.isAbsolute(marker.executable));
  return {
    ...marker,
    schema_version: 1,
    process_id: positivePid(marker.process_id),
    executable: marker.executable,
  };
}
const report: AppImageUpdateReport = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  app,
  initial_sha256: null,
  candidate_sha256: candidateSha,
  candidate_version: candidateVersion,
  actions: [],
  failure: null,
};
const evidencePath = path.join(output, "renderer-update-evidence.json");
async function save() {
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
async function procIdentity(pid: number): Promise<ProcIdentity | null> {
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
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw error;
  }
}
async function verifiedRelaunchIdentity(marker: ProcessMarker) {
  assert.equal(marker?.schema_version, 1, "Relaunch process marker schema changed");
  assert.ok(Number.isInteger(marker.process_id) && marker.process_id > 0);
  assert.equal(marker.executable, app, "Relaunch process marker executable changed");
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
async function readRelaunchEnvironment(identity: ProcIdentity) {
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
function assertRelaunchEnvironment(environment: string[]) {
  for (const expected of [
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE=${stageMarker}`,
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS=${relaunchMarker}`,
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation",
  ])
    if (!environment.includes(expected))
      throw new Error("Relaunched process did not retain the exact qualification identity");
}
async function verifiedHelperIdentity(marker: ProcessMarker) {
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
      `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS=${helperMarker}`,
    ),
    "Helper process lost its qualification identity",
  );
  return after;
}
async function terminateVerifiedProcess(live: ProcIdentity, label: string) {
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
  const marker = report.relaunch_process_marker ?? processMarker(await readJson(relaunchMarker));
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
  const marker = report.helper_process_marker ?? processMarker(await readJson(helperMarker));
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
async function ownedProcessTree(rootPid: number) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line: string) => {
      const fields = line.trim().split(/\s+/u).map(Number);
      assert.equal(fields.length, 2, "Process tree row must contain PID and parent PID");
      const pid = positivePid(fields[0]),
        parent = fields[1];
      assert.ok(typeof parent === "number" && Number.isSafeInteger(parent) && parent >= 0);
      return [pid, parent] as const;
    });
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of rows)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  return (await Promise.all([...owned].map(procIdentity))).filter((entry) => entry !== null);
}
let driver: ReturnType<typeof startInstalledUpdateDriver>["driver"] | undefined;
let browser: WebDriver | undefined;
let driverSession: ReturnType<typeof startInstalledUpdateDriver> | undefined;
try {
  report.initial_sha256 = (await hashFile(app)).sha256;
  driverSession = startInstalledUpdateDriver(driverPath, nativeDriver, {
    detached: true,
    env: process.env,
  });
  driver = driverSession.driver;
  assert.ok(driver.pid, "Owned driver PID required");
  report.driver = await awaitInstalledUpdateDriver(driver, procIdentity);
  assert.ok(report.driver);
  browser = await connectInstalledUpdateDriver(app);
  report.ordinary_staging = await driveInstalledUpdateToRestart(
    browser,
    report.actions,
    candidateVersion,
  );
  const stagedPayload = path.join(staging, "candidate.payload");
  const staged = await verifyInstalledUpdateStaging({
    stagingRoot: staging,
    payloadName: "candidate.payload",
    candidateSha: candidateSha,
    candidateVersion,
    application: app,
    initialSha: report.initial_sha256,
  });
  report.staged = staged;
  report.actions.push("renderer-downloaded-and-verified");
  await writeFile(path.join(output, "before-restart.png"), await browser.takeScreenshot(), {
    encoding: "base64",
  });
  report.processes_before_restart = await ownedProcessTree(driver.pid);
  const engineProcesses = report.processes_before_restart.filter(
    (entry) => path.basename(entry.command.split(" ")[0] ?? "") === "portcove-desktop",
  );
  assert.equal(engineProcesses.length, 1, "Exactly one owned running AppImage desktop required");
  const engineProcess = engineProcesses[0];
  assert.ok(engineProcess);
  report.loaded_engine_before_restart = await loadedWebKitLibraries(engineProcess.pid);
  assert.equal(report.loaded_engine_before_restart.process.start_ticks, engineProcess.start_ticks);
  await save();
  try {
    report.restart_action_attempted = true;
    await browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click();
    report.restart_click = "returned";
  } catch (error) {
    report.restart_click = `session-ended: ${String(errorMessage(error)).slice(0, 300)}`;
  }
  report.helper_process_marker = processMarker(
    await waitFor(() => readJson(helperMarker), "parent-owned helper process marker", 15_000),
  );
  report.helper_identity = await verifiedHelperIdentity(report.helper_process_marker);
  const initialApplication = report.processes_before_restart.find((entry) =>
    entry.command.includes("portcove-desktop"),
  );
  report.initial_application_after_helper_spawn = initialApplication
    ? await procIdentity(initialApplication.pid)
    : null;
  report.relaunch_process_marker = processMarker(
    await waitFor(() => readJson(relaunchMarker), "helper-owned candidate process marker", 60_000),
  );
  report.relaunch_identity = await verifiedRelaunchIdentity(report.relaunch_process_marker);
  const restart = await waitFor(
    async () => {
      const marker = object(await readJson(stageMarker));
      if (marker.stage !== "Tauri setup") return null;
      const processId = positivePid(marker.process_id);
      if ((await hashFile(app)).sha256 !== candidateSha) return null;
      const apply = object(await readJson(path.join(staging, "apply.json")));
      if (apply.intent !== null) return null;
      try {
        await stat(stagedPayload);
        return null;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        /* retired after healthy startup */
      }
      return {
        marker: { ...marker, stage: "Tauri setup" as const, process_id: processId },
        apply_phase: apply.phase,
        stable_sha256: candidateSha,
      };
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
  await recordInstalledUpdateFailure(report, error, helperMarker);
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
      report.helper_cleanup = `uncertain: ${String(errorMessage(error)).slice(0, 300)}`;
      report.failure = `${report.failure ?? "Qualification failed"}; ${report.helper_cleanup}`;
      process.exitCode = 1;
    }
  }
  if (driver?.pid && !report.processes_before_restart)
    report.processes_before_restart = await ownedProcessTree(driver.pid).catch(() => []);
  if (browser)
    await Promise.race([
      browser.quit().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  if (driver?.pid) {
    const driverPid = driver.pid;
    const ownedProcesses = report.processes_before_restart;
    assert.ok(ownedProcesses);
    const current = await procIdentity(driverPid);
    if (current && report.driver && current.start_ticks === report.driver.start_ticks) {
      try {
        process.kill(-driverPid, "SIGTERM");
      } catch {
        /* already exited */
      }
      await waitFor(
        async () => !(await procIdentity(driverPid)),
        "owned tauri-driver exit",
        5_000,
      ).catch(() => {
        if (report.driver?.start_ticks === current.start_ticks)
          try {
            process.kill(-driverPid, "SIGKILL");
          } catch {
            /* already exited */
          }
      });
    }
    for (const entry of [...ownedProcesses].reverse()) {
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
      await Promise.all(ownedProcesses.map((entry) => procIdentity(entry.pid)))
    ).filter(
      (entry, index): entry is ProcIdentity =>
        entry !== null && entry.start_ticks === ownedProcesses[index]?.start_ticks,
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
      report.relaunch_cleanup = `uncertain: ${String(errorMessage(error)).slice(0, 300)}`;
      report.failure = `${report.failure ?? "Qualification failed"}; ${report.relaunch_cleanup}`;
      process.exitCode = 1;
    }
  }
  await writeFile(path.join(output, "driver.log"), driverSession?.log ?? "");
  await save();
}
if (report.phase !== "complete")
  throw new Error(report.failure ?? "AppImage renderer qualification failed");
