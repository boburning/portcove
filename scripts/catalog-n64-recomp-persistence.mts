import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const sharedDirectories = ["mods", "mod_config", "saves"];
const sharedSettings = [
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
const reviewedAdditions = {
  "dinosaur-planet": {
    repository: "DinosaurPlanetRecomp/dino-recomp",
    sourceProfile: "dinosaur-planet",
    variant: "config-directory",
  },
  "donkey-kong-64-recompiled": {
    repository: "Rainchus/Donkey-Kong-64-Recompiled",
    sourceProfile: "donkey-kong-64",
    variant: "technical-settings",
  },
} as const;
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

function reviewedLayout(record: AuthoredPort) {
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
  if (typeof source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.z64$/u.test(source))
    return undefined;
  const id = record.listing.id;
  const addition = Object.hasOwn(reviewedAdditions, id)
    ? reviewedAdditions[id as keyof typeof reviewedAdditions]
    : undefined;
  const variant =
    addition &&
    addition.repository === integration.release.repository &&
    addition.sourceProfile === integration.source_profile &&
    record.listing.project_url === `https://github.com/${addition.repository}`
      ? addition.variant
      : undefined;
  return { integration, source, variant };
}

export function projectN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  const variant = record.n64_recomp_persistence_v1;
  if (variant === undefined) return record;
  const layout = reviewedLayout(record);
  if (!layout || (variant !== true && variant !== layout.variant))
    throw new Error("N64 persistence facts require the reviewed root-level GitHub recomp layout.");
  if (Object.hasOwn(layout.integration, "persistent_paths"))
    throw new Error("N64 persistence facts already own persistent_paths.");

  // Insert at the established field position so conversion also preserves the
  // exact bytes used by generated catalog and signed projection consumers.
  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(layout.integration)) {
    if (field === "runtime_source_filename")
      integration.persistent_paths = [
        ...sharedDirectories,
        ...(variant === "config-directory" ? ["config"] : []),
        ...sharedSettings,
        ...(variant === "technical-settings" ? ["technical.json", "technical.json.bak"] : []),
        layout.source,
      ];
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  if (record.n64_recomp_persistence_v1 !== undefined) return record;
  const layout = reviewedLayout(record);
  if (!layout) return record;
  const integration = { ...layout.integration };
  delete integration.persistent_paths;
  const variants =
    layout.variant === undefined ? ([true] as const) : ([true, layout.variant] as const);
  for (const variant of variants) {
    const candidate: AuthoredPort = { ...record, n64_recomp_persistence_v1: variant, integration };
    if (
      JSON.stringify(projectN64RecompPersistence(candidate).integration) ===
      JSON.stringify(layout.integration)
    )
      return candidate;
  }
  return record;
}
