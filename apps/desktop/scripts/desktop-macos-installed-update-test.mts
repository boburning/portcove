import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { Builder, By } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { driveInstalledUpdateToRestart } from "./desktop-application-update-journey.mts";
import {
  hashFile,
  readJson,
  verifyInstalledUpdateStaging,
  waitFor,
} from "./desktop-installed-update-harness.mts";

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
  evidenceDirectory = absoluteOption("output"),
  staging = absoluteOption("staging");
const helperMarker = absoluteOption("helper-marker"),
  relaunchMarker = absoluteOption("relaunch-marker"),
  stageMarker = absoluteOption("stage-marker"),
  libraryMarker = absoluteOption("library-marker");
const candidateSha = requiredOption("candidate-sha"),
  archiveSha = requiredOption("candidate-archive-sha"),
  candidateVersion = requiredOption("candidate-version");
for (const sha of [candidateSha, archiveSha]) assert.match(sha, /^[0-9a-f]{64}$/u);
await mkdir(evidenceDirectory, { recursive: false });
const evidencePath = path.join(evidenceDirectory, "renderer-update-evidence.json");
const initialSha = (await hashFile(app)).sha256;
const librarySha = (await hashFile(libraryMarker)).sha256;
type ProcessRole = "candidate" | "helper";
interface ProcessIdentity {
  pid: number;
  started: string;
  command: string;
  state: string;
}
interface ProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}
interface NaturalExit {
  observed_live: ProcessIdentity | null;
  no_owned_process_remaining: true;
}
interface ApplicationExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
interface MacUpdateReport {
  schema_version: 1;
  phase: "started" | "failed" | "complete";
  source_commit: string;
  platform: NodeJS.Platform;
  architecture: string;
  app: string;
  predecessor_sha256: string;
  candidate_sha256: string;
  candidate_archive_sha256: string;
  candidate_version: string;
  actions: string[];
  webdriver_port?: number;
  failure_dom_capture?: string;
  failure_screenshot?: string;
  predecessor_process_id?: number | undefined;
  predecessor_identity?: ProcessIdentity | null;
  staged?: Awaited<ReturnType<typeof verifyInstalledUpdateStaging>>;
  ordinary_staging?: Awaited<ReturnType<typeof driveInstalledUpdateToRestart>>;
  restart_click?: string;
  predecessor_exit?: ApplicationExit;
  helper?: ProcessMarker;
  helper_identity?: ProcessIdentity | null;
  relaunch?: ProcessMarker;
  relaunch_identity?: ProcessIdentity | null;
  startup?: { stage: "Tauri setup"; process_id: number };
  helper_exit?: NaturalExit;
  relaunch_exit?: NaturalExit;
  failure?: string;
  cleanup_failure?: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function positivePid(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "Invalid owned process marker PID",
  );
  return value;
}
function processMarker(value: unknown): ProcessMarker {
  const marker = object(value);
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.executable, app);
  return {
    ...marker,
    schema_version: 1,
    process_id: positivePid(marker.process_id),
    executable: app,
  };
}
// Cleanup ignores markers for other executables as before; matching identities
// must pass the same PID checks used by the observed-process boundary.
function ownedMarker(value: unknown): ProcessMarker | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  if (
    !("executable" in value) ||
    value.executable !== app ||
    !("schema_version" in value) ||
    value.schema_version !== 1
  )
    return null;
  return processMarker(value);
}
const report: MacUpdateReport = {
  schema_version: 1,
  phase: "started",
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  architecture: process.arch,
  app,
  predecessor_sha256: initialSha,
  candidate_sha256: candidateSha,
  candidate_archive_sha256: archiveSha,
  candidate_version: candidateVersion,
  actions: [],
};
const save = () => writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function psField(pid: number, field: "lstart" | "command" | "stat") {
  try {
    return execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1)
      return null;
    throw error;
  }
}
function processIdentity(pid: number, role: ProcessRole) {
  const identity = readProcessIdentity(pid);
  if (!identity) return null;
  const expected = role === "helper" ? `${app} --portcove-apply-update ` : app;
  if (role === "helper" ? !identity.command.startsWith(expected) : identity.command !== expected)
    throw new Error(`Marked ${role} PID does not run the owned installed executable`);
  return identity;
}
function readProcessIdentity(pid: number) {
  positivePid(pid);
  const started = psField(pid, "lstart");
  if (!started) return null;
  const command = psField(pid, "command");
  const state = psField(pid, "stat");
  if (!command || !state || state.startsWith("Z") || psField(pid, "lstart") !== started)
    return null;
  return { pid, started, command, state };
}
function matchingChildIdentity(pid: number, role: ProcessRole) {
  const command = psField(pid, "command");
  if (!command) return null;
  const expected = role === "helper" ? `${app} --portcove-apply-update ` : app;
  if (role === "helper" ? !command.startsWith(expected) : command !== expected) return null;
  // A matching child is re-read with its start identity; ambiguity fails.
  return processIdentity(pid, role);
}
function listenerPid(port: number) {
  try {
    const value = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^\d+$/u.test(value) ? Number(value) : null;
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1)
      return null;
    throw error;
  }
}
function childPids(pid: number) {
  try {
    const output = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output
      .split(/\s+/u)
      .map(Number)
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1)
      return [];
    throw error;
  }
}
async function naturalExit(marker: ProcessMarker, role: ProcessRole): Promise<NaturalExit> {
  const original = processIdentity(marker.process_id, role);
  await waitFor(
    async () => {
      const current = processIdentity(marker.process_id, role);
      return !current || (original && current.started !== original.started) ? true : null;
    },
    `${role} natural exit`,
    30_000,
  );
  return { observed_live: original, no_owned_process_remaining: true };
}
async function stopOwned(value: unknown, role: ProcessRole) {
  const marker = ownedMarker(value);
  if (!marker) return;
  const original = processIdentity(marker.process_id, role);
  if (!original) return;
  process.kill(marker.process_id, "SIGTERM");
  try {
    await waitFor(
      async () => {
        const current = processIdentity(marker.process_id, role);
        return !current || current.started !== original.started ? true : null;
      },
      `${role} cleanup`,
      5000,
    );
  } catch {
    const current = processIdentity(marker.process_id, role);
    if (current?.started === original.started) process.kill(marker.process_id, "SIGKILL");
    await waitFor(
      async () => !processIdentity(marker.process_id, role),
      `${role} forced cleanup`,
      5000,
    );
  }
}
async function freezeCaptureAndStop(
  pid: number,
  role: ProcessRole,
  childRole: ProcessRole,
): Promise<ProcessIdentity[]> {
  const original = processIdentity(pid, role);
  if (!original) return [];
  let children: ProcessIdentity[] = [];
  let failure: { error: unknown } | undefined;
  try {
    process.kill(pid, "SIGSTOP");
    await waitFor(
      async () => processIdentity(pid, role)?.state.includes("T"),
      `${role} stopped for child capture`,
      5000,
    );
    children = childPids(pid)
      .map((child) => matchingChildIdentity(child, childRole))
      .filter((child) => child !== null);
  } catch (error) {
    failure = { error };
  } finally {
    try {
      if (processIdentity(pid, role)?.started === original.started) process.kill(pid, "SIGKILL");
      await waitFor(async () => !processIdentity(pid, role), `${role} forced exit`, 5000);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return children;
}
async function stopHelper(value: unknown): Promise<ProcessIdentity[]> {
  const marker = ownedMarker(value);
  if (!marker) return [];
  const original = processIdentity(marker.process_id, "helper");
  if (!original) return [];
  try {
    await waitFor(
      async () => !processIdentity(marker.process_id, "helper"),
      "helper natural cleanup",
      30_000,
    );
    return [];
  } catch {
    // Freeze this exact helper before reading its children. It cannot spawn a
    // candidate between that read and the forced helper exit.
  }
  const current = processIdentity(marker.process_id, "helper");
  if (!current || current.started !== original.started) return [];
  return freezeCaptureAndStop(marker.process_id, "helper", "candidate");
}
const port = await availablePort();
report.webdriver_port = port;
const application = spawn(app, [], {
  env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const applicationExit = new Promise<ApplicationExit>((resolve) => {
  application.once("exit", (code, signal) => resolve({ code, signal }));
});
async function bounded<Value>(
  promise: PromiseLike<Value>,
  label: string,
  timeoutMs: number,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function captureFailureState(browser: WebDriver | undefined) {
  if (!browser) return;
  try {
    const state = await bounded(
      executeBrowserScript(browser, () => ({
        title: document.title,
        main_text: document.querySelector("main")?.textContent?.slice(0, 8000),
        navigation: [
          ...document.querySelectorAll('nav[aria-label="Primary navigation"] button'),
        ].map((button) => ({
          text: button.textContent,
          current: button.getAttribute("aria-current"),
        })),
        update_article_count: document.querySelectorAll(
          'article[aria-labelledby="application-update-settings-title"]',
        ).length,
      })),
      "failure DOM capture",
      10_000,
    );
    await writeFile(
      path.join(evidenceDirectory, "failure-state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  } catch (error) {
    report.failure_dom_capture = String(error);
  }
  try {
    await writeFile(
      path.join(evidenceDirectory, "failure-state.png"),
      await bounded(browser.takeScreenshot(), "failure screenshot", 10_000),
      "base64",
    );
  } catch (error) {
    report.failure_screenshot = String(error);
  }
}
let output = "";
for (const stream of [application.stdout, application.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output = (output + chunk).slice(-1024 * 1024);
  });
}
application.on("error", (error) => {
  output += `\nspawn: ${error.message}`;
});
report.predecessor_process_id = application.pid;
let browser: WebDriver | undefined;
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
  assert.ok(application.pid);
  report.predecessor_identity = processIdentity(application.pid, "candidate");
  assert.ok(report.predecessor_identity, "Installed predecessor identity was not observed");
  report.ordinary_staging = await bounded(
    driveInstalledUpdateToRestart(browser, report.actions, candidateVersion),
    "installed renderer journey",
    180_000,
  );
  report.staged = await verifyInstalledUpdateStaging({
    stagingRoot: staging,
    payloadName: "candidate.payload",
    candidateSha: archiveSha,
    candidateVersion,
    application: app,
    initialSha,
  });
  report.actions.push("installed-renderer-verified-candidate");
  await writeFile(
    path.join(evidenceDirectory, "before-restart.png"),
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
    report.restart_click = `session-ended: ${String(errorMessage(error)).slice(0, 300)}`;
  }
  const ended = await bounded(applicationExit, "installed predecessor exit", 30_000);
  assert.deepEqual(ended, { code: 0, signal: null });
  report.predecessor_exit = ended;
  report.helper = processMarker(
    await waitFor(() => readJson(helperMarker), "restart helper marker", 30_000),
  );
  assert.equal(report.helper.schema_version, 1);
  assert.equal(report.helper.executable, app);
  assert.ok(Number.isInteger(report.helper.process_id) && report.helper.process_id > 0);
  report.helper_identity = processIdentity(report.helper.process_id, "helper");
  report.relaunch = processMarker(
    await waitFor(() => readJson(relaunchMarker), "automatic relaunch marker", 60_000),
  );
  assert.equal(report.relaunch.schema_version, 1);
  assert.equal(report.relaunch.executable, app);
  assert.ok(Number.isInteger(report.relaunch.process_id) && report.relaunch.process_id > 0);
  report.relaunch_identity = processIdentity(report.relaunch.process_id, "candidate");
  report.startup = await waitFor(
    async () => {
      const marker = object(await readJson(stageMarker));
      return marker.stage === "Tauri setup"
        ? { ...marker, stage: "Tauri setup" as const, process_id: positivePid(marker.process_id) }
        : null;
    },
    "relaunch healthy startup",
    60_000,
  );
  assert.equal(report.startup.process_id, report.relaunch.process_id);
  await waitFor(
    async () => {
      const apply = object(await readJson(path.join(staging, "apply.json")));
      return apply.intent === null && apply.native_launch === null ? true : null;
    },
    "relaunch journal reconciliation",
    30_000,
  );
  assert.equal((await hashFile(app)).sha256, candidateSha);
  assert.equal((await hashFile(libraryMarker)).sha256, librarySha);
  await assert.rejects(stat(path.join(staging, "candidate.payload")), { code: "ENOENT" });
  report.helper_exit = await naturalExit(report.helper, "helper");
  report.relaunch_exit = await naturalExit(report.relaunch, "candidate");
  report.actions.push("installed-helper-relaunched-candidate-and-reconciled");
  report.phase = "complete";
} catch (error) {
  report.phase = "failed";
  const stack =
    error !== null && (typeof error === "object" || typeof error === "function") && "stack" in error
      ? error.stack
      : undefined;
  report.failure = String(stack ?? error);
  await captureFailureState(browser);
  throw error;
} finally {
  await writeFile(path.join(evidenceDirectory, "application.log"), output);
  let unmarkedHelper: ProcessIdentity | undefined;
  if (application.exitCode === null && application.signalCode === null) {
    try {
      assert.ok(application.pid);
      const identity = processIdentity(application.pid, "candidate");
      const identityChanged =
        identity &&
        report.predecessor_identity &&
        identity.started !== report.predecessor_identity.started;
      if (identityChanged) {
        report.cleanup_failure = "Predecessor identity changed before cleanup";
        report.phase = "failed";
      } else if (identity) {
        unmarkedHelper = (await freezeCaptureAndStop(application.pid, "candidate", "helper"))[0];
      }
      if (!identityChanged) await bounded(applicationExit, "owned predecessor cleanup", 5000);
    } catch (error) {
      report.cleanup_failure = String(error);
      report.phase = "failed";
    }
  }
  const helper =
    report.helper ??
    (await readJson(helperMarker).catch(() => null)) ??
    (unmarkedHelper && {
      schema_version: 1,
      process_id: unmarkedHelper.pid,
      executable: app,
    });
  let unmarkedCandidates: ProcessIdentity[] = [];
  try {
    unmarkedCandidates = await stopHelper(helper);
  } catch (error) {
    report.cleanup_failure = String(error);
    report.phase = "failed";
  }
  // The helper is now gone, so it cannot create another candidate after this
  // marker read. Include a child captured while an unresponsive helper was stopped.
  const candidate = report.relaunch ?? (await readJson(relaunchMarker).catch(() => null));
  const candidateMarkers = [
    candidate,
    ...unmarkedCandidates.map((identity) => ({
      schema_version: 1,
      process_id: identity.pid,
      executable: app,
    })),
  ];
  for (const marker of candidateMarkers) {
    try {
      await stopOwned(marker, "candidate");
      const owned = ownedMarker(marker);
      if (owned && processIdentity(owned.process_id, "candidate"))
        report.cleanup_failure = "Candidate remained live after owned cleanup";
    } catch (error) {
      report.cleanup_failure = String(error);
    }
    if (report.cleanup_failure) report.phase = "failed";
  }
  await save();
  // The browser session belongs to the exited predecessor. Quitting it after
  // restart can race the helper, so the process exit is the cleanup proof.
  void browser;
}
if (report.phase !== "complete") throw new Error(report.cleanup_failure ?? report.failure);
