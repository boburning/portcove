import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
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

void test("game media uses dedicated relationships and fit PNG assets through the shared private client", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-game-media-provider-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  const calls: { url: string; options: RequestInit }[] = [];
  let decoded = 0;
  const provider = createIgdbInspector(
    privateFile,
    () => {
      decoded++;
      return { format: "png", width: 400, height: 200, validator: "portcove-core" };
    },
    async (url, options) => {
      calls.push({ url, options });
      if (url.includes("oauth2")) return new Response('{"access_token":"fixture-token"}');
      if (url.includes("/image/upload/"))
        return new Response("decoder-fixture", { headers: { "content-type": "image/png" } });
      return new Response("[]");
    },
  );
  await provider.inspectGameMedia(7, "logo");
  await provider.inspectGameMedia(7, "key_art");
  await provider.inspectImageTypes();
  await provider.inspectMediaImage("logofixture", "logo");
  await provider.inspectMediaImage("artfixture", "key_art");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://id.twitch.tv/oauth2/token",
      "https://api.igdb.com/v4/logos",
      "https://api.igdb.com/v4/artworks",
      "https://api.igdb.com/v4/image_types",
      "https://images.igdb.com/igdb/image/upload/t_logo_med_2x/logofixture.png",
      "https://images.igdb.com/igdb/image/upload/t_720p/artfixture.png",
    ],
  );
  assert.ok(text(requiredFixture(calls[1]).options.body).includes("where game = 7;"));
  assert.ok(text(requiredFixture(calls[2]).options.body).includes("image_type.name"));
  assert.equal(
    text(requiredFixture(calls[3]).options.body),
    "fields id,name; sort id asc; limit 501;",
  );
  assert.ok(calls.every((call) => call.options.redirect === "error"));
  assert.equal(decoded, 2);
  assert.equal(provider.providerMetrics.authentication_requests, 1);
  assert.equal(provider.providerMetrics.game_requests, 3);
  assert.equal(provider.providerMetrics.image_requests, 2);
  await assert.rejects(provider.inspectGameMedia(0, "logo"), /Invalid game media identity/);
  assert.equal(calls.length, 6);
});

void test("hero preparation validates identity without requiring a cover and rejects generic or foreign artwork", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const inspected: string[] = [];
  const result = await prepareCatalogGameMedia(
    {
      ports: [
        {
          id: "sample",
          name: "Sample",
          project_url: "https://example.org/sample",
          presentation: { media: [] },
        },
      ],
    },
    {
      inspector: {
        inspectGame: async () => [
          {
            id: 7,
            name: "Sample",
            slug: "sample",
            websites: [{ url: "https://example.org/sample" }],
          },
        ],
        inspectGameMedia: async (_id, kind) =>
          kind === "logo"
            ? [{ id: 9, game: 7, image_id: "logo" }]
            : [
                {
                  id: 1,
                  game: 7,
                  image_id: "concept",
                  image_type: { id: 991, name: "Concept art" },
                },
                {
                  id: 2,
                  game: 8,
                  image_id: "foreign",
                  image_type: { id: 992, name: "Key art with logo" },
                },
                {
                  id: 3,
                  game: 7,
                  image_id: "without",
                  image_type: { id: 993, name: "Key art without logo" },
                },
                {
                  id: 4,
                  game: 7,
                  image_id: "with",
                  image_type: { id: 992, name: "Key art with logo" },
                },
              ],
        inspectMediaImage: async (id) => {
          inspected.push(id);
          if (id === "with") throw new Error("Fixture image unavailable");
          return {
            sha256: "a".repeat(64),
            bytes: 100,
            width: 400,
            height: 200,
            format: "png",
            validator: "portcove-core",
          };
        },
      },
    },
  );
  assert.deepEqual(inspected, ["with", "without", "logo"]);
  const media = requiredFixture(result.catalog.ports[0]).presentation?.media;
  assert.ok(Array.isArray(media));
  assert.deepEqual(
    (media as unknown[]).map((asset) => {
      assert.ok(isRecord(asset) && isRecord(asset.igdb));
      return [asset.role, asset.igdb.image_id];
    }),
    [
      ["key_art", "without"],
      ["logo", "logo"],
    ],
  );
  const first: unknown = media[0];
  assert.ok(isRecord(first) && isRecord(first.igdb));
  assert.equal(first.igdb.image_type, 993);
  assert.equal(first.igdb.image_type_name, "Key art without logo");
  assert.deepEqual(
    result.records.map((record) => record.reason),
    ["role-selected", "role-selected"],
  );
});

void test("incomplete key-art inventory preserves cached media and does not suppress the logo role", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const retained = { id: "retained-header", role: "header" };
  const result = await prepareCatalogGameMedia(
    {
      ports: [
        {
          id: "sample",
          name: "Sample",
          project_url: "https://example.org/sample",
          presentation: { media: [retained] },
        },
      ],
    },
    {
      inspector: {
        inspectGame: async () => [
          {
            id: 7,
            name: "Sample",
            slug: "sample",
            websites: [{ url: "https://example.org/sample" }],
          },
        ],
        inspectGameMedia: async (_id, kind) =>
          kind === "key_art"
            ? Array.from({ length: 21 }, () => ({}))
            : [{ id: 9, game: 7, image_id: "logo" }],
        inspectMediaImage: async () => ({
          sha256: "b".repeat(64),
          bytes: 100,
          width: 400,
          height: 200,
          format: "png",
          validator: "portcove-core",
        }),
      },
    },
  );
  assert.equal(result.records[0]?.reason, "media-provider-unavailable-or-incomplete");
  assert.equal(result.records[1]?.reason, "role-selected");
  const media = requiredFixture(result.catalog.ports[0]).presentation?.media;
  assert.ok(Array.isArray(media));
  assert.deepEqual(media[0], retained);
  const second: unknown = media[1];
  assert.ok(isRecord(second));
  assert.equal(second.role, "logo");
});

void test("an observed Gone image sweeps earlier and unselected references and cannot be reselected in the batch", async () => {
  const { createIgdbInspector, prepareCatalogGameMedia } =
    await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-game-media-gone-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  let imageCalls = 0;
  const inspector = createIgdbInspector(
    privateFile,
    () => ({ format: "png", width: 400, height: 200, validator: "portcove-core" }),
    async (url) => {
      if (url.includes("oauth2")) return new Response('{"access_token":"fixture-token"}');
      if (url.endsWith("/games"))
        return new Response(
          JSON.stringify([
            {
              id: 7,
              name: "Sample",
              slug: "sample",
              websites: [{ url: "https://example.org/sample" }],
            },
          ]),
        );
      if (url.endsWith("/artworks")) return new Response("[]");
      if (url.endsWith("/logos"))
        return new Response(JSON.stringify([{ id: 9, game: 7, image_id: "sharedlogo" }]));
      imageCalls++;
      return imageCalls === 1
        ? new Response("decoder-fixture", { headers: { "content-type": "image/png" } })
        : new Response(null, { status: 410 });
    },
  );
  const result = await prepareCatalogGameMedia(
    {
      ports: ["one", "two", "three", "unselected"].map((id) => ({
        id,
        name: "Sample",
        project_url: "https://example.org/sample",
        presentation: {
          media: [
            { id: "retained-header", role: "header", subject: { kind: "port", port_id: id } },
            {
              id: "withdrawn-logo",
              role: "logo",
              subject: { kind: "port", port_id: id },
              igdb: { image_id: "sharedlogo" },
            },
          ],
        },
      })),
    },
    { inspector, selectedPortIds: ["one", "two", "three"] },
  );
  assert.equal(imageCalls, 2);
  assert.deepEqual(result.gone_image_ids, ["sharedlogo"]);
  for (const port of result.catalog.ports) {
    const media = port.presentation?.media;
    assert.ok(Array.isArray(media));
    assert.deepEqual(media, [
      { id: "retained-header", role: "header", subject: { kind: "port", port_id: port.id } },
    ]);
  }
  assert.equal(
    result.records.find((record) => record.port_id === "one" && record.role === "logo")?.reason,
    "selected-image-gone-later-in-batch",
  );
});
