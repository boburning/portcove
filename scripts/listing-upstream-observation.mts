import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import type { ProviderObservation } from "./upstream-observer.mts";

// A bounded descriptive window, never a complete-history or compatibility claim.
export const listingObservationPolicy = "provider-listing-window-v2";
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

/** Only already-supported public provider hosts can become observation sources. */
export function listingProviderIdentity(
  listing: Record<string, unknown>,
): { provider: "github" | "gitlab"; repository: string } | null {
  let url: URL;
  try {
    url = new URL(
      typeof listing.release_url === "string" ? listing.release_url : String(listing.project_url),
    );
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  const provider =
    url.hostname === "github.com" ? "github" : url.hostname === "gitlab.com" ? "gitlab" : null;
  if (!provider) return null;
  if (provider === "gitlab") {
    const parts = url.pathname.split("/").slice(1);
    const separator = parts.indexOf("-");
    const repositoryParts = separator < 0 ? parts : parts.slice(0, separator);
    if (repositoryParts.at(-1) === "") repositoryParts.pop();
    if (
      repositoryParts.length < 2 ||
      repositoryParts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.length > 255 ||
          !/^[A-Za-z0-9_.-]+$/u.test(part),
      ) ||
      (separator >= 0 && parts[separator + 1] !== "releases")
    )
      return null;
    repositoryParts[repositoryParts.length - 1] = repositoryParts.at(-1)!.replace(/\.git$/u, "");
    if (!repositoryParts.at(-1)) return null;
    return { provider, repository: repositoryParts.join("/") };
  }
  const match =
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/releases(?:\/.*)?)?\/?$/u.exec(
      url.pathname,
    );
  if (!match || match.slice(1).some((part) => part === "." || part === "..")) return null;
  return { provider, repository: `${match[1]}/${match[2]}` };
}

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
  return projectDescriptiveListing(
    listing,
    {
      format: 1,
      provider: "github",
      repository: observation.facts.repository.full_name,
      repositoryId: observation.facts.repository.id,
      completedAt: observation.completed_at,
      observedAt,
      factsHash: observation.facts_sha256,
      complete,
      releases,
    },
    staleAfterHours,
  );
}
interface DescriptiveRelease {
  id: number | { provider: "gitlab"; project_id: number; tag: string };
  version: string;
  release_url: string;
  published_at: string | null;
  provider_prerelease: boolean;
  assets_complete: boolean;
  assets: {
    platform_hints: string[];
    id: number;
    name: string;
    url: string;
    size: number;
    sha256: string | null;
  }[];
}
/** GitLab's native release identity is its tag, not an invented numeric GitHub ID. */
export function projectGitLabListingObservation<Listing extends Record<string, unknown>>(
  listing: Listing,
  observation: Record<string, unknown>,
  staleAfterHours: number,
) {
  const facts = observation.facts;
  const identity = listingProviderIdentity(listing);
  if (
    !identity ||
    identity.provider !== "gitlab" ||
    observation.format !== 3 ||
    observation.provider !== "gitlab" ||
    observation.authority !== "provider-observation-only" ||
    !isRecord(facts) ||
    observation.facts_sha256 !== observationHash(facts) ||
    !isRecord(facts.project) ||
    facts.project.path_with_namespace !== identity.repository ||
    !Number.isSafeInteger(facts.project.id) ||
    Number(facts.project.id) < 1 ||
    !Array.isArray(facts.releases) ||
    !Array.isArray(facts.packages) ||
    !isRecord(facts.package_files) ||
    !isRecord(facts.coverage) ||
    facts.coverage.releases !== true ||
    facts.coverage.packages !== true ||
    typeof observation.started_at !== "string" ||
    !Number.isFinite(Date.parse(observation.started_at)) ||
    typeof observation.completed_at !== "string" ||
    !Number.isFinite(Date.parse(observation.completed_at)) ||
    !Number.isInteger(staleAfterHours) ||
    staleAfterHours < 1 ||
    staleAfterHours > 48
  )
    throw new Error("Exact covered GitLab facts and listing identity are required");
  if (
    facts.releases.some(
      (release) =>
        !isRecord(release) ||
        typeof release.upcoming_release !== "boolean" ||
        typeof release.tag_name !== "string" ||
        !release.tag_name ||
        release.tag_name.length > 255 ||
        /\p{Cc}/u.test(release.tag_name) ||
        !isRecord(release.assets) ||
        !Array.isArray(release.assets.links),
    ) ||
    facts.packages.some(
      (item) =>
        !isRecord(item) ||
        !Number.isSafeInteger(item.id) ||
        Number(item.id) < 1 ||
        typeof item.name !== "string" ||
        !item.name ||
        typeof item.version !== "string" ||
        !item.version,
    )
  )
    throw new Error("GitLab descriptive rows have invalid native identities or coverage");
  const releases = (facts.releases as Record<string, unknown>[]).filter(
    (release) => release.upcoming_release === false,
  );
  const projectId = Number(facts.project.id);
  if (
    releases.some(
      (release) =>
        typeof release.tag_name !== "string" ||
        typeof release.released_at !== "string" ||
        !Number.isFinite(Date.parse(release.released_at)),
    )
  )
    throw new Error("Published descriptive release has no valid identity or publication clock");
  const projected: DescriptiveRelease[] = releases
    .toSorted(
      (a, b) =>
        Date.parse(String(b.released_at)) - Date.parse(String(a.released_at)) ||
        String(a.tag_name).localeCompare(String(b.tag_name)),
    )
    .slice(0, listingReleaseLimit)
    .map((release) => {
      const version = String(release.tag_name);
      const packages = facts.packages as unknown[];
      const files = facts.package_files as Record<string, unknown>;
      const candidates = packages
        .filter(isRecord)
        .filter((item) => item.version === version || item.version === version.replace(/^v/u, ""));
      const assets = candidates.flatMap((item) => {
        const rows = files[String(item.id)];
        if (!Array.isArray(rows)) throw new Error("GitLab package file coverage is missing");
        return rows.map((raw) => {
          if (
            !isRecord(raw) ||
            !Number.isSafeInteger(raw.id) ||
            Number(raw.id) < 1 ||
            typeof raw.file_name !== "string" ||
            !Number.isSafeInteger(raw.size) ||
            Number(raw.size) < 1 ||
            typeof raw.file_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/iu.test(raw.file_sha256)
          )
            throw new Error("GitLab package file metadata is invalid");
          const name = raw.file_name;
          return {
            id: Number(raw.id),
            name,
            size: Number(raw.size),
            sha256: raw.file_sha256.toLowerCase(),
            platform_hints: platformHints(listing, name),
            url: `https://gitlab.com/api/v4/projects/${projectId}/packages/generic/${encodeURIComponent(String(item.name))}/${encodeURIComponent(String(item.version))}/${encodeURIComponent(name)}`,
          };
        });
      });
      // Release links outside the supported generic registry are observed but not
      // promoted to packages with guessed sizes or integrity facts.
      const links =
        isRecord(release.assets) && Array.isArray(release.assets.links) ? release.assets.links : [];
      const assetsComplete =
        assets.length <= packageLimit &&
        links.every(
          (link) =>
            isRecord(link) &&
            assets.some((asset) => {
              const fileLink = `https://gitlab.com/${identity.repository}/-/package_files/${asset.id}/download`;
              return (
                link.url === asset.url ||
                link.direct_asset_url === asset.url ||
                link.url === fileLink ||
                link.direct_asset_url === fileLink
              );
            }),
        );
      return {
        id: { provider: "gitlab", project_id: projectId, tag: version },
        version,
        published_at: String(release.released_at),
        release_url: `https://gitlab.com/${identity.repository}/-/releases/${encodeURIComponent(version)}`,
        provider_prerelease: false,
        assets_complete: assetsComplete,
        assets: assets.slice(0, packageLimit),
      };
    });
  return projectDescriptiveListing(
    listing,
    {
      format: 2,
      provider: "gitlab",
      repository: identity.repository,
      repositoryId: Number(facts.project.id),
      completedAt: observation.completed_at,
      observedAt: observation.started_at,
      factsHash: String(observation.facts_sha256),
      complete: projected.every((release) => release.assets_complete),
      releases: projected,
    },
    staleAfterHours,
  );
}
function projectDescriptiveListing<Listing extends Record<string, unknown>>(
  listing: Listing,
  input: {
    format: 1 | 2;
    provider: "github" | "gitlab";
    repository: string;
    repositoryId: number;
    completedAt: string;
    observedAt: string;
    factsHash: string;
    complete: boolean;
    releases: DescriptiveRelease[];
  },
  staleAfterHours: number,
) {
  const { complete, observedAt, releases } = input;
  let upstream_observation: Record<string, unknown> = {
    provider: input.provider,
    repository: input.repository,
    repository_id: input.repositoryId,
    status: complete ? "complete" : "incomplete",
    attempted_at: input.completedAt,
    observed_at: observedAt,
    fresh_until: new Date(Date.parse(observedAt) + staleAfterHours * 3600000).toISOString(),
    facts_sha256: input.factsHash,
    release_limit: listingReleaseLimit,
    releases,
  };
  if (!complete && isRecord(listing.upstream_observation))
    upstream_observation = {
      ...currentDerivedLabels(listing.upstream_observation, listing),
      attempted_at: input.completedAt,
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
    format: input.format,
    authority: "descriptive-listing-observation-only",
    projection_policy: listingObservationPolicy,
    projection_input_sha256: listingProjectionHash,
    port_id: listing.id,
    repository_id: input.repositoryId,
    facts_sha256: input.factsHash,
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
  source: { provider?: string; repository: string; ports: { listing?: Record<string, unknown> }[] },
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
      isRecord(retained) &&
      retained.repository === source.repository &&
      (retained.provider ?? "github") === (source.provider ?? "github")
        ? currentDerivedLabels(retained, current)
        : undefined;
    if (!exception) return observation ? [{ ...current, upstream_observation: observation }] : [];
    return [
      {
        ...current,
        upstream_observation: {
          ...(observation ?? {
            provider: source.provider ?? "github",
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
