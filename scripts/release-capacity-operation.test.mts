import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import {
  runBoundedCatalogPublicationOperation,
  recordCapacityReadback,
  recordPublishedCatalogMetadata,
} from "./release-capacity-operation.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { currentPublishedSite } from "./release-catalog-metadata-contract.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

void test(
  "catalog original pending/CAS blocks competing effects, preserves ambiguity and requires bounded recovery",
  { timeout: 60000 },
  async (t) => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "portcove-catalog-capacity-"));
    t.after(() => rm(repository, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", "--quiet", repository], {
      windowsHide: true,
      timeout: 10000,
    });
    const legacy: unknown = JSON.parse(
      await readFile(
        new URL("./fixtures/release-coordinator-legacy.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      isRecord(legacy) &&
        Array.isArray(legacy.rows) &&
        isRecord(legacy.rows[0]) &&
        isRecord(legacy.rows[0].input),
    );
    const input = structuredClone(legacy.rows[0].input);
    const capacity = { ...capacityFixture(), schema_version: 2 };
    input.schema_version = 2;
    input.controller = {
      workflow: ".github/workflows/fixture.yml",
      revision: "3".repeat(40),
      publication_paused: false,
      capacity_attempt: capacity,
    };
    const first = await checkpointReleaseOpportunity(repository, null, input);
    const descriptor = catalogPublicationFixture();
    const request = {
      kind: "upload" as const,
      destination: "github-actions:boburning/portcove:catalog-publication-context",
    };
    const executorIdentity = {
      actor_id: "1",
      check_run_id: "2",
      controller_revision: "3".repeat(40),
      execution_ref: "refs/tags/fixture",
      job_id: 4,
      role: "coordinator",
      run_attempt: 1,
      run_id: "5",
      workflow: ".github/workflows/fixture.yml",
    };
    const options = { executorIdentity, maximumReceipts: 1 };
    let effects = 0;
    let failedCheckpoint = "";
    try {
      await runBoundedCatalogPublicationOperation(
        repository,
        first.checkpoint,
        descriptor,
        request,
        async () => capacity.boundary,
        async (_record, pending) => {
          effects++;
          const saved = await recoverReleaseOpportunity(repository, pending.checkpoint);
          assert.ok(
            isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
          );
          const retained = saved.input.controller.capacity_attempt.operation;
          assert.ok(isRecord(retained) && retained.outcome === "pending");
          assert.deepEqual(retained.catalog_publication, pending.operation.catalog_publication);
          await assert.rejects(
            runBoundedCatalogPublicationOperation(
              repository,
              pending.checkpoint,
              descriptor,
              request,
              async () => capacity.boundary,
              async () => {
                effects++;
              },
              options,
            ),
            /held/,
          );
          throw new Error("controlled response loss; no claim of absent effect");
        },
        options,
      );
      assert.fail("original ambiguous effect must refuse");
    } catch (error) {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.retry, "forbidden");
      failedCheckpoint = String(error.evidence.checkpoint);
    }
    assert.equal(effects, 1);
    const failed = await recoverReleaseOpportunity(repository, failedCheckpoint);
    assert.ok(
      isRecord(failed.input.controller) && isRecord(failed.input.controller.capacity_attempt),
    );
    const operation = failed.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation) && operation.outcome === "ambiguous");
    const changed = { ...descriptor, bundle_sha256: "9".repeat(64) };
    await assert.rejects(
      runBoundedCatalogPublicationOperation(
        repository,
        failedCheckpoint,
        changed,
        request,
        async () => capacity.boundary,
        async () => {
          effects++;
        },
        options,
      ),
      /held/,
    );
    assert.equal(effects, 1);
    // Supplied readback is fixture-scoped, not an authenticated provider receipt.
    const readback = await recordCapacityReadback(
      repository,
      failedCheckpoint,
      "effect-not-applied",
      "a".repeat(64),
    );
    await assert.rejects(
      runBoundedCatalogPublicationOperation(
        repository,
        readback.checkpoint,
        changed,
        request,
        async () => capacity.boundary,
        async () => {
          effects++;
        },
        options,
      ),
      /recovery increment/,
    );
    const completed = await runBoundedCatalogPublicationOperation(
      repository,
      readback.checkpoint,
      changed,
      request,
      async () => capacity.boundary,
      async (record) => {
        effects++;
        await record("fixture:catalog-context", "b".repeat(64));
      },
      { ...options, recovery: "transient" },
    );
    assert.ok(
      "catalog_publication" in completed.operation &&
        isRecord(completed.operation.catalog_publication),
    );
    assert.equal(completed.operation.catalog_publication.transient_retries, 1);
    assert.equal(completed.availability, "unknown");
    assert.equal(completed.headroom, "unknown");
    assert.equal(completed.authority, "none");
    assert.equal(effects, 2);
    await assert.rejects(
      runBoundedCatalogPublicationOperation(
        repository,
        completed.checkpoint,
        descriptor,
        request,
        async () => capacity.boundary,
        async () => {
          effects++;
        },
        { ...options, recovery: "transient" },
      ),
      /completed logical effect/,
    );
    assert.equal(effects, 2);
  },
);

void test(
  "catalog-only publication records one global cursor atomically and roundtrips the existing sparse Git journal",
  { timeout: 60000 },
  async (t) => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "portcove-catalog-site-"));
    t.after(() => rm(repository, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", "--quiet", repository], {
      windowsHide: true,
      timeout: 10000,
    });
    const now = "2026-10-21T12:00:00.000Z";
    const capacity = { ...capacityFixture(), schema_version: 2 };
    const descriptor = catalogPublicationFixture();
    const input = {
      schema_version: 2,
      now,
      opportunity: null,
      active_candidate: null,
      catalog_publication: descriptor,
      controller: {
        workflow: ".github/workflows/fixture.yml",
        revision: "3".repeat(40),
        publication_paused: false,
        capacity_attempt: capacity,
      },
      publication: {
        complete: true,
        observed_at: now,
        published_versions: [],
        published_sources: [],
        reserved_versions: [],
        last_routine_preview_at: null,
      },
    };
    const initial = await checkpointReleaseOpportunity(repository, null, input);
    assert.equal(initial.plan.action, "catalog-publication");
    const expectation = {
      application_root_sha256: null,
      archive_sha256: "a".repeat(64),
      artifact_id: 1,
      catalog_repository_sha256: "b".repeat(64),
      catalog_root_sha256: "7".repeat(64),
      prior_site_generation_sha256: null,
      site_generation_sha256: "c".repeat(64),
    };
    const publication = {
      evidence_sha256: "d".repeat(64),
      remote_identity: "fixture:catalog-pages",
      site_generation_sha256: expectation.site_generation_sha256,
    };
    const executorIdentity = {
      actor_id: "1",
      check_run_id: "2",
      controller_revision: "3".repeat(40),
      execution_ref: "refs/tags/fixture",
      job_id: 4,
      role: "site-publication",
      run_attempt: 1,
      run_id: "5",
      workflow: ".github/workflows/fixture.yml",
    };
    // Synthetic declared readback, no verifier/signature or provider authority.
    const effect = await runBoundedCatalogPublicationOperation(
      repository,
      initial.checkpoint,
      descriptor,
      {
        kind: "upload",
        destination: "github-pages:boburning/portcove:complete-site",
        catalog_site_expectation: expectation,
      },
      async () => capacity.boundary,
      async (record) => record(publication.remote_identity, publication.evidence_sha256),
      { executorIdentity, maximumReceipts: 1 },
    );
    const roles = { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" };
    const expires = {
      targets: "2027-01-01T00:00:00Z",
      definitions: "2026-10-27T00:00:00Z",
      policy: "2026-10-27T00:00:00Z",
      snapshot: "2026-10-27T00:00:00Z",
      timestamp: "2026-10-22T00:00:00Z",
    };
    const catalog = {
      schema_version: 1,
      root_sha256: expectation.catalog_root_sha256,
      repository_sha256: expectation.catalog_repository_sha256,
      verifier_repository_sha256: "e".repeat(64),
      immutable_targets_sha256: digest([]),
      offline_targets_sha256: "f".repeat(64),
      index_sha256: "0".repeat(64),
      snapshot_sha256: "1".repeat(64),
      timestamp_sha256: "2".repeat(64),
      versions: roles,
      expires,
      operation_id: effect.operation.id,
      publication,
    };
    const cursor = {
      schema_version: 1,
      generation_sha256: expectation.site_generation_sha256,
      components: {
        application: null,
        catalog: { root_sha256: catalog.root_sha256, repository_sha256: catalog.repository_sha256 },
      },
      operation_id: effect.operation.id,
      publication: {
        evidence_sha256: publication.evidence_sha256,
        remote_identity: publication.remote_identity,
      },
    };
    await assert.rejects(
      recordPublishedCatalogMetadata(repository, effect.checkpoint, catalog, {
        ...cursor,
        generation_sha256: "9".repeat(64),
      }),
    );
    const recorded = await recordPublishedCatalogMetadata(
      repository,
      effect.checkpoint,
      catalog,
      cursor,
    );
    const state = await recoverReleaseOpportunity(repository, recorded.checkpoint);
    assert.equal(state.input.published_metadata, undefined);
    assert.deepEqual(state.input.published_catalog_metadata, catalog);
    assert.equal(state.input.catalog_publication, null);
    assert.deepEqual(currentPublishedSite(state.input), cursor);
    const exported = await exportCoordinatorCheckpoint(repository, recorded.checkpoint);
    const sparse = path.join(repository, "sparse.git");
    execFileSync("git", ["init", "--bare", "--quiet", sparse], {
      windowsHide: true,
      timeout: 10000,
    });
    const objects = new Map<
      string,
      { kind: "blob" | "tree" | "commit"; oid: string; bytes: Buffer }
    >();
    for (const checkpoint of [exported.checkpoint, exported.previous]) {
      if (!checkpoint) continue;
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repository, ...args], { windowsHide: true, timeout: 10000 });
      for (const [kind, oid] of [
        ["blob", git("rev-parse", `${checkpoint}:state.json`).toString("utf8").trim()],
        ["tree", git("rev-parse", `${checkpoint}^{tree}`).toString("utf8").trim()],
        ["commit", checkpoint],
      ] as const)
        objects.set(oid, { kind, oid, bytes: git("cat-file", kind, oid) });
    }
    assert.equal(objects.size, 6);
    const restored = await importCoordinatorCheckpoint(sparse, exported.checkpoint, [
      ...objects.values(),
    ]);
    assert.deepEqual(restored.input.published_catalog_metadata, catalog);
    assert.deepEqual(currentPublishedSite(restored.input), cursor);
    assert.equal(restored.plan.action, "skip");
    // Absence/mismatched baseline is not an invitation to create a fresh catalog.
    const changed = { ...descriptor, bundle_sha256: "8".repeat(64) };
    await assert.rejects(
      runBoundedCatalogPublicationOperation(
        repository,
        recorded.checkpoint,
        changed,
        {
          kind: "upload",
          destination: "github-actions:boburning/portcove:catalog-publication-context",
        },
        async () => capacity.boundary,
        async () => {
          assert.fail("stale baseline must not enter effect");
        },
        { executorIdentity: { ...executorIdentity, role: "coordinator" }, maximumReceipts: 1 },
      ),
      /baseline/,
    );
  },
);
