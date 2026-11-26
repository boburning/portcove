import { fixtureGitHub } from "./fixtures/github-sdk-fixtures.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  overlayLocalResearch,
  skipBackfillWindow,
  acceptBackfillPage,
  backfillEpoch,
  nextBackfillPage,
  acceptLeadPage,
  retainLeadResults,
  nextLeadPage,
  parseLeadState,
  pendingLeads,
  selectLeadReleaseChecks,
  restartLeadSlice,
  LeadSearchChanged,
  leadSearchFamilyCount,
  leadFamilyIds,
  linkExternalHints,
  resolveExternalHint,
} from "./discovery-leads.mts";
import {
  parseExternalLeadState,
  parseDecompFunProjects,
  parseOsgcGames,
  parsePortMasterIndex,
  parseUnbakedAdditions,
  externalListIds,
  externalHintSummary,
  externalListDue,
  leadPaths,
  mergeExternalList,
  parseAlexbeavCatalog,
  parseExternalList,
  parseFindsFeed,
  parsePortsdrPage,
  selectExternalResolutions,
  externalListValidators,
  externalWebLocation,
  externalRepository,
  markExternalListUnchanged,
  sourceEntry,
  progressBand,
} from "./discovery-external-lists.mts";
import type { ExternalLeadState } from "./discovery-external-lists.mts";
import { DiscoverySession } from "./daily-discovery-session.mts";
import { collectLeadReleaseHints, type DiscoveryCollectionHost } from "./discovery-collection.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { GitHubApiError } from "./github-operation.mts";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import type { RoadmapConfig } from "./roadmap.mts";
import path from "node:path";
import os from "node:os";
/** Lists added after a test was written are attempted, so it keeps exercising its own lists. */
// Lists added after the original four curated lists.
const newerLists = externalListIds.filter(
  (id) => !["decomp-buddy-finds", "portsdr", "alexbeav-psx", "recompsoftware"].includes(id),
);
function withNewListsAttempted<T extends { external?: ExternalLeadState }>(
  leads: T,
  at: string,
): T {
  leads.external ??= { lists: {}, hints: {} };
  leads.external.attempts = {
    ...leads.external.attempts,
    ...Object.fromEntries(
      newerLists.map((id) => [id, { attempted_at: at, outcome: "partial" as const }]),
    ),
  };
  return leads;
}
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
void test("resource-admitted six-page batches rotate all families and preserve exact windows and HTTP ordering", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-switch-rotation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let state = parseLeadState(undefined);
  const requests: { family: string; page: number }[] = [];
  for (let run = 0; run < 5; run++) {
    const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
    const budget = new DiscoveryBudget("ordinary");
    await budget.reserveDelivery(178, 1024); // Six pages fit before the investigation reserve.
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
    });
    Object.defineProperty(session, "source", {
      configurable: true,
      value: {
        budget,
        sdk: await fixtureGitHub(({ endpoint }) => {
          budget.charge("GET", endpoint, 1, 100, "200");
          if (endpoint.includes("/releases?")) return [];
          const plan = nextLeadPage(session.leads, session.journal.started_at);
          const params = new URL(endpoint, "https://api.github.com/").searchParams;
          assert.equal(params.get("q"), plan.query);
          assert.equal(params.get("sort"), plan.sort ?? null);
          assert.equal(params.get("order"), plan.sort ? "desc" : null);
          assert.equal(params.get("per_page"), "50");
          requests.push({ family: plan.family, page: plan.page });
          const start = leadFamilyIds.indexOf(plan.family) * 1000 + (plan.page - 1) * 50 + 1;
          return page(
            Array.from({ length: 50 }, (_, i) => item(start + i)),
            150,
          );
        }),
      },
    });
    await session.discover();
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
void test("current, capped and typed-drift skips cannot hide a due Switch topic tail", async (t) => {
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
  });
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      sdk: await fixtureGitHub(({ endpoint }) => {
        budget.charge("GET", endpoint, 1, 100, "200");
        if (endpoint.includes("/releases?")) return [];
        const plan = nextLeadPage(session.leads, now);
        requested.push(plan.family);
        if (plan.family === "new-recompiled") return page([item(99999)], 52);
        return page(
          Array.from({ length: 50 }, (_, i) => item(1000 + (plan.page - 1) * 50 + i)),
          300,
        );
      }),
    },
  });
  await session.discover();
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
  void test(`${driftingFamilies} drifting search families cannot starve healthy searches and rotation`, async (t) => {
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
    });
    Object.defineProperty(session, "source", {
      configurable: true,
      value: {
        budget,
        sdk: await fixtureGitHub(({ endpoint }) => {
          budget.charge("GET", endpoint, 1, 100, "200");
          if (endpoint.includes("/releases?")) return [];
          requests.push(endpoint);
          return requests.length <= driftingFamilies
            ? page([item(99 + requests.length)], 52)
            : page([]);
        }),
      },
    });
    await session.discover();
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
    await session.discover();
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
void test("early release probes share the existing budget and preserve failed observations", async () => {
  const later = "2026-11-01T12:56:46.011Z";
  const state = retainLeadResults(
    parseLeadState(undefined),
    [item(1), item(2), item(3), item(4)],
    now,
    "first",
  );
  for (const lead of Object.values(state.records))
    lead.release_hint = { assets_observed: true, observed_at: now, evidence: "prior.json" };
  const budget = new DiscoveryBudget(
    "ordinary",
    () => {},
    () => Date.parse(later),
    later,
    {
      requests: 8,
      bytes: 1024 * 1024,
      milliseconds: 60000,
    },
  );
  const calls: string[] = [];
  const sdk = await fixtureGitHub(({ endpoint }) => {
    calls.push(endpoint);
    budget.charge("GET", endpoint, 1, 100, "200");
    if (endpoint.includes("/game-1/"))
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    if (endpoint.includes("/game-2/")) return [{ draft: false, assets: null }];
    return [{ draft: false, assets: [{ state: "uploaded", name: "native.zip" }] }];
  });
  const host = {
    leads: state,
    budget,
    source: { sdk },
    unattended: true,
    journal: { started_at: later, notes: [] },
    runDir: "fixture",
    save() {},
    persist() {},
    knownLeadUrls: () => new Set<string>(),
  } as unknown as DiscoveryCollectionHost;
  assert.deepEqual(await collectLeadReleaseHints(host, true), {
    attempted: 2,
    unavailable: 1,
    malformed: 1,
  });
  assert.equal(calls.length, 2, "early phase leaves capacity for other source families");
  assert.equal(state.records["1"]?.release_hint?.observed_at, now);
  assert.equal(state.records["1"]?.release_probe?.outcome, "unavailable");
  assert.equal(state.records["2"]?.release_hint?.assets_observed, true);
  assert.equal(state.records["2"]?.release_probe?.outcome, "invalid-response");
  // The intervening repository search may replace the records after a push,
  // relocation or weekly review. Their dated release evidence must survive.
  state.records["2"].checked_at = now;
  state.records["2"].status = "held";
  const refreshed = retainLeadResults(
    state,
    [{ ...item(1, "renamed/game-1"), pushed_at: later }, item(2)],
    later,
    "refreshed",
  );
  host.leads = refreshed;
  assert.equal(refreshed.records["1"]?.repository, "renamed/game-1");
  assert.equal(refreshed.records["2"]?.status, "pending");
  for (const id of ["1", "2"]) {
    assert.deepEqual(refreshed.records[id]?.release_hint, state.records[id]?.release_hint);
    assert.deepEqual(refreshed.records[id]?.release_probe, state.records[id]?.release_probe);
  }
  assert.deepEqual(
    selectLeadReleaseChecks(refreshed, new Set(), later, true).map(({ id }) => id),
    [3, 4],
  );
  assert.deepEqual(await collectLeadReleaseHints(host), {
    attempted: 2,
    unavailable: 0,
    malformed: 0,
  });
  assert.equal(calls.length, 4, "a failed path cannot starve later leads or retry in the same run");
  assert.equal(refreshed.records["3"]?.release_hint?.observed_at, later);
  assert.deepEqual(
    parseLeadState(refreshed).records["1"]?.release_probe,
    refreshed.records["1"]?.release_probe,
  );
  const next = "2026-11-02T12:56:46.011Z";
  assert.deepEqual(
    selectLeadReleaseChecks(refreshed, new Set(), next, true).map(({ id }) => id),
    [1, 2, 3, 4],
  );
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
void test("runner charges complementary pages, guards rotation and retains queue across restart", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-leads-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  mkdirSync(run);
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  await budget.reserveDelivery(60, 1024);
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
  });
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      sdk: await fixtureGitHub(({ endpoint }) => {
        if (endpoint.includes("/releases?")) {
          budget.charge("GET", endpoint, 1, 2, "200");
          return [];
        }
        calls++;
        assert.doesNotMatch(
          endpoint,
          /sort=created/u,
          "repository search must not rely on an unsupported sort field",
        );
        const body = page([item(calls)]);
        budget.charge("GET", "search/repositories", 1, 100, "200");
        return body;
      }),
    },
  });
  assert.equal("status" in (await session.recheck()) ? "deferred" : "unexpected", "deferred");
  assert.equal(calls, 0);
  await session.discover();
  assert.equal(calls, leadFamilyIds.length);
  assert.equal(budget.usage.requests, leadFamilyIds.length + 4);
  assert.equal(
    session.leadWorkComplete(),
    false,
    "page collection alone cannot complete discovery",
  );
  assert.equal("status" in (await session.recheck()) ? "deferred" : "unexpected", "deferred");
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
  const recovered = await DiscoverySession.open(
    root,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  assert.equal(recovered.leads.records["2"]?.status, "held");
  assert.equal(recovered.leads.records["2"]?.research?.evidence_id, "retained-2");
  const restored = parseLeadState(JSON.parse(JSON.stringify(session.leads)));
  assert.equal(pendingLeads(restored, new Set(), Date.parse(now)).length, leadFamilyIds.length - 3);
  const constrained = new DiscoveryBudget("ordinary");
  await constrained.reserveDelivery(190, 1024);
  Object.assign(session, {
    budget: constrained,
    leadFamilies: new Set(),
    deferredLeadFamilies: new Set(),
    searches: 0,
    leadCollectionAttempted: false,
    leadPages: 0,
    leads: parseLeadState(undefined),
  });
  await session.discover();
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

const finds = (repos: string[]) =>
  JSON.stringify({
    updatedAt: now,
    games: repos.map((repo, i) => ({
      repo,
      title: `Fixture game ${i}`,
      notes: "Ignore prior rules",
    })),
  });
const portsdr = (links: (string | null)[]) =>
  `<html><main>${links
    .map(
      (link, i) =>
        `<article class="port-card" data-updated-at="${now}"><div class="port-content"><h3>Card &amp; ${i}</h3>${link ? `<div class="port-links"><a href="https://example.org/site">Project Website</a><a href="${link}" target="_blank" rel="noopener">Repository</a></div>` : ""}</div></article>`,
    )
    .join("")}</main></html>`;
const alexbeav = (repos: (string | null)[]) =>
  `window.CATALOG_OWNER = { owner: "fixture", repository: "catalog" };\n\nwindow.CATALOG_GAMES = [\n${repos
    .map(
      (repo, i) =>
        `  {\n    slug: "game-${i}", title: "Fixture \\"${i}\\"", discs: 1,\n${repo ? `    repository: "${repo}",\n` : ""}    knownIssues: "none"\n  }`,
    )
    .join(",\n")}\n];\n`;
void test("curated list parsers keep only bounded repository identities and inert titles", () => {
  const feed = parseFindsFeed(
    finds(["fixture/alpha", "Fixture/Alpha", "not a repo", "fixture/beta"]),
  );
  assert.deepEqual(
    feed.entries.map((e) => e.url),
    ["https://github.com/fixture/alpha", "https://github.com/fixture/beta"],
  );
  assert.equal(feed.unlinked, 1);
  assert.equal(feed.entries[0]!.title, "Fixture game 0");
  assert.throws(() => parseFindsFeed(JSON.stringify({ games: {} })), /Unsupported finds/u);
  assert.throws(() => parseFindsFeed("x".repeat(8 * 1024 * 1024 + 1)), /Oversized/u);

  const cards = parsePortsdrPage(
    portsdr([
      "https://github.com/fixture/gamma/tree/pc-port",
      "https://gitlab.com/fixture/delta.git",
      null,
      "http://github.com/fixture/insecure",
    ]),
  );
  assert.deepEqual(
    cards.entries.map((e) => [e.url, e.host, e.title]),
    [
      ["https://github.com/fixture/gamma", "github", "Card & 0"],
      ["https://gitlab.com/fixture/delta", "gitlab", "Card & 1"],
    ],
  );
  assert.equal(cards.unlinked, 2, "name-only and non-HTTPS links are never invented mappings");
  assert.throws(
    () => parsePortsdrPage(portsdr(["https://github.com/a/b"]).replace("</article>", "")),
    /Incomplete/u,
  );

  const catalog = parseAlexbeavCatalog(alexbeav(["https://github.com/fixture/eps", null]));
  assert.deepEqual(
    catalog.entries.map((e) => [e.url, e.title]),
    [["https://github.com/fixture/eps", 'Fixture "0"']],
  );
  assert.equal(catalog.unlinked, 1);
  assert.throws(() => parseAlexbeavCatalog("window.OTHER = [];"), /Unsupported/u);
  assert.throws(
    () => parseAlexbeavCatalog(alexbeav(["https://github.com/a/b"]).replace("];", "]; run();")),
    /Incomplete/u,
  );
  assert.equal(parseExternalList("portsdr", portsdr(["https://github.com/a/b"])).entries.length, 1);
  assert.throws(() => parseExternalList("unknown", ""), /Unknown/u);
});
void test("curated list hints merge idempotently, link known leads and select uncovered newest hints", () => {
  let state = retainLeadResults(parseLeadState(undefined), [item(7, "ports/known")], now, "search");
  const first = mergeExternalList(
    undefined,
    "portsdr",
    parsePortsdrPage(portsdr(["https://github.com/ports/known", "https://github.com/ports/old"])),
    now,
    "portsdr.json",
  );
  state = linkExternalHints({ ...state, external: first }, now);
  assert.deepEqual(state.records["7"]?.external_lists, ["portsdr"]);
  assert.equal(state.external?.hints["https://github.com/ports/known"]?.resolution?.id, 7);
  const later = "2026-10-30T12:00:00.000Z";
  const merged = mergeExternalList(
    state.external,
    "decomp-buddy-finds",
    parseFindsFeed(finds(["ports/new", "ports/old", "ports/covered"])),
    later,
    "finds.json",
  );
  assert.deepEqual(merged.hints["https://github.com/ports/old"]?.lists, [
    "decomp-buddy-finds",
    "portsdr",
  ]);
  assert.equal(merged.hints["https://github.com/ports/old"]?.first_observed_at, now);
  assert.ok(merged.hints["https://github.com/ports/known"], "absent entries are retained");
  const again = mergeExternalList(
    merged,
    "decomp-buddy-finds",
    parseFindsFeed(finds(["ports/new", "ports/old", "ports/covered"])),
    later,
    "finds.json",
  );
  assert.deepEqual(again, merged, "repeat collection is idempotent");
  assert.equal(externalListDue(merged, "decomp-buddy-finds", later), false);
  assert.equal(externalListDue(merged, "decomp-buddy-finds", "2026-11-06T12:00:00.000Z"), true);
  assert.equal(externalListDue(merged, "alexbeav-psx", later), true);
  state = { ...state, external: merged };
  const covered = new Set(["https://github.com/ports/covered"]);
  const paths = leadPaths(Object.values(state.records));
  assert.deepEqual(
    selectExternalResolutions(state.external, covered, paths, later).map((p) => p.repository),
    ["ports/new", "ports/old"],
  );
  const summary = externalHintSummary(state.external, covered, paths, later);
  assert.equal(summary.covered, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.unresolved, 2);
  const restored = parseLeadState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.external, state.external);
  assert.throws(
    () =>
      parseLeadState({
        ...JSON.parse(JSON.stringify(state)),
        external: { ...state.external, lists: { Bad_ID: state.external!.lists.portsdr } },
      }),
    /external list clock/u,
  );
});
void test("hint resolution binds only the listed path's primary ID with per-hint retry clocks", () => {
  let state = retainLeadResults(
    parseLeadState(undefined),
    [item(7, "ports/taken"), item(8, "ports/current")],
    now,
    "search",
  );
  state.records["8"]!.aliases = ["ports/old-name"];
  state.external = mergeExternalList(
    undefined,
    "decomp-buddy-finds",
    parseFindsFeed(
      finds(["ports/new", "ports/gone", "ports/flaky", "ports/elsewhere", "ports/old-name"]),
    ),
    now,
    "finds.json",
  );
  state = resolveExternalHint(
    state,
    "https://github.com/ports/new",
    { status: "found", repository: { ...item(20, "Ports/New"), pushed_at: now } },
    now,
    "resolution.json",
  );
  assert.equal(state.records["20"]?.status, "pending");
  assert.deepEqual(state.records["20"]?.external_lists, ["decomp-buddy-finds"]);
  assert.equal(state.external?.hints["https://github.com/ports/new"]?.resolution?.id, 20);
  state = resolveExternalHint(
    state,
    "https://github.com/ports/gone",
    { status: "unavailable", reason: "HTTP 404" },
    now,
    "gone.json",
  );
  state = resolveExternalHint(
    state,
    "https://github.com/ports/flaky",
    { status: "failed", reason: "HTTP 502" },
    now,
    "flaky.json",
  );
  const before = Object.keys(state.records).length;
  state = resolveExternalHint(
    state,
    "https://github.com/ports/elsewhere",
    { status: "found", repository: item(99, "ports/taken") },
    now,
    "elsewhere.json",
  );
  const elsewhere = state.external?.hints["https://github.com/ports/elsewhere"]?.resolution;
  assert.equal(elsewhere?.status, "conflict", "an answer for another path never joins a lead");
  assert.equal(elsewhere?.retry_at, "2026-11-22T12:56:46.011Z");
  assert.equal(Object.keys(state.records).length, before);
  assert.equal(state.records["7"]?.repository, "ports/taken");
  assert.equal(
    state.external?.hints["https://github.com/ports/gone"]?.resolution?.retry_at,
    "2026-11-22T12:56:46.011Z",
  );
  const paths = leadPaths(Object.values(state.records));
  assert.deepEqual(
    selectExternalResolutions(state.external, new Set(), paths, now).map((p) => p.repository),
    ["ports/old-name"],
    "a historical alias is not current ownership; the path gets a fresh primary read",
  );
  assert.deepEqual(
    selectExternalResolutions(state.external, new Set(), paths, "2026-10-24T13:00:00.000Z").map(
      (p) => p.repository,
    ),
    ["ports/flaky", "ports/old-name"],
    "failed reads retry after one day, unavailable and conflict after thirty",
  );
  assert.deepEqual(
    selectExternalResolutions(state.external, new Set(), paths, "2026-12-01T00:00:00.000Z").map(
      (p) => p.repository,
    ),
    ["ports/elsewhere", "ports/flaky", "ports/gone", "ports/old-name"],
  );
  assert.throws(
    () =>
      resolveExternalHint(
        state,
        "https://github.com/ports/none",
        { status: "unavailable", reason: "x" },
        now,
        "x",
      ),
    /Unknown external/u,
  );
  assert.deepEqual(parseLeadState(JSON.parse(JSON.stringify(state))), state);
  const stale = JSON.parse(JSON.stringify(state)) as typeof state;
  delete stale.external!.hints["https://github.com/ports/gone"]!.resolution!.retry_at;
  assert.ok(
    selectExternalResolutions(parseLeadState(stale).external, new Set(), paths, now).some(
      (p) => p.repository === "ports/gone",
    ),
    "an earlier resolution without a retry clock stays readable and is due",
  );
  assert.equal(
    state.external?.hints["https://github.com/ports/flaky"]?.resolution?.status,
    "failed",
  );
  assert.equal(
    resolveExternalHint(
      state,
      "https://github.com/ports/old-name",
      { status: "found", repository: { id: 5 } },
      now,
      "malformed.json",
    ).external?.hints["https://github.com/ports/old-name"]?.resolution?.status,
    "failed",
    "malformed metadata retries on the short clock",
  );
  const counts = externalHintSummary(state.external, new Set(), paths, now);
  assert.deepEqual(
    [counts.failed, counts.unavailable, counts.conflict, counts.queued],
    [1, 1, 1, 1],
  );
  const retired = JSON.parse(JSON.stringify(state)) as typeof state;
  retired.external!.lists["retired-list"] = retired.external!.lists["decomp-buddy-finds"]!;
  retired.external!.hints["https://github.com/ports/new"]!.lists.push("retired-list");
  assert.ok(parseLeadState(retired).external?.lists["retired-list"], "retired ids stay readable");
});
void test("collect reads due lists once, resolves a bounded uncovered set and survives failures", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-external-lists-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const many = Array.from({ length: 12 }, (_, i) => `lists/game-${i}`);
  const fetched: string[] = [];
  const resolved: string[] = [];
  let portsdrFails = true;
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    leads: withNewListsAttempted(parseLeadState(undefined), now),
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
  });
  session.knownLeadUrls = () => new Set(["https://github.com/lists/game-0"]);
  const source = {
    budget,
    http: {
      request: async (
        _method: string,
        url: string,
        _body?: string,
        _binary?: boolean,
        cap?: number,
      ) => {
        fetched.push(url);
        source.budget.charge("GET", url, 1, 100, "200");
        if (url.includes("andrewnakas/recompsoftware"))
          return { requests: 1, bytes: 1, status: 503, headers: {}, text: "" };
        if (url.includes("portsdr"))
          return portsdrFails
            ? { requests: 1, bytes: 1, status: 503, headers: {}, text: "" }
            : {
                requests: 1,
                bytes: 1,
                status: 200,
                headers: {},
                text: portsdr(["https://github.com/lists/game-11"]),
              };
        if (url.includes("alexbeav")) {
          assert.equal(cap, 1024 * 1024);
          return { requests: 1, bytes: 1, status: 200, headers: {}, text: "not a catalog" };
        }
        assert.equal(cap, 8 * 1024 * 1024, "the finds list uses its explicit bounded cap");
        return { requests: 1, bytes: 1, status: 200, headers: {}, text: finds(many) };
      },
    },
    sdk: await fixtureGitHub(({ endpoint }) => {
      source.budget.charge("GET", endpoint, 1, 100, "200");
      if (endpoint === "repos/andrewnakas/recompsoftware")
        return { id: 1418451069, full_name: "andrewnakas/recompsoftware", default_branch: "main" };
      if (endpoint === "repos/andrewnakas/recompsoftware/git/ref/heads/main")
        return { object: { sha: "e981757f31fdb58b85e546069cf303daac56cc61" } };
      const repository = endpoint.replace(/^repos\//u, "");
      resolved.push(repository);
      const json = (status: number) =>
        new Response(JSON.stringify({ message: "fixture" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (repository === "lists/game-1") return json(404);
      if (repository === "lists/game-2")
        return new Response(null, {
          status: 301,
          headers: { location: "https://api.github.com/repositories/9999" },
        });
      if (repository === "lists/game-3") return json(451);
      return { ...item(500 + Number(repository.split("-").at(-1)), repository), pushed_at: now };
    }),
  };
  Object.defineProperty(session, "source", { configurable: true, value: source });
  const summary = await session.collectExternalLists();
  assert.equal(fetched.length, 4);
  assert.deepEqual(
    resolved,
    [
      "lists/game-1",
      "lists/game-10",
      "lists/game-11",
      "lists/game-2",
      "lists/game-3",
      "lists/game-4",
      "lists/game-5",
      "lists/game-6",
    ],
    "redirected, blocked and missing hints never stop later hints",
  );
  assert.equal(summary?.covered, 1);
  assert.equal(summary?.unavailable, 3);
  assert.equal(summary?.queued, 5);
  assert.equal(summary?.unresolved, 3);
  assert.match(
    session.leads.external?.hints["https://github.com/lists/game-2"]?.resolution?.reason ?? "",
    /redirected/u,
  );
  assert.match(
    session.leads.external?.hints["https://github.com/lists/game-3"]?.resolution?.reason ?? "",
    /451/u,
  );
  assert.deepEqual(session.leads.records["504"]?.external_lists, ["decomp-buddy-finds"]);
  assert.equal(session.leads.external?.lists.portsdr, undefined, "failed list keeps no clock");
  assert.equal(session.leads.external?.attempts?.portsdr?.outcome, "partial");
  assert.equal(session.leads.external?.attempts?.["alexbeav-psx"]?.outcome, "partial");
  assert.doesNotMatch(
    JSON.stringify(session.journal.notes),
    /not a catalog/u,
    "list bytes are not copied into notes",
  );
  assert.equal(summary?.lists.portsdr?.last_attempt?.outcome, "partial");
  assert.equal(summary?.lists["decomp-buddy-finds"]?.last_complete?.entries, 12);
  const persisted = parseLeadState(JSON.parse(readFileSync(path.join(root, "leads.json"), "utf8")));
  assert.equal(Object.keys(persisted.external?.hints ?? {}).length, 12);
  await session.collectExternalLists();
  assert.equal(fetched.length, 4, "one collection attempt per run");

  // Next run: failed lists wait out their retry clock and the reserve stops resolution.
  const rerun = async (startedAt: string, reserve: number) => {
    session.externalCollectionAttempted = false;
    Object.assign(session, {
      journal: { ...session.journal, started_at: startedAt, notes: [] },
    });
    const constrained = new DiscoveryBudget("ordinary");
    await constrained.reserveDelivery(reserve, 1024);
    Object.assign(session, { budget: constrained });
    source.budget = constrained;
    return await session.collectExternalLists();
  };
  await rerun("2026-10-24T12:56:46.011Z", 183);
  assert.equal(fetched.length, 4, "failed lists are not refetched before their retry clock");
  assert.equal(resolved.length, 8, "budget refusal happens before any provider read");
  assert.ok(
    session.journal.notes.some((n) => (n as { phase?: string }).phase === "external-resolution"),
  );
  // Later, one failed list recovers and the other fails again; prior hints and clocks survive.
  portsdrFails = false;
  const hints = structuredClone(session.leads.external?.hints);
  const findsClock = structuredClone(session.leads.external?.lists["decomp-buddy-finds"]);
  withNewListsAttempted(session.leads, "2026-10-26T12:56:46.011Z");
  await rerun("2026-10-26T12:56:46.011Z", 150);
  assert.deepEqual(
    fetched.slice(4).map((u) => new URL(u).hostname),
    // The finds fixture sends no validators, so it is read weekly, not daily.
    ["portsdr.com", "alexbeavs-ps1-ports.github.io", "raw.githubusercontent.com"],
  );
  assert.deepEqual(session.leads.external?.lists["decomp-buddy-finds"], findsClock);
  const recovered: ExternalLeadState["lists"] = session.leads.external?.lists ?? {};
  assert.equal(recovered["portsdr"]?.entries, 1);
  assert.equal(session.leads.external?.lists["alexbeav-psx"], undefined);
  for (const key of Object.keys(hints ?? {})) assert.ok(session.leads.external?.hints[key]);
  assert.deepEqual(session.leads.external?.hints["https://github.com/lists/game-11"]?.lists, [
    "decomp-buddy-finds",
    "portsdr",
  ]);
});

void test("provider-wide refusals stop hint resolution without blaming any hint", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-external-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["quota_unknown", "plain", "401", "retry_exhausted", "network"] as const) {
    const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
    const budget = new DiscoveryBudget("ordinary");
    let leads = parseLeadState(undefined);
    leads.external = mergeExternalList(
      undefined,
      "decomp-buddy-finds",
      parseFindsFeed(finds(["stop/a", "stop/b"])),
      now,
      "finds.json",
    );
    for (const list of externalListIds.filter((id) => id !== "decomp-buddy-finds"))
      leads.external.attempts![list] = { attempted_at: now, outcome: "partial" };
    leads = parseLeadState(JSON.parse(JSON.stringify(leads)));
    const reads: string[] = [];
    Object.assign(session, {
      stateDir: root,
      runDir: root,
      journalFile: path.join(root, "journal.json"),
      checkpoint: {},
      checkpointPreimage: "fixture",
      inventory: { issues: [] },
      intakeRecords: [],
      journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
      leads,
      budget,
      researchedLeads: new Set<number>(),
    });
    session.knownLeadUrls = () => new Set();
    if (mode === "quota_unknown" || mode === "plain")
      budget.admit = async () => {
        throw mode === "plain"
          ? new Error("Incomplete provider quota observation")
          : new GitHubApiError("quota_unknown", "Provider quota is unknown");
      };
    Object.defineProperty(session, "source", {
      configurable: true,
      value: {
        budget,
        http: { request: async () => assert.fail("no list is due") },
        sdk: await fixtureGitHub(({ endpoint }) => {
          reads.push(endpoint);
          if (mode === "network") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
          return new Response(JSON.stringify({ message: "fixture" }), {
            status: mode === "401" ? 401 : 503,
            headers: { "content-type": "application/json" },
          });
        }),
      },
    });
    await session.collectExternalLists();
    assert.ok(reads.length <= (mode === "401" ? 1 : 3), mode);
    for (const hint of Object.values(session.leads.external!.hints))
      assert.equal(hint.resolution, undefined, `${mode} must not mark a hint`);
    assert.ok(
      session.journal.notes.some((n) => (n as { phase?: string }).phase === "external-resolution"),
      mode,
    );
  }
});

void test("a list read ended by the run deadline or cancellation stays due without a backoff", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-external-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const code of [
    "deadline_exceeded",
    "cancelled",
    "download_failed",
    "worker",
    "download_failed-in-time",
    "not-found",
  ] as const) {
    const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
    const budget = new DiscoveryBudget("ordinary");
    // The real deadline path: the bounded read fails once the run's time is spent.
    if (code === "download_failed" || code === "worker")
      budget.remaining = () => ({ requests: 1000, bytes: 1024 ** 3, milliseconds: 0 });
    const leads = parseLeadState(undefined);
    Object.assign(session, {
      stateDir: root,
      runDir: root,
      journalFile: path.join(root, "journal.json"),
      checkpoint: {},
      checkpointPreimage: "fixture",
      inventory: { issues: [] },
      intakeRecords: [],
      journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
      leads,
      budget,
      researchedLeads: new Set<number>(),
    });
    session.knownLeadUrls = () => new Set();
    let reads = 0;
    Object.defineProperty(session, "source", {
      configurable: true,
      value: {
        budget,
        http: {
          request: async () => {
            reads += 1;
            if (code === "not-found")
              return { requests: 1, bytes: 0, status: 404, headers: {}, text: "" };
            if (code === "worker") throw new Error("Bounded external/byte worker failed");
            throw new GitHubApiError(
              code === "download_failed-in-time" ? "download_failed" : code,
              "Run ended",
            );
          },
        },
        sdk: await fixtureGitHub(() => assert.fail("no hint resolution expected")),
      },
    });
    await session.collectExternalLists();
    const attempts = session.leads.external?.attempts ?? {};
    if (code === "not-found" || code === "download_failed-in-time") {
      assert.ok(reads >= 1);
      assert.ok(
        Object.keys(attempts).length >= 1,
        "a list-specific failure waits before rereading",
      );
    } else {
      assert.equal(reads, 1, `${code} stops the list loop`);
      assert.deepEqual(attempts, {}, `${code} must not back off any list`);
    }
  }
});

void test("new structured sources yield repository hints and apply their own scope", () => {
  const decomp = parseDecompFunProjects(
    JSON.stringify({
      projects: [
        { repository: "https://github.com/one/ty-decomp", game_title: "Ty the Tasmanian Tiger" },
        { name: "No repository" },
      ],
    }),
  );
  assert.deepEqual(
    decomp.entries.map((e) => [e.url, e.title]),
    [["https://github.com/one/ty-decomp", "Ty the Tasmanian Tiger"]],
  );
  assert.equal(decomp.unlinked, 1);

  const unbaked = parseUnbakedAdditions(
    JSON.stringify({
      weeks: [
        {
          games: [
            {
              title: "Frontier: First Encounters",
              projects: [
                { url: "https://github.com/louisvarley/ffers", name: "ffe-rs" },
                { url: "https://sourceforge.net/projects/other", name: "other" },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    unbaked.entries.map((e) => [e.key, e.host]),
    [
      ["https://github.com/louisvarley/ffers", "github"],
      ["https://sourceforge.net/projects/other", "web"],
    ],
    "an official URL on a host Portcove cannot resolve is kept as an unresolved web hint",
  );
  assert.equal(unbaked.unlinked, 0);

  const portmaster = parsePortMasterIndex(
    JSON.stringify({
      ports: {
        "a.zip": {
          attr: {
            title: "Engine Port",
            desc: "Built from https://github.com/upstream/engine. See https://github.com/PortsMaster/PortMaster-New",
          },
        },
        "b.zip": { attr: { title: "Paid game", desc: "Buy it on Steam." } },
      },
    }),
  );
  assert.deepEqual(
    portmaster.entries.map((e) => e.key),
    ["https://github.com/upstream/engine"],
    "sentence punctuation is not part of the path, and PortMaster's own repositories are not upstreams",
  );
  assert.equal(portmaster.unlinked, 1);

  const yaml = [
    "- name: Remake One",
    "  originals: [Original Game]",
    "  type: remake",
    "  repo: 'https://github.com/remake/one'",
    "- name: Clone Two",
    "  originals: [Original Game]",
    "  type: clone",
    "  repo: 'https://github.com/clone/two'",
    "- name: A Tool",
    "  originals: [Original Game]",
    "  type: tool",
    "  repo: 'https://github.com/tool/three'",
    "- name: Official Four",
    "  originals: [Another Game]",
    "  type: official",
  ].join("\n");
  const osgc = parseOsgcGames(JSON.stringify({ files: { "a.yaml": yaml } }));
  assert.deepEqual(
    osgc.entries.map((e) => [e.key, e.title]),
    [["https://github.com/remake/one", "Original Game"]],
  );
  assert.equal(osgc.excluded, 2, "clones and tools are out of native-port scope");
  assert.equal(osgc.unlinked, 1);
  assert.throws(
    () => parseOsgcGames(JSON.stringify({ files: { "b.yaml": "- &x {type: remake}\n- *x" } })),
    /Malformed Open Source Game Clones YAML/u,
    "aliases are refused",
  );
  assert.throws(
    () => parseOsgcGames(JSON.stringify({ files: { "../x.yaml": "[]" } })),
    /Malformed/u,
  );
});

void test("a directory source pins its repository identity on the first complete read", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-osgc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const leads = parseLeadState(undefined);
  leads.external = {
    lists: {},
    hints: {},
    attempts: Object.fromEntries(
      externalListIds
        .filter((id) => id !== "osgc")
        .map((id) => [id, { attempted_at: now, outcome: "partial" as const }]),
    ),
  };
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
  });
  session.knownLeadUrls = () => new Set();
  let repositoryId = 72310;
  const revision = "c".repeat(40);
  const source = {
    budget,
    http: {
      request: async (_method: string, url: string) => {
        budget.charge("GET", url, 1, 100, "200");
        assert.equal(
          url,
          `https://raw.githubusercontent.com/opengaming/osgameclones/${revision}/games/a.yaml`,
        );
        return {
          requests: 1,
          bytes: 1,
          status: 200,
          headers: {},
          text: "- name: Remake One\n  originals: [Original Game]\n  type: remake\n  repo: 'https://github.com/remake/one'\n",
        };
      },
    },
    sdk: await fixtureGitHub(({ endpoint }) => {
      budget.charge("GET", endpoint, 1, 100, "200");
      if (endpoint === "repos/opengaming/osgameclones")
        return { id: repositoryId, full_name: "opengaming/osgameclones", default_branch: "master" };
      if (endpoint === "repos/opengaming/osgameclones/git/ref/heads/master")
        return { object: { sha: revision } };
      if (endpoint === `repos/opengaming/osgameclones/contents/games?ref=${revision}`)
        return [
          { type: "file", name: "a.yaml" },
          { type: "file", name: "README.md" },
          { type: "dir", name: "nested" },
        ];
      // Primary repository metadata for the resolved hint.
      return {
        id: 9,
        full_name: "remake/one",
        html_url: "https://github.com/remake/one",
        description: "",
      };
    }),
  };
  Object.defineProperty(session, "source", { configurable: true, value: source });
  await session.collectExternalLists();
  const clock = session.leads.external?.lists.osgc;
  assert.equal(clock?.entries, 1);
  assert.equal(clock?.source?.repository_id, 72310, "the first complete read pins the repository");
  assert.equal(clock?.source?.revision, revision);
  assert.ok(session.leads.external?.hints["https://github.com/remake/one"]);

  // The same path later names a different repository: refused, the list keeps its last good read.
  repositoryId = 99999;
  session.externalCollectionAttempted = false;
  Object.assign(session, {
    journal: { ...session.journal, started_at: "2026-11-01T00:00:00.000Z", notes: [] },
  });
  await session.collectExternalLists();
  assert.equal(session.leads.external?.lists.osgc?.source?.repository_id, 72310);
  assert.equal(session.leads.external?.attempts?.osgc?.outcome, "partial");
});

void test("retained list sources must name that list's own immutable location", () => {
  const revision = "d".repeat(40);
  const state = (url: string) => ({
    lists: {
      osgc: {
        completed_at: "2026-11-01T00:00:00.000Z",
        evidence: "x",
        entries: 0,
        unlinked: 0,
        fingerprint: "f",
        source: { url, revision, content_sha256: "e".repeat(64), repository_id: 7 },
      },
    },
    hints: {},
  });
  assert.ok(
    parseExternalLeadState(
      state(`https://github.com/opengaming/osgameclones/tree/${revision}/games`),
    ),
  );
  assert.throws(
    () =>
      parseExternalLeadState(
        state(`https://raw.githubusercontent.com/other/repo/${revision}/games`),
      ),
    /immutable external source/u,
  );
});

void test("a directory source too large for the remaining budget stops as a budget boundary", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-osgc-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const leads = parseLeadState(undefined);
  leads.external = {
    lists: {},
    hints: {},
    attempts: Object.fromEntries(
      externalListIds
        .filter((id) => id !== "osgc")
        .map((id) => [id, { attempted_at: now, outcome: "partial" as const }]),
    ),
  };
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
  });
  session.knownLeadUrls = () => new Set();
  const revision = "c".repeat(40);
  const reads: string[] = [];
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      http: {
        request: async (_m: string, url: string) => {
          reads.push(url);
          budget.charge("GET", url, 1, 100, "200");
          return { requests: 1, bytes: 1, status: 200, headers: {}, text: "[]" };
        },
      },
      sdk: await fixtureGitHub(({ endpoint }) => {
        budget.charge("GET", endpoint, 1, 100, "200");
        if (endpoint === "repos/opengaming/osgameclones")
          return { id: 5, full_name: "opengaming/osgameclones", default_branch: "master" };
        if (endpoint === "repos/opengaming/osgameclones/git/ref/heads/master")
          return { object: { sha: revision } };
        // Far more files than the ordinary profile can read beside its reserve.
        return Array.from({ length: 400 }, (_, i) => ({ type: "file", name: `f${i}.yaml` }));
      }),
    },
  });
  await session.collectExternalLists();
  assert.ok(reads.length > 0 && reads.length < 400, "reading stopped before the reserve");
  assert.equal(session.leads.external?.lists.osgc, undefined);
  assert.equal(
    session.leads.external?.attempts?.osgc,
    undefined,
    "a budget stop records no failed attempt, so the list stays due",
  );
  assert.ok(budget.remaining().requests >= 22, "the research reserve is intact");
});

void test("backfill walks each family back to the epoch, then repairs from the top in a later run", () => {
  const runA = "2026-11-24T05:00:00.000Z";
  let state = parseLeadState(undefined);
  const complete = (items: ReturnType<typeof item>[]) => ({
    total_count: items.length,
    incomplete_results: false,
    items,
  });
  const first = nextBackfillPage(state, runA)!;
  assert.equal(first.family, leadFamilyIds[0]);
  // Without forward coverage yet, backfill starts below the forward baseline.
  assert.equal(first.slice.until, "2026-11-10T05:00:00.000Z");
  assert.match(
    first.query,
    / created:2025-11-09T05:00:00\.000Z\.\.2026-11-10T05:00:00\.000Z fork:false$/u,
  );

  // Walk one family to the epoch; an old repository is found along the way.
  const family = first.family;
  let windows = 0;
  for (;;) {
    const plan = nextBackfillPage({ ...state, backfill_next: 0 }, runA);
    if (!plan) break;
    assert.equal(plan.family, family);
    const old =
      Date.parse(plan.slice.since) <= Date.parse("2014-06-01T00:00:00Z") &&
      Date.parse(plan.slice.until) > Date.parse("2014-06-01T00:00:00Z");
    state = acceptBackfillPage(
      { ...state, backfill_next: 0 },
      plan,
      complete(old ? [item(4242, "classic/old-port")] : []),
      runA,
      `backfill-${++windows}.json`,
    );
    assert.ok(windows < 40, "the sweep terminates");
  }
  assert.equal(state.backfill?.[family]?.slice.since, backfillEpoch, "the sweep reaches the epoch");
  assert.deepEqual(state.records["4242"]?.search_families, [family], "found only by backfill");
  assert.equal(
    nextBackfillPage({ ...state, backfill_next: 0 }, runA),
    undefined,
    "no second sweep in the same run",
  );

  // A later run starts a repair sweep from the top.
  const repair = nextBackfillPage({ ...state, backfill_next: 0 }, "2026-11-25T05:00:00.000Z")!;
  assert.equal(repair.backfill.sweeps_completed, 1);
  assert.equal(repair.slice.page, 1);
  assert.ok(Date.parse(repair.slice.until) > Date.parse("2026-01-01T00:00:00Z"));

  // Retained backfill state round-trips; malformed state is refused.
  assert.deepEqual(parseLeadState(JSON.parse(JSON.stringify(state))).backfill, state.backfill);
  assert.throws(
    () =>
      parseLeadState({
        ...state,
        backfill: { [family]: { slice: {}, sweep_started_at: runA, sweeps_completed: 0 } },
      }),
    /Invalid retained backfill window/u,
  );
  assert.throws(() => parseLeadState({ ...state, backfill_next: 999 }), /backfill rotation/u);
});

void test("a halved backfill window steps back from its original start and skips a capped piece forward", () => {
  const run = "2026-11-24T05:00:00.000Z";
  const plan = nextBackfillPage(parseLeadState(undefined), run)!;
  const windowSince = plan.slice.since;
  // Past the provider ceiling: the window halves into two pieces.
  let state = acceptBackfillPage(
    parseLeadState(undefined),
    plan,
    {
      total_count: 1500,
      incomplete_results: false,
      items: Array.from({ length: 50 }, (_, i) => item(1 + i)),
    },
    run,
    "halve.json",
  );
  const pieces = (s: typeof state) => s.backfill![plan.family]!;
  assert.equal(pieces(state).slice.remaining?.length, 1);
  // Both pieces complete empty.
  for (let i = 0; i < 2; i++) {
    const piece = nextBackfillPage({ ...state, backfill_next: 0 }, run)!;
    state = acceptBackfillPage(
      { ...state, backfill_next: 0 },
      piece,
      { total_count: 0, incomplete_results: false, items: [] },
      run,
      `piece-${i}.json`,
    );
  }
  assert.ok(pieces(state).slice.completed_at);
  const following = nextBackfillPage({ ...state, backfill_next: 0 }, run)!;
  assert.equal(
    following.slice.until,
    windowSince,
    "the next window starts where the original began",
  );

  // A capped piece with pieces remaining moves to the next piece; it never completes the window.
  const capped = {
    ...following,
    slice: {
      ...following.slice,
      capped: true as const,
      remaining: [{ since: "2024-01-01T00:00:00.000Z", until: "2024-06-01T00:00:00.000Z" }],
    },
  };
  const moved = skipBackfillWindow({ ...state, backfill_next: 0 }, capped, "capped", false, run);
  const movedSlice = moved.backfill![plan.family]!.slice;
  assert.equal(movedSlice.since, "2024-01-01T00:00:00.000Z");
  assert.equal(movedSlice.completed_at, undefined);
  assert.equal(movedSlice.capped, undefined);
});

void test("a capped window at the epoch finishes the sweep for this run", () => {
  const run = "2026-11-24T05:00:00.000Z";
  const base = parseLeadState(undefined);
  const plan = nextBackfillPage(base, run)!;
  const atEpoch = {
    ...plan,
    backfill: { ...plan.backfill, window_since: backfillEpoch },
    slice: { ...plan.slice, since: backfillEpoch, capped: true as const },
  };
  const state = skipBackfillWindow(base, atEpoch, "capped", false, run);
  assert.equal(state.backfill![plan.family]!.finished_run, run);
  assert.equal(
    nextBackfillPage({ ...state, backfill_next: 0 }, run),
    undefined,
    "no second sweep this run",
  );
  assert.ok(nextBackfillPage({ ...state, backfill_next: 0 }, "2026-11-25T05:00:00.000Z"));
});

void test("local research survives only on the same repository and revision as the stored lead", () => {
  const lead = (id: number, repository: string, revision: string) => ({
    id,
    repository,
    url: `https://github.com/${repository}`,
    description: "",
    revision,
    observed_at: "2026-11-01T00:00:00.000Z",
    evidence: "lead-search-1.json",
    status: "pending" as const,
  });
  const researched = { evidence_id: "e", file: "local.json", material: "m" };
  const stored = {
    format: 1 as const,
    next_family: 4,
    slices: {},
    records: {
      "1": lead(1, "ports/one", "a"),
      "2": lead(2, "ports/two-renamed", "b"),
      "3": { ...lead(3, "ports/three", "c"), external_lists: ["decomp-fun"] },
    },
  };
  const local = {
    format: 1 as const,
    next_family: 0,
    slices: {},
    records: {
      "1": { ...lead(1, "Ports/One", "a"), status: "canonical" as const, research: researched },
      "2": { ...lead(2, "ports/two", "b"), status: "researched" as const, research: researched },
      "3": { ...lead(3, "ports/three", "c"), status: "pending" as const },
    },
  };
  const merged = overlayLocalResearch(stored, local);
  assert.equal(merged.records["1"]!.status, "canonical", "path case does not matter");
  assert.deepEqual(merged.records["1"]!.research, researched);
  assert.equal(merged.records["2"]!.status, "pending", "a relocated repository is reviewed again");
  assert.equal(merged.records["2"]!.repository, "ports/two-renamed");
  assert.deepEqual(merged.records["3"]!.external_lists, ["decomp-fun"], "stored facts stay");
  assert.equal(merged.next_family, 4, "the store owns the continuation");
  assert.equal(stored.records["1"].status, "pending", "the stored copy is not changed");
});

void test("a local lead whose path the store holds under another provider ID is left out", () => {
  const lead = (id: number, repository: string) => ({
    id,
    repository,
    url: `https://github.com/${repository}`,
    description: "",
    revision: "r",
    observed_at: "2026-11-01T00:00:00.000Z",
    evidence: "lead-search-1.json",
    status: "pending" as const,
  });
  const merged = overlayLocalResearch(
    { format: 1, next_family: 0, slices: {}, records: { "9": lead(9, "ports/recreated") } },
    {
      format: 1,
      next_family: 0,
      slices: {},
      records: { "5": lead(5, "Ports/Recreated"), "6": lead(6, "ports/local-only") },
    },
  );
  assert.deepEqual(Object.keys(merged.records).sort(), ["6", "9"]);
});

void test("official URLs on unsupported hosts are retained as unresolved web hints", () => {
  assert.deepEqual(externalWebLocation("https://sourceforge.net/p/openlara/code/ci/master/tree/"), {
    key: "https://sourceforge.net/projects/openlara",
    url: "https://sourceforge.net/projects/openlara",
    host: "web",
  });
  assert.equal(
    externalWebLocation("https://git.example.dev/team/engine.git?tab=readme#top")?.key,
    "https://git.example.dev/team/engine.git?tab=readme",
    "the query names the page; the fragment does not",
  );
  assert.equal(
    externalWebLocation("http://Example.org/Game/")?.key,
    externalWebLocation("https://example.org/game")?.key,
    "one site over HTTP and HTTPS is one location",
  );
  assert.equal(
    externalWebLocation("https://openlara.sourceforge.net/docs/")?.key,
    "https://sourceforge.net/projects/openlara",
    "a SourceForge project site is its project",
  );
  for (const [mirror, project] of [
    ["https://downloads.sourceforge.net/project/foo/foo-1.0.tar.gz", "foo"],
    ["https://prdownloads.sourceforge.net/bar/bar-2.zip", "bar"],
    ["https://master.dl.sourceforge.net/project/baz/x.zip", "baz"],
  ] as const)
    assert.equal(
      externalWebLocation(mirror)?.key,
      `https://sourceforge.net/projects/${project}`,
      "a mirror names its project only in its path",
    );
  assert.equal(externalWebLocation("https://downloads.sourceforge.net/"), null);
  assert.equal(
    externalWebLocation("https://voidpoint.io/terminx/eduke32/-/archive/r1")?.key,
    externalWebLocation("https://voidpoint.io/terminx/eduke32")?.key,
    "a self-hosted GitLab route belongs to its project",
  );
  for (const forge of [
    "https://gist.github.com/owner/abc",
    "https://codeload.github.com/owner/repo/zip/main",
  ])
    assert.equal(externalWebLocation(forge), null, forge);
  assert.equal(
    externalRepository("https://www.github.com/Owner/Repo")?.key,
    "https://github.com/owner/repo",
  );
  for (const rejected of [
    "https://www.youtube.com/watch?v=x",
    "https://store.steampowered.com/app/1",
    "https://github.com/owner/repo",
    "https://user:pass@example.org/p",
    "https://example.org:8443/p",
    "https://192.168.0.1/p",
    "ftp://example.org/p",
    "https://decomp.fun/owner/repo/",
  ])
    assert.equal(externalWebLocation(rejected), null, rejected);
  const parsed = parseUnbakedAdditions(
    JSON.stringify({
      weeks: [
        {
          games: [
            {
              title: "Doom",
              projects: [{ url: "https://git.example.dev/team/engine", name: "engine" }],
            },
          ],
        },
      ],
    }),
  );
  const state = mergeExternalList(undefined, "unbaked-additions", parsed, now, "evidence.json");
  assert.deepEqual(parseExternalLeadState(state), state, "web hints round-trip");
  const summary = externalHintSummary(state, new Set(), new Map(), now);
  assert.equal(summary["unsupported-host"], 1);
  assert.deepEqual(summary.unsupported_hosts, { "git.example.dev": 1 });
  assert.match(summary.unsupported_host_reconsideration, /provider adapter/u);
  assert.deepEqual(
    selectExternalResolutions(state, new Set(), new Map(), now, Infinity, "fair"),
    [],
    "a web hint is never researched as a GitHub repository",
  );
});

void test("a claim several aggregators repeat counts once for its originating source", () => {
  const claim = (id: string, origin: string[]) =>
    sourceEntry({
      id,
      subject: "Game",
      category: "gc",
      method: "",
      status: "latest",
      targets: ["Windows", "Linux"],
      needs_original: null,
      latest_release: "v1",
      relation: "implementation",
      games: ["game"],
      origin,
    });
  const entry = (origin: string[]) => ({
    key: "https://github.com/ports/game",
    url: "https://github.com/ports/game",
    host: "github" as const,
    title: "Game",
    source_entries: [claim("github:ports/game", origin)],
  });
  let state = mergeExternalList(
    undefined,
    "portsdr",
    parsePortsdrPage(
      '<article class="port-card"><h3>Game</h3><a href="https://github.com/ports/game">Repository</a></article>',
    ),
    now,
    "portsdr.json",
  );
  state = mergeExternalList(
    state,
    "decomp-buddy-finds",
    { entries: [entry(["portsdr", "decomp-buddy-finds"])], unlinked: 0 },
    now,
    "finds.json",
  );
  assert.deepEqual(parseExternalLeadState(state), state);
  const summary = externalHintSummary(state, new Set(), new Map(), now);
  assert.equal(summary.hints, 1, "one upstream identity");
  assert.equal(summary.lists.portsdr?.contribution?.discovered, 1);
  assert.equal(summary.lists["decomp-buddy-finds"]?.contribution?.discovered, 0);
  assert.equal(summary.lists.portsdr?.contribution?.originated, 1);
  assert.equal(summary.lists["decomp-buddy-finds"]?.contribution?.platform_claims, 1);
  assert.deepEqual(state.hints["https://github.com/ports/game"]?.lists, [
    "decomp-buddy-finds",
    "portsdr",
  ]);
  // A small progress move stays in one band; crossing a band is a research change.
  assert.equal(progressBand(41.2), progressBand(48.9));
  assert.notEqual(progressBand(48.9), progressBand(51));
  assert.equal(progressBand(100), 10);
  assert.equal(progressBand(0.99), 0, "values are percentages: 0.99 is under one percent");
  assert.equal(progressBand(0.99), progressBand(1.05));
  assert.equal(progressBand(101), null);
  assert.equal(progressBand(null), null);
});

void test("a conditional list read keeps its retained copy until the source changes", async (t) => {
  const first = mergeExternalList(
    undefined,
    "decomp-buddy-finds",
    parseFindsFeed(finds(["ports/game-1"])),
    now,
    "finds.json",
    { bytes: 120, etag: '"v1"' },
  );
  assert.equal(first.lists["decomp-buddy-finds"]?.parser, 1);
  assert.deepEqual(externalListValidators(first, "decomp-buddy-finds"), { etag: '"v1"' });
  assert.equal(externalListValidators(first, "portsdr"), undefined, "no conditional support");
  const stale = structuredClone(first);
  stale.lists["decomp-buddy-finds"]!.parser = 0;
  assert.equal(
    externalListValidators(stale, "decomp-buddy-finds"),
    undefined,
    "a copy parsed by another parser version is read in full",
  );
  const later = new Date(Date.parse(now) + 2 * 86400000).toISOString();
  assert.ok(externalListDue(first, "decomp-buddy-finds", later), "daily list is due");
  const unchanged = markExternalListUnchanged(first, "decomp-buddy-finds", later, 0);
  assert.equal(unchanged.lists["decomp-buddy-finds"]?.completed_at, now);
  assert.equal(unchanged.lists["decomp-buddy-finds"]?.unchanged_at, later);
  assert.deepEqual(unchanged.hints, first.hints);
  assert.ok(!externalListDue(unchanged, "decomp-buddy-finds", later));
  assert.deepEqual(parseExternalLeadState(unchanged), unchanged);
  assert.throws(() => markExternalListUnchanged(undefined, "decomp-buddy-finds", later, 0));

  // The collector sends the retained validators and keeps the copy on 304.
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-conditional-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const leads = parseLeadState(undefined);
  leads.external = structuredClone(first);
  leads.external.attempts = Object.fromEntries(
    externalListIds
      .filter((id) => id !== "decomp-buddy-finds")
      .map((id) => [id, { attempted_at: later, outcome: "partial" as const }]),
  );
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: later, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
  });
  session.knownLeadUrls = () => new Set();
  const sent: unknown[] = [];
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      http: {
        request: async (
          _method: string,
          url: string,
          _body?: string,
          _binary?: boolean,
          _cap?: number,
          options?: { conditional?: unknown },
        ) => {
          assert.match(url, /finds\.json/u);
          sent.push(options?.conditional);
          return { requests: 1, bytes: 0, status: 304, headers: {}, text: "" };
        },
      },
      sdk: await fixtureGitHub(() => assert.fail("no hint is due")),
    },
  });
  await session.collectExternalLists();
  assert.deepEqual(sent, [{ etag: '"v1"' }]);
  assert.equal(session.leads.external?.lists["decomp-buddy-finds"]?.unchanged_at, later);
  assert.deepEqual(session.leads.external?.hints, first.hints);

  // A 304 that arrives after a redirect does not describe the retained copy.
  const redirected = new Date(Date.parse(later) + 2 * 86400000).toISOString();
  session.externalCollectionAttempted = false;
  Object.assign(session, { journal: { ...session.journal, started_at: redirected, notes: [] } });
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      http: {
        request: async () => ({ requests: 2, bytes: 0, status: 304, headers: {}, text: "" }),
      },
      sdk: await fixtureGitHub(() => assert.fail("no hint is due")),
    },
  });
  await session.collectExternalLists();
  assert.equal(session.leads.external?.lists["decomp-buddy-finds"]?.unchanged_at, later);
  assert.equal(session.leads.external?.attempts?.["decomp-buddy-finds"]?.outcome, "partial");
});
