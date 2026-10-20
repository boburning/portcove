import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";

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

export function validateReleaseReviewRequestTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  const before = inspectReleaseReviewRequest(previous.review_request);
  const after = inspectReleaseReviewRequest(next.review_request);
  if (capacityDigest(before) === capacityDigest(after)) return;
  if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
    throw new Error("review request transition cannot allocate or change active candidate");
  if (!before && after) {
    if (after.before_checkpoint !== checkpoint || after.requested_at !== next.now)
      throw new Error("review request requires its exact preceding checkpoint and frozen clock");
    return;
  }
  if (before && after) throw new Error("unconsumed review request cannot be replaced or retimed");
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
