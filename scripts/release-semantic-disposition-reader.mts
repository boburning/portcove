import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { inspectReviewProducerConfiguration } from "./release-control-inputs.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
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
