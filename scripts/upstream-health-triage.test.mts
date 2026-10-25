import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHealthConditions,
  conditionEvidence,
  observedSpan,
  type HealthTriageCondition,
} from "./upstream-health-triage.mts";

function incident(overrides: Partial<HealthTriageCondition> = {}): HealthTriageCondition {
  return {
    port_id: "game-one",
    provider: "github",
    location: "owner/repo",
    release_ref: null,
    rule: "provider-redirect",
    classification: "provider-reported-pin-present",
    accounted_for: true,
    changed_in_this_run: false,
    observed_this_run: false,
    freshness: "fresh",
    latest_collection_status: "complete",
    first_seen: "2026-10-22T01:00:00.000Z",
    observed_at: "2026-10-24T03:00:00.000Z",
    occurrences: 3,
    retry_at: null,
    resume_condition: null,
    ...overrides,
  };
}

void test("routine provider metadata is quiet only with complete fresh accounting", () => {
  const routine = incident();
  const changed = incident({ port_id: "changed", changed_in_this_run: true });
  const stale = incident({ port_id: "stale", freshness: "stale" });
  const partial = incident({ port_id: "partial", latest_collection_status: "partial" });
  const unaccounted = incident({ port_id: "unknown", accounted_for: false });
  const grouped = classifyHealthConditions([routine, changed, stale, partial, unaccounted]);
  assert.deepEqual(grouped.routine, [routine]);
  assert.deepEqual(
    grouped.ordered.map((i) => i.port_id),
    ["changed", "unknown", "stale", "partial"],
  );
  assert.equal(grouped.stale, 1);
  assert.equal(grouped.partial, 1);
  assert.equal(grouped.retained, 4);
  assert.equal(grouped.changed.length, 1);
  assert.equal(grouped.continuing.length, 3);
});

void test("inconclusive, stale, and retained evidence never claims recovery", () => {
  assert.match(
    conditionEvidence(incident({ freshness: "stale", accounted_for: true })),
    /Stale history/u,
  );
  assert.match(
    conditionEvidence(incident({ latest_collection_status: "partial" })),
    /Partial collection/u,
  );
  assert.match(conditionEvidence(incident()), /not checked in this run/u);
  assert.match(conditionEvidence(incident({ observed_this_run: true })), /bytes unverified/u);
  assert.match(
    conditionEvidence(incident({ observed_this_run: true, classification: "reviewed-condition" })),
    /operation safety unassessed/u,
  );
  assert.match(
    conditionEvidence(incident({ observed_this_run: true, accounted_for: false })),
    /Unaccounted/u,
  );
});

void test("observed span is bounded to actual observations and is not uninterrupted downtime", () => {
  const i = incident();
  assert.equal(observedSpan(i), "2d 2h");
  assert.equal(observedSpan({ first_seen: i.observed_at, observed_at: i.first_seen }), "unknown");
  assert.equal(observedSpan({ first_seen: "bad", observed_at: i.observed_at }), "unknown");
  assert.equal(observedSpan({ first_seen: i.first_seen, observed_at: i.first_seen }), "0h");
});

void test("unrelated conditions are not mutated, deduplicated, or treated as proven holds", () => {
  const continuing = Object.freeze(
    incident({ port_id: "other", accounted_for: false, occurrences: 8 }),
  );
  const current = Object.freeze(
    incident({ port_id: "game-one", observed_this_run: true, changed_in_this_run: true }),
  );
  const grouped = classifyHealthConditions([continuing, current]);
  assert.equal(grouped.ordered.length, 2);
  assert.equal(grouped.ordered[0], current);
  assert.equal(grouped.ordered[1], continuing);
  assert.equal(grouped.ordered[1]?.occurrences, 8);
  assert.equal(grouped.retained, 1);
});

void test("each evidence row preserves coverage, freshness, and collection independently", () => {
  for (const observed_this_run of [false, true]) {
    for (const freshness of ["fresh", "stale"] as const) {
      for (const latest_collection_status of ["complete", "partial"] as const) {
        const evidence = conditionEvidence(
          incident({ observed_this_run, freshness, latest_collection_status }),
        );
        assert.match(
          evidence,
          observed_this_run ? /Observed this run/u : /Retained history; not checked in this run/u,
        );
        assert.match(evidence, freshness === "stale" ? /Stale history/u : /Fresh observation/u);
        assert.match(
          evidence,
          latest_collection_status === "partial"
            ? /Partial collection; outcome not established/u
            : /Complete collection/u,
        );
      }
    }
  }
});
