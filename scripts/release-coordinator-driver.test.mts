import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCoordinatorPublication,
  inspectPreparedReceiptInventoryAdvance,
  selectCoordinatorPublicationBaseline,
  selectCoordinatorMetadataRenewal,
  requireActualCoordinatorMetadataPreparation,
  coordinatorMaintenanceIdentity,
  coordinatorContinuationDeadline,
  coordinatorOriginalJobDeadline,
} from "./release-coordinator-driver.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import { performance } from "node:perf_hooks";

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
