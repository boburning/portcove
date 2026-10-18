import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

// These are checked authoring projections, not a second catalog schema. Unknown
// metadata is retained verbatim; the captured Core inspector owns admission.
export interface NamedRecord extends Record<string, unknown> {
  id: string;
}
interface CatalogPort extends NamedRecord {
  presentation?: ({ artwork?: unknown } & Record<string, unknown>) | null;
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
