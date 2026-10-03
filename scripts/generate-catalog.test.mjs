import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

function run(...args) {
  return spawnSync(process.execPath, ["scripts/generate-catalog.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("current schema-2 authoring deterministically owns the embedded catalog", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);

  const current = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8"),
  );
  const embedded = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.deepEqual(embedded, current);
  assert.equal(current.schema_version, 2);
  assert.equal("source_profiles" in current, false);

  const portIds = new Set(current.ports.map((port) => port.id));
  const identityIds = new Set(current.source_catalog.identities.map((identity) => identity.id));
  const evidenceIds = new Set(current.source_catalog.evidence.map((evidence) => evidence.id));
  assert.equal(portIds.size, current.ports.length);
  assert.equal(identityIds.size, current.source_catalog.identities.length);
  assert.equal(evidenceIds.size, current.source_catalog.evidence.length);
  for (const contract of current.source_catalog.contracts) {
    assert.equal(portIds.has(contract.port_id), true, contract.id);
    assert.equal(identityIds.has(contract.profile_id), true, contract.id);
    for (const evidenceId of contract.evidence_ids) {
      assert.equal(evidenceIds.has(evidenceId), true, `${contract.id}: ${evidenceId}`);
    }
  }
});

test("semantic comparison reports every historical-to-current difference", () => {
  const result = run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  const comparison = JSON.parse(result.stdout);
  assert.equal(typeof comparison.equal, "boolean");
  assert.match(comparison.historical_sha256, /^[0-9a-f]{64}$/u);
  assert.match(comparison.current_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Array.isArray(comparison.differences));
  assert.equal(comparison.equal, comparison.differences.length === 0);
  for (const difference of comparison.differences) assert.match(difference.path, /^\$/u);
});

test("artwork proposal batches reuse accepted choices and separately prove identity and bytes", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const accepted = {
    ports: [
      {
        id: "accepted",
        name: "Accepted",
        project_url: "https://example.org/accepted",
        presentation: {
          artwork: {
            game_id: 1,
            cover_id: 2,
            image_id: "co1",
            image_sha256: "a".repeat(64),
            game_slug: "accepted",
            match_kind: "port",
          },
        },
      },
    ],
  };
  const catalog = structuredClone(accepted);
  catalog.ports.push({
    id: "new-port",
    name: "New Port",
    project_url: "https://example.org/new",
    release: { version: "2" },
  });
  const before = structuredClone(catalog);
  const queries = [];
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: accepted,
    identities: {
      "new-port": {
        port: {
          game_id: 3,
          slug: "new-port",
          names: ["New Port"],
          evidence_url: "https://example.org/new",
        },
      },
    },
    inspectGame: async (identity) => {
      queries.push(identity.game_id);
      return [{ id: 3, slug: "new-port", name: "New Port", cover: { id: 4, image_id: "co2" } }];
    },
    inspectImage: async () => ({
      sha256: "b".repeat(64),
      bytes: 1024,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  assert.deepEqual(catalog, before);
  assert.deepEqual(queries, [3]);
  assert.equal(result.records[0].reason, "accepted-mapping-reused");
  assert.equal(result.records[1].reason, "exact-port-cover");
  assert.equal(result.catalog.ports[1].presentation.artwork.game_id, 3);
  assert.deepEqual(result.catalog.ports[1].release, before.ports[1].release);
  assert.equal(result.metrics.reused, 1);
  assert.equal(result.metrics.selected, 1);
});

test("coverless port falls through to exact original; ambiguous and failed images remain nonblocking", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const target = (game_id, slug) => ({
    game_id,
    slug,
    names: [slug],
    evidence_url: "https://example.org/facts",
  });
  const catalog = {
    ports: ["original", "ambiguous", "failed"].map((id) => ({
      id,
      name: id,
      project_url: `https://example.org/${id}`,
    })),
  };
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: { ports: [] },
    identities: {
      original: { port: target(1, "port"), underlying_game: target(2, "original") },
      ambiguous: { port: target(3, "ambiguous") },
      failed: { port: target(4, "failed") },
    },
    inspectGame: async ({ game_id, slug }) => {
      const game = {
        id: game_id,
        name: slug,
        slug,
        cover: game_id === 1 ? null : { id: game_id, image_id: `co${game_id}` },
      };
      return game_id === 3 ? [game, game] : [game];
    },
    inspectImage: async (image_id) => {
      if (image_id === "co4") throw new Error("provider unavailable");
      return {
        sha256: "c".repeat(64),
        bytes: 100,
        width: 264,
        height: 374,
        format: "jpeg",
        validator: "portcove-core",
      };
    },
  });
  assert.equal(result.records[0].reason, "exact-original-game-cover");
  assert.equal(result.catalog.ports[0].presentation.artwork.match_kind, "underlying-game");
  assert.equal(result.records[1].reason, "generated-fallback");
  assert.equal(result.records[1].exceptions[0].reason, "identity-not-unique");
  assert.equal(result.records[2].exceptions[0].reason, "image-unavailable-or-invalid");
  assert.equal(result.metrics.fallback, 2);
});

test("the entire accepted cover inventory survives a routine executable release without lookup", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const accepted = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8"),
  );
  const input = structuredClone(accepted);
  input.ports[0].release.version = "ordinary-successor";
  const result = await prepareCatalogArtwork(input, {
    acceptedCatalog: accepted,
    inspectGame: () => assert.fail("unchanged accepted artwork must not search"),
    inspectImage: () => assert.fail("unchanged accepted artwork must not download"),
  });
  assert.equal(result.metrics.reused, accepted.ports.length);
  assert.equal(result.metrics.fallback, 0);
  assert.deepEqual(result.catalog, input);
});

test("another port can reuse a uniquely accepted original-game asset without merging port identities", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const mapping = {
    game_id: 2,
    cover_id: 3,
    image_id: "co2",
    image_sha256: "a".repeat(64),
    game_slug: "original",
    match_kind: "underlying-game",
  };
  const accepted = {
    ports: [
      {
        id: "first-port",
        name: "First",
        project_url: "https://example.org/first",
        presentation: { artwork: mapping },
      },
    ],
  };
  const input = {
    ports: [
      {
        id: "second-port",
        name: "Second",
        project_url: "https://example.org/second",
        source_profile: "distinct-contract",
      },
    ],
  };
  const result = await prepareCatalogArtwork(input, {
    acceptedCatalog: accepted,
    identities: {
      "second-port": {
        underlying_game: {
          game_id: 2,
          slug: "original",
          names: ["Original"],
          evidence_url: "https://example.org/original-facts",
        },
      },
    },
    inspectGame: async (identity) => {
      assert.equal(identity.project_url, "https://example.org/second");
      return [];
    },
    inspectImage: () => assert.fail("accepted original bytes need no repeated download"),
  });
  assert.equal(result.records[0].reason, "accepted-original-game-reused");
  assert.equal(result.metrics.original_reused, 1);
  assert.equal(result.metrics.game_queries, 1);
  assert.equal(result.catalog.ports[0].id, "second-port");
  assert.equal(result.catalog.ports[0].source_profile, "distinct-contract");
  assert.deepEqual(result.catalog.ports[0].presentation.artwork, mapping);
});

test("ordinary names require exact attributable project evidence, including shared repositories", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const catalog = {
    ports: [
      { id: "one", name: "One", project_url: "https://github.com/Owner/Shared" },
      { id: "two", name: "Two", project_url: "https://github.com/Owner/Shared" },
      { id: "collision", name: "Collision", project_url: "https://github.com/Owner/Other" },
      { id: "custom-port", name: "Custom", project_url: "https://github.com/Owner/Shared" },
    ],
  };
  const queries = [];
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: { ports: [] },
    inspectGame: async (identity) => {
      queries.push(identity);
      return [
        {
          id: identity.names[0] === "One" ? 1 : 2,
          name: identity.names[0],
          slug: identity.names[0].toLowerCase(),
          websites: [
            {
              url:
                identity.names[0] === "Custom"
                  ? "https://github.com:444/owner/shared/"
                  : "https://github.com/owner/shared/",
            },
          ],
          cover: { id: 3, image_id: "co3" },
        },
      ];
    },
    inspectImage: async () => ({
      sha256: "a".repeat(64),
      bytes: 100,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  assert.equal(queries.length, 4);
  assert.ok(queries.every((identity) => identity.game_id === null));
  assert.deepEqual(
    result.records.map((record) => record.reason),
    ["exact-port-cover", "exact-port-cover", "generated-fallback", "generated-fallback"],
  );
  assert.equal(result.catalog.ports[0].presentation.artwork.game_id, 1);
  assert.equal(result.catalog.ports[1].presentation.artwork.game_id, 2);
  assert.equal(result.metrics.image_queries, 1);
  assert.equal(result.records[2].exceptions[0].reason, "identity-mismatch");
  assert.equal(result.records[3].exceptions[0].reason, "identity-mismatch");
});

test("original-game name lookup requires platform and edition evidence and refuses truncated results", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const input = {
    ports: [{ id: "original", name: "Port", project_url: "https://example.org/port" }],
  };
  const identities = {
    original: {
      underlying_game: {
        names: ["Original"],
        platform_ids: [4],
        evidence_url: "https://example.org/source-facts",
      },
    },
  };
  const setup = (games) => ({
    acceptedCatalog: { ports: [] },
    identities,
    inspectGame: async (identity) => (identity.kind === "port" ? [] : games),
    inspectImage: async () => ({
      sha256: "b".repeat(64),
      bytes: 100,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  const base = {
    id: 1,
    slug: "original",
    name: "Original",
    platforms: [4],
    cover: { id: 3, image_id: "co3" },
  };
  const observed = await prepareCatalogArtwork(
    input,
    setup([base, { ...base, id: 2, platforms: [6], version_title: "Remaster", version_parent: 1 }]),
  );
  assert.equal(observed.records[0].reason, "exact-original-game-cover");
  assert.equal(observed.catalog.ports[0].presentation.artwork.game_id, 1);
  const truncated = await prepareCatalogArtwork(
    input,
    setup(Array.from({ length: 21 }, (_, i) => ({ ...base, id: i + 1 }))),
  );
  assert.equal(truncated.records[0].reason, "generated-fallback");
  assert.equal(truncated.records[0].exceptions[1].reason, "identity-query-incomplete");
});

test("provider requests use fixed origins, bounded metadata and safe strings; auth failure is attempted once", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-provider-contract-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  const calls = [];
  const provider = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata test must not decode"),
    async (url, options) => {
      calls.push({ url, options });
      return new Response(url.includes("oauth2") ? '{"access_token":"fixture-token"}' : "[]");
    },
  );
  await provider.inspectGame({
    names: ['Port"; fields *;'],
    project_url: "https://example.org/port",
    evidence_url: "https://example.org/port",
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://id.twitch.tv/oauth2/token", "https://api.igdb.com/v4/games"],
  );
  assert.ok(calls.every((call) => call.options.redirect === "error"));
  assert.ok(calls[1].options.body.includes('name ~ "Port\\"; fields *;"'));
  assert.ok(calls[1].options.body.endsWith("limit 21;"));
  assert.equal(provider.providerMetrics.authentication_requests, 1);
  assert.equal(provider.providerMetrics.game_requests, 1);
  const denied = createIgdbInspector(
    privateFile,
    () => {},
    async () => new Response("fixture-secret", { status: 403 }),
  );
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      denied.inspectGame({
        game_id: 1,
        slug: "port",
        names: ["Port"],
        evidence_url: "https://example.org/port",
      }),
      /authentication unavailable/,
    );
  assert.equal(denied.providerMetrics.authentication_requests, 1);
  assert.equal(denied.providerMetrics.game_requests, 0);
  const oversized = createIgdbInspector(
    privateFile,
    () => {},
    async (url) =>
      new Response(url.includes("oauth2") ? '{"access_token":"fixture-token"}' : "[]", {
        headers: url.includes("oauth2") ? {} : { "content-length": String(1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    oversized.inspectGame({
      game_id: 1,
      slug: "port",
      names: ["Port"],
      evidence_url: "https://example.org/port",
    }),
    /byte contract/,
  );
});

test("malformed nested provider responses reject only that cover and the actual batch continues", async () => {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-malformed-provider-"));
  const credentials = join(scratch, "private-fixture.json");
  writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  for (const invalid of [
    { websites: [null] },
    { alternative_names: [null] },
    { platforms: ["invalid"] },
    { slug: 123 },
    { slug: ["valid-slug"] },
    { cover: { id: 3, image_id: 123 } },
    { cover: { id: 3, image_id: ["co3"] } },
  ]) {
    const transport = createIgdbInspector(
      credentials,
      () => ({ width: 12, height: 24, format: "jpeg", validator: "portcove-core" }),
      async (url, options) => {
        if (url.includes("oauth2")) return new Response('{"access_token":"fixture"}');
        if (url.includes("images.igdb.com"))
          return new Response(
            readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg")),
            { headers: { "content-type": "image/jpeg" } },
          );
        const good = options.body.includes('"Good"');
        return new Response(
          JSON.stringify([
            {
              id: good ? 2 : 1,
              name: good ? "Good" : "Bad",
              slug: good ? "good" : "bad",
              websites: [{ url: good ? "https://example.org/good" : "https://example.org/bad" }],
              cover: { id: 3, image_id: "co3" },
              ...(good ? {} : invalid),
            },
          ]),
        );
      },
    );
    const result = await prepareCatalogArtwork(
      {
        ports: [
          { id: "bad", name: "Bad", project_url: "https://example.org/bad" },
          { id: "good", name: "Good", project_url: "https://example.org/good" },
        ],
      },
      { ...transport, acceptedCatalog: { ports: [] } },
    );
    assert.equal(result.records[0].reason, "generated-fallback");
    assert.equal(
      result.records[0].exceptions[0].reason,
      invalid.cover ? "no-usable-cover" : "identity-response-invalid",
    );
    assert.equal(result.records[1].reason, "exact-port-cover");
    assert.equal(transport.providerMetrics.authentication_requests, 1);
    assert.equal(transport.providerMetrics.game_requests, 2);
    assert.equal(transport.providerMetrics.image_requests, 1);
  }
});

test("wrong editions and invalid declarations never reach image acquisition", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const result = await prepareCatalogArtwork(
    { ports: [{ id: "port", name: "Port" }] },
    {
      acceptedCatalog: { ports: [] },
      identities: {
        port: {
          port: {
            game_id: 1,
            slug: "expected",
            names: ["Expected"],
            evidence_url: "https://example.org/facts",
          },
          underlying_game: {
            game_id: 2,
            slug: 'unsafe"; fields *;',
            names: ["Original"],
            evidence_url: "https://example.org/facts",
          },
        },
      },
      inspectGame: async () => [
        { id: 9, slug: "expected", name: "Expected", cover: { id: 3, image_id: "co3" } },
      ],
      inspectImage: () => assert.fail("wrong or unsafe identity cannot download"),
    },
  );
  assert.deepEqual(
    result.records[0].exceptions.map((item) => item.reason),
    ["identity-mismatch", "identity-declaration-invalid"],
  );
  assert.equal(result.records[0].reason, "generated-fallback");
});

test("an unavailable explicit refresh retains permitted accepted metadata", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const accepted = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8"),
  );
  const port = accepted.ports[0];
  const mapping = port.presentation.artwork;
  const result = await prepareCatalogArtwork(
    { ...accepted, ports: [port] },
    {
      acceptedCatalog: accepted,
      refreshPortIds: [port.id],
      identities: {
        [port.id]: {
          port: {
            game_id: mapping.game_id,
            slug: mapping.game_slug,
            names: [port.name],
            evidence_url: port.project_url,
          },
        },
      },
      inspectGame: async () => {
        throw new Error("temporary outage");
      },
      inspectImage: () => assert.fail("unavailable identity cannot download"),
    },
  );
  assert.deepEqual(result.catalog.ports[0], port);
  assert.equal(result.records[0].reason, "accepted-mapping-retained-after-unavailable-refresh");
  assert.equal(result.records[0].checks.live_refresh_passed, false);
});

test("ordinary generator prepares one complete retained batch and refuses output overwrite", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-generator-"));
  const output = join(scratch, "proposal");
  const before = readFileSync(join(catalogRoot, "catalog.json"), "utf8");
  const args = [
    "--prepare-artwork",
    join(catalogRoot, "catalog-current-authoring.json"),
    "--output-dir",
    output,
  ];
  const generated = run(...args);
  assert.equal(generated.status, 0, generated.stderr);
  const evidence = JSON.parse(readFileSync(join(output, "artwork-evidence.json"), "utf8"));
  assert.equal(evidence.records.length, 77);
  assert.deepEqual(evidence.differences, []);
  assert.equal(evidence.provider_metrics.authentication_requests, 0);
  assert.equal(evidence.provider_metrics.game_requests, 0);
  assert.equal(evidence.provider_metrics.image_requests, 0);
  writeFileSync(join(output, "preservation-marker"), "keep");
  const repeated = run(...args);
  assert.notEqual(repeated.status, 0);
  assert.equal(readFileSync(join(output, "preservation-marker"), "utf8"), "keep");
  assert.equal(readFileSync(join(catalogRoot, "catalog.json"), "utf8"), before);
});
