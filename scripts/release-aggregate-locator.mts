import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { inspectNativeCheckpointLocator } from "./release-native-checkpoint-custody.mts";
const sha256 = /^[a-f0-9]{64}$/u;

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

export function inspectControllerAggregateLocator(raw: unknown) {
  const aggregate = structuredClone(raw);
  if (
    !isRecord(aggregate) ||
    Object.keys(aggregate).sort().join(",") !==
      [
        "artifact_id",
        "bundle_artifact_id",
        "bundle_sha256",
        "controller_ref",
        "controller_revision",
        "run_attempt",
        "run_id",
        "sha256",
        ...(aggregate.original_upload === undefined ? [] : ["original_upload"]),
        ...(aggregate.native_custody === undefined ? [] : ["native_custody"]),
      ]
        .sort()
        .join(",") ||
    typeof aggregate.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(aggregate.controller_revision) ||
    typeof aggregate.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
      aggregate.controller_ref,
    ) ||
    typeof aggregate.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(aggregate.run_id) ||
    typeof aggregate.sha256 !== "string" ||
    !sha256.test(aggregate.sha256) ||
    typeof aggregate.bundle_sha256 !== "string" ||
    !sha256.test(aggregate.bundle_sha256) ||
    typeof aggregate.artifact_id !== "number" ||
    !Number.isSafeInteger(aggregate.artifact_id) ||
    aggregate.artifact_id < 1 ||
    typeof aggregate.bundle_artifact_id !== "number" ||
    !Number.isSafeInteger(aggregate.bundle_artifact_id) ||
    aggregate.bundle_artifact_id < 1 ||
    typeof aggregate.run_attempt !== "number" ||
    !Number.isSafeInteger(aggregate.run_attempt) ||
    aggregate.run_attempt < 1
  )
    throw new Error("fixed payload aggregate identity is incomplete");
  return {
    controller_revision: aggregate.controller_revision,
    controller_ref: aggregate.controller_ref,
    run_id: aggregate.run_id,
    run_attempt: aggregate.run_attempt,
    artifact_id: aggregate.artifact_id,
    sha256: aggregate.sha256,
    bundle_artifact_id: aggregate.bundle_artifact_id,
    bundle_sha256: aggregate.bundle_sha256,
    ...(aggregate.native_custody === undefined
      ? {}
      : { native_custody: inspectNativeCheckpointLocator(aggregate.native_custody) }),
    ...(aggregate.original_upload === undefined
      ? {}
      : { original_upload: inspectAggregateOriginalUpload(aggregate.original_upload) }),
  };
}
