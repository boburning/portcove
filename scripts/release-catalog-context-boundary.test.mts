/** Real Git/maintained operation and exact function-body wiring. Private maps,
 * identity/provider reads and crypto are controlled; no hosted capability. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { capacityDigest as digest, inspectCapacityOperation } from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { runBoundedCatalogPublicationOperation } from "./release-capacity-operation.mts";
import type { CapacityBoundaryReader } from "./release-capacity-operation.mts";
import { assertCatalogPublicationBaseline } from "./release-catalog-metadata-contract.mts";

void test(
  "real Git context pending is bound by actual executor callback before getter/effect, and only same intent is idempotent",
  { timeout: 60000 },
  async (t) => {
    for (const foreign of [false, true]) {
      const repository = await mkdtemp(path.join(os.tmpdir(), "catalog-context-boundary-"));
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
      const input = structuredClone(legacy.rows[0].input),
        descriptor = catalogPublicationFixture(),
        capacity = { ...capacityFixture(), schema_version: 2 };
      Object.assign(input, {
        schema_version: 2,
        opportunity: null,
        active_candidate: null,
        catalog_publication: descriptor,
        catalog_initialization: {
          schema_version: 1,
          kind: "catalog-initialization",
          authority: "none",
          source_commit: "8".repeat(40),
          source_tree: "9".repeat(40),
          root_sha256: descriptor.prior.catalog_root_sha256,
          publisher_configuration_sha256: descriptor.publisher_configuration_sha256,
          setup_plan_sha256: "a".repeat(64),
          initial_site_preimage_sha256: "b".repeat(64),
        },
        controller: {
          workflow: ".github/workflows/fixture.yml",
          revision: "3".repeat(40),
          publication_paused: false,
          capacity_attempt: capacity,
        },
      });
      const initial = await checkpointReleaseOpportunity(repository, null, input),
        executor = {},
        receipt = {};
      const identity = {
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
      const contextSource = await readFile(
          new URL("./release-catalog-signing-context.mts", import.meta.url),
          "utf8",
        ),
        executorSource = await readFile(
          new URL("./release-capacity-executor.mts", import.meta.url),
          "utf8",
        );
      const stateStart = contextSource.indexOf("async function verifyState("),
        stateEnd = contextSource.indexOf(
          "export async function prepareActualCatalogSigningContext(",
          stateStart,
        ),
        bindStart = contextSource.indexOf(
          "export async function bindActualCatalogSigningContextPending(",
        ),
        bindEnd = contextSource.indexOf(
          "export async function requireActualCatalogSigningContext(",
          bindStart,
        );
      const getterStart = executorSource.indexOf(
          "export function requireOwnedCapacityPendingBoundary(",
        ),
        getterEnd = executorSource.indexOf("async function observe(", getterStart),
        wrapperStart = executorSource.indexOf("const readOwnedBoundary: CapacityBoundaryReader ="),
        wrapperEnd = executorSource.indexOf("// Existing transport checks", wrapperStart);
      let checkpoint = initial.checkpoint,
        boundaries = 0,
        effects = 0,
        held: object | undefined;
      const owned = {
        session: { checkpoint: initial.checkpoint, tools: {} },
        facts: { descriptor },
        deadline: performance.now() + 50000,
        pending: undefined as unknown,
      };
      let wrapped: {
        readOwnedBoundary: CapacityBoundaryReader;
        requireOwnedCapacityPendingBoundary: (
          executor: object,
          receipt: object,
        ) => {
          checkpoint: string;
          operation: NonNullable<ReturnType<typeof inspectCapacityOperation>>;
        };
      };
      const context = runInNewContext(
        stripTypeScriptTypes(
          contextSource.slice(stateStart, stateEnd) +
            contextSource
              .slice(bindStart, bindEnd)
              .replaceAll("export async function", "async function"),
        ) +
          "\n({verifyState,bindActualCatalogSigningContextPending,bindActualCatalogSigningContextBoundary})",
        {
          contexts: new WeakMap([[receipt, owned]]),
          structuredClone,
          Object,
          isRecord,
          digest,
          inspectCapacityOperation,
          assertCatalogPublicationBaseline,
          remaining: () => {},
          refreshCapacityExecutor: async () => identity,
          verifiedControllerToolPaths: async () => ({
            identity: {
              controller_revision: identity.controller_revision,
              controller_ref: identity.execution_ref,
              run_id: identity.run_id,
              run_attempt: 1,
            },
          }),
          snapshot: async () => recoverReleaseOpportunity(repository, checkpoint),
          requireOwnedCapacityPendingBoundary: (actual: object, boundary: object) =>
            wrapped.requireOwnedCapacityPendingBoundary(actual, boundary),
          requireActualCatalogSigningContext: async () => {
            await context.verifyState(owned);
            return { capacity_source: { capacity: { boundary: capacity.boundary } } };
          },
        },
      ) as {
        verifyState: (owned: unknown) => Promise<unknown>;
        bindActualCatalogSigningContextPending: (
          receipt: object,
          executor: object,
          pending: { checkpoint: string; operation_id: string },
        ) => Promise<void>;
        bindActualCatalogSigningContextBoundary: (
          receipt: object,
          executor: object,
          boundary: object,
        ) => Promise<void>;
      };
      wrapped = runInNewContext(
        stripTypeScriptTypes(
          executorSource.slice(getterStart, getterEnd).replace("export function", "function") +
            executorSource.slice(wrapperStart, wrapperEnd),
        ) + "\n({readOwnedBoundary,requireOwnedCapacityPendingBoundary})",
        {
          sessions: new Map([[executor, {}]]),
          effectStates: new Map([[executor, { busy: true }]]),
          pendingBoundaries: new WeakMap(),
          performance,
          structuredClone,
          inspectCapacityOperation,
          capacityDigest: digest,
          executorIdentity: identity,
          session: executor,
          readBoundary: async (boundary?: object) => {
            boundaries++;
            assert.equal(effects, 0);
            if (boundary) {
              held = boundary;
              const pending = wrapped.requireOwnedCapacityPendingBoundary(executor, boundary);
              checkpoint = pending.checkpoint;
              await assert.rejects(context.verifyState(owned), /original checkpoint changed/);
              if (foreign)
                checkpoint = (
                  await checkpointReleaseOpportunity(
                    repository,
                    checkpoint,
                    (await recoverReleaseOpportunity(repository, checkpoint)).input,
                  )
                ).checkpoint;
              await context.bindActualCatalogSigningContextBoundary(receipt, executor, boundary);
              await assert.rejects(
                context.bindActualCatalogSigningContextBoundary(receipt, executor, {}),
                /current executor/,
              );
            }
            await context.verifyState(owned);
            return capacity.boundary;
          },
        },
      ) as typeof wrapped;
      const attempt = runBoundedCatalogPublicationOperation(
        repository,
        initial.checkpoint,
        descriptor,
        {
          kind: "upload",
          destination: "github-actions:boburning/portcove:catalog-publication-context",
        },
        wrapped.readOwnedBoundary,
        async (record, pending) => {
          effects++;
          assert.equal(boundaries, 2);
          assert.ok(held);
          assert.throws(
            () => wrapped.requireOwnedCapacityPendingBoundary(executor, held!),
            /current executor/,
          );
          await context.bindActualCatalogSigningContextPending(receipt, executor, {
            checkpoint: pending.checkpoint,
            operation_id: pending.operation.id,
          });
          await assert.rejects(
            context.bindActualCatalogSigningContextPending(receipt, executor, {
              checkpoint: "f".repeat(40),
              operation_id: pending.operation.id,
            }),
            /cannot change/,
          );
          await record("inert:context", "c".repeat(64));
        },
        { executorIdentity: identity, maximumReceipts: 1 },
      );
      if (foreign) {
        await assert.rejects(attempt, /bounded capacity operation stopped/);
        assert.equal(effects, 0);
      } else {
        checkpoint = (await attempt).checkpoint;
        await context.verifyState(owned);
        assert.equal(effects, 1);
      }
      assert.equal(boundaries, 2);
    }
  },
);

void test("actual context getter checks renewed maintenance only after delayed state/site/tool/inventory reads", async () => {
  const source = await readFile(
      new URL("./release-catalog-signing-context.mts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf("async function readContext("),
    end = source.indexOf("export async function readActualCatalogSigningContextFiles(", start),
    receipt = {},
    descriptor = catalogPublicationFixture();
  let now = 59000,
    eligible = true,
    returns = 0;
  const calls: string[] = [],
    tools = {},
    inspectionReceipt = {};
  const maintenance = () => ({
    pause: {},
    capacity: {},
    capacity_source: { capacity: { boundary: "inert" } },
  });
  const owned = {
    deadline: 170000,
    configuration_sha256: "fixed",
    facts: { descriptor, semantic_proof_sha256: "proof" },
    binding: {},
    files: [],
    directory: "controlled",
    observed: 0,
    control_identity: "stable",
    site: {},
    site_component: "catalog",
    work: "controlled",
    session: {
      tools,
      namespace: "portcove-production",
      repository: "controlled",
      checkpoint: "original",
      inputs: { inspection: inspectionReceipt },
      recheck_semantic: async () => ({ proof_sha256: "proof" }),
      next_controls: async () => {
        calls.push("renew");
        return {
          readMaintenance: () => {
            calls.push("maintenance-LAST");
            if (!eligible) throw new Error("expired final controls");
            return maintenance();
          },
        };
      },
    },
    source: {
      readMaintenance: () => {
        calls.push("old-maintenance");
        return maintenance();
      },
    },
  };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nreadContext", {
    contexts: new WeakMap([[receipt, owned]]),
    path,
    performance: { now: () => now },
    digest,
    structuredClone,
    remaining: () => {
      assert.ok(now < owned.deadline);
    },
    requireControllerCatalogJobAuthorities: async () => ({ configuration_sha256: "fixed" }),
    requireActualCatalogInspection: async () => ({
      bundle: "controlled",
      tools_receipt: tools,
      inspection_sha256: descriptor.core_inspection_sha256,
      bundle_sha256: descriptor.bundle_sha256,
      inspection: {},
    }),
    readCatalogPublicationBundle: async () => new Map(),
    assertControllerCatalogPublisherScope: () => {},
    apiFor: () => ({}),
    verifyState: async () => {
      calls.push("state");
      now = 61000;
    },
    requirePublishedCatalogCompleteSite: async () => {
      calls.push("site");
    },
    verifiedControllerToolPaths: async () => {
      calls.push("tool");
      return {};
    },
    readBoundedReleaseContextFiles: async () => {
      calls.push("inventory");
      return new Map();
    },
    inventory: () => [],
    catalogCoordinatorMaintenanceIdentity: () => "stable",
  }) as (receipt: object) => Promise<unknown>;
  await run(receipt);
  returns++;
  assert.deepEqual(
    calls.slice(-5),
    ["state", "site", "tool", "inventory", "renew"].slice(1).concat("maintenance-LAST"),
  );
  eligible = false;
  owned.observed = 0;
  now = 59000;
  await assert.rejects(run(receipt), /expired final controls/);
  assert.equal(returns, 1, "late false controls cannot return a usable capacity projection");
});

void test("actual catalog role guard puts delayed Check and checkpoint reads before renewed final controls and key release", async () => {
  const source = await readFile(new URL("./release-catalog-signing.mts", import.meta.url), "utf8"),
    start = source.indexOf("const fresh = async () => {"),
    end = source.indexOf("await guard();", start);
  let now = 59000,
    eligible = true,
    keys = 0;
  const events: string[] = [],
    facts = { descriptor: catalogPublicationFixture() },
    current = {
      purpose: "catalog-signing-controls",
      pause: {},
      capacity: {},
      resource_policy_matches_controller: true,
    };
  const run = runInNewContext(
    stripTypeScriptTypes(`let source, round=0, observed=-Infinity; ${source.slice(start, end)}`) +
      "\nguard",
    {
      performance: { now: () => now },
      path,
      directory: "controlled",
      deadline: 115000,
      phase: "catalog-definitions",
      toolsReceipt: {},
      contextReceipt: {},
      dependencies: [],
      authorities: { configuration_sha256: "fixed" },
      facts,
      binding: {},
      manifest: { facts_sha256: "facts", previous_site_pins: {} },
      admitted: { control_facts: { pause: {}, capacity: {} } },
      coordinator: {},
      active: () => {
        assert.ok(now < 115000);
        return 15000;
      },
      verifiedControllerToolPaths: async () => {
        events.push("tools");
      },
      requireRetainedCatalogSigningContext: async () => {},
      requireControllerCatalogJobAuthorities: async () => ({
        configuration_sha256: "fixed",
      }),
      readRemoteCoordinatorSnapshot: async () => {
        events.push("checkpoint");
        now = 61000;
        return {};
      },
      reservation: () => {},
      fixedApi: () => ({}),
      recheckCatalogSemanticProof: () => {
        events.push("Check");
        now = 61000;
      },
      authenticateCatalogReleaseControlRound: async () => {
        events.push("renew");
        return {
          evidence_scope: "github.com",
          readMaintenance: () => {
            events.push("maintenance-LAST");
            if (!eligible) throw new Error("final protection expired");
            return current;
          },
        };
      },
      isDeepStrictEqual: (a: unknown, b: unknown) => digest(a) === digest(b),
    },
  ) as () => Promise<void>;
  await run();
  keys++;
  assert.deepEqual(events.slice(-4), ["checkpoint", "Check", "renew", "maintenance-LAST"]);
  eligible = false;
  await assert.rejects(
    run().then(() => {
      keys++;
    }),
    /final protection expired/,
  );
  assert.equal(
    keys,
    1,
    "the same beforeKey guard cannot release key material after stale controls",
  );
});
