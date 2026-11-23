import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "fabiangreffrath/crispy-doom";
const platform = "windows-x86-64";
const games = new Set(["doom", "heretic", "hexen", "strife"]);
const fields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "reviewed_package_layouts",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "release",
  "presentation",
  "executable_hints",
  "persistent_paths",
  "persistent_file_patterns",
  "windows_runtime_path_policy",
  "launch_arguments",
  "launch_environment",
  "windows_temp_directory",
]);
const persistentPaths = [
  "default.cfg",
  "crispy-doom.cfg",
  "heretic.cfg",
  "crispy-heretic.cfg",
  "hexen.cfg",
  "crispy-hexen.cfg",
  "strife.cfg",
  "crispy-strife.cfg",
  "saves",
  "levelstat.txt",
  "hexndata",
  "demos",
  "chocolat.rsp",
  "tmp.cfg",
  "extratmp.cfg",
  "doom",
  "doom.mid",
  "timidity.cfg",
  "temp.dsg",
  "recovery.dsg",
  "strfsav0.ssg",
  "strfsav1.ssg",
  "strfsav2.ssg",
  "strfsav3.ssg",
  "strfsav4.ssg",
  "strfsav5.ssg",
  "strfsav6.ssg",
  "originals",
  "temp",
];

const persistentFilePatterns = [
  {
    prefix: "DOOM",
    suffix: ".png",
  },
  {
    prefix: "DOOM",
    suffix: ".pcx",
  },
  {
    prefix: "HTIC",
    suffix: ".png",
  },
  {
    prefix: "HTIC",
    suffix: ".pcx",
  },
  {
    prefix: "HEXEN",
    suffix: ".png",
  },
  {
    prefix: "HEXEN",
    suffix: ".pcx",
  },
  {
    prefix: "STRIFE",
    suffix: ".png",
  },
  {
    prefix: "STRIFE",
    suffix: ".pcx",
  },
  {
    prefix: "demo",
    suffix: ".lmp",
  },
  {
    prefix: "doomsav",
    suffix: ".dsg",
  },
  {
    prefix: "hticsav",
    suffix: ".hsg",
  },
];

function reviewedRoute(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  const launch = integration?.launch_arguments;
  const game: unknown = Array.isArray(launch) ? launch[1] : undefined;
  if (
    record.listing.project_url !== `https://github.com/${repository}` ||
    integration?.adapter !== "native-portable" ||
    JSON.stringify(integration.channels) !== '["stable"]' ||
    JSON.stringify(integration.platforms) !== JSON.stringify([platform]) ||
    integration.windows_runtime_path_policy !== "relative-file-max-path" ||
    integration.windows_temp_directory !== "temp" ||
    JSON.stringify(integration.launch_environment) !== '{"DOOMWADDIR":"originals"}' ||
    !isRecord(release) ||
    release.repository !== repository ||
    (release.provider !== undefined && release.provider !== "github") ||
    !isRecord(release.asset_hints) ||
    !isRecord(integration.executable_hints) ||
    typeof game !== "string" ||
    !games.has(game) ||
    record.route_facts_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined ||
    Object.keys(integration).some((field) => !fields.has(field))
  )
    return undefined;

  if (
    JSON.stringify(launch) !==
      JSON.stringify(["-game", game, "-savedir", "saves", "-noautoload"]) ||
    JSON.stringify(release.asset_hints[platform]) !==
      JSON.stringify([`crispy-${game}-`, "-win64.zip"]) ||
    JSON.stringify(integration.executable_hints[platform]) !==
      JSON.stringify([`crispy-${game}-setup.exe`])
  )
    return undefined;
  return integration;
}

export function projectCrispyDoomWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.crispy_doom_windows_persistence_v1 === undefined) return record;
  const explicit = reviewedRoute(record);
  if (record.crispy_doom_windows_persistence_v1 !== true || !explicit)
    throw new Error("Crispy Doom persistence requires the reviewed Windows portable data route.");
  if (
    Object.hasOwn(explicit, "persistent_paths") ||
    Object.hasOwn(explicit, "persistent_file_patterns")
  )
    throw new Error("Crispy Doom persistence already owns the persistent paths and file patterns.");
  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(explicit)) {
    if (field === "windows_runtime_path_policy") {
      integration.persistent_paths = [...persistentPaths];
      integration.persistent_file_patterns = persistentFilePatterns.map((pattern) => ({
        ...pattern,
      }));
    }
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactCrispyDoomWindowsPersistence(record: AuthoredPort): AuthoredPort {
  if (record.crispy_doom_windows_persistence_v1 !== undefined) return record;
  const explicit = reviewedRoute(record);
  if (!explicit) return record;
  const {
    persistent_paths: _paths,
    persistent_file_patterns: _patterns,
    ...integration
  } = explicit;
  const candidate: AuthoredPort = {
    ...record,
    crispy_doom_windows_persistence_v1: true,
    integration,
  };
  return JSON.stringify(projectCrispyDoomWindowsPersistence(candidate).integration) ===
    JSON.stringify(explicit)
    ? candidate
    : record;
}
