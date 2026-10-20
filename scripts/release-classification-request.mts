import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { persistReviewedClassification } from "./release-control-inputs.mts";
import {
  readIndependentSemanticCheckInventory,
  inspectSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";

/** Discovery/persistence only. The fixed writer must authenticate its own
 * source/job, configured App roles, fresh isolated protections and exact current
 * journal request before calling and again in beforeMutation. Provider-supplied
 * records and injected transports never become caller authority here. */
export function persistReviewedClassificationForRequest(
  api: CoordinatorRemoteApi,
  producer: unknown,
  rawRequest: unknown,
  beforeMutation: () => void,
) {
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request || typeof beforeMutation !== "function")
    throw new Error("exact outstanding request and fresh writer guard required");
  const inventory = readIndependentSemanticCheckInventory(api, producer, request.source_commit);
  const matches = inspectSemanticRequestCheckMatches(inventory.records, request);
  if (matches.accepted.length !== 1 || matches.negative.length !== 0)
    throw new Error("exact request has no unique non-conflicting accepted independent Check");
  const accepted = matches.accepted[0]!;
  // Existing persistence reauthenticates the complete specific Check and raw
  // input ref; discovery does not replace that verifier or introduce a writer.
  const result = persistReviewedClassification(
    api,
    producer,
    accepted.opportunity,
    accepted.check_run_id,
    () => {
      inventory.assertUnchanged();
      beforeMutation();
    },
  );
  inventory.assertUnchanged();
  return {
    ...result,
    request_id: request.request_id,
    review_check_id: accepted.check_run_id,
    inventory_sha256: inventory.inventory_sha256,
  };
}
