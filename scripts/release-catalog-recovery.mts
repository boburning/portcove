/** GET-only continuation of one original catalog Pages effect. Journal and
 * provider projections remain inert until the maintained private receivers and
 * coordinator executor independently authenticate them. No signing is retried. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import {
  capacityDigest as digest,
  inspectCapacityOperation,
  inspectCompactCapacityOperations,
} from "./release-capacity.mts";
import {
  catalogPublicationLifecycle,
  inspectCatalogPublicationDescriptor,
} from "./release-catalog-publication-contract.mts";
import {
  catalogSigningRoles,
  inspectCatalogSigningBinding,
} from "./release-catalog-signing-contract.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { readRetainedCapacityOperation } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
} from "./release-coordinator-deadline.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { requireControllerCatalogJobAuthorities } from "./release-authority-configuration.mts";
import {
  readProductionControllerWorkflowBytes,
  productionControllerWorkflow,
} from "./production-controller-admission.mts";
import {
  authenticateCatalogControlReaderJob,
  authenticateCatalogReleaseControlSource,
  authenticateCatalogReleaseControlRound,
} from "./release-live-control-admission.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import {
  authenticateCapacityExecutor,
  refreshCapacityExecutor,
  recoverOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { catalogCoordinatorMaintenanceIdentity } from "./release-coordinator-driver.mts";
import { prepareControlReadiness, waitForControlArtifact } from "./release-control-handshake.mts";
import { retainControlStepLocator } from "./release-control-step-bridge.mts";
import {
  readCompleteRunArtifactInventory,
  inspectCompleteRunArtifactInventory,
} from "./release-run-artifact-inventory.mts";
import {
  inspectSigningContextArchive,
  receiveCatalogSigningContextArtifact,
  requireReceivedCatalogSigningContext,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import {
  receiveCatalogRoleArtifact,
  requireRetainedCatalogRoleArtifact,
} from "./release-tuf-role-artifact.mts";
import type { CatalogRoleArtifactExpected } from "./release-tuf-role-artifact.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import {
  materializePublishedCatalogCompleteSite,
  requirePublishedCatalogCompleteSite,
} from "./release-site-readback.mts";
import { assembleActualCatalogRepositoryForRecovery } from "./release-catalog-signing.mts";
import { recoverActualCatalogSitePublication } from "./release-catalog-site-controller.mts";

const base = "repos/boburning/portcove";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
type Output = "context" | (typeof catalogSigningRoles)[number];
const destination = (output: Output) =>
  `github-actions:boburning/portcove:${output === "context" ? "catalog-publication-context" : `catalog-tuf-role-${output}`}`;
const settled = (op: Operation) =>
  ["succeeded", "recovered"].includes(op.outcome) &&
  op.completed_effects.length === 1 &&
  (op.outcome !== "recovered" || op.recovery?.resolution === "effect-completed");

/** Pure association, never a request to retry an upload or appoint a producer. */
export function inspectCatalogContinuationOperation(
  raw: unknown,
  descriptor: unknown,
  output: Output,
) {
  const op = inspectCapacityOperation(raw);
  const selected = inspectCatalogPublicationDescriptor(descriptor);
  if (
    !op ||
    !op.catalog_publication ||
    digest(op.catalog_publication.descriptor) !== digest(selected) ||
    op.kind !== "upload" ||
    op.destination !== destination(output) ||
    !settled(op) ||
    op.executor_identity?.role !== (output === "context" ? "coordinator" : `catalog-${output}`)
  )
    throw new Error("original settled catalog output required; no signing or upload retry");
  return op;
}

/** Complete provider data association; actual attestation receivers remain the
 * only way to acquire context/role custody. A failed/missing producer holds. */
export function inspectCatalogContinuationProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawInventory: unknown,
  rawOperation: unknown,
  descriptor: unknown,
  output: Output,
) {
  const op = inspectCatalogContinuationOperation(rawOperation, descriptor, output),
    p = op.executor_identity!;
  for (const raw of [rawRun, rawAttempt]) {
    if (
      !isRecord(raw) ||
      String(raw.id) !== p.run_id ||
      raw.run_attempt !== 1 ||
      raw.head_sha !== p.controller_revision ||
      raw.path !== productionControllerWorkflow ||
      raw.event !== "workflow_dispatch" ||
      !isRecord(raw.actor) ||
      String(raw.actor.id) !== p.actor_id ||
      raw.status !== "completed" ||
      typeof raw.conclusion !== "string" ||
      !raw.conclusion ||
      !isRecord(raw.repository) ||
      raw.repository.id !== 1354613114 ||
      raw.repository.full_name !== "boburning/portcove" ||
      !isRecord(raw.head_repository) ||
      raw.head_repository.id !== 1354613114
    )
      throw new Error("original catalog run is not exact and terminal");
  }
  const phase = output === "context" ? "coordinator" : (`catalog-${output}` as const);
  if (
    !isRecord(rawJob) ||
    rawJob.id !== p.job_id ||
    String(rawJob.run_id) !== p.run_id ||
    rawJob.run_attempt !== 1 ||
    rawJob.head_sha !== p.controller_revision ||
    rawJob.name !== releaseControlPhaseProfile(phase).reader_name ||
    rawJob.status !== "completed" ||
    rawJob.conclusion !== "success" ||
    rawJob.check_run_url !==
      `https://api.github.com/repos/boburning/portcove/check-runs/${String(p.check_run_id)}`
  )
    throw new Error("original catalog producer did not positively complete");
  const rows = inspectCompleteRunArtifactInventory(rawInventory).artifacts;
  const artifacts = [false, true].map((attestation) => {
    const prefix =
      output === "context" ? "trusted-catalog-signing-context" : `trusted-catalog-${output}`;
    const name = `${prefix}${output === "context" ? (attestation ? "-attestation" : "") : attestation ? "-attestation" : "-output"}-${String(p.run_id)}-1`;
    const matches = rows.filter((row) => row.name === name);
    if (matches.length !== 1)
      throw new Error("original catalog artifact or attestation missing or ambiguous");
    const row = matches[0]!;
    if (
      !Number.isSafeInteger(row.id) ||
      Number(row.id) < 1 ||
      row.expired !== false ||
      typeof row.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
      !Number.isSafeInteger(row.size_in_bytes) ||
      Number(row.size_in_bytes) < 22 ||
      Number(row.size_in_bytes) >
        (attestation ? 4 * 1024 ** 2 : output === "context" ? 128 * 1024 ** 2 : 2 * 1024 ** 2) ||
      !isRecord(row.workflow_run) ||
      String(row.workflow_run.id) !== p.run_id ||
      row.workflow_run.repository_id !== 1354613114 ||
      row.workflow_run.head_repository_id !== 1354613114 ||
      row.workflow_run.head_sha !== p.controller_revision
    )
      throw new Error("original immutable catalog artifact association differs");
    return { id: Number(row.id), sha256: row.digest.slice(7), bytes: Number(row.size_in_bytes) };
  });
  const [artifact, bundle] = artifacts;
  assert.ok(artifact && bundle && artifact.id !== bundle.id);
  if (
    op.completed_effects[0]!.remote_identity !==
    `github-actions:boburning/portcove:artifact:${artifact.id}`
  )
    throw new Error("catalog artifact is not the original journal-settled upload");
  return { artifact, bundle, producer: structuredClone(p), authority: "none" as const };
}

/** Read only compact proofs for this exact descriptor/lifecycle. No ancestry
 * fetch or latest-run selection; duplicate usable attempts remain ambiguous. */
export async function readCatalogContinuationOperations(
  repository: string,
  rawInput: unknown,
  api: GitHubRestReader,
  deadline: number,
) {
  if (
    !isRecord(rawInput) ||
    !isRecord(rawInput.controller) ||
    !isRecord(rawInput.controller.capacity_attempt)
  )
    throw new Error("catalog continuation journal missing");
  const input = rawInput,
    capacity = rawInput.controller.capacity_attempt;
  const descriptor = inspectCatalogPublicationDescriptor(input.catalog_publication),
    found: Operation[] = [];
  const current = inspectCapacityOperation(capacity.operation);
  if (current) found.push(current);
  if (capacity.schema_version !== 2)
    throw new Error("catalog continuation requires compact journal schema");
  for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
    if (
      group.subject.kind !== "catalog-publication" ||
      group.subject.identity !== catalogPublicationLifecycle(descriptor) ||
      group.kind !== "upload" ||
      !["context", ...catalogSigningRoles].some(
        (output) => group.destination_sha256 === digest(destination(output as Output)),
      )
    )
      continue;
    for (const proof of group.attempts) {
      signingContextRemaining(deadline, 15000);
      let retained: unknown;
      try {
        retained = readRetainedCapacityOperation(repository, proof);
      } catch {
        retained = await hydrateRetainedCoordinatorOperation(repository, proof, { api });
      }
      const op = inspectCapacityOperation(retained);
      if (op) found.push(op);
    }
  }
  const selected = new Map<Output, Operation>();
  for (const output of ["context", ...catalogSigningRoles] as const) {
    const matches = found.filter(
      (op) =>
        op.destination === destination(output) &&
        op.catalog_publication &&
        digest(op.catalog_publication.descriptor) === digest(descriptor) &&
        settled(op),
    );
    const unique = [...new Map(matches.map((op) => [op.id, op])).values()];
    if (unique.length !== 1)
      throw new Error("original complete catalog output set missing or ambiguous; retain HOLD");
    selected.set(output, inspectCatalogContinuationOperation(unique[0], descriptor, output));
  }
  return selected;
}

/** Named actual coordinator continuation. No caller locators or injected
 * provider boundary are accepted by this authority-bearing entry. */
export async function continueActualCatalogPublication(
  toolsReceipt: object,
  remoteConfiguration: unknown,
  parent: string,
  originalDeadline: number,
) {
  signingContextRemaining(originalDeadline, 15000);
  if (!path.isAbsolute(parent)) throw new Error("private catalog continuation parent required");
  await verifiedControllerToolPaths(toolsReceipt);
  const remote = {
    schema_version: 1,
    namespace: inspectCoordinatorRemoteNamespace(remoteConfiguration),
  };
  return withCoordinatorDeadline(originalDeadline, async () => {
    const directory = await mkdtemp(path.join(parent, "catalog-continuation-")),
      home = path.join(directory, "reader-home");
    await mkdir(home, { mode: 0o700 });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ["PATH", "Path", "SystemRoot", "WINDIR", "GH_TOKEN"].includes(key),
      ),
    );
    Object.assign(environment, {
      HOME: home,
      USERPROFILE: home,
      TMP: home,
      TEMP: home,
      GH_CONFIG_DIR: home,
      XDG_CONFIG_HOME: home,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    });
    const spawn: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"] = (
      command,
      args,
      settings,
    ) => spawnSync(command, args, { ...settings, env: environment });
    let reads = 0;
    const api = new GitHubApiClient((args, body) => {
      if (++reads > 160) throw new Error("catalog continuation read budget exhausted");
      const response = createGitHubRunner({
        cwd: directory,
        maxBuffer: 4 * 1024 ** 2,
        timeoutMs: Math.min(
          coordinatorCommandTimeout(15000),
          signingContextRemaining(originalDeadline, 15000),
        ),
        spawn,
      })([...args, "--hostname", "github.com"], body);
      signingContextRemaining(originalDeadline, 15000);
      return response;
    });
    const get = (route: string) => {
      const response = api.request("GET", `${base}/${route}`);
      if (response.status !== 200) throw new Error("catalog original provider read unavailable");
      return response.body;
    };
    let phase = "actual-coordinator";
    try {
      const authorities = await requireControllerCatalogJobAuthorities("coordinator");
      if (authorities.namespace !== remote.namespace)
        throw new Error("catalog continuation namespace differs");
      const protectedEnvironment = Object.fromEntries(
        [
          "PORTCOVE_CATALOG_AUTHORITIES",
          "PORTCOVE_CATALOG_CONTROLLER_ADMISSION",
          "PORTCOVE_CONTROLLER_REVISION",
          "PORTCOVE_CONTROLLER_REF",
          "PORTCOVE_EXECUTION_PURPOSE",
        ].map((name) => [name, process.env[name]]),
      );
      const workflow = await readProductionControllerWorkflowBytes(),
        reader = await authenticateCatalogControlReaderJob(process.env, workflow, {
          phase: "coordinator",
          deadline: originalDeadline,
        });
      const tools = await verifiedControllerToolPaths(toolsReceipt);
      if (
        reader.identity.evidence_scope !== "github.com" ||
        tools.identity.controller_revision !== reader.admitted.revision ||
        tools.identity.controller_ref !== reader.admitted.execution_ref ||
        tools.identity.run_id !== reader.admitted.run_id ||
        tools.identity.run_attempt !== reader.admitted.run_attempt
      )
        throw new Error("actual current catalog coordinator/tool custody differs");
      const state = await recoverRemoteCoordinator(directory, remote, {
        transport: { cwd: directory, deadline: originalDeadline, spawn },
      });
      let checkpoint = state.checkpoint;
      const descriptor = inspectCatalogPublicationDescriptor(state.input.catalog_publication);
      if (
        descriptor.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
        state.input.active_candidate != null ||
        state.input.review_request != null ||
        state.input.review_disposition != null ||
        state.input.metadata_renewal != null ||
        state.input.metadata_bootstrap != null
      )
        throw new Error(
          "catalog continuation cannot replace application work or protected configuration",
        );
      const controller = state.input.controller;
      if (!isRecord(controller) || !isRecord(controller.capacity_attempt))
        throw new Error("catalog Pages intent missing");
      const pages = inspectCapacityOperation(controller.capacity_attempt.operation);
      if (
        !pages?.catalog_site_expectation ||
        !pages.catalog_publication ||
        digest(pages.catalog_publication.descriptor) !== digest(descriptor) ||
        pages.kind !== "upload" ||
        pages.destination !== "github-pages:boburning/portcove:complete-site" ||
        pages.executor_identity?.role !== "site-publication" ||
        pages.receipt_limit !== 1 ||
        pages.completed_effects.length > 1 ||
        !["pending", "ambiguous", "capacity-refused", "succeeded", "recovered"].includes(
          pages.outcome,
        ) ||
        (["succeeded", "recovered"].includes(pages.outcome) && !settled(pages))
      )
        throw new Error("original catalog Pages intent is not eligible for GET-only continuation");
      if (
        pages.completed_effects.some(
          (effect) =>
            effect.remote_identity !==
            `github-pages:boburning/portcove:${String(pages.catalog_site_expectation!.site_generation_sha256)}`,
        )
      )
        throw new Error("retained catalog Pages effect differs from exact generation");
      const ready = path.join(directory, "ready-coordinator.json");
      await writeFile(
        ready,
        JSON.stringify(
          prepareControlReadiness(
            reader.identity,
            digest({ checkpoint, descriptor }),
            "coordinator",
          ),
        ),
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
          run_attempt: 1,
        },
        {
          deadline: Date.now() + Math.floor(originalDeadline - performance.now()),
          phaseDeadline: originalDeadline,
        },
      );
      let controls = await authenticateCatalogReleaseControlSource(process.env, workflow, {
          phase: "coordinator",
          deadline: originalDeadline,
          observedArtifact: observation,
        }),
        observed = performance.now(),
        round = 0;
      if (controls.evidence_scope !== "github.com")
        throw new Error("actual catalog maintenance controls required");
      const stable = catalogCoordinatorMaintenanceIdentity(controls.readMaintenance(api));
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
          run_attempt: 1,
        },
        directory,
        originalDeadline,
      );
      const guard = async () => {
        signingContextRemaining(originalDeadline, 15000);
        await verifiedControllerToolPaths(toolsReceipt);
        const snapshot = await readRemoteCoordinatorSnapshot(directory, remote, {
          transport: { cwd: directory, deadline: originalDeadline, spawn },
        });
        if (
          snapshot.checkpoint !== checkpoint ||
          digest(snapshot.input.catalog_publication) !== digest(descriptor)
        )
          throw new Error("catalog original checkpoint or descriptor changed");
        await refreshCapacityExecutor(executor);
        if (performance.now() - observed >= 45000) {
          if (++round > 14)
            throw new Error("catalog original continuation control rounds exhausted");
          controls = await authenticateCatalogReleaseControlRound(
            path.join(directory, `controls-r${round}`),
            digest({ descriptor }),
            "coordinator",
            round,
            { deadline: originalDeadline },
          );
          observed = performance.now();
        }
        if (
          controls.evidence_scope !== "github.com" ||
          catalogCoordinatorMaintenanceIdentity(controls.readMaintenance(api)) !== stable
        )
          throw new Error("catalog continuation controls changed");
        signingContextRemaining(originalDeadline, 15000);
      };
      const beforeMutation = () => {
        signingContextRemaining(originalDeadline, 15000);
        for (const [name, value] of Object.entries(protectedEnvironment))
          if (process.env[name] !== value)
            throw new Error("catalog protected mutation configuration changed");
        if (
          controls.evidence_scope !== "github.com" ||
          catalogCoordinatorMaintenanceIdentity(controls.readMaintenance(api)) !== stable
        )
          throw new Error("catalog final mutation controls changed");
        signingContextRemaining(originalDeadline, 15000);
      };
      await guard();
      phase = "original-attested-context-and-four-roles";
      const operations = await readCatalogContinuationOperations(
        state.repository,
        state.input,
        api,
        originalDeadline,
      );
      const observe = (op: Operation, output: Output) => {
        const p = op.executor_identity!;
        return inspectCatalogContinuationProvider(
          get(`actions/runs/${String(p.run_id)}`),
          get(`actions/runs/${String(p.run_id)}/attempts/1`),
          get(`actions/jobs/${String(p.job_id)}`),
          readCompleteRunArtifactInventory((page) =>
            get(`actions/runs/${String(p.run_id)}/artifacts?per_page=100&page=${page}`),
          ),
          op,
          descriptor,
          output,
        );
      };
      const contextOp = operations.get("context")!,
        before = observe(contextOp, "context");
      const archive = readGitHubArtifactArchive(
        `${base}/actions/artifacts/${before.artifact.id}/zip`,
        {
          cwd: directory,
          maxBytes: before.artifact.bytes,
          timeoutMs: signingContextRemaining(originalDeadline, 30000),
          spawn: (command, args, settings) =>
            spawnSync(command, args, { ...settings, env: environment }),
        },
      );
      if (hash(archive) !== before.artifact.sha256)
        throw new Error("original catalog context archive changed");
      const parsed = inspectSigningContextArchive(archive),
        manifest = parsed.manifest,
        producer = contextOp.executor_identity!;
      if (
        !isRecord(manifest.controller) ||
        manifest.kind !== "catalog-signing-context" ||
        manifest.controller.controller_revision !== producer.controller_revision ||
        manifest.controller.controller_ref !== producer.execution_ref ||
        manifest.controller.run_id !== producer.run_id ||
        manifest.controller.run_attempt !== 1 ||
        !isRecord(manifest.facts)
      )
        throw new Error("original catalog context producer differs");
      const binding = inspectCatalogSigningBinding(
        manifest.facts,
        manifest.binding,
        manifest.previous_site_pins,
      );
      if (digest(binding.facts.descriptor) !== digest(descriptor))
        throw new Error("original context belongs to another catalog subject");
      const contextLocator: SigningContextArtifactExpected = {
        controller_revision: producer.controller_revision,
        controller_ref: producer.execution_ref,
        source_tree: String(manifest.controller.source_tree),
        run_id: String(producer.run_id),
        run_attempt: 1,
        artifact: { id: before.artifact.id, sha256: before.artifact.sha256 },
        bundle: { id: before.bundle.id, sha256: before.bundle.sha256 },
        manifest_sha256: parsed.manifest_sha256,
        binding_sha256: digest(manifest.binding),
        facts_sha256: String(manifest.facts_sha256),
      };
      const context = await receiveCatalogSigningContextArtifact(
        directory,
        contextLocator,
        originalDeadline,
      );
      await requireReceivedCatalogSigningContext(context, originalDeadline);
      if (digest(observe(contextOp, "context")) !== digest(before))
        throw new Error("catalog context provider drifted");
      const roleReceipts: object[] = [];
      for (const role of catalogSigningRoles) {
        await guard();
        const op = operations.get(role)!,
          provider = observe(op, role),
          p = op.executor_identity!;
        const locator: CatalogRoleArtifactExpected = {
          purpose: "catalog",
          role,
          controller: {
            controller_revision: p.controller_revision,
            controller_ref: p.execution_ref,
            source_tree: contextLocator.source_tree,
            run_id: String(p.run_id),
            run_attempt: 1,
          },
          artifact: { id: provider.artifact.id, sha256: provider.artifact.sha256 },
          bundle: { id: provider.bundle.id, sha256: provider.bundle.sha256 },
          context_manifest_sha256: contextLocator.manifest_sha256,
          context_binding_sha256: contextLocator.binding_sha256,
          context_facts_sha256: contextLocator.facts_sha256,
        };
        const receipt = await receiveCatalogRoleArtifact(
            context,
            directory,
            locator,
            originalDeadline,
          ),
          retained = await requireRetainedCatalogRoleArtifact(receipt, originalDeadline);
        const raw: unknown = JSON.parse(
          (
            await readControllerToolFile(
              path.join(path.dirname(retained.envelope.path), "signing-output-manifest.json"),
              65536,
            )
          ).toString("utf8"),
        );
        if (!isRecord(raw) || !isRecord(raw.pending) || raw.pending.operation_id !== op.id)
          throw new Error("catalog role belongs to another upload intent");
        if (digest(observe(op, role)) !== digest(provider))
          throw new Error("catalog role provider drifted");
        roleReceipts.push(receipt);
      }
      await guard();
      phase = "original-Pages-readback";
      if (!settled(pages)) {
        const expected = pages.catalog_site_expectation;
        const readback = async () => {
          const provider = createPagesProviderTransport(directory, {}, originalDeadline),
            identity = {
              artifact_id: expected.artifact_id,
              generation: String(expected.site_generation_sha256),
              controller_revision: pages.executor_identity!.controller_revision,
            };
          const before = provider.observeByGeneration(identity);
          if (before.status !== "succeed")
            throw new Error("original catalog Pages completion unavailable; no absence inference");
          const current = await materializePublishedCatalogCompleteSite(
              {
                root_sha256: String(expected.catalog_root_sha256),
                repository_sha256: String(expected.catalog_repository_sha256),
                site_generation_sha256: String(expected.site_generation_sha256),
              },
              directory,
              originalDeadline,
            ),
            verified = await requirePublishedCatalogCompleteSite(current.receipt);
          const after = provider.observeByGeneration(identity);
          if (digest(before) !== digest(after)) throw new Error("original Pages provider drifted");
          await guard();
          return {
            resolution: "effect-completed" as const,
            evidence_sha256: digest({
              before,
              generation: verified.generation,
              pins: verified.pins,
            }),
            ...(pages.completed_effects.length
              ? {}
              : {
                  completed_effect: {
                    remote_identity: `github-pages:boburning/portcove:${String(expected.site_generation_sha256)}`,
                    evidence_sha256: digest({
                      before,
                      generation: verified.generation,
                      pins: verified.pins,
                    }),
                  },
                }),
          };
        };
        const recovered = await recoverOwnedCapacityEffect(
          executor,
          { repository: state.repository, checkpoint, remote_configuration: remote },
          async (actual) => {
            if (digest(actual) !== digest(pages))
              throw new Error("different original Pages intent");
            return readback();
          },
          beforeMutation,
        );
        checkpoint = recovered.checkpoint;
      }
      await guard();
      phase = "read-only-Tough-and-atomic-handoff";
      const actual = await assembleActualCatalogRepositoryForRecovery(
        context,
        toolsReceipt,
        roleReceipts,
        directory,
        originalDeadline,
      );
      await guard();
      const result = await recoverActualCatalogSitePublication(
        actual,
        executor,
        {
          repository: state.repository,
          checkpoint,
          remote_configuration: remote,
          output_parent: directory,
          deadline: originalDeadline,
        },
        { refresh: guard, beforeMutation },
      );
      return {
        decision: "catalog-publication-recovered" as const,
        mode: "catalog" as const,
        directory,
        ...result,
        authority: "none" as const,
      };
    } catch (error) {
      await writeFile(
        path.join(directory, "refusal.json"),
        JSON.stringify({ phase, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(`catalog continuation held; retain ${directory}`, { cause: error });
    }
  });
}
