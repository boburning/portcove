import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const nativeSessionScript = fileURLToPath(new URL("./native-session.ps1", import.meta.url));

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

// Ephemeral harness ownership, never durable operation or product authority.
export class OwnedNativeSession {
  driver: CapturedNativeProcess | undefined;
  inventory: string | undefined;
  cleanup: NativeSessionCleanup | undefined;

  beginLaunch() {
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
}
