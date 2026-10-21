import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
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

/** Immutable original producer locators, authenticated independently by each
 * current custodian. These public fields cannot grant recovery authority. */
export function inspectAggregateOriginalUpload(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "actor_id,before_checkpoint,check_run_id,controller_revision,execution_ref,expectation_sha256,job_id,operation_id,run_attempt,run_id,workflow" ||
    raw.workflow !== productionControllerWorkflow ||
    typeof raw.execution_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      raw.execution_ref,
    )
  )
    throw new Error("exact original admitted aggregate upload required");
  for (const key of ["actor_id", "check_run_id", "run_id"] as const)
    if (typeof raw[key] !== "string" || !/^[1-9][0-9]{0,19}$/u.test(raw[key]))
      throw new Error("original aggregate provider locator invalid");
  for (const key of ["job_id", "run_attempt"] as const)
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 1)
      throw new Error("original aggregate provider sequence invalid");
  for (const key of [
    "before_checkpoint",
    "controller_revision",
    "expectation_sha256",
    "operation_id",
  ] as const)
    if (
      typeof raw[key] !== "string" ||
      !(
        key === "before_checkpoint" || key === "controller_revision"
          ? /^[a-f0-9]{40}$/u
          : /^[a-f0-9]{64}$/u
      ).test(raw[key])
    )
      throw new Error("original aggregate journal locator invalid");
  return {
    actor_id: raw.actor_id as string,
    before_checkpoint: raw.before_checkpoint as string,
    check_run_id: raw.check_run_id as string,
    controller_revision: raw.controller_revision as string,
    execution_ref: raw.execution_ref,
    expectation_sha256: raw.expectation_sha256 as string,
    job_id: raw.job_id as number,
    operation_id: raw.operation_id as string,
    run_attempt: raw.run_attempt as number,
    run_id: raw.run_id as string,
    workflow: raw.workflow,
  };
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
