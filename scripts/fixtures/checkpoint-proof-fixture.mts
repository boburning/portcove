import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { exportCoordinatorCheckpoint } from "../release-coordinator-state.mts";
import {
  coordinatorCheckpointEvidenceSubject,
  coordinatorCheckpointPredicateType,
} from "../release-coordinator-checkpoint-evidence.mts";
import { capacityExecutorJobProfile } from "../assembler-job-identity.mts";
import type { CheckpointProducerExpectation } from "../release-coordinator-checkpoint-authentication.mts";
import type { GitHubRestReader } from "../github-api.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
const actor = {
  name: "Portcove release coordinator",
  email: "coordinator@portcove.invalid",
  date: "2000-01-01T00:00:00Z",
};
export function checkpointProofFixture(
  checkpoint: Checkpoint = {
    schema_version: 1,
    checkpoint: "b".repeat(40),
    previous: "c".repeat(40),
    blob: { oid: "d".repeat(40), contents: "{}" },
    tree: {
      oid: "e".repeat(40),
      entries: [{ path: "state.json", mode: "100644", type: "blob", sha: "d".repeat(40) }],
    },
    commit: {
      oid: "b".repeat(40),
      tree: "e".repeat(40),
      parents: ["c".repeat(40)],
      message: "fixture",
      author: actor,
      committer: actor,
    },
    receipts: [],
    required_commits: [],
  },
  configuration = { schema_version: 1, namespace: "portcove-fixture" },
) {
  const profile = capacityExecutorJobProfile("coordinator");
  const producer: CheckpointProducerExpectation = {
    actor_id: "1122",
    check_run_id: "777",
    configuration_sha256: "1".repeat(64),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    controller_revision: "a".repeat(40),
    job_id: "501",
    run_attempt: 2,
    run_id: "9988",
    setup_sha256: "2".repeat(64),
    workflow_sha256: "3".repeat(64),
  };
  const subject = coordinatorCheckpointEvidenceSubject(checkpoint, configuration, producer);
  const sha256 = createHash("sha256").update(subject).digest("hex");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "portcove-coordinator-checkpoint-transition", digest: { sha256 } }],
    predicateType: coordinatorCheckpointPredicateType,
    predicate: { schema_version: 1, transition_sha256: sha256, producer },
  };
  const bundle = Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        signatures: [{ keyid: "inert", sig: "aW5lcnQ=" }],
      },
    }),
  );
  const job = {
    id: 501,
    run_id: 9988,
    run_attempt: 2,
    head_sha: producer.controller_revision,
    name: profile.job,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
    status: "completed",
    conclusion: "failure",
    labels: ["ubuntu-24.04"],
    started_at: "2026-10-23T12:00:00Z",
    completed_at: "2026-10-23T12:01:00Z",
  };
  const attempt = {
    id: 9988,
    run_attempt: 2,
    head_sha: producer.controller_revision,
    head_branch: producer.controller_ref.slice("refs/tags/".length),
    path: profile.workflow,
    event: "workflow_dispatch",
    status: "completed",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
    actor: { id: 1122 },
    triggering_actor: { id: 1122 },
  };
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: `https://github.com/boburning/portcove/${profile.workflow}@${producer.controller_ref}`,
    buildSignerDigest: producer.controller_revision,
    sourceRepositoryDigest: producer.controller_revision,
    sourceRepositoryRef: producer.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: "https://github.com/boburning/portcove/actions/runs/9988/attempts/2",
  };
  const verification = {
    signature: { certificate },
    verifiedTimestamps: [
      { type: "tlog", uri: "https://rekor.sigstore.dev", timestamp: "2026-10-23T12:00:30.123Z" },
    ],
    statement,
  };
  const calls: string[] = [];
  const faults = { value: "" };
  let attemptReads = 0;
  const api: GitHubRestReader = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      let body: unknown;
      if (endpoint.endsWith("/attempts/2")) {
        attemptReads++;
        body = {
          ...attempt,
          ...(faults.value === "changed-attempt" && attemptReads > 1 ? { run_attempt: 3 } : {}),
        };
      } else if (endpoint.includes("/attempts/2/jobs?")) {
        if (faults.value === "duplicate") body = { total_count: 2, jobs: [job, job] };
        else if (faults.value === "duplicate-check")
          body = { total_count: 2, jobs: [job, { ...job, id: 502 }] };
        else if (faults.value === "incomplete") body = { total_count: 101, jobs: [job] };
        else body = { total_count: 1, jobs: [job] };
      } else if (endpoint.endsWith("/actions/jobs/501"))
        body = {
          ...job,
          ...(faults.value === "changed-job"
            ? { check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/778" }
            : {}),
        };
      else assert.fail(`Unexpected historical route ${endpoint}`);
      return { status: 200, headers: new Map(), body };
    },
  };
  return {
    checkpoint,
    configuration,
    producer,
    evidence: { subject, bundle },
    expected: { role: "coordinator" as const, producer },
    job,
    attempt,
    verification,
    api,
    calls,
    faults,
  };
}
