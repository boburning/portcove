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
  releases: releases.map(([version, published_at, digests]) => ({
    version,
    published_at,
    assets: digests.map((sha256, index) => ({ name: `${version}-${index}.zip`, sha256 })),
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
    by_flag: { satisfied: 0, unknown: 0, "not-satisfied": 0, manual: 0 },
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

void test("a successor release is judged against the versions the port's restrictions scope", () => {
  const artifacts = [{ version: "v1", sha256: sha("c") }];
  const scoped = port("a", [
    hold("download", ["reviewed-successor-release"]),
    { id: "reviewed", effect: "permit", operations: ["download"], scope: { artifacts } },
  ]);
  const observed = (...versions: string[]) => ({
    listings: [
      {
        id: "a",
        upstream_observation: observation(
          ...versions.map((version) => [version, null, [null]] as [string, null, null[]]),
        ),
      },
    ],
  });
  assert.equal(
    conditionsOf({ records: [scoped], observerReport: observed("v1") })[
      "reviewed-successor-release"
    ],
    "not-satisfied",
  );
  assert.equal(
    conditionsOf({ records: [scoped], observerReport: observed("v2", "v1") })[
      "reviewed-successor-release"
    ],
    "satisfied",
  );
  const unscoped = port("a", [hold("download", ["reviewed-successor-release"])]);
  assert.equal(
    conditionsOf({ records: [unscoped], observerReport: observed("v2") })[
      "reviewed-successor-release"
    ],
    "unknown",
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

void test("a row flags its strongest condition and managed holds are included", () => {
  const records = [
    port("a", [hold("download", ["owner-review", "attributable-grant"])], {}, [
      {
        id: "acquisition",
        effect: "hold",
        operations: ["install"],
        reason: "upstream-transition-unreviewed",
        explanation: "Held.",
        reconsider_when: ["upstream-route-change"],
      },
    ]),
  ];
  const result = report({
    records,
    evidence: evidence({
      port_id: "a",
      grant: { recorded: true, reference: "https://example.invalid/grant" },
    }),
  });
  assert.deepEqual(
    result.rows.map((row) => [row.carrier, row.restriction_id, row.flag]),
    [
      ["listing", "download", "satisfied"],
      ["managed", "acquisition", "unknown"],
    ],
  );
  assert.equal(result.summary.holds, 2);
  assert.match(renderRestrictionRecheck(result), /satisfied: a listing\/download/u);
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
