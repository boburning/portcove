import { performance } from "node:perf_hooks";
import {
  inspectAssemblerIdentityExpectation,
  requestAssemblerToken,
  verifyCapacityExecutorJobIdentity,
} from "./assembler-job-identity.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import { capacityDigest, inspectCapacityExecutorIdentity } from "./release-capacity.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import {
  recordCapacityReadback,
  runBoundedCapacityOperation,
  runBoundedMetadataRenewalOperation,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";
import { inspectPublishedMetadata } from "./release-metadata-contract.mts";
import { isRecord } from "./runtime-values.mts";

export interface CapacityExecutorIdentity {
  controller_revision: string;
  execution_ref: string;
  workflow: string;
  run_id: string;
  run_attempt: number;
  job_id: number;
  check_run_id: string;
  actor_id: string;
  role: CapacityExecutorRole;
}
interface ExecutorSession {
  readonly kind: "authenticated-capacity-executor";
}
interface PrivateSession {
  role: CapacityExecutorRole;
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>;
  directory: string;
  identity: CapacityExecutorIdentity;
  observed: number;
}
const sessions = new WeakMap<ExecutorSession, PrivateSession>();
const audience = "portcove-capacity-executor";
const effectStates = new WeakMap<ExecutorSession, { busy: boolean; failed: boolean }>();

async function observe(
  role: CapacityExecutorRole,
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>,
  directory: string,
): Promise<CapacityExecutorIdentity> {
  if (expected.audience !== audience)
    throw new Error("capacity executor audience differs from its fixed role");
  const token = await requestAssemblerToken(audience);
  const actual = await verifyCapacityExecutorJobIdentity(role, token, expected, {
    transport: { cwd: directory },
  });
  if (actual.evidence_scope !== "github.com")
    throw new Error("capacity executor requires actual provider identity");
  return {
    controller_revision: actual.workflow_revision,
    execution_ref: actual.execution_ref,
    workflow: actual.workflow,
    run_id: actual.run_id,
    run_attempt: actual.run_attempt,
    job_id: actual.job_id,
    check_run_id: actual.check_run_id,
    actor_id: actual.actor_id,
    role: actual.role,
  };
}

/** Direct current-job authentication. No imported report, token, test transport
 * or caller-supplied identity can create a session. This does not prove fresh
 * admission/protections or grant permission to execute a provider effect. */
export async function authenticateCapacityExecutor(
  role: CapacityExecutorRole,
  rawExpected: unknown,
  directory: string,
): Promise<ExecutorSession> {
  const expected = inspectAssemblerIdentityExpectation(structuredClone(rawExpected));
  const identity = await observe(role, expected, directory);
  const session: ExecutorSession = Object.freeze({ kind: "authenticated-capacity-executor" });
  sessions.set(session, { role, expected, directory, identity, observed: performance.now() });
  return session;
}

export function capacityExecutorIdentity(session: ExecutorSession): CapacityExecutorIdentity {
  const value = sessions.get(session);
  if (!value || performance.now() - value.observed > 60_000)
    throw new Error("actual fresh executor session unavailable");
  return structuredClone(value.identity);
}

/** Reauthenticate the same exact job before effect/readback; a completed,
 * changed or replaced job cannot inherit the public nonce or checkpoint. */
export async function refreshCapacityExecutor(session: ExecutorSession) {
  const value = sessions.get(session);
  if (!value) throw new Error("imported executor sessions cannot execute or recover");
  const actual = await observe(value.role, value.expected, value.directory);
  if (capacityDigest(actual) !== capacityDigest(value.identity))
    throw new Error("capacity executor identity changed during the attempt");
  value.observed = performance.now();
  return structuredClone(value.identity);
}

interface OwnedEffectRequest {
  kind: "dispatch" | "upload" | "retention";
  destination: string;
}

function checkDestination(role: CapacityExecutorRole, request: OwnedEffectRequest) {
  if (Object.keys(request).sort().join(",") !== "destination,kind")
    throw new Error("executor effect request contains unsupported fields");
  // Destinations describe a stable logical effect within the candidate or
  // metadata lifecycle. Regenerated artifact/run/descriptor IDs cannot reset
  // retry accounting; actual provider IDs belong in completed-effect receipts.
  const allowed =
    role === "site-publication"
      ? request.kind === "upload" &&
        request.destination === "github-pages:boburning/portcove:complete-site"
      : role === "coordinator"
        ? request.kind === "dispatch" &&
          request.destination === "github-actions:boburning/portcove:release.yml:dispatch"
        : request.kind === "upload" &&
          /^github-release:boburning\/portcove:[A-Za-z0-9._-]{1,128}:(?:create-draft|publish|upload:[A-Za-z0-9._+-]{1,200})$/u.test(
            request.destination,
          );
  if (!allowed) throw new Error("effect is outside the authenticated executor's fixed scope");
}

/** Actual current-job/exact-checkpoint integration of the existing bounded
 * operation journal. This grants no semantic/custody/control acceptance: the
 * fixed controller must obtain those through their actual phase consumers
 * before invoking its one provider effect and independent result readback.
 * Failure stops this session. An unresolved intent cannot be retried here. */
export async function executeOwnedCapacityEffect(
  session: ExecutorSession,
  raw: {
    repository: string;
    checkpoint: string;
    remote_configuration: unknown;
    request: OwnedEffectRequest;
    metadata_renewal?: unknown;
    recovery?: "transient" | "substantive-repair";
  },
  readBoundary: () => Promise<unknown>,
  effect: (pending: {
    checkpoint: string;
    operation_id: string;
  }) => Promise<{ remote_identity: string; evidence_sha256: string }>,
) {
  const value = sessions.get(session);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const input = structuredClone(raw);
  if (!/^[a-f0-9]{40}$/u.test(input.checkpoint))
    throw new Error("exact coordinator checkpoint required");
  checkDestination(value.role, input.request);
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed)
    throw new Error("executor is busy or stopped; explicit readback/recovery required");
  state.busy = true;
  const runner = createGitHubRunner({
    cwd: value.directory,
    timeoutMs: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  const remote = { configuration: input.remote_configuration, api };
  let ownedId: string | null = null;
  const captured: { completed?: { remote_identity: string; evidence_sha256: string } } = {};
  try {
    const executorIdentity = await refreshCapacityExecutor(session);
    // Existing transport checks every remote ref and returns only exact public
    // readback; no local checkpoint or public nonce can appoint this executor.
    await publishCoordinatorCheckpoint(input.repository, input.checkpoint, remote.configuration, {
      api,
    });
    const perform: Parameters<typeof runBoundedCapacityOperation>[4] = async (
      recordCompleted,
      pending,
    ) => {
      if (capacityDigest(pending.operation.executor_identity) !== capacityDigest(executorIdentity))
        throw new Error("durable operation belongs to another executor");
      if (typeof pending.operation.id !== "string" || !/^[a-f0-9]{64}$/u.test(pending.operation.id))
        throw new Error("actual capacity operation identity unavailable");
      ownedId = pending.operation.id;
      await refreshCapacityExecutor(session);
      await publishCoordinatorCheckpoint(
        input.repository,
        pending.checkpoint,
        remote.configuration,
        { api },
      );
      const receipt = await effect({ checkpoint: pending.checkpoint, operation_id: ownedId });
      if (
        Object.keys(receipt).sort().join(",") !== "evidence_sha256,remote_identity" ||
        typeof receipt.remote_identity !== "string" ||
        !receipt.remote_identity ||
        !/^[a-f0-9]{64}$/u.test(receipt.evidence_sha256)
      )
        throw new Error("exact provider/readback evidence unavailable");
      captured.completed = structuredClone(receipt);
      await recordCompleted(receipt.remote_identity, receipt.evidence_sha256);
    };
    const options = { remote, executorIdentity, maximumReceipts: 1 };
    if (input.metadata_renewal !== undefined && value.role !== "site-publication")
      throw new Error("metadata maintenance requires the fixed site executor");
    if (input.metadata_renewal === undefined && input.recovery !== undefined)
      throw new Error("candidate retries require their existing reservation recovery");
    const result =
      input.metadata_renewal === undefined
        ? await runBoundedCapacityOperation(
            input.repository,
            input.checkpoint,
            input.request,
            readBoundary,
            perform,
            options,
          )
        : await runBoundedMetadataRenewalOperation(
            input.repository,
            input.checkpoint,
            input.metadata_renewal,
            input.request,
            readBoundary,
            perform,
            { ...options, ...(input.recovery === undefined ? {} : { recovery: input.recovery }) },
          );
    const completed = captured.completed;
    if (
      !ownedId ||
      !completed ||
      result.durable_checkpoint !== result.checkpoint ||
      result.completion !== "readback-required"
    )
      throw new Error("durable provider handoff is unresolved");
    await refreshCapacityExecutor(session);
    await publishCoordinatorCheckpoint(input.repository, result.checkpoint, remote.configuration, {
      api,
    });
    const actual = await recoverReleaseOpportunity(input.repository, result.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      operation.id !== ownedId ||
      operation.outcome !== "pending" ||
      capacityDigest(operation.executor_identity) !== capacityDigest(executorIdentity) ||
      capacityDigest(operation.completed_effects) !== capacityDigest([completed])
    )
      throw new Error("exact owned provider receipt changed before settlement");
    const settled = await recordCapacityReadback(
      input.repository,
      result.checkpoint,
      "effect-completed",
      completed.evidence_sha256,
      { remote, executorIdentity },
    );
    if (!("durable_checkpoint" in settled) || settled.durable_checkpoint !== settled.checkpoint)
      throw new Error("remote settlement is unresolved");
    return {
      checkpoint: settled.checkpoint,
      operation_id: ownedId,
      evidence_sha256: completed.evidence_sha256,
    };
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    state.busy = false;
  }
}

/** Automatic bounded recovery is a different authenticated job. It may observe
 * and resolve an old intent only after the original exact executor is terminal;
 * it never inherits permission to re-POST the effect. Readback callbacks in the
 * immutable controller must positively establish the requested resolution. */
export async function recoverOwnedCapacityEffect(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<{
    resolution: "effect-completed" | "effect-not-applied" | "partial-effects-retained";
    evidence_sha256: string;
  }>,
) {
  const value = sessions.get(session);
  if (!value || value.role !== "coordinator")
    throw new Error("actual fixed coordinator recovery identity required");
  const input = structuredClone(raw);
  if (!/^[a-f0-9]{40}$/u.test(input.checkpoint))
    throw new Error("exact recovery checkpoint required");
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed)
    throw new Error("executor is busy or stopped; retain original recovery evidence");
  state.busy = true;
  const runner = createGitHubRunner({
    cwd: value.directory,
    timeoutMs: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  const remote = { configuration: input.remote_configuration, api };
  try {
    const executorIdentity = await refreshCapacityExecutor(session);
    await publishCoordinatorCheckpoint(input.repository, input.checkpoint, remote.configuration, {
      api,
    });
    const actual = await recoverReleaseOpportunity(input.repository, input.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      !["pending", "ambiguous", "capacity-refused"].includes(String(operation.outcome)) ||
      !isRecord(operation.executor_identity)
    )
      throw new Error("an unresolved identity-bound capacity operation is required");
    const original = inspectCapacityExecutorIdentity(operation.executor_identity);
    if (original.job_id === executorIdentity.job_id && original.run_id === executorIdentity.run_id)
      throw new Error("live executor cannot appoint itself as terminal-job recovery");
    const terminal = () => {
      const response = api.request(
        "GET",
        `repos/boburning/portcove/actions/jobs/${String(original.job_id)}`,
      );
      const job = response.body;
      if (
        response.status !== 200 ||
        !isRecord(job) ||
        job.id !== original.job_id ||
        String(job.run_id) !== original.run_id ||
        job.run_attempt !== original.run_attempt ||
        job.head_sha !== original.controller_revision ||
        job.status !== "completed" ||
        typeof job.conclusion !== "string" ||
        !job.conclusion ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(original.check_run_id)}`
      )
        throw new Error("original exact executor is not observed terminal; recovery remains held");
    };
    terminal();
    const resolution = await readback(structuredClone(operation));
    if (
      Object.keys(resolution).sort().join(",") !== "evidence_sha256,resolution" ||
      !["effect-completed", "effect-not-applied", "partial-effects-retained"].includes(
        resolution.resolution,
      ) ||
      !/^[a-f0-9]{64}$/u.test(resolution.evidence_sha256)
    )
      throw new Error("actual recovery readback is incomplete");
    await refreshCapacityExecutor(session);
    terminal();
    await publishCoordinatorCheckpoint(input.repository, input.checkpoint, remote.configuration, {
      api,
    });
    const settled = await recordCapacityReadback(
      input.repository,
      input.checkpoint,
      resolution.resolution,
      resolution.evidence_sha256,
      { remote, executorIdentity },
    );
    if (!("durable_checkpoint" in settled) || settled.durable_checkpoint !== settled.checkpoint)
      throw new Error("recovery remote settlement unresolved");
    return { checkpoint: settled.checkpoint, operation_id: operation.id, ...resolution };
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    state.busy = false;
  }
}

/** Complete a lost post-publication journal handoff without another provider
 * mutation. The separately authenticated coordinator must re-read the exact
 * public result after the original publisher has become terminal. */
export async function recoverOwnedPublishedMetadata(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<unknown>,
) {
  const value = sessions.get(session);
  if (!value || value.role !== "coordinator")
    throw new Error("actual coordinator required for published-state recovery");
  const input = structuredClone(raw);
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed) throw new Error("recovery executor is busy or stopped");
  state.busy = true;
  const runner = createGitHubRunner({
    cwd: value.directory,
    timeoutMs: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  const remote = { configuration: input.remote_configuration, api };
  try {
    const current = await refreshCapacityExecutor(session);
    await publishCoordinatorCheckpoint(input.repository, input.checkpoint, remote.configuration, {
      api,
    });
    const actual = await recoverReleaseOpportunity(input.repository, input.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      operation.destination !== "github-pages:boburning/portcove:complete-site" ||
      operation.kind !== "upload" ||
      operation.outcome !== "recovered" ||
      !isRecord(operation.recovery) ||
      operation.recovery.resolution !== "effect-completed" ||
      !Array.isArray(operation.completed_effects) ||
      operation.completed_effects.length !== 1
    )
      throw new Error("exact settled site operation required for published-state recovery");
    const original = inspectCapacityExecutorIdentity(operation.executor_identity);
    if (
      original.role !== "site-publication" ||
      (original.run_id === current.run_id && original.job_id === current.job_id)
    )
      throw new Error("separate terminal site publisher required");
    const terminal = () => {
      const result = api.request(
        "GET",
        `repos/boburning/portcove/actions/jobs/${String(original.job_id)}`,
      );
      const job = result.body;
      if (
        result.status !== 200 ||
        !isRecord(job) ||
        job.id !== original.job_id ||
        String(job.run_id) !== original.run_id ||
        job.run_attempt !== original.run_attempt ||
        job.head_sha !== original.controller_revision ||
        job.status !== "completed" ||
        typeof job.conclusion !== "string" ||
        !job.conclusion ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(original.check_run_id)}`
      )
        throw new Error("original exact publisher is not observed terminal");
    };
    terminal();
    const published = inspectPublishedMetadata(await readback(structuredClone(operation)));
    const effect: unknown = operation.completed_effects[0];
    if (
      !published ||
      !isRecord(effect) ||
      published.operation_id !== operation.id ||
      published.publication.remote_identity !== effect.remote_identity ||
      published.publication.evidence_sha256 !== effect.evidence_sha256
    )
      throw new Error("public readback differs from exact settled effect");
    await refreshCapacityExecutor(session);
    terminal();
    await publishCoordinatorCheckpoint(input.repository, input.checkpoint, remote.configuration, {
      api,
    });
    const recovered = await recordPublishedMetadata(input.repository, input.checkpoint, published, {
      remote,
    });
    if (
      !("durable_checkpoint" in recovered) ||
      recovered.durable_checkpoint !== recovered.checkpoint
    )
      throw new Error("published-state recovery handoff unresolved");
    return {
      checkpoint: recovered.checkpoint,
      operation_id: operation.id,
      site_generation_sha256: published.publication.site_generation_sha256,
    };
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    state.busy = false;
  }
}
