import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  legacyDownloadProjection,
  managedHoldFromRestrictions,
} from "./catalog-acquisition-restrictions.mts";
import type { AcquisitionRestriction } from "./catalog-acquisition-restrictions.mts";
import {
  migrateCatalogSource,
  migrateRecord,
  reasonTable,
} from "./migrate-acquisition-restrictions.mts";
import { isRecord } from "./runtime-values.mts";

const catalogRoot = fileURLToPath(new URL("../crates/portcove-core/catalog/", import.meta.url));
const portsRoot = join(catalogRoot, "ports");
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function authored(id: string) {
  const record = json(join(portsRoot, `${id}.json`));
  assert.ok(isRecord(record) && isRecord(record.listing));
  return record as Record<string, unknown> & { listing: Record<string, unknown> };
}

/** The untyped record this migration consumed, rebuilt from the typed one. */
function legacyOf(id: string, record: Record<string, unknown>) {
  const listing = record.listing as Record<string, unknown>;
  const rebuilt = JSON.parse(
    JSON.stringify(record, (key, value: unknown) => {
      if (key === "restrictions" && Array.isArray(value)) return undefined;
      if (key === "acquisition_restrictions") return undefined;
      return value;
    }),
  ) as Record<string, unknown> & { listing: Record<string, unknown> };
  const typed = listing.restrictions as AcquisitionRestriction[] | undefined;
  if (typed) {
    const entries: [string, unknown][] = Object.entries(listing).map(([key, value]) =>
      key === "restrictions"
        ? ["download_block_reason", legacyDownloadProjection(typed)]
        : [key, value],
    );
    rebuilt.listing = Object.fromEntries(entries);
  }
  const integration = record.integration as Record<string, unknown> | undefined;
  if (integration?.acquisition_restrictions) {
    rebuilt.integration = Object.fromEntries(
      Object.entries(integration).map(([key, value]) =>
        key === "acquisition_restrictions"
          ? ["managed_acquisition_hold", managedHoldFromRestrictions(id, value as never)]
          : [key, value],
      ),
    );
  }
  return rebuilt;
}

void test("listing rows become one whole download hold with verbatim copy", () => {
  const id = "abuse-abuse-2025";
  const legacy = legacyOf(id, authored(id));
  const explanation = legacy.listing.download_block_reason;
  assert.equal(typeof explanation, "string");
  const migrated = migrateRecord(id, legacy);
  assert.deepEqual(migrated.record, authored(id));
  const typedListing = migrated.record.listing;
  assert.ok(isRecord(typedListing));
  assert.deepEqual(typedListing.restrictions, [
    {
      id: "download",
      effect: "hold",
      operations: ["download"],
      reason: "bundled-game-data",
      explanation,
      tracking_issue: 2913,
    },
  ]);
  // Idempotent: a typed record is returned unchanged.
  const again = migrateRecord(id, migrated.record);
  assert.equal(again.listing || again.integration, false);
  assert.deepEqual(again.record, migrated.record);
});

void test("the migration refuses rows it was not reviewed for and unexpected shapes", () => {
  const legacy = legacyOf("abuse-abuse-2025", authored("abuse-abuse-2025"));
  assert.throws(
    () => migrateRecord("not-reviewed", legacy),
    /missing from the reviewed reason table/,
  );
  const malformed = structuredClone(legacy);
  malformed.listing.download_block_reason = { reason: "x" };
  assert.throws(() => migrateRecord("abuse-abuse-2025", malformed), /unexpected listing/);
  const both = structuredClone(legacy);
  both.listing.restrictions = [];
  assert.throws(() => migrateRecord("abuse-abuse-2025", both), /unexpected listing/);
  const managed = legacyOf("super-metroid-recomp", authored("super-metroid-recomp"));
  assert.throws(
    () => migrateRecord("open-nectar-pikmin", managed),
    /disagrees with the reviewed reason table/,
  );
  assert.throws(() => migrateRecord("abuse-abuse-2025", managed), /reviewed reason table/);
});

void test("every reviewed row is typed and projects to its generated legacy bytes", () => {
  const listings = json(join(catalogRoot, "listings.json")) as {
    format_version: number;
    listings: Record<string, unknown>[];
  };
  const catalog = json(join(catalogRoot, "catalog.json")) as { ports: Record<string, unknown>[] };
  assert.equal(listings.format_version, 15);
  let listingRows = 0;
  let managedRows = 0;
  for (const file of readdirSync(portsRoot).sort()) {
    const id = file.slice(0, -5);
    const record = authored(id);
    const source = readFileSync(join(portsRoot, file), "utf8");
    assert.ok(!source.includes('"download_block_reason"'), id);
    assert.ok(!source.includes('"managed_acquisition_hold"'), id);
    const typed = record.listing.restrictions as AcquisitionRestriction[] | undefined;
    const integration = record.integration as Record<string, unknown> | undefined;
    const managed = integration?.acquisition_restrictions as AcquisitionRestriction[] | undefined;
    if (!typed && !managed) {
      assert.ok(!reasonTable.has(id), id);
      continue;
    }
    // Re-running the deterministic migration on the legacy form reproduces the file.
    assert.deepEqual(migrateRecord(id, legacyOf(id, record)).record, record, id);
    if (typed) {
      listingRows++;
      const row = listings.listings.find((listing) => listing.id === id);
      assert.equal(row?.download_block_reason, legacyDownloadProjection(typed), id);
      assert.deepEqual(row?.restrictions, typed, id);
    }
    if (managed) {
      managedRows++;
      const port = catalog.ports.find((candidate) => candidate.id === id);
      assert.deepEqual(
        port?.managed_acquisition_hold,
        managedHoldFromRestrictions(id, managed),
        id,
      );
      assert.ok(!Object.hasOwn(port ?? {}, "acquisition_restrictions"), id);
    }
  }
  assert.equal(listingRows, 152);
  assert.equal(managedRows, 5);
  assert.equal(reasonTable.size, 157);
  assert.deepEqual(migrateCatalogSource(portsRoot, false), {
    listing: 0,
    integration: 0,
    alreadyTyped: 157,
    files: 0,
  });
});
