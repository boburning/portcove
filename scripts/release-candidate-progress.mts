import { performance } from "node:perf_hooks";
import {
  requireActualCandidateBuildingEligibility,
  requireActualReleaseAdmissionContext,
} from "./acquire-release-admission.mts";
import {
  candidateProgressIdentity,
  inspectCandidateStageEvidence,
  immutableReleaseProgressDigest,
} from "./release-candidate-progress-contract.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import { assessBoundedCapacity } from "./release-capacity.mts";
import { requireAuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { requireVerifiedReleasePublicBuildInputs } from "./release-public-build-provenance.mts";
import { requireReservedAggregate } from "./production-aggregate-steps.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

type Phase = "building" | "publishing" | "promoting";
type Locator = { kind: string; id: string; sha256: string | null };
async function actualProof(receipt: object, target: Phase) {
  if (target === "building") {
    const proof = await requireActualCandidateBuildingEligibility(receipt);
    if (proof.reader.admitted.schema_version === 1)
      throw new Error("protected qualifying admission required");
    return {
      ...proof,
      controller_revision: proof.reader.admitted.revision,
      control_phase: "admission" as const,
      native_stage: "payload-signing" as const,
      original_context: receipt,
      additional_locators: [] as Locator[],
      recheck: async () => {
        await requireActualCandidateBuildingEligibility(receipt);
      },
    };
  }
  // Completion is needed only at this actual phase boundary. A static edge
  // back to the publisher forms an async bundle-initialization cycle through
  // the admission CLI, even when its guarded main never executes.
  const { requireOwnedImmutableReleaseCompletion } =
    await import("./release-immutable-publication.mts");
  const completed =
    target === "promoting" ? await requireOwnedImmutableReleaseCompletion(receipt) : null;
  const originalContext = completed?.original_context ?? receipt;
  const context = requireActualReleaseAdmissionContext(originalContext, "release-publication");
  const configuration = context.facts.configuration;
  if (!isRecord(configuration)) throw new Error("actual publication namespace unavailable");
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: configuration.namespace,
  });
  const checkpoint = completed?.checkpoint ?? context.checkpoint;
  const current = await recoverReleaseOpportunity(context.coordinator_repository, checkpoint);
  if (
    completed &&
    releaseCanonicalDigest(current.input.active_candidate) !==
      releaseCanonicalDigest(completed.candidate)
  )
    throw new Error("settled immutable publication candidate changed");
  await requireReservedAggregate(
    JSON.stringify({
      schema_version: 1,
      checkpoint,
      coordinator: { schema_version: 1, namespace },
      assembly: context.facts.assembly,
      archives: context.facts.archives,
      evidence: context.facts.evidence,
    }),
    current,
  );
  if (!isRecord(current.input.active_candidate) || !context.admission.controls)
    throw new Error("actual publication reservation unavailable");
  const recheck = async () => {
    requireActualReleaseAdmissionContext(originalContext, "release-publication");
    if (completed) {
      const again = await requireOwnedImmutableReleaseCompletion(receipt);
      if (
        again.checkpoint !== checkpoint ||
        again.original_context !== originalContext ||
        releaseCanonicalDigest(again.operation) !== releaseCanonicalDigest(completed.operation) ||
        immutableReleaseProgressDigest(again.release) !==
          immutableReleaseProgressDigest(completed.release)
      )
        throw new Error("owned immutable publication completion changed");
    }
    await requireNativeReleaseQualificationPair(
      context.native_qualifications,
      context.facts.assembly,
      context.facts.archives,
      "release-publication",
    );
    await requireVerifiedReleaseSbomDocument(context.sbom_receipt);
    await requireVerifiedReleasePublicBuildInputs(context.public_build_inputs_receipt);
  };
  await recheck();
  return {
    ...context,
    checkpoint,
    repository: context.coordinator_repository,
    namespace,
    candidate: current.input.active_candidate,
    controller_revision: context.admission.controls.reader.controller_revision,
    control_phase: "release-publication" as const,
    native_stage: "release-publication" as const,
    original_context: originalContext,
    additional_locators: completed
      ? [
          {
            kind: "operation",
            id: completed.operation.id,
            sha256: releaseCanonicalDigest(completed.operation),
          },
          {
            kind: "immutable-release",
            id: String(completed.release.release_id),
            sha256: immutableReleaseProgressDigest(completed.release),
          },
        ]
      : ([] as Locator[]),
    recheck,
  };
}

const advances = new WeakMap<
  object,
  {
    original_context: object;
    phase: Phase;
    checkpoint: string;
    previous_checkpoint: string;
    repository: string;
    namespace: string;
    candidate: Record<string, unknown>;
    evidence_sha256: string;
    recheck: () => Promise<void>;
    fresh: () => unknown;
    deadline: number | undefined;
  }
>();

/** Only the actual same-process qualifying collector can enter this phase writer.
 * Stored public locators support recovery; they never replace fresh proof.
 * No aggregation, signing, payload execution or candidate completion occurs here. */
export async function advanceActualCandidateToBuilding(
  receipt: object,
  options: { deadline?: number } = {},
) {
  return advance(receipt, "building", options);
}
/** Full post-sign publication admission, never qualifying or payload admission. */
export async function advanceActualCandidateToPublishing(
  receipt: object,
  options: { deadline?: number } = {},
) {
  return advance(receipt, "publishing", options);
}
/** Actual settled publisher custody plus fresh post-sign controls, never mere
 * Release presence. Site publication and final completion remain separate. */
export async function advanceActualCandidateToPromoting(
  receipt: object,
  options: { deadline?: number } = {},
) {
  return advance(receipt, "promoting", options);
}
async function advance(receipt: object, target: Phase, options: { deadline?: number }) {
  const deadline = options.deadline;
  const work = () => advanceWithinDeadline(receipt, target, options);
  return deadline === undefined ? work() : withCoordinatorDeadline(deadline, work);
}
async function advanceWithinDeadline(
  receipt: object,
  target: Phase,
  options: { deadline?: number },
) {
  const deadline = options.deadline;
  const remaining = () => {
    const left = deadline === undefined ? 15000 : Math.floor(deadline - performance.now());
    if (!Number.isFinite(left) || left < 1 || left > 600000)
      throw new Error("candidate phase deadline exhausted");
    return Math.min(15000, left);
  };
  remaining();
  const proof = await actualProof(receipt, target);
  remaining();
  requireAuthenticatedReleaseControlSource(proof.controls, proof.control_phase);
  const preceding = { building: "qualifying", publishing: "building", promoting: "publishing" };
  if (proof.candidate.phase !== preceding[target])
    throw new Error("candidate progress requires its exact preceding phase");
  const current = await recoverReleaseOpportunity(proof.repository, proof.checkpoint);
  if (
    releaseCanonicalDigest(current.input.active_candidate) !==
      releaseCanonicalDigest(proof.candidate) ||
    !isRecord(current.input.controller) ||
    assessBoundedCapacity(current.input.controller.capacity_attempt).eligibility !== "eligible"
  )
    throw new Error("qualifying reservation changed or has unresolved/ineligible capacity");
  const candidate = structuredClone(proof.candidate);
  const api = new GitHubApiClient((args, input) => {
    const result = createGitHubRunner({
      cwd: proof.repository,
      maxBuffer: 256 * 1024,
      timeoutMs: remaining(),
    })([...args, "--hostname", "github.com"], input);
    remaining();
    return result;
  });
  const initial = proof.controls.read(api, proof.facts.opportunity);
  const fresh = () => {
    remaining();
    requireAuthenticatedReleaseControlSource(proof.controls, proof.control_phase);
    const observed = proof.controls.read(api, proof.facts.opportunity);
    if (
      observed.pause.publication_paused ||
      !observed.resource_policy_matches_controller ||
      releaseCanonicalDigest(observed.classification) !==
        releaseCanonicalDigest(initial.classification) ||
      releaseCanonicalDigest(observed.pause) !== releaseCanonicalDigest(initial.pause) ||
      observed.capacity.document_sha256 !== initial.capacity.document_sha256
    )
      throw new Error("candidate building controls changed or paused");
    return observed;
  };
  fresh();
  const native = await requireNativeReleaseQualificationPair(
    proof.native_qualifications,
    proof.facts.assembly,
    proof.facts.archives,
    proof.native_stage,
  );
  const sbom = await requireVerifiedReleaseSbomDocument(proof.sbom_receipt);
  await proof.recheck();
  const observed = fresh();
  const locators = [
    ...native.map((report) => ({
      kind: "native-check",
      id: String(report.check.id),
      sha256: report.check.report_sha256,
    })),
    ...proof.facts.archives.map((archive) => ({
      kind: "artifact",
      id: String(archive.artifact_id),
      sha256: archive.sha256,
    })),
    {
      kind: "classification-commit",
      id: observed.classification.commit,
      sha256: releaseCanonicalDigest(observed.classification.opportunity),
    },
    { kind: "semantic-check", id: String(observed.classification.review_check_id), sha256: null },
    { kind: "sbom", id: sbom.run_id, sha256: sbom.sha256 },
    ...proof.additional_locators,
  ].sort((a, b) => {
    const left = `${a.kind}:${a.id}`,
      right = `${b.kind}:${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const projection = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: proof.controller_revision,
    locators,
  };
  const histories =
    candidate.stage_evidence === undefined
      ? []
      : inspectCandidateStageEvidence(candidate.stage_evidence, candidate);
  let slot = histories.find((entry) => entry.phase === target);
  if (!slot) {
    slot = { phase: target, attempts: [] };
    histories.push(slot);
    histories.sort(
      (a, b) =>
        ["building", "publishing", "promoting"].indexOf(String(a.phase)) -
        ["building", "publishing", "promoting"].indexOf(String(b.phase)),
    );
  }
  slot.attempts.push({
    previous_checkpoint: proof.checkpoint,
    evidence_sha256: releaseCanonicalDigest(projection),
    proof: projection,
    release_run: structuredClone(candidate.release_run),
    transient_retries: candidate.transient_retries,
    substantive_repairs: candidate.substantive_repairs,
  });
  const next = {
    ...current.input,
    active_candidate: { ...candidate, phase: target, stage_evidence: histories },
  };
  // Local intent is retained on any ambiguous remote handoff. A fresh acquisition
  // must reconcile the existing checkpoint; this function never loops or re-POSTs.
  fresh();
  const saved = await checkpointReleaseOpportunity(proof.repository, proof.checkpoint, next);
  const journal = createCoordinatorJournalApi(proof.repository, deadline);
  const remote = await publishCoordinatorCheckpoint(
    proof.repository,
    saved.checkpoint,
    { schema_version: 1, namespace: proof.namespace },
    {
      api: {
        request: journal.request.bind(journal),
        graphql(query, variables) {
          if (/^\s*mutation\b/u.test(query)) fresh();
          return journal.graphql(query, variables);
        },
      },
    },
  );
  await recoverReleaseOpportunity(proof.repository, saved.checkpoint);
  remaining();
  const result = Object.freeze({
    checkpoint: saved.checkpoint,
    previous: proof.checkpoint,
    phase: target,
    evidence_sha256: releaseCanonicalDigest(projection),
    remote,
    scope: "actual phase-specific proof; later effects require their own admission",
  });
  advances.set(result, {
    original_context: proof.original_context,
    phase: target,
    checkpoint: saved.checkpoint,
    previous_checkpoint: proof.checkpoint,
    repository: proof.repository,
    namespace: proof.namespace,
    candidate: structuredClone(next.active_candidate),
    evidence_sha256: result.evidence_sha256,
    recheck: proof.recheck,
    fresh,
    deadline,
  });
  return result;
}

/** Same-process phase handoff only. A prepared publication may rebind its exact
 * original context to this returned checkpoint after these checks, never to a
 * caller-provided updated hash or imported receipt. */
export async function requireActualCandidatePhaseAdvance(receipt: object, expectedPhase: Phase) {
  const value = advances.get(receipt);
  if (!value || value.phase !== expectedPhase)
    throw new Error("actual same-process candidate phase advance required");
  const work = () => requirePhaseAdvanceWithinDeadline(value);
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
async function requirePhaseAdvanceWithinDeadline(
  value: NonNullable<ReturnType<typeof advances.get>>,
) {
  await value.recheck();
  value.fresh();
  const current = await recoverReleaseOpportunity(value.repository, value.checkpoint);
  if (
    releaseCanonicalDigest(current.input.active_candidate) !==
    releaseCanonicalDigest(value.candidate)
  )
    throw new Error("advanced candidate changed before handoff");
  const snapshot = await readRemoteCoordinatorSnapshot(
    value.repository,
    { schema_version: 1, namespace: value.namespace },
    {
      transport: {
        cwd: value.repository,
        ...(value.deadline === undefined ? {} : { deadline: value.deadline }),
      },
    },
  );
  if (snapshot.checkpoint !== value.checkpoint)
    throw new Error("remote phase checkpoint changed before handoff");
  value.fresh();
  return Object.freeze({
    original_context: value.original_context,
    phase: value.phase,
    checkpoint: value.checkpoint,
    previous_checkpoint: value.previous_checkpoint,
    repository: value.repository,
    namespace: value.namespace,
    candidate: structuredClone(value.candidate),
    evidence_sha256: value.evidence_sha256,
  });
}
