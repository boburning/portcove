import { coordinatorJobBudgetMilliseconds } from "./release-control-phases.mts";
import {
  authenticateCapacityExecutor,
  authenticateOwnedCheckpointJournalHistory,
  ensureOwnedCheckpointJournalHistory,
  publishOwnedSignedCoordinatorCheckpoint,
} from "./release-capacity-executor.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import {
  inspectCatalogReviewDisposition,
  advanceCatalogReviewRecovery,
  receiveActualCatalogReviewDisposition,
  requireActualCatalogReviewDisposition,
  prepareActualCatalogReviewRetirement,
} from "./release-catalog-review-disposition.mts";
/** Actual catalog coordinator entry. Candidate Git/JSON is inert; only existing
 * actual configuration, controls, tool/Core and semantic factories release keys. */
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { fixedReleaseReaderToken } from "./release-readonly-child-environment.mts";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandDeadline,
} from "./release-coordinator-deadline.mts";
import {
  readOriginalCoordinatorJobDeadline,
  catalogCoordinatorMaintenanceIdentity,
  deriveCoordinatorPublication,
  prepareActualCoordinatorCatalogSigning,
} from "./release-coordinator-driver.mts";
import { continueActualCatalogPublication } from "./release-catalog-recovery.mts";
import { completeCoordinatorCatalogSigningContext } from "./release-catalog-signing-context.mts";
import {
  requireControllerCatalogCoordinatorAuthorities,
  assertControllerCatalogPublisherScope,
} from "./release-authority-configuration.mts";
import {
  authenticateCatalogControlReaderJob,
  authenticateCatalogReleaseControlSource,
  requireAuthenticatedCatalogControlSource,
} from "./release-live-control-admission.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import {
  materializeCatalogPublicationSource,
  readCatalogPublicationSourceBytesAsync,
} from "./release-catalog-source.mts";
import {
  inspectActualCatalogPublication,
  requireActualCatalogInspection,
  readCatalogPublicationBundle,
} from "./release-catalog-inspection.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import { inspectCatalogInitialization } from "./release-catalog-publication-contract.mts";
import {
  assertStandaloneBootstrapAdoptionCapacity,
  authenticateStandaloneBootstrapAdoption,
} from "./release-catalog-bootstrap-adoption.mts";
import { standaloneBootstrapAdoption } from "./release-metadata-contract.mts";
import {
  currentPublishedSite,
  inspectPublishedCatalogMetadata,
} from "./release-catalog-metadata-contract.mts";
import {
  inspectCatalogReviewRequest,
  createCatalogReviewRequest,
  assertCatalogReviewRequestBaseline,
} from "./release-catalog-review-request.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
  inspectRemoteCommitObject,
} from "./release-coordinator-recovery.mts";
import {
  inspectCoordinatorRemoteNamespace,
  publishCoordinatorCheckpoint,
} from "./release-coordinator-remote.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { retainedCatalogBootstrapClaim } from "./release-coordinator-checkpoint-authentication.mts";
import { checkpointReleaseOpportunity } from "./release-coordinator-state.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import { collectReleaseSourceChangesWithSdk } from "./release-source-changes.mts";
import { createPublicationInventoryWithSdk } from "./release-publication-inventory.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import {
  readIndependentCatalogSemanticCheckInventoryWithSdk,
  discoverIndependentCatalogSemanticDispositionWithSdk,
  inspectCatalogSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { prepareControlReadiness, waitForControlArtifact } from "./release-control-handshake.mts";
import {
  retainControlStepLocator,
  retainCatalogCoordinatorRefusal,
  inspectCatalogCheckpointRefusal,
  type CatalogCoordinatorRefusalStage,
} from "./release-control-step-bridge.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isApplicationReviewReleaseTag } from "./release-review-request.mts";
const project = fileURLToPath(new URL("..", import.meta.url));
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("fixed catalog coordinator invocation fields differ");
}
/** Inert shape only; the actual tool receiver and protected configuration own authority. */
export function inspectFixedCatalogCoordinatorConfiguration(raw: unknown) {
  const input: unknown = structuredClone(raw);
  exact(input, "remote_configuration,tools");
  inspectCoordinatorRemoteNamespace(input.remote_configuration);
  exact(input.tools, "artifact,bundle");
  exact(
    input.tools.artifact,
    "artifact_id,controller_ref,controller_revision,run_attempt,run_id,sha256,source_tree",
  );
  exact(input.tools.bundle, "artifact_id,sha256");
  return {
    remote_configuration: input.remote_configuration as { schema_version: 1; namespace: string },
    tools: input.tools as unknown as {
      artifact: ControllerToolArtifactExpected;
      bundle: { artifact_id: number; sha256: string };
    },
  };
}
function held(directory: string, checkpoint: string, reason: string) {
  return {
    decision: "held" as const,
    mode: "catalog" as const,
    directory,
    checkpoint,
    reason,
    authority: "none" as const,
    automatic_retry: false,
  };
}
function unresolved(input: Record<string, unknown>) {
  const capacity =
    isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
      ? input.controller.capacity_attempt
      : null;
  const operation = inspectCapacityOperation(capacity?.operation ?? null);
  return (
    operation !== null &&
    (!["succeeded", "recovered"].includes(operation.outcome) ||
      (operation.outcome === "recovered" &&
        operation.recovery?.resolution === "partial-effects-retained"))
  );
}

/** Integrity-only complete-op construction. No source, Core, semantic or policy
 * authority is created by this projection; the actual caller establishes each. */
export function deriveCatalogCoordinatorOpportunity(
  source: { commit: string; tree: string },
  inspection: {
    inspection: Record<string, unknown>;
    bundle_sha256: string;
    inspection_sha256: string;
  },
  input: Record<string, unknown>,
  configuration: {
    configuration_sha256: string;
    catalog: { public_source: { commit: string; root: { sha256: string } } };
  },
  initial: { commit: string; tree: string; root_sha256: string },
  changeSet: string,
  compatibility: unknown,
) {
  const seed = inspectPublishedCatalogMetadata(input.published_catalog_metadata),
    site = currentPublishedSite(input);
  const baseline = seed
    ? { commit: seed.source_commit, tree: seed.source_tree, root_sha256: seed.root_sha256 }
    : initial;
  return inspectCatalogSemanticOpportunity({
    kind: "catalog-publication",
    source_commit: source.commit,
    source_tree: source.tree,
    base_commit: baseline.commit,
    change_set_sha256: changeSet,
    bundle_sha256: inspection.bundle_sha256,
    core_inspection_sha256: inspection.inspection_sha256,
    publisher_configuration_sha256: configuration.configuration_sha256,
    baseline: {
      source_commit: baseline.commit,
      source_tree: baseline.tree,
      catalog_root_sha256: baseline.root_sha256,
      catalog_repository_sha256: seed?.repository_sha256 ?? null,
      site_generation_sha256: site?.generation_sha256 ?? null,
      application_root_sha256: site?.components.application?.root_sha256 ?? null,
      application_repository_sha256: site?.components.application?.repository_sha256 ?? null,
    },
    classification: {
      change: seed ? "update" : "initial",
      definitions: inspection.inspection.definitions,
      index_sha256: inspection.inspection.index_sha256,
      ...(inspection.inspection.listings ? { listings: inspection.inspection.listings } : {}),
    },
    compatibility,
  });
}

export async function runFixedCatalogCoordinatorConfiguration(
  raw: unknown,
  parent: string,
  phaseDeadline?: number,
) {
  const selected = inspectFixedCatalogCoordinatorConfiguration(raw),
    start = performance.now();
  if (
    !path.isAbsolute(parent) ||
    (phaseDeadline !== undefined && (!Number.isFinite(phaseDeadline) || phaseDeadline <= start))
  )
    throw new Error("catalog coordinator original deadline/private parent unavailable");
  let deadline = Math.min(
    start + coordinatorJobBudgetMilliseconds,
    phaseDeadline ?? Infinity,
    coordinatorCommandDeadline() ?? Infinity,
  );
  const check = () => {
    if (performance.now() >= deadline)
      throw new Error("catalog coordinator original job budget exhausted");
  };
  await assertOwnedUnlinkedPath(project, parent, "catalog coordinator private parent");
  const directory = await mkdtemp(path.join(parent, "catalog-coordinator-"));
  const readerToken = fixedReleaseReaderToken();
  deadline = Math.min(
    deadline,
    await readOriginalCoordinatorJobDeadline(
      Math.min(deadline, performance.now() + 15000),
      16 * 1024 ** 2,
    ),
  );
  const journalTransport = { credential: { token: readerToken }, deadline };
  check();
  return withCoordinatorDeadline(deadline, async () => {
    let stage: CatalogCoordinatorRefusalStage<"operation"> = "actual-catalog-admission";
    try {
      const authorities = await requireControllerCatalogCoordinatorAuthorities();
      if (authorities.namespace !== selected.remote_configuration.namespace)
        throw new Error("catalog authority namespace differs");
      stage = "catalog-reader-identity";
      const workflow = await readProductionControllerWorkflowBytes(),
        reader = await authenticateCatalogControlReaderJob(process.env, workflow, {
          phase: "coordinator",
          deadline,
        });
      if (reader.identity.evidence_scope !== "github.com")
        throw new Error("actual catalog coordinator reader required");
      stage = "catalog-tool-custody";
      const tools = await receiveControllerTools(
          directory,
          selected.tools.artifact,
          selected.tools.bundle,
          { deadline },
        ),
        paths = await verifiedControllerToolPaths(tools);
      if (
        paths.identity.controller_revision !== reader.admitted.revision ||
        paths.identity.controller_ref !== reader.admitted.execution_ref ||
        paths.identity.run_id !== reader.admitted.run_id ||
        paths.identity.run_attempt !== reader.admitted.run_attempt
      )
        throw new Error("catalog tools/actual job association differs");
      stage = "catalog-journal-recovery";
      const recovered = await recoverRemoteCoordinator(directory, selected.remote_configuration, {
          transport: journalTransport,
        }),
        input = recovered.input;
      const checkDirectSource = () => {
        check();
        assertTrustedDirectNode("fixed catalog authoring source");
      };
      const openPublicationReader = () =>
        createPublicationInventoryWithSdk({
          token: readerToken,
          deadline,
          maxBytes: 16 * 1024 ** 2,
          recheck: async () => check(),
          beforeDispatch: checkDirectSource,
        });
      const observeControls = async (subjectSha256: string) => {
        const runId = reader.admitted.run_id;
        if (!runId) throw new Error("catalog coordinator run identity unavailable");
        const ready = path.join(directory, "ready-coordinator.json");
        await writeFile(
          ready,
          `${JSON.stringify(prepareControlReadiness(reader.identity, subjectSha256, "coordinator"))}\n`,
          { flag: "wx", mode: 0o600 },
        );
        await retainControlStepLocator(ready, "coordinator", 0);
        const observation = await waitForControlArtifact(
          directory,
          "observation",
          {
            phase: "coordinator",
            controller_revision: reader.admitted.revision,
            controller_ref: reader.admitted.execution_ref,
            run_id: runId,
            run_attempt: reader.admitted.run_attempt,
          },
          {
            deadline: Date.now() + Math.min(240000, Math.floor(deadline - performance.now())),
            phaseDeadline: deadline,
          },
        );
        const controls = await authenticateCatalogReleaseControlSource(
          { ...process.env, GH_TOKEN: readerToken },
          workflow,
          {
            phase: "coordinator",
            deadline,
            observedArtifact: observation,
            controlReader: "catalog-maintenance",
          },
        );
        requireAuthenticatedCatalogControlSource(controls, "coordinator");
        if (controls.evidence_scope !== "github.com")
          throw new Error("actual catalog controls required");
        const readMaintenance = () =>
          controls.readSdkMaintenance(undefined, { deadline, maxBytes: 16 * 1024 ** 2 });
        const observed = await readMaintenance(),
          stable = catalogCoordinatorMaintenanceIdentity(observed);
        if (
          observed.reader.job_id !== reader.identity.job_id ||
          observed.reader.check_run_id !== reader.identity.check_run_id
        )
          throw new Error("catalog controls came from another job");
        return { controls, readMaintenance, observed, stable };
      };
      const publishCheckpoint = async (
        next: Record<string, unknown>,
        checkpointControls: () => Promise<void>,
        claimedChild?: string,
      ) => {
        const executor = await authenticateCapacityExecutor(
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
          deadline,
        );
        if (claimedChild !== undefined)
          await authenticateOwnedCheckpointJournalHistory(
            executor,
            recovered.repository,
            recovered.checkpoint,
            claimedChild,
          );
        const signedJournal =
          claimedChild !== undefined ||
          (await ensureOwnedCheckpointJournalHistory(
            executor,
            recovered.repository,
            recovered.checkpoint,
            checkpointControls,
          ));
        const publishLegacy = async (checkpoint: string) => {
          const journal = createCoordinatorJournalApi(directory, deadline),
            guarded = {
              request: async (...args: Parameters<typeof journal.request>) => {
                check();
                if (args[0] !== "GET") await checkpointControls();
                const result = await journal.request(...args);
                check();
                return result;
              },
              graphql: async (...args: Parameters<typeof journal.graphql>) => {
                check();
                if (/^\s*mutation\b/u.test(args[0])) await checkpointControls();
                const result = await journal.graphql(...args);
                check();
                return result;
              },
            };
          return publishCoordinatorCheckpoint(
            recovered.repository,
            checkpoint,
            selected.remote_configuration,
            { api: guarded },
          );
        };
        const persisted = await checkpointReleaseOpportunity(
          recovered.repository,
          recovered.checkpoint,
          next,
        );
        if (claimedChild !== undefined && persisted.checkpoint !== claimedChild)
          throw new Error("reconstructed adoption differs from the retained claimed child");
        if (signedJournal)
          await publishOwnedSignedCoordinatorCheckpoint(
            executor,
            recovered.repository,
            persisted.checkpoint,
            checkpointControls,
          );
        else await publishLegacy(persisted.checkpoint);
        if (stage === "standalone-application-bootstrap-CAS")
          stage = "standalone-application-bootstrap-journal-readback";
        const readback = await readRemoteCoordinatorSnapshot(
          directory,
          selected.remote_configuration,
          { transport: journalTransport },
        );
        if (readback.checkpoint !== persisted.checkpoint)
          throw new Error("catalog journal CAS readback differs; retain original");
        return readback;
      };
      if (
        input.published_metadata == null &&
        input.metadata_bootstrap != null &&
        capacityDigest(input.metadata_bootstrap) ===
          standaloneBootstrapAdoption.abandoned_descriptor_sha256 &&
        input.active_candidate === null &&
        !unresolved(input)
      ) {
        const resumeClaim =
          reader.admitted.execution_ref === retainedCatalogBootstrapClaim.successor_ref;
        if (resumeClaim) {
          if (
            reader.admitted.run_attempt !== 1 ||
            recovered.checkpoint !== retainedCatalogBootstrapClaim.previous
          )
            throw new Error(
              "claimed bootstrap recovery requires its original predecessor and one successor attempt",
            );
          const provider = await createReleaseCustodyProvider({
            token: readerToken,
            deadline,
            maxBytes: 2 * 1024 ** 2,
            beforeDispatch: checkDirectSource,
          });
          const [run, job, child] = await Promise.all([
            provider.attempt(retainedCatalogBootstrapClaim.original_run, 1),
            provider.job(retainedCatalogBootstrapClaim.original_job),
            provider.commit(retainedCatalogBootstrapClaim.child),
          ]);
          if (
            !isRecord(run) ||
            run.id !== Number(retainedCatalogBootstrapClaim.original_run) ||
            run.run_attempt !== 1 ||
            run.event !== "workflow_dispatch" ||
            run.path !== ".github/workflows/application-update-production.yml" ||
            run.head_sha !== retainedCatalogBootstrapClaim.original_source ||
            run.head_branch !== retainedCatalogBootstrapClaim.original_ref ||
            run.status !== "completed" ||
            run.conclusion !== "failure" ||
            !isRecord(run.actor) ||
            run.actor.id !== 41898282 ||
            !isRecord(run.triggering_actor) ||
            run.triggering_actor.id !== 41898282 ||
            !isRecord(job) ||
            job.id !== retainedCatalogBootstrapClaim.original_job ||
            job.run_id !== Number(retainedCatalogBootstrapClaim.original_run) ||
            job.run_attempt !== 1 ||
            job.name !== "Coordinate application release" ||
            job.head_sha !== retainedCatalogBootstrapClaim.original_source ||
            job.status !== "completed" ||
            job.conclusion !== "failure"
          )
            throw new Error("retained claimed bootstrap producer identity differs");
          const exact = inspectRemoteCommitObject(child, retainedCatalogBootstrapClaim.child);
          if (
            exact.tree !== retainedCatalogBootstrapClaim.tree ||
            exact.parents.length !== 1 ||
            exact.parents[0] !== retainedCatalogBootstrapClaim.previous
          )
            throw new Error("retained claimed bootstrap child or parent differs");
        }
        stage = "standalone-application-bootstrap-readback";
        const { metadata, assertCurrent } = await authenticateStandaloneBootstrapAdoption(
          directory,
          tools,
          deadline,
          (next) => (stage = next),
        );
        stage = "standalone-application-bootstrap-observer";
        const { readMaintenance, observed, stable } = await observeControls(
          capacityDigest({ checkpoint: recovered.checkpoint, standalone_bootstrap: metadata }),
        );
        assertStandaloneBootstrapAdoptionCapacity(observed);
        stage = "standalone-application-bootstrap-inventory";
        const publicationReader = await openPublicationReader();
        const readInventory = async () => {
          const tags = await publicationReader.tags();
          const releases = await publicationReader.releases();
          const { allocations } = await publicationReader.readAllocations(
            tags,
            authorities.namespace,
          );
          return { tags, releases, allocations };
        };
        const inventory = await readInventory();
        const inventorySha256 = capacityDigest(inventory);
        const checkpointControls = async () => {
          check();
          const current = await readMaintenance();
          assertStandaloneBootstrapAdoptionCapacity(current);
          if (
            current.pause.publication_paused ||
            catalogCoordinatorMaintenanceIdentity(current) !== stable ||
            (await requireControllerCatalogCoordinatorAuthorities()).configuration_sha256 !==
              authorities.configuration_sha256
          )
            throw new Error(
              "catalog controls changed before standalone bootstrap journal adoption",
            );
          if (capacityDigest(await readInventory()) !== inventorySha256)
            throw new Error(
              "publication inventory changed before standalone bootstrap journal adoption",
            );
          await assertCurrent();
          check();
        };
        const now = resumeClaim ? retainedCatalogBootstrapClaim.clock : new Date().toISOString();
        const next = {
          ...input,
          now,
          publication: deriveCoordinatorPublication(
            inventory.tags,
            inventory.releases.filter((release) => isApplicationReviewReleaseTag(release.tag_name)),
            inventory.allocations,
            now,
          ),
          published_metadata: metadata,
        };
        stage = "standalone-application-bootstrap-CAS";
        const readback = await publishCheckpoint(
          next,
          checkpointControls,
          resumeClaim ? retainedCatalogBootstrapClaim.child : undefined,
        );
        if (capacityDigest(readback.input.published_metadata) !== capacityDigest(metadata))
          throw new Error("standalone bootstrap journal adoption readback differs");
        return held(
          directory,
          readback.checkpoint,
          "exact standalone application bootstrap adopted; next wake can review catalog",
        );
      }
      if (reader.admitted.execution_ref === retainedCatalogBootstrapClaim.successor_ref)
        throw new Error("claimed bootstrap recovery ref has no further operation authority");
      const pending = inspectCatalogReviewRequest(input.catalog_review_request),
        history = inspectCatalogReviewDisposition(input.catalog_review_disposition),
        replacement = !pending && history !== null;
      if (
        input.active_candidate != null ||
        input.review_request != null ||
        input.review_disposition != null ||
        input.metadata_renewal != null ||
        (input.metadata_bootstrap != null && input.published_metadata == null)
      )
        return held(
          directory,
          recovered.checkpoint,
          "existing application reservation or unresolved effect requires its existing recovery",
        );
      if (input.catalog_publication != null)
        return continueActualCatalogPublication(
          tools,
          selected.remote_configuration,
          parent,
          deadline,
        );
      if (unresolved(input))
        return held(
          directory,
          recovered.checkpoint,
          "unresolved effect requires its existing recovery",
        );
      const requireMainSource = (repo: unknown, ref: unknown) => {
        if (
          !isRecord(repo) ||
          repo.id !== 1354613114 ||
          repo.full_name !== "boburning/portcove" ||
          repo.default_branch !== "main" ||
          !isRecord(ref) ||
          ref.ref !== "refs/heads/main" ||
          !isRecord(ref.object) ||
          ref.object.type !== "commit" ||
          typeof ref.object.sha !== "string" ||
          !/^[a-f0-9]{40}$/u.test(ref.object.sha)
        )
          throw new Error("fixed default-main catalog source unavailable");
        return ref.object.sha;
      };
      const sourceProvider = await createReleaseCustodyProvider({
        token: readerToken,
        deadline,
        maxBytes: 16 * 1024 ** 2,
        beforeDispatch: checkDirectSource,
        afterRead: check,
      });
      const mainHead = async () =>
        requireMainSource(
          await sourceProvider.repository(deadline),
          await sourceProvider.mainRef(),
        );
      const sourceCommit = pending?.opportunity.source_commit ?? (await mainHead());
      stage = "fixed-inert-source-and-Core";
      const source = await materializeCatalogPublicationSource(
        sourceProvider,
        sourceCommit,
        directory,
        deadline,
      );
      if (!source.request)
        return held(
          directory,
          recovered.checkpoint,
          "no fixed catalog publication request at exact source",
        );
      const published = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
      if (!pending && published) {
        const previous = await readCatalogPublicationSourceBytesAsync(
          sourceProvider,
          published.source_commit,
          deadline,
        );
        if (!previous.request || previous.source.tree !== published.source_tree)
          return held(
            directory,
            recovered.checkpoint,
            "accepted catalog source subtree is missing or contradictory",
          );
        if (
          previous.bundle_sha256 === source.bundle_sha256 &&
          previous.request_sha256 === source.request_sha256
        )
          return held(
            directory,
            recovered.checkpoint,
            "unchanged accepted catalog bundle and authoring request",
          );
      }
      const inspectionReceipt = await inspectActualCatalogPublication({
          tools,
          source_commit: source.source.commit,
          source_tree: source.source.tree,
          bundle: source.bundle,
          output_parent: directory,
          deadline,
        }),
        inspection = await requireActualCatalogInspection(inspectionReceipt, deadline),
        files = await readCatalogPublicationBundle(inspection.bundle, deadline);
      assertControllerCatalogPublisherScope(
        authorities.configuration,
        inspection.inspection,
        files,
      );
      const pins = authorities.catalog.public_source;
      const initialCommit = inspectRemoteCommitObject(
          await sourceProvider.commit(pins.commit),
          pins.commit,
        ),
        initial = { commit: pins.commit, tree: initialCommit.tree, root_sha256: pins.root.sha256 },
        initialization = inspectCatalogInitialization(input.catalog_initialization),
        seed = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
      if (
        (!seed && input.published_metadata == null && !initialization) ||
        (initialization &&
          (initialization.source_commit !== initial.commit ||
            initialization.source_tree !== initial.tree ||
            initialization.root_sha256 !== initial.root_sha256 ||
            initialization.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
            initialization.setup_plan_sha256 !== authorities.catalog.setup_plan_sha256 ||
            initialization.initial_site_preimage_sha256 !== pins.initial_site_preimage?.sha256))
      )
        throw new Error("catalog initialization differs from actual protected setup/source");
      const changes = await collectReleaseSourceChangesWithSdk(
        {
          token: readerToken,
          deadline,
          maxBytes: 16 * 1024 ** 2,
          requestTimeoutMs: 15000,
          guard: checkDirectSource,
          catalogComparison: true,
        },
        {
          base_commit: seed?.source_commit ?? initial.commit,
          source_commit: source.source.commit,
          source_tree: source.source.tree,
        },
      );
      if (changes.base_tree !== (seed?.source_tree ?? initial.tree))
        throw new Error("catalog baseline raw Git tree differs");
      const opportunity = deriveCatalogCoordinatorOpportunity(
        source.source,
        inspection,
        input,
        authorities,
        initial,
        changes.change_set_sha256,
        source.request.compatibility,
      );
      const core = `${JSON.stringify(inspection.inspection)}\n`;
      if (
        pending &&
        (capacityDigest(pending.opportunity) !== capacityDigest(opportunity) ||
          pending.core_inspection !== core)
      )
        throw new Error(
          "frozen catalog request differs from reacquired actual source/Core/baseline",
        );
      if (pending) assertCatalogReviewRequestBaseline(pending, input);
      stage = "selected-independent-Check";
      const producer = authorities.semantic_producer;
      const request =
        pending ??
        createCatalogReviewRequest({
          before_checkpoint: recovered.checkpoint,
          requested_at: new Date().toISOString(),
          opportunity,
          core_inspection: core,
        });
      const semanticReader = {
        token: readerToken,
        deadline,
        guard: checkDirectSource,
        maxBytes: 16 * 1024 ** 2,
      };
      const inventory = await readIndependentCatalogSemanticCheckInventoryWithSdk(
          semanticReader,
          producer,
          sourceCommit,
        ),
        matches = inspectCatalogSemanticRequestCheckMatches(inventory.records, request);
      await inventory.assertUnchanged();
      if (matches.negative.length && !pending)
        return held(
          directory,
          recovered.checkpoint,
          "exact catalog negative result awaits authenticated retirement",
        );
      if (matches.accepted.length === 1 && !replacement) {
        const preparation = await prepareActualCoordinatorCatalogSigning(
          parent,
          {
            tools,
            inspection: inspectionReceipt,
            opportunity,
            check_id: matches.accepted[0]!.check_run_id,
          },
          deadline,
        );
        return completeCoordinatorCatalogSigningContext(preparation, parent, deadline);
      }
      if (pending && !matches.negative.length)
        return held(
          directory,
          recovered.checkpoint,
          "frozen catalog request awaits automatic independent semantic worker",
        );
      stage = "neutral-request-control-and-CAS";
      const { controls, readMaintenance, observed, stable } = await observeControls(
        capacityDigest({ checkpoint: recovered.checkpoint, request }),
      );
      const publicationReader = await openPublicationReader();
      const tags = await publicationReader.tags();
      const releases = await publicationReader.releases();
      const { allocations } = await publicationReader.readAllocations(tags, authorities.namespace);
      const now = new Date().toISOString(),
        publication = deriveCoordinatorPublication(tags, releases, allocations, now);
      let frozen: NonNullable<ReturnType<typeof inspectCatalogReviewRequest>> | null = null,
        negativeReceipt: object | null = null,
        negativeProof: string | null = null,
        next: Record<string, unknown>;
      if (matches.negative.length) {
        if (!pending) throw new Error("catalog negative lacks original frozen request");
        negativeReceipt = await receiveActualCatalogReviewDisposition(
          controls,
          directory,
          pending,
          recovered.checkpoint,
          deadline,
        );
        const actual = await requireActualCatalogReviewDisposition(negativeReceipt, deadline);
        negativeProof = actual.proof_sha256;
        const retirement = await prepareActualCatalogReviewRetirement(
          negativeReceipt,
          now,
          deadline,
          publication,
        );
        if (retirement.checkpoint !== recovered.checkpoint)
          throw new Error("catalog negative checkpoint differs");
        next = retirement.input;
      } else {
        frozen = createCatalogReviewRequest({
          before_checkpoint: recovered.checkpoint,
          requested_at: now,
          opportunity,
          core_inspection: core,
        });
        if (
          !isRecord(input.controller) ||
          !isRecord(input.controller.capacity_attempt) ||
          input.controller.capacity_attempt.schema_version !== 2 ||
          !isRecord(observed.capacity_source.capacity)
        )
          throw new Error("existing catalog bounded capacity checkpoint unavailable");
        next = {
          ...structuredClone(input),
          now,
          catalog_review_request: frozen,
          publication,
          ...(replacement
            ? { catalog_review_disposition: advanceCatalogReviewRecovery(history, frozen, input) }
            : {}),
          controller: replacement
            ? structuredClone(input.controller)
            : {
                workflow: ".github/workflows/application-update-production.yml",
                revision: reader.admitted.revision,
                publication_paused: observed.pause.publication_paused,
                capacity_attempt: {
                  ...observed.capacity_source.capacity,
                  schema_version: 2,
                  operation: structuredClone(input.controller.capacity_attempt.operation),
                  prior_operations: structuredClone(
                    input.controller.capacity_attempt.prior_operations,
                  ),
                },
              },
        };
        if (planReleaseOpportunity(next).action !== "catalog-review-request")
          return held(
            directory,
            recovered.checkpoint,
            "existing coordinator admission remains held",
          );
      }
      const fresh = await readRemoteCoordinatorSnapshot(directory, selected.remote_configuration, {
        transport: journalTransport,
      });
      if (fresh.checkpoint !== recovered.checkpoint)
        throw new Error("catalog journal advanced before neutral request CAS");
      await requireActualCatalogInspection(inspectionReceipt, deadline);
      await verifiedControllerToolPaths(tools);
      const current = await requireControllerCatalogCoordinatorAuthorities();
      if (current.configuration_sha256 !== authorities.configuration_sha256)
        throw new Error("catalog authority changed before neutral request CAS");
      const environment = {
        authority: process.env.PORTCOVE_CATALOG_AUTHORITIES,
        admission: process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      };
      const requireSelectedEnvironment = () => {
        if (
          process.env.PORTCOVE_CATALOG_AUTHORITIES !== environment.authority ||
          process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION !== environment.admission
        )
          throw new Error("catalog source/configuration changed before mutation");
      };
      const beforeMutation = async () => {
        check();
        requireSelectedEnvironment();
        if (!pending && (await mainHead()) !== sourceCommit)
          throw new Error("catalog source/configuration changed before mutation");
        const currentTags = await publicationReader.tags(),
          currentReleases = await publicationReader.releases(),
          { allocations: currentAllocations } = await publicationReader.readAllocations(
            currentTags,
            authorities.namespace,
          );
        if (
          capacityDigest({
            tags: currentTags,
            releases: currentReleases,
            allocations: currentAllocations,
          }) !== capacityDigest({ tags, releases, allocations })
        )
          throw new Error(
            "publication inventory/allocations changed before catalog semantic mutation",
          );
        if (negativeProof !== null) {
          if (
            !pending ||
            capacityDigest(
              await discoverIndependentCatalogSemanticDispositionWithSdk(
                semanticReader,
                producer,
                pending,
              ),
            ) !== negativeProof
          )
            throw new Error("catalog negative selected proof changed before mutation");
        }
        if (catalogCoordinatorMaintenanceIdentity(await readMaintenance()) !== stable)
          throw new Error("catalog maintenance changed before neutral request mutation");
        requireSelectedEnvironment();
        check();
      };
      const checkpointControls = async () => {
        await beforeMutation();
      };
      if (negativeReceipt) await requireActualCatalogReviewDisposition(negativeReceipt, deadline);
      const readback = await publishCheckpoint(next, checkpointControls);
      if (
        capacityDigest(inspectCatalogReviewRequest(readback.input.catalog_review_request)) !==
          capacityDigest(frozen) ||
        (negativeReceipt &&
          capacityDigest(readback.input.catalog_review_disposition) !==
            capacityDigest(next.catalog_review_disposition))
      )
        throw new Error("catalog semantic CAS readback differs; retain original");
      check();
      if (negativeReceipt)
        return {
          decision: "catalog-negative-review-retired" as const,
          mode: "catalog" as const,
          directory,
          checkpoint: readback.checkpoint,
          catalog_review_disposition: next.catalog_review_disposition,
          authority: "none" as const,
          automatic_retry: false,
        };
      return {
        decision: "catalog-review-requested" as const,
        mode: "catalog" as const,
        directory,
        checkpoint: readback.checkpoint,
        catalog_review_request: frozen,
        authority: "none" as const,
        automatic_retry: false,
      };
    } catch (error) {
      let exchange;
      if (
        stage === "standalone-application-bootstrap-CAS" &&
        error instanceof CoordinatorRemoteError &&
        isRecord(error.evidence)
      ) {
        exchange = inspectCatalogCheckpointRefusal(error.evidence);
        const child = error.evidence.checkpoint;
        if (exchange && typeof child === "string" && /^[a-f0-9]{40}$/u.test(child)) {
          try {
            const bytes = await readControllerToolFile(
              path.join(directory, `checkpoint-signing-${child}`, "signing-failure.json"),
              1024,
            );
            const failure: unknown = JSON.parse(bytes.toString("utf8"));
            if (
              isRecord(failure) &&
              failure.schema_version === 1 &&
              failure.completed === false &&
              failure.automatic_retry === false &&
              failure.recovery_required === true &&
              failure.provider_error_text_retained === false
            ) {
              if (failure.phase === "identity" && failure.remote_effect === "not-attempted")
                exchange.signer = "identity-not-attempted";
              if (failure.phase === "signing" && failure.remote_effect === "unknown")
                exchange.signer = "signing-effect-unknown";
            }
          } catch {
            // The exchange phase remains available when signer custody was never created.
          }
        }
      }
      await retainCatalogCoordinatorRefusal(
        process.env.RUNNER_TEMP ?? "",
        "operation",
        stage,
        exchange,
      ).catch(() => {});
      await writeFile(
        path.join(directory, "refusal.json"),
        JSON.stringify({ stage, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw error;
    }
  });
}
