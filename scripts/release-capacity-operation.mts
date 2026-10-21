import {
  inspectAggregateUploadExpectation,
  assertAggregateUploadCandidate,
} from "./release-aggregate-contract.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import {
  assessBoundedCapacity,
  capacityDigest,
  inspectCapacityOperation,
  inspectPriorCapacityOperations,
  inspectCompactCapacityOperations,
  expectedCompactCapacityOperations,
  capacityOperationSubject,
  capacityOperationCounters,
  inspectCapacityExecutorIdentity,
  inspectSitePublicationExpectation,
  assertPublicationResultDestination,
} from "./release-capacity.mts";
import {
  inspectMetadataRenewalDescriptor,
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
  inspectMetadataBootstrapDescriptor,
  assertMetadataBootstrapBinding,
} from "./release-metadata-contract.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";
import { sanitizeOperationError } from "./github-api.mts";
import { randomBytes } from "node:crypto";

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
type Request = {
  kind: "dispatch" | "upload" | "retention";
  destination: string;
  site_expectation?: unknown;
  aggregate_expectation?: unknown;
};
export interface CapacityOperationOptions {
  remote?: { configuration: unknown; api: CoordinatorRemoteApi };
  executorIdentity?: unknown;
  maximumReceipts?: number;
}
type PendingEffect = {
  checkpoint: string;
  operation: NonNullable<ReturnType<typeof inspectCapacityOperation>>;
};
type Effect = (
  recordCompleted: (remoteIdentity: string, evidenceSha256: string) => Promise<void>,
  pending: PendingEffect,
) => Promise<void>;
type InternalOptions = CapacityOperationOptions & {
  metadataRenewal?: unknown;
  metadataBootstrap?: unknown;
  metadataRecovery?: "transient" | "substantive-repair";
};
export async function runBoundedCapacityOperation(
  repository: string,
  expected: string,
  request: Request,
  readBoundary: () => Promise<unknown>,
  effect: Effect,
  options: CapacityOperationOptions = {},
) {
  return runOperation(repository, expected, request, readBoundary, effect, options);
}
export async function runBoundedMetadataRenewalOperation(
  repository: string,
  expected: string,
  descriptor: unknown,
  request: Request,
  readBoundary: () => Promise<unknown>,
  effect: Effect,
  options: CapacityOperationOptions & { recovery?: "transient" | "substantive-repair" } = {},
) {
  return runOperation(repository, expected, request, readBoundary, effect, {
    ...options,
    metadataRenewal: descriptor,
    ...(options.recovery ? { metadataRecovery: options.recovery } : {}),
  });
}
export async function runBoundedMetadataBootstrapOperation(
  repository: string,
  expected: string,
  descriptor: unknown,
  request: Request,
  readBoundary: () => Promise<unknown>,
  effect: Effect,
  options: CapacityOperationOptions & { recovery?: "transient" | "substantive-repair" } = {},
) {
  return runOperation(repository, expected, request, readBoundary, effect, {
    ...options,
    metadataBootstrap: descriptor,
    ...(options.recovery ? { metadataRecovery: options.recovery } : {}),
  });
}
function metadataNow() {
  const [base, fraction = ""] = new Date().toISOString().slice(0, -1).split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return `${base}${trimmed ? `.${trimmed}` : ""}Z`;
}
async function runOperation(
  repository: string,
  expected: string,
  rawRequest: Request,
  readBoundary: () => Promise<unknown>,
  effect: Effect,
  options: InternalOptions = {},
) {
  const request = structuredClone(rawRequest);
  if (
    Object.keys(request).sort().join(",") !==
    [
      "destination",
      "kind",
      ...(request.site_expectation === undefined ? [] : ["site_expectation"]),
      ...(request.aggregate_expectation === undefined ? [] : ["aggregate_expectation"]),
    ]
      .sort()
      .join(",")
  )
    throw new Error("capacity operation request contains unsupported fields");
  const aggregate =
    request.aggregate_expectation === undefined
      ? null
      : inspectAggregateUploadExpectation(request.aggregate_expectation);
  const site =
    request.site_expectation === undefined
      ? null
      : inspectSitePublicationExpectation(request.site_expectation);
  const metadata =
    options.metadataRenewal === undefined
      ? null
      : inspectMetadataRenewalDescriptor(structuredClone(options.metadataRenewal));
  const bootstrap =
    options.metadataBootstrap === undefined
      ? null
      : inspectMetadataBootstrapDescriptor(structuredClone(options.metadataBootstrap));
  if (metadata && bootstrap) throw new Error("one exact metadata subject required");
  const maintenance = metadata ?? bootstrap;
  const executor =
    options.executorIdentity === undefined
      ? null
      : inspectCapacityExecutorIdentity(structuredClone(options.executorIdentity));
  const metadataRecovery = options.metadataRecovery;
  const maximumReceipts = options.maximumReceipts ?? 32;
  if (!Number.isInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 32)
    throw new Error("bounded receipt limit invalid");
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
    (!maintenance && !isRecord(input.active_candidate))
  )
    throw new Error("bounded operation requires schema2 and an existing frozen reservation");
  const controller = input.controller,
    capacity = controller.capacity_attempt;
  if (!isRecord(capacity)) throw new Error("bounded capacity input unavailable");
  const modern = capacity.schema_version === 2;
  if (maintenance && !modern)
    throw new Error(
      "metadata effects require capacity schema2 and explicit authenticated published seed",
    );
  capacity.boundary = structuredClone(await readBoundary());
  const ready = assessBoundedCapacity(capacity);
  if (
    ready.eligibility !== "eligible" ||
    controller.publication_paused !== false ||
    (!maintenance && recovered.plan.action !== "resume-active")
  )
    throw new Error("bounded operation is held by capacity or another coordinator condition");
  if (request.destination === "github-actions:boburning/portcove:admitted-aggregate" && !aggregate)
    throw new Error("admitted aggregate intent requires its exact upload preimage");
  const candidate = isRecord(input.active_candidate) ? input.active_candidate : null;
  if (aggregate) assertAggregateUploadCandidate(candidate);
  assertPublicationResultDestination(request.destination, candidate);
  let metadataCounters = { transient_retries: 0, substantive_repairs: 0 };
  const observedAt = metadataNow();
  if (maintenance) {
    const subject = bootstrap
      ? { kind: "metadata-bootstrap", identity: capacityDigest(bootstrap) }
      : { kind: "metadata-renewal", identity: metadata!.prior_repository_sha256 };
    if (bootstrap) {
      assertMetadataBootstrapBinding(
        bootstrap,
        inspectPublishedMetadata(input.published_metadata),
        observedAt,
      );
      input.metadata_bootstrap = structuredClone(bootstrap);
    } else if (metadata) {
      assertMetadataRenewalBinding(
        metadata,
        inspectPublishedMetadata(input.published_metadata),
        observedAt,
      );
      input.metadata_renewal = structuredClone(metadata);
    }
    const groups = inspectCompactCapacityOperations(capacity.prior_operations).filter(
      (group) => group.subject.kind === subject.kind && group.subject.identity === subject.identity,
    );
    metadataCounters = {
      transient_retries: Math.max(0, ...groups.map((group) => group.transient_retries)),
      substantive_repairs: Math.max(0, ...groups.map((group) => group.substantive_repairs)),
    };
    let repeated = groups.some(
      (group) =>
        group.kind === request.kind &&
        group.destination_sha256 === capacityDigest(request.destination),
    );
    if (
      ready.operation &&
      capacityOperationSubject(ready.operation).kind === subject.kind &&
      capacityOperationSubject(ready.operation).identity === subject.identity
    ) {
      const counters = capacityOperationCounters(ready.operation);
      metadataCounters.transient_retries = Math.max(
        metadataCounters.transient_retries,
        counters.transient_retries,
      );
      metadataCounters.substantive_repairs = Math.max(
        metadataCounters.substantive_repairs,
        counters.substantive_repairs,
      );
      repeated ||=
        ready.operation.kind === request.kind &&
        ready.operation.destination === request.destination;
    }
    if (repeated) {
      if (!metadataRecovery)
        throw new Error("metadata retry requires explicit bounded recovery increment");
      if (metadataRecovery === "transient") metadataCounters.transient_retries++;
      else metadataCounters.substantive_repairs++;
    } else if (metadataRecovery !== undefined)
      throw new Error("metadata new effect cannot manufacture a recovery increment");
  }
  const identity = {
    before_checkpoint: expected,
    ...(bootstrap
      ? {
          metadata_bootstrap: {
            descriptor_sha256: capacityDigest(bootstrap),
            setup_plan_sha256: bootstrap.setup_plan_sha256,
            initial_site_preimage_sha256: bootstrap.initial_site_preimage_sha256,
            observed_at: observedAt,
            ...metadataCounters,
          },
        }
      : metadata
        ? {
            metadata_renewal: {
              descriptor_sha256: capacityDigest(metadata),
              prior_repository_sha256: metadata.prior_repository_sha256,
              observed_at: observedAt,
              ...metadataCounters,
            },
          }
        : {
            candidate: {
              source_commit: candidate?.source_commit,
              prepared_commit: candidate?.prepared_commit,
              version: candidate?.version,
              transient_retries: candidate?.transient_retries,
              substantive_repairs: candidate?.substantive_repairs,
            },
          }),
    destination: request.destination,
    ...(site ? { site_expectation: site } : {}),
    ...(aggregate ? { aggregate_expectation: aggregate } : {}),
    // An invocation-generated claim makes independent executors' pending bytes
    // distinct. Seeing somebody else's identical logical operation is not an
    // execution grant. There is no caller-supplied nonce or resume entry point.
    ...(remote ? { executor_nonce: randomBytes(32).toString("hex") } : {}),
    ...(executor ? { executor_identity: executor } : {}),
    ...(modern ? { receipt_limit: maximumReceipts } : {}),
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
  capacity.operation = operation;
  capacity.prior_operations = modern
    ? expectedCompactCapacityOperations(recovered.input, input, expected)
    : [
        ...inspectPriorCapacityOperations(capacity.prior_operations),
        ...(ready.operation ? [ready.operation] : []),
      ].filter(
        (prior) =>
          prior &&
          isRecord(prior.candidate) &&
          prior.candidate.prepared_commit === candidate?.prepared_commit,
      );
  if (modern) {
    const prospective = structuredClone(input);
    if (!isRecord(prospective.controller) || !isRecord(prospective.controller.capacity_attempt))
      throw new Error("capacity input unavailable");
    prospective.controller.capacity_attempt.operation = {
      ...operation,
      completed_effects: Array.from({ length: maximumReceipts }, (_, index) => ({
        remote_identity: `${String(index).padStart(2, "0")}${"x".repeat(510)}`,
        evidence_sha256: "f".repeat(64),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(prospective)) > 64 * 1024 - 1024)
      throw new Error("bounded receipt journal budget unavailable before effects");
  }
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
    if (bootstrap)
      assertMetadataBootstrapBinding(
        bootstrap,
        inspectPublishedMetadata(input.published_metadata),
        metadataNow(),
      );
    if (metadata)
      assertMetadataRenewalBinding(
        metadata,
        inspectPublishedMetadata(input.published_metadata),
        metadataNow(),
      );
    await effect(recordCompleted, {
      checkpoint: current,
      operation: structuredClone(inspectCapacityOperation(operation)!),
    });
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
  options: Pick<CapacityOperationOptions, "remote" | "executorIdentity"> & {
    /** Actual admitted provider readback only; never a request to repeat the effect. */
    completedEffect?: { remote_identity: string; evidence_sha256: string };
  } = {},
) {
  const completedEffect =
    options.completedEffect === undefined ? null : structuredClone(options.completedEffect);
  const recoveryExecutor =
    options.executorIdentity === undefined
      ? null
      : inspectCapacityExecutorIdentity(structuredClone(options.executorIdentity));
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
    !isRecord(input.controller.capacity_attempt)
  )
    throw new Error("bounded capacity state unavailable");
  const capacity = input.controller.capacity_attempt;
  const operation = inspectCapacityOperation(capacity.operation);
  if (!operation || ["succeeded", "recovered"].includes(operation.outcome))
    throw new Error("no unresolved capacity operation");
  if (completedEffect !== null) {
    if (resolution !== "effect-completed" || operation.receipt_limit !== 1)
      throw new Error("observed completed effect requires exact single-effect completion readback");
    if (
      operation.completed_effects.length !== 0 &&
      capacityDigest(operation.completed_effects) !== capacityDigest([completedEffect])
    )
      throw new Error("observed completed effect cannot replace the retained receipt");
    // The existing operation parser supplies the exact receipt shape/bounds.
    // Preserve the intent, nonce, failure and original executor identity.
    operation.completed_effects = [completedEffect];
    inspectCapacityOperation(operation);
  }
  capacity.operation = {
    ...operation,
    outcome: "recovered",
    recovery: {
      checkpoint: expected,
      evidence_sha256: evidenceSha256,
      resolution,
      ...(recoveryExecutor ? { executor_identity: recoveryExecutor } : {}),
    },
  };
  const result = await checkpointReleaseOpportunity(repository, expected, input);
  if (remote) {
    await publishCoordinatorCheckpoint(repository, result.checkpoint, remote.configuration, {
      api: remote.api,
    });
    return { ...result, durable_checkpoint: result.checkpoint };
  }
  return result;
}

/** Record only after the fixed admitted caller actually verifies the ratified
 * TUF root/current public component and independent exact public readback.
 * Initial seed is a separate explicitly granted setup/import, never automatic.
 */
export async function recordPublishedMetadata(
  repository: string,
  expected: string,
  raw: unknown,
  options: Pick<CapacityOperationOptions, "remote"> = {},
) {
  const published = inspectPublishedMetadata(structuredClone(raw));
  if (!published) throw new Error("published metadata result absent");
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
    !isRecord(input.controller.capacity_attempt)
  )
    throw new Error("published metadata requires existing bounded coordinator");
  const capacity = input.controller.capacity_attempt;
  capacity.schema_version = 2;
  input.published_metadata = structuredClone(published);
  capacity.prior_operations = expectedCompactCapacityOperations(recovered.input, input, expected);
  const result = await checkpointReleaseOpportunity(repository, expected, input);
  if (remote) {
    try {
      await publishCoordinatorCheckpoint(repository, result.checkpoint, remote.configuration, {
        api: remote.api,
      });
    } catch (error) {
      throw new CoordinatorRemoteError(
        "published metadata readback retained locally; remote journal handoff requires explicit recovery",
        {
          checkpoint: result.checkpoint,
          published_metadata: published,
          checkpoint_transport_error:
            error instanceof CoordinatorRemoteError
              ? error.evidence
              : sanitizeOperationError(error),
          retry: "forbidden",
          authority: "none",
        },
      );
    }
    return { ...result, durable_checkpoint: result.checkpoint };
  }
  return result;
}
