import assert from "node:assert/strict";
import { executeBrowserScript } from "./browser-script.mts";
import type { WebDriver } from "selenium-webdriver";
import { errorCode, errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ChildProcess,
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "node:child_process";

/** Read the shipping, sanitized status command without installing an IPC hook,
 * changing updater configuration or supplying a replacement transport.
 * The product query performs its normal state reconciliation. Retain raw fault
 * preimages before application startup or this query, not afterwards. */
export async function readInstalledUpdateStatus(
  browser: WebDriver,
): Promise<Record<string, unknown> & { recovery_required: unknown[] }> {
  const raw = await browser.executeAsyncScript<string>((done: (value: string) => void) => {
    const bridge = (
      window as Window & { __TAURI_INTERNALS__?: { invoke(command: string): Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    if (!bridge) return done('{"ok":false}');
    void bridge.invoke("get_application_update_status").then(
      (value) => {
        const result = JSON.stringify({ ok: true, value });
        done(result.length <= 16384 ? result : '{"ok":false}');
      },
      () => done('{"ok":false}'),
    );
  });
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536);
  const result: unknown = JSON.parse(raw);
  assert.ok(isRecord(result) && result.ok === true && isRecord(result.value));
  const status = result.value;
  assert.ok(Array.isArray(status.recovery_required));
  assert.ok(status.staged === null || isRecord(status.staged));
  assert.ok(status.apply === null || isRecord(status.apply));
  return { ...status, recovery_required: status.recovery_required };
}

/** Observe saved updater choices through the existing fixed shipping query. */
export async function readInstalledUpdatePreferences(browser: WebDriver) {
  const raw = await browser.executeAsyncScript<string>((done: (value: string) => void) => {
    const bridge = (
      window as Window & { __TAURI_INTERNALS__?: { invoke(command: string): Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    if (!bridge) return done('{"ok":false}');
    void bridge.invoke("get_application_update_preferences").then(
      (value) => {
        const result = JSON.stringify({ ok: true, value });
        done(result.length <= 16384 ? result : '{"ok":false}');
      },
      () => done('{"ok":false}'),
    );
  });
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536);
  const result: unknown = JSON.parse(raw);
  assert.ok(isRecord(result) && result.ok === true && isRecord(result.value));
  assert.ok(Number.isSafeInteger(result.value.revision) && isRecord(result.value.choice));
  return result.value;
}

export async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    assert.ok(Buffer.isBuffer(chunk));
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes: (await stat(file)).size };
}

export async function waitFor<Value>(
  predicate: () => Promise<Value>,
  label: string,
  deadlineMs = 60_000,
): Promise<NonNullable<Value>> {
  const untilMs = Date.now() + deadlineMs;
  while (Date.now() < untilMs) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not complete within ${deadlineMs} ms`);
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

export function startInstalledUpdateDriver(
  driverPath: string,
  nativeDriverPath: string,
  options: Omit<SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>, "stdio"> = {},
) {
  const driver = spawn(
    driverPath,
    ["--port", "45770", "--native-port", "45771", "--native-driver", nativeDriverPath],
    { stdio: ["ignore", "pipe", "pipe"], ...options },
  );
  const output = { driver, log: "" };
  output.driver.on("error", (error) => {
    output.log += `\nspawn: ${error.message}`;
  });
  for (const stream of [output.driver.stdout, output.driver.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.log = (output.log + chunk.toString()).slice(-1024 * 1024);
    });
  return output;
}

type InstalledDriver = Pick<ChildProcess, "exitCode" | "pid">;
export function awaitInstalledUpdateDriver(driver: InstalledDriver): Promise<true>;
export function awaitInstalledUpdateDriver<Value>(
  driver: InstalledDriver,
  identify: (pid: number) => Value | Promise<Value>,
): Promise<NonNullable<Value>>;
export async function awaitInstalledUpdateDriver(
  driver: InstalledDriver,
  identify: (pid: number) => unknown = () => true,
) {
  return waitFor(
    async () => {
      if (driver.exitCode !== null) throw new Error(`tauri-driver exited ${driver.exitCode}`);
      const response = await fetch("http://127.0.0.1:45770/status", {
        signal: AbortSignal.timeout(500),
      });
      assert.ok(driver.pid);
      return response.ok ? identify(driver.pid) : null;
    },
    "tauri-driver startup",
    10_000,
  );
}

export async function connectInstalledUpdateDriver(application: string, profile?: string) {
  const { Builder } = await import("selenium-webdriver");
  if (process.platform === "win32")
    assert.ok(profile && path.isAbsolute(profile), "Windows WebView2 profile must be absolute");
  return new Builder()
    .disableEnvironmentOverrides()
    .usingServer("http://127.0.0.1:45770")
    .withCapabilities({
      browserName: process.platform === "win32" ? "webview2" : "wry",
      "tauri:options": {
        application,
        ...(process.platform === "win32" ? { webviewOptions: { userDataFolder: profile } } : {}),
      },
    })
    .build();
}

export async function verifyInstalledUpdateStaging({
  stagingRoot,
  payloadName,
  candidateSha,
  candidateVersion,
  application,
  initialSha,
}: {
  stagingRoot: string;
  payloadName: string;
  candidateSha: string;
  candidateVersion: string;
  application: string;
  initialSha: string;
}) {
  const staged = await hashFile(path.join(stagingRoot, payloadName));
  const staging = object(await readJson(path.join(stagingRoot, "staging.json")));
  const release = object(object(staging.candidate).release);
  assert.equal(staging.phase, "verified");
  assert.equal(staged.sha256, candidateSha);
  assert.equal(staged.bytes, object(release.artifact).bytes);
  assert.equal(release.version, candidateVersion);
  assert.equal((await hashFile(application)).sha256, initialSha);
  return staged;
}

export interface InstalledUpdateFailure {
  phase: string;
  failure: string | null;
  helper_failure?: unknown;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export async function recordInstalledUpdateFailure(
  report: InstalledUpdateFailure,
  error: unknown,
  helperMarker: string,
) {
  report.phase = "failed";
  const stack =
    error !== null && (typeof error === "object" || typeof error === "function") && "stack" in error
      ? error.stack
      : undefined;
  report.failure = String(stack ?? error);
  report.helper_failure = await readJson(
    path.join(path.dirname(helperMarker), "helper-failure.json"),
  ).catch(() => null);
}

export interface AppImageProcessIdentity {
  pid: number;
  start_ticks: string;
  command: string;
}
export interface AppImageProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}

export async function readAppImageProcessIdentity(
  pid: number,
  read: (file: string, encoding: "utf8") => Promise<string> = readFile,
): Promise<AppImageProcessIdentity | null> {
  try {
    const raw = await read(`/proc/${pid}/stat`, "utf8");
    const rest = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const command = (await read(`/proc/${pid}/cmdline`, "utf8"))
      .replaceAll("\0", " ")
      .slice(0, 400);
    return rest[0] !== "Z" && rest[19] ? { pid, start_ticks: rest[19], command } : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw error;
  }
}

export function createAppImageProcessObservations(
  {
    app,
    stageMarker,
    relaunchMarker,
    helperMarker,
  }: {
    app: string;
    stageMarker: string;
    relaunchMarker: string;
    helperMarker: string;
  },
  {
    read = readFile,
    identify = (pid: number) => readAppImageProcessIdentity(pid, read),
  }: {
    read?: (file: string, encoding: "utf8") => Promise<string>;
    identify?: (pid: number) => Promise<AppImageProcessIdentity | null>;
  } = {},
) {
  const procIdentity = identify;
  async function verifiedRelaunchIdentity(marker: AppImageProcessMarker) {
    assert.equal(marker?.schema_version, 1, "Relaunch process marker schema changed");
    assert.ok(Number.isInteger(marker.process_id) && marker.process_id > 0);
    assert.equal(marker.executable, app, "Relaunch process marker executable changed");
    const identity = await procIdentity(marker.process_id);
    if (!identity) return null;
    const environment = await readRelaunchEnvironment(identity);
    if (!environment) return null;
    const after = await procIdentity(marker.process_id);
    if (!after) return null;
    assert.equal(after.start_ticks, identity.start_ticks, "Relaunched process identity changed");
    assertRelaunchEnvironment(environment);
    return after;
  }
  async function readRelaunchEnvironment(identity: AppImageProcessIdentity) {
    let environment;
    try {
      environment = (await read(`/proc/${identity.pid}/environ`, "utf8")).split("\0");
    } catch (error) {
      const after = await procIdentity(identity.pid);
      if (!after) return null;
      if (after.start_ticks !== identity.start_ticks)
        throw new Error("Relaunched process identity changed while reading its environment");
      throw error;
    }
    return environment;
  }
  function assertRelaunchEnvironment(environment: string[]) {
    for (const expected of [
      `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE=${stageMarker}`,
      `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS=${relaunchMarker}`,
      "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation",
    ])
      if (!environment.includes(expected))
        throw new Error("Relaunched process did not retain the exact qualification identity");
  }
  async function verifiedHelperIdentity(marker: AppImageProcessMarker) {
    assert.equal(marker?.schema_version, 1, "Helper process marker schema changed");
    assert.ok(Number.isInteger(marker.process_id) && marker.process_id > 0);
    const identity = await procIdentity(marker.process_id);
    if (!identity) return null;
    const environment = await readRelaunchEnvironment(identity);
    if (!environment) return null;
    const after = await procIdentity(marker.process_id);
    if (!after) return null;
    assert.equal(after.start_ticks, identity.start_ticks, "Helper process identity changed");
    assert.ok(
      after.command.includes("--portcove-apply-update"),
      "Marked process is not the helper",
    );
    assert.ok(
      environment.includes(
        `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS=${helperMarker}`,
      ),
      "Helper process lost its qualification identity",
    );
    return after;
  }
  return { procIdentity, verifiedRelaunchIdentity, verifiedHelperIdentity };
}

/** One observation; polling and process cleanup remain with the native harness. */
export async function observeHealthyAppImageRestart(
  {
    app,
    candidateSha,
    staging,
    stageMarker,
    stagedPayload,
  }: {
    app: string;
    candidateSha: string;
    staging: string;
    stageMarker: string;
    stagedPayload: string;
  },
  {
    read = readJson,
    hash = hashFile,
    inspect = stat,
  }: {
    read?: (file: string) => Promise<unknown>;
    hash?: (file: string) => Promise<{ sha256: string }>;
    inspect?: (file: string) => Promise<unknown>;
  } = {},
) {
  const marker = await read(stageMarker);
  assert.ok(isRecord(marker));
  if (marker.stage !== "Tauri setup") return null;
  const processId = marker.process_id;
  assert.ok(typeof processId === "number" && Number.isSafeInteger(processId) && processId > 0);
  if ((await hash(app)).sha256 !== candidateSha) return null;
  const apply = await read(path.join(staging, "apply.json"));
  assert.ok(isRecord(apply));
  if (apply.intent !== null) return null;
  try {
    await inspect(stagedPayload);
    return null;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    /* retired after healthy startup */
  }
  return {
    marker: { ...marker, stage: "Tauri setup" as const, process_id: processId },
    apply_phase: apply.phase,
    stable_sha256: candidateSha,
  };
}

/** Keep the existing reconciliation label and finite polling budget together. */
export function waitForHealthyAppImageRestart(
  context: Parameters<typeof observeHealthyAppImageRestart>[0],
  options: NonNullable<Parameters<typeof observeHealthyAppImageRestart>[1]> & {
    poll?: typeof waitFor;
  } = {},
) {
  const { poll = waitFor, ...observation } = options;
  return poll(
    () => observeHealthyAppImageRestart(context, observation),
    "renderer-driven restart and healthy-startup reconciliation",
    90_000,
  );
}

export interface WindowsUpdateProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}
export interface WindowsUpdateProcessObservation {
  status: "captured" | "exited" | "prior-process-exited" | "stopped";
  pid: number;
  path?: string;
}

export interface WindowsUpdateExitObservation {
  status: "exit-observed" | "unobserved" | "timeout";
  pid: number;
  exit_code: number | null;
}
export function readWindowsUpdateExitObservation(value: unknown): WindowsUpdateExitObservation {
  const raw = object(value);
  const status = raw.status;
  let exitCode: number | null = null;
  assert.ok(status === "exit-observed" || status === "unobserved" || status === "timeout");
  if (status === "exit-observed") {
    assert.ok(typeof raw.exit_code === "number" && Number.isInteger(raw.exit_code));
    assert.ok(raw.exit_code >= -2_147_483_648 && raw.exit_code <= 2_147_483_647);
    assert.equal(raw.observation, "retained-process-handle");
    exitCode = raw.exit_code;
  } else assert.equal(raw.exit_code, null);
  return { ...raw, status, pid: installedUpdatePid(raw.pid), exit_code: exitCode };
}

export type WindowsUpdateExitCapture =
  | { kind: "observation"; observation: WindowsUpdateExitObservation }
  | { kind: "failed"; error: string; stdout: string; stderr: string };

/** Read-only observer of one already identity-bound helper. It never stops the
 * helper; cancellation owns only the observer child and drains its result. */
export function startWindowsUpdateExitObservation(script: string, args: string[]) {
  let child: ChildProcess | undefined;
  const result = new Promise<WindowsUpdateExitCapture>((resolve) => {
    child = execFile(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", script, "-Mode", "ObserveExit", ...args],
      { encoding: "utf8", windowsHide: true, timeout: 95_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ kind: "failed", error: errorMessage(error), stdout, stderr });
          return;
        }
        try {
          resolve({
            kind: "observation",
            observation: readWindowsUpdateExitObservation(JSON.parse(stdout)),
          });
        } catch (failure) {
          resolve({ kind: "failed", error: errorMessage(failure), stdout, stderr });
        }
      },
    );
  });
  assert.ok(child);
  const observer = child;
  return {
    result,
    cancel: () => {
      if (observer.exitCode === null && observer.signalCode === null) observer.kill();
    },
  };
}

function installedUpdatePid(value: unknown, message?: string): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0, message);
  return value;
}
export function readWindowsUpdateProcessMarker(value: unknown): WindowsUpdateProcessMarker {
  const marker = object(value);
  assert.equal(marker.schema_version, 1);
  assert.ok(typeof marker.executable === "string" && path.win32.isAbsolute(marker.executable));
  return {
    ...marker,
    schema_version: 1,
    process_id: installedUpdatePid(marker.process_id),
    executable: marker.executable,
  };
}
export function readWindowsUpdateProcessObservation(
  value: unknown,
): WindowsUpdateProcessObservation {
  const observation = object(value);
  const status = observation.status;
  assert.ok(
    status === "captured" ||
      status === "exited" ||
      status === "prior-process-exited" ||
      status === "stopped",
  );
  const result: WindowsUpdateProcessObservation = {
    ...observation,
    status,
    pid: installedUpdatePid(observation.pid),
  };
  if (observation.path !== undefined) {
    assert.ok(typeof observation.path === "string" && path.win32.isAbsolute(observation.path));
    result.path = observation.path;
  }
  return result;
}

export function readMacInstalledProcessField(
  pid: number,
  field: "lstart" | "command" | "stat",
  read: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
  ) => string = execFileSync,
) {
  try {
    return read("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1)
      return null;
    throw error;
  }
}

export type MacInstalledProcessRole = "candidate" | "helper";
export interface MacInstalledProcessIdentity {
  pid: number;
  started: string;
  command: string;
  state: string;
}
export interface MacInstalledProcessMarker {
  schema_version: 1;
  process_id: number;
  executable: string;
}

/** Installed-harness control only. Every process observation, signal and wait is
 * explicitly supplied by the caller; construction performs no native work. */
export function createMacInstalledProcessCleanup(
  app: string,
  {
    processIdentity,
    matchingChildIdentity,
    childPids,
    signal,
    waitFor,
  }: {
    processIdentity: (
      pid: number,
      role: MacInstalledProcessRole,
    ) => MacInstalledProcessIdentity | null;
    matchingChildIdentity: (
      pid: number,
      role: MacInstalledProcessRole,
    ) => MacInstalledProcessIdentity | null;
    childPids: (pid: number) => number[];
    signal: (pid: number, signal: NodeJS.Signals) => void;
    waitFor: (read: () => Promise<unknown>, label: string, timeoutMs: number) => Promise<unknown>;
  },
) {
  function positivePid(value: unknown): number {
    return installedUpdatePid(value, "Invalid owned process marker PID");
  }
  function processMarker(value: unknown): MacInstalledProcessMarker {
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
  function ownedMarker(value: unknown): MacInstalledProcessMarker | null {
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
  async function stopOwned(value: unknown, role: MacInstalledProcessRole) {
    const marker = ownedMarker(value);
    if (!marker) return;
    const original = processIdentity(marker.process_id, role);
    if (!original) return;
    signal(marker.process_id, "SIGTERM");
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
      if (current?.started === original.started) signal(marker.process_id, "SIGKILL");
      await waitFor(
        async () => !processIdentity(marker.process_id, role),
        `${role} forced cleanup`,
        5000,
      );
    }
  }
  async function freezeCaptureAndStop(
    pid: number,
    role: MacInstalledProcessRole,
    childRole: MacInstalledProcessRole,
  ): Promise<MacInstalledProcessIdentity[]> {
    const original = processIdentity(pid, role);
    if (!original) return [];
    let children: MacInstalledProcessIdentity[] = [];
    let failure: { error: unknown } | undefined;
    try {
      signal(pid, "SIGSTOP");
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
        if (processIdentity(pid, role)?.started === original.started) signal(pid, "SIGKILL");
        await waitFor(async () => !processIdentity(pid, role), `${role} forced exit`, 5000);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
    return children;
  }

  return { positivePid, processMarker, ownedMarker, stopOwned, freezeCaptureAndStop };
}

/** Relative worker authority remains Windows-specific even in portable tests. */
export function windowsUpdateWorkerRelativePath(staging: string, executable: string) {
  return path.win32
    .relative(path.win32.toNamespacedPath(staging), path.win32.toNamespacedPath(executable))
    .replaceAll("\\", "/");
}

export interface WindowsUpdateMarkedCleanup {
  capture: WindowsUpdateProcessObservation;
  stop: WindowsUpdateProcessObservation | null;
}

/** Decide marker cleanup through required caller-owned read/process capabilities.
 * The native provider owns actual PID/birth/path verification and stop effects. */
export async function cleanupWindowsUpdateMarkedProcess({
  markerPath,
  label,
  staging,
  app,
  output,
  restartStarted,
  readJson,
  command,
}: {
  markerPath: string;
  label: "candidate" | "helper";
  staging: string;
  app: string;
  output: string;
  restartStarted: string | undefined;
  readJson: (file: string) => Promise<unknown>;
  command: (mode: "Capture" | "Stop", args: string[]) => WindowsUpdateProcessObservation;
}): Promise<WindowsUpdateMarkedCleanup | { status: "marker-absent" }> {
  const rawMarker = await readJson(markerPath).catch(() => null);
  if (!rawMarker) return { status: "marker-absent" };
  const marker = readWindowsUpdateProcessMarker(rawMarker);
  const expected = label === "candidate" ? app : marker.executable;
  if (label === "helper") {
    const relative = windowsUpdateWorkerRelativePath(staging, expected);
    assert.match(relative, /^workers\/revision-\d+\/attempt-[^/]+\/portcove-update-worker\.exe$/iu);
  }
  const identityPath = path.join(output, `${label}-process-identity.json`);
  const capturedEarlier = await readJson(identityPath).catch(() => null);
  assert.ok(restartStarted, "Restart timestamp required for marked-process capture");
  const capture: WindowsUpdateProcessObservation = capturedEarlier
    ? { status: "captured", pid: installedUpdatePid(object(capturedEarlier).pid) }
    : command("Capture", [
        "-MarkerPath",
        markerPath,
        "-IdentityPath",
        identityPath,
        "-ExpectedPath",
        expected,
        "-EarliestStart",
        restartStarted,
        ...(label === "helper" ? ["-Helper"] : []),
      ]);
  return {
    capture,
    stop: capture.status === "captured" ? command("Stop", ["-IdentityPath", identityPath]) : null,
  };
}

/** Install the observation hook through the real browser serialization boundary. */
export async function installWindowsUpdateRestartHook(browser: Pick<WebDriver, "executeScript">) {
  await executeBrowserScript(browser, () => {
    const runtime = window as Window & {
      __TAURI_INTERNALS__?: {
        invoke(command: string, args?: unknown, options?: unknown): Promise<unknown>;
      };
      __portcoveRestartResult?: unknown;
    };
    const internals = runtime.__TAURI_INTERNALS__;
    if (!internals) throw new Error("Native bridge unavailable");
    const original = internals.invoke.bind(internals);
    runtime.__portcoveRestartResult = null;
    internals.invoke = (command, args, options) => {
      const result = original(command, args, options);
      if (command === "restart_to_apply_application_update") {
        void result.then(
          () => {
            runtime.__portcoveRestartResult = { ok: true };
          },
          (error: unknown) => {
            runtime.__portcoveRestartResult = {
              ok: false,
              code:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "code" in error
                  ? error.code
                  : undefined,
              message:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "message" in error
                  ? error.message
                  : undefined,
              details:
                error !== null &&
                (typeof error === "object" || typeof error === "function") &&
                "details" in error
                  ? error.details
                  : undefined,
            };
          },
        );
      }
      return result;
    };
  });
}
