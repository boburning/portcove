/** Catalog continuation through the existing sole complete-site publisher.
 * Every authority-bearing input is reconstructed through actual receivers;
 * serialized locators and parser results cannot appoint a publisher. */
import path from "node:path";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { currentSiteJobDeadline } from "./release-site-job-budget.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { receiveCatalogSigningContextArtifact } from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import { receiveCatalogRoleArtifact } from "./release-tuf-role-artifact.mts";
import { catalogSigningRoles } from "./release-catalog-signing-contract.mts";
import {
  assembleActualCatalogRepository,
  requireActualCatalogRepository,
} from "./release-catalog-signing.mts";
import { requireControllerCatalogJobAuthorities } from "./release-authority-configuration.mts";
import { authenticateCatalogReleaseControlRound } from "./release-live-control-admission.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { assertCatalogPublicationBaseline } from "./release-catalog-metadata-contract.mts";
import { inspectCatalogPublicationDescriptor } from "./release-catalog-publication-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  executeOwnedCapacityEffect,
  requireOwnedCapacityPendingBoundary,
} from "./release-capacity-executor.mts";
import {
  prepareCatalogSiteDeploymentFromActualRepository,
  verifyUploadedSiteArchive,
  publishPreparedSiteDeployment,
  prepareCatalogSiteHandoffFromActualRepository,
  recoverPublishedCatalogSiteHandoff,
} from "./release-site-deployment.mts";

const started = performance.now();
function remaining(deadline: number, maximum = 15000) {
  const value = Math.floor(Math.min(maximum, deadline - performance.now()));
  if (!Number.isFinite(deadline) || value < 1)
    throw new Error("catalog site original phase deadline exhausted; preserve all effects");
  return value;
}
async function retain(filename: string, value: unknown) {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Inert association only. The caller obtains pending exclusively from its
 * actual executor's callback-lifetime getter, never a remote JSON assertion. */
export function inspectCatalogSiteReservation(
  snapshot: { checkpoint: string; input: Record<string, unknown> },
  checkpoint: string,
  rawDescriptor: unknown,
  pending?: ReturnType<typeof requireOwnedCapacityPendingBoundary>,
) {
  const descriptor = inspectCatalogPublicationDescriptor(rawDescriptor);
  if (
    snapshot.input.active_candidate != null ||
    digest(inspectCatalogPublicationDescriptor(snapshot.input.catalog_publication)) !==
      digest(descriptor) ||
    digest(assertCatalogPublicationBaseline(descriptor, snapshot.input)) !== digest(descriptor)
  )
    throw new Error("catalog site current subject or components changed");
  if (pending) {
    const controller = snapshot.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    if (
      snapshot.checkpoint !== pending.checkpoint ||
      pending.operation.before_checkpoint !== checkpoint ||
      pending.operation.kind !== "upload" ||
      pending.operation.outcome !== "pending" ||
      pending.operation.destination !==
        "github-actions:boburning/portcove:complete-site-artifact" ||
      digest(pending.operation.completed_effects) !== digest([]) ||
      digest(capacity?.operation) !== digest(pending.operation)
    )
      throw new Error("catalog site pending checkpoint differs from exact owned artifact intent");
  } else if (snapshot.checkpoint !== checkpoint)
    throw new Error("catalog site current checkpoint changed without owned pending custody");
  return { checkpoint: snapshot.checkpoint, authority: "none" as const };
}

/** Coordinator continuation after an observed terminal site publisher. The
 * supplied receipt must come from the named actual recovery assembly factory;
 * the shared executor reobserves the original terminal job and exact effect. */
export async function recoverActualCatalogSitePublication(
  assembly: object,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  raw: {
    repository: string;
    checkpoint: string;
    remote_configuration: unknown;
    output_parent: string;
    deadline: number;
  },
  guards?: { refresh: () => Promise<void>; beforeMutation: () => void },
) {
  const input = structuredClone(raw);
  remaining(input.deadline);
  return withCoordinatorDeadline(input.deadline, async () => {
    const session = await prepareCatalogSiteHandoffFromActualRepository(assembly, input);
    return recoverPublishedCatalogSiteHandoff(
      session,
      executor,
      {
        repository: input.repository,
        checkpoint: input.checkpoint,
        remote_configuration: input.remote_configuration,
      },
      guards,
    );
  });
}

export async function runFixedCatalogSiteConfiguration(
  raw: unknown,
  parent: string,
  phaseDeadline?: number,
) {
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "context,identity,mode,roles,tools" ||
    input.mode !== "catalog" ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !Array.isArray(input.roles) ||
    input.roles.length !== 4 ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed catalog site invocation differs");
  const toolsInput = input.tools,
    rolesInput: unknown[] = input.roles;
  const identity = inspectAssemblerIdentityExpectation(input.identity);
  if (
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("catalog site invocation is not its original fixed job");
  const deadline = currentSiteJobDeadline(
    identity,
    parent,
    Math.min(started + 290000, phaseDeadline ?? Infinity),
  );
  return withCoordinatorDeadline(deadline, async () => {
    const directory = await mkdtemp(path.join(parent, "catalog-site-bootstrap-"));
    const tools = await receiveControllerTools(
      directory,
      toolsInput.artifact as ControllerToolArtifactExpected,
      toolsInput.bundle as { artifact_id: number; sha256: string },
      { deadline },
    );
    const context = await receiveCatalogSigningContextArtifact(
      directory,
      input.context as SigningContextArtifactExpected,
      deadline,
    );
    const roles = [];
    for (const [index, role] of rolesInput.entries()) {
      if (!isRecord(role) || role.purpose !== "catalog" || role.role !== catalogSigningRoles[index])
        throw new Error("catalog site requires the exact four separately attested roles");
      roles.push(await receiveCatalogRoleArtifact(context, directory, role, deadline));
    }
    const assembled = await assembleActualCatalogRepository(
      context,
      tools,
      roles,
      directory,
      deadline,
    );
    return runCatalogSitePublicationController(assembled, identity, parent, deadline);
  });
}

export async function runCatalogSitePublicationController(
  assemblyReceipt: object,
  rawIdentity: unknown,
  parent: string,
  phaseDeadline: number,
) {
  remaining(phaseDeadline);
  // Imported receipts refuse before local output, configuration or provider IO.
  const actual = await requireActualCatalogRepository(assemblyReceipt, phaseDeadline);
  const deadline = Math.min(phaseDeadline, actual.deadline);
  const identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  const tools = await verifiedControllerToolPaths(actual.tools_receipt);
  if (
    !path.isAbsolute(parent) ||
    identity.controller_revision !== tools.identity.controller_revision ||
    identity.controller_ref !== tools.identity.controller_ref ||
    identity.run_id !== tools.identity.run_id ||
    identity.run_attempt !== tools.identity.run_attempt ||
    identity.audience !== "portcove-capacity-executor"
  )
    throw new Error("catalog site executor differs from authenticated controller tools");
  return withCoordinatorDeadline(deadline, async () => {
    const authorities = await requireControllerCatalogJobAuthorities("site-publication");
    if (
      actual.descriptor.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
      identity.actor_id !== authorities.dispatch_actor_id
    )
      throw new Error("catalog site controller differs from protected catalog appointments");
    const remote = { schema_version: 1, namespace: authorities.namespace };
    const directory = await mkdtemp(path.join(parent, "catalog-site-controller-"));
    let stage = "current-journal-and-complete-site";
    try {
      const state = await recoverRemoteCoordinator(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      let checkpoint = state.checkpoint;
      const subject = inspectCatalogPublicationDescriptor(state.input.catalog_publication);
      const reservation = (snapshot: { checkpoint: string; input: Record<string, unknown> }) => {
        inspectCatalogSiteReservation(snapshot, checkpoint, actual.descriptor);
      };
      reservation(state);
      const prepared = await prepareCatalogSiteDeploymentFromActualRepository(assemblyReceipt, {
        repository: state.repository,
        checkpoint,
        output_parent: directory,
        deadline,
      });
      const executor = await authenticateCapacityExecutor(
        "site-publication",
        identity,
        directory,
        deadline,
      );
      const producer = capacityExecutorIdentity(executor);
      const api = new GitHubApiClient((args, body) => {
        remaining(deadline);
        const result = createGitHubRunner({
          cwd: directory,
          timeoutMs: remaining(deadline),
          maxBuffer: 2 * 1024 ** 2,
        })([...args, "--hostname", "github.com"], body);
        remaining(deadline);
        return result;
      });
      let round = 0;
      const fresh = async () => {
        remaining(deadline);
        if (++round > 5) throw new Error("catalog site control rounds exhausted");
        await requireActualCatalogRepository(assemblyReceipt, deadline);
        const controls = await authenticateCatalogReleaseControlRound(
          path.join(directory, `controls-r${round}`),
          digest({ descriptor: actual.descriptor, generation: prepared.generation.generation }),
          "site-publication",
          round,
          { deadline },
        );
        if (controls.evidence_scope !== "github.com")
          throw new Error("actual catalog site controls required");
        return controls;
      };
      let controls = await fresh();
      const boundary: Parameters<typeof executeOwnedCapacityEffect>[2] = async (pendingReceipt) => {
        remaining(deadline);
        const snapshot = await readRemoteCoordinatorSnapshot(directory, remote, {
          transport: { cwd: directory, deadline },
        });
        const pending = pendingReceipt
          ? requireOwnedCapacityPendingBoundary(executor, pendingReceipt)
          : undefined;
        inspectCatalogSiteReservation(snapshot, checkpoint, actual.descriptor, pending);
        const facts = controls.readMaintenance(api);
        if (
          facts.purpose !== "catalog-site-publication-controls" ||
          facts.pause.publication_paused ||
          !facts.resource_policy_matches_controller
        )
          throw new Error("fresh catalog site controls hold this attempt");
        remaining(deadline);
        return facts.capacity_source.capacity.boundary;
      };
      stage = "durable-site-artifact-intent";
      const uploaded = await executeOwnedCapacityEffect(
        executor,
        {
          repository: state.repository,
          checkpoint,
          remote_configuration: remote,
          catalog_publication: subject,
          request: {
            kind: "upload",
            destination: "github-actions:boburning/portcove:complete-site-artifact",
          },
        },
        boundary,
        async (pending) => {
          checkpoint = pending.checkpoint;
          await retain(path.join(directory, "site-upload-ready.json"), {
            archive: prepared.archive,
            name: `application-update-site-${producer.run_id}-${producer.run_attempt}`,
            generation: prepared.generation.generation,
            pending,
            authority: "none",
          });
          // The same existing fixed upload action and transport are used by both
          // component purposes, after the globally exclusive pending CAS exists.
          await retain(path.join(parent, "site-controller-ready.json"), {
            directory,
            authority: "none",
          });
          if (process.env.RUNNER_TEMP && process.env.PORTCOVE_JOB_OPERATION) {
            await (
              await import("./release-controller-transport.mts")
            ).retainControllerUpload(
              process.env.RUNNER_TEMP,
              "site-publication",
              "site",
              directory,
            );
          }
          let locator: unknown;
          for (;;) {
            remaining(deadline);
            try {
              locator = JSON.parse(
                (
                  await readControllerToolFile(path.join(directory, "site-uploaded.json"), 4096)
                ).toString("utf8"),
              );
              break;
            } catch (error) {
              if (!isRecord(error) || error.code !== "ENOENT") throw error;
              await delay(remaining(deadline, 100));
            }
          }
          if (
            !isRecord(locator) ||
            Object.keys(locator).sort().join(",") !== "artifact_id" ||
            typeof locator.artifact_id !== "number" ||
            !Number.isSafeInteger(locator.artifact_id) ||
            locator.artifact_id < 1
          )
            throw new Error("fixed catalog site upload locator differs");
          const readback = await verifyUploadedSiteArchive(prepared.session, {
            artifact_id: locator.artifact_id,
            run_id: Number(producer.run_id),
            run_attempt: producer.run_attempt,
            controller_revision: producer.controller_revision,
          });
          await requireActualCatalogRepository(assemblyReceipt, deadline);
          await refreshCapacityExecutor(executor);
          await boundary();
          return {
            remote_identity: `github-actions:boburning/portcove:artifact:${locator.artifact_id}`,
            evidence_sha256: digest(readback),
          };
        },
      );
      checkpoint = uploaded.checkpoint;
      await boundary();
      controls = await fresh();
      stage = "durable-pages-public-readback-and-component-cursor";
      const result = await publishPreparedSiteDeployment(
        prepared.session,
        executor,
        controls,
        {
          repository: state.repository,
          checkpoint,
          remote_configuration: remote,
          catalog_publication: subject,
        },
        async () => {
          controls = await fresh();
          return controls;
        },
      );
      remaining(deadline);
      const completed = await readRemoteCoordinatorSnapshot(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      if (completed.checkpoint !== result.checkpoint || completed.input.catalog_publication != null)
        throw new Error("catalog site final durable cursor readback differs");
      return { ...result, decision: "catalog-site-published", authority: "none" };
    } catch (error) {
      await writeFile(
        path.join(directory, "refusal.json"),
        JSON.stringify({ stage, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(`catalog site stopped; retain ${directory}`, { cause: error });
    }
  });
}
