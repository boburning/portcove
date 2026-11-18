import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { execFileSync } from "node:child_process";
import {
  projectPublicCatalog,
  publicCatalogFiles,
  writePublicCatalog,
  publicCatalogUnchanged,
  retainPublicCatalogCapture,
} from "./public-catalog.mts";

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

void test("future and malformed original identities never claim reviewed editions", async () => {
  for (const original_game of [
    { ...identity("game-a"), format_version: 999 },
    { ...identity("game-a"), source_editions: [{ title: "Invented edition" }] },
    {
      ...identity("game-a"),
      source_editions: [{ id: "edition-a", title: "Invented edition", evidence_urls: [] }],
    },
    {
      ...identity("game-a"),
      source_editions: [
        {
          id: "edition-a",
          title: "Invented edition",
          system: "../bad",
          evidence_urls: ["https://example.org"],
        },
      ],
    },
  ]) {
    const projection = fixture([entry("project", { original_game })]);
    assert.equal(projection.entries[0]!.game_id, null);
    assert.deepEqual(projection.entries[0]!.editions, []);
    assert.deepEqual(projection.entries[0]!.identity_evidence, []);
    const files = await publicCatalogFiles(projection);
    const page = files.get("projects/project/index.html")!.toString();
    assert.doesNotMatch(page, /Reviewed source editions|Invented edition/u);
    assert.match(page, /Source edition identity has not been reviewed/u);
  }
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
        methods: [{ kind: "future-method", evidence_urls: ["https://example.org/method"] }],
        dependencies: [],
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

void test("public setup notes retain only their text and remain separate from steps", async () => {
  const projection = fixture([
    entry("notes", {
      manual_setup: {
        steps: [{ title: "Install", instruction: "Use the upstream package." }],
        references: [
          {
            title: "System <requirements>",
            instruction: "Use OS 12 & newer.",
            private_path: "PRIVATE_PATH",
          },
        ],
      },
    }),
    entry("plain"),
  ]);
  const files = await publicCatalogFiles(projection);
  const page = files.get("projects/notes/index.html")!.toString();
  assert.match(page, /<summary>Setup notes<\/summary>/u);
  assert.match(page, /<dt>System &lt;requirements&gt;<\/dt><dd>Use OS 12 &amp; newer\.<\/dd>/u);
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_PATH/u);
  assert.doesNotMatch(files.get("projects/plain/index.html")!.toString(), /<summary>Setup notes/u);
});

void test("unevidenced methods and malformed dependency claims remain unavailable", async () => {
  const projection = fixture([
    entry("project", {
      implementation: {
        format_version: 1,
        methods: [
          { kind: "static-recompilation", evidence_urls: [] },
          { kind: "source-port", evidence_urls: ["javascript:alert(1)"] },
        ],
        dependencies: [
          {
            kind: "runtime",
            name: "Unverified runtime",
            confidence: "confirmed",
            project_url: "https://example.org/runtime",
            evidence_urls: [],
          },
          {
            kind: "runtime",
            name: "Unknown confidence",
            confidence: "made-up",
            project_url: "https://example.org/runtime",
            evidence_urls: ["https://example.org/source"],
          },
          {
            kind: "runtime",
            name: "Valid runtime",
            confidence: "inferred",
            project_url: "https://example.org/runtime",
            evidence_urls: ["https://example.org/source"],
            version_scope: "v1 only",
          },
        ],
      },
    }),
  ]);
  assert.deepEqual(projection.entries[0]!.methods, []);
  assert.equal(projection.entries[0]!.dependencies.length, 1);
  const page = (await publicCatalogFiles(projection))
    .get("projects/project/index.html")!
    .toString();
  assert.doesNotMatch(page, /Unverified runtime|Unknown confidence|Static recompilation/u);
  assert.match(page, /Valid runtime/u);
  assert.match(page, /inferred/u);
  assert.match(page, /Applies to: v1 only/u);
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

void test("current publisher reuses unchanged capture bytes across unrelated main revisions and clocks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-catalog-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = fixture([entry("one")]);
  const prior = path.join(root, "prior");
  await writePublicCatalog(initial, prior);
  const next = {
    ...initial,
    source_revision: "b".repeat(40),
    source_url: `https://github.com/boburning/portcove/tree/${"b".repeat(40)}`,
    observed_at: "2026-11-19T02:00:00.000Z",
  };
  assert.deepEqual(
    await publicCatalogFiles(await retainPublicCatalogCapture(next, prior)),
    await publicCatalogFiles(initial),
  );
  const listingBytes = Buffer.from(
    JSON.stringify({ format_version: 12, listings: [entry("one")] }),
  );
  const catalogBytes = Buffer.from(JSON.stringify({ schema_version: 3, ports: [] }));
  assert.equal(await publicCatalogUnchanged(listingBytes, catalogBytes, prior), true);
  assert.equal(
    await publicCatalogUnchanged(Buffer.from('{"listings":[]}'), catalogBytes, prior),
    false,
  );
  assert.equal(
    await publicCatalogUnchanged(listingBytes, catalogBytes, path.join(root, "absent")),
    false,
  );
  const changed = fixture([entry("two")]);
  assert.deepEqual(await retainPublicCatalogCapture(changed, prior), changed);
});

void test("publisher CLI adds generated browsing alongside immutable assembled TUF bytes", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "public-catalog-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "metadata"), { recursive: true });
  await mkdir(path.join(repository, "targets"));
  const timestamp = Buffer.from("inert assembled timestamp; not a signature fixture");
  const target = Buffer.from("immutable signed target placeholder");
  await writeFile(path.join(repository, "metadata/timestamp.json"), timestamp);
  await writeFile(path.join(repository, "targets/game.json"), target);
  const listings = path.join(root, "listings.json"),
    catalog = path.join(root, "catalog.json");
  await writeFile(listings, JSON.stringify({ format_version: 12, listings: [entry("project")] }));
  await writeFile(catalog, JSON.stringify({ schema_version: 3, ports: [] }));
  const script = new URL("./public-catalog.mts", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const output = path.join(repository, "browse");
  const result: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(script),
        "--listings",
        listings,
        "--catalog",
        catalog,
        "--revision",
        revision,
        "--observed-at",
        observedAt,
        "--prior",
        path.join(root, "absent"),
        "--output",
        output,
      ],
      { encoding: "utf8", timeout: 15000 },
    ),
  );
  assert.ok(isRecord(result));
  assert.equal(result.scope, "development");
  execFileSync(process.execPath, ["--check", path.join(output, "search.js")], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.doesNotMatch(
    (await readFile(path.join(output, "search.js"))).toString(),
    /interface SearchEntry|: SearchEntry\[\]/u,
  );
  assert.deepEqual(await readFile(path.join(repository, "metadata/timestamp.json")), timestamp);
  assert.deepEqual(await readFile(path.join(repository, "targets/game.json")), target);
  assert.match(
    (await readFile(path.join(output, "index.html"))).toString(),
    /Development catalog/u,
  );
  const unchanged = execFileSync(
    process.execPath,
    [
      fileURLToPath(script),
      "unchanged",
      "--listings",
      listings,
      "--catalog",
      catalog,
      "--prior",
      output,
    ],
    { encoding: "utf8", timeout: 15000 },
  ).trim();
  assert.equal(unchanged, "true");
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
