import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./runtime-values.mts";
import { assessUpstreamLineage, checkLineageIdentities } from "./upstream-lineage.mts";
import type { UpstreamLineage } from "./upstream-lineage.mts";

// These are checked authoring projections, not a second catalog schema. Unknown
// metadata is retained verbatim; the captured Core inspector owns admission.
export interface NamedRecord extends Record<string, unknown> {
  id: string;
}
export interface CatalogPort extends NamedRecord {
  presentation?: ({ artwork?: unknown } & Record<string, unknown>) | null;
}

export interface AuthoredListing extends NamedRecord {
  name: string;
  summary: string;
  project_url: string;
  platforms?: string[];
  availability?: "unknown" | "packages" | "source-only" | "unavailable";
  download_block_reason?: string;
  download_asset_hints?: Record<string, string[]>;
  recommended_download_channel?: "stable" | "beta";
  original_game_title?: string;
  variant_label?: string;
  issue_number?: number;
  release_url?: string;
  setup_url?: string;
  manual_setup?: unknown;
  artwork?: unknown;
}
export interface AuthoredPort extends Record<string, unknown> {
  format_version: 1;
  listing: AuthoredListing;
  /** Strict operational fields; common descriptive fields have one authority above. */
  integration?: Record<string, unknown>;
  /** Retained only to preserve the established operational ordering at migration. */
  order?: number;
  /** Reviewed provenance; never projected into runtime definitions or listings. */
  upstream_lineage?: UpstreamLineage;
}

export const catalogSourceNames = {
  shared: "catalog-shared.json",
  ports: "ports",
  operational: "catalog-current-authoring.json",
  embedded: "catalog.json",
  listings: "listings.json",
} as const;
const listingPresentationFields = [
  "original_game_title",
  "variant_label",
  "manual_setup",
  "artwork",
] as const;
const sharedPortFields = ["id", "name", "summary", "project_url"] as const;
const listingFields = new Set([
  ...sharedPortFields,
  ...listingPresentationFields,
  "platforms",
  "availability",
  "download_block_reason",
  "download_asset_hints",
  "recommended_download_channel",
  "issue_number",
  "release_url",
  "setup_url",
]);
const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function boundedText(value: unknown, maximum: number): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function publicUrl(value: unknown, field: string) {
  if (!boundedText(value, 4096))
    throw new Error(`Listing ${field} requires a bounded public HTTPS URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Listing ${field} is not a URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`Listing ${field} requires a credential-free HTTPS URL.`);
}

export function checkedAuthoredPort(value: unknown, expectedId?: string): AuthoredPort {
  if (!isRecord(value) || value.format_version !== 1 || !isRecord(value.listing))
    throw new Error("An authored port requires format_version 1 and a listing.");
  const listing = value.listing;
  if (Object.keys(listing).some((field) => !listingFields.has(field)))
    throw new Error(
      "Listing contains unknown descriptive fields; operational fields belong to its integration.",
    );
  if (
    typeof listing.id !== "string" ||
    listing.id.length > 128 ||
    !stableId.test(listing.id) ||
    (expectedId !== undefined && listing.id !== expectedId)
  )
    throw new Error("Authored port filename and stable listing ID must agree.");
  for (const [field, maximum] of [
    ["name", 512],
    ["summary", 4096],
  ] as const) {
    const text = listing[field];
    if (!boundedText(text, maximum))
      throw new Error(`Listing ${field} requires bounded nonempty text.`);
  }
  publicUrl(listing.project_url, "project_url");
  for (const field of ["release_url", "setup_url"] as const)
    if (listing[field] !== undefined) publicUrl(listing[field], field);
  if (
    listing.availability !== undefined &&
    (typeof listing.availability !== "string" ||
      !["unknown", "packages", "source-only", "unavailable"].includes(listing.availability))
  )
    throw new Error("Unknown listing availability.");
  if (
    listing.download_block_reason !== undefined &&
    !boundedText(listing.download_block_reason, 4096)
  )
    throw new Error("Listing download restriction requires bounded nonempty text.");
  if (listing.download_asset_hints !== undefined) {
    if (
      !isRecord(listing.download_asset_hints) ||
      Object.entries(listing.download_asset_hints).some(
        ([platform, hints]) =>
          !["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"].includes(platform) ||
          !Array.isArray(hints) ||
          hints.length < 1 ||
          hints.length > 8 ||
          hints.some((hint) => !boundedText(hint, 160)) ||
          new Set(hints.map((hint) => String(hint).toLowerCase())).size !== hints.length,
      )
    )
      throw new Error(
        "Listing download asset hints require bounded unique literal platform hints.",
      );
  }
  if (
    listing.recommended_download_channel !== undefined &&
    listing.recommended_download_channel !== "stable" &&
    listing.recommended_download_channel !== "beta"
  )
    throw new Error("Listing recommended download channel must be stable or beta.");
  if (
    listing.platforms !== undefined &&
    (!Array.isArray(listing.platforms) ||
      listing.platforms.length > 32 ||
      listing.platforms.some(
        (v: unknown) =>
          typeof v !== "string" ||
          !["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"].includes(v),
      ) ||
      new Set(listing.platforms).size !== listing.platforms.length)
  )
    throw new Error("Listing platforms require a bounded unique string array.");
  if (
    listing.issue_number !== undefined &&
    (!Number.isSafeInteger(listing.issue_number) || Number(listing.issue_number) < 1)
  )
    throw new Error("Listing issue_number must be a positive integer.");
  for (const field of ["original_game_title", "variant_label"] as const)
    if (listing[field] !== undefined && !boundedText(listing[field], 512))
      throw new Error(`Listing ${field} requires bounded nonempty text.`);
  if (value.order !== undefined && (!Number.isSafeInteger(value.order) || Number(value.order) < 0))
    throw new Error("Authored port order must be a nonnegative integer.");
  if (value.integration !== undefined) {
    if (!isRecord(value.integration)) throw new Error("Integration must be a strict object.");
    if (listing.download_block_reason !== undefined)
      throw new Error(
        "A download restriction cannot coexist with a managed integration; resolve the canonical acquisition condition before authoring that route.",
      );
    const integration = value.integration;
    const presentation = integration.presentation;
    if (sharedPortFields.some((field) => Object.hasOwn(integration, field)))
      throw new Error(
        "Common port fields belong to the listing, not a second integration authority.",
      );
    if (listing.platforms !== undefined && integration.platforms !== undefined)
      throw new Error(
        "Integrated platforms belong to the integration; the listing projection derives them.",
      );
    if (
      isRecord(presentation) &&
      listingPresentationFields.some((field) => Object.hasOwn(presentation, field))
    )
      throw new Error("Shared presentation fields belong to the listing.");
  }
  const record = value as AuthoredPort;
  assessUpstreamLineage(record);
  return record;
}

/** Mechanical split; no support, source, package or artwork observations are added. */
export function authoringRecordFromPort(port: CatalogPort, order?: number): AuthoredPort {
  const listing: Record<string, unknown> = {};
  const integration = structuredClone(port);
  for (const field of sharedPortFields) {
    listing[field] = integration[field];
    delete integration[field];
  }
  for (const field of listingPresentationFields) {
    if (isRecord(integration.presentation) && Object.hasOwn(integration.presentation, field)) {
      listing[field] = integration.presentation[field];
      delete integration.presentation[field];
    }
  }
  return checkedAuthoredPort({
    format_version: 1,
    ...(order === undefined ? {} : { order }),
    listing,
    integration,
  });
}

export function projectAuthoredPort(record: AuthoredPort): CatalogPort | undefined {
  if (!record.integration) return undefined;
  const integration = structuredClone(record.integration);
  const common: Record<string, unknown> = {};
  for (const field of sharedPortFields) common[field] = record.listing[field];
  for (const field of listingPresentationFields) {
    if (Object.hasOwn(record.listing, field)) {
      const presentation = isRecord(integration.presentation) ? integration.presentation : {};
      presentation[field] = structuredClone(record.listing[field]);
      integration.presentation = presentation;
    }
  }
  return { ...common, ...integration, id: record.listing.id };
}

export function assembleCatalogRecords(shared: unknown, inputs: readonly unknown[]) {
  if (!isRecord(shared) || Object.hasOwn(shared, "ports") || Object.hasOwn(shared, "listings"))
    throw new Error("Shared catalog source must not contain a second port/listing authority.");
  if (inputs.length > 10000) throw new Error("Catalog source exceeds its bounded record count.");
  const records = inputs.map((record) => checkedAuthoredPort(record));
  if (new Set(records.map((record) => record.listing.id)).size !== records.length)
    throw new Error("Catalog source has duplicate stable listing IDs.");
  checkLineageIdentities(records);
  records.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.listing.id.localeCompare(b.listing.id, "en"),
  );
  const ports = records.flatMap((record) => {
    const port = projectAuthoredPort(record);
    return port ? [port] : [];
  });
  const catalog = checkedCurrentCatalog({ ...structuredClone(shared), ports });
  const listings = records.map((record) => ({
    ...structuredClone(record.listing),
    platforms: structuredClone(record.integration?.platforms ?? record.listing.platforms ?? []),
    availability: record.listing.availability ?? "unknown",
  }));
  const format_version = listings.some((listing) => listing.download_block_reason !== undefined)
    ? 2
    : 1;
  return { records, catalog, directory: { format_version, listings } };
}

function readRegularJson(file: string, maximum: number) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
    throw new Error("Catalog source requires bounded regular files.");
  return parseCatalogSource(readFileSync(file, "utf8"));
}

/** Native JSON grammar plus duplicate-key refusal before source projection. */
export function parseCatalogSource(content: string): unknown {
  const value: unknown = JSON.parse(content);
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === "{") objects.push(new Set());
    else if (character === "[") objects.push(null);
    else if (character === "}" || character === "]") objects.pop();
    else if (character === '"') {
      const start = index;
      while (++index < content.length) {
        if (content[index] === "\\") index++;
        else if (content[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/u.test(content[next] ?? "")) next++;
      if (content[next] === ":") {
        const key: unknown = JSON.parse(content.slice(start, index + 1));
        const keys = objects.at(-1);
        if (typeof key !== "string" || !keys) throw new Error("Malformed catalog source object.");
        if (keys.has(key)) throw new Error("Catalog source contains a duplicate JSON key.");
        keys.add(key);
      }
    }
  }
  return value;
}

export function readCatalogSource(catalogRoot: string) {
  const directory = join(catalogRoot, catalogSourceNames.ports);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Catalog port source must be a real directory.");
  const files = readdirSync(directory).sort();
  if (files.length > 10000) throw new Error("Catalog source exceeds its bounded record count.");
  const records = files.map((file) => {
    if (!file.endsWith(".json")) throw new Error("Catalog port source accepts only JSON records.");
    return checkedAuthoredPort(
      readRegularJson(join(directory, file), 512 * 1024),
      file.slice(0, -5),
    );
  });
  return assembleCatalogRecords(
    readRegularJson(join(catalogRoot, catalogSourceNames.shared), 8 * 1024 * 1024),
    records,
  );
}
export interface CurrentCatalog extends Record<string, unknown> {
  schema_version: 2;
  ports: CatalogPort[];
  source_catalog: {
    identities: NamedRecord[];
    contracts: NamedRecord[];
    evidence: NamedRecord[];
    validators?: NamedRecord[];
    qualification: Record<string, unknown>[];
  } & Record<string, unknown>;
}
export function namedRecords(value: unknown, name: string, identityError?: string): NamedRecord[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const records: unknown[] = value;
  const result: NamedRecord[] = [];
  for (const record of records) {
    if (!isRecord(record) || typeof record.id !== "string" || !record.id)
      throw new Error(identityError ?? `${name} contains a missing id`);
    result.push({ ...record, id: record.id });
  }
  if (new Set(result.map(({ id }) => id)).size !== result.length)
    throw new Error(identityError ?? `${name} contains duplicate ids`);
  return result;
}

// Independently curated test expectations, never generated from a proposal.
// This checks identity bookkeeping only; Rust retains full frozen equality.
export function reviewCompatibilityFixture(
  catalog: CurrentCatalog,
  legacy: unknown,
  additionsBytes: Buffer,
) {
  const additions: unknown = JSON.parse(additionsBytes.toString("utf8"));
  if (
    !isRecord(additions) ||
    JSON.stringify(Object.keys(additions).sort()) !== '["port_ids","source_profile_ids"]'
  )
    throw new Error("Malformed compatibility fixture; expected only explicit identity lists.");
  const checkedIds = (values: unknown, label: string): string[] => {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((id) => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) ||
      new Set(values).size !== values.length
    )
      throw new Error(`Malformed compatibility fixture ${label}: nonempty unique IDs required.`);
    return values.filter((id: unknown): id is string => typeof id === "string");
  };
  if (!isRecord(legacy)) throw new Error("Malformed frozen legacy catalog.");
  const legacyProfiles = namedRecords(legacy.source_profiles, "legacy.source_profiles");
  const legacyPorts = namedRecords(legacy.ports, "legacy.ports");
  const collections: Record<
    string,
    { expected_count: number; unreviewed_ids: string[]; missing_expected_ids: string[] }
  > = {};
  for (const [name, baseline, actual] of [
    [
      "source_profile_ids",
      legacyProfiles.map(({ id }) => id),
      catalog.source_catalog.identities.map(({ id }) => id),
    ],
    ["port_ids", legacyPorts.map(({ id }) => id), catalog.ports.map(({ id }) => id)],
  ] as const) {
    checkedIds(baseline, `frozen ${name}`);
    const reviewed = checkedIds(additions[name], name);
    if (reviewed.some((id) => baseline.includes(id)))
      throw new Error(`Malformed compatibility fixture ${name}: overlaps frozen legacy IDs.`);
    const expected = new Set([...baseline, ...reviewed]);
    const observed = new Set(actual);
    collections[name] = {
      expected_count: expected.size,
      unreviewed_ids: [...observed].filter((id) => !expected.has(id)).sort(),
      missing_expected_ids: [...expected].filter((id) => !observed.has(id)).sort(),
    };
  }
  return {
    status: Object.values(collections).every(
      ({ unreviewed_ids, missing_expected_ids }) =>
        !unreviewed_ids.length && !missing_expected_ids.length,
    )
      ? "matched"
      : "requires-review",
    fixture: "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
    fixture_sha256: createHash("sha256").update(additionsBytes).digest("hex"),
    collections,
    scope:
      "Identity bookkeeping only; manually review expectations. Full frozen equality, source contracts and qualification remain separate Rust checks.",
  };
}

export function validateCurrentCatalog(catalog: unknown): asserts catalog is CurrentCatalog {
  if (!isRecord(catalog) || catalog.schema_version !== 2)
    throw new Error("current catalog source is not schema 2");
  if ("source_profiles" in catalog)
    throw new Error("current catalog source must not contain a schema-1 source_profiles authority");
  const source = catalog.source_catalog;
  if (!isRecord(source)) throw new Error("source_catalog must be an object");
  const ports = namedRecords(catalog.ports, "ports");
  for (const port of ports) {
    if (
      port.presentation !== undefined &&
      port.presentation !== null &&
      !isRecord(port.presentation)
    )
      throw new Error("port presentation must be an object or null");
  }
  for (const name of ["identities", "contracts", "evidence"] as const)
    namedRecords(source[name], `source_catalog.${name}`);
  if (source.validators !== undefined)
    namedRecords(
      source.validators,
      "source_catalog.validators",
      "source_catalog.validators has a missing or duplicate record identity",
    );
  if (!Array.isArray(source.qualification) || !source.qualification.every(isRecord))
    throw new Error("source_catalog.qualification must be an array of records");
}

export function checkedCurrentCatalog(value: unknown): CurrentCatalog {
  validateCurrentCatalog(value);
  return value;
}

export function serializeCurrentCatalog(catalog: CurrentCatalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
