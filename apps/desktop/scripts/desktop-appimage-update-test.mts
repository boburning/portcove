import { errorMessage } from "../../../scripts/runtime-values.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { writeFile, mkdir, copyFile, chmod, lstat, readlink, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { By, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { InstalledUpdateFailure } from "./desktop-installed-update-harness.mts";
import {
  driveInstalledStableWaiting,
  driveInstalledUpdateToRestart,
} from "./desktop-application-update-journey.mts";
import { loadedWebKitLibraries } from "./desktop-linux-webkit-inspector.mts";
import { readHistoricalLinuxInputs } from "../../../scripts/updater-historical-inputs.mts";
import { assertOwnedUnlinkedPath } from "../../../scripts/release-path-safety.mts";
import { readBoundedPublicBuildInputFile } from "../../../scripts/release-public-build-inputs.mts";
import {
  createAppImageProcessObservations,
  waitForHealthyAppImageRestart,
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
      "historical-bootstrap-manifest",
      "bootstrap-predecessor",
      "bootstrap-predecessor-sha",
      "bootstrap-library",
      "bootstrap-game-cli-manifest",
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
  game_data_events?: Array<{ phase: string; details: unknown }>;
  game_data_predecessor_cli?: unknown;
  installed_game_data?: Awaited<
    ReturnType<
      typeof import("../../../scripts/installed-game-data-fixture.mts").seedInstalledGameData
    >
  >;
  installed_game_data_after_update?: Awaited<
    ReturnType<
      typeof import("../../../scripts/installed-game-data-fixture.mts").observeInstalledGameData
    >
  >;
  stable_waiting?: Awaited<ReturnType<typeof driveInstalledStableWaiting>> & {
    installed_appimage_sha256_before: string;
    installed_appimage_sha256_after: string;
  };
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
  historical_bootstrap?: {
    phase: string;
    inputs: Awaited<ReturnType<typeof readHistoricalLinuxInputs>>;
    saved_library_choice: unknown;
    cli_observed_version?: string;
    data_scope: string;
    desktop_entry_preservation: string;
    initial_marker_sha256?: string;
    initial_preferences_sha256?: string;
    private_bus_id_sha256?: string;
    caller?: {
      uid: number;
      gid: number;
      groups: number[];
      architecture: string;
      credential_status: string[];
    };
    application_credential_status?: string[];
    window_title?: string;
    window_body_excerpt?: string;
    saved_library_selection?: { root: string; source: "saved"; card_text: string };
    normal_close_before_driver_teardown?: boolean;
    driver?: ProcIdentity;
    application?: ProcIdentity;
    driver_log?: string;
    driver_teardown?: { exit_code: number | null; signal: NodeJS.Signals | null };
    snapshots: unknown[];
  };
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
const { procIdentity, verifiedRelaunchIdentity, verifiedHelperIdentity } =
  createAppImageProcessObservations({ app, stageMarker, relaunchMarker, helperMarker });
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
const applicationEnvironment = { ...process.env };
if (values["historical-bootstrap-manifest"])
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "RUSTC"])
    delete applicationEnvironment[name];
if (values["historical-bootstrap-manifest"])
  applicationEnvironment.PATH = applicationEnvironment.PATH?.split(path.delimiter)
    .filter((entry) => !/(?:^|\/)\.(?:cargo|rustup)(?:\/|$)/u.test(entry))
    .join(path.delimiter);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function historicalSnapshot(phase: string) {
  const historical = report.historical_bootstrap;
  assert.ok(historical);
  const preferences = process.env.PORTCOVE_PREFERENCES;
  assert.ok(preferences && path.isAbsolute(preferences));
  const raw = await readBoundedPublicBuildInputFile(
    projectRoot,
    path.relative(projectRoot, preferences),
    65536,
  );
  const preferencesSha = createHash("sha256").update(raw).digest("hex");
  historical.initial_preferences_sha256 ??= preferencesSha;
  assert.equal(
    preferencesSha,
    historical.initial_preferences_sha256,
    "Normally saved host preferences changed",
  );
  const data = object(JSON.parse(raw.toString("utf8")));
  assert.equal(data.format_version, 1);
  const library = absoluteOption("bootstrap-library");
  assert.equal(data.library_root, library);
  const marker = await hashFile(path.join(library, "update-preservation-marker.txt"));
  assert.equal(
    marker.sha256,
    historical.initial_marker_sha256,
    "Original marker changed; never reseed it",
  );
  const installed = await lstat(app);
  assert.ok(installed.isFile());
  assert.equal(installed.uid, process.getuid?.(), "Installed AppImage ownership changed");
  const busId = execFileSync(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.GetId",
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  const names = execFileSync(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListNames",
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  assert.ok(
    !names.includes("org.freedesktop.secrets"),
    "Private secret service activated; inspect ownership before continuing",
  );
  const busSha = createHash("sha256").update(busId).digest("hex");
  historical.private_bus_id_sha256 ??= busSha;
  assert.equal(busSha, historical.private_bus_id_sha256);
  historical.snapshots.push({
    phase,
    preferences: { bytes: raw.length, sha256: preferencesSha, data },
    marker,
    stable: await hashFile(app),
    owner_uid: installed.uid,
    mode: (installed.mode & 0o7777).toString(8),
    private_bus_id_sha256: busSha,
    secret_service_registered: false,
  });
  await save();
}
async function historicalPrelude() {
  const inputs = await readHistoricalLinuxInputs(
    projectRoot,
    absoluteOption("historical-bootstrap-manifest"),
  );
  assert.ok(
    process.getuid && process.getuid() !== 0,
    "Historical AppImage caller must be rootless",
  );
  assert.equal(process.arch, "x64");
  const library = absoluteOption("bootstrap-library");
  const predecessor = absoluteOption("bootstrap-predecessor");
  const predecessorSha = requiredOption("bootstrap-predecessor-sha");
  assert.match(predecessorSha, /^[a-f0-9]{64}$/u);
  await assertOwnedUnlinkedPath(projectRoot, app, "historical stable AppImage");
  await assertOwnedUnlinkedPath(projectRoot, library, "historical library");
  const pre = await lstat(predecessor);
  assert.ok(pre.isFile() && pre.size > 0 && pre.size <= 512 * 1024 * 1024);
  const preBytes = await readBoundedPublicBuildInputFile(
    projectRoot,
    path.relative(projectRoot, predecessor),
    pre.size,
  );
  assert.equal(createHash("sha256").update(preBytes).digest("hex"), predecessorSha);
  await assert.rejects(lstat(app), { code: "ENOENT" }, "Bootstrap destination must be new");
  const oldEnvironment = { ...applicationEnvironment };
  for (const name of Object.keys(oldEnvironment))
    if (
      name.startsWith("PORTCOVE_APPLICATION_") ||
      name.startsWith("TAURI_SIGNING_") ||
      ["PORTCOVE_LIBRARY", "PORTCOVE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].includes(name)
    )
      delete oldEnvironment[name];
  const historical: NonNullable<AppImageUpdateReport["historical_bootstrap"]> = {
    phase: "preparing-saved-library-choice",
    inputs,
    saved_library_choice: null,
    data_scope:
      "normally saved library preference and one synthetic marker; no installed game/save/credential continuity",
    desktop_entry_preservation:
      "not_evaluated; this continuous renderer installation has no desktop entry; lifecycle entry evidence is separate",
    snapshots: [] as unknown[],
  };
  report.historical_bootstrap = historical;
  historical.caller = {
    uid: process.getuid(),
    gid: process.getgid!(),
    groups: process.getgroups!(),
    architecture: process.arch,
    credential_status: (await readFile("/proc/self/status", "utf8"))
      .split("\n")
      .filter((line) => /^(Uid|Gid|CapEff|NoNewPrivs):/u.test(line)),
  };
  await save();
  historical.cli_observed_version = execFileSync(inputs.files.cli.path, ["--version"], {
    env: oldEnvironment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65536,
  }).trim();
  assert.equal(historical.cli_observed_version, `portcove ${inputs.version}`);
  const cliResults: Record<string, unknown>[] = [];
  for (const args of [
    ["--json", "library", "set", library],
    ["--json", "library", "show"],
  ]) {
    const result = object(
      JSON.parse(
        execFileSync(inputs.files.cli.path, args, {
          env: oldEnvironment,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 65536,
        }),
      ),
    );
    assert.equal(result.ok, true);
    const resultData = object(result.data);
    assert.equal(resultData.root, library);
    assert.equal(resultData.source, "saved");
    cliResults.push(result);
  }
  historical.saved_library_choice = cliResults;
  const marker = path.join(library, "update-preservation-marker.txt");
  await writeFile(marker, "Installed AppImage renderer update preservation\n", { flag: "wx" });
  historical.initial_marker_sha256 = (await hashFile(marker)).sha256;
  await copyFile(inputs.files.appimage.path, app, constants.COPYFILE_EXCL);
  await chmod(app, 0o755);
  assert.equal((await hashFile(app)).sha256, inputs.files.appimage.sha256);
  await historicalSnapshot("before-updaterless-startup");
  driverSession = startInstalledUpdateDriver(driverPath, nativeDriver, {
    detached: true,
    env: oldEnvironment,
  });
  driver = driverSession.driver;
  report.driver = await awaitInstalledUpdateDriver(driver, procIdentity);
  historical.driver = report.driver;
  assert.ok(historical.driver);
  historical.phase = "ordinary-updaterless-session-starting";
  await save();
  browser = await connectInstalledUpdateDriver(app);
  historical.application = await waitFor(
    async () => {
      assert.ok(driver?.pid);
      const matches = [];
      for (const before of await ownedProcessTree(driver.pid)) {
        try {
          const image = await readlink(`/proc/${before.pid}/exe`);
          if (path.basename(image) !== "portcove-desktop") continue;
          const env = (await readFile(`/proc/${before.pid}/environ`, "utf8")).split("\0");
          if (!env.includes(`APPIMAGE=${app}`)) continue;
          const after = await procIdentity(before.pid);
          if (after?.start_ticks === before.start_ticks) matches.push(after);
        } catch (error) {
          if (
            !["ENOENT", "ESRCH", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))
          )
            throw error;
        }
      }
      assert.ok(matches.length <= 1, "Historical application identity is ambiguous");
      return matches[0];
    },
    "ordinary updater-less application identity",
    15_000,
  );
  historical.window_title = await browser.getTitle();
  historical.window_body_excerpt = await waitFor(
    async () => {
      assert.ok(browser);
      const text: unknown = await browser.executeScript(
        "return document.readyState === 'complete' ? document.body.innerText : ''",
      );
      if (typeof text !== "string" || !text.includes("No installed ports yet")) return undefined;
      const ready: unknown = await browser.executeScript(
        "return !!document.querySelector('[aria-label=\"Primary navigation\"]') && !document.querySelector('.loading-state')",
      );
      return ready === true ? text.slice(0, 3000) : undefined;
    },
    "ordinary historical settled empty library",
    30_000,
  );
  assert.ok(historical.application);
  historical.application_credential_status = (
    await readFile(`/proc/${historical.application.pid}/status`, "utf8")
  )
    .split("\n")
    .filter((line) => /^(Uid|Gid|CapEff|NoNewPrivs):/u.test(line));
  const appUid = historical.application_credential_status.find((line) => line.startsWith("Uid:"));
  assert.ok(
    appUid &&
      appUid
        .split(/\s+/u)
        .slice(1)
        .every((value) => Number(value) === process.getuid!()),
  );
  assert.ok(historical.application_credential_status.includes("CapEff:\t0000000000000000"));
  await writeFile(
    path.join(output, "historical-window.png"),
    Buffer.from(await browser.takeScreenshot(), "base64"),
  );
  await browser
    .findElement(
      By.xpath(
        '//nav[@aria-label="Primary navigation"]//button[.//span[normalize-space(.)="Settings"]]',
      ),
    )
    .click();
  const selectionCard = await browser.wait(
    until.elementLocated(By.xpath('//article[.//h2[normalize-space(.)="Startup selection"]]')),
    15_000,
  );
  await browser.wait(until.elementIsVisible(selectionCard), 15_000);
  const selectionText = await selectionCard.getText();
  const selectedRoot = await selectionCard.findElement(By.css("code")).getText();
  assert.equal(selectedRoot, library);
  assert.ok(selectionText.includes("Saved host preference"));
  historical.saved_library_selection = {
    root: selectedRoot,
    source: "saved",
    card_text: selectionText,
  };
  await browser.executeScript("arguments[0].scrollIntoView({block: 'center'})", selectionCard);
  await writeFile(
    path.join(output, "historical-preferences.png"),
    Buffer.from(await browser.takeScreenshot(), "base64"),
  );
  await browser.close();
  const application = historical.application;
  assert.ok(application);
  await waitFor(
    async () => (await procIdentity(application.pid))?.start_ticks !== application.start_ticks,
    "updater-less application natural close before driver teardown",
    15_000,
  );
  assert.equal(driver.exitCode, null);
  assert.equal(driver.signalCode, null);
  assert.equal(
    (await procIdentity(historical.driver.pid))?.start_ticks,
    historical.driver.start_ticks,
  );
  historical.normal_close_before_driver_teardown = true;
  await historicalSnapshot("after-updaterless-normal-close");
  const oldDriver = historical.driver;
  const oldTree = await ownedProcessTree(oldDriver.pid);
  await Promise.race([
    browser.quit().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  browser = undefined;
  historical.driver_log = driverSession.log;
  const liveDriver = await procIdentity(oldDriver.pid);
  if (liveDriver) {
    assert.equal(liveDriver.start_ticks, oldDriver.start_ticks);
    process.kill(-oldDriver.pid, "SIGTERM");
  }
  await waitFor(
    async () => {
      const live = await Promise.all(
        oldTree.map(async (old) => (await procIdentity(old.pid))?.start_ticks === old.start_ticks),
      );
      return live.every((value) => !value);
    },
    "historical owned driver tree teardown after normal application close",
    5000,
  );
  historical.driver_teardown = { exit_code: driver.exitCode, signal: driver.signalCode };
  driver = undefined;
  driverSession = undefined;
  assert.equal((await hashFile(app)).sha256, inputs.files.appimage.sha256);
  await copyFile(predecessor, app);
  await chmod(app, 0o755);
  assert.equal((await hashFile(app)).sha256, predecessorSha);
  await historicalSnapshot("after-manual-same-path-updater-enabled-replacement");
  historical.phase = "complete";
  await save();
}
let verifyInstalledGameData: (() => Promise<void>) | undefined;
try {
  if (values["bootstrap-game-cli-manifest"])
    assert.ok(
      values["historical-bootstrap-manifest"],
      "Game data requires the historical installed chain",
    );
  if (values["historical-bootstrap-manifest"]) await historicalPrelude();
  if (values["bootstrap-game-cli-manifest"]) {
    const {
      readInstalledGameCliReceipt,
      seedInstalledGameData,
      observeInstalledGameData,
      assertInstalledGameDataPreserved,
    } = await import("../../../scripts/installed-game-data-fixture.mts");
    const selected = await readInstalledGameCliReceipt(
      projectRoot,
      absoluteOption("bootstrap-game-cli-manifest"),
      report.source_commit,
    );
    report.game_data_predecessor_cli = selected.receipt;
    const gameDataEvents: Array<{ phase: string; details: unknown }> = [];
    report.game_data_events = gameDataEvents;
    assert.ok(applicationEnvironment.XDG_CONFIG_HOME);
    const options = {
      ownedRoot: selected.ownedRoot,
      library: absoluteOption("bootstrap-library"),
      playerRoot: path.join(applicationEnvironment.XDG_CONFIG_HOME, "opentyrian"),
      cli: selected.cli.path,
      cliSha256: selected.cli.sha256,
      cliVersion: selected.cli.version,
      cliSourceCommit: report.source_commit,
      platform: "linux-x86_64" as const,
      environment: applicationEnvironment,
      record: async (event: { phase: string; details: unknown }) => {
        gameDataEvents.push(event);
        await save();
      },
    };
    await historicalSnapshot("before-real-game-data-seed");
    const prepared = await seedInstalledGameData(options);
    report.installed_game_data = prepared;
    await historicalSnapshot("after-real-game-data-seed");
    verifyInstalledGameData = async () => {
      const after = await observeInstalledGameData(options, prepared.baseline.installed);
      report.installed_game_data_after_update = after;
      await save();
      assertInstalledGameDataPreserved(prepared.baseline, after);
      report.actions.push("game-authored-save-config-and-installed-runtime-preserved");
    };
  }
  report.initial_sha256 = (await hashFile(app)).sha256;
  driverSession = startInstalledUpdateDriver(driverPath, nativeDriver, {
    detached: true,
    env: applicationEnvironment,
  });
  driver = driverSession.driver;
  assert.ok(driver.pid, "Owned driver PID required");
  report.driver = await awaitInstalledUpdateDriver(driver, procIdentity);
  assert.ok(report.driver);
  browser = await connectInstalledUpdateDriver(app);
  if (report.historical_bootstrap) await historicalSnapshot("after-updater-enabled-startup");
  if (report.historical_bootstrap) {
    const beforeWaiting = (await hashFile(app)).sha256;
    assert.equal(beforeWaiting, report.initial_sha256);
    const waiting = await driveInstalledStableWaiting(browser, report.actions);
    const afterWaiting = (await hashFile(app)).sha256;
    assert.equal(afterWaiting, beforeWaiting);
    report.stable_waiting = {
      ...waiting,
      installed_appimage_sha256_before: beforeWaiting,
      installed_appimage_sha256_after: afterWaiting,
    };
    await historicalSnapshot("after-fresh-stable-waiting");
    await save();
  }
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
  const restart = await waitForHealthyAppImageRestart({
    app,
    candidateSha,
    staging,
    stageMarker,
    stagedPayload,
  });
  report.restart = restart;
  await waitFor(
    async () => !(await procIdentity(restart.marker.process_id)),
    "candidate healthy-startup qualification exit",
    15_000,
  );
  report.restart.candidate_exit_observed = true;
  report.actions.push("candidate-restarted-and-reconciled");
  if (report.historical_bootstrap) await historicalSnapshot("after-authenticated-candidate-return");
  await verifyInstalledGameData?.();
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
