import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { inspectCandidateStageEvidence } from "./release-candidate-progress-contract.mts";
import { inspectConsumedPublicationReportRepair } from "./release-report-repair-contract.mts";
import { isRecord } from "./runtime-values.mts";
import {
  acquireActualAdmittedAggregateEligibility,
  requireActualAdmittedAggregateEligibility,
} from "./acquire-release-admission.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import { requireControllerApplicationJobAuthorities } from "./release-authority-configuration.mts";
import {
  advanceActualCandidateToBuilding,
  requireActualCandidatePhaseAdvance,
} from "./release-candidate-progress.mts";
import {
  aggregateEvidenceRequestFromObservation,
  requireReservedAggregate,
  inspectReservedPublicationReadback,
} from "./production-aggregate-steps.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import {
  readRemoteCoordinatorSnapshot,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  capacityDigest,
  inspectCapacityOperation,
  inspectCompactCapacityOperations,
} from "./release-capacity.mts";
import {
  inspectAggregateUploadExpectation,
  inspectAggregateOriginalUpload,
  assertAggregateUploadCandidate,
} from "./release-aggregate-contract.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  recoverOwnedAdmittedAggregateEffect,
} from "./release-capacity-executor.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import { requireVerifiedReleasePublicBuildInputs } from "./release-public-build-provenance.mts";
import { controllerOidcSubject, requestAssemblerToken } from "./assembler-job-identity.mts";
import {
  prepareAdmittedAggregateAttestation,
  prepareRecoveredAdmittedAggregateAttestation,
} from "./trusted-aggregate-attestation.mts";
import {
  handoffAdmittedAggregateUpload,
  readAdmittedAggregateUpload,
  readTerminalAggregateProducer,
} from "./release-aggregate-upload.mts";

/** Inert selection only. Resume never re-runs the qualifying phase transition. */
export function inspectAdmittedAggregateResume(candidate: unknown) {
  if (
    !isRecord(candidate) ||
    !["qualifying", "building", "publishing", "promoting"].includes(String(candidate.phase))
  )
    throw new Error("existing qualifying/building candidate required");
  if (candidate.phase === "qualifying") return "advance" as const;
  if (candidate.phase === "publishing" || candidate.phase === "promoting") {
    const history = inspectCandidateStageEvidence(candidate.stage_evidence, candidate);
    if (
      !history.some((slot) => slot.phase === "building") ||
      !history.some(
        (slot) =>
          slot.phase === candidate.phase &&
          slot.attempts.some(
            (attempt) =>
              capacityDigest(attempt.release_run) === capacityDigest(candidate.release_run),
          ),
      )
    )
      throw new Error("aggregate later-phase custody requires retained exact stage/run history");
    return "readback" as const;
  }
  assertAggregateUploadCandidate(candidate);
  return "resume" as const;
}

/** Same-bundle complete job, selected by the fixed building/admission ABI.
 * Neither the closed JSON nor successful parsing supplies any admission. */
export async function runFixedAdmittedAggregateConfiguration(
  raw: unknown,
  root: string,
  deadline: number,
) {
  return withCoordinatorDeadline(deadline, () =>
    withReadOnlyReleaseChildren(root, async () => {
      const active = () => {
        if (!Number.isFinite(deadline) || deadline <= performance.now())
          throw new Error("original combined admission/aggregate deadline exhausted");
      };
      active();
      if (
        !isRecord(raw) ||
        Object.keys(raw).sort().join(",") !== "configuration,native_locators,tools" ||
        !isRecord(raw.tools) ||
        Object.keys(raw.tools).sort().join(",") !== "artifact,bundle" ||
        !path.isAbsolute(root)
      )
        throw new Error("fixed admitted aggregate fields differ");
      const authorities = await requireControllerApplicationJobAuthorities("admission");
      const directory = await mkdtemp(path.join(root, "admitted-aggregate-"));
      const toolsReceipt = await receiveControllerTools(
        directory,
        raw.tools.artifact as Parameters<typeof receiveControllerTools>[1],
        raw.tools.bundle as Parameters<typeof receiveControllerTools>[2],
        { deadline },
      );
      const proof = await acquireActualAdmittedAggregateEligibility(
        directory,
        raw.configuration,
        toolsReceipt,
        raw.native_locators,
        deadline,
      );
      const admitted = await requireActualAdmittedAggregateEligibility(proof);
      const reportRepair = admitted.candidate.report_repair !== undefined;
      if (reportRepair) inspectConsumedPublicationReportRepair(admitted.candidate);
      const selection = inspectAdmittedAggregateResume(admitted.candidate);
      let checkpoint = admitted.checkpoint;
      if (admitted.aggregate_readback_only && selection === "advance")
        throw new Error("aggregate readback cannot advance candidate phase");
      if (selection === "advance") {
        const advanced = await advanceActualCandidateToBuilding(proof, { deadline });
        checkpoint = (await requireActualCandidatePhaseAdvance(advanced, "building")).checkpoint;
      }
      const coordinator = { schema_version: 1, namespace: authorities.namespace };
      const descriptor = {
        schema_version: 1,
        checkpoint,
        coordinator,
        assembly: admitted.facts.assembly,
        archives: admitted.facts.archives,
        evidence: aggregateEvidenceRequestFromObservation(admitted.facts.evidence),
      };
      const expectedCandidate = (await recoverReleaseOpportunity(admitted.repository, checkpoint))
        .input.active_candidate;
      inspectAdmittedAggregateResume(expectedCandidate);
      const api = new GitHubApiClient((args, body) => {
        active();
        const response = createGitHubRunner({
          cwd: directory,
          timeoutMs: Math.max(1, Math.floor(Math.min(15000, deadline - performance.now()))),
          maxBuffer: 2 * 1024 ** 2,
        })([...args, "--hostname", "github.com"], body);
        active();
        return response;
      });
      const tools = await verifiedControllerToolPaths(toolsReceipt);
      const expectedIdentity = {
        audience: "portcove-capacity-executor",
        subject: controllerOidcSubject(
          tools.identity.controller_ref,
          "production-release-admission",
        ),
        controller_revision: tools.identity.controller_revision,
        controller_ref: tools.identity.controller_ref,
        actor_id: admitted.reader.identity.actor_id,
        run_id: tools.identity.run_id,
        run_attempt: tools.identity.run_attempt,
      };
      const executor = await authenticateCapacityExecutor(
        "aggregate-assembly",
        expectedIdentity,
        directory,
        deadline,
      );
      const producer = capacityExecutorIdentity(executor);
      if (
        producer.job_id !== admitted.reader.identity.job_id ||
        producer.check_run_id !== admitted.reader.identity.check_run_id
      )
        throw new Error("admitted aggregate executor differs from the actual independent reader");
      let round = 0;
      const fresh = async () => {
        active();
        if (++round > 14) throw new Error("combined admission control rounds exhausted");
        await verifiedControllerToolPaths(toolsReceipt);
        const source = await authenticateReleaseControlRound(
          path.join(directory, `aggregate-controls-r${round}`),
          capacityDigest(admitted.facts),
          "admission",
          round,
          { deadline },
        );
        let calls = 0;
        const bounded = () => {
          if (++calls > 32) throw new Error("aggregate control read bound exhausted");
        };
        const current = source.read(
          {
            request(method, endpoint, body) {
              bounded();
              if (
                method !== "GET" ||
                body !== undefined ||
                !endpoint.startsWith("repos/boburning/portcove/")
              )
                throw new Error("aggregate controls permit fixed repository GETs only");
              return api.request(method, endpoint);
            },
            graphql(query, variables) {
              bounded();
              if (query !== releaseControlRefQuery)
                throw new Error("aggregate control query differs");
              return api.graphql(query, variables);
            },
          },
          admitted.facts.opportunity,
        );
        const original = admitted.admission.controls;
        if (
          !original ||
          current.pause.publication_paused ||
          !current.resource_policy_matches_controller ||
          !isDeepStrictEqual(current.classification, original.classification) ||
          !isDeepStrictEqual(current.pause, original.pause) ||
          !isDeepStrictEqual(current.capacity, original.capacity)
        )
          throw new Error("fresh aggregate controls differ from independent admission");
        await requireNativeReleaseQualificationPair(
          admitted.native_qualifications,
          admitted.facts.assembly,
          admitted.facts.archives,
          "payload-signing",
        );
        await requireVerifiedReleaseSbomDocument(admitted.sbom_receipt);
        await requireVerifiedReleasePublicBuildInputs(admitted.public_build_inputs_receipt);
        const snapshot = await readRemoteCoordinatorSnapshot(directory, coordinator, {
          transport: { cwd: directory, deadline },
        });
        if (snapshot.checkpoint !== checkpoint)
          throw new Error("aggregate current checkpoint changed");
        await (
          isRecord(expectedCandidate) && expectedCandidate.phase === "promoting"
            ? inspectReservedPublicationReadback
            : requireReservedAggregate
        )(JSON.stringify({ ...descriptor, checkpoint }), snapshot);
        const local = await recoverReleaseOpportunity(admitted.repository, checkpoint);
        if (capacityDigest(local.input.active_candidate) !== capacityDigest(expectedCandidate))
          throw new Error("aggregate candidate changed during current-control readback");
        active();
        return current;
      };
      await fresh();
      const current = await recoverReleaseOpportunity(admitted.repository, checkpoint);
      const controller = current.input.controller;
      const capacity =
        isRecord(controller) && isRecord(controller.capacity_attempt)
          ? controller.capacity_attempt
          : null;
      let old = capacity ? inspectCapacityOperation(capacity.operation) : null;
      if (
        old &&
        !["succeeded", "recovered"].includes(old.outcome) &&
        old.destination !== "github-actions:boburning/portcove:admitted-aggregate"
      )
        throw new Error("unrelated unresolved journal effect blocks aggregate continuation");
      if (
        old?.destination !== "github-actions:boburning/portcove:admitted-aggregate" &&
        capacity?.schema_version === 2
      ) {
        const groups = inspectCompactCapacityOperations(capacity.prior_operations).filter(
          (group) =>
            group.completed &&
            group.kind === "upload" &&
            group.destination_sha256 ===
              capacityDigest("github-actions:boburning/portcove:admitted-aggregate") &&
            group.subject.kind === "candidate" &&
            isRecord(expectedCandidate) &&
            group.subject.identity === expectedCandidate.prepared_commit,
        );
        if (groups.length > 1) throw new Error("retained aggregate history is ambiguous");
        if (groups.length === 1) {
          const attempts = [];
          for (const locator of groups[0]!.attempts) {
            active();
            const retained = await hydrateRetainedCoordinatorOperation(
              admitted.repository,
              locator,
            );
            if (
              retained &&
              retained.receipt_limit === 1 &&
              retained.completed_effects.length === 1 &&
              ["succeeded", "recovered"].includes(retained.outcome)
            )
              attempts.push(retained);
          }
          if (attempts.length !== 1)
            throw new Error("retained aggregate exact upload receipt unavailable");
          old = attempts[0]!;
        }
      }
      let observed: Awaited<ReturnType<typeof readAdmittedAggregateUpload>> | undefined;
      let settlement: { checkpoint: string; operation_id: unknown };
      const finishBinding = async (
        original?: ReturnType<typeof inspectAggregateOriginalUpload>,
      ) => {
        await fresh();
        if (original)
          readTerminalAggregateProducer(
            api,
            {
              actor_id: original.actor_id,
              check_run_id: original.check_run_id,
              controller_revision: original.controller_revision,
              execution_ref: original.execution_ref,
              job_id: original.job_id,
              role: "aggregate-assembly",
              run_attempt: original.run_attempt,
              run_id: original.run_id,
              workflow: original.workflow,
            },
            deadline,
          );
        const token = await requestAssemblerToken(
          "portcove-admitted-aggregate",
          process.env,
          fetch,
          deadline,
        );
        const args: Parameters<typeof prepareAdmittedAggregateAttestation> = [
          token,
          { ...expectedIdentity, audience: "portcove-admitted-aggregate" },
          descriptor.assembly,
          descriptor.archives.map((file) => file.artifact_id),
          { artifact_id: observed!.artifact.id, sha256: observed!.artifact.sha256 },
          { cwd: directory, evidenceRequest: descriptor.evidence, deadline },
        ];
        const binding = original
          ? await prepareRecoveredAdmittedAggregateAttestation(original, ...args)
          : await prepareAdmittedAggregateAttestation(...args);
        if (original)
          readTerminalAggregateProducer(
            api,
            {
              actor_id: original.actor_id,
              check_run_id: original.check_run_id,
              controller_revision: original.controller_revision,
              execution_ref: original.execution_ref,
              job_id: original.job_id,
              role: "aggregate-assembly",
              run_attempt: original.run_attempt,
              run_id: original.run_id,
              workflow: original.workflow,
            },
            deadline,
          );
        await fresh();
        await mkdir(path.join(directory, "attestation"), { mode: 0o700 });
        const predicatePath = path.join(directory, "attestation", "aggregate-predicate.json");
        await writeFile(predicatePath, JSON.stringify(binding.predicate), {
          flag: "wx",
          mode: 0o600,
        });
        active();
        return Object.freeze({
          decision:
            selection === "readback"
              ? "candidate-aggregate-readback-prepared"
              : "candidate-building-and-aggregate-prepared",
          stage: isRecord(expectedCandidate) ? String(expectedCandidate.phase) : "unknown",
          descriptor: { ...descriptor, checkpoint },
          artifact: observed!.artifact,
          settlement,
          ...(original ? { original_upload: original } : {}),
          subject_name: binding.subject_name,
          subject_digest: binding.subject_digest,
          predicate_type: binding.predicate_type,
          predicate_path: predicatePath,
          authority: "none",
        });
      };
      if (old?.destination === "github-actions:boburning/portcove:admitted-aggregate") {
        // Do not regenerate or upload again. Original terminal-job verification
        // brackets the complete exact artifact/full-byte readback in the executor.
        if (["pending", "ambiguous", "capacity-refused"].includes(old.outcome)) {
          settlement = await recoverOwnedAdmittedAggregateEffect(
            executor,
            { repository: admitted.repository, checkpoint, remote_configuration: coordinator },
            async (operation) => {
              await fresh();
              observed = await readAdmittedAggregateUpload(
                api,
                operation.executor_identity,
                operation.aggregate_expectation,
                admitted.facts.assembly,
                directory,
                deadline,
              );
              await fresh();
              return {
                resolution: "effect-completed",
                evidence_sha256: observed.evidence_sha256,
                completed_effect: {
                  remote_identity: `github-actions-artifact:${observed.artifact.id}`,
                  evidence_sha256: observed.evidence_sha256,
                },
              };
            },
          );
        } else {
          if (
            !["succeeded", "recovered"].includes(old.outcome) ||
            old.completed_effects.length !== 1
          )
            throw new Error("retained aggregate has no exact completed upload receipt");
          observed = await readAdmittedAggregateUpload(
            api,
            old.executor_identity,
            old.aggregate_expectation,
            admitted.facts.assembly,
            directory,
            deadline,
          );
          if (
            old.completed_effects[0]!.remote_identity !==
            `github-actions-artifact:${observed.artifact.id}`
          )
            throw new Error("aggregate readback differs from retained completed effect");
          settlement = { checkpoint, operation_id: old.id };
        }
        checkpoint = settlement.checkpoint;
        if (!old.executor_identity) throw new Error("original aggregate executor missing");
        const { role: _originalRole, ...originalProducer } = old.executor_identity;
        const origin = inspectAggregateOriginalUpload({
          ...originalProducer,
          before_checkpoint: old.before_checkpoint,
          operation_id: old.id,
          expectation_sha256: capacityDigest(old.aggregate_expectation),
        });
        // Original producer/job and current authenticated custodian stay distinct.
        // No package assembly or artifact upload is repeated.
        return finishBinding(origin);
      }
      if (admitted.aggregate_readback_only || reportRepair)
        throw new Error("readback-only aggregate proof cannot upload");
      const assembled = await assembleReleaseArtifacts(
        directory,
        descriptor.assembly,
        descriptor.archives,
        descriptor.evidence,
        { deadline },
      );
      active();
      const expectation = inspectAggregateUploadExpectation({
        assembly_sha256: capacityDigest(descriptor.assembly),
        files: assembled.aggregate.output_files
          .slice()
          .sort((a, b) => (a.filename < b.filename ? -1 : 1)),
      });
      settlement = await executeOwnedCapacityEffect(
        executor,
        {
          repository: admitted.repository,
          checkpoint,
          remote_configuration: coordinator,
          request: {
            kind: "upload",
            destination: "github-actions:boburning/portcove:admitted-aggregate",
            aggregate_expectation: expectation,
          },
        },
        async () => (await fresh()).capacity_source.capacity.boundary,
        async (pending) => {
          checkpoint = pending.checkpoint;
          await fresh();
          const locator = await handoffAdmittedAggregateUpload(
            process.env.RUNNER_TEMP ?? root,
            assembled.aggregate.directory,
            producer,
            pending,
            expectation,
            deadline,
          );
          observed = await readAdmittedAggregateUpload(
            api,
            producer,
            expectation,
            descriptor.assembly,
            directory,
            deadline,
            locator,
          );
          await fresh();
          return {
            remote_identity: `github-actions-artifact:${observed.artifact.id}`,
            evidence_sha256: observed.evidence_sha256,
          };
        },
      );
      checkpoint = settlement.checkpoint;
      if (!observed) throw new Error("actual aggregate upload readback missing");
      return finishBinding();
    }),
  );
}
