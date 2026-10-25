import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecompFeed,
  parseRecompManifest,
  ecosystemBursts,
  ecosystemSearchFamilies,
} from "./discovery-ecosystems.mts";
import { advanceDiscovery, emptyCheckpoint } from "./discovery-checkpoint.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  acceptLeadPage,
  nextLeadPage,
  parseLeadState,
  leadSearchFamilyCount,
} from "./discovery-leads.mts";
import { collectRecompBoardSource } from "./daily-discovery-sources.mts";
import type { SourceContext } from "./daily-discovery-sources.mts";

const now = "2026-10-25T04:00:00.000Z";
const entry = (id = "game", repo = "ports/game", updated = now) =>
  `<entry><title>Game &amp; Port</title><id>tag:recomp.fyi,2026:${id}:2026-10-25</id><updated>${updated}</updated><link rel="related" href="https://github.com/${repo}"/><category term="PS2"/></entry>`;
const feed = (...entries: string[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
void test("published Atom scope is deterministic, attributed, bounded and never a table ingestion", () => {
  const rows = parseRecompFeed(feed(entry("b", "ports/b"), entry("a", "ports/a")));
  assert.deepEqual(
    rows.map((r) => r.repository),
    ["ports/a", "ports/b"],
  );
  assert.equal(rows[0]?.title, "Game & Port");
  assert.match(rows[0].provenance, /^https:\/\/recomp\.fyi\/#/u);
  assert.deepEqual(rows, parseRecompFeed(feed(entry("a", "ports/a"), entry("b", "ports/b"))));
  assert.throws(() => parseRecompFeed(feed(entry(), entry())), /identity/u);
  assert.throws(() => parseRecompFeed(feed(entry()).slice(0, -7)), /incomplete/u);
  assert.throws(
    () => parseRecompFeed(feed(entry().replace("https://github.com/", "https://host.test/"))),
    /upstream/u,
  );
  assert.throws(
    () => parseRecompFeed('<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///private">]>' + feed(entry())),
    /Unsupported/u,
  );
  assert.throws(() => parseRecompFeed("x".repeat(2 * 1024 * 1024 + 1)), /Unsupported/u);
  const updated = parseRecompFeed(
    feed(entry("first", "ports/game", "2026-10-24T00:00:00Z"), entry("second")),
  );
  assert.equal(updated.length, 1, "events on the same repository remain one research lead");
  assert.equal(updated[0]?.updated, now);
  const first = entry("first").replace("Game &amp; Port", "Game One");
  const second = entry("second").replace("Game &amp; Port", "Game Two");
  const tied = parseRecompFeed(feed(first, second));
  assert.deepEqual(tied, parseRecompFeed(feed(second, first)));
  assert.equal(
    tied[0]?.events.length,
    2,
    "multi-game source attribution survives repository deduplication",
  );
});
void test("retained primary manifests reject non-normalized lists before summary consumption", () => {
  const state = parseLeadState(undefined);
  state.records["1"] = {
    id: 1,
    repository: "ports/game",
    url: "https://github.com/ports/game",
    description: "",
    revision: "a",
    observed_at: now,
    evidence: "snapshot",
    status: "pending",
    manifest: parseRecompManifest({ game: "Game", system: "PS3", type: "recomp" }),
  };
  const raw = JSON.parse(JSON.stringify(state)) as {
    records: Record<string, { manifest: Record<string, unknown> }>;
  };
  raw.records["1"]!.manifest.types = "recomp";
  assert.throws(() => parseLeadState(raw), /normalized lists/u);
  assert.deepEqual(parseLeadState(state), state);
});
void test("the actual feed collector flags a lost overlap and preserves inaccessible source evidence", () => {
  const saved: Record<string, unknown> = {};
  let status = 200;
  const context = {
    http: {
      request: (_method: string, url: string) => {
        assert.equal(url, "https://recomp.fyi/feed.xml");
        return { status, text: feed(entry()) };
      },
    } as unknown as SourceContext["http"],
    save: (name: string, value: unknown) => {
      saved[name] = value;
    },
  };
  const initial = collectRecompBoardSource(context, emptyCheckpoint());
  assert.equal(initial.status, "complete");
  const state = advanceDiscovery(emptyCheckpoint(), {
    observed_at: "2026-10-24T04:00:00Z",
    sources: [initial],
  });
  const gap = collectRecompBoardSource(context, state);
  assert.equal(gap.status, "partial");
  assert.match(String(gap.next_action), /missing interval/u);
  assert.deepEqual(
    advanceDiscovery(state, { observed_at: now, sources: [gap] }).sources,
    state.sources,
  );
  status = 403;
  assert.throws(() => collectRecompBoardSource(context, state), /unavailable/u);
  assert.equal((saved["recomp-board-feed"] as { status: number }).status, 403);
});
void test("manifest omission remains Unknown and independent toolchains/source systems remain explicit", () => {
  const result = parseRecompManifest({
    game: "Game",
    system: ["PS2", "PSP"],
    type: ["recomp", "port"],
    toolchain: ["PS2Recomp", "other"],
    original: [{ serial: "SCUS-97402", region: "USA" }],
  });
  assert.deepEqual(result.targets, []);
  assert.equal(result.status, undefined);
  assert.deepEqual(result.systems, ["PS2", "PSP"]);
  assert.throws(
    () => parseRecompManifest({ game: "Game", system: "PS2", type: "emulator" }),
    /architecture/u,
  );
  assert.throws(
    () =>
      parseRecompManifest({
        game: "Game",
        system: "PS2",
        type: "recomp",
        $schema: "https://recomp.fyi/schema/v2.json",
      }),
    /schema/u,
  );
  assert.throws(() => parseRecompManifest({ game: "Game", type: "recomp" }), /text list/u);
});
void test("burst needs three distinct recent repository IDs and primary native claims", () => {
  const manifest = parseRecompManifest({
    game: "Game",
    system: "PS3",
    type: "recomp",
    toolchain: "PS3Recomp",
  });
  const unverified = (id: number) => ({
    id,
    repository: `ports/game-${id}`,
    created_at: "2026-10-20T00:00:00Z",
  });
  const row = (id: number) => ({
    ...unverified(id),
    manifest,
  });
  assert.deepEqual(ecosystemBursts([row(1), row(2)], now), []);
  const result = ecosystemBursts(
    [row(3), row(1), row(2), { ...row(1), repository: "new-owner/renamed" }],
    now,
  );
  assert.deepEqual(
    result.map((r) => r.ecosystem),
    ["console:ps3", "framework:ps3recomp"],
  );
  assert.equal(result[0]?.repositories.length, 3);
  assert.deepEqual(
    ecosystemBursts([row(1), row(2), { ...row(3), created_at: "2026-10-01T00:00:00Z" }], now),
    [],
  );
  assert.deepEqual(ecosystemBursts([row(1), row(2), unverified(3)], now), []);
  assert.deepEqual(
    ecosystemBursts(
      [row(1), row(2), { ...row(3), manifest: { ...manifest, types: ["decomp"] } }],
      now,
    ),
    [],
  );
  assert.deepEqual(
    ecosystemBursts([row(1), row(2), { ...row(3), created_at: "2026-10-26T00:00:00Z" }], now),
    [],
  );
  const hints = [1, 2, 3].map((id) => ({
    ...unverified(id),
    search_families: ["ps3recomp"],
  }));
  const early = ecosystemBursts(hints, now);
  assert.equal(early[0]?.confidence, "unverified repository leads");
  assert.match(early[0].action, /validate architecture/u);
});
void test("new ecosystem families participate in the existing persisted rotation and capped pagination", () => {
  let state = parseLeadState(undefined);
  assert.equal(leadSearchFamilyCount, 4 + ecosystemSearchFamilies.length);
  for (let i = 0; i < leadSearchFamilyCount; i++) {
    const plan = nextLeadPage(state, now);
    assert.ok(plan.query.includes(".."), "each family has its own incremental time window");
    state = acceptLeadPage(
      state,
      plan,
      { items: [], total_count: 0, incomplete_results: false },
      now,
      `source-${i}`,
    );
  }
  assert.equal(state.next_family, 0);
  assert.equal(Object.keys(state.slices).length, leadSearchFamilyCount);
  assert.deepEqual(parseLeadState(JSON.parse(JSON.stringify(state))), state);
});
void test("feed checkpoint replay is quiet and partial/disappeared observations preserve prior research", () => {
  const records = parseRecompFeed(feed(entry())).map((r) => ({
    key: r.key,
    fingerprint: observationHash(r),
  }));
  const source = {
    id: "recomp-board-feed",
    status: "complete",
    evidence: "https://recomp.fyi/feed.xml",
    next_page: null,
    truncated: false,
    records,
  };
  const first = advanceDiscovery(emptyCheckpoint(), { observed_at: now, sources: [source] });
  const second = advanceDiscovery(first, { observed_at: now, sources: [source] });
  assert.deepEqual(second, first);
  const failed = advanceDiscovery(first, {
    observed_at: "2026-10-26T04:00:00Z",
    sources: [{ ...source, status: "partial", records: [] }],
  });
  assert.deepEqual(failed.sources, first.sources);
  assert.deepEqual(failed.pending, first.pending);
});
void test("rolling feed expiry is not project disappearance and a gap retains positive leads without advancing", () => {
  const source = {
    id: "recomp-board-feed",
    snapshot_kind: "rolling-feed",
    status: "complete",
    evidence: "https://recomp.fyi/feed.xml",
    next_page: null,
    truncated: false,
    records: [{ key: "https://github.com/ports/first", fingerprint: "a".repeat(64) }],
  };
  const first = advanceDiscovery(emptyCheckpoint(), { observed_at: now, sources: [source] });
  const secondSource = {
    ...source,
    records: [{ key: "https://github.com/ports/second", fingerprint: "b".repeat(64) }],
  };
  const second = advanceDiscovery(first, {
    observed_at: "2026-10-26T04:00:00Z",
    sources: [secondSource],
  });
  assert.equal(Object.keys(second.sources[source.id]!.hashes).length, 2);
  assert.equal(
    Object.values(second.pending).some((row) => row.absent),
    false,
  );
  const partial = advanceDiscovery(first, {
    observed_at: "2026-10-26T04:00:00Z",
    sources: [{ ...secondSource, status: "partial" }],
  });
  assert.deepEqual(partial.sources, first.sources);
  assert.equal(Object.keys(partial.pending).length, 2);
  assert.deepEqual(
    advanceDiscovery(partial, {
      observed_at: "2026-10-26T04:00:00Z",
      sources: [{ ...secondSource, status: "partial" }],
    }),
    partial,
  );
});
