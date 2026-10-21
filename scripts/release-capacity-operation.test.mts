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
} from "./release-coordinator-state.mts";
import {
  runBoundedCatalogPublicationOperation,
  recordCapacityReadback,
} from "./release-capacity-operation.mts";
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
