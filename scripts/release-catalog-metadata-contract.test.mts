import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import {
  inspectCatalogTufPublicationFacts,
  inspectCatalogTufPublicationReport,
  inspectPublishedCatalogMetadata,
  currentPublishedSite,
  inspectPublishedSite,
  assertCatalogPublicationBaseline,
  validatePublishedSiteTransition,
  currentApplicationSitePins,
  applicationPublishedSiteCursor,
} from "./release-catalog-metadata-contract.mts";

const now = "2026-10-21T12:00:00.000Z";
function facts() {
  return {
    schema_version: 1,
    root_sha256: "7".repeat(64),
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
  };
}
function catalogAdvance() {
  const app = metadataFixture(Date.parse(now)).published;
  const before = { now, active_candidate: null, published_metadata: app };
  const descriptor = {
    ...catalogPublicationFixture(),
    prior: {
      catalog_root_sha256: "7".repeat(64),
      catalog_repository_sha256: null,
      site_generation_sha256: app.publication.site_generation_sha256,
      application_root_sha256: app.root_sha256,
      application_repository_sha256: app.repository_sha256,
    },
  };
  const publication = {
    evidence_sha256: "1".repeat(64),
    remote_identity: "fixture:pages:catalog",
    site_generation_sha256: "2".repeat(64),
  };
  const catalog = inspectPublishedCatalogMetadata({
    ...facts(),
    source_commit: descriptor.source_commit,
    source_tree: descriptor.source_tree,
    operation_id: "3".repeat(64),
    publication,
  })!;
  const site = {
    schema_version: 1,
    generation_sha256: publication.site_generation_sha256,
    components: {
      application: { root_sha256: app.root_sha256, repository_sha256: app.repository_sha256 },
      catalog: { root_sha256: catalog.root_sha256, repository_sha256: catalog.repository_sha256 },
    },
    operation_id: catalog.operation_id,
    publication: {
      evidence_sha256: publication.evidence_sha256,
      remote_identity: publication.remote_identity,
    },
  };
  const operation = {
    id: catalog.operation_id,
    kind: "upload",
    destination: "github-pages:boburning/portcove:complete-site",
    outcome: "recovered",
    recovery: { resolution: "effect-completed" },
    completed_effects: [site.publication],
    catalog_publication: { descriptor },
    catalog_site_expectation: {
      catalog_root_sha256: catalog.root_sha256,
      catalog_repository_sha256: catalog.repository_sha256,
      site_generation_sha256: site.generation_sha256,
      prior_site_generation_sha256: app.publication.site_generation_sha256,
    },
  };
  const after = { ...before, published_catalog_metadata: catalog, published_site: site };
  return { before, after, operation, descriptor, app, catalog };
}
void test("catalog raw Rust inventory and site component digests remain distinct and inert", () => {
  const inventory = [
    { target: "metadata/timestamp.json", bytes: 2, sha256: "1".repeat(64) },
    { target: "targets/definitions/index.json", bytes: 2, sha256: "2".repeat(64) },
  ];
  const {
    immutable_targets_sha256: _summary,
    verifier_repository_sha256: _verifier,
    ...data
  } = facts();
  const report = {
    ...data,
    authority: "none",
    changed: true,
    files: inventory,
    repository_sha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
  };
  const parsed = inspectCatalogTufPublicationReport(report);
  assert.equal(parsed.authority, "none");
  assert.equal(parsed.facts.verifier_repository_sha256, report.repository_sha256);
  assert.equal(
    parsed.facts.repository_sha256,
    digest(inventory.map(({ target, ...f }) => ({ path: target, ...f }))),
  );
  assert.notEqual(parsed.facts.repository_sha256, parsed.facts.verifier_repository_sha256);
  assert.throws(() =>
    inspectCatalogTufPublicationReport({
      ...report,
      repository_sha256: parsed.facts.repository_sha256,
    }),
  );
  assert.throws(() =>
    inspectCatalogTufPublicationReport({ ...report, authority: "authenticated" }),
  );
  for (const mutation of [
    { definitions: 1 },
    { policy: "01" },
    { timestamp: "18446744073709551616" },
    { releases: "1" },
  ])
    assert.throws(() =>
      inspectCatalogTufPublicationFacts({
        ...facts(),
        versions: { ...facts().versions, ...mutation },
      }),
    );
});
void test("catalog publication advances global cursor while preserving application provenance and refuses stale/foreign baselines", () => {
  const f = catalogAdvance();
  assert.doesNotThrow(() => validatePublishedSiteTransition(f.before, f.after, f.operation));
  assert.equal(currentPublishedSite(f.after)!.generation_sha256, "2".repeat(64));
  assert.equal(f.after.published_metadata.publication.site_generation_sha256, "8".repeat(64));
  assert.equal(
    inspectPublishedCatalogMetadata(f.after.published_catalog_metadata)!.source_commit,
    f.descriptor.source_commit,
  );
  for (const source of [{ source_commit: "a".repeat(40) }, { source_tree: "b".repeat(40) }])
    assert.throws(
      () =>
        validatePublishedSiteTransition(
          f.before,
          {
            ...f.after,
            published_catalog_metadata: { ...f.catalog, ...source },
          },
          f.operation,
        ),
      /frozen Pages expectation/,
    );
  const nextDescriptor = {
    ...f.descriptor,
    prior: {
      ...f.descriptor.prior,
      catalog_repository_sha256: f.catalog.repository_sha256,
      site_generation_sha256: "2".repeat(64),
    },
  };
  assert.doesNotThrow(() => assertCatalogPublicationBaseline(nextDescriptor, f.after));
  for (const prior of [
    { site_generation_sha256: "8".repeat(64) },
    { catalog_root_sha256: "9".repeat(64) },
    { catalog_repository_sha256: "9".repeat(64) },
    { application_repository_sha256: "9".repeat(64) },
  ])
    assert.throws(() =>
      assertCatalogPublicationBaseline(
        { ...nextDescriptor, prior: { ...nextDescriptor.prior, ...prior } },
        f.after,
      ),
    );
  assert.throws(() => currentPublishedSite({ ...f.after, published_site: undefined }));
  const { published_site: _site, ...without } = f.after;
  assert.throws(() => currentPublishedSite(without), /explicit current site/);
  assert.throws(() => currentPublishedSite({ ...f.before, published_site: null }));
  assert.throws(() =>
    inspectPublishedSite({
      ...f.after.published_site,
      publication: {
        ...f.after.published_site.publication,
        remote_identity: "fixture:\u0000hidden",
      },
    }),
  );
  assert.throws(() =>
    inspectPublishedSite({
      ...f.after.published_site,
      components: {
        ...f.after.published_site.components,
        catalog: { ...f.after.published_site.components.catalog, root_sha256: f.app.root_sha256 },
      },
    }),
  );
  assert.throws(() =>
    validatePublishedSiteTransition(f.before, f.after, { ...f.operation, outcome: "pending" }),
  );
  assert.throws(() =>
    validatePublishedSiteTransition(f.before, f.after, {
      ...f.operation,
      catalog_site_expectation: {
        ...f.operation.catalog_site_expectation,
        prior_site_generation_sha256: "9".repeat(64),
      },
    }),
  );
});
void test("application advance uses global catalog generation and preserves catalog publication provenance", () => {
  const f = catalogAdvance();
  const application = {
    ...f.app,
    repository_sha256: "4".repeat(64),
    operation_id: "5".repeat(64),
    publication: {
      evidence_sha256: "6".repeat(64),
      remote_identity: "fixture:pages:application",
      site_generation_sha256: "9".repeat(64),
    },
  };
  const site = {
    ...f.after.published_site,
    operation_id: application.operation_id,
    generation_sha256: application.publication.site_generation_sha256,
    publication: {
      evidence_sha256: application.publication.evidence_sha256,
      remote_identity: application.publication.remote_identity,
    },
    components: {
      ...f.after.published_site.components,
      application: {
        root_sha256: application.root_sha256,
        repository_sha256: application.repository_sha256,
      },
    },
  };
  const after = { ...f.after, published_metadata: application, published_site: site };
  assert.deepEqual(currentApplicationSitePins(f.after), {
    root_sha256: f.app.root_sha256,
    repository_sha256: f.app.repository_sha256,
    site_generation_sha256: f.after.published_site.generation_sha256,
  });
  assert.notEqual(
    currentApplicationSitePins(f.after).site_generation_sha256,
    f.app.publication.site_generation_sha256,
  );
  assert.deepEqual(applicationPublishedSiteCursor(f.after, application), site);
  assert.deepEqual(f.after.published_metadata, f.app);
  assert.throws(() =>
    currentApplicationSitePins({
      ...f.after,
      published_metadata: {
        ...f.app,
        repository_sha256: "0".repeat(64),
      },
    }),
  );
  const operation = {
    id: application.operation_id,
    kind: "upload",
    destination: "github-pages:boburning/portcove:complete-site",
    outcome: "succeeded",
    completed_effects: [site.publication],
    site_expectation: {
      root_sha256: application.root_sha256,
      repository_sha256: application.repository_sha256,
      site_generation_sha256: site.generation_sha256,
      prior_site_generation_sha256: "2".repeat(64),
    },
  };
  assert.doesNotThrow(() => validatePublishedSiteTransition(f.after, after, operation));
  assert.deepEqual(after.published_catalog_metadata, f.catalog);
  assert.throws(() =>
    validatePublishedSiteTransition(f.after, after, {
      ...operation,
      site_expectation: {
        ...operation.site_expectation,
        prior_site_generation_sha256: "8".repeat(64),
      },
    }),
  );
  assert.throws(() =>
    validatePublishedSiteTransition(
      f.after,
      {
        ...after,
        published_catalog_metadata: {
          ...f.catalog,
          publication: { ...f.catalog.publication, site_generation_sha256: site.generation_sha256 },
        },
      },
      operation,
    ),
  );
  assert.throws(() =>
    validatePublishedSiteTransition(
      f.after,
      {
        ...f.after,
        published_site: { ...f.after.published_site, generation_sha256: "9".repeat(64) },
      },
      operation,
    ),
  );
});
void test("catalog version/offline-anchor/freshness guards do not infer immutable-history safety from its summary", () => {
  const f = catalogAdvance();
  const descriptor = {
    ...f.descriptor,
    prior: {
      ...f.descriptor.prior,
      catalog_repository_sha256: f.catalog.repository_sha256,
      site_generation_sha256: f.after.published_site.generation_sha256,
    },
  };
  const catalog = {
    ...f.catalog,
    repository_sha256: "4".repeat(64),
    operation_id: "5".repeat(64),
    versions: {
      ...f.catalog.versions,
      definitions: "2",
      policy: "2",
      snapshot: "2",
      timestamp: "2",
    },
    publication: {
      remote_identity: "fixture:catalog:second",
      evidence_sha256: "6".repeat(64),
      site_generation_sha256: "9".repeat(64),
    },
  };
  const site = {
    ...f.after.published_site,
    generation_sha256: catalog.publication.site_generation_sha256,
    operation_id: catalog.operation_id,
    components: {
      ...f.after.published_site.components,
      catalog: { root_sha256: catalog.root_sha256, repository_sha256: catalog.repository_sha256 },
    },
    publication: {
      evidence_sha256: catalog.publication.evidence_sha256,
      remote_identity: catalog.publication.remote_identity,
    },
  };
  const operation = {
    ...f.operation,
    id: catalog.operation_id,
    completed_effects: [site.publication],
    catalog_publication: { descriptor },
    catalog_site_expectation: {
      ...f.operation.catalog_site_expectation,
      catalog_repository_sha256: catalog.repository_sha256,
      site_generation_sha256: site.generation_sha256,
      prior_site_generation_sha256: f.after.published_site.generation_sha256,
    },
  };
  const after = { ...f.after, published_catalog_metadata: catalog, published_site: site };
  assert.doesNotThrow(() => validatePublishedSiteTransition(f.after, after, operation));
  for (const bad of [
    { ...catalog, offline_targets_sha256: "8".repeat(64) },
    { ...catalog, versions: { ...catalog.versions, definitions: "1" } },
    { ...catalog, versions: { ...catalog.versions, targets: "2" } },
    { ...catalog, expires: { ...catalog.expires, timestamp: "2026-10-21T12:00:00Z" } },
  ])
    assert.throws(() =>
      validatePublishedSiteTransition(
        f.after,
        { ...after, published_catalog_metadata: bad },
        operation,
      ),
    );
  // Hash equality is only an identity fact. The actual private verifier/caller,
  // not this pure state guard, must establish retention/no-removal from bytes.
  assert.doesNotThrow(() =>
    inspectCatalogTufPublicationFacts({ ...facts(), immutable_targets_sha256: "9".repeat(64) }),
  );
});
void test("catalog schedules independently of application version allocation only when existing global holds allow", () => {
  const input = {
    schema_version: 2,
    now,
    controller: {
      workflow: ".github/workflows/fixture.yml",
      revision: "1".repeat(40),
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
    active_candidate: null,
    opportunity: null,
    catalog_publication: catalogPublicationFixture(),
  };
  const plan = planReleaseOpportunity(input);
  assert.equal(plan.action, "catalog-publication");
  assert.ok("admission" in plan && plan.admission === "required");
  assert.equal("proposal" in plan, false);
  assert.equal(
    planReleaseOpportunity({
      ...input,
      controller: { ...input.controller, publication_paused: true },
    }).action,
    "pause",
  );
  assert.equal(
    planReleaseOpportunity({
      ...input,
      controller: {
        ...input.controller,
        capacity_attempt: { ...input.controller.capacity_attempt, boundary: null },
      },
    }).action,
    "pause",
  );
  assert.equal(
    planReleaseOpportunity({
      ...input,
      publication: { ...input.publication, reserved_versions: ["0.1.0-beta.1"] },
    }).action,
    "pause",
  );
  assert.throws(() => planReleaseOpportunity({ ...input, schema_version: 1 }));
});
