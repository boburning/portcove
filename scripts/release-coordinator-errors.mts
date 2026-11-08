import { isRecord } from "./runtime-values.mts";

/** Data-only error boundary shared by remote snapshot reads and journal writes. */
export class CoordinatorRemoteError extends Error {
  readonly evidence: unknown;
  constructor(message: string, evidence: unknown) {
    super(message);
    this.name = "CoordinatorRemoteError";
    this.evidence = evidence;
  }
}

const applicationRefusalStages: readonly string[] = [
  "remote-recovery",
  "exact-qualified-neutral-request-gate",
  "actual-terminal-context-readback-recovery",
  "actual-terminal-pages-readback-recovery",
  "actual-original-candidate-signing-readback",
  "actual-active-resumption-authority",
  "exact-windows-qualification",
  "complete-publication-baseline-and-source",
  "actual-neutral-request-controls",
  "durable-neutral-review-request",
];

export const applicationCoordinatorRefusalFile = "application-coordinator-operation-refusal.json";

export function applicationCoordinatorRefusal(error: unknown) {
  const evidence = error instanceof CoordinatorRemoteError ? error.evidence : undefined;
  const stage =
    isRecord(evidence) &&
    typeof evidence.phase === "string" &&
    applicationRefusalStages.includes(evidence.phase)
      ? evidence.phase
      : "fixed-entry";
  return {
    schema_version: 1,
    stage,
    error_type: error instanceof CoordinatorRemoteError ? "coordinator-remote" : "unclassified",
    authority: "none",
    automatic_retry: false,
  };
}

export function requireApplicationCoordinatorRefusal(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,automatic_retry,error_type,schema_version,stage" ||
    raw.schema_version !== 1 ||
    raw.authority !== "none" ||
    raw.automatic_retry !== false ||
    (raw.error_type !== "coordinator-remote" && raw.error_type !== "unclassified") ||
    typeof raw.stage !== "string" ||
    (raw.stage !== "fixed-entry" &&
      (raw.error_type !== "coordinator-remote" || !applicationRefusalStages.includes(raw.stage)))
  )
    throw new Error("application coordinator refusal is not a fixed public stage record");
}
