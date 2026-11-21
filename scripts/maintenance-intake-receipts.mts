import { isRecord } from "./runtime-values.mts";
import { queryJson, runSql, sqlLiteral } from "./maintenance-store.mts";
import { readHostedIntake } from "./maintenance-hosted-intake.mts";
import type { HostedRequestStatus } from "./hosted-discovery-intake.mts";

interface IntakePlan {
  operation_id: string;
  kind: string;
  subject_key: string;
  sequence: number;
  assessment: number;
  generation: string;
  revision: number;
  created_at: string;
  condition: unknown;
}

const openPlans = `
  SELECT o.operation_id, o.kind, o.subject_key, o.fence_sequence AS sequence,
         o.fence_assessment_id AS assessment, c.verified_run_id AS generation,
         o.revision, o.created_at, a.explanation -> 'condition' AS condition
    FROM portcove_maintenance.operations o
    JOIN portcove_maintenance.subject_current c ON c.subject_key = o.subject_key
      AND c.sequence = o.fence_sequence AND c.applicable_assessment_id = o.fence_assessment_id
    JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
    JOIN portcove_maintenance.collection_runs r ON r.run_id = c.verified_run_id
   WHERE r.source = 'hosted-intake' AND r.coverage = 'complete' AND a.state = 'needs-attention'
     AND o.executor = 'hosted-discovery-intake.yml' AND o.state = 'planned'
     AND o.kind IN ('handoff.hosted-intake-holds', 'handoff.hosted-intake-blocked')`;

export function intakeOperationReceipt(plan: IntakePlan, row: HostedRequestStatus) {
  if ("error" in row || row.withdrawn || row.superseded_by.length || row.status !== "complete")
    return;
  const proof = row.executor_receipt;
  const condition = plan.condition;
  if (
    !proof ||
    !isRecord(condition) ||
    condition.request_comment !== row.request_comment ||
    condition.receipt_comment !== row.receipt_comment ||
    plan.subject_key !==
      `handoff:${plan.kind.slice("handoff.".length)}:intake:${row.request_comment}` ||
    !row.receipt_comment ||
    row.held ||
    row.pending ||
    row.delivered + row.existing !== row.candidates ||
    !proof.published_at ||
    !Number.isFinite(Date.parse(proof.published_at)) ||
    !(Date.parse(proof.published_at) >= Date.parse(plan.created_at)) ||
    !/^[1-9]\d*$/u.test(proof.run) ||
    !/^[1-9]\d*$/u.test(proof.attempt) ||
    !/^[0-9a-f]{40}$/u.test(proof.head) ||
    !/^[0-9a-f]{64}$/u.test(proof.request_sha256) ||
    !/^[0-9a-f]{64}$/u.test(proof.body_sha256)
  )
    return;
  if (
    row.full_doctor_required &&
    (!isRecord(row.doctor) ||
      row.doctor.status !== "passed" ||
      row.doctor.coverage !== "complete" ||
      row.doctor.global_health !== "passed")
  )
    return;
  if (plan.kind === "handoff.hosted-intake-holds") {
    if (!Array.isArray(condition.holds) || !condition.holds.length) return;
    for (const held of condition.holds) {
      if (!isRecord(held) || typeof held.candidate_index !== "number") return;
      const slot = row.slots[held.candidate_index];
      const original = proof.original_slots[held.candidate_index];
      if (
        !slot ||
        slot.candidate_index !== held.candidate_index ||
        slot.hold ||
        !slot.linked_issue ||
        !["delivered", "existing"].includes(slot.delivery_status ?? "") ||
        ![original, slot].some(
          (identity) =>
            identity !== undefined &&
            identity.repository_id === held.repository_id &&
            identity.port_key === held.port_key,
        )
      )
        return;
    }
  } else if (plan.kind !== "handoff.hosted-intake-blocked") return;
  return {
    ...plan,
    request: row.request_comment,
    request_sha256: proof.request_sha256,
    sha256: proof.body_sha256,
    checkpoint_required: proof.checkpoint_required,
    reference: `https://github.com/boburning/portcove/issues/177#issuecomment-${row.receipt_comment}`,
    run: proof.run,
    attempt: proof.attempt,
  };
}

/** Acknowledge already executed work. The native executor retains all mutation authority. */
export async function reconcileIntakeHandoffReceipts(
  environment: NodeJS.ProcessEnv,
  read = readHostedIntake,
) {
  const executor = "SET LOCAL ROLE portcove_maintenance_executor;";
  const plans = queryJson(
    environment,
    `SELECT coalesce(json_agg(p ORDER BY p.operation_id), '[]') FROM (${openPlans}) p;`,
    { executor: true },
  ) as IntakePlan[];
  if (!plans.length) return { inspected: 0, completed: [] };
  const queue = await read();
  const receipts = plans.flatMap((plan) => {
    const row = queue.requests.find(
      (r) => isRecord(plan.condition) && r.request_comment === plan.condition.request_comment,
    );
    const proof = row && intakeOperationReceipt(plan, row);
    return proof ? [proof] : [];
  });
  if (!receipts.length) return { inspected: plans.length, completed: [] };
  // The operation trigger locks the current subject and checks its fence. A
  // concurrent refresh of the same result must also retain the source generation.
  const proofRows = receipts.map((proof) => [
    proof.operation_id,
    proof.subject_key,
    proof.kind,
    proof.sequence,
    proof.assessment,
    proof.generation,
    proof.revision,
    proof.request,
    proof.request_sha256,
    proof.sha256,
    proof.checkpoint_required,
    proof.reference,
    proof.run,
    proof.attempt,
  ]);
  const proofTable = `(VALUES ${proofRows
    .map(
      (values) =>
        `(${values
          .map((v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : sqlLiteral(v)))
          .join(",")})`,
    )
    .join(",")})
    AS p(operation_id, subject_key, kind, sequence, assessment, generation, revision,
         request, request_sha256, sha256, checkpoint_required, reference, run, attempt)`;
  const checkpoint = `EXISTS (SELECT 1 FROM portcove_maintenance_meta.discovery_intake_activation WHERE active)
       AND ((b.request_comment IS NULL AND NOT p.checkpoint_required)
            OR (b.request_sha256=p.request_sha256 AND encode(sha256(convert_to(b.receipt_body,'UTF8')),'hex')=p.sha256))`;
  const currentProof = `FROM ${proofTable}
      JOIN portcove_maintenance.subject_current c ON c.subject_key=p.subject_key
        AND c.sequence=p.sequence AND c.applicable_assessment_id=p.assessment AND c.verified_run_id=p.generation
      LEFT JOIN portcove_maintenance.discovery_intake_batches b ON b.request_comment=p.request`;
  const output = runSql(
    environment,
    `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
    ${executor}
    SET LOCAL standard_conforming_strings = on;
    UPDATE portcove_maintenance.operations o
       SET state='dispatched', revision=o.revision+1, receipt_reference=p.reference,
           receipt_sha256=p.sha256, updated_at=greatest(clock_timestamp(),o.updated_at)
      ${currentProof}
     WHERE o.operation_id=p.operation_id AND o.kind=p.kind AND o.subject_key=p.subject_key
       AND o.fence_sequence=p.sequence AND o.fence_assessment_id=p.assessment AND o.state='planned'
       AND o.revision=p.revision AND o.executor='hosted-discovery-intake.yml'
       AND ${checkpoint};
    WITH completed AS (
      UPDATE portcove_maintenance.operations o
         SET state='completed', revision=o.revision+1, updated_at=greatest(clock_timestamp(),o.updated_at)
        ${currentProof}
       WHERE ${checkpoint} AND o.operation_id=p.operation_id AND o.state='dispatched' AND o.revision=p.revision+1
         AND o.receipt_reference=p.reference AND o.receipt_sha256=p.sha256
      RETURNING o.operation_id, o.receipt_reference, o.receipt_sha256, p.run, p.attempt)
    SELECT coalesce(json_agg(row_to_json(c) ORDER BY operation_id), '[]') FROM completed c;`,
  );
  const completed = JSON.parse(output) as { operation_id: string }[];
  if (completed.length) {
    // A new session reads the committed operation. Only returned operation identities are queried.
    const ids = completed.map(({ operation_id }) => sqlLiteral(operation_id)).join(",");
    const committed = runSql(
      environment,
      `${executor}
      SELECT coalesce(json_agg(row_to_json(v) ORDER BY operation_id), '[]') FROM (
        SELECT o.operation_id, o.receipt_reference, o.receipt_sha256, p.run, p.attempt
          FROM portcove_maintenance.operations o JOIN ${proofTable} ON o.operation_id=p.operation_id
         WHERE o.operation_id IN (${ids}) AND o.state='completed' AND o.revision=p.revision+2
           AND o.receipt_reference=p.reference AND o.receipt_sha256=p.sha256
           AND o.fence_sequence=p.sequence AND o.fence_assessment_id=p.assessment) v;`,
    );
    if (committed !== output) throw new Error("Committed hosted intake operation receipt differs");
  }
  return { inspected: plans.length, completed };
}
