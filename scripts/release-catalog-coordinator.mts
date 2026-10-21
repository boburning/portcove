import {
  inspectCatalogReviewDisposition,
  advanceCatalogReviewRecovery,
  receiveActualCatalogReviewDisposition,
  requireActualCatalogReviewDisposition,
  prepareActualCatalogReviewRetirement,
} from "./release-catalog-review-disposition.mts";
import { discoverIndependentCatalogSemanticDisposition } from "./release-semantic-disposition-reader.mts";
/** Actual catalog coordinator entry. Candidate Git/JSON is inert; only existing
 * actual configuration, controls, tool/Core and semantic factories release keys. */
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
} from "./release-coordinator-deadline.mts";
import {
  coordinatorOriginalJobDeadline,
  catalogCoordinatorMaintenanceIdentity,
  deriveCoordinatorPublication,
  prepareActualCoordinatorCatalogSigning,
} from "./release-coordinator-driver.mts";
import { completeCoordinatorCatalogSigningContext } from "./release-catalog-signing-context.mts";
import {
  requireControllerCatalogPublicationAuthorities,
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
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import {
  materializeCatalogPublicationSource,
  readCatalogPublicationSourceBytes,
} from "./release-catalog-source.mts";
import {
  inspectActualCatalogPublication,
  requireActualCatalogInspection,
  readCatalogPublicationBundle,
} from "./release-catalog-inspection.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import { inspectCatalogInitialization } from "./release-catalog-publication-contract.mts";
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
import { checkpointReleaseOpportunity } from "./release-coordinator-state.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import { collectReleaseSourceChanges } from "./release-source-changes.mts";
import { createReleasePublicationReader } from "./release-publication-inventory.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import {
  readIndependentSemanticCheckInventory,
  inspectCatalogSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { prepareControlReadiness, waitForControlArtifact } from "./release-control-handshake.mts";
import { retainControlStepLocator } from "./release-control-step-bridge.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
const project = fileURLToPath(new URL("..", import.meta.url)),
  repository = "repos/boburning/portcove";
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
  let deadline = Math.min(start + 170000, phaseDeadline ?? Infinity);
  const check = () => {
    if (performance.now() >= deadline)
      throw new Error("catalog coordinator original job budget exhausted");
  };
  await assertOwnedUnlinkedPath(project, parent, "catalog coordinator private parent");
  const directory = await mkdtemp(path.join(parent, "catalog-coordinator-"));
  const client = new GitHubApiClient((args, body) => {
    check();
    const result = createGitHubRunner({
      cwd: directory,
      maxBuffer: 16 * 1024 ** 2,
      timeoutMs: Math.max(
        1,
        Math.floor(Math.min(coordinatorCommandTimeout(15000), deadline - performance.now())),
      ),
    })([...args, "--hostname", "github.com"], body);
    check();
    return result;
  });
  const api = {
    request(method: string, route: string, body?: unknown) {
      if (method !== "GET" || body != null)
        throw new Error("catalog source/Check transport is GET-only");
      return client.request(method, route);
    },
    graphql(query: string, variables?: Record<string, unknown>) {
      if (!/^\s*query\b/u.test(query))
        throw new Error("catalog source transport admits queries only");
      return client.graphql(query, variables);
    },
  };
  const run = process.env.GITHUB_RUN_ID,
    revision = process.env.GITHUB_SHA;
  if (
    !run ||
    !/^[1-9][0-9]{0,15}$/u.test(run) ||
    !revision ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    process.env.GITHUB_RUN_ATTEMPT !== "1"
  )
    throw new Error("actual first coordinator job identity required");
  const jobs = api.request(
    "GET",
    `${repository}/actions/runs/${run}/jobs?filter=all&per_page=100&page=1`,
  );
  if (jobs.status !== 200) throw new Error("catalog coordinator original job unavailable");
  deadline = Math.min(
    deadline,
    coordinatorOriginalJobDeadline(jobs.body, { run_id: run, controller_revision: revision }),
  );
  check();
  return withCoordinatorDeadline(deadline, async () => {
    let stage = "actual-catalog-admission";
    try {
      const authorities = await requireControllerCatalogPublicationAuthorities("coordinator");
      if (authorities.namespace !== selected.remote_configuration.namespace)
        throw new Error("catalog authority namespace differs");
      const workflow = await readProductionControllerWorkflowBytes(),
        reader = await authenticateCatalogControlReaderJob(process.env, workflow, {
          phase: "coordinator",
          deadline,
        });
      if (reader.identity.evidence_scope !== "github.com")
        throw new Error("actual catalog coordinator reader required");
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
      const recovered = await recoverRemoteCoordinator(directory, selected.remote_configuration, {
          transport: { cwd: directory, deadline },
        }),
        input = recovered.input;
      const pending = inspectCatalogReviewRequest(input.catalog_review_request),
        history = inspectCatalogReviewDisposition(input.catalog_review_disposition),
        replacement = !pending && history !== null;
      if (
        input.active_candidate != null ||
        input.review_request != null ||
        input.review_disposition != null ||
        input.metadata_renewal != null ||
        input.metadata_bootstrap != null ||
        unresolved(input)
      )
        return held(
          directory,
          recovered.checkpoint,
          "existing application reservation or unresolved effect requires its existing recovery",
        );
      if (input.catalog_publication != null)
        return held(
          directory,
          recovered.checkpoint,
          "existing catalog subject requires original context/site readback; no replay",
        );
      const mainHead = () => {
        const repo = api.request("GET", repository),
          ref = api.request("GET", `${repository}/git/ref/heads/main`);
        if (
          repo.status !== 200 ||
          !isRecord(repo.body) ||
          repo.body.id !== 1354613114 ||
          repo.body.full_name !== "boburning/portcove" ||
          repo.body.default_branch !== "main" ||
          ref.status !== 200 ||
          !isRecord(ref.body) ||
          ref.body.ref !== "refs/heads/main" ||
          !isRecord(ref.body.object) ||
          ref.body.object.type !== "commit" ||
          typeof ref.body.object.sha !== "string" ||
          !/^[a-f0-9]{40}$/u.test(ref.body.object.sha)
        )
          throw new Error("fixed default-main catalog source unavailable");
        return ref.body.object.sha;
      };
      const sourceCommit = pending?.opportunity.source_commit ?? mainHead();
      stage = "fixed-inert-source-and-Core";
      const source = await materializeCatalogPublicationSource(
        api,
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
        const previous = readCatalogPublicationSourceBytes(api, published.source_commit, deadline);
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
      assertControllerCatalogPublisherScope(authorities, inspection.inspection, files);
      const pins = authorities.catalog.public_source,
        initialRaw = api.request("GET", `${repository}/git/commits/${pins.commit}`);
      if (initialRaw.status !== 200)
        throw new Error("appointed initial catalog source unavailable");
      const initialCommit = inspectRemoteCommitObject(initialRaw.body, pins.commit),
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
      const changes = collectReleaseSourceChanges(api, {
        base_commit: seed?.source_commit ?? initial.commit,
        source_commit: source.source.commit,
        source_tree: source.source.tree,
      });
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
      const producer = {
        schema_version: 1,
        review_app_id: authorities.apps.semantic.app_id,
        writer_app_id: authorities.apps.classification.app_id,
        review_check_name: semanticReviewCheckName,
      };
      const request =
        pending ??
        createCatalogReviewRequest({
          before_checkpoint: recovered.checkpoint,
          requested_at: new Date().toISOString(),
          opportunity,
          core_inspection: core,
        });
      const inventory = readIndependentSemanticCheckInventory(api, producer, sourceCommit),
        matches = inspectCatalogSemanticRequestCheckMatches(inventory.records, request);
      inventory.assertUnchanged();
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
      const ready = path.join(directory, "ready-coordinator.json");
      await writeFile(
        ready,
        `${JSON.stringify(prepareControlReadiness(reader.identity, capacityDigest({ checkpoint: recovered.checkpoint, request }), "coordinator"))}\n`,
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
          run_id: reader.admitted.run_id,
          run_attempt: reader.admitted.run_attempt,
        },
        {
          deadline: Date.now() + Math.floor(deadline - performance.now()),
          phaseDeadline: deadline,
        },
      );
      const controls = await authenticateCatalogReleaseControlSource(process.env, workflow, {
        phase: "coordinator",
        deadline,
        observedArtifact: observation,
      });
      requireAuthenticatedCatalogControlSource(controls, "coordinator");
      if (controls.evidence_scope !== "github.com")
        throw new Error("actual catalog controls required");
      const observed = controls.readMaintenance(api),
        stable = catalogCoordinatorMaintenanceIdentity(observed);
      if (
        observed.reader.job_id !== reader.identity.job_id ||
        observed.reader.check_run_id !== reader.identity.check_run_id
      )
        throw new Error("catalog controls came from another job");
      const publicationReader = createReleasePublicationReader(api),
        tags = publicationReader.tags(),
        releases = publicationReader.releases(),
        allocations = publicationReader.readAllocations(tags, authorities.namespace).allocations;
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
        transport: { cwd: directory, deadline },
      });
      if (fresh.checkpoint !== recovered.checkpoint)
        throw new Error("catalog journal advanced before neutral request CAS");
      await requireActualCatalogInspection(inspectionReceipt, deadline);
      await verifiedControllerToolPaths(tools);
      const current = await requireControllerCatalogPublicationAuthorities("coordinator");
      if (current.configuration_sha256 !== authorities.configuration_sha256)
        throw new Error("catalog authority changed before neutral request CAS");
      const environment = {
        authority: process.env.PORTCOVE_CATALOG_AUTHORITIES,
        admission: process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      };
      const beforeMutation = () => {
        check();
        if (
          process.env.PORTCOVE_CATALOG_AUTHORITIES !== environment.authority ||
          process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION !== environment.admission ||
          (!pending && mainHead() !== sourceCommit)
        )
          throw new Error("catalog source/configuration changed before mutation");
        const currentTags = publicationReader.tags(),
          currentReleases = publicationReader.releases(),
          currentAllocations = publicationReader.readAllocations(
            currentTags,
            authorities.namespace,
          ).allocations;
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
              discoverIndependentCatalogSemanticDisposition(api, producer, pending),
            ) !== negativeProof
          )
            throw new Error("catalog negative selected proof changed before mutation");
        }
        if (catalogCoordinatorMaintenanceIdentity(controls.readMaintenance(api)) !== stable)
          throw new Error("catalog maintenance changed before neutral request mutation");
        check();
      };
      const journal = createCoordinatorJournalApi(directory, deadline),
        guarded = {
          request: (...args: Parameters<typeof journal.request>) => {
            check();
            if (args[0] !== "GET") beforeMutation();
            const result = journal.request(...args);
            check();
            return result;
          },
          graphql: (...args: Parameters<typeof journal.graphql>) => {
            check();
            if (/^\s*mutation\b/u.test(args[0])) beforeMutation();
            const result = journal.graphql(...args);
            check();
            return result;
          },
        };
      if (negativeReceipt) await requireActualCatalogReviewDisposition(negativeReceipt, deadline);
      const persisted = await checkpointReleaseOpportunity(
        recovered.repository,
        recovered.checkpoint,
        next,
      );
      await publishCoordinatorCheckpoint(
        recovered.repository,
        persisted.checkpoint,
        selected.remote_configuration,
        { api: guarded },
      );
      const readback = await readRemoteCoordinatorSnapshot(
        directory,
        selected.remote_configuration,
        { transport: { cwd: directory, deadline } },
      );
      if (
        readback.checkpoint !== persisted.checkpoint ||
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
      await writeFile(
        path.join(directory, "refusal.json"),
        JSON.stringify({ stage, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw error;
    }
  });
}
