/** Integrity of native bytes carried by the existing signed checkpoint. This
 * parser grants neither native acceptance nor signing/publication authority. */
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import {
  candidateProgressIdentity,
  inspectCandidateStageEvidence,
} from "./release-candidate-progress-contract.mts";
import { inspectHostedNativeCustodyBundle } from "./release-hosted-native-proof-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;

/** Immutable locator only. A signed aggregate/TUF record must bind this value;
 * parsing it never authenticates a journal, native report or current admission. */
export function inspectNativeCheckpointLocator(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "checkpoint,native_bundle_bytes,native_bundle_sha256" ||
    typeof raw.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.checkpoint) ||
    typeof raw.native_bundle_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.native_bundle_sha256) ||
    typeof raw.native_bundle_bytes !== "number" ||
    !Number.isSafeInteger(raw.native_bundle_bytes) ||
    raw.native_bundle_bytes < 1 ||
    raw.native_bundle_bytes > 1048576
  )
    throw new Error("exact native checkpoint custody locator required");
  return {
    checkpoint: raw.checkpoint,
    native_bundle_sha256: raw.native_bundle_sha256,
    native_bundle_bytes: raw.native_bundle_bytes,
  };
}

/** Project the exact original building carrier named by a settled aggregate's
 * before_checkpoint. The owning caller authenticates that operation and head;
 * this does not read a current ref, walk history or invent a second journal. */
export function nativeCheckpointLocatorFromBuilding(
  retained: { checkpoint: string; input: Record<string, unknown> },
  expectedCandidate: Record<string, unknown>,
) {
  const candidate = retained.input.active_candidate;
  if (
    !isRecord(candidate) ||
    candidate.phase !== "building" ||
    candidateProgressIdentity(candidate) !== candidateProgressIdentity(expectedCandidate)
  )
    throw new Error("native carrier differs from actual original building candidate");
  const attempts = inspectCandidateStageEvidence(candidate.stage_evidence, candidate)
    .filter((slot) => slot.phase === "building")
    .flatMap((slot) => slot.attempts)
    .filter(
      (attempt) =>
        attempt.transient_retries === candidate.transient_retries &&
        attempt.substantive_repairs === candidate.substantive_repairs &&
        digest(attempt.release_run) === digest(candidate.release_run),
    );
  if (attempts.length !== 1) throw new Error("one exact original building proof required");
  const proof = attempts[0]!.proof;
  if (!isRecord(proof) || !Array.isArray(proof.locators))
    throw new Error("original building proof locators unavailable");
  const locators = proof.locators;
  const native = locators.filter(
    (value: unknown) =>
      isRecord(value) && (value.kind === "native-job" || value.kind === "native-custody"),
  );
  if (!native.length) return null;
  const markers = native.filter(
    (value: unknown) => isRecord(value) && value.kind === "native-custody",
  );
  const marker: unknown = markers[0];
  if (
    markers.length !== 1 ||
    native.length !== 3 ||
    locators.filter((value: unknown) => isRecord(value) && value.kind === "artifact").length !==
      2 ||
    !isRecord(marker) ||
    typeof marker.id !== "string" ||
    locators.some((value: unknown) => isRecord(value) && value.kind === "native-check")
  )
    throw new Error("original native building custody marker differs");
  const match = /^([a-f0-9]{64}):([1-9][0-9]{0,6})$/u.exec(marker.id);
  if (!match || marker.sha256 !== match[1])
    throw new Error("original native building custody digest differs");
  return inspectNativeCheckpointLocator({
    checkpoint: retained.checkpoint,
    native_bundle_sha256: match[1],
    native_bundle_bytes: Number(match[2]),
  });
}

export function nativeCheckpointEvidenceId(raw: unknown) {
  const value = inspectNativeCheckpointLocator(raw);
  return `native-checkpoint:${value.checkpoint}:${value.native_bundle_sha256}:${value.native_bundle_bytes}`;
}

/** Only the newly appended phase attempt can request a native carrier. Older
 * locators remain immutable history without duplicating their original bytes. */
export function inspectNativeCheckpointCustody(
  checkpoint: Checkpoint,
  configuration: unknown,
  producer: Record<string, unknown>,
  raw?: unknown,
) {
  const state: unknown = JSON.parse(checkpoint.blob.contents);
  const candidate = isRecord(state) && isRecord(state.input) ? state.input.active_candidate : null;
  const fresh =
    isRecord(candidate) && candidate.stage_evidence !== undefined
      ? inspectCandidateStageEvidence(candidate.stage_evidence, candidate).flatMap((slot) =>
          slot.attempts
            .filter((attempt) => attempt.previous_checkpoint === checkpoint.previous)
            .map((attempt) => {
              if (
                !isRecord(attempt.proof) ||
                !Array.isArray(attempt.proof.locators) ||
                !isRecord(attempt.release_run)
              )
                throw new Error("native checkpoint stage projection unavailable");
              const locators = attempt.proof.locators.map((locator: unknown) => {
                if (!isRecord(locator)) throw new Error("native checkpoint locator unavailable");
                return locator;
              });
              return {
                phase: slot.phase,
                proof: attempt.proof,
                releaseRun: attempt.release_run,
                locators,
              };
            }),
        )
      : [];
  const selected = fresh.filter(({ locators }) =>
    locators.some((locator) => locator.kind === "native-job" || locator.kind === "native-custody"),
  );
  if (raw === undefined && selected.length === 0) return null;
  if (raw === undefined || selected.length !== 1 || !isRecord(candidate))
    throw new Error("native checkpoint requires one fresh phase and its complete custody");
  const bundle = inspectHostedNativeCustodyBundle(Buffer.from(JSON.stringify(raw)));
  const { phase, proof: stageProof, releaseRun, locators } = selected[0]!;
  const markers = locators.filter((locator) => locator.kind === "native-custody");
  const jobs = locators.filter((locator) => locator.kind === "native-job");
  const artifacts = locators.filter((locator) => locator.kind === "artifact");
  if (
    candidate.phase !== phase ||
    bundle.stage !== (phase === "building" ? "payload-signing" : "release-publication") ||
    markers.length !== 1 ||
    markers[0]!.id !== `${bundle.sha256}:${bundle.bytes.length}` ||
    markers[0]!.sha256 !== bundle.sha256 ||
    jobs.length !== 2 ||
    artifacts.length !== 2 ||
    inspectCoordinatorRemoteNamespace(configuration) !== bundle.configuration.journal.namespace ||
    locators.some((locator) => locator.kind === "native-check") ||
    producer.configuration_sha256 !== digest(bundle.configuration.journal)
  )
    throw new Error("native checkpoint stage, custody marker or journal configuration differs");
  for (const proof of bundle.proofs) {
    const native = proof.report.candidate;
    const issuer = proof.producer;
    if (
      native.source_commit !== candidate.prepared_commit ||
      native.source_tree !== candidate.prepared_tree ||
      String(native.run_id) !== String(releaseRun.run_id) ||
      native.run_attempt !== releaseRun.attempt ||
      artifacts.filter((artifact) => artifact.id === String(native.artifact_id)).length !== 1 ||
      stageProof.controller_revision !== issuer.controller_revision ||
      ![
        "actor_id",
        "controller_ref",
        "controller_revision",
        "setup_sha256",
        "workflow_sha256",
      ].every((key) => producer[key] === issuer[key as keyof typeof issuer]) ||
      jobs.filter(
        (job) =>
          job.id ===
            `${issuer.run_id}:${issuer.run_attempt}:${issuer.job_id}:${issuer.check_run_id}` &&
          job.sha256 === proof.subject_sha256,
      ).length !== 1
    )
      throw new Error("native checkpoint candidate, original job or authority differs");
  }
  return { ...bundle, value: JSON.parse(bundle.bytes.toString("utf8")) as unknown };
}
