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

import {
  requiredFixture,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
  record as fixtureRecord,
  records as fixtureRecords,
} from "./fixtures/catalog-generator-fixtures.mts";

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
