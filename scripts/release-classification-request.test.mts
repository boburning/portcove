import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseControlInputsFixture,
  config,
  opportunity,
} from "./fixtures/release-control-inputs-fixture.mts";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import {
  persistReviewedClassificationForRequest,
  inspectClassificationRequestReadiness,
} from "./release-classification-request.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { prepareNegativeSemanticDispositionCheck } from "./release-semantic-disposition.mts";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";

function fixture(mode = "valid") {
  const producer = { ...config, review_check_name: semanticReviewCheckName };
  const f = releaseControlInputsFixture(undefined, opportunity, producer);
  const request = createReleaseReviewRequest({
    before_checkpoint: "1".repeat(40),
    requested_at: "2025-12-31T00:00:00.000Z",
    base_commit: opportunity.base_commit,
    base_version: opportunity.classification.base_version,
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
  });
  const negativeFixture = negativeSemanticDispositionFixture();
  const negative = prepareNegativeSemanticDispositionCheck({
    ...negativeFixture,
    request,
    request_id: request.request_id,
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    review: { ...negativeFixture.review, completed_at: "2026-01-01T00:00:00Z" },
  }).proposed_request.body;
  let snapshots = 0;
  const api = {
    ...f.api,
    request(method: string, endpoint: string, body?: unknown) {
      if (endpoint.includes("/commits/") && endpoint.includes("/check-suites?")) {
        snapshots++;
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: {
            total_count: 1,
            check_suites: [
              {
                id: 404,
                head_sha: opportunity.source_commit,
                app: { id: producer.review_app_id },
                repository: { id: 1354613114, full_name: "boburning/portcove" },
              },
            ],
          },
        };
      }
      if (endpoint.includes("/check-suites/404/check-runs?")) {
        const value = f.api.request("GET", "repos/boburning/portcove/check-runs/303").body;
        assert.ok(isRecord(value));
        const accepted = {
          ...value,
          check_suite: { id: 404 },
          external_id: `portcove-release-review-v2:${capacityDigest(opportunity)}`,
        };
        const records: Record<string, unknown>[] = mode === "missing" ? [] : [accepted];
        if (mode === "duplicate") records.push({ ...accepted, id: 304 });
        if (mode === "conflict" || (mode === "late-conflict" && snapshots > 2))
          records.push({
            ...negative,
            id: 505,
            app: { id: producer.review_app_id },
            check_suite: { id: 404 },
            output: { ...negative.output, annotations_count: 0, text: "" },
          });
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: { total_count: records.length, check_runs: records },
        };
      }
      return f.api.request(method, endpoint, body);
    },
  };
  return { ...f, api, producer, request };
}

void test("automatic writer discovers exact accepted Check and reuses existing once-only CAS", () => {
  const f = fixture();
  let guarded = 0;
  const first = persistReviewedClassificationForRequest(f.api, f.producer, f.request, () => {
    guarded++;
  });
  assert.equal(first.changed, true);
  assert.equal(first.review_check_id, 303);
  assert.equal(first.request_id, f.request.request_id);
  assert.equal(
    persistReviewedClassificationForRequest(f.api, f.producer, f.request, () => {
      guarded++;
    }).changed,
    false,
  );
  assert.equal(f.mutations(), 1);
  assert.equal(guarded, 1);
});
void test("missing, duplicate, negative conflict, late inventory drift and failed caller guard cause zero writes", () => {
  for (const mode of ["missing", "duplicate", "conflict", "late-conflict", "guard"]) {
    const f = fixture(mode);
    assert.throws(() =>
      persistReviewedClassificationForRequest(f.api, f.producer, f.request, () => {
        if (mode === "guard") throw new Error("current journal request changed");
      }),
    );
    assert.equal(f.mutations(), 0, mode);
  }
});

void test("automatic classification routing is read-only, holds missing/conflicting review, and skips persisted acceptance", () => {
  for (const [mode, eligible] of [
    ["valid", true],
    ["missing", false],
  ] as const) {
    const f = fixture(mode);
    const readiness = inspectClassificationRequestReadiness(f.api, f.producer, f.request);
    assert.equal(readiness.eligible, eligible, mode);
    assert.equal(readiness.authority, "none");
    assert.equal(f.mutations(), 0);
  }
  const f = fixture();
  assert.equal(inspectClassificationRequestReadiness(f.api, f.producer, null).eligible, false);
  persistReviewedClassificationForRequest(f.api, f.producer, f.request, () => {});
  const current = inspectClassificationRequestReadiness(f.api, f.producer, f.request);
  assert.equal(current.eligible, false);
  assert.equal(current.reason, "already-persisted");
  assert.equal(f.mutations(), 1);
  for (const mode of ["duplicate", "conflict", "late-conflict"]) {
    const drift = fixture(mode);
    assert.throws(() =>
      inspectClassificationRequestReadiness(drift.api, drift.producer, drift.request),
    );
    assert.equal(drift.mutations(), 0);
  }
});
