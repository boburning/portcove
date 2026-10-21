/** Neutral data in the existing journal, never a positive review or grant. */
import { createHash } from "node:crypto";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import {
  currentPublishedSite,
  inspectPublishedCatalogMetadata,
} from "./release-catalog-metadata-contract.mts";
import { inspectCatalogInitialization } from "./release-catalog-publication-contract.mts";
import { inspectCatalogPublicationDescriptor } from "./release-catalog-publication-contract.mts";
import { isRecord } from "./runtime-values.mts";

export function inspectCatalogReviewRequest(raw: unknown) {
  if (raw == null) return null;
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "before_checkpoint,core_inspection,kind,opportunity,request_id,requested_at,schema_version" ||
    raw.schema_version !== 1 ||
    raw.kind !== "catalog-publication-semantic-review" ||
    typeof raw.before_checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.before_checkpoint) ||
    typeof raw.request_id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.request_id) ||
    typeof raw.requested_at !== "string" ||
    !Number.isFinite(Date.parse(raw.requested_at)) ||
    new Date(raw.requested_at).toISOString() !== raw.requested_at ||
    typeof raw.core_inspection !== "string" ||
    !raw.core_inspection.length ||
    Buffer.byteLength(raw.core_inspection) > 24 * 1024 ||
    Buffer.from(raw.core_inspection).toString("utf8") !== raw.core_inspection ||
    Buffer.byteLength(JSON.stringify(raw)) > 32 * 1024
  )
    throw new Error("neutral catalog review request schema or bound differs");
  const opportunity = inspectCatalogSemanticOpportunity(raw.opportunity);
  const inspection: unknown = JSON.parse(raw.core_inspection);
  if (
    !isRecord(inspection) ||
    Object.keys(inspection).sort().join(",") !==
      "authority,definitions,files,index_sha256,publication_schema,scope" ||
    inspection.publication_schema !== 1 ||
    inspection.authority !== "none" ||
    inspection.scope !== "inert-managed-definition-publication-inspection" ||
    !Array.isArray(inspection.files) ||
    !Array.isArray(inspection.definitions) ||
    digest(inspection.definitions) !== digest(opportunity.classification.definitions) ||
    inspection.index_sha256 !== opportunity.classification.index_sha256 ||
    `${JSON.stringify(inspection)}\n` !== raw.core_inspection ||
    createHash("sha256").update(raw.core_inspection).digest("hex") !==
      opportunity.core_inspection_sha256
  )
    throw new Error("neutral catalog request does not bind exact Core bytes and identities");
  const { request_id, ...identity } = raw;
  if (digest(identity) !== request_id) throw new Error("neutral catalog request digest differs");
  return {
    schema_version: 1 as const,
    kind: "catalog-publication-semantic-review" as const,
    before_checkpoint: raw.before_checkpoint,
    requested_at: raw.requested_at,
    opportunity,
    core_inspection: raw.core_inspection,
    request_id,
  };
}

export function createCatalogReviewRequest(input: {
  before_checkpoint: string;
  requested_at: string;
  opportunity: unknown;
  core_inspection: string;
}) {
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !==
      "before_checkpoint,core_inspection,opportunity,requested_at"
  )
    throw new Error("neutral catalog request constructor fields differ");
  const identity = {
    schema_version: 1,
    kind: "catalog-publication-semantic-review",
    ...structuredClone(input),
  };
  return inspectCatalogReviewRequest({ ...identity, request_id: digest(identity) })!;
}

/** Current journal identity only; actual provider/Tough/config acceptance is
 * established by the named controller and producer, never this comparison. */
export function assertCatalogReviewRequestBaseline(
  rawRequest: unknown,
  input: Record<string, unknown>,
) {
  const request = inspectCatalogReviewRequest(rawRequest);
  if (!request) throw new Error("catalog review request absent");
  const prior = request.opportunity.baseline;
  const catalog = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
  const site = currentPublishedSite(input);
  const initialization = inspectCatalogInitialization(input.catalog_initialization);
  if (
    prior.catalog_repository_sha256 !== (catalog?.repository_sha256 ?? null) ||
    prior.site_generation_sha256 !== (site?.generation_sha256 ?? null) ||
    prior.application_root_sha256 !== (site?.components.application?.root_sha256 ?? null) ||
    prior.application_repository_sha256 !==
      (site?.components.application?.repository_sha256 ?? null) ||
    (catalog &&
      (prior.catalog_root_sha256 !== catalog.root_sha256 ||
        prior.source_commit !== catalog.source_commit ||
        prior.source_tree !== catalog.source_tree)) ||
    (!catalog &&
      initialization &&
      (prior.catalog_root_sha256 !== initialization.root_sha256 ||
        prior.source_commit !== initialization.source_commit ||
        prior.source_tree !== initialization.source_tree ||
        request.opportunity.publisher_configuration_sha256 !==
          initialization.publisher_configuration_sha256))
  )
    throw new Error("catalog review request publication baseline changed");
  return request;
}

/** A positive request can retire only into the same exact catalog descriptor.
 * Negative retirement is separately authenticated; absence never means success. */
export function validateCatalogReviewRequestTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  const before = inspectCatalogReviewRequest(previous.catalog_review_request);
  const after = inspectCatalogReviewRequest(next.catalog_review_request);
  if (digest(before) === digest(after)) return;
  if (
    digest(previous.active_candidate ?? null) !== digest(next.active_candidate ?? null) ||
    digest(previous.review_request ?? null) !== digest(next.review_request ?? null) ||
    digest(previous.review_disposition ?? null) !== digest(next.review_disposition ?? null) ||
    digest(previous.opportunity ?? null) !== digest(next.opportunity ?? null)
  )
    throw new Error("catalog review cannot rewrite an application opportunity or reservation");
  if (!before && after) {
    assertCatalogReviewRequestBaseline(after, next);
    if (
      after.before_checkpoint !== checkpoint ||
      after.requested_at !== next.now ||
      next.active_candidate != null ||
      next.review_request != null ||
      next.catalog_publication != null ||
      next.metadata_renewal != null
    )
      throw new Error("catalog review needs exact idle checkpoint and frozen clock");
    return;
  }
  if (before && after)
    throw new Error("unconsumed catalog review request cannot be replaced or retimed");
  if (!before || next.catalog_publication == null)
    throw new Error("catalog review retirement requires exact authenticated result");
  const descriptor = inspectCatalogPublicationDescriptor(next.catalog_publication);
  for (const field of Object.keys(descriptor.prior) as (keyof typeof descriptor.prior)[])
    if (descriptor.prior[field] !== before.opportunity.baseline[field])
      throw new Error("catalog review retirement changed publication baseline");
  for (const field of [
    "source_commit",
    "source_tree",
    "bundle_sha256",
    "core_inspection_sha256",
    "publisher_configuration_sha256",
  ] as const)
    if (descriptor[field] !== before.opportunity[field])
      throw new Error("catalog review retirement changed reviewed inputs");
}
