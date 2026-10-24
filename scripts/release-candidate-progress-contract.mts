import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import type { verifyPreparedImmutableRelease } from "./release-immutable-publication.mts";

/** Readback evidence may include mutable provider observations. This digest
 * selects only the already-verified immutable identity, never authenticates it. */
export function immutableReleaseProgressDigest(
  value: Pick<
    ReturnType<typeof verifyPreparedImmutableRelease>,
    "release_id" | "immutable" | "source_commit" | "version" | "assets"
  >,
) {
  return releaseCanonicalDigest({
    release_id: value.release_id,
    immutable: value.immutable,
    source_commit: value.source_commit,
    version: value.version,
    assets: value.assets.map((asset) => ({
      id: asset.id,
      release_id: asset.release_id,
      filename: asset.filename,
      bytes: asset.bytes,
      sha256: asset.sha256,
      download_url: asset.download_url,
    })),
  });
}

const stages = ["building", "publishing", "promoting"] as const;
/** Public history only; this can restrict effects, never grant eligibility. */
export function candidateHasRetainedPromotion(candidate: unknown) {
  if (!isRecord(candidate) || candidate.stage_evidence === undefined) return false;
  return inspectCandidateStageEvidence(candidate.stage_evidence, candidate).some(
    (slot) => slot.phase === "promoting",
  );
}
const hash = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value);
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("candidate stage evidence shape invalid");
}
function count(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}
export function candidateProgressIdentity(candidate: Record<string, unknown>) {
  return releaseCanonicalDigest(
    Object.fromEntries(
      [
        "source_commit",
        "source_tree",
        "prepared_commit",
        "prepared_tree",
        "version",
        "intent_sha256",
      ].map((key) => [key, candidate[key]]),
    ),
  );
}

/** Integrity-only recovery association. A later report attempt may retain the
 * original immutable publication only when the same journal already recorded
 * that exact settled operation and Release at the original recovery counters. */
export function requireRetainedPublishCandidate(
  candidate: Record<string, unknown>,
  operation: { id: string; candidate?: unknown },
  release: Parameters<typeof immutableReleaseProgressDigest>[0],
) {
  if (!isRecord(operation.candidate)) throw new Error("retained publisher candidate missing");
  const fields = [
    "source_commit",
    "prepared_commit",
    "version",
    "transient_retries",
    "substantive_repairs",
  ];
  const current = Object.fromEntries(fields.map((key) => [key, candidate[key]]));
  if (releaseCanonicalDigest(operation.candidate) === releaseCanonicalDigest(current)) return;
  for (const key of ["source_commit", "prepared_commit", "version"])
    if (operation.candidate[key] !== candidate[key])
      throw new Error("retained publisher candidate identity differs");
  for (const key of ["transient_retries", "substantive_repairs"])
    if (
      !Number.isSafeInteger(operation.candidate[key]) ||
      !Number.isSafeInteger(candidate[key]) ||
      Number(operation.candidate[key]) < 0 ||
      Number(operation.candidate[key]) > Number(candidate[key])
    )
      throw new Error("retained publisher recovery counters differ");
  const history = inspectCandidateStageEvidence(candidate.stage_evidence, candidate);
  const originalCandidate = operation.candidate;
  const matching = history
    .find((slot) => slot.phase === "promoting")
    ?.attempts.filter(
      (attempt) =>
        attempt.transient_retries === originalCandidate.transient_retries &&
        attempt.substantive_repairs === originalCandidate.substantive_repairs &&
        releaseCanonicalDigest(attempt.release_run) ===
          releaseCanonicalDigest(candidate.release_run) &&
        isRecord(attempt.proof) &&
        Array.isArray(attempt.proof.locators) &&
        attempt.proof.locators.some(
          (locator: unknown) =>
            isRecord(locator) &&
            locator.kind === "operation" &&
            locator.id === operation.id &&
            locator.sha256 === releaseCanonicalDigest(operation),
        ) &&
        attempt.proof.locators.some(
          (locator: unknown) =>
            isRecord(locator) &&
            locator.kind === "immutable-release" &&
            locator.id === String(release.release_id) &&
            locator.sha256 === immutableReleaseProgressDigest(release),
        ),
    );
  if (matching?.length !== 1)
    throw new Error("retained publisher lacks exact original promoting proof");
}

/** Bounded public recovery locators, never an authentication or eligibility proof.
 * Actual callers must recollect provider/private evidence before any action. */
export function inspectCandidateStageEvidence(raw: unknown, candidate: Record<string, unknown>) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3)
    throw new Error("candidate stage evidence requires one to three stage histories");
  let previousPhase = -1;
  const result = raw.map((slot: unknown) => {
    exact(slot, "attempts,phase");
    if (
      !stages.includes(slot.phase as (typeof stages)[number]) ||
      previousPhase >= stages.indexOf(slot.phase as (typeof stages)[number]) ||
      !Array.isArray(slot.attempts) ||
      slot.attempts.length < 1 ||
      slot.attempts.length > 6
    )
      throw new Error("candidate stage history order or attempt bound invalid");
    previousPhase = stages.indexOf(slot.phase as (typeof stages)[number]);
    const seen = new Set<string>();
    let previousRecovery = -1;
    const attempts = slot.attempts.map((attempt: unknown) => {
      exact(
        attempt,
        "evidence_sha256,previous_checkpoint,proof,release_run,substantive_repairs,transient_retries",
      );
      exact(attempt.release_run, "attempt,revision,run_id");
      if (
        !hash(attempt.previous_checkpoint, 40) ||
        !hash(attempt.evidence_sha256, 64) ||
        !count(attempt.transient_retries, 2) ||
        !count(attempt.substantive_repairs, 3) ||
        !count(attempt.release_run.run_id, Number.MAX_SAFE_INTEGER) ||
        attempt.release_run.run_id === 0 ||
        !count(attempt.release_run.attempt, Number.MAX_SAFE_INTEGER) ||
        attempt.release_run.attempt === 0 ||
        attempt.release_run.revision !== candidate.prepared_commit
      )
        throw new Error("candidate stage attempt identity invalid");
      const recovery = attempt.transient_retries + attempt.substantive_repairs;
      if (
        recovery <= previousRecovery ||
        attempt.transient_retries > Number(candidate.transient_retries) ||
        attempt.substantive_repairs > Number(candidate.substantive_repairs)
      )
        throw new Error("candidate stage recovery history regressed or exceeds current counters");
      previousRecovery = recovery;
      exact(attempt.proof, "candidate_sha256,controller_revision,locators,schema_version");
      if (
        attempt.proof.schema_version !== 1 ||
        attempt.proof.candidate_sha256 !== candidateProgressIdentity(candidate) ||
        !hash(attempt.proof.controller_revision, 40) ||
        !Array.isArray(attempt.proof.locators) ||
        attempt.proof.locators.length < 1 ||
        attempt.proof.locators.length > 16 ||
        Buffer.byteLength(JSON.stringify(attempt.proof)) > 2048 ||
        releaseCanonicalDigest(attempt.proof) !== attempt.evidence_sha256
      )
        throw new Error("candidate stage public projection or digest invalid");
      const locatorKeys = new Set<string>();
      for (const locator of attempt.proof.locators) {
        exact(locator, "id,kind,sha256");
        if (
          ![
            "native-check",
            "native-job",
            "compiler-check",
            "semantic-check",
            "classification-commit",
            "artifact",
            "operation",
            "records",
            "sbom",
            "site-generation",
            "immutable-release",
          ].includes(String(locator.kind)) ||
          typeof locator.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(locator.id) ||
          (locator.sha256 !== null && !hash(locator.sha256, 64))
        )
          throw new Error("candidate stage recovery locator invalid");
        const key = `${String(locator.kind)}:${locator.id}`;
        if (locatorKeys.has(key)) throw new Error("candidate stage recovery locator duplicated");
        locatorKeys.add(key);
      }
      const key = `${attempt.transient_retries}:${attempt.substantive_repairs}`;
      if (seen.has(key)) throw new Error("candidate stage recovery counters duplicated");
      seen.add(key);
      return structuredClone(attempt);
    });
    return { phase: slot.phase, attempts };
  });
  return result;
}

/** Preserve history on failure/retry; append exactly one proof only alongside its
 * corresponding forward phase transition. The existing 64KiB checkpoint cap
 * still applies to the complete state before any ref mutation. */
export function validateCandidateStageTransition(
  old: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
  checkpoint: string,
) {
  const before = old?.stage_evidence;
  const after = next?.stage_evidence;
  if (!old) {
    if (after !== undefined) throw new Error("new reservation cannot backfill stage evidence");
    return;
  }
  if (!next) return;
  if (before === undefined && after === undefined) return; // historical legacy path
  const previous = before === undefined ? [] : inspectCandidateStageEvidence(before, old);
  if (after === undefined) throw new Error("candidate stage history cannot be removed");
  const following = inspectCandidateStageEvidence(after, next);
  const beforeDigest = releaseCanonicalDigest(previous);
  if (old.phase === next.phase || !stages.includes(next.phase as (typeof stages)[number])) {
    if (beforeDigest !== releaseCanonicalDigest(following))
      throw new Error("candidate stage history changed without phase advance");
    return;
  }
  const slot = following.find((entry) => entry.phase === next.phase);
  if (!slot) throw new Error("candidate phase advance lacks its stage evidence");
  const added = slot.attempts.at(-1)!;
  if (
    added.previous_checkpoint !== checkpoint ||
    added.transient_retries !== next.transient_retries ||
    added.substantive_repairs !== next.substantive_repairs ||
    releaseCanonicalDigest(added.release_run) !== releaseCanonicalDigest(next.release_run)
  )
    throw new Error(
      "candidate stage evidence differs from current checkpoint, run or recovery attempt",
    );
  const reduced = structuredClone(following);
  const reducedSlot = reduced.find((entry) => entry.phase === next.phase)!;
  reducedSlot.attempts.pop();
  if (reducedSlot.attempts.length === 0) reduced.splice(reduced.indexOf(reducedSlot), 1);
  if (releaseCanonicalDigest(reduced) !== beforeDigest)
    throw new Error("candidate stage history may only append its exact current phase proof");
}
