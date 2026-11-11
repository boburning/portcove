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

const applicationCheckpointStages: readonly string[] = [
  "durable-neutral-review-request",
  "retained-application-review-claim",
  "withdrawal-signed-checkpoint",
  "durable-maintenance-descriptor",
  "retained-renewal-descriptor-identity",
];

const applicationRefusalStages: readonly string[] = [
  "bootstrap-source-admission",
  "bootstrap-job-clock",
  "bootstrap-tool-custody",
  "bootstrap-attested-worker",
  "bootstrap-worker-settlement",
  "remote-recovery",
  "exact-qualified-neutral-request-gate",
  "actual-terminal-context-readback-recovery",
  "actual-terminal-pages-readback-recovery",
  "actual-original-candidate-signing-readback",
  "actual-active-resumption-authority",
  "exact-windows-qualification",
  "complete-publication-baseline-and-source",
  "actual-neutral-request-controls",
  "withdrawal-source-authority",
  "withdrawal-journal-preimage",
  "withdrawal-reader-identity",
  "withdrawal-protection-observation",
  "withdrawal-live-controls",
  "withdrawal-checkpoint-authority",
  "renewal-current-tools",
  "renewal-public-site",
  "renewal-tuf-preparation",
  "renewal-publication-inventory",
  "actual-maintenance-controls",
  "metadata-context-preparation",
  "existing-metadata-pending",
  "metadata-pending-boundary",
  "metadata-effect-boundary",
  "metadata-owned-pending",
  "metadata-checkpoint-controls",
  "fixed-public-context-upload",
  "metadata-upload-settlement",
  ...applicationCheckpointStages,
];

export const applicationCoordinatorRefusalFile = "application-coordinator-operation-refusal.json";

const checkpointExchangeStages: readonly string[] = [
  "preimage",
  "checkpoint-objects",
  "claim",
  "signing",
  "proof-objects",
  "commit",
];

function checkpointExchange(raw: unknown) {
  if (
    !isRecord(raw) ||
    typeof raw.phase !== "string" ||
    !checkpointExchangeStages.includes(raw.phase) ||
    typeof raw.attempted_claim !== "boolean" ||
    typeof raw.attempted_commit !== "boolean"
  )
    return;
  return {
    phase: raw.phase,
    attempted_claim: raw.attempted_claim,
    attempted_commit: raw.attempted_commit,
  };
}

export function applicationCoordinatorRefusal(error: unknown) {
  const evidence = error instanceof CoordinatorRemoteError ? error.evidence : undefined;
  const stage =
    isRecord(evidence) &&
    typeof evidence.phase === "string" &&
    applicationRefusalStages.includes(evidence.phase)
      ? evidence.phase
      : "fixed-entry";
  const exchange =
    isRecord(evidence) && applicationCheckpointStages.includes(stage)
      ? checkpointExchange(evidence.retained_error)
      : undefined;
  return {
    schema_version: 1,
    stage,
    ...(exchange === undefined ? {} : { checkpoint_exchange: exchange }),
    error_type: error instanceof CoordinatorRemoteError ? "coordinator-remote" : "unclassified",
    authority: "none",
    automatic_retry: false,
  };
}

export function requireApplicationCoordinatorRefusal(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      (raw.checkpoint_exchange === undefined
        ? "authority,automatic_retry,error_type,schema_version,stage"
        : "authority,automatic_retry,checkpoint_exchange,error_type,schema_version,stage") ||
    (raw.checkpoint_exchange !== undefined &&
      (typeof raw.stage !== "string" ||
        !applicationCheckpointStages.includes(raw.stage) ||
        !isRecord(raw.checkpoint_exchange) ||
        Object.keys(raw.checkpoint_exchange).sort().join(",") !==
          "attempted_claim,attempted_commit,phase" ||
        !checkpointExchange(raw.checkpoint_exchange))) ||
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
