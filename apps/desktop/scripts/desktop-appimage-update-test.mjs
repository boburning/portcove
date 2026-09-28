import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Builder, By, until } from "selenium-webdriver";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "app",
      "driver",
      "native-driver",
      "output",
      "staging",
      "stage-marker",
      "candidate-sha",
      "candidate-version",
    ].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["app", "driver", "native-driver", "output", "staging", "stage-marker"])
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
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: (await stat(file)).size };
}
async function waitFor(predicate, label, deadlineMs = 60_000) {
  const untilMs = Date.now() + deadlineMs;
  while (Date.now() < untilMs) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not complete within ${deadlineMs} ms`);
}
async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
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
    return rest[19] ? { pid, start_ticks: rest[19], command } : null;
  } catch {
    return null;
  }
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
let driverLog = "";
try {
  report.initial_sha256 = (await hashFile(values.app)).sha256;
  driver = spawn(
    values.driver,
    ["--port", "45770", "--native-port", "45771", "--native-driver", values["native-driver"]],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  driver.on("error", (error) => {
    driverLog += `\nspawn: ${error.message}`;
  });
  for (const stream of [driver.stdout, driver.stderr])
    stream.on("data", (chunk) => {
      driverLog = (driverLog + chunk).slice(-1024 * 1024);
    });
  report.driver = await waitFor(
    async () => {
      if (driver.exitCode !== null) throw new Error(`tauri-driver exited ${driver.exitCode}`);
      const response = await fetch("http://127.0.0.1:45770/status", {
        signal: AbortSignal.timeout(500),
      });
      return response.ok ? procIdentity(driver.pid) : null;
    },
    "tauri-driver startup",
    10_000,
  );
  assert.ok(report.driver);
  browser = await new Builder()
    .disableEnvironmentOverrides()
    .usingServer("http://127.0.0.1:45770")
    .withCapabilities({ browserName: "wry", "tauri:options": { application: values.app } })
    .build();
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  report.actions.push("installed-gui-opened");
  await browser.findElement(By.xpath('//button[normalize-space(.)="Review options"]')).click();
  await browser.wait(
    until.elementLocated(By.css('article[aria-labelledby="application-update-settings-title"]')),
    15_000,
  );
  await browser
    .findElement(
      By.xpath(
        '//*[@aria-label="Application update channel"]//button[normalize-space(.)="Preview"]',
      ),
    )
    .click();
  await browser
    .findElement(
      By.xpath('//*[@aria-label="Application update mode"]//button[normalize-space(.)="Manual"]'),
    )
    .click();
  await browser
    .findElement(By.xpath('//button[normalize-space(.)="Save application update settings"]'))
    .click();
  await browser.wait(
    until.elementLocated(
      By.xpath('//button[normalize-space(.)="Check for updates" and not(@disabled)]'),
    ),
    15_000,
  );
  report.actions.push("preview-manual-settings-saved");
  await browser.findElement(By.xpath('//button[normalize-space(.)="Check for updates"]')).click();
  await browser.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="Download and verify update"]')),
    45_000,
  );
  report.actions.push("signed-candidate-presented");
  await browser
    .findElement(By.xpath('//button[normalize-space(.)="Download and verify update"]'))
    .click();
  await browser.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="Restart to update"]')),
    60_000,
  );
  const stagedPayload = path.join(values.staging, "candidate.payload");
  const staged = await hashFile(stagedPayload);
  const staging = await readJson(path.join(values.staging, "staging.json"));
  assert.equal(staging.phase, "verified");
  assert.equal(staged.sha256, values["candidate-sha"]);
  assert.equal(staged.bytes, staging.candidate.release.artifact.bytes);
  assert.equal(staging.candidate.release.version, values["candidate-version"]);
  assert.equal((await hashFile(values.app)).sha256, report.initial_sha256);
  report.staged = staged;
  report.actions.push("renderer-downloaded-and-verified");
  await writeFile(path.join(output, "before-restart.png"), await browser.takeScreenshot(), {
    encoding: "base64",
  });
  report.processes_before_restart = await ownedProcessTree(driver.pid);
  await save();
  try {
    await browser.findElement(By.xpath('//button[normalize-space(.)="Restart to update"]')).click();
    report.restart_click = "returned";
  } catch (error) {
    report.restart_click = `session-ended: ${String(error.message).slice(0, 300)}`;
  }
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
  report.phase = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (driver && !report.processes_before_restart)
    report.processes_before_restart = await ownedProcessTree(driver.pid).catch(() => []);
  if (browser)
    await Promise.race([
      browser.quit().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  if (driver) {
    const current = await procIdentity(driver.pid);
    if (current?.start_ticks === report.driver?.start_ticks) {
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
      report.failure = "Owned WebDriver or application processes remained after bounded cleanup";
      process.exitCode = 1;
    }
  }
  await writeFile(path.join(output, "driver.log"), driverLog);
  await save();
}
if (report.phase !== "complete")
  throw new Error(report.failure ?? "AppImage renderer qualification failed");
