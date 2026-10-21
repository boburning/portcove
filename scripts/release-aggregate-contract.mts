import { isRecord } from "./runtime-values.mts";
export { inspectAggregateOriginalUpload } from "./release-aggregate-locator.mts";
import { inspectCandidateStageEvidence } from "./release-candidate-progress-contract.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";

export function assertAggregateUploadCandidate(candidate: unknown) {
  if (!isRecord(candidate) || candidate.phase !== "building")
    throw new Error("aggregate upload requires the actual building phase");
  const history = inspectCandidateStageEvidence(candidate.stage_evidence, candidate);
  if (
    !history.some(
      (slot) =>
        slot.phase === "building" &&
        slot.attempts.some(
          (attempt) =>
            attempt.transient_retries === candidate.transient_retries &&
            attempt.substantive_repairs === candidate.substantive_repairs &&
            releaseCanonicalDigest(attempt.release_run) ===
              releaseCanonicalDigest(candidate.release_run),
        ),
    )
  )
    throw new Error("aggregate upload requires retained exact building/run/counter evidence");
}

/** Public exact upload preimage in the existing journal, never admission. */
export function inspectAggregateUploadExpectation(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "assembly_sha256,files" ||
    typeof raw.assembly_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.assembly_sha256) ||
    !Array.isArray(raw.files) ||
    raw.files.length < 1 ||
    raw.files.length > 8
  )
    throw new Error("bounded exact aggregate upload expectation required");
  const files = raw.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,filename,sha256" ||
      typeof file.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file.filename) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024 ** 2 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("aggregate upload member identity invalid");
    return { filename: file.filename, bytes: file.bytes, sha256: file.sha256 };
  });
  if (
    new Set(files.map((file) => file.filename.toLowerCase())).size !== files.length ||
    files.reduce((total, file) => total + file.bytes, 0) > 2 * 1024 ** 3 ||
    files.some((file, index) => index > 0 && files[index - 1]!.filename >= file.filename)
  )
    throw new Error("aggregate upload inventory must be unique, ordered and bounded");
  return { assembly_sha256: raw.assembly_sha256, files };
}
