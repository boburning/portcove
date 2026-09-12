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
import { captureAccessibilityReport } from "./desktop-review-controls.mjs";
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
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  await browser.wait(
    async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
    30_000,
  );
}

function observeNativeSession(mode, snapshot) {
  const result = spawnCommand(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      fileURLToPath(new URL("./native-session.ps1", import.meta.url)),
      "-Mode",
      mode,
      "-DriverProcessId",
      String(driver.pid),
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

try {
  await requireUnusedPort(port);
  await requireUnusedPort(port + 1);
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
      if (response.ok) break;
    } catch {
      /* Driver startup is bounded by the loop and connection timeout. */
    }
  }
  await connect();
  await scenario("empty-library", async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    assert.equal(path.resolve(bootstrap.value.library_root), library);
    const status = await invoke("get_statuses");
    assert.equal(status.ok, true);
    assert.equal(status.value.filter((item) => item.active).length, 0);
  });
  await scenario("native-error-recovery", async () => {
    const failed = await invoke("verify_port", {
      portId: "nonexistent-fixture-port",
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.error.code);
    assert.equal((await invoke("get_bootstrap_status")).value.ready, true);
  });
  await scenario("keyboard-layout", async () => {
    await browser.manage().window().setRect({ width: 960, height: 640 });
    await browser.findElement(By.css("nav button")).click();
    await browser.actions().sendKeys(Key.TAB).perform();
    const focus = await browser.executeScript(() => ({
      tag: document.activeElement.tagName,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    assert.notEqual(focus.tag, "BODY");
    assert.equal(focus.overflow, false);
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
    await browser.wait(
      async () =>
        (await browser.executeScript(() => document.activeElement?.id)) ===
        "application-update-settings-title",
      15_000,
    );
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Application update channel"]')),
      15_000,
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
          '//p[@role="status" and contains(., "No update check, download, install, or restart was started.")]',
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
      until.elementLocated(By.xpath('//button[normalize-space(.)="Repair update check history"]')),
      15_000,
    );
    assert.equal(
      (await invoke("get_application_update_status")).value.recovery_required[0].area,
      "schedule",
    );
    await browser
      .findElement(By.xpath('//button[normalize-space(.)="Repair update check history"]'))
      .click();
    await browser.wait(async () => {
      const result = await invoke("get_application_update_status");
      return result.ok && result.value.recovery_required.length === 0;
    }, 15_000);
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "schedule state repaired")]'),
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
    await browser.wait(async () => {
      const result = await invoke("get_application_update_preferences");
      return result.ok && result.value.choice === null && result.value.revision > 0;
    }, 15_000);
    await browser.wait(until.elementLocated(choicePrompt), 15_000);
    await browser.findElement(By.xpath('//button[normalize-space(.)="Not now"]')).click();
    await browser.wait(async () => (await browser.findElements(choicePrompt)).length === 0, 15_000);
    await browser.wait(
      async () => (await browser.executeScript(() => document.activeElement?.tagName)) !== "BODY",
      15_000,
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Damaged update settings reset.")]'),
      ),
      15_000,
    );
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(
      () =>
        browser.executeScript(() => {
          const control = [...document.querySelectorAll("button")].find(
            (element) => element.textContent?.trim() === "Import library",
          );
          return (
            control instanceof HTMLButtonElement &&
            !control.disabled &&
            getComputedStyle(control).color === getComputedStyle(document.body).color
          );
        }),
      15_000,
    );
    const report = path.join(output, "application-update-settings-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
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
          quit_started: new Date().toISOString(),
        };
        observations.push(observation);
        const snapshot = path.join(output, `restart-${cycle + 1}-processes.json`);
        if (process.platform === "win32") {
          observeNativeSession("Snapshot", snapshot);
          artifacts.push(snapshot);
        }
        await browser.quit();
        browser = undefined;
        observation.quit_completed = new Date().toISOString();
        if (process.platform === "win32")
          observation.shutdown = observeNativeSession("Wait", snapshot);
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
  await scenario("accessibility", async () => {
    const report = path.join(output, "accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
  });
  await controllerScenario({ browser, scenario, output, artifacts });
  await accessibleNavigationScenario({ browser, scenario, output, artifacts });
  await workspaceRefreshScenario({ browser, scenario, output, artifacts });
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
        driverPid: driver.pid,
        output,
        artifacts,
      }),
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
    await nativeLock.release();
  }
}
