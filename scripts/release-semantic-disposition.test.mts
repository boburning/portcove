import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { capacityDigest } from "./release-capacity.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import {
  inspectNegativeSemanticDisposition,
  prepareNegativeSemanticDispositionCheck,
} from "./release-semantic-disposition.mts";
import {
  prepareSemanticReviewHandoff,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
import { readIndependentSemanticReview } from "./release-control-inputs.mts";

function fixture() {
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
void test("negative serialization binds the whole neutral request and preserves failure without manufacturing acceptance", () => {
  const input = fixture();
  for (const disposition of ["changes-required", "refused"]) {
    const record = prepareNegativeSemanticDispositionCheck({ ...input, disposition });
    assert.equal(record.authority, "none");
    assert.equal(record.proposed_request.body.name, semanticReviewCheckName);
    assert.equal(record.proposed_request.body.conclusion, "failure");
    assert.equal(
      record.proposed_request.body.external_id,
      `portcove-release-review-negative-v1:${capacityDigest(record.wire)}`,
    );
    assert.deepEqual(
      inspectNegativeSemanticDisposition(JSON.parse(record.proposed_request.body.output.summary)),
      record.wire,
    );
    assert.equal(record.wire.review.coverage.classification, false);
    assert.throws(() => prepareSemanticReviewHandoff(input.opportunity, record.wire.review));
    const reader = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        assert.ok(
          ["repos/boburning/portcove", "repos/boburning/portcove/check-runs/99"].includes(endpoint),
        );
        return {
          status: 200,
          headers: new Map<string, string>(),
          body:
            endpoint === "repos/boburning/portcove"
              ? { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" }
              : {
                  ...record.proposed_request.body,
                  id: 99,
                  app: { id: 123 },
                  output: record.proposed_request.body.output,
                },
        };
      },
      graphql() {
        throw new Error("fixture disallows GraphQL");
      },
    };
    assert.throws(
      () =>
        readIndependentSemanticReview(
          reader,
          {
            schema_version: 1,
            review_app_id: 123,
            writer_app_id: 456,
            review_check_name: semanticReviewCheckName,
          },
          input.opportunity,
          99,
        ),
      /independent semantic review/,
    );
  }
  const record = inspectNegativeSemanticDisposition(input);
  input.review.report = "changed after serialization";
  assert.notEqual(record.review.report, input.review.report);
});
void test("wrong request/opportunity, report mutation, missing capture hashes and startup outcomes cannot become dispositions", () => {
  const mutate = (apply: (input: ReturnType<typeof fixture>) => void) => {
    const input = fixture();
    apply(input);
    assert.throws(() => inspectNegativeSemanticDisposition(input));
  };
  mutate((input) => {
    input.request_id = "f".repeat(64);
  });
  mutate((input) => {
    input.opportunity.urgency = true;
  });
  mutate((input) => {
    input.opportunity.classification.base_version = "0.1.0-alpha.1";
    input.opportunity_sha256 = capacityDigest(input.opportunity);
  });
  mutate((input) => {
    input.opportunity.base_commit = "f".repeat(40);
    input.opportunity_sha256 = capacityDigest(input.opportunity);
  });
  mutate((input) => {
    input.review.report += " substituted";
  });
  mutate((input) => {
    input.events_sha256 = "";
  });
  mutate((input) => {
    input.isolation_sha256 = "missing";
  });
  for (const disposition of ["accepted", "startup-failed", "parser-failed", "cancelled"])
    mutate((input) => {
      input.disposition = disposition;
    });
  for (const completed of [
    "2026-02-30T00:00:00Z",
    "2026-10-20T00:01:00.000Z",
    "2026-10-19T23:59:59Z",
  ])
    mutate((input) => {
      input.review.completed_at = completed;
    });
  mutate((input) => {
    input.review.report = "x".repeat(48 * 1024 + 1);
    input.review.report_sha256 = createHash("sha256").update(input.review.report).digest("hex");
  });
});
