import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capacityDigest as digest } from "./release-capacity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  inspectMetadataContextRetryOperation,
  inspectMetadataContextRetryProvider,
  inspectRecoveredMetadataContextBinding,
  reconcileCoordinatorSigningContext,
} from "./release-metadata-context-recovery.mts";

void test("reused context preserves its original checkpoint and all current descriptor/setup/prior/byte identities", () => {
  const facts = {
    checkpoint: "1".repeat(40),
    mode: "renewal",
    namespace: "portcove-fixture",
    descriptor: { root: "a".repeat(64) },
    setup_plan_sha256: "b".repeat(64),
    public_source_commit: "c".repeat(40),
    previous_site_pins: { repository_sha256: "d".repeat(64) },
  };
  const binding = { kind: "metadata-renewal", records_sha256: "e".repeat(64) },
    files = new Map([["context.json", Buffer.from("public context")]]);
  const original = { facts, binding, files },
    current = { facts: { ...facts, checkpoint: "2".repeat(40) }, binding, files };
  assert.equal(
    inspectRecoveredMetadataContextBinding(original, current, facts.checkpoint).authority,
    "none",
  );
  assert.throws(() => inspectRecoveredMetadataContextBinding(original, current, "2".repeat(40)));
  for (const change of [
    { mode: "release" },
    { namespace: "other" },
    { descriptor: { root: "f".repeat(64) } },
    { setup_plan_sha256: "f".repeat(64) },
    { public_source_commit: "f".repeat(40) },
    { previous_site_pins: { repository_sha256: "f".repeat(64) } },
  ])
    assert.throws(() =>
      inspectRecoveredMetadataContextBinding(
        original,
        { ...current, facts: { ...current.facts, ...change } },
        facts.checkpoint,
      ),
    );
  assert.throws(() =>
    inspectRecoveredMetadataContextBinding(
      original,
      { ...current, binding: { ...binding, records_sha256: "f".repeat(64) } },
      facts.checkpoint,
    ),
  );
  for (const changed of [
    new Map([["context.json", Buffer.from("changed")]]),
    new Map([...files, ["extra.json", Buffer.from("extra")]]),
  ])
    assert.throws(() =>
      inspectRecoveredMetadataContextBinding(
        original,
        { ...current, files: changed },
        facts.checkpoint,
      ),
    );
});

function fixture() {
  const descriptor = {
    prior_repository_sha256: "a".repeat(64),
    generated_at: "2026-10-20T00:00:00Z",
  };
  const identity = {
    before_checkpoint: "1".repeat(40),
    metadata_renewal: {
      descriptor_sha256: digest(descriptor),
      prior_repository_sha256: descriptor.prior_repository_sha256,
      observed_at: "2026-10-20T00:00:00Z",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "github-actions:boburning/portcove:metadata-renewal-context",
    executor_nonce: "2".repeat(64),
    executor_identity: {
      actor_id: "43177418",
      check_run_id: "777",
      controller_revision: "3".repeat(40),
      execution_ref: "refs/tags/portcove-production-controller-fixture",
      job_id: 501,
      role: "coordinator",
      run_attempt: 1,
      run_id: "12345",
      workflow: productionControllerWorkflow,
    },
    receipt_limit: 1,
    kind: "upload",
    policy_sha256: "4".repeat(64),
    ratification_sha256: "5".repeat(64),
    sequence: 1,
  };
  const raw = {
    ...identity,
    id: digest(identity),
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:99",
        evidence_sha256: "6".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: null,
  };
  const operation = inspectMetadataContextRetryOperation(raw, descriptor);
  const controller = {
    controller_revision: identity.executor_identity.controller_revision,
    controller_ref: identity.executor_identity.execution_ref,
    source_tree: "7".repeat(40),
    run_id: "67890",
    run_attempt: 1,
    artifact_id: 80,
    sha256: "8".repeat(64),
  };
  const run = {
    id: 12345,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: 501,
    run_id: 12345,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    name: "Coordinate application release",
    status: "completed",
    conclusion: "success",
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
  };
  const artifact = (bundle: boolean) => ({
    id: bundle ? 100 : 99,
    name: `trusted-coordinator-signing-context${bundle ? "-attestation" : ""}-12345-1`,
    digest: `sha256:${"9".repeat(64)}`,
    size_in_bytes: 100,
    expired: false,
    workflow_run: {
      id: 12345,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: controller.controller_revision,
    },
  });
  return { descriptor, raw, operation, controller, run, job, artifact };
}
void test("recovery requires the exact settled descriptor, one uploaded artifact and coordinator identity", () => {
  const f = fixture();
  assert.equal(f.operation.outcome, "succeeded");
  for (const change of [
    { outcome: "pending" },
    { completed_effects: [] },
    { destination: f.raw.destination + "-other" },
    { executor_identity: { ...f.raw.executor_identity, role: "payload-signing" } },
    { metadata_renewal: { ...f.raw.metadata_renewal, descriptor_sha256: "b".repeat(64) } },
  ])
    assert.throws(() =>
      inspectMetadataContextRetryOperation({ ...f.raw, ...change }, f.descriptor),
    );
  assert.throws(() =>
    inspectMetadataContextRetryOperation(f.raw, {
      ...f.descriptor,
      generated_at: "2026-10-21T00:00:00Z",
    }),
  );
});
void test("complete old provider inventory separates a reusable pair from terminal absence without granting authority", () => {
  const f = fixture();
  const inspect = (artifacts: unknown[]) =>
    inspectMetadataContextRetryProvider(
      f.run,
      f.run,
      f.job,
      { total_count: artifacts.length, artifacts },
      f.operation,
      f.controller,
    );
  const complete = inspect([f.artifact(false), f.artifact(true)]);
  assert.equal(complete.artifact?.id, 99);
  assert.equal(complete.bundle?.id, 100);
  assert.equal(complete.authority, "none");
  assert.equal(complete.producer.run_id, "12345");
  assert.notEqual(
    complete.producer.run_id,
    f.controller.run_id,
    "producing lineage is distinct from current execution",
  );
  assert.equal(inspect([f.artifact(false)]).bundle, null);
  assert.equal(inspect([]).artifact, null);
  assert.equal(inspect([{ ...f.artifact(false), expired: true }]).artifact?.expired, true);
  assert.equal(
    inspectMetadataContextRetryProvider(
      f.run,
      f.run,
      { ...f.job, conclusion: "failure" },
      { total_count: 0, artifacts: [] },
      f.operation,
      f.controller,
    ).producer_success,
    false,
  );
});
void test("active, wrong or incomplete provider observations cannot authorize a retry", () => {
  const f = fixture(),
    complete = { total_count: 2, artifacts: [f.artifact(false), f.artifact(true)] };
  for (const bad of [
    { ...f.run, status: "in_progress", conclusion: null },
    { ...f.run, run_attempt: 2 },
    { ...f.run, head_sha: "f".repeat(40) },
    { ...f.run, repository: { id: 99, full_name: "other/repo" } },
  ])
    assert.throws(() =>
      inspectMetadataContextRetryProvider(bad, f.run, f.job, complete, f.operation, f.controller),
    );
  for (const bad of [
    { ...f.job, status: "in_progress" },
    { ...f.job, id: 777 },
    { ...f.job, check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/501" },
    { ...f.job, run_attempt: 2 },
    { ...f.job, name: "Other job" },
  ])
    assert.throws(() =>
      inspectMetadataContextRetryProvider(f.run, f.run, bad, complete, f.operation, f.controller),
    );
  for (const bad of [
    { total_count: 3, artifacts: complete.artifacts },
    { total_count: 101, artifacts: [] },
    { total_count: 2, artifacts: [f.artifact(false), f.artifact(false)] },
    { total_count: 2, artifacts: [f.artifact(false), { ...f.artifact(false), id: 101 }] },
    { total_count: 1, artifacts: [{ ...f.artifact(false), id: 101 }] },
    { total_count: 1, artifacts: [{ ...f.artifact(false), digest: null }] },
    {
      total_count: 1,
      artifacts: [
        {
          ...f.artifact(false),
          workflow_run: { ...f.artifact(false).workflow_run, head_sha: "f".repeat(40) },
        },
      ],
    },
  ])
    assert.throws(() =>
      inspectMetadataContextRetryProvider(f.run, f.run, f.job, bad, f.operation, f.controller),
    );
});
void test("serialized metadata preparation cannot enter the actual recovery transport or create files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "metadata-recovery-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    reconcileCoordinatorSigningContext(
      { kind: "actual-coordinator-metadata-signing-context" },
      directory,
    ),
    /actual coordinator metadata context/,
  );
  assert.deepEqual(await readdir(directory), []);
});
