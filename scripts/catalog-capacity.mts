/** Offline capacity diagnostics only. No signature, provider read or admission. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { compactListingCarrier, listingDeliveryMaximum } from "./listing-directory-carrier.mts";
import { isRecord } from "./runtime-values.mts";

export function capacityConstant(source: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...source.matchAll(new RegExp(`const ${escaped}: (?:usize|u64|i64) = ([0-9_ *]+);`, "gu")),
  ];
  if (matches.length !== 1) throw new Error(`Capacity authority missing or ambiguous: ${name}`);
  const parts = matches[0]![1]!.split("*").map((part) => Number(part.trim().replaceAll("_", "")));
  const value = parts.reduce((product, part) => product * part, 1);
  if (
    parts.some((part) => !Number.isSafeInteger(part) || part <= 0) ||
    !Number.isSafeInteger(value)
  )
    throw new Error(`Invalid bounded capacity authority: ${name}`);
  return value;
}

function boundedInput(filename: string, limit: number) {
  const entry = lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit)
    throw new Error("Capacity input must be a bounded regular catalog file");
  const fd = openSync(filename, "r");
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.size > limit
    )
      throw new Error("Capacity input identity changed");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (length > before.size) throw new Error("Capacity input grew while being read");
      if (!count) break;
    }
    const after = fstatSync(fd);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Capacity input changed while being read");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function catalogCapacity(catalog: unknown, limit: number, issuedAt: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(issuedAt + 86400) ||
    issuedAt < 0
  )
    throw new Error("Capacity diagnostics require finite safe byte and clock inputs");
  if (!isRecord(catalog) || !Array.isArray(catalog.ports))
    throw new Error("Capacity diagnostics require unique declared port identities");
  const ports: unknown[] = catalog.ports;
  const ids = ports.map((port) => {
    if (!isRecord(port) || typeof port.id !== "string")
      throw new Error("Capacity diagnostics require unique declared port identities");
    return port.id;
  });
  if (new Set(ids).size !== ports.length)
    throw new Error("Capacity diagnostics require unique declared port identities");
  const compact = JSON.stringify(catalog);
  const envelopeBytes = (document: unknown) =>
    Buffer.byteLength(
      JSON.stringify({
        format_version: 1,
        key_id: "0".repeat(64),
        payload: JSON.stringify({
          sequence: Number.MAX_SAFE_INTEGER,
          issued_at: issuedAt,
          expires_at: issuedAt + 86400,
          catalog: document,
        }),
        signature: "0".repeat(128),
      }),
    );
  const envelope = envelopeBytes(catalog);
  const shared = envelopeBytes({ ...catalog, ports: [] });
  const portBytes = envelope - shared;
  const average = ports.length ? portBytes / ports.length : null;
  return {
    format: 1,
    authority: "offline-capacity-diagnostic-only",
    catalog_ports: ports.length,
    compact_catalog_bytes: Buffer.byteLength(compact),
    representative_envelope_bytes: envelope,
    envelope_limit_bytes: limit,
    envelope_remaining_bytes: Math.max(0, limit - envelope),
    fits_representative_envelope: envelope <= limit,
    shared_envelope_bytes_with_no_ports: shared,
    average_escaped_port_bytes: average,
    modeled_additional_ports: average
      ? Math.max(0, Math.floor((limit - envelope) / average))
      : null,
    model_assumptions:
      "Current average escaped per-port metadata and fixed shared source data; not a capacity guarantee for future identities or a semantically validated catalog.",
    representative_payload: {
      sequence: Number.MAX_SAFE_INTEGER,
      issued_at: issuedAt,
      expires_at: issuedAt + 86400,
    },
    signature_status: "not-created; fixed-width placeholder counted only",
    catalog_validation: "not-performed; use the existing Core proposal inspector",
    live_cache_occupancy: "Unknown",
    actual_provider_traffic: "Unknown",
    process_memory: "Unknown; serialized byte sizes are not heap/RSS measurements",
  };
}

export interface CatalogSizeBounds {
  /** Current signed-catalog, catalog-read and signer-input bound. */
  current: number;
  /** Published catalogs stay at or below this share of each guarded bound. */
  percent: number;
}

export function catalogSizeBounds(signedCatalogSource: string): CatalogSizeBounds {
  const bounds = {
    current: capacityConstant(signedCatalogSource, "MAX_CATALOG_BYTES"),
    percent: capacityConstant(signedCatalogSource, "CATALOG_SUPPORTED_CAPACITY_PERCENT"),
  };
  if (bounds.percent >= 100) throw new Error("Invalid catalog size guard bounds");
  return bounds;
}

/** One guarded measure: name, measured value, the consumer's bound and its basis. */
export type CapacityMeasure = readonly [name: string, value: number, bound: number, basis: string];

/** Bounds a released compact listing reader enforces, read from the carrier crate. */
export interface ListingDeliveryBounds {
  /** Authenticated target body, either carrier. */
  wire: number;
  /** Decoded compact directory. */
  decoded: number;
  /** One compact listing record. */
  record: number;
  /** Records and withdrawals; enforced by released readers only. */
  entries: number;
  /** Authored directory text the current Core inspects. */
  text: number;
  /** Canonical `listings.json` read by the listing publisher. */
  publisherText: number;
  /** Current generation's per-admission element budget and charges. */
  elementBudget: number;
  listingCharge: number;
  withdrawalCharge: number;
}

export function listingDeliveryBounds(
  carrierSource: string,
  listingsSource: string,
  deliverySource: string,
) {
  return {
    wire: capacityConstant(carrierSource, "MAX_BYTES"),
    decoded: capacityConstant(carrierSource, "MAX_COMPACT_DECODED_BYTES"),
    record: capacityConstant(carrierSource, "MAX_COMPACT_RECORD_BYTES"),
    entries: capacityConstant(carrierSource, "MAX_LISTING_ENTRIES"),
    text: capacityConstant(listingsSource, "MAX_LISTING_DIRECTORY_TEXT_BYTES"),
    publisherText: listingDeliveryMaximum,
    elementBudget: capacityConstant(deliverySource, "ELEMENT_WORKING_BUDGET"),
    listingCharge: capacityConstant(deliverySource, "LISTING_WORKING_BYTES"),
    withdrawalCharge: capacityConstant(deliverySource, "WITHDRAWAL_WORKING_BYTES"),
  } satisfies ListingDeliveryBounds;
}

/**
 * Mirror of `portcove_listing_carrier::legacy_row_projection`: the format-11
 * row a legacy reader receives. Core's tests prove the Rust projection equals
 * Core's format-11 export.
 */
export function legacyRowProjection(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const projected: Record<string, unknown> = structuredClone(row);
  for (const field of ["restrictions", "implementation", "upstream_observation"])
    delete projected[field];
  if (Array.isArray(projected.media)) {
    const media = projected.media.filter(
      (asset: unknown) =>
        !(
          isRecord(asset) &&
          asset.igdb !== undefined &&
          asset.igdb !== null &&
          (asset.role === "header" || asset.role === "screenshot")
        ),
    );
    if (media.length) projected.media = media;
    else delete projected.media;
  }
  const game = projected.original_game;
  if (isRecord(game) && Array.isArray(game.source_editions))
    for (const edition of game.source_editions)
      if (isRecord(edition)) delete edition.verified_sources;
  return projected;
}

/** Signed upstream observations by listing id, read from a delivered listing
 * target (legacy JSON or a decoded compact directory). */
export function signedObservations(target: unknown) {
  const directory = isRecord(target) ? target.directory : undefined;
  const rows = isRecord(directory) && Array.isArray(directory.listings) ? directory.listings : [];
  return new Map(
    rows.flatMap((row: unknown) =>
      isRecord(row) && typeof row.id === "string" && row.upstream_observation !== undefined
        ? [[row.id, row.upstream_observation] as const]
        : [],
    ),
  );
}

/**
 * The listing directory against every consumer that can stop its delivery:
 * Core's inspection of the authored text, the listing publisher's canonical
 * read, the legacy target (still the only live carrier) and the compact
 * carrier bounds released readers enforce, which the publisher honors until
 * they are no longer supported. Without `observations` the carrier rows omit
 * observer enrichment and are lower bounds; pass the observations of a signed
 * target to measure the real carriers.
 */
export function listingDirectoryMeasures(
  text: Buffer,
  bounds: ListingDeliveryBounds,
  observations?: ReadonlyMap<string, unknown>,
): CapacityMeasure[] {
  const directory: unknown = JSON.parse(text.toString("utf8"));
  if (!isRecord(directory) || !Array.isArray(directory.listings))
    throw new Error("Capacity diagnostics require a listing directory");
  const listings: unknown[] = directory.listings.map((row: unknown) =>
    observations && isRecord(row) && typeof row.id === "string" && observations.has(row.id)
      ? { ...row, upstream_observation: observations.get(row.id) }
      : row,
  );
  const scope = observations ? "with signed observations" : "without observations";
  const delivery = (document: unknown) =>
    Buffer.from(
      JSON.stringify({
        listing_delivery_schema: 1,
        revision: Number.MAX_SAFE_INTEGER,
        withdrawn_ids: [],
        directory: document,
      }),
    );
  const decoded = delivery({ ...directory, listings });
  // The legacy target carries observations beside format-11 rows.
  const legacy = delivery({
    format_version: 11,
    listings: listings.map((row) => {
      const projected = legacyRowProjection(row);
      return isRecord(row) && row.upstream_observation !== undefined && isRecord(projected)
        ? { ...projected, upstream_observation: row.upstream_observation }
        : projected;
    }),
  });
  const compressed = gzipSync(decoded);
  const carrier = Buffer.byteLength(
    JSON.stringify({
      carrier: compactListingCarrier,
      decoded_bytes: decoded.length,
      decoded_sha256: "0".repeat(64),
      gzip_base64: compressed.toString("base64"),
    }),
  );
  const largestRecord = Math.max(
    0,
    ...listings.map((row) => Buffer.byteLength(JSON.stringify(row))),
  );
  return [
    ["generated listings.json bytes", text.length, bounds.text, "Core listing inspection bound"],
    [
      "canonical listings.json read by listing-observation-delivery",
      text.length,
      bounds.publisherText,
      "listing publisher canonical read bound",
    ],
    [
      `complete legacy listing target bytes (${scope})`,
      legacy.length,
      bounds.wire,
      "released legacy target bound",
    ],
    [
      `compact listing directory decoded bytes (${scope})`,
      decoded.length,
      bounds.decoded,
      "released compact reader decoded bound",
    ],
    [
      `compact listing carrier bytes (${scope})`,
      carrier,
      bounds.wire,
      "released listing target bound",
    ],
    [
      "largest listing record bytes",
      largestRecord,
      bounds.record,
      "released compact reader record bound",
    ],
    ["listing records", listings.length, bounds.entries, "released reader entry count"],
    [
      "listing element charge",
      listings.length * bounds.listingCharge,
      bounds.elementBudget,
      "current reader element budget",
    ],
  ];
}

/** The signed definition index against Core's whole-index bounds. Neither
 * has continuation: the index is one authenticated target. */
export function definitionIndexMeasures(
  indexBytes: Buffer,
  definitionIndexSource: string,
): CapacityMeasure[] {
  const index: unknown = JSON.parse(indexBytes.toString("utf8"));
  if (!isRecord(index) || !Array.isArray(index.contents))
    throw new Error("Capacity diagnostics require a definition index");
  const aggregate = index.contents.reduce((total: number, content: unknown) => {
    if (!isRecord(content) || !Number.isSafeInteger(content.length))
      throw new Error("Capacity diagnostics require definition content lengths");
    return total + Number(content.length);
  }, 0);
  return [
    [
      "definition index bytes",
      indexBytes.length,
      capacityConstant(definitionIndexSource, "MAX_INDEX_BYTES"),
      "definition index bound",
    ],
    [
      "definition content aggregate bytes",
      aggregate,
      capacityConstant(definitionIndexSource, "MAX_TOTAL_BYTES"),
      "definition content aggregate bound",
    ],
  ];
}

/**
 * CI guard for generated, compact and escaped catalog bytes and the listing
 * directory's delivery measures. Core measures its serialized projection and
 * retained representations in its growth test.
 */
export function catalogSizeGuard(
  sourceBytes: number,
  catalog: unknown,
  bounds: CatalogSizeBounds,
  listingDirectory: readonly CapacityMeasure[] = [],
) {
  // A fixed ten-digit issuance time keeps the placeholder envelope deterministic.
  const report = catalogCapacity(catalog, bounds.current, 4_102_444_800);
  const ceiling = (bound: number) => Math.floor((bound * bounds.percent) / 100);
  const measures = [
    ["generated catalog.json bytes", sourceBytes, bounds.current, "generated input bound"],
    ["compact catalog bytes", report.compact_catalog_bytes, bounds.current, "catalog input bound"],
    [
      "escaped signed envelope bytes (unsigned placeholder)",
      report.representative_envelope_bytes,
      bounds.current,
      "signed envelope bound",
    ],
    ...listingDirectory,
  ] as const;
  const rows = measures.map(([name, bytes, bound, basis]) => ({
    name,
    bytes,
    bound,
    basis,
    ceiling: ceiling(bound),
    headroom: ceiling(bound) - bytes,
    ok: bytes <= ceiling(bound),
  }));
  return { ok: rows.every((row) => row.ok), percent: bounds.percent, rows };
}

export function formatCatalogSizeGuard(result: ReturnType<typeof catalogSizeGuard>) {
  return result.rows
    .map(
      (row) =>
        `${row.ok ? "ok  " : "FAIL"} ${row.name}: ${row.bytes} of ${row.ceiling} ` +
        `(${result.percent}% of the ${row.basis} ${row.bound}); headroom ${row.headroom}`,
    )
    .join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      catalog: { type: "string" },
      check: { type: "boolean" },
      "observed-target": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const signedCatalogSource = readFileSync(
    new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url),
    "utf8",
  );
  if (values.help)
    process.stdout.write(
      "Usage: node scripts/catalog-capacity.mts --catalog FILE\n       node scripts/catalog-capacity.mts --check [--catalog FILE] [--observed-target FILE]\nOffline byte/headroom diagnostics; no signing, provider access or admission.\n--check fails when a measure exceeds its stated margin (default: the generated catalog).\n--observed-target merges the observations of a delivered listing target (legacy JSON or a\ndecoded compact directory) into the listing carrier measures.\n",
    );
  else if (values.check) {
    const bounds = catalogSizeBounds(signedCatalogSource);
    const filename =
      values.catalog ??
      fileURLToPath(new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url));
    const bytes = boundedInput(filename, bounds.current);
    const definitionIndexSource = readFileSync(
      new URL("../crates/portcove-core/src/definition_index.rs", import.meta.url),
      "utf8",
    );
    const repositoryListings = new URL(
      "../crates/portcove-core/catalog/listings.json",
      import.meta.url,
    );
    const listingBounds = listingDeliveryBounds(
      readFileSync(
        new URL("../crates/portcove-listing-carrier/src/lib.rs", import.meta.url),
        "utf8",
      ),
      readFileSync(
        new URL("../crates/portcove-core/src/catalog/listings.rs", import.meta.url),
        "utf8",
      ),
      readFileSync(
        new URL("../crates/portcove-core/src/listing_delivery.rs", import.meta.url),
        "utf8",
      ),
    );
    const observations = values["observed-target"]
      ? signedObservations(
          JSON.parse(
            boundedInput(values["observed-target"], listingBounds.decoded).toString("utf8"),
          ),
        )
      : undefined;
    const result = catalogSizeGuard(
      bytes.length,
      JSON.parse(bytes.toString("utf8")),
      bounds,
      values.catalog
        ? []
        : [
            ...listingDirectoryMeasures(
              boundedInput(fileURLToPath(repositoryListings), listingBounds.text),
              listingBounds,
              observations,
            ),
            ...definitionIndexMeasures(
              boundedInput(
                fileURLToPath(
                  new URL(
                    "../release/catalog-publication/bundle/definitions/index.json",
                    import.meta.url,
                  ),
                ),
                capacityConstant(definitionIndexSource, "MAX_INDEX_BYTES"),
              ),
              definitionIndexSource,
            ),
          ],
    );
    process.stdout.write(`${formatCatalogSizeGuard(result)}\n`);
    if (!result.ok) {
      process.stderr.write(
        "Catalog size guard failed: reduce catalog bytes or resolve the limiting supported consumer (#5894).\n",
      );
      process.exitCode = 1;
    }
  } else {
    if (!values.catalog) throw new Error("--catalog is required");
    const limit = capacityConstant(signedCatalogSource, "MAX_CATALOG_BYTES");
    const library = readFileSync(
      new URL("../crates/portcove-core/src/library.rs", import.meta.url),
      "utf8",
    );
    const bytes = boundedInput(values.catalog, limit);
    const report = catalogCapacity(
      JSON.parse(bytes.toString("utf8")),
      limit,
      Math.floor(Date.now() / 1000),
    );
    process.stdout.write(
      JSON.stringify(
        {
          ...report,
          source_bytes: bytes.length,
          source_sha256: createHash("sha256").update(bytes).digest("hex"),
          cache_policy: {
            charged_record_budget_bytes: capacityConstant(library, "HTTP_CACHE_MAX_RECORD_BYTES"),
            per_record_reserve_bytes: capacityConstant(library, "HTTP_CACHE_RECORD_RESERVE_BYTES"),
            retention_seconds: capacityConstant(library, "HTTP_CACHE_MAX_AGE_SECONDS"),
            basis:
              "UTF-8 bodies + twice URL bytes for key/index + validators + per-row reserve; finite budget, no catalog-size-derived row ceiling. Database-file and process sizes are separate observations.",
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
}
