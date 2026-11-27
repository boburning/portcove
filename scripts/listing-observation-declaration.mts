import { observationHash } from "./upstream-observer.mts";

export function listingDeclarationHash(listing: Record<string, unknown>) {
  const declaration = { ...listing };
  delete declaration.upstream_observation;
  // A first-listed date does not change what the listing declares, so adding it
  // to every listing must not invalidate retained observations bound to this hash.
  delete declaration.listed_at;
  // Funding links are upstream descriptions refreshed independently of releases.
  delete declaration.funding_urls;
  // Technique and dependency explanations do not change the observed release scope.
  delete declaration.implementation;
  // Mod community navigation is independent of release identity and coverage.
  delete declaration.mod_portals;
  // A separate official setup is not evidence about this listing's releases.
  delete declaration.official_setup_id;
  return observationHash(declaration);
}
