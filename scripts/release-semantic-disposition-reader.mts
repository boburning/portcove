import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { inspectReviewProducerConfiguration } from "./release-control-inputs.mts";
import {
  inspectReleaseReviewRequest,
  inspectReleaseReviewDisposition,
} from "./release-review-request.mts";
import { inspectNegativeSemanticDisposition } from "./release-semantic-disposition.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

/** GET-only consistency evidence. This API accepts injected transports and
 * therefore never brands its output as direct runtime/provider authority.
 * The fixed coordinator must independently authenticate its current control
 * source and producer configuration before consuming any retirement receipt. */
export function readIndependentSemanticDisposition(
  api: GitHubRestReader,
  rawConfiguration: unknown,
  rawRequest: unknown,
  checkId: number,
) {
  const config = inspectReviewProducerConfiguration(structuredClone(rawConfiguration));
  const request = inspectReleaseReviewRequest(rawRequest);
  if (
    !request ||
    config.review_check_name !== semanticReviewCheckName ||
    !Number.isSafeInteger(checkId) ||
    checkId < 1
  )
    throw new Error("negative semantic readback requires fixed producer/request/check identity");
  const started = performance.now();
  let count = 0;
  const read = api.request.bind(api);
  const get = (endpoint: string) => {
    if (++count > 4 || performance.now() - started > 120000)
      throw new Error("negative semantic readback request/duration bound exhausted");
    const response = read("GET", endpoint);
    if (
      response.status !== 200 ||
      !isRecord(response.body) ||
      Buffer.byteLength(JSON.stringify(response.body)) > 128 * 1024 ||
      performance.now() - started > 120000
    )
      throw new Error("negative semantic provider record unavailable or oversized");
    return structuredClone(response.body);
  };
  const repository = () => {
    const value = get("repos/boburning/portcove");
    if (
      value.id !== 1354613114 ||
      value.full_name !== "boburning/portcove" ||
      typeof value.node_id !== "string" ||
      !value.node_id ||
      value.node_id.length > 128
    )
      throw new Error("negative semantic repository differs");
    return { id: value.id, name: value.full_name, node_id: value.node_id };
  };
  const observe = () => {
    const value = get(`repos/boburning/portcove/check-runs/${checkId}`);
    if (
      value.id !== checkId ||
      !isRecord(value.app) ||
      value.app.id !== config.review_app_id ||
      value.name !== semanticReviewCheckName ||
      value.head_sha !== request.source_commit ||
      value.status !== "completed" ||
      value.conclusion !== "failure" ||
      typeof value.completed_at !== "string" ||
      !Number.isFinite(Date.parse(value.completed_at)) ||
      Date.parse(value.completed_at) > Date.now() ||
      !isRecord(value.output) ||
      value.output.annotations_count !== 0 ||
      value.output.title !== "Portcove independent release review disposition v1" ||
      typeof value.output.summary !== "string" ||
      Buffer.byteLength(value.output.summary) > 64 * 1024 ||
      (value.output.text != null && value.output.text !== "")
    )
      throw new Error(
        "independent negative semantic Check is incomplete or from another producer/input",
      );
    const wire = inspectNegativeSemanticDisposition(JSON.parse(value.output.summary));
    const wire_sha256 = capacityDigest(wire);
    if (
      capacityDigest(wire.request) !== capacityDigest(request) ||
      value.completed_at !== wire.review.completed_at ||
      value.external_id !== `portcove-release-review-negative-v1:${wire_sha256}`
    )
      throw new Error("negative semantic Check does not bind exact request/report/completion");
    const observed = {
      id: checkId,
      app_id: config.review_app_id,
      name: value.name,
      head_sha: value.head_sha,
      status: value.status,
      conclusion: value.conclusion,
      completed_at: value.completed_at,
      external_id: value.external_id,
      output: value.output,
    };
    return { wire, wire_sha256, observation_sha256: capacityDigest(observed) };
  };
  const firstRepository = repository();
  const first = observe();
  const final = observe();
  if (
    capacityDigest(firstRepository) !== capacityDigest(repository()) ||
    first.observation_sha256 !== final.observation_sha256 ||
    first.wire_sha256 !== final.wire_sha256
  )
    throw new Error("negative semantic repository/Check changed during readback");
  return {
    schema_version: 1 as const,
    check_run_id: checkId,
    review_app_id: config.review_app_id,
    ...first,
    authority: "none" as const,
  };
}

/** Discover a lost/unreturned Check locator without asking a human or trusting
 * the producer's local POST response. GitHub's ref/check-runs endpoint silently
 * limits coverage to the most recent 1000 suites, so enumerate suites first.
 * Missing, duplicated or excessive history stays Unknown; never re-POST here. */
export function discoverIndependentSemanticDisposition(
  api: GitHubRestReader,
  rawConfiguration: unknown,
  rawRequest: unknown,
) {
  const config = inspectReviewProducerConfiguration(structuredClone(rawConfiguration));
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request || config.review_check_name !== semanticReviewCheckName)
    throw new Error("negative semantic discovery requires fixed producer/request identity");
  const start = performance.now();
  let requests = 0,
    bytes = 0;
  const read = api.request.bind(api);
  const bounded: GitHubRestReader = {
    request(method, endpoint) {
      if (method !== "GET" || ++requests > 40 || performance.now() - start > 120000)
        throw new Error("negative semantic discovery request/duration bound exceeded");
      const response = read("GET", endpoint);
      const length = Buffer.byteLength(JSON.stringify(response.body));
      bytes += length;
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        length > 8 * 1024 * 1024 ||
        bytes > 32 * 1024 * 1024 ||
        performance.now() - start > 120000
      )
        throw new Error("negative semantic discovery provider/body bound exceeded");
      return structuredClone(response);
    },
  };
  const snapshot = () => {
    const suitesResponse = bounded.request(
      "GET",
      `repos/boburning/portcove/commits/${request.source_commit}/check-suites?app_id=${config.review_app_id}&per_page=100&page=1`,
    );
    const body = suitesResponse.body;
    if (
      !isRecord(body) ||
      typeof body.total_count !== "number" ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0 ||
      body.total_count > 16 ||
      !Array.isArray(body.check_suites) ||
      body.check_suites.length !== body.total_count
    )
      throw new Error("complete fixed-App check suite inventory absent or excessive");
    const suiteIds = new Set<number>();
    const checkIds = new Set<number>();
    const inventory: { suite_id: number; checks_sha256: string }[] = [];
    const matches: number[] = [];
    for (const suite of body.check_suites) {
      if (
        !isRecord(suite) ||
        typeof suite.id !== "number" ||
        !Number.isSafeInteger(suite.id) ||
        suite.id < 1 ||
        suiteIds.has(suite.id) ||
        suite.head_sha !== request.source_commit ||
        !isRecord(suite.app) ||
        suite.app.id !== config.review_app_id ||
        !isRecord(suite.repository) ||
        suite.repository.id !== 1354613114 ||
        suite.repository.full_name !== "boburning/portcove"
      )
        throw new Error("semantic suite issuer/head/repository identity differs");
      suiteIds.add(suite.id);
      let total: number | null = null;
      const rows: Record<string, unknown>[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = bounded.request(
          "GET",
          `repos/boburning/portcove/check-suites/${suite.id}/check-runs?check_name=${encodeURIComponent(semanticReviewCheckName)}&filter=all&per_page=100&page=${page}`,
        );
        const runs = response.body;
        if (
          !isRecord(runs) ||
          typeof runs.total_count !== "number" ||
          !Number.isSafeInteger(runs.total_count) ||
          runs.total_count < 0 ||
          runs.total_count >= 1000 ||
          !Array.isArray(runs.check_runs) ||
          runs.check_runs.length > 100
        )
          throw new Error(
            "semantic suite run inventory incomplete or at provider deletion ceiling",
          );
        total ??= runs.total_count;
        if (total !== runs.total_count)
          throw new Error("semantic suite total changed during pagination");
        for (const value of runs.check_runs) {
          if (
            !isRecord(value) ||
            typeof value.id !== "number" ||
            !Number.isSafeInteger(value.id) ||
            value.id < 1 ||
            checkIds.has(value.id) ||
            value.head_sha !== request.source_commit ||
            value.name !== semanticReviewCheckName ||
            !isRecord(value.app) ||
            value.app.id !== config.review_app_id ||
            !isRecord(value.check_suite) ||
            value.check_suite.id !== suite.id
          )
            throw new Error("semantic run identity duplicates or escapes suite/issuer/head");
          checkIds.add(value.id);
          rows.push({
            id: value.id,
            app: value.app.id,
            head_sha: value.head_sha,
            name: value.name,
            status: value.status,
            conclusion: value.conclusion,
            completed_at: value.completed_at,
            external_id: value.external_id,
            output: value.output,
          });
          if (value.status !== "completed" || value.conclusion !== "failure") continue;
          if (
            !isRecord(value.output) ||
            typeof value.output.summary !== "string" ||
            Buffer.byteLength(value.output.summary) > 64 * 1024
          )
            throw new Error("negative semantic discovery report incomplete");
          const wire = inspectNegativeSemanticDisposition(JSON.parse(value.output.summary));
          if (
            wire.request_id === request.request_id &&
            capacityDigest(wire.request) === capacityDigest(request)
          )
            matches.push(value.id);
        }
        if (rows.length > total) throw new Error("semantic suite inventory exceeds declared count");
        if (rows.length === total) break;
        if (runs.check_runs.length !== 100) throw new Error("semantic suite omitted a page");
      }
      if (rows.length !== total) throw new Error("semantic suite inventory coverage incomplete");
      inventory.push({ suite_id: suite.id, checks_sha256: capacityDigest(rows) });
    }
    return { inventory, matches };
  };
  const first = snapshot();
  if (first.matches.length !== 1)
    throw new Error(
      "negative semantic disposition absent or ambiguous; retain request without POST",
    );
  const result = readIndependentSemanticDisposition(bounded, config, request, first.matches[0]!);
  if (capacityDigest(first) !== capacityDigest(snapshot()))
    throw new Error("semantic suite/run inventory changed during exact readback");
  return result;
}

/** Compact declared custody only. Call this on a direct, freshly authenticated
 * consumer result inside the fixed coordinator; it does not turn imported JSON
 * into producer proof. The journal independently validates the transition. */
export function createReleaseReviewDispositionReceipt(
  observed: ReturnType<typeof readIndependentSemanticDisposition>,
  requestCheckpoint: string,
  previousDisposition: unknown,
) {
  const wire = inspectNegativeSemanticDisposition(observed.wire);
  if (capacityDigest(wire) !== observed.wire_sha256)
    throw new Error("negative semantic observed wire changed before compact custody");
  const previous = inspectReleaseReviewDisposition(previousDisposition);
  const priorRequests =
    previous && previous.request.base_version === wire.request.base_version
      ? [
          ...previous.prior_requests,
          {
            request_id: previous.request.request_id,
            source_commit: previous.request.source_commit,
            source_tree: previous.request.source_tree,
            request_checkpoint: previous.request_checkpoint,
            check_run_id: previous.check_run_id,
            wire_sha256: previous.wire_sha256,
          },
        ]
      : [];
  return inspectReleaseReviewDisposition({
    schema_version: 1,
    kind: "application-release-semantic-disposition-receipt",
    request: wire.request,
    request_checkpoint: requestCheckpoint,
    check_run_id: observed.check_run_id,
    review_app_id: observed.review_app_id,
    stage: wire.stage,
    disposition: wire.disposition,
    wire_sha256: observed.wire_sha256,
    opportunity_sha256: wire.opportunity_sha256,
    bundle_sha256: wire.bundle_sha256,
    invocation_sha256: wire.invocation_sha256,
    events_sha256: wire.events_sha256,
    isolation_sha256: wire.isolation_sha256,
    report_sha256: wire.review.report_sha256,
    session_ref: wire.review.session_ref,
    completed_at: wire.review.completed_at,
    prior_requests: priorRequests,
    transient_retries: previous?.transient_retries ?? 0,
    substantive_repairs: previous?.substantive_repairs ?? 0,
  })!;
}
