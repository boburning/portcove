import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { readProcessIdentity } from "../../../scripts/heavy-rust-test-lock.mts";
import { isProcessAlive } from "../../../scripts/process-lock.mts";
import {
  assertOwnedUnlinkedPath,
  releasePathContains,
} from "../../../scripts/release-path-safety.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

interface BusyLibraryOptions {
  fixtureRoot: string;
  library: string;
  output: string;
  helperRoot: string;
  helper: { path: string; bytes: number; sha256: string; source_commit: string };
  portId: string;
  installationId: string;
  writerSchema: number;
  lockProtocol: string;
  environment?: NodeJS.ProcessEnv;
}

/** Read the existing compiled fixture contract instead of duplicating Core's
 * schema/protocol constants. This descriptor is qualification input, not release
 * authority or evidence that the application is running this helper's source. */
export async function describeInstalledLibraryBusyHelper(options: {
  fixtureRoot: string;
  output: string;
  helperRoot: string;
  helperPath: string;
  helperSha256: string;
  helperSource: string;
  version: string;
  environment?: NodeJS.ProcessEnv;
}) {
  assert.match(options.helperSha256, /^[a-f0-9]{64}$/u);
  assert.match(options.helperSource, /^[a-f0-9]{40}$/u);
  await assertOwnedUnlinkedPath(options.helperRoot, options.helperPath, "busy descriptor helper");
  await assertOwnedUnlinkedPath(options.fixtureRoot, options.output, "busy descriptor evidence");
  const binary = await fileIdentity(options.helperPath, { maxBytes: 128 * 1024 * 1024 });
  assert.equal(binary.sha256, options.helperSha256);
  await mkdir(options.output);
  const result = spawnSync(binary.path, ["describe", options.version], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 65_536,
    windowsHide: true,
    env: options.environment ?? process.env,
  });
  await writeFile(path.join(options.output, "stdout.txt"), result.stdout ?? "", { flag: "wx" });
  await writeFile(path.join(options.output, "stderr.txt"), result.stderr ?? "", { flag: "wx" });
  await writeFile(
    path.join(options.output, "status.json"),
    JSON.stringify(
      {
        helper: { ...binary, source_commit: options.helperSource },
        exit_code: result.status,
        signal: result.signal,
        error: result.error ? String(result.error) : null,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  const contract = object(JSON.parse(result.stdout));
  const library = object(object(contract.compatibility).library);
  assert.ok(Number.isSafeInteger(library.write_schema) && Number(library.write_schema) > 0);
  assert.ok(typeof library.lock_protocol === "string" && library.lock_protocol.length > 0);
  return {
    helper: { ...binary, source_commit: options.helperSource },
    writerSchema: Number(library.write_schema),
    lockProtocol: library.lock_protocol,
    contract,
    contract_input_version: options.version,
    scope:
      "Compiled helper compatibility only; not installed predecessor version or source evidence",
  };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Library activity helper must return an object");
  return value;
}

async function bounded<T>(task: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Qualification only. Call before renderer launch, after the normal seed and
 * observer processes have exited. The helper holds a genuine public Core update
 * activity; no fabricated database row or exclusive preflight lease is the busy
 * witness. The caller retains its original failed outcome even if cleanup works. */
export async function startInstalledLibraryBusy(options: BusyLibraryOptions) {
  assert.ok(["win32", "linux"].includes(process.platform));
  assert.match(options.helper.sha256, /^[a-f0-9]{64}$/u);
  assert.match(options.helper.source_commit, /^[a-f0-9]{40}$/u);
  assert.ok(Number.isSafeInteger(options.writerSchema) && options.writerSchema > 0);
  assert.ok(options.portId && options.installationId && options.lockProtocol);
  await assertOwnedUnlinkedPath(options.fixtureRoot, options.library, "busy library");
  await assertOwnedUnlinkedPath(options.fixtureRoot, options.output, "busy evidence");
  assert.equal(releasePathContains(options.library, options.output), false);
  await assertOwnedUnlinkedPath(options.helperRoot, options.helper.path, "busy Core helper");
  const binary = await fileIdentity(options.helper.path, { maxBytes: 128 * 1024 * 1024 });
  assert.equal(binary.bytes, options.helper.bytes);
  assert.equal(binary.sha256, options.helper.sha256);
  await mkdir(options.output); // Exclusive fresh observation directory.
  const nonce = randomBytes(32).toString("hex");
  const child = spawn(
    binary.path,
    [
      "hold-library-update",
      options.library,
      options.portId,
      options.installationId,
      nonce,
      String(options.writerSchema),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: options.environment ?? process.env },
  );
  let stdout = "";
  let stderr = "";
  let streamFailure: Error | undefined;
  let ready: Record<string, unknown> | undefined;
  let creation: string | null = null;
  let releaseTask: Promise<unknown> | undefined;
  const lines: unknown[] = [];
  let notifyLine: (() => void) | undefined;
  const firstLine = new Promise<void>((resolve) => {
    notifyLine = resolve;
  });
  const terminal = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
  }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", (error) => {
    streamFailure ??= error;
  });
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 131_072) {
      streamFailure ??= new Error("Library activity stderr exceeds its bound");
      child.stdin.end();
    } else stderr += chunk;
  });
  let consumed = 0;
  child.stdout.on("data", (chunk: string) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 131_072) {
      streamFailure ??= new Error("Library activity stdout exceeds its bound");
      child.stdin.end();
      notifyLine?.();
      return;
    }
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf("\n", consumed);
      if (end < 0) break;
      try {
        lines.push(JSON.parse(stdout.slice(consumed, end)));
      } catch (error) {
        streamFailure ??=
          error instanceof Error ? error : new Error(String(error), { cause: error });
      }
      consumed = end + 1;
      notifyLine?.();
    }
  });
  const evidence: Record<string, unknown> = {
    schema_version: 1,
    scope: "qualification-only real Core activity; no game execution or provider acquisition",
    helper: { ...binary, source_commit: options.helper.source_commit },
    library: options.library,
    port_id: options.portId,
    installation_id: options.installationId,
    phase: "starting",
  };
  async function save() {
    await writeFile(path.join(options.output, "stdout.txt"), stdout);
    await writeFile(path.join(options.output, "stderr.txt"), stderr);
    await writeFile(
      path.join(options.output, "activity-holder.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
  async function assertActive() {
    assert.ok(child.pid && ready && creation);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(
      readProcessIdentity(child.pid),
      creation,
      "Held process creation identity changed",
    );
    if (streamFailure) throw streamFailure;
  }
  async function release() {
    if (releaseTask) return releaseTask;
    releaseTask = (async () => {
      await assertActive();
      const command =
        JSON.stringify({
          schema_version: 1,
          action: "cancel-and-release",
          activity_id: ready!.activity_id,
          nonce,
        }) + "\n";
      evidence.release_requested_at = new Date().toISOString();
      await save();
      child.stdin.end(command);
      const outcome = await bounded(terminal, 30_000, "Owned Core activity settlement");
      evidence.os_exit = outcome;
      await save(); // Actual outcome and raw output precede all success assertions.
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.code, 0);
      assert.equal(outcome.signal, null);
      if (streamFailure) throw streamFailure;
      assert.equal(lines.length, 2);
      assert.equal(stdout.slice(consumed).trim(), "");
      const result = object(lines[1]);
      assert.equal(result.schema_version, 1);
      assert.equal(result.phase, "cancelled");
      assert.equal(result.process_id, child.pid);
      assert.equal(result.provider_polls, 0);
      assert.equal(result.library_idle, true);
      const activity = object(result.activity);
      assert.equal(activity.id, ready!.activity_id);
      assert.equal(activity.status, "cancelled");
      assert.equal(activity.target_id, options.portId);
      assert.ok(activity.finished_at !== null && activity.finished_at !== undefined);
      const event = object(result.finished_event);
      assert.equal(event.operation_id, ready!.activity_id);
      assert.equal(event.type, "finished");
      assert.equal(event.result, "cancelled");
      assert.equal(object(result.cancellation_acknowledged).requested, true);
      assert.equal(object(result.cancellation_acknowledged).phase, "preparing");
      evidence.result = result;
      evidence.phase = "cancelled-and-exit-observed";
      await save();
      return result;
    })().catch(async (error: unknown) => {
      evidence.phase = "failed";
      evidence.release_failure = String(error);
      evidence.failure ??= String(error);
      await save();
      throw error;
    });
    return releaseTask;
  }
  async function settleOwned() {
    try {
      if (ready) return await release();
      child.stdin.end();
      const outcome = await bounded(terminal, 30_000, "Owned helper EOF settlement");
      evidence.os_exit = outcome;
      if (!evidence.failure) evidence.phase = "unaccepted-helper-settled";
      await save();
      return outcome;
    } catch (error) {
      evidence.settlement_error = String(error);
      // The pipe belongs to the original child even when PID identity inspection
      // fails. EOF cannot signal a foreign/reused PID. An invalid/missing release
      // makes the helper exit 86 without inventing a Core terminal result.
      child.stdin.end();
      try {
        evidence.os_exit = await bounded(terminal, 30_000, "Owned helper fallback EOF");
      } catch (outcomeError) {
        evidence.os_exit_unknown = String(outcomeError);
      }
      await save();
      throw error;
    }
  }
  try {
    await bounded(
      Promise.race([firstLine, terminal.then(() => {})]),
      20_000,
      "Core activity Ready",
    );
    if (streamFailure) throw streamFailure;
    assert.ok(child.pid);
    assert.equal(lines.length, 1, "Ready must be the sole helper record before release");
    assert.equal(stdout.slice(consumed), "", "Ready has unexpected trailing output");
    const observed = object(lines[0]);
    assert.equal(observed.schema_version, 1);
    assert.equal(observed.phase, "ready");
    assert.equal(observed.process_id, child.pid);
    assert.equal(typeof observed.library, "string");
    assert.equal(
      path.toNamespacedPath(path.resolve(String(observed.library))),
      path.toNamespacedPath(path.resolve(options.library)),
    );
    assert.equal(observed.port_id, options.portId);
    assert.equal(observed.installation_id, options.installationId);
    assert.equal(observed.nonce, nonce);
    assert.equal(observed.writer_schema, options.writerSchema);
    assert.equal(observed.lock_protocol, options.lockProtocol);
    assert.equal(observed.activity_liveness, "active");
    assert.ok(typeof observed.activity_id === "string" && observed.activity_id.length > 0);
    creation = readProcessIdentity(child.pid);
    assert.ok(creation);
    assert.equal(
      (await fileIdentity(binary.path, { maxBytes: 128 * 1024 * 1024 })).sha256,
      binary.sha256,
    );
    ready = observed;
    await assertActive();
    evidence.ready = ready;
    evidence.process_identity = creation;
    evidence.phase = "ready";
    await save();
    return { ready, evidence, assertActive, release, settleOwned };
  } catch (error) {
    evidence.phase = "failed";
    evidence.startup_failure = String(error);
    evidence.failure ??= String(error);
    try {
      await settleOwned();
    } catch (settlement) {
      throw new AggregateError([error, settlement], "Core holder startup and settlement failed");
    }
    evidence.phase = "failed";
    await save();
    throw error;
  }
}
