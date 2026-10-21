import assert from "node:assert/strict";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import {
  deriveCoordinatorPublication,
  inspectPreparedReceiptInventoryAdvance,
  selectCoordinatorPublicationBaseline,
  selectCoordinatorMetadataRenewal,
  requireActualCoordinatorMetadataPreparation,
  coordinatorMaintenanceIdentity,
  coordinatorContinuationDeadline,
  coordinatorOriginalJobDeadline,
  selectCoordinatorPendingPagesRecovery,
  materializeCoordinatorPublishedSite,
  selectCoordinatorMetadataBootstrap,
  requireActualCoordinatorBootstrapPreparation,
} from "./release-coordinator-driver.mts";
import { metadataFixture, metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { performance } from "node:perf_hooks";
import { pagesRecoveryOperationFixture } from "./fixtures/release-pages-recovery-fixture.mts";

void test("initial bootstrap selection closes permanently on a real seed and never clears an existing effect", async () => {
  const { descriptor } = metadataBootstrapFixture();
  const input = {
    metadata_bootstrap: descriptor,
    published_metadata: null,
    active_candidate: { phase: "qualifying", transient_retries: 2, substantive_repairs: 3 },
    review_request: { retained: true },
  };
  const before = structuredClone(input);
  assert.equal(selectCoordinatorMetadataBootstrap(input, descriptor.generated_at), "resume");
  assert.deepEqual(input, before);
  assert.equal(
    selectCoordinatorMetadataBootstrap(
      { ...input, metadata_bootstrap: null },
      descriptor.generated_at,
    ),
    "initial",
  );
  assert.equal(
    selectCoordinatorMetadataBootstrap(
      { ...input, published_metadata: metadataFixture().published },
      descriptor.generated_at,
    ),
    "closed",
  );
  assert.equal(
    selectCoordinatorMetadataBootstrap(
      {
        ...input,
        controller: { capacity_attempt: { operation: pagesRecoveryOperationFixture() } },
      },
      descriptor.generated_at,
    ),
    "held-unresolved-effect",
  );
  assert.throws(() => selectCoordinatorMetadataBootstrap(input, "2099-01-01T00:00:00Z"), /expired/);
  await assert.rejects(
    requireActualCoordinatorBootstrapPreparation({ decision: "metadata-bootstrap-prepared" }),
    /same-process/,
  );
});

void test("default wake selects only unresolved exact Pages expectations without fabricating one", () => {
  const operation = pagesRecoveryOperationFixture();
  const input = { controller: { capacity_attempt: { operation } } };
  assert.equal(selectCoordinatorPendingPagesRecovery(input)?.operation.id, operation.id);
  assert.equal(selectCoordinatorPendingPagesRecovery({}), null);
  assert.equal(
    selectCoordinatorPendingPagesRecovery({
      controller: { capacity_attempt: { operation: null } },
    }),
    null,
  );
  assert.equal(
    selectCoordinatorPendingPagesRecovery({
      controller: {
        capacity_attempt: {
          operation: {
            ...operation,
            outcome: "succeeded",
            completed_effects: [
              {
                remote_identity:
                  "github-pages:boburning/portcove:" +
                  operation.site_expectation.site_generation_sha256,
                evidence_sha256: "9".repeat(64),
              },
            ],
          },
        },
      },
    }),
    null,
  );
  assert.throws(() =>
    selectCoordinatorPendingPagesRecovery({
      controller: {
        capacity_attempt: {
          operation: {
            ...operation,
            site_expectation: { ...operation.site_expectation, artifact_id: 999 },
          },
        },
      },
    }),
  );
});
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { capacityDigest } from "./release-capacity.mts";
import { requirePublishedCompleteSite } from "./release-site-readback.mts";

void test("actual fixed initial helper awaits ordinal0 observation before authenticating continuation source (inert dependencies)", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coordinator-initial0-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(
    new URL("./release-coordinator-driver.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function authenticateCoordinatorInitialControls(");
  const end = source.indexOf("export function selectCoordinatorMetadataBootstrap", start);
  assert(start >= 0 && end > start);
  const helper = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" }).replace(
    'await import("./release-control-step-bridge.mts")',
    "bridge",
  );
  const events: string[] = [];
  let allowObservation!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    allowObservation = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const artifact = { scope: "inert-observer0" };
  const run = runInNewContext(`${helper}; authenticateCoordinatorInitialControls;`, {
    path,
    writeFile,
    prepareControlReadiness: (_reader: unknown, _facts: string, phase: string) => {
      assert.equal(phase, "coordinator");
      events.push("prepare0");
      return { scope: "inert-ready0" };
    },
    bridge: {
      async retainControlStepLocator(file: string, phase: string, ordinal: number) {
        assert.equal(phase, "coordinator");
        assert.equal(ordinal, 0);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { scope: "inert-ready0" });
        events.push("locator0");
      },
    },
    waitForControlArtifact: async (_directory: string, kind: string, expected: unknown) => {
      assert.equal(kind, "observation");
      assert(expected);
      events.push("wait0");
      entered();
      await pending;
      return artifact;
    },
    authenticateReleaseControlSource: async (
      _env: unknown,
      _workflow: Buffer,
      options: { phase: string; observedArtifact: unknown },
    ) => {
      assert.equal(options.phase, "coordinator");
      assert.equal(options.observedArtifact, artifact);
      events.push("authenticate0");
      return { scope: "inert-authenticated-source" };
    },
    process: { env: {} },
  }) as (
    directory: string,
    facts: string,
    reader: unknown,
    workflow: Buffer,
    budget: unknown,
  ) => Promise<unknown>;
  const result = run(
    directory,
    "a".repeat(64),
    {
      identity: { scope: "inert-reader" },
      admitted: {
        revision: "b".repeat(40),
        execution_ref: "refs/tags/controller",
        run_id: "123",
        run_attempt: 1,
      },
    },
    Buffer.from("inert workflow"),
    { deadline: Date.now() + 10000, monotonicDeadline: performance.now() + 10000, check() {} },
  );
  await waiting;
  assert.deepEqual(events, ["prepare0", "locator0", "wait0"]);
  allowObservation();
  assert.deepEqual(await result, { scope: "inert-authenticated-source" });
  assert.deepEqual(events, ["prepare0", "locator0", "wait0", "authenticate0"]);
});

void test("coordinator keeps the real whole-site receipt through its default materialization seam", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coordinator-public-site-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const files = new Map([
    [".nojekyll", Buffer.alloc(0)],
    ["application/metadata/1.root.json", Buffer.from("inert pinned root")],
    ["application/metadata/timestamp.json", Buffer.from("inert metadata")],
    ["catalog/targets/retained.json", Buffer.from("opaque independent catalog")],
  ]);
  const inventory = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const root = inventory.find((file) => file.path === "application/metadata/1.root.json")!.sha256;
  const unsigned = {
    schema_version: 1,
    previous_generation: null,
    application_root_sha256: root,
    files: inventory,
  };
  const marker = { ...unsigned, generation: capacityDigest(unsigned) };
  files.set("publication.json", Buffer.from(JSON.stringify(marker)));
  const pins = {
    site_generation_sha256: marker.generation,
    root_sha256: root,
    repository_sha256: capacityDigest(
      inventory
        .filter((file) => file.path.startsWith("application/"))
        .map((file) => ({ ...file, path: file.path.slice(12) })),
    ),
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    const result = new Response(
      files.get(url.slice("https://boburning.github.io/portcove/".length)),
    );
    Object.defineProperty(result, "url", { value: url });
    return result;
  });
  const acquired = await materializeCoordinatorPublishedSite(
    pins,
    parent,
    performance.now() + 5000,
  );
  assert.equal(
    (await requirePublishedCompleteSite(acquired.receipt)).generation.generation,
    marker.generation,
  );
  await assert.rejects(requirePublishedCompleteSite(acquired));
  await writeFile(
    path.join(acquired.verified.directory, "catalog/targets/retained.json"),
    "changed",
  );
  await assert.rejects(requirePublishedCompleteSite(acquired.receipt));
});

void test("coordinator budget includes original job setup and refuses missing duplicate or stale provider facts", () => {
  const expected = { run_id: "123", controller_revision: "a".repeat(40) };
  const now = Date.parse("2026-10-20T00:02:00Z");
  const job = {
    id: 1,
    name: "Coordinate application release",
    run_id: 123,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    status: "in_progress",
    started_at: "2026-10-20T00:00:00Z",
  };
  const inventory = { total_count: 1, jobs: [job] };
  assert.equal(coordinatorOriginalJobDeadline(inventory, expected, now, 100), 50100);
  for (const bad of [
    { ...inventory, total_count: 2 },
    { ...inventory, jobs: [job, job], total_count: 2 },
    { ...inventory, jobs: [{ ...job, status: "completed" }] },
    { ...inventory, jobs: [{ ...job, run_attempt: 2 }] },
    { ...inventory, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
    { ...inventory, jobs: [{ ...job, started_at: "2026-10-20T00:03:00Z" }] },
    { ...inventory, jobs: [{ ...job, started_at: "2026-10-19T23:59:00Z" }] },
  ])
    assert.throws(() => coordinatorOriginalJobDeadline(bad, expected, now, 100));
});

void test("coordinator continuation can only tighten its original finite deadline", () => {
  const original = performance.now() + 10000;
  assert.equal(coordinatorContinuationDeadline(original), original);
  assert.equal(coordinatorContinuationDeadline(original, original + 1000), original);
  assert.equal(coordinatorContinuationDeadline(original, original - 1000), original - 1000);
  assert.throws(() => coordinatorContinuationDeadline(original, NaN), /finite/);
  assert.throws(() => coordinatorContinuationDeadline(original, 0), /exhausted/);
});

void test("maintenance continuation permits only fresh observation fields to change", () => {
  const original = {
    phase: "coordinator",
    purpose: "metadata-coordinator-controls",
    reader: { job_id: 12, run_id: 13, check_run_id: "14", expires_at: "old" },
    pause: { commit: "a".repeat(40), publication_paused: false },
    capacity: { commit: "a".repeat(40), document_sha256: "b".repeat(64) },
    protection: {
      observed_at: "old",
      inventory_sha256: "c".repeat(64),
      authorization: "input-writer-policy-only",
    },
    resource_policy_matches_controller: true,
    facts_sha256: "d".repeat(64),
    authority: "none",
  };
  const refreshed = {
    ...structuredClone(original),
    reader: { ...original.reader, expires_at: "new", round: { index: 1, nonce: "e".repeat(64) } },
    protection: { ...original.protection, observed_at: "new" },
    facts_sha256: "f".repeat(64),
  };
  assert.equal(coordinatorMaintenanceIdentity(original), coordinatorMaintenanceIdentity(refreshed));
  for (const changed of [
    { ...refreshed, reader: { ...refreshed.reader, job_id: 15 } },
    { ...refreshed, pause: { ...refreshed.pause, commit: "f".repeat(40) } },
    { ...refreshed, capacity: { ...refreshed.capacity, document_sha256: "f".repeat(64) } },
    { ...refreshed, protection: { ...refreshed.protection, inventory_sha256: "f".repeat(64) } },
  ])
    assert.notEqual(
      coordinatorMaintenanceIdentity(original),
      coordinatorMaintenanceIdentity(changed),
    );
  assert.throws(() =>
    coordinatorMaintenanceIdentity({ ...original, resource_policy_matches_controller: false }),
  );
  assert.throws(() =>
    coordinatorMaintenanceIdentity({
      ...original,
      pause: { ...original.pause, publication_paused: true },
    }),
  );
});

void test("serialized renewal output cannot reconstruct the coordinator's private continuation", async () => {
  await assert.rejects(
    requireActualCoordinatorMetadataPreparation({
      decision: "metadata-prepared",
      checkpoint: "a".repeat(40),
      descriptor: metadataFixture().descriptor,
      context: "/imported/context.json",
      prepared_root: "/imported",
    }),
    /actual same-process coordinator metadata preparation/,
  );
});

void test("default metadata scheduling preserves an unfinished descriptor and renews within the timestamp safety window", () => {
  const fixture = metadataFixture(Date.parse("2026-10-20T00:00:00Z"));
  const input = { published_metadata: fixture.published };
  assert.equal(selectCoordinatorMetadataRenewal({}, fixture.now), "unconfigured");
  assert.equal(selectCoordinatorMetadataRenewal(input, "2026-10-19T23:59:59Z"), "not-due");
  assert.equal(selectCoordinatorMetadataRenewal(input, fixture.now), "due");
  assert.equal(selectCoordinatorMetadataRenewal(input, "2026-10-22T00:00:00Z"), "due");
  assert.equal(
    selectCoordinatorMetadataRenewal(
      { ...input, metadata_renewal: fixture.descriptor },
      "2026-10-19T23:59:59Z",
    ),
    "resume",
  );
  const advanced = { ...fixture.published, repository_sha256: "9".repeat(64) };
  assert.equal(
    selectCoordinatorMetadataRenewal(
      { published_metadata: advanced, metadata_renewal: fixture.descriptor },
      "2026-10-19T23:59:59Z",
    ),
    "not-due",
  );
  assert.throws(() => selectCoordinatorMetadataRenewal(input, "invalid"), /clock/);
  assert.throws(() =>
    selectCoordinatorMetadataRenewal({ ...input, metadata_renewal: {} }, fixture.now),
  );
  const waiting = {
    ...input,
    active_candidate: { phase: "failed", transient_retries: 2, substantive_repairs: 3 },
    review_request: { request_id: "unavailable-independent-producer" },
  };
  const original = structuredClone(waiting);
  assert.equal(selectCoordinatorMetadataRenewal(waiting, fixture.now), "due");
  assert.deepEqual(waiting, original);
});

const ref = (name: string, oid: string, id = name) => ({
  id,
  name,
  prefix: "refs/tags/",
  target: { __typename: "Commit", oid },
});
const release = (version: string, time: string, prerelease = true, id = 1) => ({
  id,
  tag_name: `v${version}`,
  published_at: time,
  updated_at: time,
  draft: false,
  prerelease,
});
void test("published Release presence retains the exact active allocation until separately authenticated completion", () => {
  const allocation = {
    version: "0.1.0-alpha.3",
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    intent_sha256: "e".repeat(64),
  };
  const tags = [ref("v0.1.0-alpha.3", allocation.prepared_commit)];
  const releases = [release("0.1.0-alpha.3", "2026-10-19T00:00:00Z")];
  const now = "2026-10-20T00:00:00.000Z";
  assert.deepEqual(
    deriveCoordinatorPublication(tags, releases, [allocation], now).reserved_versions,
    [],
  );
  assert.deepEqual(
    deriveCoordinatorPublication(tags, releases, [allocation], now, {
      ...allocation,
      phase: "promoting",
    }).reserved_versions,
    [allocation.version],
  );
  assert.throws(
    () =>
      deriveCoordinatorPublication(tags, releases, [allocation], now, {
        ...allocation,
        intent_sha256: "f".repeat(64),
      }),
    /allocation receipts/,
  );
  assert.throws(
    () => deriveCoordinatorPublication(tags, releases, [], now, allocation),
    /allocation receipts/,
  );
});
void test("neutral request uses the uniquely latest publication only when it is also the highest version", () => {
  const old = release("0.1.0-alpha.2", "2026-10-18T00:00:00Z");
  const current = release("0.1.0-alpha.3", "2026-10-19T00:00:00Z", true, 2);
  const versions = ["0.1.0-alpha.2", "0.1.0-alpha.3"];
  assert.deepEqual(selectCoordinatorPublicationBaseline([current, old], versions), {
    release: current,
    version: "0.1.0-alpha.3",
  });
  assert.throws(() => selectCoordinatorPublicationBaseline([], []), /baseline absent/);
  assert.throws(
    () =>
      selectCoordinatorPublicationBaseline(
        [old, { ...current, published_at: old.published_at }],
        versions,
      ),
    /unique latest/,
  );
  assert.throws(
    () =>
      selectCoordinatorPublicationBaseline(
        [{ ...old, published_at: "2026-10-20T00:00:00Z" }, current],
        versions,
      ),
    /unique latest/,
  );
});
void test("complete publication facts map prepared and historical direct tags without inferring urgency", () => {
  const releases = [
    release("0.1.0-alpha.2", "2026-10-18T00:00:00Z"),
    release("0.1.0-alpha.3", "2026-10-19T00:00:00Z", true, 2),
  ];
  const allocations = [
    {
      version: "0.1.0-alpha.3",
      source_commit: "b".repeat(40),
      source_tree: "c".repeat(40),
      prepared_commit: "d".repeat(40),
      prepared_tree: "e".repeat(40),
      intent_sha256: "f".repeat(64),
    },
  ];
  const result = deriveCoordinatorPublication(
    [ref("v0.1.0-alpha.2", "a".repeat(40)), ref("v0.1.0-alpha.3", "d".repeat(40))],
    releases,
    allocations,
    "2026-10-20T00:00:00.000Z",
  );
  assert.deepEqual(result.published_versions, ["0.1.0-alpha.2", "0.1.0-alpha.3"]);
  assert.deepEqual(result.published_sources, ["a".repeat(40), "b".repeat(40)]);
  assert.deepEqual(result.reserved_versions, []);
  assert.equal(result.last_routine_preview_at, "2026-10-19T00:00:00.000Z");
  assert.equal(result.last_routine_preview_bound, "all-published-previews");
  assert.equal(
    deriveCoordinatorPublication([], [], [], "2026-10-20T00:00:00.000Z").last_routine_preview_at,
    null,
  );
});
void test("publication facts refuse missing tags, duplicate versions, changed preparation and future time", () => {
  const rows = [release("0.1.0-alpha.2", "2026-10-18T00:00:00Z")];
  const tags = [ref("v0.1.0-alpha.2", "a".repeat(40))];
  assert.throws(
    () => deriveCoordinatorPublication([], rows, [], "2026-10-20T00:00:00.000Z"),
    /unique tag/,
  );
  assert.throws(
    () =>
      deriveCoordinatorPublication(
        tags,
        [...rows, { ...rows[0]!, id: 2 }],
        [],
        "2026-10-20T00:00:00.000Z",
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      deriveCoordinatorPublication(
        tags,
        rows,
        [
          {
            version: "0.1.0-alpha.2",
            source_commit: "b".repeat(40),
            source_tree: "c".repeat(40),
            prepared_commit: "d".repeat(40),
            prepared_tree: "e".repeat(40),
            intent_sha256: "f".repeat(64),
          },
        ],
        "2026-10-20T00:00:00.000Z",
      ),
    /preparation receipt/,
  );
  assert.throws(
    () => deriveCoordinatorPublication(tags, rows, [], "2026-10-17T00:00:00.000Z"),
    /publication time/,
  );
});
void test("late publication bracket permits only the exact two own immutable preparation receipts", () => {
  const candidate = {
    version: "0.1.0-alpha.3",
    source_commit: "b".repeat(40),
    prepared_commit: "c".repeat(40),
  };
  const before = [ref("v0.1.0-alpha.2", "a".repeat(40))];
  const added = [
    ref("portcove-fixture-prepared/v0.1.0-alpha.3", candidate.prepared_commit),
    ref(`portcove-fixture-prepared-source/${candidate.source_commit}`, candidate.prepared_commit),
  ];
  inspectPreparedReceiptInventoryAdvance(
    before,
    [...before, ...added],
    "portcove-fixture",
    candidate,
  );
  inspectPreparedReceiptInventoryAdvance(
    [...before, ...added],
    [...before, ...added],
    "portcove-fixture",
    candidate,
  );
  assert.throws(
    () =>
      inspectPreparedReceiptInventoryAdvance(
        before,
        [...before, added[0]!],
        "portcove-fixture",
        candidate,
      ),
    /incomplete/,
  );
  assert.throws(
    () => inspectPreparedReceiptInventoryAdvance(before, [...added], "portcove-fixture", candidate),
    /existing provider/,
  );
  assert.throws(
    () =>
      inspectPreparedReceiptInventoryAdvance(
        before,
        [...before, ...added, ref("unrelated", "d".repeat(40))],
        "portcove-fixture",
        candidate,
      ),
    /unrelated/,
  );
});
