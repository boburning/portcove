import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "chocolate-doom/chocolate-doom";
const platform = "windows-x86-64";
const profiles = new Map([
  ["doom", { config: "default.cfg", screenshot: "DOOM" }],
  ["heretic", { config: "heretic.cfg", screenshot: "HTIC" }],
  ["hexen", { config: "hexen.cfg", screenshot: "HEXEN" }],
]);

function reviewedProfile(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  if (
    record.listing.project_url !== `https://github.com/${repository}` ||
    integration?.adapter !== "staged-source-portable" ||
    integration.managed_initialization !== "chocolate-family-portable-v1" ||
    JSON.stringify(integration.platforms) !== JSON.stringify([platform]) ||
    JSON.stringify(integration.channels) !== '["stable"]' ||
    integration.runtime_source_filename !== "game.wad" ||
    integration.runtime_source_materialization !== "copy" ||
    integration.launch_from_install_root !== true ||
    integration.windows_runtime_path_policy !== "relative-file-max-path" ||
    integration.game_settings !== undefined ||
    record.route_facts_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined ||
    !Object.hasOwn(integration, "presentation") ||
    !isRecord(integration.executable_hints) ||
    !isRecord(release) ||
    release.repository !== repository ||
    (release.provider !== undefined && release.provider !== "github") ||
    !isRecord(release.asset_hints)
  )
    return undefined;

  for (const [game, profile] of profiles) {
    const stem = `chocolate-${game}`;
    const extra = `${stem}.cfg`;
    if (
      JSON.stringify(integration.executable_hints[platform]) === JSON.stringify([`${stem}.exe`]) &&
      JSON.stringify(release.asset_hints[platform]) === JSON.stringify([stem, "win64.zip"]) &&
      integration.source_profile === `${stem}-pc-iwad` &&
      JSON.stringify(integration.launch_arguments) ===
        JSON.stringify([
          "-iwad",
          "game.wad",
          "-config",
          profile.config,
          "-extraconfig",
          extra,
          "-savedir",
          "savegames",
        ])
    )
      return {
        integration,
        paths: ["game.wad", profile.config, extra, "savegames", "autoload", "music-packs"],
        prefix: profile.screenshot,
      };
  }
  return undefined;
}

export function projectChocolateFamilyWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.chocolate_family_windows_persistence_v1 === undefined) return record;
  const profile = reviewedProfile(record);
  if (record.chocolate_family_windows_persistence_v1 !== true || !profile)
    throw new Error("Chocolate persistence requires the reviewed staged Windows profile.");
  if (
    ["persistent_paths", "persistent_file_patterns", "runtime_mutable_paths"].some((field) =>
      Object.hasOwn(profile.integration, field),
    )
  )
    throw new Error("Chocolate persistence already owns the persistent and mutable paths.");

  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(profile.integration)) {
    if (field === "presentation") {
      integration.persistent_paths = profile.paths;
      integration.persistent_file_patterns = [".pcx", ".png"].map((suffix) => ({
        prefix: profile.prefix,
        suffix,
      }));
      integration.runtime_mutable_paths = ["stdout.txt", "stderr.txt"];
    }
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactChocolateFamilyWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.chocolate_family_windows_persistence_v1 !== undefined) return record;
  const profile = reviewedProfile(record);
  if (!profile) return record;
  const {
    persistent_paths: _paths,
    persistent_file_patterns: _patterns,
    runtime_mutable_paths: _outputs,
    ...integration
  } = profile.integration;
  const candidate: AuthoredPort = {
    ...record,
    chocolate_family_windows_persistence_v1: true,
    integration,
  };
  return JSON.stringify(projectChocolateFamilyWindowsPersistence(candidate).integration) ===
    JSON.stringify(profile.integration)
    ? candidate
    : record;
}
