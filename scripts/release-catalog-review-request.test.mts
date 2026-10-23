import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  createCatalogReviewRequest,
  inspectCatalogReviewRequest,
  validateCatalogReviewRequestTransition,
} from "./release-catalog-review-request.mts";

function fixture() {
  const inspection = `${JSON.stringify({ authority: "none", definitions: [], files: [], index_sha256: "a".repeat(64), publication_schema: 1, scope: "inert-managed-definition-publication-inspection" })}\n`;
  const opportunity = {
    kind: "catalog-publication",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    base_commit: "3".repeat(40),
    change_set_sha256: "4".repeat(64),
    bundle_sha256: "5".repeat(64),
    core_inspection_sha256: createHash("sha256").update(inspection).digest("hex"),
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
      notes: "explicit inert contract fixture; no acceptance",
    },
  };
  const request = createCatalogReviewRequest({
    before_checkpoint: "b".repeat(40),
    requested_at: "2026-10-21T12:00:00.000Z",
    opportunity,
    core_inspection: inspection,
  });
  return { request, opportunity };
}
void test("neutral catalog request binds exact opportunity and lossless Core bytes without app version or acceptance", () => {
  const { request } = fixture();
  assert.deepEqual(inspectCatalogReviewRequest(request), request);
  assert.equal(Object.hasOwn(request, "base_version"), false);
  assert.equal(Object.hasOwn(request, "accepted"), false);
  const { request_id, ...identity } = request;
  assert.equal(digest(identity), request_id);
  for (const changed of [
    { ...request, core_inspection: request.core_inspection.trim() },
    { ...request, core_inspection: request.core_inspection.replace('"none"', '"accepted"') },
    { ...request, opportunity: { ...request.opportunity, source_tree: "f".repeat(40) } },
    { ...request, accepted: true },
    { ...request, core_inspection: " ".repeat(24 * 1024 + 1) },
  ])
    assert.throws(() => inspectCatalogReviewRequest(changed));
});
void test("neutral catalog request cannot be retimed/replaced or retired without same full descriptor baseline", () => {
  const { request, opportunity } = fixture();
  const initial = { now: request.requested_at, opportunity: null, active_candidate: null };
  const pending = { ...initial, catalog_review_request: request };
  validateCatalogReviewRequestTransition(initial, pending, request.before_checkpoint);
  assert.throws(
    () => validateCatalogReviewRequestTransition(initial, pending, "f".repeat(40)),
    /checkpoint/,
  );
  assert.throws(
    () =>
      validateCatalogReviewRequestTransition(
        pending,
        { ...pending, catalog_review_request: null },
        "c".repeat(40),
      ),
    /authenticated result/,
  );
  const changed = createCatalogReviewRequest({
    before_checkpoint: request.before_checkpoint,
    core_inspection: request.core_inspection,
    opportunity: request.opportunity,
    requested_at: "2026-10-21T12:01:00.000Z",
  });
  assert.throws(
    () =>
      validateCatalogReviewRequestTransition(
        pending,
        { ...pending, catalog_review_request: changed },
        "c".repeat(40),
      ),
    /replaced or retimed/,
  );
  const descriptor = {
    schema_version: 1,
    kind: "catalog-publication",
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    bundle_sha256: opportunity.bundle_sha256,
    core_inspection_sha256: opportunity.core_inspection_sha256,
    publisher_configuration_sha256: opportunity.publisher_configuration_sha256,
    admission_sha256: "e".repeat(64),
    prior: {
      catalog_root_sha256: opportunity.baseline.catalog_root_sha256,
      catalog_repository_sha256: null,
      site_generation_sha256: null,
      application_root_sha256: null,
      application_repository_sha256: null,
    },
  };
  const complete = { ...pending, catalog_review_request: null, catalog_publication: descriptor };
  validateCatalogReviewRequestTransition(pending, complete, "c".repeat(40));
  assert.throws(
    () =>
      validateCatalogReviewRequestTransition(
        pending,
        { ...complete, catalog_publication: { ...descriptor, source_tree: "f".repeat(40) } },
        "c".repeat(40),
      ),
    /changed reviewed inputs/,
  );
  assert.throws(
    () =>
      validateCatalogReviewRequestTransition(
        pending,
        {
          ...complete,
          catalog_publication: {
            ...descriptor,
            prior: { ...descriptor.prior, catalog_root_sha256: "f".repeat(64) },
          },
        },
        "c".repeat(40),
      ),
    /baseline/,
  );
  assert.throws(
    () =>
      validateCatalogReviewRequestTransition(
        pending,
        { ...complete, opportunity: { invented: "app" } },
        "c".repeat(40),
      ),
    /application/,
  );
});

void test("real journal freezes catalog request after inert initialization and rejects invented first request", async (context) => {
  const { request: prototype, opportunity } = fixture();
  const journal = disposableDirectory(context, path.join(os.tmpdir(), "catalog-review-journal-"));
  execFileSync("git", ["init", "--bare", "--quiet", journal], { windowsHide: true });
  const input = {
    schema_version: 2,
    now: prototype.requested_at,
    opportunity: null,
    active_candidate: null,
    controller: {
      workflow: ".github/workflows/application-update-production.yml",
      revision: "c".repeat(40),
      publication_paused: false,
      capacity_attempt: { ...capacityFixture(), schema_version: 2 },
    },
    publication: {
      complete: true,
      observed_at: prototype.requested_at,
      published_versions: [],
      published_sources: [],
      reserved_versions: [],
      last_routine_preview_at: null,
    },
    catalog_initialization: {
      schema_version: 1,
      kind: "catalog-initialization",
      authority: "none",
      source_commit: opportunity.baseline.source_commit,
      source_tree: opportunity.baseline.source_tree,
      root_sha256: opportunity.baseline.catalog_root_sha256,
      publisher_configuration_sha256: opportunity.publisher_configuration_sha256,
      setup_plan_sha256: "d".repeat(64),
      initial_site_preimage_sha256: "e".repeat(64),
    },
  };
  await assert.rejects(
    checkpointReleaseOpportunity(journal, null, { ...input, catalog_review_request: prototype }),
    /first coordinator checkpoint/,
  );
  const initial = await checkpointReleaseOpportunity(journal, null, input);
  const request = createCatalogReviewRequest({
    before_checkpoint: initial.checkpoint,
    requested_at: prototype.requested_at,
    opportunity,
    core_inspection: prototype.core_inspection,
  });
  const frozen = await checkpointReleaseOpportunity(journal, initial.checkpoint, {
    ...input,
    catalog_review_request: request,
  });
  const recovered = await recoverReleaseOpportunity(journal, frozen.checkpoint);
  assert.equal(recovered.plan.action, "catalog-review-request");
  assert.equal(recovered.input.active_candidate, null);
  assert.equal(recovered.input.opportunity, null);
  assert.deepEqual(recovered.input.catalog_review_request, request);
  assert.equal(Object.hasOwn(recovered.plan.authority, "catalog_publication_sha256"), false);
  await assert.rejects(
    checkpointReleaseOpportunity(journal, frozen.checkpoint, {
      ...input,
      catalog_review_request: null,
    }),
    /authenticated result/,
  );
});
