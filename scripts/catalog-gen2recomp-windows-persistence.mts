import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "UNDERdecoded/Gen2Recomped";
const platform = "windows-x86-64";
const editions = new Map([
  ["gen2recomp-gold", "gold"],
  ["gen2recomp-silver", "silver"],
  ["gen2recomp-crystal", "crystal"],
]);
const managedImport = "portcove-import.gbc";

function reviewedEdition(record: AuthoredPort) {
  const edition = editions.get(record.listing.id);
  const integration = record.integration;
  const release = integration?.release;
  if (
    !edition ||
    record.listing.project_url !== `https://github.com/${repository}` ||
    integration?.adapter !== "generated-cache" ||
    JSON.stringify(integration.platforms) !== '["windows-x86-64"]' ||
    JSON.stringify(integration.channels) !== '["stable"]' ||
    !isRecord(release) ||
    release.repository !== repository ||
    (release.provider !== undefined && release.provider !== "github") ||
    !isRecord(release.asset_hints) ||
    JSON.stringify(release.asset_hints[platform]) !== '["windows.zip"]' ||
    !isRecord(integration.executable_hints) ||
    JSON.stringify(integration.executable_hints[platform]) !== '["Gen2Recomped.exe"]' ||
    integration.source_profile !== `pokemon-${edition}` ||
    integration.portable_marker !== true ||
    integration.source_environment !== "POKEPORT_IMPORT_ROM" ||
    !isRecord(integration.launch_environment) ||
    integration.launch_environment.POKEPORT_VERSION !== edition ||
    integration.launch_environment.POKEPORT_NOTIFY_ONLY_UPDATES !== "1" ||
    integration.runtime_source_filename !== managedImport ||
    integration.runtime_source_materialization !== "copy" ||
    !isRecord(integration.presentation) ||
    integration.presentation.saves_and_settings !== "portcove-managed" ||
    record.route_facts_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined ||
    integration.game_settings !== undefined ||
    integration.runtime_data_policy !== undefined ||
    integration.persistent_file_patterns !== undefined ||
    integration.runtime_mutable_file_patterns !== undefined
  )
    return undefined;
  return { edition, integration };
}

export function projectGen2RecompWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.gen2recomp_windows_persistence_v1 === undefined) return record;
  const profile = reviewedEdition(record);
  if (record.gen2recomp_windows_persistence_v1 !== true || !profile)
    throw new Error("Gen2Recomped persistence requires its reviewed Windows package and edition.");
  if (
    Object.hasOwn(profile.integration, "persistent_paths") ||
    Object.hasOwn(profile.integration, "runtime_mutable_paths")
  )
    throw new Error("Gen2Recomped persistence already owns the persistent and mutable paths.");

  const integration: Record<string, unknown> = {};
  const { edition } = profile;
  for (const [field, value] of Object.entries(profile.integration)) {
    if (field === "presentation") {
      integration.runtime_mutable_paths = [managedImport];
      integration.persistent_paths = [
        edition,
        "mods",
        "imports",
        "exports",
        "screenshots",
        "saves",
        "editor",
        "prints",
        `save_${edition}.lua`,
        `save_${edition}.lua.bak`,
        `save_${edition}.lua.tmp`,
        "options.lua",
        "boot_trace.txt",
        "crash.txt",
      ];
    }
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactGen2RecompWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.gen2recomp_windows_persistence_v1 !== undefined) return record;
  const profile = reviewedEdition(record);
  if (!profile) return record;
  const {
    persistent_paths: _paths,
    runtime_mutable_paths: _outputs,
    ...integration
  } = profile.integration;
  const candidate: AuthoredPort = {
    ...record,
    gen2recomp_windows_persistence_v1: true,
    integration,
  };
  return JSON.stringify(projectGen2RecompWindowsPersistence(candidate).integration) ===
    JSON.stringify(profile.integration)
    ? candidate
    : record;
}
