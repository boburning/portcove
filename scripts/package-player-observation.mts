import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "./runtime-values.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

export const packageProjectionValidator = {
  id: "accepted-package-player-header-v1",
  sha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
};
export interface PackagePlayerObservationV1 {
  format_version: 1;
  port_id: string;
  repository: string;
  source_revision: string;
  selection_sha256: string;
  artifact: { id: number; name: string; url: string; bytes: number; sha256: string };
  player: { path: string; bytes: number; sha256: string; machine: string; header_bytes: number };
  provenance: { receipt_sha256: string; reference: string };
  scope_sha256: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
function bounded(value: unknown, maximum = 4096): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("Unknown package observation field.");
}
function repository(record: AuthoredPort) {
  const url = new URL(record.listing.project_url);
  return url.protocol === "https:" &&
    url.hostname === "github.com" &&
    !url.username &&
    !url.password &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(url.pathname)
    ? url.pathname.replace(/^\//u, "").replace(/\/$/u, "")
    : undefined;
}
function selection(record: AuthoredPort) {
  const player = record.route_facts_v1?.prepared_player;
  if (!player) return undefined;
  const hints = isRecord(record.integration?.executable_hints)
    ? record.integration.executable_hints["windows-x86-64"]
    : undefined;
  const executable =
    player.executable ??
    (Array.isArray(hints) && hints.length === 1 && typeof hints[0] === "string"
      ? hints[0]
      : undefined);
  return executable
    ? {
        port_id: record.listing.id,
        repository: repository(record),
        executable,
        working_directory: player.working_directory,
        arguments: player.arguments,
      }
    : undefined;
}
function scope(value: {
  port_id: unknown;
  repository: unknown;
  source_revision: unknown;
  selection_sha256: unknown;
  artifact: unknown;
  player: unknown;
}) {
  const artifact = isRecord(value.artifact) ? value.artifact : {},
    player = isRecord(value.player) ? value.player : {};
  return {
    port_id: value.port_id,
    repository: value.repository,
    source_revision: value.source_revision,
    selection_sha256: value.selection_sha256,
    artifact: {
      id: artifact.id,
      name: artifact.name,
      url: artifact.url,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    player: {
      path: player.path,
      bytes: player.bytes,
      sha256: player.sha256,
      machine: player.machine,
      header_bytes: player.header_bytes,
    },
  };
}
function relative(value: unknown): value is string {
  return (
    bounded(value, 1024) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Syntax/content binding only; an unsigned receipt is never publication or execution authority. */
export function checkPackagePlayerObservation(
  value: unknown,
): asserts value is PackagePlayerObservationV1 {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !bounded(value.port_id, 128) ||
    !bounded(value.repository, 512) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) ||
    typeof value.source_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source_revision) ||
    !sha(value.selection_sha256) ||
    !isRecord(value.artifact) ||
    !isRecord(value.player) ||
    !isRecord(value.provenance)
  )
    throw new Error("Invalid accepted package/player observation envelope.");
  exact(value, [
    "format_version",
    "port_id",
    "repository",
    "source_revision",
    "selection_sha256",
    "artifact",
    "player",
    "provenance",
    "scope_sha256",
  ]);
  exact(value.artifact, ["id", "name", "url", "bytes", "sha256"]);
  exact(value.player, ["path", "bytes", "sha256", "machine", "header_bytes"]);
  exact(value.provenance, ["receipt_sha256", "reference"]);
  const artifact = value.artifact,
    player = value.player;
  if (
    !positive(artifact.id) ||
    !positive(artifact.bytes) ||
    artifact.bytes > 512 * 1024 * 1024 ||
    !bounded(artifact.name, 512) ||
    !sha(artifact.sha256) ||
    !bounded(artifact.url)
  )
    throw new Error("Invalid exact package identity.");
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.toLowerCase().startsWith(`/${value.repository.toLowerCase()}/releases/download/`)
  )
    throw new Error("Package identity escapes its observed upstream.");
  if (
    !relative(player.path) ||
    !positive(player.bytes) ||
    player.bytes > 512 * 1024 * 1024 ||
    !sha(player.sha256) ||
    !bounded(player.machine, 16) ||
    !/^0x[0-9a-f]{4}$/iu.test(player.machine) ||
    !positive(player.header_bytes) ||
    player.header_bytes < 88 ||
    player.header_bytes > 1024 * 1024 ||
    player.header_bytes > player.bytes ||
    !sha(value.provenance.receipt_sha256) ||
    !relative(value.provenance.reference)
  )
    throw new Error("Invalid exact selected-player evidence.");
  if (
    !sha(value.scope_sha256) ||
    hash(
      scope({
        port_id: value.port_id,
        repository: value.repository,
        source_revision: value.source_revision,
        selection_sha256: value.selection_sha256,
        artifact: value.artifact,
        player: value.player,
      }),
    ) !== value.scope_sha256
  )
    throw new Error("Selected package/player observation scope changed.");
}

/** Consume a previously accepted complete inspection row; do not fetch or execute bytes. */
export function acceptPackagePlayerObservation(
  record: AuthoredPort,
  raw: unknown,
  reference: string,
  retained = record.package_observation_v1,
): PackagePlayerObservationV1 {
  if (retained) checkPackagePlayerObservation(retained);
  const chosen = selection(record);
  if (
    !chosen ||
    !chosen.repository ||
    !isRecord(raw) ||
    raw.id !== record.listing.id ||
    typeof raw.source_repository !== "string" ||
    raw.source_repository.toLowerCase() !== chosen.repository.toLowerCase() ||
    typeof raw.source_revision !== "string" ||
    !isRecord(raw.official_asset) ||
    !Array.isArray(raw.selected_executables) ||
    raw.selected_executables.length > 128 ||
    raw.expected_digest_matched !== true ||
    !sha(raw.observed_archive_sha256) ||
    raw.official_asset.digest !== `sha256:${raw.observed_archive_sha256}`
  )
    throw new Error(
      "Accepted package observation needs exact title, upstream, independently expected archive and stable player selection.",
    );
  const members: unknown[] = raw.selected_executables;
  const matches = members.filter(
    (member) =>
      isRecord(member) &&
      typeof member.path === "string" &&
      member.path.split("/").at(-1)?.toLowerCase() === chosen.executable.toLowerCase(),
  );
  if (matches.length !== 1 || !isRecord(matches[0]))
    throw new Error(
      "Selected player observation is missing or ambiguous; installer/launcher headers cannot stand in for a child player.",
    );
  const player = matches[0];
  if (
    player.full_member_CRC_verified !== true ||
    !isRecord(player.pe_prefix) ||
    !isRecord(raw.raw_preparser) ||
    raw.raw_preparser.raw_names_bound_before_parser !== true
  )
    throw new Error("Selected player/archive coverage is incomplete.");
  // An existing receipt's spelling and selection hash remain exact historical
  // bindings. Only GitHub identity comparison is case-insensitive.
  const boundSelection = {
    ...chosen,
    repository:
      retained?.repository.toLowerCase() === chosen.repository.toLowerCase()
        ? retained.repository
        : raw.source_repository,
  };
  const observation = {
    format_version: 1 as const,
    port_id: record.listing.id,
    repository: boundSelection.repository,
    source_revision: raw.source_revision,
    selection_sha256: hash(boundSelection),
    artifact: {
      id: raw.official_asset.id,
      name: raw.official_asset.name,
      url: raw.official_asset.browser_download_url,
      bytes: raw.official_asset.size,
      sha256: raw.observed_archive_sha256,
    },
    player: {
      path: player.path,
      bytes: player.bytes,
      sha256: player.sha256,
      machine: player.pe_prefix.machine,
      header_bytes: player.pe_prefix.bytes_retained,
    },
    provenance: { receipt_sha256: hash(raw), reference },
  };
  const result = { ...observation, scope_sha256: hash(scope(observation)) };
  checkPackagePlayerObservation(result);
  checkPackagePlayerObservationContinuity(retained, result);
  return result;
}

/** Preserve accepted descriptive byte identities across every preparation input route. */
export function checkPackagePlayerObservationContinuity(
  previous: PackagePlayerObservationV1 | undefined,
  next: PackagePlayerObservationV1,
) {
  checkPackagePlayerObservation(next);
  if (previous) checkPackagePlayerObservation(previous);
  if (
    previous &&
    previous.repository.toLowerCase() === next.repository.toLowerCase() &&
    previous.artifact.id === next.artifact.id &&
    (previous.artifact.sha256 !== next.artifact.sha256 ||
      previous.artifact.bytes !== next.artifact.bytes ||
      previous.artifact.name !== next.artifact.name ||
      previous.artifact.url !== next.artifact.url ||
      (previous.player.path === next.player.path &&
        (previous.player.sha256 !== next.player.sha256 ||
          previous.player.bytes !== next.player.bytes)))
  )
    throw new Error(
      "Previously accepted bytes changed under the same package/member identity; preserve the retained observation.",
    );
}

export function packagePlayerProjectionKey(
  record: AuthoredPort,
  observation: PackagePlayerObservationV1,
  validator = packageProjectionValidator,
) {
  checkPackagePlayerObservation(observation);
  const chosen = selection(record);
  return hash({
    scope: observation.scope_sha256,
    selection: chosen && { ...chosen, repository: chosen.repository?.toLowerCase() },
    validator,
  });
}

/** Describes the observed selected executable, never dependency/gameplay/support qualification. */
export function packagePlayerProjection(
  record: AuthoredPort,
  observation: PackagePlayerObservationV1,
  validator = packageProjectionValidator,
) {
  checkPackagePlayerObservation(observation);
  const chosen = selection(record);
  const cache_key = packagePlayerProjectionKey(record, observation, validator);
  if (
    !chosen ||
    observation.port_id !== record.listing.id ||
    observation.repository.toLowerCase() !== chosen.repository?.toLowerCase() ||
    observation.selection_sha256 !== hash({ ...chosen, repository: observation.repository })
  )
    return {
      platforms: [] as string[],
      status: "inapplicable" as const,
      reason: "selected-player-contract-changed",
      cache_key,
    };
  if (observation.player.machine.toLowerCase() !== "0x8664")
    return {
      platforms: [] as string[],
      status: "unknown" as const,
      reason: "selected-player-header-does-not-establish-windows-x64",
      cache_key,
    };
  return {
    platforms: ["windows-x86-64"],
    status: "observed" as const,
    scope:
      "Exact selected AMD64 PE header only; not dependency, source/original verification, gameplay, save compatibility or Supported qualification.",
    cache_key,
  };
}

export function projectPackagePlayerFacts(record: AuthoredPort): AuthoredPort {
  if (record.package_observation_v1 === undefined || record.integration) return record;
  const projection = packagePlayerProjection(record, record.package_observation_v1);
  return { ...record, listing: { ...record.listing, platforms: projection.platforms } };
}

/** Test expectations derive from accepted member identity and its bound player contract.
 * They are owned probe inputs, never execution or authentication of upstream games. */
export function acceptedPlayerRouteExpectations(records: readonly AuthoredPort[]) {
  return {
    format_version: 1,
    cases: records
      .flatMap((record) => {
        const observation = record.package_observation_v1;
        if (!observation || record.integration) return [];
        const projected = packagePlayerProjection(record, observation);
        const chosen = selection(record);
        if (projected.status === "inapplicable" || !chosen)
          throw new Error(
            `Declared player ${record.listing.id} needs an accepted observation bound to its changed selection contract before generating lifecycle expectations.`,
          );
        return [
          {
            port_id: record.listing.id,
            executable: observation.player.path.split("/").at(-1),
            arguments: chosen.arguments,
            managed_native: false,
            observation_scope_sha256: observation.scope_sha256,
          },
        ];
      })
      .sort((a, b) => a.port_id.localeCompare(b.port_id, "en")),
  };
}
