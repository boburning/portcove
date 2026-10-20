import assert from "node:assert/strict";
import test from "node:test";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  candidateProgressIdentity,
  inspectCandidateStageEvidence,
  validateCandidateStageTransition,
} from "./release-candidate-progress-contract.mts";

const checkpoint = "a".repeat(40);
function candidate() {
  return {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    prepared_commit: "3".repeat(40),
    prepared_tree: "4".repeat(40),
    intent_sha256: "5".repeat(64),
    version: "0.19.0-preview.1",
    phase: "qualifying",
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: { run_id: 123, attempt: 1, revision: "3".repeat(40) },
  };
}
function attempt(c = candidate(), cp = checkpoint) {
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(c),
    controller_revision: "6".repeat(40),
    locators: [{ kind: "native-check", id: "12345", sha256: "7".repeat(64) }],
  };
  return {
    previous_checkpoint: cp,
    evidence_sha256: releaseCanonicalDigest(proof),
    proof,
    release_run: c.release_run,
    transient_retries: c.transient_retries,
    substantive_repairs: c.substantive_repairs,
  };
}
void test("stage history appends only exact phase/checkpoint/run proof and keeps legacy unchanged", () => {
  const old = candidate();
  const next = {
    ...old,
    phase: "building",
    stage_evidence: [{ phase: "building", attempts: [attempt(old)] }],
  };
  validateCandidateStageTransition(old, next, checkpoint);
  assert.deepEqual(inspectCandidateStageEvidence(next.stage_evidence, next), next.stage_evidence);
  validateCandidateStageTransition(old, { ...old, phase: "building" }, checkpoint);
  for (const bad of [
    { ...next, phase: "qualifying" },
    { ...next, release_run: { ...old.release_run, run_id: 124 } },
    { ...next, stage_evidence: [{ phase: "publishing", attempts: [attempt(old)] }] },
  ])
    assert.throws(() => validateCandidateStageTransition(old, bad, checkpoint));
  assert.throws(() => validateCandidateStageTransition(null, next, checkpoint));
  assert.throws(() => validateCandidateStageTransition(old, next, "b".repeat(40)));
});
void test("recovery retains prior evidence and permits a later run only with consumed counters", () => {
  const c = candidate();
  const history = [{ phase: "building", attempts: [attempt(c)] }];
  const old = {
    ...c,
    phase: "qualifying",
    transient_retries: 1,
    release_run: { ...c.release_run, run_id: 124 },
    stage_evidence: history,
  };
  const next = {
    ...old,
    phase: "building",
    stage_evidence: [{ phase: "building", attempts: [...history[0]!.attempts, attempt(old)] }],
  };
  validateCandidateStageTransition(old, next, checkpoint);
  validateCandidateStageTransition(
    { ...old, phase: "failed" },
    { ...old, phase: "prepared" },
    checkpoint,
  );
  assert.throws(() =>
    validateCandidateStageTransition(
      old,
      { ...next, stage_evidence: [{ phase: "building", attempts: [attempt(old)] }] },
      checkpoint,
    ),
  );
  assert.throws(() =>
    validateCandidateStageTransition({ ...old, phase: "building" }, next, checkpoint),
  );
  assert.throws(() =>
    validateCandidateStageTransition(old, { ...old, stage_evidence: undefined }, checkpoint),
  );
});
void test("bounded public locators cannot hide altered bytes, counters or duplicate history", () => {
  const c = candidate();
  const a = attempt(c);
  for (const bad of [
    { ...a, evidence_sha256: "0".repeat(64) },
    { ...a, proof: { ...a.proof, candidate_sha256: "0".repeat(64) } },
    { ...a, transient_retries: 1 },
    { ...a, proof: { ...a.proof, locators: Array(17).fill(a.proof.locators[0]) } },
    {
      ...a,
      proof: { ...a.proof, locators: [{ kind: "native-check", id: "../secret", sha256: null }] },
    },
  ])
    assert.throws(() => inspectCandidateStageEvidence([{ phase: "building", attempts: [bad] }], c));
  assert.throws(() => inspectCandidateStageEvidence([{ phase: "building", attempts: [a, a] }], c));
  assert.throws(() =>
    inspectCandidateStageEvidence([{ phase: "building", attempts: Array(7).fill(a) }], c),
  );
  assert.throws(() =>
    inspectCandidateStageEvidence(
      [
        { phase: "publishing", attempts: [a] },
        { phase: "building", attempts: [a] },
      ],
      c,
    ),
  );
});
