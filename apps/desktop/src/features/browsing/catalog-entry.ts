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
      "channels" | "release" | "source_profile" | "bios_source_profile" | "upstream_status"
    >
  > & {
    presentation?: Partial<NonNullable<PortDefinition["presentation"]>> | null;
    definition?: PortDefinition;
    listing?: PortListing;
    listingStatus?: PortListingStatus;
    pendingSetup?: PendingSetupRecord;
  };

/** One card per stable identity. Strict integrations keep their existing metadata. */
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
    if (definition) return { ...definition, ...shared };
    // The identity came from the accepted directory; no release, source, or
    // installation contract is manufactured to make a listing fit the browser.
    const identity = listings.get(id)!;
    return {
      id,
      name: identity.name,
      summary: identity.summary,
      platforms: identity.platforms ?? [],
      presentation: {
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

export function listingAvailabilityLabel(listing: PortListing): string {
  switch (listing.availability) {
    case "packages":
      return "Upstream packages";
    case "source-only":
      return "Source only";
    case "unavailable":
      return "Upstream unavailable";
    default:
      return "Package availability unknown";
  }
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
