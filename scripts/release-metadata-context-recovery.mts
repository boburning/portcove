import {
  inspectCompleteRunArtifactInventory,
  readCompleteRunArtifactInventoryAsync,
} from "./release-run-artifact-inventory.mts";
/** Bounded renewal-context reconciliation. Journal receipts, public artifacts
 * and completed producer identity remain separate from current controls. */
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectCapacityOperation, inspectCompactCapacityOperations } from "./release-capacity.mts";
import {
  fixedReleaseReaderToken,
  readOnlyReleaseChildEnvironment,
} from "./release-readonly-child-environment.mts";
import { readRetainedCapacityOperation } from "./release-coordinator-state.mts";
import {
  readRemoteCoordinatorSnapshot,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import {
  coordinatorCommandDeadline,
  withCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import {
  requireCoordinatorSigningContext,
  readPreparedCoordinatorSigningContext,
  readCoordinatorSigningContextFiles,
} from "./release-metadata-signing-context.mts";
import {
  inspectSigningContextArchive,
  receiveMetadataSigningContextArtifact,
  requireReceivedSigningContext,
  acquireSigningContextArchive,
  signingContextArchiveLimits,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { retainedApplicationContextUpload as retainedUnattemptedUpload } from "./release-coordinator-checkpoint-authentication.mts";
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function metadataDestination(descriptor: unknown) {
  return `github-actions:boburning/portcove:metadata-${isRecord(descriptor) && descriptor.kind === "application-tuf-initial-bootstrap" ? "bootstrap" : "renewal"}-context`;
}
type Context = Awaited<ReturnType<typeof requireCoordinatorSigningContext>>;
type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;

const retainedUnattemptedEvidence = digest(retainedUnattemptedUpload);

function matchesRetainedUnattemptedUpload(operation: Operation) {
  const pin = retainedUnattemptedUpload;
  const executor = operation.executor_identity;
  return (
    operation.id === pin.operation_id &&
    operation.before_checkpoint === pin.previous &&
    operation.kind === "upload" &&
    operation.destination === "github-actions:boburning/portcove:metadata-renewal-context" &&
    operation.completed_effects.length === 0 &&
    operation.metadata_renewal?.transient_retries === 0 &&
    operation.metadata_renewal.substantive_repairs === 0 &&
    executor?.role === "coordinator" &&
    executor.actor_id === "41898282" &&
    executor.workflow === productionControllerWorkflow &&
    executor.check_run_id === String(pin.job_id) &&
    executor.controller_revision === pin.revision &&
    executor.execution_ref === pin.ref &&
    executor.run_id === pin.run_id &&
    executor.run_attempt === 1 &&
    executor.job_id === pin.job_id
  );
}

function settledRetainedUnattemptedUpload(operation: Operation) {
  return (
    matchesRetainedUnattemptedUpload(operation) &&
    operation.outcome === "recovered" &&
    operation.recovery?.resolution === "effect-not-applied" &&
    operation.recovery.checkpoint === retainedUnattemptedUpload.checkpoint &&
    operation.recovery.evidence_sha256 === retainedUnattemptedEvidence &&
    isRecord(operation.recovery.executor_identity) &&
    operation.recovery.executor_identity.role === "coordinator" &&
    operation.recovery.executor_identity.execution_ref === retainedUnattemptedUpload.successor_ref
  );
}
function originalProducer(operation: Operation) {
  const raw = operation.executor_identity;
  if (!raw) throw new Error("metadata context original executor missing");
  return {
    controller_revision: String(raw.controller_revision),
    execution_ref: String(raw.execution_ref),
    workflow: String(raw.workflow),
    run_id: String(raw.run_id),
    run_attempt: Number(raw.run_attempt),
    job_id: Number(raw.job_id),
    check_run_id: String(raw.check_run_id),
  };
}
const filesIdentity = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));

/** Data-only comparison. The old checkpoint is historical lineage; every
 * other prepared fact and every retained public byte must still be exact. */
export function inspectRecoveredMetadataContextBinding(
  original: { facts: unknown; binding: unknown; files: ReadonlyMap<string, Buffer> },
  current: { facts: unknown; binding: unknown; files: ReadonlyMap<string, Buffer> },
  beforeCheckpoint: string,
) {
  if (
    !isRecord(original.facts) ||
    !isRecord(current.facts) ||
    !/^[a-f0-9]{40}$/u.test(beforeCheckpoint) ||
    original.facts.checkpoint !== beforeCheckpoint ||
    digest({ ...original.facts, checkpoint: null }) !==
      digest({ ...current.facts, checkpoint: null }) ||
    digest(original.binding) !== digest(current.binding) ||
    digest(filesIdentity(original.files)) !== digest(filesIdentity(current.files))
  )
    throw new Error("metadata retry does not match genuine current Tough context");
  return { authority: "none" as const };
}

/** Data integrity only; callers cannot turn this projection into an executor. */
export function inspectMetadataContextRetryOperation(raw: unknown, descriptor: unknown) {
  const operation = inspectCapacityOperation(raw);
  const bootstrap = isRecord(descriptor) && descriptor.kind === "application-tuf-initial-bootstrap";
  if (
    !operation ||
    operation.kind !== "upload" ||
    operation.destination !== metadataDestination(descriptor) ||
    (bootstrap
      ? operation.metadata_bootstrap?.descriptor_sha256
      : operation.metadata_renewal?.descriptor_sha256) !== digest(descriptor) ||
    !operation.executor_identity ||
    operation.executor_identity.role !== "coordinator" ||
    (!settledRetainedUnattemptedUpload(operation) && !hasSettledContextArtifact(operation))
  )
    throw new Error("metadata context retry requires one exact settled upload");
  return operation;
}

function hasSettledContextArtifact(operation: Operation) {
  return (
    ["succeeded", "recovered"].includes(operation.outcome) &&
    (operation.outcome !== "recovered" || operation.recovery?.resolution === "effect-completed") &&
    operation.completed_effects.length === 1 &&
    /^github-actions:boburning\/portcove:artifact:[1-9][0-9]{0,15}$/u.test(
      operation.completed_effects[0]!.remote_identity,
    )
  );
}

/** Integrity only. An unresolved upload can be read back, never retried, by
 * the separately authenticated coordinator recovery boundary. */
export function inspectPendingMetadataContextUpload(raw: unknown, descriptor: unknown) {
  const operation = inspectCapacityOperation(raw);
  const bootstrap = isRecord(descriptor) && descriptor.kind === "application-tuf-initial-bootstrap";
  if (
    !operation ||
    operation.kind !== "upload" ||
    operation.destination !== metadataDestination(descriptor) ||
    (bootstrap
      ? operation.metadata_bootstrap?.descriptor_sha256
      : operation.metadata_renewal?.descriptor_sha256) !== digest(descriptor) ||
    !operation.executor_identity ||
    operation.executor_identity.role !== "coordinator" ||
    !["pending", "ambiguous"].includes(operation.outcome) ||
    operation.completed_effects.length > 1
  )
    throw new Error("one exact unresolved metadata context upload required");
  return operation;
}

async function priorOperation(context: Context, raw: unknown) {
  if (!isRecord(raw) || !isRecord(raw.controller) || !isRecord(raw.controller.capacity_attempt))
    throw new Error("metadata context journal capacity unavailable");
  const capacity = raw.controller.capacity_attempt;
  const destination = metadataDestination(context.descriptor),
    bootstrap = context.descriptor.kind === "application-tuf-initial-bootstrap",
    subject = bootstrap ? digest(context.descriptor) : context.descriptor.prior_repository_sha256;
  const operations = new Map<string, Operation>();
  const current = inspectCapacityOperation(capacity.operation);
  if (
    current?.destination === destination &&
    (bootstrap
      ? current.metadata_bootstrap?.descriptor_sha256
      : current.metadata_renewal?.descriptor_sha256) === digest(context.descriptor)
  )
    operations.set(current.id, inspectMetadataContextRetryOperation(current, context.descriptor));
  for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
    if (
      group.subject.kind !== (bootstrap ? "metadata-bootstrap" : "metadata-renewal") ||
      group.subject.identity !== subject ||
      group.kind !== "upload" ||
      group.destination_sha256 !== digest(destination)
    )
      continue;
    for (const proof of group.attempts) {
      // Recovery imports only the current and one previous checkpoint. An old
      // compact receipt needs its independently pinned three-object closure.
      const rawOperation = await readMetadataContextRetryReceipt(
        context.coordinator_repository,
        proof,
      );
      const operation = inspectMetadataContextRetryOperation(rawOperation, context.descriptor);
      operations.set(operation.id, operation);
    }
  }
  return [...operations.values()].sort((a, b) => b.sequence - a.sequence)[0];
}

/** Raw receipt custody only. Hydration verifies the named commit/tree/blob and
 * operation digest; it creates no refs, execution grant or acceptance brand. */
export async function readMetadataContextRetryReceipt(repository: string, proof: unknown) {
  try {
    return readRetainedCapacityOperation(repository, proof);
  } catch {
    const environment = readOnlyReleaseChildEnvironment() ?? process.env;
    const provider = await createReleaseCustodyProvider({
      token: environment.GH_TOKEN ?? "",
      deadline: coordinatorCommandDeadline() ?? performance.now() + 45000,
      maxBytes: 256 * 1024,
    });
    return hydrateRetainedCoordinatorOperation(repository, proof, { provider });
  }
}

/** Complete terminal provider inventory only. A 404, partial list, active run
 * or unavailable transport is never evidence that an attestation is absent. */
export function inspectMetadataContextRetryProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawArtifacts: unknown,
  operation: Operation,
  controller: Context["tools"]["identity"],
) {
  if (operation.completed_effects.length !== 1)
    throw new Error("metadata retry provider requires its settled upload receipt");
  return inspectMetadataContextProvider(
    rawRun,
    rawAttempt,
    rawJob,
    rawArtifacts,
    operation,
    controller,
  );
}

/** Pending readback still requires the original numeric terminal producer and
 * complete immutable inventory. Absence/expiry never proves non-application. */
export function inspectPendingMetadataContextProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawArtifacts: unknown,
  rawOperation: unknown,
  descriptor: unknown,
  controller: Context["tools"]["identity"],
) {
  const operation = inspectPendingMetadataContextUpload(rawOperation, descriptor);
  const selected = inspectMetadataContextProvider(
    rawRun,
    rawAttempt,
    rawJob,
    rawArtifacts,
    operation,
    controller,
  );
  if (!selected.artifact || selected.artifact.expired)
    throw new Error("unresolved metadata upload lacks positive immutable artifact readback");
  return selected;
}

function inspectMetadataContextProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawArtifacts: unknown,
  operation: Operation,
  controller: Pick<Context["tools"]["identity"], "controller_revision" | "controller_ref">,
) {
  const producer = originalProducer(operation);
  if (
    producer.controller_revision !== controller.controller_revision ||
    producer.execution_ref !== controller.controller_ref ||
    producer.workflow !== productionControllerWorkflow ||
    producer.run_attempt !== 1
  )
    throw new Error("metadata retry original producer source differs");
  for (const run of [rawRun, rawAttempt]) {
    if (
      !isRecord(run) ||
      String(run.id) !== producer.run_id ||
      run.run_attempt !== 1 ||
      run.head_sha !== producer.controller_revision ||
      run.path !== productionControllerWorkflow ||
      run.event !== "workflow_dispatch" ||
      run.status !== "completed" ||
      ![
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "neutral",
        "skipped",
        "stale",
        "startup_failure",
      ].includes(String(run.conclusion)) ||
      !isRecord(run.repository) ||
      run.repository.id !== 1354613114 ||
      run.repository.full_name !== "boburning/portcove" ||
      !isRecord(run.head_repository) ||
      run.head_repository.id !== 1354613114
    )
      throw new Error("metadata retry original run is incomplete or still active");
  }
  if (
    !isRecord(rawJob) ||
    rawJob.id !== producer.job_id ||
    String(rawJob.run_id) !== producer.run_id ||
    rawJob.run_attempt !== 1 ||
    rawJob.head_sha !== producer.controller_revision ||
    rawJob.name !== "Coordinate application release" ||
    rawJob.status !== "completed" ||
    !["success", "failure", "cancelled", "timed_out", "skipped"].includes(
      String(rawJob.conclusion),
    ) ||
    rawJob.check_run_url !==
      `https://api.github.com/repos/boburning/portcove/check-runs/${producer.check_run_id}`
  )
    throw new Error("metadata retry original numeric producer differs or is active");
  const rows = inspectCompleteRunArtifactInventory(rawArtifacts).artifacts;
  const prefix = `trusted-coordinator-signing-context`,
    selected = [false, true].map((bundle) => {
      const name = `${prefix}${bundle ? "-attestation" : ""}-${producer.run_id}-1`;
      const matches: unknown[] = rows.filter((row: unknown) => isRecord(row) && row.name === name);
      if (matches.length > 1) throw new Error("metadata retry artifact name is ambiguous");
      const row = matches[0];
      if (row === undefined) return null;
      if (
        !isRecord(row) ||
        typeof row.id !== "number" ||
        typeof row.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
        typeof row.expired !== "boolean" ||
        typeof row.size_in_bytes !== "number" ||
        !Number.isSafeInteger(row.size_in_bytes) ||
        row.size_in_bytes < 22 ||
        row.size_in_bytes >
          (bundle ? 4 * 1024 ** 2 : signingContextArchiveLimits.compressedBytes) ||
        !isRecord(row.workflow_run) ||
        String(row.workflow_run.id) !== producer.run_id ||
        row.workflow_run.repository_id !== 1354613114 ||
        row.workflow_run.head_repository_id !== 1354613114 ||
        row.workflow_run.head_sha !== producer.controller_revision
      )
        throw new Error("metadata retry artifact source or byte identity differs");
      return {
        id: row.id,
        sha256: row.digest.slice(7),
        bytes: row.size_in_bytes,
        expired: row.expired,
      };
    });
  const [artifact, bundle] = selected;
  if (
    artifact &&
    operation.completed_effects.length > 0 &&
    operation.completed_effects[0]!.remote_identity !==
      `github-actions:boburning/portcove:artifact:${artifact.id}`
  )
    throw new Error("metadata retry artifact is not the settled upload");
  return {
    producer,
    producer_success: rawJob.conclusion === "success",
    artifact: artifact ?? null,
    bundle: bundle ?? null,
    authority: "none" as const,
  };
}

function metadataReadbackProvider(token: string, deadline: number, limitError: string) {
  // Two complete metadata observations share fourteen reads. The opaque archive has its own single lookup.
  let reads = 0;
  return createReleaseCustodyProvider({
    token,
    deadline,
    chargeRead() {
      if (++reads > 14) throw new Error(limitError);
      signingContextRemaining(deadline, 15000);
    },
  });
}

async function readMetadataProviderSnapshot(
  provider: Awaited<ReturnType<typeof metadataReadbackProvider>>,
  producer: ReturnType<typeof originalProducer>,
  deadline: number,
) {
  const raw = {
    run: await provider.run(producer.run_id),
    attempt: await provider.attempt(producer.run_id, 1),
    job: await provider.job(producer.job_id),
    artifacts: await readCompleteRunArtifactInventoryAsync((page) =>
      provider.runArtifacts(producer.run_id, page),
    ),
  };
  signingContextRemaining(deadline, 15000);
  return raw;
}

/** Reobserve the original terminal attempt and exact reviewed diagnostics. The
 * returned data has no write authority. Only the existing signed recovery CAS
 * can settle the pending operation, and it must retain the original intent. */
export async function readRetainedUnattemptedMetadataUpload(
  checkpoint: string,
  rawOperation: unknown,
  descriptor: unknown,
  directory: string,
  deadline: number,
) {
  const pin = retainedUnattemptedUpload;
  if (checkpoint !== pin.checkpoint) return;
  const operation = inspectPendingMetadataContextUpload(rawOperation, descriptor);
  if (!matchesRetainedUnattemptedUpload(operation))
    throw new Error("retained unattempted upload identity differs");
  const producer = originalProducer(operation);
  const token = fixedReleaseReaderToken();
  const provider = await metadataReadbackProvider(
    token,
    deadline,
    "unattempted upload read limit exhausted",
  );
  const before = await readMetadataProviderSnapshot(provider, producer, deadline);
  const selected = inspectMetadataContextProvider(
    before.run,
    before.attempt,
    before.job,
    before.artifacts,
    operation,
    { controller_revision: pin.revision, controller_ref: pin.ref },
  );
  const rows = inspectCompleteRunArtifactInventory(before.artifacts).artifacts;
  const diagnostics = rows.filter(
    (row) =>
      isRecord(row) && row.name === `trusted-controller-diagnostics-coordinator-${pin.run_id}-1`,
  );
  const row = diagnostics[0];
  if (
    selected.artifact ||
    selected.bundle ||
    ![before.run, before.attempt].every(
      (run) =>
        isRecord(run) &&
        run.conclusion === "failure" &&
        run.head_branch === pin.ref.slice(10) &&
        isRecord(run.actor) &&
        run.actor.id === 41898282 &&
        isRecord(run.triggering_actor) &&
        run.triggering_actor.id === 41898282,
    ) ||
    !isRecord(before.job) ||
    before.job.conclusion !== "failure" ||
    diagnostics.length !== 1 ||
    !isRecord(row) ||
    row.id !== pin.diagnostics_id ||
    row.expired !== false ||
    row.size_in_bytes !== pin.diagnostics_bytes ||
    row.digest !== `sha256:${pin.diagnostics_sha256}` ||
    !isRecord(row.workflow_run) ||
    String(row.workflow_run.id) !== pin.run_id ||
    row.workflow_run.repository_id !== 1354613114 ||
    row.workflow_run.head_repository_id !== 1354613114 ||
    row.workflow_run.head_sha !== pin.revision ||
    row.workflow_run.head_branch !== pin.ref.slice(10)
  )
    throw new Error("retained unattempted upload diagnostics differ");
  const archive = await acquireSigningContextArchive(
    directory,
    {
      id: pin.diagnostics_id,
      bytes: pin.diagnostics_bytes,
      sha256: pin.diagnostics_sha256,
    },
    { token, deadline },
  );
  const after = await readMetadataProviderSnapshot(provider, producer, deadline);
  if (digest(before) !== digest(after))
    throw new Error("retained unattempted upload provider inventory changed");
  await writeFile(path.join(directory, "original-upload-diagnostics.zip"), archive, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(directory, "original-upload-provider.json"), JSON.stringify(before), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    resolution: "effect-not-applied" as const,
    evidence_sha256: retainedUnattemptedEvidence,
  };
}

/** Public custody readback only. The fixed coordinator must independently
 * derive `current` from its actual tools, ratified anchors and Tough prior;
 * only its existing authenticated recovery executor may settle the result. */
export async function readPendingMetadataContextUpload(
  rawOperation: unknown,
  descriptor: unknown,
  current: {
    controller: Context["tools"]["identity"];
    facts: unknown;
    binding: unknown;
    files: ReadonlyMap<string, Buffer>;
  },
  parent: string,
  deadline: number,
) {
  signingContextRemaining(deadline, 15000);
  const operation = inspectPendingMetadataContextUpload(rawOperation, descriptor),
    producer = originalProducer(operation),
    directory = await mkdtemp(path.join(parent, "pending-context-readback-"));
  const snapshot = async (provider: Awaited<ReturnType<typeof metadataReadbackProvider>>) => {
    const raw = await readMetadataProviderSnapshot(provider, producer, deadline);
    return {
      raw,
      selected: inspectPendingMetadataContextProvider(
        raw.run,
        raw.attempt,
        raw.job,
        raw.artifacts,
        operation,
        descriptor,
        current.controller,
      ),
    };
  };
  let phase = "terminal-original-provider";
  try {
    const token = fixedReleaseReaderToken();
    const provider = await metadataReadbackProvider(
      token,
      deadline,
      "pending metadata readback limit exhausted",
    );
    const before = await snapshot(provider),
      artifact = before.selected.artifact!;
    await writeFile(path.join(directory, "provider-before.json"), JSON.stringify(before.raw), {
      flag: "wx",
      mode: 0o600,
    });
    phase = "opaque-public-context";
    const archive = await acquireSigningContextArchive(directory, artifact, {
      token,
      deadline,
    });
    signingContextRemaining(deadline, 15000);
    await writeFile(path.join(directory, "original-context.zip"), archive, {
      flag: "wx",
      mode: 0o600,
    });
    const inspected = inspectSigningContextArchive(archive);
    if (
      inspected.manifest.kind !== "metadata-signing-context" ||
      digest(inspected.manifest.controller) !==
        digest({
          controller_revision: producer.controller_revision,
          source_tree: current.controller.source_tree,
          controller_ref: producer.execution_ref,
          run_id: producer.run_id,
          run_attempt: producer.run_attempt,
        })
    )
      throw new Error("pending metadata manifest producer differs");
    inspectRecoveredMetadataContextBinding(
      {
        facts: inspected.manifest.facts,
        binding: inspected.manifest.binding,
        files: inspected.files,
      },
      current,
      operation.before_checkpoint,
    );
    // This is the original upload's deterministic public receipt identity, not
    // an attestation or signing admission. A failed producer may lack a bundle.
    const predicate = {
      schema_version: 1,
      role: "metadata-signing-context",
      controller: inspected.manifest.controller,
      producer: {
        run_id: producer.run_id,
        run_attempt: producer.run_attempt,
        job_id: producer.job_id,
        check_run_id: producer.check_run_id,
      },
      artifact: { id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 },
      manifest_sha256: inspected.manifest_sha256,
      binding: inspected.manifest.binding,
      facts_sha256: inspected.manifest.facts_sha256,
      stage: "coordinator",
      publication_admission: "not-established",
      authority: "none",
    };
    const completed_effect = {
      remote_identity: `github-actions:boburning/portcove:artifact:${artifact.id}`,
      evidence_sha256: digest(predicate),
    };
    if (
      operation.completed_effects.length &&
      digest(operation.completed_effects[0]) !== digest(completed_effect)
    )
      throw new Error("pending metadata partial receipt differs from exact readback");
    phase = "terminal-provider-after";
    const after = await snapshot(provider);
    if (digest(before.raw) !== digest(after.raw))
      throw new Error("pending metadata provider changed");
    await writeFile(path.join(directory, "provider-after.json"), JSON.stringify(after.raw), {
      flag: "wx",
      mode: 0o600,
    });
    const evidence = {
      operation_id: operation.id,
      original_executor: producer,
      artifact,
      manifest_sha256: inspected.manifest_sha256,
      completed_effect,
      attestation: "not-established",
      authority: "none",
    };
    await writeFile(path.join(directory, "readback.json"), JSON.stringify(evidence), {
      flag: "wx",
      mode: 0o600,
    });
    signingContextRemaining(deadline, 15000);
    return {
      resolution: "effect-completed" as const,
      completed_effect,
      evidence_sha256: digest(evidence),
      directory,
      authority: "none" as const,
    };
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error("pending context readback refused; retain original artifact and intent");
  }
}

export async function reconcileCoordinatorSigningContext(actualContext: object, parent: string) {
  const context = await readPreparedCoordinatorSigningContext(actualContext);
  return withCoordinatorDeadline(context.deadline, () =>
    reconcileAt(actualContext, context, parent),
  );
}
async function reconcileAt(actualContext: object, context: Context, parent: string) {
  const deadline = context.deadline;
  const state = await readRemoteCoordinatorSnapshot(
    parent,
    { schema_version: 1, namespace: context.namespace },
    {
      transport: {
        credential: { token: (readOnlyReleaseChildEnvironment() ?? process.env).GH_TOKEN ?? "" },
        deadline,
      },
    },
  );
  if (state.checkpoint !== context.checkpoint) throw new Error("metadata retry checkpoint changed");
  const operation = await priorOperation(context, state.input);
  if (!operation) return { decision: "new" as const };
  if (settledRetainedUnattemptedUpload(operation))
    return { decision: "transient-recovery" as const, recovery: "transient" as const };
  const directory = await mkdtemp(path.join(parent, "metadata-context-recovery-"));
  const producer = originalProducer(operation);
  const snapshot = async (provider: Awaited<ReturnType<typeof metadataReadbackProvider>>) => {
    const raw = await readMetadataProviderSnapshot(provider, producer, deadline);
    return {
      raw,
      selected: inspectMetadataContextRetryProvider(
        raw.run,
        raw.attempt,
        raw.job,
        raw.artifacts,
        operation,
        context.tools.identity,
      ),
    };
  };
  let phase = "terminal-original-provider";
  try {
    const token = fixedReleaseReaderToken();
    const provider = await metadataReadbackProvider(
      token,
      deadline,
      "metadata retry read limit exhausted",
    );
    const before = await snapshot(provider);
    await writeFile(path.join(directory, "provider-before.json"), JSON.stringify(before.raw), {
      flag: "wx",
      mode: 0o600,
    });
    const { artifact, bundle } = before.selected;
    let reused: object | undefined;
    let expected: Parameters<typeof receiveMetadataSigningContextArtifact>[1] | undefined;
    if (
      before.selected.producer_success &&
      artifact &&
      bundle &&
      !artifact.expired &&
      !bundle.expired
    ) {
      phase = "original-opaque-context";
      const archive = await acquireSigningContextArchive(directory, artifact, {
        token,
        deadline,
      });
      signingContextRemaining(deadline, 15000);
      await writeFile(path.join(directory, "original-context.zip"), archive, {
        flag: "wx",
        mode: 0o600,
      });
      const inspected = inspectSigningContextArchive(archive),
        currentFiles = await readCoordinatorSigningContextFiles(actualContext);
      if (inspected.manifest.kind !== "metadata-signing-context")
        throw new Error("metadata retry cannot reuse a release context");
      inspectRecoveredMetadataContextBinding(
        {
          facts: inspected.manifest.facts,
          binding: inspected.manifest.binding,
          files: inspected.files,
        },
        { facts: context.facts, binding: context.binding, files: currentFiles },
        operation.before_checkpoint,
      );
      expected = {
        controller_revision: producer.controller_revision,
        source_tree: context.tools.identity.source_tree,
        controller_ref: producer.execution_ref,
        run_id: producer.run_id,
        run_attempt: 1,
        artifact: { id: artifact.id, sha256: artifact.sha256 },
        bundle: { id: bundle.id, sha256: bundle.sha256 },
        manifest_sha256: inspected.manifest_sha256,
        binding_sha256: digest(context.binding),
        facts_sha256: String(inspected.manifest.facts_sha256),
      };
      phase = "original-authenticated-context";
      reused = await receiveMetadataSigningContextArtifact(directory, expected, deadline);
      const actual = await requireReceivedSigningContext(reused, deadline);
      const statement: unknown = JSON.parse(
        (
          await readControllerToolFile(
            path.join(actual.directory, "verified-statement.json"),
            1024 * 1024,
          )
        ).toString("utf8"),
      );
      if (
        !isRecord(statement) ||
        digest(statement.predicate) !== operation.completed_effects[0]!.evidence_sha256
      )
        throw new Error("metadata retry attestation differs from settled receipt");
    }
    phase = "terminal-provider-after";
    const after = await snapshot(provider);
    if (digest(before.raw) !== digest(after.raw))
      throw new Error("metadata retry provider inventory changed");
    await writeFile(path.join(directory, "provider-after.json"), JSON.stringify(after.raw), {
      flag: "wx",
      mode: 0o600,
    });
    await requireCoordinatorSigningContext(actualContext, deadline);
    signingContextRemaining(deadline, 15000);
    const evidence = {
      operation_id: operation.id,
      original_executor: producer,
      directory,
      authority: "none" as const,
    };
    if (reused && expected)
      return {
        ...evidence,
        decision: "reused" as const,
        received_context: reused,
        locator: expected,
      };
    // The old upload is settled and its exact run/job/list are terminal and
    // bracketed. A missing/expired bundle or failed producing job may consume
    // the existing transient counter; no read error reaches this branch.
    return { ...evidence, decision: "transient-recovery" as const, recovery: "transient" as const };
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(
      "metadata context recovery refused; retain provider and original context evidence",
    );
  }
}
