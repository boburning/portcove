import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const nativeSessionScript = fileURLToPath(new URL("./native-session.ps1", import.meta.url));
export const ownedGameWindowScript = fileURLToPath(
  new URL("./owned-game-window.ps1", import.meta.url),
);
export const sopwithKnownFolderScript = fileURLToPath(
  new URL("./sopwith-known-folder.ps1", import.meta.url),
);

export interface CapturedNativeProcess {
  pid: number;
  path: string;
  started_filetime: string;
}
export interface NativeProcessSnapshot {
  captured_at: string;
  driver: CapturedNativeProcess;
  application_pid: number | null;
  processes: CapturedNativeProcess[];
}
export interface NativeExitObservation {
  exited_at: string;
  observed_processes: number;
  wait_ms: number;
}
export interface NativeCloseObservation {
  requested_at: string;
  application_pid: number;
  started_filetime: string;
  method: "identity-bound-native-main-window-close-request";
  message_sent: true;
}
export interface NativeCurrentObservation {
  observed_at: string;
  processes: (CapturedNativeProcess & { state: "running" | "exited" })[];
}
interface NativeDriverStopObservation {
  stopped_at: string;
  driver_pid: number;
  method: "identity-bound-isolated-tree-termination";
  terminated_survivors: number[];
}
export type NativeStopObservation =
  | NativeDriverStopObservation
  | { method: "captured-application-survivors"; terminated_survivors: number[] };
export interface NativeSessionCleanup {
  stopped: NativeStopObservation | { method: "observed-child-exit"; exit_code: number };
  exited: NativeExitObservation;
  snapshot: string;
}
export interface NativeSessionObservations {
  Snapshot: NativeProcessSnapshot;
  SnapshotDriver: NativeProcessSnapshot;
  SnapshotDriverTree: NativeProcessSnapshot;
  SnapshotApplication: NativeProcessSnapshot & {
    root_kind: "direct-application";
    executable_sha256: string;
  };
  Wait: NativeExitObservation;
  StopDriver: NativeDriverStopObservation;
  StopApplication: NativeStopObservation;
  RequestClose: NativeCloseObservation;
  Observe: NativeCurrentObservation;
  ApplicationListener:
    | { ready: false }
    | { ready: true; pid: number; address: "127.0.0.1"; port: number; started_filetime: string };
}
export type NativeSessionMode = keyof NativeSessionObservations;
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Native observation must be an object",
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Native observation text field required");
  return value;
}
function natural(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function positive(value: unknown): number {
  const number = natural(value);
  assert.ok(number > 0, "Native PID/port must be positive");
  return number;
}
function filetime(value: unknown): string {
  const time = text(value);
  assert.match(time, /^\d+$/u);
  return time;
}
function nativeProcess(value: unknown): CapturedNativeProcess {
  const record = object(value);
  const executable = text(record.path);
  assert.ok(path.isAbsolute(executable), "Captured native executable must be absolute");
  return {
    ...record,
    pid: positive(record.pid),
    path: executable,
    started_filetime: filetime(record.started_filetime),
  };
}
/** Consumed projection of native-session.ps1 output; process actions stay in PowerShell. */
export function readNativeProcessSnapshot(value: unknown): NativeProcessSnapshot {
  const record = object(value);
  assert.ok(Array.isArray(record.processes));
  return {
    ...record,
    captured_at: text(record.captured_at),
    driver: nativeProcess(record.driver),
    application_pid: record.application_pid === null ? null : positive(record.application_pid),
    processes: record.processes.map(nativeProcess),
  };
}
export function readNativeSessionObservation<Mode extends NativeSessionMode>(
  mode: Mode,
  value: unknown,
): NativeSessionObservations[Mode];
export function readNativeSessionObservation(
  mode: NativeSessionMode,
  value: unknown,
): NativeSessionObservations[NativeSessionMode] {
  const record = object(value);
  switch (mode) {
    case "Snapshot":
    case "SnapshotDriver":
    case "SnapshotDriverTree":
      return readNativeProcessSnapshot(record);
    case "SnapshotApplication": {
      assert.equal(record.root_kind, "direct-application");
      const sha256 = text(record.executable_sha256);
      assert.match(sha256, /^[a-f0-9]{64}$/u);
      return {
        ...readNativeProcessSnapshot(record),
        root_kind: "direct-application",
        executable_sha256: sha256,
      };
    }
    case "Wait":
      return {
        ...record,
        exited_at: text(record.exited_at),
        observed_processes: natural(record.observed_processes),
        wait_ms: natural(record.wait_ms),
      };
    case "StopDriver":
    case "StopApplication": {
      assert.ok(Array.isArray(record.terminated_survivors));
      const terminated = record.terminated_survivors.map((value: unknown) => positive(value));
      if (mode === "StopApplication" && record.method === "captured-application-survivors")
        return {
          ...record,
          method: "captured-application-survivors",
          terminated_survivors: terminated,
        };
      assert.equal(record.method, "identity-bound-isolated-tree-termination");
      return {
        ...record,
        stopped_at: text(record.stopped_at),
        driver_pid: positive(record.driver_pid),
        method: "identity-bound-isolated-tree-termination",
        terminated_survivors: terminated,
      };
    }
    case "RequestClose":
      assert.equal(record.method, "identity-bound-native-main-window-close-request");
      assert.equal(record.message_sent, true);
      return {
        ...record,
        requested_at: text(record.requested_at),
        application_pid: positive(record.application_pid),
        started_filetime: filetime(record.started_filetime),
        method: "identity-bound-native-main-window-close-request",
        message_sent: true,
      };
    case "Observe":
      assert.ok(Array.isArray(record.processes));
      return {
        ...record,
        observed_at: text(record.observed_at),
        processes: record.processes.map(
          (value: unknown): CapturedNativeProcess & { state: "running" | "exited" } => {
            const process = object(value);
            const state = process.state;
            assert.ok(state === "running" || state === "exited");
            return { ...nativeProcess(process), state };
          },
        ),
      };
    case "ApplicationListener":
      assert.ok(typeof record.ready === "boolean");
      if (!record.ready) return { ...record, ready: false };
      assert.equal(record.address, "127.0.0.1");
      const port = positive(record.port);
      assert.ok(port <= 65535);
      return {
        ...record,
        ready: true,
        address: "127.0.0.1",
        port,
        pid: positive(record.pid),
        started_filetime: filetime(record.started_filetime),
      };
    default:
      throw new Error(`Unsupported native observation mode: ${String(mode)}`);
  }
}

// Ephemeral harness ownership, never durable operation or product authority.
export class OwnedNativeSession {
  private launchAttempted = false;
  driver: CapturedNativeProcess | undefined;
  inventory: string | undefined;
  cleanup: NativeSessionCleanup | undefined;

  beginLaunch() {
    this.launchAttempted = true;
    // Invalidate the former host's proof before a replacement can exist,
    // including when spawn succeeds but identity capture fails.
    this.driver = undefined;
    this.inventory = undefined;
    this.cleanup = undefined;
  }

  requireQuiescence() {
    assert.ok(this.driver, "Current owned launch identity is required");
    assert.ok(this.inventory, "Current owned exit inventory is required");
    assert.ok(this.cleanup?.exited, "Positive current owned root/descendant exit is required");
    return this.cleanup;
  }

  async releaseResources({
    closeFixtures,
    releaseLock,
  }: {
    closeFixtures: () => Promise<void>;
    releaseLock: () => Promise<void>;
  }) {
    // Missing identity after an attempted spawn is unknown, not proof that no
    // process exists. Only a pristine session can release without an exit proof.
    if (this.launchAttempted) this.requireQuiescence();
    await closeFixtures();
    await releaseLock();
  }
}
