/** Synthetic provider input passed through the REAL existing observer projector
 * and publication builder. Its fixed clock is exercised explicitly by Core. */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { observationHash } from "../upstream-observer.mts";
import type { ProviderObservation } from "../upstream-observer.mts";
import { projectListingObservation } from "../listing-upstream-observation.mts";
import { projectListingDelivery } from "../listing-observation-delivery.mts";
export const fixtureListing = {
  id: "new-unmanaged-port",
  name: "Observed unmanaged fixture",
  summary: "Provider metadata only; no managed definition or executable authority.",
  project_url: "https://github.com/owner/game",
  availability: "unknown",
  platforms: ["windows-x86-64"],
  download_asset_hints: { "windows-x86-64": ["windows", "x64"] },
};
export function fixturePolicy(listing: Record<string, unknown> = fixtureListing) {
  const facts = {
    repository: {
      id: 42,
      full_name: "owner/game",
      default_branch: "main",
      archived: false,
      disabled: false,
      fork: false,
    },
    releases: [
      {
        id: 7,
        tag_name: "v1.0",
        name: "v1.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
        assets: [
          {
            id: 11,
            name: "game-windows-x64.zip",
            browser_download_url:
              "https://github.com/owner/game/releases/download/v1.0/game-windows-x64.zip",
            size: 42,
            digest: null,
          },
        ],
      },
    ],
  };
  const observation = {
    format: 1,
    authority: "provider-observation-only",
    config_sha256: "a".repeat(64),
    port_id: String(listing.id),
    started_at: "2026-11-10T00:00:00Z",
    completed_at: "2026-11-10T00:00:01Z",
    facts_sha256: observationHash(facts),
    facts,
    consumed: { requests: 3, response_bytes: 1000, conditional_hits: 0 },
  } as unknown as ProviderObservation;
  return projectListingObservation(listing, observation, 12);
}
export function fixtureDelivery() {
  const policy = fixturePolicy();
  return projectListingDelivery(
    { format_version: 11, listings: [fixtureListing] },
    [policy.listing_update],
    null,
  ).bytes;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(fixtureDelivery());
