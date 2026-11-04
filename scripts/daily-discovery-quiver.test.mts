import assert from "node:assert/strict";
import test from "node:test";
import { collectQuiver } from "./daily-discovery-quiver.mts";
import { advanceDiscovery, emptyCheckpoint, recordDisposition } from "./discovery-checkpoint.mts";
import type { SourceContext } from "./daily-discovery-sources.mts";

const app = (id: string) => ({
  id,
  name: "Game",
  projectId: "project",
  projectName: "Engine",
  games: [{ id: "game", title: "Game" }],
});
const release = (id: string, repository = "owner/engine") => ({ id, repository });
const page = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  isDone: nextCursor === null,
});
function fixture(pages: unknown[]) {
  const urls: string[] = [],
    saved: unknown[] = [];
  const request = async (_method: string, url: string) => {
    urls.push(url);
    const value = pages.shift();
    if (value instanceof Error) throw value;
    return {
      status: 200,
      text: typeof value === "string" ? value : JSON.stringify(value),
      requests: 1,
      bytes: 1,
      headers: {},
    };
  };
  const c: Pick<SourceContext, "http" | "save"> = {
    http: { request },
    save: (_name, value) => saved.push(value),
  };
  return { collect: async () => await collectQuiver(c), urls, saved };
}
await test("joins differently ordered feeds by stable app ID and exhausts each cursor", async () => {
  const f = fixture([
    page([app("a")], "app-cursor"),
    page([app("b")]),
    page([release("b")], "release-cursor"),
    page([release("a")]),
  ]);
  const result = (await f.collect());
  assert.equal(result.status, "complete");
  assert.deepEqual(
    result.records.map((r) => r.key),
    ["a", "b"],
  );
  assert.match(f.urls[1]!, /cursor=app-cursor/u);
  assert.match(f.urls[3]!, /cursor=release-cursor/u);
  assert.equal(f.saved.length, 5);
});
await test("deduplicates identical boundary records, refusing conflicting identity observations", async () => {
  const same = fixture([page([app("a")], "next"), page([app("a")]), page([release("a")])]);
  assert.equal((await same.collect()).records.length, 1);
  const changed = fixture([page([app("a")], "next"), page([{ ...app("a"), name: "Other" }])]);
  assert.equal((await changed.collect()).status, "partial");
});
await test("retains empty game-target metadata for research or exclusion", async () => {
  const source = (await fixture([page([{ ...app("a"), games: [] }]), page([release("a")])]).collect());
  assert.equal(source.status, "complete");
  assert.equal(source.records[0]!.key, "a");
});
for (const [name, pages] of Object.entries({
  loop: [page([app("a")], "same"), page([app("b")], "same")],
  empty: [page([], "next")],
  malformed: [{ items: {}, isDone: true, nextCursor: null }],
  missingIdentity: [page([{}])],
  missingProvenance: [page([app("a")]), page([{ id: "a" }])],
  malformedGames: [page([{ ...app("a"), games: [{}] }]), page([release("a")])],
  contradictoryCatalog: [
    page([{ ...app("a"), catalogId: "catalog-a" }]),
    page([{ ...release("a"), catalogId: "catalog-b" }]),
  ],
  contradictory: [{ items: [app("a")], isDone: true, nextCursor: "still-more" }],
  mismatch: [page([app("a")]), page([release("b")])],
  malformedJson: ["{"],
  failedSecondFeed: [page([app("a")]), new Error("source unavailable")],
}))
  await test(`refuses ${name} without replacing prior checkpoint`, async () => {
    const good = (await fixture([page([app("a")]), page([release("a")])]).collect());
    const before = advanceDiscovery(emptyCheckpoint(), {
      observed_at: "2026-10-24T00:00:00Z",
      sources: [good],
    });
    const result = (await fixture([...pages]).collect());
    assert.notEqual(result.status, "complete");
    assert.deepEqual(
      advanceDiscovery(before, { observed_at: "2026-10-24T01:00:00Z", sources: [result] }),
      before,
    );
  });
await test("unchanged repeat ignores collection time and engagement; repository rename keeps app identity", async () => {
  const first = (await fixture([page([{ ...app("a"), reviewCount: 1 }]), page([release("a")])]).collect());
  const repeated = (await fixture([
    page([{ ...app("a"), reviewCount: 2 }]),
    page([release("a")]),
  ]).collect());
  assert.deepEqual(repeated.records, first.records);
  const renamed = (await fixture([page([app("a")]), page([release("a", "new-owner/engine")])]).collect());
  assert.equal(renamed.records[0]!.key, first.records[0]!.key);
  assert.notEqual(renamed.records[0]!.fingerprint, first.records[0]!.fingerprint);
  let state = advanceDiscovery(emptyCheckpoint(), {
    observed_at: "2026-10-24T00:00:00Z",
    sources: [first],
  });
  for (const id of Object.keys(state.pending))
    state = recordDisposition(state, id, {
      outcome: "intake-complete",
      evidence: "Reviewed primary identity",
      issue: 2552,
      readback: "Exact canonical owner and Project fields read back",
    });
  const repeat = advanceDiscovery(state, {
    observed_at: "2026-10-24T01:00:00Z",
    sources: [repeated],
  });
  assert.deepEqual(repeat.pending, {});
  assert.deepEqual(repeat.receipts, state.receipts);
});
await test("temporary disappearance retains pending identities and only records absence", async () => {
  const first = (await fixture([page([app("a")]), page([release("a")])]).collect());
  const before = advanceDiscovery(emptyCheckpoint(), {
    observed_at: "2026-10-24T00:00:00Z",
    sources: [first],
  });
  const empty = (await fixture([page([]), page([])]).collect());
  const after = advanceDiscovery(before, { observed_at: "2026-10-24T01:00:00Z", sources: [empty] });
  for (const [id, pending] of Object.entries(before.pending))
    assert.deepEqual(after.pending[id], pending);
  assert.equal(Object.values(after.pending).filter((v) => v.absent).length, 1);
});
