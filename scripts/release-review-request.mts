import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mts";

const scope = "portcove-release-net-tree-delta-v1";
export interface ReleaseReviewRequest {
  schema_version: 1;
  kind: "application-release-semantic-review";
  before_checkpoint: string;
  requested_at: string;
  base_commit: string;
  base_version: string;
  source_commit: string;
  source_tree: string;
  change_set_scope: typeof scope;
  change_set_sha256: string;
  requested_channel: "preview";
  request_id: string;
}
function sha(value: unknown, length: number) {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value))
    throw new Error("neutral review request identity absent");
  return value;
}
export function inspectReleaseReviewRequest(raw: unknown): ReleaseReviewRequest | null {
  if (raw === undefined || raw === null) return null;
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "base_commit,base_version,before_checkpoint,change_set_scope,change_set_sha256,kind,request_id,requested_at,requested_channel,schema_version,source_commit,source_tree" ||
    raw.schema_version !== 1 ||
    raw.kind !== "application-release-semantic-review" ||
    raw.change_set_scope !== scope ||
    raw.requested_channel !== "preview"
  )
    throw new Error("neutral release review request schema differs");
  for (const field of ["base_commit", "before_checkpoint", "source_commit", "source_tree"])
    if (typeof raw[field] !== "string" || !/^[a-f0-9]{40}$/u.test(raw[field]))
      throw new Error("neutral review request Git identity absent");
  for (const field of ["change_set_sha256", "request_id"])
    if (typeof raw[field] !== "string" || !/^[a-f0-9]{64}$/u.test(raw[field]))
      throw new Error("neutral review request digest absent");
  classifyApplicationVersion(raw.base_version);
  if (
    typeof raw.requested_at !== "string" ||
    !Number.isFinite(Date.parse(raw.requested_at)) ||
    new Date(raw.requested_at).toISOString() !== raw.requested_at
  )
    throw new Error("neutral review request timestamp invalid");
  const { request_id, ...identity } = raw;
  if (capacityDigest(identity) !== request_id)
    throw new Error("neutral review request does not bind exact frozen inputs");
  return {
    schema_version: 1,
    kind: "application-release-semantic-review",
    base_commit: sha(raw.base_commit, 40),
    before_checkpoint: sha(raw.before_checkpoint, 40),
    source_commit: sha(raw.source_commit, 40),
    source_tree: sha(raw.source_tree, 40),
    base_version: classifyApplicationVersion(raw.base_version).version,
    change_set_scope: scope,
    change_set_sha256: sha(raw.change_set_sha256, 64),
    requested_at: raw.requested_at,
    requested_channel: "preview",
    request_id: sha(request_id, 64),
  };
}

/** Data request only. The same selected independent producer must first propose
 * an untrusted classification, then run the existing exact acceptance/broker
 * path. Neither this digest nor journal custody grants semantic acceptance. */
export function createReleaseReviewRequest(raw: {
  base_commit: string;
  base_version: string;
  source_commit: string;
  source_tree: string;
  change_set_sha256: string;
  before_checkpoint: string;
  requested_at: string;
}) {
  const input = structuredClone(raw);
  if (
    Object.keys(input).sort().join(",") !==
    "base_commit,base_version,before_checkpoint,change_set_sha256,requested_at,source_commit,source_tree"
  )
    throw new Error("neutral review request source fields differ");
  const identity = {
    ...input,
    schema_version: 1,
    kind: "application-release-semantic-review",
    change_set_scope: scope,
    requested_channel: "preview",
  };
  return inspectReleaseReviewRequest({ ...identity, request_id: capacityDigest(identity) })!;
}

/** Compact custody of an independently authenticated negative Check. The full
 * report remains in that Check and the original request remains in this same
 * immutable Git history. Parsing these declared hashes grants no authority. */
export function inspectReleaseReviewDisposition(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "bundle_sha256,check_run_id,completed_at,disposition,events_sha256,invocation_sha256,isolation_sha256,kind,opportunity_sha256,prior_requests,report_sha256,request,request_checkpoint,review_app_id,schema_version,session_ref,stage,substantive_repairs,transient_retries,wire_sha256" ||
    raw.schema_version !== 1 ||
    raw.kind !== "application-release-semantic-disposition-receipt" ||
    (raw.stage !== "classification-proposal" && raw.stage !== "complete-opportunity") ||
    (raw.disposition !== "refused" && raw.disposition !== "changes-required") ||
    (raw.stage === "classification-proposal" &&
      (raw.disposition !== "refused" || raw.opportunity_sha256 !== null))
  )
    throw new Error("semantic disposition receipt schema differs");
  const request = inspectReleaseReviewRequest(raw.request);
  if (!request) throw new Error("semantic disposition original request absent");
  for (const key of ["check_run_id", "review_app_id"])
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 1)
      throw new Error("semantic disposition provider identity absent");
  if (raw.review_app_id === 15368)
    throw new Error("generic Actions cannot issue semantic dispositions");
  if (!Array.isArray(raw.prior_requests) || raw.prior_requests.length > 3)
    throw new Error("semantic disposition prior request bound exceeded");
  const priorRequests = raw.prior_requests.map((prior: unknown) => {
    if (
      !isRecord(prior) ||
      Object.keys(prior).sort().join(",") !==
        "check_run_id,request_checkpoint,request_id,source_commit,source_tree,wire_sha256" ||
      typeof prior.check_run_id !== "number" ||
      !Number.isSafeInteger(prior.check_run_id) ||
      prior.check_run_id < 1
    )
      throw new Error("semantic disposition prior request identity differs");
    return {
      check_run_id: prior.check_run_id,
      request_checkpoint: sha(prior.request_checkpoint, 40),
      request_id: sha(prior.request_id, 64),
      source_commit: sha(prior.source_commit, 40),
      source_tree: sha(prior.source_tree, 40),
      wire_sha256: sha(prior.wire_sha256, 64),
    };
  });
  if (
    new Set([...priorRequests.map((prior) => prior.request_id), request.request_id]).size !==
    priorRequests.length + 1
  )
    throw new Error("semantic disposition prior request duplicates current history");
  const counters = {
    transient_retries: raw.transient_retries,
    substantive_repairs: raw.substantive_repairs,
  };
  for (const [key, max] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const)
    if (
      typeof counters[key] !== "number" ||
      !Number.isSafeInteger(counters[key]) ||
      counters[key] < 0 ||
      counters[key] > max
    )
      throw new Error("semantic disposition recovery budget differs");
  if (
    typeof raw.session_ref !== "string" ||
    !raw.session_ref ||
    raw.session_ref.length > 512 ||
    Array.from(raw.session_ref).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    typeof raw.completed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(raw.completed_at) ||
    !Number.isFinite(Date.parse(raw.completed_at)) ||
    new Date(raw.completed_at).toISOString() !== raw.completed_at.replace("Z", ".000Z") ||
    Date.parse(raw.completed_at) < Math.floor(Date.parse(request.requested_at) / 1000) * 1000
  )
    throw new Error("semantic disposition completion/session absent");
  return {
    schema_version: 1 as const,
    kind: "application-release-semantic-disposition-receipt" as const,
    request,
    request_checkpoint: sha(raw.request_checkpoint, 40),
    check_run_id: Number(raw.check_run_id),
    review_app_id: Number(raw.review_app_id),
    prior_requests: priorRequests,
    stage: raw.stage,
    disposition: raw.disposition,
    wire_sha256: sha(raw.wire_sha256, 64),
    opportunity_sha256:
      raw.stage === "classification-proposal" ? null : sha(raw.opportunity_sha256, 64),
    bundle_sha256: sha(raw.bundle_sha256, 64),
    invocation_sha256: sha(raw.invocation_sha256, 64),
    events_sha256: sha(raw.events_sha256, 64),
    isolation_sha256: sha(raw.isolation_sha256, 64),
    report_sha256: sha(raw.report_sha256, 64),
    completed_at: raw.completed_at,
    session_ref: raw.session_ref,
    transient_retries: Number(raw.transient_retries),
    substantive_repairs: Number(raw.substantive_repairs),
  };
}

export function advanceReleaseReviewRecovery(
  rawDisposition: unknown,
  rawRequest: unknown,
  publication: unknown,
) {
  const previous = inspectReleaseReviewDisposition(rawDisposition);
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request) throw new Error("next semantic request absent");
  if (!previous) return null;
  if (request.base_version !== previous.request.base_version) {
    if (
      compareApplicationVersionPrecedence(request.base_version, previous.request.base_version) <=
        0 ||
      !isRecord(publication) ||
      publication.complete !== true ||
      !Array.isArray(publication.published_versions) ||
      !publication.published_versions.includes(request.base_version)
    )
      throw new Error(
        "semantic recovery budget resets only after actual published baseline advance",
      );
    return { ...previous, transient_retries: 0, substantive_repairs: 0 };
  }
  if (
    request.base_commit !== previous.request.base_commit ||
    [...previous.prior_requests, previous.request].some(
      (prior) =>
        request.source_commit === prior.source_commit || request.source_tree === prior.source_tree,
    )
  )
    throw new Error(
      "negative semantic request requires changed source/tree on the same published baseline",
    );
  if (previous.substantive_repairs >= 3)
    throw new Error("semantic request exhausted three substantive repairs");
  return { ...previous, substantive_repairs: previous.substantive_repairs + 1 };
}

export function validateReleaseReviewRequestTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  const before = inspectReleaseReviewRequest(previous.review_request);
  const after = inspectReleaseReviewRequest(next.review_request);
  const oldDisposition = inspectReleaseReviewDisposition(previous.review_disposition);
  const disposition = inspectReleaseReviewDisposition(next.review_disposition);
  if (
    capacityDigest(before) === capacityDigest(after) &&
    capacityDigest(oldDisposition) === capacityDigest(disposition)
  )
    return;
  if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
    throw new Error("review request transition cannot allocate or change active candidate");
  if (!before && after) {
    if (after.before_checkpoint !== checkpoint || after.requested_at !== next.now)
      throw new Error("review request requires its exact preceding checkpoint and frozen clock");
    if (
      capacityDigest(advanceReleaseReviewRecovery(oldDisposition, after, next.publication)) !==
      capacityDigest(disposition)
    )
      throw new Error(
        "semantic recovery receipt/counters cannot be dropped or reset for another request",
      );
    return;
  }
  if (before && after) throw new Error("unconsumed review request cannot be replaced or retimed");
  if (before && !after && capacityDigest(oldDisposition) !== capacityDigest(disposition)) {
    const priorRequests =
      oldDisposition && oldDisposition.request.base_version === before.base_version
        ? [
            ...oldDisposition.prior_requests,
            {
              request_id: oldDisposition.request.request_id,
              source_commit: oldDisposition.request.source_commit,
              source_tree: oldDisposition.request.source_tree,
              request_checkpoint: oldDisposition.request_checkpoint,
              check_run_id: oldDisposition.check_run_id,
              wire_sha256: oldDisposition.wire_sha256,
            },
          ]
        : [];
    if (
      !disposition ||
      capacityDigest(disposition.request) !== capacityDigest(before) ||
      disposition.request_checkpoint !== checkpoint ||
      capacityDigest(disposition.prior_requests) !== capacityDigest(priorRequests) ||
      disposition.transient_retries !== (oldDisposition?.transient_retries ?? 0) ||
      disposition.substantive_repairs !== (oldDisposition?.substantive_repairs ?? 0) ||
      Date.parse(disposition.completed_at) > Date.parse(String(next.now)) ||
      capacityDigest(previous.opportunity) !== capacityDigest(next.opportunity)
    )
      throw new Error(
        "negative retirement requires exact authenticated request receipt without changing opportunity or resetting budget",
      );
    return;
  }
  if (capacityDigest(oldDisposition) !== capacityDigest(disposition))
    throw new Error(
      "semantic disposition cannot disappear or change outside exact request retirement/recovery",
    );
  const opportunity = next.opportunity;
  if (
    !before ||
    !isRecord(opportunity) ||
    !isRecord(opportunity.classification) ||
    opportunity.base_commit !== before.base_commit ||
    opportunity.source_commit !== before.source_commit ||
    opportunity.source_tree !== before.source_tree ||
    opportunity.change_set_sha256 !== before.change_set_sha256 ||
    opportunity.requested_channel !== before.requested_channel ||
    opportunity.classification.base_version !== before.base_version ||
    opportunity.classification.change_set_scope !== before.change_set_scope
  )
    throw new Error("consumed review request requires exact independently accepted opportunity");
}
