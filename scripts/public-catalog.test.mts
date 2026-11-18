import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { projectPublicCatalog, publicCatalogFiles, writePublicCatalog } from "./public-catalog.mts";

const revision = "e57f3296a94a2e914293ecc6da315f0294beef00";
const observedAt = "2026-11-18T02:00:00Z";
function fixture(listings: unknown[], ports: unknown[] = []) {
  return projectPublicCatalog({
    listings: Buffer.from(JSON.stringify({ format_version: 12, listings })),
    catalog: Buffer.from(JSON.stringify({ schema_version: 3, ports })),
    revision,
    observedAt,
  });
}
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Project ${id}`,
  summary: "Game description",
  project_url: "https://example.org/game",
  platforms: ["linux-aarch64"],
  availability: "unknown",
  ...extra,
});
const identity = (id: string) => ({
  format_version: 1,
  id,
  evidence_urls: ["https://example.org/identity"],
  source_editions: [
    {
      id: "edition-a",
      title: "Nintendo 64 USA 1.0",
      system: "nintendo-64",
      evidence_urls: ["https://example.org/originals"],
    },
  ],
});

void test("reviewed game identities group alternatives while title collisions and shared runtimes stay separate", async () => {
  const p = fixture([
    entry("recomp", { original_game_title: "Game", original_game: identity("game-a") }),
    entry("decomp", { original_game_title: "Game", original_game: identity("game-a") }),
    entry("engine-game-b", { original_game_title: "Game", original_game: identity("game-b") }),
    entry("unknown", { original_game_title: "Game" }),
  ]);
  const files = await publicCatalogFiles(p);
  assert.ok(files.has("games/game-a/index.html"));
  assert.ok(files.has("games/game-b/index.html"));
  assert.ok(files.has("projects/unknown/index.html"));
  const game = files.get("games/game-a/index.html")!.toString();
  assert.match(game, /Compare implementations/u);
  assert.match(game, /Nintendo 64 USA 1.0/u);
  assert.match(game, /linux-aarch64/u);
  assert.doesNotMatch(game, /Project engine-game-b/u);
  assert.match(game, /No personal recommendation/u);
});

void test("OpenSHC release claim, unknown methods and missing enrichment create no install or support claim", async () => {
  const p = fixture([
    entry("openshc", {
      availability: "packages",
      release_url: "https://github.com/sourcehold/OpenSHC/releases/tag/latest-sarif",
      implementation: {
        format_version: 1,
        methods: [{ kind: "future-method", evidence_urls: [] }],
      },
    }),
  ]);
  const files = await publicCatalogFiles(p);
  const page = files.get("projects/openshc/index.html")!.toString();
  assert.match(page, /research reports rather than a playable package/u);
  assert.match(page, /Method not recognized/u);
  assert.match(page, /Descriptive listing only/u);
  assert.match(page, /Published delivery<\/dt><dd>Not checked/u);
  assert.doesNotMatch(page, /portcove:|href="[^"]*install|Supported/u);
  assert.equal(p.entries[0]!.declared_platforms.length, 0);
});

void test("public allowlist strips private state, unsafe links and external markup", async () => {
  const p = fixture(
    [
      entry("game", {
        name: '<img src=x onerror="alert(1)">',
        summary: "</script><script>alert(2)</script>",
        project_url: "javascript:alert(3)",
        setup_url: "https://secret@example.org",
        private_maintenance: { token: "TOP_SECRET" },
        local_path: "C:\\Users\\player",
        implementation: { format_version: 99, methods: [{ kind: "static-recompilation" }] },
      }),
    ],
    [
      {
        id: "game",
        persistent_paths: ["PRIVATE_SAVE"],
        release: { token: "TOP_SECRET" },
        platforms: ["windows-x86-64"],
        presentation: {
          source_requirements: [{ label: "Original cartridge dump", path: "PRIVATE_PATH" }],
          installation_method: "portable-recompilation",
        },
      },
    ],
  );
  const files = await publicCatalogFiles(p);
  const all = [...files.values()].map((bytes) => bytes.toString()).join("\n");
  assert.doesNotMatch(all, /TOP_SECRET|PRIVATE_SAVE|PRIVATE_PATH|C:\\\\Users|javascript:alert/u);
  assert.doesNotMatch(
    files.get("projects/game/index.html")!.toString(),
    /<img src=x|<script>alert/u,
  );
  assert.match(all, /&lt;img/u);
  assert.equal(p.entries[0]!.methods.length, 0);
  assert.equal(p.entries[0]!.project_url, undefined);
  assert.equal(p.entries[0]!.setup_url, undefined);
  assert.match(all, /Original cartridge dump/u);
});

void test("public projection validates stable identities, duplicates, UTF-8, bounds and immutable source", () => {
  assert.throws(() => fixture([entry("../../escape")]), /identity/u);
  assert.throws(() => fixture([entry("same"), entry("same")]), /identity/u);
  assert.throws(
    () =>
      projectPublicCatalog({
        listings: Buffer.from([0xff]),
        catalog: Buffer.from("{}"),
        revision,
        observedAt,
      }),
    /UTF-8/u,
  );
  assert.throws(
    () =>
      projectPublicCatalog({
        listings: Buffer.alloc(32 * 1024 ** 2 + 1),
        catalog: Buffer.from("{}"),
        revision,
        observedAt,
      }),
    /bound/u,
  );
  assert.throws(
    () =>
      projectPublicCatalog({
        listings: Buffer.from("{}"),
        catalog: Buffer.from("{}"),
        revision: "main",
        observedAt,
      }),
    /exact revision/u,
  );
});

void test("new-directory output is reproducible, leaves an existing result intact and contains no live provider reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = fixture([entry("one")]);
  const first = await publicCatalogFiles(p),
    second = await publicCatalogFiles(p);
  assert.deepEqual(first, second);
  const output = path.join(root, "browse");
  await writePublicCatalog(p, output);
  const before = await readFile(path.join(output, "index.html"));
  await assert.rejects(writePublicCatalog(fixture([entry("two")]), output));
  assert.deepEqual(await readFile(path.join(output, "index.html")), before);
  const script = first.get("search.js")!.toString();
  assert.match(script, /fetch\(['"]search-index.json/u);
  assert.doesNotMatch(script, /api.github|innerHTML|eval\(/u);
});

void test("actual reviewed Majora's Mask records produce a comparison and independent original edition and target facts", async () => {
  const base = new URL("../crates/portcove-core/catalog/", import.meta.url);
  const [listings, catalog] = await Promise.all([
    readFile(new URL("listings.json", base)),
    readFile(new URL("catalog.json", base)),
  ]);
  const p = projectPublicCatalog({ listings, catalog, revision, observedAt });
  const files = await publicCatalogFiles(p);
  const page = files.get("games/the-legend-of-zelda-majoras-mask/index.html")!.toString();
  assert.match(page, /2Ship2Harkinian/u);
  assert.match(page, /Zelda 64: Recompiled/u);
  assert.match(page, /Source edition|Reviewed source editions/u);
  assert.match(page, /Development catalog/u);
  assert.match(page, /Published delivery<\/dt><dd>Not checked/u);
  assert.ok(files.get("search-index.json")!.length < 4 * 1024 ** 2);
});
