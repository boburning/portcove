import assert from "node:assert/strict";
import test from "node:test";
import { publicationReportRepairStateFixture as fixture } from "./fixtures/publication-report-repair-fixture.mts";
import { capacityDigest as digest } from "./release-capacity.mts";
import {
  requireRetainedPublishCandidate,
  validateCandidateStageTransition,
} from "./release-candidate-progress-contract.mts";
import {
  inspectPublicationReportRepair,
  validatePublicationReportRepairTransition,
  reportRepairDispatchDestination,
  assertReportRepairDispatch,
} from "./release-report-repair-contract.mts";

void test("only positively read-back report custody and retained original promoting proof can record technical failure", () => {
  const f = fixture();
  validatePublicationReportRepairTransition(f.candidate, f.failed, f.checkpoint, f.operation);
  validateCandidateStageTransition(f.candidate, f.failed, f.checkpoint);
  assert.equal(inspectPublicationReportRepair(f.proof, f.failed).expected_transient_retry, 1);
  for (const next of [
    { ...f.failed, stage_evidence: [] },
    { ...f.failed, phase: "building" },
    { ...f.failed, failure_kind: "substantive" },
    { ...f.failed, report_repair: { ...f.proof, expected_transient_retry: 2 } },
    { ...f.failed, report_repair: { ...f.proof, publish_operation_sha256: "f".repeat(64) } },
  ])
    assert.throws(() =>
      validatePublicationReportRepairTransition(f.candidate, next, f.checkpoint, f.operation),
    );
  for (const operation of [
    { ...f.operation, outcome: "ambiguous" },
    { ...f.operation, completed_effects: [] },
    {
      ...f.operation,
      recovery: { ...f.operation.recovery, resolution: "partial-effects-retained" },
    },
    {
      ...f.operation,
      completed_effects: [
        {
          remote_identity: "github-actions:boburning/portcove:artifact:701",
          evidence_sha256: "a".repeat(64),
        },
      ],
    },
  ])
    assert.throws(() =>
      validatePublicationReportRepairTransition(f.candidate, f.failed, f.checkpoint, operation),
    );
  assert.throws(() =>
    validatePublicationReportRepairTransition(f.candidate, f.failed, "d".repeat(40), f.operation),
  );
});
void test("existing transient counter must be consumed before exact report-only dispatch; no proof reset or generic retry", () => {
  const f = fixture();
  validatePublicationReportRepairTransition(f.failed, f.prepared, f.checkpoint, f.operation);
  validateCandidateStageTransition(f.failed, f.prepared, f.checkpoint);
  const destination = reportRepairDispatchDestination(f.prepared);
  assert.equal(
    destination,
    `github-actions:boburning/portcove:release.yml:dispatch:report-repair-1-0:${digest(f.proof)}`,
  );
  assertReportRepairDispatch(destination, f.prepared);
  for (const candidate of [
    f.failed,
    { ...f.prepared, report_repair: undefined },
    { ...f.prepared, transient_retries: 2 },
    { ...f.prepared, substantive_repairs: 1 },
  ])
    assert.throws(() => assertReportRepairDispatch(destination, candidate));
  assert.throws(() =>
    assertReportRepairDispatch(
      "github-actions:boburning/portcove:release.yml:dispatch",
      f.prepared,
    ),
  );
  assert.throws(() =>
    validatePublicationReportRepairTransition(
      f.failed,
      { ...f.prepared, report_repair: undefined },
      f.checkpoint,
      f.operation,
    ),
  );
  assert.throws(() =>
    validatePublicationReportRepairTransition(
      f.failed,
      { ...f.prepared, report_repair: { ...f.proof, report_sha256: "e".repeat(64) } },
      f.checkpoint,
      f.operation,
    ),
  );
});
void test("new report custodian run remains distinct from original settled publication tuple", () => {
  const f = fixture();
  const current = {
    ...f.prepared,
    phase: "building",
    release_run: f.candidate.release_run,
  };
  const custodian = { run_id: 1111, attempt: 1, revision: f.candidate.prepared_commit };
  requireRetainedPublishCandidate(current, f.published, f.release);
  assert.equal(current.release_run.run_id, 999);
  assert.notEqual(custodian.run_id, current.release_run.run_id);
  assert.throws(() =>
    requireRetainedPublishCandidate({ ...current, release_run: custodian }, f.published, f.release),
  );
  assert.equal(f.candidate.stage_evidence[0]!.attempts[0]!.release_run.run_id, 999);
  const replaced = structuredClone(current);
  replaced.stage_evidence[0]!.attempts[0]!.proof.locators[0]!.sha256 = "f".repeat(64);
  assert.throws(() => requireRetainedPublishCandidate(replaced, f.published, f.release));
});
void test("settled metadata interleaving requires exact existing compact result proof; unrelated pending and copied projections stay held", () => {
  const f = fixture();
  const current = {
    ...f.operation,
    id: "f".repeat(64),
    destination: "qualification:metadata",
    outcome: "succeeded",
  };
  const prior = [
    {
      summary_schema_version: 1,
      subject: { kind: "candidate", identity: f.candidate.prepared_commit },
      kind: "upload",
      completed: true,
      destination_sha256: digest(f.operation.destination),
      attempts: [
        { id: f.operation.id, operation_sha256: digest(f.operation), checkpoint: "a".repeat(40) },
      ],
    },
  ];
  validatePublicationReportRepairTransition(f.candidate, f.failed, f.checkpoint, current, prior);
  for (const evidence of [
    [],
    [{ ...prior[0], completed: false }],
    [{ ...prior[0], subject: { kind: "candidate", identity: "e".repeat(40) } }],
    [{ ...prior[0], destination_sha256: "e".repeat(64) }],
    [{ ...prior[0], attempts: [{ ...prior[0]!.attempts[0], operation_sha256: "e".repeat(64) }] }],
  ])
    assert.throws(() =>
      validatePublicationReportRepairTransition(
        f.candidate,
        f.failed,
        f.checkpoint,
        current,
        evidence,
      ),
    );
  for (const outcome of ["pending", "ambiguous", "capacity-refused"])
    assert.throws(() =>
      validatePublicationReportRepairTransition(
        f.candidate,
        f.failed,
        f.checkpoint,
        { ...current, outcome },
        prior,
      ),
    );
  const rewritten = structuredClone(f.failed);
  rewritten.report_repair.result_operation.completed_effects[0]!.remote_identity =
    "github-actions:boburning/portcove:artifact:701";
  assert.throws(() =>
    validatePublicationReportRepairTransition(f.candidate, rewritten, f.checkpoint, current, prior),
  );
});
