import { observedModPortalPrefix } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  exactGameBananaId,
  validateModProviderRegistryProgress,
} from "./upstream-mod-provider-registry.mts";
import type { ModProviderRegistryProgress } from "./upstream-mod-provider-registry.mts";

type RegistryCommunity = NonNullable<
  ModProviderRegistryProgress["last_complete"]
>["communities"][number];
type Portal = {
  id: string;
  site: "community_site";
  url: string;
  name: string;
  instructions: string;
};

function communityPortal(community: RegistryCommunity): Portal {
  return {
    id: `${observedModPortalPrefix}${community.gamebanana_game}-${community.game_uuid}`,
    site: "community_site",
    url: `https://thunderstore.io/c/${community.community}/`,
    name: "Thunderstore",
    instructions: "Open the community to browse its mods.",
  };
}

function listingPortals(listing: Record<string, unknown>): unknown[] {
  return Array.isArray(listing.mod_portals) ? listing.mod_portals : [];
}

function isGenerated(portal: unknown): boolean {
  return (
    isRecord(portal) &&
    typeof portal.id === "string" &&
    portal.id.startsWith(observedModPortalPrefix)
  );
}

/** Generated browser links are independent of the release observation declaration. */
export function withoutGeneratedModPortals(listing: Record<string, unknown>) {
  const portals = listingPortals(listing);
  const authored = portals.filter((portal) => !isGenerated(portal));
  if (portals.length === authored.length) return listing;
  const result = { ...listing };
  if (authored.length) result.mod_portals = authored;
  else delete result.mod_portals;
  return result;
}

/**
 * Derive an optional website for the exact implementation with a reviewed
 * GameBanana identity. An authored exact website or operational binding can
 * establish the identity. The registry's numeric cross-link supplies only a
 * website and requires agreement between every reviewed identity for the port.
 */
export function listingModPortalDefaults(
  catalog: unknown,
  registry: unknown,
  excluded: ReadonlySet<string>,
  now: number,
) {
  const reviewedGameIds = new Map<string, number[]>();
  const boundThunderstore = new Set<string>();
  if (!isRecord(catalog) || !Array.isArray(catalog.ports))
    throw new Error("Mod portal projection requires the canonical operational catalog.");
  for (const port of catalog.ports as unknown[]) {
    if (
      !isRecord(port) ||
      typeof port.id !== "string" ||
      !Array.isArray(port.mod_provider_bindings)
    )
      continue;
    const bindings: unknown[] = port.mod_provider_bindings;
    if (bindings.some((binding) => isRecord(binding) && binding.provider === "thunderstore")) {
      boundThunderstore.add(port.id);
      continue;
    }
    reviewedGameIds.set(
      port.id,
      bindings.flatMap((binding) =>
        isRecord(binding) &&
        binding.provider === "gamebanana" &&
        typeof binding.game_id === "number" &&
        Number.isSafeInteger(binding.game_id) &&
        binding.game_id > 0
          ? [binding.game_id]
          : [],
      ),
    );
  }
  let communities: Map<number, RegistryCommunity[]> | undefined;
  let conflicted: Set<string> | "unknown" | undefined;
  if (registry !== undefined) {
    validateModProviderRegistryProgress(registry, now);
    const progress = registry as ModProviderRegistryProgress;
    conflicted = Array.isArray(progress.identity_conflicts)
      ? new Set(progress.identity_conflicts)
      : progress.identity_conflicts === "unknown" || progress.exception === "identity-changed"
        ? "unknown"
        : undefined;
    if (
      !progress.exception &&
      progress.last_complete &&
      Date.parse(progress.last_complete.expires_at) > now
    ) {
      communities = new Map();
      for (const entry of progress.last_complete.communities) {
        if (entry.listed === false || entry.gamebanana_game === null) continue;
        const matches = communities.get(entry.gamebanana_game) ?? [];
        matches.push(entry);
        communities.set(entry.gamebanana_game, matches);
      }
    }
  }
  return (listing: Record<string, unknown>, previous: Record<string, unknown> | undefined) => {
    if (
      typeof listing.id !== "string" ||
      excluded.has(listing.id) ||
      boundThunderstore.has(listing.id)
    )
      return undefined;
    const authored = listingPortals(listing);
    const gameIds = new Set(reviewedGameIds.get(listing.id));
    for (const portal of authored) {
      if (!isRecord(portal) || isGenerated(portal) || portal.site !== "community_site") continue;
      const gameId = exactGameBananaId(portal.url);
      if (gameId !== null) gameIds.add(gameId);
    }
    const [gameId] = gameIds;
    if (
      gameIds.size !== 1 ||
      gameId === undefined ||
      authored.length >= 8 ||
      authored.some(
        (portal) =>
          isRecord(portal) &&
          typeof portal.url === "string" &&
          URL.parse(portal.url)?.hostname === "thunderstore.io",
      )
    )
      return undefined;
    const matches = communities?.get(gameId);
    if (matches?.length === 1 && matches[0]?.listed === true) return communityPortal(matches[0]);
    if (
      previous?.project_url !== listing.project_url ||
      !previous ||
      observationHash(previous.original_game ?? null) !==
        observationHash(listing.original_game ?? null)
    )
      return undefined;
    const prior = listingPortals(previous).filter(
      (portal): portal is Portal =>
        isRecord(portal) &&
        typeof portal.id === "string" &&
        portal.id.startsWith(`${observedModPortalPrefix}${gameId}-`) &&
        portal.site === "community_site" &&
        portal.name === "Thunderstore" &&
        portal.instructions === "Open the community to browse its mods." &&
        typeof portal.url === "string" &&
        /^https:\/\/thunderstore\.io\/c\/[a-z0-9]+(?:[-_][a-z0-9]+)*\/$/u.test(portal.url),
    );
    if (prior.length !== 1) return undefined;
    const retained = prior[0]!;
    if (
      conflicted === "unknown" ||
      conflicted?.has(new URL(retained.url).pathname.split("/")[2] ?? "")
    )
      return undefined;
    // Preserve the published association during outages and while the provider
    // explicitly confirms it among several results. Complete removal withdraws it.
    return communities === undefined ||
      matches?.some(
        (entry) => observationHash(communityPortal(entry)) === observationHash(retained),
      )
      ? retained
      : undefined;
  };
}
