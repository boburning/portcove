import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "./maintenance-inventory.mts";
import { upstreamAttention, upstreamFacts, upstreamObservation } from "./maintenance-upstream.mts";
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
