import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

// Reviewed ceilings, not remaining storage, a reservation, or a billing quote.
export const slice4CapacityResources = Object.freeze({
  contract: "slice4-no-spend-v1",
  aggregate_workflow_sha256: "bee2037f33ae9a317af0b93a49eede17ddb81298f83d77e12f69bae7c4fd0a35",
  input_workflow_sha256: "086ed2c625bbd45b4849eee8598a65e9bdcb394d008f47f32a081965b1223b17",
  aggregate_job_minutes: Object.freeze([5, 25, 30, 5, 20]),
  input_job_minutes: Object.freeze([5, 5, 5]),
  aggregate_concurrency: "application-update-production-controller",
  input_concurrency: "portcove-release-reviewed-inputs",
  cancel_in_progress: false,
  total_job_minutes: 100,
  retention_days: 7,
  archive_bytes: 512 * 1024 * 1024,
  total_archive_bytes: 2 * 1024 * 1024 * 1024,
  assembly_file_bytes: 512 * 1024 * 1024,
  total_assembly_bytes: 2 * 1024 * 1024 * 1024,
  input_receipts: 3,
  input_receipt_bytes: 128 * 1024,
  shared_cache: false,
  enlarged_cache: false,
  paid_fallback: false,
  overwrite: false,
  unrelated_evidence_deletion: false,
});
export function capacityDigest(value: unknown): string {
  const ordered = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(ordered)
      : isRecord(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, ordered(entry[key])]),
          )
        : entry;
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
export const slice4CapacityResourceDigest = capacityDigest(slice4CapacityResources);
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("bounded capacity schema differs");
}
function sha(value: unknown, length = 64): asserts value is string {
  if (
    typeof value !== "string" ||
    !(length === 40 ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value)
  )
    throw new Error("bounded capacity requires exact identities");
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("bounded capacity identity text invalid");
}
export function inspectCapacityOperation(raw: unknown) {
  if (raw === null) return null;
  exact(
    raw,
    "before_checkpoint,candidate,completed_effects,destination,failure_evidence,id,kind,outcome,policy_sha256,ratification_sha256,recovery,sequence",
  );
  sha(raw.before_checkpoint, 40);
  sha(raw.id);
  sha(raw.policy_sha256);
  sha(raw.ratification_sha256);
  text(raw.destination);
  exact(
    raw.candidate,
    "prepared_commit,source_commit,substantive_repairs,transient_retries,version",
  );
  sha(raw.candidate.prepared_commit, 40);
  sha(raw.candidate.source_commit, 40);
  text(raw.candidate.version);
  if (
    typeof raw.candidate.transient_retries !== "number" ||
    !Number.isInteger(raw.candidate.transient_retries) ||
    raw.candidate.transient_retries < 0 ||
    raw.candidate.transient_retries > 2 ||
    typeof raw.candidate.substantive_repairs !== "number" ||
    !Number.isInteger(raw.candidate.substantive_repairs) ||
    raw.candidate.substantive_repairs < 0 ||
    raw.candidate.substantive_repairs > 3
  )
    throw new Error("capacity intent exceeds existing recovery limits");
  if (
    !Number.isSafeInteger(raw.sequence) ||
    typeof raw.sequence !== "number" ||
    raw.sequence < 1 ||
    raw.sequence > 10000 ||
    !["dispatch", "upload", "retention"].includes(String(raw.kind)) ||
    !["pending", "succeeded", "capacity-refused", "ambiguous", "recovered"].includes(
      String(raw.outcome),
    ) ||
    !Array.isArray(raw.completed_effects) ||
    raw.completed_effects.length > 32
  )
    throw new Error("bounded capacity operation invalid");
  const completed = raw.completed_effects.map((effect: unknown) => {
    exact(effect, "evidence_sha256,remote_identity");
    sha(effect.evidence_sha256);
    text(effect.remote_identity);
    return { evidence_sha256: effect.evidence_sha256, remote_identity: effect.remote_identity };
  });
  if (new Set(completed.map((effect) => effect.remote_identity)).size !== completed.length)
    throw new Error("duplicate capacity effect");
  if (raw.failure_evidence !== null) {
    exact(raw.failure_evidence, "evidence_sha256,remote_identity");
    sha(raw.failure_evidence.evidence_sha256);
    text(raw.failure_evidence.remote_identity);
  }
  if (raw.outcome === "capacity-refused" && raw.failure_evidence === null)
    throw new Error("capacity refusal needs retained exact evidence");
  if (raw.outcome === "succeeded" && completed.length === 0)
    throw new Error("successful capacity operation requires exact completed evidence");
  if (raw.outcome === "recovered") {
    exact(raw.recovery, "checkpoint,evidence_sha256,resolution");
    sha(raw.recovery.checkpoint, 40);
    sha(raw.recovery.evidence_sha256);
    if (
      !["effect-completed", "effect-not-applied", "partial-effects-retained"].includes(
        String(raw.recovery.resolution),
      )
    )
      throw new Error("capacity recovery unresolved");
    if (raw.recovery.resolution === "effect-not-applied" && completed.length !== 0)
      throw new Error("effect-not-applied contradicts retained completed effects");
  } else if (raw.recovery !== null) throw new Error("unresolved operation cannot assert recovery");
  const identity = {
    before_checkpoint: raw.before_checkpoint,
    candidate: raw.candidate,
    destination: raw.destination,
    kind: raw.kind,
    policy_sha256: raw.policy_sha256,
    ratification_sha256: raw.ratification_sha256,
    sequence: raw.sequence,
  };
  if (capacityDigest(identity) !== raw.id) throw new Error("capacity operation identity differs");
  return {
    ...identity,
    id: raw.id,
    outcome: String(raw.outcome),
    completed_effects: completed,
    failure_evidence: raw.failure_evidence,
    recovery: raw.recovery,
  };
}

/** Facts are supplied by the admitted fixed caller, never authenticated by this
 * pure parser or by journal persistence. No default budget API or billing App.
 * A ratification is revocable; its owner must invalidate it BEFORE boundary
 * changes. Unreported provider changes cannot be detected by digest equality.
 */
export function assessBoundedCapacity(raw: unknown) {
  exact(raw, "boundary,operation,prior_operations,ratification,schema_version");
  inspectPriorCapacityOperations(raw.prior_operations);
  if (raw.schema_version !== 1) throw new Error("unsupported bounded capacity contract");
  exact(raw.ratification, "active,boundary_sha256,resource_policy_sha256,selection");
  sha(raw.ratification.boundary_sha256);
  sha(raw.ratification.resource_policy_sha256);
  if (
    typeof raw.ratification.active !== "boolean" ||
    raw.ratification.selection !== "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0"
  )
    throw new Error("capacity ratification invalid");
  let reason = "bounded attempt eligible under supplied ratified no-spend facts";
  let eligible = true;
  if (!raw.ratification.active) {
    eligible = false;
    reason = "capacity ratification revoked";
  } else if (raw.ratification.resource_policy_sha256 !== slice4CapacityResourceDigest) {
    eligible = false;
    reason = "capacity resource policy changed";
  } else if (raw.boundary === null) {
    eligible = false;
    reason = "admitted spending-boundary source unavailable";
  } else {
    exact(
      raw.boundary,
      "account_id,budget_id,budget_usd,configuration_generation,product,public_repository,repository_id,resource_policy_sha256,runner_class,scope,stop_usage",
    );
    text(raw.boundary.budget_id);
    text(raw.boundary.configuration_generation);
    if (
      raw.boundary.account_id !== 43177418 ||
      raw.boundary.repository_id !== 1354613114 ||
      raw.boundary.product !== "Actions" ||
      raw.boundary.scope !== "account" ||
      raw.boundary.budget_usd !== 0 ||
      raw.boundary.stop_usage !== true ||
      raw.boundary.public_repository !== true ||
      raw.boundary.runner_class !== "standard-public" ||
      raw.boundary.resource_policy_sha256 !== slice4CapacityResourceDigest ||
      capacityDigest(raw.boundary) !== raw.ratification.boundary_sha256
    ) {
      eligible = false;
      reason = "spending, account, runner or resource boundary changed";
    }
  }
  const operation = inspectCapacityOperation(raw.operation);
  if (operation && !["succeeded", "recovered"].includes(operation.outcome)) {
    eligible = false;
    reason =
      "pending, refused or ambiguous operation requires existing checkpoint/readback recovery";
  }
  return {
    schema_version: 1,
    contract: "provider-no-spend-bounded-attempt-v1",
    eligibility: eligible ? "eligible" : "ineligible",
    reason,
    availability: "unknown",
    headroom: "unknown",
    reservation: "none",
    resource_policy_sha256: slice4CapacityResourceDigest,
    ratification_sha256: capacityDigest(raw.ratification),
    operation,
    resource_estimate: slice4CapacityResources,
    qualification: "supplied boundary facts only; no producer authentication or execution grant",
    authority: "none",
  };
}

/** Bounded anti-repeat summary carried by the existing portable checkpoint. */
export function inspectPriorCapacityOperations(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 32)
    throw new Error("capacity prior-operation summary exceeds bound");
  const operations = raw.map(inspectCapacityOperation);
  if (
    operations.some((op) => !op || !["succeeded", "recovered"].includes(op.outcome)) ||
    new Set(operations.map((op) => op?.id)).size !== operations.length
  )
    throw new Error("capacity prior-operation summary must retain unique resolved effects");
  return operations;
}
/** Called inside the existing journal's transition validation. No new journal. */
export function validateCapacityTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  if (previous.schema_version === 2 && next.schema_version !== 2)
    throw new Error("capacity schema cannot downgrade to legacy availability");
  const get = (input: Record<string, unknown>) =>
    isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
      ? inspectCapacityOperation(input.controller.capacity_attempt.operation)
      : null;
  const before = get(previous),
    after = get(next);
  if (next.schema_version !== 2) return;
  const prior =
    isRecord(previous.controller) && isRecord(previous.controller.capacity_attempt)
      ? inspectPriorCapacityOperations(previous.controller.capacity_attempt.prior_operations)
      : [];
  const retained =
    isRecord(next.controller) && isRecord(next.controller.capacity_attempt)
      ? inspectPriorCapacityOperations(next.controller.capacity_attempt.prior_operations)
      : [];
  const newIntent = after && (!before || before.id !== after.id);
  const expectedPrior = newIntent
    ? [...prior, ...(before ? [before] : [])].filter(
        (op) => op?.candidate.prepared_commit === after.candidate.prepared_commit,
      )
    : prior;
  if (capacityDigest(retained) !== capacityDigest(expectedPrior))
    throw new Error("capacity prior-operation summary cannot drop or rewrite effects");
  if (!before && !after) return;
  if (before && !after) throw new Error("capacity operation cannot disappear");
  if (!after) return;
  if (before && before.id === after.id && capacityDigest(before) === capacityDigest(after)) {
    if (
      !["succeeded", "recovered"].includes(before.outcome) &&
      capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate)
    )
      throw new Error("unresolved capacity effects must retain actual reservation progress");
    return;
  }
  const active = next.active_candidate;
  if (
    !isRecord(active) ||
    capacityDigest(after.candidate) !==
      capacityDigest({
        source_commit: active.source_commit,
        prepared_commit: active.prepared_commit,
        version: active.version,
        transient_retries: active.transient_retries,
        substantive_repairs: active.substantive_repairs,
      })
  )
    throw new Error("capacity operation changed its frozen candidate");
  if (!before || before.id !== after.id) {
    for (const prior of retained) {
      if (
        !prior ||
        prior.candidate.prepared_commit !== after.candidate.prepared_commit ||
        prior.kind !== after.kind ||
        prior.destination !== after.destination
      )
        continue;
      if (
        prior.outcome === "succeeded" ||
        (isRecord(prior.recovery) && prior.recovery.resolution === "effect-completed")
      )
        throw new Error("completed operation cannot be repeated");
      if (!["succeeded", "recovered"].includes(prior.outcome))
        throw new Error("new capacity operation cannot bypass unresolved historical effects");
      if (
        Number(after.candidate.transient_retries) <= Number(prior.candidate.transient_retries) &&
        Number(after.candidate.substantive_repairs) <= Number(prior.candidate.substantive_repairs)
      )
        throw new Error(
          "same-operation retry requires existing bounded coordinator recovery increment",
        );
    }
    if (before && !["succeeded", "recovered"].includes(before.outcome))
      throw new Error("new capacity operation cannot bypass unresolved effects");
    if (
      after.outcome !== "pending" ||
      after.completed_effects.length !== 0 ||
      after.before_checkpoint !== checkpoint ||
      after.sequence !== (before?.sequence ?? 0) + 1
    )
      throw new Error("capacity effect requires a preceding exact pending checkpoint");
    if (!isRecord(next.controller) || !isRecord(next.controller.capacity_attempt))
      throw new Error("capacity configuration missing");
    const readiness = assessBoundedCapacity({
      ...next.controller.capacity_attempt,
      operation: before,
    });
    if (
      readiness.eligibility !== "eligible" ||
      after.policy_sha256 !== readiness.resource_policy_sha256 ||
      after.ratification_sha256 !== readiness.ratification_sha256
    )
      throw new Error("capacity intent lacks bounded attempt eligibility");
    if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
      throw new Error("pending capacity intent must retain actual reservation progress");
    return;
  }
  if (
    capacityDigest(before.completed_effects) !==
    capacityDigest(after.completed_effects.slice(0, before.completed_effects.length))
  )
    throw new Error("completed capacity effects regressed or changed");
  if (before.outcome === "succeeded" || before.outcome === "recovered") {
    if (capacityDigest(before) !== capacityDigest(after))
      throw new Error("completed capacity outcome cannot be rewritten");
  } else if (after.outcome === "recovered") {
    if (capacityDigest(before.failure_evidence) !== capacityDigest(after.failure_evidence))
      throw new Error("capacity recovery must preserve failure evidence");
    if (!isRecord(after.recovery) || after.recovery.checkpoint !== checkpoint)
      throw new Error("capacity recovery must bind its actual prior checkpoint");
  } else if (before.outcome !== "pending" && capacityDigest(before) !== capacityDigest(after))
    throw new Error("failed capacity outcome requires explicit readback recovery");
  // Recording outcomes must never rewind/advance the real reservation phase or
  // counters. The ordinary coordinator owns subsequent bounded recovery.
  if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
    throw new Error("capacity outcome cannot rewrite actual reservation progress");
}
