import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { inspectCatalogReviewRequest } from "./release-catalog-review-request.mts";
import { isRecord } from "./runtime-values.mts";

function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("negative semantic disposition schema differs");
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("negative semantic disposition evidence digest absent");
  return value;
}

/** Shape and integrity only. Neither an imported report nor these digests prove
 * direct runtime capture, cleanup, issuer identity or request retirement. The
 * actual parent/broker must establish those before publishing this failure.
 * This deliberately cannot be consumed as accepted schema-2 classification. */
function inspectDisposition(raw: unknown, catalog: boolean) {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    "bundle_sha256,disposition,events_sha256,invocation_sha256,isolation_sha256,kind,opportunity,opportunity_sha256,request,request_id,review,schema_version,stage",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !==
      (catalog
        ? "catalog-publication-semantic-disposition"
        : "application-release-semantic-disposition") ||
    (value.disposition !== "changes-required" && value.disposition !== "refused") ||
    (catalog
      ? value.stage !== "complete-catalog-publication-opportunity"
      : value.stage !== "classification-proposal" && value.stage !== "complete-opportunity")
  )
    throw new Error("only explicit negative semantic outcomes are dispositions");
  const request = catalog
    ? inspectCatalogReviewRequest(value.request)
    : inspectReleaseReviewRequest(value.request);
  if (!request || value.request_id !== request.request_id)
    throw new Error("negative disposition differs from exact neutral request");
  const opportunity = catalog
    ? inspectCatalogReviewRequest(value.request)!.opportunity
    : value.stage === "complete-opportunity"
      ? validateOpportunity(value.opportunity)
      : null;
  if (catalog && capacityDigest(value.opportunity) !== capacityDigest(opportunity))
    throw new Error("negative catalog disposition opportunity differs from request");
  if (
    value.stage === "classification-proposal" &&
    (value.disposition !== "refused" ||
      value.opportunity !== null ||
      value.opportunity_sha256 !== null)
  )
    throw new Error("proposal refusal cannot manufacture a classified opportunity");
  if (catalog) {
    if (value.opportunity_sha256 !== capacityDigest(opportunity))
      throw new Error("negative catalog opportunity digest differs");
  } else if (opportunity) {
    const application = validateOpportunity(value.opportunity),
      applicationRequest = inspectReleaseReviewRequest(value.request)!;
    if (
      application.base_commit !== applicationRequest.base_commit ||
      application.source_commit !== applicationRequest.source_commit ||
      application.source_tree !== applicationRequest.source_tree ||
      application.change_set_sha256 !== applicationRequest.change_set_sha256 ||
      application.requested_channel !== applicationRequest.requested_channel ||
      application.classification.base_version !== applicationRequest.base_version ||
      application.classification.change_set_scope !== applicationRequest.change_set_scope ||
      value.opportunity_sha256 !== capacityDigest(application)
    )
      throw new Error("negative disposition differs from exact neutral request/opportunity");
  }
  const review = value.review;
  exact(review, "completed_at,coverage,report,report_sha256,runtime,scope,session_ref");
  let coverage: {
    accumulated_changes: boolean;
    classification: boolean;
    compatibility: boolean;
  } | null = null;
  if (catalog || value.stage === "complete-opportunity") {
    exact(review.coverage, "accumulated_changes,classification,compatibility");
    if (
      typeof review.coverage.accumulated_changes !== "boolean" ||
      typeof review.coverage.classification !== "boolean" ||
      typeof review.coverage.compatibility !== "boolean"
    )
      throw new Error("negative semantic review coverage incomplete");
    coverage = {
      accumulated_changes: review.coverage.accumulated_changes,
      classification: review.coverage.classification,
      compatibility: review.coverage.compatibility,
    };
  } else if (review.coverage !== null)
    throw new Error("proposal refusal has no invented full-review coverage");
  const scope = catalog
    ? "complete-catalog-publication-opportunity"
    : value.stage === "classification-proposal"
      ? "release-classification-proposal"
      : "complete-release-opportunity";
  if (
    review.runtime !== "codex-independent-local-review" ||
    review.scope !== scope ||
    typeof review.session_ref !== "string" ||
    !review.session_ref ||
    review.session_ref.length > 512 ||
    Array.from(review.session_ref).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    typeof review.report !== "string" ||
    !review.report.trim() ||
    Buffer.byteLength(review.report) > 48 * 1024 ||
    typeof review.completed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(review.completed_at) ||
    !Number.isFinite(Date.parse(review.completed_at)) ||
    new Date(review.completed_at).toISOString() !== review.completed_at.replace("Z", ".000Z") ||
    Date.parse(review.completed_at) < Math.floor(Date.parse(request.requested_at) / 1000) * 1000
  )
    throw new Error("negative semantic runtime evidence incomplete");
  const reportHash = createHash("sha256").update(review.report).digest("hex");
  if (review.report_sha256 !== reportHash)
    throw new Error("negative semantic report bytes changed");
  const result = {
    schema_version: 1 as const,
    kind: catalog
      ? ("catalog-publication-semantic-disposition" as const)
      : ("application-release-semantic-disposition" as const),
    stage: value.stage,
    disposition: value.disposition,
    request,
    request_id: request.request_id,
    opportunity,
    opportunity_sha256: opportunity ? capacityDigest(opportunity) : null,
    bundle_sha256: digest(value.bundle_sha256),
    invocation_sha256: digest(value.invocation_sha256),
    events_sha256: digest(value.events_sha256),
    isolation_sha256: digest(value.isolation_sha256),
    review: {
      runtime: "codex-independent-local-review" as const,
      scope,
      session_ref: review.session_ref,
      completed_at: review.completed_at,
      coverage,
      report: review.report,
      report_sha256: reportHash,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
    throw new Error("negative semantic wire exceeds provider bound");
  return result;
}
export function inspectNegativeSemanticDisposition(raw: unknown) {
  const result = inspectDisposition(raw, false);
  return {
    ...result,
    request: inspectReleaseReviewRequest(result.request)!,
    opportunity: result.opportunity === null ? null : validateOpportunity(result.opportunity),
  };
}
export function inspectNegativeCatalogSemanticDisposition(raw: unknown) {
  const result = inspectDisposition(raw, true),
    request = inspectCatalogReviewRequest(result.request)!;
  return {
    ...result,
    kind: "catalog-publication-semantic-disposition" as const,
    stage: "complete-catalog-publication-opportunity" as const,
    request,
    opportunity: request.opportunity,
    opportunity_sha256: capacityDigest(request.opportunity),
  };
}
export type NegativeSemanticDisposition = ReturnType<typeof inspectNegativeSemanticDisposition>;

/** Inert request serialization only; this function never posts or authenticates
 * any issuer. Failure conclusion plus the distinct wire cannot clear D1 holds. */
function prepareDispositionCheck(raw: unknown, catalog: boolean) {
  const wire = inspectDisposition(raw, catalog);
  const wire_sha256 = capacityDigest(wire);
  return {
    authority: "none" as const,
    wire,
    wire_sha256,
    proposed_request: {
      method: "POST" as const,
      endpoint: "repos/boburning/portcove/check-runs",
      body: {
        name: semanticReviewCheckName,
        head_sha:
          "opportunity" in wire.request
            ? wire.request.opportunity.source_commit
            : wire.request.source_commit,
        external_id: `${catalog ? "portcove-catalog-review-negative-v1" : "portcove-release-review-negative-v1"}:${wire_sha256}`,
        status: "completed" as const,
        conclusion: "failure" as const,
        completed_at: wire.review.completed_at,
        output: {
          title: catalog
            ? "Portcove independent catalog review disposition v1"
            : "Portcove independent release review disposition v1",
          summary: JSON.stringify(wire),
        },
      },
    },
  };
}

export function prepareNegativeSemanticDispositionCheck(raw: unknown) {
  return prepareDispositionCheck(raw, false);
}
export function prepareNegativeCatalogSemanticDispositionCheck(raw: unknown) {
  return prepareDispositionCheck(raw, true);
}
