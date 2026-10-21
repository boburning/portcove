/** Fixed whole-site continuation. Public inputs and serialized locators cannot
 * appoint a publisher: actual context, five role receipts, immutable result,
 * current controls and executor identity all remain independently required. */
import path from "node:path";
import { mkdtemp, open, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  requireActualTufPublication,
  requireRetainedActualTufPublication,
} from "./release-tuf-publication.mts";
import {
  requireReceivedPublicationResult,
  receivePublicationResultArtifact,
} from "./release-publication-result-artifact.mts";
import type { PublicationResultArtifactExpected } from "./release-publication-result-artifact.mts";
import { receiveControllerTools } from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { receiveSigningContextArtifact } from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import { receiveTufRoleArtifact } from "./release-tuf-role-artifact.mts";
import { prepareActualTufPublication } from "./release-tuf-publication.mts";
import { releasePathContains } from "./release-path-safety.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
} from "./release-site-readback.mts";
import {
  prepareSiteDeploymentFromActualTufPublication,
  bindSiteDeploymentToPublicationResult,
  verifyPriorPublicSite,
  verifyUploadedSiteArchive,
  publishPreparedSiteDeployment,
} from "./release-site-deployment.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { inspectPublishedMetadata } from "./release-metadata-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
} from "./release-capacity-executor.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  publishCoordinatorCheckpoint,
  inspectCoordinatorRemoteNamespace,
} from "./release-coordinator-remote.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import { createReleasePublicationReader } from "./release-publication-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";

import { currentSiteJobDeadline } from "./release-site-job-budget.mts";
const started = performance.now();
function remaining(deadline: number, maximum = 15000) {
  const left = Math.floor(Math.min(maximum, deadline - performance.now()));
  if (!Number.isFinite(deadline) || left < 1)
    throw new Error(
      "whole-site phase exhausted; retain actual effects and read back before recovery",
    );
  return left;
}

export async function runFixedSiteConfiguration(
  raw: unknown,
  parent: string,
  phaseDeadline?: number,
) {
  const input: unknown = structuredClone(raw);
  if (isRecord(input) && input.mode === "metadata") {
    const deadline = Math.min(started + 290000, phaseDeadline ?? Infinity);
    remaining(deadline);
    return (
      await import("./release-metadata-site-controller.mts")
    ).runFixedMetadataSiteConfiguration(input, parent, deadline);
  }
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "context,identity,publication_result,roles,tools" ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !Array.isArray(input.roles) ||
    input.roles.length !== 5 ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed whole-site invocation fields differ");
  const toolsInput = input.tools,
    roleInputs: unknown[] = input.roles;
  const identity = inspectAssemblerIdentityExpectation(input.identity);
  if (
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("site invocation is not its original fixed job");
  const provisional = Math.min(started + 290000, phaseDeadline ?? Infinity);
  remaining(provisional);
  const deadline = currentSiteJobDeadline(identity, parent, provisional);
  return withCoordinatorDeadline(deadline, async () => {
    const directory = await mkdtemp(path.join(parent, "site-controller-bootstrap-"));
    const tools = await receiveControllerTools(
      directory,
      toolsInput.artifact as ControllerToolArtifactExpected,
      toolsInput.bundle as { artifact_id: number; sha256: string },
      { deadline },
    );
    const context = await receiveSigningContextArtifact(
      directory,
      input.context as SigningContextArtifactExpected,
      deadline,
    );
    const roles = [];
    const expectedRoles = ["releases", "preview", "stable", "snapshot", "timestamp"];
    for (const [index, role] of roleInputs.entries()) {
      if (!isRecord(role) || role.role !== expectedRoles[index])
        throw new Error("site five-role order differs");
      roles.push(await receiveTufRoleArtifact(context, directory, role, deadline));
    }
    const tuf = await prepareActualTufPublication(context, tools, roles, directory, deadline);
    const result = await receivePublicationResultArtifact(
      directory,
      input.publication_result as PublicationResultArtifactExpected,
      context,
      deadline,
    );
    return runSitePublicationController(tuf, result, identity, parent, deadline);
  });
}

/** Fixed Actions step bridge. Output locators grant no private session or
 * provider acceptance; the live controller verifies the actual archive bytes. */
async function siteUploadBridge(mode: "--ready" | "--uploaded") {
  const parent = process.env.RUNNER_TEMP;
  if (!parent || !path.isAbsolute(parent)) throw new Error("site runner root unavailable");
  const deadline = currentSiteJobDeadline(
    {
      controller_revision: process.env.GITHUB_SHA ?? "",
      controller_ref: process.env.GITHUB_REF ?? "",
      run_id: process.env.GITHUB_RUN_ID ?? "",
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    },
    parent,
    started + 290000,
  );
  let pointer: unknown;
  for (;;) {
    remaining(deadline);
    try {
      await readControllerToolFile(path.join(parent, "site-controller-process-ended.json"), 4096);
      throw new Error("site producer already ended before handoff; preserve pending intent");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    try {
      pointer = JSON.parse(
        (
          await readControllerToolFile(path.join(parent, "site-controller-ready.json"), 4096)
        ).toString("utf8"),
      );
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await delay(remaining(deadline, 100));
    }
  }
  if (
    !isRecord(pointer) ||
    Object.keys(pointer).sort().join(",") !== "authority,directory" ||
    pointer.authority !== "none" ||
    typeof pointer.directory !== "string" ||
    !releasePathContains(parent, pointer.directory) ||
    path.dirname(pointer.directory) !== path.resolve(parent) ||
    !/^site-controller-[A-Za-z0-9_-]+$/u.test(path.basename(pointer.directory))
  )
    throw new Error("fixed site output locator differs");
  if (mode === "--uploaded") {
    const id = Number(process.env.PORTCOVE_SITE_ARTIFACT_ID);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("site action artifact identity missing");
    await retain(path.join(pointer.directory, "site-uploaded.json"), { artifact_id: id });
    return;
  }
  const ready: unknown = JSON.parse(
    (
      await readControllerToolFile(path.join(pointer.directory, "site-upload-ready.json"), 8192)
    ).toString("utf8"),
  );
  const expectedName = `application-update-site-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  if (
    !isRecord(ready) ||
    ready.name !== expectedName ||
    typeof ready.archive !== "string" ||
    !releasePathContains(pointer.directory, ready.archive) ||
    path.basename(ready.archive) !== "artifact.tar" ||
    !/^site-deployment-[A-Za-z0-9_-]+\/upload\/artifact[.]tar$/u.test(
      path.relative(pointer.directory, ready.archive).replaceAll("\\", "/"),
    ) ||
    !process.env.GITHUB_OUTPUT
  )
    throw new Error("fixed site upload readiness unavailable");
  await readControllerToolFile(ready.archive, 512 * 1024 ** 2);
  await appendFile(process.env.GITHUB_OUTPUT, `archive=${ready.archive}\nname=${expectedName}\n`);
}

if (
  process.argv[1] &&
  /^release-site-controller(?:[.]mts|(?:[.]bundle)?[.]mjs)$/u.test(
    path.basename(process.argv[1]),
  ) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runSiteUploadCli().catch(() => {
    console.error("fixed site upload bridge refused; retain original pending intent and evidence");
    process.exitCode = 1;
  });
}
async function runSiteUploadCli() {
  const mode = process.argv[2];
  if ((mode === "--ready" || mode === "--uploaded") && process.argv.length === 3)
    await siteUploadBridge(mode);
  else
    throw new Error(
      "whole-site CLI permits only fixed upload step handoff; run uses verified bundle export",
    );
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

/** Association only. The fixed caller supplies actual remote journal and
 * authenticated result; no booleans or copied report establish those origins. */
export function inspectSitePublicationReservation(
  rawInput: unknown,
  rawResult: unknown,
  rawFacts: unknown,
) {
  const input: unknown = structuredClone(rawInput),
    result: unknown = structuredClone(rawResult),
    facts: unknown = structuredClone(rawFacts);
  if (
    !isRecord(input) ||
    !isRecord(input.active_candidate) ||
    !isRecord(result) ||
    !isRecord(result.candidate) ||
    !isRecord(facts)
  )
    throw new Error("site publication requires exact candidate and complete reviewed opportunity");
  const candidate = input.active_candidate,
    published = result.candidate;
  if (
    candidate.phase !== "promoting" ||
    candidateProgressIdentity(candidate) !== candidateProgressIdentity(published) ||
    digest([candidate.release_run, candidate.transient_retries, candidate.substantive_repairs]) !==
      digest([published.release_run, published.transient_retries, published.substantive_repairs]) ||
    digest(candidate.frozen_opportunity) !== digest(facts.opportunity)
  )
    throw new Error("site result differs from actual promoting reservation or frozen review");
  return { candidate_sha256: candidateProgressIdentity(candidate), authority: "none" as const };
}

/** One actual new-release path. Maintenance uses its own authenticated metadata
 * subject and must never fabricate this release result or its native facts. */
export async function runSitePublicationController(
  actualTufReceipt: object,
  actualResultReceipt: object,
  rawIdentity: unknown,
  outputParent: string,
  phaseDeadline?: number,
) {
  const deadline = Math.min(started + 290000, phaseDeadline ?? Infinity);
  remaining(deadline);
  // Brand refusals precede filesystem, provider or protected configuration work.
  const tuf = await requireActualTufPublication(actualTufReceipt, deadline);
  const publication = await requireReceivedPublicationResult(actualResultReceipt, deadline);
  const identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  if (
    tuf.context_receipt !== publication.context_receipt ||
    !path.isAbsolute(outputParent) ||
    identity.controller_revision !== tuf.tools.identity.controller_revision ||
    identity.controller_ref !== tuf.tools.identity.controller_ref ||
    identity.run_id !== tuf.tools.identity.run_id ||
    identity.run_attempt !== tuf.tools.identity.run_attempt
  )
    throw new Error("whole-site current controller and authenticated context differ");
  return withCoordinatorDeadline(deadline, async () => {
    const authorities = await requireControllerPublicationAuthorities("site-publication");
    const remote = { schema_version: 1, namespace: authorities.namespace };
    const directory = await mkdtemp(path.join(outputParent, "site-controller-"));
    let stage = "current-journal-and-whole-site";
    try {
      const recovered = await recoverRemoteCoordinator(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      let checkpoint = recovered.checkpoint;
      inspectSitePublicationReservation(
        recovered.input,
        publication.record,
        publication.context.manifest.facts,
      );
      const published = inspectPublishedMetadata(recovered.input.published_metadata);
      const pins = publication.context.manifest.previous_site_pins;
      if (
        !published ||
        typeof published.repository_sha256 !== "string" ||
        typeof published.publication.site_generation_sha256 !== "string" ||
        !isRecord(pins) ||
        published.root_sha256 !== authorities.publication.public_source.root.sha256 ||
        published.repository_sha256 !== pins.repository_sha256 ||
        published.root_sha256 !== pins.root_sha256 ||
        published.publication.site_generation_sha256 !== pins.site_generation_sha256
      )
        throw new Error("current published seed differs from original signed prior");
      const prior = await materializePublishedCompleteSite(
        {
          repository_sha256: published.repository_sha256,
          root_sha256: published.root_sha256,
          site_generation_sha256: published.publication.site_generation_sha256,
        },
        directory,
        deadline,
      );
      const prepared = await prepareSiteDeploymentFromActualTufPublication(
        actualTufReceipt,
        prior.receipt,
        directory,
        deadline,
      );
      if (!prepared.changed)
        throw new Error(
          "new release has no changed complete-site generation; reconcile existing publication",
        );
      await bindSiteDeploymentToPublicationResult(
        prepared.session,
        actualResultReceipt,
        tuf.tools_receipt,
      );
      await verifyPriorPublicSite(prepared.session);
      const executor = await authenticateCapacityExecutor(
        "site-publication",
        {
          ...identity,
          audience: "portcove-capacity-executor",
        },
        directory,
        deadline,
      );
      const executorIdentity = capacityExecutorIdentity(executor);
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
        if (++round > 5) throw new Error("fixed whole-site control round budget exhausted");
        await requireRetainedActualTufPublication(actualTufReceipt, deadline);
        await requireReceivedPublicationResult(actualResultReceipt, deadline);
        await requirePublishedCompleteSite(prior.receipt);
        const source = await authenticateReleaseControlRound(
          path.join(directory, `controls-r${round}`),
          digest({
            facts: publication.context.manifest.facts,
            generation: prepared.generation.generation,
          }),
          "site-publication",
          round,
          { deadline },
        );
        if (source.evidence_scope !== "github.com")
          throw new Error("actual site controls required");
        return source;
      };
      let controls = await fresh();
      const currentBoundary = () => {
        remaining(deadline);
        const facts = publication.context.manifest.facts;
        if (!isRecord(facts)) throw new Error("actual complete opportunity missing");
        const observed = controls.read(api, facts.opportunity);
        if (observed.pause.publication_paused || !observed.resource_policy_matches_controller)
          throw new Error("fresh site controls hold this attempt");
        return observed.capacity_source.capacity.boundary;
      };
      const boundary = async () => {
        remaining(deadline);
        const state = await readRemoteCoordinatorSnapshot(directory, remote, {
          transport: { cwd: directory, deadline },
        });
        inspectSitePublicationReservation(
          state.input,
          publication.record,
          publication.context.manifest.facts,
        );
        return currentBoundary();
      };
      stage = "durable-site-artifact-intent";
      const uploaded = await executeOwnedCapacityEffect(
        executor,
        {
          repository: recovered.repository,
          checkpoint,
          remote_configuration: remote,
          request: {
            kind: "upload",
            destination: "github-actions:boburning/portcove:complete-site-artifact",
          },
        },
        boundary,
        async (pending) => {
          checkpoint = pending.checkpoint;
          // The fixed upload action is released only after remote pending exists.
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
            throw new Error("fixed site upload numeric locator missing");
          const upload = await verifyUploadedSiteArchive(prepared.session, {
            artifact_id: locator.artifact_id,
            run_id: Number(executorIdentity.run_id),
            run_attempt: executorIdentity.run_attempt,
            controller_revision: executorIdentity.controller_revision,
          });
          await requireReceivedPublicationResult(actualResultReceipt, deadline);
          await refreshCapacityExecutor(executor);
          await boundary();
          return {
            remote_identity: `github-actions:boburning/portcove:artifact:${locator.artifact_id}`,
            evidence_sha256: digest(upload),
          };
        },
      );
      checkpoint = uploaded.checkpoint;
      const snapshot = await readRemoteCoordinatorSnapshot(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      if (snapshot.checkpoint !== checkpoint)
        throw new Error("site upload settlement changed; retain original artifact");
      const current = await recoverReleaseOpportunity(recovered.repository, checkpoint);
      if (
        !isRecord(current.input.active_candidate) ||
        current.input.active_candidate.phase !== "promoting"
      )
        throw new Error("site publication requires the actual promoting candidate");
      controls = await fresh();
      stage = "durable-pages-and-public-readback";
      const result = await publishPreparedSiteDeployment(
        prepared.session,
        executor,
        controls,
        {
          repository: recovered.repository,
          checkpoint,
          remote_configuration: remote,
        },
        async () => {
          controls = await fresh();
          return controls;
        },
      );
      remaining(deadline);
      stage = "durable-candidate-completion";
      const completionSnapshot = await readRemoteCoordinatorSnapshot(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      if (completionSnapshot.checkpoint !== result.checkpoint)
        throw new Error("site metadata handoff changed before candidate completion");
      inspectSitePublicationReservation(
        completionSnapshot.input,
        publication.record,
        publication.context.manifest.facts,
      );
      const completedMetadata = inspectPublishedMetadata(
        completionSnapshot.input.published_metadata,
      );
      if (
        !completedMetadata ||
        completedMetadata.operation_id !== result.operation_id ||
        completedMetadata.publication.site_generation_sha256 !== prepared.generation.generation ||
        completedMetadata.repository_sha256 !== tuf.publication.repository_sha256 ||
        completedMetadata.records_sha256 !== tuf.publication.records_sha256
      )
        throw new Error("actual public metadata differs before candidate completion");
      // Complete inventory reuses the existing provider reader and allocation
      // associations. Observing one Release cannot refresh account-wide facts.
      const { deriveCoordinatorPublication } = await import("./release-coordinator-driver.mts");
      const inventory = createReleasePublicationReader(api),
        tags = inventory.tags(),
        releases = inventory.releases();
      const { allocations } = inventory.readAllocations(
        tags,
        inspectCoordinatorRemoteNamespace(remote),
      );
      const nextPublication = deriveCoordinatorPublication(
        tags,
        releases,
        allocations,
        new Date().toISOString(),
      );
      if (
        digest({ tags, releases }) !==
        digest({ tags: inventory.tags(), releases: inventory.releases() })
      )
        throw new Error("publication inventory changed during candidate completion");
      if (!isRecord(publication.record.candidate))
        throw new Error("actual result candidate missing");
      if (
        !nextPublication.published_versions.includes(
          String(publication.record.candidate.version),
        ) ||
        !nextPublication.published_sources.includes(
          String(publication.record.candidate.source_commit),
        )
      )
        throw new Error("completed candidate missing from exact published inventory");
      controls = await fresh();
      await boundary();
      const next = structuredClone(completionSnapshot.input);
      next.active_candidate = null;
      next.publication = nextPublication;
      next.now = new Date().toISOString();
      const saved = await checkpointReleaseOpportunity(
        recovered.repository,
        result.checkpoint,
        next,
      );
      const journal = createCoordinatorJournalApi(directory, deadline);
      const completionRemote = await publishCoordinatorCheckpoint(
        recovered.repository,
        saved.checkpoint,
        remote,
        {
          api: {
            request: journal.request.bind(journal),
            graphql(query, variables) {
              if (/^\s*mutation\b/u.test(query)) currentBoundary();
              return journal.graphql(query, variables);
            },
          },
        },
      );
      remaining(deadline);
      const completed = await readRemoteCoordinatorSnapshot(directory, remote, {
        transport: { cwd: directory, deadline },
      });
      if (completed.checkpoint !== saved.checkpoint || completed.input.active_candidate !== null)
        throw new Error("candidate completion readback ambiguous; preserve published effects");
      await retain(path.join(directory, "site-completed.json"), {
        candidate_completion: { checkpoint: saved.checkpoint, remote: completionRemote },
        result,
        generation: prepared.generation.generation,
        pending_obligations: ["ordinary-public-updater-journey", "eligible-cleanup"],
        authority: "none",
      });
      return Object.freeze({
        decision: "site-published",
        directory,
        result,
        candidate_completion: { checkpoint: saved.checkpoint },
        pending_obligations: ["ordinary-public-updater-journey", "eligible-cleanup"],
        authority: "none",
      });
    } catch {
      await writeFile(
        path.join(directory, "site-controller-refusal.json"),
        JSON.stringify({ stage, automatic_retry: false, authority: "none" }),
        { flag: "wx", mode: 0o600 },
      );
      throw new Error(`whole-site controller stopped; retain and reconcile ${directory}`);
    }
  });
}
