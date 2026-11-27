import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { validArtworkMapping, validArtworkCollection } from "./catalog-cover-mapping.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import {
  indexAuthoredOriginalMedia,
  type ReviewedOriginalMediaDecision,
} from "./reviewed-original-media.mts";
import { isRecord } from "./runtime-values.mts";
import { originalEditionMediaKey, permitsReviewedOriginalMedia } from "./shared-original-media.mts";
import { observationHash } from "./upstream-observer.mts";

function sharedCoverScope(record: AuthoredPort) {
  if (record.igdb_no_shared_cover || record.igdb_regional_cover || usesScummvmEngine(record))
    return undefined;
  const game = record.listing.original_game;
  const edition = game?.source_editions.length === 1 ? game.source_editions[0] : undefined;
  if (!game || !edition) return undefined;
  const key = originalEditionMediaKey(game.id, edition);
  if (!key) return undefined;
  return { game_id: game.id, source_edition_id: edition.id, key };
}

function matchesSharedCoverScope(
  game: unknown,
  scope: NonNullable<ReturnType<typeof sharedCoverScope>>,
) {
  return (
    isRecord(game) &&
    game.id === scope.game_id &&
    Array.isArray(game.source_editions) &&
    game.source_editions.length === 1 &&
    originalEditionMediaKey(scope.game_id, game.source_editions[0]) === scope.key
  );
}

// The provider may rename a game slug without changing the admitted asset.
function coverIdentity({ game_id, cover_id, image_id, image_sha256 }: IgdbArtwork) {
  return JSON.stringify([game_id, cover_id, image_id, image_sha256]);
}

export function indexSharedCoverRows(rows: readonly unknown[]) {
  const live = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || live.has(row.id))
      throw new Error("Shared cover preparation requires unique signed listing IDs.");
    live.set(row.id, row);
  }
  return live;
}

/** Choose descriptive defaults from an already authenticated listing selection.
 * The caller owns target verification and publication. */
export function projectExactSharedCovers({
  live,
  authored,
  excludedPortIds,
  gone,
  checked,
  reviewedOriginalMedia,
  deriveDefaultsForPublishedRecipients = false,
  holdNewForImages = new Set<string>(),
}: {
  live: ReadonlyMap<string, Record<string, unknown>>;
  authored: readonly AuthoredPort[];
  excludedPortIds: ReadonlySet<string>;
  gone: ReadonlySet<string>;
  checked: ReadonlyMap<string, { digest: string | null }>;
  reviewedOriginalMedia?: ReadonlyMap<string, ReviewedOriginalMediaDecision>;
  /** The publisher recomputes defaults even when the previous generation had one. */
  deriveDefaultsForPublishedRecipients?: boolean;
  holdNewForImages?: ReadonlySet<string>;
}) {
  const signedDigests = new Map<string, Set<string>>();
  for (const row of live.values()) {
    const covers = [
      ...(validArtworkMapping(row.artwork) ? [row.artwork] : []),
      ...(validArtworkCollection(row.collection_covers) ? row.collection_covers : []),
    ];
    for (const cover of covers) {
      const digests = signedDigests.get(cover.image_id) ?? new Set<string>();
      digests.add(cover.image_sha256);
      signedDigests.set(cover.image_id, digests);
    }
  }
  const reviewed = reviewedOriginalMedia ?? indexAuthoredOriginalMedia(authored);
  const scoped = authored.flatMap((record) => {
    if (excludedPortIds.has(record.listing.id)) return [];
    const scope = sharedCoverScope(record);
    return scope ? [{ record, scope, decision: reviewed.get(scope.key) }] : [];
  });
  type CoverDonor = { id: string; artwork: IgdbArtwork };
  const donors = new Map<string, Map<string, CoverDonor>>();
  for (const { record, scope, decision } of scoped) {
    const { id, artwork } = record.listing;
    const signed = live.get(id);
    const game = signed?.original_game;
    const signedArtwork = signed?.artwork;
    const newer = validArtworkMapping(artwork) ? checked.get(artwork.image_id) : undefined;
    if (
      !signed ||
      signed.project_url !== record.listing.project_url ||
      !matchesSharedCoverScope(game, scope) ||
      !validArtworkMapping(artwork) ||
      artwork.match_kind !== "underlying-game" ||
      gone.has(artwork.image_id) ||
      signedDigests.get(artwork.image_id)?.size !== 1 ||
      (newer !== undefined && newer.digest !== artwork.image_sha256) ||
      !validArtworkMapping(signedArtwork) ||
      signedArtwork.match_kind !== "underlying-game" ||
      !permitsReviewedOriginalMedia(decision, artwork.game_id, artwork.game_slug) ||
      !permitsReviewedOriginalMedia(decision, signedArtwork.game_id, signedArtwork.game_slug) ||
      coverIdentity(signedArtwork) !== coverIdentity(artwork)
    )
      continue;
    const variants = donors.get(scope.key) ?? new Map<string, CoverDonor>();
    const identity = coverIdentity(artwork);
    const existing = variants.get(identity);
    if (!existing || id < existing.id) variants.set(identity, { id, artwork: signedArtwork });
    donors.set(scope.key, variants);
  }

  const proposals = new Map<string, IgdbArtwork>();
  const outcomes = scoped.flatMap(({ record, scope, decision }) => {
    const { id, artwork, collection_covers } = record.listing;
    const existing = live.get(id);
    if (
      artwork ||
      collection_covers ||
      (!deriveDefaultsForPublishedRecipients && (existing?.artwork || existing?.collection_covers))
    )
      return [];
    const choices = donors.get(scope.key);
    const result = { id, game_id: scope.game_id, source_edition_id: scope.source_edition_id };
    if (decision?.decision === "exclude")
      return [{ ...result, status: "reviewed-original-match-excluded" }];
    if (choices?.size !== 1)
      return [{ ...result, status: choices ? "ambiguous" : "no-accepted-donor" }];
    const donor = choices.values().next().value!;
    let mapping = donor.artwork;
    if (holdNewForImages.has(mapping.image_id)) {
      const prior = existing?.artwork;
      if (
        existing?.project_url !== record.listing.project_url ||
        !matchesSharedCoverScope(existing?.original_game, scope) ||
        !validArtworkMapping(prior) ||
        prior.match_kind !== "underlying-game" ||
        !permitsReviewedOriginalMedia(decision, prior.game_id, prior.game_slug) ||
        coverIdentity(prior) !== coverIdentity(mapping)
      )
        return [{ ...result, status: "donor-content-held" }];
      mapping = prior;
    }
    proposals.set(id, mapping);
    return [{ ...result, status: "prepared", donor_port_id: donor.id, mapping }];
  });

  return { proposals, outcomes };
}

/** Retain an authenticated prior default during a source read failure only
 * for the same repository and exact original-game and edition relationship. */
export function retainSharedCoverDefaults(
  previous: ReadonlyMap<string, Record<string, unknown>>,
  current: readonly Record<string, unknown>[],
  gone: ReadonlySet<string>,
): ReturnType<typeof projectExactSharedCovers> {
  const proposals = new Map<string, IgdbArtwork>();
  for (const row of current) {
    if (typeof row.id !== "string" || row.artwork || row.collection_covers) continue;
    const old = previous.get(row.id);
    const game = row.original_game;
    if (
      old?.project_url !== row.project_url ||
      !isRecord(game) ||
      !Array.isArray(game.source_editions) ||
      game.source_editions.length !== 1 ||
      observationHash(game) !== observationHash(old?.original_game ?? null) ||
      !validArtworkMapping(old?.artwork) ||
      old.artwork.match_kind !== "underlying-game" ||
      gone.has(old.artwork.image_id)
    )
      continue;
    proposals.set(row.id, old.artwork);
  }
  return { proposals, outcomes: [] };
}
