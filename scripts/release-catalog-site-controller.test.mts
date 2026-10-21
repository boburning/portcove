import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { inspectCapacityExecutorIdentity, capacityDigest } from "./release-capacity.mts";
import { inspectPublishedMetadata } from "./release-metadata-contract.mts";
import {
  inspectPublishedCatalogMetadata,
  inspectPublishedSite,
} from "./release-catalog-metadata-contract.mts";
import { isRecord } from "./runtime-values.mts";
import {
  runFixedCatalogSiteConfiguration,
  runCatalogSitePublicationController,
  recoverActualCatalogSitePublication,
} from "./release-catalog-site-controller.mts";
import {
  prepareCatalogSiteDeploymentFromActualRepository,
  prepareCatalogSiteHandoffFromActualRepository,
  readBackSiteDeployment,
} from "./release-site-deployment.mts";
import {
  recoverOwnedPublishedCatalogMetadata,
  recoverOwnedPublishedMetadata,
} from "./release-capacity-executor.mts";

void test("imported catalog assemblies, deployments and executors cannot reach provider or filesystem work", async () => {
  const raw = {
    repository: "uncreated",
    checkpoint: "uncreated",
    output_parent: "uncreated",
    deadline: performance.now() + 10000,
  };
  for (const prepare of [
    prepareCatalogSiteDeploymentFromActualRepository,
    prepareCatalogSiteHandoffFromActualRepository,
  ])
    await assert.rejects(
      prepare({ kind: "actual-catalog-keyless-assembly" }, raw),
      /actual keyless catalog assembly/,
    );
  await assert.rejects(
    runCatalogSitePublicationController({}, {}, "uncreated", raw.deadline),
    /actual keyless catalog assembly/,
  );
  await assert.rejects(
    readBackSiteDeployment({ kind: "prepared-catalog-site-deployment" }),
    /imported deployment/,
  );
  let reads = 0;
  for (const recover of [recoverOwnedPublishedMetadata, recoverOwnedPublishedCatalogMetadata])
    await assert.rejects(
      recover(
        { kind: "authenticated-capacity-executor" },
        { repository: "uncreated", checkpoint: "uncreated", remote_configuration: {} },
        async () => {
          reads++;
        },
      ),
      /actual authenticated executor/,
    );
  await assert.rejects(
    recoverActualCatalogSitePublication({}, {} as never, { ...raw, remote_configuration: {} }),
    /actual keyless catalog assembly/,
  );
  assert.equal(reads, 0);
});
void test("catalog fixed invocation never reinterprets application roles or arbitrary schemas", async () => {
  for (const value of [
    null,
    {},
    { mode: "metadata" },
    { mode: "catalog", roles: Array(5).fill({}) },
    { mode: "catalog", context: {}, identity: {}, roles: [], tools: {}, acceptance: true },
  ])
    await assert.rejects(
      runFixedCatalogSiteConfiguration(value, "uncreated"),
      /fixed catalog site invocation/,
    );
});
void test(
  "controlled actual-module wiring composes catalog archive and uses sole Pages path plus atomic cursor",
  { timeout: 30000 },
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        fileURLToPath(new URL("./fixtures/release-catalog-site-fixture.mts", import.meta.url)),
      ],
      { timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true },
    );
    assert.match(stdout, /sole-pages\/atomic-cursor PASS; no actual authority/u);
  },
);

void test("source-bound shared recovery requires exact terminal publisher/effect and writes only catalog cursor", async () => {
  // This exercises the maintained internal function with controlled boundary
  // facts. It cannot create an actual executor session or a provider receipt.
  const source = await readFile(
    new URL("./release-capacity-executor.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function recoverOwnedPublishedMetadataWithinScope(");
  assert.ok(start > 0);
  const original = {
    role: "site-publication",
    run_id: "123",
    job_id: 42,
    run_attempt: 1,
    controller_revision: "b".repeat(40),
    execution_ref: "refs/tags/fixture",
    check_run_id: "43",
    actor_id: "44",
    workflow: ".github/workflows/fixture.yml",
  };
  const publication = {
    evidence_sha256: "a".repeat(64),
    remote_identity: `github-pages:boburning/portcove:${"b".repeat(64)}`,
  };
  const metadata = {
    schema_version: 1,
    root_sha256: "1".repeat(64),
    offline_targets_sha256: "2".repeat(64),
    index_sha256: "3".repeat(64),
    repository_sha256: "4".repeat(64),
    verifier_repository_sha256: "5".repeat(64),
    timestamp_sha256: "6".repeat(64),
    snapshot_sha256: "7".repeat(64),
    immutable_targets_sha256: "8".repeat(64),
    versions: { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires: Object.fromEntries(
      ["targets", "definitions", "policy", "snapshot", "timestamp"].map((role) => [
        role,
        "2026-12-01T00:00:00Z",
      ]),
    ),
    source_commit: "c".repeat(40),
    source_tree: "d".repeat(40),
    operation_id: "e".repeat(64),
    publication: { ...publication, site_generation_sha256: "b".repeat(64) },
  };
  const site = {
    schema_version: 1,
    generation_sha256: "b".repeat(64),
    components: {
      application: null,
      catalog: { root_sha256: metadata.root_sha256, repository_sha256: metadata.repository_sha256 },
    },
    operation_id: metadata.operation_id,
    publication,
  };
  const op = {
    id: metadata.operation_id,
    kind: "upload",
    destination: "github-pages:boburning/portcove:complete-site",
    outcome: "recovered",
    recovery: { resolution: "effect-completed" },
    completed_effects: [publication],
    catalog_publication: { authority: "none" },
    executor_identity: original,
  };
  let jobStatus = "completed",
    reads = 0,
    catalogWrites = 0,
    appWrites = 0,
    callbackReads = 0;
  const api = {
    request() {
      reads++;
      return {
        status: 200,
        body: {
          id: 42,
          run_id: 123,
          run_attempt: 1,
          head_sha: original.controller_revision,
          status: jobStatus,
          conclusion: "success",
          check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/43",
        },
      };
    },
  };
  const make = () =>
    runInNewContext(
      stripTypeScriptTypes(source.slice(start)) + "\nrecoverOwnedPublishedMetadataWithinScope",
      {
        sessions: new Map([["session", { role: "coordinator", directory: "inert" }]]),
        effectStates: new Map(),
        capacityRecoveryProviderApi: () => api,
        createCoordinatorJournalApi: () => api,
        refreshCapacityExecutor: async () => ({ run_id: "124", job_id: 45 }),
        publishCoordinatorCheckpoint: async () => ({}),
        recoverReleaseOpportunity: async () => ({
          input: { controller: { capacity_attempt: { operation: op } } },
        }),
        isRecord,
        inspectCapacityExecutorIdentity,
        inspectPublishedCatalogMetadata,
        inspectPublishedMetadata,
        inspectPublishedSite,
        capacityDigest,
        structuredClone,
        recordPublishedCatalogMetadata: async (
          _repo: string,
          _cp: string,
          actual: unknown,
          cursor: unknown,
        ) => {
          catalogWrites++;
          assert.deepEqual(actual, inspectPublishedCatalogMetadata(metadata));
          assert.deepEqual(cursor, inspectPublishedSite(site));
          return { checkpoint: "advanced", durable_checkpoint: "advanced" };
        },
        recordPublishedApplicationSiteMetadata: async () => {
          appWrites++;
          throw new Error("wrong component");
        },
      },
    ) as (
      session: string,
      input: object,
      readback: () => Promise<unknown>,
      component?: "application" | "catalog",
    ) => Promise<{ checkpoint: string }>;
  const raw = { repository: "inert", checkpoint: "old", remote_configuration: {} };
  const readback = async () => {
    callbackReads++;
    return { metadata, site };
  };
  assert.equal((await make()("session", raw, readback, "catalog")).checkpoint, "advanced");
  assert.equal(reads, 2);
  assert.equal(callbackReads, 1);
  assert.equal(catalogWrites, 1);
  assert.equal(appWrites, 0);
  await assert.rejects(make()("session", raw, readback), /different component/);
  jobStatus = "in_progress";
  await assert.rejects(make()("session", raw, readback, "catalog"), /not observed terminal/);
  assert.equal(callbackReads, 1);
  assert.equal(catalogWrites, 1);
  jobStatus = "completed";
  await assert.rejects(
    make()(
      "session",
      raw,
      async () => ({ metadata, site: { ...site, generation_sha256: "f".repeat(64) } }),
      "catalog",
    ),
    /cursor differs/,
  );
  assert.equal(catalogWrites, 1);
});
