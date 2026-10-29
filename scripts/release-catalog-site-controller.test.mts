import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  runFixedCatalogSiteConfiguration,
  runCatalogSitePublicationController,
  recoverActualCatalogSitePublication,
  inspectCatalogSiteReservation,
} from "./release-catalog-site-controller.mts";
import {
  prepareCatalogSiteDeploymentFromActualRepository,
  prepareCatalogSiteHandoffFromActualRepository,
  readBackSiteDeployment,
} from "./release-site-deployment.mts";
import {
  recoverOwnedPublishedCatalogMetadata,
  recoverOwnedPublishedMetadata,
  requireOwnedCapacityPendingBoundary,
} from "./release-capacity-executor.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { runBoundedCatalogPublicationOperation } from "./release-capacity-operation.mts";
import type { CapacityBoundaryReader } from "./release-capacity-operation.mts";

void test("imported catalog assemblies, deployments and executors cannot reach provider or filesystem work", async () => {
  const raw = {
    repository: "uncreated",
    checkpoint: "uncreated",
    output_parent: "uncreated",
    deadline: performance.now() + 10000,
  };
  await assert.rejects(
    prepareCatalogSiteDeploymentFromActualRepository(
      { kind: "actual-catalog-keyless-assembly" },
      raw,
    ),
    /actual keyless catalog assembly/,
  );
  await assert.rejects(
    prepareCatalogSiteHandoffFromActualRepository({ kind: "actual-catalog-keyless-assembly" }, raw),
    /actual read-only catalog recovery verification/,
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
    /actual read-only catalog recovery verification/,
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
  "real Git intent reaches owned pending boundary before effect and rejects foreign snapshots",
  { timeout: 60000 },
  async (t) => {
    for (const foreignChange of [false, true]) {
      const repository = await mkdtemp(path.join(os.tmpdir(), "catalog-pending-boundary-"));
      t.after(() => rm(repository, { recursive: true, force: true }));
      execFileSync("git", ["init", "--bare", "--quiet", repository], {
        timeout: 10000,
        windowsHide: true,
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
      const descriptor = catalogPublicationFixture(),
        capacity = { ...capacityFixture(), schema_version: 2 };
      input.schema_version = 2;
      input.opportunity = null;
      input.active_candidate = null;
      input.catalog_publication = descriptor;
      input.catalog_initialization = {
        schema_version: 1,
        kind: "catalog-initialization",
        authority: "none",
        source_commit: "8".repeat(40),
        source_tree: "9".repeat(40),
        root_sha256: descriptor.prior.catalog_root_sha256,
        publisher_configuration_sha256: descriptor.publisher_configuration_sha256,
        setup_plan_sha256: "a".repeat(64),
        initial_site_preimage_sha256: "b".repeat(64),
      };
      input.controller = {
        workflow: ".github/workflows/fixture.yml",
        revision: "3".repeat(40),
        publication_paused: false,
        capacity_attempt: capacity,
      };
      const initial = await checkpointReleaseOpportunity(repository, null, input);
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
      const source = await readFile(
        new URL("./release-capacity-executor.mts", import.meta.url),
        "utf8",
      );
      const getterStart = source.indexOf("export function requireOwnedCapacityPendingBoundary("),
        getterEnd = source.indexOf("async function observe(", getterStart),
        wrapperStart = source.indexOf("const readOwnedBoundary: CapacityBoundaryReader ="),
        wrapperEnd = source.indexOf("// Existing transport checks", wrapperStart);
      assert.ok(
        getterStart > 0 && getterEnd > getterStart && wrapperStart > 0 && wrapperEnd > wrapperStart,
      );
      let effects = 0,
        boundaries = 0,
        foreignCheckpoint: string | undefined;
      let held: object | undefined;
      const session = {};
      const wrapped = runInNewContext(
        stripTypeScriptTypes(
          source.slice(getterStart, getterEnd).replace("export function", "function") +
            source.slice(wrapperStart, wrapperEnd) +
            "\n({readOwnedBoundary, requireOwnedCapacityPendingBoundary})",
        ),
        {
          sessions: new Map([[session, {}]]),
          effectStates: new Map([[session, { busy: true }]]),
          pendingBoundaries: new WeakMap(),
          performance,
          structuredClone,
          inspectCapacityOperation,
          capacityDigest,
          executorIdentity,
          session,
          readBoundary: async (receipt?: object) => {
            boundaries++;
            assert.equal(effects, 0);
            const pending = receipt
              ? wrapped.requireOwnedCapacityPendingBoundary(session, receipt)
              : undefined;
            if (receipt) held = receipt;
            const snapshot = await recoverReleaseOpportunity(
              repository,
              pending?.checkpoint ?? initial.checkpoint,
            );
            inspectCatalogSiteReservation(snapshot, initial.checkpoint, descriptor, pending);
            if (pending) {
              assert.notEqual(snapshot.checkpoint, initial.checkpoint);
              assert.throws(
                () => inspectCatalogSiteReservation(snapshot, initial.checkpoint, descriptor),
                /without owned pending/,
              );
              assert.throws(
                () =>
                  inspectCatalogSiteReservation(
                    { ...snapshot, checkpoint: "f".repeat(40) },
                    initial.checkpoint,
                    descriptor,
                    pending,
                  ),
                /exact owned/,
              );
              assert.throws(
                () =>
                  inspectCatalogSiteReservation(snapshot, initial.checkpoint, descriptor, {
                    ...pending,
                    operation: { ...pending.operation, before_checkpoint: "e".repeat(40) },
                  }),
                /exact owned/,
              );
              if (foreignChange) {
                const changed = await checkpointReleaseOpportunity(
                  repository,
                  pending.checkpoint,
                  snapshot.input,
                );
                foreignCheckpoint = changed.checkpoint;
                const foreign = await recoverReleaseOpportunity(repository, changed.checkpoint);
                inspectCatalogSiteReservation(foreign, initial.checkpoint, descriptor, pending);
              }
            }
            return capacity.boundary;
          },
        },
      ) as {
        readOwnedBoundary: CapacityBoundaryReader;
        requireOwnedCapacityPendingBoundary: (
          session: object,
          receipt: object,
        ) => ReturnType<typeof requireOwnedCapacityPendingBoundary>;
      };
      const attempt = runBoundedCatalogPublicationOperation(
        repository,
        initial.checkpoint,
        descriptor,
        { kind: "upload", destination: "github-actions:boburning/portcove:complete-site-artifact" },
        wrapped.readOwnedBoundary,
        async (record) => {
          effects++;
          assert.equal(boundaries, 2);
          assert.ok(held);
          assert.throws(
            () => wrapped.requireOwnedCapacityPendingBoundary(session, held!),
            /current executor/,
          );
          await record("inert:artifact", "c".repeat(64));
        },
        { executorIdentity, maximumReceipts: 1 },
      );
      if (foreignChange) {
        await assert.rejects(attempt, /bounded capacity operation stopped/);
        assert.equal(effects, 0);
        assert.ok(foreignCheckpoint);
        const retained = await recoverReleaseOpportunity(repository, foreignCheckpoint);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt) &&
            isRecord(retained.input.controller.capacity_attempt.operation),
        );
        assert.equal(retained.input.controller.capacity_attempt.operation.outcome, "pending");
      } else {
        await attempt;
        assert.equal(effects, 1);
      }
      assert.equal(boundaries, 2);
      assert.throws(
        () => wrapped.requireOwnedCapacityPendingBoundary(session, {}),
        /current executor/,
      );
    }
  },
);
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

async function runExecutorRecoveryFixture(mode: "catalog-recovery" | "journal-controls") {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      fileURLToPath(new URL("./fixtures/release-executor-recovery-fixture.mts", import.meta.url)),
      mode,
    ],
    { env: environment, timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true },
  );
  assert.ok(stdout.includes(mode + " PASS; controlled dependencies, no hosted authority"));
}

void test("source-bound shared recovery requires exact terminal publisher/effect and writes only catalog cursor", () =>
  runExecutorRecoveryFixture("catalog-recovery"));

void test("actual recovery journal checks REST and GraphQL mutations synchronously after intervening reads", () =>
  runExecutorRecoveryFixture("journal-controls"));

void test("named catalog recovery requires both actual caller guard functions before any journal handoff", async () => {
  const source = await readFile(new URL("./release-site-deployment.mts", import.meta.url), "utf8"),
    start = source.indexOf("export async function recoverPublishedCatalogSiteHandoff("),
    end = source.indexOf("/** Bind actual", start);
  const session = {},
    raw = { repository: "controlled", checkpoint: "retained", remote_configuration: {} };
  let refreshes = 0,
    handoffs = 0;
  const run = runInNewContext(
    stripTypeScriptTypes(source.slice(start, end).replace("export ", "")) +
      "\nrecoverPublishedCatalogSiteHandoff",
    {
      sessions: new Map([
        [
          session,
          {
            catalog: { recovery_only: true, recovery_intent: { checkpoint: "retained" } },
            archive_bytes: 0,
          },
        ],
      ]),
      recoverOwnedPublishedCatalogMetadata: async (
        _executor: object,
        _raw: unknown,
        _readback: unknown,
        beforeMutation: unknown,
      ) => {
        assert.equal(typeof beforeMutation, "function");
        handoffs++;
        return {};
      },
    },
  ) as (...args: unknown[]) => Promise<unknown>;
  const refresh = async () => {
    refreshes++;
  };
  for (const guards of [
    undefined,
    null,
    {},
    { refresh },
    { refresh, beforeMutation: null },
    { refresh, beforeMutation: false },
    { refresh: true, beforeMutation: () => {} },
  ])
    await assert.rejects(run(session, {}, raw, guards), /current control mutation guards/);
  assert.equal(refreshes, 0);
  assert.equal(handoffs, 0);
  await run(session, {}, raw, { refresh, beforeMutation: () => {} });
  assert.equal(refreshes, 1);
  assert.equal(handoffs, 1);
});
