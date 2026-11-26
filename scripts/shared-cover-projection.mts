import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { validArtworkMapping, validArtworkCollection } from "./catalog-cover-mapping.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

function sharedCoverScope(record: AuthoredPort) {
  if (record.igdb_regional_cover || usesScummvmEngine(record)) return undefined;
  const game = record.listing.original_game;
  const edition = game?.source_editions.length === 1 ? game.source_editions[0] : undefined;
  if (!game || !edition) return undefined;
  return { game_id: game.id, source_edition_id: edition.id };
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
}: {
  live: ReadonlyMap<string, Record<string, unknown>>;
  authored: readonly AuthoredPort[];
  excludedPortIds: ReadonlySet<string>;
  gone: ReadonlySet<string>;
  checked: ReadonlyMap<string, { digest: string | null }>;
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
  const scoped = authored.flatMap((record) => {
    if (excludedPortIds.has(record.listing.id)) return [];
    const scope = sharedCoverScope(record);
    return scope ? [{ record, scope, key: observationHash(scope) }] : [];
  });
  type CoverDonor = { id: string; artwork: IgdbArtwork };
  const donors = new Map<string, Map<string, CoverDonor>>();
  for (const { record, scope, key } of scoped) {
    const { id, artwork } = record.listing;
    const signed = live.get(id);
    const game = signed?.original_game;
    const newer = validArtworkMapping(artwork) ? checked.get(artwork.image_id) : undefined;
    if (
      !signed ||
      signed.project_url !== record.listing.project_url ||
      !isRecord(game) ||
      game.id !== scope.game_id ||
      !Array.isArray(game.source_editions) ||
      game.source_editions.length !== 1 ||
      !isRecord(game.source_editions[0]) ||
      game.source_editions[0].id !== scope.source_edition_id ||
      !validArtworkMapping(artwork) ||
      artwork.match_kind !== "underlying-game" ||
      gone.has(artwork.image_id) ||
      signedDigests.get(artwork.image_id)?.size !== 1 ||
      (newer !== undefined && newer.digest !== artwork.image_sha256) ||
      observationHash(signed.artwork ?? null) !== observationHash(artwork)
    )
      continue;
    const variants = donors.get(key) ?? new Map<string, CoverDonor>();
    const digest = observationHash(artwork);
    const existing = variants.get(digest);
    if (!existing || id < existing.id) variants.set(digest, { id, artwork });
    donors.set(key, variants);
  }

  const proposals = new Map<string, IgdbArtwork>();
  const outcomes = scoped.flatMap(({ record, scope, key }) => {
    const { id, artwork, collection_covers } = record.listing;
    const existing = live.get(id);
    if (artwork || collection_covers || existing?.artwork || existing?.collection_covers) return [];
    const choices = donors.get(key);
    const result = { id, ...scope };
    if (choices?.size !== 1)
      return [{ ...result, status: choices ? "ambiguous" : "no-accepted-donor" }];
    const donor = choices.values().next().value!;
    proposals.set(id, donor.artwork);
    return [{ ...result, status: "prepared", donor_port_id: donor.id, mapping: donor.artwork }];
  });

  return { proposals, outcomes };
}
