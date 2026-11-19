import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  collectDriftTargets,
  completedInspections,
  driftNotices,
  driftTargetKey,
  scanDriftTargets,
} from "./scheduled-package-drift.mts";

const source = { source_commit: "d".repeat(40), run_id: "42", run_attempt: "1" };
const now = Date.parse("2026-11-16T09:00:00Z");
const platform = "windows-x86-64";
const catalog = {
  ports: [{ id: "example", release: { repository: "owner/repo" }, platforms: [platform] }],
};
const listings = { listings: [{ id: "example", issue_number: 200 }] };
const table = {
  shape_version: 1,
  entries: [
    {
      port_id: "example",
      platform,
      sha256: "b".repeat(64),
      derivation_inputs_sha256: "c".repeat(64),
    },
  ],
};

function observation() {
  return {
    execution: source,
    catalog_policies_scope:
      "complete-current-consumer-projections; managed eligibility remains Core-only",
    unassessed_current_port_ids: [],
    source_port_ids: ["example"],
    catalog_policies: [
      {
        port_id: "example",
        repository_id: 900,
        observed_at: new Date(now - 60_000).toISOString(),
        catalog_definition_sha256: "e".repeat(64),
        projections: [
          {
            platform,
            channel: "stable",
            channel_candidate: { id: 2, tag: "v2" },
            latest_eligible: {
              release_id: 2,
              asset_id: 3,
              release: {
                version: "v2",
                channel: "stable",
                asset: {
                  name: "example.zip",
                  url: "https://github.com/owner/repo/releases/download/v2/example.zip",
                  size: 100,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        ],
      },
    ],
  };
}

const collect = (handoffs: unknown[]) =>
  collectDriftTargets(catalog, listings, table, handoffs, source, now);

void test("binds the inspected managed route to the exact Core projection and canonical issue", () => {
  const candidates = collect([observation(), observation()]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    portId: "example",
    issue: 200,
    platform,
    channel: "stable",
    definitionSha256: "e".repeat(64),
    baselineSha256: createHash("sha256").update(JSON.stringify(table.entries)).digest("hex"),
    derivationSha256: "c".repeat(64),
    shapeVersion: 1,
    repositoryId: 900,
    releaseId: 2,
    assetId: 3,
    version: "v2",
    asset: observation().catalog_policies[0]!.projections[0]!.latest_eligible.release.asset,
  });
  const conflict = observation();
  conflict.catalog_policies[0]!.projections[0]!.latest_eligible.asset_id++;
  assert.deepEqual(collect([observation(), conflict, observation()]), []);
});

void test("excludes fallback, stale, cross-run, noncanonical and unreviewable route observations", () => {
  const snapshot = observation();
  const wrongAttempt = { ...snapshot, execution: { ...source, run_attempt: "2" } };
  const historical = {
    ...snapshot,
    catalog_policies_scope: "last-complete-historical-fallback; current state unknown",
  };
  const fallback = observation();
  fallback.catalog_policies[0]!.projections[0]!.channel_candidate.id++;
  const stale = observation();
  stale.catalog_policies[0]!.observed_at = new Date(now - 5 * 60 * 60_000).toISOString();
  const foreign = observation();
  foreign.catalog_policies[0]!.projections[0]!.latest_eligible.release.asset.url =
    "https://github.com/other/repo/releases/download/v2/example.zip";
  assert.deepEqual(collect([wrongAttempt, historical, fallback, stale, foreign]), []);
  assert.deepEqual(
    collectDriftTargets(catalog, { listings: [] }, table, [snapshot], source, now),
    [],
  );
  assert.deepEqual(
    collectDriftTargets(catalog, listings, { ...table, entries: [] }, [snapshot], source, now),
    [],
  );
});

void test("inspects issue-free routes and preserves comparison identity when issue links change", async () => {
  const [linked] = collect([observation()]);
  const unlinkedListings = { listings: [{ id: "example" }] };
  const [unlinked] = collectDriftTargets(
    catalog,
    unlinkedListings,
    table,
    [observation()],
    source,
    now,
  );
  assert.ok(linked);
  assert.ok(unlinked);
  assert.equal(Object.hasOwn(unlinked, "issue"), false);
  assert.equal(driftTargetKey(unlinked), driftTargetKey(linked));

  const inspection = {
    status: "drifted" as const,
    shapeVersion: 1,
    derivationSha256: "c".repeat(64),
    components: ["top_level_folders"],
  };
  const result = await scanDriftTargets(
    [unlinked],
    new Map([[driftTargetKey(linked), inspection]]),
    now + 60_000,
    {
      now: () => now,
      download: async () => assert.fail("existing comparison should be reused"),
      inspect: async () => assert.fail("existing comparison should be reused"),
    },
  );
  assert.deepEqual(
    result.observations.map((entry) => entry.inspection),
    [inspection],
  );
  assert.equal(result.unassessed.length, 0);
  const report = { format: 1, run: source, ...result };
  assert.deepEqual(driftNotices(report, unlinkedListings, source), []);
  assert.deepEqual(driftNotices(report, listings, source), []);
});

void test("preserves an exact prior inspection and reports failures and unknown separately", async () => {
  const [target] = collect([observation()]);
  assert.ok(target);
  const compatible = {
    status: "compatible" as const,
    shapeVersion: 1,
    derivationSha256: "c".repeat(64),
    components: [],
  };
  const results = await scanDriftTargets(
    [
      target,
      { ...target, assetId: 5 },
      { ...target, assetId: 8 },
      { ...target, asset: { ...target.asset, size: 2 ** 30 } },
    ],
    new Map([[driftTargetKey(target), compatible]]),
    now + 60_000,
    {
      now: () => now,
      download: async (_asset, archive) => assert.match(archive, /example\.zip$/),
      inspect: async (_archive, candidate) => {
        if (candidate.assetId === 5) throw new Error("rejected archive");
        return { ...compatible, status: "unknown" };
      },
    },
  );
  assert.deepEqual(
    results.observations.map(({ inspection }) => inspection.status),
    ["compatible", "unknown"],
  );
  assert.deepEqual(
    results.unassessed.map(({ reason }) => reason),
    ["core-inspection-failed", "inspection-budget"],
  );
  assert.equal(results.attempted_bytes, 200);
});

void test("publishes one scoped notice per issue from current drift evidence only", () => {
  const [target] = collect([observation()]);
  assert.ok(target);
  const inspection = {
    status: "drifted",
    components: ["top_level_folders"],
    shapeVersion: 1,
    derivationSha256: "c".repeat(64),
  };
  const drifted = { target, key: driftTargetKey(target), inspection };
  const report = {
    format: 1,
    run: source,
    observations: [
      drifted,
      drifted,
      { ...drifted, target: { ...target, issue: 999 } },
      { ...drifted, inspection: { ...inspection, status: "unknown" } },
    ],
  };
  const notices = driftNotices(report, listings, source);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.issue, 200);
  assert.match(notices[0]?.body ?? "", /release 2, asset 3/);
  assert.match(notices[0]?.body ?? "", /top level folders/);
  assert.equal((notices[0]?.body.match(/asset 3/g) ?? []).length, 1);
  assert.throws(
    () => driftNotices(report, listings, { ...source, run_attempt: "2" }),
    /exact scheduled/,
  );
  const nextRun = { ...source, run_id: "43" };
  assert.equal(
    driftNotices({ ...report, run: nextRun }, listings, nextRun)[0]?.identity,
    notices[0]?.identity,
  );
});

void test("a changed inspector binary invalidates otherwise exact cached results", () => {
  const key = "f".repeat(64);
  const inspector_sha256 = "a".repeat(64);
  const cache = {
    format: 1,
    inspector_sha256,
    observations: [
      {
        key,
        inspection: {
          status: "compatible",
          shapeVersion: 1,
          derivationSha256: "c".repeat(64),
          components: [],
        },
      },
    ],
  };
  assert.equal(completedInspections(cache, inspector_sha256).get(key)?.status, "compatible");
  assert.equal(completedInspections(cache, "b".repeat(64)).size, 0);
});
