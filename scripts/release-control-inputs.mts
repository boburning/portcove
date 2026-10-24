import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import {
  inspectRemoteCommitObject,
  inspectRemoteGitObject,
} from "./release-coordinator-recovery.mts";
import {
  inspectSemanticReviewEvidence,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
import { isRecord } from "./runtime-values.mts";
import { assessBoundedCapacity, capacityDigest } from "./release-capacity.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import { inspectFixedClassificationProducer } from "./release-classification-contract.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const classificationBranch = "portcove-release-inputs";
const pauseBranch = "portcove-release-pause";
const maximumBytes = 128 * 1024;
export const releaseControlRefQuery =
  "query($id:ID!,$ref:String!){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ref(qualifiedName:$ref){id name prefix target{__typename oid}}}}}";

function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("release control input schema differs");
}
function numeric(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("release control numeric identity is missing");
}
function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("release control requires an exact Git identity");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("release control JSON is incomplete");
  return result;
}
function releaseOpportunityDigest(value: unknown) {
  return createHash("sha256")
    .update(canonical(validateOpportunity(value)))
    .digest("hex");
}
function session(api: CoordinatorRemoteApi) {
  const started = performance.now();
  let requests = 0;
  const bound = () => {
    if (++requests > 80 || performance.now() - started > 120_000)
      throw new Error("release control request or duration bound exhausted");
  };
  const get = (suffix: string, missing = false) => {
    bound();
    const response = api.request("GET", `repos/${repository}${suffix}`);
    if (performance.now() - started > 120_000) throw new Error("release control response late");
    if (response.status === 404 && missing) return null;
    if (response.status !== 200 || Buffer.byteLength(JSON.stringify(response.body)) > maximumBytes)
      throw new Error("release control response unavailable or oversized");
    return response.body;
  };
  const identity = get("");
  if (
    !isRecord(identity) ||
    identity.id !== repositoryId ||
    identity.full_name !== repository ||
    typeof identity.node_id !== "string" ||
    !identity.node_id
  )
    throw new Error("release control repository differs");
  const refIds = new Map<string, string>();
  const ref = (branch: string) => {
    bound();
    const response = api.graphql(releaseControlRefQuery, {
      id: identity.node_id,
      ref: `refs/heads/${branch}`,
    });
    const node = isRecord(response.data) ? response.data.node : null;
    const value = isRecord(node) ? node.ref : null;
    if (
      performance.now() - started > 120_000 ||
      !isRecord(node) ||
      node.__typename !== "Repository" ||
      node.id !== identity.node_id ||
      node.databaseId !== repositoryId ||
      node.nameWithOwner !== repository ||
      !isRecord(value) ||
      value.name !== branch ||
      value.prefix !== "refs/heads/" ||
      typeof value.id !== "string" ||
      !value.id ||
      !isRecord(value.target) ||
      value.target.__typename !== "Commit"
    )
      throw new Error("release control ref unavailable or repository identity differs");
    oid(value.target.oid);
    if (refIds.has(branch) && refIds.get(branch) !== value.id)
      throw new Error("release control ref opaque identity changed");
    refIds.set(branch, value.id);
    return value.target.oid;
  };
  const contents = (commit: string, path: string, missing = false) => {
    const closure = inspectRemoteCommitObject(get(`/git/commits/${commit}`), commit);
    let tree = closure.tree;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const value = get(`/git/trees/${tree}`);
      if (
        !isRecord(value) ||
        value.sha !== tree ||
        value.truncated !== false ||
        !Array.isArray(value.tree) ||
        value.tree.length > 512
      )
        throw new Error("release control tree coverage incomplete");
      const entries = value.tree.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          typeof entry.path !== "string" ||
          !entry.path ||
          /[\\/\0]/u.test(entry.path) ||
          [".", ".."].includes(entry.path) ||
          Buffer.byteLength(entry.path) > 256 ||
          !(
            (entry.type === "tree" && entry.mode === "040000") ||
            (entry.type === "blob" &&
              ["100644", "100755", "120000"].includes(String(entry.mode))) ||
            (entry.type === "commit" && entry.mode === "160000")
          )
        )
          throw new Error("unsupported release control tree entry");
        oid(entry.sha);
        return {
          name: entry.path,
          mode: String(entry.mode),
          type: String(entry.type),
          sha: entry.sha,
        };
      });
      if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
        throw new Error("duplicate release control tree entry");
      entries.sort((a, b) =>
        Buffer.compare(
          Buffer.from(a.name + (a.type === "tree" ? "/" : "")),
          Buffer.from(b.name + (b.type === "tree" ? "/" : "")),
        ),
      );
      inspectRemoteGitObject(
        "tree",
        tree,
        Buffer.concat(
          entries.map((entry) =>
            Buffer.concat([
              Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.name}\0`),
              Buffer.from(entry.sha, "hex"),
            ]),
          ),
        ),
      );
      const selected = entries.find((entry) => entry.name === parts[index]);
      if (!selected) {
        if (missing) return null;
        throw new Error("release control path missing");
      }
      if (index < parts.length - 1) {
        if (selected.type !== "tree" || selected.mode !== "040000")
          throw new Error("release control path is not a directory");
        tree = selected.sha;
        continue;
      }
      if (selected.type !== "blob" || selected.mode !== "100644")
        throw new Error("release control document is not an inert file");
      const blob = get(`/git/blobs/${selected.sha}`);
      if (
        !isRecord(blob) ||
        blob.sha !== selected.sha ||
        blob.encoding !== "base64" ||
        typeof blob.content !== "string" ||
        typeof blob.size !== "number" ||
        blob.size < 1 ||
        blob.size > maximumBytes
      )
        throw new Error("release control blob unavailable");
      const encoded = blob.content.replaceAll("\n", "");
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") !== encoded ||
        bytes.length !== blob.size ||
        !Buffer.from(bytes.toString("utf8")).equals(bytes)
      )
        throw new Error("release control blob encoding differs");
      inspectRemoteGitObject("blob", selected.sha, bytes);
      return bytes.toString("utf8");
    }
    throw new Error("release control path incomplete");
  };
  return { get, ref, contents, bound, refId: (branch: string) => refIds.get(branch) };
}

interface ReviewProducerConfiguration {
  schema_version: 1;
  review_app_id: number;
  writer_app_id: number;
  review_check_name: string;
}
function legacyConfiguration(value: unknown): ReviewProducerConfiguration {
  exact(value, "review_app_id,review_check_name,schema_version,writer_app_id");
  numeric(value.review_app_id);
  numeric(value.writer_app_id);
  if (
    value.schema_version !== 1 ||
    value.review_app_id === value.writer_app_id ||
    value.review_app_id === 15368 ||
    typeof value.review_check_name !== "string" ||
    !value.review_check_name ||
    value.review_check_name.length > 128
  )
    throw new Error(
      "independent semantic review producer is unconfigured or conflated with persistence",
    );
  return {
    schema_version: 1,
    review_app_id: value.review_app_id,
    writer_app_id: value.writer_app_id,
    review_check_name: value.review_check_name,
  };
}
export function inspectReviewProducerConfiguration(value: unknown) {
  return legacyConfiguration(structuredClone(value));
}
function configuration(value: unknown) {
  return isRecord(value) && value.schema_version === 3
    ? inspectFixedClassificationProducer(value)
    : legacyConfiguration(value);
}
export function inspectApplicationReviewProducerConfiguration(value: unknown) {
  return configuration(structuredClone(value));
}
/** Semantic transport only. This writer-free projection cannot enter the
 * classification read/persist configuration above. */
export function inspectApplicationSemanticProducerConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  return isRecord(value) && value.schema_version === 2
    ? semanticProducerConfiguration(value, "application")
    : configuration(value);
}
/** Catalog Check authenticity has no classification persistence role. This
 * closed projection appoints no writer and cannot enter application readers. */
export function inspectCatalogReviewProducerConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  if (isRecord(value) && value.schema_version === 1) return legacyConfiguration(value);
  return semanticProducerConfiguration(value, "catalog-publication");
}
function semanticProducerConfiguration<P extends "application" | "catalog-publication">(
  value: unknown,
  purpose: P,
) {
  exact(value, "purpose,review_app_id,review_check_name,schema_version");
  numeric(value.review_app_id);
  if (
    value.schema_version !== 2 ||
    value.purpose !== purpose ||
    value.review_app_id === 15368 ||
    value.review_check_name !== semanticReviewCheckName
  )
    throw new Error(`${purpose} independent semantic producer schema differs`);
  return {
    schema_version: 2 as const,
    purpose,
    review_app_id: value.review_app_id,
    review_check_name: value.review_check_name,
  };
}
function review(
  get: ReturnType<typeof session>["get"],
  checkId: number,
  config: Pick<ReviewProducerConfiguration, "review_app_id" | "review_check_name">,
  opportunity:
    | ReturnType<typeof validateOpportunity>
    | ReturnType<typeof inspectCatalogSemanticOpportunity>,
  purpose: "application" | "catalog-publication" = "application",
) {
  const value = get(`/check-runs/${checkId}`);
  if (
    !isRecord(value) ||
    value.id !== checkId ||
    !isRecord(value.app) ||
    value.app.id !== config.review_app_id ||
    value.name !== config.review_check_name ||
    value.head_sha !== opportunity.source_commit ||
    value.status !== "completed" ||
    value.conclusion !== "success" ||
    typeof value.completed_at !== "string" ||
    !Number.isFinite(Date.parse(value.completed_at)) ||
    Date.parse(value.completed_at) > Date.now() ||
    !isRecord(value.output) ||
    value.output.annotations_count !== 0 ||
    value.output.title !==
      (purpose === "application"
        ? "Portcove independent release review v1"
        : "Portcove independent catalog review v1") ||
    typeof value.output.summary !== "string" ||
    value.output.summary.length > 64 * 1024 ||
    (value.output.text != null && value.output.text !== "")
  )
    throw new Error(
      "independent semantic review is missing, incomplete or from another producer/input",
    );
  const report: unknown = JSON.parse(value.output.summary);
  exact(
    report,
    purpose === "application"
      ? "opportunity,opportunity_sha256,review,schema_version"
      : "opportunity,opportunity_sha256,purpose,review,schema_version",
  );
  const evidence = inspectSemanticReviewEvidence(report.review, purpose);
  if (evidence.completed_at !== value.completed_at)
    throw new Error("semantic review completion identity differs");
  if (
    report.schema_version !== (purpose === "application" ? 2 : 3) ||
    (purpose === "catalog-publication" &&
      (report.purpose !== purpose ||
        value.external_id !== `portcove-catalog-review-v1:${capacityDigest(opportunity)}`)) ||
    report.opportunity_sha256 !==
      (purpose === "application"
        ? releaseOpportunityDigest(opportunity)
        : capacityDigest(opportunity)) ||
    canonical(
      purpose === "application"
        ? validateOpportunity(report.opportunity)
        : inspectCatalogSemanticOpportunity(report.opportunity),
    ) !== canonical(opportunity)
  )
    throw new Error("independent review does not bind the complete exact opportunity");
  return canonical({
    id: value.id,
    app: value.app.id,
    name: value.name,
    head_sha: value.head_sha,
    completed_at: value.completed_at,
    report,
  });
}
function classificationPath(opportunity: ReturnType<typeof validateOpportunity>) {
  parseVersionClassification(opportunity.classification);
  if (opportunity.classification.change_set_scope !== "portcove-release-net-tree-delta-v1")
    throw new Error(
      "release classification requires the existing versioned net-tree delta contract",
    );
  return `classification/${opportunity.source_commit}/${opportunity.change_set_sha256}.json`;
}

/** Read-only reuse by the fixed producer broker; no persistence or authority. */
export function readIndependentSemanticReview(
  api: CoordinatorRemoteApi,
  rawConfig: unknown,
  rawOpportunity: unknown,
  checkId: number,
) {
  numeric(checkId);
  const config = inspectApplicationSemanticProducerConfiguration(rawConfig);
  const opportunity = validateOpportunity(rawOpportunity);
  return review(session(api).get, checkId, config, opportunity);
}

/** Same independent issuer transport; distinct catalog purpose. No application
 * classification persistence, reservation or accepted catalog state is created. */
export function readIndependentCatalogSemanticReview(
  api: CoordinatorRemoteApi,
  rawConfig: unknown,
  rawOpportunity: unknown,
  checkId: number,
) {
  numeric(checkId);
  const config = inspectCatalogReviewProducerConfiguration(rawConfig);
  const opportunity = inspectCatalogSemanticOpportunity(rawOpportunity);
  return review(session(api).get, checkId, config, opportunity, "catalog-publication");
}

/** Persistence adapter, not a classifier or execution grant. An admitted fixed
 * writer job supplies its independently ratified producer and writer App IDs.
 * This module never discovers credentials, edits protections, or writes pause.
 * Protected caller identity and observer handoff must be established separately.
 */
export function persistReviewedClassification(
  api: CoordinatorRemoteApi,
  rawConfig: unknown,
  rawOpportunity: unknown,
  checkId: number,
  beforeMutation: () => void,
) {
  const config = configuration(rawConfig);
  if (typeof beforeMutation !== "function")
    throw new Error("fresh protected caller guard unavailable");
  numeric(checkId);
  const opportunity = validateOpportunity(rawOpportunity);
  const path = classificationPath(opportunity);
  const io = session(api);
  const before = io.ref(classificationBranch);
  const proof = review(io.get, checkId, config, opportunity);
  const text = `${canonical({ schema_version: 2, opportunity, review_check_id: checkId, review_app_id: config.review_app_id, review_sha256: createHash("sha256").update(proof).digest("hex"), opportunity_sha256: releaseOpportunityDigest(opportunity) })}\n`;
  const existing = io.contents(before, path, true);
  if (existing !== null && existing !== text)
    throw new Error("immutable classification conflicts; no overwrite permitted");
  if (
    review(io.get, checkId, config, opportunity) !== proof ||
    io.ref(classificationBranch) !== before
  )
    throw new Error("release review or input ref changed before persistence");
  if (existing !== null) return { changed: false, commit: before, path, authority: "none" };
  io.bound();
  beforeMutation();
  let ambiguous = false;
  let acknowledged: string | null = null;
  // expectedHeadOid is GitHub's single-branch exact-preimage CAS. Never retry.
  try {
    const response = api.graphql(
      "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
      {
        input: {
          branch: { id: io.refId(classificationBranch) },
          expectedHeadOid: before,
          message: { headline: `Persist reviewed classification ${opportunity.source_commit}` },
          fileChanges: { additions: [{ path, contents: Buffer.from(text).toString("base64") }] },
        },
      },
    );
    if (
      !isRecord(response.data) ||
      !isRecord(response.data.createCommitOnBranch) ||
      !isRecord(response.data.createCommitOnBranch.commit)
    )
      throw new Error("classification CAS acknowledgment unavailable");
    oid(response.data.createCommitOnBranch.commit.oid);
    acknowledged = response.data.createCommitOnBranch.commit.oid;
  } catch {
    ambiguous = true;
  }
  let after: string | null = null;
  try {
    after = io.ref(classificationBranch);
    if (
      after === before ||
      (acknowledged !== null && acknowledged !== after) ||
      io.contents(after, path) !== text
    )
      throw new Error(
        "classification mutation outcome unknown or conflicting; retain evidence and do not retry",
      );
    if (review(io.get, checkId, config, opportunity) !== proof)
      throw new Error("review changed after persistence; classification cannot admit");
  } catch {
    throw new CoordinatorRemoteError(
      "classification outcome unknown or conflicting; retain evidence and do not retry",
      {
        operation: "persist-reviewed-classification",
        before,
        observed: after,
        acknowledged,
        phase: "post-CAS-readback",
        path,
        check_id: checkId,
        review_app_id: config.review_app_id,
        opportunity_sha256: releaseOpportunityDigest(opportunity),
        ambiguous_acknowledgment: ambiguous,
        retry: "forbidden",
      },
    );
  }
  return { changed: true, commit: after, path, recovered: ambiguous, authority: "none" };
}

/** Fresh reads reauthenticate semantic acceptance; App-authored Git bytes alone
 * are never accepted as an independent review. Missing/stale/conflicting source
 * or protection evidence causes refusal in the admitted caller, never default false.
 */
export function readReviewedClassification(
  api: CoordinatorRemoteApi,
  rawConfig: unknown,
  rawOpportunity: unknown,
) {
  const config = configuration(rawConfig);
  const opportunity = validateOpportunity(rawOpportunity);
  const io = session(api);
  const before = io.ref(classificationBranch);
  const text = io.contents(before, classificationPath(opportunity));
  if (text === null) throw new Error("classification is missing");
  const value: unknown = JSON.parse(text);
  exact(
    value,
    "opportunity,opportunity_sha256,review_app_id,review_check_id,review_sha256,schema_version",
  );
  numeric(value.review_check_id);
  if (
    value.schema_version !== 2 ||
    value.review_app_id !== config.review_app_id ||
    value.opportunity_sha256 !== releaseOpportunityDigest(opportunity) ||
    canonical(validateOpportunity(value.opportunity)) !== canonical(opportunity)
  )
    throw new Error("classification record differs from reviewed inputs");
  const proof = review(io.get, value.review_check_id, config, opportunity);
  if (value.review_sha256 !== createHash("sha256").update(proof).digest("hex"))
    throw new Error("persisted semantic review report changed");
  if (
    io.ref(classificationBranch) !== before ||
    review(io.get, value.review_check_id, config, opportunity) !== proof
  )
    throw new Error("classification or review changed during read");
  return {
    commit: before,
    opportunity,
    review_check_id: value.review_check_id,
    observed_at: new Date().toISOString(),
    authority: "none",
  };
}

/** Locate the existing D1 record from the exact neutral request, then reuse the
 * same authenticated Check/record verifier. Only an absent path is missing;
 * malformed, legacy, substituted or changed records remain hard refusals. */
export function readReviewedClassificationForRequest(
  api: CoordinatorRemoteApi,
  rawConfig: unknown,
  rawRequest: unknown,
) {
  const config = configuration(rawConfig);
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request) throw new Error("classification extraction requires an exact neutral request");
  const io = session(api);
  const before = io.ref(classificationBranch);
  const text = io.contents(
    before,
    `classification/${request.source_commit}/${request.change_set_sha256}.json`,
    true,
  );
  if (text === null) {
    if (io.ref(classificationBranch) !== before)
      throw new Error("classification ref changed while path was absent");
    return { status: "missing" as const, commit: before, authority: "none" as const };
  }
  const declared: unknown = JSON.parse(text);
  if (!isRecord(declared)) throw new Error("request classification record malformed");
  const opportunity = validateOpportunity(declared.opportunity);
  if (
    opportunity.base_commit !== request.base_commit ||
    opportunity.source_commit !== request.source_commit ||
    opportunity.source_tree !== request.source_tree ||
    opportunity.change_set_sha256 !== request.change_set_sha256 ||
    opportunity.requested_channel !== request.requested_channel ||
    opportunity.classification.base_version !== request.base_version ||
    opportunity.classification.change_set_scope !== request.change_set_scope
  )
    throw new Error("persisted classification differs from exact neutral request");
  const verified = readReviewedClassification(api, config, opportunity);
  if (verified.commit !== before || io.ref(classificationBranch) !== before)
    throw new Error("request classification changed during independent reauthentication");
  return { ...verified, status: "reviewed" as const };
}

export function readPublicationPause(api: CoordinatorRemoteApi) {
  const io = session(api);
  const before = io.ref(pauseBranch);
  const text = io.contents(before, "publication.json");
  if (text === null) throw new Error("publication pause is unavailable");
  const value: unknown = JSON.parse(text);
  exact(value, "publication_paused,schema_version");
  if (value.schema_version !== 1 || typeof value.publication_paused !== "boolean")
    throw new Error("publication pause is malformed");
  if (io.ref(pauseBranch) !== before) throw new Error("publication pause changed during read");
  return {
    commit: before,
    publication_paused: value.publication_paused,
    observed_at: new Date().toISOString(),
    authority: "none",
  };
}

/** Owner-controlled configuration on the already selected pause ref. The fixed
 * admitted caller must authenticate fresh observer/job provenance in the guard.
 * This reads a revocable operator observation, not live billing availability.
 */
export function readRatifiedCapacityConfiguration(api: CoordinatorRemoteApi, guard: () => void) {
  if (typeof guard !== "function") throw new Error("authenticated capacity source guard missing");
  guard();
  const io = session(api);
  const before = io.ref(pauseBranch);
  const text = io.contents(before, "capacity.json", true);
  if (text === null) throw new Error("ratified capacity configuration unavailable");
  const value: unknown = JSON.parse(text);
  exact(value, "capacity,observation,schema_version");
  exact(value.observation, "evidence_sha256,kind,observed_at,operator_actor_id");
  if (
    value.schema_version !== 1 ||
    value.observation.kind !== "provider-ui-spending-configuration" ||
    value.observation.operator_actor_id !== 43177418 ||
    typeof value.observation.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observation.observed_at)) ||
    Date.parse(value.observation.observed_at) > Date.now() ||
    typeof value.observation.evidence_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.observation.evidence_sha256) ||
    !isRecord(value.capacity) ||
    value.capacity.operation !== null ||
    !Array.isArray(value.capacity.prior_operations) ||
    value.capacity.prior_operations.length !== 0
  )
    throw new Error("capacity source cannot supply invented observation or reservation effects");
  const report = assessBoundedCapacity(value.capacity);
  if (io.ref(pauseBranch) !== before) throw new Error("capacity configuration changed during read");
  guard();
  return {
    commit: before,
    path: "capacity.json",
    document_sha256: capacityDigest(value),
    capacity: structuredClone(value.capacity),
    observation: structuredClone(value.observation),
    report,
    authority: "none",
    qualification: "protected owner configuration; availability/headroom remain unknown",
  };
}
