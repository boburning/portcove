// This one recovery replaces the catalog signing and Pages jobs with a longer
// original coordinator observer allocation. The existing capacity document and
// the retained checkpoint keep their ordinary workflow/resource identities.
export const retainedCatalogReviewRecoveryResources = Object.freeze({
  execution_ref: "refs/tags/portcove-production-controller-catalog-chameleon-review-window",
  workflow_sha256: "2fb0ff02954084bafb214347012e858ac11a75c4b1f22dec028228785caed6de",
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
