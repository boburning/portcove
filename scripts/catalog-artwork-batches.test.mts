import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ArtworkCatalog, ArtworkPreparationOptions } from "./inspect-igdb-artwork.mts";

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
    fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8")),
  );
  const input = structuredClone(accepted);
  requiredFixture(requiredFixture(input.ports[0]).release).version = "ordinary-successor";
  const result = await prepareCatalogArtwork(input, {
    acceptedCatalog: accepted,
    inspectGame: () => assert.fail("unchanged accepted artwork must not search"),
    inspectImage: () => assert.fail("unchanged accepted artwork must not download"),
  });
  const mapped = accepted.ports.filter((port) => port.presentation?.artwork);
  const unmapped = accepted.ports.filter((port) => !port.presentation?.artwork);
  assert.equal(result.metrics.reused, mapped.length);
  assert.equal(result.metrics.fallback, unmapped.length);
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
    fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8")),
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
    "image-unavailable-or-invalid",
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
