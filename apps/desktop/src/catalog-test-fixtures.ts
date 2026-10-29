import { Ajv2020 } from "ajv/dist/2020.js";
import catalog from "../../../crates/portcove-core/catalog/catalog.json";
import schemas from "./transport-schemas.generated.json";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { portDefinition } from "./test-fixtures";
import type { PortDefinition } from "./types";
import type { SourceCatalog } from "./transport-types.generated";

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  formats: {
    int32: true,
    int64: true,
    uint: true,
    uint32: true,
    uint64: true,
    uint8: true,
    uint16: true,
  },
});
const validate = ajv.compile<PortDefinition>({
  $schema: schemas.catalog.$schema,
  $ref: "#/$defs/PortDefinition",
  $defs: schemas.catalog.$defs,
});
const validateSources = ajv.compile<SourceCatalog>(schemas.source_catalog);

/** Test setup consumes the Rust-owned serialized shape without type assertions. */
export function serializedPortFixture(value: unknown): PortDefinition {
  if (!validate(value))
    throw new Error(`Invalid serialized port fixture: ${ajv.errorsText(validate.errors)}`);
  return value;
}

function entryDefaults(value: unknown, defaults: Record<string, unknown>) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid catalog release fixture map");
  return Object.fromEntries(
    Object.entries(value).map(([platform, entry]) => [
      platform,
      isRecord(entry) ? { ...defaults, ...entry } : entry,
    ]),
  );
}

/** Intentional current-catalog contract coverage, separate from generic builders.
 * The authored catalog omits these Core defaults; fixture values are then
 * checked against the complete serialized schema, without coercion or mutation.
 */
export function authoredPortFixture(authored: unknown): PortDefinition {
  if (!isRecord(authored) || !isRecord(authored.release))
    throw new Error("Invalid authored port fixture: required release object is missing");
  const base = portDefinition();
  // Whitelist serde(default) fields. A future mandatory field must fail setup,
  // even if the generic synthetic builder provides a value for it.
  const defaultedFields = [
    "automated_tested_platforms",
    "manually_validated_platforms",
    "bundled_runtime",
    "source_profile",
    "bios_source_profile",
    "executable_hints",
    "persistent_paths",
    "persistent_file_patterns",
    "runtime_mutable_paths",
    "portable_marker",
    "source_environment",
    "user_data_environment",
    "launch_environment",
    "launch_arguments",
    "runtime_subdirectory",
    "runtime_source_filename",
    "runtime_source_materialization",
    "runtime_source_hashes",
    "runtime_source_set",
    "launch_from_install_root",
    "setup_executable_hints",
    "setup_arguments",
    "setup_marker",
    "setup_output_paths",
    "upstream_status",
  ] as const satisfies readonly (keyof PortDefinition)[];
  const defaults = Object.fromEntries(defaultedFields.map((field) => [field, base[field]]));
  return serializedPortFixture({
    ...defaults,
    ...authored,
    release: {
      ...base.release,
      ...authored.release,
      direct: entryDefaults(authored.release.direct, {
        published_at: null,
      }),
      user_prepared: entryDefaults(authored.release.user_prepared, {
        source_argument_extension: null,
      }),
    },
  });
}

export function currentCatalogPort(id: string): PortDefinition {
  const authored = catalog.ports.find((entry) => entry.id === id);
  if (!authored) throw new Error(`Missing embedded catalog port fixture ${id}`);
  return authoredPortFixture(authored);
}

/** Preserve omitted nullable evidence URLs without inventing source claims. */
export function authoredSourceCatalogFixture(authored: unknown): SourceCatalog {
  if (!isRecord(authored)) throw new Error("Invalid authored source catalog fixture");
  const value: unknown = {
    ...authored,
    evidence: Array.isArray(authored.evidence)
      ? authored.evidence.map((entry: unknown) =>
          isRecord(entry) ? { live_url: null, ...entry } : entry,
        )
      : authored.evidence,
  };
  if (!validateSources(value))
    throw new Error(`Invalid source catalog fixture: ${ajv.errorsText(validateSources.errors)}`);
  return value;
}

export function currentSourceCatalog(): SourceCatalog {
  return authoredSourceCatalogFixture(catalog.source_catalog);
}
