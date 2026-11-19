import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

// The reviewed PSXRecomp kits build the game under build-portcove.
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
    "psx_crash.txt",
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

// PSXRecomp 7192402 also creates the player's HD texture replacements and
// dumps under mods/texture-packs/<game id> on every start.
const splitModPaths = [
  "mods/installed",
  "mods/packages",
  "mods/.staging",
  "mods/state.toml",
  "mods/state.toml.tmp",
  "mods/texture-packs",
];

// Retail BIOS profiles a reviewed kit's own `bios_config` can name. Core's
// kit guard (psx.rs `kit_bios_profile`) maps the same images.
const retailBiosProfiles = new Set<unknown>([
  "psx-scph-1001-bios",
  "psx-scph-5552-bios",
  "psx-scph-5500-bios",
]);

const multidiscFields = [
  "runtime_source_filename",
  "launch_disc_choice",
  "runtime_source_materialization",
] as const;

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
  ...multidiscFields,
]);

function isAssetSelector(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((hint) => typeof hint === "string" && hint.trim())
  );
}

class PsxLayoutMismatch extends Error {}

/** Prefer a shared layout only when it reproduces the exact authored integration. */
export function compactPsxManagedWindows(record: AuthoredPort): AuthoredPort {
  const { integration } = record;
  if (record.psx_managed_windows_v1 !== undefined || integration?.adapter !== "psx-recomp-managed")
    return record;
  const layoutFields = Object.keys(runtimeLayout);
  if (layoutFields.some((field) => !Object.hasOwn(integration, field))) return record;
  const explicitIntegration = JSON.stringify(integration);
  const facts = { ...integration };
  for (const field of layoutFields) delete facts[field];
  const layouts = [true, "bundled-openbios", "split-mods", "split-mods-openbios"] as const;
  for (const layout of layouts) {
    const proposed = { ...record, psx_managed_windows_v1: layout, integration: facts };
    try {
      if (JSON.stringify(projectPsxManagedWindows(proposed).integration) === explicitIntegration)
        return proposed;
    } catch (error) {
      if (!(error instanceof PsxLayoutMismatch)) throw error;
    }
  }
  return record;
}

export function projectPsxManagedWindows(record: AuthoredPort): AuthoredPort {
  const layout = record.psx_managed_windows_v1;
  if (layout === undefined) return record;
  const bundledOpenBios = layout === "bundled-openbios" || layout === "split-mods-openbios";
  const splitMods = layout === "split-mods" || layout === "split-mods-openbios";
  const integration = record.integration;
  const executableHints = isRecord(integration?.executable_hints)
    ? integration.executable_hints
    : {};
  const executable = executableHints["windows-x86-64"];
  const linuxExecutable = executableHints["linux-x86-64"];
  const assetHints = isRecord(integration?.release) ? integration.release.asset_hints : undefined;
  const linuxAssets = isRecord(assetHints) ? assetHints["linux-x86-64"] : undefined;
  const windowsAssets = isRecord(assetHints) ? assetHints["windows-x86-64"] : undefined;
  const biosProfile = integration?.bios_source_profile;
  if (
    (layout !== true && !bundledOpenBios && !splitMods) ||
    !integration ||
    integration.adapter !== "psx-recomp-managed" ||
    !Array.isArray(integration.platforms) ||
    integration.platforms[0] !== "windows-x86-64" ||
    (integration.platforms.length !== 1 &&
      (integration.platforms.length !== 2 || integration.platforms[1] !== "linux-x86-64")) ||
    !isRecord(integration.release) ||
    integration.release.provider !== "github" ||
    Object.keys(integration.release).some(
      (key) => !["provider", "repository", "asset_hints"].includes(key),
    ) ||
    typeof integration.source_profile !== "string" ||
    !integration.source_profile ||
    (bundledOpenBios
      ? Object.hasOwn(integration, "bios_source_profile")
      : !retailBiosProfiles.has(biosProfile)) ||
    !Array.isArray(executable) ||
    executable.length !== 1 ||
    typeof executable[0] !== "string" ||
    !/^[^/\\:]+\.exe$/iu.test(executable[0]) ||
    (integration.platforms.length === 2 &&
      (!Array.isArray(linuxExecutable) ||
        linuxExecutable.length !== 1 ||
        linuxExecutable[0] !== executable[0].slice(0, -4) ||
        !isAssetSelector(linuxAssets))) ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    throw new PsxLayoutMismatch(
      "PSX managed Windows authoring requires the reviewed Windows GitHub kit, a generated player, an explicit disc profile and either retail SCPH-1001 BIOS, an explicit retail SCPH-5552 or SCPH-5500 BIOS, or explicit bundled OpenBIOS without a retail profile. A Linux x64 sibling requires the same generated player basename and an explicit asset selector.",
    );

  if (
    splitMods &&
    (integration.platforms.length !== 2 ||
      !isRecord(assetHints) ||
      Object.keys(assetHints).length !== 2 ||
      !isAssetSelector(windowsAssets) ||
      !isAssetSelector(linuxAssets) ||
      windowsAssets.length !== 2 ||
      linuxAssets.length !== 2 ||
      windowsAssets[0] !== linuxAssets[0] ||
      windowsAssets[1] !== "-windows-x64.zip" ||
      linuxAssets[1] !== "-linux-x64.zip" ||
      Object.keys(executableHints).length !== 2)
  )
    throw new PsxLayoutMismatch(
      "PSX split-mods authoring requires exact Windows and Linux x64 kit selectors and generated players.",
    );

  const hasMultidiscContract = multidiscFields.some((field) => Object.hasOwn(integration, field));
  if (
    hasMultidiscContract &&
    (layout !== "split-mods" ||
      integration.runtime_source_filename !== "runtime-discs" ||
      integration.launch_disc_choice !== "psx-settings-selected" ||
      integration.runtime_source_materialization !== "psx-raw-set")
  )
    throw new PsxLayoutMismatch(
      "PSX multidisc authoring requires the retail split-mods kit and its reviewed raw-disc settings contract.",
    );

  for (const field of Object.keys(runtimeLayout))
    if (Object.hasOwn(integration, field))
      throw new PsxLayoutMismatch(
        `PSX managed Windows authoring already owns ${field}; use an explicit integration for a different layout.`,
      );

  for (const field of Object.keys(integration))
    if (!explicitFields.has(field))
      throw new PsxLayoutMismatch(
        `PSX managed Windows authoring does not cover ${field}; use an explicit integration for a different layout.`,
      );

  const {
    presentation,
    bios_source_profile,
    runtime_source_filename,
    launch_disc_choice,
    runtime_source_materialization,
    ...operation
  } = integration;
  const projectedLayout = structuredClone(runtimeLayout);
  if (splitMods) {
    projectedLayout.persistent_paths = projectedLayout.persistent_paths.flatMap((path) =>
      path === "mods" ? splitModPaths : [path],
    );
  }
  return {
    ...record,
    integration: {
      ...operation,
      ...projectedLayout,
      ...(bundledOpenBios
        ? { launch_arguments: ["--no-launcher", "--bios", "bios/openbios.bin"] }
        : {}),
      ...(presentation === undefined ? {} : { presentation }),
      ...(bios_source_profile === undefined ? {} : { bios_source_profile }),
      ...(hasMultidiscContract
        ? { runtime_source_filename, launch_disc_choice, runtime_source_materialization }
        : {}),
    },
  };
}
