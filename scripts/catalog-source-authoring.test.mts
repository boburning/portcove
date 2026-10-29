import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  authoringRecordFromPort,
  readCatalogSource,
  assembleCatalogRecords,
  checkedAuthoredPort,
  parseCatalogSource,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { estimateHealthRequests } from "./check-catalog-repositories.mts";

import {
  requiredFixture,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
  record as fixtureRecord,
  records as fixtureRecords,
} from "./fixtures/catalog-generator-fixtures.mts";

void test("current authored operational routes remain valid read-only health inventory inputs", () => {
  // Core-readable prepared routes still need canonical explicit repository
  // names. Validate the whole authored inventory without fetching or waiting
  // for the slower command/report fixture; this does not assess live health.
  assert.doesNotThrow(() => estimateHealthRequests(readCatalogSource(catalogRoot).catalog));
});

void test("shared upstream family facts stay consistent while game and permission facts remain independent", () => {
  const source = readCatalogSource(catalogRoot);
  const razeUrl = "https://github.com/ZDoom/Raze";
  const namcoUrl = "https://github.com/spacestate1/namco22-decompile";
  const families = source.records.filter((entry) =>
    [razeUrl, namcoUrl].includes(entry.listing.project_url),
  );
  const check = (records: readonly AuthoredPort[]) => {
    for (const [url, count] of [
      [razeUrl, 7],
      [namcoUrl, 5],
    ] as const) {
      const family = records.filter((entry) => entry.listing.project_url === url);
      assert.equal(family.length, count, `Retain the reviewed independent identities for ${url}`);
      const first = requiredFixture(family[0]).listing;
      for (const { listing } of family) {
        for (const field of ["platforms", "availability", "setup_url", "release_url"] as const)
          assert.deepEqual(listing[field], first[field], `${listing.id}: shared ${field}`);
        if (url === razeUrl) {
          for (const field of ["download_asset_hints", "recommended_download_channel"] as const)
            assert.deepEqual(listing[field], first[field], `${listing.id}: shared ${field}`);
          const steps = fixtureRecords(fixtureRecord(listing.manual_setup).steps);
          const expected = fixtureRecords(fixtureRecord(first.manual_setup).steps);
          assert.equal(steps.length, 4);
          assert.deepEqual(
            steps.slice(2),
            expected.slice(2),
            `${listing.id}: shared profile and update ownership`,
          );
        }
      }
    }
  };
  check(families);
  for (const field of [
    "platforms",
    "availability",
    "setup_url",
    "release_url",
    "download_asset_hints",
    "recommended_download_channel",
    "profile",
  ] as const) {
    const changed = structuredClone(families);
    const listing = requiredFixture(
      changed.find((entry) => entry.listing.project_url === razeUrl),
    ).listing;
    if (field === "platforms") listing.platforms = ["windows-x86-64"];
    else if (field === "availability") listing.availability = "unavailable";
    else if (field === "download_asset_hints") listing.download_asset_hints = {};
    else if (field === "recommended_download_channel")
      listing.recommended_download_channel = "beta";
    else if (field === "profile")
      requiredFixture(fixtureRecords(fixtureRecord(listing.manual_setup).steps)[2]).instruction =
        "Wrong profile.";
    else listing[field] = "https://example.invalid/unrelated";
    assert.throws(() => check(changed), /shared/, field);
  }
  const independent = structuredClone(families);
  for (const { listing } of independent) {
    listing.name += listing.id;
    listing.issue_number = (listing.issue_number ?? 1) + 10000;
    listing.download_block_reason = `An independently reviewed condition for ${listing.id}.`;
    const steps = fixtureRecords(fixtureRecord(listing.manual_setup).steps);
    requiredFixture(steps[0]).instruction = `Original-file requirements for ${listing.id}.`;
  }
  check(independent);
});

void test("per-port source projects all accepted operations unchanged and listing-only records stay inert", () => {
  const source = readCatalogSource(catalogRoot);
  const accepted = fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json")));
  assert.deepEqual(source.catalog, accepted);
  const listing = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "source-only-fixture",
      name: "Source-only fixture",
      summary: "An identified upstream project.",
      project_url: "https://example.org/source-only",
      availability: "source-only",
    },
  });
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const projected = assembleCatalogRecords(shared, [...source.records, listing]);
  assert.deepEqual(projected.catalog, source.catalog);
  assert.equal(projected.directory.listings.length, source.directory.listings.length + 1);
  assert.deepEqual(
    projected.directory.listings.find((port) => port.id === listing.listing.id)?.platforms,
    [],
  );
  assert.throws(
    () => assembleCatalogRecords(shared, [listing, listing]),
    /duplicate stable listing IDs/,
  );
  assert.throws(() => checkedAuthoredPort(listing, "wrong-file"), /filename and stable listing ID/);
  assert.throws(
    () => checkedAuthoredPort({ ...listing, integration: { id: listing.listing.id } }),
    /second integration authority/,
  );
});

void test("authored JSON refuses duplicate decoded keys while retaining nested data and native grammar", () => {
  assert.throws(() => parseCatalogSource('{"id":"first","id":"second"}'), /duplicate JSON key/);
  assert.throws(
    () => parseCatalogSource('{"id":"first","\\u0069d":"second"}'),
    /duplicate JSON key/,
  );
  assert.throws(() => parseCatalogSource('{"nested":[{"x":1,"x":2}]}'), /duplicate JSON key/);
  assert.throws(() => parseCatalogSource('{"id":"first",}'), SyntaxError);
  const valid =
    '{"nested":[{"id":"first"},{"id":"second"}],"literal":"{\\\"id\\\":\\\"a\\\"}","__proto__":{"id":"own"}}';
  assert.deepEqual(parseCatalogSource(valid), JSON.parse(valid));
});

void test("download restrictions project through the versioned directory without managed authority", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "restricted-fixture",
      name: "Restricted fixture",
      summary: "An upstream project.",
      project_url: "https://example.org/project",
      download_block_reason: "Resolve the exact upstream permission.",
    },
  });
  const projection = assembleCatalogRecords(shared, [record]);
  assert.equal(projection.directory.format_version, 2);
  assert.equal(
    projection.directory.listings[0]?.download_block_reason,
    record.listing.download_block_reason,
  );
  assert.equal(projection.catalog.ports.length, 0);
  assert.throws(
    () => checkedAuthoredPort({ ...record, integration: { adapter: "native-portable" } }),
    /download restriction cannot coexist with a managed integration/,
  );
  const legacy = structuredClone(record);
  delete legacy.listing.download_block_reason;
  assert.equal(assembleCatalogRecords(shared, [legacy]).directory.format_version, 1);
  for (const reason of ["", " trailing ", "line\nbreak", "x".repeat(4097), { allowed: true }]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          ...record,
          listing: { ...record.listing, download_block_reason: reason },
        }),
      /download restriction/,
    );
  }
  assert.ok(source.records.length > 0);
});

void test("authoring split preserves unknown metadata and ordered operational arrays", () => {
  const original = fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json")));
  const catalog = fixtureCatalog(original);
  const port = structuredClone(requiredFixture(catalog.ports[0]));
  port.unfamiliar_metadata = { retained: ["second", "first"] };
  port.launch_arguments = ["--second", "--first"];
  const authored = authoringRecordFromPort(port, 0);
  const shared: Record<string, unknown> = { ...catalog };
  delete shared.ports;
  const projected = assembleCatalogRecords(shared, [authored]);
  assert.deepEqual(projected.catalog.ports[0], port);
  assert.equal(Object.hasOwn(authored.integration ?? {}, "name"), false);
  assert.equal(Object.hasOwn(authored.integration?.presentation ?? {}, "artwork"), false);
});

void test("listing download hints remain advisory and reject ambiguous authoring shapes", () => {
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const listing = {
    id: "setup-fixture",
    name: "Setup fixture",
    summary: "An upstream setup handoff.",
    project_url: "https://example.org/game",
    download_asset_hints: { "windows-x86-64": ["-Windows_Installer.exe"] },
    recommended_download_channel: "beta",
  };
  const record = checkedAuthoredPort({ format_version: 1, listing });
  const projection = assembleCatalogRecords(shared, [record]);
  assert.deepEqual(
    projection.directory.listings[0]?.download_asset_hints,
    listing.download_asset_hints,
  );
  assert.equal(projection.catalog.ports.length, 0);
  assert.equal(projection.directory.listings[0]?.recommended_download_channel, "beta");
  for (const channel of ["rolling", "nightly", 1, null]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          format_version: 1,
          listing: { ...listing, recommended_download_channel: channel },
        }),
      /recommended download channel/,
    );
  }
  for (const hints of [
    [],
    { unknown: ["game.zip"] },
    { "windows-x86-64": [] },
    { "windows-x86-64": ["same", "SAME"] },
    { "windows-x86-64": [" trailing "] },
    { "windows-x86-64": ["bad\nname"] },
    { "windows-x86-64": ["x".repeat(161)] },
  ]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          format_version: 1,
          listing: { ...listing, download_asset_hints: hints },
        }),
      /download asset hints/,
    );
  }
});

void test("original game identity projects exact authored groups and multiple source editions without operational authority", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const original_game = {
    format_version: 1,
    id: "example-game",
    evidence_urls: ["https://example.com/game"],
    source_editions: [
      {
        id: "example-console",
        title: "Console edition",
        system: "nintendo-64",
        evidence_urls: ["https://example.com/console"],
      },
      {
        id: "example-computer",
        title: "Computer edition",
        system: "pc",
        evidence_urls: ["https://example.com/computer"],
      },
    ],
  };
  const base = {
    format_version: 1,
    listing: {
      id: "edition-fixture",
      name: "Example port",
      summary: "Descriptive metadata only.",
      project_url: "https://example.com/port",
      original_game,
    },
  };
  const record = checkedAuthoredPort(base);
  const projected = assembleCatalogRecords(shared, [...source.records, record]);
  assert.equal(projected.directory.format_version, 3);
  assert.deepEqual(projected.catalog, source.catalog);
  assert.deepEqual(
    projected.directory.listings.find((value) => value.id === "edition-fixture")?.original_game,
    original_game,
  );
  const integrated = source.records.find((value) => value.integration)!;
  const withMetadata = checkedAuthoredPort({
    ...integrated,
    listing: { ...integrated.listing, original_game },
  });
  const assembled = assembleCatalogRecords(shared, [withMetadata]);
  assert.deepEqual(assembled.catalog.ports[0]?.presentation?.original_game, original_game);
  assert.deepEqual(
    authoringRecordFromPort(assembled.catalog.ports[0]).listing.original_game,
    original_game,
  );
  for (const invalid of [
    { ...original_game, format_version: 2 },
    { ...original_game, id: "Ambiguous title" },
    { ...original_game, evidence_urls: [] },
    { ...original_game, evidence_urls: ["http://example.com/source"] },
    {
      ...original_game,
      source_editions: [original_game.source_editions[0], original_game.source_editions[0]],
    },
    {
      ...original_game,
      source_editions: [{ ...original_game.source_editions[0], system: "Nintendo 64" }],
    },
    { ...original_game, unexpected: true },
  ])
    assert.throws(() =>
      checkedAuthoredPort({ ...base, listing: { ...base.listing, original_game: invalid } }),
    );
  assert.doesNotThrow(() =>
    checkedAuthoredPort({
      ...base,
      listing: { ...base.listing, original_game: { ...original_game, source_editions: [] } },
    }),
  );
});

void test("descriptive media projects to format 3 and explicit empty strict media remains a removal", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const media = [
    {
      id: "upstream-screenshot",
      role: "screenshot",
      subject: { kind: "port", port_id: "media-fixture" },
      caption: "A synthetic screenshot fixture.",
      url: "https://raw.githubusercontent.com/example/media/" + "a".repeat(40) + "/screen.png",
      sha256: "b".repeat(64),
      width: 640,
      height: 480,
      attribution: "Fixture author",
      source_url: "https://example.com/media",
      license: "CC0-1.0",
      rights_url: "https://example.com/rights",
    },
  ];
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "media-fixture",
      name: "Media fixture",
      summary: "No managed integration.",
      project_url: "https://example.com/port",
      media,
    },
  });
  const projected = assembleCatalogRecords(shared, [record]);
  assert.equal(projected.directory.format_version, 3);
  assert.deepEqual(projected.directory.listings[0]?.media, media);
  assert.equal(projected.catalog.ports.length, 0);
  const integrated = source.records.find((value) => value.integration)!;
  const removal = checkedAuthoredPort({
    ...integrated,
    listing: { ...integrated.listing, media: [] },
  });
  const removed = assembleCatalogRecords(shared, [removal]);
  assert.deepEqual(removed.catalog.ports[0]?.presentation?.media, []);
  assert.deepEqual(authoringRecordFromPort(removed.catalog.ports[0]).listing.media, []);
});

void test("optional recommendation observations round-trip as inert presentation without changing the operational route", () => {
  const source = readCatalogSource(catalogRoot);
  const original = source.catalog.ports.find((port) => port.id === "fragglet-sdl-sopwith")!;
  for (const optional of [
    { format_version: 1, observations: [], capabilities: [] },
    { format_version: 999, future_observations: ["preserve without interpretation"] },
    { malformed: "optional interpretation must fail without hiding the ordinary project" },
  ]) {
    const port = structuredClone(original);
    port.presentation = { ...fixtureRecord(port.presentation), recommendation: optional };
    const record = authoringRecordFromPort(port);
    const assembled = assembleCatalogRecords(
      fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json"))),
      [record],
    );
    assert.deepEqual(assembled.catalog.ports[0], port);
    assert.deepEqual(assembled.catalog.ports[0]!.release, original.release);
    assert.deepEqual(assembled.catalog.ports[0]!.adapter, original.adapter);
  }
});
