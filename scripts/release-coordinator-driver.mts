import { mkdtemp, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  createReleasePublicationReader,
  peelReleaseReference,
} from "./release-publication-inventory.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import {
  inspectCoordinatorRemoteNamespace,
  publishCoordinatorCheckpoint,
} from "./release-coordinator-remote.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { planReleaseOpportunity, validateOpportunity } from "./release-coordinator.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import { collectReleaseSourceChanges, netTreeDeltaScope } from "./release-source-changes.mts";
import { hydrateReleasePreparationSource } from "./release-preparation-source.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import {
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mts";
import { publishPreparedCoordinatorCheckpoint } from "./release-prepared-transport.mts";
import {
  dispatchPreparedReleaseCandidate,
  readPreparedReleaseCandidate,
  discoverPreparedReleaseCandidate,
} from "./release-candidate-dispatch.mts";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
  recoverOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import {
  authenticateControlReaderJob,
  authenticateReleaseControlSource,
} from "./release-live-control-admission.mts";
import { prepareControlReadiness, waitForControlArtifact } from "./release-control-handshake.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { materializePublishedApplicationComponent } from "./release-site-readback.mts";
import { inspectPublishedMetadata } from "./release-metadata-contract.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import { createHash } from "node:crypto";
import {
  createReleaseReviewRequest,
  inspectReleaseReviewRequest,
} from "./release-review-request.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";

type Reader = ReturnType<typeof createReleasePublicationReader>;
const project = fileURLToPath(new URL("..", import.meta.url));

/** Provider inventory facts only. Every Release is available in Preview; using
 * their latest publication as an explicitly typed upper bound can delay a
 * routine Preview, but never bypass its actual cadence. No urgency is inferred. */
export function deriveCoordinatorPublication(
  tags: Awaited<ReturnType<Reader["tags"]>>,
  releases: ReturnType<Reader["releases"]>,
  allocations: ReturnType<Reader["readAllocations"]>["allocations"],
  now: string,
) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    throw new Error("canonical coordinator publication clock required");
  const versions = new Set<string>();
  const sources = new Set<string>();
  let latest: number | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (!release.tag_name.startsWith("v"))
      throw new Error("published application Release has unsupported tag scope");
    const version = classifyApplicationVersion(
      release.tag_name.slice(1),
      !release.prerelease,
    ).version;
    if (versions.has(version)) throw new Error("duplicate published application version");
    const refs = tags.filter((tag) => tag.name === release.tag_name);
    if (refs.length !== 1) throw new Error("published application Release has no exact unique tag");
    const commit = peelReleaseReference(refs[0]!);
    const prepared = allocations.filter((allocation) => allocation.version === version);
    if (prepared.length > 1 || (prepared[0] && prepared[0].prepared_commit !== commit))
      throw new Error("published Release differs from immutable preparation receipt");
    sources.add(prepared[0]?.source_commit ?? commit);
    versions.add(version);
    const published = release.published_at === null ? NaN : Date.parse(release.published_at);
    if (!Number.isFinite(published) || published > Date.parse(now))
      throw new Error("published application Release has invalid publication time");
    latest = latest === null ? published : Math.max(latest, published);
  }
  return {
    complete: true,
    observed_at: now,
    published_versions: [...versions].sort(),
    published_sources: [...sources].sort(),
    reserved_versions: allocations
      .filter((a) => !versions.has(a.version))
      .map((a) => a.version)
      .sort(),
    last_routine_preview_at: latest === null ? null : new Date(latest).toISOString(),
    last_routine_preview_bound: "all-published-previews",
  };
}

export function inspectPreparedReceiptInventoryAdvance(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  namespace: string,
  candidate: { version: string; source_commit: string; prepared_commit: string },
) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const expected = new Set([
    `${namespace}-prepared/v${candidate.version}`,
    `${namespace}-prepared-source/${candidate.source_commit}`,
  ]);
  const prior = new Map(before.map((ref) => [String(ref.name), ref]));
  const next = new Map(after.map((ref) => [String(ref.name), ref]));
  if (prior.size !== before.length || next.size !== after.length)
    throw new Error("prepared receipt inventory duplicates names");
  for (const [name, old] of prior)
    if (!next.has(name) || capacityDigest(old) !== capacityDigest(next.get(name)))
      throw new Error("preparation changed an existing provider reference");
  for (const [name, value] of next) {
    if (prior.has(name)) continue;
    if (
      !expected.has(name) ||
      !isRecord(value.target) ||
      value.target.__typename !== "Commit" ||
      value.target.oid !== candidate.prepared_commit
    )
      throw new Error("preparation introduced an unrelated or changed provider reference");
  }
  for (const name of expected) {
    const value = next.get(name);
    if (
      !value ||
      !isRecord(value.target) ||
      value.target.__typename !== "Commit" ||
      value.target.oid !== candidate.prepared_commit
    )
      throw new Error("preparation receipt pair remains incomplete");
  }
}

/** Fixed current-job coordinator. Supplied opportunity/configuration select
 * inputs, never acceptance: actual D1/protection/capacity/OIDC checks below own
 * admission. No caller transport, accepted Boolean or executable is accepted.
 * Initial journal/feed provisioning and protected execution stay separately
 * granted prerequisites. This function performs at most one logical dispatch. */
export async function coordinateTrustedRelease(
  privateParent: string,
  raw: { remote_configuration: unknown; opportunity: unknown; dispatch_actor_id: string },
) {
  const selected = structuredClone(raw);
  if (
    Object.keys(selected).sort().join(",") !== "dispatch_actor_id,opportunity,remote_configuration"
  )
    throw new Error("fixed coordinator invocation fields differ");
  const namespace = inspectCoordinatorRemoteNamespace(selected.remote_configuration);
  const opportunity = validateOpportunity(selected.opportunity);
  if (
    !/^[1-9][0-9]*$/u.test(selected.dispatch_actor_id) ||
    opportunity.classification.change_set_scope !== netTreeDeltaScope
  )
    throw new Error(
      "independently selected dispatch principal and explicit net-delta scope required",
    );
  await assertOwnedUnlinkedPath(project, privateParent, "coordinator private parent");
  const directory = await mkdtemp(path.join(privateParent, "coordinator-attempt-"));
  let phase = "remote-recovery";
  let checkpoint: string | null = null;
  try {
    const runner = createGitHubRunner({
      cwd: directory,
      timeoutMs: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const api = new GitHubApiClient((args, body) =>
      runner([...args, "--hostname", "github.com"], body),
    );
    let recovered = await recoverRemoteCoordinator(directory, selected.remote_configuration, {
      transport: { cwd: directory },
    });
    checkpoint = recovered.checkpoint;
    const repository = recovered.repository;
    const existingActive = recovered.input.active_candidate;
    const activeOpportunity = isRecord(existingActive)
      ? validateOpportunity(existingActive.frozen_opportunity)
      : opportunity;
    if (
      isRecord(existingActive) &&
      (activeOpportunity.source_commit !== existingActive.source_commit ||
        activeOpportunity.source_tree !== existingActive.source_tree)
    )
      throw new Error("active original frozen opportunity unavailable");
    phase = "complete-publication-and-source";
    const inventory = createReleasePublicationReader(api);
    const tags = inventory.tags();
    const releases = inventory.releases();
    const { allocations } = inventory.readAllocations(tags, namespace);
    const changes = collectReleaseSourceChanges(api, opportunity);
    if (changes.change_set_sha256 !== opportunity.change_set_sha256)
      throw new Error("independent complete source delta differs from reviewed opportunity");
    const workflow = await readProductionControllerWorkflowBytes();
    const reader = await authenticateControlReaderJob(process.env, workflow, {
      phase: "coordinator",
    });
    let currentExecutor: Awaited<ReturnType<typeof authenticateCapacityExecutor>> | null = null;
    const getExecutor = async () => {
      currentExecutor ??= await authenticateCapacityExecutor(
        "coordinator",
        {
          audience: "portcove-capacity-executor",
          subject: controllerOidcSubject(
            reader.admitted.execution_ref,
            "production-release-coordinator",
          ),
          controller_revision: reader.admitted.revision,
          controller_ref: reader.admitted.execution_ref,
          actor_id: reader.admitted.actor_id,
          run_id: reader.admitted.run_id,
          run_attempt: reader.admitted.run_attempt,
        },
        directory,
      );
      return currentExecutor;
    };
    // Hydration is inert and precedes the short-lived observer/control round.
    const trustedReleaseWorkflow = await readControllerToolFile(
      path.join(project, ".github/workflows/release.yml"),
      256 * 1024,
    );
    hydrateReleasePreparationSource(
      repository,
      {
        source_commit: opportunity.source_commit,
        source_tree: opportunity.source_tree,
      },
      api,
      { trustedReleaseWorkflow },
    );
    if (activeOpportunity.source_commit !== opportunity.source_commit) {
      const activeChanges = collectReleaseSourceChanges(api, activeOpportunity);
      if (activeChanges.change_set_sha256 !== activeOpportunity.change_set_sha256)
        throw new Error("active frozen accumulated source delta differs");
      hydrateReleasePreparationSource(
        repository,
        {
          source_commit: activeOpportunity.source_commit,
          source_tree: activeOpportunity.source_tree,
        },
        api,
        { trustedReleaseWorkflow },
      );
    }
    let expectedInventory = capacityDigest({ tags, releases });
    const publication = deriveCoordinatorPublication(
      tags,
      releases,
      allocations,
      new Date().toISOString(),
    );
    const factsSha = capacityDigest({ opportunity, publication, checkpoint });
    const ready = prepareControlReadiness(reader.identity, factsSha, "coordinator");
    await writeFile(path.join(directory, "ready-coordinator.json"), `${JSON.stringify(ready)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    phase = "actual-coordinator-control-observation";
    const artifact = await waitForControlArtifact(directory, "observation", {
      phase: "coordinator",
      controller_revision: reader.admitted.revision,
      controller_ref: reader.admitted.execution_ref,
      run_id: String(reader.admitted.run_id),
      run_attempt: reader.admitted.run_attempt,
    });
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      observedArtifact: artifact,
    });
    const initial = controls.read(api, opportunity);
    const original =
      activeOpportunity.source_commit === opportunity.source_commit
        ? initial
        : controls.read(api, activeOpportunity);
    const recoveredController = recovered.input.controller;
    const priorOperation = inspectCapacityOperation(
      isRecord(recoveredController) && isRecord(recoveredController.capacity_attempt)
        ? recoveredController.capacity_attempt.operation
        : null,
    );
    if (
      isRecord(existingActive) &&
      existingActive.phase === "prepared" &&
      existingActive.release_run === null &&
      priorOperation &&
      !["succeeded", "recovered"].includes(priorOperation.outcome) &&
      priorOperation.kind === "dispatch" &&
      priorOperation.destination === "github-actions:boburning/portcove:release.yml:dispatch" &&
      isRecord(priorOperation.candidate) &&
      priorOperation.candidate.prepared_commit === existingActive.prepared_commit
    ) {
      phase = "actual-terminal-dispatch-recovery";
      const token = process.env.GH_TOKEN;
      if (
        !token ||
        typeof existingActive.version !== "string" ||
        typeof existingActive.prepared_commit !== "string"
      )
        throw new Error("actual dispatch recovery reader or candidate unavailable");
      const candidate = {
        version: existingActive.version,
        prepared_commit: existingActive.prepared_commit,
        remote_configuration: selected.remote_configuration,
        dispatch_actor_id: selected.dispatch_actor_id,
      };
      const resolved = await recoverOwnedCapacityEffect(
        await getExecutor(),
        {
          repository,
          checkpoint,
          remote_configuration: selected.remote_configuration,
        },
        async (operation) => {
          if (operation.id !== priorOperation.id)
            throw new Error("dispatch recovery operation changed");
          const receipt = priorOperation.completed_effects[0];
          const known = receipt?.remote_identity.match(
            /^github-actions:boburning\/portcove:run:([1-9][0-9]*):attempt:1$/u,
          );
          const observed = known
            ? await readPreparedReleaseCandidate(candidate, Number(known[1]), token)
            : await discoverPreparedReleaseCandidate(candidate, token);
          if (
            receipt &&
            (receipt.remote_identity !== observed.remote_identity ||
              receipt.evidence_sha256 !== observed.evidence_sha256)
          )
            throw new Error("dispatch recovery contradicts retained completed receipt");
          return {
            resolution: "effect-completed",
            evidence_sha256: observed.evidence_sha256,
            completed_effect: {
              remote_identity: observed.remote_identity,
              evidence_sha256: observed.evidence_sha256,
            },
          };
        },
      );
      checkpoint = resolved.checkpoint;
      recovered = { ...recovered, ...(await recoverReleaseOpportunity(repository, checkpoint)) };
    }
    const assertInventory = async (expectedCheckpoint = checkpoint) => {
      if (
        capacityDigest({ tags: inventory.tags(), releases: inventory.releases() }) !==
        expectedInventory
      )
        throw new Error("complete publication inventory changed during coordinator admission");
      const current = await readRemoteCoordinatorSnapshot(
        directory,
        selected.remote_configuration,
        { transport: { cwd: directory } },
      );
      if (current.checkpoint !== expectedCheckpoint)
        throw new Error("remote checkpoint changed during coordinator admission");
    };
    await assertInventory();
    if (
      !initial.resource_policy_matches_controller ||
      !isRecord(initial.capacity_source.capacity) ||
      !isRecord(recovered.input.controller)
    )
      throw new Error("bounded coordinator capacity state unavailable");
    const oldCapacity = recovered.input.controller.capacity_attempt;
    if (!isRecord(oldCapacity) || oldCapacity.schema_version !== 2)
      throw new Error("actual coordinator requires existing capacity schema2 seed");
    const input = structuredClone(recovered.input);
    input.schema_version = 2;
    input.now = new Date().toISOString();
    input.opportunity = opportunity;
    if (inspectReleaseReviewRequest(input.review_request)) input.review_request = null;
    input.publication = { ...publication, observed_at: input.now };
    input.controller = {
      workflow: ".github/workflows/application-update-production.yml",
      revision: reader.admitted.revision,
      publication_paused: initial.pause.publication_paused,
      capacity_attempt: {
        ...structuredClone(initial.capacity_source.capacity),
        schema_version: 2,
        operation: structuredClone(oldCapacity.operation),
        prior_operations: structuredClone(oldCapacity.prior_operations),
      },
    };
    const plan = planReleaseOpportunity(input);
    if (
      plan.action === "pause" ||
      plan.action === "retry-active" ||
      plan.action === "dispatch-repair"
    )
      return {
        decision: "held",
        plan,
        directory,
        checkpoint,
        authority: "none",
        automatic_retry: false,
      };
    const journal = createCoordinatorJournalApi(directory);
    const readBoundary = async () => {
      const fresh = controls.read(api, opportunity);
      const frozen =
        activeOpportunity.source_commit === opportunity.source_commit
          ? fresh
          : controls.read(api, activeOpportunity);
      if (
        fresh.pause.publication_paused ||
        !fresh.resource_policy_matches_controller ||
        capacityDigest(fresh.classification) !== capacityDigest(initial.classification) ||
        capacityDigest(fresh.pause) !== capacityDigest(initial.pause) ||
        capacityDigest(fresh.capacity) !== capacityDigest(initial.capacity) ||
        !isRecord(fresh.capacity_source.capacity) ||
        capacityDigest(frozen.classification) !== capacityDigest(original.classification) ||
        capacityDigest(frozen.pause) !== capacityDigest(fresh.pause) ||
        capacityDigest(frozen.capacity) !== capacityDigest(fresh.capacity)
      )
        throw new Error("fresh coordinator control sources changed or remain held");
      return structuredClone(fresh.capacity_source.capacity.boundary);
    };
    await readBoundary();
    await assertInventory();
    phase = "durable-planner-input";
    const planned = await checkpointReleaseOpportunity(repository, checkpoint, input);
    await publishCoordinatorCheckpoint(
      repository,
      planned.checkpoint,
      selected.remote_configuration,
      { api: journal },
    );
    checkpoint = planned.checkpoint;
    if (plan.action === "skip" || plan.action === "coalesce")
      return { decision: plan.action, plan, directory, checkpoint, authority: "none" };
    if (plan.action === "prepare") {
      phase = "exact-version-preparation";
      const prepared = await prepareReleaseVersion(
        repository,
        opportunity.classification,
        publication.published_versions,
      );
      input.active_candidate = {
        source_commit: prepared.source_commit,
        source_tree: opportunity.source_tree,
        prepared_commit: prepared.prepared_commit,
        prepared_tree: prepared.prepared_tree,
        version: prepared.version,
        intent_sha256: prepared.intent_sha256,
        phase: "prepared",
        failure_kind: null,
        transient_retries: 0,
        substantive_repairs: 0,
        release_run: null,
        frozen_opportunity: opportunity,
      };
      if (!isRecord(input.publication)) throw new Error("complete publication disappeared");
      input.publication.reserved_versions = [prepared.version];
      await readBoundary();
      await assertInventory();
      const allocated = await checkpointReleaseOpportunity(repository, checkpoint, input);
      await publishPreparedCoordinatorCheckpoint(
        repository,
        allocated.checkpoint,
        selected.remote_configuration,
        { api: journal },
      );
      checkpoint = allocated.checkpoint;
      const ownTags = inventory.tags();
      inspectPreparedReceiptInventoryAdvance(tags, ownTags, namespace, {
        version: prepared.version,
        source_commit: prepared.source_commit,
        prepared_commit: prepared.prepared_commit,
      });
      const ownReleases = inventory.releases();
      if (capacityDigest(ownReleases) !== capacityDigest(releases))
        throw new Error("Release inventory changed during immutable preparation allocation");
      expectedInventory = capacityDigest({ tags: ownTags, releases: ownReleases });
    }
    const state = await recoverReleaseOpportunity(repository, checkpoint);
    const candidate = state.input.active_candidate;
    if (!isRecord(candidate) || candidate.phase !== "prepared" || candidate.release_run !== null)
      return {
        decision: "resume-existing",
        directory,
        checkpoint,
        active_candidate: candidate,
        authority: "none",
        automatic_retry: false,
      };
    phase = "actual-owned-dispatch";
    const executor = await getExecutor();
    const dispatch: { value?: Awaited<ReturnType<typeof dispatchPreparedReleaseCandidate>> } = {};
    let result: { checkpoint: string; operation_id: string };
    const controller = state.input.controller;
    const retained = inspectCapacityOperation(
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt.operation
        : null,
    );
    const known = retained?.completed_effects[0];
    const retainedRun = known?.remote_identity.match(
      /^github-actions:boburning\/portcove:run:([1-9][0-9]*):attempt:1$/u,
    );
    const isRetainedDispatch =
      retained &&
      (retained.outcome === "succeeded" || retained.outcome === "recovered") &&
      retained.kind === "dispatch" &&
      retained.destination === "github-actions:boburning/portcove:release.yml:dispatch" &&
      isRecord(retained.candidate) &&
      retained.candidate.prepared_commit === candidate.prepared_commit;
    if (isRetainedDispatch) {
      phase = "actual-retained-dispatch-readback";
      const readToken = process.env.GH_TOKEN;
      if (
        !readToken ||
        !retainedRun ||
        !known ||
        retained.completed_effects.length !== 1 ||
        typeof candidate.version !== "string" ||
        typeof candidate.prepared_commit !== "string"
      )
        throw new Error("retained dispatch readback identity absent");
      dispatch.value = await readPreparedReleaseCandidate(
        {
          version: candidate.version,
          prepared_commit: candidate.prepared_commit,
          remote_configuration: selected.remote_configuration,
          dispatch_actor_id: selected.dispatch_actor_id,
        },
        Number(retainedRun[1]),
        readToken,
      );
      if (dispatch.value.evidence_sha256 !== known.evidence_sha256)
        throw new Error("actual retained dispatch receipt changed");
      await refreshCapacityExecutor(executor);
      await assertInventory();
      await readBoundary();
      result = { checkpoint, operation_id: retained.id };
    } else {
      const token = process.env.PORTCOVE_RELEASE_DISPATCH_TOKEN;
      if (!token) throw new Error("dedicated release dispatch credential unavailable");
      result = await executeOwnedCapacityEffect(
        executor,
        {
          repository,
          checkpoint,
          remote_configuration: selected.remote_configuration,
          request: {
            kind: "dispatch",
            destination: "github-actions:boburning/portcove:release.yml:dispatch",
          },
        },
        readBoundary,
        async (pending) => {
          if (
            typeof candidate.version !== "string" ||
            typeof candidate.prepared_commit !== "string"
          )
            throw new Error("frozen dispatch candidate identity absent");
          dispatch.value = await dispatchPreparedReleaseCandidate(
            {
              version: candidate.version,
              prepared_commit: candidate.prepared_commit,
              remote_configuration: selected.remote_configuration,
              dispatch_actor_id: selected.dispatch_actor_id,
            },
            token,
            async () => {
              await refreshCapacityExecutor(executor);
              await assertInventory(pending.checkpoint);
              await readBoundary();
            },
          );
          return dispatch.value;
        },
      );
    }
    checkpoint = result.checkpoint;
    if (!dispatch.value) throw new Error("actual dispatch readback absent after settlement");
    phase = "durable-dispatched-run-binding";
    const settled = await recoverReleaseOpportunity(repository, checkpoint);
    const progressed = structuredClone(settled.input);
    if (
      !isRecord(progressed.active_candidate) ||
      capacityDigest(progressed.active_candidate) !== capacityDigest(candidate)
    )
      throw new Error("frozen candidate changed before actual run binding");
    progressed.active_candidate.phase = "qualifying";
    progressed.active_candidate.release_run = {
      run_id: dispatch.value.evidence.run_id,
      attempt: 1,
      revision: candidate.prepared_commit,
    };
    await refreshCapacityExecutor(executor);
    const bound = await checkpointReleaseOpportunity(repository, checkpoint, progressed);
    checkpoint = bound.checkpoint;
    await publishCoordinatorCheckpoint(repository, checkpoint, selected.remote_configuration, {
      api: journal,
    });
    return {
      decision: "dispatched",
      directory,
      checkpoint,
      operation_id: result.operation_id,
      release_run: progressed.active_candidate.release_run,
      authority: "none",
      automatic_retry: false,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "trusted coordinator stopped; retain exact local state and read back before continuing",
      {
        directory,
        checkpoint,
        phase,
        retained_error: error instanceof CoordinatorRemoteError ? error.evidence : null,
        automatic_retry: false,
        authority: "none",
      },
    );
  }
}

/** No-candidate maintenance preparation uses the same recovered journal and
 * actual authenticated public component. It neither signs nor publishes, and
 * never invents an initial feed. Actual role jobs must reauthenticate their
 * public context before accessing their own role key. */
export async function prepareTrustedCoordinatorRenewal(
  privateParent: string,
  raw: {
    remote_configuration: unknown;
    tools: {
      artifact: ControllerToolArtifactExpected;
      bundle: { artifact_id: number; sha256: string };
    };
  },
) {
  const selected = structuredClone(raw);
  if (
    Object.keys(selected).sort().join(",") !== "remote_configuration,tools" ||
    !isRecord(selected.tools) ||
    Object.keys(selected.tools).sort().join(",") !== "artifact,bundle"
  )
    throw new Error("fixed coordinator renewal invocation fields differ");
  inspectCoordinatorRemoteNamespace(selected.remote_configuration);
  await assertOwnedUnlinkedPath(project, privateParent, "metadata coordinator private parent");
  const directory = await mkdtemp(path.join(privateParent, "coordinator-renewal-"));
  let checkpoint: string | null = null;
  let phase = "remote-recovery";
  try {
    const recovered = await recoverRemoteCoordinator(directory, selected.remote_configuration, {
      transport: { cwd: directory },
    });
    checkpoint = recovered.checkpoint;
    if (recovered.input.active_candidate !== null)
      return { decision: "held-active-candidate", directory, checkpoint, authority: "none" };
    const published = inspectPublishedMetadata(recovered.input.published_metadata);
    if (!published)
      throw new Error(
        "authenticated published metadata seed absent; explicit initial bootstrap required",
      );
    if (
      typeof published.root_sha256 !== "string" ||
      typeof published.repository_sha256 !== "string"
    )
      throw new Error("published application root/repository identity unavailable");
    phase = "actual-current-tool-and-public-feed";
    const receipt = await receiveControllerTools(
      directory,
      selected.tools.artifact,
      selected.tools.bundle,
    );
    const tools = await verifiedControllerToolPaths(receipt);
    const workflow = await readProductionControllerWorkflowBytes();
    const reader = await authenticateControlReaderJob(process.env, workflow, {
      phase: "coordinator",
    });
    if (
      tools.identity.controller_revision !== reader.admitted.revision ||
      tools.identity.controller_ref !== reader.admitted.execution_ref ||
      tools.identity.run_id !== String(reader.admitted.run_id) ||
      tools.identity.run_attempt !== reader.admitted.run_attempt
    )
      throw new Error("metadata verifier tools differ from actual current coordinator");
    const component = await materializePublishedApplicationComponent(
      {
        site_generation_sha256: published.publication.site_generation_sha256,
        root_sha256: published.root_sha256,
        repository_sha256: published.repository_sha256,
      },
      directory,
    );
    const existing = recovered.input.metadata_renewal;
    const generatedAt =
      isRecord(existing) &&
      existing.prior_repository_sha256 === published.repository_sha256 &&
      typeof existing.generated_at === "string"
        ? existing.generated_at
        : new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
    const verifierBytes = await readControllerToolFile(tools.rust);
    const preparation = await prepareAuthenticatedMetadataRenewal({
      verifier: tools.rust,
      verifier_sha256: createHash("sha256").update(verifierBytes).digest("hex"),
      trusted_root: component.root_path,
      trusted_root_sha256: published.root_sha256,
      previous_repository: component.directory,
      prior_repository_sha256: published.repository_sha256,
      generated_at: generatedAt,
      output_parent: directory,
    });
    const prepared = await inspectPreparedMetadataRenewal(preparation);
    const runner = createGitHubRunner({
      cwd: directory,
      timeoutMs: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const api = new GitHubApiClient((args, body) =>
      runner([...args, "--hostname", "github.com"], body),
    );
    const inventory = createReleasePublicationReader(api);
    const tags = inventory.tags();
    const releases = inventory.releases();
    const { allocations } = inventory.readAllocations(
      tags,
      inspectCoordinatorRemoteNamespace(selected.remote_configuration),
    );
    const publication = deriveCoordinatorPublication(
      tags,
      releases,
      allocations,
      new Date().toISOString(),
    );
    const inventorySha = capacityDigest({ tags, releases });
    const ready = prepareControlReadiness(
      reader.identity,
      capacityDigest({ checkpoint, descriptor: prepared.descriptor }),
      "coordinator",
    );
    await writeFile(path.join(directory, "ready-coordinator.json"), `${JSON.stringify(ready)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    phase = "actual-maintenance-controls";
    const artifact = await waitForControlArtifact(directory, "observation", {
      phase: "coordinator",
      controller_revision: reader.admitted.revision,
      controller_ref: reader.admitted.execution_ref,
      run_id: String(reader.admitted.run_id),
      run_attempt: reader.admitted.run_attempt,
    });
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      observedArtifact: artifact,
    });
    const initial = controls.readMaintenance(api);
    if (
      !initial.resource_policy_matches_controller ||
      !isRecord(initial.capacity_source.capacity) ||
      !isRecord(recovered.input.controller) ||
      !isRecord(recovered.input.controller.capacity_attempt) ||
      recovered.input.controller.capacity_attempt.schema_version !== 2
    )
      throw new Error("bounded coordinator maintenance state unavailable");
    const oldCapacity = recovered.input.controller.capacity_attempt;
    const input = structuredClone(recovered.input);
    input.schema_version = 2;
    input.now = new Date().toISOString();
    input.publication = { ...publication, observed_at: input.now };
    input.metadata_renewal = prepared.descriptor;
    input.controller = {
      workflow: ".github/workflows/application-update-production.yml",
      revision: reader.admitted.revision,
      publication_paused: initial.pause.publication_paused,
      capacity_attempt: {
        ...initial.capacity_source.capacity,
        schema_version: 2,
        operation: structuredClone(oldCapacity.operation),
        prior_operations: structuredClone(oldCapacity.prior_operations),
      },
    };
    const plan = planReleaseOpportunity(input);
    if (plan.action === "pause")
      return { decision: "held", directory, checkpoint, plan, authority: "none" };
    await verifiedControllerToolPaths(receipt);
    await inspectPreparedMetadataRenewal(preparation);
    const current = await readRemoteCoordinatorSnapshot(directory, selected.remote_configuration, {
      transport: { cwd: directory },
    });
    const fresh = controls.readMaintenance(api);
    if (
      current.checkpoint !== checkpoint ||
      fresh.pause.publication_paused ||
      capacityDigest({ tags: inventory.tags(), releases: inventory.releases() }) !== inventorySha ||
      capacityDigest(fresh.pause) !== capacityDigest(initial.pause) ||
      capacityDigest(fresh.capacity) !== capacityDigest(initial.capacity)
    )
      throw new Error("maintenance inputs or remote checkpoint changed before durable preparation");
    phase = "durable-maintenance-descriptor";
    const saved = await checkpointReleaseOpportunity(recovered.repository, checkpoint, input);
    checkpoint = saved.checkpoint;
    await publishCoordinatorCheckpoint(
      recovered.repository,
      checkpoint,
      selected.remote_configuration,
      { api: createCoordinatorJournalApi(directory) },
    );
    return {
      decision: "metadata-prepared",
      directory,
      checkpoint,
      descriptor: prepared.descriptor,
      context: prepared.context,
      prepared_root: prepared.prepared_root,
      files: prepared.files,
      authority: "none",
      evidence_scope: "actual-tool-and-public-feed",
      automatic_retry: false,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "coordinator metadata preparation stopped; retain exact state",
      {
        directory,
        checkpoint,
        phase,
        retained_error: error instanceof CoordinatorRemoteError ? error.evidence : null,
        automatic_retry: false,
        authority: "none",
      },
    );
  }
}

/** Freeze one neutral work request in the existing journal. While a candidate
 * or request is outstanding the current provider main head merely coalesces;
 * no second queue, semantic assertion or speculative version is created. */
export async function requestTrustedSemanticReview(
  privateParent: string,
  raw: { remote_configuration: unknown },
) {
  const selected = structuredClone(raw);
  if (Object.keys(selected).join(",") !== "remote_configuration")
    throw new Error("neutral review request invocation fields differ");
  const namespace = inspectCoordinatorRemoteNamespace(selected.remote_configuration);
  await assertOwnedUnlinkedPath(
    project,
    privateParent,
    "review request coordinator private parent",
  );
  const directory = await mkdtemp(path.join(privateParent, "coordinator-review-"));
  let checkpoint: string | null = null;
  let phase = "remote-recovery";
  try {
    const recovered = await recoverRemoteCoordinator(directory, selected.remote_configuration, {
      transport: { cwd: directory },
    });
    checkpoint = recovered.checkpoint;
    const runner = createGitHubRunner({
      cwd: directory,
      timeoutMs: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const api = new GitHubApiClient((args, body) =>
      runner([...args, "--hostname", "github.com"], body),
    );
    const mainHead = () => {
      const response = api.request("GET", "repos/boburning/portcove/git/ref/heads/main");
      const value = response.body;
      if (
        response.status !== 200 ||
        !isRecord(value) ||
        value.ref !== "refs/heads/main" ||
        !isRecord(value.object) ||
        value.object.type !== "commit" ||
        typeof value.object.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(value.object.sha)
      )
        throw new Error("fixed current main source identity unavailable");
      return value.object.sha;
    };
    const source = mainHead();
    const outstanding = inspectReleaseReviewRequest(recovered.input.review_request);
    if (outstanding || recovered.input.active_candidate !== null)
      return {
        decision: outstanding ? "review-request-retained" : "coalesced-active",
        directory,
        checkpoint,
        review_request: outstanding,
        current_main: source,
        authority: "none",
      };
    phase = "complete-publication-baseline-and-source";
    const inventory = createReleasePublicationReader(api);
    const tags = inventory.tags();
    const releases = inventory.releases();
    const { allocations } = inventory.readAllocations(tags, namespace);
    const now = new Date().toISOString();
    const publication = deriveCoordinatorPublication(tags, releases, allocations, now);
    const versions = [...publication.published_versions].sort(compareApplicationVersionPrecedence);
    const baseVersion = versions.at(-1);
    if (!baseVersion)
      throw new Error("actual published application baseline absent; explicit setup required");
    const baseline = tags.find((ref) => ref.name === `v${baseVersion}`);
    if (!baseline) throw new Error("published baseline tag absent");
    const baselinePrepared = peelReleaseReference(baseline);
    const allocation = allocations.find((a) => a.version === baseVersion);
    const base = allocation?.source_commit ?? baselinePrepared;
    if (source === base)
      return { decision: "unchanged-published-source", directory, checkpoint, authority: "none" };
    const sourceResponse = api.request("GET", `repos/boburning/portcove/git/commits/${source}`);
    if (sourceResponse.status !== 200) throw new Error("current main raw Git identity unavailable");
    const sourceObject = inspectRemoteCommitObject(sourceResponse.body, source);
    const changes = collectReleaseSourceChanges(api, {
      base_commit: base,
      source_commit: source,
      source_tree: sourceObject.tree,
    });
    const requestedAt = new Date().toISOString();
    const request = createReleaseReviewRequest({
      before_checkpoint: checkpoint,
      requested_at: requestedAt,
      base_commit: base,
      base_version: baseVersion,
      source_commit: source,
      source_tree: sourceObject.tree,
      change_set_sha256: changes.change_set_sha256,
    });
    const workflow = await readProductionControllerWorkflowBytes();
    const reader = await authenticateControlReaderJob(process.env, workflow, {
      phase: "coordinator",
    });
    await writeFile(
      path.join(directory, "ready-coordinator.json"),
      `${JSON.stringify(prepareControlReadiness(reader.identity, request.request_id, "coordinator"))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    phase = "actual-neutral-request-controls";
    const artifact = await waitForControlArtifact(directory, "observation", {
      phase: "coordinator",
      controller_revision: reader.admitted.revision,
      controller_ref: reader.admitted.execution_ref,
      run_id: String(reader.admitted.run_id),
      run_attempt: reader.admitted.run_attempt,
    });
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      observedArtifact: artifact,
    });
    const observed = controls.readMaintenance(api);
    if (
      !observed.resource_policy_matches_controller ||
      !isRecord(observed.capacity_source.capacity) ||
      !isRecord(recovered.input.controller) ||
      !isRecord(recovered.input.controller.capacity_attempt) ||
      recovered.input.controller.capacity_attempt.schema_version !== 2
    )
      throw new Error("neutral request bounded policy unavailable");
    const capacity = recovered.input.controller.capacity_attempt;
    const input = structuredClone(recovered.input);
    input.schema_version = 2;
    input.now = requestedAt;
    input.publication = { ...publication, observed_at: requestedAt };
    input.review_request = request;
    input.controller = {
      workflow: ".github/workflows/application-update-production.yml",
      revision: reader.admitted.revision,
      publication_paused: observed.pause.publication_paused,
      capacity_attempt: {
        ...observed.capacity_source.capacity,
        schema_version: 2,
        operation: structuredClone(capacity.operation),
        prior_operations: structuredClone(capacity.prior_operations),
      },
    };
    const plan = planReleaseOpportunity(input);
    if (plan.action === "pause")
      return { decision: "held", directory, checkpoint, plan, authority: "none" };
    const fresh = controls.readMaintenance(api);
    const remote = await readRemoteCoordinatorSnapshot(directory, selected.remote_configuration, {
      transport: { cwd: directory },
    });
    if (
      mainHead() !== source ||
      remote.checkpoint !== checkpoint ||
      fresh.pause.publication_paused ||
      capacityDigest(fresh.pause) !== capacityDigest(observed.pause) ||
      capacityDigest(fresh.capacity) !== capacityDigest(observed.capacity) ||
      capacityDigest({ tags: inventory.tags(), releases: inventory.releases() }) !==
        capacityDigest({ tags, releases })
    )
      throw new Error("neutral request provider/control snapshot changed before durable intent");
    phase = "durable-neutral-review-request";
    const result = await checkpointReleaseOpportunity(recovered.repository, checkpoint, input);
    checkpoint = result.checkpoint;
    await publishCoordinatorCheckpoint(
      recovered.repository,
      checkpoint,
      selected.remote_configuration,
      { api: createCoordinatorJournalApi(directory) },
    );
    return {
      decision: "review-requested",
      directory,
      checkpoint,
      review_request: request,
      authority: "none",
      automatic_retry: false,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "neutral review request stopped; retain exact existing journal state",
      {
        directory,
        checkpoint,
        phase,
        retained_error: error instanceof CoordinatorRemoteError ? error.evidence : null,
        automatic_retry: false,
        authority: "none",
      },
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, selectionFile] = process.argv.slice(2);
  if (process.argv.length !== 4 || !directory || !selectionFile)
    throw new Error("usage: release-coordinator-driver.mts PRIVATE_PARENT SELECTION.json");
  const stat = await lstat(selectionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw new Error("bounded coordinator selection file required");
  const selection: unknown = JSON.parse(await readFile(selectionFile, "utf8"));
  if (!isRecord(selection)) throw new Error("coordinator selection must be an object");
  if (
    selection.opportunity === null &&
    Object.keys(selection).sort().join(",") !== "opportunity,remote_configuration,tools"
  )
    throw new Error("fixed metadata coordinator selection fields differ");
  console.log(
    JSON.stringify(
      Object.keys(selection).join(",") === "remote_configuration"
        ? await requestTrustedSemanticReview(path.resolve(directory), {
            remote_configuration: selection.remote_configuration,
          })
        : selection.opportunity === null
          ? await prepareTrustedCoordinatorRenewal(path.resolve(directory), {
              remote_configuration: selection.remote_configuration,
              tools: selection.tools as Parameters<
                typeof prepareTrustedCoordinatorRenewal
              >[1]["tools"],
            })
          : await coordinateTrustedRelease(
              path.resolve(directory),
              selection as Parameters<typeof coordinateTrustedRelease>[1],
            ),
    ),
  );
}
