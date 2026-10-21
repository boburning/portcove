/** Same-journal, bounded technical report recovery. Data integrity only. */
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  candidateProgressIdentity,
  inspectCandidateStageEvidence,
} from "./release-candidate-progress-contract.mts";

const dispatchRoot = "github-actions:boburning/portcove:release.yml:dispatch";
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  assert.ok(
    isRecord(raw) && Object.keys(raw).sort().join(",") === keys,
    "report repair schema differs",
  );
}
function sha(raw: unknown, length = 64): asserts raw is string {
  assert.ok(typeof raw === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw));
}
function count(raw: unknown, max: number): asserts raw is number {
  assert.ok(typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= max);
}
export function inspectPublicationReportRepair(raw: unknown, candidate: Record<string, unknown>) {
  exact(
    raw,
    "artifact_id,artifact_sha256,candidate_sha256,context_manifest_sha256,expected_transient_retry,failure,immutable_identity_sha256,publish_operation_id,publish_operation_sha256,release_id,report_sha256,result_checkpoint,result_operation,result_operation_id,result_operation_sha256,schema_version,substantive_repairs",
  );
  assert.equal(raw.schema_version, 1);
  for (const key of [
    "artifact_sha256",
    "candidate_sha256",
    "context_manifest_sha256",
    "immutable_identity_sha256",
    "publish_operation_id",
    "publish_operation_sha256",
    "report_sha256",
    "result_operation_id",
    "result_operation_sha256",
  ] as const)
    sha(raw[key]);
  sha(raw.result_checkpoint, 40);
  for (const key of ["artifact_id", "release_id"] as const)
    assert.ok(typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && raw[key] > 0);
  count(raw.expected_transient_retry, 2);
  assert.ok(raw.expected_transient_retry > 0);
  count(raw.substantive_repairs, 3);
  assert.equal(raw.substantive_repairs, candidate.substantive_repairs);
  assert.ok(["producer-failed", "attestation-missing"].includes(String(raw.failure)));
  assert.equal(raw.candidate_sha256, candidateProgressIdentity(candidate));
  const operation = raw.result_operation;
  assert.ok(
    isRecord(operation) && isRecord(operation.candidate) && isRecord(operation.executor_identity),
  );
  assert.equal(operation.id, raw.result_operation_id);
  assert.equal(digest(operation), raw.result_operation_sha256);
  assert.equal(operation.kind, "upload");
  assert.equal(operation.receipt_limit, 1);
  assert.equal(operation.executor_identity.role, "release-publication");
  assert.ok(
    operation.outcome === "succeeded" ||
      (operation.outcome === "recovered" &&
        isRecord(operation.recovery) &&
        operation.recovery.resolution === "effect-completed"),
  );
  assert.ok(
    Array.isArray(operation.completed_effects) &&
      operation.completed_effects.length === 1 &&
      isRecord(operation.completed_effects[0]),
  );
  assert.equal(
    operation.completed_effects[0].remote_identity,
    `github-actions:boburning/portcove:artifact:${String(raw.artifact_id)}`,
  );
  for (const key of ["source_commit", "prepared_commit", "version", "substantive_repairs"])
    assert.equal(operation.candidate[key], candidate[key]);
  assert.equal(operation.candidate.transient_retries, raw.expected_transient_retry - 1);
  const suffix =
    Number(operation.candidate.transient_retries) +
      Number(operation.candidate.substantive_repairs) >
    0
      ? `:recovery-${String(operation.candidate.transient_retries)}-${String(operation.candidate.substantive_repairs)}`
      : "";
  assert.equal(
    operation.destination,
    `github-actions:boburning/portcove:${String(candidate.version)}:immutable-release-result${suffix}`,
  );
  assert.ok(
    candidate.transient_retries === raw.expected_transient_retry ||
      (candidate.phase === "failed" &&
        candidate.failure_kind === "transient" &&
        candidate.transient_retries === raw.expected_transient_retry - 1),
    "report repair counter was not genuinely consumed",
  );
  const history = inspectCandidateStageEvidence(candidate.stage_evidence, candidate);
  const origin = history
    .find((slot) => slot.phase === "promoting")
    ?.attempts.filter(
      (attempt) =>
        isRecord(attempt.proof) &&
        Array.isArray(attempt.proof.locators) &&
        attempt.proof.locators.some(
          (a: unknown) =>
            isRecord(a) &&
            a.kind === "operation" &&
            a.id === raw.publish_operation_id &&
            a.sha256 === raw.publish_operation_sha256,
        ) &&
        attempt.proof.locators.some(
          (a: unknown) =>
            isRecord(a) &&
            a.kind === "immutable-release" &&
            a.id === String(raw.release_id) &&
            a.sha256 === raw.immutable_identity_sha256,
        ),
    );
  assert.ok(origin && origin.length >= 1, "report repair lacks exact original promoting proof");
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 4096);
  return structuredClone(raw) as typeof raw & {
    expected_transient_retry: number;
    substantive_repairs: number;
  };
}

export function validatePublicationReportRepairTransition(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
  checkpoint: string,
  rawOperation: unknown,
  priorOperations: unknown = [],
) {
  const before = previous?.report_repair,
    after = next?.report_repair;
  if (after === undefined && before === undefined) return;
  if (next === null) return; // Existing completed-publication transition remains mandatory.
  if (after === undefined)
    throw new Error("report repair proof cannot disappear while candidate is active");
  inspectPublicationReportRepair(after, next);
  if (["qualifying", "building", "publishing", "promoting"].includes(String(next.phase)))
    inspectConsumedPublicationReportRepair(next);
  if (digest(before ?? null) === digest(after)) return;
  assert.ok(
    previous &&
      previous.phase === "promoting" &&
      next.phase === "failed" &&
      next.failure_kind === "transient",
    "report repair may be recorded only from actual promoting failure",
  );
  assert.equal(previous.transient_retries, next.transient_retries);
  assert.equal(previous.substantive_repairs, next.substantive_repairs);
  assert.equal(candidateProgressIdentity(previous), candidateProgressIdentity(next));
  const proof = inspectPublicationReportRepair(after, next);
  assert.equal(proof.expected_transient_retry, Number(previous.transient_retries) + 1);
  assert.equal(proof.result_checkpoint, checkpoint);
  if (!isRecord(rawOperation) || rawOperation.id !== proof.result_operation_id) {
    assert.ok(
      rawOperation === null ||
        (isRecord(rawOperation) &&
          (rawOperation.outcome === "succeeded" ||
            (rawOperation.outcome === "recovered" &&
              isRecord(rawOperation.recovery) &&
              rawOperation.recovery.resolution === "effect-completed"))),
      "unrelated unresolved effect blocks report repair",
    );
    assert.ok(Array.isArray(priorOperations) && priorOperations.length <= 96);
    const matches = priorOperations.filter((entry: unknown) => {
      if (!isRecord(entry)) return false;
      if (entry.id === proof.result_operation_id)
        return digest(entry) === proof.result_operation_sha256;
      return (
        entry.summary_schema_version === 1 &&
        isRecord(entry.subject) &&
        entry.subject.kind === "candidate" &&
        entry.subject.identity === previous.prepared_commit &&
        entry.kind === "upload" &&
        entry.completed === true &&
        entry.destination_sha256 ===
          digest((proof.result_operation as Record<string, unknown>).destination) &&
        Array.isArray(entry.attempts) &&
        entry.attempts.some(
          (attempt: unknown) =>
            isRecord(attempt) &&
            attempt.id === proof.result_operation_id &&
            attempt.operation_sha256 === proof.result_operation_sha256,
        )
      );
    });
    assert.equal(matches.length, 1, "exact original result proof missing from existing journal");
    rawOperation = proof.result_operation;
  }
  assert.ok(
    isRecord(rawOperation) &&
      isRecord(rawOperation.candidate) &&
      isRecord(rawOperation.executor_identity) &&
      rawOperation.executor_identity.role === "release-publication" &&
      rawOperation.kind === "upload" &&
      rawOperation.receipt_limit === 1 &&
      (rawOperation.outcome === "succeeded" ||
        (rawOperation.outcome === "recovered" &&
          isRecord(rawOperation.recovery) &&
          rawOperation.recovery.resolution === "effect-completed")) &&
      Array.isArray(rawOperation.completed_effects) &&
      rawOperation.completed_effects.length === 1 &&
      isRecord(rawOperation.completed_effects[0]),
  );
  assert.equal(rawOperation.id, proof.result_operation_id);
  assert.equal(digest(rawOperation), proof.result_operation_sha256);
  assert.equal(
    rawOperation.completed_effects[0].remote_identity,
    `github-actions:boburning/portcove:artifact:${String(proof.artifact_id)}`,
  );
  const suffix =
    Number(previous.transient_retries) + Number(previous.substantive_repairs) > 0
      ? `:recovery-${String(previous.transient_retries)}-${String(previous.substantive_repairs)}`
      : "";
  assert.equal(
    rawOperation.destination,
    `github-actions:boburning/portcove:${String(previous.version)}:immutable-release-result${suffix}`,
  );
  for (const key of [
    "source_commit",
    "prepared_commit",
    "version",
    "transient_retries",
    "substantive_repairs",
  ])
    assert.equal(rawOperation.candidate[key], previous[key]);
}

export function reportRepairDispatchDestination(candidate: Record<string, unknown>) {
  if (candidate.report_repair === undefined) return dispatchRoot;
  const proof = inspectPublicationReportRepair(candidate.report_repair, candidate);
  assert.equal(candidate.transient_retries, proof.expected_transient_retry);
  return `${dispatchRoot}:report-repair-${String(candidate.transient_retries)}-${String(candidate.substantive_repairs)}:${digest(proof)}`;
}
/** Restricts an already consumed report repair to its original compiler tuple.
 * This public association grants no signing or publication eligibility. */
export function inspectConsumedPublicationReportRepair(candidate: Record<string, unknown>) {
  const proof = inspectPublicationReportRepair(candidate.report_repair, candidate);
  assert.equal(candidate.transient_retries, proof.expected_transient_retry);
  assert.ok(
    ["qualifying", "building", "publishing", "promoting"].includes(String(candidate.phase)),
  );
  assert.equal(digest(candidate.release_run), digest(reportRepairOriginalCompilerRun(candidate)));
  return proof;
}
export function reportRepairOriginalCompilerRun(candidate: Record<string, unknown>) {
  const proof = inspectPublicationReportRepair(candidate.report_repair, candidate);
  const attempts = inspectCandidateStageEvidence(candidate.stage_evidence, candidate)
    .find((slot) => slot.phase === "promoting")!
    .attempts.filter(
      (attempt) =>
        isRecord(attempt.proof) &&
        Array.isArray(attempt.proof.locators) &&
        attempt.proof.locators.some(
          (raw: unknown) =>
            isRecord(raw) &&
            raw.kind === "operation" &&
            raw.id === proof.publish_operation_id &&
            raw.sha256 === proof.publish_operation_sha256,
        ),
    );
  assert.ok(
    attempts.length > 0 &&
      new Set(attempts.map((attempt) => digest(attempt.release_run))).size === 1,
    "original report compiler run is ambiguous",
  );
  const original = attempts[0]!.release_run;
  assert.ok(isRecord(original));
  return {
    run_id: Number(original.run_id),
    attempt: Number(original.attempt),
    revision: String(original.revision),
  };
}
export function assertReportRepairDispatch(
  destination: string,
  candidate: Record<string, unknown>,
) {
  assert.equal(destination, reportRepairDispatchDestination(candidate));
  if (candidate.report_repair === undefined)
    assert.ok(
      candidate.transient_retries === 0 && candidate.substantive_repairs === 0,
      "noninitial dispatch requires genuine report-only repair proof",
    );
}
