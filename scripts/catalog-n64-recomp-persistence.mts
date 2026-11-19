import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const sharedPaths = [
  "mods",
  "mod_config",
  "saves",
  "mods.json",
  "mods.json.bak",
  "general.json",
  "general.json.bak",
  "graphics.json",
  "graphics.json.bak",
  "controls.json",
  "controls.json.bak",
  "sound.json",
  "sound.json.bak",
];
const customPersistenceFields = [
  "runtime_subdirectory",
  "runtime_subdirectory_by_platform",
  "runtime_mutable_paths",
  "runtime_source_materialization",
  "runtime_source_hashes",
  "n64_runtime_at_executable_parent",
  "portable_marker",
  "user_data_environment",
];

function reviewedLayout(record: AuthoredPort): string | undefined {
  const integration = record.integration;
  if (
    integration?.adapter !== "n64-recomp-portable" ||
    !isRecord(integration.release) ||
    (integration.release.provider !== undefined && integration.release.provider !== "github") ||
    typeof integration.release.repository !== "string" ||
    typeof integration.source_profile !== "string" ||
    !integration.source_profile ||
    customPersistenceFields.some((field) => Object.hasOwn(integration, field)) ||
    Object.hasOwn(integration, "game_settings") ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    return undefined;
  const source = integration.runtime_source_filename;
  if (typeof source === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.z64$/u.test(source))
    return source;
  return undefined;
}

export function projectN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  if (record.n64_recomp_persistence_v1 === undefined) return record;
  const source = reviewedLayout(record);
  if (record.n64_recomp_persistence_v1 !== true || source === undefined || !record.integration)
    throw new Error("N64 persistence facts require the reviewed root-level GitHub recomp layout.");
  if (Object.hasOwn(record.integration, "persistent_paths"))
    throw new Error("N64 persistence facts already own persistent_paths.");

  // Insert at the established field position so conversion also preserves the
  // exact bytes used by generated catalog and signed projection consumers.
  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record.integration)) {
    if (field === "runtime_source_filename")
      integration.persistent_paths = [...sharedPaths, source];
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  if (record.n64_recomp_persistence_v1 !== undefined || reviewedLayout(record) === undefined)
    return record;
  const integration = { ...record.integration };
  delete integration.persistent_paths;
  const candidate: AuthoredPort = { ...record, n64_recomp_persistence_v1: true, integration };
  return JSON.stringify(projectN64RecompPersistence(candidate).integration) ===
    JSON.stringify(record.integration)
    ? candidate
    : record;
}
