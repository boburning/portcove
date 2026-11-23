import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDecompBuddyCatalog,
  parseDecompBuddyWaiting,
  parseDecompFunGames,
  parseDecompFunProjects,
  parseRecompendiumCatalog,
  parseUnbakedGame,
  parseUnbakedInventory,
} from "./discovery-source-parsers.mts";
import {
  completeExternalInventory,
  dueExternalInventoryItems,
  externalHintSummary,
  mergeExternalInventoryItem,
  mergeExternalList,
  parseExternalLeadState,
  recordExternalInventory,
  recordExternalInventoryItemFailure,
} from "./discovery-external-lists.mts";

const now = "2026-11-23T17:00:00.000Z";
const day = 86400000;
const later = (days: number) => new Date(Date.parse(now) + days * day).toISOString();

// Shapes observed live on 2026-11-23; identities are anonymized.
const catalog = (games: unknown[], count = games.length) =>
  JSON.stringify({
    schema: 1,
    generatedAt: "2026-11-23T14:24:32.842Z",
    count,
    sources: { finds: { label: "Individual Finds", count: 1 } },
    games,
  });
const catalogGame = (id: string, repoUrl: string, extra: Record<string, unknown> = {}) => ({
  id,
  slug: id.split("#")[1] ?? "game",
  title: "Game",
  console: "Wii",
  repoUrl,
  host: "github",
  platforms: ["Linux", "Windows"],
  version: "v1.0.0",
  latestVersion: "v1.4.0",
  status: "latest",
  sources: ["portsdr", "finds"],
  facts: { completeness: "playable", takedown: false },
  ...extra,
});

void test("Decomp Buddy's catalog keeps per-game claims, lineage and unsupported hosts", () => {
  const parsed = parseDecompBuddyCatalog(
    catalog([
      catalogGame("github:owner/driftdroid#mario-kart-wii", "https://github.com/owner/driftdroid"),
      catalogGame("github:owner/driftdroid#other-game", "https://github.com/owner/driftdroid", {
        title: "Other Game",
      }),
      catalogGame("magicbean:team/port", "https://git.magicbean.dev/team/port", {
        sources: ["list:https://tanookistudios.com/decomp-buddy/magicbean.json"],
        takedown: true,
      }),
    ]),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.key, entry.host]),
    [
      ["https://git.magicbean.dev/team/port", "web"],
      ["https://github.com/owner/driftdroid", "github"],
    ],
  );
  const shared = parsed.entries[1]!.source_entries!;
  assert.equal(shared.length, 2, "a multi-game repository keeps each game's claim");
  assert.deepEqual(shared[0]!.origin, ["decomp-buddy-finds", "portsdr"]);
  assert.deepEqual(shared[0]!.targets, ["Linux", "Windows"]);
  assert.equal(shared[0]!.latest_release, "v1.4.0");
  assert.equal(shared[0]!.method, "playable");
  assert.equal(parsed.entries[0]!.source_entries![0]!.status, "latest,takedown");
  assert.throws(() => parseDecompBuddyCatalog(catalog([], 2)), /Incomplete/u);
  assert.throws(
    () => parseDecompBuddyCatalog(JSON.stringify({ schema: 2, count: 0, games: [] })),
    /Unsupported Decomp Buddy catalog schema/u,
  );
  assert.throws(() => parseDecompBuddyCatalog("{"), /Malformed/u);
});

void test("Decomp Buddy's waiting projects are hints and its own rejections are excluded", () => {
  const parsed = parseDecompBuddyWaiting(
    JSON.stringify({
      updatedAt: now,
      games: [{ repo: "owner/piney", title: ".hack", console: "PlayStation 2" }],
      hidden: [{ repo: "owner/list", title: "awesome list", reason: "Not a game" }],
    }),
  );
  assert.equal(parsed.entries[0]!.key, "https://github.com/owner/piney");
  assert.equal(parsed.entries[0]!.source_entries![0]!.status, "waiting");
  assert.equal(parsed.excluded, 1);
});

const project = (owner: string, repo: string, extra: Record<string, unknown> = {}) => ({
  owner,
  repo,
  name: repo,
  repository: `https://github.com/${owner}/${repo}`,
  game_title: "Battle Game",
  platform: { key: "gc", name: "GameCube" },
  slot: "gc:battle-game",
  leader: true,
  listed_as: `${owner}/${repo}`,
  archived: false,
  versions: [{ id: "GQPE78", default: true, decompiled_percent: 38.06 }],
  ...extra,
});

void test("decomp.fun keeps alternate implementations and treats progress in bands", () => {
  const projects = parseDecompFunProjects(
    JSON.stringify({
      api_version: 1,
      projects: [
        project("lead", "game"),
        project("other", "game", { leader: false, listed_as: "lead/game" }),
      ],
    }),
  );
  assert.equal(projects.entries.length, 2, "a leader never suppresses another project");
  const [leader, alternate] = projects.entries.map((entry) => entry.source_entries![0]!);
  assert.equal(leader!.status, "leader");
  assert.equal(alternate!.status, "alternate-of:lead/game");
  assert.deepEqual(leader!.games, ["gc:battle-game"]);
  assert.equal(leader!.progress_band, 3);
  const moved = parseDecompFunProjects(
    JSON.stringify({
      api_version: 1,
      projects: [
        project("lead", "game", { versions: [{ default: true, decompiled_percent: 39.9 }] }),
      ],
    }),
  );
  assert.equal(
    moved.entries[0]!.source_entries![0]!.fingerprint,
    leader!.fingerprint,
    "a small percentage move is not a change",
  );
  assert.throws(
    () => parseDecompFunProjects(JSON.stringify({ api_version: 2, projects: [] })),
    /API version/u,
  );

  const games = parseDecompFunGames(
    JSON.stringify({
      api_version: 1,
      count: 1,
      games: {
        "gc:battle-game": {
          platform: "gc",
          title: "Battle Game",
          leader: "lead/game",
          decompiled_percent: 38.06,
          others: ["other/game"],
        },
      },
    }),
  );
  assert.deepEqual(
    games.entries.map((entry) => [entry.key, entry.source_entries![0]!.status]),
    [
      ["https://github.com/lead/game", "leader"],
      ["https://github.com/other/game", "alternate-of:lead/game"],
    ],
  );
  assert.throws(
    () => parseDecompFunGames(JSON.stringify({ api_version: 1, count: 2, games: {} })),
    /Incomplete/u,
  );
});

const inventoryRow = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title: slug,
  platform: "PC",
  has_public_code: true,
  stars: 1,
  last_push: "2026-11-15",
  runs_on: ["Windows"],
  url: `https://unbaked.games/games/${slug}/`,
  json: `https://unbaked.games/api/games/${slug}.json`,
  ...extra,
});
const gameRecord = (slug: string, projects: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ slug, title: slug, platform: "DOS", has_public_code: true, projects, ...extra });

void test("unbaked's inventory and records keep projects, candidates and official sites", () => {
  const rows = parseUnbakedInventory(
    JSON.stringify({ count: 2, games: [inventoryRow("doom"), inventoryRow("spelunky-2")] }),
  );
  assert.deepEqual(
    rows.map((row) => row.slug),
    ["doom", "spelunky-2"],
  );
  const starred = parseUnbakedInventory(
    JSON.stringify({ count: 1, games: [inventoryRow("doom", { stars: 99 })] }),
  );
  assert.equal(starred[0]!.fingerprint, rows[0]!.fingerprint, "popularity is not a change");
  const pushed = parseUnbakedInventory(
    JSON.stringify({ count: 1, games: [inventoryRow("doom", { last_push: "2026-11-23" })] }),
  );
  assert.notEqual(pushed[0]!.fingerprint, rows[0]!.fingerprint);
  for (const bad of [
    { count: 3, games: [inventoryRow("doom")] },
    { games: [inventoryRow("doom", { json: "https://evil.example/doom.json" })] },
    { games: [inventoryRow("doom"), inventoryRow("doom")] },
  ])
    assert.throws(() => parseUnbakedInventory(JSON.stringify(bad)), /unbaked inventory/u);

  const doom = parseUnbakedGame(
    gameRecord("doom", [
      {
        name: "a",
        url: "https://github.com/owner/a",
        methods: ["Source port"],
        runs_on: ["Linux"],
      },
      { name: "b", url: "https://sourceforge.net/projects/b/files/", methods: ["Source port"] },
      { name: "c", url: null, website: "https://c.example.org/", methods: ["Source port"] },
      { name: "d", url: null, website: null },
      { name: "tool", url: "https://github.com/owner/tool", general_tool: true },
    ]),
    "doom",
  );
  assert.deepEqual(
    doom.entries.map((entry) => [entry.key, entry.host]),
    [
      ["https://c.example.org", "web"],
      ["https://github.com/owner/a", "github"],
      ["https://sourceforge.net/projects/b", "web"],
    ],
  );
  assert.equal(doom.unlinked, 1);
  assert.equal(doom.excluded, 1, "a general tool is outside native-port scope");
  const candidate = parseUnbakedGame(
    gameRecord(
      "spelunky-2",
      [{ name: "overlay", url: "https://github.com/owner/overlay", methods: ["RE candidate"] }],
      { has_public_code: false },
    ),
    "spelunky-2",
  );
  assert.match(candidate.entries[0]!.source_entries![0]!.status, /candidate-without-public-code/u);
  assert.throws(() => parseUnbakedGame(gameRecord("other", []), "doom"), /Unsupported/u);
});

void test("an unbaked baseline resumes after interruption, reconciles changes and keeps hints", () => {
  const rows = parseUnbakedInventory(
    JSON.stringify({
      count: 3,
      games: [inventoryRow("a"), inventoryRow("b"), inventoryRow("c", { has_public_code: false })],
    }),
  );
  let state = recordExternalInventory(undefined, "unbaked-registry", rows, now, "f".repeat(64));
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", now), ["a", "b", "c"]);
  const record = (slug: string) =>
    parseUnbakedGame(
      gameRecord(slug, [{ name: slug, url: `https://github.com/owner/${slug}` }]),
      slug,
    );
  // A run stops after one record: its findings stand and the rest stay due.
  state = mergeExternalInventoryItem(state, "unbaked-registry", "a", record("a"), now);
  assert.ok(state.hints["https://github.com/owner/a"]);
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", now), ["b", "c"]);
  assert.throws(
    () => completeExternalInventory(state, "unbaked-registry", now, "games.json"),
    /due items/u,
  );
  assert.equal(
    state.lists["unbaked-registry"],
    undefined,
    "no complete claim over unfinished work",
  );
  // A failed record waits a day; a later run finishes the rest.
  state = recordExternalInventoryItemFailure(state, "unbaked-registry", "b", now);
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", now), ["c"]);
  state = mergeExternalInventoryItem(state, "unbaked-registry", "c", record("c"), now);
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", now), []);
  assert.throws(
    () => completeExternalInventory(state, "unbaked-registry", now, "games.json"),
    /due items/u,
    "an item waiting out a failed read keeps the list incomplete",
  );
  const next = later(1);
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", next), ["b"]);
  state = mergeExternalInventoryItem(state, "unbaked-registry", "b", record("b"), next);
  state = completeExternalInventory(state, "unbaked-registry", next, "games.json");
  assert.equal(state.lists["unbaked-registry"]?.entries, 3);
  assert.deepEqual(parseExternalLeadState(state), state);
  const summary = externalHintSummary(state, new Set(), new Map(), next);
  assert.deepEqual(summary.inventories["unbaked-registry"], {
    inventory_at: now,
    items: 3,
    read: 3,
    due: 0,
    candidates_without_public_code: 1,
  });

  // A changed row is due again; an unchanged one waits for reconciliation.
  const changed = parseUnbakedInventory(
    JSON.stringify({
      count: 2,
      games: [inventoryRow("a", { last_push: "2026-11-24" }), inventoryRow("b")],
    }),
  );
  state = recordExternalInventory(state, "unbaked-registry", changed, later(2), "e".repeat(64));
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", later(2)), ["a"]);
  assert.deepEqual(dueExternalInventoryItems(state, "unbaked-registry", later(31)), ["a", "b"]);
  // A record read by another parser version is read again.
  const reparsed = structuredClone(state);
  reparsed.inventories!["unbaked-registry"]!.items.b!.parser = 0;
  assert.deepEqual(dueExternalInventoryItems(reparsed, "unbaked-registry", later(2)), ["a", "b"]);
  assert.ok(state.hints["https://github.com/owner/c"], "leaving the registry keeps the hint");
  assert.equal(state.inventories?.["unbaked-registry"]?.items.c, undefined);

  // A record naming the same project as another source joins its hint.
  const merged = mergeExternalList(
    state,
    "unbaked-additions",
    {
      entries: [
        {
          key: "https://github.com/owner/a",
          url: "https://github.com/owner/a",
          host: "github",
          title: "a",
        },
      ],
      unlinked: 0,
    },
    later(2),
    "additions.json",
  );
  assert.deepEqual(merged.hints["https://github.com/owner/a"]?.lists, [
    "unbaked-additions",
    "unbaked-registry",
  ]);
});

void test("Recompendium keeps identities and attributed claims, never its prose", () => {
  const parsed = parseRecompendiumCatalog(
    JSON.stringify({
      formato: 1,
      generado: now,
      entradas: [
        {
          entry: "recomps/007-agent-under-fire",
          juego: "007-agent-under-fire",
          nombre: "007: Agent Under Fire",
          proyecto: "007: Agent Under Fire",
          repo: "owner/007-recomp",
          consola: "xbox",
          estado: "playable",
          metodo: "recomp",
          toolchain: "XboxXBE-Recomp",
          retirado: false,
          sin_enlace: false,
          version: "v1.0.3",
          desc: { es: "Texto con licencia", en: "Licensed text" },
          requisitos: { en: "Windows 10" },
        },
        {
          entry: "ports/re3",
          juego: "gta3",
          nombre: "re3",
          repo: "GTAmodding/re3",
          retirado: true,
        },
        { entry: "ports/nolink", juego: "x", nombre: "x", repo: "", sin_enlace: true },
      ],
    }),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => entry.key),
    ["https://github.com/gtamodding/re3", "https://github.com/owner/007-recomp"],
  );
  const claim = parsed.entries[1]!.source_entries![0]!;
  assert.equal(claim.method, "recomp,XboxXBE-Recomp");
  assert.equal(claim.latest_release, "v1.0.3");
  assert.deepEqual(claim.games, ["007-agent-under-fire"]);
  assert.doesNotMatch(JSON.stringify(parsed), /Licensed text|Windows 10/u);
  assert.match(parsed.entries[0]!.source_entries![0]!.status, /retired/u);
  assert.equal(parsed.unlinked, 1);
  assert.throws(
    () => parseRecompendiumCatalog(JSON.stringify({ formato: 2, entradas: [] })),
    /Unsupported/u,
  );
});
