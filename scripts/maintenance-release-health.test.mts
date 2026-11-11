import assert from "node:assert/strict";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  attentionConditions,
  releaseHealthFacts,
  zipJsonEntry,
} from "./maintenance-release-health.mts";

const condition = (overrides: Record<string, unknown> = {}) => ({
  key: "k1",
  material_sha256: "m1",
  observation_contract_sha256: "c1",
  classification: "unclassified-or-actionable",
  accounted_for: false,
  port_id: "alpha",
  operation: "observe-availability",
  rule: "provider-redirect",
  provider: "github",
  location: "owner/alpha",
  release_ref: null,
  http_status: 301,
  first_seen: "2026-11-08T00:00:00.000Z",
  resume_condition: "Review the redirect.",
  occurrences: 7,
  observed_at: "2026-11-11T17:15:46.042Z",
  notify: false,
  retry_at: null,
  ...overrides,
});

const report = (conditions: unknown[], stale: string[] = []) => ({
  format_version: 1,
  authority: "upstream-monitoring-only; no acquisition, artifact, lineage or publication authority",
  inventory: {
    total_ports: 2 + stale.length,
    fresh_complete_port_ids: ["alpha", "beta"],
    fresh_partial_port_ids: [],
    stale_port_ids: stale,
    unmonitored_port_ids: [],
  },
  known_conditions: conditions,
});

void test("release-health facts keep stable condition facts and report coverage gaps", () => {
  const first = releaseHealthFacts(report([condition()]));
  assert.equal(first.expected, 2);
  assert.deepEqual(first.gaps, []);
  assert.deepEqual([...first.facts.keys()], ["port:alpha", "port:beta"]);
  const alpha = first.facts.get("port:alpha") as { conditions: Record<string, unknown>[] };
  assert.equal(alpha.conditions[0]?.rule, "provider-redirect");
  assert.equal(
    "occurrences" in (alpha.conditions[0] ?? {}),
    false,
    "recurrence counts are not facts",
  );
  assert.equal("observed_at" in (alpha.conditions[0] ?? {}), false);
  // A routine recurrence of the same condition is the same fact.
  const later = releaseHealthFacts(
    report([condition({ occurrences: 8, observed_at: "2026-11-12T17:15:46.042Z" })]),
  );
  assert.deepEqual(later.facts.get("port:alpha"), first.facts.get("port:alpha"));
  const stale = releaseHealthFacts(report([], ["gamma"]));
  assert.deepEqual(
    stale.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [["port:gamma", "stale"]],
  );
  assert.throws(
    () => releaseHealthFacts({ ...report([]), authority: "release-publication" }),
    /Unsupported release-health report/u,
  );
});

void test("artifact reports are read from a bounded, integrity-checked archive", () => {
  const archive = createAuditZip([
    ["report.json", JSON.stringify({ format_version: 1 })],
    ["summary.md", "summary"],
  ]);
  assert.deepEqual(zipJsonEntry(archive, "report.json"), { format_version: 1 });
  assert.throws(
    () => zipJsonEntry(createAuditZip([["other.json", "{}"]]), "report.json"),
    /ZIP rejected|no report\.json/u,
  );
  const corrupt = Buffer.from(archive);
  corrupt[40] = corrupt[40]! ^ 0xff;
  assert.throws(() => zipJsonEntry(corrupt, "report.json"));
});

void test("needs-attention follows the maintained monitor triage", () => {
  const visible = (overrides: Record<string, unknown>) =>
    attentionConditions({ conditions: [condition(overrides)] }).length === 1;
  assert.equal(
    visible({ classification: "provider-reported-pin-present", accounted_for: false }),
    true,
  );
  assert.equal(
    visible({ classification: "provider-reported-pin-present", accounted_for: true }),
    false,
  );
  assert.equal(
    visible({ classification: "unclassified-or-actionable", accounted_for: true }),
    true,
  );
  assert.equal(
    visible({ classification: "catalog-declared-unavailable-original", accounted_for: false }),
    true,
  );
  assert.deepEqual(attentionConditions(null), []);
});

void test("a report whose port lists are not a partition is unsupported", () => {
  const overlapping = report([]);
  overlapping.inventory.stale_port_ids = ["alpha"];
  overlapping.inventory.total_ports = 3;
  assert.throws(() => releaseHealthFacts(overlapping), /not a partition/u);
  const short = report([]);
  short.inventory.total_ports = 5;
  assert.throws(() => releaseHealthFacts(short), /not a partition/u);
});
