import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import {
  persistReviewedClassification,
  readReviewedClassificationForRequest,
} from "./release-control-inputs.mts";
import {
  readIndependentSemanticCheckInventory,
  inspectSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { checkCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";

/** Same fixed current-request check used immediately before classification CAS.
 * The callback belongs to trusted caller identity/protection machinery. */
export function requireCurrentClassificationRequest(
  api: CoordinatorRemoteApi,
  namespace: string,
  checkpoint: string,
  fresh: () => void,
) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  if (!/^[a-f0-9]{40}$/u.test(checkpoint) || typeof fresh !== "function")
    throw new Error("exact classification request and freshness guard required");
  fresh();
  const response = api.request(
    "GET",
    `repos/boburning/portcove/git/ref/heads/${namespace}-coordinator-state`,
  );
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    response.body.ref !== `refs/heads/${namespace}-coordinator-state` ||
    !isRecord(response.body.object) ||
    response.body.object.type !== "commit" ||
    response.body.object.sha !== checkpoint
  )
    throw new Error("automatic writer outstanding journal request changed");
  fresh();
  checkCoordinatorDeadline();
}

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

/** Read-only discovery before either D1 App is released. Absence and a negative
 * disposition are ordinary holds; changed or malformed evidence still refuses.
 * This output is routing data, never classification or semantic acceptance. */
export function inspectClassificationRequestReadiness(
  api: CoordinatorRemoteApi,
  producer: unknown,
  rawRequest: unknown,
) {
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request)
    return { eligible: false, reason: "no-outstanding-request", authority: "none" } as const;
  const inventory = readIndependentSemanticCheckInventory(api, producer, request.source_commit);
  const matches = inspectSemanticRequestCheckMatches(inventory.records, request);
  const current = readReviewedClassificationForRequest(api, producer, request);
  inventory.assertUnchanged();
  const eligible =
    matches.accepted.length === 1 && matches.negative.length === 0 && current.status === "missing";
  return {
    eligible,
    reason:
      matches.negative.length > 0
        ? "negative-or-conflicting-review"
        : matches.accepted.length !== 1
          ? "missing-or-ambiguous-review"
          : current.status === "reviewed"
            ? "already-persisted"
            : "unique-independent-acceptance",
    request_id: request.request_id,
    inventory_sha256: inventory.inventory_sha256,
    authority: "none" as const,
  };
}
