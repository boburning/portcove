import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { derivationInputs, derivationInputsDigest } from "./package-shape-baselines.mts";
import {
  collectDriftTargets,
  completedInspections,
  driftNotices,
  driftTargetKey,
  inspectionFromResponse,
  readDriftContinuation,
  scanDriftTargets,
  type DriftTarget,
} from "./scheduled-package-drift.mts";

const source = {
  source_commit: "d".repeat(40),
  run_id: "42",
  run_attempt: "1",
  event_name: "schedule",
} as const;
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

void test("only OpenMoHAA Unix shape identities include the prepared programs rule", () => {
  const openmohaa = { external_profile_policy: "openmohaa-unix-v1" };
  for (const platform of ["linux-x86-64", "macos-x86-64", "macos-aarch64"]) {
    assert.equal(derivationInputs(openmohaa, platform).openmohaa_prepared_programs, true);
  }
  assert.equal(
    derivationInputs(openmohaa, "windows-x86-64").openmohaa_prepared_programs,
    undefined,
  );
  assert.equal(
    derivationInputs(catalog.ports[0], "linux-x86-64").openmohaa_prepared_programs,
    undefined,
  );
});

function observation(portId = "example") {
  return {
    execution: source,
    catalog_policies_scope:
      "complete-current-consumer-projections; managed eligibility remains Core-only",
    unassessed_current_port_ids: [],
    source_port_ids: [portId],
    catalog_policies: [
      {
        port_id: portId,
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
  collectDriftTargets(catalog, listings, table, handoffs, source, now).targets;

const layout = { directories: ["data"], executables: ["example.exe"] };
const layoutPort = {
  ...catalog.ports[0]!,
  id: "layout",
  adapter: "native-portable",
  reviewed_package_layouts: { [platform]: layout },
};
const layoutListings = { listings: [...listings.listings, { id: "layout" }] };

function collectWithLayout(port = layoutPort, shapes = table) {
  return collectDriftTargets(
    { ports: [...catalog.ports, port] },
    layoutListings,
    shapes,
    [observation("layout"), observation()],
    source,
    now,
  ).targets;
}

const comparedLayout = {
  status: "unknown",
  baseline: { source: "reviewed_layout" },
  reason: "incomplete_comparison",
  unknown: [
    "persistent_parent_children",
    "persistent_overlap",
    "config_files",
    "missing_persistent_parents",
  ],
};

const coreResponse = (target: DriftTarget, verdict: unknown) => ({
  ok: true,
  command: "catalog.inspect-package-shape",
  data: {
    port_id: target.portId,
    platform: target.platform,
    sha256: target.asset.sha256,
    shape_version: target.shapeVersion,
    derivation_inputs_sha256: target.derivationSha256,
    verdict,
  },
});

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
    collectDriftTargets(catalog, { listings: [] }, table, [snapshot], source, now).targets,
    [],
  );
  assert.deepEqual(
    collectDriftTargets(catalog, listings, { ...table, entries: [] }, [snapshot], source, now)
      .targets,
    [],
  );
});

void test("reports one exact current missing-baseline row without inspection or issue notice", async () => {
  const port = { ...catalog.ports[0]!, adapter: "n64-recomp-portable" };
  const noShapes = { ...table, entries: [] };
  const select = (handoffs: unknown[]) =>
    collectDriftTargets({ ports: [port] }, listings, noShapes, handoffs, source, now);
  const snapshot = observation();
  const selected = select([snapshot, structuredClone(snapshot)]);
  assert.deepEqual(selected, {
    targets: [],
    baselineGaps: {
      rows: [
        {
          reason: "no-reviewed-baseline",
          port_id: "example",
          platform,
          channel: "stable",
          definition_sha256: "e".repeat(64),
          repository_id: 900,
          release_id: 2,
          asset_id: 3,
          asset_sha256: "a".repeat(64),
          version: "v2",
        },
      ],
      omitted: 0,
    },
  });
  const inspected = await scanDriftTargets(selected.targets, new Map(), now + 60_000, {
    now: () => now,
    download: async () => assert.fail("missing baseline should not download"),
    inspect: async () => assert.fail("missing baseline should not inspect"),
  });
  assert.equal(inspected.attempted_bytes, 0);
  assert.deepEqual(inspected.observations, []);
  assert.deepEqual(
    driftNotices(
      { format: 1, run: source, ...inspected, baseline_gaps: selected.baselineGaps },
      listings,
      source,
    ),
    [],
  );

  const conflict = observation();
  conflict.catalog_policies[0]!.projections[0]!.latest_eligible.asset_id++;
  assert.deepEqual(select([snapshot, conflict, snapshot]).baselineGaps.rows, []);
  const sameAssetId = observation();
  sameAssetId.catalog_policies[0]!.projections[0]!.latest_eligible.release.asset.size++;
  assert.deepEqual(select([snapshot, sameAssetId, snapshot]).baselineGaps.rows, []);
  const partial = { ...snapshot, unassessed_current_port_ids: ["example"] };
  const crossRun = { ...snapshot, execution: { ...source, run_attempt: "2" } };
  const fallback = observation();
  fallback.catalog_policies[0]!.projections[0]!.channel_candidate.id++;
  const stale = observation();
  stale.catalog_policies[0]!.observed_at = new Date(now - 5 * 60 * 60_000).toISOString();
  const foreign = observation();
  foreign.catalog_policies[0]!.projections[0]!.latest_eligible.release.asset.url =
    "https://github.com/other/repo/releases/download/v2/example.zip";
  const historical = {
    ...snapshot,
    catalog_policies_scope: "last-complete-historical-fallback; current state unknown",
  };
  assert.deepEqual(
    select([partial, crossRun, fallback, stale, foreign, historical]).baselineGaps.rows,
    [],
  );
  for (const unsupported of [
    { ...catalog.ports[0]!, adapter: "manual-setup" },
    { ...port, release: { repository: "owner/repo", provider: "gitlab" } },
  ]) {
    const result = collectDriftTargets(
      { ports: [unsupported] },
      listings,
      noShapes,
      [snapshot],
      source,
      now,
    );
    assert.deepEqual(result.baselineGaps.rows, []);
  }
});

void test("retains only the bounded first missing-baseline keys in stable order", () => {
  const ids = Array.from({ length: 1025 }, (_, index) => `port-${String(index).padStart(4, "0")}`);
  const selected = collectDriftTargets(
    { ports: ids.map((id) => ({ ...catalog.ports[0]!, id, adapter: "native-portable" })) },
    { listings: ids.map((id) => ({ id })) },
    { ...table, entries: [] },
    [...ids].reverse().map(observation),
    source,
    now,
  );
  assert.deepEqual(
    selected.baselineGaps.rows.map(({ port_id }) => port_id),
    ids.slice(0, 1024),
  );
  assert.equal(selected.baselineGaps.omitted, 1);
});

void test("a reviewed layout supplies an issue-free baseline only without a generated entry", () => {
  const [tableTarget, layoutTarget] = collectWithLayout();
  assert.deepEqual(tableTarget, collect([observation()])[0]);
  assert.ok(layoutTarget);
  assert.equal(layoutTarget.portId, "layout");
  assert.equal(Object.hasOwn(layoutTarget, "issue"), false);
  assert.equal(layoutTarget.baselineSource, "reviewed_layout");
  assert.equal(layoutTarget.derivationSha256, derivationInputsDigest(layoutPort, platform));
  const [, changed] = collectWithLayout({
    ...layoutPort,
    reviewed_package_layouts: { [platform]: { ...layout, directories: [] } },
  });
  assert.ok(changed);
  assert.equal(changed.derivationSha256, layoutTarget.derivationSha256);
  assert.notEqual(driftTargetKey(changed), driftTargetKey(layoutTarget));

  const generated = { ...table.entries[0]!, port_id: layoutPort.id };
  const [generatedTarget] = collectWithLayout(layoutPort, {
    ...table,
    entries: [...table.entries, generated],
  });
  assert.ok(generatedTarget);
  assert.equal(generatedTarget.portId, "layout");
  assert.equal(Object.hasOwn(generatedTarget, "baselineSource"), false);
  assert.equal(generatedTarget.derivationSha256, generated.derivation_inputs_sha256);
  assert.deepEqual(
    collectWithLayout(layoutPort, {
      ...table,
      entries: [...table.entries, { ...generated, derivation_inputs_sha256: "invalid" }],
    }),
    collect([observation()]),
  );
  assert.deepEqual(
    collectWithLayout({ ...layoutPort, adapter: "manual-setup" }),
    collect([observation()]),
  );
});

void test("Core must report the bound explicit layout and only its two known components", () => {
  const [, target] = collectWithLayout();
  assert.ok(target);
  const { baseline } = comparedLayout;
  const inspect = (verdict: unknown) =>
    inspectionFromResponse(coreResponse(target, verdict), target);
  const matched = inspect(comparedLayout);
  assert.equal(matched.status, "unknown");
  assert.equal(matched.layoutMatch, true);
  for (const part of ["programs", "top_directories"]) {
    const incomplete = inspect({ ...comparedLayout, unknown: [...comparedLayout.unknown, part] });
    assert.equal(incomplete.status, "unknown");
    assert.equal(incomplete.layoutMatch, undefined);
  }
  assert.deepEqual(
    inspect({ status: "drifted", baseline, changes: [{ component: "programs" }] }).components,
    ["programs"],
  );
  for (const verdict of [
    { status: "unknown", reason: "no_baseline" },
    { status: "compatible", baseline },
    { status: "drifted", baseline: { source: "generated" }, changes: [{ component: "programs" }] },
    { status: "drifted", baseline, changes: [{ component: "config_files" }] },
  ]) {
    assert.throws(() => inspect(verdict), /explicit reviewed layout/);
  }
});

void test("generated comparisons retain priority in the existing shared archive budget", async () => {
  const [generated, layoutTarget] = collectWithLayout();
  assert.ok(generated);
  assert.ok(layoutTarget);
  const full = { ...generated, asset: { ...generated.asset, size: 768 * 1024 * 1024 } };
  const second = { ...full, assetId: full.assetId + 1 };
  const partial = { ...layoutTarget, asset: { ...layoutTarget.asset, size: 512 * 1024 * 1024 } };
  const last = { ...partial, assetId: partial.assetId + 1 };
  const targets = [full, second, partial, last];
  const downloaded: string[] = [];
  const dependencies = {
    now: () => now,
    download: async (asset: DriftTarget["asset"]) => {
      downloaded.push(asset.name);
    },
    inspect: async (_archive: string, target: DriftTarget) =>
      inspectionFromResponse(
        coreResponse(target, target.baselineSource ? comparedLayout : { status: "compatible" }),
        target,
      ),
  };
  const result = await scanDriftTargets(targets, new Map(), now + 1, dependencies);
  assert.equal(downloaded.length, 3);
  assert.deepEqual(
    result.observations.map(({ target }) => target),
    [full, second, partial],
  );
  assert.deepEqual(result.unassessed, [{ target: last, reason: "inspection-budget" }]);
  assert.equal(result.attempted_bytes, 2 * full.asset.size + partial.asset.size);

  const inspector_sha256 = "a".repeat(64);
  const cache = { format: 1, inspector_sha256, observations: result.observations };
  const retained = completedInspections(cache, inspector_sha256);
  assert.equal(retained.get(driftTargetKey(partial))?.status, "unknown");
  assert.equal(retained.get(driftTargetKey(partial))?.layoutMatch, true);
  assert.equal(completedInspections(cache, "b".repeat(64)).size, 0);
  const repeated = await scanDriftTargets(targets, retained, now + 1, dependencies);
  assert.equal(downloaded.length, 4);
  assert.deepEqual(
    repeated.observations.map(({ target }) => target),
    targets,
  );
  assert.deepEqual(repeated.unassessed, []);
  assert.equal(repeated.attempted_bytes, last.asset.size);

  const updatedLayout = { ...partial, baselineSha256: "f".repeat(64) };
  const updated = await scanDriftTargets([updatedLayout], retained, now + 1, dependencies);
  assert.equal(updated.attempted_bytes, updatedLayout.asset.size);
  const report = { format: 1, run: source, ...repeated };
  assert.deepEqual(driftNotices(report, layoutListings, source), []);
});

void test("both drift queues continue after inspector bytes change", async () => {
  const [generated, layout] = collectWithLayout();
  assert.ok(generated && layout);
  const mib = 1024 * 1024;
  const make = (base: DriftTarget, portId: string, size: number) => ({
    ...base,
    portId,
    asset: { ...base.asset, size: size * mib },
  });
  const targets = [
    ...["f", "e", "d", "c"].map((id) => make(layout, id, 256)),
    ...["z", "y", "x"].map((id) => make(generated, id, 768)),
  ];
  const dependencies = {
    now: () => now,
    download: async () => {},
    inspect: async (_archive: string, target: DriftTarget) =>
      inspectionFromResponse(
        coreResponse(target, target.baselineSource ? comparedLayout : { status: "compatible" }),
        target,
      ),
  };
  const ids = (result: Awaited<ReturnType<typeof scanDriftTargets>>) =>
    result.observations.map(({ target }) => target.portId);
  const first = await scanDriftTargets(targets, new Map(), now + 1, dependencies);
  assert.deepEqual(ids(first), ["x", "y", "c", "d"]);
  assert.equal(first.attempted_bytes, 2 * 1024 * mib);
  const previous = {
    format: 1,
    inspector_sha256: "a".repeat(64),
    observations: first.observations,
    continuation: first.continuation,
  };
  assert.deepEqual(readDriftContinuation(previous), {
    generated: "z/windows-x86-64/stable",
    reviewed_layout: "e/windows-x86-64/stable",
  });
  assert.equal(completedInspections(previous, previous.inspector_sha256).size, 4);
  const secondCache = completedInspections(previous, "b".repeat(64));
  assert.equal(secondCache.size, 0);
  const second = await scanDriftTargets(
    targets.toReversed(),
    secondCache,
    now + 1,
    dependencies,
    readDriftContinuation(previous),
  );
  assert.deepEqual(ids(second), ["z", "x", "e", "f"]);
  assert.equal(second.attempted_bytes, first.attempted_bytes);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, targets.length);
});

void test("drift continuation survives missing routes and leaves failed archives retryable", async () => {
  const [generated] = collect([observation()]);
  assert.ok(generated);
  const targets = ["a", "c", "e", "z"].map((portId) => ({ ...generated, portId }));
  targets[3]!.asset = { ...generated.asset, size: 1024 * 1024 * 1024 };
  let clock = now;
  let attempted: string[] = [];
  const dependencies = {
    now: () => clock,
    download: async () => {},
    inspect: async (_archive: string, target: DriftTarget) => {
      attempted.push(target.portId);
      if (target.portId === "c") {
        clock = now + 1;
        throw new Error("transient Core failure");
      }
      return inspectionFromResponse(coreResponse(target, { status: "compatible" }), target);
    },
  };
  const previous = {
    format: 1,
    continuation: { generated: "b/windows-x86-64/stable", reviewed_layout: "x/invalid/stable" },
  };
  assert.deepEqual(readDriftContinuation(previous), { generated: "b/windows-x86-64/stable" });
  assert.deepEqual(readDriftContinuation({ format: 1, observations: [] }), {});
  const first = await scanDriftTargets(
    targets,
    new Map(),
    now + 1,
    dependencies,
    readDriftContinuation(previous),
  );
  assert.deepEqual(attempted, ["c"]);
  assert.deepEqual(
    first.unassessed.map(({ target, reason }) => [target.portId, reason]),
    [
      ["c", "core-inspection-failed"],
      ["e", "inspection-budget"],
      ["z", "inspection-budget"],
      ["a", "inspection-budget"],
    ],
  );
  assert.deepEqual(first.continuation, { generated: "e/windows-x86-64/stable" });
  clock = now;
  attempted = [];
  const second = await scanDriftTargets(
    targets,
    new Map(),
    now + 1,
    dependencies,
    first.continuation,
  );
  assert.deepEqual(attempted, ["e", "a", "c"]);
  assert.deepEqual(second.continuation, {});
});

void test("a handoff that omits both deferred routes preserves their positions", async () => {
  const [generated, layout] = collectWithLayout();
  assert.ok(generated && layout);
  const prior = {
    generated: "b/windows-x86-64/stable",
    reviewed_layout: "y/windows-x86-64/stable",
  };
  const a = { ...generated, portId: "a" };
  const b = { ...generated, portId: "b" };
  const x = { ...layout, portId: "x" };
  const y = { ...layout, portId: "y" };
  const dependencies = {
    now: () => now,
    download: async () => {},
    inspect: async (_archive: string, target: DriftTarget) =>
      inspectionFromResponse(
        coreResponse(target, target.baselineSource ? comparedLayout : { status: "compatible" }),
        target,
      ),
  };
  const intervening = await scanDriftTargets([x, a], new Map(), now + 1, dependencies, prior);
  assert.deepEqual(
    intervening.observations.map(({ target }) => target.portId),
    ["a", "x"],
  );
  assert.deepEqual(intervening.unassessed, []);
  assert.equal(intervening.attempted_bytes, a.asset.size + x.asset.size);
  const persisted = readDriftContinuation({ format: 1, continuation: intervening.continuation });
  assert.deepEqual(persisted, prior);

  const returned = await scanDriftTargets(
    [x, a, y, b],
    new Map(),
    now + 1,
    dependencies,
    persisted,
  );
  assert.deepEqual(
    returned.observations.map(({ target }) => target.portId),
    ["b", "a", "y", "x"],
  );
  assert.deepEqual(returned.unassessed, []);
  assert.deepEqual(returned.continuation, {});
});

void test("an unfit leading layout advances to another within-limit route", async () => {
  const [generated, layout] = collectWithLayout();
  assert.ok(generated && layout);
  const mib = 1024 * 1024;
  const targets = [
    ...["y", "z"].map((portId) => ({
      ...generated,
      portId,
      asset: { ...generated.asset, size: 768 * mib },
    })),
    ...(
      [
        ["a", 700],
        ["b", 1024],
        ["c", 100],
      ] as const
    ).map(([portId, size]) => ({
      ...layout,
      portId,
      asset: { ...layout.asset, size: size * mib },
    })),
  ];
  const result = await scanDriftTargets(
    targets,
    new Map(),
    now + 1,
    {
      now: () => now,
      download: async () => {},
      inspect: async (_archive, target) =>
        inspectionFromResponse(
          coreResponse(target, target.baselineSource ? comparedLayout : { status: "compatible" }),
          target,
        ),
    },
    { reviewed_layout: "z/windows-x86-64/stable" },
  );
  assert.deepEqual(
    result.observations.map(({ target }) => target.portId),
    ["y", "z", "c"],
  );
  assert.deepEqual(result.continuation, { reviewed_layout: "c/windows-x86-64/stable" });
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
  ).targets;
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
    /exact observer package inspection/,
  );
  assert.match(notices[0]?.body ?? "", /started by the schedule/u);
  const { event_name: _event, ...legacyReportRun } = source;
  assert.throws(
    () => driftNotices({ ...report, run: legacyReportRun }, listings, source),
    /exact observer package inspection/u,
  );
  for (const [event_name, name] of [
    ["workflow_dispatch", "a manual dispatch"],
    ["push", "a push to main"],
  ] as const) {
    const nextRun = { ...source, run_id: "43", event_name };
    assert.throws(
      () =>
        driftNotices({ ...report, run: nextRun }, listings, { ...nextRun, event_name: "schedule" }),
      /exact observer package inspection/u,
    );
    const [notice] = driftNotices({ ...report, run: nextRun }, listings, nextRun);
    assert.ok(notice);
    assert.ok(notice.body.includes(`started by ${name}.`));
    assert.equal(notice.identity, notices[0]?.identity);
  }
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
  const unknown = { ...cache.observations[0]!.inspection, status: "unknown" };
  assert.equal(
    completedInspections(
      { ...cache, observations: [{ key, inspection: unknown }] },
      inspector_sha256,
    ).size,
    0,
  );
});
