import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CatalogMediaAsset } from "../apps/desktop/src/transport-types.generated.d.ts";
import {
  imagePattern,
  positiveId,
  slugPattern,
  validArtworkMapping,
} from "./catalog-cover-mapping.mts";
import {
  acceptedHeroMediaMatches,
  catalogGameMediaRoles,
  gameMediaDimensionsFit,
  gameMediaRoleLimits,
  gameMediaRoles,
  isConfirmedIgdbImageGone,
  normalizedArtworkTypeName,
  type createIgdbInspector,
  type prepareCatalogGameMedia,
} from "./inspect-igdb-artwork.mts";
import type { ReviewedOriginalMediaDecision } from "./reviewed-original-media.mts";
import { isRecord } from "./runtime-values.mts";
import {
  directoryOnlyMedia,
  landscapeCoverMedia,
  originalEditionMediaKey,
} from "./shared-original-media.mts";
import type { ScheduledCover } from "./listing-scheduled-cover.mts";

export const scheduledGameMediaFile = "game-media-additions.json";
export const scheduledGameMediaLimit = 2 * 1024 * 1024;
const automaticPrefix = "auto-igdb-";
const maxAssets = 48 * 14;
const assetFields = new Set([
  "id",
  "role",
  "subject",
  "caption",
  "url",
  "sha256",
  "width",
  "height",
  "attribution",
  "source_url",
  "license",
  "rights_url",
  "edition_neutral",
  "igdb",
]);
const imageFields = new Set([
  "game_id",
  "record_id",
  "kind",
  "image_id",
  "game_slug",
  "alpha_channel",
  "image_type",
  "image_type_name",
]);
type Listing = Record<string, unknown>;
type Candidate = { id: string; asset: CatalogMediaAsset };
type Proposal = {
  format_version: 1;
  selected_ids: readonly string[];
  additions: Candidate[];
  covers?: readonly ScheduledCover[];
};
type MediaPreparation = Awaited<ReturnType<typeof prepareCatalogGameMedia>>;

const media = (row: Listing | undefined): unknown[] =>
  row && Array.isArray(row.media) ? row.media : [];

function scope(row: Listing, subject: unknown) {
  if (!isRecord(subject)) return undefined;
  if (subject.kind === "port" && subject.port_id === row.id)
    return typeof row.project_url === "string"
      ? JSON.stringify(["port", row.id, row.project_url])
      : undefined;
  const original = row.original_game;
  if (
    subject.kind !== "original" ||
    !isRecord(original) ||
    typeof original.id !== "string" ||
    original.id !== subject.game_id ||
    !Array.isArray(original.source_editions)
  )
    return undefined;
  return originalEditionMediaKey(
    original.id,
    original.source_editions.find(
      (edition: unknown) => isRecord(edition) && edition.id === subject.source_edition_id,
    ),
  );
}

function typedAsset(value: unknown): value is CatalogMediaAsset {
  if (!isRecord(value) || !isRecord(value.subject) || !isRecord(value.igdb)) return false;
  const role = catalogGameMediaRoles.find((candidate) => candidate === value.role);
  if (!role) return false;
  const { kind, caption, variant } = gameMediaRoles[role];
  const image = value.igdb;
  return (
    Object.keys(value).every((key) => assetFields.has(key)) &&
    Object.keys(image).every((key) => imageFields.has(key)) &&
    (value.subject.kind === "port"
      ? Object.keys(value.subject).length === 2 && typeof value.subject.port_id === "string"
      : Object.keys(value.subject).length === 3 &&
        typeof value.subject.game_id === "string" &&
        typeof value.subject.source_edition_id === "string") &&
    typeof value.id === "string" &&
    /^(?:auto-)?igdb-[a-z0-9-]{1,110}$/u.test(value.id) &&
    (value.subject.kind === "port" || value.subject.kind === "original") &&
    value.caption ===
      (role === "screenshot" && value.subject.kind === "original"
        ? "Original game screenshot"
        : caption) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    positiveId(value.width) &&
    positiveId(value.height) &&
    gameMediaDimensionsFit(role, value.width, value.height) &&
    positiveId(image.game_id) &&
    positiveId(image.record_id) &&
    image.kind === kind &&
    (role !== "landscape_cover" ||
      (Number(value.width) > Number(value.height) &&
        positiveId(image.image_type) &&
        normalizedArtworkTypeName(image.image_type_name) === "keyartwithlogo")) &&
    typeof image.image_id === "string" &&
    imagePattern.test(image.image_id) &&
    typeof image.game_slug === "string" &&
    slugPattern.test(image.game_slug) &&
    value.url === `https://images.igdb.com/igdb/image/upload/t_${variant}/${image.image_id}.png` &&
    value.source_url === `https://www.igdb.com/games/${image.game_slug}` &&
    value.attribution === "Game artwork via IGDB; copyright remains with its rights holders." &&
    value.license === "LicenseRef-IGDB-Terms" &&
    value.rights_url === "https://www.twitch.tv/p/en/legal/developer-agreement/"
  );
}

function sameRole(asset: CatalogMediaAsset, other: unknown) {
  return (
    isRecord(other) && other.role === asset.role && isDeepStrictEqual(other.subject, asset.subject)
  );
}

/** Only live role selections enter the small typed proposal. */
export function scheduledGameMediaProposal(
  preparation: MediaPreparation,
  selected_ids: readonly string[],
): Proposal {
  const byPort = new Map(
    preparation.catalog.ports.map((port) => [port.id, port.presentation?.media]),
  );
  const additions: Candidate[] = [];
  for (const row of preparation.records) {
    if (row.reason !== "role-selected") continue;
    const available = byPort.get(row.port_id);
    const asset =
      Array.isArray(available) &&
      (available as unknown[]).find(
        (value): value is CatalogMediaAsset =>
          typedAsset(value) &&
          sameRole(value, row) &&
          value.igdb?.image_id === row.image_id &&
          value.igdb?.game_id === row.provider_game_id,
      );
    if (
      asset &&
      !additions.some(({ id, asset: prior }) => id === row.port_id && sameRole(prior, asset))
    )
      additions.push({ id: row.port_id, asset });
  }
  return { format_version: 1, selected_ids, additions };
}

export function readScheduledGameMediaProposal(value: unknown): Proposal {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !Array.isArray(value.selected_ids) ||
    value.selected_ids.length > 48 ||
    !value.selected_ids.every(
      (id: unknown) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id),
    ) ||
    new Set(value.selected_ids).size !== value.selected_ids.length ||
    !Array.isArray(value.additions) ||
    value.additions.length > maxAssets ||
    !value.additions.every(
      (row: unknown) =>
        isRecord(row) &&
        typeof row.id === "string" &&
        /^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.id) &&
        (value.selected_ids as unknown[]).includes(row.id) &&
        typedAsset(row.asset),
    )
  )
    throw new Error("Invalid scheduled media proposal");
  if (value.covers !== undefined) {
    const selected = new Set<unknown>(value.selected_ids);
    if (
      !Array.isArray(value.covers) ||
      value.covers.length > selected.size ||
      !value.covers.every(
        (cover: unknown) =>
          isRecord(cover) &&
          typeof cover.id === "string" &&
          selected.has(cover.id) &&
          validArtworkMapping(cover.artwork) &&
          Object.keys(cover.artwork).length === 6 &&
          (cover.artwork.match_kind === "underlying-game"
            ? Object.keys(cover).length === 2
            : Object.keys(cover).length === 3 &&
              isRecord(cover.project) &&
              Object.keys(cover.project).length === 3 &&
              positiveId(cover.project.github_repository_id) &&
              typeof cover.project.name === "string" &&
              cover.project.name.length > 0 &&
              cover.project.name.length <= 255 &&
              typeof cover.project.project_url === "string" &&
              cover.project.project_url.startsWith("https://") &&
              cover.project.project_url.length <= 2048),
      ) ||
      new Set(value.covers.map((cover: ScheduledCover) => cover.id)).size !== value.covers.length
    )
      throw new Error("Invalid scheduled cover proposal");
  }
  return value as Proposal;
}

function assetKey(asset: CatalogMediaAsset) {
  const image = asset.igdb!;
  return JSON.stringify([gameMediaRoles[asset.role].variant, image.image_id, asset.sha256]);
}

function approvalKey(asset: CatalogMediaAsset) {
  return JSON.stringify([asset.role, asset.subject, assetKey(asset)]);
}

export function hasScheduledMedia(rows: readonly Listing[]) {
  return rows.some((row) =>
    media(row).some((asset) => typedAsset(asset) && asset.id.startsWith(automaticPrefix)),
  );
}

/** Revalidate first acceptance, and rotate through already-signed image bodies.
 * Transient failures can defer new entries but cannot invalidate old bytes. */
export async function observeScheduledGameMedia(
  previous: readonly Listing[],
  incoming: Proposal | undefined,
  inspect: ReturnType<typeof createIgdbInspector>["inspectMediaImage"],
  now: number,
  eligible?: readonly CatalogMediaAsset[],
) {
  const retained = new Map<string, CatalogMediaAsset>();
  for (const row of previous)
    for (const asset of media(row))
      if (typedAsset(asset) && asset.id.startsWith(automaticPrefix))
        retained.set(assetKey(asset), asset);
  const keys = [...retained.keys()].sort();
  const windowSize = 8;
  const offset =
    (Math.floor(now / 86_400_000) % Math.max(1, Math.ceil(keys.length / windowSize))) * windowSize;
  const withdrawn = new Set<string>();
  type Observation = Awaited<ReturnType<typeof inspect>> | "gone" | null;
  const reads = new Map<string, Promise<Observation>>();
  function observe(asset: CatalogMediaAsset) {
    const { image_id } = asset.igdb!;
    const { variant } = gameMediaRoles[asset.role];
    const target = `${variant}/${image_id}`;
    const held = reads.get(target);
    if (held) return held;
    const request = inspect(image_id, asset.role).then(
      (bytes) => bytes,
      (error: unknown) =>
        isConfirmedIgdbImageGone(error, image_id, variant) ? ("gone" as const) : null,
    );
    reads.set(target, request);
    return request;
  }
  for (const key of keys.slice(offset, offset + windowSize)) {
    const asset = retained.get(key)!;
    const observation = await observe(asset);
    if (observation === "gone" || (observation !== null && observation.sha256 !== asset.sha256))
      withdrawn.add(key);
  }
  const additions: Candidate[] = [];
  const allowed = eligible && new Set(eligible.map(approvalKey));
  for (const candidate of incoming?.additions ?? []) {
    const { asset } = candidate;
    if (allowed && !allowed.has(approvalKey(asset))) continue;
    const observation = await observe(asset);
    if (
      observation &&
      observation !== "gone" &&
      observation.sha256 === asset.sha256 &&
      observation.width === asset.width &&
      observation.height === asset.height
    )
      additions.push(candidate);
  }
  return { withdrawn, proposal: incoming && { ...incoming, additions } };
}

/** Reconcile additions against maintained identities and retain only signed defaults
 * that still have that authority. No provider output supplies identity authority. */
export function scheduledGameMediaDefaults(
  canonical: readonly Listing[],
  previous: readonly Listing[],
  reviewed: ReadonlyMap<string, ReviewedOriginalMediaDecision>,
  excluded: ReadonlySet<string>,
  incoming?: { proposal: Proposal; producerListings: readonly Listing[] },
  options: { strict?: ReadonlyMap<unknown, Listing>; withdrawn?: ReadonlySet<string> } = {},
) {
  const byId = new Map(canonical.map((row) => [row.id, row]));
  const accepted = acceptedHeroMediaMatches(
    {
      ports: canonical.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        project_url: String(row.project_url),
        presentation: { original_game: row.original_game, media: row.media },
      })),
    },
    excluded,
  );
  const choices = new Map<
    string,
    Map<string, { asset: CatalogMediaAsset; retained: boolean } | null>
  >();
  const verifiedOriginalScreenshots = new Set(
    canonical
      .filter((row) => typeof row.id === "string" && !excluded.has(row.id))
      .flatMap((row) =>
        media(row).flatMap((value) => {
          if (
            !typedAsset(value) ||
            value.role !== "screenshot" ||
            value.subject.kind !== "original"
          )
            return [];
          const key = scope(row, value.subject);
          return key ? [JSON.stringify([key, assetKey(value)])] : [];
        }),
      ),
  );
  function offer(
    id: string,
    asset: CatalogMediaAsset,
    producer: Listing | undefined,
    retained: boolean,
  ) {
    const row = byId.get(id);
    if (
      !row ||
      !producer ||
      excluded.has(id) ||
      (Array.isArray(row.media) && row.media.length === 0)
    )
      return;
    const key = scope(row, asset.subject);
    if (!key || key !== scope(producer, asset.subject) || row.project_url !== producer.project_url)
      return;
    if (options.withdrawn?.has(assetKey(asset))) return;
    if (
      asset.role === "screenshot" &&
      asset.subject.kind === "original" &&
      !verifiedOriginalScreenshots.has(JSON.stringify([key, assetKey(asset)]))
    )
      return;
    const image = asset.igdb!;
    const decision = reviewed.get(key);
    const portCover =
      validArtworkMapping(row.artwork) && row.artwork.match_kind === "port"
        ? row.artwork
        : undefined;
    const mapping =
      asset.subject.kind === "port"
        ? portCover && { game_id: portCover.game_id, slug: portCover.game_slug }
        : decision?.decision === "exclude"
          ? undefined
          : (decision ?? accepted.get(key));
    if (!mapping || mapping.game_id !== image.game_id || mapping.slug !== image.game_slug) return;
    const roles =
      choices.get(key) ?? new Map<string, { asset: CatalogMediaAsset; retained: boolean } | null>();
    const stored = roles.get(asset.role);
    const fingerprint = [
      key,
      asset.role,
      image.game_id,
      image.record_id,
      image.image_id,
      asset.sha256,
    ];
    const normalized = {
      ...asset,
      id: automaticPrefix + createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
    };
    if (retained && asset.id !== normalized.id) return;
    // An automatic observation never widens a maintained edition scope.
    delete normalized.edition_neutral;
    if (stored === undefined) roles.set(asset.role, { asset: normalized, retained });
    else if (stored && stored.retained === retained && stored.asset.id !== normalized.id)
      roles.set(asset.role, null);
    choices.set(key, roles);
  }
  for (const producer of previous) {
    for (const asset of media(producer))
      if (
        typeof producer.id === "string" &&
        typedAsset(asset) &&
        asset.id.startsWith(automaticPrefix)
      )
        offer(producer.id, asset, producer, true);
  }
  if (incoming) {
    const source = new Map(incoming.producerListings.map((row) => [row.id, row]));
    for (const { id, asset } of incoming.proposal.additions)
      offer(id, asset, source.get(id), false);
  }
  return (row: Listing): CatalogMediaAsset[] => {
    if (
      typeof row.id !== "string" ||
      excluded.has(row.id) ||
      (Array.isArray(row.media) && !row.media.length)
    )
      return [];
    const existing = media(row);
    const strict = options.strict?.get(row.id);
    const strictMedia = isRecord(strict?.presentation) ? strict.presentation.media : undefined;
    if (strict && strict.project_url !== row.project_url) return [];
    if (
      Array.isArray(strictMedia) &&
      (!strictMedia.length ||
        !isDeepStrictEqual(
          existing.filter((value) => !directoryOnlyMedia(value)),
          strictMedia,
        ))
    )
      return [];
    const additions: CatalogMediaAsset[] = [];
    const original = row.original_game;
    const keys = [
      scope(row, { kind: "port", port_id: row.id }),
      ...(isRecord(original) &&
      typeof original.id === "string" &&
      Array.isArray(original.source_editions)
        ? original.source_editions.map((edition: unknown) =>
            originalEditionMediaKey(String(original.id), edition),
          )
        : []),
    ];
    for (const key of keys) {
      if (!key) continue;
      for (const entry of choices.get(key)?.values() ?? []) {
        if (!entry) continue;
        const { asset } = entry;
        const current = [...existing, ...additions];
        if (
          scope(row, asset.subject) !== key ||
          (Array.isArray(strictMedia) && !directoryOnlyMedia(asset)) ||
          (asset.role !== "landscape_cover" &&
            current.filter((value) => !landscapeCoverMedia(value)).length >= 14) ||
          current.filter((value) => isRecord(value) && value.role === asset.role).length >=
            gameMediaRoleLimits[asset.role] ||
          current.some(
            (value) => sameRole(asset, value) || (isRecord(value) && value.id === asset.id),
          )
        )
          continue;
        additions.push(asset);
      }
    }
    return additions;
  };
}
