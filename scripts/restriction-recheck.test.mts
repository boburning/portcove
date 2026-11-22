import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  main,
  manualConditions,
  renderRestrictionRecheck,
  restrictionRecheckReport,
  type RecheckInputs,
} from "./restriction-recheck.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

function port(
  id: string,
  restrictions: Record<string, unknown>[],
  fields: Record<string, unknown> = {},
  integration?: Record<string, unknown>[],
): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      name: `Name ${id}`,
      summary: "Summary.",
      project_url: `https://github.com/owner/${id}`,
      release_url: `https://github.com/owner/${id}/releases`,
      restrictions,
      ...fields,
    },
    ...(integration ? { integration: { acquisition_restrictions: integration } } : {}),
  } as unknown as AuthoredPort;
}
const hold = (id: string, reconsider_when?: string[], scope?: Record<string, unknown>) => ({
  id,
  effect: "hold",
  operations: ["download"],
  reason: "bundled-game-data",
  explanation: "Held.",
  ...(reconsider_when ? { reconsider_when } : {}),
  ...(scope ? { scope } : {}),
});
const sha = (digit: string) => digit.repeat(64);
const observation = (...releases: [string, string | null, (string | null)[]][]) => ({
  status: "complete",
  facts_sha256: sha("f"),
  releases: releases.map(([version, published_at, digests]) => ({
    version,
    published_at,
    assets: digests.map((sha256, index) => ({
      name: `${version}-${index}.zip`,
      sha256,
      platform_hints: [index % 2 ? "linux-x86-64" : "windows-x86-64"],
    })),
  })),
});
const evidence = (...subjects: Record<string, unknown>[]) => ({ format_version: 1, subjects });
const report = (inputs: RecheckInputs) => restrictionRecheckReport(inputs);
const conditionsOf = (inputs: RecheckInputs, id = "a") =>
  Object.fromEntries(
    report(inputs)
      .rows.filter((row) => row.port_id === id)
      .flatMap((row) => row.conditions.map((entry) => [entry.condition, entry.status])),
  );

void test("holds without conditions are counted and never flagged", () => {
  const result = report({ records: [port("a", [hold("download")])] });
  assert.deepEqual(result.summary, {
    holds: 1,
    holds_with_conditions: 0,
    holds_without_conditions: 1,
    by_flag: { manual: 0, satisfied: 0, unknown: 0, "not-satisfied": 0 },
    observer_report: "absent",
    evidence: "absent",
  });
  assert.deepEqual(result.flagged, []);
});

void test("missing evidence is unknown, never satisfied", () => {
  const conditions = [
    "publisher-checksum",
    "reviewed-successor-release",
    "clean-upstream-package",
    "attributable-grant",
    "upstream-route-change",
  ];
  const result = report({ records: [port("a", [hold("download", conditions)])] });
  assert.equal(result.rows[0]?.flag, "unknown");
  assert.ok(result.rows[0]?.conditions.every((entry) => entry.status === "unknown"));
  assert.equal(result.flagged.length, 1);
});

void test("manual conditions are reported but not flagged", () => {
  const result = report({ records: [port("a", [hold("download", [...manualConditions])])] });
  assert.equal(result.rows[0]?.flag, "manual");
  assert.equal(result.rows[0]?.machine, null);
  assert.deepEqual(result.flagged, []);
  assert.equal(result.summary.by_flag.manual, 1);
});

void test("a publisher checksum is satisfied only when every newest asset has a digest", () => {
  const records = [port("a", [hold("download", ["publisher-checksum"])])];
  const listings = (digests: (string | null)[]) => ({
    listings: [
      {
        id: "a",
        upstream_observation: observation(
          ["v2", "2026-11-20T00:00:00Z", digests],
          ["v1", "2026-10-01T00:00:00Z", [null]],
        ),
      },
    ],
  });
  assert.equal(
    conditionsOf({ records, observerReport: listings([sha("a"), sha("b")]) })["publisher-checksum"],
    "satisfied",
  );
  assert.equal(
    conditionsOf({ records, observerReport: listings([sha("a"), null]) })["publisher-checksum"],
    "not-satisfied",
  );
  assert.equal(
    conditionsOf({ records, observerReport: listings([]) })["publisher-checksum"],
    "unknown",
  );
});

void test("an incomplete observation is not evidence", () => {
  const records = [port("a", [hold("download", ["publisher-checksum"])])];
  const observerReport = [
    {
      listing_update: {
        id: "a",
        upstream_observation: { ...observation(["v1", null, [sha("a")]]), status: "incomplete" },
      },
    },
  ];
  assert.equal(conditionsOf({ records, observerReport })["publisher-checksum"], "unknown");
});

void test("a successor release must be newer than the newest scoped release", () => {
  const artifacts = [{ version: "v4", sha256: sha("c") }];
  const scoped = port("a", [
    hold("download", ["reviewed-successor-release"]),
    { id: "reviewed", effect: "permit", operations: ["download"], scope: { artifacts } },
  ]);
  const status = (...releases: [string, string | null][]) =>
    conditionsOf({
      records: [scoped],
      observerReport: {
        listings: [
          {
            id: "a",
            upstream_observation: observation(
              ...releases.map(
                ([version, at]) => [version, at, [null]] as [string, string | null, null[]],
              ),
            ),
          },
        ],
      },
    })["reviewed-successor-release"];
  const reviewed: [string, string] = ["v4", "2026-06-01T00:00:00Z"];
  assert.equal(status(reviewed), "not-satisfied");
  // An older unscoped release is not a successor.
  assert.equal(status(reviewed, ["v3.6", "2026-01-01T00:00:00Z"]), "not-satisfied");
  // Nor is one published at the same time.
  assert.equal(status(reviewed, ["v4-hotfix", "2026-06-01T00:00:00Z"]), "not-satisfied");
  assert.equal(status(["v5", "2026-07-01T00:00:00Z"], reviewed), "satisfied");
  // Undated releases are never a successor and never cleared as older.
  assert.equal(status(reviewed, ["v5", null]), "unknown");
  assert.equal(status(["v4", null], ["v5", "2026-07-01T00:00:00Z"]), "unknown");
  // A scoped version the observation no longer lists gives no baseline.
  assert.equal(status(["v5", "2026-07-01T00:00:00Z"]), "unknown");
  // A newer dated release still wins over an undated one.
  assert.equal(status(reviewed, ["v5", null], ["v6", "2026-08-01T00:00:00Z"]), "satisfied");
  const platformOnly = port("a", [
    hold("download", ["reviewed-successor-release"], { platforms: ["windows-x86-64"] }),
  ]);
  const unscopedResult = report({
    records: [platformOnly],
    observerReport: {
      listings: [{ id: "a", upstream_observation: observation(["v2", null, [null]]) }],
    },
  }).rows[0]!.conditions[0]!;
  assert.equal(unscopedResult.status, "unknown");
  assert.match(unscopedResult.detail, /no reviewed baseline/u);
});

void test("a complete observation needs bound facts and the row names its digest", () => {
  const records = [port("a", [hold("download", ["publisher-checksum"])])];
  const bound = observation(["v1", null, [sha("a")]]);
  const reported = (upstream_observation: unknown) =>
    report({ records, observerReport: { listings: [{ id: "a", upstream_observation }] } }).rows[0]!;
  assert.equal(reported(bound).machine, "satisfied");
  assert.equal(reported(bound).observation_facts_sha256, sha("f"));
  const { facts_sha256: _digest, ...unbound } = bound;
  assert.equal(reported(unbound).machine, "unknown");
  assert.equal(reported(unbound).observation_facts_sha256, null);
  assert.equal(reported({ ...bound, facts_sha256: "short" }).machine, "unknown");
  // An entry without an observation keeps the committed one.
  const committed = [
    port("a", [hold("download", ["publisher-checksum"])], { upstream_observation: bound }),
  ];
  assert.equal(
    report({ records: committed, observerReport: { listings: [{ id: "a" }] } }).rows[0]!.machine,
    "satisfied",
  );
});

void test("evidence decides content scans, grants and route changes", () => {
  const records = [
    port("a", [
      hold("download", ["clean-upstream-package", "attributable-grant", "upstream-route-change"]),
    ]),
  ];
  const observerReport = {
    listings: [{ id: "a", upstream_observation: observation(["v3", null, [null]]) }],
  };
  const clean = evidence({
    port_id: "a",
    content_scan: [
      { version: "v2", findings: 4 },
      { version: "v3", findings: 0 },
    ],
    grant: { recorded: false, reference: "https://example.invalid/grant" },
    route_changed: { changed: true, reference: "https://example.invalid/route" },
  });
  assert.deepEqual(conditionsOf({ records, observerReport, evidence: clean }), {
    "clean-upstream-package": "satisfied",
    "attributable-grant": "not-satisfied",
    "upstream-route-change": "satisfied",
  });
  const dirty = evidence({ port_id: "a", content_scan: [{ version: "v3", findings: 2 }] });
  assert.equal(
    conditionsOf({ records, observerReport, evidence: dirty })["clean-upstream-package"],
    "not-satisfied",
  );
  // A scan of an older release says nothing about the newest one.
  const stale = evidence({ port_id: "a", content_scan: [{ version: "v2", findings: 0 }] });
  assert.equal(
    conditionsOf({ records, observerReport, evidence: stale })["clean-upstream-package"],
    "unknown",
  );
});

void test("content scans are keyed by version and asset digest or platform", () => {
  const records = [port("a", [hold("download", ["clean-upstream-package"])])];
  const observerReport = {
    listings: [{ id: "a", upstream_observation: observation(["v3", null, [sha("a"), sha("b")]]) }],
  };
  const status = (...content_scan: Record<string, unknown>[]) =>
    conditionsOf({ records, observerReport, evidence: evidence({ port_id: "a", content_scan }) })[
      "clean-upstream-package"
    ];
  // One asset scanned clean leaves the other unknown.
  assert.equal(status({ version: "v3", findings: 0, asset_sha256: sha("a") }), "unknown");
  assert.equal(
    status(
      { version: "v3", findings: 0, asset_sha256: sha("a") },
      { version: "v3", findings: 0, platform: "linux-x86-64" },
    ),
    "satisfied",
  );
  assert.equal(
    status(
      { version: "v3", findings: 0, asset_sha256: sha("a") },
      { version: "v3", findings: 1, asset_sha256: sha("b") },
    ),
    "not-satisfied",
  );
  // A digest that is not in the newest release covers nothing.
  assert.equal(status({ version: "v3", findings: 0, asset_sha256: sha("9") }), "unknown");
  assert.equal(status({ version: "v3", findings: 0, platform: "macos-aarch64" }), "unknown");
  assert.throws(
    () => status({ version: "v3", findings: 0, platform: "linux-x86-64", asset_sha256: sha("a") }),
    /at most one of platform/u,
  );
  assert.throws(
    () => status({ version: "v3", findings: 0, asset_sha256: "A".repeat(64) }),
    /lowercase/u,
  );
});

void test("any manual condition flags the row for the owner whatever else it says", () => {
  const artifacts = [{ version: "v1", sha256: sha("c") }];
  const records = [
    port(
      "a",
      [
        hold("download", ["reviewed-successor-release", "owner-review"]),
        { id: "reviewed", effect: "permit", operations: ["download"], scope: { artifacts } },
      ],
      {},
      [
        {
          id: "acquisition",
          effect: "hold",
          operations: ["install"],
          reason: "upstream-transition-unreviewed",
          explanation: "Held.",
          reconsider_when: ["upstream-route-change"],
        },
      ],
    ),
  ];
  const result = report({
    records,
    observerReport: {
      listings: [
        {
          id: "a",
          upstream_observation: observation(
            ["v2", "2026-11-20T00:00:00Z", [null]],
            ["v1", "2026-10-01T00:00:00Z", [null]],
          ),
        },
      ],
    },
  });
  assert.deepEqual(
    result.rows.map((row) => [row.carrier, row.restriction_id, row.flag, row.machine]),
    [
      ["listing", "download", "manual", "satisfied"],
      ["managed", "acquisition", "unknown", "unknown"],
    ],
  );
  assert.equal(result.summary.holds, 2);
  assert.deepEqual(result.summary.by_flag, {
    manual: 1,
    satisfied: 0,
    unknown: 1,
    "not-satisfied": 0,
  });
  assert.equal(result.flagged.length, 2);
  assert.match(
    renderRestrictionRecheck(result),
    /manual \(owner; machine satisfied\): a listing\/download/u,
  );
});

void test("malformed or foreign inputs are refused", () => {
  const records = [port("a", [hold("download", ["attributable-grant"])])];
  assert.throws(() => report({ records, evidence: { subjects: [] } }), /format_version 1/u);
  assert.throws(
    () => report({ records, evidence: evidence({ port_id: "unknown" }) }),
    /not a catalog identity/u,
  );
  assert.throws(
    () => report({ records, evidence: evidence({ port_id: "a" }, { port_id: "a" }) }),
    /repeats a/u,
  );
  assert.throws(
    () => report({ records, evidence: evidence({ port_id: "a", grant: { recorded: true } }) }),
    /reference/u,
  );
  assert.throws(
    () => report({ records, observerReport: { listings: [{ id: "b" }] } }),
    /not a catalog identity/u,
  );
  assert.throws(() => report({ records: [records[0]!, records[0]!] }), /unique/u);
});

void test("the committed catalog reports deterministically through the command line", () => {
  const first = main(["--json"], root);
  assert.equal(main(["--json"], root), first);
  const parsed = JSON.parse(first) as ReturnType<typeof restrictionRecheckReport>;
  const { records } = readCatalogSource(join(root, "crates/portcove-core/catalog"));
  const holds = records.flatMap((record) =>
    [
      ...((record.listing as { restrictions?: { effect: string }[] }).restrictions ?? []),
      ...((record.integration as { acquisition_restrictions?: { effect: string }[] } | undefined)
        ?.acquisition_restrictions ?? []),
    ].filter((restriction) => restriction.effect === "hold"),
  );
  assert.equal(parsed.summary.holds, holds.length);
  assert.equal(
    parsed.summary.holds_with_conditions + parsed.summary.holds_without_conditions,
    holds.length,
  );
  assert.match(main([], root), /^Restriction recheck: /u);
  const directory = mkdtempSync(join(tmpdir(), "restriction-recheck-"));
  try {
    const output = join(directory, "report.json");
    const evidenceFile = join(directory, "evidence.json");
    writeFileSync(evidenceFile, JSON.stringify(evidence()));
    main(["--output", output, "--evidence", evidenceFile], root);
    const written = JSON.parse(readFileSync(output, "utf8")) as { summary: { evidence: string } };
    assert.equal(written.summary.evidence, "applied");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(() => main(["--evidence"], root), /Usage/u);
  assert.throws(() => main(["--write"], root), /Usage/u);
});
