import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectMetadataSigningBinding,
  inspectMetadataSigningReservation,
} from "./release-metadata-signing-contract.mts";
import {
  prepareCoordinatorSigningContext,
  requireCoordinatorSigningContext,
  readCoordinatorSigningContextFiles,
  bindCoordinatorSigningContextPending,
} from "./release-metadata-signing-context.mts";
import { completeCoordinatorSigningContext } from "./release-metadata-signing-controller.mts";

function fixture() {
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"],
    versions = Object.fromEntries(roles.map((role) => [role, "9007199254740993"])),
    next = Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? "9007199254740993" : "9007199254740994"]),
    ),
    expires = Object.fromEntries(roles.map((role) => [role, "2026-10-21T00:00:00Z"])),
    after = Object.fromEntries(
      roles.map((role) => [
        role,
        role === "targets" ? "2026-10-21T00:00:00Z" : "2026-10-22T00:00:00Z",
      ]),
    );
  const pins = {
    repository_sha256: "a".repeat(64),
    root_sha256: "b".repeat(64),
    site_generation_sha256: "c".repeat(64),
  };
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: "2026-10-20T00:00:00Z",
    root_sha256: pins.root_sha256,
    offline_targets_sha256: "d".repeat(64),
    prior_repository_sha256: pins.repository_sha256,
    prior_timestamp_sha256: "e".repeat(64),
    prior_snapshot_sha256: "f".repeat(64),
    unchanged_records_sha256: digest([]),
    current_versions: versions,
    next_versions: next,
    current_expires: expires,
    next_expires: after,
  };
  const facts = {
    mode: "renewal",
    descriptor,
    namespace: "portcove-test",
    checkpoint: "1".repeat(40),
    previous_site_pins: pins,
    setup_plan_sha256: "2".repeat(64),
    public_source_commit: "3".repeat(40),
  };
  const binding = {
    kind: "metadata-renewal",
    descriptor_sha256: digest(descriptor),
    records_sha256: descriptor.unchanged_records_sha256,
  };
  return { facts, binding, pins };
}
void test("renewal role journal binding needs the exact live published seed and descriptor, with no invented candidate", (t) => {
  const f = fixture(),
    d = f.facts.descriptor;
  const published = {
    schema_version: 1,
    root_sha256: d.root_sha256,
    offline_targets_sha256: d.offline_targets_sha256,
    repository_sha256: d.prior_repository_sha256,
    timestamp_sha256: d.prior_timestamp_sha256,
    snapshot_sha256: d.prior_snapshot_sha256,
    records_sha256: d.unchanged_records_sha256,
    versions: d.current_versions,
    expires: d.current_expires,
    operation_id: null,
    publication: {
      remote_identity: "public fixture",
      evidence_sha256: "9".repeat(64),
      site_generation_sha256: f.pins.site_generation_sha256,
    },
  };
  const state = {
    input: { active_candidate: null, metadata_renewal: d, published_metadata: published },
  };
  const now = "2026-10-20T01:00:00Z";
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state, now), d);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T01:00:00.120Z") });
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state), d);
  t.mock.timers.tick(880);
  assert.equal(new Date().toISOString(), "2026-10-20T01:00:01.000Z");
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state), d);
  for (const input of [
    { ...state.input, metadata_renewal: null },
    { ...state.input, published_metadata: null },
    { ...state.input, published_metadata: { ...published, records_sha256: "0".repeat(64) } },
    {
      ...state.input,
      published_metadata: {
        ...published,
        publication: { ...published.publication, site_generation_sha256: "0".repeat(64) },
      },
    },
  ])
    assert.throws(() =>
      inspectMetadataSigningReservation(f.facts, f.binding, f.pins, { input }, now),
    );
  assert.throws(
    () =>
      inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state, "2026-10-22T00:00:00Z"),
    /expired/,
  );
});
void test("renewal context public contract preserves exact u64 and distinguishes unchanged feed from release/bootstrap claims", () => {
  const f = fixture(),
    result = inspectMetadataSigningBinding(f.facts, f.binding, f.pins);
  assert.ok(result.facts.descriptor.kind === "application-tuf-metadata-renewal");
  assert.equal(result.authority, "none");
  assert.equal(result.facts.descriptor.next_versions.releases, "9007199254740994");
  f.facts.descriptor.next_versions.releases = "7";
  assert.equal(result.facts.descriptor.next_versions.releases, "9007199254740994");
  for (const altered of [
    { ...fixture().facts, mode: "bootstrap" },
    { ...fixture().facts, version: "1.0.0" },
    { ...fixture().facts, native_accepted: true },
    { ...fixture().facts, checkpoint: "not-a-checkpoint" },
    { ...fixture().facts, namespace: "another/repository" },
  ])
    assert.throws(() => inspectMetadataSigningBinding(altered, fixture().binding, fixture().pins));
});
void test("metadata transport cannot substitute prior site, descriptor, records or offline role progression", () => {
  const f = fixture();
  for (const binding of [
    { ...f.binding, kind: "release-signing-context" },
    { ...f.binding, descriptor_sha256: "0".repeat(64) },
    { ...f.binding, records_sha256: "0".repeat(64) },
    { ...f.binding, accepted: true },
  ])
    assert.throws(() => inspectMetadataSigningBinding(f.facts, binding, f.pins));
  assert.throws(() =>
    inspectMetadataSigningBinding(f.facts, f.binding, {
      ...f.pins,
      repository_sha256: "0".repeat(64),
    }),
  );
  const changed = fixture();
  changed.facts.descriptor.next_versions.targets = "9007199254740994";
  assert.throws(() =>
    inspectMetadataSigningBinding(
      changed.facts,
      { ...changed.binding, descriptor_sha256: digest(changed.facts.descriptor) },
      changed.pins,
    ),
  );
});
void test("serialized coordinator results or caller pending cannot mint context custody or write outputs", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "metadata-context-refusal-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const imported = {
    kind: "actual-coordinator-metadata-signing-context",
    mode: "renewal",
    authority: "none",
  };
  await assert.rejects(
    prepareCoordinatorSigningContext(imported, parent, performance.now() + 1000),
    /same-process/,
  );
  await assert.rejects(completeCoordinatorSigningContext(imported, parent), /same-process/);
  await assert.rejects(requireCoordinatorSigningContext(imported), /actual coordinator/);
  await assert.rejects(readCoordinatorSigningContextFiles(imported), /actual coordinator/);
  await assert.rejects(
    bindCoordinatorSigningContextPending(imported, {} as never, {
      checkpoint: "a".repeat(40),
      operation_id: "b".repeat(64),
    }),
    /actual coordinator/,
  );
  assert.deepEqual(await readdir(parent), []);
});

void test("initial metadata binding requires explicit empty setup, null prior and current same-descriptor journal", async () => {
  const { metadataBootstrapFixture } = await import("./fixtures/release-metadata-fixture.mts");
  const f = metadataBootstrapFixture();
  const facts = {
    mode: "bootstrap",
    descriptor: f.descriptor,
    namespace: "portcove-test",
    checkpoint: "1".repeat(40),
    previous_site_pins: null,
    setup_plan_sha256: f.descriptor.setup_plan_sha256,
    public_source_commit: "2".repeat(40),
  };
  const binding = {
    kind: "metadata-bootstrap",
    descriptor_sha256: digest(f.descriptor),
    records_sha256: digest([]),
  };
  const actual = inspectMetadataSigningBinding(facts, binding, null);
  assert.equal(actual.facts.mode, "bootstrap");
  assert.equal(actual.previous_site_pins, null);
  assert.deepEqual(
    inspectMetadataSigningReservation(facts, binding, null, {
      input: { metadata_bootstrap: f.descriptor, published_metadata: null },
    }),
    f.descriptor,
  );
  for (const altered of [
    { ...facts, previous_site_pins: { repository_sha256: "a".repeat(64) } },
    { ...facts, setup_plan_sha256: "b".repeat(64) },
    { ...facts, mode: "renewal" },
    { ...facts, descriptor: { ...f.descriptor, initial_records_sha256: "c".repeat(64) } },
  ])
    assert.throws(() => inspectMetadataSigningBinding(altered, binding, null));
  for (const state of [
    { metadata_bootstrap: null, published_metadata: null },
    { metadata_bootstrap: f.descriptor, published_metadata: f.published },
  ])
    assert.throws(() => inspectMetadataSigningReservation(facts, binding, null, { input: state }));
  await assert.rejects(
    prepareCoordinatorSigningContext({ decision: "metadata-bootstrap-prepared" }, process.cwd()),
    /same-process/,
  );
});

void test("catalog-only initial metadata binds same-journal global prior, preserves catalog and closes old whole404 appointment", async () => {
  const { metadataBootstrapFixture } = await import("./fixtures/release-metadata-fixture.mts");
  const { assertBootstrapSiteBaseline } = await import("./release-metadata-signing-contract.mts");
  const f = metadataBootstrapFixture();
  const pins = {
    kind: "catalog-only",
    root_sha256: "7".repeat(64),
    repository_sha256: "8".repeat(64),
    site_generation_sha256: "9".repeat(64),
  };
  const initialSitePreimage = JSON.stringify({
    kind: "catalog-only-application-site-preimage",
    pins,
  });
  const { createHash } = await import("node:crypto");
  f.descriptor.initial_site_preimage_sha256 = createHash("sha256")
    .update(initialSitePreimage)
    .digest("hex");
  const catalog = {
    schema_version: 1,
    root_sha256: pins.root_sha256,
    offline_targets_sha256: "a".repeat(64),
    index_sha256: "b".repeat(64),
    repository_sha256: pins.repository_sha256,
    verifier_repository_sha256: "c".repeat(64),
    snapshot_sha256: "d".repeat(64),
    timestamp_sha256: "e".repeat(64),
    immutable_targets_sha256: "f".repeat(64),
    versions: { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires: Object.fromEntries(
      ["targets", "definitions", "policy", "snapshot", "timestamp"].map((k) => [
        k,
        "2027-01-01T00:00:00Z",
      ]),
    ),
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    operation_id: "3".repeat(64),
    publication: {
      site_generation_sha256: pins.site_generation_sha256,
      evidence_sha256: "4".repeat(64),
      remote_identity: "fixture:catalog",
    },
  };
  const input = {
    metadata_bootstrap: f.descriptor,
    published_metadata: null,
    published_catalog_metadata: catalog,
    published_site: {
      schema_version: 1,
      generation_sha256: pins.site_generation_sha256,
      components: {
        application: null,
        catalog: { root_sha256: pins.root_sha256, repository_sha256: pins.repository_sha256 },
      },
      operation_id: catalog.operation_id,
      publication: {
        evidence_sha256: catalog.publication.evidence_sha256,
        remote_identity: catalog.publication.remote_identity,
      },
    },
  };
  const facts = {
    mode: "bootstrap",
    descriptor: f.descriptor,
    namespace: "portcove-test",
    checkpoint: "1".repeat(40),
    previous_site_pins: pins,
    initial_site_preimage: initialSitePreimage,
    catalog_readback_sha256: "a".repeat(64),
    setup_plan_sha256: f.descriptor.setup_plan_sha256,
    public_source_commit: "2".repeat(40),
  };
  const binding = {
    kind: "metadata-bootstrap",
    descriptor_sha256: digest(f.descriptor),
    records_sha256: digest([]),
  };
  assert.deepEqual(
    inspectMetadataSigningReservation(facts, binding, pins, { input }),
    f.descriptor,
  );
  assert.deepEqual(input.published_catalog_metadata, catalog);
  assert.throws(() => assertBootstrapSiteBaseline(null, input), /whole-404/);
  for (const changed of [
    { ...input, published_site: null },
    { ...input, published_metadata: f.published },
    { ...input, published_catalog_metadata: { ...catalog, repository_sha256: "0".repeat(64) } },
    { ...input, published_site: { ...input.published_site, generation_sha256: "0".repeat(64) } },
  ])
    assert.throws(() =>
      inspectMetadataSigningReservation(facts, binding, pins, { input: changed }),
    );
  for (const altered of [
    { ...pins, kind: "application" },
    { ...pins, root_sha256: f.descriptor.root_sha256 },
    { ...pins, site_generation_sha256: "0".repeat(64) },
  ])
    assert.throws(() =>
      inspectMetadataSigningReservation(
        { ...facts, previous_site_pins: altered },
        binding,
        altered,
        { input },
      ),
    );
});

void test("actual metadata controller boundary binds maintained Git pending before getter and refuses copied or foreign pending", async (t) => {
  // Actual operation/Git + actual callback/binder/guard source in an inert VM.
  // VM-owned receipts below are not production OIDC/tool/control admission.
  const { execFileSync } = await import("node:child_process");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { capacityFixture } = await import("./fixtures/release-capacity-fixture.mts");
  const { metadataBootstrapFixture } = await import("./fixtures/release-metadata-fixture.mts");
  const { checkpointReleaseOpportunity, recoverReleaseOpportunity } =
    await import("./release-coordinator-state.mts");
  const { runBoundedMetadataBootstrapOperation } = await import("./release-capacity-operation.mts");
  const { inspectCapacityOperation } = await import("./release-capacity.mts");
  const { isRecord } = await import("./runtime-values.mts");
  const repository = await mkdtemp(path.join(os.tmpdir(), "metadata-pending-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", repository], {
    windowsHide: true,
    timeout: 10000,
  });
  const legacy: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-coordinator-legacy.json", import.meta.url), "utf8"),
  );
  assert(
    isRecord(legacy) &&
      Array.isArray(legacy.rows) &&
      isRecord(legacy.rows[0]) &&
      isRecord(legacy.rows[0].input),
  );
  const input = structuredClone(legacy.rows[0].input),
    capacity = { ...capacityFixture(), schema_version: 2 };
  const { descriptor } = metadataBootstrapFixture();
  input.schema_version = 2;
  input.active_candidate = null;
  input.now = new Date().toISOString();
  assert(isRecord(input.publication));
  input.publication.observed_at = input.now;
  input.published_metadata = null;
  input.metadata_bootstrap = descriptor;
  input.controller = {
    workflow: ".github/workflows/fixture.yml",
    revision: "3".repeat(40),
    publication_paused: false,
    capacity_attempt: capacity,
  };
  const first = await checkpointReleaseOpportunity(repository, null, input);
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
  const receipt = {},
    executor = { kind: "authenticated-capacity-executor" };
  const owned = {
    session: { mode: "bootstrap", checkpoint: first.checkpoint, tools: {} },
    descriptor,
    facts: {
      mode: "bootstrap",
      descriptor,
      namespace: "portcove-test",
      checkpoint: first.checkpoint,
      previous_site_pins: null,
      setup_plan_sha256: descriptor.setup_plan_sha256,
      public_source_commit: "2".repeat(40),
    },
    binding: {
      kind: "metadata-bootstrap",
      descriptor_sha256: digest(descriptor),
      records_sha256: digest([]),
    },
    pending: undefined as
      | undefined
      | { executor: object; checkpoint: string; operation_id: string },
  };
  const contexts = new WeakMap([[receipt, owned]]),
    sessions = new WeakMap([[executor, { deadline: performance.now() + 20000 }]]),
    effectStates = new WeakMap([[executor, { busy: true }]]),
    pendingBoundaries = new WeakMap<
      object,
      { session: object; checkpoint: string; operation: unknown }
    >();
  const source = await readFile(
      new URL("./release-metadata-signing-context.mts", import.meta.url),
      "utf8",
    ),
    executorSource = await readFile(
      new URL("./release-capacity-executor.mts", import.meta.url),
      "utf8",
    ),
    controllerSource = await readFile(
      new URL("./release-metadata-signing-controller.mts", import.meta.url),
      "utf8",
    );
  const take = (text: string, start: string, end: string) => {
    const a = text.indexOf(start),
      b = text.indexOf(end, a);
    assert(a >= 0 && b > a);
    return text.slice(a, b).replaceAll("export ", "");
  };
  let observedCheckpoint = first.checkpoint,
    effects = 0;
  let lastPrivate: object | undefined;
  const sandbox = {
    contexts,
    sessions,
    effectStates,
    pendingBoundaries,
    performance,
    structuredClone,
    inspectCapacityOperation,
    inspectMetadataSigningReservation,
    digest,
    isRecord,
    remaining: () => {},
    requirePublishedCompleteSite: async () => {
      throw new Error("not renewal");
    },
    refreshCapacityExecutor: async () => identity,
    verifiedControllerToolPaths: async () => ({
      identity: {
        controller_revision: identity.controller_revision,
        controller_ref: identity.execution_ref,
        run_id: identity.run_id,
        run_attempt: identity.run_attempt,
      },
    }),
    snapshot: async () => recoverReleaseOpportunity(repository, observedCheckpoint),
    requireCoordinatorSigningContext: async () => {
      throw new Error("uninitialized test getter");
    },
  };
  const code =
    take(
      executorSource,
      "export function requireOwnedCapacityPendingBoundary(",
      "\nasync function observe(",
    ) +
    "\n" +
    take(
      source,
      "async function verifyState(",
      "\nexport async function prepareCoordinatorSigningContext(",
    ) +
    "\n" +
    take(
      source,
      "export async function bindCoordinatorSigningContextBoundary(",
      "\nexport async function requireCoordinatorSigningContext(",
    );
  const bindings = runInNewContext(
    stripTypeScriptTypes(code) +
      "\n({bindCoordinatorSigningContextBoundary,bindCoordinatorSigningContextPending,verifyState})",
    sandbox,
  ) as {
    bindCoordinatorSigningContextBoundary: (r: object, e: object, p: object) => Promise<void>;
    bindCoordinatorSigningContextPending: (
      r: object,
      e: object,
      p: { checkpoint: string; operation_id: string },
    ) => Promise<void>;
    verifyState: (
      o: typeof owned,
      state: Awaited<ReturnType<typeof recoverReleaseOpportunity>>,
    ) => Promise<void>;
  };
  sandbox.requireCoordinatorSigningContext = async () => {
    const state = await recoverReleaseOpportunity(repository, observedCheckpoint);
    await bindings.verifyState(owned, state);
    return { capacity_source: { capacity: { boundary: capacity.boundary } } } as never;
  };
  const boundaryStart = controllerSource.indexOf("async (pending) => {"),
    boundaryEnd = controllerSource.indexOf("\n        async (pending) =>", boundaryStart);
  assert(boundaryStart > 0 && boundaryEnd > boundaryStart);
  const callback = runInNewContext(
    stripTypeScriptTypes(
      "const callback=" +
        controllerSource.slice(boundaryStart, boundaryEnd).trim().replace(/,$/u, "") +
        "; callback",
    ),
    {
      ...bindings,
      receipt,
      executor,
      deadline: performance.now() + 20000,
      requireCoordinatorSigningContext: sandbox.requireCoordinatorSigningContext,
    },
  ) as (p?: object) => Promise<unknown>;
  const wrapper = take(
    executorSource,
    "const readOwnedBoundary: CapacityBoundaryReader =",
    "\n    // Existing transport checks",
  );
  let boundaryFailure: unknown;
  const wrapped = runInNewContext(stripTypeScriptTypes(wrapper) + "\nreadOwnedBoundary", {
    inspectCapacityOperation,
    capacityDigest: digest,
    executorIdentity: identity,
    structuredClone,
    session: executor,
    pendingBoundaries,
    readBoundary: async (p?: object) => {
      if (p) {
        lastPrivate = p;
        const selected = pendingBoundaries.get(p);
        assert(selected);
        const original = selected.operation;
        assert(isRecord(original));
        for (const change of [
          { before_checkpoint: "f".repeat(40) },
          { outcome: "succeeded" },
          {
            completed_effects: [{ remote_identity: "unexpected", evidence_sha256: "a".repeat(64) }],
          },
          { destination: "github-actions:boburning/portcove:metadata-renewal-context" },
          { metadata_bootstrap: { descriptor_sha256: "0".repeat(64) } },
        ]) {
          pendingBoundaries.set(p, { ...selected, operation: { ...original, ...change } });
          await assert.rejects(
            bindings.bindCoordinatorSigningContextBoundary(receipt, executor, p),
            /original pending upload/,
          );
          assert.equal(owned.pending, undefined);
        }
        pendingBoundaries.set(p, selected);
        await assert.rejects(
          sandbox.requireCoordinatorSigningContext(),
          /initial checkpoint changed/,
        );
      }
      try {
        return await callback(p);
      } catch (error) {
        boundaryFailure = error;
        throw error;
      }
    },
  }) as (pending?: { checkpoint: string; operation: unknown }) => Promise<unknown>;
  await assert.rejects(
    bindings.bindCoordinatorSigningContextBoundary(receipt, executor, {}),
    /custody/,
  );
  await runBoundedMetadataBootstrapOperation(
    repository,
    first.checkpoint,
    descriptor,
    { kind: "upload", destination: "github-actions:boburning/portcove:metadata-bootstrap-context" },
    async (pending) => {
      if (pending) observedCheckpoint = pending.checkpoint;
      return await wrapped(pending);
    },
    async (record, pending) => {
      effects++;
      await bindings.bindCoordinatorSigningContextPending(receipt, executor, {
        checkpoint: pending.checkpoint,
        operation_id: String(pending.operation.id),
      });
      await assert.rejects(
        bindings.bindCoordinatorSigningContextPending(
          receipt,
          {},
          { checkpoint: pending.checkpoint, operation_id: String(pending.operation.id) },
        ),
        /one exact/,
      );
      await record("fixture:metadata-context", "a".repeat(64));
    },
    { executorIdentity: identity, maximumReceipts: 1 },
  ).catch((error: unknown) => {
    throw boundaryFailure ?? error;
  });
  assert.equal(effects, 1);
  assert(owned.pending);
  assert.notEqual(owned.pending.checkpoint, first.checkpoint);
  assert(lastPrivate);
  await assert.rejects(
    bindings.bindCoordinatorSigningContextBoundary(receipt, executor, lastPrivate),
    /custody/,
  );
});

void test("metadata context rechecks maintenance after slow current-state/public reads before returning boundary", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(
    new URL("./release-metadata-signing-context.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function requireCoordinatorSigningContext("),
    end = source.indexOf("\nexport async function readCoordinatorSigningContextFiles", start);
  assert(start > 0 && end > start);
  let clock = 59000;
  const reads: number[] = [];
  const receipt = {},
    owned = {
      deadline: 100000,
      session: { mode: "bootstrap", tools: {}, preparation: {} },
      descriptor: {},
      directory: "inert",
      files: [],
      bootstrap_observed: 59000,
    };
  const getter = runInNewContext(
    stripTypeScriptTypes(source.slice(start, end).replace("export ", "")) +
      "\nrequireCoordinatorSigningContext",
    {
      contexts: new WeakMap([[receipt, owned]]),
      performance: { now: () => clock },
      remaining: () => {},
      digest,
      verifiedControllerToolPaths: async () => ({}),
      inspectPreparedMetadataBootstrap: async () => ({ descriptor: {} }),
      readBoundedReleaseContextFiles: async () => new Map(),
      inventory: () => [],
      controls: async () => {
        reads.push(clock);
        if (clock >= 60000) throw new Error("original maintenance observation expired");
        return {};
      },
      snapshot: async () => {
        clock = 61000;
        return {};
      },
      verifyState: async () => {},
      structuredClone,
    },
  ) as (r: object) => Promise<unknown>;
  await assert.rejects(getter(receipt), /maintenance observation expired/);
  assert.deepEqual(reads, [59000, 61000]);
});
