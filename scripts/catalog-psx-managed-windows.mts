import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

// The reviewed PSXRecomp Windows kit builds the game under build-portcove.
// The packaged setup host and the generated player may have the same basename.
const runtimeLayout = {
  persistent_paths: [
    "saves",
    "settings.toml",
    "settings.toml.bad",
    "input.ini",
    "keybinds.ini",
    "config.ini",
    "disc.cfg",
    "bios.cfg",
    "mods",
    "overlay-captures",
    "overlay_captures.json",
    "overlay_captures.json.d",
    "overlay_captures.addendum.jsonl",
  ],
  runtime_mutable_paths: [
    "cache",
    "psx_freeze_heartbeat.json",
    "psx_freeze_heartbeat.json.tmp",
    "psx_last_run_report.json",
    "psx_cps_exit_trace.json",
    "netplay_lan_lobby.txt",
  ],
  runtime_mutable_file_patterns: [
    {
      prefix: "psx_freeze_dump_psx-runtime_",
      suffix: ".json",
    },
    {
      prefix: "overlay_captures.json.",
      suffix: ".tmp",
    },
  ],
  launch_environment: {
    PSX_OVERLAY_CAPTURES: "build-portcove/overlay-captures/overlay_captures.json",
  },
  launch_arguments: ["--no-launcher"],
  runtime_subdirectory: "build-portcove",
};

const explicitFields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "adapter",
  "release",
  "source_profile",
  "executable_hints",
  "presentation",
  "bios_source_profile",
]);

export function projectPsxManagedWindows(record: AuthoredPort): AuthoredPort {
  if (record.psx_managed_windows_v1 === undefined) return record;
  const integration = record.integration;
  const executable = isRecord(integration?.executable_hints)
    ? integration.executable_hints["windows-x86-64"]
    : undefined;
  if (
    record.psx_managed_windows_v1 !== true ||
    !integration ||
    integration.adapter !== "psx-recomp-managed" ||
    !Array.isArray(integration.platforms) ||
    integration.platforms.length !== 1 ||
    integration.platforms[0] !== "windows-x86-64" ||
    !isRecord(integration.release) ||
    integration.release.provider !== "github" ||
    Object.keys(integration.release).some(
      (key) => !["provider", "repository", "asset_hints"].includes(key),
    ) ||
    typeof integration.source_profile !== "string" ||
    !integration.source_profile ||
    integration.bios_source_profile !== "psx-scph-1001-bios" ||
    !Array.isArray(executable) ||
    executable.length !== 1 ||
    typeof executable[0] !== "string" ||
    !/^[^/\\:]+\.exe$/iu.test(executable[0]) ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    throw new Error(
      "PSX managed Windows authoring requires the reviewed Windows GitHub kit, a generated player, an explicit disc profile and retail SCPH-1001 BIOS.",
    );

  for (const field of Object.keys(runtimeLayout))
    if (Object.hasOwn(integration, field))
      throw new Error(
        `PSX managed Windows authoring already owns ${field}; use an explicit integration for a different layout.`,
      );

  for (const field of Object.keys(integration))
    if (!explicitFields.has(field))
      throw new Error(
        `PSX managed Windows authoring does not cover ${field}; use an explicit integration for a different layout.`,
      );

  const { presentation, bios_source_profile, ...operation } = integration;
  return {
    ...record,
    integration: {
      ...operation,
      ...structuredClone(runtimeLayout),
      ...(presentation === undefined ? {} : { presentation }),
      bios_source_profile,
    },
  };
}
