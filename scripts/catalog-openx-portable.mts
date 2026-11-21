import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const windows = "windows-x86-64";
const linux = "linux-x86-64";

function hasReviewedExecutable(layout: unknown, executable: string) {
  return (
    isRecord(layout) &&
    Array.isArray(layout.executables) &&
    layout.executables.includes(executable.toLowerCase())
  );
}

function reviewedRoute(record: AuthoredPort) {
  const { integration } = record;
  const release = integration?.release;
  const hints = integration?.executable_hints;
  const presentation = integration?.presentation;
  const layouts = integration?.reviewed_package_layouts;
  const lineage = record.upstream_lineage;
  const origin = lineage?.origin;
  const repository = origin?.repository;
  const linuxHints = isRecord(hints) ? hints[linux] : undefined;
  const player: unknown = Array.isArray(linuxHints) ? linuxHints[0] : undefined;
  if (
    typeof player !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(player) ||
    integration?.adapter !== "native-portable" ||
    JSON.stringify(integration.channels) !== '["stable"]' ||
    JSON.stringify(integration.platforms) !== JSON.stringify([windows, linux]) ||
    integration.source_profile !== undefined ||
    repository?.host !== "github.com" ||
    !/^[1-9][0-9]*$/u.test(repository.id) ||
    lineage?.target_key !== record.listing.id ||
    origin?.project_url !== record.listing.project_url ||
    !isRecord(release) ||
    typeof release.repository !== "string" ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(release.repository) ||
    record.listing.project_url !== `https://github.com/${release.repository}` ||
    Object.keys(release).some(
      (field) => !["repository", "asset_hints", "linux_tar_xz"].includes(field),
    ) ||
    !isRecord(hints) ||
    JSON.stringify(hints) !== JSON.stringify({ [windows]: [`${player}.exe`], [linux]: [player] }) ||
    !isRecord(layouts) ||
    !hasReviewedExecutable(layouts[windows], `${player}.exe`) ||
    !hasReviewedExecutable(layouts[linux], player) ||
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
    throw new Error(
      "Portable package facts require matching GitHub lineage, executable hints and reviewed layouts.",
    );
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
