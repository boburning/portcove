/** Offline capacity diagnostics only. No signature, provider read or admission. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  compactListingCarrier,
  compactListingCountMaximum,
  compactListingDecodedMaximum,
  compactListingRecordMaximum,
  decodeRetainedCompactListing,
  listingDeliveryMaximum,
  listingDirectoryTextMaximum,
} from "./listing-directory-carrier.mts";
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

/**
 * How a guarded measure's CI ceiling is set below its bound:
 * - `percent`: Core's supported share (`CATALOG_SUPPORTED_CAPACITY_PERCENT`);
 * - `growth`: `leadDays` of measured growth at `perDay` units a day;
 * - `half`: half the bound, for a measure with no growth rate (one record);
 * - `informational`: reported, never failed. The frozen legacy listing target
 *   keeps its last signed bytes, so its size is no CI growth ceiling.
 */
export type CapacityMargin =
  | { kind: "percent" }
  | { kind: "growth"; perDay: number }
  | { kind: "half" }
  | { kind: "informational" };

/** One guarded measure: name, measured value, the consumer's bound, its basis
 * and how its ceiling is set (default: Core's supported share). */
export type CapacityMeasure = readonly [
  name: string,
  value: number,
  bound: number,
  basis: string,
  margin?: CapacityMargin,
];

/**
 * The one bound source for the listing directory's consumers. Carrier bounds
 * are those of the RELEASED compact readers (Preview 14 and 15): the publisher
 * signs nothing they would refuse, so these come from the publisher's own
 * constants in `listing-directory-carrier.mts`. The current generation's Rust
 * constants may be raised for the next reader generation; that never loosens
 * what is guarded or signed, and a current constant below a released one is
 * refused because the current reader would then refuse a signed target.
 */
export interface ListingDeliveryBounds {
  /** Authenticated target body, either carrier (released readers). */
  wire: number;
  /** Decoded compact directory (released readers). */
  decoded: number;
  /** One compact listing record (released readers). */
  record: number;
  /** Listings, and separately withdrawals (released readers). */
  entries: number;
  /** Authored directory text Core inspects; also the publisher's canonical
   * `listings.json` read (`listingDirectoryTextMaximum`). */
  text: number;
  /** Current generation's per-admission element budget and charges. */
  elementBudget: number;
  listingCharge: number;
  withdrawalCharge: number;
}

export function listingDeliveryBounds(
  carrierSource: string,
  listingsSource: string,
  deliverySource: string,
): ListingDeliveryBounds {
  const released = {
    wire: listingDeliveryMaximum,
    decoded: compactListingDecodedMaximum,
    record: compactListingRecordMaximum,
    entries: compactListingCountMaximum,
  };
  const current = {
    wire: capacityConstant(carrierSource, "MAX_BYTES"),
    decoded: capacityConstant(carrierSource, "MAX_COMPACT_DECODED_BYTES"),
    record: capacityConstant(carrierSource, "MAX_COMPACT_RECORD_BYTES"),
    entries: capacityConstant(carrierSource, "MAX_LISTING_ENTRIES"),
  };
  for (const key of Object.keys(released) as (keyof typeof released)[])
    if (current[key] < released[key])
      throw new Error(
        `Current listing carrier bound ${key} (${current[key]}) is below the released readers' ${released[key]}`,
      );
  const text = capacityConstant(listingsSource, "MAX_LISTING_DIRECTORY_TEXT_BYTES");
  if (text !== listingDirectoryTextMaximum)
    throw new Error(
      "Publisher listing text bound differs from Core's MAX_LISTING_DIRECTORY_TEXT_BYTES",
    );
  return {
    ...released,
    text,
    elementBudget: capacityConstant(deliverySource, "ELEMENT_WORKING_BUDGET"),
    listingCharge: capacityConstant(deliverySource, "LISTING_WORKING_BYTES"),
    withdrawalCharge: capacityConstant(deliverySource, "WITHDRAWAL_WORKING_BYTES"),
  };
}

/**
 * Mirror of `portcove_listing_carrier::legacy_row_projection`: the format-11
 * row a legacy reader receives. Core's tests prove the Rust projection equals
 * Core's format-11 export.
 */
export function legacyRowProjection(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const projected: Record<string, unknown> = structuredClone(row);
  for (const field of ["restrictions", "implementation", "upstream_observation", "mod_portals"])
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
 * target: legacy JSON, a decoded compact delivery document, or a compact
 * carrier (`gzip-base64-json-v1`), which is decoded under its own bounds. */
export function signedObservations(target: unknown) {
  if (isRecord(target) && target.carrier === compactListingCarrier)
    target = JSON.parse(
      decodeRetainedCompactListing(Buffer.from(JSON.stringify(target))).toString("utf8"),
    );
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
 * The compact carrier's growth model. Measured November 23, 2026; refresh
 * these figures with the evidence in docs/SIGNED-CATALOG.md ("Compact carrier
 * capacity guard").
 */
export const compactCarrierModel = {
  /** Mean serialized `upstream_observation` over the 933 observed rows of the
   * live revision-47 target; charged to every row without a signed one. */
  observationBytesPerRow: 4_791,
  /** Largest live serialized observation, charged to every row without a
   * signed one when finding the largest record. */
  largestObservationBytes: 31_106,
  /** Wire/decoded ratio of the staged revision-48 compact target
   * (2,745,010 / 9,602,327); the guard uses the worse of this and its own. */
  wireRatio: 2_745_010 / 9_602_327,
  /** Seven-day growth of the committed directory (November 16 -> 23): compact
   * authored bytes 4,251,227 -> 5,365,914 and rows 1,527 -> 1,649. */
  authoredBytesPerDay: (5_365_914 - 4_251_227) / 7,
  rowsPerDay: (1_649 - 1_527) / 7,
  /** Days to release a new reader generation AND have players adopt it: the
   * compact reader took two days from merge (#8450) to Preview 14, but older
   * previews do not update on their own (docs/SIGNED-CATALOG.md). */
  leadDays: 28,
} as const;

/**
 * The listing directory against every consumer that can stop its delivery:
 * Core's inspection of the authored text (also the publisher's canonical
 * read), the compact carrier at the released readers' bounds, the current
 * generation's element budget, and the frozen legacy target (informational).
 *
 * Carrier rows are modeled: each row carries its signed observation when
 * `observations` (from `--observed-target`) has one, and is otherwise charged
 * the model's mean observation; the wire uses the worse of the model's and
 * this document's own compression ratio. Each carrier ceiling reserves
 * `leadDays` of measured growth; the largest record reserves half its bound.
 */
/** The identities of the committed listing withdrawal record (`listing-withdrawals.json`). */
export function withdrawalIdentities(record: unknown): string[] {
  if (!isRecord(record) || !Array.isArray(record.withdrawals))
    throw new Error("Capacity diagnostics require the committed listing withdrawal record");
  return record.withdrawals.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== "string")
      throw new Error("Capacity diagnostics require withdrawal identities");
    return entry.id;
  });
}

export function listingDirectoryMeasures(
  text: Buffer,
  bounds: ListingDeliveryBounds,
  observations?: ReadonlyMap<string, unknown>,
  withdrawals: readonly string[] = [],
  model: typeof compactCarrierModel = compactCarrierModel,
): CapacityMeasure[] {
  const directory: unknown = JSON.parse(text.toString("utf8"));
  if (!isRecord(directory) || !Array.isArray(directory.listings))
    throw new Error("Capacity diagnostics require a listing directory");
  const listings: unknown[] = directory.listings.map((row: unknown) =>
    observations && isRecord(row) && typeof row.id === "string" && observations.has(row.id)
      ? { ...row, upstream_observation: observations.get(row.id) }
      : row,
  );
  const observed = (row: unknown) => isRecord(row) && row.upstream_observation !== undefined;
  const signed = listings.filter(observed).length;
  const charged = listings.length - signed;
  const scope = `modeled: ${signed} signed observations, ${charged} charged the mean`;
  const delivery = (document: unknown) =>
    Buffer.from(
      JSON.stringify({
        listing_delivery_schema: 1,
        revision: Number.MAX_SAFE_INTEGER,
        withdrawn_ids: withdrawals,
        directory: document,
      }),
    );
  const document = delivery({ ...directory, listings });
  const decoded = document.length + charged * model.observationBytesPerRow;
  // Base64 of the gzip stream; the carrier's fixed fields are the 256 below.
  const ratio = Math.max(model.wireRatio, (gzipSync(document).length * 4) / 3 / document.length);
  const wire = Math.ceil(decoded * ratio) + 256;
  const record = Math.max(
    0,
    ...listings.map(
      (row) =>
        Buffer.byteLength(JSON.stringify(row)) +
        (observed(row) ? 0 : model.largestObservationBytes),
    ),
  );
  // What a complete format-11 successor would need. The legacy target is
  // frozen at its last signed bytes, so this never fails CI.
  const legacy = delivery({
    format_version: 11,
    listings: listings.map((row) => {
      const projected = legacyRowProjection(row);
      return isRecord(row) && row.upstream_observation !== undefined && isRecord(projected)
        ? { ...projected, upstream_observation: row.upstream_observation }
        : projected;
    }),
  });
  const decodedPerDay = model.authoredBytesPerDay + model.rowsPerDay * model.observationBytesPerRow;
  const growth = (perDay: number): CapacityMargin => ({ kind: "growth", perDay });
  return [
    [
      "generated listings.json bytes",
      text.length,
      bounds.text,
      "Core listing inspection and publisher canonical read bound",
    ],
    [
      `compact listing directory decoded bytes (${scope})`,
      decoded,
      bounds.decoded,
      "released compact reader decoded bound",
      growth(decodedPerDay),
    ],
    [
      `compact listing carrier bytes (${scope})`,
      wire,
      bounds.wire,
      "released listing target bound",
      growth(decodedPerDay * ratio),
    ],
    [
      "largest compact listing record bytes (modeled)",
      record,
      bounds.record,
      "released compact reader record bound",
      { kind: "half" },
    ],
    [
      "listing records",
      listings.length,
      bounds.entries,
      "released reader entry count",
      growth(model.rowsPerDay),
    ],
    // Withdrawals cannot outpace the rows that could be withdrawn.
    [
      "listing withdrawals",
      withdrawals.length,
      bounds.entries,
      "released reader entry count",
      growth(model.rowsPerDay),
    ],
    [
      "listing element charge",
      listings.length * bounds.listingCharge + withdrawals.length * bounds.withdrawalCharge,
      bounds.elementBudget,
      "current reader element budget",
    ],
    [
      "frozen legacy listing target (revision 47): complete format-11 successor bytes",
      legacy.length,
      bounds.wire,
      "released legacy target bound",
      { kind: "informational" },
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
 * The one CI capacity guard: generated, compact and escaped catalog bytes, the
 * listing directory's delivery measures and the definition index. Core
 * measures its serialized projection and retained representations in its
 * growth test.
 */
export function catalogSizeGuard(
  sourceBytes: number,
  catalog: unknown,
  bounds: CatalogSizeBounds,
  measured: readonly CapacityMeasure[] = [],
  leadDays: number = compactCarrierModel.leadDays,
) {
  // A fixed ten-digit issuance time keeps the placeholder envelope deterministic.
  const report = catalogCapacity(catalog, bounds.current, 4_102_444_800);
  const measures: CapacityMeasure[] = [
    ["generated catalog.json bytes", sourceBytes, bounds.current, "generated input bound"],
    ["compact catalog bytes", report.compact_catalog_bytes, bounds.current, "catalog input bound"],
    [
      "escaped signed envelope bytes (unsigned placeholder)",
      report.representative_envelope_bytes,
      bounds.current,
      "signed envelope bound",
    ],
    ...measured,
  ];
  const rows = measures.map(([name, bytes, bound, basis, margin = { kind: "percent" }]) => {
    const ceiling =
      margin.kind === "growth"
        ? bound - Math.ceil(margin.perDay * leadDays)
        : margin.kind === "half"
          ? bound - Math.ceil(bound / 2)
          : margin.kind === "informational"
            ? bound
            : Math.floor((bound * bounds.percent) / 100);
    const perDay = margin.kind === "growth" && margin.perDay > 0 ? margin.perDay : null;
    return {
      name,
      bytes,
      bound,
      basis,
      margin: margin.kind,
      ceiling,
      headroom: ceiling - bytes,
      growth_per_day: perDay === null ? null : Math.round(perDay),
      days_before_ceiling: perDay === null ? null : Math.floor((ceiling - bytes) / perDay),
      days_before_bound: perDay === null ? null : Math.floor((bound - bytes) / perDay),
      ok: margin.kind === "informational" || bytes <= ceiling,
    };
  });
  return {
    ok: rows.every((row) => row.ok),
    percent: bounds.percent,
    lead_days: leadDays,
    rows,
  };
}

export function formatCatalogSizeGuard(result: ReturnType<typeof catalogSizeGuard>) {
  return result.rows
    .map((row) => {
      const reserve =
        row.margin === "growth"
          ? `${result.lead_days} days at ${row.growth_per_day ?? 0}/day reserved below the ${row.basis} ${row.bound}` +
            (row.growth_per_day === null
              ? ""
              : `; ${row.days_before_ceiling} days to this ceiling, ${row.days_before_bound} to the bound`)
          : row.margin === "half"
            ? `half of the ${row.basis} ${row.bound} reserved for one record's growth`
            : row.margin === "informational"
              ? `informational, not a CI ceiling; the ${row.basis} ${row.bound}`
              : `${result.percent}% of the ${row.basis} ${row.bound}`;
      const status = row.margin === "informational" ? "info" : row.ok ? "ok  " : "FAIL";
      return `${status} ${row.name}: ${row.bytes} of ${row.ceiling} (${reserve}); headroom ${row.headroom}`;
    })
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
      "Usage: node scripts/catalog-capacity.mts --catalog FILE\n       node scripts/catalog-capacity.mts --check [--catalog FILE] [--observed-target FILE]\nOffline byte/headroom diagnostics; no signing, provider access or admission.\n--check fails when a measure exceeds its stated margin (default: the generated catalog).\n--observed-target merges the signed observations of a delivered listing target (legacy JSON,\na decoded compact directory or a compact carrier) into the modeled carrier measures.\n",
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
    let listingDirectory: CapacityMeasure[] = [];
    if (!values.catalog) {
      const record: unknown = JSON.parse(
        boundedInput(
          fileURLToPath(
            new URL("../crates/portcove-core/catalog/listing-withdrawals.json", import.meta.url),
          ),
          listingBounds.text,
        ).toString("utf8"),
      );
      const withdrawn = withdrawalIdentities(record);
      listingDirectory = [
        ...listingDirectoryMeasures(
          boundedInput(fileURLToPath(repositoryListings), listingBounds.text),
          listingBounds,
          observations,
          withdrawn,
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
      ];
    }
    const result = catalogSizeGuard(
      bytes.length,
      JSON.parse(bytes.toString("utf8")),
      bounds,
      listingDirectory,
    );
    process.stdout.write(`${formatCatalogSizeGuard(result)}\n`);
    if (!result.ok) {
      process.stderr.write(
        "Catalog size guard failed: reduce catalog bytes or resolve the limiting supported consumer (#5894). A compact listing carrier row lifts only with the next reader generation; start one now (docs/SIGNED-CATALOG.md, Compact carrier capacity guard).\n",
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
