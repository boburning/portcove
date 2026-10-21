import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { createCatalogReviewRequest } from "./release-catalog-review-request.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import {
  compactCatalogReviewDisposition,
  inspectCatalogReviewDisposition,
  advanceCatalogReviewRecovery,
  validateCatalogReviewRecoveryTransition,
  receiveActualCatalogReviewDisposition,
  requireActualCatalogReviewDisposition,
} from "./release-catalog-review-disposition.mts";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = "2026-10-21T00:00:00.000Z";
function fixture() {
  const core =
    JSON.stringify({
      authority: "none",
      definitions: [],
      files: [],
      index_sha256: "a".repeat(64),
      publication_schema: 1,
      scope: "inert-managed-definition-publication-inspection",
    }) + "\n";
  const opportunity = {
    kind: "catalog-publication",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    base_commit: "3".repeat(40),
    change_set_sha256: "4".repeat(64),
    bundle_sha256: "5".repeat(64),
    core_inspection_sha256: sha(core),
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
      notes: "Inert empty catalog fixture; never acceptance.",
    },
  };
  const input: Record<string, unknown> = {
    schema_version: 2,
    now,
    opportunity: null,
    active_candidate: null,
    controller: {
      workflow: ".github/workflows/application-update-production.yml",
      revision: "9".repeat(40),
      publication_paused: false,
      capacity_attempt: { ...capacityFixture(), schema_version: 2 },
    },
    publication: {
      complete: true,
      observed_at: now,
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
      setup_plan_sha256: "b".repeat(64),
      initial_site_preimage_sha256: "c".repeat(64),
    },
  };
  const request = (checkpoint = "d".repeat(40), generation = 0, time = now) =>
    createCatalogReviewRequest({
      before_checkpoint: checkpoint,
      requested_at: time,
      core_inspection: core,
      opportunity: {
        ...opportunity,
        source_commit:
          generation === 0 ? opportunity.source_commit : sha("commit" + generation).slice(0, 40),
        source_tree:
          generation === 0 ? opportunity.source_tree : sha("tree" + generation).slice(0, 40),
      },
    });
  return { input, request };
}
function negative(
  request: ReturnType<ReturnType<typeof fixture>["request"]>,
  checkpoint: string,
  previous: unknown = null,
) {
  return compactCatalogReviewDisposition(
    {
      schema_version: 1,
      kind: "catalog-publication-semantic-disposition-receipt",
      request,
      request_checkpoint: checkpoint,
      check_run_id: 99,
      review_app_id: 123,
      stage: "complete-catalog-publication-opportunity",
      disposition: "changes-required",
      wire_sha256: "a".repeat(64),
      opportunity_sha256: digest(request.opportunity),
      bundle_sha256: "b".repeat(64),
      invocation_sha256: "c".repeat(64),
      events_sha256: "d".repeat(64),
      isolation_sha256: "e".repeat(64),
      report_sha256: "f".repeat(64),
      session_ref: "inert/negative",
      completed_at: request.requested_at,
    },
    previous,
  );
}
void test("compact negative is data-only, exact and bounded; raw objects cannot mint actual review custody", async () => {
  const f = fixture(),
    request = f.request(),
    receipt = negative(request, "d".repeat(40));
  assert.deepEqual(inspectCatalogReviewDisposition(receipt), receipt);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 4096);
  for (const patch of [
    { disposition: "accepted" },
    { stage: "classification-proposal" },
    { review_app_id: 15368 },
    { session_ref: "x".repeat(513) },
    { completed_at: "2026-02-30T00:00:00Z" },
    { transient_retries: 3 },
    { substantive_repairs: 4 },
    {
      prior_requests: [
        {
          request_id: request.request_id,
          source_commit: request.opportunity.source_commit,
          source_tree: request.opportunity.source_tree,
          check_run_id: 1,
          request_checkpoint: "d".repeat(40),
          wire_sha256: "a".repeat(64),
        },
      ],
    },
  ])
    assert.throws(() => inspectCatalogReviewDisposition({ ...receipt, ...patch }));
  await assert.rejects(
    requireActualCatalogReviewDisposition(receipt),
    /actual catalog negative receipt/,
  );
  await assert.rejects(
    receiveActualCatalogReviewDisposition(
      { evidence_scope: "github.com" },
      process.cwd(),
      request,
      "d".repeat(40),
      performance.now() + 1000,
    ),
    /catalog.*source|catalog.*receipt|catalog.*control|authenticated/iu,
  );
});
void test("negative retirement preserves unrelated holds/counters and only a fresh unchanged publication inventory may refresh", () => {
  const f = fixture(),
    request = f.request(),
    before = { ...f.input, catalog_review_request: request },
    receipt = negative(request, "d".repeat(40));
  const after = {
    ...before,
    now: "2026-10-21T00:01:00.000Z",
    publication: { ...(before.publication as object), observed_at: "2026-10-21T00:01:00.000Z" },
    catalog_review_request: null,
    catalog_review_disposition: receipt,
  };
  assert.equal(validateCatalogReviewRecoveryTransition(before, after, "d".repeat(40)), true);
  for (const patch of [
    { catalog_review_disposition: { ...receipt, request_checkpoint: "e".repeat(40) } },
    { catalog_review_disposition: { ...receipt, substantive_repairs: 1 } },
    { publication: { ...(after.publication as object), published_versions: ["0.1.0-beta.1"] } },
    { publication: { ...(after.publication as object), observed_at: "2026-10-21T00:02:00.000Z" } },
    { review_request: {} },
    { metadata_bootstrap: {} },
    { active_candidate: {} },
    { controller: { ...(before.controller as object), publication_paused: true } },
  ])
    assert.throws(() =>
      validateCatalogReviewRecoveryTransition(before, { ...after, ...patch }, "d".repeat(40)),
    );
  const unresolved = {
    ...before,
    controller: {
      ...(before.controller as Record<string, unknown>),
      capacity_attempt: {
        ...capacityFixture(),
        operation: { outcome: "recovered", recovery: { resolution: "partial-effects-retained" } },
      },
    },
  };
  assert.throws(
    () =>
      validateCatalogReviewRecoveryTransition(
        unresolved,
        { ...unresolved, catalog_review_request: null, catalog_review_disposition: receipt },
        "d".repeat(40),
      ),
    /unresolved/,
  );
  assert.throws(
    () =>
      validateCatalogReviewRecoveryTransition(
        { ...after },
        { ...after, catalog_review_disposition: null },
        "d".repeat(40),
      ),
    /disappear/,
  );
});
void test("initial request refresh delegates existing validator; repair reservations stay on exact state and require changed source AND tree", () => {
  const f = fixture(),
    request = f.request();
  assert.equal(
    validateCatalogReviewRecoveryTransition(
      f.input,
      {
        ...f.input,
        publication: {
          ...(f.input.publication as object),
          last_routine_preview_bound: "all-published-previews",
        },
        catalog_review_request: request,
      },
      "d".repeat(40),
    ),
    false,
  );
  const old = negative(request, "d".repeat(40)),
    input = { ...f.input, catalog_review_disposition: old };
  const changed = f.request("d".repeat(40), 1),
    reserved = advanceCatalogReviewRecovery(old, changed, input)!;
  assert.equal(reserved.substantive_repairs, 1);
  assert.equal(reserved.transient_retries, 0);
  assert.equal(
    validateCatalogReviewRecoveryTransition(
      input,
      { ...input, catalog_review_request: changed, catalog_review_disposition: reserved },
      "d".repeat(40),
    ),
    false,
  );
  for (const op of [
    request.opportunity,
    { ...changed.opportunity, source_tree: request.opportunity.source_tree },
    { ...changed.opportunity, source_commit: request.opportunity.source_commit },
  ]) {
    const same = createCatalogReviewRequest({
      before_checkpoint: "d".repeat(40),
      requested_at: now,
      core_inspection: request.core_inspection,
      opportunity: op,
    });
    assert.throws(() => advanceCatalogReviewRecovery(old, same, input), /changed source AND tree/);
  }
  assert.throws(
    () =>
      validateCatalogReviewRecoveryTransition(
        input,
        { ...input, catalog_review_request: changed, catalog_review_disposition: old },
        "d".repeat(40),
      ),
    /counters/,
  );
  const advanced = createCatalogReviewRequest({
    before_checkpoint: "d".repeat(40),
    requested_at: now,
    core_inspection: request.core_inspection,
    opportunity: {
      ...changed.opportunity,
      baseline: { ...changed.opportunity.baseline, catalog_root_sha256: "e".repeat(64) },
    },
  });
  assert.throws(
    () => advanceCatalogReviewRecovery(old, advanced, { ...input, catalog_initialization: null }),
    /actual durable/,
  );
});
void test("real bare Git journal retires exact negative and allows only three distinct changed-source repairs without retry/counter erasure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-negative-journal-"));
  try {
    const bare = path.join(root, "journal");
    await mkdir(bare);
    execFileSync("git", ["init", "--bare", "--quiet", bare]);
    const f = fixture();
    let checkpoint = (await checkpointReleaseOpportunity(bare, null, f.input)).checkpoint;
    let input = (await recoverReleaseOpportunity(bare, checkpoint)).input;
    const save = async (next: Record<string, unknown>) => {
      const result = await checkpointReleaseOpportunity(bare, checkpoint, next);
      checkpoint = result.checkpoint;
      input = (await recoverReleaseOpportunity(bare, checkpoint)).input;
      return result;
    };
    for (let generation = 0; generation <= 3; generation++) {
      const request = f.request(checkpoint, generation),
        old = input.catalog_review_disposition;
      const reserved = advanceCatalogReviewRecovery(old, request, input);
      await save({
        ...input,
        catalog_review_request: request,
        ...(old == null ? {} : { catalog_review_disposition: reserved }),
      });
      const frozen = checkpoint,
        receipt = negative(request, frozen, input.catalog_review_disposition);
      await assert.rejects(
        save({
          ...input,
          catalog_review_request: null,
          catalog_review_disposition: { ...receipt, request_checkpoint: "f".repeat(40) },
        }),
        /request/,
      );
      await save({ ...input, catalog_review_request: null, catalog_review_disposition: receipt });
      const read = inspectCatalogReviewDisposition(input.catalog_review_disposition)!;
      assert.equal(read.substantive_repairs, generation);
      assert.equal(read.prior_requests.length, generation);
      assert.equal(read.transient_retries, 0);
      assert.equal(read.request.request_id, request.request_id);
      assert.equal(read.request_checkpoint, frozen);
    }
    assert.throws(
      () =>
        advanceCatalogReviewRecovery(
          input.catalog_review_disposition,
          f.request(checkpoint, 4),
          input,
        ),
      /exhausted/,
    );
    await assert.rejects(save({ ...input, catalog_review_disposition: null }), /disappear/);
    assert.equal(
      inspectCatalogReviewDisposition(
        (await recoverReleaseOpportunity(bare, checkpoint)).input.catalog_review_disposition,
      )?.substantive_repairs,
      3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
