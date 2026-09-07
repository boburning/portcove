import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { remote } from "webdriverio";
import { writeEvidence, fileIdentity } from "../../../scripts/development-evidence.mjs";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({ options: {
  app: { type: "string" }, driver: { type: "string" }, "native-driver": { type: "string" },
  output: { type: "string" }, port: { type: "string", default: "4444" },
} });
for (const name of ["app", "driver", "native-driver", "output"]) {
  if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65533) throw new Error("--port must be 1024..65533");
const inputs = await Promise.all(["app", "driver", "native-driver"].map(name => fileIdentity(values[name])));
inputs.push(await fileIdentity(fileURLToPath(import.meta.url)));
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
const deadline = setTimeout(() => { stopDriver(); }, 120_000);
deadline.unref();

async function requireUnusedPort(number) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: number, host: "127.0.0.1", exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const invoke = async (command, args = {}) => JSON.parse(await browser.executeAsync((name, input, done) => {
  window.__TAURI_INTERNALS__.invoke(name, input).then(value => done(JSON.stringify({ ok: true, value })), error => done(JSON.stringify({ ok: false, error })));
}, command, args));

async function scenario(name, action) {
  try {
    await action();
    checks.push({ scenario: name, outcome: "passed" });
  } catch (error) {
    checks.push({ scenario: name, outcome: "failed", message: error.message });
    process.exitCode = 1;
  }
  if (browser) {
    const screenshot = path.join(output, `${name}.png`);
    try { await browser.saveScreenshot(screenshot); artifacts.push(screenshot); }
    catch { /* The failed scenario remains recorded even if its window disappeared. */ }
  }
}

async function connect() {
  browser = await remote({ hostname: "127.0.0.1", port, logLevel: "error", connectionRetryCount: 0,
    connectionRetryTimeout: 30_000, capabilities: { "tauri:options": { application: values.app,
      ...(process.platform === "win32" ? { webviewOptions: { userDataFolder: profile } } : {}) } } });
  await browser.setTimeout({ script: 15_000 });
  await browser.$('nav[aria-label="Primary navigation"]').waitForExist({ timeout: 30_000 });
  await browser.$(".loading-state").waitForExist({ reverse: true, timeout: 30_000 });
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
    await browser.setWindowSize(960, 640);
    await browser.$('nav button').click();
    await browser.keys(["Tab"]);
    const focus = await browser.execute(() => ({ tag: document.activeElement.tagName,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    assert.notEqual(focus.tag, "BODY");
    assert.equal(focus.overflow, false);
  });
  await scenario("appearance-restart", async () => {
    await browser.$('nav').$('button*=Settings').click();
    await browser.$('button=Light').click();
    assert.equal(await browser.execute(() => document.documentElement.dataset.theme), "light");
    await browser.deleteSession();
    browser = undefined;
    await connect();
    assert.equal(await browser.execute(() => document.documentElement.dataset.theme), "light");
  });
  await scenario("accessibility", async () => {
    await browser.execute(axe.source);
    const result = await browser.executeAsync(done => window.axe.run().then(done));
    const report = path.join(output, "accessibility.json");
    await writeFile(report, JSON.stringify(result, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.deepEqual(result.violations.map(item => item.id), []);
  });
  checks.push({ scenario: "install-progress-cancellation", outcome: "not-run", reason: "Requires a reviewed install fixture; the smoke harness does not download or execute upstream games." });
} catch (error) {
  checks.push({ scenario: "harness", outcome: "failed", message: error.message });
  if (browser) {
    const screenshot = path.join(output, "harness-failure.png");
    await browser.saveScreenshot(screenshot).then(() => artifacts.push(screenshot)).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.deleteSession().catch(() => {});
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
  await writeEvidence(output, { revision, executable: values.app, capturedExecutable: inputs[0], checks, artifacts, inputs, method: "native-desktop-smoke" });
  console.log(JSON.stringify(checks, null, 2));
}
