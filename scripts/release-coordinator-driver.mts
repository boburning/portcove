import { mkdtemp, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  capacityDigest,
  inspectCapacityOperation,
  assessBoundedCapacity,
} from "./release-capacity.mts";
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
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";
import {
  inspectPublishedMetadata,
  inspectMetadataRenewalDescriptor,
} from "./release-metadata-contract.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import { createHash } from "node:crypto";
import {
  createReleaseReviewRequest,
  inspectReleaseReviewRequest,
  advanceReleaseReviewRecovery,
} from "./release-review-request.mts";
import { createReleaseReviewDispositionReceipt } from "./release-semantic-disposition-reader.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPublishedApplicationSource } from "./release-published-source.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

type Reader = ReturnType<typeof createReleasePublicationReader>;
const metadataPreparations = new WeakMap<
  object,
  {
    preparation: Awaited<ReturnType<typeof prepareAuthenticatedMetadataRenewal>>;
    tools: Awaited<ReturnType<typeof receiveControllerTools>>;
    complete_site: Awaited<ReturnType<typeof materializePublishedCompleteSite>>;
    controls: Awaited<ReturnType<typeof authenticateReleaseControlSource>>;
    reader: Awaited<ReturnType<typeof authenticateControlReaderJob>>;
    repository: string;
    namespace: string;
    checkpoint: string;
    deadline: number;
    seed: NonNullable<ReturnType<typeof inspectPublishedMetadata>>;
    descriptor_sha256: string;
    control_facts_sha256: string;
  }
>();
const project = fileURLToPath(new URL("..", import.meta.url));
function coordinatorDeadline() {
  const monotonicStart = performance.now();
  const monotonicDeadline = monotonicStart + 170000;
  const deadline = Date.now() + 170000;
  return {
    deadline,
    monotonicDeadline,
    remaining(maximum = 170000) {
      const left = Math.floor(
        Math.min(deadline - Date.now(), monotonicDeadline - performance.now(), maximum),
      );
      if (left < 1) throw new Error("coordinator attempt deadline exhausted; no subsequent effect");
      return left;
    },
    check() {
      if (Date.now() >= deadline || performance.now() - monotonicStart >= 170000)
        throw new Error("coordinator attempt deadline exhausted; no subsequent effect");
    },
  };
}
function coordinatorApi(
  directory: string,
  budget: ReturnType<typeof coordinatorDeadline>,
  maxBuffer: number,
) {
  return new GitHubApiClient((args, input) => {
    const result = createGitHubRunner({
      cwd: directory,
      maxBuffer,
      timeoutMs: budget.remaining(15000),
    })([...args, "--hostname", "github.com"], input);
    budget.check();
    return result;
  });
}
function guardedCoordinatorJournal(
  directory: string,
  budget: ReturnType<typeof coordinatorDeadline>,
  beforeMutation: () => void,
) {
  const journal = createCoordinatorJournalApi(directory, budget.monotonicDeadline);
  return {
    request: (...args: Parameters<typeof journal.request>) => {
      budget.check();
      return journal.request(...args);
    },
    graphql: (...args: Parameters<typeof journal.graphql>) => {
      budget.check();
      if (/^\s*mutation\b/u.test(args[0])) {
        beforeMutation();
        budget.check();
      }
      return journal.graphql(...args);
    },
  };
}

/** Provider inventory facts only. Every Release is available in Preview; using
 * their latest publication as an explicitly typed upper bound can delay a
 * routine Preview, but never bypass its actual cadence. No urgency is inferred. */
export function deriveCoordinatorPublication(
  tags: Awaited<ReturnType<Reader["tags"]>>,
  releases: ReturnType<Reader["releases"]>,
  allocations: ReturnType<Reader["readAllocations"]>["allocations"],
  now: string,
  active?: unknown,
) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    throw new Error("canonical coordinator publication clock required");
  const versions = new Set<string>();
  const sources = new Set<string>();
  if (active != null) {
    if (!isRecord(active)) throw new Error("active reservation identity invalid");
    const matches = allocations.filter((entry) => entry.version === active.version);
    if (
      matches.length !== 1 ||
      Object.entries(matches[0]!).some(([key, value]) => active[key] !== value)
    )
      throw new Error("active reservation differs from complete immutable allocation receipts");
  }
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
      .filter((a) => !versions.has(a.version) || (isRecord(active) && a.version === active.version))
      .map((a) => a.version)
      .sort(),
    last_routine_preview_at: latest === null ? null : new Date(latest).toISOString(),
    last_routine_preview_bound: "all-published-previews",
  };
}

/** The existing semantic baseline is the uniquely latest actual publication;
 * it must also be the highest published version before reserving a successor.
 * An out-of-order historical publication remains an explicit hold. */
export function selectCoordinatorPublicationBaseline(
  releases: ReturnType<Reader["releases"]>,
  publishedVersions: readonly string[],
) {
  const highest = [...publishedVersions].sort(compareApplicationVersionPrecedence).at(-1);
  const rows = releases.filter((release) => !release.draft);
  if (!highest || rows.length === 0)
    throw new Error("actual published application baseline absent; explicit setup required");
  let latest: (typeof rows)[number] | null = null;
  let latestTime = -Infinity;
  for (const release of rows) {
    const time = release.published_at === null ? NaN : Date.parse(release.published_at);
    if (!Number.isFinite(time)) throw new Error("published baseline time unavailable");
    if (time > latestTime) {
      latest = release;
      latestTime = time;
    }
  }
  if (
    rows.filter((release) => Date.parse(release.published_at ?? "") === latestTime).length !== 1 ||
    !latest ||
    latest.tag_name !== `v${highest}`
  )
    throw new Error("highest application version differs from unique latest published baseline");
  return { release: latest, version: highest };
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
  const budget = coordinatorDeadline();
  return withCoordinatorDeadline(budget.monotonicDeadline, () =>
    coordinateTrustedReleaseAt(privateParent, raw, undefined, budget),
  );
}

type RecoveredCoordinatorRound = {
  directory: string;
  budget: ReturnType<typeof coordinatorDeadline>;
  recovered: Awaited<ReturnType<typeof recoverRemoteCoordinator>>;
  admission?: {
    workflow: Awaited<ReturnType<typeof readProductionControllerWorkflowBytes>>;
    reader: Awaited<ReturnType<typeof authenticateControlReaderJob>>;
    controls: Awaited<ReturnType<typeof authenticateReleaseControlSource>>;
    request: NonNullable<ReturnType<typeof inspectReleaseReviewRequest>>;
  };
};

async function coordinateTrustedReleaseAt(
  privateParent: string,
  raw: Parameters<typeof coordinateTrustedRelease>[1],
  round?: RecoveredCoordinatorRound,
  inheritedBudget?: ReturnType<typeof coordinatorDeadline>,
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
  if (!round) await assertOwnedUnlinkedPath(project, privateParent, "coordinator private parent");
  const directory =
    round?.directory ?? (await mkdtemp(path.join(privateParent, "coordinator-attempt-")));
  const budget = round?.budget ?? inheritedBudget ?? coordinatorDeadline();
  let phase = "remote-recovery";
  let checkpoint: string | null = null;
  try {
    const api = coordinatorApi(directory, budget, 16 * 1024 * 1024);
    let recovered =
      round?.recovered ??
      (await recoverRemoteCoordinator(directory, selected.remote_configuration, {
        transport: { cwd: directory, deadline: budget.monotonicDeadline },
      }));
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
    const workflow = round?.admission?.workflow ?? (await readProductionControllerWorkflowBytes());
    const reader =
      round?.admission?.reader ??
      (await authenticateControlReaderJob(process.env, workflow, {
        phase: "coordinator",
        deadline: budget.monotonicDeadline,
      }));
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
        budget.monotonicDeadline,
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
      recovered.input.active_candidate,
    );
    const factsSha = capacityDigest({ opportunity, publication, checkpoint });
    const ready = prepareControlReadiness(reader.identity, factsSha, "coordinator");
    if (!round?.admission)
      await writeFile(
        path.join(directory, "ready-coordinator.json"),
        `${JSON.stringify(ready)}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    phase = "actual-coordinator-control-observation";
    const artifact = round?.admission
      ? undefined
      : await waitForControlArtifact(
          directory,
          "observation",
          {
            phase: "coordinator",
            controller_revision: reader.admitted.revision,
            controller_ref: reader.admitted.execution_ref,
            run_id: String(reader.admitted.run_id),
            run_attempt: reader.admitted.run_attempt,
          },
          { deadline: budget.deadline, phaseDeadline: budget.monotonicDeadline },
        );
    const controls =
      round?.admission?.controls ??
      (await authenticateReleaseControlSource(process.env, workflow, {
        phase: "coordinator",
        deadline: budget.monotonicDeadline,
        ...(artifact ? { observedArtifact: artifact } : {}),
      }));
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
            ? await readPreparedReleaseCandidate(
                candidate,
                Number(known[1]),
                token,
                fetch,
                budget.monotonicDeadline,
              )
            : await discoverPreparedReleaseCandidate(
                candidate,
                token,
                fetch,
                budget.monotonicDeadline,
              );
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
      budget.check();
      if (
        capacityDigest({ tags: inventory.tags(), releases: inventory.releases() }) !==
        expectedInventory
      )
        throw new Error("complete publication inventory changed during coordinator admission");
      const current = await readRemoteCoordinatorSnapshot(
        directory,
        selected.remote_configuration,
        { transport: { cwd: directory, deadline: budget.monotonicDeadline } },
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
    const journal = guardedCoordinatorJournal(directory, budget, () => {
      readSynchronousBoundary();
    });
    const readSynchronousBoundary = () => {
      budget.check();
      if (round?.admission) {
        const exact = controls.readRequest(api, round.admission.request).classification;
        if (
          exact.status !== "reviewed" ||
          capacityDigest(exact.opportunity) !== capacityDigest(opportunity)
        )
          throw new Error("accepted request changed or acquired contradictory disposition");
      }
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
    const readBoundary = async () => readSynchronousBoundary();
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
      if (
        !isRecord(input.publication) ||
        !Array.isArray(input.publication.reserved_versions) ||
        input.publication.reserved_versions.some((version: unknown) => typeof version !== "string")
      )
        throw new Error("complete publication disappeared");
      const reserved = input.publication.reserved_versions.map((version: unknown) => {
        if (typeof version !== "string") throw new Error("complete reservation identity absent");
        return version;
      });
      input.publication.reserved_versions = [...new Set([...reserved, prepared.version])].sort(
        (left, right) => (left < right ? -1 : left > right ? 1 : 0),
      );
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
        fetch,
        budget.monotonicDeadline,
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
            fetch,
            budget.monotonicDeadline,
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
  const budget = coordinatorDeadline();
  return withCoordinatorDeadline(budget.monotonicDeadline, () =>
    prepareTrustedCoordinatorRenewalAt(privateParent, raw, undefined, budget),
  );
}

async function prepareTrustedCoordinatorRenewalAt(
  privateParent: string,
  raw: Parameters<typeof prepareTrustedCoordinatorRenewal>[1],
  round?: RecoveredCoordinatorRound,
  inheritedBudget?: ReturnType<typeof coordinatorDeadline>,
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
  const directory =
    round?.directory ?? (await mkdtemp(path.join(privateParent, "coordinator-renewal-")));
  const budget = round?.budget ?? inheritedBudget ?? coordinatorDeadline();
  let checkpoint: string | null = null;
  let phase = "remote-recovery";
  try {
    const recovered =
      round?.recovered ??
      (await recoverRemoteCoordinator(directory, selected.remote_configuration, {
        transport: { cwd: directory, deadline: budget.monotonicDeadline },
      }));
    checkpoint = recovered.checkpoint;
    if (coordinatorHasUnresolvedEffect(recovered.input))
      return { decision: "held-unresolved-effect", directory, checkpoint, authority: "none" };
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
      { deadline: budget.monotonicDeadline },
    );
    const tools = await verifiedControllerToolPaths(receipt);
    const workflow = await readProductionControllerWorkflowBytes();
    const reader = await authenticateControlReaderJob(process.env, workflow, {
      phase: "coordinator",
      deadline: budget.monotonicDeadline,
    });
    const authorities = await requireControllerReleaseAuthorities("coordinator");
    if (authorities.namespace !== inspectCoordinatorRemoteNamespace(selected.remote_configuration))
      throw new Error("metadata coordinator authority namespace differs");
    if (
      tools.identity.controller_revision !== reader.admitted.revision ||
      tools.identity.controller_ref !== reader.admitted.execution_ref ||
      tools.identity.run_id !== String(reader.admitted.run_id) ||
      tools.identity.run_attempt !== reader.admitted.run_attempt
    )
      throw new Error("metadata verifier tools differ from actual current coordinator");
    const siteReceipt = await materializePublishedCompleteSite(
      {
        site_generation_sha256: published.publication.site_generation_sha256,
        root_sha256: published.root_sha256,
        repository_sha256: published.repository_sha256,
      },
      directory,
      budget.monotonicDeadline,
    );
    const component = await requirePublishedCompleteSite(siteReceipt);
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
      previous_repository: component.application,
      prior_repository_sha256: published.repository_sha256,
      generated_at: generatedAt,
      output_parent: directory,
      deadline: budget.monotonicDeadline,
    });
    const prepared = await inspectPreparedMetadataRenewal(preparation);
    const api = coordinatorApi(directory, budget, 2 * 1024 * 1024);
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
      recovered.input.active_candidate,
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
    const artifact = await waitForControlArtifact(
      directory,
      "observation",
      {
        phase: "coordinator",
        controller_revision: reader.admitted.revision,
        controller_ref: reader.admitted.execution_ref,
        run_id: String(reader.admitted.run_id),
        run_attempt: reader.admitted.run_attempt,
      },
      { deadline: budget.deadline, phaseDeadline: budget.monotonicDeadline },
    );
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      deadline: budget.monotonicDeadline,
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
    const frozenController = recovered.input.controller;
    const input = structuredClone(recovered.input);
    input.schema_version = 2;
    input.now = new Date().toISOString();
    input.publication = { ...publication, observed_at: input.now };
    input.metadata_renewal = prepared.descriptor;
    input.controller = {
      ...frozenController,
      publication_paused: initial.pause.publication_paused,
      capacity_attempt: {
        ...initial.capacity_source.capacity,
        schema_version: 2,
        operation: structuredClone(oldCapacity.operation),
        prior_operations: structuredClone(oldCapacity.prior_operations),
      },
    };
    const plan = planReleaseOpportunity(input);
    if (
      !isRecord(input.controller) ||
      input.controller.publication_paused ||
      assessBoundedCapacity(input.controller.capacity_attempt).eligibility !== "eligible"
    )
      return { decision: "held", directory, checkpoint, plan, authority: "none" };
    await verifiedControllerToolPaths(receipt);
    await inspectPreparedMetadataRenewal(preparation);
    const current = await readRemoteCoordinatorSnapshot(directory, selected.remote_configuration, {
      transport: { cwd: directory, deadline: budget.monotonicDeadline },
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
    budget.check();
    const saved = await checkpointReleaseOpportunity(recovered.repository, checkpoint, input);
    checkpoint = saved.checkpoint;
    await publishCoordinatorCheckpoint(
      recovered.repository,
      checkpoint,
      selected.remote_configuration,
      {
        api: guardedCoordinatorJournal(directory, budget, () => {
          if (controls.readMaintenance(api).facts_sha256 !== initial.facts_sha256)
            throw new Error("maintenance controls changed immediately before journal CAS");
        }),
      },
    );
    const result = Object.freeze({
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
    });
    metadataPreparations.set(result, {
      preparation,
      tools: receipt,
      complete_site: siteReceipt,
      controls,
      reader,
      repository: recovered.repository,
      namespace: authorities.namespace,
      checkpoint,
      deadline: budget.monotonicDeadline,
      seed: structuredClone(published),
      descriptor_sha256: capacityDigest(prepared.descriptor),
      control_facts_sha256: initial.facts_sha256,
    });
    return result;
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

/** Same-process continuation for the fixed coordinator context producer. Public
 * JSON output and a copied descriptor cannot reconstruct any of these brands.
 * The original role deadline continues across the context/upload handoff. */
export async function requireActualCoordinatorMetadataPreparation(result: object) {
  const retained = metadataPreparations.get(result);
  if (!retained) throw new Error("actual same-process coordinator metadata preparation required");
  return withCoordinatorDeadline(retained.deadline, async () => {
    await verifiedControllerToolPaths(retained.tools);
    const prepared = await inspectPreparedMetadataRenewal(retained.preparation);
    const site = await requirePublishedCompleteSite(retained.complete_site);
    if (
      capacityDigest(prepared.descriptor) !== retained.descriptor_sha256 ||
      site.pins.site_generation_sha256 !== retained.seed.publication.site_generation_sha256 ||
      site.pins.root_sha256 !== retained.seed.root_sha256 ||
      site.pins.repository_sha256 !== retained.seed.repository_sha256
    )
      throw new Error("coordinator metadata public inputs changed");
    const current = await recoverReleaseOpportunity(retained.repository, retained.checkpoint);
    if (
      capacityDigest(current.input.published_metadata) !== capacityDigest(retained.seed) ||
      capacityDigest(current.input.metadata_renewal) !== retained.descriptor_sha256 ||
      coordinatorHasUnresolvedEffect(current.input)
    )
      throw new Error("coordinator metadata seed or checkpoint changed");
    const remaining = () =>
      Math.max(1, Math.floor(Math.min(15000, retained.deadline - performance.now())));
    const api = new GitHubApiClient((args, input) => {
      if (performance.now() >= retained.deadline)
        throw new Error("coordinator metadata phase deadline exhausted");
      const response = createGitHubRunner({
        cwd: retained.repository,
        maxBuffer: 256 * 1024,
        timeoutMs: remaining(),
      })([...args, "--hostname", "github.com"], input);
      if (performance.now() >= retained.deadline)
        throw new Error("coordinator metadata phase deadline exhausted");
      return response;
    });
    const fresh = retained.controls.readMaintenance(api);
    if (fresh.pause.publication_paused || fresh.facts_sha256 !== retained.control_facts_sha256)
      throw new Error("coordinator maintenance controls changed before continuation");
    await readPublicApplicationSiteMarker(site.generation, retained.deadline);
    const remote = await readRemoteCoordinatorSnapshot(
      retained.repository,
      { schema_version: 1, namespace: retained.namespace },
      { transport: { cwd: retained.repository, deadline: retained.deadline } },
    );
    if (remote.checkpoint !== retained.checkpoint)
      throw new Error("remote coordinator metadata checkpoint changed");
    if (retained.controls.readMaintenance(api).facts_sha256 !== retained.control_facts_sha256)
      throw new Error("coordinator maintenance controls changed after readback");
    return Object.freeze({
      mode: "renewal" as const,
      preparation: retained.preparation,
      tools: retained.tools,
      complete_site: retained.complete_site,
      controls: retained.controls,
      reader: retained.reader,
      repository: retained.repository,
      namespace: retained.namespace,
      checkpoint: retained.checkpoint,
      deadline: retained.deadline,
    });
  });
}

/** Scheduling only; the actual fixed tool must authenticate the public feed
 * before a descriptor can enter the journal. A retained unfinished descriptor
 * takes precedence over choosing another controller clock. */
export function selectCoordinatorMetadataRenewal(input: Record<string, unknown>, now: string) {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new Error("metadata scheduling clock unavailable");
  const published = inspectPublishedMetadata(input.published_metadata);
  if (!published) return "unconfigured" as const;
  const retained =
    input.metadata_renewal == null
      ? null
      : inspectMetadataRenewalDescriptor(input.metadata_renewal);
  if (retained?.prior_repository_sha256 === published.repository_sha256) return "resume" as const;
  return Date.parse(published.expires.timestamp) <= time + 24 * 60 * 60 * 1000
    ? ("due" as const)
    : ("not-due" as const);
}

function coordinatorHasUnresolvedEffect(input: Record<string, unknown>) {
  const capacity =
    isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
      ? input.controller.capacity_attempt
      : null;
  const operation = inspectCapacityOperation(capacity?.operation ?? null);
  return operation !== null && !["succeeded", "recovered"].includes(operation.outcome);
}

/** Freeze one neutral work request in the existing journal. While a candidate
 * or request is outstanding the current provider main head merely coalesces;
 * no second queue, semantic assertion or speculative version is created. */
export async function requestTrustedSemanticReview(
  privateParent: string,
  raw: {
    remote_configuration: unknown;
    tools?: Parameters<typeof prepareTrustedCoordinatorRenewal>[1]["tools"];
  },
) {
  const budget = coordinatorDeadline();
  return withCoordinatorDeadline(budget.monotonicDeadline, () =>
    requestTrustedSemanticReviewAt(privateParent, raw, budget),
  );
}
async function requestTrustedSemanticReviewAt(
  privateParent: string,
  raw: Parameters<typeof requestTrustedSemanticReview>[1],
  budget: ReturnType<typeof coordinatorDeadline>,
) {
  const selected = structuredClone(raw);
  if (
    !["remote_configuration", "remote_configuration,tools"].includes(
      Object.keys(selected).sort().join(","),
    )
  )
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
      transport: { cwd: directory, deadline: budget.monotonicDeadline },
    });
    checkpoint = recovered.checkpoint;
    const renewal = selectCoordinatorMetadataRenewal(recovered.input, new Date().toISOString());
    if (["due", "resume"].includes(renewal)) {
      if (coordinatorHasUnresolvedEffect(recovered.input))
        return {
          decision: "held-unresolved-effect",
          directory,
          checkpoint,
          renewal,
          authority: "none",
        };
      if (!selected.tools)
        return {
          decision: "held-renewal-tools",
          directory,
          checkpoint,
          renewal,
          authority: "none",
        };
      return prepareTrustedCoordinatorRenewalAt(
        directory,
        { remote_configuration: selected.remote_configuration, tools: selected.tools },
        { directory, budget, recovered },
      );
    }
    const outstanding = inspectReleaseReviewRequest(recovered.input.review_request);
    if (outstanding)
      return continueTrustedSemanticReview(
        directory,
        selected.remote_configuration,
        recovered,
        budget,
      );
    if (isRecord(recovered.input.active_candidate)) {
      phase = "actual-active-resumption-authority";
      const authorities = await requireControllerReleaseAuthorities("coordinator");
      if (authorities.namespace !== namespace)
        throw new Error("active coordinator authority namespace differs");
      return coordinateTrustedReleaseAt(
        directory,
        {
          remote_configuration: selected.remote_configuration,
          opportunity: validateOpportunity(recovered.input.opportunity),
          dispatch_actor_id: authorities.apps.dispatch.actor_id,
        },
        { directory, budget, recovered },
      );
    }
    const api = coordinatorApi(directory, budget, 16 * 1024 * 1024);
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
    phase = "complete-publication-baseline-and-source";
    const inventory = createReleasePublicationReader(api);
    const tags = inventory.tags();
    const releases = inventory.releases();
    const { allocations } = inventory.readAllocations(tags, namespace);
    const now = new Date().toISOString();
    const publication = deriveCoordinatorPublication(tags, releases, allocations, now);
    const { release: baselineRelease, version: baseVersion } = selectCoordinatorPublicationBaseline(
      releases,
      publication.published_versions,
    );
    const baseline = tags.find((ref) => ref.name === `v${baseVersion}`);
    if (!baseline) throw new Error("published baseline tag absent");
    const baselinePrepared = peelReleaseReference(baseline);
    const publishedCommit = api.request(
      "GET",
      `repos/boburning/portcove/git/commits/${baselinePrepared}`,
    );
    if (
      publishedCommit.status !== 200 ||
      !isRecord(publishedCommit.body) ||
      !isRecord(publishedCommit.body.tree) ||
      typeof publishedCommit.body.tree.sha !== "string"
    )
      throw new Error("published baseline tree unavailable");
    const sourceProof = inspectPublishedApplicationSource(api, selected.remote_configuration, {
      id: baselineRelease.id,
      version: baseVersion,
      prepared_commit: baselinePrepared,
      prepared_tree: publishedCommit.body.tree.sha,
    });
    const base = sourceProof.source_baseline.commit;
    if (source === base) {
      return {
        decision: "unchanged-published-source",
        directory,
        checkpoint,
        renewal,
        authority: "none",
      };
    }
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
      deadline: budget.monotonicDeadline,
    });
    await writeFile(
      path.join(directory, "ready-coordinator.json"),
      `${JSON.stringify(prepareControlReadiness(reader.identity, request.request_id, "coordinator"))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    phase = "actual-neutral-request-controls";
    const artifact = await waitForControlArtifact(
      directory,
      "observation",
      {
        phase: "coordinator",
        controller_revision: reader.admitted.revision,
        controller_ref: reader.admitted.execution_ref,
        run_id: String(reader.admitted.run_id),
        run_attempt: reader.admitted.run_attempt,
      },
      { deadline: budget.deadline, phaseDeadline: budget.monotonicDeadline },
    );
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      deadline: budget.monotonicDeadline,
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
    const disposition = advanceReleaseReviewRecovery(
      recovered.input.review_disposition,
      request,
      input.publication,
    );
    if (Object.hasOwn(input, "review_disposition") || disposition !== null)
      input.review_disposition = disposition;
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
      transport: { cwd: directory, deadline: budget.monotonicDeadline },
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
    budget.check();
    const result = await checkpointReleaseOpportunity(recovered.repository, checkpoint, input);
    checkpoint = result.checkpoint;
    await publishCoordinatorCheckpoint(
      recovered.repository,
      checkpoint,
      selected.remote_configuration,
      {
        api: guardedCoordinatorJournal(directory, budget, () => {
          if (controls.readMaintenance(api).facts_sha256 !== observed.facts_sha256)
            throw new Error("neutral request controls changed immediately before journal CAS");
        }),
      },
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

/** Resolve the exact outstanding request through current authenticated controls.
 * Accepted persisted records enter the existing coordinator using this same
 * recovered bare repository, observer and deadline. Only genuinely missing
 * records can take the separate negative retirement path. */
async function continueTrustedSemanticReview(
  directory: string,
  remoteConfiguration: unknown,
  recovered: Awaited<ReturnType<typeof recoverRemoteCoordinator>>,
  budget: ReturnType<typeof coordinatorDeadline>,
) {
  let checkpoint: string = recovered.checkpoint;
  let phase = "actual-negative-semantic-controls";
  try {
    const request = inspectReleaseReviewRequest(recovered.input.review_request);
    if (!request) throw new Error("no outstanding exact semantic request to retire");
    const api = coordinatorApi(directory, budget, 2 * 1024 * 1024);
    const workflow = await readProductionControllerWorkflowBytes();
    const reader = await authenticateControlReaderJob(process.env, workflow, {
      phase: "coordinator",
      deadline: budget.monotonicDeadline,
    });
    await writeFile(
      path.join(directory, "ready-coordinator.json"),
      `${JSON.stringify(prepareControlReadiness(reader.identity, capacityDigest({ request, checkpoint }), "coordinator"))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    phase = "actual-negative-semantic-controls";
    const artifact = await waitForControlArtifact(
      directory,
      "observation",
      {
        phase: "coordinator",
        controller_revision: reader.admitted.revision,
        controller_ref: reader.admitted.execution_ref,
        run_id: String(reader.admitted.run_id),
        run_attempt: reader.admitted.run_attempt,
      },
      { deadline: budget.deadline, phaseDeadline: budget.monotonicDeadline },
    );
    const controls = await authenticateReleaseControlSource(process.env, workflow, {
      phase: "coordinator",
      deadline: budget.monotonicDeadline,
      observedArtifact: artifact,
    });
    const reviewed = controls.readRequest(api, request);
    if (reviewed.classification.status === "reviewed") {
      const authorities = await requireControllerReleaseAuthorities("coordinator");
      if (
        authorities.namespace !== inspectCoordinatorRemoteNamespace(remoteConfiguration) ||
        reviewed.pause.publication_paused
      )
        throw new Error("accepted request authority namespace or pause differs");
      budget.check();
      return coordinateTrustedReleaseAt(
        directory,
        {
          remote_configuration: remoteConfiguration,
          opportunity: reviewed.classification.opportunity,
          dispatch_actor_id: authorities.apps.dispatch.actor_id,
        },
        { directory, budget, recovered, admission: { workflow, reader, controls, request } },
      );
    }
    const observed = controls.readDisposition(api, request);
    if (
      observed.pause.publication_paused ||
      !observed.resource_policy_matches_controller ||
      !isRecord(observed.capacity_source.capacity) ||
      !isRecord(recovered.input.controller) ||
      !isRecord(recovered.input.controller.capacity_attempt) ||
      recovered.input.controller.capacity_attempt.schema_version !== 2
    )
      throw new Error("semantic retirement controls/capacity remain held");
    const priorCapacity = recovered.input.controller.capacity_attempt;
    const input = structuredClone(recovered.input);
    input.schema_version = 2;
    input.now = new Date().toISOString();
    input.review_request = null;
    input.review_disposition = createReleaseReviewDispositionReceipt(
      observed.disposition,
      checkpoint,
      input.review_disposition,
    );
    input.controller = {
      workflow: ".github/workflows/application-update-production.yml",
      revision: reader.admitted.revision,
      publication_paused: observed.pause.publication_paused,
      capacity_attempt: {
        ...observed.capacity_source.capacity,
        schema_version: 2,
        operation: structuredClone(priorCapacity.operation),
        prior_operations: structuredClone(priorCapacity.prior_operations),
      },
    };
    const fresh = controls.readDisposition(api, request);
    const current = await readRemoteCoordinatorSnapshot(directory, remoteConfiguration, {
      transport: { cwd: directory, deadline: budget.monotonicDeadline },
    });
    budget.check();
    if (fresh.facts_sha256 !== observed.facts_sha256 || current.checkpoint !== checkpoint)
      throw new Error("negative semantic/control/checkpoint identity changed before retirement");
    phase = "durable-negative-semantic-retirement";
    const saved = await checkpointReleaseOpportunity(recovered.repository, checkpoint, input);
    checkpoint = saved.checkpoint;
    await publishCoordinatorCheckpoint(recovered.repository, checkpoint, remoteConfiguration, {
      api: guardedCoordinatorJournal(directory, budget, () => {
        if (controls.readDisposition(api, request).facts_sha256 !== observed.facts_sha256)
          throw new Error("semantic disposition/controls changed immediately before journal CAS");
      }),
    });
    return {
      decision: "negative-review-retired",
      directory,
      checkpoint,
      review_disposition: input.review_disposition,
      authority: "none",
      automatic_retry: false,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "negative semantic retirement stopped; retain exact request/checkpoint",
      {
        directory,
        checkpoint,
        phase,
        retained_error: error instanceof CoordinatorRemoteError ? error.evidence : null,
        authority: "none",
        automatic_retry: false,
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
      ["remote_configuration", "remote_configuration,tools"].includes(
        Object.keys(selection).sort().join(","),
      )
        ? await requestTrustedSemanticReview(path.resolve(directory), {
            remote_configuration: selection.remote_configuration,
            ...(selection.tools === undefined
              ? {}
              : {
                  tools: selection.tools as Parameters<
                    typeof prepareTrustedCoordinatorRenewal
                  >[1]["tools"],
                }),
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
