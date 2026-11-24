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
/**
 * Optional additions a recomp's own writer makes beside the shared layout.
 * The authored variant declares which one applies; the record names no title.
 */
const variants = new Map<unknown, { before: string[]; after: string[] }>([
  [true, { before: [], after: [] }],
  ["config-directory", { before: ["config"], after: [] }],
  ["technical-settings", { before: [], after: ["technical.json", "technical.json.bak"] }],
]);
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

/** The root-level layout, or the first precondition the record misses. */
function reviewedLayout(record: AuthoredPort) {
  const integration = record.integration;
  if (integration?.adapter !== "n64-recomp-portable")
    return { missing: "the n64-recomp-portable adapter" } as const;
  if (
    !isRecord(integration.release) ||
    (integration.release.provider !== undefined && integration.release.provider !== "github") ||
    typeof integration.release.repository !== "string"
  )
    return { missing: "a GitHub release repository" } as const;
  if (typeof integration.source_profile !== "string" || !integration.source_profile)
    return { missing: "an explicit source_profile" } as const;
  const custom = customPersistenceFields.find((field) => Object.hasOwn(integration, field));
  if (custom !== undefined) return { missing: `no ${custom}` } as const;
  if (
    Object.hasOwn(integration, "game_settings") ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    return { missing: "no game settings or settings qualification" } as const;
  const source = integration.runtime_source_filename;
  if (typeof source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.z64$/u.test(source))
    return { missing: "a root-level .z64 runtime_source_filename" } as const;
  return { integration, source };
}

export function projectN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  const variant = record.n64_recomp_persistence_v1;
  if (variant === undefined) return record;
  const additions = variants.get(variant);
  if (!additions)
    throw new Error('N64 persistence facts take true, "config-directory" or "technical-settings".');
  const layout = reviewedLayout(record);
  if ("missing" in layout) throw new Error(`N64 persistence facts require ${layout.missing}.`);
  if (Object.hasOwn(layout.integration, "persistent_paths"))
    throw new Error("N64 persistence facts already own persistent_paths.");

  // Insert at the established field position so conversion also preserves the
  // exact bytes used by generated catalog and signed projection consumers.
  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(layout.integration)) {
    if (field === "runtime_source_filename")
      integration.persistent_paths = [
        ...sharedDirectories,
        ...additions.before,
        ...sharedSettings,
        ...additions.after,
        layout.source,
      ];
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactN64RecompPersistence(record: AuthoredPort): AuthoredPort {
  if (record.n64_recomp_persistence_v1 !== undefined) return record;
  const layout = reviewedLayout(record);
  if ("missing" in layout) return record;
  const integration = { ...layout.integration };
  delete integration.persistent_paths;
  for (const variant of variants.keys()) {
    const candidate = {
      ...record,
      n64_recomp_persistence_v1: variant,
      integration,
    } as AuthoredPort;
    if (
      JSON.stringify(projectN64RecompPersistence(candidate).integration) ===
      JSON.stringify(layout.integration)
    )
      return candidate;
  }
  return record;
}
