import assert from "node:assert/strict";
import test from "node:test";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import { prepareNegativeSemanticDispositionCheck } from "./release-semantic-disposition.mts";
import { readIndependentSemanticDisposition } from "./release-semantic-disposition-reader.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { isRecord } from "./runtime-values.mts";

const config = {
  schema_version: 1,
  review_app_id: 123,
  writer_app_id: 456,
  review_check_name: semanticReviewCheckName,
};
function fixture(stage = "complete-opportunity", mode = "valid") {
  const full = negativeSemanticDispositionFixture();
  const wire =
    stage === "complete-opportunity"
      ? full
      : {
          ...full,
          stage,
          disposition: "refused",
          opportunity: null,
          opportunity_sha256: null,
          review: { ...full.review, scope: "release-classification-proposal", coverage: null },
        };
  const serialized = prepareNegativeSemanticDispositionCheck(wire);
  const check = {
    ...serialized.proposed_request.body,
    id: 99,
    app: { id: config.review_app_id },
    output: { ...serialized.proposed_request.body.output, annotations_count: 0, text: "" },
  };
  const calls: string[] = [];
  let checks = 0;
  return {
    wire: serialized.wire,
    check,
    calls,
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        let body: Record<string, unknown>;
        if (endpoint === "repos/boburning/portcove")
          body = {
            id: 1354613114,
            full_name: "boburning/portcove",
            node_id: mode === "repository-drift" && calls.length > 1 ? "R_changed" : "R_fixture",
          };
        else {
          assert.equal(endpoint, "repos/boburning/portcove/check-runs/99");
          checks++;
          body = structuredClone(check);
          if (mode === "app") body.app = { id: config.writer_app_id };
          if (mode === "head") body.head_sha = "f".repeat(40);
          if (mode === "success") body.conclusion = "success";
          if (mode === "name") body.name = "caller-selected-check";
          if (mode === "external")
            body.external_id = "portcove-release-review-negative-v1:" + "f".repeat(64);
          if (mode === "future") body.completed_at = "2999-01-01T00:00:00Z";
          assert.ok(isRecord(body.output));
          if (mode === "title") body.output.title = "Portcove independent release review v1";
          if (mode === "annotations") body.output.annotations_count = 1;
          if (mode === "body-drift" && checks > 1)
            body.output.summary = String(body.output.summary) + " ";
          if (mode === "report-tamper") {
            const value: unknown = JSON.parse(String(body.output.summary));
            assert.ok(isRecord(value) && isRecord(value.review));
            value.review.report = "changed report bytes";
            body.output.summary = JSON.stringify(value);
          }
        }
        return { status: 200, headers: new Map<string, string>(), body };
      },
    },
  };
}
void test("fixed GET consumer brackets real-format negative Check and repository for both exact stages", () => {
  for (const stage of ["complete-opportunity", "classification-proposal"]) {
    const f = fixture(stage);
    const read = readIndependentSemanticDisposition(f.api, config, f.wire.request, 99);
    assert.deepEqual(read.wire, f.wire);
    assert.equal(read.authority, "none");
    assert.equal(read.check_run_id, 99);
    assert.equal(read.review_app_id, config.review_app_id);
    assert.equal(f.calls.length, 4);
  }
});
void test("foreign issuer/input, success, malformed report, future time and changed second read refuse without writes", () => {
  for (const mode of [
    "app",
    "head",
    "success",
    "name",
    "external",
    "future",
    "title",
    "annotations",
    "body-drift",
    "report-tamper",
    "repository-drift",
  ]) {
    const f = fixture("complete-opportunity", mode);
    assert.throws(() => readIndependentSemanticDisposition(f.api, config, f.wire.request, 99));
    assert.ok(f.calls.length <= 4);
  }
  const f = fixture();
  for (const bad of [
    { ...config, review_app_id: 15368 },
    { ...config, writer_app_id: config.review_app_id },
    { ...config, review_check_name: "generic" },
  ]) {
    assert.throws(() => readIndependentSemanticDisposition(f.api, bad, f.wire.request, 99));
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() =>
    readIndependentSemanticDisposition(
      f.api,
      config,
      { ...f.wire.request, requested_at: "2026-10-20T00:00:01.000Z" },
      99,
    ),
  );
  assert.equal(f.calls.length, 0);
});
