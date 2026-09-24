import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Builder, By, Key, until } from "selenium-webdriver";
import { writeEvidence, fileIdentity } from "../../../scripts/development-evidence.mjs";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { cachedDesktopDrivers } from "../../../scripts/tool-cache.mjs";
import { preparationScenarios } from "./desktop-preparation-test.mjs";
import { nativeConfirmation } from "./desktop-native-confirmation.mjs";
import { controllerScenario } from "./desktop-controller-test.mjs";
import { accessibleNavigationScenario } from "./desktop-accessibility-test.mjs";
import { reloadScenario } from "./desktop-reload-test.mjs";
import { workspaceRefreshScenario } from "./desktop-workspace-refresh-test.mjs";
import { assertCompactReview, captureAccessibilityReport } from "./desktop-review-controls.mjs";
import { createInstallFixture } from "./desktop-install-fixture.mjs";
import { installScenarios } from "./desktop-install-test.mjs";
import { assertDesignCompatibility } from "./desktop-design-compatibility-assertions.mjs";
import { catalogUpdateScenario } from "./desktop-catalog-update-test.mjs";
import {
  desktopHarnessDeadlineMs,
  desktopScenarioById,
  resolveDesktopSelection,
} from "../../../scripts/desktop-scenarios.mjs";
import { acquireNativeSessionLock } from "../../../scripts/native-session-lock.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({
  options: {
    app: { type: "string" },
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
if (selection.prerequisites.includes("owned-fixture") && !values["preparation-cli"])
  throw new Error("Selected fixture scenarios require the owned preparation CLI/tool inputs");
if (!Number.isInteger(port) || port < 1024 || port > 65533)
  throw new Error("--port must be 1024..65533");
const inputs = await Promise.all(
  ["app", "driver", "native-driver"].map((name) => fileIdentity(values[name])),
);
inputs.push(await fileIdentity(fileURLToPath(import.meta.url)));
inputs.push(
  await fileIdentity(fileURLToPath(new URL("./desktop-controller-test.mjs", import.meta.url))),
);
for (const name of ["native-session.ps1", "native-process-tree.ps1"])
  inputs.push(await fileIdentity(fileURLToPath(new URL(name, import.meta.url))));
inputs.push(await fileIdentity(fileURLToPath(new URL("desktop-reload-test.mjs", import.meta.url))));
inputs.push(
  await fileIdentity(fileURLToPath(new URL("desktop-workspace-refresh-test.mjs", import.meta.url))),
);
inputs.push(
  await fileIdentity(fileURLToPath(new URL("desktop-catalog-update-test.mjs", import.meta.url))),
);
if (selection.prerequisites.includes("owned-fixture")) {
  for (const name of ["preparation-cli", "preparation-tool"]) {
    if (!values[name] || !path.isAbsolute(values[name]))
      throw new Error(`--${name} requires an absolute path`);
    inputs.push(await fileIdentity(values[name]));
  }
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-preparation-test.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-readiness-test.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-artwork-observations.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-preparation-recovery-test.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-backup-review-test.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-removal-review-test.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-steam-entry-test.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-source-removal-test.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-adoption-review-test.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-library-handoff-test.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-cli-handoff-test.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-review-controls.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(
      fileURLToPath(new URL("./desktop-native-confirmation.mjs", import.meta.url)),
    ),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./native-confirmation.ps1", import.meta.url))),
  );
}
if (selection.prerequisites.includes("install-fixture")) {
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-install-fixture.mjs", import.meta.url))),
  );
  inputs.push(
    await fileIdentity(fileURLToPath(new URL("./desktop-install-test.mjs", import.meta.url))),
  );
}
inputs.push(
  await fileIdentity(
    fileURLToPath(new URL("../../../scripts/desktop-scenarios.mjs", import.meta.url)),
  ),
);
inputs.push(
  await fileIdentity(
    fileURLToPath(new URL("../../../scripts/native-session-lock.mjs", import.meta.url)),
  ),
);
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
const library = path.join(output, "library");
const profile = path.join(output, "webview");
const checks = [];
const setupChecks = [];
const artifacts = [];
const scenarioOutcomes = new Map();
let driver;
let browser;
let driverLog = "";
const nativeLock = await acquireNativeSessionLock({
  workspace: root,
  profile: selection.profile,
  scenarios: selection.selected_scenarios,
});
const harnessStarted = new Date();
function stopDriver() {
  if (!driver?.pid || driver.exitCode !== null) return;
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
// Includes owned native artwork picker/restart coverage in addition to lifecycle reviews.
const harnessDeadlineMs = desktopHarnessDeadlineMs(selection);
const deadline = setTimeout(() => {
  stopDriver();
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

async function captureScenarioScreenshot(name) {
  if (!browser) return;
  const screenshot = path.join(output, `${name}.png`);
  try {
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  } catch {
    /* The failed scenario remains recorded even if its window disappeared. */
  }
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
  }
  if (!target.setup) await captureScenarioScreenshot(name);
}

async function connect() {
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
  await browser.manage().setTimeouts({ script: 15_000 });
  const readyRoot = selection.prerequisites.includes("design-compatibility-fixture")
    ? ".design-compatibility-fixture"
    : 'nav[aria-label="Primary navigation"]';
  await browser.wait(until.elementLocated(By.css(readyRoot)), 30_000);
  await browser.wait(
    async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
    30_000,
  );
}

async function requestApplicationShutdown(snapshot) {
  await browser.quit();
  browser = undefined;
  const driverStop =
    process.platform === "win32" ? observeNativeSession("StopDriver", snapshot) : undefined;
  driver = undefined;
  return driverStop;
}

async function restartApplication(name, prepareWhileStopped) {
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
  await startDriver();
  await connect();
  observation.reconnected_at = new Date().toISOString();
  await writeFile(restartEvidence, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx" });
  artifacts.push(restartEvidence);
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

async function startDriver() {
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
      env: {
        ...process.env,
        ...(installFixture ? { PORTCOVE_QUALIFICATION_CATALOG: installFixture.catalogPath } : {}),
        ...(selection.prerequisites.includes("steam-fixture")
          ? { PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE: "closed" }
          : {}),
        PORTCOVE_LIBRARY: library,
        PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
        PORTCOVE_APPLICATION_UPDATE_PREFERENCES: path.join(output, "application-updates.json"),
        PORTCOVE_APPLICATION_UPDATE_SCHEDULE: path.join(output, "application-update-schedule.json"),
        PORTCOVE_APPLICATION_UPDATE_STAGING: path.join(output, "application-update-state"),
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
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
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited: ${driver.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      /* Driver startup is bounded by the loop and connection timeout. */
    }
  }
  throw new Error("tauri-driver did not become ready within ten seconds");
}

try {
  if (selection.prerequisites.includes("install-fixture")) {
    installFixture = await createInstallFixture({ root, output });
    inputs.push(await fileIdentity(installFixture.artifactPath));
    inputs.push(await fileIdentity(installFixture.catalogPath));
  }
  await requireUnusedPort(port);
  await requireUnusedPort(port + 1);
  await startDriver();
  await connect();
  await scenario("empty-library", async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    assert.equal(path.resolve(bootstrap.value.library_root), library);
    const status = await invoke("get_statuses");
    assert.equal(status.ok, true);
    assert.equal(status.value.filter((item) => item.active).length, 0);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const browse = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Browse port catalog"]')),
      15_000,
    );
    assert.equal(await browse.getAttribute("data-slot"), "button");
    assert.equal(await browse.getAttribute("data-variant"), "primary");
    await captureScenarioScreenshot("empty-library-shared-controls");
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys("unmatched title");
    const clearSearch = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Clear search and filters"]')),
      5000,
    );
    assert.match(
      await browser.findElement(By.css(".empty-state")).getText(),
      /This library has no installed ports yet/,
    );
    await captureScenarioScreenshot("filtered-empty-new-library");
    await clearSearch.click();
    assert.equal(await search.getAttribute("value"), "");
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Browse port catalog"]')),
      5000,
    );
    await browser
      .findElement(
        By.xpath('//div[contains(@class,"filter-row")]//button[normalize-space(.)="Ready"]'),
      )
      .click();
    const clearReadiness = await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Clear search and filters"]')),
      5000,
    );
    await clearReadiness.click();
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Browse port catalog"]')),
      5000,
    );
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
  await catalogUpdateScenario({ browser, invoke, scenario, output, artifacts });
  await scenario("keyboard-layout", async () => {
    await browser.manage().window().setRect({ width: 640, height: 640 });
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
      overflowing_cards: [...document.querySelectorAll(".settings-card")]
        .filter((card) => card.scrollWidth > card.clientWidth + 1)
        .map((card) => card.getAttribute("aria-labelledby") ?? card.className),
      legacy_buttons: [
        ...document.querySelectorAll(
          '[data-settings-group]:not([data-settings-group="updates"]) button:not([data-slot="button"])',
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

    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    const selectedFilter = await browser.findElement(By.css('.filter-row [aria-pressed="true"]'));
    assert.equal(await selectedFilter.getAttribute("data-slot"), "button");
    assert.equal(await selectedFilter.getAttribute("data-variant"), "selected");
    await search.sendKeys("64");
    await browser.wait(async () => (await browser.findElements(By.css(".port-card"))).length > 2);
    const origin = await browser.executeScript(() => {
      const cards = [...document.querySelectorAll(".port-card")];
      const card = cards[Math.min(3, cards.length - 1)];
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
    await captureScenarioScreenshot("game-details-workspace");
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
    assert.equal(restored.query, "64");
    assert.equal(restored.focus, origin.originKey);
    assert.ok(Math.abs(restored.scrollTop - origin.scrollTop) <= 1);
    await captureScenarioScreenshot("game-details-workspace-return");
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

    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
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
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
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
    const layout = await browser.executeScript(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
        };
      };
      return {
        updates: {
          content: rect('[data-settings-group="updates"] .settings-section-content'),
          application: rect('[data-settings-group="updates"] .application-update-settings'),
          catalog: rect(
            '[data-settings-group="updates"] .settings-card:not(.application-update-settings)',
          ),
        },
        advanced: {
          content: rect('[data-settings-group="advanced"] .settings-section-content'),
          diagnostics: rect('[data-settings-group="advanced"] .diagnostics-card'),
          privacy: rect('[data-settings-group="advanced"] .privacy-card'),
          about: rect('[data-settings-group="advanced"] .about-card'),
        },
      };
    });
    assert.ok(Math.abs(layout.updates.application.width - layout.updates.content.width) < 2);
    assert.ok(Math.abs(layout.updates.catalog.width - layout.updates.content.width) < 2);
    assert.ok(Math.abs(layout.updates.application.left - layout.updates.catalog.left) < 2);
    assert.ok(Math.abs(layout.advanced.diagnostics.top - layout.advanced.privacy.top) < 2);
    assert.ok(layout.advanced.diagnostics.right < layout.advanced.privacy.left);
    assert.ok(layout.advanced.about.top >= layout.advanced.diagnostics.bottom);
    assert.ok(layout.advanced.about.top >= layout.advanced.privacy.bottom);
    assert.ok(Math.abs(layout.advanced.about.width - layout.advanced.content.width) < 2);
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
    const updates = await browser.findElement(By.css('[data-settings-group="updates"]'));
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
      updates,
    );
    await captureScenarioScreenshot("settings-updates-group");
    const advanced = await browser.findElement(By.css('[data-settings-group="advanced"]'));
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "start", inline: "nearest" }),
      advanced,
    );
    await captureScenarioScreenshot("settings-lower-groups");
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
    async function refreshSettings() {
      await browser.navigate().refresh();
      await browser.wait(
        until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
        15_000,
      );
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    }

    const reset = await invoke("set_locale_preference", { locale: "en" });
    assert.equal(reset.ok, true);
    await refreshSettings();
    const languageTrigger = await browser.wait(
      until.elementLocated(By.xpath('//button[contains(., "Display language")]')),
      15_000,
    );
    await languageTrigger.click();
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
  await installScenarios({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    fixture: installFixture,
  });
  for (const gap of selection.known_gaps)
    checks.push({ scenario: gap.scenario, outcome: "not-run", reason: gap.reason });
  if (selection.prerequisites.includes("owned-fixture")) {
    await preparationScenarios({
      browser,
      invoke,
      scenario,
      library,
      output,
      artifacts,
      confirmNative: nativeConfirmation({
        application: values.app,
        getDriverPid: () => driver.pid,
        output,
        artifacts,
      }),
      restartApplication,
      cli: values["preparation-cli"],
      tool: values["preparation-tool"],
    });
  }
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
    if (browser) await browser.quit().catch(() => {});
    stopDriver();
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
