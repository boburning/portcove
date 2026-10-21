import {
  inspectCompleteRunArtifactInventory,
  readCompleteRunArtifactInventory,
} from "./release-run-artifact-inventory.mts";
/** Bounded renewal-context reconciliation. Journal receipts, public artifacts
 * and completed producer identity remain separate from current controls. */
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectCapacityOperation, inspectCompactCapacityOperations } from "./release-capacity.mts";
import { readRetainedCapacityOperation } from "./release-coordinator-state.mts";
import {
  readRemoteCoordinatorSnapshot,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  requireCoordinatorSigningContext,
  readCoordinatorSigningContextFiles,
} from "./release-metadata-signing-context.mts";
import {
  inspectSigningContextArchive,
  receiveMetadataSigningContextArtifact,
  requireReceivedSigningContext,
  signingContextArchiveLimits,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const destination = "github-actions:boburning/portcove:metadata-renewal-context";
type Context = Awaited<ReturnType<typeof requireCoordinatorSigningContext>>;
type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
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
  if (
    !operation ||
    operation.kind !== "upload" ||
    operation.destination !== destination ||
    operation.metadata_renewal?.descriptor_sha256 !== digest(descriptor) ||
    !operation.executor_identity ||
    operation.executor_identity.role !== "coordinator" ||
    !["succeeded", "recovered"].includes(operation.outcome) ||
    (operation.outcome === "recovered" && operation.recovery?.resolution !== "effect-completed") ||
    operation.completed_effects.length !== 1 ||
    !/^github-actions:boburning\/portcove:artifact:[1-9][0-9]{0,15}$/u.test(
      operation.completed_effects[0]!.remote_identity,
    )
  )
    throw new Error("metadata context retry requires one exact settled upload");
  return operation;
}

async function priorOperation(context: Context, raw: unknown) {
  if (!isRecord(raw) || !isRecord(raw.controller) || !isRecord(raw.controller.capacity_attempt))
    throw new Error("metadata context journal capacity unavailable");
  const capacity = raw.controller.capacity_attempt;
  const operations = new Map<string, Operation>();
  const current = inspectCapacityOperation(capacity.operation);
  if (
    current?.destination === destination &&
    current.metadata_renewal?.prior_repository_sha256 === context.descriptor.prior_repository_sha256
  )
    operations.set(current.id, inspectMetadataContextRetryOperation(current, context.descriptor));
  for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
    if (
      group.subject.kind !== "metadata-renewal" ||
      group.subject.identity !== context.descriptor.prior_repository_sha256 ||
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
    return hydrateRetainedCoordinatorOperation(repository, proof);
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

export async function reconcileCoordinatorSigningContext(actualContext: object, parent: string) {
  const context = await requireCoordinatorSigningContext(actualContext);
  return withCoordinatorDeadline(context.deadline, () =>
    reconcileAt(actualContext, context, parent),
  );
}
async function reconcileAt(actualContext: object, context: Context, parent: string) {
  const deadline = context.deadline;
  const state = await readRemoteCoordinatorSnapshot(
    parent,
    { schema_version: 1, namespace: context.namespace },
    { transport: { cwd: parent, deadline } },
  );
  if (state.checkpoint !== context.checkpoint) throw new Error("metadata retry checkpoint changed");
  const operation = await priorOperation(context, state.input);
  if (!operation) return { decision: "new" as const };
  const directory = await mkdtemp(path.join(parent, "metadata-context-recovery-")),
    home = path.join(directory, "reader-home");
  await mkdir(home, { mode: 0o700 });
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    GH_CONFIG_DIR: home,
    GH_TOKEN: process.env.GH_TOKEN,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
  };
  let reads = 0;
  const api = new GitHubApiClient((args, input) => {
    if (++reads > 14) throw new Error("metadata retry read limit exhausted");
    const result = createGitHubRunner({
      cwd: directory,
      timeoutMs: signingContextRemaining(deadline, 15000),
      maxBuffer: 2 * 1024 ** 2,
      spawn: (command, argv, settings) =>
        spawnSync(command, argv, { ...settings, env: environment }),
    })([...args, "--hostname", "github.com"], input);
    signingContextRemaining(deadline, 15000);
    return result;
  });
  const get = (suffix: string) => {
    const response = api.request("GET", `repos/boburning/portcove/${suffix}`);
    if (response.status !== 200) throw new Error("metadata retry provider read unavailable");
    return response.body;
  };
  const producer = originalProducer(operation);
  const snapshot = () => {
    const raw = {
      run: get(`actions/runs/${producer.run_id}`),
      attempt: get(`actions/runs/${producer.run_id}/attempts/1`),
      job: get(`actions/jobs/${producer.job_id}`),
      artifacts: readCompleteRunArtifactInventory((page) =>
        get(`actions/runs/${producer.run_id}/artifacts?per_page=100&page=${page}`),
      ),
    };
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
    const before = snapshot();
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
      const archive = readGitHubArtifactArchive(
        `repos/boburning/portcove/actions/artifacts/${artifact.id}/zip`,
        {
          cwd: directory,
          maxBytes: artifact.bytes,
          timeoutMs: signingContextRemaining(deadline, 30000),
          spawn: (command, argv, settings) =>
            spawnSync(command, argv, { ...settings, env: environment }),
        },
      );
      signingContextRemaining(deadline, 15000);
      if (archive.length !== artifact.bytes || hash(archive) !== artifact.sha256)
        throw new Error("metadata retry opaque context changed");
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
    const after = snapshot();
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
