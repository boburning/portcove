import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  assessBoundedCapacity,
  inspectCapacityOperation,
  validateCapacityTransition,
  slice4CapacityResources,
  capacityDigest,
} from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
void test("bounded eligibility never claims availability, headroom or reservation", () => {
  const result = assessBoundedCapacity(capacityFixture());
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.availability, "unknown");
  assert.equal(result.headroom, "unknown");
  assert.equal(result.reservation, "none");
  assert.equal(result.authority, "none");
  assert.equal(result.resource_estimate.total_job_minutes, 100);
  assert.equal(result.resource_estimate.input_receipts, 3);
  assert.equal(result.resource_estimate.retention_days, 7);
});
void test("changed account, stop, budget, visibility, runner or resource policy refuses even a rehashed observation", () => {
  for (const [key, value] of Object.entries({
    account_id: 1,
    repository_id: 1,
    budget_usd: 1,
    stop_usage: false,
    public_repository: false,
    runner_class: "larger",
    scope: "repository",
    resource_policy_sha256: "0".repeat(64),
  })) {
    const input = capacityFixture();
    Object.assign(input.boundary, { [key]: value });
    input.ratification.boundary_sha256 = capacityDigest(input.boundary);
    assert.equal(assessBoundedCapacity(input).eligibility, "ineligible", key);
  }
  const input = capacityFixture();
  input.ratification.active = false;
  assert.equal(assessBoundedCapacity(input).eligibility, "ineligible");
  assert.equal(
    assessBoundedCapacity({ ...capacityFixture(), boundary: null }).eligibility,
    "ineligible",
  );
  const changed = capacityFixture();
  changed.boundary.configuration_generation = "changed";
  assert.equal(assessBoundedCapacity(changed).eligibility, "ineligible");
});
void test("historical resource ratification preserves its limits and cannot silently cover the changed held controller", async () => {
  for (const [file, expected] of [
    [
      "docs/qualification/application-update-production.aggregate.yml",
      slice4CapacityResources.aggregate_workflow_sha256,
    ],
    [
      "docs/qualification/release-reviewed-inputs.held.yml",
      slice4CapacityResources.input_workflow_sha256,
    ],
  ] as const) {
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    const current = createHash("sha256").update(bytes).digest("hex");
    if (file.endsWith("application-update-production.aggregate.yml"))
      assert.notEqual(
        current,
        expected,
        "new observer source requires final coherent resource requalification",
      );
    else assert.equal(current, expected);
  }
  assert.deepEqual(slice4CapacityResources.aggregate_job_minutes, [5, 25, 30, 5, 20]);
  assert.deepEqual(slice4CapacityResources.input_job_minutes, [5, 5, 5]);
  assert.equal(slice4CapacityResources.cancel_in_progress, false);
  assert.equal(slice4CapacityResources.shared_cache, false);
  assert.equal(slice4CapacityResources.paid_fallback, false);
  assert.equal(slice4CapacityResources.overwrite, false);
});

function operationFixture(outcome = "succeeded", executorNonce?: string) {
  const capacity = capacityFixture();
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate: {
      source_commit: "b".repeat(40),
      prepared_commit: "c".repeat(40),
      version: "0.1.0-alpha.1",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "artifact:A",
    ...(executorNonce === undefined ? {} : { executor_nonce: executorNonce }),
    kind: "upload",
    sequence: 1,
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: capacityDigest(capacity.ratification),
  };
  return {
    ...identity,
    id: capacityDigest(identity),
    outcome,
    completed_effects: [{ remote_identity: "artifact:A", evidence_sha256: "d".repeat(64) }],
    failure_evidence: null,
    recovery: null,
  };
}
void test("executor nonce is retained and cannot be changed or removed from an existing operation", () => {
  const operation = operationFixture("succeeded", "1".repeat(64));
  assert.equal(inspectCapacityOperation(operation)?.executor_nonce, "1".repeat(64));
  assert.throws(
    () => inspectCapacityOperation({ ...operation, executor_nonce: "2".repeat(64) }),
    /identity differs/,
  );
  assert.throws(() => inspectCapacityOperation({ ...operation, executor_nonce: "not-a-nonce" }));
  const { executor_nonce: _nonce, ...removed } = operation;
  assert.throws(() => inspectCapacityOperation(removed), /identity differs/);
  assert.equal(inspectCapacityOperation(operationFixture())?.id, operationFixture().id);
});
void test("fresh executor nonce cannot repeat a completed logical effect", () => {
  const before = inspectCapacityOperation(operationFixture("succeeded", "1".repeat(64)))!;
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...identity
  } = operationFixture("pending", "2".repeat(64));
  const nextIdentity = { ...identity, before_checkpoint: "e".repeat(40), sequence: 2 };
  const after = {
    ...nextIdentity,
    id: capacityDigest(nextIdentity),
    outcome: "pending",
    completed_effects: [],
    failure_evidence: null,
    recovery: null,
  };
  const capacity = capacityFixture();
  const previous = {
    schema_version: 2,
    active_candidate: before.candidate,
    controller: { capacity_attempt: { ...capacity, operation: before } },
  };
  const next = {
    ...previous,
    controller: { capacity_attempt: { ...capacity, operation: after, prior_operations: [before] } },
  };
  assert.throws(
    () => validateCapacityTransition(previous, next, nextIdentity.before_checkpoint),
    /completed operation cannot be repeated/,
  );
});
void test("receipt contradictions cannot release capacity hold", () => {
  const operation = operationFixture();
  assert.throws(
    () => inspectCapacityOperation({ ...operation, completed_effects: [] }),
    /requires exact/,
  );
  assert.throws(
    () =>
      inspectCapacityOperation({
        ...operation,
        outcome: "recovered",
        recovery: {
          checkpoint: "e".repeat(40),
          evidence_sha256: "f".repeat(64),
          resolution: "effect-not-applied",
        },
      }),
    /contradicts/,
  );
});
void test("historical failed A behind B still requires existing recovery increment", () => {
  const prior = inspectCapacityOperation({
    ...operationFixture(),
    outcome: "recovered",
    recovery: {
      checkpoint: "e".repeat(40),
      evidence_sha256: "f".repeat(64),
      resolution: "partial-effects-retained",
    },
  })!;
  const identity = { ...operationFixture(), sequence: 3 };
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...keys
  } = identity;
  const after = {
    ...identity,
    id: capacityDigest(keys),
    outcome: "pending",
    completed_effects: [],
  };
  const capacity = capacityFixture();
  const active = { ...after.candidate };
  const before = {
    schema_version: 2,
    active_candidate: active,
    controller: { capacity_attempt: { ...capacity, operation: null, prior_operations: [prior] } },
  };
  const next = {
    ...before,
    controller: { capacity_attempt: { ...capacity, operation: after, prior_operations: [prior] } },
  };
  assert.throws(
    () => validateCapacityTransition(before, next, after.before_checkpoint),
    /bounded coordinator recovery increment/,
  );
});
