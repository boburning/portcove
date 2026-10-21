/** Original result upload custody only. No key, upload or attestation operation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { inspectCapacityOperation, capacityDigest as digest } from "./release-capacity.mts";
import { inspectCompleteRunArtifactInventory } from "./release-run-artifact-inventory.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  immutableReleaseProgressDigest,
  requireRetainedPublishCandidate,
} from "./release-candidate-progress-contract.mts";
import {
  inspectPublicationResultArchive,
  inspectPublicationResultReadback,
} from "./release-publication-result-artifact.mts";
import { inspectPendingReleaseProducer } from "./release-pending-release-recovery.mts";

type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function publicationResultReadbackDestination(candidate: Record<string, unknown>) {
  const root = `github-actions:boburning/portcove:${String(candidate.version)}:immutable-release-result`;
  return (
    root +
    (Number(candidate.transient_retries) + Number(candidate.substantive_repairs) > 0
      ? `:recovery-${String(candidate.transient_retries)}-${String(candidate.substantive_repairs)}`
      : "")
  );
}
function inspectResultOperation(raw: unknown, candidate: Record<string, unknown>) {
  const operation = inspectCapacityOperation(raw);
  assert.ok(
    operation &&
      ["publishing", "promoting"].includes(String(candidate.phase)) &&
      ["pending", "ambiguous", "capacity-refused", "succeeded", "recovered"].includes(
        operation.outcome,
      ),
  );
  assert.equal(operation.kind, "upload");
  assert.equal(operation.receipt_limit, 1);
  assert.ok(
    operation.executor_identity?.role === "release-publication" &&
      operation.executor_identity.workflow === productionControllerWorkflow &&
      operation.executor_identity.run_attempt === 1,
  );
  assert.equal(
    digest(operation.candidate),
    digest(
      Object.fromEntries(
        [
          "source_commit",
          "prepared_commit",
          "version",
          "transient_retries",
          "substantive_repairs",
        ].map((key) => [key, candidate[key]]),
      ),
    ),
  );
  assert.equal(operation.destination, publicationResultReadbackDestination(candidate));
  return operation;
}
export function inspectPendingResultOperation(raw: unknown, candidate: Record<string, unknown>) {
  const operation = inspectResultOperation(raw, candidate);
  assert.ok(["pending", "ambiguous", "capacity-refused"].includes(operation.outcome));
  return operation;
}
export function inspectRetainedResultOperation(raw: unknown, candidate: Record<string, unknown>) {
  const operation = inspectResultOperation(raw, candidate);
  assert.ok(
    operation.outcome === "succeeded" ||
      (operation.outcome === "recovered" && operation.recovery?.resolution === "effect-completed"),
  );
  assert.equal(operation.completed_effects.length, 1);
  return operation;
}

/** Complete provider projection. Missing report is UNKNOWN; missing bundle is
 * a separate attestation obligation, never successful attested provenance. */
export function inspectPendingResultProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawArtifacts: unknown,
  operation: Operation,
) {
  const original = inspectPendingReleaseProducer(rawRun, rawAttempt, rawJob, operation);
  const producer = operation.executor_identity!;
  const rows = inspectCompleteRunArtifactInventory(rawArtifacts).artifacts;
  const selected = [false, true].map((bundle) => {
    const name = `trusted-immutable-release-result${bundle ? "-attestation" : ""}-${String(producer.run_id)}-1`;
    const matches = rows.filter((row) => row.name === name);
    assert.ok(matches.length <= 1, "original result artifact name is ambiguous");
    const raw = matches[0];
    if (raw === undefined) return null;
    assert.ok(
      Number.isSafeInteger(raw.id) &&
        Number(raw.id) > 0 &&
        raw.expired === false &&
        typeof raw.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(raw.digest) &&
        Number.isSafeInteger(raw.size_in_bytes) &&
        Number(raw.size_in_bytes) >= 22 &&
        Number(raw.size_in_bytes) <= (bundle ? 4 * 1024 ** 2 : 1024 ** 2) &&
        isRecord(raw.workflow_run) &&
        String(raw.workflow_run.id) === producer.run_id &&
        raw.workflow_run.repository_id === 1354613114 &&
        raw.workflow_run.head_repository_id === 1354613114 &&
        raw.workflow_run.head_sha === producer.controller_revision,
      "original result artifact provider identity differs",
    );
    return { id: Number(raw.id), bytes: Number(raw.size_in_bytes), sha256: raw.digest.slice(7) };
  });
  const [artifact, bundle] = selected;
  assert.ok(artifact, "original result upload has no positive immutable artifact readback");
  if (bundle) assert.notEqual(bundle.id, artifact.id);
  if (operation.completed_effects.length)
    assert.equal(
      operation.completed_effects[0]!.remote_identity,
      `github-actions:boburning/portcove:artifact:${artifact.id}`,
    );
  return { original, artifact, bundle: bundle ?? null, authority: "none" as const };
}

/** Pure restriction on a report whose actual context and archive association
 * is checked below. `published` must come from the current existing journal. */
export function inspectPendingResultAssociation(
  record: Record<string, unknown>,
  operation: Operation,
  candidate: Record<string, unknown>,
  published: Operation,
  currentRelease: Parameters<typeof immutableReleaseProgressDigest>[0],
) {
  const producer = operation.executor_identity!;
  assert.equal(
    digest(record.producer),
    digest({ job_id: producer.job_id, check_run_id: producer.check_run_id }),
  );
  assert.equal(
    digest(record.candidate),
    digest(
      Object.fromEntries(
        [
          "source_commit",
          "source_tree",
          "prepared_commit",
          "prepared_tree",
          "version",
          "intent_sha256",
          "release_run",
          "transient_retries",
          "substantive_repairs",
        ].map((key) => [key, candidate[key]]),
      ),
    ),
  );
  assert.ok(isRecord(record.settlement));
  assert.ok(
    typeof record.settlement.checkpoint === "string" &&
      /^[a-f0-9]{40}$/u.test(record.settlement.checkpoint),
  );
  assert.equal(
    digest(record.settlement.operation),
    digest(published),
    "report references a different original publish settlement",
  );
  assert.ok(
    published.outcome === "succeeded" ||
      (published.outcome === "recovered" && published.recovery?.resolution === "effect-completed"),
  );
  assert.equal(
    published.destination,
    `github-release:boburning/portcove:v${String(candidate.version)}:publish`,
  );
  assert.ok(
    published.executor_identity?.role === "release-publication" &&
      published.receipt_limit === 1 &&
      published.completed_effects.length === 1,
  );
  requireRetainedPublishCandidate(candidate, published, currentRelease);
  assert.equal(record.immutable_identity_sha256, immutableReleaseProgressDigest(currentRelease));
  assert.ok(isRecord(record.release));
  assert.equal(
    immutableReleaseProgressDigest(
      record.release as unknown as Parameters<typeof immutableReleaseProgressDigest>[0],
    ),
    immutableReleaseProgressDigest(currentRelease),
  );
  assert.ok(
    published.completed_effects[0]!.remote_identity.startsWith(
      `github-release:boburning/portcove:release:${currentRelease.release_id}:immutable:`,
    ),
  );
  return { authority: "none" as const };
}

/** Actual private context remains mandatory. This association returns only
 * data; the existing coordinator executor owns any journal settlement. */
export async function readPendingResultArchive(
  archive: Buffer,
  provider: ReturnType<typeof inspectPendingResultProvider>,
  controllerTree: string,
  contextReceipt: object,
  operation: Operation,
  candidate: Record<string, unknown>,
  published: Operation,
  observeRelease: (
    record: Record<string, unknown>,
  ) => Promise<Parameters<typeof immutableReleaseProgressDigest>[0]>,
  deadline: number,
) {
  assert.equal(archive.length, provider.artifact.bytes);
  assert.equal(hash(archive), provider.artifact.sha256);
  const bytes = inspectPublicationResultArchive(archive);
  const original = operation.executor_identity!;
  const controller = {
    controller_revision: original.controller_revision,
    controller_ref: original.execution_ref,
    source_tree: controllerTree,
    run_id: String(original.run_id),
    run_attempt: 1,
  };
  const actual = await inspectPublicationResultReadback(
    bytes,
    controller,
    contextReceipt,
    deadline,
  );
  const currentRelease = await observeRelease(actual.record);
  inspectPendingResultAssociation(actual.record, operation, candidate, published, currentRelease);
  const projection = {
    operation_id: operation.id,
    artifact: provider.artifact,
    report_sha256: actual.report_sha256,
    original_producer: original,
    publish_operation_sha256: digest(published),
    immutable_identity_sha256: immutableReleaseProgressDigest(currentRelease),
  };
  return {
    projection,
    report_sha256: actual.report_sha256,
    remote_identity: `github-actions:boburning/portcove:artifact:${provider.artifact.id}`,
    evidence_sha256: digest(projection),
    record: actual.record,
    authority: "none" as const,
  };
}
