import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "ReflectionHLE/ReflectionHLE";
const portableIntegrationFields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "windows_runtime_path_policy",
  "release",
  "executable_hints",
  "launch_arguments",
  "persistent_paths",
  "presentation",
  "reviewed_package_layouts",
]);
const persistentPaths = [
  "bh071592",
  "bh071592.txt",
  "bm1v10r",
  "bm1v10r.txt",
  "bm1v10s",
  "bm1v10s.txt",
  "bm1v11f",
  "bm1v11f.txt",
  "bm1v11gm",
  "bm1v11gm.txt",
  "bm1v11r",
  "bm1v11r.txt",
  "bm1v11s",
  "bm1v11s.txt",
  "bm2v10r",
  "bm2v10r.txt",
  "bm2v11f",
  "bm2v11f.txt",
  "bm2v11r",
  "bm2v11r.txt",
  "bm3v10r",
  "bm3v10r.txt",
  "bm3v11f",
  "bm3v11f.txt",
  "bm3v11r",
  "bm3v11r.txt",
  "cat3d100",
  "cat3d100.txt",
  "cat3d122",
  "cat3d122.txt",
  "catabyss113",
  "catabyss113.txt",
  "catabyss124",
  "catabyss124.txt",
  "catapoc101",
  "catapoc101.txt",
  "catarm102",
  "catarm102.txt",
  "gamecontrollerdb.txt",
  "kdreams2015",
  "kdreams2015.txt",
  "kdreamsc100",
  "kdreamsc100.txt",
  "kdreamsc105",
  "kdreamsc105.txt",
  "kdreamse100",
  "kdreamse100.txt",
  "kdreamse113",
  "kdreamse113.txt",
  "kdreamse120",
  "kdreamse120.txt",
  "kdreamse193",
  "kdreamse193.txt",
  "n3dwt10",
  "n3dwt10.txt",
  "reflection-bmenace.cfg",
  "reflection-cat3d.cfg",
  "reflection-kdreams.cfg",
  "reflection-wolf3d.cfg",
  "reflectionhle.cfg",
  "sd2ac14",
  "sd2ac14.txt",
  "sd2fg10",
  "sd2fg10.txt",
  "sd2fg14",
  "sd2fg14.txt",
  "sd3ac14",
  "sd3ac14.txt",
  "sd3fg10",
  "sd3fg10.txt",
  "sd3fg14",
  "sd3fg14.txt",
  "sdmfg10",
  "sdmfg10.txt",
  "sodac14",
  "sodac14.txt",
  "sodfg10",
  "sodfg10.txt",
  "sodfg14",
  "sodfg14.txt",
  "wj6im14",
  "wj6im14.txt",
  "wl1ap10",
  "wl1ap10.txt",
  "wl1ap11",
  "wl1ap11.txt",
  "wl1ap12",
  "wl1ap12.txt",
  "wl1ap14",
  "wl1ap14.txt",
  "wl3ap12",
  "wl3ap12.txt",
  "wl3ap14",
  "wl3ap14.txt",
  "wl6ac14",
  "wl6ac14.txt",
  "wl6ap11",
  "wl6ap11.txt",
  "wl6ap12",
  "wl6ap12.txt",
  "wl6ap14",
  "wl6ap14.txt",
  "wl6gt14a",
  "wl6gt14a.txt",
  "wl6gt14b",
  "wl6gt14b.txt",
  "wl6id14",
  "wl6id14.txt",
  "wl920312",
  "wl920312.txt",
];

function portableRoute(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  if (
    record.listing.project_url !== `https://github.com/${repository}` ||
    integration?.adapter !== "native-portable" ||
    !isRecord(release) ||
    release.repository !== repository ||
    (release.provider !== undefined && release.provider !== "github") ||
    !isRecord(integration.presentation) ||
    JSON.stringify(integration.launch_arguments) !==
      JSON.stringify(["-datadir", ".", "-cfgdir", "."]) ||
    record.route_facts_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined ||
    Object.keys(integration).some((field) => !portableIntegrationFields.has(field))
  )
    return undefined;
  return integration;
}

export function projectReflectionHlePortablePaths(record: AuthoredPort): AuthoredPort {
  if (record.reflectionhle_portable_paths_v1 === undefined) return record;
  const explicit = portableRoute(record);
  if (record.reflectionhle_portable_paths_v1 !== true || !explicit)
    throw new Error("ReflectionHLE portable paths require the reviewed portable root layout.");
  if (Object.hasOwn(explicit, "persistent_paths"))
    throw new Error("ReflectionHLE portable paths already own persistent_paths.");

  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(explicit)) {
    if (field === "presentation") integration.persistent_paths = [...persistentPaths];
    integration[field] = value;
  }
  return { ...record, integration };
}

export function compactReflectionHlePortablePaths(record: AuthoredPort): AuthoredPort {
  if (record.reflectionhle_portable_paths_v1 !== undefined || !portableRoute(record)) return record;
  const integration = { ...record.integration };
  delete integration.persistent_paths;
  const candidate: AuthoredPort = { ...record, reflectionhle_portable_paths_v1: true, integration };
  return JSON.stringify(projectReflectionHlePortablePaths(candidate).integration) ===
    JSON.stringify(record.integration)
    ? candidate
    : record;
}
