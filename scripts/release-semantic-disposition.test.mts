import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { capacityDigest } from "./release-capacity.mts";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import {
  inspectNegativeSemanticDisposition,
  prepareNegativeSemanticDispositionCheck,
} from "./release-semantic-disposition.mts";
import {
  prepareSemanticReviewHandoff,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
import { readIndependentSemanticReview } from "./release-control-inputs.mts";

void test("negative serialization binds the whole neutral request and preserves failure without manufacturing acceptance", () => {
  const input = negativeSemanticDispositionFixture();
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
    assert.equal(record.wire.review.coverage?.classification, false);
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
void test("proposal refusal retires no invented classification or full-opportunity coverage", () => {
  const full = negativeSemanticDispositionFixture();
  const proposed = {
    ...full,
    stage: "classification-proposal",
    disposition: "refused",
    opportunity: null,
    opportunity_sha256: null,
    review: { ...full.review, scope: "release-classification-proposal", coverage: null },
  };
  const result = inspectNegativeSemanticDisposition(proposed);
  assert.equal(result.stage, "classification-proposal");
  assert.equal(result.opportunity, null);
  assert.equal(result.opportunity_sha256, null);
  assert.equal(result.review.coverage, null);
  for (const mutation of [
    { ...proposed, disposition: "changes-required" },
    { ...proposed, opportunity: full.opportunity },
    { ...proposed, opportunity_sha256: full.opportunity_sha256 },
    { ...proposed, review: { ...proposed.review, coverage: full.review.coverage } },
    { ...proposed, review: { ...proposed.review, scope: "complete-release-opportunity" } },
  ])
    assert.throws(() => inspectNegativeSemanticDisposition(mutation));
});
void test("wrong request/opportunity, report mutation, missing capture hashes and startup outcomes cannot become dispositions", () => {
  const mutate = (
    apply: (input: ReturnType<typeof negativeSemanticDispositionFixture>) => void,
  ) => {
    const input = negativeSemanticDispositionFixture();
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
