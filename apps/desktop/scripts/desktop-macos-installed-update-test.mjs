import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { Builder, By } from "selenium-webdriver";
import { driveInstalledUpdateToRestart } from "./desktop-application-update-journey.mjs";
import {
  hashFile,
  readJson,
  verifyInstalledUpdateStaging,
  waitFor,
} from "./desktop-installed-update-harness.mjs";

if (process.platform !== "darwin") throw new Error("Installed bundle qualification requires macOS");
const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "app",
      "output",
      "staging",
      "candidate-sha",
      "candidate-archive-sha",
      "candidate-version",
      "helper-marker",
      "relaunch-marker",
      "stage-marker",
      "library-marker",
    ].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of [
  "app",
  "output",
  "staging",
  "helper-marker",
  "relaunch-marker",
  "stage-marker",
  "library-marker",
])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`);
assert.match(values["candidate-sha"] ?? "", /^[0-9a-f]{64}$/u);
assert.match(values["candidate-archive-sha"] ?? "", /^[0-9a-f]{64}$/u);
assert.ok(values["candidate-version"]);
await mkdir(values.output, { recursive: false });
const evidencePath = path.join(values.output, "renderer-update-evidence.json");
const initialSha = (await hashFile(values.app)).sha256;
const librarySha = (await hashFile(values["library-marker"])).sha256;
const report = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  architecture: process.arch,
  app: values.app,
  predecessor_sha256: initialSha,
  candidate_sha256: values["candidate-sha"],
  candidate_archive_sha256: values["candidate-archive-sha"],
  candidate_version: values["candidate-version"],
  actions: [],
};
const save = () => writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function psField(pid, field) {
  try {
    return execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}
function processIdentity(pid, role) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid owned process marker PID");
  const started = psField(pid, "lstart");
  if (!started) return null;
  const command = psField(pid, "command");
  const state = psField(pid, "stat");
  if (!command || !state || state.startsWith("Z") || psField(pid, "lstart") !== started)
    return null;
  const expected = role === "helper" ? `${values.app} --portcove-apply-update ` : values.app;
  if (role === "helper" ? !command.startsWith(expected) : command !== expected)
    throw new Error(`Marked ${role} PID does not run the owned installed executable`);
  return { pid, started, command, state };
}
function listenerPid(port) {
  try {
    const value = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^\d+$/u.test(value) ? Number(value) : null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}
async function naturalExit(marker, role) {
  const original = processIdentity(marker.process_id, role);
  await waitFor(
    () => {
      const current = processIdentity(marker.process_id, role);
      return !current || (original && current.started !== original.started) ? true : null;
    },
    `${role} natural exit`,
    30_000,
  );
  return { observed_live: original, no_owned_process_remaining: true };
}
async function stopOwned(marker, role) {
  if (!marker || marker.executable !== values.app || marker.schema_version !== 1) return;
  const original = processIdentity(marker.process_id, role);
  if (!original) return;
  process.kill(marker.process_id, "SIGTERM");
  try {
    await waitFor(
      () => {
        const current = processIdentity(marker.process_id, role);
        return !current || current.started !== original.started ? true : null;
      },
      `${role} cleanup`,
      5000,
    );
  } catch {
    const current = processIdentity(marker.process_id, role);
    if (current?.started === original.started) process.kill(marker.process_id, "SIGKILL");
    await waitFor(() => !processIdentity(marker.process_id, role), `${role} forced cleanup`, 5000);
  }
}
const port = await availablePort();
report.webdriver_port = port;
const application = spawn(values.app, [], {
  env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const applicationExit = new Promise((resolve) => {
  application.once("exit", (code, signal) => resolve({ code, signal }));
});
async function bounded(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let output = "";
for (const stream of [application.stdout, application.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-1024 * 1024);
  });
}
application.on("error", (error) => {
  output += `\nspawn: ${error.message}`;
});
report.predecessor_process_id = application.pid;
let browser;
try {
  await waitFor(
    async () => {
      if (application.exitCode !== null) throw new Error(`installed predecessor exited: ${output}`);
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const owner = listenerPid(port);
      if (owner !== application.pid)
        throw new Error("Embedded WebDriver listener does not belong to the installed predecessor");
      return true;
    },
    "installed predecessor embedded WebDriver",
    60_000,
  );
  browser = await bounded(
    new Builder()
      .usingServer(`http://127.0.0.1:${port}`)
      .withCapabilities({ browserName: "tauri" })
      .build(),
    "embedded WebDriver session",
    20_000,
  );
  report.predecessor_identity = processIdentity(application.pid, "candidate");
  assert.ok(report.predecessor_identity, "Installed predecessor identity was not observed");
  await bounded(
    driveInstalledUpdateToRestart(browser, report.actions),
    "installed renderer journey",
    180_000,
  );
  report.staged = await verifyInstalledUpdateStaging({
    stagingRoot: values.staging,
    payloadName: "candidate.payload",
    candidateSha: values["candidate-archive-sha"],
    candidateVersion: values["candidate-version"],
    application: values.app,
    initialSha,
  });
  report.actions.push("installed-renderer-verified-candidate");
  await writeFile(
    path.join(values.output, "before-restart.png"),
    await bounded(browser.takeScreenshot(), "pre-restart screenshot", 20_000),
    "base64",
  );
  await save();
  try {
    await bounded(
      browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click(),
      "renderer restart click",
      15_000,
    );
    report.restart_click = "returned";
  } catch (error) {
    // The session can disappear while a successful restart click is in flight.
    report.restart_click = `session-ended: ${String(error.message).slice(0, 300)}`;
  }
  const ended = await bounded(applicationExit, "installed predecessor exit", 30_000);
  assert.deepEqual(ended, { code: 0, signal: null });
  report.predecessor_exit = ended;
  report.helper = await waitFor(
    () => readJson(values["helper-marker"]),
    "restart helper marker",
    30_000,
  );
  assert.equal(report.helper.schema_version, 1);
  assert.equal(report.helper.executable, values.app);
  assert.ok(Number.isInteger(report.helper.process_id) && report.helper.process_id > 0);
  report.helper_identity = processIdentity(report.helper.process_id, "helper");
  report.relaunch = await waitFor(
    () => readJson(values["relaunch-marker"]),
    "automatic relaunch marker",
    60_000,
  );
  assert.equal(report.relaunch.schema_version, 1);
  assert.equal(report.relaunch.executable, values.app);
  assert.ok(Number.isInteger(report.relaunch.process_id) && report.relaunch.process_id > 0);
  report.relaunch_identity = processIdentity(report.relaunch.process_id, "candidate");
  report.startup = await waitFor(
    async () => {
      const marker = await readJson(values["stage-marker"]);
      return marker.stage === "Tauri setup" ? marker : null;
    },
    "relaunch healthy startup",
    60_000,
  );
  assert.equal(report.startup.process_id, report.relaunch.process_id);
  await waitFor(
    async () => {
      const apply = await readJson(path.join(values.staging, "apply.json"));
      return apply.intent === null && apply.native_launch === null ? true : null;
    },
    "relaunch journal reconciliation",
    30_000,
  );
  assert.equal((await hashFile(values.app)).sha256, values["candidate-sha"]);
  assert.equal((await hashFile(values["library-marker"])).sha256, librarySha);
  await assert.rejects(stat(path.join(values.staging, "candidate.payload")), { code: "ENOENT" });
  report.helper_exit = await naturalExit(report.helper, "helper");
  report.relaunch_exit = await naturalExit(report.relaunch, "candidate");
  report.actions.push("installed-helper-relaunched-candidate-and-reconciled");
  report.phase = "complete";
} catch (error) {
  report.phase = "failed";
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(path.join(values.output, "application.log"), output);
  if (application.exitCode === null && application.signalCode === null) {
    application.kill();
    await bounded(applicationExit, "owned predecessor cleanup", 5000).catch((error) => {
      report.cleanup_failure = String(error);
      report.phase = "failed";
    });
  }
  // A live helper may create the relaunch marker while cleanup runs. Stop it
  // first, then read the candidate marker after helper exit.
  for (const role of ["helper", "candidate"]) {
    const marker =
      role === "helper"
        ? (report.helper ?? (await readJson(values["helper-marker"]).catch(() => null)))
        : (report.relaunch ?? (await readJson(values["relaunch-marker"]).catch(() => null)));
    try {
      await stopOwned(marker, role);
      if (marker && processIdentity(marker.process_id, role))
        throw new Error(`${role} remained live after owned cleanup`);
    } catch (error) {
      report.cleanup_failure = String(error);
      report.phase = "failed";
    }
  }
  await save();
  // The browser session belongs to the exited predecessor. Quitting it after
  // restart can race the helper, so the process exit is the cleanup proof.
  void browser;
}
if (report.phase !== "complete") throw new Error(report.cleanup_failure ?? report.failure);
