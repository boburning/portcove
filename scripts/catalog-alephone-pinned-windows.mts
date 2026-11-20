import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const project = new URL("https://github.com/Aleph-One-Marathon/alephone");
const releasePath = `${project.pathname}/releases/download/`;
const platform = "windows-x86-64";
const scenarios = new Set([
  "marathon-aleph-one",
  "marathon-2-durandal-aleph-one",
  "marathon-infinity-aleph-one",
]);
const launch = {
  launch_arguments: ["."],
  launch_environment: { ALEPHONE_DATA: ";", ALEPHONE_DEFAULT_DATA: "." },
  windows_runtime_path_policy: "relative-file-max-path",
};
const profile = {
  installation_method: "portable-package",
  source_requirements: [],
  saves_and_settings: "external-user-owned",
};
const sharedFields = ["persistent_paths", ...Object.keys(launch)];
const allowedFields = new Set([
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "release",
  "executable_hints",
  "presentation",
  ...sharedFields,
]);

function isOfficialPinUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  if (
    !url ||
    url.origin !== project.origin ||
    value !== `${url.origin}${url.pathname}` ||
    !url.pathname.startsWith(releasePath)
  )
    return false;
  const segments = url.pathname.slice(releasePath.length).split("/");
  // The reviewed tags and filenames use literal unreserved characters.
  return segments.length === 2 && segments.every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment));
}

function reviewedRoute(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  const pin = isRecord(release) && isRecord(release.direct) && release.direct[platform];
  if (
    !scenarios.has(record.listing.id) ||
    record.listing.project_url !== project.href ||
    integration?.adapter !== "native-portable" ||
    !Array.isArray(integration.platforms) ||
    integration.platforms.length !== 1 ||
    integration.platforms[0] !== platform ||
    !Array.isArray(integration.channels) ||
    integration.channels.length !== 1 ||
    integration.channels[0] !== "stable" ||
    !isRecord(release) ||
    release.provider !== "direct-manifest" ||
    Object.keys(release).length !== 2 ||
    !isRecord(release.direct) ||
    Object.keys(release.direct).length !== 1 ||
    !isRecord(pin) ||
    !isOfficialPinUrl(pin.url) ||
    record.route_facts_v1 !== undefined ||
    record.package_observation_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined ||
    Object.keys(integration).some((field) => !allowedFields.has(field)) ||
    (integration.presentation !== undefined && !isRecord(integration.presentation))
  )
    return undefined;
  return integration;
}

export function projectAlephOnePinnedWindows(record: AuthoredPort): AuthoredPort {
  if (record.alephone_pinned_windows_v1 === undefined) return record;
  const integration = reviewedRoute(record);
  if (record.alephone_pinned_windows_v1 !== true || !integration)
    throw new Error("Aleph One launch settings require a reviewed pinned Windows scenario.");
  const { presentation, ...route } = integration;
  if (
    sharedFields.some((field) => Object.hasOwn(route, field)) ||
    (isRecord(presentation) &&
      Object.keys(profile).some((field) => Object.hasOwn(presentation, field)))
  )
    throw new Error("Aleph One authoring already supplies the launch and external profile fields.");

  const { alephone_pinned_windows_v1: _recipe, ...explicit } = record;
  return {
    ...explicit,
    integration: {
      ...route,
      persistent_paths: [],
      presentation: {
        ...structuredClone(profile),
        ...(isRecord(presentation) ? presentation : {}),
      },
      ...structuredClone(launch),
    },
  };
}

export function compactAlephOnePinnedWindows(record: AuthoredPort): AuthoredPort {
  if (record.alephone_pinned_windows_v1 !== undefined) return record;
  const explicit = reviewedRoute(record);
  if (!explicit || !isRecord(explicit.presentation)) return record;
  const integration = { ...explicit };
  const presentation = { ...explicit.presentation };
  for (const field of sharedFields) delete integration[field];
  for (const field of Object.keys(profile)) delete presentation[field];
  if (Object.keys(presentation).length === 0) delete integration.presentation;
  else integration.presentation = presentation;
  const candidate: AuthoredPort = { ...record, alephone_pinned_windows_v1: true, integration };
  return JSON.stringify(projectAlephOnePinnedWindows(candidate).integration) ===
    JSON.stringify(explicit)
    ? candidate
    : record;
}
