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

// Disposable inert tuple only: no capture/provider admission is manufactured.
function catalogFixture() {
  const core = `${JSON.stringify({ authority: "none", definitions: [], files: [], index_sha256: "a".repeat(64), publication_schema: 1, scope: "inert-managed-definition-publication-inspection" })}\n`;
  const opportunity = {
    kind: "catalog-publication",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    base_commit: "3".repeat(40),
    change_set_sha256: "4".repeat(64),
    bundle_sha256: "5".repeat(64),
    core_inspection_sha256: createHash("sha256").update(core).digest("hex"),
    publisher_configuration_sha256: "6".repeat(64),
    baseline: {
      source_commit: "3".repeat(40),
      source_tree: "7".repeat(40),
      catalog_root_sha256: "8".repeat(64),
      catalog_repository_sha256: null,
      site_generation_sha256: null,
      application_root_sha256: null,
      application_repository_sha256: null,
    },
    classification: { change: "initial", definitions: [], index_sha256: "a".repeat(64) },
    compatibility: {
      contract: "official-definition-policy-launch-v1",
      notes: "Inert fixture; no semantic acceptance.",
    },
  };
  const request = createCatalogReviewRequest({
    before_checkpoint: "b".repeat(40),
    requested_at: "2026-01-01T00:00:00.000Z",
    opportunity,
    core_inspection: core,
  });
  const app = negativeSemanticDispositionFixture();
  const wire = {
    ...app,
    kind: "catalog-publication-semantic-disposition",
    stage: "complete-catalog-publication-opportunity",
    request,
    request_id: request.request_id,
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    review: { ...app.review, scope: "complete-catalog-publication-opportunity" },
  };
  return { request, wire };
}
import { createCatalogReviewRequest } from "./release-catalog-review-request.mts";
import {
  inspectNegativeCatalogSemanticDisposition,
  prepareNegativeCatalogSemanticDispositionCheck,
} from "./release-semantic-disposition.mts";
import {
  readIndependentCatalogSemanticDisposition,
  inspectCatalogSemanticRequestCheckMatches,
  inspectSemanticRequestCheckMatches,
  createCatalogReviewDispositionReceipt,
} from "./release-semantic-disposition-reader.mts";
import { inspectSemanticWorkerRequest } from "./release-semantic-worker.mts";
import { prepareCapturedSemanticDisposition } from "./release-semantic-runtime.mts";

void test("catalog negative wire binds exact full request, never app classification or accepted result", async () => {
  const { request, wire } = catalogFixture(),
    result = prepareNegativeCatalogSemanticDispositionCheck(wire);
  assert.equal(result.proposed_request.body.conclusion, "failure");
  assert.match(result.proposed_request.body.external_id, /^portcove-catalog-review-negative-v1:/u);
  assert.deepEqual(inspectNegativeCatalogSemanticDisposition(result.wire).request, request);
  assert.throws(() => inspectNegativeSemanticDisposition(result.wire));
  assert.throws(() =>
    inspectNegativeCatalogSemanticDisposition(negativeSemanticDispositionFixture()),
  );
  for (const changed of [
    { ...wire, disposition: "accepted" },
    { ...wire, stage: "classification-proposal" },
    { ...wire, opportunity: { ...wire.opportunity, source_tree: "f".repeat(40) } },
    { ...wire, review: { ...wire.review, scope: "complete-release-opportunity" } },
    { ...wire, review: { ...wire.review, report: "changed" } },
    { ...wire, review: { ...wire.review, report: "x".repeat(64 * 1024) } },
  ])
    assert.throws(() => inspectNegativeCatalogSemanticDisposition(changed));
  await assert.rejects(
    prepareCapturedSemanticDisposition({
      kind: "complete-catalog-publication-opportunity",
      request,
      error: new Error("copied negative result"),
    }),
    /imported failure/u,
  );
});
void test("catalog GET reader and complete inventory preserve negative identity, drift and conflicting outcome refusal", () => {
  const { request, wire } = catalogFixture(),
    record = prepareNegativeCatalogSemanticDispositionCheck(wire);
  const row = {
    ...record.proposed_request.body,
    id: 99,
    app: { id: 123 },
    output: { ...record.proposed_request.body.output, annotations_count: 0 },
  };
  const producer = {
    schema_version: 1,
    review_app_id: 123,
    writer_app_id: 456,
    review_check_name: semanticReviewCheckName,
  };
  const reader = (mutate?: (v: typeof row, n: number) => unknown) => {
    let n = 0;
    return {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        return {
          status: 200,
          headers: new Map<string, string>(),
          body:
            endpoint === "repos/boburning/portcove"
              ? { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" }
              : mutate
                ? mutate(structuredClone(row), ++n)
                : structuredClone(row),
        };
      },
    };
  };
  const proof = readIndependentCatalogSemanticDisposition(reader(), producer, request, 99);
  assert.equal(proof.authority, "none");
  assert.equal(
    createCatalogReviewDispositionReceipt(proof, request.before_checkpoint).request.request_id,
    request.request_id,
  );
  assert.deepEqual(inspectCatalogSemanticRequestCheckMatches([row], request).negative, [99]);
  assert.deepEqual(
    inspectSemanticRequestCheckMatches([row], negativeSemanticDispositionFixture().request)
      .negative,
    [],
  );
  assert.throws(
    () => inspectCatalogSemanticRequestCheckMatches([row, { ...row, id: 100 }], request),
    /duplicate|conflict/u,
  );
  for (const mutation of [
    (v: typeof row) => ({ ...v, app: { id: 456 } }),
    (v: typeof row) => ({ ...v, head_sha: "f".repeat(40) }),
    (v: typeof row) => ({ ...v, conclusion: "success" }),
    (v: typeof row, n: number) => (n === 2 ? { ...v, external_id: "changed" } : v),
  ])
    assert.throws(() =>
      readIndependentCatalogSemanticDisposition(reader(mutation), producer, request, 99),
    );
  const accepted = prepareSemanticReviewHandoff(request.opportunity, {
    runtime: "codex-independent-local-review",
    scope: "complete-catalog-publication-opportunity",
    session_ref: "inert",
    completed_at: wire.review.completed_at,
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Inert accepted wire, not actual runtime.",
    accepted_opportunity: request.opportunity,
  });
  const acceptedRow = {
    ...accepted.proposed_request.body,
    id: 101,
    app: { id: 123 },
    output: { ...accepted.proposed_request.body.output, annotations_count: 0 },
  };
  assert.equal(
    inspectCatalogSemanticRequestCheckMatches([acceptedRow], request).accepted[0]?.check_run_id,
    101,
  );
  assert.throws(
    () => inspectCatalogSemanticRequestCheckMatches([row, acceptedRow], request),
    /conflict/u,
  );
});
void test("worker chooses exact catalog purpose without application version and refuses malformed or simultaneous requests", () => {
  const { request } = catalogFixture();
  const selected = inspectSemanticWorkerRequest({ catalog_review_request: request });
  assert.equal(selected?.purpose, "catalog");
  assert.equal(selected?.source_commit, request.opportunity.source_commit);
  assert.equal(Object.hasOwn(selected.request, "base_version"), false);
  assert.equal(inspectSemanticWorkerRequest({}), null);
  assert.throws(
    () =>
      inspectSemanticWorkerRequest({
        catalog_review_request: request,
        review_request: negativeSemanticDispositionFixture().request,
      }),
    /simultaneous/u,
  );
  assert.throws(() =>
    inspectSemanticWorkerRequest({
      catalog_review_request: { ...request, request_id: "f".repeat(64) },
    }),
  );
  assert.throws(() =>
    inspectSemanticWorkerRequest({
      catalog_review_request: request,
      published_site: { malformed: true },
    }),
  );
});
