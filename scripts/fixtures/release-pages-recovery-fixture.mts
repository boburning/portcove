import { capacityDigest } from "../release-capacity.mts";
import { capacityFixture } from "./release-capacity-fixture.mts";
export function pagesRecoveryOperationFixture() {
  const capacity = capacityFixture();
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate: {
      source_commit: "b".repeat(40),
      prepared_commit: "c".repeat(40),
      version: "0.1.0-beta.1",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "github-pages:boburning/portcove:complete-site",
    kind: "upload",
    sequence: 1,
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: capacityDigest(capacity.ratification),
    executor_nonce: "e".repeat(64),
    receipt_limit: 1,
    executor_identity: {
      controller_revision: "a".repeat(40),
      execution_ref: "refs/tags/controller-v1",
      workflow: ".github/workflows/controller.yml",
      run_id: "123",
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
      actor_id: "43177418",
      role: "site-publication",
    },
    site_expectation: {
      archive_sha256: "1".repeat(64),
      artifact_id: 123,
      prior_site_generation_sha256: "2".repeat(64),
      repository_sha256: "3".repeat(64),
      root_sha256: "4".repeat(64),
      site_generation_sha256: "5".repeat(64),
    },
  };
  return {
    ...identity,
    id: capacityDigest(identity),
    outcome: "pending",
    completed_effects: [] as { remote_identity: string; evidence_sha256: string }[],
    failure_evidence: null,
    recovery: null,
  };
}
