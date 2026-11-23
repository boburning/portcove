import { isRecord } from "./runtime-values.mts";

/**
 * One reader for authored `upstream_observation` values and listing observer
 * reports, shared by the read-only catalog reports. It interprets; it never
 * validates or accepts an observation (Core and the observer own that).
 *
 * A `complete` observation (or a legacy one with no status) counts as complete
 * only when it binds its facts with a 64-hex `facts_sha256`, as Core requires
 * of every complete observation. Without that digest the facts are unbound and
 * the observation reads as `incomplete`.
 */

export type ListingObservationState = "complete" | "incomplete" | "unavailable" | "failed";
export interface ListingObservedAsset {
  name: string | null;
  sha256: string | null;
  platform_hints: string[];
}
export interface ListingObservedRelease {
  version: string | null;
  published_at: string | null;
  assets: ListingObservedAsset[];
}
export interface ListingObservation {
  state: ListingObservationState;
  /** The bound fact digest of a complete observation; null otherwise. */
  facts_sha256: string | null;
  /** Releases of a complete observation; empty otherwise. */
  releases: ListingObservedRelease[];
}

const factsDigest = /^[0-9a-f]{64}$/iu;
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export function readListingObservation(observation: unknown): ListingObservation | undefined {
  if (!isRecord(observation)) return undefined;
  const status = observation.status;
  // `complete` is the producer's success; an absent status is a legacy success.
  if (status !== undefined && status !== "complete") {
    const state = (["incomplete", "unavailable", "failed"] as const).find(
      (known) => known === status,
    );
    return { state: state ?? "failed", facts_sha256: null, releases: [] };
  }
  const digest = observation.facts_sha256;
  if (typeof digest !== "string" || !factsDigest.test(digest))
    return { state: "incomplete", facts_sha256: null, releases: [] };
  return {
    state: "complete",
    facts_sha256: digest.toLowerCase(),
    releases: (Array.isArray(observation.releases) ? observation.releases : []).flatMap(
      (release: unknown) =>
        isRecord(release)
          ? [
              {
                version: text(release.version),
                published_at: text(release.published_at),
                assets: (Array.isArray(release.assets) ? release.assets : []).flatMap(
                  (asset: unknown) =>
                    isRecord(asset)
                      ? [
                          {
                            name: text(asset.name),
                            sha256: text(asset.sha256),
                            platform_hints: (Array.isArray(asset.platform_hints)
                              ? asset.platform_hints
                              : []
                            ).filter((hint: unknown): hint is string => typeof hint === "string"),
                          },
                        ]
                      : [],
                ),
              },
            ]
          : [],
    ),
  };
}

/**
 * Observations from an observer report: listing updates, `{ listings }`, or
 * observer policies with `listing_update`. An entry without an observation
 * leaves the committed observation in place.
 */
export function observerListingObservations(report: unknown, known: ReadonlySet<string>) {
  const result = new Map<string, ListingObservation>();
  if (report === undefined) return result;
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries))
    throw new Error("Observer report needs a listings array of listing updates.");
  for (const raw of entries) {
    const entry: unknown = isRecord(raw) && isRecord(raw.listing_update) ? raw.listing_update : raw;
    if (!isRecord(entry) || typeof entry.id !== "string")
      throw new Error("Observer report contains a listing without an id.");
    if (!known.has(entry.id))
      throw new Error(`Observer report names ${entry.id}, which is not a catalog identity.`);
    const observed = readListingObservation(entry.upstream_observation);
    if (observed) result.set(entry.id, observed);
  }
  return result;
}
