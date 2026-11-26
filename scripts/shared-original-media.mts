import type { AuthoredListing } from "./catalog-authoring.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const limits = { header: 2, logo: 2, key_art: 2, screenshot: 8 } as const;
type Role = keyof typeof limits;
type Asset = Record<string, unknown> & { id: string; role: Role };

function sharedAsset(value: unknown, game: AuthoredListing["original_game"]) {
  if (
    !game ||
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.role !== "string" ||
    !Object.hasOwn(limits, value.role) ||
    !isRecord(value.igdb) ||
    !isRecord(value.subject) ||
    value.subject.kind !== "original" ||
    value.subject.game_id !== game.id
  )
    return undefined;
  const edition = value.subject.source_edition_id;
  if (typeof edition !== "string" || !game.source_editions.some(({ id }) => id === edition))
    return undefined;
  return { asset: value as Asset, game: game.id, edition };
}

const scopeKey = (game: string, edition: string) => JSON.stringify([game, edition]);

/** Copy accepted descriptive media into compatible listing views. The authored
 * records and strict installation catalog remain the inputs to their own paths. */
export function sharedOriginalMedia<
  T extends Pick<AuthoredListing, "id" | "media" | "original_game">,
>(listings: readonly T[], excluded: ReadonlySet<string>): T[] {
  const scopes = new Map<string, Map<string, Asset | null>>();
  for (const listing of listings) {
    if (excluded.has(listing.id) || !Array.isArray(listing.media)) continue;
    for (const candidate of listing.media as unknown[]) {
      const item = sharedAsset(candidate, listing.original_game);
      if (!item) continue;
      const key = scopeKey(item.game, item.edition);
      const assets = scopes.get(key) ?? new Map<string, Asset | null>();
      const assetKey = item.asset.role === "screenshot" ? item.asset.id : item.asset.role;
      const prior = assets.get(assetKey);
      if (prior === undefined) assets.set(assetKey, item.asset);
      else if (prior && orderedJsonSha256(prior) !== orderedJsonSha256(item.asset))
        assets.set(assetKey, null);
      scopes.set(key, assets);
    }
  }

  return listings.map((listing) => {
    const game = listing.original_game;
    if (!game || excluded.has(listing.id)) return listing;
    // An explicitly empty media list clears the generated defaults.
    if (Array.isArray(listing.media) && listing.media.length === 0) return listing;
    const authored: unknown[] = Array.isArray(listing.media) ? listing.media : [];
    const media = [...authored];
    const roles = new Set(authored.flatMap((asset) => (isRecord(asset) ? [asset.role] : [])));
    const ids = new Set(authored.flatMap((asset) => (isRecord(asset) ? [asset.id] : [])));
    const count = { header: 0, logo: 0, key_art: 0, screenshot: 0 };
    for (const edition of game.source_editions) {
      for (const item of scopes.get(scopeKey(game.id, edition.id))?.values() ?? []) {
        if (
          !item ||
          roles.has(item.role) ||
          ids.has(item.id) ||
          count[item.role] >= limits[item.role] ||
          media.length >= 14
        )
          continue;
        media.push(structuredClone(item));
        ids.add(item.id);
        count[item.role]++;
      }
    }
    return media.length === authored.length ? listing : { ...listing, media };
  });
}
