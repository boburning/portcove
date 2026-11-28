import { launcherModGameScopes, verifyLauncherModGameScope } from "./launcher-mod-game-scope.mts";
import {
  isBoundLauncherModPortal,
  launcherModPortalId,
  observedLauncherModPortalPrefix,
} from "./first-party-mod-portal.mts";
import { admittedGithubRepositoryId, observedModPortalPrefix } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import { catalogObservationSources } from "./catalog-upstream-observer.mts";
import {
  launcherModScopes,
  launcherModSubjectBinding,
  launcherModSubjects,
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

function withoutModPortals(listing: Record<string, unknown>, remove: (portal: unknown) => boolean) {
  const portals = listingPortals(listing);
  const authored = portals.filter((portal) => !remove(portal));
  if (portals.length === authored.length) return listing;
  const result = { ...listing };
  if (authored.length) result.mod_portals = authored;
  else delete result.mod_portals;
  return result;
}

/** Generated browser links are independent of the release observation declaration. */
export function withoutGeneratedModPortals(listing: Record<string, unknown>) {
  return withoutModPortals(listing, isGenerated);
}

export function withoutLauncherAdmissionSeeds(listing: Record<string, unknown>) {
  return withoutModPortals(
    listing,
    (portal) =>
      isRecord(portal) &&
      typeof portal.id === "string" &&
      portal.id.startsWith(observedLauncherModPortalPrefix),
  );
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
    const authored = listingPortals(withoutLauncherAdmissionSeeds(listing));
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
  const gameScopes = launcherModGameScopes(catalog, listings);
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
  const observedOwners = new Map<number, Set<string>>();
  for (const source of sources) {
    const prior = isRecord(state?.sources) ? state.sources[source.key] : undefined;
    if (
      isRecord(prior) &&
      Number.isSafeInteger(prior.repository_id) &&
      Number(prior.repository_id) > 0
    ) {
      const repositoryId = Number(prior.repository_id);
      ids[source.key] = { repository_id: repositoryId };
      if ((source.provider ?? "github") === "github") {
        const owners = observedOwners.get(repositoryId) ?? new Set<string>();
        for (const port of source.ports) owners.add(port.id);
        observedOwners.set(repositoryId, owners);
      }
    }
  }
  const scopes = launcherModScopes(sources);
  const scopeByPort = new Map(scopes.map((scope) => [scope.port_id, scope]));
  const subjects = new Map(
    launcherModSubjects(sources, ids, scopes, gameScopes).map((subject) => [
      subject.port_id,
      subject,
    ]),
  );
  const raw = state?.launcher_mod_sources;
  if (raw !== undefined) validateFirstPartyModProgress(raw, now);
  const progress = raw as Record<string, FirstPartyModProgress> | undefined;
  return (
    listing: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
  ): Portal[] => {
    if (typeof listing.id !== "string" || excluded.has(listing.id)) return [];
    const scope = scopeByPort.get(listing.id);
    const gameScope = gameScopes.get(listing.id);
    if (!scope || !gameScope) return [];
    const subject = subjects.get(listing.id);
    if (!subject && ids[scope.source_key]) return [];
    const admittedId = admittedGithubRepositoryId(listing.id);
    const owners = admittedId === undefined ? undefined : observedOwners.get(admittedId);
    if (owners && (owners.size !== 1 || !owners.has(listing.id))) return [];
    const entry = progress?.[listing.id];
    const authored = listingPortals(withoutLauncherAdmissionSeeds(listing));
    const blocked = new Set(bindings.get(listing.id));
    for (const portal of authored) {
      if (!isRecord(portal) || typeof portal.url !== "string") continue;
      const host = URL.parse(portal.url)?.hostname;
      if (host === "thunderstore.io" || host === "gamebanana.com") blocked.add(host.split(".")[0]!);
    }
    const provider = (portal: { name: string }) =>
      portal.name === "Thunderstore" ? "thunderstore" : "gamebanana";
    let sharedRenamePortals: readonly Pick<Portal, "name" | "url">[] | undefined;
    if (entry && !subject) {
      // A renamed source may lack a current checkpoint. Keep only authenticated
      // prior websites under the same admitted ID, and honor explicit absence.
      const result = entry.last_complete?.result;
      const verified = result && verifyLauncherModGameScope(result, gameScope);
      if (
        admittedId === undefined ||
        !previous ||
        entry.outcome === "held" ||
        verified?.state === "absent" ||
        verified?.state === "held" ||
        (result?.state === "observed" && result.repository_id !== admittedId)
      )
        return [];
      if (gameScope.sharedEditionBinding) {
        if (
          verified?.state !== "observed" ||
          entry.binding !==
            launcherModSubjectBinding(
              listing.id,
              admittedId,
              scope.original_game,
              gameScope.sharedEditionBinding,
            )
        )
          return [];
        sharedRenamePortals = verified.mod_portals;
      }
    }
    if (entry && subject) {
      if (entry.binding !== subject.binding) return [];
      const result = entry.last_complete?.result;
      if (entry.outcome !== "unavailable" || result) {
        if (result?.state !== "observed" || result.repository_id !== subject.repository_id)
          return [];
        const verified = verifyLauncherModGameScope(result, gameScope);
        if (verified.state === "held") return [];
        if (verified.state === "observed" && entry.reason !== "game-input-scope-unproven")
          return verified.mod_portals
            .filter((portal) => !blocked.has(provider(portal)))
            .slice(0, 8 - authored.length)
            .map((portal) => ({
              ...portal,
              site: "community_site",
              id: launcherModPortalId(portal, result.repository_id),
            }));
      }
    }
    // A readable checkpoint must substantiate current shared codes. If the
    // entire checkpoint is unavailable, fall back to the previously signed
    // source under the unchanged game, edition and repository checks below.
    if (gameScope.sharedEditionBinding && state && !sharedRenamePortals) return [];
    const expectedId = subject?.repository_id ?? admittedId;
    if (
      previous?.id !== listing.id ||
      (previous.project_url !== listing.project_url && admittedId === undefined) ||
      observationHash(previous.original_game ?? null) !==
        observationHash(listing.original_game ?? null)
    )
      return [];
    const retained: Portal[] = [];
    for (const portal of listingPortals(previous)) {
      if (!isBoundLauncherModPortal(portal, expectedId)) continue;
      if (
        sharedRenamePortals &&
        !sharedRenamePortals.some(
          (source) => source.name === portal.name && source.url === portal.url,
        )
      )
        continue;
      const providerId = provider(portal);
      if (blocked.has(providerId)) continue;
      blocked.add(providerId);
      retained.push(portal);
    }
    return retained.slice(0, 8 - authored.length);
  };
}
