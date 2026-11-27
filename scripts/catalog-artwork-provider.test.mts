import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ArtworkPreparationOptions } from "./inspect-igdb-artwork.mts";

import { requiredFixture, text, root } from "./fixtures/catalog-generator-fixtures.mts";

void test("shared covers use the accepted provider asset identity through a slug rename", async () => {
  const { checkedAuthoredPort } = await import("./catalog-authoring.mts");
  const { indexSharedCoverRows, projectExactSharedCovers } =
    await import("./shared-cover-projection.mts");
  const game = {
    format_version: 1,
    id: "same-game",
    evidence_urls: ["https://example.org/same-game"],
    source_editions: [
      {
        id: "same-edition",
        title: "Same game",
        system: "pc",
        evidence_urls: ["https://example.org/same-edition"],
      },
    ],
  };
  const cover = {
    game_id: 2,
    cover_id: 3,
    image_id: "stablecover",
    image_sha256: "a".repeat(64),
    game_slug: "before-rename",
    match_kind: "underlying-game" as const,
  };
  const listing = (id: string) => ({
    id,
    name: id,
    summary: "Artwork identity fixture.",
    project_url: `https://github.com/example/${id}`,
    original_game: game,
  });
  const oldDonor = { ...listing("a-donor"), artwork: cover };
  const renamedCover = { ...cover, game_slug: "after-rename" };
  const newDonor = { ...listing("b-donor"), artwork: renamedCover };
  const recipient = listing("recipient");
  const derive = (
    signed: readonly unknown[],
    rows: readonly unknown[],
    holdNewForImages = new Set<string>(),
  ) =>
    projectExactSharedCovers({
      live: indexSharedCoverRows(signed),
      authored: rows.map((row) => checkedAuthoredPort({ format_version: 1, listing: row })),
      excludedPortIds: new Set(),
      gone: new Set(),
      checked: new Map(),
      deriveDefaultsForPublishedRecipients: true,
      holdNewForImages,
    });

  const currentAuthoring = [{ ...oldDonor, artwork: renamedCover }, newDonor, recipient];
  const prior = [oldDonor, newDonor];
  assert.deepEqual(derive(prior, currentAuthoring).proposals.get(recipient.id), cover);

  // An image under a byte-change hold can continue serving its old recipients.
  const hold = new Set([cover.image_id]);
  assert.equal(derive(prior, currentAuthoring, hold).proposals.size, 0);
  const previousRecipient = { ...recipient, artwork: renamedCover };
  assert.deepEqual(
    derive([...prior, previousRecipient], currentAuthoring, hold).proposals.get(recipient.id),
    renamedCover,
  );

  const remapped = { ...previousRecipient, original_game: { ...game, id: "other-game" } };
  assert.equal(derive([...prior, remapped], currentAuthoring, hold).proposals.size, 0);

  // Different provider assets for the same edition are still ambiguous.
  const conflicting = { ...newDonor, artwork: { ...renamedCover, cover_id: 4 } };
  const result = derive([oldDonor, conflicting], [oldDonor, conflicting, recipient]);
  assert.equal(result.proposals.size, 0);
  assert.equal(result.outcomes.find(({ id }) => id === recipient.id)?.status, "ambiguous");
});

void test("a regional cover refresh refuses a mismatched localization and preserves accepted art", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const selection = {
    game_id: 1,
    slug: "original",
    name: "Original",
    platform_id: 7,
    localization_id: 2,
    region_id: 4,
    cover_id: 9,
    image_id: "localized",
  };
  const mapping = {
    game_id: 1,
    game_slug: "original",
    cover_id: 9,
    image_id: "localized",
    image_sha256: "a".repeat(64),
    match_kind: "underlying-game",
  };
  const project_url = "https://github.com/owner/port";
  const regional = {
    id: "regional",
    name: "Regional",
    project_url,
    igdb_regional_cover: selection,
    presentation: { artwork: mapping },
  };
  const game = {
    id: 1,
    name: "Original",
    slug: "original",
    platforms: [7],
    cover: { id: 8, image_id: "maincover" },
    game_localizations: [
      { id: 2, game: 1, region: 3, cover: { id: 9, image_id: "localized", game_localization: 2 } },
    ],
  };

  const catalog = { ports: [regional] };
  const { igdb_regional_cover: _, ...projected } = regional;
  const inspectedImages: string[] = [];
  const refreshed = await prepareCatalogArtwork(
    { ports: [projected] },
    {
      acceptedCatalog: catalog,
      refreshPortIds: ["regional"],
      inspectGame: () => [game],
      inspectImage: (id) => {
        inspectedImages.push(id);
        throw new Error("Unexpected image");
      },
    },
  );
  assert.equal(refreshed.records[0]?.reason, "accepted-mapping-retained-after-unavailable-refresh");
  assert.equal(
    refreshed.records[0]?.exceptions[0]?.reason,
    "regional-cover-unavailable-or-mismatched",
  );
  assert.deepEqual(refreshed.records[0]?.mapping, mapping);
  assert.equal(inspectedImages.length, 0);

  const wrongArt = {
    ...regional,
    presentation: { artwork: { ...mapping, cover_id: 8, image_id: "maincover" } },
  };
  const stale = await prepareCatalogArtwork(
    { ports: [wrongArt] },
    {
      acceptedCatalog: { ports: [wrongArt] },
      inspectGame: () => [game],
      inspectImage: (id) => {
        inspectedImages.push(id);
        throw new Error("Unexpected image");
      },
    },
  );
  assert.equal(stale.records[0]?.reason, "generated-fallback");
  assert.equal(stale.records[0]?.mapping, null);
  assert.equal(inspectedImages.length, 0);

  const generic = {
    id: "generic",
    name: "Generic",
    project_url,
    underlying_game: {
      names: ["Original"],
      platform_ids: [7],
      game_id: 1,
      slug: "original",
      evidence_url: project_url,
    },
  };
  const ordinary = await prepareCatalogArtwork(
    { ports: [generic] },
    {
      acceptedCatalog: catalog,
      inspectGame: (identity) => (identity.kind === "port" ? [] : [game]),
      inspectImage: (id) => {
        assert.equal(id, "maincover");
        return {
          bytes: 100,
          width: 264,
          height: 374,
          sha256: "b".repeat(64),
          format: "jpeg",
          validator: "portcove-core",
        };
      },
    },
  );
  assert.equal(ordinary.records[0]?.mapping?.image_id, "maincover");
});

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
  await provider.inspectGameMedia(7, "screenshot");
  await provider.inspectImageTypes();
  await provider.inspectMediaImage("logofixture", "logo");
  await provider.inspectMediaImage("artfixture", "key_art");
  await provider.inspectMediaImage("shotfixture", "screenshot");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://id.twitch.tv/oauth2/token",
      "https://api.igdb.com/v4/logos",
      "https://api.igdb.com/v4/artworks",
      "https://api.igdb.com/v4/screenshots",
      "https://api.igdb.com/v4/image_types",
      "https://images.igdb.com/igdb/image/upload/t_logo_med_2x/logofixture.png",
      "https://images.igdb.com/igdb/image/upload/t_720p/artfixture.png",
      "https://images.igdb.com/igdb/image/upload/t_720p/shotfixture.png",
    ],
  );
  assert.ok(text(requiredFixture(calls[1]).options.body).includes("where game = 7;"));
  assert.ok(text(requiredFixture(calls[2]).options.body).includes("image_type.name"));
  assert.equal(
    text(requiredFixture(calls[3]).options.body),
    "fields id,game,image_id,width,height,alpha_channel,animated; where game = 7; sort id asc; limit 21;",
  );
  assert.equal(
    text(requiredFixture(calls[4]).options.body),
    "fields id,name; sort id asc; limit 500;",
  );
  assert.ok(calls.every((call) => call.options.redirect === "error"));
  for (const call of calls.slice(5)) assert.equal(call.options.headers, undefined);
  assert.equal(decoded, 3);
  assert.equal(provider.providerMetrics.authentication_requests, 1);
  assert.equal(provider.providerMetrics.game_requests, 4);
  assert.equal(provider.providerMetrics.image_requests, 3);
  await assert.rejects(provider.inspectGameMedia(0, "logo"), /Invalid game media identity/);
  assert.equal(calls.length, 8);
});

void test("image-type inventory respects the provider page cap and proves completeness at the boundary", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-image-types-provider-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "private" }));
  const fullPage = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    name: `Type ${index}`,
  }));
  for (const [name, pages, accepted] of [
    ["short", [[{ id: 3, name: "Key art with logo" }]], true],
    ["empty", [[]], true],
    ["exactly full", [fullPage, []], true],
    ["overflow", [fullPage, [{ id: 501 }]], false],
    ["malformed overflow", [fullPage, {}], false],
    ["oversized", [[...fullPage, { id: 501, name: "Extra" }]], false],
    ["malformed page", [{}], false],
  ] as const) {
    const queries: string[] = [];
    const provider = createIgdbInspector(
      privateFile,
      () => assert.fail("metadata cannot decode"),
      async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "private-token" });
        assert.equal(url, "https://api.igdb.com/v4/image_types");
        const query = text(options.body);
        const limit = Number(/limit (\d+);/.exec(query)?.[1]);
        assert.ok(limit > 0 && limit <= 500, `${name}: legal provider limit`);
        queries.push(query);
        return Response.json(pages[queries.length - 1]);
      },
    );
    if (accepted) assert.deepEqual(await provider.inspectImageTypes(), pages[0], name);
    else
      await assert.rejects(
        provider.inspectImageTypes(),
        /image.type inventory.*invalid or incomplete/i,
        name,
      );
    assert.equal(queries.length, pages.length, name);
    if (pages.length === 2)
      assert.equal(queries[1], "fields id; sort id asc; limit 1; offset 500;", name);
    assert.equal(provider.providerMetrics.authentication_requests, 1, name);
  }
});

void test("unavailable image-type overflow stays unknown without disabling game-logo lookup", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-image-types-unavailable-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "private" }));
  const queries: string[] = [];
  const provider = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata cannot decode"),
    async (url, options) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "private-token" });
      queries.push(url);
      if (url.endsWith("/logos")) return Response.json([]);
      assert.equal(url, "https://api.igdb.com/v4/image_types");
      return text(options.body).includes("offset 500")
        ? new Response("private-provider-error-body", { status: 403 })
        : Response.json(
            Array.from({ length: 500 }, (_, index) => ({ id: index + 1, name: `Type ${index}` })),
          );
    },
  );
  await assert.rejects(provider.inspectImageTypes(), {
    message: "IGDB media request unavailable.",
  });
  assert.deepEqual(await provider.inspectGameMedia(7, "logo"), []);
  assert.deepEqual(queries, [
    "https://api.igdb.com/v4/image_types",
    "https://api.igdb.com/v4/image_types",
    "https://api.igdb.com/v4/logos",
  ]);
  assert.equal(provider.providerMetrics.authentication_requests, 1);
  assert.equal(provider.providerMetrics.game_requests, 3);
});

void test("game media preparation binds each typed role to the same exact game", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const inspected: string[] = [];
  const relationships: string[] = [];
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
        inspectGameMedia: async (id, kind) => {
          relationships.push(kind);
          assert.equal(id, 7);
          if (kind === "logo") return [{ id: 9, game: 7, image_id: "logo" }];
          if (kind === "screenshot")
            return [
              { id: 1, game: 8, image_id: "othergame" },
              { id: 2, game: 7, image_id: "animated", animated: true },
              { id: 3, game: 7, image_id: "shot" },
            ];
          return [
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
            {
              id: 5,
              game: 7,
              image_id: "wide",
              image_type: { id: 993, name: "Key art without logo" },
            },
          ];
        },
        inspectMediaImage: async (id) => {
          inspected.push(id);
          if (id === "with") throw new Error("Fixture image unavailable");
          return {
            sha256: "a".repeat(64),
            bytes: 100,
            width: id === "without" ? 260 : 400,
            height: 200,
            format: "png",
            validator: "portcove-core",
          };
        },
      },
    },
  );
  assert.deepEqual(relationships, ["key_art", "logo", "screenshot"]);
  assert.deepEqual(inspected, ["with", "without", "logo", "without", "wide", "shot"]);
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
      ["header", "wide"],
      ["screenshot", "shot"],
    ],
  );
  const first: unknown = media[0];
  assert.ok(isRecord(first) && isRecord(first.igdb));
  assert.equal(first.igdb.image_type, 993);
  assert.equal(first.igdb.image_type_name, "Key art without logo");
  const header: unknown = media[2];
  assert.ok(isRecord(header) && isRecord(header.igdb));
  assert.equal(header.igdb.kind, "artwork");
  assert.equal(header.igdb.image_type, 993);
  const screenshot: unknown = media[3];
  assert.ok(isRecord(screenshot) && isRecord(screenshot.igdb));
  assert.deepEqual(screenshot.igdb, {
    kind: "screenshot",
    game_id: 7,
    game_slug: "sample",
    record_id: 3,
    image_id: "shot",
  });
  assert.deepEqual(
    result.records.map((record) => record.reason),
    ["role-selected", "role-selected", "role-selected", "role-selected"],
  );
});

void test("an incomplete inventory preserves artwork, shares the failed read and recovers next pass", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const catalog = {
    ports: ["sample", "another"].map((id) => ({
      id,
      name: "Sample",
      project_url: "https://example.org/sample",
      presentation: {
        media: [{ id: "retained-header", role: "header", subject: { kind: "port", port_id: id } }],
      },
    })),
  };
  let recovered = false;
  const inventories: string[] = [];
  const options: Parameters<typeof prepareCatalogGameMedia>[1] = {
    inspector: {
      inspectGame: async () => [
        {
          id: 7,
          name: "Sample",
          slug: "sample",
          websites: [{ url: "https://example.org/sample" }],
        },
      ],
      inspectGameMedia: async (_id, kind) => {
        inventories.push(kind);
        if (kind === "logo") return [{ id: 9, game: 7, image_id: "logo" }];
        if (!recovered) return Array.from({ length: 21 }, () => ({}));
        return kind === "screenshot" ? [{ id: 10, game: 7, image_id: "scene" }] : [];
      },
      inspectMediaImage: async () => ({
        sha256: "b".repeat(64),
        bytes: 100,
        width: 400,
        height: 200,
        format: "png",
        validator: "portcove-core",
      }),
    },
  };
  const partial = await prepareCatalogGameMedia(catalog, options);
  assert.deepEqual(inventories, ["key_art", "logo", "screenshot"]);
  for (const [index, port] of partial.catalog.ports.entries()) {
    assert.deepEqual(
      partial.records.filter((record) => record.port_id === port.id).map(({ reason }) => reason),
      [
        "media-provider-unavailable-or-incomplete",
        "role-selected",
        "existing-scene-retained",
        "media-provider-unavailable-or-incomplete",
      ],
    );
    const media = port.presentation?.media;
    assert.ok(Array.isArray(media));
    assert.deepEqual(media[0], requiredFixture(catalog.ports[index]).presentation.media[0]);
    const logo: unknown = media[1];
    assert.ok(isRecord(logo));
    assert.equal(logo.role, "logo");
  }

  recovered = true;
  inventories.length = 0;
  const retried = await prepareCatalogGameMedia(partial.catalog, options);
  assert.deepEqual(inventories, ["key_art", "screenshot"]);
  for (const [index, port] of retried.catalog.ports.entries()) {
    const past = requiredFixture(partial.catalog.ports[index]).presentation?.media;
    const current = port.presentation?.media;
    assert.ok(Array.isArray(past) && Array.isArray(current));
    assert.deepEqual(current[1], past[1]);
  }
  assert.deepEqual(
    retried.records
      .filter(({ role, reason }) => role === "screenshot" && reason === "role-selected")
      .map(({ port_id, subject }) => [port_id, subject]),
    catalog.ports.map(({ id }) => [id, { kind: "port", port_id: id }]),
  );
});

void test("new scenes stay edition-bound and preserve other reviewed scopes", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const portScreenshot = {
    id: "port-screenshot",
    role: "screenshot",
    subject: { kind: "port", port_id: "sample" },
  };
  const otherEditionScreenshot = {
    id: "igdb-screenshot-original-8",
    role: "screenshot",
    subject: { kind: "original", game_id: "original", source_edition_id: "older" },
  };
  const lookedUp: number[] = [];
  const result = await prepareCatalogGameMedia(
    {
      ports: [
        {
          id: "sample",
          name: "Sample Port",
          project_url: "https://example.org/sample",
          underlying_game: {
            game_id: 7,
            slug: "sample-original",
            names: ["Sample Original"],
            evidence_url: "https://example.org/edition",
            source_edition_id: "selected",
            hero_media_edition_neutral: true,
          },
          presentation: {
            original_game: {
              id: "original",
              source_editions: [{ id: "selected" }, { id: "older" }],
            },
            media: [portScreenshot, otherEditionScreenshot],
          },
        },
      ],
    },
    {
      inspector: {
        inspectGame: async (declaration) => {
          assert.ok(isRecord(declaration));
          return declaration.game_id === 7
            ? [{ id: 7, name: "Sample Original", slug: "sample-original" }]
            : [
                {
                  id: 9,
                  name: "Sample Port",
                  slug: "sample-port",
                  websites: [{ url: "https://example.org/sample" }],
                },
              ];
        },
        inspectGameMedia: async (id, role) => {
          if (id === 7 && role === "logo") return [{ id: 7, game: 7, image_id: "logo" }];
          if (id === 7 && role === "key_art")
            return [
              {
                id: 5,
                game: 7,
                image_id: "background",
                image_type: { id: 99, name: "Key Art Without Logo" },
              },
            ];
          if (role !== "screenshot") return [];
          lookedUp.push(id);
          return [
            { id: 8, game: 7, image_id: "otheredition" },
            { id: 9, game: 7, image_id: "selectededition" },
          ];
        },
        inspectMediaImage: async () => ({
          sha256: "a".repeat(64),
          bytes: 100,
          width: 400,
          height: 200,
          format: "png",
          validator: "portcove-core",
        }),
      },
    },
  );
  assert.deepEqual(lookedUp, [7]);
  const media = requiredFixture(result.catalog.ports[0]).presentation?.media;
  assert.ok(Array.isArray(media));
  assert.equal(media.length, 6);
  assert.deepEqual(media.slice(0, 2), [portScreenshot, otherEditionScreenshot]);
  const keyArt: unknown = media[2];
  assert.ok(isRecord(keyArt));
  assert.equal(keyArt.role, "key_art");
  assert.equal(keyArt.edition_neutral, true);
  const logo: unknown = media[3];
  assert.ok(isRecord(logo));
  assert.equal(logo.role, "logo");
  assert.equal(logo.edition_neutral, true);
  const background: unknown = media[4];
  assert.ok(isRecord(background));
  assert.equal(background.role, "header");
  assert.equal(background.edition_neutral, undefined);
  const added: unknown = media[5];
  assert.ok(isRecord(added));
  assert.equal(added.id, "igdb-screenshot-original-9");
  assert.equal(added.caption, "Original game screenshot");
  assert.equal(added.edition_neutral, undefined);
  assert.deepEqual(added.subject, {
    kind: "original",
    game_id: "original",
    source_edition_id: "selected",
  });
});

void test("an observed Gone logo sweeps every reference to its variant and preserves other variants", async () => {
  const { createIgdbInspector, prepareCatalogArtwork, prepareCatalogGameMedia } =
    await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-game-media-gone-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  let imageCalls = 0;
  const inventoryCalls: string[] = [];
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
      if (url.endsWith("/artworks") || url.endsWith("/screenshots") || url.endsWith("/logos"))
        inventoryCalls.push(new URL(url).pathname);
      if (url.endsWith("/artworks") || url.endsWith("/screenshots")) return new Response("[]");
      if (url.endsWith("/logos"))
        // Duplicate records for one exact image must not retry it after withdrawal.
        return new Response(
          JSON.stringify([
            { id: 9, game: 7, image_id: "sharedlogo" },
            { id: 10, game: 7, image_id: "sharedlogo" },
          ]),
        );
      imageCalls++;
      return imageCalls === 1
        ? new Response("decoder-fixture", { headers: { "content-type": "image/png" } })
        : new Response(null, { status: 410 });
    },
  );
  const catalog = {
    ports: ["one", "two", "three", "unselected"].map((id) => ({
      id,
      name: "Sample",
      project_url: "https://example.org/sample",
      presentation: {
        artwork: {
          game_id: 7,
          cover_id: 9,
          image_id: "sharedlogo",
          image_sha256: "a".repeat(64),
          game_slug: "sample",
          match_kind: "port",
        },
        media: [
          {
            id: "retained-header",
            role: "header",
            subject: { kind: "port", port_id: id },
            igdb: { image_id: "sharedlogo" },
          },
          ...(["three", "unselected"].includes(id)
            ? [
                {
                  id: "withdrawn-logo",
                  role: "logo",
                  subject: { kind: "port", port_id: id },
                  igdb: { image_id: "sharedlogo" },
                },
              ]
            : []),
        ],
      },
    })),
  };
  const covers = await prepareCatalogArtwork(catalog, {
    ...inspector,
    acceptedCatalog: catalog,
    selectedPortIds: ["one", "two", "three"],
  });
  assert.equal(covers.metrics.reused, 3);
  assert.equal(imageCalls, 0);
  const result = await prepareCatalogGameMedia(covers.catalog, {
    inspector,
    selectedPortIds: ["one", "two", "three"],
  });
  assert.deepEqual(inventoryCalls, ["/v4/artworks", "/v4/logos", "/v4/screenshots"]);
  assert.equal(imageCalls, 2);
  assert.deepEqual(result.gone_media_targets, ["logo_med_2x/sharedlogo"]);
  assert.deepEqual(covers.gone_image_ids, []);
  for (const port of result.catalog.ports) {
    const artwork = port.presentation?.artwork;
    assert.ok(isRecord(artwork));
    assert.equal(artwork.image_id, "sharedlogo");
    const media = port.presentation?.media;
    assert.ok(Array.isArray(media));
    assert.deepEqual(media, [
      {
        id: "retained-header",
        role: "header",
        subject: { kind: "port", port_id: port.id },
        igdb: { image_id: "sharedlogo" },
      },
    ]);
  }
  assert.equal(
    result.records.find((record) => record.port_id === "one" && record.role === "logo")?.reason,
    "selected-image-gone-later-in-batch",
  );
});

for (const unavailableMedia of [false, true]) {
  void test(`cover Gone preserves other variants through ${unavailableMedia ? "unavailable" : "successful"} media lookup`, async () => {
    const { createIgdbInspector, prepareCatalogArtwork, prepareCatalogGameMedia } =
      await import("./inspect-igdb-artwork.mts");
    const scratch = mkdtempSync(join(tmpdir(), "portcove-cover-media-gone-"));
    const credentials = join(scratch, "private-fixture.json");
    writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
    let imageCalls = 0,
      mediaCalls = 0;
    const provider = createIgdbInspector(
      credentials,
      () => ({ format: "png", width: 400, height: 200, validator: "portcove-core" }),
      async (url) => {
        if (url.includes("oauth2")) return new Response('{"access_token":"fixture"}');
        if (url.endsWith("/games"))
          return new Response(
            JSON.stringify([
              {
                id: 7,
                name: "Sample",
                slug: "sample",
                websites: [{ url: "https://example.org/sample" }],
                cover: { id: 9, image_id: "withdrawncover" },
              },
            ]),
          );
        assert.ok(url.includes("images.igdb.com"), `Unexpected provider request: ${url}`);
        imageCalls++;
        return url.endsWith(".jpg")
          ? new Response(null, { status: 410 })
          : new Response("media", { headers: { "content-type": "image/png" } });
      },
    );
    const catalog = {
      ports: ["earlier", "refreshed", "unselected"].map((id) => ({
        id,
        name: "Sample",
        project_url: "https://example.org/sample",
        presentation: {
          artwork: {
            game_id: 7,
            cover_id: 9,
            image_id: "withdrawncover",
            image_sha256: "a".repeat(64),
            game_slug: "sample",
            match_kind: "port",
          },
          media: [
            { id: "retained-header", role: "header", subject: { kind: "port", port_id: id } },
            {
              id: "gone-logo",
              role: "logo",
              subject: { kind: "port", port_id: id },
              igdb: { image_id: "withdrawncover" },
            },
          ],
        },
      })),
    };
    const covers = await prepareCatalogArtwork(catalog, {
      ...provider,
      acceptedCatalog: catalog,
      selectedPortIds: ["earlier", "refreshed"],
      refreshPortIds: ["refreshed"],
    });
    assert.deepEqual(covers.gone_image_ids, ["withdrawncover"]);
    assert.equal(imageCalls, 1);
    // The same provider image ID can still serve a different CDN variant.
    for (const port of covers.catalog.ports) {
      assert.equal(port.presentation?.artwork, undefined);
      const retained = port.presentation?.media;
      assert.ok(Array.isArray(retained));
      assert.equal(retained.length, 2);
    }
    const result = await prepareCatalogGameMedia(covers.catalog, {
      selectedPortIds: ["refreshed"],
      inspector: {
        ...provider,
        inspectGameMedia: async () => {
          mediaCalls++;
          if (unavailableMedia) throw new Error("Fixture role lookup unavailable");
          return [
            { id: 9, game: 7, image_id: "withdrawncover", image_type: { id: 7, name: "Key Art" } },
          ];
        },
      },
    });
    assert.equal(mediaCalls, 2);
    assert.equal(imageCalls, unavailableMedia ? 1 : 3);
    assert.deepEqual(result.gone_media_targets, []);
    for (const port of result.catalog.ports) {
      assert.equal(port.presentation?.artwork, undefined);
      const media = port.presentation?.media;
      assert.ok(Array.isArray(media));
      assert.ok(media.some((asset) => isRecord(asset) && asset.id === "gone-logo"));
      if (!unavailableMedia && port.id === "refreshed") assert.equal(media.length, 4);
    }
    assert.equal(covers.metrics.fallback, 3);
    assert.ok(covers.records.every((record) => record.mapping === null && record.checks === null));
    if (unavailableMedia)
      assert.ok(
        result.records.every(
          (record) =>
            record.reason === "media-provider-unavailable-or-incomplete" ||
            record.reason === "existing-scene-retained",
        ),
      );
  });
}

void test("an exact 410 for an unselected scene stays attached to its provider game and role", async () => {
  const { createIgdbInspector, prepareCatalogGameMedia } =
    await import("./inspect-igdb-artwork.mts");
  const { sceneCoverage } = await import("./artwork-operations.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-scene-withdrawal-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  const fetched: string[] = [];
  const project = "https://example.org/withdrawn-scene";
  const inspector = createIgdbInspector(
    privateFile,
    () => ({ format: "png", width: 400, height: 200, validator: "portcove-core" }),
    async (url) => {
      if (url.includes("oauth2")) return new Response('{"access_token":"fixture-token"}');
      if (url.endsWith("/games"))
        return Response.json([
          {
            id: 7,
            name: "Sample",
            slug: "sample",
            websites: [{ url: project }],
          },
        ]);
      if (url.endsWith("/logos")) return Response.json([]);
      if (url.endsWith("/artworks"))
        return Response.json([
          {
            id: 10,
            game: 7,
            image_id: "keyartgone",
            image_type: { id: 4, name: "Key Art Without Logo" },
          },
        ]);
      if (url.endsWith("/screenshots"))
        return Response.json([{ id: 9, game: 7, image_id: "scenegone" }]);
      assert.match(url, /(?:scenegone|keyartgone)\.png$/u);
      fetched.push(url.split("/").at(-1)!);
      return new Response(null, { status: 410 });
    },
  );
  const catalog = { ports: [{ id: "sample", name: "Sample", project_url: project }] };
  const proposal = await prepareCatalogGameMedia(catalog, { inspector });
  assert.deepEqual(proposal.gone_media_targets, ["720p/keyartgone", "720p/scenegone"]);
  assert.deepEqual(fetched, ["keyartgone.png", "scenegone.png"]);
  const screenshot = sceneCoverage(catalog, proposal).find(({ role }) => role === "screenshot");
  assert.deepEqual(screenshot?.provider_game_ids, [7]);
  assert.equal(screenshot?.state, "withdrawn");
  assert.deepEqual(screenshot?.withdrawn_image_ids, ["scenegone"]);
  assert.deepEqual(screenshot?.proposed_image_ids, []);
  const header = sceneCoverage(catalog, proposal).find(({ role }) => role === "header");
  assert.equal(header?.state, "withdrawn");
  assert.deepEqual(header?.withdrawn_image_ids, ["keyartgone"]);
});

void test("a fully covered subject keeps every maintained media role without contacting IGDB", async () => {
  const { prepareCatalogGameMedia } = await import("./inspect-igdb-artwork.mts");
  const id = "covered-port";
  const media = ["key_art", "logo", "header", "screenshot"].map((role) => ({
    id: role + "-fixture",
    role,
    subject: { kind: "port", port_id: id },
  }));
  const catalog = {
    ports: [
      {
        id,
        name: "Covered",
        project_url: "https://example.org/covered",
        presentation: { media },
      },
    ],
  };
  const unexpected = () => {
    throw new Error("Retained roles do not need more provider requests");
  };
  const result = await prepareCatalogGameMedia(catalog, {
    inspector: {
      inspectGame: unexpected,
      inspectGameMedia: unexpected,
      inspectMediaImage: unexpected,
    },
  });
  assert.deepEqual(result.catalog, catalog);
  assert.deepEqual(
    result.records.map(({ reason }) => reason),
    [
      "existing-scene-retained",
      "existing-scene-retained",
      "existing-scene-retained",
      "existing-scene-retained",
    ],
  );
});

void test("explicit media refresh shares exact checks and only confirmed Gone withdraws maintained assets", async () => {
  const { createIgdbInspector, prepareCatalogGameMedia } =
    await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-retained-game-media-"));
  try {
    const privateFile = join(scratch, "private-fixture.json");
    writeFileSync(
      privateFile,
      JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
    );
    const ids = ["one", "two"];
    const catalog = {
      ports: ids.map((id) => ({
        id,
        name: "Sample",
        project_url: "https://example.org/sample",
        presentation: {
          original_game: {
            id: "original",
            source_editions: [{ id: "current" }, { id: "older" }],
          },
          media: ["key_art", "logo", "header", "screenshot"].map((role) => ({
            id: "maintained-" + role,
            role,
            subject:
              role === "logo"
                ? { kind: "original", game_id: "original", source_edition_id: "older" }
                : { kind: "port", port_id: id },
            sha256: "a".repeat(64),
            ...(role === "logo" ? { igdb: { image_id: "sharedlogo", game_id: 7 } } : {}),
          })),
        },
      })),
    };
    for (const status of [200, 503, 410]) {
      let reads = 0;
      const inspector = createIgdbInspector(
        privateFile,
        () => ({ format: "png", width: 400, height: 200, validator: "portcove-core" }),
        async (url) => {
          if (url.includes("oauth2")) return new Response('{"access_token":"fixture-token"}');
          if (url.endsWith("/games")) return new Response("[]");
          assert.match(url, /logo_med_2x\/sharedlogo\.png$/u);
          reads++;
          return status === 200
            ? new Response("changed-image", { headers: { "content-type": "image/png" } })
            : new Response(null, { status });
        },
      );
      const result = await prepareCatalogGameMedia(catalog, { inspector, refreshPortIds: ids });
      assert.equal(reads, 1);
      if (status === 410) {
        assert.deepEqual(result.gone_media_targets, ["logo_med_2x/sharedlogo"]);
        assert.ok(
          result.catalog.ports.every(
            ({ presentation }) =>
              Array.isArray(presentation?.media) && presentation.media.length === 3,
          ),
        );
        const withdrawal = result.records.find(
          ({ reason }) => reason === "retained-image-withdrawn",
        );
        assert.equal(withdrawal?.image_id, "sharedlogo");
        assert.deepEqual(withdrawal?.subject, {
          kind: "original",
          game_id: "original",
          source_edition_id: "older",
        });
      } else {
        assert.deepEqual(result.catalog, catalog);
        assert.deepEqual(result.gone_media_targets, []);
        assert.equal(
          result.records.filter(
            ({ reason }) =>
              reason ===
              (status === 200
                ? "retained-image-bytes-changed"
                : "media-provider-unavailable-or-incomplete"),
          ).length,
          2,
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
