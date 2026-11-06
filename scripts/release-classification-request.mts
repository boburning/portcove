import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import {
  persistReviewedClassification,
  persistReviewedClassificationWithSdk,
  readReviewedClassificationForRequest,
  readReviewedClassificationForRequestWithSdk,
} from "./release-control-inputs.mts";
import {
  readIndependentSemanticCheckInventory,
  readIndependentSemanticCheckInventoryWithSdk,
  inspectSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import {
  checkCoordinatorDeadline,
  coordinatorCommandDeadline,
} from "./release-coordinator-deadline.mts";
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
  assertCurrentClassificationRequest(response.status, response.body, namespace, checkpoint);
  fresh();
  checkCoordinatorDeadline();
}

export async function createClassificationJournalGuard(
  options: Parameters<typeof readIndependentSemanticCheckInventoryWithSdk>[0],
  namespace: string,
  checkpoint: string,
  fresh: () => void,
) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  if (!/^[a-f0-9]{40}$/u.test(checkpoint) || typeof fresh !== "function")
    throw new Error("exact classification request and freshness guard required");
  const endpoint = `/repos/boburning/portcove/git/ref/heads/${namespace}-coordinator-state`;
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: options.token },
    deadline: Math.min(options.deadline, coordinatorCommandDeadline() ?? Infinity),
    maxBytes: 2 * 1024 * 1024,
    allowRequest(method, url) {
      options.guard();
      fresh();
      return method === "GET" && url.href === `https://api.github.com${endpoint}`;
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return async () => {
    fresh();
    const response = await client.request(`GET ${endpoint}`, {
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    assertCurrentClassificationRequest(response.status, response.data, namespace, checkpoint);
    fresh();
    options.guard();
  };
}

function assertCurrentClassificationRequest(
  status: number | undefined,
  body: unknown,
  namespace: string,
  checkpoint: string,
) {
  if (
    status !== 200 ||
    !isRecord(body) ||
    body.ref !== `refs/heads/${namespace}-coordinator-state` ||
    !isRecord(body.object) ||
    body.object.type !== "commit" ||
    body.object.sha !== checkpoint
  )
    throw new Error("automatic writer outstanding journal request changed");
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

export async function persistReviewedClassificationForRequestWithSdk(
  options: Parameters<typeof readIndependentSemanticCheckInventoryWithSdk>[0],
  writer: Parameters<typeof persistReviewedClassificationWithSdk>[1],
  producer: unknown,
  rawRequest: unknown,
) {
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request || typeof writer.beforeMutation !== "function")
    throw new Error("exact outstanding request and fresh writer guard required");
  const inventory = await readIndependentSemanticCheckInventoryWithSdk(
    options,
    producer,
    request.source_commit,
  );
  const matches = inspectSemanticRequestCheckMatches(inventory.records, request);
  if (matches.accepted.length !== 1 || matches.negative.length !== 0)
    throw new Error("exact request has no unique non-conflicting accepted independent Check");
  const accepted = matches.accepted[0]!;
  const result = await persistReviewedClassificationWithSdk(
    options,
    {
      ...writer,
      async beforeMutation() {
        await inventory.assertUnchanged();
        await writer.beforeMutation();
      },
    },
    producer,
    accepted.opportunity,
    accepted.check_run_id,
  );
  await inventory.assertUnchanged();
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
  return classificationReadiness(request, inventory, matches, current);
}

export async function inspectClassificationRequestReadinessWithSdk(
  options: Parameters<typeof readIndependentSemanticCheckInventoryWithSdk>[0],
  producer: unknown,
  rawRequest: unknown,
) {
  const request = inspectReleaseReviewRequest(rawRequest);
  if (!request)
    return { eligible: false, reason: "no-outstanding-request", authority: "none" } as const;
  const inventory = await readIndependentSemanticCheckInventoryWithSdk(
    options,
    producer,
    request.source_commit,
  );
  const matches = inspectSemanticRequestCheckMatches(inventory.records, request);
  const current = await readReviewedClassificationForRequestWithSdk(options, producer, request);
  await inventory.assertUnchanged();
  return classificationReadiness(request, inventory, matches, current);
}

function classificationReadiness(
  request: NonNullable<ReturnType<typeof inspectReleaseReviewRequest>>,
  inventory: { inventory_sha256: string },
  matches: ReturnType<typeof inspectSemanticRequestCheckMatches>,
  current: ReturnType<typeof readReviewedClassificationForRequest>,
) {
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
