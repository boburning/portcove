import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptLeadPage,
  retainLeadResults,
  nextLeadPage,
  parseLeadState,
  pendingLeads,
  restartLeadSlice,
  LeadSearchChanged,
  leadSearchFamilyCount,
  leadFamilyIds,
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
void test("Switch searches preserve old pagination and carry their supported ordering contract", () => {
  assert.deepEqual(leadFamilyIds.slice(0, 24), [
    "new-recompiled",
    "new-recomp",
    "changed-recompilation",
    "changed-native-port",
    "ps2recomp",
    "xboxrecomp",
    "rexglue",
    "ps3recomp",
    "ps4-runtime",
    "psprecomp",
    "gcn-recomp",
    "dolrecomp",
    "psxrecomp",
    "static-topic",
    "xenonrecomp",
    "psp-web-recomp",
    "gcrecomp",
    "nwii-recomp",
    "xbox-xbe-recomp",
    "rexglue-org",
    "sp00nznet-owner",
    "xbox-xbe-hyphen",
    "rexglue-topic",
    "xboxrecomp-topic",
  ]);
  let state = parseLeadState(undefined);
  state = acceptLeadPage(
    state,
    nextLeadPage(state, now),
    page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      51,
    ),
    now,
    "old-page",
  );
  const retained = structuredClone(state.slices["new-recompiled"]);
  const expected = [
    "switch recomp",
    '"Nintendo Switch" native',
    "SwitchRecomp",
    "topic:nintendo-switch topic:static-recompilation",
  ];
  for (let index = 24; index < leadSearchFamilyCount; index++) {
    state.next_family = index;
    const plan = nextLeadPage(state, now);
    assert.match(plan.query, /pushed:.*fork:true$/u);
    assert.ok(plan.query.startsWith(expected[index - 24]!));
    assert.equal(plan.sort, "updated");
    assert.match(plan.slice.terms!, /\[updated desc\] \[fork:true\]$/u);
    // Same provider ID from multiple families remains one neutral research lead.
    state = acceptLeadPage(
      state,
      plan,
      page([item(900, "nxporting/nxport")]),
      now,
      `switch-${index}`,
    );
  }
  assert.deepEqual(state.slices["new-recompiled"], retained);
  assert.equal(Object.values(state.records).filter((r) => r.id === 900).length, 1);
  assert.equal(state.records["900"]?.status, "pending");
  assert.equal(parseLeadState(JSON.parse(JSON.stringify(state))).next_family, 0);
  assert.equal(leadFamilyIds.length, 28);
});
void test("resource-admitted six-page batches rotate all families and preserve exact windows and HTTP ordering", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-switch-rotation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let state = parseLeadState(undefined);
  const requests: { family: string; page: number }[] = [];
  for (let run = 0; run < 5; run++) {
    const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
    const budget = new DiscoveryBudget("ordinary");
    budget.reserveDelivery(178, 1024); // Six pages fit before the investigation reserve.
    Object.assign(session, {
      stateDir: root,
      runDir: root,
      journalFile: path.join(root, "journal.json"),
      checkpoint: {},
      checkpointPreimage: "fixture",
      inventory: { issues: [] },
      journal: {
        format: 1,
        started_at: new Date(Date.parse(now) + run * 86400000).toISOString(),
        notes: [],
        candidates: {},
        evidence: {},
      },
      leads: state,
      budget,
      leadPages: 0,
      searches: 0,
      leadCollectionAttempted: false,
      researchedLeads: new Set<number>(),
      source: {
        api: {
          request: (_method: string, endpoint: string) => {
            budget.charge("GET", endpoint, 1, 100, "200");
            if (endpoint.includes("/releases?")) return { body: [] };
            const plan = nextLeadPage(session.leads, session.journal.started_at);
            const params = new URL(endpoint, "https://api.github.com/").searchParams;
            assert.equal(params.get("q"), plan.query);
            assert.equal(params.get("sort"), plan.sort ?? null);
            assert.equal(params.get("order"), plan.sort ? "desc" : null);
            assert.equal(params.get("per_page"), "50");
            requests.push({ family: plan.family, page: plan.page });
            const start = leadFamilyIds.indexOf(plan.family) * 1000 + (plan.page - 1) * 50 + 1;
            return {
              body: page(
                Array.from({ length: 50 }, (_, i) => item(start + i)),
                150,
              ),
            };
          },
        },
      },
    });
    session.discover();
    assert.equal(session.searches, 6);
    const evidence = JSON.parse(readFileSync(path.join(root, "lead-search-1.json"), "utf8")) as {
      sort: string;
      query: string;
    };
    assert.equal(evidence.sort, run === 4 ? "updated" : "best-match");
    state = parseLeadState(JSON.parse(JSON.stringify(session.leads)));
    assert.deepEqual(
      session.leadSummary().pending_families,
      leadFamilyIds.filter(
        (id) => !requests.slice(run * 6, (run + 1) * 6).some((r) => r.family === id),
      ),
    );
  }
  assert.deepEqual(
    requests.map((r) => r.family),
    [...leadFamilyIds, ...leadFamilyIds.slice(0, 2)],
  );
  assert.deepEqual(
    requests.slice(28).map((r) => r.page),
    [2, 2],
  );
  assert.equal(state.slices["new-recompiled"]?.until, now);
});
void test("current, capped and typed-drift skips cannot hide a due Switch topic tail", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-switch-skips-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let leads = parseLeadState(undefined);
  leads = acceptLeadPage(
    leads,
    nextLeadPage(leads, now),
    page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      51,
    ),
    now,
    "prior",
  );
  for (let index = 1; index < leadSearchFamilyCount - 1; index++)
    leads = acceptLeadPage(leads, nextLeadPage(leads, now), page([]), now, "current");
  const capped = leads.slices[leadFamilyIds[2]!]!;
  delete capped.completed_at;
  capped.capped = true;
  leads.next_family = 0;
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const requested: string[] = [];
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: false,
    researchedLeads: new Set<number>(),
    source: {
      api: {
        request: (_method: string, endpoint: string) => {
          budget.charge("GET", endpoint, 1, 100, "200");
          if (endpoint.includes("/releases?")) return { body: [] };
          const plan = nextLeadPage(session.leads, now);
          requested.push(plan.family);
          if (plan.family === "new-recompiled") return { body: page([item(99999)], 52) };
          return {
            body: page(
              Array.from({ length: 50 }, (_, i) => item(1000 + (plan.page - 1) * 50 + i)),
              300,
            ),
          };
        },
      },
    },
  });
  session.discover();
  assert.deepEqual(requested, [
    "new-recompiled",
    ...Array<string>(6).fill("changed-switch-topics"),
  ]);
  assert.equal(session.searches, 7);
  assert.equal(session.leadPages, 6, "drifting page is never validated pagination");
  assert.ok(session.deferredLeadFamilies.has("new-recompiled"));
  assert.equal(session.leads.slices["new-recompiled"]?.page, 1);
  assert.equal(session.leads.slices["changed-switch-topics"]?.page, 7);
  assert.equal(session.leads.slices["changed-switch-topics"]?.completed_at, now);
  assert.ok(session.leads.records["1"], "retained prior identity survives");
  assert.ok(session.leads.records["99999"], "positive lead survives refused pagination");
  assert.deepEqual(session.leads.records["99999"]?.search_families, ["new-recompiled"]);
});
for (const driftingFamilies of [1, 2, 4])
  void test(`${driftingFamilies} drifting search families cannot starve healthy searches and rotation`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "discovery-drift-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
    const budget = new DiscoveryBudget("ordinary");
    let leads = parseLeadState(undefined);
    for (let family = 0; family < driftingFamilies; family++) {
      leads.next_family = family;
      leads = acceptLeadPage(
        leads,
        nextLeadPage(leads, now),
        page(
          Array.from({ length: 50 }, (_, i) => item(i + 1)),
          51,
        ),
        now,
        "previous-page.json",
      );
    }
    leads.next_family = 0;
    const requests: string[] = [];
    Object.assign(session, {
      stateDir: root,
      runDir: root,
      journalFile: path.join(root, "journal.json"),
      checkpoint: {},
      checkpointPreimage: "fixture",
      inventory: { issues: [] },
      journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
      leads,
      budget,
      leadPages: 0,
      searches: 0,
      leadCollectionAttempted: false,
      researchedLeads: new Set<number>(),
      source: {
        api: {
          request: (_method: string, endpoint: string) => {
            budget.charge("GET", endpoint, 1, 100, "200");
            if (endpoint.includes("/releases?")) return { body: [] };
            requests.push(endpoint);
            return {
              body:
                requests.length <= driftingFamilies
                  ? page([item(99 + requests.length)], 52)
                  : page([]),
            };
          },
        },
      },
    });
    session.discover();
    assert.equal(
      requests.length,
      leadFamilyIds.length,
      "continue beyond six pages across independent families",
    );
    assert.equal(
      requests.filter((r) => decodeURIComponent(r).includes("recompiled in:")).length,
      1,
      "never retry the drifting family in this session",
    );
    assert.equal(
      session.leadPages,
      leadFamilyIds.length - driftingFamilies,
      "refused page is not validated coverage",
    );
    assert.equal(session.leads.slices["new-recompiled"]?.page, 1);
    assert.equal(session.leads.slices["new-recompiled"]?.completed_at, undefined);
    assert.equal(session.leads.records["1"]?.id, 1, "prior lead survives discarded pagination");
    assert.equal(
      session.leads.records["100"]?.id,
      100,
      "validated identities on drift page survive",
    );
    assert.equal(session.leadWorkComplete(), false, "research protection remains");
    session.researchedLeads.add(1);
    session.researchedLeads.add(2);
    assert.equal(
      session.leadWorkComplete(),
      true,
      "bounded partial search effort permits rotation",
    );
    const calls = requests.length;
    session.discover();
    assert.equal(requests.length, calls, "repeat discover does not retry any page");
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
  for (let n = 0; n < leadSearchFamilyCount - 1; n++)
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
  assert.throws(
    () =>
      acceptLeadPage(next, nextLeadPage(next, now), page([item(100), item(100)], 52), now, "bad"),
    /Duplicate or malformed lead identity/,
    "count drift must not mask fatal page identity errors",
  );
  assert.throws(
    () =>
      acceptLeadPage(
        next,
        nextLeadPage(next, now),
        page([item(1, "foreign/renamed")], 52),
        now,
        "bad",
      ),
    /count changed/,
    "a same-ID rename does not excuse incomplete pagination",
  );
});
void test("query overlap deduplicates IDs, preserves disposition and requeues same-ID relocation", () => {
  let state = parseLeadState(undefined);
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "first");
  state.records["1"]!.status = "held";
  state.records["1"]!.disposition = { reason: "experimental", resume: "usable upstream setup" };
  state = acceptLeadPage(state, nextLeadPage(state, now), page([item(1)]), now, "second");
  assert.equal(Object.keys(state.records).length, 1);
  assert.equal(state.records["1"]!.status, "held");
  const renamed = acceptLeadPage(
    state,
    nextLeadPage(state, now),
    page([item(1, "other/game")]),
    now,
    "renamed",
  );
  assert.equal(Object.keys(renamed.records).length, 1);
  assert.equal(renamed.records["1"]?.repository, "other/game");
  assert.deepEqual(renamed.records["1"]?.aliases, ["ports/game-1"]);
  assert.equal(renamed.records["1"]?.status, "pending", "renew primary evidence after transfer");
  assert.equal(state.records["1"]?.status, "held", "previous state is immutable");
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
  for (const [id, repository, description] of [
    [2, "btraceio/btrace", "Production-safe tracing for Java with no restart or recompilation"],
    [3, "lists/awesome-game-decompilations", "A curated list of game decompilations"],
    [4, "engine/PS2Recomp", "Static Recompiler & Runtime Tool to make native PC ports"],
  ] as const) {
    state.records[String(id)] = {
      ...state.records["1"],
      id,
      repository,
      url: `https://github.com/${repository}`,
      description,
    };
  }
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
          assert.doesNotMatch(
            endpoint,
            /sort=created/u,
            "repository search must not rely on an unsupported sort field",
          );
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
  assert.equal(calls, leadFamilyIds.length);
  assert.equal(budget.usage.requests, leadFamilyIds.length + 4);
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
  assert.equal(pendingLeads(restored, new Set(), Date.parse(now)).length, leadFamilyIds.length - 3);
  const constrained = new DiscoveryBudget("ordinary");
  constrained.reserveDelivery(190, 1024);
  Object.assign(session, {
    budget: constrained,
    leadFamilies: new Set(),
    deferredLeadFamilies: new Set(),
    searches: 0,
    leadCollectionAttempted: false,
    leadPages: 0,
    leads: parseLeadState(undefined),
  });
  session.discover();
  assert.equal(calls, leadFamilyIds.length, "reserve refusal must happen before HTTP");
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

void test("pre-integration Switch fork scope retires page two while published family cursors retain meaning", () => {
  const state = parseLeadState(undefined);
  state.next_family = 23;
  assert.equal(
    nextLeadPage(parseLeadState(JSON.parse(JSON.stringify(state))), now).family,
    "xboxrecomp-topic",
  );
  state.next_family = 24;
  const first = nextLeadPage(state, now);
  state.slices[first.family] = {
    ...first.slice,
    page: 2,
    seen: [111],
    terms: first.slice.terms!.replace(" [fork:true]", ""),
  };
  const plan = nextLeadPage(parseLeadState(JSON.parse(JSON.stringify(state))), now);
  assert.equal(plan.retired, true);
  assert.equal(plan.page, 1);
  assert.deepEqual(plan.slice.seen, []);
  assert.match(plan.query, /fork:true$/u);
  const accepted = acceptLeadPage(state, plan, page([]), now, "new-fork-scope");
  assert.equal(accepted.retired_slices?.[first.family]?.page, 2);
  assert.deepEqual(accepted.retired_slices?.[first.family]?.seen, [111]);
  assert.equal(accepted.slices[first.family]?.completed_at, now);
});
void test("partial family effort requires six observed families and the same primary investigations", () => {
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  let leads = parseLeadState(undefined);
  leads = acceptLeadPage(leads, nextLeadPage(leads, now), page([item(1), item(2)]), now, "pending");
  Object.assign(session, {
    inventory: { issues: [] },
    journal: { started_at: now },
    leads,
    leadCollectionAttempted: true,
    leadPages: 0,
    leadFamilies: new Set(leadFamilyIds.slice(0, 5)),
    researchedLeads: new Set([1, 2]),
  });
  assert.equal(
    session.leadWorkComplete(),
    false,
    "five observed families do not spend the six-family partial effort",
  );
  session.leadFamilies.add(leadFamilyIds[5]!);
  assert.equal(session.leadWorkComplete(), true);
  session.researchedLeads.delete(2);
  assert.equal(
    session.leadWorkComplete(),
    false,
    "family effort does not replace primary investigation",
  );
  session.leadPages = 4;
  session.leadFamilies.clear();
  session.researchedLeads.add(2);
  assert.equal(
    session.leadWorkComplete(),
    true,
    "four validated pages remain the original alternate bound",
  );
});

void test("retained leads exceed 10000 identities without truncation and enforce the shared physical envelope", () => {
  const state = retainLeadResults(
    parseLeadState(undefined),
    Array.from({ length: 12001 }, (_, index) => item(index + 1)),
    now,
    "primary-evidence",
  );
  const reloaded = parseLeadState(JSON.parse(JSON.stringify(state)));
  assert.equal(Object.keys(reloaded.records).length, 12001);
  const next = retainLeadResults(reloaded, [item(12002)], now, "next-bounded-batch");
  assert.equal(Object.keys(next.records).length, 12002);
  assert.equal(next.records["1"]!.id, 1);
  assert.equal(Object.keys(reloaded.records).length, 12001);
  assert.throws(
    () =>
      retainLeadResults(
        reloaded,
        [{ ...item(12003), description: "x".repeat(32 * 1024 * 1024) }],
        now,
        "oversized-response",
      ),
    /byte envelope/u,
  );
  assert.equal(Object.keys(reloaded.records).length, 12001);
  assert.throws(
    () => retainLeadResults(reloaded, [item(12004, "ports/game-1")], now, "identity-conflict"),
    /identity changed/u,
  );
});
