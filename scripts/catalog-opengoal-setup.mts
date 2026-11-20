import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "open-goal/jak-project";
const projectUrl = `https://github.com/${repository}`;
const games = new Map([
  ["opengoal-jak1", { token: "jak1", id: "jak-and-daxter-the-precursor-legacy" }],
  ["opengoal-jak2", { token: "jak2", id: "jak-ii" }],
  ["opengoal-jak3", { token: "jak3", id: "jak-3" }],
]);
const explicitFields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "release",
  "source_profile",
  "presentation",
]);

function reviewedSetup(record: AuthoredPort) {
  const game = games.get(record.listing.id);
  const original = record.listing.original_game;
  const origin = record.upstream_lineage?.origin;
  const integration = record.integration;
  const release = integration?.release;
  const presentation = integration?.presentation;
  const source = isRecord(presentation) ? presentation.source_requirements : undefined;
  const edition = original?.source_editions[0];
  if (
    !game ||
    record.listing.project_url !== projectUrl ||
    (origin !== undefined &&
      (origin.project_url !== projectUrl ||
        (origin.repository !== undefined &&
          (origin.repository.host !== "github.com" || origin.repository.id !== "289585720")))) ||
    original?.id !== game.id ||
    original.source_editions.length !== 1 ||
    edition?.id !== `${game.id}-playstation-2` ||
    edition.system !== "playstation-2" ||
    integration?.adapter !== "upstream-managed-setup" ||
    JSON.stringify(integration.platforms) !== JSON.stringify(Object.keys(executableHints("gk"))) ||
    integration.source_profile !== `opengoal-${game.token}-disc` ||
    !isRecord(release) ||
    release.repository !== repository ||
    (release.provider !== undefined && release.provider !== "github") ||
    !isRecord(presentation) ||
    presentation.installation_method !== "upstream-setup" ||
    presentation.saves_and_settings !== "portcove-managed" ||
    !Array.isArray(source) ||
    source.length !== 1 ||
    !isRecord(source[0]) ||
    source[0].role !== "game" ||
    source[0].profile_id !== integration.source_profile ||
    source[0].verification !== "upstream-validator" ||
    record.route_facts_v1 !== undefined ||
    record.package_observation_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    return undefined;
  return { token: game.token, integration, presentation };
}

function executableHints(executable: string) {
  return {
    "windows-x86-64": [`${executable}.exe`],
    "linux-x86-64": [executable],
    "macos-x86-64": [executable],
    "macos-aarch64": [executable],
  };
}

export function projectOpenGoalSetup(record: AuthoredPort): AuthoredPort {
  if (record.opengoal_setup_v1 === undefined) return record;
  const setup = reviewedSetup(record);
  if (record.opengoal_setup_v1 !== true || !setup)
    throw new Error("OpenGOAL setup requires the reviewed project, game, and disc profile.");
  const { integration, presentation, token } = setup;
  if (Object.keys(integration).some((field) => !explicitFields.has(field)))
    throw new Error("OpenGOAL setup already supplies the extractor, launcher, and data paths.");

  const { opengoal_setup_v1: _recipe, ...projected } = record;
  const { presentation: _presentation, ...explicit } = integration;
  return {
    ...projected,
    integration: {
      ...explicit,
      runtime_source_filename: "source.iso",
      runtime_source_materialization: "ps2-iso",
      setup_executable_hints: executableHints("extractor"),
      setup_arguments: [
        "--game",
        token,
        "--extract",
        "--decompile",
        "--compile",
        "--validate",
        "--disable-ansi",
      ],
      setup_marker: `data/out/${token}/iso/0COMMON.TXT`,
      launch_arguments: ["--game", token, "--portable"],
      executable_hints: executableHints("gk"),
      runtime_mutable_paths: ["data/log", "data/imgui.ini"],
      persistent_paths: [`OpenGOAL/${token}`],
      setup_output_paths: ["data/iso_data", "data/decompiler_out", "data/out"],
      presentation,
    },
  };
}

export function compactOpenGoalSetup(record: AuthoredPort): AuthoredPort {
  if (record.opengoal_setup_v1 !== undefined) return record;
  const setup = reviewedSetup(record);
  if (!setup) return record;
  const integration = Object.fromEntries(
    Object.entries(setup.integration).filter(([field]) => explicitFields.has(field)),
  );
  const candidate: AuthoredPort = { ...record, opengoal_setup_v1: true, integration };
  return JSON.stringify(projectOpenGoalSetup(candidate).integration) ===
    JSON.stringify(setup.integration)
    ? candidate
    : record;
}
