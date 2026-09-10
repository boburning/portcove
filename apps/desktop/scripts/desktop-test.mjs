import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { Builder, By, Key, until } from "selenium-webdriver";
import { writeEvidence, fileIdentity } from "../../../scripts/development-evidence.mjs";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { preparationScenarios } from "./desktop-preparation-test.mjs";
import { nativeConfirmation } from "./desktop-native-confirmation.mjs";
import { controllerScenario } from "./desktop-controller-test.mjs";
import { accessibleNavigationScenario } from "./desktop-accessibility-test.mjs";
import { reloadScenario } from "./desktop-reload-test.mjs";
import { workspaceRefreshScenario } from "./desktop-workspace-refresh-test.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({ options: {
  app: { type: "string" }, driver: { type: "string" }, "native-driver": { type: "string" },
  output: { type: "string" }, port: { type: "string", default: "4444" },
  "preparation-cli": { type: "string" }, "preparation-tool": { type: "string" },
  "artwork-only": { type: "boolean", default: false },
  "restart-cycles": { type: "string", default: "1" },
  "reload-cycles": { type: "string", default: "0" },
} });
for (const name of ["app", "driver", "native-driver", "output"]) {
  if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`);
}
const port = Number(values.port);
const restartCycles = Number(values["restart-cycles"]);
if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10) throw new Error("--restart-cycles must be 1..10");
const reloadCycles = Number(values["reload-cycles"]);
if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25) throw new Error("--reload-cycles must be 0..25");
if (values["artwork-only"] && !values["preparation-cli"]) throw new Error("--artwork-only requires the owned preparation CLI/tool inputs");
if (!Number.isInteger(port) || port < 1024 || port > 65533) throw new Error("--port must be 1024..65533");
const inputs = await Promise.all(["app", "driver", "native-driver"].map(name => fileIdentity(values[name])));
inputs.push(await fileIdentity(fileURLToPath(import.meta.url)));
inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-controller-test.mjs", import.meta.url))));
for (const name of ["native-session.ps1", "native-process-tree.ps1"]) inputs.push(await fileIdentity(fileURLToPath(new URL(name, import.meta.url))));
inputs.push(await fileIdentity(fileURLToPath(new URL("desktop-reload-test.mjs", import.meta.url))));
inputs.push(await fileIdentity(fileURLToPath(new URL("desktop-workspace-refresh-test.mjs", import.meta.url))));
if (values["preparation-cli"] || values["preparation-tool"]) {
  for (const name of ["preparation-cli", "preparation-tool"]) {
    if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`);
    inputs.push(await fileIdentity(values[name]));
  }
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-preparation-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-artwork-observations.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-preparation-recovery-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-backup-review-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-removal-review-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-source-removal-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-adoption-review-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-library-handoff-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-cli-handoff-test.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-review-controls.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./desktop-native-confirmation.mjs", import.meta.url))));
  inputs.push(await fileIdentity(fileURLToPath(new URL("./native-confirmation.ps1", import.meta.url))));
}
const revision = spawnCommand("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim();
const output = path.resolve(values.output);
await mkdir(output); // Existing output is never reused, including after failed runs.
const library = path.join(output, "library");
const profile = path.join(output, "webview");
const checks = [];
const artifacts = [];
let driver;
let browser;
let driverLog = "";
function stopDriver() {
  if (!driver?.pid || driver.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnCommand("taskkill.exe", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, stdio: "ignore" });
  } else {
    try { process.kill(-driver.pid, "SIGTERM"); } catch { /* Already stopped. */ }
  }
}
// Includes owned native artwork picker/restart coverage in addition to lifecycle reviews.
const deadline = setTimeout(() => { stopDriver(); }, 180_000);
deadline.unref();

async function requireUnusedPort(number) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: number, host: "127.0.0.1", exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const invoke = async (command, args = {}) => JSON.parse(await browser.executeAsyncScript((name, input, done) => {
  window.__TAURI_INTERNALS__.invoke(name, input).then(value => done(JSON.stringify({ ok: true, value })), error => done(JSON.stringify({ ok: false, error })));
}, command, args));

async function scenario(name, action) {
  try {
    await action();
    checks.push({ scenario: name, outcome: "passed" });
  } catch (error) {
    checks.push({ scenario: name, outcome: "failed", message: error.message });
    if (browser) {
      const report = path.join(output, `${name}-diagnostics.json`);
      try {
        const details = await browser.executeScript(() => Array.from(document.querySelectorAll('.error-banner, .bootstrap-error')).map(element => element.textContent));
        await writeFile(report, JSON.stringify(details, null, 2), { flag: "wx" }); artifacts.push(report);
      } catch { /* Preserve the original failure if its window is unavailable. */ }
    }
    process.exitCode = 1;
  }
  if (browser) {
    const screenshot = path.join(output, `${name}.png`);
    try { await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot); }
    catch { /* The failed scenario remains recorded even if its window disappeared. */ }
  }
}

async function connect() {
  browser = await new Builder().disableEnvironmentOverrides().usingServer(`http://127.0.0.1:${port}`).withCapabilities({
    browserName: process.platform === "win32" ? "webview2" : "wry",
    "tauri:options": { application: values.app,
      ...(process.platform === "win32" ? { webviewOptions: { userDataFolder: profile } } : {}) },
  }).build();
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  await browser.wait(async () => (await browser.findElements(By.css(".loading-state"))).length === 0, 30_000);
}

function observeNativeSession(mode, snapshot) {
  const result = spawnCommand("pwsh", ["-NoProfile", "-File", fileURLToPath(new URL("./native-session.ps1", import.meta.url)), "-Mode", mode,
    "-DriverProcessId", String(driver.pid), "-ApplicationPath", values.app, "-SnapshotPath", snapshot], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  await requireUnusedPort(port);
  await requireUnusedPort(port + 1);
  driver = spawn(values.driver, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", values["native-driver"]], {
    windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      PORTCOVE_LIBRARY: library, PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
      WEBVIEW2_USER_DATA_FOLDER: profile },
  });
  let spawnError;
  driver.on("error", error => { spawnError = error; });
  for (const stream of [driver.stdout, driver.stderr]) stream.on("data", chunk => { driverLog = (driverLog + chunk).slice(-1024 * 1024); });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited: ${driver.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch { /* Driver startup is bounded by the loop and connection timeout. */ }
  }
  await connect();
  await scenario("empty-library", async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    assert.equal(path.resolve(bootstrap.value.library_root), library);
    const status = await invoke("get_statuses");
    assert.equal(status.ok, true);
    assert.equal(status.value.filter(item => item.active).length, 0);
  });
  await scenario("native-error-recovery", async () => {
    const failed = await invoke("verify_port", { portId: "nonexistent-fixture-port" });
    assert.equal(failed.ok, false);
    assert.ok(failed.error.code);
    assert.equal((await invoke("get_bootstrap_status")).value.ready, true);
  });
  await scenario("keyboard-layout", async () => {
    await browser.manage().window().setRect({ width: 960, height: 640 });
    await browser.findElement(By.css('nav button')).click();
    await browser.actions().sendKeys(Key.TAB).perform();
    const focus = await browser.executeScript(() => ({ tag: document.activeElement.tagName,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    assert.notEqual(focus.tag, "BODY");
    assert.equal(focus.overflow, false);
  });
  await scenario("appearance-restart", async () => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.findElement(By.xpath('//button[normalize-space(.)="Light"]')).click();
    assert.equal(await browser.executeScript(() => document.documentElement.dataset.theme), "light");
    const observations = [];
    try {
      for (let cycle = 0; cycle < restartCycles; cycle++) {
        const observation = { cycle: cycle + 1, quit_started: new Date().toISOString() };
        observations.push(observation);
        const snapshot = path.join(output, `restart-${cycle + 1}-processes.json`);
        if (process.platform === "win32") { observeNativeSession("Snapshot", snapshot); artifacts.push(snapshot); }
        await browser.quit();
        browser = undefined;
        observation.quit_completed = new Date().toISOString();
        if (process.platform === "win32") observation.shutdown = observeNativeSession("Wait", snapshot);
        await connect();
        observation.connected = new Date().toISOString();
        assert.equal(await browser.executeScript(() => document.documentElement.dataset.theme), "light");
        observation.preference_preserved = true;
      }
    } finally {
      const report = path.join(output, "restart-observations.json");
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" }); artifacts.push(report);
    }
  });
  await scenario("accessibility", async () => {
    await browser.executeScript(axe.source);
    const result = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "accessibility.json");
    await writeFile(report, JSON.stringify(result, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.deepEqual(result.violations.map(item => item.id), []);
  });
  await controllerScenario({ browser, scenario, output, artifacts });
  await accessibleNavigationScenario({ browser, scenario, output, artifacts });
  await workspaceRefreshScenario({ browser, scenario, output, artifacts });
  checks.push({ scenario: "install-progress-cancellation", outcome: "not-run", reason: "Requires a reviewed install fixture; the smoke harness does not download or execute upstream games." });
  if (values["preparation-cli"]) {
    await preparationScenarios({ browser, invoke, scenario, library, output, artifacts,
      confirmNative: nativeConfirmation({ application: values.app, driverPid: driver.pid, output, artifacts }),
      cli: values["preparation-cli"], tool: values["preparation-tool"], onlyArtwork: values["artwork-only"] });
  }
  if (reloadCycles) await reloadScenario({ browser, scenario, output, artifacts, cycles: reloadCycles });
} catch (error) {
  checks.push({ scenario: "harness", outcome: "failed", message: error.message });
  if (browser) {
    const screenshot = path.join(output, "harness-failure.png");
    await browser.takeScreenshot().then(data => writeFile(screenshot, data, { encoding: "base64", flag: "wx" })).then(() => artifacts.push(screenshot)).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.quit().catch(() => {});
  stopDriver();
  clearTimeout(deadline);
  try {
    assert.equal((await fileIdentity(values.app)).sha256, inputs[0].sha256, "Executable changed during the run; discard its scenario claims.");
  } catch (error) {
    checks.push({ scenario: "executable-identity", outcome: "failed", message: error.message });
    process.exitCode = 1;
  }
  const log = path.join(output, "driver.log");
  await writeFile(log, driverLog, { flag: "wx" });
  artifacts.push(log);
  await writeEvidence(output, { revision, executable: values.app, capturedExecutable: inputs[0], checks, artifacts, inputs, method: values["artwork-only"] ? "native-artwork-smoke" : "native-desktop-smoke" });
  console.log(JSON.stringify(checks, null, 2));
}
