/** Unchanged-feed publication through the existing site executor. This path
 * cannot manufacture a release result, native qualification or prior site. */
import path from "node:path";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { currentPublishedSite } from "./release-catalog-metadata-contract.mts";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectMetadataSigningReservation } from "./release-metadata-signing-contract.mts";
import { inspectPublishedMetadata } from "./release-metadata-contract.mts";
import {
  requireActualTufPublication,
  requireRetainedActualTufPublication,
  prepareActualTufPublication,
} from "./release-tuf-publication.mts";
import { receiveMetadataSigningContextArtifact } from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import { receiveControllerTools } from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { receiveTufRoleArtifact } from "./release-tuf-role-artifact.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { currentSiteJobDeadline } from "./release-site-job-budget.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
  materializePublishedCatalogCompleteSite,
  requirePublishedCatalogCompleteSite,
} from "./release-site-readback.mts";
import {
  prepareSiteDeploymentFromActualTufPublication,
  prepareInitialSiteDeploymentFromActualTufPublication,
  prepareInitialApplicationOverCatalogSiteDeployment,
  verifyPriorPublicSite,
  verifyUploadedSiteArchive,
  publishPreparedSiteDeployment,
} from "./release-site-deployment.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
} from "./release-capacity-executor.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

function remaining(deadline: number, maximum = 15000) {
  const left = Math.floor(Math.min(deadline - performance.now(), maximum));
  if (!Number.isFinite(deadline) || left < 1)
    throw new Error("metadata site original deadline exhausted");
  return left;
}
async function retain(file: string, value: unknown) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Current journal integrity only, never signing or publication authority. */
export function inspectMetadataSiteReservation(rawInput: unknown, rawManifest: unknown) {
  if (
    !isRecord(rawInput) ||
    !isRecord(rawManifest) ||
    rawManifest.kind !== "metadata-signing-context" ||
    !isRecord(rawManifest.facts) ||
    !["renewal", "bootstrap"].includes(String(rawManifest.facts.mode))
  )
    throw new Error("metadata site requires an explicit unchanged-feed context");
  const descriptor = inspectMetadataSigningReservation(
    rawManifest.facts,
    rawManifest.binding,
    rawManifest.previous_site_pins,
    { input: rawInput },
  );
  return {
    descriptor,
    mode: rawManifest.facts.mode === "bootstrap" ? ("bootstrap" as const) : ("renewal" as const),
    candidate_sha256: digest(rawInput.active_candidate ?? null),
    authority: "none" as const,
  };
}
/** Fixed existing site job; raw locators are independently authenticated by
 * the maintained receivers and never become caller-appointed authority. */
export async function runFixedMetadataSiteConfiguration(
  raw: unknown,
  parent: string,
  phaseDeadline: number,
) {
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "context,identity,mode,roles,tools" ||
    input.mode !== "metadata" ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !Array.isArray(input.roles) ||
    input.roles.length !== 5 ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed metadata site invocation differs");
  const identity = inspectAssemblerIdentityExpectation(input.identity);
  if (
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("metadata site invocation is not its original fixed job");
  remaining(phaseDeadline);
  const deadline = currentSiteJobDeadline(identity, parent, phaseDeadline);
  const toolsInput = input.tools,
    roleInputs: unknown[] = input.roles;
  return withCoordinatorDeadline(deadline, async () => {
    const directory = await mkdtemp(path.join(parent, "metadata-site-bootstrap-"));
    const tools = await receiveControllerTools(
      directory,
      toolsInput.artifact as ControllerToolArtifactExpected,
      toolsInput.bundle as { artifact_id: number; sha256: string },
      { deadline },
    );
    const context = await receiveMetadataSigningContextArtifact(
      directory,
      input.context as SigningContextArtifactExpected,
      deadline,
    );
    const roles = [],
      order = ["releases", "preview", "stable", "snapshot", "timestamp"];
    for (const [index, role] of roleInputs.entries()) {
      if (!isRecord(role) || role.role !== order[index])
        throw new Error("metadata site five-role order differs");
      roles.push(await receiveTufRoleArtifact(context, directory, role, deadline));
    }
    const tuf = await prepareActualTufPublication(context, tools, roles, directory, deadline);
    return runMetadataSitePublicationController(tuf, identity, parent, deadline);
  });
}

export async function runMetadataSitePublicationController(
  actualTufReceipt: object,
  rawIdentity: unknown,
  outputParent: string,
  phaseDeadline: number,
) {
  remaining(phaseDeadline);
  // Reject imported receipts before allocating files or reading protected setup.
  const tuf = await requireActualTufPublication(actualTufReceipt, phaseDeadline);
  const identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  if (
    !path.isAbsolute(outputParent) ||
    identity.controller_revision !== tuf.tools.identity.controller_revision ||
    identity.controller_ref !== tuf.tools.identity.controller_ref ||
    identity.run_id !== tuf.tools.identity.run_id ||
    identity.run_attempt !== tuf.tools.identity.run_attempt ||
    tuf.context.manifest.kind !== "metadata-signing-context" ||
    !isRecord(tuf.context.manifest.facts) ||
    !["renewal", "bootstrap"].includes(String(tuf.context.manifest.facts.mode))
  )
    throw new Error("metadata site actual context/current tools differ");
  const deadline = currentSiteJobDeadline(identity, outputParent, phaseDeadline);
  return withCoordinatorDeadline(deadline, async () => {
    const authorities = await requireControllerPublicationAuthorities("site-publication"),
      remote = { schema_version: 1, namespace: authorities.namespace };
    const directory = await mkdtemp(path.join(outputParent, "metadata-site-controller-"));
    let stage = "current-metadata-journal";
    try {
      const recovered = await recoverRemoteCoordinator(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      let checkpoint = recovered.checkpoint;
      const selected = inspectMetadataSiteReservation(recovered.input, tuf.context.manifest);
      const bootstrap = selected.mode === "bootstrap";
      const rawPins = tuf.context.manifest.previous_site_pins;
      const pins = isRecord(rawPins) ? rawPins : null;
      if (
        !bootstrap &&
        (!isRecord(pins) ||
          pins.root_sha256 !== authorities.publication.public_source.root.sha256 ||
          typeof pins.repository_sha256 !== "string" ||
          typeof pins.root_sha256 !== "string" ||
          typeof pins.site_generation_sha256 !== "string")
      )
        throw new Error("metadata prior differs from protected public root");
      const catalogPrior =
        bootstrap && pins
          ? await materializePublishedCatalogCompleteSite(
              {
                root_sha256: String(pins.root_sha256),
                repository_sha256: String(pins.repository_sha256),
                site_generation_sha256: String(pins.site_generation_sha256),
              },
              directory,
              deadline,
            )
          : null;
      const prior = bootstrap
        ? null
        : await materializePublishedCompleteSite(
            {
              repository_sha256: String(pins!.repository_sha256),
              root_sha256: String(pins!.root_sha256),
              site_generation_sha256: String(pins!.site_generation_sha256),
            },
            directory,
            deadline,
          );
      const prepared = catalogPrior
        ? await prepareInitialApplicationOverCatalogSiteDeployment(
            actualTufReceipt,
            catalogPrior.receipt,
            directory,
            deadline,
          )
        : prior === null
          ? await prepareInitialSiteDeploymentFromActualTufPublication(
              actualTufReceipt,
              directory,
              deadline,
            )
          : await prepareSiteDeploymentFromActualTufPublication(
              actualTufReceipt,
              prior.receipt,
              directory,
              deadline,
            );
      if (!prepared.changed)
        throw new Error("metadata site unchanged; reconcile existing public handoff");
      await verifyPriorPublicSite(prepared.session);
      const executor = await authenticateCapacityExecutor(
          "site-publication",
          { ...identity, audience: "portcove-capacity-executor" },
          directory,
          deadline,
        ),
        executorIdentity = capacityExecutorIdentity(executor);
      const api = new GitHubApiClient((args, input) => {
        remaining(deadline);
        const result = createGitHubRunner({
          cwd: directory,
          timeoutMs: remaining(deadline),
          maxBuffer: 2 * 1024 ** 2,
        })([...args, "--hostname", "github.com"], input);
        remaining(deadline);
        return result;
      });
      let round = 0;
      const fresh = async () => {
        if (++round > 5) throw new Error("metadata site control-round limit exhausted");
        await requireRetainedActualTufPublication(actualTufReceipt, deadline);
        if (prior) await requirePublishedCompleteSite(prior.receipt);
        if (catalogPrior) await requirePublishedCatalogCompleteSite(catalogPrior.receipt);
        const source = await authenticateReleaseControlRound(
          path.join(directory, `controls-r${round}`),
          digest({ descriptor: selected.descriptor, generation: prepared.generation.generation }),
          "site-publication",
          round,
          { deadline },
        );
        if (source.evidence_scope !== "github.com")
          throw new Error("actual metadata site controls required");
        return source;
      };
      let controls = await fresh();
      const boundary = async () => {
        const state = await readRemoteCoordinatorSnapshot(directory, remote, {
          transport: { cwd: directory, deadline },
        });
        const current = inspectMetadataSiteReservation(state.input, tuf.context.manifest);
        if (current.candidate_sha256 !== selected.candidate_sha256)
          throw new Error("metadata renewal cannot change the active release candidate");
        const observed = controls.readMaintenance(api);
        if (observed.pause.publication_paused || !observed.resource_policy_matches_controller)
          throw new Error("metadata publication held by current maintenance controls");
        remaining(deadline);
        return observed.capacity_source.capacity.boundary;
      };
      stage = "durable-metadata-site-artifact";
      const uploaded = await executeOwnedCapacityEffect(
        executor,
        {
          repository: recovered.repository,
          checkpoint,
          remote_configuration: remote,
          ...(bootstrap
            ? { metadata_bootstrap: selected.descriptor }
            : { metadata_renewal: selected.descriptor }),
          request: {
            kind: "upload",
            destination: "github-actions:boburning/portcove:complete-site-artifact",
          },
        },
        boundary,
        async (pending) => {
          checkpoint = pending.checkpoint;
          // Same fixed action bridge as the release caller, after durable intent.
          await retain(path.join(directory, "site-upload-ready.json"), {
            archive: prepared.archive,
            name: `application-update-site-${executorIdentity.run_id}-${executorIdentity.run_attempt}`,
            generation: prepared.generation.generation,
            pending,
            authority: "none",
          });
          await retain(path.join(outputParent, "site-controller-ready.json"), {
            directory,
            authority: "none",
          });
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
            throw new Error("metadata site upload locator differs");
          const upload = await verifyUploadedSiteArchive(prepared.session, {
            artifact_id: locator.artifact_id,
            run_id: Number(executorIdentity.run_id),
            run_attempt: executorIdentity.run_attempt,
            controller_revision: executorIdentity.controller_revision,
          });
          await requireRetainedActualTufPublication(actualTufReceipt, deadline);
          await refreshCapacityExecutor(executor);
          await boundary();
          return {
            remote_identity: `github-actions:boburning/portcove:artifact:${locator.artifact_id}`,
            evidence_sha256: digest(upload),
          };
        },
      );
      checkpoint = uploaded.checkpoint;
      const settled = await readRemoteCoordinatorSnapshot(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      if (settled.checkpoint !== checkpoint)
        throw new Error("metadata site upload settlement changed");
      controls = await fresh();
      stage = "durable-metadata-pages-and-public-readback";
      const result = await publishPreparedSiteDeployment(
        prepared.session,
        executor,
        controls,
        {
          repository: recovered.repository,
          checkpoint,
          remote_configuration: remote,
          ...(bootstrap
            ? { metadata_bootstrap: selected.descriptor }
            : { metadata_renewal: selected.descriptor }),
        },
        async () => {
          controls = await fresh();
          return controls;
        },
      );
      remaining(deadline);
      const completed = await readRemoteCoordinatorSnapshot(directory, remote, {
          transport: { cwd: directory, deadline },
        }),
        published = inspectPublishedMetadata(completed.input.published_metadata);
      if (
        completed.checkpoint !== result.checkpoint ||
        digest(
          bootstrap ? completed.input.metadata_bootstrap : completed.input.metadata_renewal,
        ) !== digest(selected.descriptor) ||
        digest(completed.input.active_candidate ?? null) !== selected.candidate_sha256 ||
        !published ||
        published.operation_id !== result.operation_id ||
        published.publication.site_generation_sha256 !== prepared.generation.generation ||
        currentPublishedSite(completed.input)?.generation_sha256 !==
          prepared.generation.generation ||
        published.repository_sha256 !== tuf.publication.repository_sha256 ||
        published.records_sha256 !== tuf.publication.records_sha256
      )
        throw new Error("metadata publication handoff differs; retain settled effects");
      const output = {
        decision: "metadata-site-published",
        mode: selected.mode,
        directory,
        result,
        generation: prepared.generation.generation,
        release_candidate_changed: false,
        pending_obligations: ["eligible-cleanup"],
        authority: "none",
      };
      await retain(path.join(directory, "metadata-site-completed.json"), output);
      remaining(deadline);
      return Object.freeze(output);
    } catch {
      await writeFile(
        path.join(directory, "metadata-site-refusal.json"),
        JSON.stringify({ stage, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(`metadata site stopped; retain and reconcile ${directory}`);
    }
  });
}
