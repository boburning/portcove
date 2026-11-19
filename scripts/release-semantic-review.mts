import { createHash } from "node:crypto";
import { validateOpportunity } from "./release-opportunity.mts";
import { capacityDigest } from "./release-capacity.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectCatalogSemanticOpportunity,
  isCatalogSemanticPurpose,
} from "./release-catalog-semantic.mts";

import { semanticReviewCheckName } from "./release-control-phases.mts";
export { semanticReviewCheckName } from "./release-control-phases.mts";
import { inspectSemanticReviewEvidence } from "./release-semantic-review-evidence.mts";
export { inspectSemanticReviewEvidence } from "./release-semantic-review-evidence.mts";

/** Inactive serializer for the existing consumer, not a classifier, authenticated
 * transport, credential broker or execution grant. Actual admitted runtime and
 * App identity remain separate requirements. No POST/CLI exists here.
 */
export function prepareSemanticReviewHandoff(rawOpportunity: unknown, rawReview: unknown) {
  const catalog = isCatalogSemanticPurpose(rawOpportunity);
  const opportunity = catalog
    ? inspectCatalogSemanticOpportunity(structuredClone(rawOpportunity))
    : validateOpportunity(structuredClone(rawOpportunity));
  if (!catalog) {
    const application = validateOpportunity(rawOpportunity);
    parseVersionClassification(application.classification);
    if (application.classification.change_set_scope !== "portcove-release-net-tree-delta-v1")
      throw new Error("semantic review needs the complete versioned accumulated opportunity");
  }
  if (
    !isRecord(rawReview) ||
    Object.keys(rawReview).sort().join(",") !==
      "accepted_opportunity,completed_at,coverage,report,runtime,scope,session_ref"
  )
    throw new Error("semantic review record schema differs");
  const { accepted_opportunity: accepted, ...record } = rawReview;
  const evidence = inspectSemanticReviewEvidence(
    {
      ...record,
      report_sha256:
        typeof record.report === "string"
          ? createHash("sha256").update(record.report).digest("hex")
          : null,
    },
    catalog ? "catalog-publication" : "application",
  );
  const digest = capacityDigest(opportunity);
  if (
    capacityDigest(
      catalog ? inspectCatalogSemanticOpportunity(accepted) : validateOpportunity(accepted),
    ) !== digest
  )
    throw new Error("semantic review accepted different exact inputs");
  const summary = JSON.stringify({
    schema_version: catalog ? 3 : 2,
    ...(catalog ? { purpose: "catalog-publication" } : {}),
    opportunity,
    opportunity_sha256: digest,
    review: evidence,
  });
  if (Buffer.byteLength(summary) > 64 * 1024)
    throw new Error("semantic review wire summary exceeds provider bound");
  return {
    authority: "none",
    qualification: "serialization only; runtime and issuer are not authenticated here",
    evidence: { ...evidence, opportunity, opportunity_sha256: digest },
    proposed_request: {
      method: "POST",
      endpoint: "repos/boburning/portcove/check-runs",
      body: {
        name: semanticReviewCheckName,
        head_sha: opportunity.source_commit,
        external_id: catalog
          ? `portcove-catalog-review-v1:${digest}`
          : `portcove-release-review-v2:${digest}`,
        status: "completed",
        conclusion: "success",
        completed_at: evidence.completed_at,
        output: {
          title: catalog
            ? "Portcove independent catalog review v1"
            : "Portcove independent release review v1",
          summary,
        },
      },
    },
  };
}
