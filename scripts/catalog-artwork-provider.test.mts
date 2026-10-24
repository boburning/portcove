import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ArtworkPreparationOptions } from "./inspect-igdb-artwork.mts";

import { requiredFixture, text, root } from "./fixtures/catalog-generator-fixtures.mts";

void test("ordinary names require exact attributable project evidence, including shared repositories", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const catalog = {
    ports: [
      { id: "one", name: "One", project_url: "https://github.com/Owner/Shared" },
      { id: "two", name: "Two", project_url: "https://github.com/Owner/Shared" },
      { id: "collision", name: "Collision", project_url: "https://github.com/Owner/Other" },
      { id: "custom-port", name: "Custom", project_url: "https://github.com/Owner/Shared" },
    ],
  };
  const queries: Parameters<NonNullable<ArtworkPreparationOptions["inspectGame"]>>[0][] = [];
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: { ports: [] },
    inspectGame: async (identity) => {
      queries.push(identity);
      return [
        {
          id: identity.names[0] === "One" ? 1 : 2,
          name: requiredFixture(identity.names[0]),
          slug: requiredFixture(identity.names[0]).toLowerCase(),
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
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .game_id,
    1,
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[1]).presentation).artwork)
      .game_id,
    2,
  );
  assert.equal(result.metrics.image_queries, 1);
  assert.equal(
    requiredFixture(requiredFixture(result.records[2]).exceptions[0]).reason,
    "identity-mismatch",
  );
  assert.equal(
    requiredFixture(requiredFixture(result.records[3]).exceptions[0]).reason,
    "identity-mismatch",
  );
});

void test("original-game name lookup requires platform and edition evidence and refuses truncated results", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
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
  const setup = (games: unknown): ArtworkPreparationOptions => ({
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
  assert.equal(requiredFixture(observed.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(
      requiredFixture(requiredFixture(observed.catalog.ports[0]).presentation).artwork,
    ).game_id,
    1,
  );
  const truncated = await prepareCatalogArtwork(
    input,
    setup(Array.from({ length: 21 }, (_, i) => ({ ...base, id: i + 1 }))),
  );
  assert.equal(requiredFixture(truncated.records[0]).reason, "generated-fallback");
  assert.equal(
    requiredFixture(requiredFixture(truncated.records[0]).exceptions[1]).reason,
    "identity-query-incomplete",
  );
});

void test("provider requests use fixed origins, bounded metadata and safe strings; auth failure is attempted once", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-provider-contract-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  const calls: { url: string; options: RequestInit }[] = [];
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
  assert.ok(text(requiredFixture(calls[1]).options.body).includes('name ~ "Port\\"; fields *;"'));
  assert.ok(text(requiredFixture(calls[1]).options.body).endsWith("limit 21;"));
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

void test("malformed nested provider responses reject only that cover and the actual batch continues", async () => {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
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
        const good = text(options.body).includes('"Good"');
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
    assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
    assert.equal(
      requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
      invalid.cover ? "no-usable-cover" : "identity-response-invalid",
    );
    assert.equal(requiredFixture(result.records[1]).reason, "exact-port-cover");
    assert.equal(transport.providerMetrics.authentication_requests, 1);
    assert.equal(transport.providerMetrics.game_requests, 2);
    assert.equal(transport.providerMetrics.image_requests, 1);
  }
});

void test("wrong editions and invalid declarations never reach image acquisition", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
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
    requiredFixture(result.records[0]).exceptions.map((item) => item.reason),
    ["identity-mismatch", "identity-declaration-invalid"],
  );
  assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
});
