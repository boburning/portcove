import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "RSDKModding/RSDKv4-Decompilation";
const reviewedGames = new Set([
  "sonic-the-hedgehog-2013-mobile-edition-rsdkv4-decompilation",
  "sonic-the-hedgehog-2-2013-mobile-edition-rsdkv4-decompilation",
]);
const persistentPaths = [
  "Data.rsdk",
  "Data",
  "settings.ini",
  "SData.bin",
  "UData.bin",
  "mods",
  "log.txt",
  "Bytecode",
  "SGame.bin",
  "usage.txt",
];

function reviewedIntegration(record: AuthoredPort) {
  const integration = record.integration;
  const release = integration?.release;
  if (
    reviewedGames.has(record.listing.id) &&
    record.listing.project_url === `https://github.com/${repository}` &&
    integration?.adapter === "native-portable" &&
    JSON.stringify(integration.platforms) === '["windows-x86-64","linux-x86-64"]' &&
    isRecord(release) &&
    (release.provider === undefined || release.provider === "github") &&
    release.repository === repository &&
    isRecord(integration.presentation) &&
    integration.presentation.saves_and_settings === "portcove-managed" &&
    integration.persistent_file_patterns === undefined &&
    integration.runtime_subdirectory === undefined &&
    integration.game_settings === undefined &&
    record.route_facts_v1 === undefined &&
    record.settings_qualification_v1 === undefined &&
    record.settings_observation_v1 === undefined
  )
    return integration;
  return undefined;
}

export function projectRsdkv4PortableData(record: AuthoredPort): AuthoredPort {
  if (record.rsdkv4_portable_data_v1 === undefined) return record;
  const integration = reviewedIntegration(record);
  if (record.rsdkv4_portable_data_v1 !== true || !integration)
    throw new Error("RSDKv4 portable data requires a reviewed Sonic route and package source.");
  if (Object.hasOwn(integration, "persistent_paths"))
    throw new Error("RSDKv4 portable data already owns the persistent paths.");

  const projected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(integration)) {
    if (field === "presentation") projected.persistent_paths = [...persistentPaths];
    projected[field] = value;
  }
  return { ...record, integration: projected };
}

export function compactRsdkv4PortableData(record: AuthoredPort): AuthoredPort {
  if (record.rsdkv4_portable_data_v1 !== undefined) return record;
  const existing = reviewedIntegration(record);
  if (!existing) return record;

  const { persistent_paths: _paths, ...integration } = existing;
  const candidate: AuthoredPort = { ...record, rsdkv4_portable_data_v1: true, integration };
  return JSON.stringify(projectRsdkv4PortableData(candidate).integration) ===
    JSON.stringify(existing)
    ? candidate
    : record;
}
