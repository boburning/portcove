import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import type { ProviderObservation } from "./upstream-observer.mts";

// A bounded descriptive window, never a complete-history or compatibility claim.
export const listingObservationPolicy = "github-listing-window-v1";
export const listingReleaseLimit = 4;
// Reprojection follows actual implementation and schema-inventory changes too.
export const listingProjectionHash = observationHash({
  policy: listingObservationPolicy,
  implementation: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  platforms,
});
export function listingDeclarationHash(listing: Record<string, unknown>) {
  const declaration = { ...listing };
  delete declaration.upstream_observation;
  return observationHash(declaration);
}
const packageLimit = 32;

export function listingObservationReleaseIds(observation: ProviderObservation): number[] {
  if (
    observation.facts.releases.some(
      (release) =>
        !release.draft &&
        (!release.published_at || !Number.isFinite(Date.parse(release.published_at))),
    )
  )
    throw new Error("Published descriptive release has no valid publication clock");
  return observation.facts.releases
    .filter((release) => !release.draft)
    .toSorted((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!) || b.id - a.id)
    .slice(0, listingReleaseLimit)
    .map((release) => release.id);
}

/** Consumes already collected provider facts. No network, resolver or acquisition authority. */
function platformHints(listing: Record<string, unknown>, name: string) {
  return platforms.filter((platform) => {
    const hints = isRecord(listing.download_asset_hints)
      ? listing.download_asset_hints[platform]
      : undefined;
    return (
      Array.isArray(hints) &&
      hints.length > 0 &&
      hints.every(
        (hint) => typeof hint === "string" && name.toLowerCase().includes(hint.toLowerCase()),
      )
    );
  });
}

function currentDerivedLabels(
  observation: Record<string, unknown>,
  listing: Record<string, unknown>,
) {
  const retained = structuredClone(observation);
  if (Array.isArray(retained.releases))
    retained.releases = retained.releases.map((release: unknown) => {
      if (!isRecord(release) || !Array.isArray(release.assets)) return release;
      return {
        ...release,
        assets: release.assets.map((asset: unknown) =>
          isRecord(asset) && typeof asset.name === "string"
            ? { ...asset, platform_hints: platformHints(listing, asset.name) }
            : asset,
        ),
      };
    });
  return retained;
}

export function projectListingObservation<Listing extends Record<string, unknown>>(
  listing: Listing,
  observation: ProviderObservation,
  staleAfterHours: number,
) {
  if (
    typeof listing.id !== "string" ||
    observation.authority !== "provider-observation-only" ||
    observation.facts_sha256 !== observationHash(observation.facts) ||
    !Number.isInteger(staleAfterHours) ||
    staleAfterHours < 1 ||
    staleAfterHours > 48
  )
    throw new Error("Exact bounded provider facts and listing identity are required");
  const selected = new Set(listingObservationReleaseIds(observation));
  const covered =
    observation.format === 1 ? selected : new Set(observation.coverage?.asset_release_ids ?? []);
  const complete =
    [...selected].every((id) => covered.has(id)) &&
    observation.facts.releases
      .filter((release) => selected.has(release.id))
      .every((release) => release.assets.length <= packageLimit);
  const observedAt = observation.validation_started_at ?? observation.completed_at;
  const releases = observation.facts.releases
    .filter((release) => selected.has(release.id))
    .map((release) => ({
      id: release.id,
      version: release.tag_name,
      release_url: `https://github.com/${observation.facts.repository.full_name}/releases/tag/${encodeURIComponent(release.tag_name)}`,
      published_at: release.published_at,
      provider_prerelease: release.prerelease,
      assets_complete: covered.has(release.id) && release.assets.length <= packageLimit,
      assets: release.assets.slice(0, packageLimit).map((asset) => ({
        // Authored literal filename hints only; these labels do not establish compatibility.
        platform_hints: platformHints(listing, asset.name),
        id: asset.id,
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        // Provider claim only. It is not independent byte verification.
        sha256: asset.digest?.replace(/^sha256:/iu, "").toLowerCase() ?? null,
      })),
    }));
  let upstream_observation: Record<string, unknown> = {
    provider: "github",
    repository: observation.facts.repository.full_name,
    repository_id: observation.facts.repository.id,
    status: complete ? "complete" : "incomplete",
    attempted_at: observation.completed_at,
    observed_at: observedAt,
    fresh_until: new Date(Date.parse(observedAt) + staleAfterHours * 3600000).toISOString(),
    facts_sha256: observation.facts_sha256,
    release_limit: listingReleaseLimit,
    releases,
  };
  if (!complete && isRecord(listing.upstream_observation))
    upstream_observation = {
      ...currentDerivedLabels(listing.upstream_observation, listing),
      attempted_at: observation.completed_at,
      status: "incomplete",
    };
  const maintenance = isRecord(listing.release_maintenance)
    ? listing.release_maintenance
    : undefined;
  const pins = Array.isArray(maintenance?.pinned_releases)
    ? maintenance.pinned_releases.filter(isRecord)
    : [];
  const newer = releases.filter((release) =>
    pins.some(
      (pin) =>
        typeof pin.published_at === "string" &&
        pin.version !== release.version &&
        Date.parse(release.published_at!) > Date.parse(pin.published_at),
    ),
  );
  return {
    ...(maintenance
      ? {
          pin_reconsideration: {
            status: newer.length
              ? "newer-release-observed"
              : pins.some((pin) => typeof pin.published_at !== "string")
                ? "unknown"
                : "no-newer-release-in-observed-window",
            candidates: newer.map((release) => ({
              id: release.id,
              version: release.version,
              release_url: release.release_url,
            })),
            reason: maintenance.reason,
            reconsider_when: maintenance.reconsider_when,
            scope:
              "Observation triggers bounded compatibility reassessment; no plausible compatibility, accepted replacement or managed acquisition is inferred.",
          },
        }
      : {}),
    format: 1,
    authority: "descriptive-listing-observation-only",
    projection_policy: listingObservationPolicy,
    projection_input_sha256: listingProjectionHash,
    port_id: listing.id,
    repository_id: observation.facts.repository.id,
    facts_sha256: observation.facts_sha256,
    catalog_definition_sha256: listingDeclarationHash(listing),
    // Deliberately no managed channel/artifact eligibility projection.
    projections: [],
    listing_update: { ...structuredClone(listing), upstream_observation },
  };
}

/** A failed attempt annotates retained facts without advancing their success/freshness clocks. */
export function listingUpdatesForReport(
  policies: readonly unknown[],
  report: unknown,
  attemptedAt: string,
  source: { repository: string; ports: { listing?: Record<string, unknown> }[] },
): (Record<string, unknown> & { upstream_observation: Record<string, unknown> })[] {
  const exception = isRecord(report) && isRecord(report.exception) ? report.exception : undefined;
  const rule = typeof exception?.rule === "string" ? exception.rule : "failed";
  const status = /budget|incomplete/u.test(rule)
    ? "incomplete"
    : /unavailable|rate.limit|backoff/u.test(rule)
      ? "unavailable"
      : "failed";
  return source.ports.flatMap((consumer) => {
    if (!consumer.listing) return [];
    const current = structuredClone(consumer.listing);
    const historical = policies.find(
      (policy) =>
        isRecord(policy) && policy.port_id === current.id && isRecord(policy.listing_update),
    );
    const proposed =
      isRecord(historical) && isRecord(historical.listing_update)
        ? historical.listing_update.upstream_observation
        : undefined;
    // Current authored facts always win. Historical policies carry only applicable observations.
    const retained =
      !exception && isRecord(proposed)
        ? proposed
        : isRecord(current.upstream_observation)
          ? current.upstream_observation
          : proposed;
    const observation =
      isRecord(retained) && retained.repository === source.repository
        ? currentDerivedLabels(retained, current)
        : undefined;
    if (!exception) return observation ? [{ ...current, upstream_observation: observation }] : [];
    return [
      {
        ...current,
        upstream_observation: {
          ...(observation ?? {
            provider: "github",
            repository: source.repository,
            repository_id: null,
            observed_at: null,
            fresh_until: null,
            facts_sha256: null,
            release_limit: listingReleaseLimit,
            releases: [],
          }),
          attempted_at: attemptedAt,
          status,
        },
      },
    ];
  });
}
