/** Catalog negative custody in the existing coordinator only. Pure projections
 * never authenticate provider evidence or grant acceptance/signing authority. */
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectCatalogReviewRequest,
  assertCatalogReviewRequestBaseline,
} from "./release-catalog-review-request.mts";
import { inspectPublishedCatalogMetadata } from "./release-catalog-metadata-contract.mts";
import {
  checkCoordinatorDeadline,
  coordinatorCommandTimeout,
  withCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
function exact(raw: unknown, fields: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== fields)
    throw new Error("catalog disposition schema differs");
}
function sha(raw: unknown, length = 64) {
  if (typeof raw !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw))
    throw new Error("catalog disposition identity differs");
  return raw;
}
function number(raw: unknown) {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)
    throw new Error("catalog disposition numeric identity absent");
  return raw;
}
function instant(raw: unknown) {
  if (
    typeof raw !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(raw) ||
    !Number.isFinite(Date.parse(raw)) ||
    new Date(raw).toISOString() !== (raw.length === 20 ? raw.slice(0, -1) + ".000Z" : raw)
  )
    throw new Error("catalog disposition clock differs");
  return raw;
}
function requestProjection(raw: unknown) {
  const r = inspectCatalogReviewRequest(raw);
  if (!r) throw new Error("catalog disposition request absent");
  return {
    request_id: r.request_id,
    source_commit: r.opportunity.source_commit,
    source_tree: r.opportunity.source_tree,
    base_commit: r.opportunity.base_commit,
    baseline_source_tree: r.opportunity.baseline.source_tree,
    catalog_root_sha256: r.opportunity.baseline.catalog_root_sha256,
    catalog_repository_sha256: r.opportunity.baseline.catalog_repository_sha256,
    publication_bundle_sha256: r.opportunity.bundle_sha256,
    core_inspection_sha256: r.opportunity.core_inspection_sha256,
    publisher_configuration_sha256: r.opportunity.publisher_configuration_sha256,
    requested_at: r.requested_at,
  };
}
function inspectRequestProjection(raw: unknown) {
  exact(
    raw,
    "base_commit,baseline_source_tree,catalog_repository_sha256,catalog_root_sha256,core_inspection_sha256,publication_bundle_sha256,publisher_configuration_sha256,request_id,requested_at,source_commit,source_tree",
  );
  return {
    request_id: sha(raw.request_id),
    source_commit: sha(raw.source_commit, 40),
    source_tree: sha(raw.source_tree, 40),
    base_commit: sha(raw.base_commit, 40),
    baseline_source_tree: sha(raw.baseline_source_tree, 40),
    catalog_root_sha256: sha(raw.catalog_root_sha256),
    catalog_repository_sha256:
      raw.catalog_repository_sha256 === null ? null : sha(raw.catalog_repository_sha256),
    publication_bundle_sha256: sha(raw.publication_bundle_sha256),
    core_inspection_sha256: sha(raw.core_inspection_sha256),
    publisher_configuration_sha256: sha(raw.publisher_configuration_sha256),
    requested_at: instant(raw.requested_at),
  };
}
function baseline(raw: { catalog_root_sha256: string; catalog_repository_sha256: string | null }) {
  return digest({
    root_sha256: raw.catalog_root_sha256,
    repository_sha256: raw.catalog_repository_sha256,
  });
}
export function inspectCatalogReviewDisposition(raw: unknown) {
  if (raw == null) return null;
  exact(
    raw,
    "bundle_sha256,check_run_id,completed_at,disposition,events_sha256,invocation_sha256,isolation_sha256,kind,opportunity_sha256,prior_requests,report_sha256,request,request_checkpoint,review_app_id,schema_version,session_ref,stage,substantive_repairs,transient_retries,wire_sha256",
  );
  if (
    raw.schema_version !== 1 ||
    raw.kind !== "catalog-publication-semantic-disposition-receipt" ||
    raw.stage !== "complete-catalog-publication-opportunity" ||
    !["refused", "changes-required"].includes(String(raw.disposition))
  )
    throw new Error("only catalog negative dispositions may be retained");
  const request = inspectRequestProjection(raw.request);
  if (!Array.isArray(raw.prior_requests) || raw.prior_requests.length > 3)
    throw new Error("catalog negative history bound exceeded");
  const prior_requests = raw.prior_requests.map((row: unknown) => {
    exact(row, "check_run_id,request_checkpoint,request_id,source_commit,source_tree,wire_sha256");
    return {
      check_run_id: number(row.check_run_id),
      request_checkpoint: sha(row.request_checkpoint, 40),
      request_id: sha(row.request_id),
      source_commit: sha(row.source_commit, 40),
      source_tree: sha(row.source_tree, 40),
      wire_sha256: sha(row.wire_sha256),
    };
  });
  for (const field of ["request_id", "source_commit", "source_tree"] as const)
    if (
      new Set([...prior_requests.map((row) => row[field]), request[field]]).size !==
      prior_requests.length + 1
    )
      throw new Error("catalog negative history repeats an original source/request");
  for (const [field, max] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const)
    if (
      typeof raw[field] !== "number" ||
      !Number.isSafeInteger(raw[field]) ||
      raw[field] < 0 ||
      raw[field] > max
    )
      throw new Error("catalog semantic recovery limit exceeded");
  const completed_at = instant(raw.completed_at);
  if (
    Date.parse(completed_at) < Math.floor(Date.parse(request.requested_at) / 1000) * 1000 ||
    typeof raw.session_ref !== "string" ||
    !raw.session_ref ||
    Buffer.byteLength(raw.session_ref) > 512 ||
    Array.from(raw.session_ref).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    raw.review_app_id === 15368
  )
    throw new Error("catalog disposition completion/producer absent");
  const result = {
    schema_version: 1 as const,
    kind: "catalog-publication-semantic-disposition-receipt" as const,
    request,
    request_checkpoint: sha(raw.request_checkpoint, 40),
    check_run_id: number(raw.check_run_id),
    review_app_id: number(raw.review_app_id),
    stage: "complete-catalog-publication-opportunity" as const,
    disposition: raw.disposition as "refused" | "changes-required",
    wire_sha256: sha(raw.wire_sha256),
    opportunity_sha256: sha(raw.opportunity_sha256),
    bundle_sha256: sha(raw.bundle_sha256),
    invocation_sha256: sha(raw.invocation_sha256),
    events_sha256: sha(raw.events_sha256),
    isolation_sha256: sha(raw.isolation_sha256),
    report_sha256: sha(raw.report_sha256),
    session_ref: raw.session_ref,
    completed_at,
    prior_requests,
    transient_retries: Number(raw.transient_retries),
    substantive_repairs: Number(raw.substantive_repairs),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 4096)
    throw new Error("compact catalog disposition exceeds journal bound");
  return result;
}
type Disposition = NonNullable<ReturnType<typeof inspectCatalogReviewDisposition>>;
function priorRow(previous: Disposition) {
  return {
    request_id: previous.request.request_id,
    source_commit: previous.request.source_commit,
    source_tree: previous.request.source_tree,
    request_checkpoint: previous.request_checkpoint,
    check_run_id: previous.check_run_id,
    wire_sha256: previous.wire_sha256,
  };
}
/** Inert canonical projection, not a provider authenticator. Production calls
 * this only after the default actual receiver below and a fresh control guard. */
export function compactCatalogReviewDisposition(raw: unknown, previousRaw: unknown) {
  if (!isRecord(raw)) throw new Error("catalog disposition readback absent");
  const previous = inspectCatalogReviewDisposition(previousRaw),
    request = requestProjection(raw.request);
  if (previous && baseline(previous.request) !== baseline(request))
    throw new Error("catalog negative cannot reset prior baseline outside new request transition");
  return inspectCatalogReviewDisposition({
    ...raw,
    request,
    prior_requests: previous ? [...previous.prior_requests, priorRow(previous)] : [],
    transient_retries: previous?.transient_retries ?? 0,
    substantive_repairs: previous?.substantive_repairs ?? 0,
  })!;
}
/** A new source consumes a substantive repair; technical retries remain the
 * worker's existing initial+2 attempts for this same immutable request. */
export function advanceCatalogReviewRecovery(
  previousRaw: unknown,
  nextRequestRaw: unknown,
  input: Record<string, unknown>,
) {
  const previous = inspectCatalogReviewDisposition(previousRaw),
    next = assertCatalogReviewRequestBaseline(nextRequestRaw, input);
  if (!previous) return null;
  const projection = requestProjection(next);
  if (baseline(previous.request) !== baseline(projection)) {
    const seed = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
    if (
      !seed ||
      seed.repository_sha256 === previous.request.catalog_repository_sha256 ||
      seed.root_sha256 !== projection.catalog_root_sha256 ||
      seed.repository_sha256 !== projection.catalog_repository_sha256
    )
      throw new Error(
        "catalog semantic history resets only after actual durable catalog baseline advance",
      );
    return null;
  }
  if (
    projection.base_commit !== previous.request.base_commit ||
    projection.baseline_source_tree !== previous.request.baseline_source_tree ||
    [...previous.prior_requests, previous.request].some(
      (row) =>
        row.source_commit === projection.source_commit ||
        row.source_tree === projection.source_tree,
    )
  )
    throw new Error(
      "catalog semantic replacement requires changed source AND tree on same publication baseline",
    );
  if (previous.substantive_repairs >= 3)
    throw new Error("catalog semantic substantive repairs exhausted");
  return { ...previous, substantive_repairs: previous.substantive_repairs + 1 };
}
function idle(input: Record<string, unknown>) {
  if (
    input.active_candidate != null ||
    input.review_request != null ||
    input.review_disposition != null ||
    input.metadata_renewal != null ||
    input.metadata_bootstrap != null
  )
    throw new Error("catalog negative/replacement cannot bypass application or metadata holds");
  if (!isRecord(input.controller) || !isRecord(input.controller.capacity_attempt))
    throw new Error("catalog bounded coordinator capacity absent");
  const op = input.controller.capacity_attempt.operation;
  if (
    op != null &&
    (!isRecord(op) ||
      !["succeeded", "recovered"].includes(String(op.outcome)) ||
      (op.outcome === "recovered" &&
        (!isRecord(op.recovery) || op.recovery.resolution === "partial-effects-retained")))
  )
    throw new Error("unresolved capacity effect prevents catalog semantic transition");
}
function sameOtherInputs(previous: Record<string, unknown>, next: Record<string, unknown>) {
  if (!isRecord(previous.publication) || !isRecord(next.publication))
    throw new Error("catalog transition requires complete publication observations");
  const priorClock = instant(previous.publication.observed_at),
    nextClock = instant(next.publication.observed_at);
  if (
    Date.parse(nextClock) < Date.parse(priorClock) ||
    Date.parse(nextClock) > Date.parse(String(next.now))
  )
    throw new Error("catalog publication observation clock regressed or is in future");
  const clean = (raw: Record<string, unknown>) => {
    const { now, catalog_review_request, catalog_review_disposition, publication, ...other } = raw;
    void now;
    void catalog_review_request;
    void catalog_review_disposition;
    const { observed_at, ...inventory } = publication as Record<string, unknown>;
    void observed_at;
    return { ...other, publication: inventory };
  };
  if (digest(clean(previous)) !== digest(clean(next)))
    throw new Error(
      "catalog negative/replacement cannot rewrite unrelated state/counters/publication inventory",
    );
}
/** Returns true only for transitions handled here. The existing positive
 * descriptor retirement checker handles every remaining request transition. */
export function validateCatalogReviewRecoveryTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  const before = inspectCatalogReviewRequest(previous.catalog_review_request),
    after = inspectCatalogReviewRequest(next.catalog_review_request),
    old = inspectCatalogReviewDisposition(previous.catalog_review_disposition),
    current = inspectCatalogReviewDisposition(next.catalog_review_disposition);
  sha(checkpoint, 40);
  if (digest(before) === digest(after) && digest(old) === digest(current)) return false;
  if (!before && after) {
    if (!old) {
      if (current) throw new Error("initial catalog request cannot invent negative history");
      return false;
    }
    idle(previous);
    idle(next);
    sameOtherInputs(previous, next);
    if (digest(advanceCatalogReviewRecovery(old, after, next)) !== digest(current))
      throw new Error("catalog replacement cannot erase or reset semantic recovery counters");
    return false;
  }
  if (before && !after && digest(old) !== digest(current)) {
    idle(previous);
    idle(next);
    sameOtherInputs(previous, next);
    if (
      !current ||
      next.catalog_publication != null ||
      digest(current.request) !== digest(requestProjection(before)) ||
      current.request_checkpoint !== checkpoint ||
      Date.parse(current.completed_at) > Date.parse(String(next.now)) ||
      digest(current.prior_requests) !==
        digest(old ? [...old.prior_requests, priorRow(old)] : []) ||
      current.transient_retries !== (old?.transient_retries ?? 0) ||
      current.substantive_repairs !== (old?.substantive_repairs ?? 0) ||
      current.opportunity_sha256 !== digest(before.opportunity)
    )
      throw new Error(
        "catalog negative retirement requires exact original request and authenticated proof without counter reset",
      );
    return true;
  }
  if (digest(old) !== digest(current))
    throw new Error(
      "catalog negative history cannot disappear/change outside exact retirement/replacement",
    );
  return false;
}
const receipts = new WeakMap<
  object,
  {
    controls: unknown;
    parent: string;
    request: NonNullable<ReturnType<typeof inspectCatalogReviewRequest>>;
    checkpoint: string;
    deadline: number;
    configuration_sha256: string;
    proof_sha256: string;
    input_sha256: string;
  }
>();
function bounded(deadline: number, tighter?: number) {
  if (tighter !== undefined && (!Number.isFinite(tighter) || tighter <= performance.now()))
    throw new Error("catalog negative inherited deadline exhausted");
  const result = Math.min(deadline, tighter ?? Infinity);
  if (!Number.isFinite(result) || result <= performance.now())
    throw new Error("catalog negative original deadline exhausted");
  checkCoordinatorDeadline();
  return result;
}
async function actualInputs(owned: {
  controls: unknown;
  parent: string;
  request: NonNullable<ReturnType<typeof inspectCatalogReviewRequest>>;
  checkpoint: string;
  deadline: number;
}) {
  const { requireAuthenticatedCatalogControlSource } =
    await import("./release-live-control-admission.mts");
  requireAuthenticatedCatalogControlSource(owned.controls, "coordinator");
  if (
    !isRecord(owned.controls) ||
    owned.controls.evidence_scope !== "github.com" ||
    typeof owned.controls.readMaintenance !== "function"
  )
    throw new Error("actual catalog coordinator controls required");
  const { requireControllerCatalogJobAuthorities } =
      await import("./release-authority-configuration.mts"),
    authorities = await requireControllerCatalogJobAuthorities("coordinator");
  const { createGitHubRunner, GitHubApiClient } = await import("./github-api.mts");
  const transport = { cwd: owned.parent, deadline: owned.deadline };
  const client = new GitHubApiClient((args, input) => {
    bounded(owned.deadline);
    const result = createGitHubRunner({
      cwd: owned.parent,
      maxBuffer: 2 * 1024 ** 2,
      timeoutMs: coordinatorCommandTimeout(
        Math.max(1, Math.floor(Math.min(15000, owned.deadline - performance.now()))),
      ),
    })([...args, "--hostname", "github.com"], input);
    bounded(owned.deadline);
    return result;
  });
  const api = {
    request(method: string, endpoint: string, body?: unknown) {
      if (method !== "GET") throw new Error("catalog disposition transport is GET only");
      return client.request(method, endpoint, body);
    },
    graphql() {
      throw new Error("catalog disposition has no mutation transport");
    },
  };
  const { readRemoteCoordinatorSnapshot } = await import("./release-coordinator-recovery.mts");
  const snapshot = await readRemoteCoordinatorSnapshot(
    owned.parent,
    { schema_version: 1, namespace: authorities.namespace },
    { transport },
  );
  if (
    snapshot.checkpoint !== owned.checkpoint ||
    digest(inspectCatalogReviewRequest(snapshot.input.catalog_review_request)) !==
      digest(owned.request)
  )
    throw new Error("catalog original request/checkpoint changed");
  idle(snapshot.input);
  assertCatalogReviewRequestBaseline(owned.request, snapshot.input);
  const { discoverIndependentCatalogSemanticDisposition, createCatalogReviewDispositionReceipt } =
    await import("./release-semantic-disposition-reader.mts");
  const observed = discoverIndependentCatalogSemanticDisposition(
    api,
    authorities.semantic_producer,
    owned.request,
  );
  // LAST provider validation before returning: original observation must still be fresh.
  const controls = owned.controls as { readMaintenance: (reader: typeof api) => unknown };
  const facts = controls.readMaintenance(api);
  if (
    !isRecord(facts) ||
    !isRecord(facts.pause) ||
    facts.pause.publication_paused !== false ||
    facts.resource_policy_matches_controller !== true
  )
    throw new Error("catalog negative control/capacity remains held");
  bounded(owned.deadline);
  const disposition = compactCatalogReviewDisposition(
    createCatalogReviewDispositionReceipt(observed, owned.checkpoint),
    snapshot.input.catalog_review_disposition,
  );
  return {
    disposition,
    controls_facts: facts,
    input: snapshot.input,
    configuration_sha256: authorities.configuration_sha256,
    proof_sha256: digest(observed),
  };
}
/** No injectable API, imported Check or raw receipt can mint this capability. */
export async function receiveActualCatalogReviewDisposition(
  controls: unknown,
  parent: string,
  rawRequest: unknown,
  checkpoint: string,
  phaseDeadline: number,
) {
  const request = inspectCatalogReviewRequest(rawRequest);
  if (!request) throw new Error("catalog negative actual request absent");
  sha(checkpoint, 40);
  const deadline = bounded(
    Math.min(phaseDeadline, performance.now() + coordinatorCommandTimeout(170000)),
  );
  const { requireAuthenticatedCatalogControlSource } =
    await import("./release-live-control-admission.mts");
  requireAuthenticatedCatalogControlSource(controls, "coordinator");
  if (!isRecord(controls) || controls.evidence_scope !== "github.com")
    throw new Error("actual catalog controls only");
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp)) throw new Error("fixed catalog negative parent unavailable");
  const { assertOwnedUnlinkedPath } = await import("./release-path-safety.mts");
  await assertOwnedUnlinkedPath(temp, parent, "catalog disposition parent");
  return withCoordinatorDeadline(deadline, async () => {
    const owned = { controls, parent, request, checkpoint, deadline };
    const actual = await actualInputs(owned);
    const receipt = Object.freeze({ kind: "actual-catalog-negative-review", authority: "none" });
    receipts.set(receipt, {
      ...owned,
      configuration_sha256: actual.configuration_sha256,
      proof_sha256: actual.proof_sha256,
      input_sha256: digest(actual.input),
    });
    return receipt;
  });
}
export async function requireActualCatalogReviewDisposition(
  receipt: object,
  phaseDeadline?: number,
) {
  const owned = receipts.get(receipt);
  if (!owned) throw new Error("actual catalog negative receipt required");
  owned.deadline = bounded(owned.deadline, phaseDeadline);
  return withCoordinatorDeadline(owned.deadline, async () => {
    const actual = await actualInputs(owned);
    if (
      actual.configuration_sha256 !== owned.configuration_sha256 ||
      actual.proof_sha256 !== owned.proof_sha256 ||
      digest(actual.input) !== owned.input_sha256
    )
      throw new Error("catalog negative original provider/journal/configuration changed");
    return { ...actual, checkpoint: owned.checkpoint, authority: "none" as const };
  });
}
export async function prepareActualCatalogReviewRetirement(
  receipt: object,
  now: string,
  phaseDeadline?: number,
  publication?: unknown,
) {
  const actual = await requireActualCatalogReviewDisposition(receipt, phaseDeadline);
  instant(now);
  const input = {
    ...structuredClone(actual.input),
    now,
    ...(publication === undefined ? {} : { publication: structuredClone(publication) }),
    catalog_review_request: null,
    catalog_review_disposition: actual.disposition,
  };
  validateCatalogReviewRecoveryTransition(actual.input, input, actual.checkpoint);
  return {
    input,
    checkpoint: actual.checkpoint,
    controls_facts: actual.controls_facts,
    authority: "none" as const,
  };
}
