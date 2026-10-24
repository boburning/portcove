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

import {
  requiredFixture,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
} from "./fixtures/catalog-generator-fixtures.mts";

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
