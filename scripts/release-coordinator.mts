import { inspectCatalogReviewDisposition } from "./release-catalog-review-disposition.mts";
import {
  inspectCatalogReviewRequest,
  assertCatalogReviewRequestBaseline,
} from "./release-catalog-review-request.mts";
import { inspectPublicationReportRepair } from "./release-report-repair-contract.mts";
import {
  inspectCatalogPublicationDescriptor,
  inspectCatalogInitialization,
} from "./release-catalog-publication-contract.mts";
import {
  inspectPublishedCatalogMetadata,
  currentPublishedSite,
  assertCatalogPublicationBaseline,
} from "./release-catalog-metadata-contract.mts";
import { assessBoundedCapacity, capacityDigest } from "./release-capacity.mts";
import {
  inspectPublishedMetadata,
  applicationMetadataMaintenancePriority,
  inspectMetadataRenewalDescriptor,
  inspectMetadataBootstrapDescriptor,
} from "./release-metadata-contract.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectPreviewWithdrawals } from "./release-preview-withdrawals.mts";
import { inspectCandidateStageEvidence } from "./release-candidate-progress-contract.mts";
import {
  inspectReleaseReviewRequest,
  inspectReleaseReviewDisposition,
} from "./release-review-request.mts";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyApplicationVersion,
  proposeApplicationVersion,
  parseVersionClassification,
} from "../apps/desktop/scripts/release-version-policy.mts";

const scriptPath = fileURLToPath(import.meta.url);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const publicationFreshnessMilliseconds = 15 * 60 * 1000;
const phases = new Set(["prepared", "qualifying", "building", "publishing", "promoting"]);
const failureKinds = new Set(["transient", "substantive", "authority"]);

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  object(value, label);
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

function sha(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error(`${label} must be an exact lowercase commit identity`);
  return value;
}

function text(value: unknown, label: string, maximum = 128) {
  const containsControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character: string) => {
      const codePoint = character.codePointAt(0);
      return (codePoint ?? 0) <= 0x1f || codePoint === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    containsControlCharacter
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function boundedCount(value: unknown, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${label} is outside its bounded budget`);
  return value;
}

function instant(value: unknown, label: string): number;
function instant(value: unknown, label: string, optional: true): number | null;
function instant(value: unknown, label: string, optional = false) {
  if (optional && value === null) return null;
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${label} must be a canonical UTC instant`);
  return milliseconds;
}

function uniqueStrings(
  value: unknown,
  label: string,
  validate: (value: unknown, label: string) => string = text,
) {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must be an array`);
  const raw: unknown[] = value;
  const checked = raw.map((entry) => validate(entry, `${label} entry`));
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  if (JSON.stringify(value) !== JSON.stringify([...checked].sort()))
    throw new Error(`${label} must be sorted`);
  return checked;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries: unknown[] = value;
    return entries.map(stable);
  }
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

interface Decision<Action extends string> {
  schema_version: number;
  action: Action;
  reason: string;
  authority: Authority;
  plan_sha256: string;
}
function plan<Action extends string, Details extends object>(
  action: Action,
  reason: string,
  authority: Authority,
  details: Details,
): Decision<Action> & Details;
function plan<Action extends string>(
  action: Action,
  reason: string,
  authority: Authority,
): Decision<Action>;
function plan(action: string, reason: string, authority: Authority, details: object = {}) {
  const unsigned = {
    schema_version: 1,
    action,
    reason,
    authority,
    ...details,
  };
  return {
    ...unsigned,
    plan_sha256: createHash("sha256")
      .update(JSON.stringify(stable(unsigned)))
      .digest("hex"),
  };
}

function validateController(controller: unknown, schema: number) {
  if (schema === 2) {
    exactKeys(
      controller,
      ["workflow", "revision", "publication_paused", "capacity_attempt"],
      [],
      "controller",
    );
    return {
      workflow: text(controller.workflow, "controller workflow", 256),
      revision: sha(controller.revision, "controller revision"),
      publication_paused: boolean(controller.publication_paused, "publication pause"),
      capacity: assessBoundedCapacity(controller.capacity_attempt),
      free_capacity_available: undefined,
    };
  }
  exactKeys(
    controller,
    ["workflow", "revision", "publication_paused", "free_capacity_available"],
    [],
    "controller",
  );
  text(controller.workflow, "controller workflow", 256);
  sha(controller.revision, "controller revision");
  boolean(controller.publication_paused, "publication pause");
  boolean(controller.free_capacity_available, "free capacity availability");
  return {
    workflow: text(controller.workflow, "controller workflow", 256),
    revision: sha(controller.revision, "controller revision"),
    publication_paused: boolean(controller.publication_paused, "publication pause"),
    free_capacity_available: boolean(
      controller.free_capacity_available,
      "free capacity availability",
    ),
  };
}

export function validateOpportunity(opportunity: unknown) {
  exactKeys(
    opportunity,
    [
      "source_commit",
      "source_tree",
      "base_commit",
      "change_set_sha256",
      "complete_change_set",
      "meaningful",
      "documentation_only",
      "urgency",
      "requested_channel",
      "classification",
    ],
    [],
    "release opportunity",
  );
  sha(opportunity.source_commit, "opportunity source commit");
  sha(opportunity.source_tree, "opportunity source tree");
  sha(opportunity.base_commit, "opportunity base commit");
  if (
    typeof opportunity.change_set_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(opportunity.change_set_sha256)
  )
    throw new Error("opportunity change-set digest is invalid");
  boolean(opportunity.complete_change_set, "complete change set");
  boolean(opportunity.meaningful, "meaningful change");
  boolean(opportunity.documentation_only, "documentation-only change");
  boolean(opportunity.urgency, "urgency");
  if (!opportunity.complete_change_set)
    throw new Error("release opportunity requires a complete accumulated change set");
  if (opportunity.requested_channel !== "preview" && opportunity.requested_channel !== "stable")
    throw new Error("requested channel must be preview or stable");
  object(opportunity.classification, "reviewed classification");
  if (opportunity.classification.preview_withdrawals !== undefined) {
    inspectPreviewWithdrawals(opportunity.classification.preview_withdrawals);
    if (opportunity.requested_channel !== "preview")
      throw new Error("Preview withdrawals cannot appoint Stable eligibility");
  }
  if (
    opportunity.classification.source_commit !== opportunity.source_commit ||
    opportunity.classification.reviewed_commit !== opportunity.source_commit ||
    opportunity.classification.source_tree !== opportunity.source_tree ||
    opportunity.classification.reviewed_tree !== opportunity.source_tree ||
    opportunity.classification.change_set_sha256 !== opportunity.change_set_sha256
  )
    throw new Error("reviewed classification is stale for the candidate identity");
  return {
    source_commit: sha(opportunity.source_commit, "opportunity source commit"),
    source_tree: sha(opportunity.source_tree, "opportunity source tree"),
    base_commit: sha(opportunity.base_commit, "opportunity base commit"),
    change_set_sha256: opportunity.change_set_sha256,
    complete_change_set: boolean(opportunity.complete_change_set, "complete change set"),
    meaningful: boolean(opportunity.meaningful, "meaningful change"),
    documentation_only: boolean(opportunity.documentation_only, "documentation-only change"),
    urgency: boolean(opportunity.urgency, "urgency"),
    requested_channel: opportunity.requested_channel,
    classification: opportunity.classification,
  };
}

function validatePublication(publication: unknown, now: number) {
  exactKeys(
    publication,
    [
      "complete",
      "observed_at",
      "published_versions",
      "published_sources",
      "reserved_versions",
      "last_routine_preview_at",
    ],
    ["last_routine_preview_bound"],
    "publication inventory",
  );
  if (
    Object.hasOwn(publication, "last_routine_preview_bound") &&
    publication.last_routine_preview_bound !== "all-published-previews"
  )
    throw new Error("unsupported Preview cadence upper-bound scope");
  if (publication.complete !== true) throw new Error("publication inventory is incomplete");
  const observed = instant(publication.observed_at, "publication observation");
  if (observed > now) throw new Error("publication observation is in the future");
  if (now - observed > publicationFreshnessMilliseconds)
    throw new Error("publication inventory is stale");
  uniqueStrings(publication.published_versions, "published versions");
  uniqueStrings(publication.published_sources, "published sources", sha);
  uniqueStrings(publication.reserved_versions, "reserved versions");
  const lastPreview = instant(publication.last_routine_preview_at, "last routine Preview", true);
  if (lastPreview !== null && lastPreview > now)
    throw new Error("last routine Preview is in the future");
  return {
    observed_at: text(publication.observed_at, "publication observation"),
    published_versions: uniqueStrings(publication.published_versions, "published versions"),
    published_sources: uniqueStrings(publication.published_sources, "published sources", sha),
    reserved_versions: uniqueStrings(publication.reserved_versions, "reserved versions"),
    observed,
    lastPreview,
  };
}

function validateActive(active: unknown) {
  if (active === null) return null;
  exactKeys(
    active,
    [
      "source_commit",
      "source_tree",
      "prepared_commit",
      "prepared_tree",
      "version",
      "intent_sha256",
      "phase",
      "failure_kind",
      "transient_retries",
      "substantive_repairs",
    ],
    ["release_run", "frozen_opportunity", "stage_evidence", "report_repair"],
    "active candidate",
  );
  for (const field of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"])
    sha(active[field], `active candidate ${field}`);
  if (typeof active.intent_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(active.intent_sha256))
    throw new Error("active candidate intent digest is invalid");
  text(active.version, "active candidate version");
  classifyApplicationVersion(active.version);
  if (typeof active.phase !== "string" || (!phases.has(active.phase) && active.phase !== "failed"))
    throw new Error("active candidate phase is invalid or terminal");
  if (active.phase === "failed") {
    if (typeof active.failure_kind !== "string" || !failureKinds.has(active.failure_kind))
      throw new Error("failed active candidate requires a failure kind");
  } else if (active.failure_kind !== null) {
    throw new Error("nonfailed active candidate cannot carry a failure kind");
  }
  boundedCount(active.transient_retries, 2, "transient retries");
  boundedCount(active.substantive_repairs, 3, "substantive repairs");
  if (Object.hasOwn(active, "frozen_opportunity")) {
    const frozen = validateOpportunity(active.frozen_opportunity);
    parseVersionClassification(frozen.classification);
    if (frozen.source_commit !== active.source_commit || frozen.source_tree !== active.source_tree)
      throw new Error("frozen opportunity differs from active original source");
  }
  if (active.report_repair !== undefined)
    inspectPublicationReportRepair(active.report_repair, active);
  if (active.release_run !== undefined && active.release_run !== null) {
    exactKeys(active.release_run, ["run_id", "attempt", "revision"], [], "release run");
    if (
      typeof active.release_run.run_id !== "number" ||
      !Number.isSafeInteger(active.release_run.run_id) ||
      active.release_run.run_id < 1
    )
      throw new Error("release run ID is invalid");
    if (
      typeof active.release_run.attempt !== "number" ||
      !Number.isSafeInteger(active.release_run.attempt) ||
      active.release_run.attempt < 1
    )
      throw new Error("release run attempt is invalid");
    if (active.release_run.revision !== active.prepared_commit)
      throw new Error("release run is not bound to the prepared commit");
  }
  return {
    source_commit: sha(active.source_commit, "active source commit"),
    source_tree: sha(active.source_tree, "active source tree"),
    prepared_commit: sha(active.prepared_commit, "prepared commit"),
    prepared_tree: sha(active.prepared_tree, "prepared tree"),
    version: text(active.version, "active candidate version"),
    intent_sha256: active.intent_sha256,
    phase: active.phase,
    failure_kind: active.failure_kind,
    transient_retries: boundedCount(active.transient_retries, 2, "transient retries"),
    substantive_repairs: boundedCount(active.substantive_repairs, 3, "substantive repairs"),
    release_run: active.release_run ?? null,
    ...(active.report_repair === undefined
      ? {}
      : { report_repair: inspectPublicationReportRepair(active.report_repair, active) }),
    ...(Object.hasOwn(active, "frozen_opportunity")
      ? { frozen_opportunity: validateOpportunity(active.frozen_opportunity) }
      : {}),
    ...(Object.hasOwn(active, "stage_evidence")
      ? { stage_evidence: inspectCandidateStageEvidence(active.stage_evidence, active) }
      : {}),
  };
}

type Authority = {
  controller_workflow: string;
  controller_revision: string;
  publication_observed_at: string;
  publication_sha256: string;
  opportunity_base_commit?: string;
  opportunity_commit?: string;
  opportunity_tree?: string;
  change_set_sha256?: string;
  reviewed_classification_sha256?: string;
  capacity_attempt?: ReturnType<typeof assessBoundedCapacity>;
  published_metadata_sha256?: string;
  metadata_renewal_sha256?: string;
  metadata_bootstrap_sha256?: string;
  catalog_publication_sha256?: string;
  catalog_initialization_sha256?: string;
  catalog_review_request_sha256?: string;
  catalog_review_disposition_sha256?: string;
  published_catalog_metadata_sha256?: string;
  published_site_sha256?: string;
};
function activePlan(
  active: NonNullable<ReturnType<typeof validateActive>>,
  opportunity: ReturnType<typeof validateOpportunity>,
  authority: Authority,
) {
  const queued =
    opportunity.source_commit === active.source_commit
      ? null
      : {
          source_commit: opportunity.source_commit,
          source_tree: opportunity.source_tree,
          disposition: "coalesced-for-next-opportunity",
        };
  const exactCandidate = {
    source_commit: active.source_commit,
    source_tree: active.source_tree,
    prepared_commit: active.prepared_commit,
    prepared_tree: active.prepared_tree,
    version: active.version,
    intent_sha256: active.intent_sha256,
    phase: active.phase,
    failure_kind: active.failure_kind,
    transient_retries: active.transient_retries,
    substantive_repairs: active.substantive_repairs,
    release_run: active.release_run ?? null,
    ...(active.report_repair === undefined ? {} : { report_repair: active.report_repair }),
    ...(Object.hasOwn(active, "frozen_opportunity")
      ? { frozen_opportunity: active.frozen_opportunity }
      : {}),
    ...(Object.hasOwn(active, "stage_evidence") ? { stage_evidence: active.stage_evidence } : {}),
  };
  if (active.phase !== "failed")
    return plan(
      "resume-active",
      "finish the frozen active candidate without cancellation",
      authority,
      {
        active_candidate: exactCandidate,
        queued_candidate: queued,
      },
    );
  if (active.failure_kind === "transient" && active.transient_retries < 2)
    return plan(
      "retry-active",
      "retry bounded transient infrastructure on the same candidate",
      authority,
      {
        active_candidate: exactCandidate,
        retry_number: active.transient_retries + 1,
        retry_limit: 2,
        queued_candidate: queued,
      },
    );
  if (active.failure_kind === "substantive" && active.substantive_repairs < 3)
    return plan(
      "dispatch-repair",
      "diagnose and repair the held candidate before distribution",
      authority,
      {
        active_candidate: exactCandidate,
        repair_number: active.substantive_repairs + 1,
        repair_limit: 3,
        queued_candidate: queued,
      },
    );
  return plan(
    "pause-exception",
    active.failure_kind === "authority"
      ? "candidate needs missing production authority"
      : "candidate exhausted its bounded recovery budget",
    authority,
    { active_candidate: exactCandidate, queued_candidate: queued },
  );
}

/**
 * Decide one release opportunity without mutating Git, GitHub, artifacts, or feeds.
 * A trusted controller persists this output beside workflow/issue evidence and then
 * invokes the existing preparation and release workflows with the exact identities.
 */
export function planReleaseOpportunity(input: unknown) {
  exactKeys(
    input,
    ["schema_version", "now", "controller", "opportunity", "publication", "active_candidate"],
    [
      "published_metadata",
      "metadata_renewal",
      "metadata_bootstrap",
      "review_request",
      "review_disposition",
      "catalog_publication",
      "catalog_initialization",
      "catalog_review_request",
      "catalog_review_disposition",
      "published_catalog_metadata",
      "published_site",
    ],
    "release coordinator input",
  );
  if (input.schema_version !== 1 && input.schema_version !== 2)
    throw new Error("unsupported release coordinator schema");
  const now = instant(input.now, "coordinator time");
  const controller = validateController(input.controller, input.schema_version);
  const publication = validatePublication(input.publication, now);
  const active = validateActive(input.active_candidate);
  const hasMetadata =
    Object.hasOwn(input, "catalog_publication") ||
    Object.hasOwn(input, "catalog_initialization") ||
    Object.hasOwn(input, "catalog_review_request") ||
    Object.hasOwn(input, "catalog_review_disposition") ||
    Object.hasOwn(input, "published_catalog_metadata") ||
    Object.hasOwn(input, "published_site") ||
    Object.hasOwn(input, "published_metadata") ||
    Object.hasOwn(input, "metadata_renewal") ||
    Object.hasOwn(input, "metadata_bootstrap") ||
    Object.hasOwn(input, "review_request") ||
    Object.hasOwn(input, "review_disposition");
  if (
    hasMetadata &&
    (input.schema_version !== 2 ||
      !isRecord(input.controller) ||
      !isRecord(input.controller.capacity_attempt) ||
      input.controller.capacity_attempt.schema_version !== 2)
  )
    throw new Error("metadata journal fields require bounded capacity schema2");
  const catalogInitialization = inspectCatalogInitialization(input.catalog_initialization);
  const publishedMetadata = inspectPublishedMetadata(input.published_metadata);
  const publishedCatalog = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
  const publishedSite = currentPublishedSite(input);
  const catalogPublication =
    input.catalog_publication == null
      ? null
      : inspectCatalogPublicationDescriptor(input.catalog_publication);
  const siteAuthority = {
    ...(Object.hasOwn(input, "published_site")
      ? { published_site_sha256: capacityDigest(publishedSite) }
      : {}),
    ...(Object.hasOwn(input, "published_catalog_metadata")
      ? { published_catalog_metadata_sha256: capacityDigest(publishedCatalog) }
      : {}),
  };
  const catalogReviewRequest = inspectCatalogReviewRequest(input.catalog_review_request);
  const catalogReviewDisposition = inspectCatalogReviewDisposition(
    input.catalog_review_disposition,
  );
  const reviewRequest = inspectReleaseReviewRequest(input.review_request);
  const reviewDisposition = inspectReleaseReviewDisposition(input.review_disposition);
  const metadataRenewal =
    input.metadata_renewal === undefined || input.metadata_renewal === null
      ? null
      : inspectMetadataRenewalDescriptor(input.metadata_renewal);
  const metadataBootstrap =
    input.metadata_bootstrap == null
      ? null
      : inspectMetadataBootstrapDescriptor(input.metadata_bootstrap);
  if (catalogPublication) {
    if (catalogReviewRequest)
      throw new Error("catalog publication must consume its neutral review request");
    if (
      catalogInitialization &&
      (catalogPublication.prior.catalog_root_sha256 !== catalogInitialization.root_sha256 ||
        catalogPublication.publisher_configuration_sha256 !==
          catalogInitialization.publisher_configuration_sha256)
    )
      throw new Error("catalog subject differs from initial setup identity");
    const authority: Authority = {
      ...siteAuthority,
      controller_workflow: controller.workflow,
      controller_revision: controller.revision,
      publication_observed_at: publication.observed_at,
      publication_sha256: capacityDigest(input.publication),
      catalog_publication_sha256: capacityDigest(catalogPublication),
      published_catalog_metadata_sha256: capacityDigest(publishedCatalog),
      published_site_sha256: capacityDigest(publishedSite),
      ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
    };
    if (input.opportunity !== null) validateOpportunity(input.opportunity);
    if (
      controller.publication_paused ||
      controller.capacity?.eligibility !== "eligible" ||
      active ||
      publication.reserved_versions.length ||
      reviewRequest ||
      reviewDisposition
    )
      return plan(
        "pause",
        "catalog scheduling held by existing pause/capacity/reservation/review recovery",
        authority,
      );
    assertCatalogPublicationBaseline(catalogPublication, input);
    return plan(
      "catalog-publication",
      "explicit catalog subject ready for independently authenticated catalog admission",
      authority,
      { catalog_publication: catalogPublication, admission: "required" as const },
    );
  }
  if (
    (catalogReviewRequest || catalogReviewDisposition) &&
    applicationMetadataMaintenancePriority(input, String(input.now))
  ) {
    if (catalogReviewRequest) assertCatalogReviewRequestBaseline(catalogReviewRequest, input);
    if (input.opportunity !== null) validateOpportunity(input.opportunity);
    return plan(
      controller.publication_paused || controller.capacity?.eligibility !== "eligible"
        ? "pause"
        : "skip",
      "accepted application metadata maintenance precedes neutral catalog review; request/history retained",
      {
        ...siteAuthority,
        controller_workflow: controller.workflow,
        controller_revision: controller.revision,
        publication_observed_at: publication.observed_at,
        publication_sha256: capacityDigest(input.publication),
        published_metadata_sha256: capacityDigest(publishedMetadata),
        metadata_renewal_sha256: capacityDigest(metadataRenewal),
        metadata_bootstrap_sha256: capacityDigest(metadataBootstrap),
        catalog_review_request_sha256: capacityDigest(catalogReviewRequest),
        catalog_review_disposition_sha256: capacityDigest(catalogReviewDisposition),
        ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
      },
    );
  }
  if (catalogReviewRequest) {
    if (input.opportunity !== null) validateOpportunity(input.opportunity);
    assertCatalogReviewRequestBaseline(catalogReviewRequest, input);
    const authority: Authority = {
      ...siteAuthority,
      controller_workflow: controller.workflow,
      controller_revision: controller.revision,
      publication_observed_at: publication.observed_at,
      publication_sha256: capacityDigest(input.publication),
      catalog_review_request_sha256: capacityDigest(catalogReviewRequest),
      ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
    };
    return plan(
      controller.publication_paused ||
        controller.capacity?.eligibility !== "eligible" ||
        active ||
        publication.reserved_versions.length ||
        reviewRequest ||
        reviewDisposition
        ? "pause"
        : "catalog-review-request",
      "neutral catalog request awaits independently authenticated whole-opportunity review",
      authority,
      { catalog_review_request: catalogReviewRequest, admission: "required" as const },
    );
  }
  if (input.opportunity === null && catalogReviewDisposition && !catalogReviewRequest) {
    return plan(
      controller.publication_paused ||
        controller.capacity?.eligibility !== "eligible" ||
        active ||
        reviewRequest ||
        reviewDisposition
        ? "pause"
        : "skip",
      "catalog negative review retained; only a bounded changed-source request or actual catalog baseline advance may continue",
      {
        ...siteAuthority,
        controller_workflow: controller.workflow,
        controller_revision: controller.revision,
        publication_observed_at: publication.observed_at,
        publication_sha256: capacityDigest(input.publication),
        catalog_review_disposition_sha256: capacityDigest(catalogReviewDisposition),
        ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
      },
    );
  }
  if (input.opportunity === null) {
    if (
      (!metadataBootstrap && !publishedSite && !catalogInitialization) ||
      active ||
      publication.reserved_versions.length !== 0
    )
      throw new Error(
        "null semantic opportunity requires explicit initial metadata state without a reservation",
      );
    const authority: Authority = {
      controller_workflow: controller.workflow,
      ...siteAuthority,
      controller_revision: controller.revision,
      publication_observed_at: publication.observed_at,
      publication_sha256: capacityDigest(input.publication),
      ...(metadataBootstrap
        ? { metadata_bootstrap_sha256: capacityDigest(metadataBootstrap) }
        : {}),
      ...(catalogInitialization
        ? { catalog_initialization_sha256: capacityDigest(catalogInitialization) }
        : {}),
      ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
      ...(Object.hasOwn(input, "published_metadata")
        ? { published_metadata_sha256: capacityDigest(publishedMetadata) }
        : {}),
      ...(Object.hasOwn(input, "metadata_renewal")
        ? { metadata_renewal_sha256: capacityDigest(metadataRenewal) }
        : {}),
      ...(Object.hasOwn(input, "review_request")
        ? { review_request_sha256: capacityDigest(reviewRequest) }
        : {}),
      ...(Object.hasOwn(input, "review_disposition")
        ? { review_disposition_sha256: capacityDigest(reviewDisposition) }
        : {}),
    };
    return plan(
      controller.publication_paused || controller.capacity?.eligibility !== "eligible"
        ? "pause"
        : "skip",
      controller.publication_paused
        ? "publication emergency pause is active"
        : controller.capacity?.eligibility !== "eligible"
          ? "bounded initial metadata state is held"
          : catalogInitialization && !publishedSite
            ? "inert catalog initialization awaits an authenticated complete opportunity"
            : metadataBootstrap
              ? "explicit initial metadata state has no semantic release opportunity"
              : "catalog-only published site has no application release opportunity",
      authority,
    );
  }
  const opportunity = validateOpportunity(input.opportunity);
  const authority = {
    ...siteAuthority,
    ...(Object.hasOwn(input, "review_disposition")
      ? { review_disposition_sha256: capacityDigest(reviewDisposition) }
      : {}),
    ...(Object.hasOwn(input, "review_request")
      ? { review_request_sha256: capacityDigest(reviewRequest) }
      : {}),
    ...(Object.hasOwn(input, "published_metadata")
      ? { published_metadata_sha256: capacityDigest(publishedMetadata) }
      : {}),
    ...(Object.hasOwn(input, "metadata_renewal")
      ? { metadata_renewal_sha256: capacityDigest(metadataRenewal) }
      : {}),
    ...(Object.hasOwn(input, "metadata_bootstrap")
      ? { metadata_bootstrap_sha256: capacityDigest(metadataBootstrap) }
      : {}),
    ...(controller.capacity ? { capacity_attempt: controller.capacity } : {}),
    controller_workflow: controller.workflow,
    controller_revision: controller.revision,
    publication_observed_at: publication.observed_at,
    publication_sha256: createHash("sha256")
      .update(JSON.stringify(stable(input.publication)))
      .digest("hex"),
    opportunity_base_commit: opportunity.base_commit,
    opportunity_commit: opportunity.source_commit,
    opportunity_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
    reviewed_classification_sha256: createHash("sha256")
      .update(JSON.stringify(stable(opportunity.classification)))
      .digest("hex"),
  };

  if (
    controller.capacity &&
    (controller.publication_paused || controller.capacity.eligibility !== "eligible")
  )
    return plan(
      "pause",
      controller.publication_paused
        ? "publication emergency pause is active"
        : controller.capacity.reason,
      authority,
      { active_candidate: active, capacity: controller.capacity },
    );
  if (controller.publication_paused)
    return plan("pause", "publication emergency pause is active", authority);
  if (input.schema_version === 1 && !controller.free_capacity_available)
    return plan("pause", "free runner or artifact capacity is unavailable", authority);
  if (active) {
    if (
      publication.reserved_versions.length !== 1 ||
      publication.reserved_versions[0] !== active.version
    )
      throw new Error("active candidate does not match the complete reservation inventory");
    return activePlan(active, opportunity, authority);
  }
  if (publication.reserved_versions.length)
    throw new Error("reserved versions require active-candidate recovery before allocation");
  if (!opportunity.meaningful || opportunity.documentation_only)
    return plan("skip", "no meaningful distributable application change", authority);
  if (publication.published_sources.includes(opportunity.source_commit))
    return plan("skip", "candidate commit is already in the publication inventory", authority);

  const routinePreview = opportunity.requested_channel === "preview" && !opportunity.urgency;
  if (
    routinePreview &&
    publication.lastPreview !== null &&
    now - publication.lastPreview < dayMilliseconds
  ) {
    return plan("coalesce", "routine Preview cadence has not elapsed", authority, {
      next_opportunity_at: new Date(publication.lastPreview + dayMilliseconds).toISOString(),
      queued_candidate: {
        source_commit: opportunity.source_commit,
        source_tree: opportunity.source_tree,
      },
    });
  }

  const proposal = proposeApplicationVersion(
    opportunity.classification,
    publication.published_versions,
  );
  classifyApplicationVersion(proposal.version, opportunity.requested_channel === "stable");
  return plan("prepare", "allocate and freeze one exact release candidate", authority, {
    requested_channel: opportunity.requested_channel,
    urgency_bypassed_cadence: opportunity.urgency,
    proposal,
    invocation: {
      preparation: "apps/desktop/scripts/prepare-release-version.mts",
      qualification: ".github/workflows/qualification.yml",
      release: ".github/workflows/release.yml",
    },
  });
}

async function readInput(filename: string): Promise<unknown> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1024 * 1024)
    throw new Error("release coordinator input must be a bounded regular file");
  return JSON.parse(await readFile(filename, "utf8"));
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const filename = process.argv[2];
    if (process.argv.length !== 3 || !filename)
      throw new Error("usage: release-coordinator.mts INPUT.json");
    const input = await readInput(path.resolve(filename));
    object(input, "release coordinator input");
    const controller = isRecord(input.controller) ? input.controller : {};
    if (
      process.env.PORTCOVE_CONTROLLER_REVISION &&
      controller.revision !== process.env.PORTCOVE_CONTROLLER_REVISION
    )
      throw new Error("coordinator input does not match the executing controller revision");
    if (
      process.env.PORTCOVE_CONTROLLER_WORKFLOW &&
      controller.workflow !== process.env.PORTCOVE_CONTROLLER_WORKFLOW
    )
      throw new Error("coordinator input does not match the executing controller workflow");
    console.log(JSON.stringify(planReleaseOpportunity(input), null, 2));
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
