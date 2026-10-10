import assert from "node:assert/strict";
import { planDesktopExecution } from "../../../scripts/desktop-execution-plan.mjs";
import { runOwnedFixtureJourneys } from "./desktop-owned-fixture-journeys.mjs";
import { isUntrustworthyProbeError } from "./desktop-owned-ipc-probe.mjs";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Builder, By, Key, until } from "selenium-webdriver";
import { writeEvidence, fileIdentity } from "../../../scripts/development-evidence.mjs";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { cachedDesktopDrivers } from "../../../scripts/tool-cache.mjs";
import {
  assertOwnedBoundaryRequests,
  normalPackageBoundaryScenario,
  verifyNormalPackageEvidence,
} from "./desktop-main-webview-boundary.mjs";
import { OwnedNativeSession } from "./desktop-owned-native-session.mjs";
import { observeStartupNetwork } from "./desktop-startup-network-diagnostic.mjs";
import {
  prepareLibrarySwitchRecoveryFixture,
  librarySwitchRecoverySelection,
  librarySwitchRecoveryScenario,
} from "./desktop-library-switch-recovery-test.mjs";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  preferencesRecoverySelection,
  bootstrapRecoveryScenario,
  preparePreferencesRecoveryFixture,
  preferencesRecoveryScenario,
  prepareBootstrapRecoveryFixture,
} from "./desktop-bootstrap-recovery-test.mjs";
import { preparationScenarios } from "./desktop-preparation-test.mjs";
import { seedSelectedSetup, selectedSetupScenario } from "./desktop-source-dialog-test.mjs";
import { selectedSetupCompletionScenario } from "./desktop-selected-setup-completion-test.mjs";
import { nativeConfirmation } from "./desktop-native-confirmation.mjs";
import { controllerScenario } from "./desktop-controller-test.mjs";
import { accessibleNavigationScenario } from "./desktop-accessibility-test.mjs";
import { reloadScenario } from "./desktop-reload-test.mjs";
import { workspaceRefreshScenario } from "./desktop-workspace-refresh-test.mjs";
import {
  qualificationHistoryScenario,
  captureHistorySession,
  captureHistoryDriver,
  historyDriverStillOwned,
  waitHistorySessionExit,
} from "./desktop-qualification-history-test.mjs";
import { assertCompactReview, captureAccessibilityReport } from "./desktop-review-controls.mjs";
import { createInstallFixture } from "./desktop-install-fixture.mjs";
import {
  createExternalRuntimeFixture,
  externalFixtureTreeDigest,
  externalRuntimePickerObservation,
  externalRuntimeReviewScenario,
} from "./desktop-external-runtime-test.mjs";
import {
  nativePickerObservation,
  nativePreparedRuntimePicker,
} from "./desktop-native-confirmation.mjs";
import { installScenarios } from "./desktop-install-test.mjs";
import { assertDesignCompatibility } from "./desktop-design-compatibility-assertions.mjs";
import { catalogUpdateScenario } from "./desktop-catalog-update-test.mjs";
import { defaultCoverScenario } from "./desktop-default-cover-test.mjs";
import {
  desktopHarnessDeadlineMs,
  desktopScenarioById,
  resolveDesktopSelection,
} from "../../../scripts/desktop-scenarios.mjs";
import { acquireNativeSessionLock } from "../../../scripts/native-session-lock.mjs";
import { observeStartup } from "./desktop-startup-observation.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({
  options: {
    app: { type: "string" },
    "package-evidence": { type: "string" },
    driver: { type: "string" },
    "native-driver": { type: "string" },
    output: { type: "string" },
    profile: { type: "string" },
    scenario: { type: "string", multiple: true, default: [] },
    port: { type: "string", default: "4444" },
    "preparation-cli": { type: "string" },
    "preparation-tool": { type: "string" },
    "artwork-only": { type: "boolean", default: false },
    "adoption-only": { type: "boolean", default: false },
    "accessibility-only": { type: "boolean", default: false },
    "restart-cycles": { type: "string", default: "1" },
    "reload-cycles": { type: "string", default: "0" },
    "run-metadata": { type: "string" },
  },
});
const cachedDrivers = cachedDesktopDrivers();
values.driver ??= cachedDrivers?.driver;
values["native-driver"] ??= cachedDrivers?.nativeDriver;
for (const name of ["app", "output"]) {
  if (!values[name] || !path.isAbsolute(values[name]))
    throw new Error(`--${name} requires an absolute path`);
}
for (const name of ["driver", "native-driver"]) {
  if (!values[name] || !path.isAbsolute(values[name]))
    throw new Error(
      `--${name} requires an absolute path or a verified cached driver from ./scripts/bootstrap-quality-tools.ps1 -Desktop`,
    );
}
const port = Number(values.port);
const restartCycles = Number(values["restart-cycles"]);
if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10)
  throw new Error("--restart-cycles must be 1..10");
const reloadCycles = Number(values["reload-cycles"]);
if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25)
  throw new Error("--reload-cycles must be 0..25");
const focusedModes = ["artwork-only", "adoption-only", "accessibility-only"].filter(
  (name) => values[name],
);
if (focusedModes.length > 1) throw new Error("Choose only one focused desktop scenario mode");
if (focusedModes.length && (values.profile || values.scenario.length))
  throw new Error("Legacy focused modes cannot be combined with --profile or --scenario");
if (Boolean(values["preparation-cli"]) !== Boolean(values["preparation-tool"]))
  throw new Error("--preparation-cli and --preparation-tool must be supplied together");
const legacyScenario = values["accessibility-only"]
  ? "accessibility"
  : values["artwork-only"]
    ? "native-local-artwork-picker-and-recovery"
    : values["adoption-only"]
      ? "native-reviewed-existing-install-copy"
      : null;
const selection = resolveDesktopSelection({
  profile: values.profile,
  scenarios: legacyScenario ? [legacyScenario] : values.scenario,
  reloadCycles,
  defaultProfile: values["preparation-cli"] ? "full" : "smoke",
});
// Admission stays with the existing native owners; planning never grants it.
bootstrapRecoverySelection(selection, process.platform);
librarySwitchRecoverySelection(selection, process.platform);
preferencesRecoverySelection(selection, process.platform);
const executionPlan = planDesktopExecution(selection);
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
  identityBoundSession,
  cleanupName,
} = executionPlan.session;
const savedLibraryRecoverySession =
  bootstrapRecoverySession || librarySwitchRecoverySession || preferencesRecoverySession;
if (selection.prerequisites.includes("owned-fixture") && !values["preparation-cli"])
  throw new Error("Selected fixture scenarios require the owned preparation CLI/tool inputs");
if (!Number.isInteger(port) || port < 1024 || port > 65533)
  throw new Error("--port must be 1024..65533");
if (executionPlan.fixtures.owned) {
  for (const name of ["preparation-cli", "preparation-tool"]) {
    if (!values[name] || !path.isAbsolute(values[name]))
      throw new Error(`--${name} requires an absolute path`);
  }
}
const inputs = await Promise.all(
  executionPlan.receiptInputs.map((input) =>
    fileIdentity(input.kind === "executable" ? values[input.name] : path.join(root, input.path)),
  ),
);
for (const name of [
  "scripts/desktop-execution-plan.mjs",
  "apps/desktop/scripts/desktop-owned-fixture-journeys.mjs",
  "apps/desktop/scripts/desktop-owned-ipc-probe.mjs",
])
  inputs.push(await fileIdentity(path.join(root, name)));
let runnerMetadata = {};
if (values["run-metadata"]) {
  if (!path.isAbsolute(values["run-metadata"]))
    throw new Error("--run-metadata requires an absolute path");
  inputs.push(await fileIdentity(values["run-metadata"]));
  runnerMetadata = JSON.parse(await readFile(values["run-metadata"], "utf8"));
}
const revision = spawnCommand("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();
const output = path.resolve(values.output);
await mkdir(output); // Existing output is never reused, including after failed runs.
let installFixture;
let externalFixture;
let bootstrapRecoveryFixture;
let connectedLaunches = 0;
const library = path.join(output, "library");
const profile = path.join(output, "webview");
const checks = [];
const setupChecks = [];
const artifacts = [];
const scenarioOutcomes = new Map();
let driver;
let browser;
let driverLog = "";
let startupAttempt = 0;
let historyInventory;
let packageEvidence;
if (normalPackageSession) {
  assert.equal(process.platform, "win32");
  assert.deepEqual(selection.selected_scenarios, ["native-normal-package-webview-boundary"]);
  packageEvidence = await verifyNormalPackageEvidence(
    values["package-evidence"],
    revision,
    inputs[0],
    root,
  );
  inputs.push(
    ...packageEvidence.identities,
    await fileIdentity(
      fileURLToPath(new URL("./desktop-main-webview-boundary.mjs", import.meta.url)),
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
const ownedSession = new OwnedNativeSession();
const nativeLock = await acquireNativeSessionLock({
  workspace: root,
  profile: selection.profile,
  scenarios: selection.selected_scenarios,
});
const harnessStarted = new Date();
async function stopDriver() {
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
    driver.exitCode === null
      ? observeNativeSession("StopDriver", snapshot)
      : { method: "observed-child-exit", exit_code: driver.exitCode };
  const exited = observeNativeSession("Wait", snapshot);
  ownedSession.cleanup = { stopped, exited, snapshot };
  driver = undefined;
}

function validateBackupFocusInventory(captured) {
  if (
    savedLibraryRecoverySession ||
    checks.some(
      (check) =>
        [
          "native-selected-setup-completion",
          "native-retained-contract-repair-state",
          "native-backup-delete-focus",
          "native-host-interrupted-preparation",
          "native-closed-preparation-recovery",
          "native-minimized-preparation-continuity",
          "native-normal-package-webview-boundary",
          "native-startup-library-recovery",
          "native-library-switch-recovery",
        ].includes(check.scenario) && check.outcome === "passed",
    )
  ) {
    assert.equal(
      captured.processes.filter(
        (entry) =>
          path.resolve(entry.path).toLowerCase() === path.resolve(values.app).toLowerCase(),
      ).length,
      1,
      "Successful native qualification requires one captured application",
    );
    assert.ok(
      captured.processes.some(
        (entry) => path.basename(entry.path).toLowerCase() === "msedgewebview2.exe",
      ),
      "Successful native qualification requires actual WebView identities",
    );
    assert.equal(
      captured.processes.filter(
        (entry) =>
          path.resolve(entry.path).toLowerCase() ===
          path.resolve(values["native-driver"]).toLowerCase(),
      ).length,
      1,
      "Successful native qualification requires the exact selected native driver identity",
    );
  }
}

function captureBackupFocusCleanup() {
  if (ownedSession.inventory) return ownedSession.inventory;
  assert.ok(
    ownedSession.driver && driver?.pid,
    "Missing initial owned driver identity; refuse unchecked cleanup",
  );
  const suffix =
    hostInterruptionSession || ordinaryCloseSession || savedLibraryRecoverySession
      ? `-${driver.pid}`
      : "";
  const original = path.join(output, `${cleanupName}-final-processes${suffix}.json`);
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
    checks.push({
      scenario: "native-backup-process-inventory",
      outcome: "failed",
      message: error.message,
    });
    process.exitCode = 1;
  }
  // Preserve the original snapshot; the existing Wait helper iterates processes.
  // Include the captured driver root in a separate, explicitly derived inventory
  // so positive exit shares the same five-second bound for root and descendants.
  const checked = path.join(output, `${cleanupName}-exit-inventory${suffix}.json`);
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
  const bundleWarningVisible = await browser.executeScript(() => {
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
  try {
    for (const theme of ["dark", "light"]) {
      await selectSettingsTheme(theme);
      for (const size of [
        { width: 960, height: 640 },
        { width: 1280, height: 800 },
      ]) {
        await setVerifiedWindowSize(size, "Settings");
        const rows = await browser.executeScript(() => {
          const rect = (element) => {
            const bounds = element.getBoundingClientRect();
            return {
              left: bounds.left,
              top: bounds.top,
              bottom: bounds.bottom,
              width: bounds.width,
              fits: element.scrollWidth <= element.clientWidth + 1,
            };
          };
          const groups = [
            "appearance",
            "library-storage",
            "game-files",
            "updates",
            "integrations",
            "advanced",
          ];
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
            bundlePathFits: (() => {
              const path = document.querySelector(
                '[data-settings-group="advanced"] .diagnostics-card code',
              );
              if (!(path instanceof HTMLElement)) throw new Error("Saved bundle path is missing");
              return path.scrollWidth <= path.clientWidth + 1;
            })(),
            recommendationFits: (() => {
              const label = document.querySelector(
                '[aria-label="Application update mode"] button small',
              );
              const button = label?.closest("button");
              if (!(label instanceof HTMLElement) || !(button instanceof HTMLElement))
                throw new Error("Recommended update-mode label is missing");
              return (
                label.getBoundingClientRect().bottom <= button.getBoundingClientRect().bottom - 2
              );
            })(),
          };
        });
        assertSettingsRowGeometry(rows, size);
        for (const group of [
          "appearance",
          "library-storage",
          "game-files",
          "updates",
          "integrations",
          "advanced",
        ]) {
          const section = await browser.findElement(By.css(`[data-settings-group="${group}"]`));
          await browser.executeScript(
            (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
            section,
          );
          await captureScenarioScreenshot(
            `settings-${group}-${theme}-${size.width}x${size.height}`,
          );
          if (group === "advanced" && size.width === 960) {
            await browser.executeScript(() =>
              document
                .querySelector('[data-settings-group="advanced"] .diagnostics-card code')
                ?.scrollIntoView({ block: "center", inline: "nearest" }),
            );
            await captureScenarioScreenshot(`settings-bundle-path-${theme}-960x640`);
          }
        }
      }
    }
  } finally {
    await browser.manage().window().setRect(originalWindow);
    await browser
      .findElement(
        By.xpath(
          '//*[@role="group" and @aria-label="Color theme"]//button[normalize-space(.)="System"]',
        ),
      )
      .click();
  }
}

function assertSettingsRowGeometry(rows, size) {
  const expectedRows = {
    appearance: 2,
    "library-storage": 2,
    "game-files": 3,
    updates: 2,
    integrations: 1,
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
      if (index > 0) assert.ok(group.rows[index - 1].bottom <= row.top, `${name} rows overlap`);
    }
    assert.ok(group.content.fits, `${name} content overflows horizontally`);
  }
  assert.ok(rows.viewportWidth <= size.width);
  assert.equal(rows.bundlePathFits, true, "saved bundle path is clipped");
  assert.equal(rows.recommendationFits, true, "recommended update mode label is clipped");
}

async function verifyLongTitleCatalogDetail(theme) {
  await browser.executeScript(() => {
    const card = [...document.querySelectorAll(".port-card-selectable")].find((item) =>
      item.textContent?.includes("Castlevania: Legacy of Darkness Recompiled"),
    );
    if (!(card instanceof HTMLElement)) throw new Error("Long-title catalog card is missing");
    card.scrollIntoView({ block: "center", inline: "nearest" });
    card.click();
  });
  await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 15_000);
  await browser.wait(
    () =>
      browser.executeScript(() => {
        const initials = document.querySelector(".detail-cover.artwork-image > span")?.textContent;
        return Boolean(initials && initials !== "PC");
      }),
    15_000,
    "Long-title cover fallback did not settle before visual capture",
  );
  for (const size of [
    { width: 960, height: 640 },
    { width: 1280, height: 800 },
  ]) {
    await setVerifiedWindowSize(size, "Long-title");
    const layout = await browser.executeScript(() => {
      const title = document.querySelector("#port-detail-title");
      const action = document.querySelector(
        '.detail-body .primary-actions button[data-variant="primary"]',
      );
      if (!(title instanceof HTMLElement) || !(action instanceof HTMLElement))
        throw new Error("Long-title detail title or primary action is missing");
      const bounds = action.getBoundingClientRect();
      const main = document.querySelector("main");
      return {
        title: title.textContent?.trim(),
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
    assert.equal(layout.title, "Castlevania: Legacy of Darkness Recompiled");
    assert.equal(layout.titleFits, true, JSON.stringify(layout));
    if (size.width === 960)
      assert.ok(layout.titleHeight > layout.lineHeight * 1.5, JSON.stringify(layout));
    assert.equal(layout.action.label, "Choose game files");
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

async function refreshSettings() {
  await browser.navigate().refresh();
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
}

// Includes owned native artwork picker/restart coverage in addition to lifecycle reviews.
const harnessDeadlineMs = desktopHarnessDeadlineMs(selection);
const deadline = setTimeout(async () => {
  try {
    await stopDriver();
  } catch (error) {
    checks.push({
      scenario: "native-backup-watchdog-cleanup",
      outcome: "failed",
      message: error.message,
    });
    process.exitCode = 1;
  }
}, harnessDeadlineMs);
deadline.unref();

async function requireUnusedPort(number) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: number, host: "127.0.0.1", exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const invoke = async (command, args = {}) =>
  JSON.parse(
    await browser.executeAsyncScript(
      (name, input, done) => {
        window.__TAURI_INTERNALS__.invoke(name, input).then(
          (value) => done(JSON.stringify({ ok: true, value })),
          (error) => done(JSON.stringify({ ok: false, error })),
        );
      },
      command,
      args,
    ),
  );

function scenarioTarget(name) {
  if (selection.selected_scenarios.includes(name)) return { records: checks, setup: false };
  if (selection.setup_scenarios.includes(name)) return { records: setupChecks, setup: true };
  return null;
}

function failedScenarioDependency(name) {
  const dependencies = desktopScenarioById.get(name)?.dependencies ?? [];
  return dependencies.find((dependency) => scenarioOutcomes.get(dependency) !== "passed");
}

function recordScenario(target, name, outcome, details = {}) {
  target.records.push({ scenario: name, outcome, ...details });
  scenarioOutcomes.set(name, outcome);
}

async function captureScenarioDiagnostics(name, setup) {
  if (!browser) return;
  const report = path.join(output, `${setup ? "setup-" : ""}${name}-diagnostics.json`);
  try {
    const details = await browser.executeScript(() =>
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

async function captureScenarioScreenshot(name, required = false) {
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

async function selectSettingsTheme(theme) {
  await browser
    .findElement(
      By.xpath(
        `//*[@role="group" and @aria-label="Color theme"]//button[normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
      ),
    )
    .click();
  await browser.wait(
    async () =>
      (await browser.executeScript(() => document.documentElement.dataset.theme)) === theme,
    5_000,
  );
}

async function setVerifiedWindowSize(size, context) {
  await browser.manage().window().setRect(size);
  const actual = await browser.manage().window().getRect();
  assert.deepEqual(
    { width: actual.width, height: actual.height },
    size,
    `${context} window was clamped: ${JSON.stringify(actual)}`,
  );
}

async function captureApplicationUpdateSettingsComparison() {
  const originalWindow = await browser.manage().window().getRect();
  try {
    for (const theme of ["dark", "light"]) {
      await selectSettingsTheme(theme);
      for (const size of [
        { width: 960, height: 640 },
        { width: 1280, height: 800 },
      ]) {
        await setVerifiedWindowSize(size, "Application update settings");
        const geometry = await browser.executeScript(() => {
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

async function captureOutputDestinationReview(name) {
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
  const outputLayout = await browser.executeScript(() => {
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
    await browser.executeScript((review) => {
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
    }, outputReview),
    true,
  );
  await captureScenarioScreenshot(`${name}-output-destination-review`, true);
  await browser.findElement(By.xpath('//button[normalize-space(.)="Cancel review"]')).click();
  await browser.wait(
    async () =>
      (await browser.executeScript(() => document.activeElement?.textContent?.trim())) ===
      "Review future folder",
    5_000,
  );
}

async function scenario(name, action) {
  const target = scenarioTarget(name);
  if (!target) return;
  const failedDependency = failedScenarioDependency(name);
  if (failedDependency) {
    recordScenario(target, name, "not-run", {
      reason: `Prerequisite ${failedDependency} did not pass`,
    });
    return;
  }
  try {
    await action();
    recordScenario(target, name, "passed");
  } catch (error) {
    recordScenario(target, name, "failed", { message: error.message });
    await captureScenarioDiagnostics(name, target.setup);
    process.exitCode = 1;
    if (isUntrustworthyProbeError(error)) throw error;
  }
  if (!target.setup) await captureScenarioScreenshot(name);
}

async function connectObservedDriver() {
  const finishObservation =
    process.platform === "win32"
      ? await observeStartup({
          driver,
          driverPath: values.driver,
          profile,
          output,
          attempt: startupAttempt++,
        })
      : null;
  try {
    browser = await new Builder()
      .disableEnvironmentOverrides()
      .usingServer(`http://127.0.0.1:${port}`)
      .withCapabilities({
        browserName: process.platform === "win32" ? "webview2" : "wry",
        "tauri:options": {
          application: values.app,
          ...(process.platform === "win32" ? { webviewOptions: { userDataFolder: profile } } : {}),
        },
      })
      .build();
  } finally {
    if (finishObservation) {
      const observation = await finishObservation();
      artifacts.push(...observation.artifacts);
      setupChecks.push({
        scenario: "session-startup-observation",
        outcome: observation.successful ? "passed" : "failed",
      });
      if (!observation.successful) process.exitCode = 1;
    }
  }
}

async function connect() {
  await connectObservedDriver();
  await browser.manage().setTimeouts({ script: 15_000 });
  const initialRecovery =
    (bootstrapRecoverySession || preferencesRecoverySession) && connectedLaunches === 0;
  const readyRoot = initialRecovery
    ? ".bootstrap-error"
    : selection.prerequisites.includes("design-compatibility-fixture")
      ? ".design-compatibility-fixture"
      : 'nav[aria-label="Primary navigation"]';
  await browser.wait(until.elementLocated(By.css(readyRoot)), 30_000);
  await browser.wait(
    async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
    30_000,
  );
  connectedLaunches++;
}

async function requestApplicationShutdown(snapshot) {
  await browser.quit();
  browser = undefined;
  const driverStop =
    process.platform === "win32" ? observeNativeSession("StopDriver", snapshot) : undefined;
  driver = undefined;
  return driverStop;
}

async function restartApplication(name, prepareWhileStopped, childEnvironment = {}) {
  if (savedLibraryRecoverySession) {
    if (!preferencesRecoverySession)
      assert.equal(
        prepareWhileStopped,
        undefined,
        "Library recovery restart cannot rewrite fixture state",
      );
    const inventory = captureBackupFocusCleanup();
    validateBackupFocusInventory(JSON.parse(await readFile(inventory, "utf8")));
    await browser.quit();
    browser = undefined;
    stopBackupFocusDriver();
    const cleanup = ownedSession.requireQuiescence();
    const restartEvidence = path.join(output, `${name}-restart.json`);
    await writeFile(restartEvidence, `${JSON.stringify(cleanup, null, 2)}\n`, { flag: "wx" });
    artifacts.push(restartEvidence);
    if (prepareWhileStopped) await prepareWhileStopped();
    await startDriver(childEnvironment);
    await connect();
    return browser;
  }
  const snapshot = path.join(output, `${name}-processes.json`);
  const restartEvidence = path.join(output, `${name}-restart.json`);
  const observation = {
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
  return browser;
}

// Interrupt only this harness's positively identified tree, without first
// deleting its WebDriver session or requesting graceful application shutdown.
function captureLivePreparation(preparationExecutable) {
  assert.ok(minimizedPreparationSession && ownedSession.driver && driver?.pid);
  const snapshot = path.join(output, "minimized-preparation-live-processes.json");
  const captured = observeNativeSession("Snapshot", snapshot);
  assert.deepEqual(captured.driver, ownedSession.driver);
  for (const expected of [values.app, preparationExecutable]) {
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

async function interruptApplication(name, preparationExecutable, assertStillPreparing) {
  assert.equal(process.platform, "win32", "Live host interruption is Windows qualification");
  const inventory = captureBackupFocusCleanup();
  const captured = JSON.parse(await readFile(inventory, "utf8"));
  const matches = (expected) =>
    captured.processes.filter(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(expected).toLowerCase(),
    );
  assert.equal(matches(values.app).length, 1, "Capture the live owned application");
  assert.equal(matches(preparationExecutable).length, 1, "Capture the live preparation child");
  await assertStillPreparing();
  const startedAt = new Date().toISOString();
  stopBackupFocusDriver();
  const observation = {
    started_at: startedAt,
    shutdown_request: "forced-owned-tree-termination-without-session-delete",
    driver_stop: ownedSession.cleanup.stopped,
    shutdown: ownedSession.cleanup.exited,
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
  return browser;
}

async function closeApplication(name, preparationExecutable, assertStillPreparing) {
  assert.ok(ordinaryCloseSession && process.platform === "win32");
  captureBackupFocusCleanup();
  const inventory = path.join(output, `${name}-live-processes.json`);
  const captured = observeNativeSession("Snapshot", inventory);
  artifacts.push(inventory);
  assert.deepEqual(captured.driver, ownedSession.driver);
  const matches = (expected) =>
    captured.processes.filter(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(expected).toLowerCase(),
    );
  assert.equal(matches(values.app).length, 1);
  assert.equal(matches(preparationExecutable).length, 1);
  const application = matches(values.app)[0];
  assert.equal(application.pid, captured.application_pid);
  await assertStillPreparing();
  const appInventory = path.join(output, `${name}-application-exit-inventory.json`);
  await writeFile(
    appInventory,
    JSON.stringify(
      {
        ...captured,
        source_snapshot: path.basename(inventory),
        derivation: "captured-application-only-natural-exit-observation",
        processes: [application],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  artifacts.push(appInventory);
  const observation = { started_at: new Date().toISOString() };
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
  return browser;
}

function observeNativeSession(mode, snapshot) {
  const driverProcessId = mode === "Wait" ? 0 : driver.pid;
  const result = spawnCommand(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      fileURLToPath(new URL("./native-session.ps1", import.meta.url)),
      "-Mode",
      mode,
      "-DriverProcessId",
      String(driverProcessId),
      "-ApplicationPath",
      values.app,
      "-SnapshotPath",
      snapshot,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function captureBackupFocusDriverLaunch(launchStarted) {
  const suffix =
    hostInterruptionSession || ordinaryCloseSession || savedLibraryRecoverySession
      ? `-${driver.pid}`
      : "";
  const snapshot = path.join(output, `${cleanupName}-driver-startup${suffix}.json`);
  const captured = observeNativeSession("SnapshotDriver", snapshot);
  artifacts.push(snapshot);
  assert.equal(captured.driver.pid, driver.pid);
  assert.equal(
    path.resolve(captured.driver.path).toLowerCase(),
    path.resolve(values.driver).toLowerCase(),
  );
  const created = Number(BigInt(captured.driver.started_filetime) / 10_000n) - 11_644_473_600_000;
  assert.ok(
    created >= launchStarted - 1 && created <= Date.now(),
    "Driver creation must belong to this launch",
  );
  ownedSession.driver = captured.driver;
}

async function driverReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    // Driver startup remains bounded by the loop and connection timeout.
    return false;
  }
}

function driverEnvironment(childEnvironment) {
  const environment = {
    ...process.env,
    ...childEnvironment,
    ...(installFixture ? { PORTCOVE_QUALIFICATION_CATALOG: installFixture.catalogPath } : {}),
    ...(externalFixture ? { PORTCOVE_QUALIFICATION_CATALOG: externalFixture.catalogPath } : {}),
    ...(selection.prerequisites.includes("steam-fixture")
      ? { PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE: "closed" }
      : {}),
    PORTCOVE_LIBRARY: library,
    PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
    PORTCOVE_APPLICATION_UPDATE_PREFERENCES: path.join(output, "application-updates.json"),
    PORTCOVE_APPLICATION_UPDATE_SCHEDULE: path.join(output, "application-update-schedule.json"),
    PORTCOVE_APPLICATION_UPDATE_STAGING: path.join(output, "application-update-state"),
    WEBVIEW2_USER_DATA_FOLDER: profile,
  };
  return savedLibraryRecoverySession ? bootstrapRecoveryEnvironment(environment) : environment;
}

async function startDriver(childEnvironment = {}) {
  ownedSession.beginLaunch();
  const launchStarted = Date.now();
  driver = spawn(
    values.driver,
    [
      "--port",
      String(port),
      "--native-port",
      String(port + 1),
      "--native-driver",
      values["native-driver"],
    ],
    {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: driverEnvironment(childEnvironment),
    },
  );
  let spawnError;
  driver.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [driver.stdout, driver.stderr])
    stream.on("data", (chunk) => {
      driverLog = (driverLog + chunk).slice(-1024 * 1024);
    });
  await captureSelectedDriverLaunch(launchStarted);
  if (historySession) historyInventory = await captureHistoryDriver(driver.pid, values.driver);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited: ${driver.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await driverReady()) return;
  }
  throw new Error("tauri-driver did not become ready within ten seconds");
}

async function captureSelectedDriverLaunch(launchStarted) {
  if (!identityBoundSession) return;
  await new Promise((resolve, reject) => {
    driver.once("spawn", resolve);
    driver.once("error", reject);
  });
  captureBackupFocusDriverLaunch(launchStarted);
}

async function verifyCompactSettingsJumps() {
  const index = await browser.findElement(By.css('[role="group"][aria-label="Settings sections"]'));
  assert.equal((await index.findElements(By.css('button[data-slot="button"]'))).length, 6);
  await browser.executeScript((element) => element.scrollIntoView({ block: "start" }), index);
  await captureScenarioScreenshot("settings-section-index-compact");
  await index.findElement(By.xpath('.//button[normalize-space(.)="Game files"]')).click();
  const jump = await browser.executeScript(() => {
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
  assert.equal(jump.tabIndex, 0);
  assert.equal(jump.outlineStyle, "solid");
  assert.ok(jump.top >= 0 && jump.bottom <= 640);
  await captureScenarioScreenshot("settings-section-jump-game-files");
  await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
  assert.equal(
    await browser.executeScript(() =>
      document.activeElement?.closest("[data-settings-group]")?.getAttribute("data-settings-group"),
    ),
    "game-files",
  );
  assert.equal(
    await browser.executeScript(
      () => document.getElementById("settings-game-files-heading")?.tabIndex,
    ),
    -1,
  );

  const diagnosticCopy = await browser.executeScript(() => {
    const paragraph = document.querySelector(".diagnostics-card > p:not(.eyebrow):not([role])");
    if (!(paragraph instanceof HTMLElement)) throw new Error("Diagnostics explanation is missing");
    const original = paragraph.textContent;
    paragraph.textContent = `${original} `.repeat(8);
    return original;
  });
  try {
    await browser.executeScript((element) => element.scrollIntoView({ block: "start" }), index);
    await index.findElement(By.xpath('.//button[normalize-space(.)="Advanced"]')).click();
    const focus = await browser.executeScript(() => {
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
      await browser.executeScript(() =>
        document.activeElement
          ?.closest("[data-settings-group]")
          ?.getAttribute("data-settings-group"),
      ),
      "advanced",
    );
    assert.equal(
      await browser.executeScript(
        () => document.getElementById("settings-advanced-heading")?.tabIndex,
      ),
      -1,
    );
    const next = await browser.executeScript(() => {
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
    assert.ok(next.top >= 0 && next.bottom <= 640, JSON.stringify(next));
    await captureScenarioScreenshot("settings-section-advanced-next-control");
  } finally {
    await browser.executeScript((copy) => {
      const paragraph = document.querySelector(".diagnostics-card > p:not(.eyebrow):not([role])");
      if (paragraph) paragraph.textContent = copy;
    }, diagnosticCopy);
  }
  const about = await browser.findElement(By.css(".about-card"));
  const aboutLayout = await browser.executeScript((element) => {
    element.scrollIntoView({ block: "start" });
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, about);
  assert.equal(aboutLayout.overflow, false);
  assert.ok(
    aboutLayout.left >= 0 && aboutLayout.right <= aboutLayout.viewportWidth,
    JSON.stringify(aboutLayout),
  );
  await captureScenarioScreenshot("settings-about-card-compact", true);
}

async function verifySettingsIndexTheme(theme) {
  const index = await browser.findElement(By.css('[role="group"][aria-label="Settings sections"]'));
  const geometry = await browser.executeScript((element) => {
    element.scrollIntoView({ block: "start" });
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, index);
  assert.equal(geometry.documentOverflow, false);
  assert.ok(geometry.left >= 0 && geometry.right <= 960);
  assert.ok(geometry.bottom <= 640);
  await captureScenarioScreenshot(`settings-section-index-${theme}`);
}

try {
  let preferencesRecoveryFixture;
  if (preferencesRecoverySession) {
    preferencesRecoveryFixture = await preparePreferencesRecoveryFixture(output);
    for (const name of ["preferencesBefore", "markerBefore"]) {
      inputs.push(await fileIdentity(preferencesRecoveryFixture[name]));
      artifacts.push(preferencesRecoveryFixture[name]);
    }
  }
  let librarySwitchRecoveryFixture;
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
    for (const name of ["invalidBefore", "preferencesBefore"])
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
      completionJourney: executionPlan.fixtures.completionJourney,
      holdFirstDownload: executionPlan.fixtures.holdFirstDownload,
      preparationTool: values["preparation-tool"],
    });
    if (installFixture.sourceJourney) {
      for (const name of ["gameBefore", "gameReplacement", "biosBefore"])
        inputs.push(await fileIdentity(installFixture.sourceJourney[name]));
      installFixture.sourceJourney.root = seedSelectedSetup({
        cli: values["preparation-cli"],
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
    const declared = JSON.parse(await readFile(externalFixture.catalogPath, "utf8")).ports[0];
    assert.equal(declared.id, externalFixture.port.id);
    const prepared = declared.release.user_prepared["windows-x86-64"];
    const immutableFiles = new Map(
      await Promise.all(
        externalFixture.identities
          .filter((identity) => !prepared.mutable_paths.includes(path.basename(identity.path)))
          .map(async (identity) => [path.basename(identity.path), await readFile(identity.path)]),
      ),
    );
    assert.equal(
      externalFixtureTreeDigest(immutableFiles),
      prepared.immutable_tree_sha256,
      "Actual prepared fixture bytes must match the declared immutable tree before launch",
    );
    for (const name of [
      "desktop-external-runtime-test.mjs",
      "desktop-native-confirmation.mjs",
      "native-confirmation.ps1",
    ])
      inputs.push(await fileIdentity(fileURLToPath(new URL(`./${name}`, import.meta.url))));
    inputs.push(await fileIdentity(externalFixture.catalogPath), ...externalFixture.identities);
  }
  await requireUnusedPort(port);
  await requireUnusedPort(port + 1);
  await startDriver();
  await connect();
  if (historySession) {
    historyInventory = await captureHistorySession(driver.pid, values.driver, values.app);
    const record = path.join(output, "qualification-history-process-identities.json");
    await writeFile(record, JSON.stringify(historyInventory, null, 2), { flag: "wx" });
    artifacts.push(record);
  }
  await scenario("native-external-runtime-review", async () => {
    const pickerContext = {
      application: values.app,
      getDriverIdentity: () => ownedSession.driver,
      output,
      artifacts,
    };
    await externalRuntimeReviewScenario({
      browser,
      By,
      until,
      fixture: externalFixture,
      output,
      artifacts,
      invoke,
      confirmNative: nativeConfirmation({
        application: values.app,
        getDriverPid: () => driver.pid,
        output,
        artifacts,
      }),
      pickerObservation: externalRuntimePickerObservation({
        browser,
        By,
        Key,
        until,
        fixture: externalFixture,
        observePicker: nativePickerObservation(pickerContext),
      }),
      selectPicker: nativePreparedRuntimePicker(pickerContext),
    });
  });
  await scenario("native-startup-preferences-recovery", async () => {
    await preferencesRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: preferencesRecoveryFixture,
      captureScreenshot: captureScenarioScreenshot,
      captureAccessibilityReport,
      restart: restartApplication,
      output,
      artifacts,
    });
  });
  await scenario("native-library-switch-recovery", async () => {
    await librarySwitchRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: librarySwitchRecoveryFixture,
      chooseOwnedLibrary: nativeConfirmation({
        application: values.app,
        getDriverPid: () => driver.pid,
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
    const chooseOwnedLibrary = nativeConfirmation({
      application: values.app,
      getDriverPid: () => driver.pid,
      output,
      artifacts,
    });
    await bootstrapRecoveryScenario({
      browser,
      invoke,
      By,
      until,
      fixture: bootstrapRecoveryFixture,
      chooseOwnedLibrary,
      captureScreenshot: captureScenarioScreenshot,
      restart: restartApplication,
      output,
      artifacts,
    });
  });
  await scenario("native-normal-package-webview-boundary", async () => {
    const requests = await normalPackageBoundaryScenario({
      browser,
      invoke,
      library,
      output,
      artifacts,
      packageEvidence,
    });
    assertOwnedBoundaryRequests(requests);
  });
  await scenario("empty-library", async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    assert.equal(path.resolve(bootstrap.value.library_root), library);
    const status = await invoke("get_statuses");
    assert.equal(status.ok, true);
    assert.equal(status.value.filter((item) => item.active).length, 0);
    const firstCatalog = await browser.wait(
      until.elementLocated(By.xpath('//h1[normalize-space(.)="Port catalog"]')),
      15_000,
    );
    assert.equal(await firstCatalog.isDisplayed(), true);
    assert.ok((await browser.findElements(By.css("button.port-card-selectable"))).length > 0);
    await captureScenarioScreenshot("first-use-port-catalog");
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const browse = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Browse port catalog"]')),
      15_000,
    );
    assert.equal(await browse.getAttribute("data-slot"), "button");
    assert.equal(await browse.getAttribute("data-variant"), "primary");
    assert.match(
      await browser.findElement(By.css(".empty-state")).getText(),
      /Your library is empty[\s\S]*use an existing installation/,
    );
    await captureScenarioScreenshot("empty-library-shared-controls");
    const updateChoice = await browser.wait(
      until.elementLocated(By.css(".application-update-consent-notice")),
      15_000,
    );
    assert.equal(await updateChoice.isDisplayed(), true);
    await browser.manage().window().setRect({ width: 960, height: 640 });
    const firstUseAction = await browser.executeScript((button) => {
      const bounds = button.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight };
    }, browse);
    await captureScenarioScreenshot("empty-library-compact-first-use", true);
    assert.ok(
      firstUseAction.top >= 0 && firstUseAction.bottom <= firstUseAction.viewportHeight,
      `Browse port catalog must be visible without scrolling: ${JSON.stringify(firstUseAction)}`,
    );
    await browser.manage().window().setRect({ width: 1280, height: 800 });
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys("unmatched title");
    const clearSearch = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Clear search and filters"]')),
      5000,
    );
    assert.match(
      await browser.findElement(By.css(".empty-state")).getText(),
      /This library has no ports yet/,
    );
    await captureScenarioScreenshot("filtered-empty-new-library");
    await clearSearch.click();
    assert.equal(await search.getAttribute("value"), "");
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Browse port catalog"]')),
      5000,
    );
    assert.equal((await browser.findElements(By.css(".filter-row"))).length, 0);
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Connect game-file folder"]'))
      .click();
    await browser.wait(
      until.elementLocated(By.xpath('//h2[normalize-space(.)="Game files"]')),
      5000,
    );
    await browser.wait(
      async () =>
        browser.executeScript(() =>
          document.activeElement?.matches('[data-settings-control="add-game-file-root"]'),
        ),
      10_000,
    );
    await captureScenarioScreenshot("empty-library-connect-game-files");
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
  });
  await scenario("native-design-system-compatibility", async () => {
    const environment = await assertDesignCompatibility({ browser, By, Key, until });
    const environmentArtifact = path.join(output, "design-compatibility-environment.json");
    await writeFile(environmentArtifact, JSON.stringify(environment, null, 2), { flag: "wx" });
    artifacts.push(environmentArtifact);
  });
  await scenario("native-error-recovery", async () => {
    const failed = await invoke("verify_port", {
      portId: "nonexistent-fixture-port",
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.error.code);
    assert.equal((await invoke("get_bootstrap_status")).value.ready, true);
  });
  await scenario("native-startup-network-diagnostic", async () => {
    inputs.push(
      await fileIdentity(
        fileURLToPath(new URL("./desktop-startup-network-diagnostic.mjs", import.meta.url)),
      ),
    );
    const observation = await observeStartupNetwork({
      invoke,
      readAlerts: () =>
        browser.executeScript(() => document.querySelectorAll(".error-banner").length),
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
    const before = await invoke("get_bootstrap_status");
    assert.equal(before.ok, true);
    const defaultRoot = await invoke("get_default_library_root");
    assert.equal(defaultRoot.ok, true);
    assert.ok(defaultRoot.value);
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
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
      (await invoke("get_bootstrap_status")).value.library_root,
      before.value.library_root,
    );
    await assertCompactReview(browser, '[aria-labelledby="library-selection-review-title"]');
    const accessibility = path.join(output, "library-selection-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    const screenshot = path.join(output, "native-library-selection-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
    await browser.wait(
      () => browser.executeScript("return document.activeElement === arguments[0];", trigger),
      5_000,
      "Library selection review trigger did not regain focus after Escape",
    );
    assert.deepEqual((await invoke("get_bootstrap_status")).value, before.value);
  });
  await scenario("native-library-browsing-context", async () => {
    const chooseOwnedLibrary = nativeConfirmation({
      application: values.app,
      getDriverPid: () => driver.pid,
      output,
      artifacts,
    });
    const original = (await invoke("get_bootstrap_status")).value;
    assert.equal(path.resolve(original.library_root), library);
    const alternate = path.join(output, "browsing-alternate-library");
    await mkdir(alternate);
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    let search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    const catalog = await invoke("get_catalog");
    assert.equal(catalog.ok, true);
    const channelButton = (channel) =>
      browser.findElement(
        By.xpath(
          `//div[@aria-label="Release channel filters"]//button[normalize-space(.)="${channel}"]`,
        ),
      );
    const expectChannels = async (channels) => {
      const expected = catalog.value.ports
        .filter(
          (port) =>
            channels.length === 0 || port.channels.some((channel) => channels.includes(channel)),
        )
        .map((port) => port.id)
        .sort();
      assert.ok(expected.length > 0, "Channel fixture must contain matching ports");
      await browser.wait(
        async () => {
          const ids = await browser.executeScript(() =>
            [...document.querySelectorAll('[data-detail-origin^="catalog:card:"]')]
              .map((card) => card.getAttribute("data-detail-origin").slice("catalog:card:".length))
              .sort(),
          );
          return JSON.stringify(ids) === JSON.stringify(expected);
        },
        5_000,
        `Catalog did not display the exact ${channels.join("+") || "All"} union once`,
      );
      for (const channel of ["stable", "beta", "rolling"])
        assert.equal(
          await (await channelButton(channel)).getAttribute("aria-pressed"),
          String(channels.includes(channel)),
        );
    };
    await (await channelButton("stable")).click();
    await expectChannels(["stable"]);
    const beta = await browser.wait(
      until.elementLocated(
        By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="beta"]'),
      ),
      15_000,
    );
    await beta.click();
    await expectChannels(["stable", "beta"]);
    await (await channelButton("stable")).click();
    await expectChannels(["beta"]);
    await beta.click();
    await expectChannels([]);
    await (await channelButton("rolling")).click();
    await expectChannels(["rolling"]);
    await (await channelButton("All")).click();
    await expectChannels([]);
    await (await channelButton("stable")).click();
    await beta.click();
    await expectChannels(["stable", "beta"]);
    await search.sendKeys("zelda");
    await browser.wait(
      async () =>
        (await browser.findElements(By.css('[data-detail-origin^="catalog:card:"]'))).length > 0,
      5_000,
    );
    const sort = By.xpath('//button[@role="combobox"][contains(., "Sort")]');
    await browser.findElement(sort).click();
    await browser
      .wait(until.elementLocated(By.xpath('//*[@role="option"][contains(., "Name A–Z")]')), 5_000)
      .click();
    const card = await browser.findElement(By.css('[data-detail-origin^="catalog:card:"]'));
    await browser.executeScript("arguments[0].scrollIntoView({block:'center'});", card);
    const origin = await browser.executeScript(
      (card) => ({
        key: card.getAttribute("data-detail-origin"),
        scroll: document.querySelector("main").scrollTop,
      }),
      card,
    );
    await card.click();
    await browser.wait(until.elementLocated(By.css(".detail-back")), 15_000).click();
    await browser.wait(
      () =>
        browser.executeScript(
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
        (await browser.executeScript("return document.querySelector('main').scrollTop")) -
          origin.scroll,
      ) <= 1,
    );
    await captureScenarioScreenshot("native-catalog-composed-channels");
    await search.click();
    assert.equal(await browser.executeScript("return document.activeElement.id"), "port-search");
    await browser.actions().keyDown(Key.CONTROL).sendKeys("4").keyUp(Key.CONTROL).perform();
    await browser.wait(until.elementLocated(By.css(".diagnostics-card")), 15_000);
    const switchTo = async (target, artifactName, previousGeneration) => {
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
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
      assert.equal(path.resolve(picker.selected_directory), path.resolve(target));
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
            path.toNamespacedPath(status.value.library_root) === path.toNamespacedPath(target)
          )
            return "switched";
          const alerts = await browser.findElements(
            By.xpath('//article[.//h2[normalize-space(.)="Library at startup"]]//*[@role="alert"]'),
          );
          return alerts.length ? { error: await alerts[0].getText(), status } : false;
        },
        15_000,
        "Owned library switch did not advance bootstrap generation",
      );
      if (outcome !== "switched") {
        const diagnostic = { outcome };
        try {
          diagnostic.technical_text = await browser.executeScript(() => {
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
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const alternateSearch = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    assert.equal(await alternateSearch.getAttribute("value"), "");
    const alternateBeta = await browser.findElement(
      By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="beta"]'),
    );
    assert.equal(await alternateBeta.getAttribute("aria-pressed"), "false");
    assert.equal(await (await channelButton("stable")).getAttribute("aria-pressed"), "false");
    const alternateStatus = (await invoke("get_bootstrap_status")).value;
    await switchTo(library, "library-picker-select-original", alternateStatus.generation);
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const restoredSearch = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    assert.equal(await restoredSearch.getAttribute("value"), "zelda");
    const restoredBeta = await browser.findElement(
      By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="beta"]'),
    );
    assert.equal(await restoredBeta.getAttribute("aria-pressed"), "true");
    assert.equal(await (await channelButton("stable")).getAttribute("aria-pressed"), "true");
    assert.ok((await browser.findElement(sort).getText()).includes("Name A–Z"));
    assert.equal((await browser.findElements(By.css('[role="dialog"]'))).length, 0);
    await browser.wait(
      async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
      15_000,
      "Restored catalog did not finish loading",
    );
    await browser.wait(
      () => browser.executeScript("return document.activeElement.id === 'port-search'"),
      5_000,
      "Saved catalog focus did not return after library data loaded",
    );
    await browser.executeScript("arguments[0].scrollIntoView({block: 'center'});", restoredSearch);
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
    });
  }
  await scenario("keyboard-layout", async () => {
    const verifySidebarLabels = async () => {
      const labels = await browser.executeScript(() =>
        [...document.querySelectorAll(".sidebar nav .nav-item")].map((button) => {
          const label = button.querySelector("span:not(.icon)");
          if (!(button instanceof HTMLElement) || !(label instanceof HTMLElement))
            throw new Error("Primary navigation label is missing");
          return {
            text: label.textContent,
            widthFits: label.scrollWidth <= label.clientWidth + 1,
            heightFits: label.scrollHeight <= label.clientHeight + 1,
            buttonFits: button.scrollHeight <= button.clientHeight + 1,
          };
        }),
      );
      assert.deepEqual(
        labels.map((label) => label.text),
        ["Library", "Port catalog", "Game updates", "Settings"],
      );
      assert.ok(labels.every((label) => label.widthFits && label.heightFits && label.buttonFits));
    };
    await browser.manage().window().setRect({ width: 1280, height: 800 });
    await verifySidebarLabels();
    await captureScenarioScreenshot("sidebar-full-labels-default");
    await browser.manage().window().setRect({ width: 640, height: 640 });
    await verifySidebarLabels();
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.wait(until.elementLocated(By.css('[data-settings-group="appearance"]')), 15_000);
    const layout = await browser.executeScript(() => ({
      document_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      about_columns: (() => {
        const about = document.querySelector(".about-card");
        if (!(about instanceof HTMLElement)) throw new Error("About card is missing");
        return getComputedStyle(about).gridTemplateColumns.split(" ").length;
      })(),
      groups: [...document.querySelectorAll("[data-settings-group]")].map((group) => {
        const content = group.querySelector(".settings-section-content");
        if (!(content instanceof HTMLElement)) throw new Error("Settings group content is missing");
        return {
          name: group.getAttribute("data-settings-group"),
          columns: getComputedStyle(content).gridTemplateColumns.split(" ").length,
        };
      }),
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
    assert.deepEqual(layout.groups, [
      { name: "appearance", columns: 1 },
      { name: "library-storage", columns: 1 },
      { name: "game-files", columns: 1 },
      { name: "updates", columns: 1 },
      { name: "integrations", columns: 1 },
      { name: "advanced", columns: 1 },
    ]);
    assert.deepEqual(layout.overflowing_cards, []);
    assert.deepEqual(layout.legacy_buttons, []);
    assert.deepEqual(layout.legacy_shell_buttons, []);
    await verifyCompactSettingsJumps();

    let focusedSettingsControl = false;
    for (let step = 0; step < 30 && !focusedSettingsControl; step++) {
      await browser.actions().sendKeys(Key.TAB).perform();
      focusedSettingsControl = await browser.executeScript(() =>
        Boolean(document.activeElement?.closest("[data-settings-group]")),
      );
    }
    assert.equal(focusedSettingsControl, true);
    const focus = await browser.executeScript(() => {
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
    const about = await browser.findElement(By.css(".about-card"));
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
      about,
    );
    await captureScenarioScreenshot("settings-compact-layout");

    const gameUpdatesLink = await browser.findElement(
      By.xpath(
        '//*[@data-settings-group="updates"]//button[normalize-space(.)="Open Game updates"]',
      ),
    );
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "center" }),
      gameUpdatesLink,
    );
    await captureScenarioScreenshot("settings-game-update-destination-link");
    await gameUpdatesLink.click();
    await browser.wait(until.elementLocated(By.css(".update-center")), 15_000);
    assert.equal(await browser.findElement(By.css("main h1")).getText(), "Game updates & activity");
    assert.equal(
      await browser.executeScript(() => {
        const stat = [...document.querySelectorAll(".update-stat")].find(
          (candidate) => candidate.querySelector("span")?.textContent === "Updates available",
        );
        return stat?.querySelector("strong")?.textContent;
      }),
      "—",
      "An empty managed library must not report a completed zero-update check",
    );
    await browser.wait(
      () => browser.executeScript(() => document.activeElement?.matches("main h1")),
      5_000,
      "Game updates heading did not receive focus",
    );
    const applicationUpdatesLink = await browser.findElement(
      By.xpath('//button[normalize-space(.)="Open Portcove & catalog update settings"]'),
    );
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "center" }),
      applicationUpdatesLink,
    );
    await captureScenarioScreenshot("game-updates-settings-destination-link");
    await applicationUpdatesLink.click();
    const updateSettings = await browser.wait(
      until.elementLocated(By.css('[data-settings-group="updates"]')),
      15_000,
    );
    assert.ok((await updateSettings.getText()).includes("Portcove & catalog updates"));
    await browser.wait(
      () =>
        browser.executeScript(() =>
          document.activeElement?.matches('[data-settings-control="catalog-updates"]'),
        ),
      5_000,
      "Catalog update settings did not receive focus",
    );

    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    const selectedFilter = await browser.findElement(By.css('.filter-row [aria-pressed="true"]'));
    assert.equal(await selectedFilter.getAttribute("data-slot"), "button");
    assert.equal(await selectedFilter.getAttribute("data-variant"), "selected");
    await search.clear();
    const allChannels = await browser.findElement(
      By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="All"]'),
    );
    await allChannels.click();
    assert.equal(await allChannels.getAttribute("aria-pressed"), "true");
    await browser.findElement(By.id("port-search")).sendKeys("Ghostship");
    await browser.wait(
      () =>
        browser.executeScript(() =>
          [...document.querySelectorAll(".port-card")].some((card) =>
            card.textContent?.includes("Ghostship"),
          ),
        ),
      15_000,
    );
    const origin = await browser.executeScript(() => {
      const cards = [...document.querySelectorAll(".port-card")];
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
      await browser.executeScript(() => document.querySelector('.detail-panel[role="dialog"]')),
      null,
    );
    assert.equal(await browser.executeScript(() => document.querySelector("#port-search")), null);
    assert.equal(
      await browser.executeScript(() => document.querySelector("[data-detail-workspace] h1")?.id),
      "port-detail-title",
    );
    assert.equal(
      await browser.executeScript(() => document.activeElement?.classList.contains("detail-back")),
      true,
    );
    const verifyDetailActionHierarchy = async () => {
      const hierarchy = await browser.executeScript(() => {
        const hero = document.querySelector(".detail-hero");
        const title = document.querySelector(".detail-title");
        const reason = document.querySelector(".hero-reason");
        const requirement = document.querySelector(".hero-requirement");
        const action = document.querySelector(".primary-actions button");
        if (
          !(hero instanceof HTMLElement) ||
          !(title instanceof HTMLElement) ||
          !(reason instanceof HTMLElement) ||
          !(requirement instanceof HTMLElement) ||
          !(action instanceof HTMLElement)
        ) {
          throw new Error("Game detail hierarchy is incomplete");
        }
        const heroBounds = hero.getBoundingClientRect();
        const reasonBounds = reason.getBoundingClientRect();
        const requirementBounds = requirement.getBoundingClientRect();
        const actionBounds = action.getBoundingClientRect();
        const futureChoices = [...document.querySelectorAll(".future-setup-disclosure")];
        return {
          duplicateReadiness: document.querySelectorAll(".readiness-card").length,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          stateText: document.querySelector(".hero-state")?.textContent?.trim(),
          reasonText: reason.textContent?.trim(),
          requirementText: requirement.textContent?.trim(),
          actionText: action.textContent?.trim(),
          titleFits: title.scrollWidth <= title.clientWidth + 1,
          reasonFits: reason.scrollWidth <= reason.clientWidth + 1,
          requirementFits: requirement.scrollWidth <= requirement.clientWidth + 1,
          reasonInHero:
            reasonBounds.top >= heroBounds.top && reasonBounds.bottom <= heroBounds.bottom,
          requirementInHero:
            requirementBounds.top >= heroBounds.top &&
            requirementBounds.bottom <= heroBounds.bottom,
          requirementVisible: requirementBounds.bottom <= window.innerHeight,
          futureChoices: futureChoices.map((choice) => ({
            title: choice.querySelector("summary")?.textContent?.trim(),
            open: choice.hasAttribute("open"),
          })),
          actionGap: actionBounds.top - heroBounds.bottom,
          actionFits: actionBounds.left >= 0 && actionBounds.right <= window.innerWidth,
        };
      });
      assert.equal(hierarchy.duplicateReadiness, 0);
      assert.equal(hierarchy.horizontalOverflow, false);
      assert.equal(hierarchy.stateText, "Game files needed");
      assert.match(
        hierarchy.reasonText,
        /Choose the required game files before reviewing installation/u,
      );
      assert.equal(hierarchy.actionText, "Choose game files");
      assert.match(hierarchy.requirementText, /Required for setup: Super Mario 64 \(US\) source/u);
      assert.equal(hierarchy.titleFits, true);
      assert.equal(hierarchy.reasonFits, true);
      assert.equal(hierarchy.requirementFits, true);
      assert.equal(hierarchy.reasonInHero, true);
      assert.equal(hierarchy.requirementInHero, true);
      assert.equal(hierarchy.requirementVisible, true);
      assert.deepEqual(hierarchy.futureChoices, [
        { title: "Release and update choices for later", open: false },
        { title: "Folder for a future install", open: false },
      ]);
      assert.ok(hierarchy.actionGap >= 0 && hierarchy.actionGap < 160);
      assert.equal(hierarchy.actionFits, true);
    };
    await verifyDetailActionHierarchy();
    await captureScenarioScreenshot("game-details-workspace");
    await browser.manage().window().setRect({ width: 960, height: 640 });
    await verifyDetailActionHierarchy();
    await captureScenarioScreenshot("game-details-action-hierarchy");
    const updateChoices = await browser.findElement(By.css(".future-setup-disclosure > summary"));
    await updateChoices.click();
    assert.equal(
      await browser.executeScript(() =>
        document.querySelector(".future-setup-disclosure")?.hasAttribute("open"),
      ),
      true,
    );
    await updateChoices.sendKeys(Key.ENTER);
    assert.equal(
      await browser.executeScript(() =>
        document.querySelector(".future-setup-disclosure")?.hasAttribute("open"),
      ),
      false,
    );
    const outputChoices = (
      await browser.findElements(By.css(".future-setup-disclosure > summary"))
    )[1];
    assert.ok(outputChoices);
    await outputChoices.click();
    const outputDraft = await browser.wait(
      until.elementLocated(By.css('[id^="output-location-path-"]')),
      15_000,
    );
    await browser.wait(async () => await outputDraft.isEnabled(), 15_000);
    await captureOutputDestinationReview("game-details");
    const draftPath = "C:\\Portcove-fixture\\Future-install";
    await outputDraft.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, draftPath);
    const sourceDraft = await browser.findElement(
      By.css('.requirements-body input[id^="source-"]'),
    );
    await sourceDraft.sendKeys("C:\\Portcove-fixture\\candidate.z64");
    await browser.wait(
      async () =>
        (await browser.executeScript(() =>
          [...document.querySelectorAll(".future-setup-disclosure")].every(
            (choice) => !choice.classList.contains("is-deferred"),
          ),
        )) === true,
      5_000,
      "future setup choices did not expand after selecting game files",
    );
    assert.equal(await outputDraft.getAttribute("value"), draftPath);
    await sourceDraft.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
    await browser.wait(
      async () =>
        (await browser.executeScript(() =>
          [...document.querySelectorAll(".future-setup-disclosure")].every((choice) =>
            choice.classList.contains("is-deferred"),
          ),
        )) === true,
      5_000,
      "future setup choices did not defer after removing the selected path",
    );
    await outputChoices.click();
    assert.equal(await outputDraft.getAttribute("value"), draftPath);
    await captureScenarioScreenshot("game-details-future-output-draft");
    await outputChoices.click();
    await browser.manage().window().setRect({ width: 640, height: 640 });
    await browser.findElement(By.css(".detail-back")).click();
    await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await browser.wait(
      async () =>
        (await browser.executeScript(() =>
          document.activeElement?.getAttribute("data-detail-origin"),
        )) === origin.originKey,
      15_000,
    );
    const restored = await browser.executeScript(() => ({
      query: document.querySelector("#port-search")?.value,
      focus: document.activeElement?.getAttribute("data-detail-origin"),
      scrollTop: document.querySelector("main")?.scrollTop,
    }));
    assert.equal(restored.query, "Ghostship");
    assert.equal(restored.focus, origin.originKey);
    assert.ok(Math.abs(restored.scrollTop - origin.scrollTop) <= 1);
    await captureScenarioScreenshot("game-details-workspace-return");
    await browser
      .findElement(By.id("port-search"))
      .sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
    await browser.wait(
      async () => (await browser.findElements(By.css(".port-card"))).length > 2,
      15_000,
    );

    const compactWindow = await browser.manage().window().getRect();
    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await verifySidebarLabels();
      for (const theme of ["dark", "light"]) {
        await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
        await selectSettingsTheme(theme);
        await verifySettingsIndexTheme(theme);
        const gameFileCards = await browser.findElements(
          By.css('[data-settings-group="game-files"] article.source-health'),
        );
        assert.equal(gameFileCards.length, 2, "Game files settings cards are incomplete");
        const settingsCards = [
          { name: "saved-folders", card: gameFileCards[0], group: "game-files" },
          { name: "verification", card: gameFileCards[1], group: "game-files" },
          {
            name: "capacity",
            card: await browser.findElement(
              By.css('[data-settings-group="library-storage"] article.storage-card'),
            ),
            group: "storage",
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
            await browser.executeScript(
              (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
              card,
            );
            const overflow = await browser.executeScript(
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
        await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
        await browser.wait(
          async () => (await browser.findElements(By.css(".port-card"))).length > 2,
          15_000,
        );
        const descriptions = await browser.executeScript(() => {
          const cards = [...document.querySelectorAll(".port-card-selectable")].slice(0, 3);
          cards[0]?.scrollIntoView({ block: "center" });
          return {
            documentOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            items: cards.map((card) => {
              const description = card.querySelector(".card-content > p");
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
            ({ text, visible, clamp, cardOverflow }) =>
              text && visible && clamp === "2" && !cardOverflow,
          ),
        );
        await captureScenarioScreenshot(`catalog-short-window-${theme}`);

        const themedOrigin = await browser.executeScript(() => {
          const card = [...document.querySelectorAll(".port-card")].find((item) =>
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
            await browser.executeScript(() => document.documentElement.dataset.theme),
            theme,
          );
          await verifyDetailActionHierarchy();
          await captureScenarioScreenshot(
            `game-details-missing-source-${theme}-${size.width}`,
            true,
          );
          const folderChoices = (
            await browser.findElements(By.css(".future-setup-disclosure > summary"))
          )[1];
          assert.ok(folderChoices);
          await folderChoices.click();
          await captureOutputDestinationReview(`game-details-${theme}-${size.width}`);
          await folderChoices.click();
        }
        await browser.findElement(By.css(".detail-back")).click();
        await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await browser.wait(
          async () =>
            (await browser.executeScript(() =>
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
    const before = await invoke("get_application_update_preferences");
    assert.equal(before.ok, true);
    assert.equal(before.value.choice, null);
    const initialStatus = await invoke("get_application_update_status");
    assert.equal(initialStatus.ok, true);
    assert.equal(initialStatus.value.staged, null);
    assert.deepEqual(initialStatus.value.recovery_required, []);
    const activities = await invoke("get_activities");
    assert.equal(activities.ok, true);

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
          await browser.executeScript(
            () =>
              document.activeElement?.closest(".application-update-settings") !== null &&
              document.activeElement?.textContent?.trim() === "Preview",
          ),
        15_000,
      );
    } catch (error) {
      const focus = await browser.executeScript(() => ({
        active: document.activeElement?.outerHTML,
        firstControl: document.querySelector(".application-update-settings button:not(:disabled)")
          ?.outerHTML,
      }));
      throw new Error(`Review options focus: ${JSON.stringify(focus)}`, { cause: error });
    }
    await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
    await browser.wait(
      async () =>
        await browser.executeScript(
          () =>
            document.activeElement?.closest(".application-update-settings") !== null &&
            document.activeElement?.textContent?.trim() !== "Preview",
        ),
      5_000,
      "Directional navigation left application update settings",
    );
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Application update channel"]')),
      15_000,
    );
    assert.deepEqual(
      await browser.executeScript(() =>
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
    await browser.findElement(By.id("pause-application-updates")).click();

    assert.equal(
      (await invoke("get_application_update_preferences")).value.choice,
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
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(
      until.elementLocated(
        By.xpath(
          '//p[@role="status" and contains(., "Saving these settings does not start an update.")]',
        ),
      ),
      15_000,
    );

    await refreshSettings();
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
    assert.equal(await browser.findElement(By.id("pause-application-updates")).isSelected(), true);

    await captureApplicationUpdateSettingsComparison();

    await writeFile(path.join(output, "application-update-schedule.json"), "not-json\n", {
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
      (await invoke("get_application_update_status")).value.recovery_required[0].area,
      "schedule",
    );
    await browser.executeScript(() =>
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
    assert.deepEqual((await invoke("get_activities")).value, activities.value);

    await writeFile(path.join(output, "application-updates.json"), "not-json\n");
    await refreshSettings();
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
      async () => (await browser.executeScript(() => document.activeElement?.tagName)) !== "BODY",
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
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(
      () =>
        browser.executeScript(() => {
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
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.findElement(By.xpath('//button[normalize-space(.)="Light"]')).click();
    assert.equal(
      await browser.executeScript(() => document.documentElement.dataset.theme),
      "light",
    );
    const observations = [];
    try {
      for (let cycle = 0; cycle < restartCycles; cycle++) {
        const observation = {
          cycle: cycle + 1,
          close_started: new Date().toISOString(),
          shutdown_request: "identity-bound-isolated-driver-tree-termination",
        };
        observations.push(observation);
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
        observation.connected = new Date().toISOString();
        assert.equal(
          await browser.executeScript(() => document.documentElement.dataset.theme),
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
    const reset = await invoke("set_locale_preference", { locale: "en" });
    assert.equal(reset.ok, true);
    await refreshSettings();
    const languageTrigger = await browser.wait(
      until.elementLocated(By.xpath('//button[contains(., "Display language")]')),
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
      async () => (await invoke("get_locale_preference")).value.locale === null,
      15_000,
    );
    assert.ok(
      (await browser.findElement(By.css(".language-card")).getText()).includes(
        "Current language: English.",
      ),
    );

    const engineering = await invoke("set_locale_preference", { locale: "ar-XB" });
    assert.equal(engineering.ok, true);
    await refreshSettings();
    await browser.wait(async () => {
      const state = await browser.executeScript(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        heading: [...document.querySelectorAll("h2")].some(
          (element) => element.textContent?.trim() === "لغة الواجهة",
        ),
        preview: document
          .querySelector('.language-card [role="note"]')
          ?.textContent?.includes("معاينة اللغة"),
      }));
      return state.lang === "ar-XB" && state.dir === "rtl" && state.heading && state.preview;
    }, 15_000);
    const rendered = await browser.executeScript(() => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      heading: [...document.querySelectorAll("h2")].some(
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
    assert.deepEqual((await invoke("get_locale_preference")).value, { locale: "ar-XB" });
    await captureScenarioScreenshot("native-localization-rtl");
    await browser.navigate().refresh();
    await browser.wait(
      async () =>
        (await browser.executeScript(() => document.documentElement.lang === "ar-XB")) === true,
      15_000,
      "saved locale did not survive renderer reload",
    );
    assert.equal(await browser.executeScript(() => document.documentElement.dir), "rtl");
    const accessibility = path.join(output, "native-localization-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);

    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    const rtlTrigger = await browser.wait(
      until.elementLocated(By.css(".language-card button")),
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
        (await browser.executeScript(
          () => document.documentElement.lang === "en" && document.documentElement.dir === "ltr",
        )) === true,
      15_000,
      "switching away from the preview did not resolve English",
    );
    const focusAfterSwitch = await browser.executeScript(() => ({
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
    assert.deepEqual((await invoke("get_locale_preference")).value, { locale: "en" });

    const preferencePath = path.join(output, "preferences.json");
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
      assert.equal(await browser.executeScript(() => document.documentElement.lang), "en");
    } finally {
      await writeFile(preferencePath, savedPreferences);
    }
    assert.deepEqual((await invoke("get_locale_preference")).value, { locale: "en" });
    await invoke("set_locale_preference", { locale: null });
  });
  await scenario("accessibility", async () => {
    const report = path.join(output, "accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
  });
  await controllerScenario({ browser, scenario, output, artifacts });
  await accessibleNavigationScenario({ browser, scenario, output, artifacts });
  await workspaceRefreshScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    cli: values["preparation-cli"],
    tool: values["preparation-tool"],
  });
  await qualificationHistoryScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    captureScreenshot: captureScenarioScreenshot,
  });
  await runOwnedFixtureJourneys(
    {
      plan: executionPlan,
      runtime: {
        context: () => ({
          browser,
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
        }),
        confirmNative: () =>
          nativeConfirmation({
            application: values.app,
            getDriverPid: () => driver.pid,
            output,
            artifacts,
          }),
        recordKnownGap: (gap) =>
          checks.push({ scenario: gap.scenario, outcome: "not-run", reason: gap.reason }),
      },
    },
    {
      install: installScenarios,
      selectedSetup: selectedSetupScenario,
      selectedSetupCompletion: selectedSetupCompletionScenario,
      preparation: preparationScenarios,
    },
  );
  if (selection.selected_scenarios.includes("native-repeated-library-reload"))
    await reloadScenario({
      browser,
      scenario,
      output,
      artifacts,
      cycles: reloadCycles,
    });
} catch (error) {
  checks.push({
    scenario: "harness",
    outcome: "failed",
    message: error.message,
  });
  if (browser) {
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
    if (identityBoundSession) {
      try {
        if (driver?.pid && !ownedSession.cleanup) captureBackupFocusCleanup();
        let quitError;
        if (browser)
          await browser.quit().catch((error) => {
            quitError = error;
          });
        browser = undefined;
        await stopDriver();
        ownedSession.requireQuiescence();
        const report = path.join(output, `${cleanupName}-cleanup.json`);
        await writeFile(
          report,
          JSON.stringify(
            { ...ownedSession.cleanup, session_quit_error: quitError?.message },
            null,
            2,
          ),
          { flag: "wx" },
        );
        artifacts.push(report);
        if (quitError) {
          checks.push({
            scenario: "native-backup-session-quit",
            outcome: "failed",
            message: quitError.message,
          });
          process.exitCode = 1;
        }
      } catch (error) {
        checks.push({
          scenario: "native-backup-owned-cleanup",
          outcome: "failed",
          message: error.message,
        });
        process.exitCode = 1;
        // No PID-only fallback when identity or positive exit could not be proved.
      }
    } else if (historySession) {
      let quitError;
      try {
        assert.ok(historyInventory, "History requires captured identities before interaction");
        const finalInventory = (await historyDriverStillOwned(historyInventory))
          ? await captureHistorySession(driver.pid, values.driver, values.app, "cleanup")
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
            quitError = error;
          });
        browser = undefined;
        await stopDriver();
        const exited = await waitHistorySessionExit(historyInventory);
        const report = path.join(output, "qualification-history-cleanup.json");
        await writeFile(
          report,
          JSON.stringify({ ...exited, session_quit_error: quitError?.message ?? null }, null, 2),
          { flag: "wx" },
        );
        artifacts.push(report);
        assert.equal(
          quitError,
          undefined,
          "History session deletion failed; preserve its cleanup receipt",
        );
      } catch (error) {
        checks.push({
          scenario: "native-history-owned-cleanup",
          outcome: "failed",
          message: error.message,
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
      assert.equal(
        (await fileIdentity(values.app)).sha256,
        inputs[0].sha256,
        "Executable changed during the run; discard its scenario claims.",
      );
    } catch (error) {
      checks.push({
        scenario: "executable-identity",
        outcome: "failed",
        message: error.message,
      });
      process.exitCode = 1;
    }
    const log = path.join(output, "driver.log");
    await writeFile(log, driverLog, { flag: "wx" });
    artifacts.push(log);
    for (const name of selection.selected_scenarios) {
      if (!checks.some((check) => check.scenario === name))
        checks.push({
          scenario: name,
          outcome: "not-run",
          reason: "The harness ended before this selected scenario ran",
        });
    }
    await writeEvidence(output, {
      revision,
      executable: values.app,
      capturedExecutable: inputs[0],
      checks,
      setupChecks,
      artifacts,
      inputs,
      method: selection.profile ? `native-desktop-${selection.profile}` : "native-desktop-focused",
      context: {
        ...runnerMetadata,
        profile: selection.profile,
        selected_scenarios: selection.selected_scenarios,
        setup_scenarios: selection.setup_scenarios,
        excluded_scenarios: selection.excluded_scenarios,
        known_gaps: selection.known_gaps,
        restart_cycles: restartCycles,
        reload_cycles: reloadCycles,
        harness_deadline_ms: harnessDeadlineMs,
        phases: [
          ...(runnerMetadata.phases ?? []),
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
    if (installFixture) await installFixture.close();
    await nativeLock.release();
  }
}
