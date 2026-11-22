import type {
  CatalogDocument,
  CatalogListingDocument,
  PendingSetupRecord,
  PortDefinition,
  PortListing,
  PortListingStatus,
  PortStatus,
} from "../../types";

/** A display projection, never an operational PortDefinition or an action grant. */
export type CatalogEntry = Pick<PortDefinition, "id" | "name" | "summary" | "platforms"> &
  Partial<
    Pick<
      PortDefinition,
      | "channels"
      | "release"
      | "source_profile"
      | "bios_source_profile"
      | "optional_game_source"
      | "upstream_status"
      | "adapter"
      | "project_url"
    >
  > & {
    presentation?: Partial<NonNullable<PortDefinition["presentation"]>> | null;
    definition?: PortDefinition;
    listing?: PortListing;
    listingStatus?: PortListingStatus;
    pendingSetup?: PendingSetupRecord;
  };

/**
 * Platforms this entry is offered on: the managed definition's platforms plus
 * any the accepted listing declares for its upstream download (that download can
 * still be unavailable). Browsing, filtering and labels use this; managed
 * actions keep `entry.platforms`.
 */
export function availablePlatforms(
  entry: Pick<CatalogEntry, "platforms"> & { listing?: PortListing | undefined },
): PortDefinition["platforms"] {
  const extra = entry.listing?.platforms ?? [];
  if (!extra.some((platform) => !entry.platforms.includes(platform))) return entry.platforms;
  return [...new Set([...entry.platforms, ...extra])];
}

function definitionDescriptiveFallback(
  definition: PortDefinition,
  listing: PortListing | undefined,
  id: string,
) {
  const presentation = definition.presentation;
  const originalGame = presentation?.original_game ?? listing?.original_game;
  const listedMedia = listing?.media?.filter(({ subject }) =>
    subject.kind === "port"
      ? subject.port_id === id
      : subject.game_id === originalGame?.id &&
        originalGame.source_editions.some((edition) => edition.id === subject.source_edition_id),
  );
  const sceneMedia = listedMedia?.filter(
    ({ role, igdb }) =>
      (role === "header" && igdb?.kind === "artwork") ||
      (role === "screenshot" && igdb?.kind === "screenshot"),
  );
  const strictMedia = presentation?.media;
  // The accepted directory has already reconciled managed presentation in Core.
  // Only its new scene roles extend an existing strict media array.
  const media =
    strictMedia == null
      ? listedMedia
      : strictMedia.length && sceneMedia?.length && listing?.project_url === definition.project_url
        ? [...strictMedia, ...sceneMedia]
        : undefined;
  // Only descriptive additions may fall back to the accepted listing. The
  // strict definition remains the separate operational owner, including setup.
  return {
    ...(presentation?.original_game == null && listing?.original_game
      ? { original_game: listing.original_game }
      : {}),
    ...(media ? { media } : {}),
  };
}

/** One entry per stable port identity; grouping is a separate display projection. */
export function catalogEntries(
  catalog: CatalogDocument | undefined,
  directory: CatalogListingDocument | undefined,
  statuses: readonly PortListingStatus[],
  pending: readonly PendingSetupRecord[],
): CatalogEntry[] {
  const definitions = new Map(catalog?.ports.map((port) => [port.id, port]));
  // A saved download retains its identity even when it leaves the current catalog.
  const listings = new Map([
    ...pending.map((setup) => [setup.port_id, setup.listing] as const),
    ...(directory?.listings.map((listing) => [listing.id, listing] as const) ?? []),
  ]);
  const listingStatuses = new Map(statuses.map((status) => [status.port_id, status]));
  const pendingSetups = new Map(pending.map((setup) => [setup.port_id, setup]));
  const ids = new Set([...definitions.keys(), ...listings.keys()]);
  return Array.from(ids, (id): CatalogEntry => {
    const definition = definitions.get(id);
    const listing = listings.get(id);
    const shared = {
      ...(definition ? { definition } : {}),
      ...(listing ? { listing } : {}),
      ...(listingStatuses.has(id) ? { listingStatus: listingStatuses.get(id)! } : {}),
      ...(pendingSetups.has(id) ? { pendingSetup: pendingSetups.get(id)! } : {}),
    };
    if (definition) {
      const presentation = definition.presentation;
      const descriptive = definitionDescriptiveFallback(definition, listing, id);
      return {
        ...definition,
        ...shared,
        ...(Object.keys(descriptive).length
          ? { presentation: { ...presentation, ...descriptive } }
          : {}),
      };
    }
    // The identity came from the accepted directory; no release, source, or
    // installation contract is manufactured to make a listing fit the browser.
    const identity = listings.get(id)!;
    return {
      id,
      name: identity.name,
      summary: identity.summary,
      platforms: identity.platforms ?? [],
      presentation: {
        ...(identity.original_game ? { original_game: identity.original_game } : {}),
        ...(identity.media ? { media: identity.media } : {}),
        ...(identity.original_game_title
          ? { original_game_title: identity.original_game_title }
          : {}),
        ...(identity.variant_label ? { variant_label: identity.variant_label } : {}),
        ...(identity.artwork ? { artwork: identity.artwork } : {}),
        ...(identity.manual_setup ? { manual_setup: identity.manual_setup } : {}),
      },
      ...shared,
    };
  });
}

type ListingAvailabilityAssessment = {
  availability: NonNullable<PortListing["availability"]>;
  label: string;
  observedPlatforms?: PortDefinition["platforms"];
};

export function assessListingAvailability(
  listing: PortListing,
  now = Date.now(),
): ListingAvailabilityAssessment {
  const availability = listing.availability ?? "unknown";
  const authoredLabel = {
    packages: "Upstream packages",
    "source-only": "Source only",
    unavailable: "Upstream unavailable",
    unknown: "Package availability unknown",
  }[availability];
  if (listing.availability_override_reason)
    return { availability, label: `${authoredLabel} (catalog setting)` };
  const observation = listing.upstream_observation;
  if (!observation) return { availability, label: authoredLabel };
  const assets = observation.releases.flatMap((release) => release.assets);
  const observedPlatforms = [...new Set(assets.flatMap((asset) => asset.platform_hints))];
  const observedAt = Date.parse(observation.observed_at ?? "");
  const freshUntil = Date.parse(observation.fresh_until ?? "");
  const observed = Number.isFinite(observedAt) && observedAt <= now;
  const fresh = observed && now < freshUntil;
  const facts = !observed
    ? "Package availability unknown"
    : observedPlatforms.length
      ? "Package candidates observed"
      : assets.length
        ? "Release assets observed; package availability unknown"
        : "No package observed in checked releases";
  const limits = [
    ...(observed && !fresh ? ["stale observation"] : []),
    ...(observation.status === "complete"
      ? []
      : [
          observation.status === "incomplete"
            ? "incomplete check"
            : observation.status === "unavailable"
              ? "check unavailable"
              : "check failed",
        ]),
  ];
  const label = limits.length ? `${facts} (${limits.join("; ")})` : facts;
  if (fresh && observation.status === "complete" && observedPlatforms.length)
    return { availability, label, observedPlatforms };
  // A bounded release window cannot establish that all upstream packages are absent.
  return {
    availability,
    label: availability !== "unknown" ? `${authoredLabel}. ${label}` : label,
  };
}

export function listingAvailabilityLabel(listing: PortListing, now = Date.now()): string {
  return assessListingAvailability(listing, now).label;
}

/** Display only: require one current Core assessment, never infer a permission. */
export function listingActionAssessment(
  status: PortListingStatus | undefined,
  action: PortListingStatus["actions"][number]["action"],
): { allowed: boolean; reason?: string } {
  const matches = status?.actions.filter((candidate) => candidate.action === action) ?? [];
  const assessment = matches[0];
  return matches.length === 1 && assessment && typeof assessment.allowed === "boolean"
    ? { allowed: assessment.allowed, ...(assessment.reason ? { reason: assessment.reason } : {}) }
    : {
        allowed: false,
        reason: "Current action availability is unavailable. Refresh the workspace to check again.",
      };
}

/** Choose a detail surface from Core facts; this does not authorize an operation. */
export function usesSelfServiceDetail(entry: CatalogEntry, status?: PortStatus): boolean {
  if (!entry.definition || entry.pendingSetup) return true;
  if (status?.external_runtime?.user_selected && entry.listingStatus) return true;
  if (status?.active || status?.staged || status?.external_runtime || !entry.listingStatus)
    return false;
  // Accepted-package preparation retains its existing checks and detailed review.
  if (entry.definition.release.provider === "user-prepared") return false;
  const installs = status?.port_actions?.filter((action) => action.action === "install") ?? [];
  return (
    installs.length === 1 &&
    installs[0]?.availability === "not_offered" &&
    ["unsupported_platform", "route_not_offered"].includes(installs[0].reason)
  );
}
