// This one recovery replaces the catalog signing and Pages jobs with a longer
// original coordinator observer allocation. The existing capacity document and
// the retained checkpoint keep their ordinary workflow/resource identities.
export const retainedCatalogReviewRecoveryResources = Object.freeze({
  execution_ref: "refs/tags/portcove-production-controller-catalog-chameleon-review-window-r2",
  workflow_sha256: "878611d1d1aa20cd603748ff5a006dc3c73aa6e65703ff6f0c7d41bec3de129a",
  observer_job_minutes: 8,
  declared_job_minutes: 25,
});

export function matchesRetainedCatalogReviewRecoverySource(source: {
  execution_ref: string;
  workflow_sha256: string;
}) {
  const recovery = retainedCatalogReviewRecoveryResources;
  return (
    source.execution_ref === recovery.execution_ref &&
    source.workflow_sha256 === recovery.workflow_sha256
  );
}
