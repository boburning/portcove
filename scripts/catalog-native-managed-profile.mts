import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const directory = "profile";
const defaults = {
  windows_runtime_path_policy: "relative-file-max-path",
  persistent_paths: [directory],
  windows_temp_directory: directory,
};
const families = new Map([
  [
    "bibendovsky/bstone",
    {
      profileFlags: ["--profile_dir"],
      pathPolicyBefore: "launch_arguments",
      tempDirectoryAfter: "runtime_source_set",
    },
  ],
  [
    "diasurgical/DevilutionX",
    {
      profileFlags: ["--save-dir", "--config-dir"],
      pathPolicyBefore: "source_profile",
      tempDirectoryAfter: "launch_arguments",
    },
  ],
]);

function reviewedProfile(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  const presentation = integration?.presentation;
  if (
    integration?.adapter !== "native-portable" ||
    !isRecord(release) ||
    (release.provider !== undefined && release.provider !== "github") ||
    typeof release.repository !== "string" ||
    record.listing.project_url !== `https://github.com/${release.repository}` ||
    typeof integration.source_profile !== "string" ||
    !Array.isArray(integration.runtime_source_set) ||
    integration.runtime_source_set.length === 0 ||
    !Array.isArray(integration.platforms) ||
    !integration.platforms.includes("windows-x86-64") ||
    !Array.isArray(integration.launch_arguments) ||
    !isRecord(presentation) ||
    presentation.saves_and_settings !== "portcove-managed"
  )
    return undefined;
  const layout = families.get(release.repository);
  const args: unknown[] = integration.launch_arguments;
  if (
    !layout ||
    !layout.profileFlags.every(
      (flag) =>
        args.indexOf(flag) >= 0 &&
        args.indexOf(flag) === args.lastIndexOf(flag) &&
        args[args.indexOf(flag) + 1] === directory,
    )
  )
    return undefined;
  return { integration, ...layout };
}

export function projectNativeManagedProfile(record: AuthoredPort): AuthoredPort {
  if (record.native_managed_profile_v1 === undefined) return record;
  const layout = reviewedProfile(record);
  if (record.native_managed_profile_v1 !== true || !layout)
    throw new Error("The managed profile requires a reviewed BStone or DevilutionX profile route.");
  const { integration, pathPolicyBefore, tempDirectoryAfter } = layout;
  if (Object.keys(defaults).some((key) => Object.hasOwn(integration, key)))
    throw new Error(
      "The managed profile already supplies the profile directory and Windows policy.",
    );

  // Keep the field order of each accepted integration for reproducible output.
  const projected: [string, unknown][] = [];
  for (const [key, value] of Object.entries(integration)) {
    if (key === pathPolicyBefore)
      projected.push(["windows_runtime_path_policy", defaults.windows_runtime_path_policy]);
    projected.push([key, value]);
    if (key === "launch_arguments")
      projected.push(["persistent_paths", [...defaults.persistent_paths]]);
    if (key === tempDirectoryAfter)
      projected.push(["windows_temp_directory", defaults.windows_temp_directory]);
  }
  const { native_managed_profile_v1: _recipe, ...explicit } = record;
  return { ...explicit, integration: Object.fromEntries(projected) };
}

export function compactNativeManagedProfile(record: AuthoredPort): AuthoredPort {
  if (record.native_managed_profile_v1 !== undefined) return record;
  const layout = reviewedProfile(record);
  if (!layout) return record;
  const integration = { ...layout.integration };
  for (const key of Object.keys(defaults)) delete integration[key];
  const candidate: AuthoredPort = { ...record, native_managed_profile_v1: true, integration };
  return JSON.stringify(projectNativeManagedProfile(candidate).integration) ===
    JSON.stringify(layout.integration)
    ? candidate
    : record;
}
