import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const platform = "windows-x86-64";
const executable = "raze.exe";
const portableMarker = "raze_portable.ini";
const repository = "ZDoom/Raze";
const explicitIntegrationFields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "release",
  "presentation",
]);
const generatedIntegrationFields = [
  "executable_hints",
  "persistent_paths",
  "portable_marker_file",
  "reviewed_package_layouts",
];

function reviewedRoute(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  if (
    record.listing.project_url !== `https://github.com/${repository}` ||
    integration?.adapter !== "native-portable" ||
    !Array.isArray(integration.platforms) ||
    integration.platforms.length !== 1 ||
    integration.platforms[0] !== platform ||
    !Array.isArray(integration.channels) ||
    integration.channels.length !== 1 ||
    integration.channels[0] !== "stable" ||
    !isRecord(release) ||
    release.repository !== repository ||
    record.route_facts_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    return undefined;
  return { integration, release };
}

function hasOnlyExplicitFields(
  integration: Record<string, unknown>,
  release: Record<string, unknown>,
) {
  return (
    Object.keys(release).length === 1 &&
    Object.keys(integration).every((field) => explicitIntegrationFields.has(field))
  );
}

export function projectRazeWindowsProfile(record: AuthoredPort): AuthoredPort {
  if (record.raze_windows_profile_v1 === undefined) return record;
  const route = reviewedRoute(record);
  if (record.raze_windows_profile_v1 !== true || !route)
    throw new Error("The Raze Windows profile requires the reviewed stable ZDoom/Raze route.");

  const { integration, release } = route;
  if (!hasOnlyExplicitFields(integration, release))
    throw new Error("The Raze Windows profile supplies its package and data paths.");

  const { presentation, ...operation } = integration;
  return {
    ...record,
    integration: {
      ...operation,
      release: { ...release, asset_hints: { [platform]: ["Raze-", "-windows.zip"] } },
      executable_hints: { [platform]: [executable] },
      persistent_paths: [portableMarker, "Save", "Screenshots", "Demos", "autoexec.cfg"],
      portable_marker_file: portableMarker,
      ...(presentation === undefined ? {} : { presentation }),
      reviewed_package_layouts: {
        [platform]: { directories: ["soundfonts"], executables: [executable] },
      },
    },
  };
}

export function compactRazeWindowsProfile(record: AuthoredPort): AuthoredPort {
  if (record.raze_windows_profile_v1 !== undefined) return record;
  const route = reviewedRoute(record);
  if (!route) return record;
  const release = { ...route.release };
  delete release.asset_hints;
  const integration: Record<string, unknown> = { ...route.integration, release };
  for (const field of generatedIntegrationFields) delete integration[field];
  if (!hasOnlyExplicitFields(integration, release)) return record;

  const candidate: AuthoredPort = { ...record, raze_windows_profile_v1: true, integration };
  return JSON.stringify(projectRazeWindowsProfile(candidate).integration) ===
    JSON.stringify(record.integration)
    ? candidate
    : record;
}
