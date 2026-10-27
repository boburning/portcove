import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiClient, GitHubApiError } from "./github-api.mts";
import { DiscoveryPrimaryReads, discoveryNextPage } from "./discovery-primary-progress.mts";
import {
  investigateDiscoveryUpstream,
  collectDiscoverySources,
} from "./daily-discovery-sources.mts";
import type { SourceContext, CollectedSource } from "./daily-discovery-sources.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { emptyCheckpoint, advanceDiscovery } from "./discovery-checkpoint.mts";
const epoch = Date.parse("2026-10-27T00:00:00Z");
function primaryFixture() {
  let allowance = 7;
  let clock = epoch;
  let changed = false;
  let repositoryId = 41;
  let corrupt = false;
  const calls: { endpoint: string; conditional: boolean }[] = [];
  const entries: Record<string, unknown> = {};
  let writes = 0;
  const api = new GitHubApiClient((args) => {
    assert.equal(args[0], "api");
    assert.equal(args[args.indexOf("--method") + 1], "GET");
    if (allowance-- <= 0) throw new GitHubApiError("budget_exhausted", "fixture batch exhausted");
    const endpoint = args[2]!;
    const conditional = args.some((value) => value.startsWith("If-None-Match: "));
    calls.push({ endpoint, conditional });
    let body: unknown;
    let link: string | undefined;
    if (endpoint === "repos/owner/game")
      body = { id: repositoryId, full_name: "owner/game", default_branch: "main" };
    else if (/\/releases\?/u.test(endpoint)) {
      const page = Number(
        new URL(endpoint, "https://api.github.com").searchParams.get("page") ?? 1,
      );
      body = [
        {
          id: page,
          tag_name: `v${page}`,
          draft: false,
          prerelease: false,
          published_at: new Date(epoch + page * 1000).toISOString(),
          body: changed && page === 1 ? "changed" : "stable",
        },
      ];
      if (page < 24)
        link = `<https://api.github.com/repos/owner/game/releases?per_page=10&page=${page + 1}>; rel="next"`;
    } else if (/\/assets\?/u.test(endpoint)) {
      const page = Number(
        new URL(endpoint, "https://api.github.com").searchParams.get("page") ?? 1,
      );
      body = [{ id: corrupt ? 1 : page, size: 17, name: `file-${page}.zip` }];
      if (page < 4)
        link = `<https://api.github.com/repos/owner/game/releases/24/assets?per_page=100&page=${page + 1}>; rel="next"`;
    } else if (endpoint.includes("/git/ref/tags/"))
      body = { object: { type: "commit", sha: "a".repeat(40) } };
    else if (endpoint.includes("/readme?"))
      body = {
        sha: "b".repeat(40),
        content: Buffer.from("Primary upstream readme").toString("base64"),
      };
    else if (endpoint.includes("/contents/.recomp.json?"))
      throw new GitHubApiError("http_error", "fixture absent manifest", { status: 404 });
    else throw new Error(`Unexpected fixture endpoint ${endpoint}`);
    if (conditional && !changed) return "HTTP/2 304\n\n";
    return `HTTP/2 200\netag: "fixture"\n${link ? `link: ${link}\n` : ""}\n${JSON.stringify(body)}`;
  });
  const context = {
    api,
    budget: new DiscoveryBudget(
      "ordinary",
      () => {},
      () => clock,
    ),
    http: {} as SourceContext["http"],
    save: () => {},
    primaryProgress: {
      entries,
      persist: () => {
        writes += 1;
      },
      now: () => clock,
    },
  };
  return {
    context,
    calls,
    entries,
    setAllowance: (n: number) => {
      allowance = n;
    },
    tick: () => {
      clock += 1000;
    },
    change: () => {
      changed = true;
    },
    changeIdentity: () => {
      repositoryId = 42;
    },
    corrupt: () => {
      corrupt = true;
    },
    writes: () => writes,
  };
}

void test("primary investigations and complete validation advance through bounded pages without replaying completed collection", () => {
  const h = primaryFixture();
  let result: ReturnType<typeof investigateDiscoveryUpstream> | undefined;
  let batches = 0;
  while (!result && batches < 30) {
    h.setAllowance(7);
    h.tick();
    batches += 1;
    try {
      result = investigateDiscoveryUpstream(h.context, "owner/game");
    } catch (error) {
      assert.ok(error instanceof GitHubApiError && error.code === "budget_exhausted");
    }
  }
  assert.ok(result);
  assert.ok(batches > 6);
  assert.equal(result.releases.length, 24);
  assert.equal(result.selected[0]!.assets instanceof Array, true);
  assert.equal((result.selected[0]!.assets as unknown[]).length, 4);
  assert.equal(result.manifest_evidence.status, "unavailable-or-invalid");
  assert.ok(result.observed_at);
  const reads = h.calls.filter((call) => call.endpoint !== "repos/owner/game");
  for (const endpoint of new Set(reads.map((call) => call.endpoint))) {
    const operations = reads.filter((call) => call.endpoint === endpoint);
    assert.equal(
      operations.filter((call) => !call.conditional).length,
      endpoint.includes(".recomp.json") ? 2 : 1,
    );
  }
  assert.ok(h.writes() > 30);
});

void test("changed or corrupt primary facts, repository identities and duplicate pages cannot complete resumed research", () => {
  const changed = primaryFixture();
  assert.throws(
    () => investigateDiscoveryUpstream(changed.context, "owner/game"),
    /fixture batch exhausted/,
  );
  changed.change();
  changed.setAllowance(100);
  assert.throws(() => investigateDiscoveryUpstream(changed.context, "owner/game"), /facts changed/);
  assert.deepEqual(changed.entries, {});
  const identity = primaryFixture();
  assert.throws(
    () => investigateDiscoveryUpstream(identity.context, "owner/game"),
    /fixture batch exhausted/,
  );
  identity.changeIdentity();
  identity.setAllowance(100);
  assert.throws(
    () => investigateDiscoveryUpstream(identity.context, "owner/game"),
    /identity or shape changed/,
  );
  const corrupt = primaryFixture();
  assert.throws(
    () => investigateDiscoveryUpstream(corrupt.context, "owner/game"),
    /fixture batch exhausted/,
  );
  const state = corrupt.entries["owner/game"] as { reads: { body: unknown }[] };
  state.reads[0]!.body = [];
  corrupt.setAllowance(100);
  assert.throws(
    () => investigateDiscoveryUpstream(corrupt.context, "owner/game"),
    /corrupt or foreign/,
  );
  const duplicate = primaryFixture();
  duplicate.setAllowance(100);
  duplicate.corrupt();
  assert.throws(
    () => investigateDiscoveryUpstream(duplicate.context, "owner/game"),
    /duplicate identities/,
  );
  assert.deepEqual(duplicate.entries, {});
});

void test("pagination refuses foreign scopes, skipped pages and ambiguous completion", () => {
  const first = "repos/owner/game/releases?per_page=10";
  for (const value of [
    '<https://evil.example/repos/owner/game/releases?per_page=10&page=2>; rel="next"',
    '<https://api.github.com/repos/other/game/releases?per_page=10&page=2>; rel="next"',
    '<https://api.github.com/repos/owner/game/releases?per_page=10&page=3>; rel="next"',
    "malformed",
    '<x>; rel="next", <y>; rel="next"',
  ])
    assert.throws(
      () => discoveryNextPage({ headers: new Map([["link", value]]), body: [] }, first, first),
      /pagination/,
    );
});

void test("manifest work drains fairly past eight files, persists each exact blob, and resumes after interruption and provider failure", () => {
  let checkpoint = emptyCheckpoint();
  let allowance = 5;
  let providerFailure = false;
  const loaded: string[] = [];
  const accepted: CollectedSource[] = [];
  const retcomm = Array.from({ length: 18 }, (_, i) => `game-${String(i).padStart(2, "0")}`);
  const forge = Array.from(
    { length: 17 },
    (_, i) => `game-${String(i).padStart(2, "0")}.forge.json`,
  );
  const api = new GitHubApiClient((args) => {
    const endpoint = args[2]!;
    let body: unknown;
    const repo = endpoint.startsWith("repos/RetroPortingToolKit/")
      ? "RetroPortingToolKit/Retro-Catalog"
      : "zamiba/portforge-mediaitems";
    if (endpoint === "repos/SirDiabo/GHLAppList") throw new Error("unrelated unavailable registry");
    if (endpoint === `repos/${repo}`)
      body = { id: repo.startsWith("Retro") ? 1 : 2, full_name: repo, default_branch: "main" };
    else if (endpoint.includes("/git/ref/heads/")) body = { object: { sha: "a".repeat(40) } };
    else if (endpoint.includes("/git/trees/"))
      body = {
        truncated: false,
        tree: repo.startsWith("Retro")
          ? retcomm.map((title) => ({ path: `titles/${title}.json`, sha: `ret-${title}` }))
          : forge.map((file) => ({ path: file, sha: `forge-${file}` })),
      };
    else if (endpoint.includes("/contents/")) {
      const file = decodeURIComponent(endpoint.split("/contents/")[1]!.split("?")[0]!);
      const isIndex = file === "index.json";
      if (!isIndex) {
        if (allowance-- <= 0)
          throw new GitHubApiError("budget_exhausted", "fixture manifest batch exhausted");
        if (providerFailure && file === forge[5])
          throw new GitHubApiError("http_error", "fixture isolated provider failure", {
            status: 503,
          });
        loaded.push(`${repo}/${file}`);
      }
      const data = isIndex
        ? { platforms: { psx: { dir: "titles", titles: retcomm } } }
        : { name: file, repository: "owner/game" };
      body = {
        sha: isIndex
          ? "index"
          : repo.startsWith("Retro")
            ? `ret-${file.slice(7, -5)}`
            : `forge-${file}`,
        content: Buffer.from(JSON.stringify(data)).toString("base64"),
      };
    } else throw new Error(`Unexpected registry fixture ${endpoint}`);
    return `HTTP/2 200\n\n${JSON.stringify(body)}`;
  });
  const context: SourceContext = {
    api,
    budget: new DiscoveryBudget(
      "ordinary",
      () => {},
      () => epoch,
    ),
    save: () => {},
    http: {
      request: () => ({ status: 503, text: "", headers: {} }),
    } as unknown as SourceContext["http"],
    acceptSource: (source) => {
      accepted.push(source);
      checkpoint = advanceDiscovery(checkpoint, {
        observed_at: new Date(epoch).toISOString(),
        sources: [source],
      });
    },
  };
  const first = collectDiscoverySources(context, checkpoint);
  assert.equal(loaded.length, 5);
  assert.ok(loaded[0]!.startsWith("RetroPortingToolKit/"));
  assert.ok(loaded[1]!.startsWith("zamiba/"));
  assert.equal(
    first.find((source) => source.id === "retcomm-manifest-coverage")!.status,
    "partial",
  );
  assert.equal(first.find((source) => source.id === "portforge-tree")!.status, "partial");
  const prefix = [...loaded];
  allowance = 100;
  providerFailure = true;
  collectDiscoverySources(context, checkpoint);
  assert.equal(loaded.length, 34);
  assert.equal(accepted.at(-1)!.status, "partial");
  providerFailure = false;
  allowance = 100;
  collectDiscoverySources(context, checkpoint);
  assert.equal(loaded.length, 35);
  assert.equal(new Set(loaded).size, 35);
  assert.ok(prefix.every((file) => loaded.filter((value) => value === file).length === 1));
  assert.equal(accepted.filter((source) => source.id.startsWith("retcomm-game-")).length, 18);
  assert.equal(
    accepted.filter(
      (source) =>
        source.id.startsWith("portforge-") &&
        source.id !== "portforge-tree" &&
        source.status === "complete",
    ).length,
    17,
  );
});

void test("durably accepted research reads survive checkpoint interruption and stale prefixes require current validation", () => {
  const h = primaryFixture();
  h.setAllowance(100);
  const original = h.context.primaryProgress.persist;
  let writes = 0;
  h.context.primaryProgress.persist = () => {
    original();
    if (++writes === 5) throw new Error("fixture interruption");
  };
  assert.throws(
    () => investigateDiscoveryUpstream(h.context, "owner/game"),
    /checkpoint interrupted/,
  );
  assert.ok(h.entries["owner/game"]);
  h.context.primaryProgress.persist = original;
  h.context.primaryProgress.now = () => epoch + 13 * 3600000;
  h.setAllowance(100);
  assert.equal(investigateDiscoveryUpstream(h.context, "owner/game").releases.length, 24);
  const reads = new DiscoveryPrimaryReads(
    h.context.api,
    "owner/game",
    41,
    h.context.primaryProgress,
  );
  assert.throws(() => reads.request("repos/foreign/game/releases?per_page=10"), /escaped/);
  const tooLarge = {
    entries: { foreign: "x".repeat(32 * 1024 * 1024) },
    persist: () => {},
    now: () => epoch,
  };
  assert.throws(
    () => new DiscoveryPrimaryReads(h.context.api, "owner/other", 3, tooLarge),
    /byte envelope/,
  );
});

void test("conditional discovery headers stay scoped to the original provider read and cannot become credentials or redirect authority", async () => {
  const { boundedDiscoveryRequest } = await import("./discovery-http.mts");
  const initial = {
    url: "https://api.github.com/repos/owner/game/releases?per_page=10",
    method: "GET",
    cap: 1024,
    timeout: 1000,
    maxRequests: 2,
    conditionalEtag: '"facts"',
  };
  let calls = 0;
  const result = await boundedDiscoveryRequest(initial, async (_input, options) => {
    const headers = options!.headers as Record<string, string>;
    assert.equal(headers["If-None-Match"], calls === 0 ? '"facts"' : undefined);
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://other.example/release" } })
      : new Response(null, { status: 304 });
  });
  assert.equal(result.status, 304);
  assert.equal(calls, 2);
  await assert.rejects(
    boundedDiscoveryRequest({ ...initial, conditionalEtag: "bad\r\nAuthorization: secret" }),
    /Invalid scoped/,
  );
  await assert.rejects(
    boundedDiscoveryRequest({ ...initial, url: "https://other.example/file" }),
    /Invalid scoped/,
  );
  await assert.rejects(boundedDiscoveryRequest({ ...initial, method: "POST" }), /Invalid scoped/);
});

void test("a source burst exceeds former record and pending counts within a bounded physical checkpoint", () => {
  const records = Array.from({ length: 12001 }, (_, index) => ({
    key: `game-${index}`,
    fingerprint: "a".repeat(64),
  }));
  const source = {
    id: "large-source",
    status: "complete",
    evidence: "https://primary.example/exact",
    next_page: null,
    truncated: false,
    records,
  };
  const before = emptyCheckpoint();
  const next = advanceDiscovery(before, {
    observed_at: new Date(epoch).toISOString(),
    sources: [source],
  });
  assert.equal(Object.keys(next.sources["large-source"]!.hashes).length, 12001);
  assert.equal(Object.keys(next.pending).length, 12001);
  assert.deepEqual(before, emptyCheckpoint());
  assert.throws(
    () =>
      advanceDiscovery(next, {
        observed_at: new Date(epoch).toISOString(),
        sources: [{ ...source, extra: "x".repeat(32 * 1024 * 1024) }],
      }),
    /byte envelope/,
  );
  assert.equal(Object.keys(next.pending).length, 12001);
});

void test("optional-manifest checkpoint interruption cannot discard completed primary research", () => {
  const h = primaryFixture();
  h.setAllowance(100);
  const persist = h.context.primaryProgress.persist;
  let interrupted = false;
  h.context.primaryProgress.persist = () => {
    persist();
    const saved = h.entries["owner/game"] as { reads: { endpoint: string }[] } | undefined;
    if (!interrupted && saved?.reads.at(-1)?.endpoint.includes("/contents/.recomp.json?")) {
      interrupted = true;
      throw new Error("fixture interruption at optional manifest");
    }
  };
  assert.throws(
    () => investigateDiscoveryUpstream(h.context, "owner/game"),
    /checkpoint interrupted/,
  );
  const saved = h.entries["owner/game"] as { reads: { endpoint: string }[] };
  assert.ok(saved.reads.at(-1)!.endpoint.includes("/contents/.recomp.json?"));
  const accepted = saved.reads
    .map((read) => read.endpoint)
    .filter((endpoint) => !endpoint.includes(".recomp.json"));
  h.context.primaryProgress.persist = persist;
  h.setAllowance(100);
  const result = investigateDiscoveryUpstream(h.context, "owner/game");
  assert.equal(result.releases.length, 24);
  for (const endpoint of accepted)
    assert.equal(
      h.calls.filter((call) => call.endpoint === endpoint && !call.conditional).length,
      1,
    );
});
