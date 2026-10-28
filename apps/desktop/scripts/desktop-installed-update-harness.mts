import assert from "node:assert/strict";
import type { WebDriver } from "selenium-webdriver";
import { errorCode, isRecord } from "../../../scripts/runtime-values.mts";
import { spawn } from "node:child_process";
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
