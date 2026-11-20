import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const reviewed = new Map([
  ["star-wars-x-wing-openxw", { player: "OpenXW", repositoryId: "1393268483" }],
  [
    "star-wars-x-wing-vs-tie-fighter-balance-of-power-openxvt",
    { player: "OpenXvT", repositoryId: "1367490590" },
  ],
]);
const windows = "windows-x86-64";
const linux = "linux-x86-64";

function reviewedRoute(record: AuthoredPort) {
  const { player, repositoryId } = reviewed.get(record.listing.id) ?? {};
  const { integration } = record;
  const release = integration?.release;
  const hints = integration?.executable_hints;
  const presentation = integration?.presentation;
  const layouts = integration?.reviewed_package_layouts;
  if (
    !player ||
    integration?.adapter !== "native-portable" ||
    JSON.stringify(integration.channels) !== '["stable"]' ||
    JSON.stringify(integration.platforms) !== JSON.stringify([windows, linux]) ||
    integration.source_profile !== undefined ||
    record.upstream_lineage?.origin.repository?.host !== "github.com" ||
    record.upstream_lineage.origin.repository.id !== repositoryId ||
    !isRecord(release) ||
    release.repository !== `elyosh/${player}` ||
    record.listing.project_url !== `https://github.com/${release.repository}` ||
    Object.keys(release).some(
      (field) => !["repository", "asset_hints", "linux_tar_xz"].includes(field),
    ) ||
    !isRecord(hints) ||
    JSON.stringify(hints) !== JSON.stringify({ [windows]: [`${player}.exe`], [linux]: [player] }) ||
    !isRecord(layouts) ||
    !isRecord(layouts[windows]) ||
    !isRecord(layouts[linux]) ||
    !isRecord(presentation) ||
    presentation.installation_method !== "portable-package" ||
    !Array.isArray(presentation.source_requirements) ||
    presentation.source_requirements.length !== 0 ||
    presentation.saves_and_settings !== "external-user-owned"
  )
    return undefined;
  return { integration, release };
}

export function projectOpenXPortable(record: AuthoredPort): AuthoredPort {
  if (record.openx_portable_v1 === undefined) return record;
  const route = reviewedRoute(record);
  if (record.openx_portable_v1 !== true || !route)
    throw new Error("OpenX portable facts require a reviewed OpenXW or OpenXvT GitHub route.");
  if (
    Object.hasOwn(route.release, "asset_hints") ||
    Object.hasOwn(route.release, "linux_tar_xz") ||
    Object.hasOwn(route.integration, "persistent_paths")
  )
    throw new Error(
      "OpenX portable facts already own release selectors, Linux TAR.XZ and persistent paths.",
    );

  const integration: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(route.integration)) {
    integration[field] =
      field === "release"
        ? {
            ...route.release,
            asset_hints: {
              [windows]: ["-windows-x86_64-release.zip"],
              [linux]: ["-linux-x86_64-release.tar.xz"],
            },
            linux_tar_xz: true,
          }
        : value;
    if (field === "executable_hints") integration.persistent_paths = ["config.yaml"];
  }
  const { openx_portable_v1: _recipe, ...explicit } = record;
  return { ...explicit, integration };
}

export function compactOpenXPortable(record: AuthoredPort): AuthoredPort {
  if (record.openx_portable_v1 !== undefined) return record;
  const route = reviewedRoute(record);
  if (!route) return record;
  const { persistent_paths: _paths, ...integration } = route.integration;
  const { asset_hints: _hints, linux_tar_xz: _tar, ...release } = route.release;
  const candidate: AuthoredPort = {
    ...record,
    openx_portable_v1: true,
    integration: { ...integration, release },
  };
  return JSON.stringify(projectOpenXPortable(candidate).integration) ===
    JSON.stringify(route.integration)
    ? candidate
    : record;
}
