import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
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
export function inspectNegativeSemanticDisposition(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    "bundle_sha256,disposition,events_sha256,invocation_sha256,isolation_sha256,kind,opportunity,opportunity_sha256,request,request_id,review,schema_version",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !== "application-release-semantic-disposition" ||
    (value.disposition !== "changes-required" && value.disposition !== "refused")
  )
    throw new Error("only explicit negative semantic outcomes are dispositions");
  const request = inspectReleaseReviewRequest(value.request);
  const opportunity = validateOpportunity(value.opportunity);
  if (
    !request ||
    value.request_id !== request.request_id ||
    opportunity.base_commit !== request.base_commit ||
    opportunity.source_commit !== request.source_commit ||
    opportunity.source_tree !== request.source_tree ||
    opportunity.change_set_sha256 !== request.change_set_sha256 ||
    opportunity.requested_channel !== request.requested_channel ||
    opportunity.classification.base_version !== request.base_version ||
    opportunity.classification.change_set_scope !== request.change_set_scope ||
    value.opportunity_sha256 !== capacityDigest(opportunity)
  )
    throw new Error("negative disposition differs from exact neutral request/opportunity");
  const review = value.review;
  exact(review, "completed_at,coverage,report,report_sha256,runtime,scope,session_ref");
  exact(review.coverage, "accumulated_changes,classification,compatibility");
  if (
    review.runtime !== "codex-independent-local-review" ||
    review.scope !== "complete-release-opportunity" ||
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
    Date.parse(review.completed_at) < Math.floor(Date.parse(request.requested_at) / 1000) * 1000 ||
    typeof review.coverage.accumulated_changes !== "boolean" ||
    typeof review.coverage.classification !== "boolean" ||
    typeof review.coverage.compatibility !== "boolean"
  )
    throw new Error("negative semantic runtime evidence incomplete");
  const reportHash = createHash("sha256").update(review.report).digest("hex");
  if (review.report_sha256 !== reportHash)
    throw new Error("negative semantic report bytes changed");
  const result = {
    schema_version: 1 as const,
    kind: "application-release-semantic-disposition" as const,
    disposition: value.disposition,
    request,
    request_id: request.request_id,
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    bundle_sha256: digest(value.bundle_sha256),
    invocation_sha256: digest(value.invocation_sha256),
    events_sha256: digest(value.events_sha256),
    isolation_sha256: digest(value.isolation_sha256),
    review: {
      runtime: "codex-independent-local-review" as const,
      scope: "complete-release-opportunity" as const,
      session_ref: review.session_ref,
      completed_at: review.completed_at,
      coverage: {
        accumulated_changes: review.coverage.accumulated_changes,
        classification: review.coverage.classification,
        compatibility: review.coverage.compatibility,
      },
      report: review.report,
      report_sha256: reportHash,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
    throw new Error("negative semantic wire exceeds provider bound");
  return result;
}
export type NegativeSemanticDisposition = ReturnType<typeof inspectNegativeSemanticDisposition>;

/** Inert request serialization only; this function never posts or authenticates
 * any issuer. Failure conclusion plus the distinct wire cannot clear D1 holds. */
export function prepareNegativeSemanticDispositionCheck(raw: unknown) {
  const wire = inspectNegativeSemanticDisposition(raw);
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
        head_sha: wire.request.source_commit,
        external_id: `portcove-release-review-negative-v1:${wire_sha256}`,
        status: "completed" as const,
        conclusion: "failure" as const,
        completed_at: wire.review.completed_at,
        output: {
          title: "Portcove independent release review disposition v1",
          summary: JSON.stringify(wire),
        },
      },
    },
  };
}
