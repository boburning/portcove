import { createHash } from "node:crypto";
import { capacityDigest } from "../release-capacity.mts";
import { createReleaseReviewRequest } from "../release-review-request.mts";

export function negativeSemanticDispositionFixture() {
  const opportunity = {
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    base_commit: "c".repeat(40),
    change_set_sha256: "d".repeat(64),
    complete_change_set: true,
    meaningful: true,
    documentation_only: false,
    urgency: false,
    requested_channel: "preview",
    classification: {
      source_commit: "a".repeat(40),
      reviewed_commit: "a".repeat(40),
      source_tree: "b".repeat(40),
      reviewed_tree: "b".repeat(40),
      change_set_sha256: "d".repeat(64),
      change_set_scope: "portcove-release-net-tree-delta-v1",
      base_version: "0.1.0-alpha.2",
      change: "prerelease",
      compatibility: "compatible",
    },
  };
  const request = createReleaseReviewRequest({
    before_checkpoint: "e".repeat(40),
    requested_at: "2026-10-20T00:00:00.123Z",
    base_commit: opportunity.base_commit,
    base_version: opportunity.classification.base_version,
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
  });
  const report = "Fixture actual negative result; not evidence of a real runtime or issuer.";
  return {
    schema_version: 1,
    kind: "application-release-semantic-disposition",
    stage: "complete-opportunity",
    disposition: "changes-required",
    request,
    request_id: request.request_id,
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    bundle_sha256: "1".repeat(64),
    invocation_sha256: "2".repeat(64),
    events_sha256: "3".repeat(64),
    isolation_sha256: "4".repeat(64),
    review: {
      runtime: "codex-independent-local-review",
      scope: "complete-release-opportunity",
      session_ref: "fixture:separate-runtime",
      completed_at: "2026-10-20T00:01:00Z",
      coverage: { accumulated_changes: true, classification: false, compatibility: false },
      report,
      report_sha256: createHash("sha256").update(report).digest("hex"),
    },
  };
}
