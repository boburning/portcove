import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderMaintenancePublicSummary } from "./maintenance-public-summary.mts";

const generated = "2026-11-20T00:00:00.000Z";
const digest = "a".repeat(64);
const revision = `upstream-observer-run:123-1@${"b".repeat(40)}#sha256:${"c".repeat(64)}`;
const privateInput = "https://private.invalid/journal?credential=raw-data";
function report() {
  return {
    format: "portcove-maintenance-inventory",
    format_version: 1,
    generated_at: generated,
    subjects: [{ raw: privateInput }],
    handoffs: [{ journal: privateInput }],
    runs: [
      { source: "catalog-records", coverage: "complete", observed_count: 100 },
      {
        source: "upstream-observations",
        coverage: "partial",
        observed_count: 97,
        expected_count: 100,
        source_revision: revision,
        gaps: [
          { code: "held", subject_key: privateInput },
          { code: "unobserved" },
          { code: privateInput },
        ],
      },
    ],
    freshness: [{ source: "upstream-observations", last_good_at: "2026-11-19T23:00:00+00:00" }],
    managed_route_observation_coverage: {
      catalog_collection_complete: true,
      target_scope_known: true,
      observer_membership_verified: true,
      operational_definitions: 7,
      offered_managed_platforms: 9,
      offered_following_platforms: 8,
      fixed_managed_platforms: 1,
      platforms_with_candidate_observed: 6,
      platforms_with_retained_candidate: 8,
      routes: [{ port_key: privateInput }],
    },
    managed_release_eligibility: {
      from: "2026-10-21T00:00:00.000Z",
      through: generated,
      first_recorded_evidence_at: "2026-11-18T00:00:00Z",
      last_recorded_evidence_at: "2026-11-19T00:00:00Z",
      distinct_candidates: 10,
      eligible_candidates: 8,
      pending_candidates: 2,
      pending_without_recorded_hold_reason: 1,
      oldest_pending_age_ms: 7_200_000,
      observed_pending_candidates: 4,
      observed_pending_to_eligible_candidates: 2,
      publication_to_recorded_eligibility_ms: { median: 3_600_000.5, max: 7_200_000, samples: 7 },
      pending_with_other_recorded_hold_reason: 1,
      hold_reasons: [
        { reason: "asset-missing-or-ambiguous", distinct_candidates: 1 },
        { reason: "reviewed-artifact-excluded", distinct_candidates: 1 },
        { reason: privateInput, distinct_candidates: 1 },
        { reason: "another-private-reason", distinct_candidates: 1 },
      ],
      released_client_unattended_availability: 1,
      human_interventions: 0,
      signed_automatic_repairs: 5,
    },
  };
}
const usage = {
  format_version: 1,
  kind: "maintenance-observer-operating-usage",
  scope: "one-imported-observer-attempt",
  inventory_sha256: digest,
  source_revision: revision,
  observed_runner_seconds: 35.5,
  unmeasured_jobs: 1,
  checkpoint: { bytes: 2450, url: privateInput },
  executed_jobs: [{ name: privateInput }],
  billed_cost_usd: 0,
};

void test("public management summary emits only explicit counts, time windows and evidence limits", () => {
  const summary = renderMaintenancePublicSummary(report(), usage, digest);
  assert.match(summary, /100 listings and 7 operational definitions/);
  assert.match(summary, /6 of 8 following offers.*2 lack that evidence\. 8 have retained/);
  assert.match(summary, /97 of 100.*aged 1\.0 h.*1 held, 1 unobserved.*1 other/);
  assert.match(
    summary,
    /maintenance collection was 2026-11-19T23:00:00\.000Z.*Actual observer execution age is unknown/,
  );
  assert.match(summary, /2026-11-18T00:00:00\.000Z to 2026-11-19/);
  assert.match(summary, /8 eligible of 10 distinct managed candidates/);
  assert.match(
    summary,
    /1 pending candidates have a recorded reason and 1 lack one.*2\.0 h.*2 of 4/,
  );
  assert.match(summary, /median of 1\.0 h, a maximum of 2\.0 h, and 7 samples/);
  assert.match(
    summary,
    /1 asset missing or ambiguous, 1 excluded by reviewed artifact policy, and 1 with other reasons\. One candidate can appear in more than one reason category/,
  );
  assert.match(summary, /35\.5 measured runner seconds.*1 jobs.*2450 checkpoint bytes/);
  assert.match(summary, /Fleet resource use and billed cost are unknown/);
  assert.match(summary, /Released-client availability and release-to-availability lag are unknown/);
  assert.doesNotMatch(summary, /https?:|private|journal|credential|upstream-observer-run/u);
});

void test("public summary uses only the bound observation completion for its age", () => {
  const boundUsage = { ...usage, observation_finished_at: "2026-11-19T20:30:00Z" };
  assert.match(
    renderMaintenancePublicSummary(report(), boundUsage, digest),
    /imported observation job finished at 2026-11-19T20:30:00\.000Z, aged 3\.5 h/u,
  );
  for (const observation_finished_at of ["tomorrow", "2026-11-21T00:00:00Z"]) {
    assert.match(
      renderMaintenancePublicSummary(report(), { ...boundUsage, observation_finished_at }, digest),
      /Actual observer execution age is unknown/u,
    );
  }
  assert.match(
    renderMaintenancePublicSummary(report(), boundUsage, "0".repeat(64)),
    /Actual observer execution age is unknown/u,
  );
});

void test("public management summary preserves unknown quiet windows, failed coverage and unbound usage", () => {
  const input = report();
  const rollup = input.managed_release_eligibility;
  rollup.first_recorded_evidence_at = "";
  rollup.last_recorded_evidence_at = "";
  input.runs[1]!.coverage = "failed";
  input.managed_route_observation_coverage.observer_membership_verified = false;
  const summary = renderMaintenancePublicSummary(input, usage, digest);
  assert.match(summary, /Exact candidate coverage is unknown/);
  assert.match(summary, /collection is failed\. Subject coverage is unknown/);
  assert.match(summary, /Observer eligibility is unknown/);
  assert.match(summary, /unknown measured runner seconds/);
  assert.doesNotMatch(summary, /35\.5|2450|8 eligible|97 of 100/u);
  const other = renderMaintenancePublicSummary(report(), usage, "d".repeat(64));
  assert.match(other, /unknown measured runner seconds/);
  assert.match(other, /8 eligible of 10/);
});

void test("older hold-reason counts only admit a known other-candidate union", () => {
  const input = report();
  const { pending_with_other_recorded_hold_reason: _union, ...older } =
    input.managed_release_eligibility;
  assert.match(
    renderMaintenancePublicSummary({ ...input, managed_release_eligibility: older }, usage, digest),
    /and unknown with other reasons/,
  );
  older.hold_reasons.pop();
  assert.match(
    renderMaintenancePublicSummary({ ...input, managed_release_eligibility: older }, usage, digest),
    /and 1 with other reasons/,
  );
  older.hold_reasons.push(older.hold_reasons[0]!);
  assert.match(
    renderMaintenancePublicSummary({ ...input, managed_release_eligibility: older }, usage, digest),
    /Distinct pending candidates by reason are unknown/,
  );
});

void test("public summary command fails without exposing a malformed report", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "maintenance-public-summary-"));
  try {
    const input = path.join(directory, "inventory.json");
    writeFileSync(input, `!${privateInput}`);
    const result = spawnSync(process.execPath, ["scripts/maintenance-public-summary.mts", input], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "Public maintenance summary inventory could not be read");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("open handoffs count current operations and keep incomplete evidence unknown", () => {
  const summary = (handoffs: unknown) =>
    renderMaintenancePublicSummary({ ...report(), handoffs }, usage, digest);
  const row = (id: string, operation: unknown) => ({
    subject_key: `handoff:${id}`,
    sequence: 1,
    assessment_id: 9,
    updated_at: "2026-11-19T18:00:00.000001+00:00",
    operation,
  });
  const op = {
    operation_id: privateInput,
    executor: privateInput,
    fence_sequence: 1,
    fence_assessment_id: 9,
    revision: 2,
    state: "planned",
  };
  const rows = [
    row("a", null),
    row("b", op),
    row("c", { ...op, state: "dispatched" }),
    row("d", { ...op, state: "ambiguous" }),
    row("e", { ...op, fence_sequence: 2 }),
    row("f", { ...op, fence_assessment_id: null }),
  ];
  const rendered = summary(rows);
  assert.match(
    rendered,
    /6 open maintenance handoffs: 1 without an open operation, 1 planned, 1 dispatched, 1 ambiguous, and 2 with an operation/,
  );
  assert.match(rendered, /updated 6.0 h ago/);
  assert.doesNotMatch(rendered, /private.invalid/);
  assert.match(summary([]), /0 open maintenance handoffs/);
  for (const invalid of [
    undefined,
    [...rows, rows[0]],
    [row("bad", {})],
    [row("bad", { ...op, state: "complete" })],
    [{ ...row("future", null), updated_at: "2026-12-01T00:00:00Z" }],
  ]) {
    assert.match(summary(invalid), /Open maintenance handoff counts are unknown/);
  }
});
