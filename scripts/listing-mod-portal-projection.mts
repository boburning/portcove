import {
  admittedGithubRepositoryId,
  observedModPortalPrefix,
  observedLauncherModPortalPrefix,
} from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import { catalogObservationSources } from "./catalog-upstream-observer.mts";
import {
  launcherModSubjects,
  validLauncherModPortal,
  validateFirstPartyModProgress,
  type FirstPartyModProgress,
} from "./upstream-launcher-mod-progress.mts";
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
    (portal.id.startsWith(observedModPortalPrefix) ||
      portal.id.startsWith(observedLauncherModPortalPrefix))
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
      previous?.id !== listing.id ||
      // Repository-bound listings keep their identity when the verified
      // canonical repository changes names. Other listings still need
      // the same authored project URL.
      (previous.project_url !== listing.project_url &&
        admittedGithubRepositoryId(listing.id) === undefined) ||
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

/** First-party declarations are implementation-scoped website metadata. */
export function firstPartyListingModDefaults(
  catalog: Record<string, unknown>,
  listings: unknown[],
  checkpoint: unknown,
  excluded: ReadonlySet<string>,
  now: number,
) {
  const sources = catalogObservationSources({ ...catalog, listings }).sources;
  const bindings = new Map<string, Set<string>>();
  for (const port of catalog.ports as unknown[]) {
    if (
      !isRecord(port) ||
      typeof port.id !== "string" ||
      !Array.isArray(port.mod_provider_bindings)
    )
      continue;
    bindings.set(
      port.id,
      new Set(
        port.mod_provider_bindings.flatMap((binding: unknown) =>
          isRecord(binding) && typeof binding.provider === "string" ? [binding.provider] : [],
        ),
      ),
    );
  }
  const state = isRecord(checkpoint) && isRecord(checkpoint.sources) ? checkpoint : undefined;
  const ids: Record<string, { repository_id: number | null }> = {};
  for (const source of sources) {
    const prior = isRecord(state?.sources) ? state.sources[source.key] : undefined;
    if (
      isRecord(prior) &&
      Number.isSafeInteger(prior.repository_id) &&
      Number(prior.repository_id) > 0
    )
      ids[source.key] = { repository_id: Number(prior.repository_id) };
  }
  const subjects = new Map(
    launcherModSubjects(sources, ids).map((subject) => [subject.port_id, subject]),
  );
  const raw = state?.launcher_mod_sources;
  if (raw !== undefined) validateFirstPartyModProgress(raw, now);
  const progress = raw as Record<string, FirstPartyModProgress> | undefined;
  return (
    listing: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
  ): Portal[] => {
    if (typeof listing.id !== "string" || excluded.has(listing.id)) return [];
    const subject = subjects.get(listing.id);
    const entry = progress?.[listing.id];
    const authored = listingPortals(listing);
    const blocked = new Set(bindings.get(listing.id));
    for (const portal of authored) {
      if (!isRecord(portal) || typeof portal.url !== "string") continue;
      const host = URL.parse(portal.url)?.hostname;
      if (host === "thunderstore.io" || host === "gamebanana.com") blocked.add(host.split(".")[0]!);
    }
    const provider = (portal: Portal) =>
      portal.name === "Thunderstore" ? "thunderstore" : "gamebanana";
    if (entry) {
      const result = entry.last_complete?.result;
      if (
        !subject ||
        entry.binding !== subject.binding ||
        result?.state !== "observed" ||
        result.repository_id !== subject.repository_id
      )
        return [];
      return result.mod_portals
        .filter((portal) => !blocked.has(provider(portal as Portal)))
        .slice(0, 8 - authored.length)
        .map((portal) => ({
          ...portal,
          site: "community_site",
          id:
            observedLauncherModPortalPrefix +
            provider(portal as Portal) +
            "-" +
            result.repository_id,
        }));
    }
    // A missing observation handoff preserves authenticated URLs for the
    // unchanged listing. A present checkpoint can prove scope loss.
    if (
      (state && !subject) ||
      previous?.id !== listing.id ||
      previous.project_url !== listing.project_url ||
      observationHash(previous.original_game ?? null) !==
        observationHash(listing.original_game ?? null)
    )
      return [];
    const retained: Portal[] = [];
    for (const portal of listingPortals(previous)) {
      if (!isRecord(portal) || typeof portal.id !== "string") continue;
      const match = /^obs-gh-(thunderstore|gamebanana)-([1-9]\d*)$/u.exec(portal.id);
      if (
        !match ||
        blocked.has(match[1]!) ||
        !Number.isSafeInteger(Number(match[2])) ||
        (subject && subject.repository_id !== Number(match[2]))
      )
        continue;
      if (validLauncherModPortal({ ...portal, id: "upstream-" + match[1] })) {
        blocked.add(match[1]!);
        retained.push(portal as Portal);
      }
    }
    return retained.slice(0, 8 - authored.length);
  };
}
