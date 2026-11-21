import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256 } from "./maintenance-inventory.mts";
import {
  encodeManagedInterventionEvidence,
  readManagedInterventionEvidence,
  scopedManagedInterventions,
} from "./maintenance-interventions.mts";
import {
  managedReleaseEligibilityWindow,
  readObserverOperatingUsage,
  readUpstreamObservations,
  upstreamAttention,
  upstreamFacts,
  upstreamObservation,
  upstreamSummary,
  type UpstreamTransport,
} from "./maintenance-upstream.mts";
import { newCatalogObserverCheckpoint } from "./catalog-upstream-observer.mts";
import { encodeStreamingObserverSnapshot, snapshotName } from "./observer-checkpoint-artifact.mts";
import { encodeStoredObserverCheckpoint } from "./observer-checkpoint-storage.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  catalog,
  checkpoint,
  exception,
  facts,
  keyOf,
  progress,
  scope,
} from "./fixtures/upstream-checkpoint-fixture.mts";

const now = Date.parse("2026-11-11T00:00:00.000Z");

const witnessStart = "2026-11-02T00:00:00.000Z";
const witnessEnd = "2026-11-03T00:00:00.000Z";
const action = {
  id: "f".repeat(64),
  evidence_sha256: "e".repeat(64),
  witnessed_at: "2026-11-02T20:00:00.000Z",
};
const witness = (id: string, coverage = "complete", actions: (typeof action)[] = []) => ({
  candidate_key: id.repeat(64),
  port_key: `port:${id}`,
  platform: "windows-x86-64",
  channel: "stable",
  observer_revision: `upstream-observer-run:42-1@${"1".repeat(40)}#sha256:${"2".repeat(64)}`,
  definition_sha256: "3".repeat(64),
  client_sha256: "4".repeat(64),
  review_ref: "https://github.com/boburning/portcove/issues/246#issuecomment-8",
  start: witnessStart,
  end: witnessEnd,
  coverage,
  actions,
});
const witnessObservation = (sequence: ReturnType<typeof witness>) => ({
  ...sequence,
  state: "pending",
  recorded_at: "2026-11-02 19:00:00+00",
});

function reportWitnesses(sequences: ReturnType<typeof witness>[], rows: readonly unknown[]) {
  const { bytes, sha256 } = encodeManagedInterventionEvidence(sequences);
  const evidence = readManagedInterventionEvidence(bytes, sha256);
  return scopedManagedInterventions(evidence, rows, witnessStart, witnessEnd);
}

void test("reviewed intervention evidence deduplicates witnessed actions and candidate sequences", () => {
  const alias = { ...action, id: "8".repeat(64) };
  const positive = witness("a", "complete", [action, action, alias]);
  const shared = witness("b", "partial", [alias]);
  const zero = witness("c");
  const partial = witness("d", "partial");
  const unbound = witness("e");
  const report = reportWitnesses(
    [positive, { ...positive, actions: [alias] }, shared, zero, partial, unbound],
    [
      witnessObservation(positive),
      witnessObservation(positive),
      witnessObservation(shared),
      witnessObservation(zero),
      witnessObservation(partial),
      { ...witnessObservation(unbound), definition_sha256: "a".repeat(64) },
    ],
  );
  assert.equal(report.distinct_reported_actions, 1);
  assert.equal(report.reported_zero_sequences, 1);
  assert.deepEqual(
    report.sequences.map(({ state }) => state),
    ["action-reported", "action-reported", "zero-reported", "partial", "scope-unverified"],
  );
  const zeroOnly = reportWitnesses([zero], [witnessObservation(zero)]);
  assert.equal(zeroOnly.distinct_reported_actions, 0);
  assert.equal(zeroOnly.provenance, "operator-supplied-unverified");
  assert.equal(zeroOnly.verified_human_interventions, null);
  const [zeroSequence] = zeroOnly.sequences;
  assert.ok(zeroSequence && "matched_observation_states" in zeroSequence);
  assert.deepEqual(zeroSequence.matched_observation_states, ["pending"]);
  const incomplete = reportWitnesses([partial], [witnessObservation(partial)]);
  assert.equal(incomplete.distinct_reported_actions, null);
  assert.equal(incomplete.reported_zero_sequences, 0);
  assert.equal(managedReleaseEligibilityWindow([], new Date(witnessEnd)).human_interventions, null);
});

void test("intervention assertions preserve distinct client and disjoint time scopes for one candidate", () => {
  const first = witness("a");
  const otherClient = { ...first, client_sha256: "5".repeat(64), coverage: "partial" };
  const later = {
    ...first,
    start: "2026-11-04T00:00:00.000Z",
    end: "2026-11-05T00:00:00.000Z",
    observer_revision: first.observer_revision.replace(":42-1@", ":43-1@"),
  };
  const { bytes, sha256 } = encodeManagedInterventionEvidence([first, otherClient, later]);
  const report = scopedManagedInterventions(
    readManagedInterventionEvidence(bytes, sha256),
    [
      witnessObservation(first),
      { ...witnessObservation(later), state: "eligible", recorded_at: "2026-11-04 19:00:00+00" },
    ],
    first.start,
    later.end,
  );
  assert.equal(report.submitted_distinct_candidates, 1);
  assert.deepEqual(
    report.sequences.map((sequence) => [
      sequence.client_sha256,
      sequence.start,
      sequence.state,
      "matched_observation_states" in sequence ? sequence.matched_observation_states : null,
    ]),
    [
      [first.client_sha256, first.start, "zero-reported", ["pending"]],
      [later.client_sha256, later.start, "zero-reported", ["eligible"]],
      [otherClient.client_sha256, otherClient.start, "partial", ["pending"]],
    ],
  );
  assert.equal(report.verified_human_interventions, null);
});

void test("a complete zero contradicts actions inside its interval for the same client and definition", () => {
  const zero = witness("a");
  const claimed = {
    ...zero,
    start: "2026-11-02T12:00:00.000Z",
    end: "2026-11-03T12:00:00.000Z",
    observer_revision: zero.observer_revision.replace(":42-1@", ":43-1@"),
    coverage: "partial",
    actions: [action],
  };
  const zeroObservation = witnessObservation(zero);
  const actionObservation = witnessObservation(claimed);
  const summarize = (sequence: typeof claimed, observations: readonly unknown[]) => {
    const { bytes, sha256 } = encodeManagedInterventionEvidence([zero, sequence]);
    const result = scopedManagedInterventions(
      readManagedInterventionEvidence(bytes, sha256),
      observations,
      zero.start,
      claimed.end,
    );
    return {
      states: result.sequences.map(({ state }) => state),
      actions: result.distinct_reported_actions,
      zeroes: result.reported_zero_sequences,
    };
  };
  assert.deepEqual(summarize(claimed, [zeroObservation, actionObservation]), {
    states: ["conflicting-evidence", "conflicting-evidence"],
    actions: null,
    zeroes: 0,
  });
  assert.deepEqual(summarize(claimed, [zeroObservation]), {
    states: ["zero-reported", "scope-unverified"],
    actions: null,
    zeroes: 1,
  });
  for (const independent of [
    { ...claimed, client_sha256: "5".repeat(64) },
    { ...claimed, definition_sha256: "6".repeat(64) },
    { ...claimed, actions: [{ ...action, witnessed_at: "2026-11-03T06:00:00.000Z" }] },
  ]) {
    const result = summarize(independent, [zeroObservation, witnessObservation(independent)]);
    assert.deepEqual(result, {
      states: ["zero-reported", "action-reported"],
      actions: 1,
      zeroes: 1,
    });
  }
});

void test("conflicting reviewed intervention facts cannot supply a count", () => {
  const zero = witness("a");
  const positive = witness("a", "complete", [action]);
  const shared = witness("b", "complete", [action]);
  const substituted = witness("c", "complete", [{ ...action, evidence_sha256: "9".repeat(64) }]);
  const valid = witness("d");
  const report = reportWitnesses(
    [zero, positive, shared, substituted, valid],
    [zero, shared, substituted, valid].map(witnessObservation),
  );
  assert.deepEqual(
    report.sequences.map(({ state }) => state),
    ["conflicting-evidence", "conflicting-evidence", "conflicting-evidence", "zero-reported"],
  );
  assert.equal(report.distinct_reported_actions, null);
  assert.equal(report.reported_zero_sequences, 1);
});

void test("reviewed intervention evidence refuses bytes, malformed clocks and false observer binding", () => {
  const zero = witness("a");
  const { bytes, sha256 } = encodeManagedInterventionEvidence([zero]);
  assert.throws(() => readManagedInterventionEvidence(bytes, "0".repeat(64)), /reviewed input/u);
  assert.throws(
    () => encodeManagedInterventionEvidence([{ ...zero, end: "2026-11-35" }]),
    /binding or scope/u,
  );
  assert.throws(
    () =>
      encodeManagedInterventionEvidence([
        { ...zero, actions: [{ ...action, witnessed_at: "2026-11-04T00:00:00.000Z" }] },
      ]),
    /witnessed intervention action/u,
  );
  const recorded = witnessObservation(zero);
  for (const incompatible of [
    { ...recorded, recorded_at: "2026-11-04 00:00:00+00" },
    { ...recorded, platform: "linux-x86-64" },
    { ...recorded, channel: "rolling" },
    { ...recorded, port_key: "port:wrong" },
    { ...recorded, state: "unknown" },
    { ...recorded, observer_revision: recorded.observer_revision.replace(":42-1@", ":42-2@") },
  ]) {
    const parsed = scopedManagedInterventions(
      readManagedInterventionEvidence(bytes, sha256),
      [incompatible],
      witnessStart,
      witnessEnd,
    );
    assert.equal(parsed.sequences[0]?.state, "scope-unverified");
    assert.equal(parsed.distinct_reported_actions, null);
  }
});

void test("operating usage binds the imported attempt and measures only executed jobs", async () => {
  const source = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;
  const prefix = "actions/runs/123";
  const attempt = `${prefix}/attempts/2`;
  const report = {
    format: "portcove-maintenance-inventory",
    runs: [
      {
        source: "upstream-observations",
        source_revision: `upstream-observer-run:123-2@${source}#${digest}`,
        coverage: "partial",
      },
    ],
  };
  const job = {
    run_id: 123,
    run_attempt: 2,
    head_sha: source,
    status: "completed",
    started_at: "2026-11-11T00:00:00Z",
    completed_at: "2026-11-11T00:01:17.000Z",
  };
  const observation = { ...job, id: 1, name: "observe", conclusion: "failure" };
  const jobs = [
    observation,
    { ...job, id: 2, name: "report", conclusion: "skipped" },
    { ...job, id: 3, name: "admit", conclusion: "success", started_at: "2026-11-11" },
  ];
  const checkpoint = {
    id: 789,
    name: `upstream-observer-checkpoint-${"c".repeat(64)}-123-2`,
    digest,
    size_in_bytes: 12345,
    workflow_run: { id: 123, head_sha: source },
  };
  const jobInventory = { total_count: 3, jobs };
  const responses: Record<string, Record<string, unknown>> = {
    [attempt]: {
      id: 123,
      run_attempt: 2,
      head_sha: source,
      head_branch: "main",
      head_repository: { full_name: "boburning/portcove" },
      path: ".github/workflows/configured-upstream-observer.yml",
      event: "schedule",
      status: "completed",
      conclusion: "failure",
    },
    [`${attempt}/jobs?per_page=100`]: jobInventory,
    [`${prefix}/artifacts?per_page=100`]: { total_count: 1, artifacts: [checkpoint] },
  };
  const transport = {
    read: async (path: string) => {
      const response = responses[path];
      assert.ok(response, path);
      return response;
    },
  };
  const usage = await readObserverOperatingUsage(report, transport);
  assert.equal(usage.producer.event, "schedule");
  assert.equal(usage.observation_finished_at, "2026-11-11T00:01:17.000Z");
  assert.equal(usage.observed_runner_seconds, 77);
  assert.equal(usage.unmeasured_jobs, 1);
  assert.equal(usage.billed_cost_usd, null);
  assert.deepEqual(usage.checkpoint, { id: 789, digest, bytes: 12345 });
  assert.deepEqual(
    usage.executed_jobs.map(({ id, seconds }) => [id, seconds]),
    [
      [1, 77],
      [3, null],
    ],
  );

  observation.started_at = "2026-02-30T00:00:00Z";
  const malformed = await readObserverOperatingUsage(report, transport);
  assert.equal(malformed.observed_runner_seconds, null);
  assert.equal(malformed.unmeasured_jobs, 2);
  assert.equal(malformed.observation_finished_at, null);

  jobInventory.total_count = 4;
  await assert.rejects(readObserverOperatingUsage(report, transport), /inventory is incomplete/u);
  jobInventory.total_count = 3;
  observation.run_attempt = 1;
  await assert.rejects(readObserverOperatingUsage(report, transport), /job identity differs/u);
  observation.run_attempt = 2;
  checkpoint.digest = `sha256:${"d".repeat(64)}`;
  await assert.rejects(readObserverOperatingUsage(report, transport), /checkpoint differs/u);
});

void test("rolling eligibility counts one candidate per target separately from client availability", () => {
  const published = "2026-11-08T12:00:00.000Z";
  const row = (
    key: string,
    recorded_at: string,
    eligible = false,
    published_at: string | null = published,
  ) => ({
    candidate_key: key.repeat(64),
    recorded_at,
    published_at,
    state: eligible ? "eligible" : "pending",
    hold_reasons: eligible ? [] : ["missing-digest", "missing-digest"],
  });
  const result = managedReleaseEligibilityWindow(
    [
      row("a", "2026-11-10T12:00:00.000Z", true),
      row("a", "2026-11-09T12:00:00.000Z"),
      row("a", "2026-11-10T18:00:00.000Z", true),
      {
        ...row("b", "2026-11-09T12:00:00.000Z"),
        hold_reasons: [
          "missing-digest",
          "held-without-receipt",
          "asset-missing-or-ambiguous",
          "missing-digest",
        ],
      },
      row("c", "2026-11-09T12:00:00.000Z", false, null),
      row("d", "2026-11-09T12:00:00.000Z", false, "2026-09-08T12:00:00.000Z"),
      row("e", "2026-11-12T12:00:00.000Z", true),
      { ...row("f", "2026-11-10T20:00:00.000Z"), hold_reasons: [" "] },
      row("f", "2026-11-10T19:00:00.000Z"),
    ],
    new Date(now),
  );
  assert.equal(result.first_recorded_evidence_at, "2026-11-09T12:00:00.000Z");
  assert.equal(result.last_recorded_evidence_at, "2026-11-10T20:00:00.000Z");
  assert.equal(result.distinct_candidates, 3);
  assert.equal(result.eligible_candidates, 1);
  assert.equal(result.pending_candidates, 2);
  assert.equal(result.pending_without_recorded_hold_reason, 1);
  assert.equal(result.pending_with_other_recorded_hold_reason, 1);
  assert.equal(result.observed_pending_candidates, 3);
  assert.equal(result.observed_pending_to_eligible_candidates, 1);
  assert.equal(result.unknown_publication_times, 1);
  assert.equal(result.oldest_pending_age_ms, 216_000_000);
  assert.deepEqual(result.hold_reasons, [
    { reason: "asset-missing-or-ambiguous", distinct_candidates: 1 },
    { reason: "held-without-receipt", distinct_candidates: 1 },
    { reason: "missing-digest", distinct_candidates: 1 },
  ]);
  assert.deepEqual(result.publication_to_recorded_eligibility_ms, {
    samples: 1,
    median: 172_800_000,
    max: 172_800_000,
  });
  assert.equal(result.released_client_unattended_availability, null);
  assert.equal(result.human_interventions, null);
  assert.equal(result.signed_automatic_repairs, null);
  assert.equal(result.operating_cost, null);
});

void test("pending transitions require ordered evidence and count repeated changes once", () => {
  const published = "2026-11-08T12:00:00.000Z";
  const candidate = (id: string, date: string, state: "pending" | "eligible") => ({
    candidate_key: id.repeat(64),
    published_at: published,
    recorded_at: date,
    state,
    hold_reasons: [],
  });
  const early = "2026-11-09T12:00:00.000Z";
  const later = "2026-11-10T12:00:00.000Z";
  const report = managedReleaseEligibilityWindow(
    [
      candidate("a", later, "pending"),
      candidate("a", early, "eligible"),
      candidate("b", later, "pending"),
      candidate("b", later, "eligible"),
      candidate("c", later, "eligible"),
      candidate("c", early, "pending"),
      candidate("c", later, "eligible"),
    ],
    new Date(now),
  );
  assert.equal(report.observed_pending_candidates, 3);
  assert.equal(report.observed_pending_to_eligible_candidates, 1);
});

void test("upstream facts keep stable source facts and report coverage gaps", () => {
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"]),
      // Completed before but its scope was reset for a changed declaration.
      [keyOf("owner/beta")]: progress("owner/beta", ["beta"], { completed_scope_sha256: null }),
    }),
    catalog,
    now,
  );
  assert.equal(result.expected, 4);
  assert.deepEqual([...result.facts.keys()], ["port:alpha"]);
  assert.deepEqual(
    result.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [
      ["port:beta", "scope-changed"],
      ["port:delta", "held"],
      ["port:gamma", "unobserved"],
    ],
  );
  const alpha = result.facts.get("port:alpha") as { sources: Record<string, unknown>[] };
  assert.deepEqual(alpha.sources, [
    {
      source_key: keyOf("owner/alpha"),
      provider: "github",
      repository: "owner/alpha",
      repository_id: 7,
      last_complete_facts_sha256: facts,
      last_change_at: "2026-11-01T00:00:00.000Z",
      exception_key: null,
      exception_rule: null,
      catalog_definition_sha256: "d".repeat(64),
    },
  ]);
  assert.deepEqual(upstreamAttention(alpha), []);
});

void test("a port added after its source completed is a scope change, not a fact", () => {
  const result = upstreamFacts(
    checkpoint({ [keyOf("owner/alpha")]: progress("owner/alpha", []) }),
    { ports: [catalog.ports[0]] },
    now,
  );
  assert.deepEqual(result.facts.size, 0);
  assert.equal(result.gaps[0]?.code, "scope-changed");
});

void test("a held managed source preserves completed successor listing evidence in its gap", () => {
  const historical = "owner/alpha";
  const successor = "new-owner/alpha";
  const catalogWithSuccessor = {
    ports: [catalog.ports[0]],
    listings: [{ id: "alpha", project_url: `https://github.com/${successor}` }],
  };
  const invalidOrigin = progress(historical, [], {
    repository_id: null,
    completed_scope_sha256: null,
    last_complete_facts_sha256: null,
    exception_key: exception,
    exception_rule: "repository-unavailable",
  });
  const successorListing = progress(successor, ["alpha"], {
    last_complete_policies: [
      {
        ...progress(successor, ["alpha"]).last_complete_policies[0],
        catalog_definition_sha256: null,
      },
    ],
  });
  const partial = upstreamFacts(
    checkpoint({ [keyOf(historical)]: invalidOrigin, [keyOf(successor)]: successorListing }),
    catalogWithSuccessor,
    now,
  );

  assert.equal(partial.expected, 1);
  assert.equal(partial.facts.size, 0);
  assert.equal(partial.gaps.length, 1);
  const gap = partial.gaps[0]!;
  assert.deepEqual(
    gap.source_coverage?.retained.map((source) => source.repository),
    [successor],
  );
  assert.equal(gap.source_coverage?.retained[0]?.scope, "listing");
  assert.deepEqual(
    gap.source_coverage?.incomplete.map(({ repository, exception_rule }) => [
      repository,
      exception_rule,
    ]),
    [[historical, "repository-unavailable"]],
  );
  const summary = upstreamSummary(null, gap)!;
  assert.match(summary, /new-owner\/alpha \(listing\): facts f{12}/u);
  assert.match(
    summary,
    /latest checkpoint: partial source coverage; github owner\/alpha \(operational\): unobserved/u,
  );
  assert.deepEqual(upstreamAttention(null, gap), [
    "upstream observer exception: repository-unavailable (github owner/alpha)",
  ]);

  const restored = upstreamFacts(
    checkpoint({
      [keyOf(historical)]: progress(historical, ["alpha"]),
      [keyOf(successor)]: successorListing,
    }),
    catalogWithSuccessor,
    now,
  );
  assert.equal(restored.facts.size, 1);
  assert.equal(restored.gaps.length, 0);

  const failedBoth = upstreamFacts(
    checkpoint({ [keyOf(historical)]: invalidOrigin }),
    catalogWithSuccessor,
    now,
  );
  const previous = restored.facts.get("port:alpha");
  const incompleteSummary = upstreamSummary(previous, failedBoth.gaps[0])!;
  assert.match(incompleteSummary, /new-owner\/alpha \(previous observation\)/u);
  assert.match(incompleteSummary, /latest checkpoint: incomplete source coverage/u);
  assert.match(incompleteSummary, /new-owner\/alpha \(listing\): unobserved/u);
});

void test("retained managed candidates keep their identity from pending to eligible under one tag", () => {
  const offered = {
    platform: "linux-x86-64",
    channel: "stable",
    channel_candidate: { id: 19, tag: "v2", published_at: "2026-11-10T09:00:00Z" },
  };
  const prior = progress("owner/alpha", ["alpha"]);
  const read = (row: Record<string, unknown>) =>
    upstreamFacts(
      checkpoint({
        [keyOf("owner/alpha")]: {
          ...prior,
          last_complete_policies: [
            {
              ...prior.last_complete_policies[0],
              projections: [
                row,
                { ...row, channel: "rolling" },
                { ...row, platform: "windows-x86-64" },
              ],
            },
          ],
        },
      }),
      {
        ports: [
          {
            ...catalog.ports[0],
            release: { repository: "owner/alpha", curated: { "windows-x86-64": {} } },
          },
        ],
      },
      now,
    ).facts.get("port:alpha");
  const pending = read({
    ...offered,
    latest_eligible: { release_id: 18, release: { version: "v1" } },
    hold_reasons: ["checksum-observation-incomplete"],
  });
  const eligible = read({
    ...offered,
    latest_eligible: { release_id: 19, release: { version: "v2" } },
    hold_reasons: [],
  });
  const identity = {
    candidate_key: sha256(JSON.stringify(["alpha", "github", 7, 19, "linux-x86-64", "stable"])),
    platform: "linux-x86-64",
    channel: "stable",
    release_id: 19,
    tag: "v2",
    published_at: "2026-11-10T09:00:00.000Z",
  };
  for (const [value, state, reasons] of [
    [pending, "pending", ["checksum-observation-incomplete"]],
    [eligible, "eligible", []],
  ] as const) {
    const fact = value as { sources: { managed_release_candidates: unknown }[] };
    assert.deepEqual(fact.sources[0]?.managed_release_candidates, [
      { ...identity, state, hold_reasons: reasons },
    ]);
  }
});

void test("observer exceptions are facts that need attention, or gaps when never completed", () => {
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], {
        exception_key: exception,
        exception_rule: "repository-unavailable",
      }),
      [keyOf("owner/gamma")]: progress("owner/gamma", [], {
        completed_scope_sha256: null,
        last_complete_facts_sha256: null,
        exception_key: exception,
      }),
    }),
    catalog,
    now,
  );
  assert.deepEqual(upstreamAttention(result.facts.get("port:alpha")), [
    "upstream observer exception: repository-unavailable (owner/alpha)",
  ]);
  const gamma = result.gaps.find(({ subject_key }) => subject_key === "port:gamma");
  assert.equal(gamma?.code, "unobserved");
  // A checkpoint written before #4779 has no rule; the exception still needs attention.
  assert.deepEqual(upstreamAttention(null, gamma), [
    "upstream observer exception: unrecorded rule",
  ]);
});

void test("the observer's partial-progress stops are routine and stay quiet", () => {
  for (const rule of ["budget", "cancelled", "provider-quota"]) {
    const result = upstreamFacts(
      checkpoint({
        [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], {
          exception_key: exception,
          exception_rule: rule,
        }),
      }),
      { ports: [catalog.ports[0]] },
      now,
    );
    assert.equal(result.facts.get("port:alpha") === undefined, false);
    assert.deepEqual(upstreamAttention(result.facts.get("port:alpha")), [], rule);
  }
});

void test("per-observation clocks and progress never change the stored payload", () => {
  const digest = (overrides: Record<string, unknown>, policyClock: string) => {
    const source = progress("owner/alpha", ["alpha"], overrides);
    source.last_complete_policies[0]!.observed_at = policyClock;
    const result = upstreamFacts(
      checkpoint({ [keyOf("owner/alpha")]: source }, 9),
      { ports: [catalog.ports[0]] },
      now,
    );
    return sha256(canonicalJson(result.facts.get("port:alpha")));
  };
  assert.equal(
    digest({}, "2026-11-10T10:00:00.000Z"),
    digest(
      {
        attempted_sequence: 9,
        completed_at: "2026-11-10T16:00:00.000Z",
        freshness_observed_at: "2026-11-10T16:00:00.000Z",
        next_due_at: "2026-11-10T22:00:00.000Z",
        retry_at: "2026-11-10T17:00:00.000Z",
        result_sha256: "c".repeat(64),
        change_intervals: 2,
      },
      "2026-11-10T16:00:00.000Z",
    ),
  );
  // A real upstream change is a different fact.
  assert.notEqual(
    digest({}, "2026-11-10T10:00:00.000Z"),
    digest({ last_change_at: "2026-11-10T16:00:00.000Z" }, "2026-11-10T10:00:00.000Z"),
  );
});

void test("an unreadable or invalid checkpoint is a failed run that observes nothing", async () => {
  const failed = await upstreamObservation(() =>
    Promise.reject(new Error("artifact download refused")),
  );
  assert.equal(failed.failed, true);
  assert.equal(failed.facts.size, 0);
  assert.equal(failed.gaps[0]?.code, "unavailable");
  assert.match(failed.gaps[0]?.message ?? "", /artifact download refused/u);
  const invalid = await upstreamObservation(() =>
    Promise.resolve({
      revision: "r",
      config_sha256: scope,
      checkpoint: { format: 2 },
      catalog,
    }),
  );
  assert.equal(invalid.failed, true);
  assert.match(invalid.gaps[0]?.message ?? "", /Invalid catalog observer checkpoint/u);
});

void test("held declarations of observed ports stay facts; only unserved held ports are gaps", () => {
  const mixed = {
    ports: [
      { id: "alpha", channels: ["stable"], release: { repository: "owner/alpha" } },
      {
        id: "eps",
        channels: ["stable"],
        release: { provider: "user-prepared", repository: "x/y" },
      },
    ],
    listings: [
      // A managed GitHub port whose listing has no supported identity.
      { id: "alpha", project_url: "https://example.com/alpha" },
      // A user-prepared port whose listing the observer still observes.
      { id: "eps", project_url: "https://github.com/owner/eps" },
    ],
  };
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"]),
      [keyOf("owner/eps")]: progress("owner/eps", ["eps"]),
    }),
    mixed,
    now,
  );
  assert.deepEqual(result.gaps, []);
  assert.deepEqual((result.facts.get("port:alpha") as { held_reasons?: string[] }).held_reasons, [
    "listing-provider-observation-unsupported",
  ]);
  assert.deepEqual((result.facts.get("port:eps") as { held_reasons?: string[] }).held_reasons, [
    "provider-user-prepared-not-observable-by-core",
  ]);
  const unserved = upstreamFacts(checkpoint({}), { ports: [catalog.ports[3]] }, now);
  assert.equal(unserved.gaps[0]?.code, "held");
});

void test("a routine partial-progress stop does not change the stored payload", () => {
  const stored = (overrides: Record<string, unknown>) =>
    JSON.stringify(
      upstreamFacts(
        checkpoint({ [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], overrides) }),
        { ports: [catalog.ports[0]] },
        now,
      ).facts.get("port:alpha"),
    );
  const quiet = stored({});
  for (const rule of ["budget", "cancelled", "provider-quota"])
    assert.equal(stored({ exception_key: exception, exception_rule: rule }), quiet, rule);
  assert.notEqual(
    stored({ exception_key: exception, exception_rule: "repository-unavailable" }),
    quiet,
  );
});

// Stubbed GitHub transport for the observer snapshot selection and binding.
const observerConfig = Buffer.from("fixture observer config");
const observerConfigDigest = createHash("sha256").update(observerConfig).digest("hex");
const observerCatalog = { ports: [catalog.ports[0]] };
const observerListings = { listings: [{ id: "alpha", project_url: "https://example.com" }] };

interface FixtureRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  path: string;
  created_at: string;
  head_repository: { full_name: string };
}

function observerRuns() {
  const runs: FixtureRun[] = [];
  const artifacts = new Map<number, Record<string, unknown>[]>();
  const archives = new Map<number, Buffer>();
  const downloads: string[] = [];
  let configBytes: Buffer = observerConfig;
  const run = (
    id: number,
    event: string,
    minutesAgo: number,
    overrides: Partial<FixtureRun> = {},
  ) => {
    const value: FixtureRun = {
      id,
      run_attempt: 1,
      head_sha: id.toString(16).padStart(40, "0"),
      head_branch: "main",
      event,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/configured-upstream-observer.yml",
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      head_repository: { full_name: "boburning/portcove" },
      ...overrides,
    };
    runs.push(value);
    artifacts.set(id, []);
    return value;
  };
  /** A retained checkpoint snapshot of `value`, bound like the observer's own upload. */
  const retain = (
    value: FixtureRun,
    options: {
      artifact?: Record<string, unknown>;
      producer?: Partial<{ run: number; attempt: number; source: string }>;
      archive?: (bytes: Buffer) => Buffer;
      member?: Buffer;
    } = {},
  ) => {
    const producer = {
      run: value.id,
      attempt: value.run_attempt,
      source: value.head_sha,
      ...options.producer,
    };
    const snapshot = {
      format: 1,
      authority: "observer-checkpoint-cache-only",
      repository: "boburning/portcove",
      repository_id: 1354613114,
      workflow: ".github/workflows/configured-upstream-observer.yml",
      ref: "refs/heads/main",
      config_sha256: observerConfigDigest,
      created_at: new Date(Date.now() - 1000).toISOString(),
      producer,
      files: { "catalog/checkpoint.json": newCatalogObserverCheckpoint() },
    };
    const archive = createAuditZip([
      ["checkpoint.json", options.member ?? JSON.stringify(snapshot)],
    ]);
    const id = 1000 + archives.size;
    artifacts.get(value.id)!.push({
      id,
      name: snapshotName(observerConfigDigest, {
        run: value.id,
        attempt: value.run_attempt,
        source: value.head_sha,
      }),
      expired: false,
      size_in_bytes: archive.length,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      workflow_run: { id: value.id, head_sha: value.head_sha },
      ...options.artifact,
    });
    archives.set(id, options.archive ? options.archive(archive) : archive);
    return { id, archive };
  };
  const transport: UpstreamTransport = {
    read: (endpoint) => {
      const workflow = /^actions\/workflows\/configured-upstream-observer\.yml\/runs\?(.+)$/u.exec(
        endpoint,
      );
      if (workflow) {
        const query = new URLSearchParams(workflow[1]);
        assert.equal(query.get("branch"), "main");
        assert.equal(query.get("status"), "completed");
        // The provider filters by trigger; a foreign row is the provider's own error.
        return Promise.resolve({
          workflow_runs: runs
            .filter((row) => row.event === query.get("event") || row.event === "workflow_dispatch")
            .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
            .slice(0, Number(query.get("per_page"))),
        });
      }
      const listed = /^actions\/runs\/(\d+)\/artifacts\?per_page=100&page=1$/u.exec(endpoint);
      if (listed) {
        const rows = artifacts.get(Number(listed[1])) ?? [];
        return Promise.resolve({ total_count: rows.length, artifacts: rows });
      }
      throw new Error(`unexpected read ${endpoint}`);
    },
    download: (endpoint, maxBytes) => {
      downloads.push(endpoint);
      const id = Number(/\/artifacts\/(\d+)\/zip$/u.exec(endpoint)?.[1]);
      const bytes = archives.get(id);
      if (!bytes) throw new Error(`unexpected download ${endpoint}`);
      assert.ok(maxBytes > 0);
      return Promise.resolve(bytes);
    },
  };
  const committed = (revision: string, file: string) => {
    assert.match(revision, /^[0-9a-f]{40}$/u);
    if (file === "release/upstream-observer.json") return configBytes;
    if (file === "crates/portcove-core/catalog/catalog.json")
      return Buffer.from(JSON.stringify(observerCatalog));
    if (file === "crates/portcove-core/catalog/listings.json")
      return Buffer.from(JSON.stringify(observerListings));
    throw new Error(`unexpected committed file ${file}`);
  };
  return {
    run,
    retain,
    downloads,
    setConfig(bytes: Buffer) {
      configBytes = bytes;
    },
    read: () => readUpstreamObservations(committed, { transport }),
  };
}

void test("the newest qualifying schedule or push run is selected and bound", async () => {
  const fixture = observerRuns();
  fixture.retain(fixture.run(101, "schedule", 90));
  // A gated push run retains no snapshot; an expired or foreign-named one is passed over.
  fixture.run(102, "push", 5);
  fixture.retain(fixture.run(103, "push", 10), { artifact: { expired: true } });
  fixture.retain(fixture.run(104, "schedule", 15), {
    artifact: { name: `upstream-observer-checkpoint-${observerConfigDigest}-104-2` },
  });
  // Cancelled runs never carry a complete snapshot, even when one is listed.
  fixture.retain(fixture.run(105, "push", 20, { conclusion: "cancelled" }));
  // A failed run can still carry a complete snapshot.
  const selected = fixture.run(106, "push", 30, { conclusion: "failure" });
  const { id, archive } = fixture.retain(selected);
  // Runs older than the one-day retention are never candidates.
  fixture.retain(fixture.run(107, "schedule", 25 * 60));
  const input = await fixture.read();
  const digest = createHash("sha256").update(archive).digest("hex");
  assert.equal(input.revision, `upstream-observer-run:106-1@${selected.head_sha}#sha256:${digest}`);
  assert.equal(input.config_sha256, observerConfigDigest);
  assert.deepEqual(input.checkpoint, newCatalogObserverCheckpoint());
  assert.deepEqual(input.catalog, { ...observerCatalog, listings: observerListings.listings });
  assert.deepEqual(fixture.downloads, [`repos/boburning/portcove/actions/artifacts/${id}/zip`]);
});

void test("a full window of admission-only pushes cannot hide a scheduled snapshot", async () => {
  const fixture = observerRuns();
  const schedule = fixture.run(500, "schedule", 90);
  const { id } = fixture.retain(schedule);
  for (let minute = 1; minute <= 24; minute++) fixture.run(500 + minute, "push", minute);

  const input = await fixture.read();
  assert.match(input.revision, /^upstream-observer-run:500-1@/u);
  assert.deepEqual(fixture.downloads, [`repos/boburning/portcove/actions/artifacts/${id}/zip`]);
});

void test("streaming snapshots deliver a logical controller to maintenance facts", async () => {
  const fixture = observerRuns();
  const run = fixture.run(108, "schedule", 5);
  const controller = checkpoint({
    [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"]),
  });
  const stored = encodeStoredObserverCheckpoint(controller);
  assert.notEqual(stored, controller, "fixture controller must be compacted on read");
  const snapshot = await encodeStreamingObserverSnapshot(
    {
      format: 1,
      authority: "observer-checkpoint-cache-only",
      repository: "boburning/portcove",
      repository_id: 1354613114,
      workflow: ".github/workflows/configured-upstream-observer.yml",
      ref: "refs/heads/main",
      config_sha256: observerConfigDigest,
      created_at: new Date(Date.now() - 1000).toISOString(),
      producer: { run: run.id, attempt: run.run_attempt, source: run.head_sha },
      files: { "catalog/checkpoint.json": controller },
    },
    Date.now() + 60_000,
  );
  fixture.retain(run, { member: snapshot.bytes });
  const input = await fixture.read();
  assert.deepEqual(input.checkpoint, controller);
  assert.deepEqual(
    [...upstreamFacts(input.checkpoint, input.catalog, now).facts.keys()],
    ["port:alpha"],
  );
});

void test("a foreign producer run is refused before any artifact is read", async () => {
  for (const overrides of [
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "fork/portcove" } },
  ]) {
    const fixture = observerRuns();
    fixture.retain(fixture.run(201, "schedule", 10));
    fixture.retain(fixture.run(202, "schedule", 5, overrides));
    await assert.rejects(fixture.read(), /names a foreign producer/u, JSON.stringify(overrides));
    assert.deepEqual(fixture.downloads, []);
  }
});

void test("an unbound or mismatched snapshot is refused, never passed over", async () => {
  const cases: [
    string,
    (fixture: ReturnType<typeof observerRuns>, run: FixtureRun) => void,
    RegExp,
  ][] = [
    [
      "missing digest",
      (fixture, run) => fixture.retain(run, { artifact: { digest: undefined } }),
      /checkpoint artifact is unbound/u,
    ],
    [
      "foreign workflow run",
      (fixture, run) =>
        fixture.retain(run, { artifact: { workflow_run: { id: 999, head_sha: run.head_sha } } }),
      /checkpoint artifact is unbound/u,
    ],
    [
      "downloaded bytes",
      (fixture, run) =>
        fixture.retain(run, {
          archive: (bytes) =>
            Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1)! ^ 1])]),
        }),
      /does not match its recorded digest/u,
    ],
    [
      "configuration digest",
      (fixture, run) => {
        fixture.retain(run);
        fixture.setConfig(Buffer.from("a different observer config"));
      },
      /configuration differs from its producer source/u,
    ],
    [
      "snapshot producer",
      (fixture, run) => fixture.retain(run, { producer: { run: 999 } }),
      /snapshot producer differs from its run/u,
    ],
  ];
  for (const [label, arrange, expected] of cases) {
    const fixture = observerRuns();
    // An older valid snapshot exists; a refusal must not fall back to it.
    fixture.retain(fixture.run(301, "schedule", 60));
    arrange(fixture, fixture.run(302, "push", 10));
    await assert.rejects(fixture.read(), expected, label);
  }
});

void test("no retained snapshot is a failed run that observes nothing", async () => {
  const fixture = observerRuns();
  fixture.run(401, "schedule", 10);
  fixture.retain(fixture.run(402, "push", 20), { artifact: { expired: true } });
  await assert.rejects(
    fixture.read(),
    /None of the 2 newest completed schedule or push main observer runs/u,
  );
  const failed = await upstreamObservation(() => fixture.read());
  assert.equal(failed.failed, true);
  assert.equal(failed.revision, "upstream-observer:unavailable");
  assert.equal(failed.facts.size, 0);
  assert.deepEqual(
    failed.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [["source:upstream-observer-checkpoint", "unavailable"]],
  );
  assert.deepEqual(fixture.downloads, []);
});
