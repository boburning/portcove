import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
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

function isolatedGenerator() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-generator-dispatch-"));
  mkdirSync(join(scratch, "scripts"));
  for (const name of ["generate-catalog.mjs", "inspect-igdb-artwork.mjs"])
    copyFileSync(join(root, "scripts", name), join(scratch, "scripts", name));
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(catalogs, { recursive: true });
  for (const name of ["catalog-current-authoring.json", "catalog-schema2-migration-fixture.json"])
    copyFileSync(join(catalogRoot, name), join(catalogs, name));
  return {
    catalogs,
    run: (...args) =>
      spawnSync(process.execPath, ["scripts/generate-catalog.mjs", ...args], {
        cwd: scratch,
        encoding: "utf8",
      }),
  };
}

test("semantic diff retains own fields colliding with Object.prototype", () => {
  const fixture = isolatedGenerator();
  const currentPath = join(fixture.catalogs, "catalog-current-authoring.json");
  const before = readFileSync(currentPath, "utf8");
  writeFileSync(join(fixture.catalogs, "catalog-schema2-migration-fixture.json"), before);
  const current = JSON.parse(before);
  for (const [key, value] of Object.entries(
    JSON.parse('{"__proto__":{},"constructor":{},"toString":{}}'),
  ))
    Object.defineProperty(current, key, { value, enumerable: true });
  writeFileSync(currentPath, JSON.stringify(current));
  const result = fixture.run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).differences, [
    { path: "$.__proto__", after: {} },
    { path: "$.constructor", after: {} },
    { path: "$.toString", after: {} },
  ]);
});

test("malformed generator mode arguments refuse before embedded catalog writes", () => {
  const fixture = isolatedGenerator();
  const embedded = join(fixture.catalogs, "catalog.json");
  const retained = "retained embedded catalog sentinel";
  writeFileSync(embedded, retained);
  for (const args of [
    ["--prepare-proposal=input.json", "--validator-cli", "cli", "--output-dir", "out"],
    ["--prepare-artwork=input.json"],
    ["--unexpected"],
    ["--check", "--unexpected"],
    ["--compare-historical", "--check"],
  ]) {
    const result = fixture.run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(readFileSync(embedded, "utf8"), retained);
  }
  const ordinary = fixture.run();
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(
    readFileSync(embedded, "utf8"),
    `${JSON.stringify(JSON.parse(readFileSync(join(fixture.catalogs, "catalog-current-authoring.json"))), null, 2)}\n`,
  );
});

test("full proposal preparation cannot combine with ordinary catalog writes or checks", () => {
  const result = run("--prepare-proposal", "unused.json", "--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot.*check|cannot.*combine/i);
  for (const flag of ["--apply", "--sign", "--publisher-grant", "--prepare-proposal"]) {
    const refused = run("--prepare-proposal", "unused.json", flag, "untrusted");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Unknown or repeated proposal option/);
  }
});

test("captured proposal bytes remain exact after the caller path changes", async () => {
  const { readArtworkInput } = await import("./inspect-igdb-artwork.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-proposal-bytes-"));
  const path = join(scratch, "input.json");
  const original = Buffer.from('{ "name": "é", "duplicate": 1, "duplicate": 2 }\n');
  writeFileSync(path, original);
  const captured = readArtworkInput(path);
  writeFileSync(path, '{"replacement":true}');
  assert.deepEqual(captured.bytes, original);
  assert.equal(captured.document.name, "é");
  assert.equal(captured.document.duplicate, 2);
  // Core receives the captured duplicate-key bytes, not JSON.stringify's loss.
  assert.match(captured.bytes.toString(), /"duplicate": 1, "duplicate": 2/);
});

test("full preparation requires an explicit validator and preserves prior output and authoring", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-proposal-refusal-"));
  const input = join(catalogRoot, "catalog-current-authoring.json");
  const before = readFileSync(input);
  const output = join(scratch, "output");
  const missing = run("--prepare-proposal", input, "--output-dir", output);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--validator-cli requires a value/);
  assert.equal(existsSync(output), false);
  mkdirSync(output);
  writeFileSync(join(output, "retained.txt"), "retained interruption evidence");
  const refused = run(
    "--prepare-proposal",
    input,
    "--validator-cli",
    join(scratch, "absent"),
    "--output-dir",
    output,
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /EEXIST/);
  assert.equal(
    readFileSync(join(output, "retained.txt"), "utf8"),
    "retained interruption evidence",
  );
  assert.deepEqual(readFileSync(input), before);
});

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

async function capturedArtworkRefresh({ status = 410, imageId = "coexisting", fault } = {}) {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mjs");
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
  const accepted = {
    ports: [
      {
        id: "refresh-probe",
        name: "Refresh Probe",
        project_url: "https://example.org/refresh-probe",
        presentation: { artwork: mapping },
      },
    ],
  };
  const games = [
    {
      id: 101,
      name: "Refresh Probe",
      slug: "refresh-probe",
      cover: { id: 202, image_id: imageId },
    },
  ];
  const requests = [];
  let decodes = 0;
  const inspector = createIgdbInspector(
    credentials,
    () => {
      decodes++;
      return { width: 12, height: 24, format: "jpeg", validator: "portcove-core" };
    },
    async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" }, { status: fault === "auth" ? 403 : 200 });
      if (url === "https://api.igdb.com/v4/games")
        return Response.json(
          games.filter((game) => options.body.includes(`id = ${game.id};`)),
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
  const options = {
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

test("a confirmed Gone response for the accepted image chooses generated fallback", async () => {
  const fixture = await capturedArtworkRefresh();
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  assert.equal(result.catalog.ports[0].presentation.artwork, undefined);
  assert.equal(result.records[0].reason, "generated-fallback");
  assert.deepEqual(result.records[0].exceptions[0], {
    kind: "port",
    reason: "image-gone",
    resume:
      "Correct the exact identity or asset fact, or retry after a confirmed provider/environment change.",
    image_id: "coexisting",
    http_status: 410,
  });
  assert.equal(result.records[0].mapping, null);
  assert.equal(result.metrics.fallback, 1);
  assert.equal(result.metrics.reused, 0);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.deepEqual(fixture.accepted, before);
  assert.equal(fixture.decodes(), 0);
});

for (const status of [404, 503, 429]) {
  test(`HTTP${status} retains permitted accepted artwork metadata`, async () => {
    const fixture = await capturedArtworkRefresh({ status });
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.deepEqual(result.catalog, before);
    assert.deepEqual(fixture.accepted, before);
    assert.equal(result.records[0].reason, "accepted-mapping-retained-after-unavailable-refresh");
    assert.equal(fixture.decodes(), 0);
  });
}

test("an unchanged accepted mapping makes no source-health claim or provider request", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.options.refreshPortIds = [];
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(result.records[0].reason, "accepted-mapping-reused");
  assert.equal(fixture.requests.length, 0);
});

test("Gone for a different candidate image cannot withdraw accepted artwork", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(fixture.decodes(), 0);
  assert.equal(result.records[0].reason, "accepted-mapping-retained-after-unavailable-refresh");
});

for (const fault of ["auth", "network", "identity-gone"]) {
  test(`${fault} failure does not establish Gone for an accepted image`, async () => {
    const fixture = await capturedArtworkRefresh({ fault });
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.ok(result.records[0].exceptions.every((item) => item.reason !== "image-gone"));
    assert.equal(fixture.decodes(), 0);
  });
}

test("unclassified status properties and another image's Gone error cannot withdraw metadata", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const unrelated = await fixture.inspector.inspectImage("codifferent").catch((error) => error);
  for (const error of [
    Object.assign(new Error("IGDB image is gone."), { status: 410, image_id: "coexisting" }),
    unrelated,
  ]) {
    fixture.games[0].cover.image_id = "coexisting";
    fixture.options.inspectImage = async () => {
      throw error;
    };
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.equal(result.records[0].exceptions[0].reason, "image-unavailable-or-invalid");
  }
});

for (const refreshedFirst of [true, false]) {
  test(`same-image accepted references fall back with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
    const fixture = await capturedArtworkRefresh();
    const reused = { ...structuredClone(fixture.accepted.ports[0]), id: "reused", name: "Reused" };
    fixture.accepted.ports = refreshedFirst
      ? [...fixture.accepted.ports, reused]
      : [reused, ...fixture.accepted.ports];
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.ok(result.catalog.ports.every((port) => !port.presentation.artwork));
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
  test(`accepted original-game reuse cannot restore Gone with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
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
    const refreshed = fixture.accepted.ports[0];
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

test("Gone for the port cover still permits a checked exact original-game replacement", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.games.push({
    id: 102,
    slug: "original",
    name: "Original",
    cover: { id: 203, image_id: "coreplacement" },
  });
  fixture.options.identities["refresh-probe"].underlying_game = {
    game_id: 102,
    slug: "original",
    names: ["Original"],
    evidence_url: "https://example.org/original",
  };
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  const bytes = readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg"));
  const { createHash } = await import("node:crypto");
  assert.equal(result.records[0].reason, "exact-original-game-cover");
  assert.equal(result.catalog.ports[0].presentation.artwork.image_id, "coreplacement");
  assert.equal(result.catalog.ports[0].presentation.artwork.match_kind, "underlying-game");
  assert.equal(
    result.catalog.ports[0].presentation.artwork.image_sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(result.records[0].exceptions[0].http_status, 410);
  assert.equal(result.records[0].checks.content.bytes, bytes.length);
  assert.equal(result.metrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 2);
  assert.equal(fixture.decodes(), 1);
  assert.deepEqual(fixture.accepted, before);
});

test("Gone observations still consume the existing finite image-request budget", async () => {
  const fixture = await capturedArtworkRefresh();
  for (let request = 0; request < 400; request++)
    await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image is gone/);
  await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image budget reached/);
  assert.equal(fixture.requests.length, 400);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 400);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.equal(fixture.decodes(), 0);
});

test("a successful HTTP image exceeding its remaining byte budget retains accepted metadata", async () => {
  const fixture = await capturedArtworkRefresh({ status: 200 });
  fixture.options.inspectImage = (imageId) => fixture.inspector.inspectImage(imageId, 1);
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(result.records[0].exceptions[0].reason, "image-unavailable-or-invalid");
  assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
  assert.equal(fixture.decodes(), 0);
});

const providerClockStart = Date.UTC(2026, 9, 3, 8);

async function flushProviderTimers(context) {
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(0);
  await new Promise((resolve) => setImmediate(resolve));
}

async function capturedMetadataBackoff(
  context,
  { status = 429, retryAfter = "2", responseDelay = 0 } = {},
) {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-backoff-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: providerClockStart });
  const calls = [];
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.signal.aborted, false);
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      calls.push(Date.now());
      if (calls.length === 1) context.mock.timers.tick(responseDelay);
      return Response.json([], {
        status: calls.length === 1 ? status : 200,
        headers: calls.length === 1 && retryAfter !== null ? { "Retry-After": retryAfter } : {},
      });
    },
  );
  const request = (id) =>
    inspector.inspectGame({
      game_id: id,
      slug: `probe-${id}`,
      names: [`Probe ${id}`],
      evidence_url: "https://example.org/probe",
    });
  const first = request(101).catch((error) => error);
  await flushProviderTimers(context);
  await first;
  return { inspector, calls, request };
}

for (const [status, retryAfter] of [
  [429, "2"],
  [503, "2"],
  [429, new Date(providerClockStart + 2000).toUTCString()],
  [503, "Saturday, 03-Oct-26 08:00:02 GMT"],
  [429, "Sat Oct  3 08:00:02 2026"],
]) {
  test(`metadata${status} honors Retry-After ${retryAfter}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { status, retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape at the ordinary300ms floor");
    context.mock.timers.tick(1699);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape before the full provider pause");
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2000]);
    assert.equal(fixture.inspector.providerMetrics.game_requests, 2);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

for (const retryAfter of [
  null,
  "invalid",
  "-1",
  "1.5",
  "0",
  "Tue, 31 Nov 2026 08:00:00 GMT",
  "Tuesday, 31-Nov-26 08:00:00 GMT",
  "Tue Nov 31 08:00:00 2026",
  "Saturday, 03-Oct-76 08:00:01 GMT",
  new Date(providerClockStart - 1000).toUTCString(),
]) {
  test(`unusable or elapsed Retry-After ${retryAfter} preserves the metadata rate floor`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(299);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

test("successful metadata ignores Retry-After and preserves ordinary pacing", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { status: 200, retryAfter: "900" });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
});

test("Retry-After seconds start when the unavailable response arrives", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { responseDelay: 500 });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(1999);
  await flushProviderTimers(context);
  assert.equal(fixture.calls.length, 1);
  context.mock.timers.tick(1);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2500]);
});

test("deadline expiry while a metadata wait resolves does not count or send a request", async (context) => {
  const fixture = await capturedMetadataBackoff(context);
  const next = fixture.request(102).catch((error) => error);
  await flushProviderTimers(context);
  context.mock.timers.tick(15 * 60 * 1000);
  await flushProviderTimers(context);
  assert.match((await next).message, /batch deadline/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
});

test("metadata pacing preserves the800request cap without repeated authentication", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { retryAfter: null });
  for (let request = 1; request < 799; request++) {
    const next = fixture.request(101 + request);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    await next;
  }
  const last = Promise.allSettled([fixture.request(900), fixture.request(901)]);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  const results = await last;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /metadata budget/,
  );
  await assert.rejects(fixture.request(901), /metadata budget/);
  assert.equal(fixture.calls.length, 800);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 800);
  assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
});

test("metadata backoff uses the existing batch cancellation signal", async (context) => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-cancel-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  let requests = 0;
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url) => {
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      requests++;
      return Response.json([], { status: 503, headers: { "Retry-After": "600" } });
    },
  );
  const identity = {
    game_id: 101,
    slug: "probe",
    names: ["Probe"],
    evidence_url: "https://example.org/probe",
  };
  await assert.rejects(inspector.inspectGame(identity), /identity request unavailable/);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let waitSignals = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds) => {
    if (milliseconds <= 15000) return timeout(milliseconds);
    waitSignals++;
    return controller.signal;
  });
  const pending = inspector.inspectGame(identity);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(waitSignals, 1);
  assert.equal(requests, 1);
  assert.equal(inspector.providerMetrics.game_requests, 1);
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
});

test("over-budget metadata backoff retains accepted mappings and leaves authoring input unchanged", async (context) => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mjs");
  const fixture = await capturedMetadataBackoff(context, { retryAfter: "900" });
  const accepted = {
    ports: [
      {
        id: "probe",
        name: "Probe",
        project_url: "https://example.org/probe",
        presentation: {
          artwork: {
            game_id: 101,
            cover_id: 202,
            image_id: "coexisting",
            image_sha256: "a".repeat(64),
            game_slug: "probe",
            match_kind: "port",
          },
        },
      },
    ],
  };
  const before = structuredClone(accepted);
  const result = await prepareCatalogArtwork(accepted, {
    ...fixture.inspector,
    acceptedCatalog: accepted,
    refreshPortIds: ["probe"],
    identities: {
      probe: {
        port: {
          game_id: 101,
          slug: "probe",
          names: ["Probe"],
          evidence_url: "https://example.org/probe",
        },
      },
    },
  });
  assert.deepEqual(result.catalog, accepted);
  assert.deepEqual(accepted, before);
  assert.equal(result.records[0].reason, "accepted-mapping-retained-after-unavailable-refresh");
  assert.equal(result.records[0].checks.live_refresh_passed, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 0);
});

for (const retryAfter of [
  "900",
  "901",
  "9".repeat(200),
  "9007199254740991",
  "Thursday, 01-Jan-60 08:00:00 GMT",
  "Saturday, 03-Oct-76 08:00:00 GMT",
  new Date(providerClockStart + 901000).toUTCString(),
]) {
  test(`Retry-After beyond the finite batch budget refuses another metadata request: ${retryAfter.slice(0, 40)}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102).then(
      () => assert.fail("over-budget pause cannot send"),
      (error) => error,
    );
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    assert.match((await next).message, /batch deadline/);
    assert.equal(Date.now(), providerClockStart + 300, "no unbounded sleep");
    assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

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
