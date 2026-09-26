// Generated from Rust event schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mjs --write

export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateCheckResultKind =
  | "consent-required"
  | "paused"
  | "manual-mode"
  | "offline"
  | "metered"
  | "metered-state-unknown"
  | "startup-delay"
  | "cadence"
  | "superseded"
  | "current"
  | "update-available"
  | "held"
  | "incompatible"
  | "no-candidate";
export type EventPortcoveLibraryChanged = null;
/**
 * Versioned best-effort progress envelope. Durable activity history remains
 * authoritative after reconnect or restart.
 */
export type EventPortcoveOperation = {
  operation: string;
  operation_id: string;
  parent_operation_id: string | null;
  schema_version: number;
  sequence: number;
  target: OperationTarget | null;
  timestamp_ms: number;
  [k: string]: unknown;
} & EventPortcoveOperation1;
export type ActivityTargetKind = "port" | "source" | "library";
export type EventPortcoveOperation1 =
  | {
      type: "started";
      [k: string]: unknown;
    }
  | {
      path: string;
      profile_id: string;
      sha256: string;
      size: number;
      type: "source_candidate";
      [k: string]: unknown;
    }
  | {
      completed: number;
      phase: string;
      total: number | null;
      type: "progress";
      [k: string]: unknown;
    }
  | {
      level: string;
      message: string;
      type: "message";
      [k: string]: unknown;
    }
  | {
      result: OperationResult;
      type: "finished";
      [k: string]: unknown;
    };
export type OperationResult = "succeeded" | "failed" | "cancelled";

export interface DesktopEventPayloads {
  "portcove://application-update-notice": EventPortcoveApplicationUpdateNotice;
  "portcove://library-changed": EventPortcoveLibraryChanged;
  "portcove://operation": EventPortcoveOperation;
}
export interface EventPortcoveApplicationUpdateNotice {
  notice: ApplicationUpdateNotice | null;
  revision: number;
  [k: string]: unknown;
}
export interface ApplicationUpdateNotice {
  preference_revision: number;
  result: ApplicationUpdateCheckResult;
  [k: string]: unknown;
}
export interface ApplicationUpdateCheckResult {
  candidate: ApplicationUpdateCandidateSummary | null;
  kind: ApplicationUpdateCheckResultKind;
  reasons: string[];
  staged: boolean;
  [k: string]: unknown;
}
export interface ApplicationUpdateCandidateSummary {
  bytes: number;
  channel: ApplicationChannel;
  version: string;
}
export interface OperationTarget {
  id: string;
  kind: ActivityTargetKind;
  [k: string]: unknown;
}
