import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { metadataFixture, metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  createCatalogReviewRequest,
  inspectCatalogReviewRequest,
  refreezeCatalogReviewAfterApplicationMetadata,
} from "./release-catalog-review-request.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  readRetainedCoordinatorCheckpoint,
  readCatalogReviewMaintenanceLineage,
  hydrateCatalogReviewMaintenanceLineage,
} from "./release-coordinator-state.mts";
import {
  runBoundedMetadataRenewalOperation,
  recordPublishedApplicationSiteMetadata,
} from "./release-capacity-operation.mts";
import {
  currentPublishedSite,
  applicationPublishedSiteCursor,
} from "./release-catalog-metadata-contract.mts";
import { applicationMetadataMaintenancePriority } from "./release-metadata-contract.mts";
import { readWakePurposePriority } from "./release-controller-wake.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import {
  compactCatalogReviewDisposition,
  advanceCatalogReviewRecovery,
} from "./release-catalog-review-disposition.mts";
import { prepareSemanticReviewHandoff } from "./release-semantic-review.mts";
import { inspectCatalogSemanticRequestCheckMatches } from "./release-semantic-disposition-reader.mts";
import {
  claimSemanticTechnicalAttempt,
  reconcileCatalogSemanticTechnicalPredecessors,
} from "./release-semantic-worker-recovery.mts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const now = new Date().toISOString(),
    metadata = metadataFixture(Date.parse(now));
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
      application_root_sha256: metadata.published.root_sha256,
      application_repository_sha256: metadata.published.repository_sha256,
      site_generation_sha256: metadata.published.publication.site_generation_sha256,
    },
    classification: { change: "initial", definitions: [], index_sha256: "a".repeat(64) },
    compatibility: {
      contract: "official-definition-policy-launch-v1",
      notes: "Inert maintenance fixture, no semantic/provider acceptance.",
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
    published_metadata: metadata.published,
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
  const request = (checkpoint: string, source = "1", tree = "2") =>
    createCatalogReviewRequest({
      before_checkpoint: checkpoint,
      requested_at: now,
      core_inspection: core,
      opportunity: {
        ...opportunity,
        source_commit: source.repeat(40),
        source_tree: tree.repeat(40),
      },
    });
  return { input, request, metadata };
}
function negative(request: ReturnType<ReturnType<typeof fixture>["request"]>, checkpoint: string) {
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
    null,
  );
}
void test("real App renewal readback atomically refreezes catalog pending request with immutable predecessor and exact negative counters", async (t) => {
  const f = fixture(),
    repository = await mkdtemp(path.join(os.tmpdir(), "catalog-maintenance-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", repository], {
    windowsHide: true,
    timeout: 10000,
  });
  const initial = await checkpointReleaseOpportunity(repository, null, f.input),
    old = f.request(initial.checkpoint, "a", "b");
  const first = await checkpointReleaseOpportunity(repository, initial.checkpoint, {
    ...f.input,
    catalog_review_request: old,
  });
  const history = negative(old, first.checkpoint);
  const retired = await checkpointReleaseOpportunity(repository, first.checkpoint, {
    ...f.input,
    catalog_review_request: null,
    catalog_review_disposition: history,
  });
  const current = f.request(retired.checkpoint);
  const retained = advanceCatalogReviewRecovery(history, current, {
    ...f.input,
    catalog_review_disposition: history,
  });
  const pending = await checkpointReleaseOpportunity(repository, retired.checkpoint, {
    ...f.input,
    catalog_review_request: current,
    catalog_review_disposition: retained,
  });
  const before = await recoverReleaseOpportunity(repository, pending.checkpoint);
  assert.equal(before.plan.action, "skip");
  assert.match(before.plan.reason, /metadata maintenance/);
  assert.equal(
    applicationMetadataMaintenancePriority(before.input, String(before.input.now)),
    "renewal",
  );
  const capacity = capacityFixture(),
    nextRepository = "d".repeat(64),
    nextGeneration = "e".repeat(64),
    evidence = "f".repeat(64);
  const operation = await runBoundedMetadataRenewalOperation(
    repository,
    pending.checkpoint,
    f.metadata.descriptor,
    {
      kind: "upload",
      destination: "github-pages:boburning/portcove:complete-site",
      site_expectation: {
        artifact_id: 123,
        archive_sha256: "c".repeat(64),
        prior_site_generation_sha256: f.metadata.published.publication.site_generation_sha256,
        root_sha256: f.metadata.published.root_sha256,
        repository_sha256: nextRepository,
        site_generation_sha256: nextGeneration,
      },
    },
    async () => capacity.boundary,
    async (record) => {
      await record(`github-pages:boburning/portcove:${nextGeneration}`, evidence);
    },
    {
      maximumReceipts: 1,
      executorIdentity: {
        actor_id: "1",
        check_run_id: "2",
        controller_revision: "9".repeat(40),
        execution_ref: "refs/tags/fixture",
        job_id: 4,
        role: "site-publication",
        run_attempt: 1,
        run_id: "5",
        workflow: ".github/workflows/fixture.yml",
      },
    },
  );
  const saved = await recordPublishedApplicationSiteMetadata(repository, operation.checkpoint, {
    ...f.metadata.published,
    repository_sha256: nextRepository,
    snapshot_sha256: "6".repeat(64),
    timestamp_sha256: "7".repeat(64),
    versions: f.metadata.descriptor.next_versions,
    expires: f.metadata.descriptor.next_expires,
    operation_id: operation.operation.id,
    publication: {
      remote_identity: `github-pages:boburning/portcove:${nextGeneration}`,
      evidence_sha256: evidence,
      site_generation_sha256: nextGeneration,
    },
  });
  const after = await recoverReleaseOpportunity(repository, saved.checkpoint),
    request = inspectCatalogReviewRequest(after.input.catalog_review_request)!;
  assert.notEqual(request.request_id, current.request_id);
  assert.equal(request.before_checkpoint, operation.checkpoint);
  assert.equal(request.core_inspection, current.core_inspection);
  assert.equal(request.opportunity.source_commit, current.opportunity.source_commit);
  assert.deepEqual(after.input.catalog_review_disposition, retained);
  assert.equal(request.opportunity.baseline.application_repository_sha256, nextRepository);
  assert.equal(request.opportunity.baseline.site_generation_sha256, nextGeneration);
  assert.deepEqual(
    readRetainedCoordinatorCheckpoint(repository, request.before_checkpoint).input
      .catalog_review_request,
    current,
  );
  const lineage = readCatalogReviewMaintenanceLineage(
    repository,
    request,
    after.input,
    performance.now() + 15000,
  );
  assert.deepEqual(
    lineage.map((r) => r.request_id),
    [request.request_id, current.request_id],
  );
  // The installed worker starts from a sparse current/parent recovery. Fetch
  // only named immutable predecessor objects through the actual raw verifier.
  const sparse = path.join(repository, "sparse");
  await mkdir(sparse);
  execFileSync("git", ["init", "--bare", "--quiet", sparse], { windowsHide: true });
  const cat = (kind: string, id: string) =>
    execFileSync("git", ["-C", repository, "cat-file", kind, id], {
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
  const reads: string[] = [];
  const hydrated = await hydrateCatalogReviewMaintenanceLineage(
    sparse,
    request,
    after.input,
    {
      request(method, endpoint) {
        assert.equal(method, "GET");
        reads.push(endpoint);
        const match =
          /^repos\/boburning\/portcove\/git\/(commits|trees|blobs)\/([a-f0-9]{40})$/u.exec(
            endpoint,
          );
        assert.ok(match);
        const kind = match[1]!,
          id = match[2]!;
        let body: unknown;
        if (kind === "commits") {
          assert.ok([request.before_checkpoint, current.before_checkpoint].includes(id));
          const text = cat("commit", id).toString("utf8"),
            boundary = text.indexOf("\n\n"),
            header = text.slice(0, boundary),
            tree = /^tree ([a-f0-9]{40})$/mu.exec(header)![1]!;
          const actor = {
            name: "Portcove release coordinator",
            email: "coordinator@portcove.invalid",
            date: "2000-01-01T00:00:00Z",
          };
          body = {
            sha: id,
            tree: { sha: tree },
            parents: [...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((m) => ({ sha: m[1] })),
            author: actor,
            committer: actor,
            message: text.slice(boundary + 2),
          };
        } else if (kind === "trees")
          body = {
            sha: id,
            truncated: false,
            tree: [
              {
                path: "state.json",
                mode: "100644",
                type: "blob",
                sha: cat("tree", id).subarray(-20).toString("hex"),
              },
            ],
          };
        else {
          const bytes = cat("blob", id);
          body = {
            sha: id,
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
          };
        }
        return { status: 200, headers: new Map(), body };
      },
    },
    performance.now() + 15000,
  );
  assert.deepEqual(hydrated, lineage);
  assert.equal(reads.length, 6);
  assert.equal(
    execFileSync("git", ["-C", sparse, "for-each-ref"], { encoding: "utf8", windowsHide: true }),
    "",
  );
  await assert.rejects(
    hydrateCatalogReviewMaintenanceLineage(
      sparse,
      request,
      after.input,
      {
        request() {
          throw new Error("missing predecessor retains HOLD");
        },
      },
      performance.now() + 15000,
    ),
    /missing predecessor/,
  );
  assert.throws(() =>
    readCatalogReviewMaintenanceLineage(
      repository,
      { ...request, before_checkpoint: "0".repeat(40) },
      { ...after.input, catalog_review_request: { ...request, before_checkpoint: "0".repeat(40) } },
      performance.now() + 15000,
    ),
  );
  const review = {
    scope: "complete-catalog-publication-opportunity",
    runtime: "codex-independent-local-review",
    session_ref: "inert/old",
    completed_at: new Date(current.requested_at).toISOString().slice(0, 19) + "Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    accepted_opportunity: current.opportunity,
    report: "Inert exact old baseline only.",
  };
  const handoff = prepareSemanticReviewHandoff(current.opportunity, review);
  const check = {
    ...handoff.proposed_request.body,
    id: 101,
    app: { id: 123 },
    output: { ...handoff.proposed_request.body.output, annotations_count: 0, text: "" },
  };
  assert.equal(inspectCatalogSemanticRequestCheckMatches([check], current).accepted.length, 1);
  assert.equal(inspectCatalogSemanticRequestCheckMatches([check], request).accepted.length, 0);
  const rawBefore = readRetainedCoordinatorCheckpoint(repository, operation.checkpoint).input;
  for (const patch of [
    {
      published_metadata: {
        ...(after.input.published_metadata as object),
        records_sha256: "0".repeat(64),
      },
    },
    { catalog_review_disposition: null },
    { catalog_publication: {} },
    { active_candidate: { version: "1.0.0" } },
  ])
    assert.throws(() =>
      refreezeCatalogReviewAfterApplicationMetadata(
        rawBefore,
        { ...after.input, ...patch },
        operation.checkpoint,
      ),
    );
  assert.equal(currentPublishedSite(after.input)?.generation_sha256, nextGeneration);
});
void test("technical claims are charged across maintenance request IDs and contradictory predecessor custody refuses", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-technical-lineage-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const prior = path.join(parent, `request-${"1".repeat(64)}`),
    current = path.join(parent, `request-${"2".repeat(64)}`);
  await mkdir(prior);
  await mkdir(current);
  for (let i = 0; i < 2; i++) {
    const attempt = await claimSemanticTechnicalAttempt(prior, "a".repeat(64));
    await writeFile(
      path.join(attempt, "technical-stop.json"),
      JSON.stringify({ outcome: "technical-failure", invocations: [] }),
    );
  }
  const third = await claimSemanticTechnicalAttempt(current, "a".repeat(64), [prior]);
  await writeFile(
    path.join(third, "technical-stop.json"),
    JSON.stringify({ outcome: "technical-failure", invocations: [] }),
  );
  await assert.rejects(
    claimSemanticTechnicalAttempt(current, "a".repeat(64), [prior]),
    /budget exhausted/,
  );
  await rm(path.join(prior, "technical-1"), { recursive: true });
  await assert.rejects(claimSemanticTechnicalAttempt(current, "a".repeat(64), [prior]), /custody/);
});

void test("ratified App bootstrap over a retained catalog refreezes only after exact settled metadata readback", () => {
  const f = fixture(),
    bootstrap = metadataBootstrapFixture();
  const catalog = {
    schema_version: 1,
    source_commit: "3".repeat(40),
    source_tree: "7".repeat(40),
    root_sha256: "8".repeat(64),
    offline_targets_sha256: "a".repeat(64),
    index_sha256: "b".repeat(64),
    repository_sha256: "c".repeat(64),
    verifier_repository_sha256: "d".repeat(64),
    snapshot_sha256: "e".repeat(64),
    timestamp_sha256: "f".repeat(64),
    immutable_targets_sha256: "0".repeat(64),
    versions: { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires: {
      targets: "2027-01-01T00:00:00Z",
      definitions: "2026-10-27T00:00:00Z",
      policy: "2026-10-27T00:00:00Z",
      snapshot: "2026-10-27T00:00:00Z",
      timestamp: "2026-10-22T00:00:00Z",
    },
    operation_id: "1".repeat(64),
    publication: {
      remote_identity: "fixture:catalog",
      evidence_sha256: "2".repeat(64),
      site_generation_sha256: "3".repeat(64),
    },
  };
  const site = {
    schema_version: 1,
    generation_sha256: catalog.publication.site_generation_sha256,
    components: {
      application: null,
      catalog: { root_sha256: catalog.root_sha256, repository_sha256: catalog.repository_sha256 },
    },
    operation_id: catalog.operation_id,
    publication: {
      remote_identity: catalog.publication.remote_identity,
      evidence_sha256: catalog.publication.evidence_sha256,
    },
  };
  const old = f.request("4".repeat(40));
  const request = createCatalogReviewRequest({
    before_checkpoint: old.before_checkpoint,
    requested_at: old.requested_at,
    core_inspection: old.core_inspection,
    opportunity: {
      ...old.opportunity,
      classification: { ...old.opportunity.classification, change: "update" },
      baseline: {
        ...old.opportunity.baseline,
        catalog_repository_sha256: catalog.repository_sha256,
        application_root_sha256: null,
        application_repository_sha256: null,
        site_generation_sha256: site.generation_sha256,
      },
    },
  });
  const publication = {
    remote_identity: "fixture:app-bootstrap",
    evidence_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  const afterMetadata = { ...bootstrap.published, operation_id: "6".repeat(64), publication };
  const operation = {
    id: afterMetadata.operation_id,
    kind: "upload",
    destination: "github-pages:boburning/portcove:complete-site",
    outcome: "succeeded",
    metadata_bootstrap: { descriptor_sha256: digest(bootstrap.descriptor) },
    completed_effects: [
      {
        remote_identity: publication.remote_identity,
        evidence_sha256: publication.evidence_sha256,
      },
    ],
    site_expectation: {
      root_sha256: afterMetadata.root_sha256,
      repository_sha256: afterMetadata.repository_sha256,
      site_generation_sha256: publication.site_generation_sha256,
      prior_site_generation_sha256: site.generation_sha256,
    },
  };
  const before: Record<string, unknown> = {
    ...f.input,
    published_metadata: null,
    published_catalog_metadata: catalog,
    published_site: site,
    metadata_bootstrap: bootstrap.descriptor,
    catalog_review_request: request,
    controller: {
      ...(f.input.controller as object),
      capacity_attempt: { ...capacityFixture(), schema_version: 2, operation },
    },
  };
  const next = {
    ...before,
    published_metadata: afterMetadata,
    published_site: applicationPublishedSiteCursor(before, afterMetadata),
  };
  assert.equal(applicationMetadataMaintenancePriority(before, String(before.now)), "bootstrap");
  assert.match(
    planReleaseOpportunity({ ...before, controller: f.input.controller }).reason,
    /metadata maintenance/,
  );
  const refrozen = refreezeCatalogReviewAfterApplicationMetadata(before, next, "7".repeat(40))!;
  assert.equal(
    refrozen.opportunity.baseline.application_root_sha256,
    bootstrap.descriptor.root_sha256,
  );
  assert.equal(refrozen.opportunity.baseline.catalog_repository_sha256, catalog.repository_sha256);
  assert.notEqual(refrozen.request_id, request.request_id);
  assert.deepEqual(currentPublishedSite(next)?.components.catalog, site.components.catalog);
  for (const mutation of [
    { outcome: "pending" },
    { completed_effects: [] },
    { metadata_bootstrap: null },
    { metadata_renewal: {} },
  ])
    assert.throws(() =>
      refreezeCatalogReviewAfterApplicationMetadata(
        {
          ...before,
          controller: { capacity_attempt: { operation: { ...operation, ...mutation } } },
        },
        next,
        "7".repeat(40),
      ),
    );
});

void test("wake prioritizes due and resumed App maintenance but never an accepted catalog subject or unresolved catalog effect", () => {
  const f = fixture(),
    request = f.request("1".repeat(40));
  const read = (input: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 1, previous: null, input }));
    return readWakePurposePriority(
      {
        request(method, endpoint) {
          assert.equal(method, "GET");
          if (endpoint.includes("/git/ref/"))
            return {
              status: 200,
              body: {
                ref: "refs/heads/fixture-coordinator-state",
                object: { type: "commit", sha: "a".repeat(40) },
              },
              headers: new Map(),
            };
          assert.equal(
            endpoint,
            `repos/boburning/portcove/contents/state.json?ref=${"a".repeat(40)}`,
          );
          return {
            status: 200,
            body: {
              type: "file",
              path: "state.json",
              encoding: "base64",
              content: bytes.toString("base64"),
              size: bytes.length,
              sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
            },
            headers: new Map(),
          };
        },
      },
      "fixture",
    );
  };
  const base = {
    ...f.input,
    catalog_review_request: request,
    controller: { capacity_attempt: { operation: null } },
  };
  assert.equal(read(base), "application");
  assert.equal(
    read({
      ...base,
      catalog_review_request: null,
      catalog_review_disposition: negative(request, "2".repeat(40)),
    }),
    "application",
  );
  const future = metadataFixture(Date.now() + 86400000),
    seed = future.published;
  assert.equal(read({ ...base, published_metadata: seed }), "catalog-publication");
  assert.equal(
    read({
      ...base,
      published_metadata: seed,
      metadata_renewal: future.descriptor,
    }),
    "application",
  );
  assert.equal(read({ ...base, catalog_publication: {} }), "catalog-publication");
  assert.equal(
    read({
      ...base,
      controller: {
        capacity_attempt: { operation: { outcome: "pending", catalog_publication: {} } },
      },
    }),
    "catalog-publication",
  );
});

void test("ambiguous old POST stays fixed GET-only in its original opportunity and blocks a new technical claim", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-old-post-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(),
    request = f.request("1".repeat(40)),
    prior = path.join(parent, `request-${request.request_id}`),
    current = path.join(parent, `request-${"2".repeat(64)}`);
  await mkdir(prior);
  await mkdir(current);
  const attempt = await claimSemanticTechnicalAttempt(prior, "a".repeat(64));
  const handoff = prepareSemanticReviewHandoff(request.opportunity, {
    scope: "complete-catalog-publication-opportunity",
    runtime: "codex-independent-local-review",
    session_ref: "fixture/old",
    completed_at: new Date().toISOString().slice(0, 19) + "Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    accepted_opportunity: request.opportunity,
    report: "Inert old Check fixture.",
  });
  await writeFile(
    path.join(attempt, "expected-check.json"),
    JSON.stringify({
      root: path.join(attempt, "r-original"),
      proposed_request: handoff.proposed_request,
    }),
  );
  const calls: string[] = [];
  await assert.rejects(
    reconcileCatalogSemanticTechnicalPredecessors(
      current,
      [{ request, directory: prior }],
      "a".repeat(64),
      {
        graphql() {
          throw new Error("old POST recovery forbids GraphQL");
        },
        request(method, endpoint) {
          assert.equal(method, "GET");
          calls.push(endpoint);
          if (endpoint === "repos/boburning/portcove")
            return {
              status: 200,
              headers: new Map(),
              body: { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" },
            };
          assert.ok(
            endpoint.includes(
              `/commits/${request.opportunity.source_commit}/check-suites?app_id=123&`,
            ),
          );
          return { status: 200, headers: new Map(), body: { total_count: 0, check_suites: [] } };
        },
      },
      { app_id: 123, installation_id: 456, writer_app_id: 789 },
    ),
    /POST remains ambiguous/,
  );
  assert.equal(calls.length, 4);
  await assert.rejects(
    claimSemanticTechnicalAttempt(prior, "a".repeat(64)),
    /GET-only reconciliation/,
  );
});
