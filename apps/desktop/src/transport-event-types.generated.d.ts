// Generated from Rust event schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mts --write

/**
 * The application release feed a player follows. Beta is the default; Preview
 * is an opt-in feed that receives builds before Beta.
 */
export type ApplicationUpdateChannel = "beta" | "preview";
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
      /**
       * Stable producer identity, independent of translated display wording.
       */
      phase_id?: string | null;
      total: number | null;
      type: "progress";
      /**
       * Absent on older producers; clients must not infer it from phase text.
       */
      unit?: ProgressUnit | null;
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
export type ProgressUnit = "bytes" | "items" | "ports" | "indeterminate";
export type OperationResult = "succeeded" | "failed" | "cancelled";

export interface DesktopEventPayloads {
  "portcove://application-update-notice": EventPortcoveApplicationUpdateNotice;
  "portcove://library-changed": EventPortcoveLibraryChanged;
  "portcove://operation": EventPortcoveOperation;
}
export interface EventPortcoveApplicationUpdateNotice {
  available: ApplicationUpdateAvailable | null;
  checking: boolean;
  current_version: string;
  installing: boolean;
  last_checked_unix_seconds: number | null;
  [k: string]: unknown;
}
/**
 * A newer signed release announced by the channel feed.
 */
export interface ApplicationUpdateAvailable {
  channel: ApplicationUpdateChannel;
  /**
   * Publication date as written in the feed (RFC 3339).
   */
  date: string | null;
  notes: string | null;
  version: string;
  [k: string]: unknown;
}
export interface OperationTarget {
  id: string;
  kind: ActivityTargetKind;
  [k: string]: unknown;
}
