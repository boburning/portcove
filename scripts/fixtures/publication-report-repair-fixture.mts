import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pagesRecoveryOperationFixture } from "./release-pages-recovery-fixture.mts";
import { releaseEffectFixture } from "./release-effect-fixture.mts";
import { createAuditZip } from "./audit-zip-fixture.mts";
import { capacityDigest as digest, inspectCapacityOperation } from "../release-capacity.mts";
import { productionControllerWorkflow } from "../production-controller-admission.mts";
import {
  immutableReleaseProgressDigest,
  candidateProgressIdentity,
} from "../release-candidate-progress-contract.mts";
import { inspectPendingResultOperation } from "../release-pending-result-recovery.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function publicationReportRepairFixture() {
  const {
    site_expectation: discarded,
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...base
  } = pagesRecoveryOperationFixture();
  assert.ok(discarded);
  const candidate = {
    ...base.candidate,
    source_tree: "d".repeat(40),
    prepared_tree: "e".repeat(40),
    phase: "promoting",
    failure_kind: null,
    stage_evidence: [] as {
      phase: string;
      attempts: {
        previous_checkpoint: string;
        release_run: { run_id: number; attempt: number; revision: string };
        transient_retries: number;
        substantive_repairs: number;
        proof: {
          schema_version: number;
          candidate_sha256: string;
          controller_revision: string;
          locators: { kind: string; id: string; sha256: string }[];
        };
        evidence_sha256: string;
      }[];
    }[],
    intent_sha256: "f".repeat(64),
    release_run: { run_id: 999, attempt: 1, revision: base.candidate.prepared_commit },
  };
  const identity = {
    ...base,
    destination: `github-actions:boburning/portcove:${candidate.version}:immutable-release-result`,
    executor_identity: {
      ...base.executor_identity,
      role: "release-publication",
      workflow: productionControllerWorkflow,
    },
  };
  const operation = inspectPendingResultOperation(
    {
      ...identity,
      id: digest(identity),
      outcome: "ambiguous",
      completed_effects: [],
      failure_evidence: null,
      recovery: null,
    },
    candidate,
  );
  const assets = [{ filename: "package.exe", bytes: 7, sha256: hash(Buffer.from("package")) }];
  const expectation = releaseEffectFixture(base.before_checkpoint, {
    version: candidate.version,
    source_commit: candidate.prepared_commit,
    assets,
  });
  const publishIdentity = {
    ...identity,
    destination: `github-release:boburning/portcove:v${candidate.version}:publish`,
    release_expectation: expectation,
  };
  const published = inspectCapacityOperation({
    ...publishIdentity,
    id: digest(publishIdentity),
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: "github-release:boburning/portcove:release:321:immutable:abc",
        evidence_sha256: "a".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: null,
  })!;
  const release = {
    release_id: 321,
    immutable: true as const,
    source_commit: candidate.prepared_commit,
    version: candidate.version,
    assets: assets.map((a) => ({
      ...a,
      id: 500,
      release_id: 321,
      download_url: `https://github.com/boburning/portcove/releases/download/v${candidate.version}/${a.filename}`,
    })),
  };
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: base.executor_identity.controller_revision,
    locators: [
      { kind: "operation", id: published.id, sha256: digest(published) },
      {
        kind: "immutable-release",
        id: String(release.release_id),
        sha256: immutableReleaseProgressDigest(release),
      },
    ],
  };
  candidate.stage_evidence = [
    {
      phase: "promoting",
      attempts: [
        {
          previous_checkpoint: "a".repeat(40),
          release_run: { ...candidate.release_run, run_id: Number(candidate.release_run.run_id) },
          transient_retries: candidate.transient_retries,
          substantive_repairs: candidate.substantive_repairs,
          proof,
          evidence_sha256: digest(proof),
        },
      ],
    },
  ];
  const producer = operation.executor_identity!;
  const record = {
    schema_version: 1,
    kind: "owned-immutable-application-release",
    repository_id: 1354613114,
    namespace: "fixture",
    controller: {
      revision: producer.controller_revision,
      source_tree: "3".repeat(40),
      ref: producer.execution_ref,
      run_id: producer.run_id,
      run_attempt: 1,
    },
    producer: { job_id: producer.job_id, check_run_id: producer.check_run_id },
    context: { binding: {}, facts_sha256: "1".repeat(64), manifest_sha256: "2".repeat(64) },
    native: [],
    producer_sbom_sha256: "4".repeat(64),
    candidate: Object.fromEntries(
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
      ].map((key) => [key, candidate[key as keyof typeof candidate]]),
    ),
    settlement: { checkpoint: "a".repeat(40), operation: published },
    release,
    immutable_identity_sha256: immutableReleaseProgressDigest(release),
    scope: "settled-immutable-release-only",
    authority: "none",
    pending_obligations: [
      "authenticated-feed-deployment",
      "independent-public-byte-readback",
      "ordinary-public-updater-journey",
      "durable-candidate-completion",
    ],
  };
  const archive = createAuditZip([
    ["immutable-release-result.json", Buffer.from(JSON.stringify(record) + "\n")],
  ]);
  const run = {
    id: Number(producer.run_id),
    run_attempt: 1,
    head_sha: producer.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    actor: { id: Number(producer.actor_id) },
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: producer.job_id,
    run_id: Number(producer.run_id),
    run_attempt: 1,
    head_sha: producer.controller_revision,
    name: "Publish immutable application release",
    status: "completed",
    conclusion: "failure",
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}`,
  };
  const rows = [
    {
      id: 700,
      name: `trusted-immutable-release-result-${String(producer.run_id)}-1`,
      size_in_bytes: archive.length,
      digest: `sha256:${hash(archive)}`,
      expired: false,
      workflow_run: {
        id: Number(producer.run_id),
        repository_id: 1354613114,
        head_repository_id: 1354613114,
        head_sha: producer.controller_revision,
      },
    },
  ];
  return { candidate, operation, published, release, record, archive, run, job, rows };
}

export function publicationReportRepairStateFixture() {
  const f = publicationReportRepairFixture();
  const checkpoint = "c".repeat(40);
  const operation = inspectCapacityOperation({
    ...f.operation,
    outcome: "recovered",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:700",
        evidence_sha256: "a".repeat(64),
      },
    ],
    recovery: {
      checkpoint: "b".repeat(40),
      resolution: "effect-completed",
      evidence_sha256: "a".repeat(64),
    },
  })!;
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(f.candidate),
    expected_transient_retry: 1,
    substantive_repairs: 0,
    failure: "producer-failed",
    artifact_id: 700,
    artifact_sha256: "a".repeat(64),
    report_sha256: "b".repeat(64),
    context_manifest_sha256: "c".repeat(64),
    result_checkpoint: checkpoint,
    result_operation_id: operation.id,
    result_operation_sha256: digest(operation),
    result_operation: operation,
    publish_operation_id: f.published.id,
    publish_operation_sha256: digest(f.published),
    release_id: f.release.release_id,
    immutable_identity_sha256: f.record.immutable_identity_sha256,
  };
  const failed = {
    ...f.candidate,
    phase: "failed",
    failure_kind: "transient",
    report_repair: proof,
  };
  const prepared = {
    ...failed,
    phase: "prepared",
    failure_kind: null,
    transient_retries: 1,
    release_run: null,
  };
  return { ...f, checkpoint, operation, proof, failed, prepared };
}
