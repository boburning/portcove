import type { AuthoredListing } from "./catalog-authoring.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const limits = { header: 2, logo: 2, key_art: 2, screenshot: 8 } as const;
type Role = keyof typeof limits;
type Asset = Record<string, unknown> & { id: string; role: Role };
type Claim = { asset: Asset; digest: string };

export function originalEditionMediaKey(gameId: string, edition: unknown) {
  if (
    isRecord(edition) &&
    typeof edition.id === "string" &&
    (edition.system == null || typeof edition.system === "string")
  )
    return JSON.stringify([gameId, edition.id, edition.system ?? null]);
}

export function typedIgdbScene(asset: unknown) {
  return (
    isRecord(asset) &&
    (asset.role === "header" || asset.role === "screenshot") &&
    asset.igdb != null
  );
}

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
  const editionId = value.subject.source_edition_id;
  const edition = game.source_editions.find(({ id }) => id === editionId);
  const key = originalEditionMediaKey(game.id, edition);
  return key ? { asset: value as Asset, key } : undefined;
}

function recordClaim(claims: Map<string, Claim | null>, key: string, claim: Claim | null) {
  const previous = claims.get(key);
  if (!claim || (previous && previous.digest !== claim.digest)) claims.set(key, null);
  else if (previous === undefined) claims.set(key, claim);
}

/** Copy accepted descriptive media into compatible listing views. The authored
 * records and strict installation catalog remain the inputs to their own paths. */
export function sharedOriginalMedia<
  T extends Pick<AuthoredListing, "id" | "media" | "original_game">,
>(listings: readonly T[], excluded: ReadonlySet<string>): T[] {
  const scopes = new Map<
    string,
    { roles: Map<string, Claim | null>; ids: Map<string, Claim | null> }
  >();
  for (const listing of listings) {
    if (excluded.has(listing.id) || !Array.isArray(listing.media)) continue;
    for (const candidate of listing.media as unknown[]) {
      const item = sharedAsset(candidate, listing.original_game);
      if (!item) continue;
      const { key } = item;
      const scope = scopes.get(key) ?? {
        roles: new Map<string, Claim | null>(),
        ids: new Map<string, Claim | null>(),
      };
      const claim = { asset: item.asset, digest: orderedJsonSha256(item.asset) };
      recordClaim(scope.ids, item.asset.id, claim);
      if (item.asset.role !== "screenshot") recordClaim(scope.roles, item.asset.role, claim);
      scopes.set(key, scope);
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
    const claims = new Map<string, Claim | null>();
    const candidates: Claim[] = [];
    for (const edition of game.source_editions) {
      const key = originalEditionMediaKey(game.id, edition);
      const scope = key && scopes.get(key);
      if (!scope) continue;
      for (const [id, claim] of scope.ids) {
        recordClaim(claims, id, claim);
        if (claim?.asset.role === "screenshot") candidates.push(claim);
      }
      for (const claim of scope.roles.values()) if (claim) candidates.push(claim);
    }
    const count = { header: 0, logo: 0, key_art: 0, screenshot: 0 };
    for (const { asset: item, digest } of candidates) {
      if (
        claims.get(item.id)?.digest !== digest ||
        ids.has(item.id) ||
        roles.has(item.role) ||
        count[item.role] >= limits[item.role] ||
        media.length >= 14
      )
        continue;
      media.push(structuredClone(item));
      ids.add(item.id);
      count[item.role]++;
    }
    return media.length === authored.length ? listing : { ...listing, media };
  });
}
