import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
  ArtworkCatalog,
  ArtworkPreparationOptions,
  ArtworkRecord,
} from "./inspect-igdb-artwork.mts";

import {
  requiredFixture,
  record,
  text,
  fixtureJson,
  fixtureCatalog,
  root,
  catalogRoot,
} from "./fixtures/catalog-generator-fixtures.mts";

async function capturedArtworkRefresh({
  status = 410,
  imageId = "coexisting",
  fault,
}: { status?: number; imageId?: string; fault?: string } = {}) {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-refresh-"));
  const credentials = join(scratch, "private-fixture.json");
  writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  const mapping = {
    game_id: 101,
    cover_id: 202,
    image_id: "coexisting",
    image_sha256: "a".repeat(64),
    game_slug: "refresh-probe",
    match_kind: "port",
  };
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "refresh-probe",
        name: "Refresh Probe",
        project_url: "https://example.org/refresh-probe",
        presentation: { artwork: mapping },
      },
    ],
  };
  const games: {
    id: number;
    name: string;
    slug: string;
    cover?: { id: number; image_id: string };
  }[] = [
    {
      id: 101,
      name: "Refresh Probe",
      slug: "refresh-probe",
      cover: { id: 202, image_id: imageId },
    },
  ];
  const requests: string[] = [];
  let decodes = 0;
  const inspector = createIgdbInspector(
    credentials,
    () => {
      decodes++;
      return { width: 12, height: 24, format: "jpeg", validator: "portcove-core" };
    },
    async (url: string, options: RequestInit) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" }, { status: fault === "auth" ? 403 : 200 });
      if (url === "https://api.igdb.com/v4/games")
        return Response.json(
          games.filter((game) => text(options.body).includes(`id = ${game.id};`)),
          {
            status: fault === "identity-gone" ? 410 : 200,
          },
        );
      assert.ok(
        /^https:\/\/images\.igdb\.com\/igdb\/image\/upload\/t_cover_big\/[a-z0-9]+\.jpg$/.test(url),
      );
      if (fault === "network") throw new Error("fixture network failure");
      return new Response(
        readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg")),
        {
          status: url.endsWith("/coexisting.jpg")
            ? status
            : imageId === "coexisting"
              ? 200
              : status,
          headers: { "content-type": "image/jpeg" },
        },
      );
    },
  );
  const options: ArtworkPreparationOptions & {
    identities: Record<string, { port?: unknown; underlying_game?: unknown }>;
  } = {
    ...inspector,
    acceptedCatalog: accepted,
    refreshPortIds: ["refresh-probe"],
    identities: {
      "refresh-probe": {
        port: {
          game_id: 101,
          slug: "refresh-probe",
          names: ["Refresh Probe"],
          evidence_url: "https://example.org/refresh-probe",
        },
      },
    },
  };
  return {
    accepted,
    games,
    requests,
    options,
    inspector,
    decodes: () => decodes,
    run: (input = accepted) => prepareCatalogArtwork(input, options),
  };
}

void test("artwork batches reject numeric port identities rather than coercing them into stable IDs", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  await assert.rejects(
    prepareCatalogArtwork(
      // @ts-expect-error Numeric IDs deliberately represent malformed authoring input.
      { ports: [{ id: 7, name: "Numeric identity" }] },
      { acceptedCatalog: { ports: [] } },
    ),
    /unique stable port ids/,
  );
});

void test("artwork proposal batches reuse accepted choices and separately prove identity and bytes", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted: ArtworkCatalog = {
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
  const queries: (number | null)[] = [];
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
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-mapping-reused");
  assert.equal(requiredFixture(result.records[1]).reason, "exact-port-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[1]).presentation).artwork)
      .game_id,
    3,
  );
  assert.deepEqual(
    requiredFixture(result.catalog.ports[1]).release,
    requiredFixture(before.ports[1]).release,
  );
  assert.equal(result.metrics.reused, 1);
  assert.equal(result.metrics.selected, 1);
});

void test("coverless port falls through to exact original; ambiguous and failed images remain nonblocking", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const target = (game_id: number, slug: string) => ({
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
  assert.equal(requiredFixture(result.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .match_kind,
    "underlying-game",
  );
  assert.equal(requiredFixture(result.records[1]).reason, "generated-fallback");
  assert.equal(
    requiredFixture(requiredFixture(result.records[1]).exceptions[0]).reason,
    "identity-not-unique",
  );
  assert.equal(
    requiredFixture(requiredFixture(result.records[2]).exceptions[0]).reason,
    "image-unavailable-or-invalid",
  );
  assert.equal(result.metrics.fallback, 2);
});

void test("the entire accepted cover inventory survives a routine executable release without lookup", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogRoot, "catalog.json"), "utf8")),
  );
  const input = structuredClone(accepted);
  requiredFixture(requiredFixture(input.ports[0]).release).version = "ordinary-successor";
  // One operation admits at most 400 ports, so the whole catalog runs as
  // consecutive operations over the evolving proposal, as the generator does.
  const ids = input.ports.map((port) => port.id);
  const result: {
    catalog: ArtworkCatalog;
    records: ArtworkRecord[];
    reused: number;
    fallback: number;
  } = { catalog: input, records: [], reused: 0, fallback: 0 };
  for (let start = 0; start < ids.length; start += 400) {
    const operation = await prepareCatalogArtwork(result.catalog, {
      acceptedCatalog: accepted,
      selectedPortIds: ids.slice(start, start + 400),
      inspectGame: () => assert.fail("unchanged accepted artwork must not search"),
      inspectImage: () => assert.fail("unchanged accepted artwork must not download"),
    });
    result.catalog = operation.catalog;
    result.records.push(...operation.records);
    result.reused += operation.metrics.reused;
    result.fallback += operation.metrics.fallback;
  }
  const mapped = accepted.ports.filter((port) => port.presentation?.artwork);
  const unmapped = accepted.ports.filter((port) => !port.presentation?.artwork);
  assert.equal(result.reused, mapped.length);
  assert.equal(result.fallback, unmapped.length);
  assert.deepEqual(
    result.records.filter((record) => record.mapping).map((record) => record.port_id),
    mapped.map((port) => port.id),
  );
  assert.deepEqual(
    result.records
      .filter((record) => record.reason === "generated-fallback")
      .map((record) => record.port_id),
    unmapped.map((port) => port.id),
  );
  assert.deepEqual(result.catalog, input);
});

void test("another port can reuse a uniquely accepted original-game asset without merging port identities", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const mapping = {
    game_id: 2,
    cover_id: 3,
    image_id: "co2",
    image_sha256: "a".repeat(64),
    game_slug: "original",
    match_kind: "underlying-game",
  };
  const accepted: ArtworkCatalog = {
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
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-original-game-reused");
  assert.equal(result.metrics.original_reused, 1);
  assert.equal(result.metrics.game_queries, 1);
  assert.equal(requiredFixture(result.catalog.ports[0]).id, "second-port");
  assert.equal(requiredFixture(result.catalog.ports[0]).source_profile, "distinct-contract");
  assert.deepEqual(
    requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork,
    mapping,
  );
});

void test("an unavailable explicit refresh retains permitted accepted metadata", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogRoot, "catalog.json"), "utf8")),
  );
  const port = requiredFixture(accepted.ports[0]);
  const mapping = record(requiredFixture(port.presentation).artwork);
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
  assert.deepEqual(requiredFixture(result.catalog.ports[0]), port);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
  assert.equal(record(requiredFixture(result.records[0]).checks).live_refresh_passed, false);
});

void test("a confirmed Gone response for the accepted image chooses generated fallback", async () => {
  const fixture = await capturedArtworkRefresh();
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  assert.equal(
    requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork,
    undefined,
  );
  assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
  assert.deepEqual(requiredFixture(requiredFixture(result.records[0]).exceptions[0]), {
    kind: "port",
    reason: "image-gone",
    resume:
      "Correct the exact identity or asset fact, or retry after a confirmed provider/environment change.",
    image_id: "coexisting",
    http_status: 410,
  });
  assert.equal(requiredFixture(result.records[0]).mapping, null);
  assert.equal(result.metrics.fallback, 1);
  assert.equal(result.metrics.reused, 0);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.deepEqual(fixture.accepted, before);
  assert.equal(fixture.decodes(), 0);
});

for (const status of [404, 503, 429]) {
  void test(`HTTP${status} retains permitted accepted artwork metadata`, async () => {
    const fixture = await capturedArtworkRefresh({ status });
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.deepEqual(result.catalog, before);
    assert.deepEqual(fixture.accepted, before);
    assert.equal(
      requiredFixture(result.records[0]).reason,
      "accepted-mapping-retained-after-unavailable-refresh",
    );
    assert.equal(fixture.decodes(), 0);
  });
}

void test("an unchanged accepted mapping makes no source-health claim or provider request", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.options.refreshPortIds = [];
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-mapping-reused");
  assert.equal(fixture.requests.length, 0);
});

void test("sparse artwork preparation keeps a large catalog and reuses unselected mappings", async () => {
  const fixture = await capturedArtworkRefresh({ status: 503 });
  const retained = requiredFixture(fixture.accepted.ports[0]);
  for (let index = 0; index < 520; index++)
    fixture.accepted.ports.push({ ...structuredClone(retained), id: `retained-${index}` });
  fixture.options.selectedPortIds = ["refresh-probe"];
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  assert.deepEqual(result.catalog, before);
  assert.equal(result.metrics.ports, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.workset.catalog_ports, 521);
  assert.deepEqual(result.workset.selected_port_ids, ["refresh-probe"]);
  assert.deepEqual(result.workset.invalidated_port_ids, []);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
});

void test("sparse exact-image invalidation reaches unselected references without new queries", async () => {
  const fixture = await capturedArtworkRefresh();
  const retained = requiredFixture(fixture.accepted.ports[0]);
  for (let index = 0; index < 420; index++)
    fixture.accepted.ports.push({ ...structuredClone(retained), id: `shared-image-${index}` });
  fixture.options.selectedPortIds = ["refresh-probe"];
  const result = await fixture.run();
  assert.equal(result.catalog.ports.length, 421);
  assert.ok(result.catalog.ports.every((port) => port.presentation?.artwork === undefined));
  assert.equal(result.records.length, 421);
  assert.equal(result.metrics.fallback, 421);
  assert.equal(result.workset.invalidated_port_ids.length, 420);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
  assert.ok(fixture.accepted.ports.every((port) => port.presentation?.artwork));
});

void test("artwork worksets are bounded and cannot hide changed mappings outside their scope", async () => {
  const fixture = await capturedArtworkRefresh();
  const retained = requiredFixture(fixture.accepted.ports[0]);
  for (let index = 0; index < 401; index++)
    fixture.accepted.ports.push({ ...structuredClone(retained), id: `bounded-${index}` });
  await assert.rejects(fixture.run(), /worksets require at most400/);
  fixture.options.selectedPortIds = ["refresh-probe", "refresh-probe"];
  await assert.rejects(fixture.run(), /unique catalog port ids/);
  fixture.options.selectedPortIds = ["unknown-id"];
  await assert.rejects(fixture.run(), /unique catalog port ids/);
  fixture.options.selectedPortIds = ["refresh-probe"];
  const changed = structuredClone(fixture.accepted);
  requiredFixture(changed.ports[1]).name = "A different identity";
  await assert.rejects(fixture.run(changed), /Changed artwork identity outside selected workset/);
  assert.equal(fixture.requests.length, 3);
});

void test("Gone for a different candidate image cannot withdraw accepted artwork", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(fixture.decodes(), 0);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
});

for (const fault of ["auth", "network", "identity-gone"]) {
  void test(`${fault} failure does not establish Gone for an accepted image`, async () => {
    const fixture = await capturedArtworkRefresh({ fault });
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.ok(
      requiredFixture(result.records[0]).exceptions.every((item) => item.reason !== "image-gone"),
    );
    assert.equal(fixture.decodes(), 0);
  });
}

void test("unclassified status properties and another image's Gone error cannot withdraw metadata", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const unrelated = await fixture.inspector
    .inspectImage("codifferent")
    .catch((error: unknown) => error);
  for (const error of [
    Object.assign(new Error("IGDB image is gone."), { status: 410, image_id: "coexisting" }),
    unrelated,
  ]) {
    requiredFixture(requiredFixture(fixture.games[0]).cover).image_id = "coexisting";
    fixture.options.inspectImage = async () => {
      throw error;
    };
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.equal(
      requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
      "image-unavailable-or-invalid",
    );
  }
});

for (const refreshedFirst of [true, false]) {
  void test(`same-image accepted references fall back with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
    const fixture = await capturedArtworkRefresh();
    const reused = {
      ...structuredClone(requiredFixture(fixture.accepted.ports[0])),
      id: "reused",
      name: "Reused",
    };
    fixture.accepted.ports = refreshedFirst
      ? [...fixture.accepted.ports, reused]
      : [reused, ...fixture.accepted.ports];
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.ok(result.catalog.ports.every((port) => !requiredFixture(port.presentation).artwork));
    assert.ok(
      result.records.every(
        (record) => record.reason === "generated-fallback" && record.mapping === null,
      ),
    );
    assert.ok(
      result.records.every((record) =>
        record.exceptions.some(
          (item) => item.image_id === "coexisting" && item.http_status === 410,
        ),
      ),
    );
    assert.deepEqual(fixture.accepted, before);
    assert.deepEqual(result.metrics, {
      ports: 2,
      reused: 0,
      original_reused: 0,
      selected: 0,
      fallback: 2,
      game_queries: 1,
      image_queries: 1,
      image_bytes: 0,
    });
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
    assert.equal(fixture.decodes(), 0);
  });
}

for (const refreshedFirst of [true, false]) {
  void test(`accepted original-game reuse cannot restore Gone with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
    const fixture = await capturedArtworkRefresh();
    const original = {
      game_id: 102,
      game_slug: "original",
      cover_id: 203,
      image_id: "coexisting",
      image_sha256: "b".repeat(64),
      match_kind: "underlying-game",
    };
    fixture.accepted.ports.push({ id: "accepted-original", presentation: { artwork: original } });
    fixture.games.push(
      { id: 102, slug: "original", name: "Original", cover: { id: 203, image_id: "coexisting" } },
      { id: 103, slug: "new", name: "New" },
    );
    fixture.options.identities.new = {
      port: { game_id: 103, slug: "new", names: ["New"], evidence_url: "https://example.org/new" },
      underlying_game: {
        game_id: 102,
        slug: "original",
        names: ["Original"],
        evidence_url: "https://example.org/original",
      },
    };
    const added = { id: "new", name: "New", project_url: "https://example.org/new" };
    const refreshed = requiredFixture(fixture.accepted.ports[0]);
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run({
      ports: refreshedFirst ? [refreshed, added] : [added, refreshed],
    });
    assert.ok(result.catalog.ports.every((port) => !port.presentation?.artwork));
    assert.ok(
      result.records.every(
        (record) => record.reason === "generated-fallback" && record.mapping === null,
      ),
    );
    assert.ok(
      result.records.every((record) =>
        record.exceptions.some(
          (item) => item.image_id === "coexisting" && item.http_status === 410,
        ),
      ),
    );
    assert.deepEqual(fixture.accepted, before);
    assert.equal(result.metrics.selected, 0);
    assert.equal(result.metrics.original_reused, 0);
    assert.equal(result.metrics.reused, 0);
    assert.equal(result.metrics.fallback, 2);
    assert.equal(result.metrics.image_queries, 1);
    assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
    assert.equal(fixture.decodes(), 0);
  });
}

void test("Gone for the port cover still permits a checked exact original-game replacement", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.games.push({
    id: 102,
    slug: "original",
    name: "Original",
    cover: { id: 203, image_id: "coreplacement" },
  });
  requiredFixture(fixture.options.identities["refresh-probe"]).underlying_game = {
    game_id: 102,
    slug: "original",
    names: ["Original"],
    evidence_url: "https://example.org/original",
  };
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  const bytes = readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg"));
  const { createHash } = await import("node:crypto");
  assert.equal(requiredFixture(result.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .image_id,
    "coreplacement",
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .match_kind,
    "underlying-game",
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .image_sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(requiredFixture(requiredFixture(result.records[0]).exceptions[0]).http_status, 410);
  assert.equal(
    record(record(requiredFixture(result.records[0]).checks).content).bytes,
    bytes.length,
  );
  assert.equal(result.metrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 2);
  assert.equal(fixture.decodes(), 1);
  assert.deepEqual(fixture.accepted, before);
});

void test("Gone observations still consume the existing finite image-request budget", async () => {
  const fixture = await capturedArtworkRefresh();
  for (let request = 0; request < 400; request++)
    await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image is gone/);
  await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image budget reached/);
  assert.equal(fixture.requests.length, 400);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 400);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.equal(fixture.decodes(), 0);
});

void test("a successful HTTP image exceeding its remaining byte budget retains accepted metadata", async () => {
  const fixture = await capturedArtworkRefresh({ status: 200 });
  fixture.options.inspectImage = (imageId) => fixture.inspector.inspectImage(imageId, 1);
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(
    requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
    "batch-provider-budget-exhausted",
  );
  assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
  assert.equal(fixture.decodes(), 0);
});

void test("artwork preparation widens replaced artwork while retaining authoring metadata", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const input = {
    schema_version: 2,
    custom: { retained: true },
    ports: [
      {
        id: "typed-artwork",
        name: "Typed artwork",
        custom: "retained",
        presentation: { artwork: null, summary: "retained" },
      },
    ],
  };
  const result = await prepareCatalogArtwork(input, {});
  const port = requiredFixture(result.catalog.ports[0]);
  assert.ok(port);
  // @ts-expect-error Preparation may remove null or replace it with a checked mapping.
  const originalLiteral: null = port.presentation?.artwork;
  assert.equal(originalLiteral, undefined);
  const imageId: string | undefined = port.presentation?.artwork?.image_id;
  assert.equal(imageId, undefined);
  assert.deepEqual(result.catalog.custom, input.custom);
  assert.equal(port.custom, "retained");
  assert.equal(port.presentation?.summary, "retained");
  assert.equal(requiredFixture(input.ports[0])?.presentation.artwork, null);
});

function scalableArtworkFixture(count: number) {
  const catalog: ArtworkCatalog = {
    ports: Array.from({ length: count }, (_, index) => ({
      id: `scale-${index}`,
      name: `Scale ${index}`,
      project_url: `https://example.org/scale-${index}`,
      source_profile: `retained-${index}`,
    })),
  };
  const requests: string[] = [];
  let batches = 0;
  let used = 0;
  let failure: string | null = null;
  const inspector = {
    beginBatch() {
      batches++;
      used = 0;
    },
    inspectGame(identity: Parameters<NonNullable<ArtworkPreparationOptions["inspectGame"]>>[0]) {
      requests.push(identity.names[0]!);
      if (identity.names[0] === failure) throw new Error("Temporary provider failure");
      const index = Number(identity.names[0]!.split(" ")[1]);
      return [
        {
          id: index + 1,
          name: identity.names[0],
          slug: `scale-${index}`,
          websites: [{ url: identity.project_url }],
          cover: { id: index + 1, image_id: `scale${index}` },
        },
      ];
    },
    inspectImage() {
      used++;
      return {
        sha256: "d".repeat(64),
        bytes: 100,
        width: 264,
        height: 374,
        format: "jpeg",
        validator: "portcove-core",
      };
    },
  };
  return {
    catalog,
    requests,
    inspector,
    batches: () => batches,
    used: () => used,
    fail: (name: string | null) => {
      failure = name;
    },
  };
}

void test("logical artwork maintenance crosses 400 IDs, checkpoints interruption, and invalidates only changed input", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-workset-"));
  const fixture = scalableArtworkFixture(501);
  const before = structuredClone(fixture.catalog);
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    identities: {},
    validatorIdentity: null,
    selectedPortIds: fixture.catalog.ports.map((port) => port.id),
  };
  const signal = new AbortController();
  let completed = 0;
  try {
    await assert.rejects(
      prepareArtworkWorkset(fixture.catalog, {
        ...options,
        signal: signal.signal,
        onProgress() {
          if (++completed === 107) signal.abort();
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(fixture.requests.length, 107);
    const resumed = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(resumed.continuation.complete, true);
    assert.equal(resumed.continuation.completed_cache_hits, 107);
    assert.equal(fixture.requests.length, 501);
    assert.ok(resumed.continuation.batches >= 1);
    assert.equal(new Set(fixture.requests).size, 501);
    assert.deepEqual(fixture.catalog, before);
    const cached = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(cached.continuation.completed_cache_hits, 501);
    assert.equal(fixture.requests.length, 501);
    fixture.catalog.ports[450]!.source_profile = "changed";
    const changed = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(changed.continuation.completed_cache_hits, 500);
    assert.equal(fixture.requests.length, 502);
    assert.equal(fixture.requests.at(-1), "Scale 450");
    const progress = join(scratch, "artwork-progress-scale-0.json");
    const state = JSON.parse(readFileSync(progress, "utf8")) as Record<string, unknown>;
    state.port_id = "different";
    writeFileSync(progress, JSON.stringify(state));
    await assert.rejects(
      prepareArtworkWorkset(fixture.catalog, options),
      /identity, facts or clocks differ/,
    );
    assert.equal(fixture.requests.length, 502);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("a verified Gone image removes an out-of-workset companion without changing its primary cover", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-companion-"));
  try {
    const fixture = await capturedArtworkRefresh();
    const primary = {
      game_id: 102,
      cover_id: 203,
      image_id: "retained",
      image_sha256: "b".repeat(64),
      game_slug: "retained",
      match_kind: "port",
    };
    fixture.accepted.ports.push({
      id: "combined",
      presentation: {
        artwork: primary,
        companion_cover: fixture.accepted.ports[0]?.presentation?.artwork,
      },
    });
    const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
    const prepared = await prepareCatalogArtwork(fixture.accepted, {
      ...fixture.options,
      selectedPortIds: ["refresh-probe"],
    });
    assert.deepEqual(prepared.catalog.ports[1]?.presentation, { artwork: primary });
    assert.ok(prepared.workset.invalidated_port_ids.includes("combined"));
    const result = await prepareArtworkWorkset(fixture.accepted, {
      root: scratch,
      identities: fixture.options.identities,
      validatorIdentity: null,
      selectedPortIds: ["refresh-probe"],
      refreshPortIds: ["refresh-probe"],
      inspector: fixture.inspector,
    });
    assert.deepEqual(result.gone_image_ids, ["coexisting"]);
    assert.deepEqual(result.catalog.ports[1]?.presentation, { artwork: primary });
    assert.ok(result.workset.invalidated_port_ids.includes("combined"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("reobserved artwork invalidates an original mapping inherited while its alternative was Gone", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-reobserved-"));
  try {
    const gone = await capturedArtworkRefresh();
    const recovered = await capturedArtworkRefresh({ status: 200 });
    const identity = {
      game_id: 102,
      slug: "original",
      names: ["Original"],
      evidence_url: "https://example.org/original",
    };
    const mapping = {
      game_id: 102,
      game_slug: "original",
      cover_id: 203,
      image_id: "coexisting",
      image_sha256: "b".repeat(64),
      match_kind: "underlying-game",
    };
    const accepted = structuredClone(gone.accepted);
    accepted.ports.push(
      { id: "first-original", presentation: { artwork: mapping } },
      {
        id: "second-original",
        presentation: { artwork: { ...mapping, cover_id: 204, image_id: "alternative" } },
      },
    );
    const proposal = {
      ports: [...accepted.ports, { id: "selected", name: "Selected", underlying_game: identity }],
    };
    const refresh = {
      root: scratch,
      identities: gone.options.identities,
      validatorIdentity: null,
      selectedPortIds: ["refresh-probe"],
      refreshPortIds: ["refresh-probe"],
    };
    const withdrawn = await prepareArtworkWorkset(accepted, {
      ...refresh,
      inspector: gone.inspector,
    });
    assert.deepEqual(withdrawn.gone_image_ids, ["coexisting"]);
    const selected = {
      root: scratch,
      acceptedCatalog: accepted,
      identities: {},
      validatorIdentity: null,
      selectedPortIds: ["selected"],
      inspector: { inspectGame: () => [] },
    };
    const inherited = await prepareArtworkWorkset(proposal, selected);
    assert.equal(inherited.records[0]?.reason, "accepted-original-game-reused");
    assert.equal(inherited.records[0]?.mapping?.image_id, "alternative");
    const refreshed = await prepareArtworkWorkset(accepted, {
      ...refresh,
      inspector: recovered.inspector,
    });
    assert.equal(refreshed.records[0]?.mapping?.image_id, "coexisting");
    const reconsidered = await prepareArtworkWorkset(proposal, selected);
    assert.equal(reconsidered.continuation.completed_cache_hits, 0);
    assert.equal(reconsidered.records[0]?.reason, "generated-fallback");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("partial provider failure retries the unchanged full logical workset without repeating completed IDs", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-recovery-"));
  const fixture = scalableArtworkFixture(403);
  fixture.fail("Scale 2");
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    identities: {},
    validatorIdentity: null,
    selectedPortIds: fixture.catalog.ports.map((port) => port.id),
  };
  try {
    const partial = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(partial.continuation.pending_port_ids, ["scale-2"]);
    assert.equal(partial.continuation.batches, 2);
    fixture.fail(null);
    const recovered = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(recovered.continuation.complete, true);
    assert.equal(recovered.continuation.completed_cache_hits, 402);
    assert.equal(fixture.requests.length, 404);
    assert.equal(fixture.requests.at(-1), "Scale 2");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("an unavailable provider batch cannot starve trailing accepted artwork", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const { ArtworkBatchExhausted } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-fairness-"));
  const fixture = scalableArtworkFixture(401);
  fixture.catalog.ports[400]!.presentation = {
    artwork: {
      game_id: 401,
      cover_id: 401,
      image_id: "accepted",
      image_sha256: "a".repeat(64),
      game_slug: "scale-400",
      match_kind: "port",
    },
  };
  let requests = 0;
  try {
    const result = await prepareArtworkWorkset(fixture.catalog, {
      root: scratch,
      identities: {},
      validatorIdentity: null,
      selectedPortIds: fixture.catalog.ports.map((port) => port.id),
      inspector: {
        inspectGame() {
          requests++;
          throw new ArtworkBatchExhausted("Provider unavailable");
        },
        inspectImage() {
          return assert.fail("Unavailable identity cannot download");
        },
      },
    });
    assert.equal(requests, 400);
    assert.equal(result.continuation.pending_port_ids.length, 400);
    assert.equal(
      result.records.find((record) => record.port_id === "scale-400")!.reason,
      "accepted-mapping-reused",
    );
    assert.ok(
      readFileSync(join(scratch, "artwork-progress-scale-400.json"), "utf8").includes(
        '"complete":true',
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("automatic due maintenance uses actual retained observation clocks and leaves unknown clocks due", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-due-"));
  const fixture = scalableArtworkFixture(2);
  let time = Date.parse("2026-10-01T00:00:00Z");
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    identities: {},
    validatorIdentity: null,
    maintenance: true,
    now: () => time,
  };
  try {
    const first = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(first.continuation.complete, true);
    const ordinary = await prepareArtworkWorkset(fixture.catalog, {
      ...options,
      maintenance: false,
      selectedPortIds: ["scale-0"],
    });
    assert.equal(ordinary.continuation.complete, true);
    const current = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(current.workset.selected_port_ids, []);
    assert.equal(current.records.length, 2);
    assert.ok(current.catalog.ports.every((port) => port.presentation?.artwork));
    assert.equal(current.workset.carried_port_ids.length, 2);
    assert.equal(fixture.requests.length, 3);
    time += 29 * 24 * 60 * 60 * 1000;
    const overdue = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(overdue.workset.selected_port_ids.length, 2);
    assert.equal(fixture.requests.length, 5);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("an explicit refresh reuses a recent result and samples an older one again", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-explicit-refresh-"));
  const fixture = scalableArtworkFixture(1);
  let time = Date.parse("2026-10-01T00:00:00Z");
  let imageId = "firstimage";
  const options = {
    root: scratch,
    identities: {},
    inspector: {
      ...fixture.inspector,
      inspectGame(identity: Parameters<typeof fixture.inspector.inspectGame>[0]) {
        return fixture.inspector.inspectGame(identity).map((match) => ({
          ...match,
          cover: { ...match.cover, image_id: imageId },
        }));
      },
    },
    validatorIdentity: null,
    selectedPortIds: ["scale-0"],
    refreshPortIds: ["scale-0"],
    now: () => time,
  };
  try {
    const first = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(first.records[0]?.mapping?.image_id, "firstimage");
    imageId = "replacementimage";
    const resumed = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(resumed.records[0]?.mapping?.image_id, "firstimage");
    assert.equal(fixture.requests.length, 1);

    time += 28 * 24 * 60 * 60 * 1000;
    const refresh = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(refresh.records[0]?.mapping?.image_id, "replacementimage");
    assert.equal(fixture.requests.length, 2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("bounded due maintenance rotates attempted retained covers without admitting unreviewed rows", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-retained-limit-"));
  const fixture = scalableArtworkFixture(3);
  for (let index = 0; index < 2; index++) {
    fixture.catalog.ports[index]!.presentation = {
      artwork: {
        game_id: index + 1,
        cover_id: index + 1,
        image_id: `scale${index}`,
        image_sha256: "d".repeat(64),
        game_slug: `scale-${index}`,
        match_kind: "port",
      },
    };
  }
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    validatorIdentity: null,
    identities: {},
    maintenance: true,
    retainedCoverLimit: 1,
    now: () => Date.parse("2026-11-21T00:00:00Z"),
  };
  try {
    fixture.fail("Scale 0");
    const first = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(first.workset.selected_port_ids, ["scale-0"]);
    assert.equal(first.continuation.unselected_due_count, 1);
    assert.equal(first.continuation.complete, false);

    const second = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(second.workset.selected_port_ids, ["scale-1"]);
    assert.equal(second.continuation.unselected_due_count, 1);
    assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1"]);
    assert.equal(second.catalog.ports[2]?.presentation?.artwork, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("bounded full artwork rounds finish older missing and retained work before new arrivals", async (t) => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-due-round-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = scalableArtworkFixture(5);
  const all = fixture.catalog.ports;
  all[2]!.presentation = {
    artwork: {
      game_id: 3,
      cover_id: 3,
      image_id: "scale2",
      image_sha256: "d".repeat(64),
      game_slug: "scale-2",
      match_kind: "port",
    },
  };
  let now = Date.parse("2026-11-21T00:00:00Z");
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    validatorIdentity: null,
    identities: {},
    maintenance: true,
    dueCoverLimit: 1,
    now: () => now,
  };
  const firstCatalog = { ...fixture.catalog, ports: all.slice(0, 3) };
  fixture.fail("Scale 0");
  const first = await prepareArtworkWorkset(firstCatalog, options);
  assert.deepEqual(first.workset.selected_port_ids, ["scale-0"]);
  assert.deepEqual(first.continuation.pending_port_ids, ["scale-0"]);
  assert.equal(first.continuation.unselected_due_count, 2);
  assert.equal(first.continuation.complete, false);

  now++;
  const expanded = { ...fixture.catalog, ports: all.slice(0, 4) };
  await assert.rejects(
    prepareArtworkWorkset(expanded, {
      ...options,
      onProgress(id) {
        assert.equal(id, "scale-1");
        throw new Error("Stopped after per-item checkpoint");
      },
    }),
    /Stopped after per-item checkpoint/,
  );
  assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1"]);
  now++;
  const third = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(third.workset.selected_port_ids, ["scale-2"]);
  assert.ok(third.workset.carried_port_ids.includes("scale-1"));
  assert.equal(third.continuation.unselected_due_count, 3);
  assert.equal(third.continuation.complete, false);
  assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1", "Scale 2"]);

  fixture.fail(null);
  const nextRound = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(nextRound.workset.selected_port_ids, ["scale-3"]);
  assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1", "Scale 2", "Scale 3"]);
  const cursorPath = join(scratch, "artwork-due-round.json");
  const retained = readFileSync(cursorPath, "utf8");
  const cursor = JSON.parse(retained) as { next: number };
  writeFileSync(cursorPath, JSON.stringify({ ...cursor, next: cursor.next + 1 }));
  await assert.rejects(
    prepareArtworkWorkset(fixture.catalog, options),
    /artwork due cursor does not match its receipt/,
  );
  assert.equal(fixture.requests.length, 4);
  writeFileSync(cursorPath, retained);

  const secondArrival = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(secondArrival.workset.selected_port_ids, ["scale-4"]);
  const olderRetry = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(olderRetry.workset.selected_port_ids, ["scale-0"]);
  assert.equal(
    olderRetry.records.find(({ port_id }) => port_id === "scale-0")?.mapping?.image_id,
    "scale0",
  );
});

void test("bounded artwork keeps provider backoff pending without consuming a later pass", async (t) => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-due-retry-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = scalableArtworkFixture(2);
  let now = Date.parse("2026-11-21T00:00:00Z");
  const retryAt = now + 60_000;
  fixture.fail("Scale 0");
  const options = {
    root: scratch,
    inspector: {
      ...fixture.inspector,
      batchStatus: () => ({
        deadline: now + 10_000,
        retry_at:
          now < retryAt && fixture.requests.at(-1) === "Scale 0"
            ? new Date(retryAt).toISOString()
            : null,
      }),
    },
    validatorIdentity: null,
    identities: {},
    maintenance: true,
    dueCoverLimit: 1,
    now: () => now,
  };
  const first = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(first.continuation.pending_port_ids, ["scale-0"]);
  const second = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(second.workset.selected_port_ids, ["scale-1"]);
  const deferred = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(deferred.workset.selected_port_ids, []);
  assert.equal(deferred.continuation.unselected_due_count, 1);
  assert.equal(deferred.continuation.complete, false);
  assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1"]);

  now = retryAt;
  fixture.fail(null);
  const resumed = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(resumed.workset.selected_port_ids, ["scale-0"]);
  assert.equal(resumed.continuation.complete, true);
  assert.deepEqual(fixture.requests, ["Scale 0", "Scale 1", "Scale 0"]);
});

void test("due maintenance revalidates the same game and cover role", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-retained-identity-"));
  const fixture = scalableArtworkFixture(1);
  const artwork = {
    game_id: 1,
    cover_id: 1,
    image_id: "acceptedimage",
    image_sha256: "d".repeat(64),
    game_slug: "scale-0",
    match_kind: "port",
  };
  fixture.catalog.ports[0]!.presentation = { artwork };
  fixture.catalog.ports[0]!.underlying_game = {
    names: ["Original Game"],
    evidence_url: "https://example.org/original",
    project_url: "https://example.org/original",
  };
  let allowReplacement = false;
  const requests: [number | null, string | null, string][] = [];
  const images: string[] = [];
  const options = {
    root: scratch,
    validatorIdentity: null,
    identities: {},
    maintenance: true,
    inspector: {
      inspectGame(identity: Parameters<NonNullable<ArtworkPreparationOptions["inspectGame"]>>[0]) {
        requests.push([identity.game_id, identity.slug, identity.kind]);
        return allowReplacement
          ? [
              {
                id: 1,
                slug: "scale-0",
                name: "Scale 0",
                cover: { id: 2, image_id: "replacementimage" },
              },
            ]
          : [
              {
                id: 2,
                slug: "original-game",
                name: "Original Game",
                websites: [{ url: "https://example.org/original" }],
                cover: { id: 3, image_id: "unreviewedimage" },
              },
            ];
      },
      inspectImage(imageId: string) {
        images.push(imageId);
        return fixture.inspector.inspectImage();
      },
    },
  };
  try {
    const explicit = await prepareArtworkWorkset(fixture.catalog, {
      ...options,
      maintenance: false,
      selectedPortIds: ["scale-0"],
      refreshPortIds: ["scale-0"],
    });
    assert.equal(explicit.records[0]?.mapping?.match_kind, "underlying-game");
    requests.length = 0;
    images.length = 0;

    const held = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(requests, [[1, "scale-0", "port"]]);
    assert.deepEqual(images, []);
    assert.deepEqual(held.records[0]?.mapping, artwork);
    assert.equal(held.continuation.complete, false);

    allowReplacement = true;
    const next = await prepareArtworkWorkset(fixture.catalog, options);
    assert.deepEqual(requests, [
      [1, "scale-0", "port"],
      [1, "scale-0", "port"],
    ]);
    assert.deepEqual(images, ["replacementimage"]);
    assert.equal(next.records[0]?.mapping?.image_id, "replacementimage");
    assert.equal(next.records[0]?.mapping?.game_id, artwork.game_id);
    assert.equal(next.records[0]?.mapping?.match_kind, artwork.match_kind);
    assert.equal(next.continuation.complete, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("maintenance refreshes an accepted original cover without an authored original title", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-unnamed-original-"));
  const fixture = scalableArtworkFixture(1);
  const artwork = {
    game_id: 1,
    cover_id: 1,
    image_id: "approvedimage",
    image_sha256: "d".repeat(64),
    game_slug: "scale-0",
    match_kind: "underlying-game",
  };
  fixture.catalog.ports[0]!.presentation = { artwork };
  let game = { id: 1, slug: "different-edition", imageId: "unapprovedimage" };
  const options = {
    root: scratch,
    validatorIdentity: null,
    identities: {},
    maintenance: true,
    inspector: {
      inspectGame(identity: Parameters<NonNullable<ArtworkPreparationOptions["inspectGame"]>>[0]) {
        assert.equal(identity.kind, "underlying-game");
        assert.equal(identity.game_id, 1);
        assert.equal(identity.slug, "scale-0");
        assert.deepEqual(identity.names, []);
        return [
          {
            id: game.id,
            slug: game.slug,
            name: "Original Title",
            cover: { id: 3, image_id: game.imageId },
          },
        ];
      },
      inspectImage(imageId: string) {
        assert.equal(imageId, "observedimage");
        return fixture.inspector.inspectImage();
      },
    },
  };
  try {
    const wrongSlug = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(wrongSlug.continuation.complete, false);
    assert.deepEqual(wrongSlug.records[0]?.mapping, artwork);

    game = { id: 2, slug: "scale-0", imageId: "unapprovedimage" };
    const wrongId = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(wrongId.continuation.complete, false);
    assert.deepEqual(wrongId.records[0]?.mapping, artwork);

    game = { id: 1, slug: "scale-0", imageId: "observedimage" };
    const result = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(result.continuation.complete, true);
    assert.deepEqual(result.records[0]?.mapping, {
      ...artwork,
      cover_id: 3,
      image_id: "observedimage",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("provider backoff survives continuation and applies to newly added identities", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const { ArtworkBatchExhausted } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-backoff-resume-"));
  const fixture = scalableArtworkFixture(1);
  const now = Date.now();
  const reset = new Date(now + 3600000).toISOString();
  const options = {
    root: scratch,
    identities: {},
    validatorIdentity: null,
    selectedPortIds: ["scale-0"],
  };
  try {
    const partial = await prepareArtworkWorkset(fixture.catalog, {
      ...options,
      inspector: {
        inspectGame() {
          throw new ArtworkBatchExhausted();
        },
        batchStatus: () => ({
          deadline: now + 900000,
          retry_at: reset,
          metadata_retry_at: reset,
          image_retry_at: null,
        }),
      },
    });
    assert.equal(partial.continuation.complete, false);
    fixture.catalog.ports.push({ id: "new", name: "New", project_url: "https://example.org/new" });
    let restored = 0;
    let admitted = 0;
    const resumed = await prepareArtworkWorkset(fixture.catalog, {
      ...options,
      selectedPortIds: ["scale-0", "new"],
      inspector: {
        restoreProviderBackoff(metadata) {
          restored = metadata;
        },
        inspectGame() {
          admitted++;
          assert.equal(restored, Date.parse(reset));
          throw new ArtworkBatchExhausted();
        },
      },
    });
    assert.equal(restored, Date.parse(reset));
    assert.equal(
      admitted,
      1,
      "previous ID remains durably deferred; new ID sees the restored provider clock",
    );
    assert.equal(resumed.continuation.complete, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("unavailable cover refresh retains its successful observation clock and remains due", async (t) => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-retained-clock-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = scalableArtworkFixture(1);
  const artwork = {
    game_id: 1,
    cover_id: 1,
    image_id: "scale0",
    image_sha256: "d".repeat(64),
    game_slug: "scale-0",
    match_kind: "port",
  };
  fixture.catalog.ports[0]!.presentation = { artwork };
  const started = Date.parse("2026-10-01T00:00:00Z");
  let now = started;
  const options = {
    root: scratch,
    identities: {},
    validatorIdentity: null,
    maintenance: true,
    dueCoverLimit: 1,
    now: () => now,
    inspector: fixture.inspector,
  };
  const state = () =>
    JSON.parse(
      readFileSync(join(scratch, "artwork-maintenance-progress-scale-0.json"), "utf8"),
    ) as { observed_at: string; last_live_observation_at: string | null };

  await prepareArtworkWorkset(fixture.catalog, options);
  assert.equal(state().last_live_observation_at, new Date(started).toISOString());
  now += 28 * 86400000;
  fixture.fail("Scale 0");
  const unavailable = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(unavailable.records[0]?.mapping, artwork);
  assert.deepEqual(unavailable.continuation.pending_port_ids, ["scale-0"]);
  assert.equal(state().observed_at, new Date(now).toISOString());
  assert.equal(state().last_live_observation_at, new Date(started).toISOString());

  now++;
  fixture.fail(null);
  const recovered = await prepareArtworkWorkset(fixture.catalog, options);
  assert.deepEqual(recovered.workset.selected_port_ids, ["scale-0"]);
  assert.equal(recovered.continuation.complete, true);
  assert.equal(state().last_live_observation_at, new Date(now).toISOString());
});

void test("memoized image reuse cannot refresh the original observation clock", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-memo-clock-"));
  const fixture = scalableArtworkFixture(2);
  const started = Date.parse("2026-10-01T00:00:00Z");
  let now = started;
  let downloads = 0;
  try {
    await prepareArtworkWorkset(fixture.catalog, {
      root: scratch,
      identities: {},
      validatorIdentity: null,
      selectedPortIds: ["scale-0", "scale-1"],
      now: () => now,
      onProgress() {
        now += 86400000;
      },
      inspector: {
        inspectGame(identity) {
          const index = Number(identity.names[0]!.split(" ")[1]);
          return [
            {
              id: index + 1,
              name: identity.names[0],
              slug: `scale-${index}`,
              websites: [{ url: identity.project_url }],
              cover: { id: index + 1, image_id: "shared" },
            },
          ];
        },
        inspectImage() {
          downloads++;
          return fixture.inspector.inspectImage();
        },
      },
    });
    const state = JSON.parse(
      readFileSync(join(scratch, "artwork-progress-scale-1.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(downloads, 1);
    assert.equal(state.last_live_observation_at, new Date(started).toISOString());
    assert.equal(state.observed_at, new Date(started + 86400000).toISOString());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("interrupted automatic maintenance assembles completed undelivered proposals on resume", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-due-interrupt-"));
  const fixture = scalableArtworkFixture(3);
  const options = {
    root: scratch,
    inspector: fixture.inspector,
    identities: {},
    validatorIdentity: null,
    maintenance: true,
  };
  try {
    await assert.rejects(
      prepareArtworkWorkset(fixture.catalog, {
        ...options,
        onProgress() {
          throw new Error("fixture interruption");
        },
      }),
      /fixture interruption/,
    );
    assert.equal(fixture.requests.length, 1);
    const resumed = await prepareArtworkWorkset(fixture.catalog, options);
    assert.equal(fixture.requests.length, 3);
    assert.equal(resumed.continuation.complete, true);
    assert.equal(resumed.records.length, 3);
    assert.deepEqual(resumed.workset.carried_port_ids, ["scale-0"]);
    assert.ok(resumed.catalog.ports.every((port) => port.presentation?.artwork));
    assert.ok(fixture.catalog.ports.every((port) => !port.presentation?.artwork));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("operations over a large workset keep a cover an earlier operation changed", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const { prepareCoverArtworkInOperations } = await import("./artwork-operations.mts");
  const fixture = await capturedArtworkRefresh({ status: 200, imageId: "fresh" });
  const retained = requiredFixture(fixture.accepted.ports[0]);
  for (let index = 0; index < 400; index++)
    fixture.accepted.ports.push({ ...structuredClone(retained), id: `later-${index}` });
  const input = structuredClone(fixture.accepted);
  const result = await prepareCoverArtworkInOperations(
    input,
    undefined,
    ["refresh-probe"],
    (ids, refresh, gone) =>
      prepareCatalogArtwork(input, {
        ...fixture.options,
        refreshPortIds: refresh,
        ...(ids ? { selectedPortIds: ids } : {}),
        ...(gone.length ? { knownGoneImageIds: gone } : {}),
      }),
  );
  const ports = new Map(result.catalog.ports.map((port) => [port.id, port]));
  assert.equal(ports.get("refresh-probe")?.presentation?.artwork?.image_id, "fresh");
  assert.ok(
    result.catalog.ports
      .filter((port) => port.id !== "refresh-probe")
      .every((port) => port.presentation?.artwork?.image_id === "coexisting"),
  );
  assert.equal(result.records.length, 401);
  assert.equal(new Set(result.records.map((record) => record.port_id)).size, 401);
  assert.equal(result.metrics.ports, 401);
  assert.equal(result.metrics.reused, 400);
});

void test("a Gone image found by a later operation withdraws an earlier operation's mapping", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const { prepareCoverArtworkInOperations } = await import("./artwork-operations.mts");
  const fixture = await capturedArtworkRefresh();
  const probe = requiredFixture(fixture.accepted.ports.shift());
  for (let index = 0; index < 420; index++)
    fixture.accepted.ports.push({ ...structuredClone(probe), id: `earlier-${index}` });
  fixture.accepted.ports.push(probe);
  const input = structuredClone(fixture.accepted);
  const result = await prepareCoverArtworkInOperations(
    input,
    undefined,
    ["refresh-probe"],
    (ids, refresh, gone) =>
      prepareCatalogArtwork(input, {
        ...fixture.options,
        refreshPortIds: refresh,
        ...(ids ? { selectedPortIds: ids } : {}),
        ...(gone.length ? { knownGoneImageIds: gone } : {}),
      }),
  );
  assert.ok(result.catalog.ports.every((port) => port.presentation?.artwork === undefined));
  assert.equal(result.records.length, 421);
  assert.equal(new Set(result.records.map((record) => record.port_id)).size, 421);
  assert.ok(result.records.every((record) => record.mapping === null));
  assert.equal(result.metrics.fallback, 421);
  assert.equal(result.metrics.reused, 0);
  assert.deepEqual(result.gone_image_ids, ["coexisting"]);
  assert.equal(result.workset.invalidated_port_ids.length, 420);
});

void test("explicit large worksets record outside ports an earlier operation's Gone withdrew", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const { prepareCoverArtworkInOperations } = await import("./artwork-operations.mts");
  const fixture = await capturedArtworkRefresh();
  const probe = requiredFixture(fixture.accepted.ports[0]);
  for (let index = 0; index < 420; index++)
    fixture.accepted.ports.push({ ...structuredClone(probe), id: `selected-${index}` });
  for (let index = 0; index < 5; index++)
    fixture.accepted.ports.push({ ...structuredClone(probe), id: `outside-${index}` });
  const input = structuredClone(fixture.accepted);
  const selected = input.ports.map((port) => port.id).filter((id) => !id.startsWith("outside-"));
  assert.equal(selected.length, 421);
  const result = await prepareCoverArtworkInOperations(
    input,
    selected,
    ["refresh-probe"],
    (ids, refresh, gone) =>
      prepareCatalogArtwork(input, {
        ...fixture.options,
        refreshPortIds: refresh,
        ...(ids ? { selectedPortIds: ids } : {}),
        ...(gone.length ? { knownGoneImageIds: gone } : {}),
      }),
  );
  // The first operation observes Gone and withdraws every reference, including
  // ports outside the workset; each withdrawal keeps its fallback record.
  assert.ok(result.catalog.ports.every((port) => port.presentation?.artwork === undefined));
  assert.equal(result.records.length, 426);
  assert.equal(new Set(result.records.map((record) => record.port_id)).size, 426);
  for (let index = 0; index < 5; index++)
    assert.ok(result.workset.invalidated_port_ids.includes(`outside-${index}`));
  assert.equal(result.workset.invalidated_port_ids.length, 425);
  assert.equal(result.metrics.ports, 426);
  assert.equal(result.metrics.fallback, 426);
});

void test("a Gone image found by a later media operation relabels an earlier operation's record", async () => {
  const { prepareGameMediaInOperations } = await import("./artwork-operations.mts");
  const ports = Array.from({ length: 401 }, (_, index) => ({
    id: `port-${index}`,
    name: `Port ${index}`,
  }));
  const subject = (id: string) => ({ kind: "port" as const, port_id: id });
  let calls = 0;
  const result = await prepareGameMediaInOperations(
    { ports },
    undefined,
    async (ids, catalog, gone) => {
      calls++;
      const first = ids![0]!;
      return {
        catalog,
        records: [
          calls === 1
            ? {
                port_id: first,
                role: "logo" as const,
                subject: subject(first),
                reason: "selected",
                image_id: "shared",
              }
            : {
                port_id: first,
                role: "logo" as const,
                subject: subject(first),
                reason: "image-gone",
              },
        ],
        gone_media_targets:
          calls === 1 ? [...gone] : [...new Set([...gone, "logo_med_2x/shared"])].sort(),
      };
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result.gone_media_targets, ["logo_med_2x/shared"]);
  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.find((record) => record.port_id === "port-0")?.reason,
    "selected-image-gone-later-in-batch",
  );
  assert.equal(
    result.records.find((record) => record.port_id === "port-400")?.reason,
    "image-gone",
  );
});

void test("operations over a large workset refuse unknown refresh and duplicate identities", async () => {
  const { prepareCoverArtworkInOperations } = await import("./artwork-operations.mts");
  const ports = Array.from({ length: 401 }, (_, index) => ({
    id: `port-${index}`,
    name: `Port ${index}`,
  }));
  const never = () => assert.fail("refused worksets must not run an operation");
  await assert.rejects(
    prepareCoverArtworkInOperations({ ports }, undefined, ["unknown-id"], never),
    /refresh names a port outside this workset/,
  );
  await assert.rejects(
    prepareCoverArtworkInOperations(
      { ports },
      [...ports.map((port) => port.id), "port-0"],
      [],
      never,
    ),
    /unique catalog port ids/,
  );
});

function reviewedCollectionFixture() {
  const covers = [1, 2].map((index) => ({
    game_id: index,
    cover_id: index,
    image_id: `member${index}`,
    image_sha256: index.toString(16).repeat(64),
    game_slug: `member-${index}`,
    match_kind: "underlying-game" as const,
  }));
  const catalog: ArtworkCatalog = {
    ports: [
      {
        id: "collection",
        name: "Collection",
        project_url: "https://example.org/collection",
        presentation: { collection_covers: covers },
      },
    ],
  };
  return { covers, catalog };
}

void test("reviewed collection reuse is offline and later Gone observations remove only exact members", async () => {
  const { prepareCatalogArtwork, reconcileCatalogArtworkWithdrawals } =
    await import("./inspect-igdb-artwork.mts");
  const { catalog, covers } = reviewedCollectionFixture();
  const prepared = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: catalog,
    inspectGame() {
      throw new Error("unnecessary metadata query");
    },
    inspectImage() {
      throw new Error("unnecessary image query");
    },
  });
  assert.deepEqual(prepared.records[0]?.collection, covers);
  assert.equal(prepared.metrics.fallback, 0);
  reconcileCatalogArtworkWithdrawals(prepared, [covers[0]!.image_id]);
  assert.deepEqual(prepared.records[0]?.collection, [covers[1]]);
  assert.deepEqual(prepared.catalog.ports[0]?.presentation?.collection_covers, [covers[1]]);
  reconcileCatalogArtworkWithdrawals(prepared, [covers[1]!.image_id]);
  assert.equal(prepared.catalog.ports[0]?.presentation?.collection_covers, undefined);
  assert.equal(prepared.records[0]?.collection, undefined);
  assert.equal(prepared.records[0]?.reason, "generated-fallback");
  assert.equal(prepared.metrics.fallback, 1);
  assert.equal(prepared.metrics.reused, 0);
  assert.deepEqual(catalog.ports[0]?.presentation?.collection_covers, covers);
  const changed = structuredClone(catalog);
  changed.ports[0]!.project_url = "https://example.org/other";
  const rejected = await prepareCatalogArtwork(changed, { acceptedCatalog: catalog });
  assert.equal(rejected.records[0]?.reason, "collection-mapping-review-required");
  assert.equal(rejected.catalog.ports[0]?.presentation?.collection_covers, undefined);
});

void test("collection refresh distinguishes a confirmed Gone image from an outage", async () => {
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256")
    .update(readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg")))
    .digest("hex");
  for (const status of [410, 503]) {
    const fixture = await capturedArtworkRefresh({ status });
    const first = {
      game_id: 101,
      cover_id: 202,
      image_id: "coexisting",
      image_sha256: "a".repeat(64),
      game_slug: "refresh-probe",
      match_kind: "port",
    };
    const second = {
      ...first,
      game_id: 102,
      cover_id: 203,
      image_id: "coother",
      image_sha256: digest,
      game_slug: "other",
    };
    fixture.accepted.ports[0]!.presentation = { collection_covers: [first, second] };
    const result = await fixture.run();
    const expected = status === 410 ? [second] : [first, second];
    assert.deepEqual(result.catalog.ports[0]?.presentation?.collection_covers, expected);
    assert.deepEqual(result.records[0]?.collection, expected);
    assert.deepEqual(result.gone_image_ids, status === 410 ? [first.image_id] : []);
    assert.equal(result.metrics.fallback, 0);
    const checks = result.records[0]?.checks;
    assert.ok(checks && "live_refresh_passed" in checks);
    assert.equal(checks.live_refresh_passed, status === 410);
  }
});

void test("collection checkpoints retain the refresh clock across ordinary reuse and expire normally", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const { catalog, covers } = reviewedCollectionFixture();
  const scratch = mkdtempSync(join(tmpdir(), "portcove-collection-clock-"));
  let now = Date.parse("2026-11-17T10:00:00Z");
  let requests = 0;
  const options = {
    root: scratch,
    acceptedCatalog: catalog,
    identities: {},
    validatorIdentity: null,
    selectedPortIds: ["collection"],
    now: () => now,
    inspector: {
      inspectImage(imageId: string) {
        requests++;
        const cover = covers.find((value) => value.image_id === imageId)!;
        return {
          sha256: cover.image_sha256,
          bytes: 100,
          width: 264,
          height: 352,
          format: "jpeg",
          validator: "portcove-core",
        };
      },
    },
  };
  try {
    await prepareArtworkWorkset(catalog, options);
    assert.equal(requests, 0);
    const first = await prepareArtworkWorkset(catalog, { ...options, maintenance: true });
    assert.equal(requests, 2);
    assert.equal(first.metrics.fallback, 0);
    await prepareArtworkWorkset(catalog, options);
    await prepareArtworkWorkset(catalog, { ...options, maintenance: true });
    assert.equal(requests, 2);
    now += 29 * 24 * 60 * 60 * 1000;
    await prepareArtworkWorkset(catalog, { ...options, maintenance: true });
    assert.equal(requests, 4);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("a sparse refresh withdraws matching collection members outside the selected workset", async () => {
  const fixture = await capturedArtworkRefresh();
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const first = {
    game_id: 101,
    cover_id: 202,
    image_id: "coexisting",
    image_sha256: "a".repeat(64),
    game_slug: "refresh-probe",
    match_kind: "port",
  };
  const second = {
    ...first,
    game_id: 102,
    cover_id: 203,
    image_id: "retainedmember",
    image_sha256: "b".repeat(64),
    game_slug: "other",
  };
  fixture.accepted.ports.push({
    id: "collection-other",
    name: "Other collection",
    project_url: "https://example.org/other",
    presentation: { collection_covers: [first, second] },
  });
  const result = await prepareCatalogArtwork(fixture.accepted, {
    ...fixture.options,
    selectedPortIds: ["refresh-probe"],
  });
  assert.deepEqual(result.catalog.ports[1]?.presentation?.collection_covers, [second]);
  assert.ok(result.workset.invalidated_port_ids.includes("collection-other"));
  assert.deepEqual(fixture.accepted.ports[1]?.presentation?.collection_covers, [first, second]);
});

void test("explicit cover review revalidates only the retained original even when the port has its own cover", async () => {
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-original-cover-review-"));
  try {
    const fixture = scalableArtworkFixture(2);
    const artwork = {
      game_id: 42,
      cover_id: 1,
      image_id: "acceptedimage",
      image_sha256: "d".repeat(64),
      game_slug: "original-game",
      match_kind: "underlying-game",
    };
    const port = requiredFixture(fixture.catalog.ports[0]);
    const original = {
      game_id: 42,
      slug: "original-game",
      names: ["Original Game"],
      evidence_url: "https://example.org/original",
    };
    port.presentation = { artwork };
    port.underlying_game = original;
    const requests: string[] = [];
    const result = await prepareArtworkWorkset(fixture.catalog, {
      root: scratch,
      validatorIdentity: null,
      identities: { "scale-0": { underlying_game: original } },
      selectedPortIds: ["scale-0"],
      refreshPortIds: ["scale-0"],
      revalidateAccepted: true,
      inspector: {
        inspectGame(identity) {
          requests.push(identity.kind);
          if (identity.kind === "port")
            return [
              {
                id: 1,
                name: "Scale 0",
                slug: "scale-0",
                websites: [{ url: port.project_url }],
                cover: { id: 3, image_id: "distinctportcover" },
              },
            ];
          assert.equal(identity.game_id, 42);
          assert.equal(identity.slug, "original-game");
          return [
            {
              id: 42,
              name: "Original Game",
              slug: "original-game",
              cover: { id: 2, image_id: "replacementimage" },
            },
          ];
        },
        inspectImage() {
          return fixture.inspector.inspectImage();
        },
      },
    });
    assert.deepEqual(requests, ["underlying-game"]);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.mapping?.image_id, "replacementimage");
    assert.equal(result.records[0]?.mapping?.match_kind, "underlying-game");
    assert.equal(result.continuation.complete, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
