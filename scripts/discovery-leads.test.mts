import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptLeadPage,
  nextLeadPage,
  parseLeadState,
  pendingLeads,
  restartLeadSlice,
  LeadSearchChanged,
} from "./discovery-leads.mts";
import { DiscoverySession } from "./daily-discovery-session.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import type { RoadmapConfig } from "./roadmap.mts";
import path from "node:path";
import os from "node:os";
const now = "2026-10-23T12:56:46.011Z";
const item = (id: number, full_name = `ports/game-${id}`) => ({
  id,
  full_name,
  html_url: `https://github.com/${full_name}`,
  description: "Native PC port",
});
const page = (items: ReturnType<typeof item>[], total_count = items.length) => ({
  total_count,
  incomplete_results: false,
  items,
});
void test("Brawl missed by newest-ten remains discoverable and queued across paginated runs", () => {
  let state = parseLeadState(undefined);
  const first = nextLeadPage(state, now);
  assert.match(first.query, /recompiled.*created:2026-10-09.*2026-10-23/u);
  state = acceptLeadPage(
    state,
    first,
    page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      51,
    ),
    now,
    "page1.json",
  );
  for (let n = 0; n < 3; n++)
    state = acceptLeadPage(state, nextLeadPage(state, now), page([]), now, "other.json");
  state = parseLeadState(JSON.parse(JSON.stringify(state)));
  const second = nextLeadPage(state, "2026-10-24T13:00:00Z");
  assert.equal(second.page, 2);
  assert.equal(second.slice.until, now, "unfinished window must not slide past the missed release");
  state = acceptLeadPage(
    state,
    second,
    page([item(1430261227, "josiahg2502-glitch/BrawlRecompiled")], 51),
    now,
    "page2.json",
  );
  const lead = pendingLeads(state).find((r) => r.id === 1430261227);
  assert.equal(lead?.repository, "josiahg2502-glitch/BrawlRecompiled");
  assert.equal(lead?.evidence, "page2.json");
  assert.equal(state.slices[second.family]?.completed_at, now);
  const restored = parseLeadState(JSON.parse(JSON.stringify(state)));
  assert.equal(
    pendingLeads(restored).length,
    51,
    "search cursor changes cannot drop unfinished research",
  );
});
void test("failed, truncated, drifting and duplicate search pages preserve the last accepted state", () => {
  const state = parseLeadState(undefined),
    plan = nextLeadPage(state, now);
  const before = JSON.stringify(state);
  assert.throws(
    () => acceptLeadPage(state, plan, { ...page([item(1)]), incomplete_results: true }, now, "bad"),
    /Incomplete/,
  );
  assert.throws(() => acceptLeadPage(state, plan, page([item(1)], 20), now, "bad"), /coverage/);
  assert.throws(
    () => acceptLeadPage(state, plan, page([item(1), item(1)]), now, "bad"),
    /Duplicate/,
  );
  assert.equal(JSON.stringify(state), before);
  const next = acceptLeadPage(
    state,
    plan,
    page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      51,
    ),
    now,
    "ok",
  );
  next.next_family = 0;
  assert.throws(
    () => acceptLeadPage(next, nextLeadPage(next, now), page([item(100)], 52), now, "bad"),
    /count changed/,
  );
  assert.equal(next.slices[plan.family]?.page, 2);
});
void test("query overlap deduplicates provider identities, preserves disposition and refuses relocation", () => {
  let state = parseLeadState(undefined);
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "first");
  state.records["1"]!.status = "held";
  state.records["1"]!.disposition = { reason: "experimental", resume: "usable upstream setup" };
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "second");
  assert.equal(Object.keys(state.records).length, 1);
  assert.equal(state.records["1"]!.status, "held");
  assert.throws(
    () =>
      acceptLeadPage(
        state,
        nextLeadPage(state, now),
        page([item(1, "other/game")]),
        now,
        "renamed",
      ),
    /relocation/,
  );
  assert.throws(
    () =>
      acceptLeadPage(
        state,
        nextLeadPage(state, now),
        page([item(2, "ports/game-1")]),
        now,
        "replaced",
      ),
    /identity changed/,
  );
});
void test("old state migration and provider search ceiling remain bounded and truthful", () => {
  const state = parseLeadState(undefined);
  const plan = nextLeadPage(state, now);
  plan.slice.page = 20;
  plan.page = 20;
  plan.slice.seen = Array.from({ length: 950 }, (_, i) => i + 1);
  plan.slice.total = 1001;
  const next = acceptLeadPage(
    state,
    plan,
    page(
      Array.from({ length: 50 }, (_, i) => item(951 + i)),
      1001,
    ),
    now,
    "cap",
  );
  assert.equal(next.slices[plan.family]?.page, 1);
  assert.equal(next.slices[plan.family]?.remaining?.length, 1);
  assert.equal(next.slices[plan.family]?.completed_at, undefined);
  next.next_family = 0;
  assert.ok(nextLeadPage(next, now).slice.until < now);
  let halves = acceptLeadPage(next, nextLeadPage(next, now), page([item(1002)]), now, "half");
  assert.equal(halves.slices[plan.family]?.completed_at, undefined);
  halves.next_family = 0;
  halves = acceptLeadPage(halves, nextLeadPage(halves, now), page([item(1003)]), now, "tail");
  assert.equal(halves.slices[plan.family]?.completed_at, now);
  assert.throws(() => parseLeadState({ ...next, next_family: -1 }), /Invalid/);
});
void test("changed search index can restart on a later run without dropping collected leads", () => {
  let state = parseLeadState(undefined);
  const plan = nextLeadPage(state, now);
  state = acceptLeadPage(
    state,
    plan,
    page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      51,
    ),
    now,
    "first",
  );
  state.next_family = 0;
  const second = nextLeadPage(state, now);
  assert.throws(
    () => acceptLeadPage(state, second, page([item(52)], 52), now, "changed"),
    LeadSearchChanged,
  );
  state = restartLeadSlice(state, second, "count changed");
  assert.equal(nextLeadPage(state, now).page, 1);
  assert.equal(Object.keys(state.records).length, 50);
  assert.equal(nextLeadPage(state, now).slice.until, now);
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(52)]), now, "replacement");
  assert.equal(Object.keys(state.records).length, 51);
});
void test("weekly held-lead refresh catches release-only changes without a source push", () => {
  let state = parseLeadState(undefined);
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "first");
  state.records["1"]!.status = "held";
  state.records["1"]!.checked_at = now;
  assert.equal(pendingLeads(state, new Set(), Date.parse(now) + 6 * 86400000).length, 0);
  assert.equal(pendingLeads(state, new Set(), Date.parse(now) + 7 * 86400000).length, 1);
});
void test("metadata query scopes preserve old pagination and game signals outrank compiler packages", () => {
  let state = parseLeadState(undefined);
  const plan = nextLeadPage(state, now);
  state = acceptLeadPage(
    state,
    plan,
    page([item(1430261227, "josiahg2502-glitch/BrawlRecompiled")]),
    now,
    "brawl",
  );
  const old = state.slices[plan.family]!;
  delete old.terms;
  state.next_family = 0;
  const revised = nextLeadPage(state, now);
  assert.equal(revised.retired, true);
  assert.equal(revised.page, 1);
  state = acceptLeadPage(state, revised, page([]), now, "new-scope");
  assert.equal(state.retired_slices?.[plan.family]?.seen[0], 1430261227);
  assert.equal(state.records["1430261227"]?.repository, "josiahg2502-glitch/BrawlRecompiled");
  state.next_family = 2;
  assert.doesNotMatch(nextLeadPage(state, now).query, /readme/u);
  state.next_family = 3;
  assert.doesNotMatch(nextLeadPage(state, now).query, /readme/u);
  state.records["1"] = {
    ...state.records["1430261227"],
    id: 1,
    repository: "ccache/ccache",
    url: "https://github.com/ccache/ccache",
    description: "A fast C/C++ compiler cache",
    release_hint: { assets_observed: true, observed_at: now, evidence: "ccache-release.json" },
  };
  assert.equal(pendingLeads(state)[0]?.repository, "josiahg2502-glitch/BrawlRecompiled");
  assert.ok(state.records["1"], "noisy old leads are retained rather than silently deleted");
});
void test("runner charges complementary pages, guards rotation and retains queue across restart", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-leads-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  mkdirSync(run);
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  budget.reserveDelivery(60, 1024);
  let calls = 0;
  Object.assign(session, {
    stateDir: root,
    runDir: run,
    journalFile: path.join(root, "active-run.json"),
    inventory: { issues: [] },
    checkpoint: {},
    checkpointPreimage: "fixture",
    leads: parseLeadState(undefined),
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: false,
    researchedLeads: new Set(),
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    source: {
      api: {
        request: (_method: string, endpoint: string) => {
          if (endpoint.includes("/releases?")) {
            budget.charge("GET", endpoint, 1, 2, "200");
            return { body: [] };
          }
          calls++;
          const body = page([item(calls)]);
          budget.charge("GET", "search/repositories", 1, 100, "200");
          return { body };
        },
      },
    },
  });
  assert.equal("status" in session.recheck() ? "deferred" : "unexpected", "deferred");
  assert.equal(calls, 0);
  session.discover();
  assert.equal(calls, 4);
  assert.equal(budget.usage.requests, 8);
  assert.equal(
    session.leadWorkComplete(),
    false,
    "page collection alone cannot complete discovery",
  );
  assert.equal("status" in session.recheck() ? "deferred" : "unexpected", "deferred");
  session.researchedLeads.add(1);
  session.researchedLeads.add(2);
  assert.equal(session.leadWorkComplete(), true);
  session.researchedLeads.clear();
  session.knownLeadUrls = () => new Set(["https://github.com/ports/game-1"]);
  const oldLeadFile = JSON.stringify(session.leads);
  for (const id of [1, 2, 3]) {
    const evidenceId = `retained-${id}`;
    session.leads.records[String(id)]!.research = {
      evidence_id: evidenceId,
      file: "retained.json",
      material: "fixture",
    };
    session.journal.evidence[evidenceId] = {
      repository: `ports/game-${id}`,
      material: "fixture",
      file: "retained.json",
      requests: 4,
      bytes: 100,
      observed_at: now,
    };
    session.leads.records[String(id)]!.status = "researched";
    session.disposeLead({
      evidence_id: evidenceId,
      outcome: "held",
      reason: "No usable upstream package",
      resume: "New upstream release",
    });
    assert.throws(
      () =>
        session.disposeLead({
          evidence_id: evidenceId,
          outcome: "held",
          reason: "same",
          resume: "same",
        }),
      /matching investigated/,
    );
    if (id === 1)
      assert.equal(
        session.researchedLeads.size,
        0,
        "canonical work cannot spend new-lead protection",
      );
  }
  assert.equal(
    session.researchedLeads.size,
    2,
    "retained researched evidence can be disposed without recapture",
  );
  assert.equal(session.leadWorkComplete(), true);
  // Simulate interruption after the evidence+lead journal commits but before leads.json replacement.
  writeFileSync(path.join(root, "leads.json"), oldLeadFile);
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as RoadmapConfig;
  const recovered = new DiscoverySession(root, run, config, "fixture-token", now, "fixture-head");
  assert.equal(recovered.leads.records["2"]?.status, "held");
  assert.equal(recovered.leads.records["2"]?.research?.evidence_id, "retained-2");
  const restored = parseLeadState(JSON.parse(JSON.stringify(session.leads)));
  assert.equal(pendingLeads(restored, new Set(), Date.parse(now)).length, 1);
  const constrained = new DiscoveryBudget("ordinary");
  constrained.reserveDelivery(190, 1024);
  Object.assign(session, {
    budget: constrained,
    searches: 0,
    leadCollectionAttempted: false,
    leadPages: 0,
    leads: parseLeadState(undefined),
  });
  session.discover();
  assert.equal(calls, 4, "reserve refusal must happen before HTTP");
  assert.equal(session.leadWorkComplete(), false);
});
void test("new window overlaps the completed interval and hints do not claim package usability", () => {
  let state = parseLeadState(undefined);
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "done");
  state.records["1"]!.description = "Experimental tooling";
  state.records["2"] = {
    ...state.records["1"]!,
    id: 2,
    repository: "ports/game-2",
    url: "https://github.com/ports/game-2",
    description: "Native port",
  };
  assert.deepEqual(
    pendingLeads(state).map((r) => r.id),
    [2, 1],
  );
  assert.deepEqual(
    pendingLeads(state, new Set(["https://github.com/ports/game-2"])).map((r) => r.id),
    [1],
  );
  state.next_family = 0;
  const next = nextLeadPage(state, "2026-10-24T13:00:00Z");
  assert.equal(next.slice.since, "2026-10-21T12:56:46.011Z");
});
