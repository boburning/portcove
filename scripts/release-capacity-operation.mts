import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import {
  assessBoundedCapacity,
  capacityDigest,
  inspectCapacityOperation,
  inspectPriorCapacityOperations,
} from "./release-capacity.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";
import { sanitizeOperationError } from "./github-api.mts";

export class ProviderCapacityRefusal extends Error {
  readonly receipt: { remote_identity: string; evidence_sha256: string };
  constructor(remoteIdentity: string, evidenceSha256: string) {
    super("provider capacity refusal");
    if (
      !remoteIdentity ||
      remoteIdentity.length > 512 ||
      Array.from(remoteIdentity).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !/^[a-f0-9]{64}$/u.test(evidenceSha256)
    )
      throw new Error("capacity refusal evidence invalid");
    this.receipt = { remote_identity: remoteIdentity, evidence_sha256: evidenceSha256 };
  }
}

/** Inactive caller-owned seam. Does not discover credentials, dispatch, upload,
 * change retention, allocate candidates, or grant execution. An independently
 * admitted caller supplies one exact effect. No CLI or automatic retry exists.
 */
export async function runBoundedCapacityOperation(
  repository: string,
  expected: string,
  request: { kind: "dispatch" | "upload" | "retention"; destination: string },
  readBoundary: () => Promise<unknown>,
  effect: (
    recordCompleted: (remoteIdentity: string, evidenceSha256: string) => Promise<void>,
  ) => Promise<void>,
  options: { remote?: { configuration: unknown; api: CoordinatorRemoteApi } } = {},
) {
  // Freeze the selected mode before any await or caller-provided callback.
  const remote = options.remote
    ? {
        configuration: structuredClone(options.remote.configuration),
        api: {
          request: options.remote.api.request.bind(options.remote.api),
          graphql: options.remote.api.graphql.bind(options.remote.api),
        },
      }
    : null;
  const recovered = await recoverReleaseOpportunity(repository, expected);
  const input = structuredClone(recovered.input);
  if (
    input.schema_version !== 2 ||
    !isRecord(input.controller) ||
    !isRecord(input.controller.capacity_attempt) ||
    !isRecord(input.active_candidate)
  )
    throw new Error("bounded operation requires schema2 and an existing frozen reservation");
  const controller = input.controller,
    capacity = controller.capacity_attempt;
  if (!isRecord(capacity)) throw new Error("bounded capacity input unavailable");
  capacity.boundary = structuredClone(await readBoundary());
  const ready = assessBoundedCapacity(capacity);
  if (ready.eligibility !== "eligible" || recovered.plan.action !== "resume-active")
    throw new Error("bounded operation is held by capacity or another coordinator condition");
  const candidate = input.active_candidate;
  const identity = {
    before_checkpoint: expected,
    candidate: {
      source_commit: candidate.source_commit,
      prepared_commit: candidate.prepared_commit,
      version: candidate.version,
      transient_retries: candidate.transient_retries,
      substantive_repairs: candidate.substantive_repairs,
    },
    destination: request.destination,
    kind: request.kind,
    policy_sha256: ready.resource_policy_sha256,
    ratification_sha256: ready.ratification_sha256,
    sequence: (ready.operation?.sequence ?? 0) + 1,
  };
  const operation = {
    ...identity,
    id: capacityDigest(identity),
    outcome: "pending",
    completed_effects: [] as { remote_identity: string; evidence_sha256: string }[],
    failure_evidence: null as { remote_identity: string; evidence_sha256: string } | null,
    recovery: null,
  };
  inspectCapacityOperation(operation);
  capacity.prior_operations = [
    ...inspectPriorCapacityOperations(capacity.prior_operations),
    ...(ready.operation ? [ready.operation] : []),
  ].filter((prior) => prior?.candidate.prepared_commit === candidate.prepared_commit);
  capacity.operation = operation;
  // Commit the intent BEFORE entering the caller's effect. A crash thereafter
  // leaves pending, which prevents a second invocation through this same seam.
  let current = (await checkpointReleaseOpportunity(repository, expected, input)).checkpoint;
  let durableCheckpoint: string | null = null;
  let remoteFailure: unknown = null;
  let remoteFailed = false;
  const publish = async () => {
    if (!remote) return;
    try {
      await publishCoordinatorCheckpoint(repository, current, remote.configuration, {
        api: remote.api,
      });
      durableCheckpoint = current;
    } catch (error) {
      remoteFailed = true;
      remoteFailure = error;
      throw error;
    }
  };
  const save = async () => {
    current = (await checkpointReleaseOpportunity(repository, current, input)).checkpoint;
    await publish();
  };
  let acceptingReceipts = true;
  let receiptFailure: Error | undefined;
  let receipts = Promise.resolve();
  const recordCompleted = (remoteIdentity: string, evidenceSha256: string) => {
    if (!acceptingReceipts) return Promise.reject(new Error("capacity receipt window closed"));
    const task = receipts.then(async () => {
      if (receiptFailure) throw receiptFailure;
      const prospective = {
        ...operation,
        completed_effects: [
          ...operation.completed_effects,
          { remote_identity: remoteIdentity, evidence_sha256: evidenceSha256 },
        ],
      };
      inspectCapacityOperation(prospective);
      operation.completed_effects = prospective.completed_effects;
      await save();
    });
    receipts = task.catch((error: unknown) => {
      receiptFailure = error instanceof Error ? error : new Error("capacity receipt write failed");
    });
    return task;
  };
  try {
    // An explicitly configured remote transport must confirm the pending intent
    // before any provider effect. No fallback to local-only execution is allowed.
    // This does not establish the independently required exclusive executor.
    await publish();
    const fresh = assessBoundedCapacity({
      ...capacity,
      boundary: structuredClone(await readBoundary()),
      operation: ready.operation,
    });
    if (fresh.eligibility !== "eligible")
      throw new ProviderCapacityRefusal("local-pre-effect-boundary-refusal", capacityDigest(fresh));
    // The awaited boundary read may have allowed recovery, pause or another
    // writer to advance the journal. Verify the exact pending ownership again.
    // Live activation additionally requires its existing exclusive executor and
    // remote-durability boundary; this local seam does not install that authority.
    const owned = await recoverReleaseOpportunity(repository, current);
    if (capacityDigest(owned.input) !== capacityDigest(input))
      throw new Error("capacity pending ownership changed");
    await effect(recordCompleted);
    acceptingReceipts = false;
    await receipts;
    if (receiptFailure) throw receiptFailure;
    // No generic function return is treated as an actual remote success.
    if (operation.completed_effects.length === 0)
      throw new Error("exact provider result evidence missing");
    if (remote) {
      // Completed effects remain durably pending until the existing explicit
      // readback/recovery closes the handoff. Do not write a locally immutable
      // terminal outcome before its remote handoff can be confirmed.
      await publish();
    } else {
      operation.outcome = "succeeded";
      await save();
    }
    return {
      checkpoint: current,
      operation: structuredClone(operation),
      durable_checkpoint: durableCheckpoint,
      completion: remote ? "readback-required" : "recorded",
      availability: "unknown",
      headroom: "unknown",
      authority: "none",
    };
  } catch (error) {
    acceptingReceipts = false;
    await receipts;
    // A failed response or failed receipt write never proves no remote effect.
    // Preserve the last durable pending checkpoint if outcome CAS also fails.
    operation.outcome = error instanceof ProviderCapacityRefusal ? "capacity-refused" : "ambiguous";
    operation.failure_evidence = error instanceof ProviderCapacityRefusal ? error.receipt : null;
    try {
      current = (await checkpointReleaseOpportunity(repository, current, input)).checkpoint;
      // A lost/refused checkpoint response requires explicit readback/recovery.
      // Do not post another checkpoint after an ambiguous transport outcome.
      if (!remoteFailed) await publish();
    } catch {
      /* existing pending intent remains blocking */
    }
    throw new CoordinatorRemoteError(
      "bounded capacity operation stopped; recover and read back before any later attempt",
      {
        checkpoint: current,
        operation: structuredClone(operation),
        retry: "forbidden",
        reservation: structuredClone(candidate),
        durable_checkpoint: durableCheckpoint,
        checkpoint_transport_error: remoteFailed
          ? remoteFailure instanceof CoordinatorRemoteError
            ? remoteFailure.evidence
            : sanitizeOperationError(remoteFailure)
          : null,
        authority: "none",
      },
    );
  }
}

/** Only after the existing provider readback/recovery has resolved this exact
 * identity may its admitted caller record that result. Persistence validates
 * association and preservation; it does not authenticate caller-supplied proof.
 */
export async function recordCapacityReadback(
  repository: string,
  expected: string,
  resolution: "effect-completed" | "effect-not-applied" | "partial-effects-retained",
  evidenceSha256: string,
) {
  const recovered = await recoverReleaseOpportunity(repository, expected);
  const input = structuredClone(recovered.input);
  if (
    input.schema_version !== 2 ||
    !isRecord(input.controller) ||
    !isRecord(input.controller.capacity_attempt)
  )
    throw new Error("bounded capacity state unavailable");
  const capacity = input.controller.capacity_attempt;
  const operation = inspectCapacityOperation(capacity.operation);
  if (!operation || ["succeeded", "recovered"].includes(operation.outcome))
    throw new Error("no unresolved capacity operation");
  capacity.operation = {
    ...operation,
    outcome: "recovered",
    recovery: { checkpoint: expected, evidence_sha256: evidenceSha256, resolution },
  };
  return checkpointReleaseOpportunity(repository, expected, input);
}
