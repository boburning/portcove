/** Actual coordinator continuation. No caller JSON may replace its preparation
 * receipt; this job has public inputs and the existing journal role, no keys. */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  prepareCoordinatorSigningContext,
  requireCoordinatorSigningContext,
  bindCoordinatorSigningContextPending,
} from "./release-metadata-signing-context.mts";
import {
  prepareMetadataSigningContextArtifact,
  handoffSigningContextArtifact,
  signingContextRemaining,
  signingContextPredicateType,
} from "./release-signing-context-artifact.mts";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

export async function completeCoordinatorSigningContext(
  actualPreparation: object,
  parent: string,
  phaseDeadline?: number,
) {
  const receipt = await prepareCoordinatorSigningContext(actualPreparation, parent, phaseDeadline),
    context = await requireCoordinatorSigningContext(receipt),
    deadline = context.deadline;
  return withCoordinatorDeadline(deadline, async () => {
    signingContextRemaining(deadline, 15000);
    const authorities = await requireControllerPublicationAuthorities("coordinator"),
      identity = {
        audience: "portcove-capacity-executor",
        subject: controllerOidcSubject(
          context.tools.identity.controller_ref,
          releaseControlPhaseProfile("coordinator").reader_environment,
        ),
        controller_revision: context.tools.identity.controller_revision,
        controller_ref: context.tools.identity.controller_ref,
        run_id: context.tools.identity.run_id,
        run_attempt: context.tools.identity.run_attempt,
        actor_id: authorities.apps.dispatch.actor_id,
      };
    const executor = await authenticateCapacityExecutor("coordinator", identity, parent, deadline);
    const artifact = await prepareMetadataSigningContextArtifact(receipt, parent);
    const directory = artifact.directory;
    await writeFile(
      path.join(parent, "metadata-context-session.json"),
      JSON.stringify({ schema_version: 1, directory }),
      { flag: "wx", mode: 0o600 },
    );
    let phase = "existing-metadata-pending",
      handoff: Awaited<ReturnType<typeof handoffSigningContextArtifact>> | undefined;
    try {
      const current = await requireCoordinatorSigningContext(receipt, deadline);
      const settlement = await executeOwnedCapacityEffect(
        executor,
        {
          repository: current.coordinator_repository,
          checkpoint: current.checkpoint,
          remote_configuration: { schema_version: 1, namespace: current.namespace },
          metadata_renewal: current.descriptor,
          request: {
            kind: "upload",
            destination: "github-actions:boburning/portcove:metadata-renewal-context",
          },
        },
        async () =>
          (await requireCoordinatorSigningContext(receipt, deadline)).capacity_source.capacity
            .boundary,
        async (pending) => {
          await bindCoordinatorSigningContextPending(receipt, executor, pending);
          phase = "fixed-public-context-upload";
          handoff = await handoffSigningContextArtifact(artifact, identity, pending, deadline);
          await requireCoordinatorSigningContext(receipt, deadline);
          return {
            remote_identity: `github-actions:boburning/portcove:artifact:${handoff.artifact_id}`,
            evidence_sha256: handoff.predicate_sha256,
          };
        },
      );
      if (!handoff) throw new Error("actual metadata handoff was not independently read back");
      phase = "metadata-upload-settlement";
      await requireCoordinatorSigningContext(receipt, deadline);
      signingContextRemaining(deadline, 15000);
      const result = Object.freeze({
        decision: "metadata-context-prepared",
        mode: "renewal",
        directory,
        artifact: { id: handoff.artifact_id, sha256: handoff.sha256 },
        manifest_sha256: handoff.manifest_sha256,
        predicate_path: path.join(directory, "signing-context-predicate.json"),
        subject_path: path.join(directory, "signing-context-manifest.json"),
        subject_name: "metadata-signing-context-manifest",
        predicate_type: signingContextPredicateType,
        subject_digest: handoff.manifest_sha256,
        settlement,
        pending_obligations: [
          "actual-context-attestation",
          "five-separate-online-role-envelopes",
          "keyless-Tough-assembly",
          "metadata-publication",
          "public-readback",
        ],
        authority: "none",
      });
      await writeFile(path.join(parent, "metadata-context-result.json"), JSON.stringify(result), {
        flag: "wx",
        mode: 0o600,
      });
      signingContextRemaining(deadline, 15000);
      return result;
    } catch {
      await writeFile(
        path.join(directory, "controller-refusal.json"),
        JSON.stringify({ phase, authority: "none", automatic_retry: false }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(
        "actual metadata context continuation stopped; retain public context and pending receipts",
      );
    }
  });
}
