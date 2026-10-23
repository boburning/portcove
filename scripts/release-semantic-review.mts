import { createHash } from "node:crypto";
import { validateOpportunity } from "./release-coordinator.mts";
import { capacityDigest } from "./release-capacity.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectCatalogSemanticOpportunity,
  isCatalogSemanticPurpose,
} from "./release-catalog-semantic.mts";

import { semanticReviewCheckName } from "./release-control-phases.mts";
export { semanticReviewCheckName } from "./release-control-phases.mts";

/** Shape/integrity only: this does not authenticate a runtime or certify review. */
export function inspectSemanticReviewEvidence(
  raw: unknown,
  purpose: "application" | "catalog-publication" = "application",
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "completed_at,coverage,report,report_sha256,runtime,scope,session_ref"
  )
    throw new Error("semantic review evidence schema differs");
  if (
    raw.scope !==
      (purpose === "application"
        ? "complete-release-opportunity"
        : "complete-catalog-publication-opportunity") ||
    raw.runtime !== "codex-independent-local-review" ||
    typeof raw.session_ref !== "string" ||
    !raw.session_ref ||
    raw.session_ref.length > 512 ||
    Array.from(raw.session_ref).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    typeof raw.report !== "string" ||
    !raw.report.trim() ||
    Buffer.byteLength(raw.report) > 48 * 1024 ||
    typeof raw.completed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(raw.completed_at) ||
    !Number.isFinite(Date.parse(raw.completed_at)) ||
    new Date(raw.completed_at).toISOString() !== raw.completed_at.replace("Z", ".000Z")
  )
    throw new Error("implementation review or incomplete runtime record is not release acceptance");
  if (
    !isRecord(raw.coverage) ||
    Object.keys(raw.coverage).sort().join(",") !==
      "accumulated_changes,classification,compatibility" ||
    Object.values(raw.coverage).some((value) => value !== true)
  )
    throw new Error("semantic review omitted accumulated changes, classification or compatibility");
  const digest = createHash("sha256").update(raw.report).digest("hex");
  if (raw.report_sha256 !== digest) throw new Error("semantic review report bytes changed");
  return {
    runtime: raw.runtime,
    session_ref: raw.session_ref,
    scope: raw.scope,
    coverage: structuredClone(raw.coverage),
    completed_at: raw.completed_at,
    report: raw.report,
    report_sha256: digest,
  };
}

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
