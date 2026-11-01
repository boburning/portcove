import { observeVisibleTarget } from "./browser-readiness.mts";
import { captureStartupDiagnostics } from "./desktop-startup-diagnostics.mts";
import { errorCode, errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { reenterResourceCommand } from "../../../scripts/resource-command.mts";
import os from "node:os";
import {
  writeAcceptancePreflight,
  parseAcceptancePreflightContext,
  observePacketDeliveryBindings,
} from "../../../scripts/acceptance-packet.mts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import { captureKeyboardTarget as captureNativeKeyboardTarget } from "./desktop-capture-target.mts";
import type { WebElement } from "selenium-webdriver";
import {
  parseDesktopHarnessOptions,
  resolveDesktopHarnessSelection,
} from "../../../scripts/desktop-execution-plan.mts";
import {
  readPrelaunchCustody,
  verifyConsumedInputs,
  executionAdmission,
  retainedEvidenceRoot,
  retainEvidenceInput,
} from "../../../scripts/retained-evidence.mts";
import assert from "node:assert/strict";
import { planDesktopExecution } from "../../../scripts/desktop-execution-plan.mts";
import { runOwnedFixtureJourneys } from "./desktop-owned-fixture-journeys.mts";
import { observeDesktopScenario, recordDesktopCheck } from "./desktop-scenario-outcomes.mts";
import { spawn } from "node:child_process";
import {
  DesktopNativeAccountSession,
  AccountDriverView,
} from "./desktop-native-account-session.mts";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Builder, By, Key, until, WebDriver } from "selenium-webdriver";
import { writeEvidence, fileIdentity } from "../../../scripts/development-evidence.mts";
import { observeDesktopHarnessInputs } from "../../../scripts/native-helper-dependencies.mts";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import { cachedDesktopDrivers } from "../../../scripts/tool-cache.mts";
import {
  assertOwnedBoundaryRequests,
  normalPackageBoundaryScenario,
  verifyNormalPackageEvidence,
  verifyLinuxPackageEvidence,
  createOriginBoundaryFixture,
  linuxOriginBoundaryScenario,
  prepareLinuxExternalBrowser,
} from "./desktop-main-webview-boundary.mts";
import {
  OwnedNativeSession,
  retainNativeCustody as retainOwnedNativeCustody,
  nativeSessionScript,
  readNativeProcessSnapshot,
  readNativeSessionObservation,
} from "./desktop-owned-native-session.mts";
import {
  launchLinuxNativeSession,
  LinuxLaunchPublication,
} from "./desktop-linux-native-session.mts";
import { launchIsolatedLinuxNativeSession } from "./native-linux-isolated-session.mts";
import { inspectIsolatedNativeLinuxBinding } from "./native-linux-isolated-plan.mts";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { get as httpGet } from "node:http";
import {
  connectLinuxInspector,
  LinuxInspectorProtocol,
  linuxInspectorEnvironment,
} from "./desktop-linux-webkit-inspector.mts";
import { observeStartupNetwork } from "./desktop-startup-network-diagnostic.mts";
import {
  prepareLibrarySwitchRecoveryFixture,
  librarySwitchRecoverySelection,
  librarySwitchRecoveryScenario,
} from "./desktop-library-switch-recovery-test.mts";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  preferencesRecoverySelection,
  bootstrapRecoveryScenario,
  preparePreferencesRecoveryFixture,
  preferencesRecoveryScenario,
  prepareBootstrapRecoveryFixture,
} from "./desktop-bootstrap-recovery-test.mts";
import { preparationScenarios } from "./desktop-preparation-test.mts";
import { seedSelectedSetup, selectedSetupScenario } from "./desktop-source-dialog-test.mts";
import { selectedSetupCompletionScenario } from "./desktop-selected-setup-completion-test.mts";
import { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { controllerScenario } from "./desktop-controller-test.mts";
import { accessibleNavigationScenario } from "./desktop-accessibility-test.mts";
import { interfaceSizeScenario } from "./desktop-interface-size-test.mts";
import { reloadScenario } from "./desktop-reload-test.mts";
import { workspaceRefreshScenario } from "./desktop-workspace-refresh-test.mts";
import {
  qualificationHistoryScenario,
  captureHistorySession,
  captureHistoryDriver,
  historyDriverStillOwned,
  waitHistorySessionExit,
} from "./desktop-qualification-history-test.mts";
import {
  revealDetailSection,
  clickVisible,
  assertCompactReview,
  captureAccessibilityReport,
  selectPrimaryNavigation,
  reviewControls,
  selectCatalogPort,
  openCatalogFilters,
  clearCatalogFilters,
  catalogResultPortIds,
} from "./desktop-review-controls.mts";
import { createInstallFixture } from "./desktop-install-fixture.mts";
import {
  createExternalRuntimeFixture,
  externalFixtureTreeDigest,
  externalRuntimePickerObservation,
  externalRuntimeReviewScenario,
} from "./desktop-external-runtime-test.mts";
import {
  prepareRegisteredSourceReuseInputs,
  registeredSourceReuseScenario,
} from "./desktop-source-reuse-test.mts";
import { prepareRealRuntimeInputs, realRuntimeScenario } from "./desktop-real-runtime-test.mts";
import {
  nativePickerObservation,
  nativePreparedRuntimePicker,
  nativeGameFileFolderPicker,
} from "./desktop-native-confirmation.mts";
import { installScenarios } from "./desktop-install-test.mts";
import type { AcquisitionGameObserver } from "./desktop-install-test.mts";
import { hostPublicationScenario } from "./desktop-host-publication-test.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
import { assertDesignCompatibility } from "./desktop-design-compatibility-assertions.mts";
import { catalogUpdateScenario } from "./desktop-catalog-update-test.mts";
import { defaultCoverScenario } from "./desktop-default-cover-test.mts";
import {
  desktopHarnessDeadlineMs,
  desktopScenarioById,
} from "../../../scripts/desktop-scenarios.mts";
import { acquireNativeSessionLock } from "../../../scripts/native-session-lock.mts";
import { observeStartup } from "./desktop-startup-observation.mts";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { FileIdentity, EvidenceCheck } from "../../../scripts/development-evidence.mts";
import type {
  NativeCloseObservation,
  NativeCurrentObservation,
  NativeSessionMode,
  NativeSessionObservations,
  NativeExitObservation,
  NativeStopObservation,
  NativeProcessSnapshot,
  CapturedNativeProcess,
} from "./desktop-owned-native-session.mts";
type LinuxLaunch =
  | Awaited<ReturnType<typeof launchLinuxNativeSession>>
  | Awaited<ReturnType<typeof launchIsolatedLinuxNativeSession>>;
type LinuxCleanup = Awaited<ReturnType<LinuxLaunch["stop"]>>;
type ScenarioTarget = { records: EvidenceCheck[]; setup: boolean };
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined, "Required harness observation missing");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Harness observation must be an object");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Harness text observation required");
  return value;
}
function driverBrowser(): WebDriver {
  assert.ok(
    browser instanceof WebDriver,
    "Selected scenario requires its connected WebDriver transport",
  );
  return browser;
}

function requiredInspector(): LinuxInspectorProtocol {
  assert.ok(
    browser instanceof LinuxInspectorProtocol,
    "Ordinary Linux package requires its owned inspector transport",
  );
  return browser;
}

import type { MainBoundaryBrowser } from "./desktop-main-webview-boundary.mts";
import type {
  GameFileRoot,
  GameFileScanSnapshot,
  TransportOutputs,
} from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
type IpcReply<Value> =
  | { ok: true; value: Value; error?: unknown }
  | { ok: false; error: unknown; value?: unknown };
function success<Value>(reply: IpcReply<Value>): Value {
  assert.ok(reply.ok, JSON.stringify(reply.error));
  return reply.value;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseDesktopHarnessOptions();
const linuxBinding = await (async () => {
  const filename = process.env.PORTCOVE_NATIVE_LINUX_BINDING,
    expected = process.env.PORTCOVE_NATIVE_LINUX_BINDING_SHA256;
  if (!filename && !expected) return undefined;
  assert.equal(process.platform, "linux");
  assert.ok(filename && expected && /^[a-f0-9]{64}$/u.test(expected));
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 128 * 1024);
  const bytes = await readFile(filename);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  const selected = inspectIsolatedNativeLinuxBinding(JSON.parse(bytes.toString("utf8")));
  assert.equal(path.posix.dirname(filename), selected.capture_root);
  return selected;
})();
const nativeAccount =
  process.env.PORTCOVE_NATIVE_ACCOUNT_BINDING || process.env.PORTCOVE_NATIVE_ACCOUNT_BINDING_SHA256
    ? DesktopNativeAccountSession.open(
        required(process.env.PORTCOVE_NATIVE_ACCOUNT_BINDING),
        required(process.env.PORTCOVE_NATIVE_ACCOUNT_BINDING_SHA256),
      )
    : undefined;
assert.ok(!(linuxBinding && nativeAccount), "Native host boundaries cannot be combined");
const accountDrivers =
  nativeAccount?.drivers() ??
  (linuxBinding
    ? {
        tauri_driver: required(linuxBinding.tools.driver).path,
        webview_driver: required(linuxBinding.tools.webkit_driver).path,
      }
    : undefined);
const cachedDrivers = accountDrivers
  ? { driver: accountDrivers.tauri_driver, nativeDriver: accountDrivers.webview_driver }
  : cachedDesktopDrivers();
if (cachedDrivers?.driver) values.driver ??= cachedDrivers.driver;
if (cachedDrivers?.nativeDriver) values["native-driver"] ??= cachedDrivers.nativeDriver;
for (const name of ["app", "output"] as const) {
  if (!values[name] || !path.isAbsolute(values[name]))
    throw new Error(`--${name} requires an absolute path`);
}
for (const name of ["driver", "native-driver"] as const) {
  if (!values[name] || !path.isAbsolute(values[name]))
    throw new Error(
      `--${name} requires an absolute path or a verified cached driver from ./scripts/bootstrap-quality-tools.ps1 -Desktop`,
    );
}
const application = required(values.app);
if (linuxBinding) assert.equal(application, linuxBinding.application.path);
const driverPath = required(values.driver);
const nativeDriverPath = required(values["native-driver"]);
const port = Number(values.port);
const restartCycles = Number(values["restart-cycles"]);
if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10)
  throw new Error("--restart-cycles must be 1..10");
const reloadCycles = Number(values["reload-cycles"]);
if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25)
  throw new Error("--reload-cycles must be 0..25");
const selection = resolveDesktopHarnessSelection(values);
// Admission stays with the existing native owners; planning never grants it.
bootstrapRecoverySelection(selection, process.platform);
librarySwitchRecoverySelection(selection, process.platform);
preferencesRecoverySelection(selection, process.platform);
const executionPlan = planDesktopExecution(selection, {
  prelaunchCustody: Boolean(process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST),
  retainedMetadata: Boolean(
    process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST &&
    object(JSON.parse(await readFile(process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST, "utf8")))
      .retained_metadata,
  ),
});
const {
  bootstrapRecoverySession,
  librarySwitchRecoverySession,
  preferencesRecoverySession,
  historySession,
  backupFocusSession,
  hostInterruptionSession,
  ordinaryCloseSession,
  minimizedPreparationSession,
  normalPackageSession,
  reviewedWorkflowSession,
  identityBoundSession: plannedIdentityBoundSession,
  cleanupName,
} = executionPlan.session;
const identityBoundSession = plannedIdentityBoundSession || Boolean(nativeAccount);
const interruptedPreparationSession =
  process.platform === "win32" &&
  selection.selected_scenarios.includes("native-interrupted-preparation-recovery");
const savedLibraryRecoverySession =
  bootstrapRecoverySession || librarySwitchRecoverySession || preferencesRecoverySession;
const hostPublicationSession = selection.selected_scenarios.includes(
  "native-host-publication-recovery",
);
if (selection.prerequisites.includes("owned-fixture") && !values["preparation-cli"])
  throw new Error("Selected fixture scenarios require the owned preparation CLI/tool inputs");
if (!Number.isInteger(port) || port < 1024 || port > 65533)
  throw new Error("--port must be 1024..65533");
if (executionPlan.fixtures.owned) {
  for (const name of ["preparation-cli", "preparation-tool"] as const) {
    if (!values[name] || !path.isAbsolute(values[name]))
      throw new Error(`--${name} requires an absolute path`);
  }
}
const revision = spawnCommand("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();
const output = path.resolve(required(values.output));
await mkdir(output); // Existing output is never reused, including after failed runs.
const runtimeRoot = nativeAccount
  ? nativeAccount.runtimeRoot(output)
  : (linuxBinding?.home ?? output);
if (nativeAccount) await mkdir(runtimeRoot); // A previous candidate's state is never reused.
const custody = process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST
  ? await readPrelaunchCustody(process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST, {
      root,
      revision,
      deadlineMs: desktopHarnessDeadlineMs(selection),
      plan: executionPlan,
      values: { ...values, app: application },
      selectedScenarios: selection.selected_scenarios,
    })
  : null;
const { inputs, runnerMetadata, metadataPhases } = await observeDesktopHarnessInputs({
  custody,
  capture: {
    root,
    values: { ...values, app: application },
    plan: executionPlan,
    output,
    revision,
  },
  runMetadata: values["run-metadata"],
});
let acceptancePreflight: Awaited<ReturnType<typeof writeAcceptancePreflight>> | undefined;
const packetFixtureIdentities: (FileIdentity & { role: string })[] = [];
type InstallFixture = Awaited<ReturnType<typeof createInstallFixture>>;
let installFixture:
  | (Omit<InstallFixture, "sourceJourney"> & {
      sourceJourney:
        | (NonNullable<InstallFixture["sourceJourney"]> & { root?: GameFileRoot })
        | null;
      nativeConnectionJourney?: boolean;
      hashResumeInitial?: GameFileScanSnapshot;
    })
  | undefined;
let externalFixture: Awaited<ReturnType<typeof createExternalRuntimeFixture>> | undefined;
let registeredSourceReuseFixture:
  | Awaited<ReturnType<typeof prepareRegisteredSourceReuseInputs>>
  | undefined;
let realRuntimeFixture: Awaited<ReturnType<typeof prepareRealRuntimeInputs>> | undefined;
let bootstrapRecoveryFixture:
  | Awaited<ReturnType<typeof prepareBootstrapRecoveryFixture>>
  | undefined;
let connectedLaunches = 0;
const library = path.join(runtimeRoot, "library");
const profile = path.join(runtimeRoot, "webview");
const checks: EvidenceCheck[] = [];
function recordChecks(...records: EvidenceCheck[]) {
  for (const record of records) recordDesktopCheck(checks, revision, record);
}
const setupChecks: EvidenceCheck[] = [];
const artifacts: string[] = [];
const scenarioOutcomes = new Map<string, EvidenceCheck["outcome"]>();
let driver:
  | ChildProcessByStdio<null, Readable, Readable>
  | LinuxLaunch["child"]
  | AccountDriverView
  | undefined;
let browser: WebDriver | LinuxInspectorProtocol | undefined;
let driverLog = "";
let startupAttempt = 0;
const linuxPackagedInspector =
  process.platform === "linux" &&
  selection.selected_scenarios.includes("native-linux-packaged-webview-boundary");
let historyInventory: Awaited<ReturnType<typeof captureHistoryDriver>> | undefined;
const linuxSelectedSession =
  process.platform === "linux" &&
  (Boolean(linuxBinding) ||
    selection.selected_scenarios.some(
      (name) =>
        [
          "native-selected-setup-completion",
          "native-saved-folder-selected-setup",
          "native-linux-packaged-webview-boundary",
          "native-linux-webview-origin-boundary",
          "native-linux-interrupted-preparation",
        ].includes(name) ||
        (name === "native-preparation-cancellation" && selection.selected_scenarios.length === 1),
    ));
const linuxPublication = new LinuxLaunchPublication<LinuxCleanup, LinuxLaunch, boolean>({
  output,
  artifacts,
  write: writeFile,
  beforeCommit: publishLinuxMediaEvidence,
  committed: () => {
    driver = undefined;
  },
  afterCommit: validateLinuxMediaEvidence,
});
let packageEvidence:
  | Awaited<ReturnType<typeof verifyNormalPackageEvidence>>
  | Awaited<ReturnType<typeof verifyLinuxPackageEvidence>>
  | undefined;
let originFixture: Awaited<ReturnType<typeof createOriginBoundaryFixture>> | undefined;
let externalBrowser: Awaited<ReturnType<typeof prepareLinuxExternalBrowser>> | undefined;
const applicationMediaEvidence = path.join(output, "linux-app-media-readiness.json");
if (selection.selected_scenarios.includes("native-linux-packaged-webview-boundary")) {
  assert.equal(process.platform, "linux");
  assert.deepEqual(selection.selected_scenarios, ["native-linux-packaged-webview-boundary"]);
  packageEvidence = await verifyLinuxPackageEvidence(
    required(values["package-evidence"]),
    revision,
    required(inputs[0]),
    root,
  );
  inputs.push(
    ...packageEvidence.identities,
    await fileIdentity(
      fileURLToPath(new URL("./desktop-main-webview-boundary.mts", import.meta.url)),
    ),
  );
  assert.ok(path.isAbsolute(process.env.PORTCOVE_QUALIFICATION_MEDIA_CONFIG ?? ""));
  inputs.push(await fileIdentity(required(process.env.PORTCOVE_QUALIFICATION_MEDIA_CONFIG)));
}
if (normalPackageSession) {
  assert.equal(process.platform, "win32");
  assert.deepEqual(selection.selected_scenarios, ["native-normal-package-webview-boundary"]);
  packageEvidence = await verifyNormalPackageEvidence(
    required(values["package-evidence"]),
    revision,
    required(inputs[0]),
    root,
  );
  inputs.push(
    ...packageEvidence.identities,
    await fileIdentity(
      fileURLToPath(new URL("./desktop-main-webview-boundary.mts", import.meta.url)),
    ),
  );
}
if (hostInterruptionSession) {
  assert.equal(process.platform, "win32");
  assert.deepEqual(selection.selected_scenarios, ["native-host-interrupted-preparation"]);
}
if (ordinaryCloseSession) {
  assert.equal(process.platform, "win32");
  assert.deepEqual(selection.selected_scenarios, ["native-closed-preparation-recovery"]);
}
if (minimizedPreparationSession) {
  assert.equal(process.platform, "win32");
  assert.deepEqual(selection.selected_scenarios, ["native-minimized-preparation-continuity"]);
}
if (backupFocusSession) {
  assert.equal(process.platform, "win32", "The exact backup-focus consent route requires Windows");
  assert.deepEqual(
    selection.selected_scenarios,
    ["native-backup-delete-focus"],
    "The bounded backup-focus qualification must run as one exact scenario",
  );
}
await reenterResourceCommand("browser", import.meta.url);
const ownedSession = new OwnedNativeSession();
const nativeLock = await acquireNativeSessionLock({
  workspace: root,
  profile: selection.profile,
  scenarios: selection.selected_scenarios,
});
const harnessStarted = custody ? new Date(custody.execution_started_at) : new Date();
const admission = executionAdmission(
  harnessStarted.toISOString(),
  desktopHarnessDeadlineMs(selection),
);
async function releaseNativeResources() {
  const closeFixtures = async () => {
    if (installFixture) await installFixture.close();
    if (originFixture) await originFixture.close();
  };
  if (process.platform !== "win32" || !identityBoundSession) {
    await closeFixtures();
    await nativeLock.release();
    return;
  }
  try {
    await ownedSession.releaseResources({
      closeFixtures,
      releaseLock: () => nativeLock.release(),
    });
  } catch (error) {
    await retainNativeCustody(error);
  }
}

async function retainNativeCustody(error: unknown): Promise<never> {
  process.exitCode = 1;
  const evidence = path.join(output, `${cleanupName}-unknown-custody.json`);
  return retainOwnedNativeCustody({
    publish: () =>
      writeFile(
        evidence,
        JSON.stringify(
          {
            error: errorMessage(error),
            driver: ownedSession.driver,
            inventory: ownedSession.inventory,
            cleanup: ownedSession.cleanup,
            retained_at: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      ),
    reportPublicationFailure: (publicationError) => {
      console.error(`Could not publish retained native custody: ${errorMessage(publicationError)}`);
    },
    reportRetained: () => {
      console.error(
        `Native custody remains unresolved; retained ${output}; runner and any unreleased reservations remain owned: ${errorMessage(error)}`,
      );
    },
    hold: async () => {
      // Keep the admitted runner alive even if evidence publication failed. No
      // PID-only fallback or owner-death reclamation is implied by this failure.
      setInterval(() => {}, 60_000);
      return new Promise<never>(() => {});
    },
  });
}

async function publishLinuxMediaEvidence(cleanup: LinuxCleanup, evidence: string) {
  let mediaWrapperFailure = false;
  if (linuxPackagedInspector) {
    const finalEvidence = `${applicationMediaEvidence}.final.json`;
    await writeFile(
      finalEvidence,
      JSON.stringify(
        {
          quiesced: cleanup.quiesced,
          namespace_join: evidence,
          limitation: "Namespace closure; no application or wrapper normal-exit inference",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    artifacts.push(finalEvidence);
    for (const suffix of ["", ".failure.json", ".exit.json"]) {
      const captured = await lstat(`${applicationMediaEvidence}${suffix}`).catch((error) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (captured) {
        assert.ok(captured.isFile() && !captured.isSymbolicLink());
        artifacts.push(`${applicationMediaEvidence}${suffix}`);
        if (suffix === ".failure.json") mediaWrapperFailure = true;
      }
    }
  }
  return mediaWrapperFailure;
}

async function validateLinuxMediaEvidence(
  cleanup: LinuxCleanup,
  mediaWrapperFailure: boolean | undefined,
) {
  if (linuxPackagedInspector) {
    const { assertMediaWrapperOutcome } = await import("../../../scripts/desktop-linux-media.mts");
    assertMediaWrapperOutcome(cleanup.events);
    assert.equal(
      mediaWrapperFailure,
      false,
      "Application media wrapper failed; preserve its failure receipt",
    );
    const exit = await readFile(`${applicationMediaEvidence}.exit.json`, "utf8").catch((error) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (exit) {
      const observed = object(JSON.parse(exit));
      assert.deepEqual(
        { code: observed.code, signal: observed.signal },
        { code: 0, signal: null },
        "Unexpected ordinary app exit before namespace cleanup",
      );
    }
  }
}

async function stopDriver() {
  if (linuxSelectedSession) {
    return linuxPublication.stop();
  }
  if (identityBoundSession) {
    stopBackupFocusDriver();
    return;
  }
  if (!driver?.pid || driver.exitCode !== null) return;
  if (historySession) {
    assert.ok(historyInventory, "History cleanup cannot signal without captured driver identity");
    if (!(await historyDriverStillOwned(historyInventory))) return;
  }
  if (process.platform === "win32") {
    spawnCommand("taskkill.exe", ["/PID", String(driver.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-driver.pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  }
}

function stopBackupFocusDriver() {
  if (ownedSession.cleanup || !driver?.pid) return;
  const snapshot = captureBackupFocusCleanup();
  const stopped =
    nativeAccount || driver.exitCode === null
      ? observeNativeSession("StopDriver", snapshot)
      : { method: "observed-child-exit" as const, exit_code: driver.exitCode };
  const exited = observeNativeSession("Wait", snapshot);
  ownedSession.cleanup = { stopped, exited, snapshot };
  driver = undefined;
}

let acquisitionLaunchProofCount = 0;
function acquisitionLaunchSessions(deadline: number) {
  const game = ownedSession.game;
  if (!game) return [];
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  let ids: string[];
  try {
    const rows = database
      .prepare("SELECT id FROM launch_sessions WHERE port_id = ? ORDER BY started_at, id LIMIT 17")
      .all(game.installation.port_id);
    assert.ok(rows.length <= 16, "Owned acquisition launch inventory exceeded its fixture bound");
    ids = rows.map((row) => {
      assert.equal(typeof row.id, "string");
      return String(row.id);
    });
  } finally {
    database.close();
  }
  const command = ownedFixtureCommand(
    { cli: required(values["preparation-cli"]), library, output },
    (file, args, options) => {
      const remaining = Math.floor(deadline - performance.now());
      assert.ok(remaining > 0, "Owned supervisor evidence exceeded the native capture budget");
      return spawnCommand(file, args, { ...options, timeout: remaining });
    },
  );
  const sessions = ids.map((id) => {
    const session = transportValue("launch_request", command(["launch", "show", id]));
    assert.ok(session, "Captured owned launch record disappeared");
    return session;
  });
  const receipt = path.join(
    output,
    `acquisition-launch-binding-${++acquisitionLaunchProofCount}.json`,
  );
  writeFileSync(
    receipt,
    JSON.stringify({ game, previous_games: ownedSession.games, sessions }, null, 2) + "\n",
    { flag: "wx" },
  );
  artifacts.push(receipt);
  return sessions;
}

function validateBackupFocusInventory(
  captured: NativeProcessSnapshot,
  requireQualified = false,
  deadline = performance.now() + 10_000,
) {
  ownedSession.validateQualificationInventory(captured, {
    requireQualified,
    savedLibraryRecoverySession,
    checks,
    application,
    nativeDriverPath,
    acquisitionJourney:
      executionPlan.fixtures.acquisitionJourney || executionPlan.fixtures.registeredSourceReuse,
    acquisitionLaunchSessions: () => acquisitionLaunchSessions(deadline),
  });
}

let cleanupCaptureSequence = 0;
function captureBackupFocusCleanup(evidenceName = cleanupName) {
  if (ownedSession.inventory) return ownedSession.inventory;
  assert.ok(
    ownedSession.driver && driver?.pid,
    "Missing initial owned driver identity; refuse unchecked cleanup",
  );
  const suffix =
    cleanupName === "presentation" ||
    cleanupName === "organization-restart" ||
    reviewedWorkflowSession ||
    interruptedPreparationSession
      ? `-${++cleanupCaptureSequence}-${driver.pid}`
      : hostInterruptionSession ||
          ordinaryCloseSession ||
          savedLibraryRecoverySession ||
          hostPublicationSession
        ? `-${driver.pid}`
        : "";
  const original = path.join(output, `${evidenceName}-final-processes${suffix}.json`);
  const captured = observeNativeSession("SnapshotDriverTree", original);
  artifacts.push(original);
  assert.deepEqual(
    captured.driver,
    ownedSession.driver,
    "Driver identity changed since owned launch",
  );
  try {
    validateBackupFocusInventory(captured);
  } catch (error) {
    recordChecks({
      scenario: "native-backup-process-inventory",
      outcome: "failed",
      message: errorMessage(error),
    });
    process.exitCode = 1;
  }
  // Preserve the original snapshot; the existing Wait helper iterates processes.
  // Include the captured driver root in a separate, explicitly derived inventory
  // so positive exit shares the same five-second bound for root and descendants.
  const checked = path.join(output, `${evidenceName}-exit-inventory${suffix}.json`);
  writeFileSync(
    checked,
    JSON.stringify(
      {
        ...captured,
        source_snapshot: path.basename(original),
        derivation: "include-captured-driver-root-in-positive-exit-inventory",
        processes: [captured.driver, ...captured.processes],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  artifacts.push(checked);
  ownedSession.inventory = checked;
  return checked;
}
async function verifySettingsRows() {
  const browser = driverBrowser();
  await selectSettingsCategory("game-files");
  const savedFolders = await browser.wait(
    until.elementLocated(
      By.xpath(
        '//*[@data-settings-group="game-files"]//*[normalize-space(.)="No folders saved yet."]',
      ),
    ),
    15_000,
  );
  assert.ok(
    await savedFolders.isDisplayed(),
    "saved game-file roots did not load from the native service",
  );
  assert.equal(
    await browser
      .findElement(
        By.xpath(
          '//*[@data-settings-group="game-files"]//button[normalize-space(.)="Scan saved folders"]',
        ),
      )
      .isEnabled(),
    false,
    "an empty saved-root registry must not start a scan",
  );
  await selectSettingsCategory("advanced");
  const bundleWarningVisible = await executeBrowserScript(browser, () => {
    const card = document.querySelector('[data-settings-group="advanced"] .diagnostics-card');
    const warning = [...(card?.querySelectorAll("p") ?? [])].find((element) =>
      element.textContent?.includes("paths, file names, and other metadata may remain"),
    );
    return Boolean(
      warning &&
      !warning.closest("details") &&
      warning.getBoundingClientRect().height > 0 &&
      getComputedStyle(warning).visibility === "visible",
    );
  });
  assert.ok(
    bundleWarningVisible,
    "support-bundle metadata warning must be visible before creation",
  );
  await browser
    .findElement(
      By.xpath(
        '//*[@data-settings-group="advanced"]//button[normalize-space(.)="Create support bundle"]',
      ),
    )
    .click();
  const savedBundle = await browser.wait(
    until.elementLocated(By.css('[data-settings-group="advanced"] .diagnostics-card code')),
    15_000,
  );
  assert.match(await savedBundle.getText(), /support|bundle/iu);
  const originalWindow = await browser.manage().window().getRect();
  let primaryFailure: unknown;
  let failed = false;
  try {
    for (const theme of ["dark", "light"]) {
      await selectSettingsTheme(theme);
      for (const size of [
        { width: 960, height: 640 },
        { width: 1280, height: 800 },
      ]) {
        await setVerifiedWindowSize(size, "Settings");
        for (const group of [
          "appearance",
          "library-storage",
          "game-files",
          "updates",
          "integrations",
          "controls",
          "advanced",
        ]) {
          await selectSettingsCategory(group);
          const rows = await executeBrowserScript(
            browser,
            (group) => {
              const rect = (element: Element) => {
                const bounds = element.getBoundingClientRect();
                return {
                  left: bounds.left,
                  top: bounds.top,
                  bottom: bounds.bottom,
                  width: bounds.width,
                  fits: element.scrollWidth <= element.clientWidth + 1,
                };
              };
              const groups = [group];
              return {
                viewportWidth: window.innerWidth,
                groups: Object.fromEntries(
                  groups.map((group) => {
                    const content = document.querySelector(
                      `[data-settings-group="${group}"] .settings-section-content`,
                    );
                    if (!(content instanceof HTMLElement)) throw new Error(`Missing ${group}`);
                    const children = [...content.children];
                    if (!children.every((child) => child.classList.contains("settings-row")))
                      throw new Error(`${group} contains an unmigrated Settings card`);
                    return [group, { content: rect(content), rows: children.map(rect) }];
                  }),
                ),
                bundlePathFits:
                  group !== "advanced" ||
                  (() => {
                    const path = document.querySelector(
                      '[data-settings-group="advanced"] .diagnostics-card code',
                    );
                    if (!(path instanceof HTMLElement))
                      throw new Error("Saved bundle path is missing");
                    return path.scrollWidth <= path.clientWidth + 1;
                  })(),
                recommendationFits:
                  group !== "updates" ||
                  (() => {
                    const label = document.querySelector(
                      '[aria-label="Application update mode"] button small',
                    );
                    const button = label?.closest("button");
                    if (!(label instanceof HTMLElement) || !(button instanceof HTMLElement))
                      throw new Error("Recommended update-mode label is missing");
                    return (
                      label.getBoundingClientRect().bottom <=
                      button.getBoundingClientRect().bottom - 2
                    );
                  })(),
              };
            },
            group,
          );
          assertSettingsRowGeometry(rows, size);
          const section = await browser.findElement(By.css(`[data-settings-group="${group}"]`));
          await executeBrowserScript(
            browser,
            (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
            section,
          );
          await captureScenarioScreenshot(
            `settings-${group}-${theme}-${size.width}x${size.height}`,
          );
          if (group === "advanced" && size.width === 960) {
            await executeBrowserScript(browser, () =>
              document
                .querySelector('[data-settings-group="advanced"] .diagnostics-card code')
                ?.scrollIntoView({ block: "center", inline: "nearest" }),
            );
            await captureScenarioScreenshot(`settings-bundle-path-${theme}-960x640`);
          }
        }
      }
    }
  } catch (error) {
    failed = true;
    primaryFailure = error;
    await captureScenarioScreenshot("settings-rows-primary-failure");
  }
  try {
    await browser.manage().window().setRect(originalWindow);
    await selectSettingsCategory("appearance");
    await clickVisible(
      browser,
      await browser.findElement(
        By.xpath(
          '//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="Follow system"]',
        ),
      ),
    );
  } catch (restoreError) {
    if (failed)
      throw new Error(
        `Settings row verification failed: ${errorMessage(primaryFailure)}; restoring appearance failed: ${errorMessage(restoreError)}`,
        { cause: new AggregateError([primaryFailure, restoreError]) },
      );
    throw restoreError;
  }
  if (failed) throw primaryFailure;
}

interface SettingsRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
  fits: boolean;
}
interface SettingsRows {
  viewportWidth: number;
  groups: Record<string, { content: SettingsRect; rows: SettingsRect[] }>;
  bundlePathFits: boolean;
  recommendationFits: boolean;
}
function assertSettingsRowGeometry(rows: SettingsRows, size: { width: number; height: number }) {
  const expectedRows: Record<string, number> = {
    appearance: 3,
    "library-storage": 3,
    "game-files": 3,
    updates: 2,
    integrations: 2,
    controls: 2,
    advanced: 3,
  };
  for (const [name, group] of Object.entries(rows.groups)) {
    assert.equal(group.rows.length, expectedRows[name], `${name} row count changed`);
    for (const [index, row] of group.rows.entries()) {
      assert.ok(
        Math.abs(row.width - group.content.width) < 3,
        `${name} row ${index} is not full width`,
      );
      assert.ok(Math.abs(row.left - group.content.left) < 3, `${name} row ${index} is misaligned`);
      assert.ok(row.fits, `${name} row ${index} overflows horizontally`);
      if (index > 0)
        assert.ok(required(group.rows[index - 1]).bottom <= row.top, `${name} rows overlap`);
    }
    assert.ok(group.content.fits, `${name} content overflows horizontally`);
  }
  assert.ok(rows.viewportWidth <= size.width);
  assert.equal(rows.bundlePathFits, true, "saved bundle path is clipped");
  assert.equal(rows.recommendationFits, true, "recommended update mode label is clipped");
}

async function verifyLongTitleCatalogDetail(theme: string) {
  const browser = driverBrowser();
  await selectCatalogPort(browser, "cvlod-recomp");
  await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 15_000);
  await browser.wait(
    () =>
      executeBrowserScript(browser, () => {
        const hero = document.querySelector<HTMLElement>(".game-hero-detail");
        const image = hero?.querySelector(".game-hero-image");
        return Boolean(
          (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) ||
          (hero?.dataset.heroIdentity === "text" &&
            !hero.querySelector('[data-loading="true"]') &&
            hero.querySelector("#port-detail-title")?.textContent?.trim()),
        );
      }),
    15_000,
    "Long-title cover image or fallback did not settle before visual capture",
  );
  for (const size of [
    { width: 960, height: 640 },
    { width: 1280, height: 800 },
  ]) {
    await setVerifiedWindowSize(size, "Long-title");
    const layout = await executeBrowserScript(browser, () => {
      const title = document.querySelector("#port-detail-title");
      const action = document.querySelector(
        '.detail-header-actions button[data-variant="primary"]',
      );
      if (!(title instanceof HTMLElement) || !(action instanceof HTMLElement))
        throw new Error("Long-title detail title or primary action is missing");
      const bounds = action.getBoundingClientRect();
      const main = document.querySelector("main");
      return {
        title: title.textContent?.trim(),
        project: title.parentElement?.querySelector("h1 + p")?.textContent?.trim(),
        titleClientWidth: title.clientWidth,
        titleScrollWidth: title.scrollWidth,
        titleClientHeight: title.clientHeight,
        titleScrollHeight: title.scrollHeight,
        // Chromium can count font ink just outside a fractional line box
        // as scroll height even when the full heading is visible.
        titleFits:
          title.scrollWidth <= title.clientWidth + 1 &&
          title.scrollHeight <= Math.ceil(title.getBoundingClientRect().height) + 2,
        titleHeight: title.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
        action: {
          label: action.textContent?.trim(),
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        horizontalOverflow: Boolean(main && main.scrollWidth > main.clientWidth + 1),
      };
    });
    await captureScenarioScreenshot(`game-details-long-title-${theme}-${size.width}`, true);
    assert.equal(layout.title, "Castlevania: Legacy of Darkness");
    assert.equal(layout.project, "Castlevania: Legacy of Darkness Recompiled");
    assert.equal(layout.titleFits, true, JSON.stringify(layout));
    assert.equal(layout.action.label, "Set up");
    assert.equal(layout.horizontalOverflow, false);
    assert.ok(
      layout.action.top >= 0 &&
        layout.action.bottom <= layout.viewport.height &&
        layout.action.left >= 0 &&
        layout.action.right <= layout.viewport.width,
      `Long-title primary action must remain visible: ${JSON.stringify(layout)}`,
    );
  }
  await browser.findElement(By.css(".detail-back")).click();
  await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
  await browser.manage().window().setRect({ width: 960, height: 640 });
}

async function refreshSettings(category?: string) {
  const browser = driverBrowser();
  const previousDocument = await browser.findElement(By.css("html"));
  await browser.navigate().refresh();
  // WebView's refresh command can return while the previous renderer is still visible.
  // Select the category only after the new document and workspace have settled.
  await browser.wait(until.stalenessOf(previousDocument), 15_000);
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  await browser.wait(
    () => executeBrowserScript(browser, () => document.querySelector(".loading-state") === null),
    15_000,
  );
  await selectPrimaryNavigation(browser, "Settings");
  if (category) await selectSettingsCategory(category);
}

async function selectSettingsCategory(id: string) {
  const browser = driverBrowser();
  await selectPrimaryNavigation(browser, "Settings");
  const category = By.css(
    `nav[aria-label="Settings categories"] button[aria-controls="settings-${id}"]`,
  );
  await browser.wait(until.elementLocated(category), 15_000);
  await clickVisible(browser, await browser.findElement(category));
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (categoryId) => document.activeElement?.id === `settings-${categoryId}-heading`,
        id,
      ),
    5_000,
    `Settings ${id} heading did not receive focus`,
  );
}

// Includes owned native artwork picker/restart coverage in addition to lifecycle reviews.
const harnessDeadlineMs = desktopHarnessDeadlineMs(selection);
const deadline = setTimeout(
  () => {
    recordChecks({
      scenario: "native-harness-deadline",
      outcome: "failed",
      message: `Native harness exceeded its ${harnessDeadlineMs}ms allowance; stopping the owned driver.`,
    });
    process.exitCode = 1;
    void (async () => {
      try {
        await stopDriver();
      } catch (error) {
        recordChecks({
          scenario: "native-backup-watchdog-cleanup",
          outcome: "failed",
          message: errorMessage(error),
        });
        process.exitCode = 1;
      }
    })();
  },
  custody
    ? Math.max(0, harnessDeadlineMs - (Date.now() - harnessStarted.getTime()))
    : harnessDeadlineMs,
);
deadline.unref();

async function requireUnusedPort(number: number) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: number, host: "127.0.0.1", exclusive: true }, resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function invoke(
  command: "get_bootstrap_status",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["desktop_bootstrap_status"]>>;
function invoke(
  command: "get_catalog",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["catalog"]>>;
function invoke(
  command: "get_locale_preference",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["desktop_locale_preference"]>>;
function invoke(
  command: "get_activities",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["activity"]>>;
function invoke(
  command: "create_support_bundle",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["desktop_support_bundle_export"]>>;
function invoke(
  command: "get_application_update_preferences",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["desktop_application_update_preferences"]>>;
function invoke(
  command: "get_application_update_status",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["desktop_application_update_status"]>>;
function invoke(
  command: "get_statuses",
  args?: object | null,
): Promise<IpcReply<TransportOutputs["status"][]>>;
function invoke(
  command: "get_default_library_root",
  args?: object | null,
): Promise<IpcReply<string>>;
function invoke(command: string, args?: object | null): Promise<IpcReply<unknown>>;
async function invoke(command: string, args: object | null = {}): Promise<IpcReply<unknown>> {
  const observer: MainBoundaryBrowser = required(browser);
  const serialized = await observer.executeAsyncScript(
    (name, input, done) => {
      const native = (
        window as Window & {
          __TAURI_INTERNALS__?: { invoke(name: string, input: object | null): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      if (!native) throw new Error("Native IPC bridge is missing");
      void native.invoke(name, input).then(
        (value) => done(JSON.stringify({ ok: true, value })),
        (error: unknown) => done(JSON.stringify({ ok: false, error })),
      );
    },
    command,
    args,
  );
  const parsed: unknown = JSON.parse(text(serialized));
  const reply = object(parsed);
  assert.ok(typeof reply.ok === "boolean", "Native IPC envelope outcome required");
  if (!reply.ok) return { ...reply, ok: false, error: reply.error };
  switch (command) {
    case "get_bootstrap_status":
      return { ...reply, ok: true, value: transportValue("desktop_bootstrap_status", reply.value) };
    case "get_catalog":
      return { ...reply, ok: true, value: transportValue("catalog", reply.value) };
    case "get_locale_preference":
      return {
        ...reply,
        ok: true,
        value: transportValue("desktop_locale_preference", reply.value),
      };
    case "get_activities":
      return { ...reply, ok: true, value: transportValue("activity", reply.value) };
    case "create_support_bundle":
      return {
        ...reply,
        ok: true,
        value: transportValue("desktop_support_bundle_export", reply.value),
      };
    case "get_application_update_preferences":
      return {
        ...reply,
        ok: true,
        value: transportValue("desktop_application_update_preferences", reply.value),
      };
    case "get_application_update_status":
      return {
        ...reply,
        ok: true,
        value: transportValue("desktop_application_update_status", reply.value),
      };
    case "get_statuses":
      return { ...reply, ok: true, value: transportValues("status", reply.value) };
    case "get_default_library_root":
      return { ...reply, ok: true, value: text(reply.value) };
    default:
      return { ...reply, ok: true, value: reply.value };
  }
}

function scenarioTarget(name: string): ScenarioTarget | null {
  if (selection.selected_scenarios.includes(name)) return { records: checks, setup: false };
  if (selection.setup_scenarios.includes(name)) return { records: setupChecks, setup: true };
  return null;
}

function failedScenarioDependency(name: string) {
  const dependencies = desktopScenarioById.get(name)?.dependencies ?? [];
  return dependencies.find((dependency) => scenarioOutcomes.get(dependency) !== "passed");
}

function recordScenario(
  target: ScenarioTarget,
  name: string,
  outcome: EvidenceCheck["outcome"],
  details: Pick<EvidenceCheck, "message" | "reason" | "duration_ms" | "duration_scope"> = {},
) {
  recordDesktopCheck(target.records, revision, { scenario: name, outcome, ...details });
  scenarioOutcomes.set(name, outcome);
}

async function captureScenarioDiagnostics(name: string, setup: boolean) {
  if (!browser) return;
  const report = path.join(output, `${setup ? "setup-" : ""}${name}-diagnostics.json`);
  try {
    const observer: MainBoundaryBrowser = browser;
    const details = await observer.executeScript(() =>
      Array.from(document.querySelectorAll(".error-banner, .bootstrap-error")).map(
        (element) => element.textContent,
      ),
    );
    await writeFile(report, JSON.stringify(details, null, 2), { flag: "wx" });
    artifacts.push(report);
  } catch {
    /* Preserve the original failure if its window is unavailable. */
  }
}

async function captureScenarioScreenshot(name: string, required = false) {
  if (!browser) {
    if (required) throw new Error(`Required screenshot ${name} has no browser session`);
    return;
  }
  const screenshot = path.join(output, `${name}.png`);
  try {
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  } catch (error) {
    if (required)
      throw new Error(`Required screenshot ${name} could not be captured`, { cause: error });
    /* The failed scenario remains recorded even if its window disappeared. */
  }
}

async function captureKeyboardTarget(
  name: string,
  element: WebElement,
  scenarioId = "keyboard-layout",
) {
  return captureNativeKeyboardTarget(
    { browser: driverBrowser(), output, artifacts },
    name,
    element,
    scenarioId,
  );
}

async function selectSettingsTheme(theme: string) {
  const browser = driverBrowser();
  await selectSettingsCategory("appearance");
  await clickVisible(
    browser,
    await browser.findElement(
      By.xpath(
        `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
      ),
    ),
  );
  await browser.wait(
    async () =>
      (await executeBrowserScript(browser, () => document.documentElement.dataset.theme)) === theme,
    5_000,
  );
}

async function setVerifiedWindowSize(size: { width: number; height: number }, context: string) {
  const browser = driverBrowser();
  await browser.manage().window().setRect(size);
  const actual = await browser.manage().window().getRect();
  assert.deepEqual(
    { width: actual.width, height: actual.height },
    size,
    `${context} window was clamped: ${JSON.stringify(actual)}`,
  );
}

async function captureApplicationUpdateSettingsComparison() {
  const browser = driverBrowser();
  const originalWindow = await browser.manage().window().getRect();
  try {
    for (const theme of ["dark", "light"]) {
      await selectSettingsTheme(theme);
      await selectSettingsCategory("updates");
      for (const size of [
        { width: 960, height: 640 },
        { width: 1280, height: 800 },
      ]) {
        await setVerifiedWindowSize(size, "Application update settings");
        const geometry = await executeBrowserScript(browser, () => {
          const card = document.querySelector(".application-update-settings");
          if (!(card instanceof HTMLElement)) return null;
          card.scrollIntoView({ block: "start", inline: "nearest" });
          const versionBadge = card.querySelector(".application-update-heading > p");
          const secondaryColorProbe = document.createElement("span");
          secondaryColorProbe.style.color = "var(--color-text-secondary)";
          card.append(secondaryColorProbe);
          const badgeColorMatchesSecondary =
            versionBadge instanceof HTMLElement &&
            getComputedStyle(versionBadge).color === getComputedStyle(secondaryColorProbe).color;
          secondaryColorProbe.remove();
          return {
            display: getComputedStyle(card).display,
            badgeColorMatchesSecondary,
            documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            cardOverflow: card.scrollWidth > card.clientWidth + 1,
          };
        });
        assert.deepEqual(geometry, {
          display: "grid",
          badgeColorMatchesSecondary: true,
          documentOverflow: false,
          cardOverflow: false,
        });
        await captureScenarioScreenshot(`application-update-settings-${theme}-${size.width}`, true);
      }
    }
  } finally {
    await browser.manage().window().setRect(originalWindow);
  }
}

async function captureOutputDestinationReview(name: string) {
  const browser = driverBrowser();
  const outputControl = await browser.wait(
    until.elementLocated(By.css(".output-location-control")),
    15_000,
  );
  await browser.wait(
    async () =>
      (await outputControl.findElements(By.css('[aria-label="Current output destination"] dl')))
        .length === 1,
    15_000,
  );
  const outputLayout = await executeBrowserScript(browser, () => {
    const control = document.querySelector(".output-location-control");
    const current = control?.querySelector('[aria-label="Current output destination"]');
    if (!(control instanceof HTMLElement) || !(current instanceof HTMLElement)) return null;
    const facts = current.querySelector("dl");
    const factValue = facts?.querySelector("dd");
    if (!(facts instanceof HTMLElement) || !(factValue instanceof HTMLElement)) return null;
    control.scrollIntoView({ block: "start", inline: "nearest" });
    return {
      controlDisplay: getComputedStyle(control).display,
      currentDisplay: getComputedStyle(current).display,
      factsTopMargin: getComputedStyle(facts).marginTop,
      factValueLeftMargin: getComputedStyle(factValue).marginLeft,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      controlOverflow: control.scrollWidth > control.clientWidth + 1,
    };
  });
  assert.deepEqual(outputLayout, {
    controlDisplay: "grid",
    currentDisplay: "grid",
    factsTopMargin: "0px",
    factValueLeftMargin: "0px",
    horizontalOverflow: false,
    controlOverflow: false,
  });
  await captureScenarioScreenshot(`${name}-current-output-destination`, true);
  const reviewOutput = await outputControl.findElement(
    By.xpath('.//button[normalize-space(.)="Review future folder"]'),
  );
  await reviewOutput.click();
  const outputReview = await browser.wait(
    until.elementLocated(By.css('[aria-label="Output destination review"]')),
    15_000,
  );
  assert.equal(
    await executeBrowserScript(
      browser,
      (review) => {
        const facts = review.querySelector("dl");
        const value = facts?.querySelector("dd");
        return (
          getComputedStyle(review).display === "grid" &&
          review.scrollWidth <= review.clientWidth + 1 &&
          facts instanceof HTMLElement &&
          value instanceof HTMLElement &&
          getComputedStyle(facts).marginTop === "0px" &&
          getComputedStyle(value).marginLeft === "0px"
        );
      },
      outputReview,
    ),
    true,
  );
  await captureScenarioScreenshot(`${name}-output-destination-review`, true);
  await browser.findElement(By.xpath('//button[normalize-space(.)="Cancel review"]')).click();
  await browser.wait(
    async () =>
      (await executeBrowserScript(browser, () => document.activeElement?.textContent?.trim())) ===
      "Review future folder",
    5_000,
  );
}

async function scenario(name: string, action: () => unknown) {
  const target = scenarioTarget(name);
  if (!target) return;
  const failedDependency = failedScenarioDependency(name);
  if (failedDependency) {
    recordScenario(target, name, "not-run", {
      reason: `Prerequisite ${failedDependency} did not pass`,
      duration_ms: null,
      duration_scope: "scenario-action",
    });
    return;
  }
  let failed = false;
  await observeDesktopScenario(action, {
    record: ({ outcome, ...details }) => {
      failed = outcome === "failed";
      recordScenario(target, name, outcome, { ...details, duration_scope: "scenario-action" });
      if (outcome === "failed") process.exitCode = 1;
    },
    diagnostics: () => captureScenarioDiagnostics(name, target.setup),
    screenshot: async () => {
      if (!target.setup || failed)
        await captureScenarioScreenshot(
          failed ? `${target.setup ? "setup-" : ""}${name}-scenario-failure` : name,
          failed,
        );
    },
  });
}

async function connectObservedDriver() {
  await admission.verify(custody?.inputs ?? []);
  if (linuxPackagedInspector) {
    const evidence = path.join(output, "linux-webkit-inspector.json");
    artifacts.push(evidence);
    const { awaitApplicationMediaReadiness, verifyConnectedApplicationMedia } =
      await import("../../../scripts/desktop-linux-media.mts");
    const launch = required(linuxPublication.launch);
    let readiness: unknown;
    const inspector = await connectLinuxInspector({
      port,
      launch,
      app: application,
      expectedSha256: required(inputs[0]).sha256,
      evidence,
      beforeConnect: async (deadline) => {
        readiness = await awaitApplicationMediaReadiness(
          applicationMediaEvidence,
          launch,
          deadline,
        );
      },
    });
    await verifyConnectedApplicationMedia({
      inspector,
      retain: (connected) => {
        browser = connected;
      },
      inputs,
      admission,
      readiness,
    });
    return;
  }
  const finishObservation =
    process.platform === "win32"
      ? await observeStartup({
          driver: required(driver),
          driverPath: driverPath,
          profile,
          output,
          attempt: startupAttempt++,
        })
      : null;
  try {
    admission.assertReady();
    const builder = new Builder()
      .disableEnvironmentOverrides()
      .usingServer(`http://127.0.0.1:${port}`)
      .withCapabilities({
        browserName: process.platform === "win32" ? "webview2" : "wry",
        "tauri:options": {
          application: application,
          ...(process.platform === "win32" ? { webviewOptions: { userDataFolder: profile } } : {}),
        },
      });
    if (linuxPublication.launch && "privateAgent" in linuxPublication.launch)
      builder.usingHttpAgent(linuxPublication.launch.privateAgent);
    browser = await builder.build();
  } finally {
    if (finishObservation) {
      const observation = await finishObservation();
      artifacts.push(...observation.artifacts);
      recordDesktopCheck(setupChecks, revision, {
        scenario: "session-startup-observation",
        outcome: observation.successful ? "passed" : "failed",
      });
      if (!observation.successful) process.exitCode = 1;
    }
  }
}

async function connect() {
  await connectObservedDriver();
  if (linuxPackagedInspector) {
    const browser = requiredInspector();
    await browser.wait(
      () =>
        browser.executeScript(
          () =>
            document.querySelector('nav[aria-label="Primary navigation"]') !== null &&
            document.querySelector(".loading-state") === null,
        ),
      30_000,
    );
    connectedLaunches++;
    return;
  }
  const browser = driverBrowser();
  await browser.manage().setTimeouts({ script: 15_000 });
  const initialRecovery =
    (bootstrapRecoverySession || preferencesRecoverySession) && connectedLaunches === 0;
  const readyRoot = initialRecovery
    ? ".bootstrap-error"
    : selection.prerequisites.includes("design-compatibility-fixture")
      ? ".design-compatibility-fixture"
      : 'nav[aria-label="Primary navigation"]';
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (selector) => document.querySelector(selector) !== null,
        readyRoot,
      ),
    30_000,
  );
  await browser.wait(
    () => executeBrowserScript(browser, () => document.querySelector(".loading-state") === null),
    30_000,
  );
  if (executionPlan.fixtures.acquisitionJourney || executionPlan.fixtures.registeredSourceReuse) {
    const snapshot = path.join(
      output,
      `acquisition-connected-${connectedLaunches + 1}-processes.json`,
    );
    const captured = observeNativeSession("Snapshot", snapshot);
    artifacts.push(snapshot);
    ownedSession.bindApplication(captured, application);
  }
  connectedLaunches++;
}

async function requestApplicationShutdown(snapshot: string) {
  await required(browser).quit();
  browser = undefined;
  const driverStop =
    process.platform === "win32" ? observeNativeSession("StopDriver", snapshot) : undefined;
  driver = undefined;
  return driverStop;
}

async function restartApplication(
  name: string,
  prepareWhileStopped?: () => Promise<void>,
  childEnvironment: NodeJS.ProcessEnv = {},
) {
  const selectedSetupRestart = name === "selected-setup-inputs";
  if (linuxSelectedSession) {
    assert.equal(name, "selected-setup-inputs");
    assert.equal(prepareWhileStopped, undefined, "Selected restart cannot rewrite fixture state");
    await required(browser).quit();
    browser = undefined;
    await stopDriver();
    assert.equal(required(linuxPublication.cleanup).quiesced, true);
    const evidence = path.join(output, `${name}-restart.json`);
    await writeFile(evidence, JSON.stringify(linuxPublication.cleanup, null, 2) + "\n", {
      flag: "wx",
    });
    artifacts.push(evidence);
    await startDriver(childEnvironment);
    await connect();
    return driverBrowser();
  }
  if (process.platform === "linux" && historySession) {
    const captured = await captureHistorySession(
      required(required(driver).pid),
      driverPath,
      application,
    );
    assert.equal(captured.driver.start_ticks, required(historyInventory).driver.start_ticks);
    const identities = new Map(
      [...required(historyInventory).processes, ...captured.processes].map((entry) => [
        `${entry.pid}:${entry.start_ticks}`,
        entry,
      ]),
    );
    historyInventory = { ...captured, processes: [...identities.values()] };
    await required(browser).quit();
    browser = undefined;
    await stopDriver();
    const cleanup = await waitHistorySessionExit(historyInventory);
    driver = undefined;
    const evidence = path.join(output, `${name}-restart.json`);
    await writeFile(evidence, JSON.stringify(cleanup, null, 2) + "\n", { flag: "wx" });
    artifacts.push(evidence);
    if (prepareWhileStopped) await prepareWhileStopped();
    await startDriver(childEnvironment);
    await connect();
    return driverBrowser();
  }
  const acquisitionRestart = Boolean(executionPlan.fixtures.acquisitionJourney);
  if (
    savedLibraryRecoverySession ||
    selectedSetupRestart ||
    hostPublicationSession ||
    acquisitionRestart ||
    (process.platform === "win32" && identityBoundSession)
  ) {
    if (
      !preferencesRecoverySession &&
      !hostPublicationSession &&
      !acquisitionRestart &&
      !(
        reviewedWorkflowSession &&
        selection.selected_scenarios.includes("native-staged-update-composition") &&
        name === "native-staged-update-composition"
      ) &&
      !(
        interruptedPreparationSession &&
        (name === "interrupted-preparation-fixture" || name === "journal-only-preparation-recovery")
      )
    )
      assert.equal(
        prepareWhileStopped,
        undefined,
        "Identity-bound restart cannot rewrite fixture state",
      );
    return await ownedSession.restart({
      capture: async () => {
        const inventory = captureBackupFocusCleanup(
          selectedSetupRestart ||
            acquisitionRestart ||
            interruptedPreparationSession ||
            reviewedWorkflowSession
            ? name
            : cleanupName,
        );
        validateBackupFocusInventory(
          readNativeProcessSnapshot(JSON.parse(await readFile(inventory, "utf8"))),
          selectedSetupRestart || acquisitionRestart,
        );
      },
      close: async () => {
        await required(browser).quit();
        browser = undefined;
      },
      stop: stopBackupFocusDriver,
      publish: async (cleanup) => {
        const restartEvidence = path.join(output, `${name}-restart.json`);
        await writeFile(restartEvidence, `${JSON.stringify(cleanup, null, 2)}\n`, { flag: "wx" });
        artifacts.push(restartEvidence);
      },
      prepare: prepareWhileStopped,
      start: () => startDriver(childEnvironment),
      connect,
      browser: driverBrowser,
    });
  }
  const snapshot = path.join(output, `${name}-processes.json`);
  const restartEvidence = path.join(output, `${name}-restart.json`);
  const observation: RestartObservation = {
    started_at: new Date().toISOString(),
    shutdown_request: "identity-bound-isolated-driver-tree-termination",
  };
  if (process.platform === "win32") {
    observation.snapshot = observeNativeSession("Snapshot", snapshot);
    artifacts.push(snapshot);
  }
  observation.driver_stop = await requestApplicationShutdown(snapshot);
  observation.session_delete_completed_at = new Date().toISOString();
  if (process.platform === "win32") {
    observation.shutdown = observeNativeSession("Wait", snapshot);
  }
  if (prepareWhileStopped) {
    await prepareWhileStopped();
    observation.fixture_prepared_while_stopped = true;
  }
  await startDriver(childEnvironment);
  await connect();
  observation.reconnected_at = new Date().toISOString();
  await writeFile(restartEvidence, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx" });
  artifacts.push(restartEvidence);
  return driverBrowser();
}

// Interrupt only this harness's positively identified tree, without first
// deleting its WebDriver session or requesting graceful application shutdown.
function captureLivePreparation(preparationExecutable: string) {
  assert.ok(minimizedPreparationSession && ownedSession.driver && driver?.pid);
  const snapshot = path.join(output, "minimized-preparation-live-processes.json");
  const captured = observeNativeSession("Snapshot", snapshot);
  assert.deepEqual(captured.driver, ownedSession.driver);
  for (const expected of [application, preparationExecutable]) {
    assert.equal(
      captured.processes.filter(
        (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(expected).toLowerCase(),
      ).length,
      1,
      "Capture one exact live owned executable",
    );
  }
  artifacts.push(snapshot);
  // Preserve final cleanup's independent current inventory; the worker may
  // legitimately exit after this immutable live checkpoint.
  return { snapshot, ...captured };
}

async function interruptCheckpointHost(
  name: string,
  assertHeld: (application: CapturedNativeProcess) => Promise<void>,
  afterStopped: () => Promise<void>,
  bootstrapRecovery: boolean,
  restartLibrary?: string,
) {
  assert.ok(hostPublicationSession && process.platform === "win32");
  const report: Record<string, unknown> = {
    name,
    shutdown_request: "forced-owned-application-only-without-session-delete-or-graceful-handler",
    started_at: new Date().toISOString(),
  };
  try {
    const inventory = captureBackupFocusCleanup();
    const captured = readNativeProcessSnapshot(JSON.parse(await readFile(inventory, "utf8")));
    validateBackupFocusInventory(captured, true);
    const matches = (file: string) =>
      captured.processes.filter(
        (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(file).toLowerCase(),
      );
    const apps = matches(application);
    const parents = matches(nativeDriverPath);
    assert.equal(apps.length, 1);
    assert.equal(parents.length, 1);
    const app = required(apps[0]);
    const parent = required(parents[0]);
    const appInventory = path.join(output, `${name}-direct-application.json`);
    const snapshot = observeNativeSession("SnapshotApplication", appInventory, {
      applicationPid: app.pid,
      parentPid: parent.pid,
      sha256: (await fileIdentity(application)).sha256,
    });
    artifacts.push(appInventory);
    assert.deepEqual(snapshot.driver, app);
    report.live_application = snapshot;
    await assertHeld(app);
    report.application_stop = observeNativeSession("StopApplication", appInventory);
    report.application_exit = observeNativeSession("Wait", appInventory);
    // Only after the independently observed app exit may the driver be ended.
    // Never delete its WebDriver session as a substitute for forced host loss.
    browser = undefined;
    stopBackupFocusDriver();
    report.remaining_driver_cleanup = ownedSession.requireQuiescence();
    driver = undefined;
    await afterStopped();
    report.fixture_disarmed_after_quiescence = true;
    if (restartLibrary !== undefined) {
      assert.equal(
        path.resolve(restartLibrary),
        path.resolve(output, "published-import-destination"),
      );
      const directory = await lstat(restartLibrary);
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
      publicationRestartRoot = restartLibrary;
      report.restart_library_root = restartLibrary;
    }
    await startDriver();
    await connectObservedDriver();
    const current = driverBrowser();
    await current.manage().setTimeouts({ script: 15_000 });
    await current.wait(
      until.elementLocated(
        By.css(bootstrapRecovery ? ".bootstrap-error" : 'nav[aria-label="Primary navigation"]'),
      ),
      30_000,
    );
    connectedLaunches++;
    report.reconnected_at = new Date().toISOString();
    return current;
  } catch (error) {
    report.failure = errorMessage(error);
    throw error;
  } finally {
    const file = path.join(output, `${name}-forced-host-loss.json`);
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    artifacts.push(file);
  }
}

async function interruptApplication(
  name: string,
  preparationExecutable: string,
  assertStillPreparing: () => Promise<void>,
) {
  assert.equal(process.platform, "win32", "Live host interruption is Windows qualification");
  const inventory = captureBackupFocusCleanup();
  const captured = readNativeProcessSnapshot(JSON.parse(await readFile(inventory, "utf8")));
  const matches = (expected: string) =>
    captured.processes.filter(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(expected).toLowerCase(),
    );
  assert.equal(matches(application).length, 1, "Capture the live owned application");
  assert.equal(matches(preparationExecutable).length, 1, "Capture the live preparation child");
  await assertStillPreparing();
  const startedAt = new Date().toISOString();
  stopBackupFocusDriver();
  const cleanup = ownedSession.requireQuiescence();
  const observation: RestartObservation = {
    started_at: startedAt,
    shutdown_request: "forced-owned-tree-termination-without-session-delete",
    driver_stop: cleanup.stopped,
    shutdown: cleanup.exited,
  };
  // The killed session cannot be reused. Recovery runs in a new native host;
  // no durable-state fixture or quiescence flag is written by the harness.
  browser = undefined;
  driver = undefined;
  await startDriver();
  await connect();

  observation.reconnected_at = new Date().toISOString();
  const evidence = path.join(output, `${name}-restart.json`);
  await writeFile(evidence, JSON.stringify(observation, null, 2), { flag: "wx" });
  artifacts.push(evidence);
  return driverBrowser();
}

async function interruptLinuxPreparation(
  name: string,
  preparationExecutable: string,
  assertStillPreparing: () => Promise<void>,
) {
  assert.equal(process.platform, "linux");
  assert.ok(linuxSelectedSession);
  return linuxPublication.interruptPreparation({
    name,
    preparationExecutable,
    library,
    selectedScenarios: selection.selected_scenarios,
    assertStillPreparing,
    invalidateBrowser: () => {
      browser = undefined;
    },
    start: () => startDriver(),
    connect,
    browser: driverBrowser,
  });
}

async function closeApplication(
  name: string,
  preparationExecutable: string,
  assertStillPreparing: () => Promise<void>,
) {
  assert.ok(ordinaryCloseSession && process.platform === "win32");
  captureBackupFocusCleanup();
  const inventory = path.join(output, `${name}-live-processes.json`);
  const captured = observeNativeSession("Snapshot", inventory);
  artifacts.push(inventory);
  assert.deepEqual(captured.driver, ownedSession.driver);
  const matches = (expected: string) =>
    captured.processes.filter(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(expected).toLowerCase(),
    );
  assert.equal(matches(application).length, 1);
  assert.equal(matches(preparationExecutable).length, 1);
  const applicationProcess = required(matches(application)[0]);
  assert.equal(applicationProcess.pid, captured.application_pid);
  await assertStillPreparing();
  const appInventory = path.join(output, `${name}-application-exit-inventory.json`);
  await writeFile(
    appInventory,
    JSON.stringify(
      {
        ...captured,
        source_snapshot: path.basename(inventory),
        derivation: "captured-application-only-natural-exit-observation",
        processes: [applicationProcess],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  artifacts.push(appInventory);
  const observation: {
    started_at: string;
    close_request?: NativeCloseObservation;
    natural_application_exit?: NativeExitObservation;
    before_cleanup?: NativeCurrentObservation;
  } = { started_at: new Date().toISOString() };
  const evidence = path.join(output, `${name}-ordinary-close.json`);
  try {
    observation.close_request = observeNativeSession("RequestClose", inventory);
    observation.natural_application_exit = observeNativeSession("Wait", appInventory);
    observation.before_cleanup = observeNativeSession("Observe", inventory);
  } finally {
    await writeFile(evidence, JSON.stringify(observation, null, 2), { flag: "wx" });
    artifacts.push(evidence);
  }
  // Only the app's natural exit qualifies ordinary close. Preserve any live
  // preparation child before this separate, identity-bound fixture cleanup.
  browser = undefined;
  stopBackupFocusDriver();
  const cleanup = path.join(output, `${name}-fixture-cleanup.json`);
  await writeFile(cleanup, JSON.stringify(ownedSession.requireQuiescence(), null, 2), {
    flag: "wx",
  });
  artifacts.push(cleanup);
  await startDriver();
  await connect();
  return driverBrowser();
}

interface RestartObservation {
  started_at: string;
  shutdown_request: string;
  snapshot?: NativeProcessSnapshot;
  driver_stop?:
    | NativeStopObservation
    | { method: "observed-child-exit"; exit_code: number }
    | undefined;
  session_delete_completed_at?: string;
  shutdown?: NativeExitObservation;
  fixture_prepared_while_stopped?: boolean;
  reconnected_at?: string;
}
// Read-only identity evidence through the existing owned driver-tree observer.
// An exact executable under the isolated library is required; no PID/name-only ownership.
const acquisitionGameObserver: AcquisitionGameObserver = {
  capture(game, name) {
    assert.equal(process.platform, "win32");
    assert.ok(
      (executionPlan.fixtures.acquisitionJourney || executionPlan.fixtures.registeredSourceReuse) &&
        identityBoundSession,
    );
    const { executable } = game;
    const canonical = (value: string) =>
      path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase();
    const relative = path.relative(canonical(library), canonical(executable));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "Only an executable inside the owned fixture library may be observed",
    );
    const installed = path.relative(canonical(game.installation.path), canonical(executable));
    assert.ok(
      installed && !installed.startsWith("..") && !path.isAbsolute(installed),
      "Observed game must belong to its exact expected installation",
    );
    ownedSession.game = { executable, installation: { ...game.installation } };
    assert.match(name, /^[a-z0-9-]+$/u);
    const deadline = performance.now() + 30_000;
    const snapshot = path.join(output, `${name}-processes.json`);
    // Cold observer startup and the Core session read share this bounded capture
    // budget; other observations and cleanup retain their existing default.
    const captured = observeNativeSession("SnapshotDriverTree", snapshot, undefined, 30_000);
    artifacts.push(snapshot);
    assert.deepEqual(captured.driver, ownedSession.driver, "Captured driver identity changed");
    ownedSession.requireApplication(captured);
    const candidates = captured.processes.filter(
      (entry) => canonical(entry.path) === canonical(executable),
    );
    assert.ok(candidates.length <= 1, "Owned game executable has ambiguous live identities");
    const identity = candidates[0];
    // A supervisor can exist before its game and Core record publication. No capture qualifies yet.
    if (!identity) return null;
    validateBackupFocusInventory(captured, true, deadline);
    if (!ownedSession.games.some((previous) => previous.installation.id === game.installation.id))
      ownedSession.games.push({ executable, installation: { ...game.installation } });
    return { identity, snapshot };
  },
  observe(game, name) {
    assert.match(name, /^[a-z0-9-]+$/u);
    const current = observeNativeSession("Observe", game.snapshot);
    const gameProcess = current.processes.find(
      (entry) =>
        entry.pid === game.identity.pid &&
        entry.path === game.identity.path &&
        entry.started_filetime === game.identity.started_filetime,
    );
    assert.ok(
      gameProcess,
      "Exact captured game identity disappeared from its own observation inventory",
    );
    const receipt = path.join(output, `${name}-observation.json`);
    writeFileSync(
      receipt,
      JSON.stringify({ identity: game.identity, observation: current }, null, 2) + "\n",
      { flag: "wx" },
    );
    artifacts.push(receipt);
    return gameProcess.state;
  },
};

function observeNativeSession<Mode extends NativeSessionMode>(
  mode: Mode,
  snapshot: string,
  identity?: { applicationPid: number; parentPid: number; sha256: string },
  timeoutMs = 10_000,
): NativeSessionObservations[Mode] {
  if (nativeAccount) {
    assert.equal(
      identity,
      undefined,
      "Direct application capture needs its own reviewed account root; no owner fallback",
    );
    return nativeAccount.observe(mode, snapshot, application);
  }
  const driverProcessId = identity?.applicationPid ?? (mode === "Wait" ? 0 : required(driver).pid);
  const result = spawnCommand(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      nativeSessionScript,
      "-Mode",
      mode,
      "-DriverProcessId",
      String(driverProcessId),
      "-ApplicationPath",
      application,
      "-SnapshotPath",
      snapshot,
      ...(identity
        ? [
            "-ExpectedParentProcessId",
            String(identity.parentPid),
            "-ExpectedApplicationSha256",
            identity.sha256,
          ]
        : []),
    ],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return readNativeSessionObservation(mode, JSON.parse(result.stdout));
}

function captureBackupFocusDriverLaunch(launchStarted: number) {
  ownedSession.captureDriverLaunch({
    pid: required(driver).pid,
    executable: driverPath,
    output,
    name: cleanupName,
    launchStarted,
    artifacts,
    observe: observeNativeSession,
  });
}

async function driverReady() {
  try {
    if (linuxBinding) {
      const launch = required(linuxPublication.launch);
      assert.ok("privateAgent" in launch);
      return await new Promise<boolean>((resolve, reject) => {
        const request = httpGet(
          `http://127.0.0.1:${port}/status`,
          { agent: launch.privateAgent },
          (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          },
        );
        request.on("error", reject);
        request.setTimeout(500, () => request.destroy(new Error("private driver status timeout")));
      });
    }
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    // Driver startup remains bounded by the loop and connection timeout.
    return false;
  }
}

let publicationRestartRoot: string | undefined;
function driverEnvironment(childEnvironment: NodeJS.ProcessEnv) {
  const environment: NodeJS.ProcessEnv = {
    ...(nativeAccount || linuxBinding ? {} : process.env),
    ...childEnvironment,
    ...(originFixture
      ? {
          PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL: originFixture.url,
          TAURI_WEBDRIVER_PORT: String(port + 2),
        }
      : {}),
    ...(installFixture ? { PORTCOVE_QUALIFICATION_CATALOG: installFixture.catalogPath } : {}),
    ...(externalFixture ? { PORTCOVE_QUALIFICATION_CATALOG: externalFixture.catalogPath } : {}),
    ...(selection.prerequisites.includes("steam-fixture")
      ? { PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE: "closed" }
      : {}),
    PORTCOVE_LIBRARY: hostPublicationSession ? (publicationRestartRoot ?? library) : library,
    ...(hostPublicationSession
      ? {
          PORTCOVE_QUALIFICATION_CHECKPOINT: path.join(
            output,
            ".qualification-lifecycle",
            "armed.json",
          ),
        }
      : {}),
    PORTCOVE_PREFERENCES: path.join(runtimeRoot, "preferences.json"),
    PORTCOVE_APPLICATION_UPDATE_PREFERENCES: path.join(runtimeRoot, "application-updates.json"),
    PORTCOVE_APPLICATION_UPDATE_SCHEDULE: path.join(
      runtimeRoot,
      "application-update-schedule.json",
    ),
    PORTCOVE_APPLICATION_UPDATE_STAGING: path.join(runtimeRoot, "application-update-state"),
    WEBVIEW2_USER_DATA_FOLDER: profile,
  };
  if (externalBrowser) {
    delete environment.BROWSER;
    delete environment.CHROME_CONFIG_HOME;
    delete environment.CHROME_USER_DATA_DIR;
  }
  return savedLibraryRecoverySession ? bootstrapRecoveryEnvironment(environment) : environment;
}

async function startDriver(childEnvironment: NodeJS.ProcessEnv = {}) {
  if (linuxPackagedInspector) {
    const { verifyApplicationMediaInputs } =
      await import("../../../scripts/desktop-linux-media.mts");
    await verifyApplicationMediaInputs(inputs, admission);
  } else await admission.verify(custody?.inputs ?? []);
  const launchStarted = Date.now();
  await launchDriverProcess(childEnvironment);
  const spawnedDriver = required(driver);
  let spawnError: Error | undefined;
  if (!(spawnedDriver instanceof AccountDriverView)) {
    spawnedDriver.on("error", (error) => {
      spawnError = error;
    });
  }
  for (const stream of [spawnedDriver.stdout, spawnedDriver.stderr]) {
    if (!stream) throw new Error("Owned driver capture stream is missing");
    stream.on("data", (chunk: Buffer) => {
      driverLog = (driverLog + chunk.toString()).slice(-1024 * 1024);
    });
  }
  if (linuxSelectedSession) await required(linuxPublication.launch).ready();
  if (linuxPackagedInspector) return;
  try {
    await captureSelectedDriverLaunch(launchStarted);
    if (historySession)
      historyInventory = await captureHistoryDriver(required(spawnedDriver.pid), driverPath);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (spawnedDriver.exitCode !== null)
        throw new Error(`tauri-driver exited: ${spawnedDriver.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await driverReady()) return;
    }
    throw new Error("tauri-driver did not become ready within ten seconds");
  } catch (error) {
    // A later startup observation must not strand the newly captured spawnedDriver.
    // Without positive launch identity, retain the failure and refuse PID-only cleanup.
    await cleanupFailedDriverLaunch();
    throw error;
  }
}

async function launchDriverProcess(childEnvironment: NodeJS.ProcessEnv) {
  const arguments_ = [
    "--port",
    String(port),
    "--native-port",
    String(port + 1),
    "--native-driver",
    nativeDriverPath,
  ];
  if (linuxSelectedSession) {
    ownedSession.beginLaunch();
    const launch = await linuxPublication.start(async () => {
      if (linuxBinding) {
        assert.equal(
          linuxPackagedInspector,
          false,
          "Inspector media route is separate from isolated WebDriver package qualification",
        );
        return await launchIsolatedLinuxNativeSession(
          linuxBinding,
          driverPath,
          arguments_,
          driverEnvironment(childEnvironment),
          admission.assertReady,
        );
      } else
        return await launchLinuxNativeSession(
          linuxPackagedInspector ? process.execPath : driverPath,
          linuxPackagedInspector
            ? [
                path.join(root, "scripts/desktop-linux-media.mts"),
                "--launch-probed-app",
                required(process.env.PORTCOVE_QUALIFICATION_MEDIA_CONFIG),
                application,
                required(inputs[0]).sha256,
                applicationMediaEvidence,
              ]
            : arguments_,
          linuxPackagedInspector
            ? linuxInspectorEnvironment(driverEnvironment(childEnvironment), port)
            : driverEnvironment(childEnvironment),
          { beforeLaunch: admission.assertReady },
        );
    });
    driver = launch.child;
  } else if (nativeAccount) {
    driver = ownedSession.startLaunch({
      admit: () => admission.assertReady(),
      create: () =>
        required(nativeAccount).start(
          driverPath,
          arguments_,
          runtimeRoot,
          driverEnvironment(childEnvironment),
        ),
    });
  } else {
    driver = ownedSession.startLaunch({
      admit: () => admission.assertReady(),
      create: () =>
        spawn(driverPath, arguments_, {
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: driverEnvironment(childEnvironment),
        }),
    });
  }
}

async function captureSelectedDriverLaunch(launchStarted: number) {
  if (linuxSelectedSession) return;
  if (!identityBoundSession) return;
  const child = required(driver);
  if (!(child instanceof AccountDriverView)) {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  captureBackupFocusDriverLaunch(launchStarted);
}

async function verifyCompactSettingsJumps() {
  const browser = driverBrowser();
  const index = await browser.findElement(By.css('nav[aria-label="Settings categories"]'));
  assert.deepEqual(
    await Promise.all(
      (await index.findElements(By.css('button[data-slot="button"]'))).map((button) =>
        button.getText(),
      ),
    ),
    [
      "Appearance",
      "Library and storage",
      "Game files",
      "Updates",
      "Integrations",
      "Keyboard and controller",
      "Advanced",
      "About",
    ],
  );
  await executeBrowserScript(
    browser,
    (element) => element.scrollIntoView({ block: "start" }),
    index,
  );
  await captureScenarioScreenshot("settings-section-index-compact");
  await selectSettingsCategory("game-files");
  const jump = await executeBrowserScript(browser, () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const bounds = active.getBoundingClientRect();
    return {
      id: active.id,
      tabIndex: active.tabIndex,
      outlineStyle: getComputedStyle(active).outlineStyle,
      top: bounds.top,
      bottom: bounds.bottom,
    };
  });
  assert.equal(jump?.id, "settings-game-files-heading");
  assert.equal(jump.tabIndex, -1);
  assert.equal(jump.outlineStyle, "solid");
  assert.ok(jump.top >= 0 && jump.bottom <= 640);
  await captureScenarioScreenshot("settings-section-jump-game-files");
  await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
  assert.equal(
    await executeBrowserScript(browser, () =>
      document.activeElement?.closest("[data-settings-group]")?.getAttribute("data-settings-group"),
    ),
    "game-files",
  );
  assert.equal(
    await executeBrowserScript(
      browser,
      () => document.getElementById("settings-game-files-heading")?.tabIndex,
    ),
    -1,
  );

  const diagnosticCopy = await executeBrowserScript(browser, () => {
    const paragraph = document.querySelector(
      ".diagnostics-card .support-bundle-export > p:first-of-type",
    );
    if (!(paragraph instanceof HTMLElement)) throw new Error("Diagnostics explanation is missing");
    const original = paragraph.textContent;
    paragraph.textContent = `${original} `.repeat(8);
    return original;
  });
  try {
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "start" }),
      index,
    );
    await selectSettingsCategory("advanced");
    const focus = await executeBrowserScript(browser, () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const bounds = active.getBoundingClientRect();
      return {
        id: active.id,
        outlineStyle: getComputedStyle(active).outlineStyle,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    });
    await captureScenarioScreenshot("settings-section-jump-advanced-long-content");
    assert.equal(focus?.id, "settings-advanced-heading");
    assert.equal(focus.outlineStyle, "solid");
    assert.ok(focus.top >= 0 && focus.bottom <= 640, JSON.stringify(focus));
    await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
    assert.equal(
      await executeBrowserScript(browser, () =>
        document.activeElement
          ?.closest("[data-settings-group]")
          ?.getAttribute("data-settings-group"),
      ),
      "advanced",
    );
    assert.equal(
      await executeBrowserScript(
        browser,
        () => document.getElementById("settings-advanced-heading")?.tabIndex,
      ),
      -1,
    );
    const next = await executeBrowserScript(browser, () => {
      const active = document.activeElement;
      const bounds = active?.getBoundingClientRect();
      return {
        label: active?.getAttribute("aria-label") ?? active?.textContent?.trim().slice(0, 80),
        top: bounds?.top,
        bottom: bounds?.bottom,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.clientHeight,
        visualViewportHeight: window.visualViewport?.height,
      };
    });
    assert.ok(typeof next.top === "number" && typeof next.bottom === "number");
    assert.ok(next.top >= 0 && next.bottom <= 640, JSON.stringify(next));
    await captureScenarioScreenshot("settings-section-advanced-next-control");
  } finally {
    await executeBrowserScript(
      browser,
      (copy) => {
        const paragraph = document.querySelector(
          ".diagnostics-card .support-bundle-export > p:first-of-type",
        );
        if (paragraph) paragraph.textContent = copy;
      },
      diagnosticCopy,
    );
  }
  await selectSettingsCategory("about");
  const about = await browser.findElement(By.css(".about-card"));
  const aboutLayout = await executeBrowserScript(
    browser,
    (element) => {
      element.scrollIntoView({ block: "start" });
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    },
    about,
  );
  assert.equal(aboutLayout.overflow, false);
  assert.ok(
    aboutLayout.left >= 0 && aboutLayout.right <= aboutLayout.viewportWidth,
    JSON.stringify(aboutLayout),
  );
  await captureScenarioScreenshot("settings-about-card-compact", true);
}

async function verifySettingsIndexTheme(theme: string) {
  const browser = driverBrowser();
  const index = await browser.findElement(By.css('nav[aria-label="Settings categories"]'));
  const geometry = await executeBrowserScript(
    browser,
    (element) => {
      element.scrollIntoView({ block: "start" });
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    },
    index,
  );
  assert.equal(geometry.documentOverflow, false);
  assert.ok(geometry.left >= 0 && geometry.right <= 960);
  assert.ok(geometry.bottom <= 640);
  await captureScenarioScreenshot(`settings-section-index-${theme}`);
}

try {
  let preferencesRecoveryFixture:
    | Awaited<ReturnType<typeof preparePreferencesRecoveryFixture>>
    | undefined;
  if (preferencesRecoverySession) {
    preferencesRecoveryFixture = await preparePreferencesRecoveryFixture(output);
    for (const name of ["preferencesBefore", "markerBefore"] as const) {
      inputs.push(await fileIdentity(preferencesRecoveryFixture[name]));
      artifacts.push(preferencesRecoveryFixture[name]);
    }
  }
  let librarySwitchRecoveryFixture:
    | Awaited<ReturnType<typeof prepareLibrarySwitchRecoveryFixture>>
    | undefined;
  if (librarySwitchRecoverySession) {
    librarySwitchRecoveryFixture = await prepareLibrarySwitchRecoveryFixture(output);
    for (const file of Object.values(librarySwitchRecoveryFixture.before)) {
      inputs.push(await fileIdentity(file));
      artifacts.push(file);
    }
    inputs.push(await fileIdentity(librarySwitchRecoveryFixture.futureDatabase));
  }
  if (bootstrapRecoverySession) {
    bootstrapRecoveryFixture = await prepareBootstrapRecoveryFixture(output);
    for (const name of ["invalidBefore", "preferencesBefore"] as const)
      inputs.push(await fileIdentity(bootstrapRecoveryFixture[name]));
    artifacts.push(
      bootstrapRecoveryFixture.invalidBefore,
      bootstrapRecoveryFixture.preferencesBefore,
    );
  }
  if (selection.prerequisites.includes("install-fixture")) {
    installFixture = await createInstallFixture({
      root,
      output,
      revision,
      sourceJourney: executionPlan.fixtures.sourceJourney,
      preliminaryJourney: executionPlan.fixtures.preliminaryJourney,
      preliminarySetupJourney: Boolean(executionPlan.fixtures.preliminarySetupJourney),
      hashResumeJourney: Boolean(executionPlan.fixtures.hashResumeJourney),
      completionJourney: executionPlan.fixtures.completionJourney,
      acquisitionJourney: Boolean(executionPlan.fixtures.acquisitionJourney),
      holdFirstDownload: executionPlan.fixtures.holdFirstDownload,
      ...(values["preparation-tool"] ? { preparationTool: values["preparation-tool"] } : {}),
    });
    if (installFixture.sourceJourney) {
      if (installFixture.preliminaryJourney)
        for (const name of ["path", "before"] as const)
          inputs.push(await fileIdentity(installFixture.preliminaryJourney[name]));
      for (const name of ["gameBefore", "gameReplacement", "biosBefore"] as const)
        inputs.push(await fileIdentity(installFixture.sourceJourney[name]));
      if (installFixture.completionJourney && ["win32", "linux"].includes(process.platform)) {
        installFixture.nativeConnectionJourney = true;
      } else
        installFixture.sourceJourney.root = seedSelectedSetup({
          cli: required(values["preparation-cli"]),
          library,
          output,
          fixture: installFixture,
        });
    }
    inputs.push(await fileIdentity(installFixture.artifactPath));
    inputs.push(await fileIdentity(installFixture.catalogPath));
  }
  if (selection.prerequisites.includes("external-runtime-fixture")) {
    externalFixture = await createExternalRuntimeFixture(output);
    const catalog = object(JSON.parse(await readFile(externalFixture.catalogPath, "utf8")));
    assert.ok(Array.isArray(catalog.ports));
    const declared = object(catalog.ports[0]);
    assert.equal(declared.id, externalFixture.port.id);
    const prepared = object(object(object(declared.release).user_prepared)["windows-x86-64"]);
    assert.ok(Array.isArray(prepared.mutable_paths));
    const mutablePaths = prepared.mutable_paths.map((entry: unknown) => text(entry));
    const immutableFiles = new Map(
      await Promise.all(
        externalFixture.identities
          .filter((identity) => !mutablePaths.includes(path.basename(identity.path)))
          .map(
            async (identity) =>
              [path.basename(identity.path), await readFile(identity.path)] as const,
          ),
      ),
    );
    assert.equal(
      externalFixtureTreeDigest(immutableFiles),
      prepared.immutable_tree_sha256,
      "Actual prepared fixture bytes must match the declared immutable tree before launch",
    );
    inputs.push(
      await fileIdentity(
        fileURLToPath(new URL("./desktop-external-runtime-test.mts", import.meta.url)),
      ),
    );
    inputs.push(await fileIdentity(externalFixture.catalogPath), ...externalFixture.identities);
  }
  if (selection.selected_scenarios.includes("native-registered-source-reuse")) {
    const original = process.env.PORTCOVE_SOURCE_REUSE_ORIGINAL;
    assert.ok(
      original && path.isAbsolute(original),
      "Source reuse requires an explicit absolute original ZIP",
    );
    registeredSourceReuseFixture = await prepareRegisteredSourceReuseInputs({
      output,
      library,
      cli: required(values["preparation-cli"]),
      original,
    });
    inputs.push(registeredSourceReuseFixture.before, registeredSourceReuseFixture.copy);
  }
  if (selection.selected_scenarios.includes("native-real-prepared-runtime")) {
    const manifest = process.env.PORTCOVE_REAL_RUNTIME_INPUTS;
    assert.ok(
      manifest && path.isAbsolute(manifest),
      "Real runtime qualification requires its exact absolute input manifest",
    );
    realRuntimeFixture = await prepareRealRuntimeInputs({
      output,
      library,
      cli: required(values["preparation-cli"]),
      manifest,
    });
    inputs.push(...realRuntimeFixture.inputs);
  }
  if (runnerMetadata.acceptance_bindings) {
    assert.equal(
      custody?.retained_metadata,
      true,
      "Finite packet declarations require retained metadata",
    );
    const retainedRoot = retainedEvidenceRoot(output);
    const fixtures = packetFixtureIdentities;
    for (const [index, input] of inputs.entries())
      if (!input.retained) {
        const retained = await retainEvidenceInput({
          root: retainedRoot,
          file: input.path,
          signal: admission.signal,
        });
        assert.equal(retained.sha256, input.sha256, "Fixture changed before capture");
        fixtures.push({ ...retained.retained, role: `fixture-${fixtures.length}` });
        inputs[index] = {
          ...input,
          ...retained,
          role: `fixture-${fixtures.length - 1}`,
          kind: "fixture",
        };
      }
  }
  await requireUnusedPort(port);
  await requireUnusedPort(port + 1);
  if (selection.selected_scenarios.includes("native-linux-packaged-webview-boundary")) {
    externalBrowser = await prepareLinuxExternalBrowser();
    inputs.push(...externalBrowser.identities);
  }
  if (selection.selected_scenarios.includes("native-linux-webview-origin-boundary")) {
    await requireUnusedPort(port + 2);
    originFixture = await createOriginBoundaryFixture();
  }
  await startDriver();
  await connect();
  if (runnerMetadata.acceptance_bindings) {
    assert.equal(
      custody?.retained_metadata,
      true,
      "Finite packet declarations must be consumed from retained non-secret metadata",
    );
    const declaration = object(runnerMetadata.acceptance_bindings);
    const retainedRoot = retainedEvidenceRoot(output);
    const fixtures = packetFixtureIdentities;
    const capabilities = linuxPackagedInspector ? null : await driverBrowser().getCapabilities();
    const capabilityValue = (key: string): unknown => required(capabilities).get(key);
    const nodeIdentity = await fileIdentity(process.execPath, { signal: admission.signal });
    let privateDisplay;
    if (process.env.PORTCOVE_QUALIFICATION_DISPLAY_RECEIPT) {
      privateDisplay = await retainEvidenceInput({
        root: retainedRoot,
        file: process.env.PORTCOVE_QUALIFICATION_DISPLAY_RECEIPT,
        signal: admission.signal,
      });
      inputs.push({ ...privateDisplay, role: "private-display-observation", kind: "runtime" });
    }
    const runtime = {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      node_executable: nodeIdentity,
      operating_system: os.release(),
      browser: linuxPackagedInspector
        ? requiredInspector().observedRuntime
        : {
            name: capabilityValue("browserName") ?? null,
            version: capabilityValue("browserVersion") ?? null,
            platform: capabilityValue("platformName") ?? null,
          },
      ...(privateDisplay ? { private_display: privateDisplay.retained } : {}),
      display_route: process.env.PORTCOVE_QUALIFICATION_DISPLAY_RECEIPT
        ? "private-authenticated-virtual-X11"
        : "native-platform-display",
      physical_controller: "not-qualified",
      driver_inputs: inputs
        .filter((input) => ["driver", "native-driver"].includes(input.role ?? ""))
        .map(({ role, sha256, bytes }) => ({ role, sha256, bytes })),
    };
    acceptancePreflight = await writeAcceptancePreflight(
      path.join(path.dirname(required(process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST)), "packet"),
      parseAcceptancePreflightContext({
        root,
        author: declaration.author,
        source_review: declaration.source_review,
        bindings: {
          ...observePacketDeliveryBindings(root, revision),
          build_inputs: runnerMetadata.verification_build,
          product_artifacts: inputs
            .filter((input) =>
              ["app", "preparation-cli", "preparation-tool"].includes(input.role ?? ""),
            )
            .map((input) => ({ ...input.retained, role: input.role })),
          harness_inputs: inputs
            .filter((input) => input.kind === "file")
            .map((input) => ({ ...input.retained, role: input.role })),
          execution_qualification: {
            runtime_conditions: runtime,
            fixture_identities: fixtures,
            initial_state: {
              isolated: true,
              fixture_consumption:
                "Original owned paths; cooperative ownership and pre/post content checks, not immutable Core consumption",
              seeded_owned_fixture: Boolean(installFixture),
              restart_cycles: restartCycles,
              reload_cycles: reloadCycles,
            },
            requirements: declaration.requirements,
            scenarios: selection.selected_scenarios,
            acceptance_criteria: declaration.acceptance_criteria,
          },
        },
        prerequisites: selection.prerequisites.map((id) => ({
          id,
          outcome: "available-for-selected-run",
        })),
        reusable_evidence: declaration.reusable_evidence ?? [],
        known_gaps: declaration.known_gaps ?? [],
      }),
    );
    console.log(JSON.stringify({ acceptance_preflight: acceptancePreflight.identity }));
  }
  if (historySession) {
    historyInventory = await captureHistorySession(
      required(required(driver).pid),
      driverPath,
      application,
    );
    const record = path.join(output, "qualification-history-process-identities.json");
    await writeFile(record, JSON.stringify(historyInventory, null, 2), { flag: "wx" });
    artifacts.push(record);
  }
  await scenario("native-host-publication-recovery", async () => {
    const fixture = required(installFixture);
    await hostPublicationScenario({
      browser: driverBrowser(),
      output,
      library,
      artifacts,
      fixture,
      command: ownedFixtureCommand({
        cli: required(values["preparation-cli"]),
        library,
        output,
        catalogPath: fixture.catalogPath,
      }),
      invoke,
      confirmNative: nativeConfirmation({
        application,
        getDriverPid: () => required(required(driver).pid),
        output,
        artifacts,
      }),
      restartApplication,
      interruptHost: interruptCheckpointHost,
    });
  });
  if (selection.selected_scenarios.includes("native-registered-source-reuse")) {
    await registeredSourceReuseScenario({
      browser: driverBrowser(),
      output,
      artifacts,
      scenario,
      library,
      cli: required(values["preparation-cli"]),
      fixture: required(registeredSourceReuseFixture),
      application,
      ownedGameProcess: acquisitionGameObserver,
      ownedLaunchSessions: () => acquisitionLaunchSessions(performance.now() + 30000),
      confirmNative: nativeConfirmation({
        application,
        getDriverPid: () => required(required(driver).pid),
        output,
        artifacts,
      }),
    });
  }
  await scenario("native-real-prepared-runtime", async () => {
    const pickerContext = {
      application,
      getDriverPid: () => required(required(driver).pid),
      getDriverIdentity: () => ownedSession.driver,
      output,
      artifacts,
    };
    await realRuntimeScenario({
      browser: driverBrowser(),
      invoke,
      fixture: required(realRuntimeFixture),
      output,
      artifacts,
      confirmNative: nativeConfirmation(pickerContext),
      selectPicker: nativePreparedRuntimePicker(pickerContext),
      restartApplication,
      library,
      cli: required(values["preparation-cli"]),
      application,
    });
  });
  await scenario("native-external-runtime-review", async () => {
    const browser = driverBrowser();
    const pickerContext = {
      application: application,
      getDriverIdentity: () => ownedSession.driver,
      output,
      artifacts,
    };
    await externalRuntimeReviewScenario({
      browser,
      By,
      until,
      fixture: required(externalFixture),
      output,
      artifacts,
      invoke,
      confirmNative: nativeConfirmation({
        application: application,
        getDriverPid: () => required(required(driver).pid),
        output,
        artifacts,
      }),
      pickerObservation: externalRuntimePickerObservation({
        browser,
        By,
        Key,
        until,
        fixture: required(externalFixture),
        observePicker: nativePickerObservation(pickerContext),
      }),
      selectPicker: nativePreparedRuntimePicker(pickerContext),
    });
  });
  await scenario("native-startup-preferences-recovery", async () => {
    const browser = driverBrowser();
    await preferencesRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: required(preferencesRecoveryFixture),
      captureScreenshot: captureScenarioScreenshot,
      captureAccessibilityReport,
      restart: restartApplication,
      output,
      artifacts,
    });
  });
  await scenario("native-library-switch-recovery", async () => {
    const browser = driverBrowser();
    await librarySwitchRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: required(librarySwitchRecoveryFixture),
      chooseOwnedLibrary: nativeConfirmation({
        application: application,
        getDriverPid: () => required(required(driver).pid),
        output,
        artifacts,
      }),
      captureScreenshot: captureScenarioScreenshot,
      captureAccessibilityReport,
      restart: restartApplication,
      output,
      artifacts,
    });
  });
  await scenario("native-startup-library-recovery", async () => {
    const browser = driverBrowser();
    const chooseOwnedLibrary = nativeConfirmation({
      application: application,
      getDriverPid: () => required(required(driver).pid),
      output,
      artifacts,
    });
    await bootstrapRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: required(bootstrapRecoveryFixture),
      chooseOwnedLibrary,
      captureScreenshot: captureScenarioScreenshot,
      restart: restartApplication,
      output,
      artifacts,
    });
  });
  await scenario("native-normal-package-webview-boundary", async () => {
    const browser = driverBrowser();
    const requests = await normalPackageBoundaryScenario({
      browser,
      invoke,
      library,
      preferencesPath: path.join(runtimeRoot, "preferences.json"),
      output,
      artifacts,
      packageEvidence: required(packageEvidence),
    });
    assertOwnedBoundaryRequests(requests);
  });
  await scenario("native-linux-packaged-webview-boundary", async () => {
    const browser = requiredInspector();
    const requests = await normalPackageBoundaryScenario({
      browser,
      invoke,
      library,
      preferencesPath: path.join(runtimeRoot, "preferences.json"),
      output,
      artifacts,
      packageEvidence: required(packageEvidence),
      ...(externalBrowser ? { externalBrowser } : {}),
    });
    assertOwnedBoundaryRequests(requests);
    assert.ok(browser.verifyOwnedListener, "Owned inspector listener verification required");
    artifacts.push(await browser.verifyOwnedListener());
  });
  await scenario("native-linux-webview-origin-boundary", async () => {
    const browser = driverBrowser();
    await linuxOriginBoundaryScenario({
      browser,
      invoke,
      library,
      output,
      artifacts,
      fixture: required(originFixture),
    });
  });
  await scenario("empty-library", async () => {
    const browser = driverBrowser();
    if (linuxBinding) {
      const capabilities = await invoke("get_engine_capabilities");
      assert.ok(capabilities.ok, "Installed Linux Core capability observation failed");
      const observed = object(capabilities.value);
      assert.equal(observed.product, "Portcove");
      assert.ok(Number.isSafeInteger(observed.schema_version));
      assert.equal(typeof observed.product_version, "string");
      const filename = path.join(output, "linux-native-core-capabilities.json");
      await writeFile(
        filename,
        JSON.stringify({
          schema_version: 1,
          observed_at: new Date().toISOString(),
          binding_sha256: process.env.PORTCOVE_NATIVE_LINUX_BINDING_SHA256,
          core: observed,
          authority: "none",
        }) + "\n",
        { flag: "wx" },
      );
      artifacts.push(filename);
      const launch = required(linuxPublication.launch);
      assert.ok("observeRuntime" in launch);
      const runtime = await launch.observeRuntime();
      const browserCapabilities = await browser.getCapabilities();
      const browserName: unknown = browserCapabilities.get("browserName"),
        browserVersion: unknown = browserCapabilities.get("browserVersion");
      const runtimePath = path.join(output, "linux-native-runtime.json");
      await writeFile(
        runtimePath,
        JSON.stringify({
          schema_version: 1,
          observed_at: new Date().toISOString(),
          binding_sha256: process.env.PORTCOVE_NATIVE_LINUX_BINDING_SHA256,
          runtime,
          core: observed,
          browser: {
            name: browserName ?? null,
            version: browserVersion ?? null,
          },
          authority: "none",
        }) + "\n",
        { flag: "wx" },
      );
      artifacts.push(runtimePath);
    }
    if (nativeAccount) {
      // Observe the existing Core capability endpoint through this actual
      // installed renderer. This data is not a new client capability or a
      // native acceptance receipt; the fixed parent must bind it separately.
      const capabilities = await invoke("get_engine_capabilities");
      assert.ok(capabilities.ok, "Installed Core capability observation failed");
      const value = object(capabilities.value);
      assert.equal(value.product, "Portcove");
      assert.ok(Number.isSafeInteger(value.schema_version));
      assert.equal(typeof value.product_version, "string");
      const snapshotPath = path.join(output, "native-runtime-processes.json");
      const snapshot = observeNativeSession("Snapshot", snapshotPath);
      const enginePaths = [
        ...new Set(
          snapshot.processes
            .filter((item) => path.basename(item.path).toLowerCase() === "msedgewebview2.exe")
            .map((item) => item.path),
        ),
      ];
      assert.ok(
        enginePaths.length >= 1 && enginePaths.length <= 4,
        "Actual loaded WebView images required",
      );
      const loaded = await Promise.all(
        enginePaths.map((image) =>
          fileIdentity(image, { maxBytes: 256 * 1024 * 1024, signal: admission.signal }),
        ),
      );
      const browserCapabilities = await browser.getCapabilities();
      const browserName: unknown = browserCapabilities.get("browserName");
      const browserVersion: unknown = browserCapabilities.get("browserVersion");
      const runtimePath = path.join(output, "native-runtime-capabilities.json");
      await writeFile(
        runtimePath,
        JSON.stringify({
          schema_version: 1,
          observed_at: new Date().toISOString(),
          account_binding_sha256: process.env.PORTCOVE_NATIVE_ACCOUNT_BINDING_SHA256,
          operating_system: os.release(),
          architecture: process.arch,
          core: value,
          browser: {
            name: browserName ?? null,
            version: browserVersion ?? null,
          },
          loaded_engine_images: loaded,
          process_snapshot: snapshotPath,
          authority: "none",
        }) + "\n",
        { flag: "wx" },
      );
      artifacts.push(snapshotPath, runtimePath);
    }
    const bootstrap = await invoke("get_bootstrap_status");
    assert.ok(bootstrap.ok);
    assert.equal(path.resolve(required(bootstrap.value.library_root)), library);
    const status = await invoke("get_statuses");
    assert.ok(status.ok);
    assert.equal(status.value.filter((item) => item.active).length, 0);
    const firstCatalog = await browser.wait(
      until.elementLocated(By.xpath('//h1[normalize-space(.)="Discover"]')),
      15_000,
    );
    assert.equal(await firstCatalog.isDisplayed(), true);
    assert.ok((await browser.findElements(By.css("button.discover-game-identity"))).length > 0);
    const connection = await browser.findElement(
      By.css('[aria-label="Connect your game files"] button'),
    );
    await browser.wait(until.elementIsVisible(connection), 5_000);
    const entryReply: unknown = await browser.executeAsyncScript<unknown>(
      (control: Element, done: (result: unknown) => void) => {
        control.scrollIntoView({ block: "nearest" });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const bounds = control.getBoundingClientRect();
            done({
              title: document.querySelector("h1")?.textContent?.trim(),
              text: control.closest('[aria-label="Connect your game files"]')?.textContent,
              top: bounds.top,
              bottom: bounds.bottom,
              left: bounds.left,
              right: bounds.right,
              viewport: { width: innerWidth, height: innerHeight },
            });
          }),
        );
      },
      connection,
    );
    const entryState = object(entryReply);
    const viewport = object(entryState.viewport);
    assert.ok(
      typeof entryState.top === "number" &&
        typeof entryState.bottom === "number" &&
        typeof entryState.left === "number" &&
        typeof entryState.right === "number",
    );
    assert.ok(typeof viewport.height === "number" && typeof viewport.width === "number");
    assert.equal(entryState.title, "Discover");
    assert.ok(entryState.top >= 0 && entryState.bottom <= viewport.height);
    assert.ok(entryState.left >= 0 && entryState.right <= viewport.width);
    const entryArtifact = path.join(output, "first-use-port-catalog-state.json");
    await writeFile(entryArtifact, JSON.stringify(entryState, null, 2) + "\n", { flag: "wx" });
    artifacts.push(entryArtifact);
    await captureScenarioScreenshot("first-use-port-catalog", true);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const browse = await browser.wait(
      until.elementLocated(
        By.xpath('//*[contains(@class,"empty-state")]//button[normalize-space(.)="Add games"]'),
      ),
      15_000,
    );
    assert.equal(await browse.getAttribute("data-slot"), "button");
    assert.equal(await browse.getAttribute("data-variant"), "primary");
    assert.match(
      await browser.findElement(By.css(".empty-state")).getText(),
      /Your library is empty[\s\S]*copy a supported installation without changing its original folder/,
    );
    await captureScenarioScreenshot("empty-library-shared-controls");
    const updateChoice = await browser.wait(
      until.elementLocated(
        By.xpath(
          '//*[@role="status"][.//strong[normalize-space(.)="Choose how Portcove updates"]]',
        ),
      ),
      15_000,
    );
    assert.equal(await updateChoice.isDisplayed(), true);
    await browser.manage().window().setRect({ width: 960, height: 640 });
    const firstUseAction = await executeBrowserScript(
      browser,
      (button) => {
        const bounds = button.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight };
      },
      browse,
    );
    await captureScenarioScreenshot("empty-library-compact-first-use", true);
    assert.ok(
      firstUseAction.top >= 0 && firstUseAction.bottom <= firstUseAction.viewportHeight,
      `Add games must be visible without scrolling: ${JSON.stringify(firstUseAction)}`,
    );
    await browser.manage().window().setRect({ width: 1280, height: 800 });
    assert.equal((await browser.findElements(By.id("port-search"))).length, 0);
    assert.match(
      await browser.findElement(By.css(".empty-state")).getText(),
      /Your library is empty/,
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//*[contains(@class,"empty-state")]//button[normalize-space(.)="Add games"]'),
      ),
      5000,
    );
    assert.equal((await browser.findElements(By.css(".filter-row"))).length, 0);
    await browser
      .findElement(
        By.xpath('//*[contains(@class,"empty-state")]//button[normalize-space(.)="Add games"]'),
      )
      .click();
    await browser.wait(
      until.elementIsVisible(
        await browser.findElement(By.css('[aria-label="Add games workspace"]')),
      ),
      5_000,
    );
    for (const name of [
      "Choose a game or port",
      "Find games in a folder",
      "Use an existing installation",
    ])
      assert.equal(
        await browser.findElement(By.css(`button[aria-label="${name}"]`)).isDisplayed(),
        true,
        `Add games route is missing: ${name}`,
      );
    await browser.findElement(By.xpath('//button[normalize-space(.)="Back to library"]')).click();
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Connect game-file folder"]'))
      .click();
    await browser.wait(
      until.elementLocated(By.xpath('//h2[normalize-space(.)="Game files"]')),
      5000,
    );
    await browser.wait(
      async () =>
        executeBrowserScript(browser, () =>
          document.activeElement?.matches('[data-settings-control="add-game-file-root"]'),
        ),
      10_000,
    );
    await captureScenarioScreenshot("empty-library-connect-game-files");
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
  });
  await scenario("native-design-system-compatibility", async () => {
    const browser = driverBrowser();
    const environment = await assertDesignCompatibility({ browser, By, Key, until });
    const environmentArtifact = path.join(output, "design-compatibility-environment.json");
    await writeFile(environmentArtifact, JSON.stringify(environment, null, 2), { flag: "wx" });
    artifacts.push(environmentArtifact);
  });
  await scenario("native-error-recovery", async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.ok(bootstrap.ok);
    const failed = await invoke("verify_port", {
      portId: "nonexistent-fixture-port",
      generation: bootstrap.value.generation,
    });
    assert.equal(failed.ok, false);
    assert.ok(object(failed.error).code);
    assert.equal(success(await invoke("get_bootstrap_status")).ready, true);
  });
  await scenario("native-startup-network-diagnostic", async () => {
    const browser = driverBrowser();
    inputs.push(
      await fileIdentity(
        fileURLToPath(new URL("./desktop-startup-network-diagnostic.mts", import.meta.url)),
      ),
    );
    const observation = await observeStartupNetwork({
      invoke,
      readAlerts: () =>
        executeBrowserScript(browser, () => document.querySelectorAll(".error-banner").length),
    });
    const report = path.join(output, "startup-network-diagnostic.json");
    await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.equal(
      observation.completed,
      true,
      "Current diagnostic coverage is incomplete; inspect its phase",
    );
  });
  await scenario("native-library-selection-review", async () => {
    const browser = driverBrowser();
    const before = await invoke("get_bootstrap_status");
    assert.ok(before.ok);
    const defaultRoot = await invoke("get_default_library_root");
    assert.ok(defaultRoot.ok);
    assert.ok(defaultRoot.value);
    await selectSettingsCategory("library-storage");
    const card = await browser.wait(
      until.elementLocated(By.xpath('//article[.//h2[normalize-space(.)="Library at startup"]]')),
      15_000,
    );
    assert.ok((await card.getText()).includes("Opening another library does not move your files"));
    const trigger = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Use default library"]')),
      15_000,
    );
    await trigger.click();
    const dialog = By.css('[aria-labelledby="library-selection-review-title"]');
    const review = await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.wait(until.elementIsVisible(review), 5_000);
    await browser.wait(
      async () => (await review.getText()).includes("Open the default library?"),
      5_000,
      "Default library review title did not become visible",
    );
    const reviewText = await review.getText();
    assert.ok(reviewText.includes("Open the default library?"));
    assert.ok(reviewText.includes(defaultRoot.value));
    assert.ok(reviewText.includes("Files in the current library will stay where they are"));
    assert.equal(
      success(await invoke("get_bootstrap_status")).library_root,
      before.value.library_root,
    );
    await assertCompactReview(browser, '[aria-labelledby="library-selection-review-title"]');
    const accessibility = path.join(output, "library-selection-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    const capture = await captureSettledVisual({
      browser,
      output,
      name: "native-library-selection-review",
      scenario: "native-library-selection-review",
      target: '[aria-labelledby="library-selection-review-title"]',
      observeTarget: () =>
        executeBrowserScript(
          browser,
          observeVisibleTarget,
          '[aria-labelledby="library-selection-review-title"]',
        ),
      readiness: () =>
        executeBrowserScript(browser, () => {
          const review = document.querySelector(
            '[aria-labelledby="library-selection-review-title"]',
          );
          const title = document.querySelector("#library-selection-review-title");
          return {
            ready: Boolean(
              review &&
              title?.textContent.includes("Open the default library?") &&
              [...review.querySelectorAll("button")].some((control) => !control.disabled),
            ),
            phase: "default-library-consent-review",
          };
        }),
    });
    artifacts.push(capture.image.path, capture.receipt);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
    await browser.wait(
      () =>
        executeBrowserScript(browser, "return document.activeElement === arguments[0];", trigger),
      5_000,
      "Library selection review trigger did not regain focus after Escape",
    );
    assert.deepEqual(success(await invoke("get_bootstrap_status")), before.value);
  });
  await scenario("native-library-browsing-context", async () => {
    const browser = driverBrowser();
    const chooseOwnedLibrary = nativeConfirmation({
      application: application,
      getDriverPid: () => required(required(driver).pid),
      output,
      artifacts,
    });
    const original = success(await invoke("get_bootstrap_status"));
    assert.equal(path.resolve(required(original.library_root)), library);
    const alternate = path.join(output, "browsing-alternate-library");
    await mkdir(alternate);
    await selectPrimaryNavigation(browser, "Discover");
    let search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    const workspace = transportValue(
      "desktop_workspace_snapshot",
      success(await invoke("get_workspace_snapshot", { generation: original.generation })),
    );
    const allPortIds = [
      ...new Set([
        ...workspace.catalog.ports.map((port) => port.id),
        ...(workspace.listing_catalog?.listings.map((listing) => listing.id) ?? []),
        ...(workspace.pending_setups?.map((setup) => setup.port_id) ?? []),
      ]),
    ].sort();
    const channelButton = async (channel: string) => {
      const panel = await openCatalogFilters(browser);
      const label = channel === "beta" ? "Preview" : channel === "stable" ? "Stable" : "Rolling";
      return panel.findElement(
        By.xpath(
          `.//fieldset[legend[normalize-space(.)="Release channels"]]//button[contains(normalize-space(.),"${label}")]`,
        ),
      );
    };
    const expectChannels = async (channels: string[]) => {
      const expected =
        channels.length === 0
          ? allPortIds
          : workspace.catalog.ports
              .filter((port) => port.channels.some((channel) => channels.includes(channel)))
              .map((port) => port.id)
              .sort();
      assert.ok(expected.length > 0, "Channel fixture must contain matching ports");
      await browser.wait(
        async () =>
          JSON.stringify(await catalogResultPortIds(browser)) === JSON.stringify(expected),
        5_000,
        `Discover did not display the exact ${channels.join("+") || "All"} matching-port union once`,
      );
      for (const channel of ["stable", "beta", "rolling"])
        assert.equal(
          await (await channelButton(channel)).getAttribute("aria-pressed"),
          String(channels.includes(channel)),
        );
    };
    await clearCatalogFilters(browser);
    await (await channelButton("stable")).click();
    await expectChannels(["stable"]);
    await (await channelButton("beta")).click();
    await expectChannels(["stable", "beta"]);
    await (await channelButton("stable")).click();
    await expectChannels(["beta"]);
    await (await channelButton("beta")).click();
    await expectChannels([]);
    await (await channelButton("rolling")).click();
    await expectChannels(["rolling"]);
    await clearCatalogFilters(browser);
    await expectChannels([]);
    await (await channelButton("stable")).click();
    await (await channelButton("beta")).click();
    await expectChannels(["stable", "beta"]);
    await search.sendKeys("zelda");
    await reviewControls(browser).click(
      By.xpath('//section[@aria-label="Filter options"]//button[normalize-space(.)="Done"]'),
    );
    await browser.wait(async () => (await catalogResultPortIds(browser)).length > 0, 5_000);
    const sort = By.xpath('//button[@role="combobox"][contains(., "Sort")]');
    await browser.findElement(sort).click();
    await browser
      .wait(until.elementLocated(By.xpath('//*[@role="option"][contains(., "Name A–Z")]')), 5_000)
      .click();
    const card = await browser.findElement(By.css(".discover-game-identity"));
    await executeBrowserScript(browser, "arguments[0].scrollIntoView({block:'center'});", card);
    const origin = await executeBrowserScript(
      browser,
      (card) => {
        const ids: unknown = JSON.parse(
          card.closest(".discover-game")?.getAttribute("data-discover-matching-port-ids") ?? "[]",
        );
        if (!Array.isArray(ids)) throw new Error("Discover group lost its matching identities");
        const candidates: unknown[] = ids;
        const portId = candidates[0];
        if (typeof portId !== "string" || !portId.length)
          throw new Error("Discover group lost its first matching port identity");
        return {
          key: card.getAttribute("data-detail-origin"),
          portId,
          scroll: document.querySelector("main")?.scrollTop,
        };
      },
      card,
    );
    await selectCatalogPort(browser, origin.portId);
    await browser.wait(until.elementLocated(By.css(".detail-back")), 15_000).click();
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (key) => document.activeElement?.getAttribute("data-detail-origin") === key,
          origin.key,
        ),
      5_000,
    );
    search = await browser.findElement(By.id("port-search"));
    assert.equal(await search.getAttribute("value"), "zelda");
    assert.ok((await browser.findElement(sort).getText()).includes("Name A–Z"));
    assert.ok(
      Math.abs(
        required(
          await executeBrowserScript(browser, () => document.querySelector("main")?.scrollTop),
        ) - required(origin.scroll),
      ) <= 1,
    );
    await captureScenarioScreenshot("native-catalog-composed-channels");
    await search.click();
    assert.equal(
      await executeBrowserScript(browser, "return document.activeElement.id"),
      "port-search",
    );
    await browser.actions().keyDown(Key.CONTROL).sendKeys("4").keyUp(Key.CONTROL).perform();
    await browser.wait(until.elementLocated(By.css(".diagnostics-card")), 15_000);
    const switchTo = async (target: string, artifactName: string, previousGeneration: number) => {
      await selectPrimaryNavigation(browser, "Settings");
      await browser.wait(
        async () => {
          const diagnostics = await browser.findElement(By.css(".diagnostics-card"));
          return (await diagnostics.getText()).includes("Diagnostics are current.");
        },
        15_000,
        "Settings diagnostics did not settle before the library switch",
      );
      await browser.wait(
        async () => {
          const connection = await browser.findElement(
            By.xpath('//article[.//h2[normalize-space(.)="GitHub connection"]]'),
          );
          const text = await connection.getText();
          return (
            !text.includes("Connection status unavailable") ||
            (await browser.findElements(By.css('.error-banner[role="alert"]'))).length > 0
          );
        },
        65_000,
        "GitHub status request retained the outgoing library lease",
      );
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Choose another library"]'))
        .click();
      const picker = await chooseOwnedLibrary(
        "Choose Portcove library",
        "Select Folder",
        "Folder",
        artifactName,
        undefined,
        target,
      );
      assert.equal(path.resolve(text(object(picker).selected_directory)), path.resolve(target));
      const review = await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="library-selection-review-title"]')),
        15_000,
      );
      await browser.wait(until.elementIsVisible(review), 5_000);
      assert.ok((await review.getText()).includes(target));
      await review.findElement(By.xpath('.//button[normalize-space(.)="Switch library"]')).click();
      const outcome = await browser.wait(
        async () => {
          const status = await invoke("get_bootstrap_status");
          if (
            status.ok &&
            status.value.ready &&
            status.value.generation > previousGeneration &&
            status.value.library_root !== null &&
            path.toNamespacedPath(status.value.library_root) === path.toNamespacedPath(target)
          )
            return "switched";
          const alerts = await browser.findElements(
            By.xpath('//article[.//h2[normalize-space(.)="Library at startup"]]//*[@role="alert"]'),
          );
          return alerts.length ? { error: await required(alerts[0]).getText(), status } : false;
        },
        15_000,
        "Owned library switch did not advance bootstrap generation",
      );
      if (outcome !== "switched") {
        const diagnostic: {
          outcome: unknown;
          technical_text?: string | null;
          technical_projection?: unknown;
          parse_error?: string;
          capture_error?: string;
        } = { outcome };
        try {
          diagnostic.technical_text = await executeBrowserScript(browser, () => {
            const article = [...document.querySelectorAll("article")].find((element) =>
              [...element.querySelectorAll("h2")].some(
                (heading) => heading.textContent.trim() === "Library at startup",
              ),
            );
            return (
              article?.querySelector('[role="alert"] .failure-details pre')?.textContent ?? null
            );
          });
          if (diagnostic.technical_text) {
            try {
              diagnostic.technical_projection = JSON.parse(diagnostic.technical_text);
            } catch (error) {
              diagnostic.parse_error = String(error);
            }
          } else {
            diagnostic.capture_error = "Library switch technical projection is absent";
          }
        } catch (error) {
          diagnostic.capture_error = String(error);
        }
        const report = path.join(output, `${artifactName}-switch-failure.json`);
        try {
          await writeFile(report, JSON.stringify(diagnostic, null, 2), { flag: "wx" });
          artifacts.push(report);
        } catch (error) {
          console.error("Library switch diagnostic write failed", String(error), diagnostic);
        }
      }
      assert.equal(outcome, "switched", `Library switch failed: ${JSON.stringify(outcome)}`);
      await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Choose another library"]')),
        15_000,
      );
    };
    await switchTo(alternate, "library-picker-select-alternate", original.generation);
    await selectPrimaryNavigation(browser, "Discover");
    const alternateSearch = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    assert.equal(await alternateSearch.getAttribute("value"), "");
    const alternateBeta = await channelButton("beta");
    assert.equal(await alternateBeta.getAttribute("aria-pressed"), "false");
    assert.equal(await (await channelButton("stable")).getAttribute("aria-pressed"), "false");
    const alternateStatus = success(await invoke("get_bootstrap_status"));
    await switchTo(library, "library-picker-select-original", alternateStatus.generation);
    await selectPrimaryNavigation(browser, "Discover");
    const restoredSearch = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    assert.equal(await restoredSearch.getAttribute("value"), "zelda");
    await browser.wait(
      () => executeBrowserScript(browser, "return document.activeElement.id === 'port-search'"),
      5_000,
      "Saved catalog focus did not return after library data loaded",
    );
    const restoredBeta = await channelButton("beta");
    assert.equal(await restoredBeta.getAttribute("aria-pressed"), "true");
    assert.equal(await (await channelButton("stable")).getAttribute("aria-pressed"), "true");
    assert.ok((await browser.findElement(sort).getText()).includes("Name A–Z"));
    assert.equal((await browser.findElements(By.css('[role="dialog"]'))).length, 0);
    await browser.wait(
      async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
      15_000,
      "Restored catalog did not finish loading",
    );
    await executeBrowserScript(
      browser,
      "arguments[0].scrollIntoView({block: 'center'});",
      restoredSearch,
    );
    await captureScenarioScreenshot("native-library-browsing-context-restored");
  });
  await catalogUpdateScenario({ browser, invoke, scenario, output, artifacts });
  for (const cacheConditions of [true, false]) {
    await defaultCoverScenario({
      browser,
      invoke,
      scenario,
      output,
      artifacts,
      capture: captureScenarioScreenshot,
      setTheme: selectSettingsTheme,
      library,
      restart: restartApplication,
      cacheConditions,
      coverPortIds: values["cover-port-id"],
    });
  }
  await scenario("keyboard-layout", async () => {
    const browser = driverBrowser();
    const futureFolderSummary = By.xpath(
      '//details[contains(@class,"future-setup-disclosure")]/summary[normalize-space(.)="Folder for a future install"]',
    );
    const verifySidebarLabels = async () => {
      const labels = await executeBrowserScript(browser, () =>
        [...document.querySelectorAll('nav[aria-label="Primary navigation"] .nav-item')]
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => {
            const label = button.querySelector("span:not(.icon)");
            if (!(button instanceof HTMLElement) || !(label instanceof HTMLElement))
              throw new Error("Primary navigation label is missing");
            const labelStyle = getComputedStyle(label);
            const icon = button.querySelector(".icon");
            const iconRect = icon?.getBoundingClientRect();
            return {
              text: label.textContent,
              compactLabel:
                labelStyle.position === "absolute" &&
                labelStyle.clipPath === "inset(50%)" &&
                label.clientWidth === 1 &&
                label.clientHeight === 1,
              iconVisible: Boolean(iconRect && iconRect.width > 0 && iconRect.height > 0),
              widthFits: label.scrollWidth <= label.clientWidth + 1,
              heightFits: label.scrollHeight <= label.clientHeight + 1,
              buttonFits: button.scrollHeight <= button.clientHeight + 1,
            };
          }),
      );
      assert.deepEqual(
        labels.map((label) => label.text),
        ["Library", "Discover", "Activity", "Settings"],
      );
      assert.ok(
        labels.every(
          (label) =>
            label.buttonFits &&
            (label.compactLabel ? label.iconVisible : label.widthFits && label.heightFits),
        ),
        JSON.stringify(labels),
      );
    };
    await browser.manage().window().setRect({ width: 1280, height: 800 });
    await verifySidebarLabels();
    await captureKeyboardTarget(
      "sidebar-full-labels-default",
      await browser.findElement(By.css(".sidebar nav")),
    );
    await browser.manage().window().setRect({ width: 640, height: 640 });
    await browser.findElement(By.css('button[aria-label="Open navigation"]')).click();
    await browser.wait(
      until.elementIsVisible(
        await browser.wait(until.elementLocated(By.css(".navigation-sheet")), 5_000),
      ),
      5_000,
    );
    await verifySidebarLabels();
    await selectPrimaryNavigation(browser, "Settings");
    await browser.wait(until.elementLocated(By.css('[data-settings-group="appearance"]')), 15_000);
    const visibleGroups: { name: string; columns: number }[] = [];
    for (const id of [
      "appearance",
      "library-storage",
      "game-files",
      "updates",
      "integrations",
      "controls",
      "advanced",
      "about",
    ]) {
      await selectSettingsCategory(id);
      const columns = await executeBrowserScript(
        browser,
        (categoryId) => {
          const section = document.querySelector(`[data-settings-group="${categoryId}"]`);
          const content = section?.querySelector(".settings-section-content");
          if (!(content instanceof HTMLElement) || section?.closest("[hidden]"))
            throw new Error("Selected Settings category is not visible");
          return getComputedStyle(content).gridTemplateColumns.split(" ").length;
        },
        id,
      );
      visibleGroups.push({ name: id, columns });
    }
    const layout = await executeBrowserScript(browser, () => ({
      document_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      about_columns: (() => {
        const about = document.querySelector(".about-card");
        if (!(about instanceof HTMLElement)) throw new Error("About card is missing");
        return getComputedStyle(about).gridTemplateColumns.split(" ").length;
      })(),
      overflowing_cards: [...document.querySelectorAll(".settings-row")]
        .filter((card) => card.scrollWidth > card.clientWidth + 1)
        .map((card) => card.getAttribute("aria-labelledby") ?? card.className),
      legacy_buttons: [
        ...document.querySelectorAll(
          '[data-settings-group]:not([data-settings-group="updates"]) button:not([data-slot="button"]):not([data-slot="select-trigger"])',
        ),
      ].map((button) => button.textContent?.trim() ?? ""),
      legacy_shell_buttons: [
        ...document.querySelectorAll(
          'aside button:not([data-slot="button"]), header button:not([data-slot="button"])',
        ),
      ].map((button) => button.textContent?.trim() ?? button.getAttribute("aria-label") ?? ""),
    }));
    assert.equal(layout.document_overflow, false);
    assert.equal(layout.about_columns, 1);
    assert.deepEqual(visibleGroups, [
      { name: "appearance", columns: 1 },
      { name: "library-storage", columns: 1 },
      { name: "game-files", columns: 1 },
      { name: "updates", columns: 1 },
      { name: "integrations", columns: 1 },
      { name: "controls", columns: 1 },
      { name: "advanced", columns: 1 },
      { name: "about", columns: 1 },
    ]);
    assert.deepEqual(layout.overflowing_cards, []);
    assert.deepEqual(layout.legacy_buttons, []);
    assert.deepEqual(layout.legacy_shell_buttons, []);
    await verifyCompactSettingsJumps();

    let focusedSettingsControl = false;
    for (let step = 0; step < 30 && !focusedSettingsControl; step++) {
      await browser.actions().sendKeys(Key.TAB).perform();
      focusedSettingsControl = await executeBrowserScript(browser, () =>
        Boolean(document.activeElement?.closest("[data-settings-group]")),
      );
    }
    assert.equal(focusedSettingsControl, true);
    const focus = await executeBrowserScript(browser, () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const bounds = active.getBoundingClientRect();
      return {
        tag: active.tagName,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    });
    assert.ok(focus);
    assert.notEqual(focus.tag, "BODY");
    assert.ok(focus.left >= 0 && focus.right <= 640);
    assert.ok(focus.top >= 0 && focus.bottom <= 640);
    await selectSettingsCategory("about");
    const about = await browser.findElement(By.css(".about-card"));
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
      about,
    );
    const aboutHeight = await executeBrowserScript(
      browser,
      (element) => ({
        height: element.getBoundingClientRect().height,
        viewport: window.innerHeight,
      }),
      about,
    );
    if (aboutHeight.height > aboutHeight.viewport)
      await assert.rejects(
        captureKeyboardTarget("settings-about-panel-refused", about),
        /Capture target exceeds viewport; capture identified title\/actions instead/,
      );
    await captureKeyboardTarget(
      "settings-about-title-compact",
      await about.findElement(By.css("h3")),
    );

    await selectSettingsCategory("updates");
    const gameUpdatesLink = await browser.findElement(
      By.xpath(
        '//*[@data-settings-group="updates"]//button[normalize-space(.)="Open game updates in Activity"]',
      ),
    );
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "center" }),
      gameUpdatesLink,
    );
    await captureKeyboardTarget("settings-game-update-destination-link", gameUpdatesLink);
    await gameUpdatesLink.click();
    await browser.wait(until.elementLocated(By.css(".update-center")), 15_000);
    assert.equal(await browser.findElement(By.css("main h1")).getText(), "Activity");
    assert.equal(
      await browser.findElement(By.css('[aria-label="Game updates"]')).isDisplayed(),
      true,
    );
    assert.equal(
      await browser.findElement(By.css('[aria-label="Tasks and history"]')).isDisplayed(),
      false,
    );
    assert.equal(
      await executeBrowserScript(browser, () => {
        const stat = [...document.querySelectorAll(".update-stat")].find(
          (candidate) => candidate.querySelector("span")?.textContent === "Updates available",
        );
        return stat?.querySelector("strong")?.textContent;
      }),
      "—",
      "An empty managed library must not report a completed zero-update check",
    );
    await browser.wait(
      () => executeBrowserScript(browser, () => document.activeElement?.matches("main h1")),
      5_000,
      "Game updates heading did not receive focus",
    );
    const updateCheckDetails = await browser.findElement(By.css(".update-check-details"));
    if ((await updateCheckDetails.getAttribute("open")) === null)
      await updateCheckDetails.findElement(By.css("summary")).click();
    const applicationUpdatesLink = await browser.findElement(
      By.xpath('//button[normalize-space(.)="Open Portcove update settings"]'),
    );
    await browser.wait(until.elementIsVisible(applicationUpdatesLink), 5_000);
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "center" }),
      applicationUpdatesLink,
    );
    await captureKeyboardTarget("game-updates-settings-destination-link", applicationUpdatesLink);
    await applicationUpdatesLink.click();
    const updateSettings = await browser.wait(
      until.elementLocated(By.css('[data-settings-group="updates"]')),
      15_000,
    );
    assert.ok((await updateSettings.getText()).includes("Portcove updates"));
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          () => document.activeElement?.id === "settings-updates-heading",
        ),
      5_000,
      "Application update settings did not receive focus",
    );

    await selectPrimaryNavigation(browser, "Discover");
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await clearCatalogFilters(browser);
    const filters = await openCatalogFilters(browser);
    const channelChoices = await filters.findElement(
      By.css('button[aria-label="Release channels: All"]'),
    );
    await clickVisible(browser, channelChoices);
    const selectedFilter = await browser.wait(
      until.elementLocated(
        By.css('fieldset[aria-label="Release channels"] [role="checkbox"][aria-label^="Stable ("]'),
      ),
      5_000,
    );
    await browser.wait(until.elementIsVisible(selectedFilter), 5_000);
    await selectedFilter.sendKeys(Key.SPACE);
    await browser.wait(
      async () => (await selectedFilter.getAttribute("aria-checked")) === "true",
      5_000,
      "Keyboard activation did not select the Stable channel filter",
    );
    assert.equal(await selectedFilter.getAttribute("data-slot"), "checkbox");
    await selectedFilter.sendKeys(Key.ESCAPE);
    await browser.wait(
      async () =>
        (await channelChoices.getAttribute("aria-expanded")) === "false" &&
        (await executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          channelChoices,
        )),
      5_000,
      "Escape did not close channel choices and restore focus to its trigger",
    );
    await channelChoices.sendKeys(Key.ESCAPE);
    await browser.wait(
      () =>
        executeBrowserScript(browser, () => {
          const active = document.activeElement;
          return (
            active instanceof HTMLButtonElement &&
            active.textContent?.trim() === "Filters (1)" &&
            active.getAttribute("aria-expanded") === "false"
          );
        }),
      5_000,
      "Escape did not close Filters and restore focus to its trigger",
    );
    // WebDriver clear() can empty the DOM without committing React's query;
    // the next render then restores the previous scenario's search. Exercise
    // actual editing with a nonempty preimage, including on standalone runs.
    const selectAll = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    await search.sendKeys(selectAll, "a", Key.NULL, "prior catalog query");
    assert.equal(await search.getAttribute("value"), "prior catalog query");
    await search.sendKeys(selectAll, "a", Key.NULL, Key.BACK_SPACE);
    await browser.wait(async () => (await search.getAttribute("value")) === "", 5_000);
    await clearCatalogFilters(browser);
    await browser.findElement(By.id("port-search")).sendKeys("Ghostship");
    assert.equal(await search.getAttribute("value"), "Ghostship");
    await browser.wait(
      () =>
        executeBrowserScript(browser, () =>
          [...document.querySelectorAll(".discover-game-identity")].some((card) =>
            card.textContent?.includes("Ghostship"),
          ),
        ),
      15_000,
    );
    const origin = await executeBrowserScript(browser, () => {
      const cards = [...document.querySelectorAll(".discover-game-identity")];
      const card = cards.find((item) => item.textContent?.includes("Ghostship"));
      if (!(card instanceof HTMLElement)) throw new Error("Catalog detail origin is missing");
      card.scrollIntoView({ block: "center", inline: "nearest" });
      card.focus();
      const originKey = card.getAttribute("data-detail-origin");
      const workspace = document.querySelector("main");
      if (!originKey || !(workspace instanceof HTMLElement))
        throw new Error("Catalog detail origin is incomplete");
      const scrollTop = workspace.scrollTop;
      card.click();
      return { originKey, scrollTop };
    });
    await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 15_000);
    assert.equal(
      await executeBrowserScript(browser, () =>
        document.querySelector('.detail-panel[role="dialog"]'),
      ),
      null,
    );
    assert.equal(
      await executeBrowserScript(browser, () => document.querySelector("#port-search")),
      null,
    );
    assert.equal(
      await executeBrowserScript(
        browser,
        () => document.querySelector("[data-detail-workspace] h1")?.id,
      ),
      "port-detail-title",
    );
    await browser.wait(
      () => executeBrowserScript(browser, () => document.activeElement?.id === "port-detail-title"),
      5_000,
      "Detail navigation did not focus the game heading",
    );
    const verifyDetailActionHierarchy = async () => {
      await revealDetailSection(browser, "Game files");
      const hierarchy = await executeBrowserScript(browser, () => {
        document
          .querySelector(".detail-hero")
          ?.scrollIntoView({ block: "start", behavior: "instant" });
        const title = document.querySelector("#port-detail-title");
        const action = document.querySelector(".detail-header-actions button");
        const hero = document.querySelector<HTMLElement>(".game-hero-detail");
        const cover = hero?.querySelector<HTMLElement>(".game-hero-foreground");
        const image = cover?.querySelector("img");
        if (
          !(title instanceof HTMLElement) ||
          !(action instanceof HTMLElement) ||
          !(hero instanceof HTMLElement)
        )
          throw new Error("Detail header is incomplete");
        const bounds = action.getBoundingClientRect();
        const frame = cover?.getBoundingClientRect();
        const heroBounds = hero.getBoundingClientRect();
        return {
          state: document.querySelector("[data-detail-readiness]")?.textContent?.trim(),
          reason: document.querySelector("[data-detail-reason]")?.textContent?.trim(),
          requirement: document.querySelector(".requirements-disclosure")?.textContent,
          tabs: Array.from(document.querySelectorAll("[data-detail-workspace] [role=tab]"), (tab) =>
            tab.textContent?.trim(),
          ),
          selected: document.querySelector('[role=tab][aria-selected="true"]')?.textContent,
          action: action.textContent?.trim(),
          actionInHero: Boolean(action.closest(".detail-hero")),
          titleFits: title.scrollWidth <= title.clientWidth + 1,
          actionFits: bounds.left >= 0 && bounds.right <= innerWidth,
          actionVisible: bounds.top >= 0 && bounds.bottom <= innerHeight,
          identity: hero.dataset.heroIdentity,
          hero: { width: heroBounds.width, height: heroBounds.height },
          artwork:
            frame && image
              ? {
                  width: frame.width,
                  height: frame.height,
                  naturalWidth: image.naturalWidth,
                  naturalHeight: image.naturalHeight,
                  fit: getComputedStyle(image).objectFit,
                }
              : null,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          futureChoices: Array.from(
            document.querySelectorAll(".future-setup-disclosure"),
            (choice) => ({
              title: choice.querySelector("summary")?.textContent?.trim(),
              open: choice.hasAttribute("open"),
              visible: choice.getBoundingClientRect().height > 0,
            }),
          ),
        };
      });
      assert.equal(hierarchy.state, "Needs game files");
      assert.match(
        required(hierarchy.reason),
        /Choose the required game files before reviewing installation/u,
      );
      assert.match(required(hierarchy.requirement), /Super Mario 64 \(US\) source/u);
      assert.deepEqual(hierarchy.tabs, [
        "Overview",
        "Game files",
        "Saves & backups",
        "Versions & updates",
        "Manage",
      ]);
      assert.equal(hierarchy.selected, "Game files");
      assert.equal(hierarchy.action, "Set up");
      assert.equal(hierarchy.actionInHero, true);
      assert.equal(hierarchy.titleFits, true);
      assert.equal(hierarchy.actionFits, true);
      assert.equal(hierarchy.actionVisible, true);
      assert.equal(hierarchy.horizontalOverflow, false);
      assert.ok(["key_art", "logo", "cover", "text"].includes(required(hierarchy.identity)));
      if (hierarchy.artwork) {
        assert.ok(hierarchy.artwork.width > 0 && hierarchy.artwork.width <= hierarchy.hero.width);
        assert.ok(
          hierarchy.artwork.height > 0 && hierarchy.artwork.height <= hierarchy.hero.height,
        );
        assert.ok(hierarchy.artwork.naturalWidth > 0 && hierarchy.artwork.naturalHeight > 0);
        assert.equal(hierarchy.artwork.fit, "contain");
        assert.notEqual(hierarchy.identity, "text");
      } else assert.equal(hierarchy.identity, "text");
      assert.deepEqual(hierarchy.futureChoices, [
        { title: "Folder for a future install", open: false, visible: false },
      ]);
    };
    await verifyDetailActionHierarchy();
    await captureScenarioScreenshot("game-details-workspace");
    await browser.manage().window().setRect({ width: 960, height: 640 });
    await verifyDetailActionHierarchy();
    await captureScenarioScreenshot("game-details-action-hierarchy");
    await revealDetailSection(browser, "Manage");
    const outputChoices = await browser.findElement(futureFolderSummary);
    const outputDisclosure = await outputChoices.findElement(By.xpath(".."));
    await outputChoices.click();
    assert.equal(
      await executeBrowserScript(
        browser,
        (element) => element.hasAttribute("open"),
        outputDisclosure,
      ),
      true,
    );
    await outputChoices.sendKeys(Key.ENTER);
    assert.equal(
      await executeBrowserScript(
        browser,
        (element) => element.hasAttribute("open"),
        outputDisclosure,
      ),
      false,
    );
    await outputChoices.click();
    const outputDraft = await browser.wait(
      until.elementLocated(By.css('[id^="output-location-path-"]')),
      15_000,
    );
    await browser.wait(async () => await outputDraft.isEnabled(), 15_000);
    await captureOutputDestinationReview("game-details");
    const draftPath = "C:\\Portcove-fixture\\Future-install";
    await outputDraft.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, draftPath);
    await revealDetailSection(browser, "Game files");
    const sourceDraft = await browser.findElement(
      By.css('.requirements-body input[id^="source-"]'),
    );
    await sourceDraft.sendKeys("C:\\Portcove-fixture\\candidate.z64");
    await revealDetailSection(browser, "Manage");
    await browser.wait(
      async () =>
        (await executeBrowserScript(
          browser,
          (element) => element.hasAttribute("open"),
          outputDisclosure,
        )) === true,
      5_000,
      "the open future-folder editor closed after selecting game files",
    );
    assert.equal(await outputDraft.getAttribute("value"), draftPath);
    await revealDetailSection(browser, "Game files");
    await sourceDraft.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
    await revealDetailSection(browser, "Manage");
    await browser.wait(
      async () =>
        (await executeBrowserScript(
          browser,
          (element) => element.hasAttribute("open"),
          outputDisclosure,
        )) === true,
      5_000,
      "the open future-folder editor closed after removing the selected path",
    );
    await outputChoices.click();
    assert.equal(await outputDisclosure.getAttribute("open"), null);
    await outputChoices.click();
    assert.equal(await outputDraft.getAttribute("value"), draftPath);
    await captureScenarioScreenshot("game-details-future-output-draft");
    await outputChoices.click();
    await browser.manage().window().setRect({ width: 640, height: 640 });
    await browser.findElement(By.css(".detail-back")).click();
    await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await browser.wait(
      async () =>
        (await executeBrowserScript(browser, () =>
          document.activeElement?.getAttribute("data-detail-origin"),
        )) === origin.originKey,
      15_000,
    );
    const restored = await executeBrowserScript(browser, () => ({
      query: document.querySelector<HTMLInputElement>("#port-search")?.value,
      focus: document.activeElement?.getAttribute("data-detail-origin"),
      scrollTop: document.querySelector("main")?.scrollTop,
    }));
    assert.equal(restored.query, "Ghostship");
    assert.equal(restored.focus, origin.originKey);
    assert.ok(Math.abs(required(restored.scrollTop) - origin.scrollTop) <= 1);
    await captureScenarioScreenshot("game-details-workspace-return");
    await browser
      .findElement(By.id("port-search"))
      .sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
    await browser.wait(
      async () => (await browser.findElements(By.css(".discover-game-identity"))).length > 2,
      15_000,
    );

    const compactWindow = await browser.manage().window().getRect();
    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await verifySidebarLabels();
      for (const theme of ["dark", "light"]) {
        await selectPrimaryNavigation(browser, "Settings");
        await selectSettingsTheme(theme);
        await verifySettingsIndexTheme(theme);
        const gameFileCards = await browser.findElements(
          By.css('[data-settings-group="game-files"] article.source-health'),
        );
        assert.equal(gameFileCards.length, 2, "Game files settings cards are incomplete");
        const settingsCards = [
          { name: "saved-folders", card: required(gameFileCards[0]), group: "game-files" },
          { name: "verification", card: required(gameFileCards[1]), group: "game-files" },
          {
            name: "capacity",
            card: await browser.findElement(
              By.css('[data-settings-group="library-storage"] article.storage-card'),
            ),
            group: "library-storage",
          },
          {
            name: "disc-tools",
            card: await browser.findElement(
              By.xpath('//h2[@id="disc-tools-heading"]/ancestor::article[1]'),
            ),
            group: "game-files",
          },
        ];
        for (const size of [
          { width: 960, height: 640 },
          { width: 1280, height: 800 },
        ]) {
          await setVerifiedWindowSize(size, "Settings");
          for (const { name, card, group } of settingsCards) {
            await selectSettingsCategory(group);
            await executeBrowserScript(
              browser,
              (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
              card,
            );
            const overflow = await executeBrowserScript(
              browser,
              (element) => element.scrollWidth > element.clientWidth + 1,
              card,
            );
            assert.equal(overflow, false, `${name} overflows at ${size.width}px in ${theme}`);
            await captureScenarioScreenshot(
              `settings-${group}-${name}-${theme}-${size.width}`,
              true,
            );
          }
        }
        await browser.manage().window().setRect({ width: 960, height: 640 });
        await selectPrimaryNavigation(browser, "Discover");
        await browser.wait(
          async () => (await browser.findElements(By.css(".discover-game-identity"))).length > 2,
          15_000,
        );
        const descriptions = await executeBrowserScript(browser, () => {
          const cards = [...document.querySelectorAll(".discover-game")].slice(0, 3);
          cards[0]?.scrollIntoView({ block: "center" });
          return {
            documentOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            items: cards.map((card) => {
              const description = card.querySelector(".collection-title");
              const rect = description?.getBoundingClientRect();
              const style = description ? getComputedStyle(description) : null;
              return {
                text: description?.textContent?.trim(),
                visible: style?.display !== "none" && (rect?.height ?? 0) > 0,
                clamp: style?.webkitLineClamp,
                cardOverflow: card.scrollWidth > card.clientWidth + 1,
              };
            }),
          };
        });
        assert.equal(descriptions.documentOverflow, false);
        assert.equal(descriptions.items.length, 3);
        assert.ok(
          descriptions.items.every(
            ({ text, visible, cardOverflow }) => text && visible && !cardOverflow,
          ),
        );
        await captureScenarioScreenshot(`catalog-short-window-${theme}`);

        const themedOrigin = await executeBrowserScript(browser, () => {
          const card = [...document.querySelectorAll(".discover-game-identity")].find((item) =>
            item.textContent?.includes("Ghostship"),
          );
          if (!(card instanceof HTMLElement)) throw new Error("Ghostship card is missing");
          const originKey = card.getAttribute("data-detail-origin");
          if (!originKey) throw new Error("Ghostship detail origin is missing");
          card.scrollIntoView({ block: "center", inline: "nearest" });
          card.click();
          return originKey;
        });
        await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 15_000);
        for (const size of [
          { width: 960, height: 640 },
          { width: 1280, height: 800 },
        ]) {
          await setVerifiedWindowSize(size, "Missing-source detail");
          assert.equal(
            await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
            theme,
          );
          await verifyDetailActionHierarchy();
          await captureScenarioScreenshot(
            `game-details-missing-source-${theme}-${size.width}`,
            true,
          );
          await revealDetailSection(browser, "Manage");
          const folderChoices = await browser.findElement(futureFolderSummary);
          await folderChoices.click();
          await captureOutputDestinationReview(`game-details-${theme}-${size.width}`);
          await folderChoices.click();
        }
        await browser.findElement(By.css(".detail-back")).click();
        await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await browser.wait(
          async () =>
            (await executeBrowserScript(browser, () =>
              document.activeElement?.getAttribute("data-detail-origin"),
            )) === themedOrigin,
          15_000,
          "Themed game details did not return focus to the catalog card",
        );
        await verifyLongTitleCatalogDetail(theme);
      }
    } finally {
      await browser.manage().window().setRect(compactWindow);
    }
  });
  await scenario("native-application-update-preferences", async () => {
    const browser = driverBrowser();
    const before = await invoke("get_application_update_preferences");
    assert.ok(before.ok);
    assert.equal(before.value.choice, null);
    const initialStatus = await invoke("get_application_update_status");
    assert.ok(initialStatus.ok);
    assert.equal(initialStatus.value.staged, null);
    assert.deepEqual(initialStatus.value.recovery_required, []);
    const activities = await invoke("get_activities");
    assert.ok(activities.ok);

    const choicePrompt = By.xpath(
      '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
    );
    await browser.wait(until.elementLocated(choicePrompt), 15_000);
    await browser.findElement(By.xpath('//button[normalize-space(.)="Review options"]')).click();
    const settings = By.css('article[aria-labelledby="application-update-settings-title"]');
    await browser.wait(until.elementLocated(settings), 15_000);
    try {
      await browser.wait(
        async () =>
          await executeBrowserScript(
            browser,
            () =>
              document.activeElement ===
              document.querySelector(
                '.application-update-settings [aria-label="Application update channel"] button:not(:disabled)',
              ),
          ),
        15_000,
      );
    } catch (error) {
      const focus = await executeBrowserScript(browser, () => ({
        active: document.activeElement?.outerHTML,
        firstControl: document.querySelector(
          '.application-update-settings [aria-label="Application update channel"] button:not(:disabled)',
        )?.outerHTML,
      }));
      throw new Error(`Review options focus: ${JSON.stringify(focus)}`, { cause: error });
    }
    const initialChoice = await browser.switchTo().activeElement();
    await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
    await browser.wait(
      async () =>
        await executeBrowserScript(
          browser,
          (initial) =>
            document.activeElement?.closest(".application-update-settings") !== null &&
            document.activeElement !== initial,
          initialChoice,
        ),
      5_000,
      "Directional navigation left application update settings",
    );
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Application update channel"]')),
      15_000,
    );
    assert.deepEqual(
      await executeBrowserScript(browser, () =>
        [...document.querySelectorAll(".application-update-settings button")]
          .filter((button) => !button.hasAttribute("data-slot"))
          .map((button) => button.textContent?.trim() ?? ""),
      ),
      [],
    );
    await browser
      .findElement(
        By.xpath(
          '//*[@aria-label="Application update channel"]//button[normalize-space(.)="Stable"]',
        ),
      )
      .click();
    await browser
      .findElement(
        By.xpath('//*[@aria-label="Application update mode"]//button[normalize-space(.)="Manual"]'),
      )
      .click();
    await browser
      .findElement(By.css('[role="checkbox"][aria-labelledby="pause-application-updates-label"]'))
      .click();

    assert.equal(
      success(await invoke("get_application_update_preferences")).choice,
      null,
      "editing application update settings is not saving",
    );
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Save application update settings"]'))
      .click();
    await browser.wait(async () => {
      const result = await invoke("get_application_update_preferences");
      return (
        result.ok &&
        result.value.choice?.channel === "stable" &&
        result.value.choice?.mode === "manual" &&
        result.value.choice?.paused === true
      );
    }, 15_000);
    assert.deepEqual(success(await invoke("get_activities")), activities.value);
    await browser.wait(
      until.elementLocated(
        By.xpath(
          '//p[@role="status" and contains(., "Saving these settings does not start an update.")]',
        ),
      ),
      15_000,
    );

    await refreshSettings("updates");
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Application update channel"]')),
      15_000,
    );
    assert.equal(
      await browser
        .findElement(
          By.css('[aria-label="Application update channel"] button[aria-pressed="true"]'),
        )
        .getText(),
      "Stable",
    );
    assert.equal(
      await browser
        .findElement(By.css('[aria-label="Application update mode"] button[aria-pressed="true"]'))
        .getText(),
      "Manual",
    );
    assert.equal(
      await browser
        .findElement(By.css('[role="checkbox"][aria-labelledby="pause-application-updates-label"]'))
        .getAttribute("aria-checked"),
      "true",
    );

    await captureApplicationUpdateSettingsComparison();

    await writeFile(path.join(runtimeRoot, "application-update-schedule.json"), "not-json\n", {
      flag: "wx",
    });
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Refresh update status"]'))
      .click();
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Reset update-check history"]')),
      15_000,
    );
    assert.equal(
      required(success(await invoke("get_application_update_status")).recovery_required[0]).area,
      "schedule",
    );
    await executeBrowserScript(browser, () =>
      document.querySelector(".application-update-recovery")?.scrollIntoView({ block: "center" }),
    );
    await captureScenarioScreenshot("application-update-recovery-light", true);
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Reset update-check history"]'))
      .click();
    await browser.wait(async () => {
      const result = await invoke("get_application_update_status");
      return result.ok && result.value.recovery_required.length === 0;
    }, 15_000);
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Update-check history reset.")]'),
      ),
      15_000,
    );
    assert.deepEqual(success(await invoke("get_activities")), activities.value);

    await writeFile(path.join(runtimeRoot, "application-updates.json"), "not-json\n");
    await refreshSettings("updates");
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Reset update settings"]')),
      15_000,
    );
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Reset update settings"]'))
      .click();
    await browser.wait(
      async () => {
        const result = await invoke("get_application_update_preferences");
        return result.ok && result.value.choice === null && result.value.revision > 0;
      },
      15_000,
      "recovered application update preferences were not published by the host",
    );
    await browser.wait(
      until.elementLocated(choicePrompt),
      15_000,
      "application update choice prompt did not return after recovery",
    );
    await browser.findElement(By.xpath('//button[normalize-space(.)="Not now"]')).click();
    await browser.wait(
      async () => (await browser.findElements(choicePrompt)).length === 0,
      15_000,
      "application update choice prompt did not dismiss",
    );
    await browser.wait(
      async () =>
        (await executeBrowserScript(browser, () => document.activeElement?.tagName)) !== "BODY",
      15_000,
      "focus did not return after dismissing the application update choice prompt",
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Damaged update settings reset.")]'),
      ),
      15_000,
      "application update recovery success notice did not remain visible",
    );
    assert.deepEqual(success(await invoke("get_activities")), activities.value);
    await browser.wait(
      () =>
        executeBrowserScript(browser, () => {
          const control = [...document.querySelectorAll("button")].find(
            (element) => element.textContent?.trim() === "Restore from a library copy",
          );
          return (
            control instanceof HTMLButtonElement &&
            !control.disabled &&
            control.dataset.slot === "button" &&
            control.dataset.variant === "outline"
          );
        }),
      15_000,
      "Restore from a library copy did not retain its enabled shared outline action",
    );
    const report = path.join(output, "application-update-settings-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    await verifySettingsRows();
  });
  await scenario("appearance-restart", async () => {
    await selectSettingsTheme("light");
    assert.equal(
      await executeBrowserScript(driverBrowser(), () => document.documentElement.dataset.theme),
      "light",
    );
    interface AppearanceRestartObservation {
      cycle: number;
      close_started: string;
      shutdown_request: string;
      driver_stop?: NativeStopObservation | undefined;
      session_delete_completed?: string;
      shutdown?: NativeExitObservation;
      connected?: string;
      preference_preserved?: boolean;
      owned_restart_receipt?: string;
    }
    const observations: AppearanceRestartObservation[] = [];
    try {
      for (let cycle = 0; cycle < restartCycles; cycle++) {
        const observation: AppearanceRestartObservation = {
          cycle: cycle + 1,
          close_started: new Date().toISOString(),
          shutdown_request: "identity-bound-isolated-driver-tree-termination",
        };
        observations.push(observation);
        if (process.platform === "win32" && identityBoundSession) {
          const name = `appearance-restart-${cycle + 1}`;
          await restartApplication(name);
          const receipt = path.join(output, `${name}-restart.json`);
          observation.owned_restart_receipt = receipt;
          const cleanup: unknown = JSON.parse(await readFile(receipt, "utf8"));
          assert.ok(isRecord(cleanup));
          observation.shutdown = readNativeSessionObservation("Wait", cleanup.exited);
        } else {
          const snapshot = path.join(output, `restart-${cycle + 1}-processes.json`);
          if (process.platform === "win32") {
            observeNativeSession("Snapshot", snapshot);
            artifacts.push(snapshot);
          }
          observation.driver_stop = await requestApplicationShutdown(snapshot);
          observation.session_delete_completed = new Date().toISOString();
          if (process.platform === "win32")
            observation.shutdown = observeNativeSession("Wait", snapshot);
          await startDriver();
          await connect();
        }
        observation.connected = new Date().toISOString();
        assert.equal(
          await executeBrowserScript(driverBrowser(), () => document.documentElement.dataset.theme),
          "light",
        );
        observation.preference_preserved = true;
      }
    } finally {
      const report = path.join(output, "restart-observations.json");
      await writeFile(report, JSON.stringify(observations, null, 2), {
        flag: "wx",
      });
      artifacts.push(report);
    }
  });
  await scenario("native-localization-foundation", async () => {
    const browser = driverBrowser();
    const reset = await invoke("set_locale_preference", { locale: "en" });
    assert.ok(reset.ok);
    await refreshSettings("appearance");
    const languageTrigger = await browser.wait(
      until.elementLocated(By.css('.language-card [role="combobox"]')),
      15_000,
    );
    await languageTrigger.click();
    await browser.wait(
      until.elementLocated(By.css('[data-slot="select-content"][data-open] [role="option"]')),
      5_000,
      "language choices did not open",
    );
    assert.deepEqual(
      await Promise.all(
        (await browser.findElements(By.css('[role="option"]'))).map((option) => option.getText()),
      ),
      ["System default", "English"],
      "the engineering locale must not be a new production picker choice",
    );
    await browser
      .findElement(By.xpath('//*[@role="option" and contains(., "System default")]'))
      .click();
    await browser.wait(
      async () => success(await invoke("get_locale_preference")).locale === null,
      15_000,
    );
    assert.ok(
      (await browser.findElement(By.css(".language-card")).getText()).includes(
        "Current language: English.",
      ),
    );

    const engineering = await invoke("set_locale_preference", { locale: "ar-XB" });
    assert.ok(engineering.ok);
    await refreshSettings("appearance");
    await browser.wait(async () => {
      const state = await executeBrowserScript(browser, () => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        heading: [...document.querySelectorAll(".language-card h3")].some(
          (element) => element.textContent?.trim() === "لغة الواجهة",
        ),
        preview: document
          .querySelector('.language-card [role="note"]')
          ?.textContent?.includes("معاينة اللغة"),
      }));
      return state.lang === "ar-XB" && state.dir === "rtl" && state.heading && state.preview;
    }, 15_000);
    const rendered = await executeBrowserScript(browser, () => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      heading: [...document.querySelectorAll(".language-card h3")].some(
        (element) => element.textContent?.trim() === "لغة الواجهة",
      ),
      preview: document
        .querySelector('.language-card [role="note"]')
        ?.textContent?.includes("معاينة اللغة"),
      externalResources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => {
          const resource = new URL(name);
          return (
            ["http:", "https:"].includes(resource.protocol) &&
            !["tauri.localhost", "ipc.localhost", "localhost", "127.0.0.1"].includes(
              resource.hostname,
            )
          );
        }),
    }));
    assert.deepEqual(rendered, {
      lang: "ar-XB",
      dir: "rtl",
      heading: true,
      preview: true,
      externalResources: [],
    });
    assert.deepEqual(success(await invoke("get_locale_preference")), { locale: "ar-XB" });
    await captureScenarioScreenshot("native-localization-rtl");
    await browser.navigate().refresh();
    await browser.wait(
      async () =>
        (await executeBrowserScript(browser, () => document.documentElement.lang === "ar-XB")) ===
        true,
      15_000,
      "saved locale did not survive renderer reload",
    );
    assert.equal(await executeBrowserScript(browser, () => document.documentElement.dir), "rtl");
    const accessibility = path.join(output, "native-localization-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);

    await selectPrimaryNavigation(browser, "Settings");
    const rtlTrigger = await browser.wait(
      until.elementLocated(By.css('.language-card [role="combobox"]')),
      15_000,
    );
    await rtlTrigger.click();
    await browser.wait(
      until.elementLocated(By.css('[data-slot="select-content"][data-open] [role="option"]')),
      5_000,
      "language choices did not open",
    );
    await browser
      .findElement(By.xpath('//*[@role="option" and normalize-space(.)="English"]'))
      .click();
    await browser.wait(
      async () =>
        (await executeBrowserScript(
          browser,
          () => document.documentElement.lang === "en" && document.documentElement.dir === "ltr",
        )) === true,
      15_000,
      "switching away from the preview did not resolve English",
    );
    const focusAfterSwitch = await executeBrowserScript(browser, () => ({
      activeTag: document.activeElement?.tagName,
      activeText: document.activeElement?.textContent?.trim().slice(0, 100),
      activeHtml: document.activeElement?.outerHTML.slice(0, 500),
      inLanguageCard: document.activeElement?.closest(".language-card") !== null,
    }));
    const focusReport = path.join(output, "localization-focus-after-switch.json");
    await writeFile(focusReport, JSON.stringify(focusAfterSwitch, null, 2), { flag: "wx" });
    artifacts.push(focusReport);
    assert.equal(
      focusAfterSwitch.inLanguageCard,
      true,
      "switching away from the preview lost language-control focus",
    );
    assert.deepEqual(success(await invoke("get_locale_preference")), { locale: "en" });

    const preferencePath = path.join(runtimeRoot, "preferences.json");
    const savedPreferences = await readFile(preferencePath);
    try {
      await writeFile(preferencePath, "not-json\n");
      await browser.findElement(By.css(".language-card button")).click();
      await browser.wait(
        until.elementLocated(By.css('[data-slot="select-content"][data-open] [role="option"]')),
        5_000,
        "language choices did not open",
      );
      await browser
        .findElement(By.xpath('//*[@role="option" and contains(., "System default")]'))
        .click();
      await browser.wait(
        until.elementLocated(
          By.xpath('//p[@role="status" and contains(., "Couldn\'t save the language.")]'),
        ),
        15_000,
      );
      assert.equal(await executeBrowserScript(browser, () => document.documentElement.lang), "en");
    } finally {
      await writeFile(preferencePath, savedPreferences);
    }
    assert.deepEqual(success(await invoke("get_locale_preference")), { locale: "en" });
    await invoke("set_locale_preference", { locale: null });
  });
  await scenario("accessibility", async () => {
    const browser = driverBrowser();
    const report = path.join(output, "accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
  });
  await controllerScenario({ browser: required(browser), scenario, output, artifacts });
  if (!linuxPackagedInspector) {
    await accessibleNavigationScenario({ browser: driverBrowser(), scenario, output, artifacts });
    await interfaceSizeScenario({
      browser: driverBrowser,
      scenario,
      output,
      artifacts,
      restart: restartApplication,
      setTheme: selectSettingsTheme,
      capture: captureScenarioScreenshot,
      captureTarget: (name, target) => captureKeyboardTarget(name, target, "native-interface-size"),
    });
    await workspaceRefreshScenario({
      browser: driverBrowser(),
      invoke,
      scenario,
      library,
      output,
      artifacts,
      cli: values["preparation-cli"],
      tool: values["preparation-tool"],
    });
    await qualificationHistoryScenario({
      browser: driverBrowser(),
      invoke,
      scenario,
      output,
      artifacts,
      captureScreenshot: captureScenarioScreenshot,
    });
    const selectedFixtureFamilies = new Set(
      executionPlan.fixtureFamilies
        .filter((entry) => entry.members?.length)
        .map((entry) => entry.family),
    );
    await runOwnedFixtureJourneys(
      {
        plan: executionPlan,
        runtime: {
          context: () => ({
            browser: driverBrowser(),
            invoke,
            scenario,
            library,
            output,
            artifacts,
            inputs,
            installFixture,
            restartApplication,
            cli: values["preparation-cli"],
            tool: values["preparation-tool"],
            interruptApplication,
            closeApplication,
            captureLivePreparation,
            ...(executionPlan.fixtures.acquisitionJourney
              ? { ownedGameProcess: acquisitionGameObserver }
              : {}),
            chooseOwnedLibrary: nativeConfirmation({
              application,
              getDriverPid: () => required(required(driver).pid),
              output,
              artifacts,
            }),
            chooseGameFileFolder: ["win32", "linux"].includes(process.platform)
              ? nativeGameFileFolderPicker({
                  application: application,
                  getDriverIdentity: () => ownedSession.driver,
                  getLinuxLaunch: () => linuxPublication.launch,
                  output,
                  artifacts,
                })
              : undefined,
          }),
          confirmNative: () =>
            nativeConfirmation({
              application: application,
              getDriverPid: () => required(required(driver).pid),
              output,
              artifacts,
            }),
          recordKnownGap: (gap) =>
            recordChecks({ scenario: gap.scenario, outcome: "not-run", reason: gap.reason }),
        },
      },
      {
        install: installScenarios,
        selectedSetup: (context) =>
          selectedFixtureFamilies.has("selected-setup")
            ? selectedSetupScenario({
                ...context,
                fixture: required(context.fixture),
                cli: required(context.cli),
              })
            : Promise.resolve(),
        selectedSetupCompletion: ({ chooseGameFileFolder, ...context }) =>
          selectedFixtureFamilies.has("selected-setup-completion")
            ? selectedSetupCompletionScenario({
                ...context,
                fixture: required(context.fixture),
                cli: required(context.cli),
                ...(chooseGameFileFolder ? { chooseGameFileFolder } : {}),
              })
            : Promise.resolve(),
        preparation: (context) =>
          selectedFixtureFamilies.has("preparation")
            ? preparationScenarios({
                ...context,
                interruptApplication:
                  process.platform === "linux"
                    ? interruptLinuxPreparation
                    : context.interruptApplication,
                cli: required(context.cli),
                tool: required(context.tool),
              })
            : Promise.resolve(),
      },
    );
    if (selection.selected_scenarios.includes("native-repeated-library-reload"))
      await reloadScenario({
        browser: driverBrowser(),
        scenario,
        output,
        artifacts,
        cycles: reloadCycles,
      });
  }
} catch (error) {
  recordChecks({
    scenario: "harness",
    outcome: "failed",
    message: errorMessage(error),
  });
  if (browser) {
    const diagnostics = path.join(output, "harness-failure-diagnostics.json");
    await captureStartupDiagnostics(browser)
      .then((details) => writeFile(diagnostics, JSON.stringify(details, null, 2), { flag: "wx" }))
      .then(() => artifacts.push(diagnostics))
      .catch(() => {});
    const screenshot = path.join(output, "harness-failure.png");
    await browser
      .takeScreenshot()
      .then((data) => writeFile(screenshot, data, { encoding: "base64", flag: "wx" }))
      .then(() => artifacts.push(screenshot))
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  try {
    if (linuxSelectedSession) {
      let quitFailure: { error: unknown } | undefined;
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        if (browser)
          await browser.quit().catch((error) => {
            quitFailure = { error };
            recordChecks({
              scenario: "native-linux-session-quit",
              outcome: "failed",
              message: errorMessage(error),
            });
            process.exitCode = 1;
          });
        browser = undefined;
        await stopDriver();
        assert.equal(
          linuxPublication.cleanup?.quiesced,
          true,
          "Positive current Linux namespace join is required",
        );
      } catch (error) {
        cleanupError = error;
        cleanupFailed = true;
        recordChecks({
          scenario: "native-linux-owned-cleanup",
          outcome: "failed",
          message: errorMessage(error),
        });
        process.exitCode = 1;
      }
      if (cleanupFailed || quitFailure) {
        const failure = cleanupFailed ? cleanupError : required(quitFailure).error;
        const evidence = path.join(
          output,
          `linux-native-launch-${linuxPublication.ordinal}-unknown.json`,
        );
        await writeFile(
          evidence,
          JSON.stringify(
            { error: errorMessage(failure), receipt: linuxPublication.launch?.receipt },
            null,
            2,
          ) + "\n",
          { flag: "wx" },
        );
        artifacts.push(evidence);
      }
    } else if (identityBoundSession) {
      try {
        if (driver?.pid && !ownedSession.cleanup) captureBackupFocusCleanup();
        let quitFailure: { error: unknown } | undefined;
        if (browser)
          await browser.quit().catch((error) => {
            quitFailure = { error };
            recordChecks({
              scenario: "native-backup-session-quit",
              outcome: "failed",
              message: errorMessage(error),
            });
            process.exitCode = 1;
          });
        browser = undefined;
        await stopDriver();
        const disposition = ownedSession.cleanupDisposition();
        if (disposition.kind === "not-started") {
          const report = path.join(output, `${cleanupName}-prelaunch.json`);
          await writeFile(
            report,
            JSON.stringify(
              {
                ...disposition,
                reason:
                  "No owned driver or application launch was attempted; no process-exit proof is claimed",
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
          artifacts.push(report);
        } else {
          const report = path.join(output, `${cleanupName}-cleanup.json`);
          await writeFile(
            report,
            JSON.stringify(
              {
                ...disposition.proof,
                session_quit_error: quitFailure ? errorMessage(quitFailure.error) : undefined,
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
          artifacts.push(report);
        }
      } catch (error) {
        recordChecks({
          scenario: "native-backup-owned-cleanup",
          outcome: "failed",
          message: errorMessage(error),
        });
        process.exitCode = 1;
        // No PID-only fallback when identity or positive exit could not be proved.
      }
    } else if (historySession) {
      let quitFailure: { error: unknown } | undefined;
      try {
        assert.ok(historyInventory, "History requires captured identities before interaction");
        const finalInventory = (await historyDriverStillOwned(historyInventory))
          ? await captureHistorySession(
              required(required(driver).pid),
              driverPath,
              application,
              "cleanup",
            )
          : historyInventory;
        assert.equal(finalInventory.driver.start_ticks, historyInventory.driver.start_ticks);
        const identities = new Map(
          [...historyInventory.processes, ...finalInventory.processes].map((entry) => [
            `${entry.pid}:${entry.start_ticks}`,
            entry,
          ]),
        );
        historyInventory.processes = [...identities.values()];
        if (browser)
          await browser.quit().catch((error) => {
            quitFailure = { error };
            recordChecks({
              scenario: "native-history-session-quit",
              outcome: "failed",
              message: errorMessage(error),
            });
            process.exitCode = 1;
          });
        browser = undefined;
        await stopDriver();
        const exited = await waitHistorySessionExit(historyInventory);
        const report = path.join(output, "qualification-history-cleanup.json");
        await writeFile(
          report,
          JSON.stringify(
            { ...exited, session_quit_error: quitFailure ? errorMessage(quitFailure.error) : null },
            null,
            2,
          ),
          { flag: "wx" },
        );
        artifacts.push(report);
      } catch (error) {
        recordChecks({
          scenario: "native-history-owned-cleanup",
          outcome: "failed",
          message: errorMessage(error),
        });
        process.exitCode = 1;
        // No PID-only fallback after missing or changed identity.
      }
    } else {
      if (browser) await browser.quit().catch(() => {});
      await stopDriver();
    }
    clearTimeout(deadline);
    try {
      if (custody) await verifyConsumedInputs(custody.inputs);
      assert.equal(
        (await fileIdentity(application)).sha256,
        required(inputs[0]).sha256,
        "Executable changed during the run; discard its scenario claims.",
      );
    } catch (error) {
      recordChecks({
        scenario: "executable-identity",
        outcome: "failed",
        message: errorMessage(error),
      });
      process.exitCode = 1;
    }
    const log = path.join(output, "driver.log");
    await writeFile(log, driverLog, { flag: "wx" });
    artifacts.push(log);
    for (const name of selection.selected_scenarios) {
      if (!checks.some((check) => check.scenario === name))
        recordChecks({
          scenario: name,
          outcome: "not-run",
          reason: "The harness ended before this selected scenario ran",
        });
    }
    const runtimeArguments: Record<string, unknown> = values;
    await writeEvidence(output, {
      revision,
      executable: application,
      capturedExecutable:
        custody && required(inputs[0]).binding === "retained-artifact"
          ? required(required(inputs[0]).retained)
          : required(inputs[0]),
      checks,
      setupChecks,
      artifacts,
      inputs,
      method: linuxPackagedInspector
        ? "native-linux-ordinary-package-webkit-inspector"
        : selection.profile
          ? `native-desktop-${selection.profile}`
          : "native-desktop-focused",
      context: {
        ...runnerMetadata,
        ...(acceptancePreflight ? { acceptance_preflight: acceptancePreflight.identity } : {}),
        execution_binding: custody
          ? {
              format_version: 1,
              prelaunch_manifest: process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST,
              captured_at: custody.created_at,
              product_artifacts: custody.inputs
                .filter((input) =>
                  ["app", "preparation-cli", "preparation-tool"].includes(input.role ?? ""),
                )
                .map((input) => ({
                  role: input.role,
                  consumed_path: runtimeArguments[input.role],
                  bytes: input.bytes,
                  sha256: input.sha256,
                  binding: input.binding,
                  retained: input.retained,
                })),
              runtime_tools: custody.inputs.filter((input) =>
                ["driver", "native-driver"].includes(input.role ?? ""),
              ),
              harness_inputs: custody.inputs.filter((input) => input.kind === "file"),
              ...(acceptancePreflight
                ? {
                    build_inputs: runnerMetadata.verification_build,
                    execution_qualification:
                      acceptancePreflight.packet.bindings.execution_qualification,
                  }
                : {}),
              verification:
                "Content checked before target import, each application/driver launch and after execution; trusted launcher/verifier source observations are not immutable execution proof",
              limitations: custody.limitations,
            }
          : null,
        profile: selection.profile,
        selected_scenarios: selection.selected_scenarios,
        setup_scenarios: selection.setup_scenarios,
        excluded_scenarios: selection.excluded_scenarios,
        known_gaps: selection.known_gaps,
        restart_cycles: restartCycles,
        reload_cycles: reloadCycles,
        harness_deadline_ms: harnessDeadlineMs,
        phases: [
          ...metadataPhases,
          {
            phase: "native-harness",
            started_at: harnessStarted.toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - harnessStarted.getTime(),
            status: process.exitCode || 0,
          },
        ],
      },
    });
    console.log(JSON.stringify(checks, null, 2));
  } finally {
    if (linuxSelectedSession && linuxPublication.launch) {
      try {
        // A late normal join can release custody but never repair the failed
        // qualification. Keep the owning runner/slot alive while still pending.
        const custody = await linuxPublication.launch.custody();
        const evidence = path.join(
          output,
          `linux-native-launch-${linuxPublication.ordinal}-retained-join.json`,
        );
        await writeFile(evidence, JSON.stringify(custody, null, 2) + "\n", { flag: "wx" });
      } catch (error) {
        console.error(
          `Native custody remains unknown; retained ${output}; native slot and fixture server remain owned: ${errorMessage(error)}`,
        );
        // No owner-death reclamation or foreign-PID fallback is authorized by a
        // failed launcher. An explicit custody resolution is needed to end this
        // retained harness; do not release its slot merely to finish the command.
        const hold = setInterval(() => {}, 60_000);
        await new Promise(() => {});
        clearInterval(hold);
      }
    }
    await releaseNativeResources();
  }
}

async function cleanupFailedDriverLaunch() {
  if (identityBoundSession && ownedSession.driver && driver?.pid) {
    try {
      await stopDriver();
    } catch (cleanupError) {
      recordChecks({
        scenario: "native-driver-launch-cleanup",
        outcome: "failed",
        message: errorMessage(cleanupError),
      });
      process.exitCode = 1;
    }
  }
}
