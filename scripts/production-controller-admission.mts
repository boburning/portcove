import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isRecord } from "./runtime-values.mts";
import {
  releaseControlPhaseProfile,
  applicationProtectionObserver,
  isSharedApplicationObserverPhase,
  inspectControllerPurposePhase,
} from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";

export const productionControllerWorkflow = ".github/workflows/application-update-production.yml";
const repository = "boburning/portcove";
const repositoryId = "1354613114";
const maximumWorkflowBytes = 64 * 1024;
const admittedSources = new WeakMap<
  object,
  { workflow: string; job: string; purpose: string; snapshot: string; sharedObserver: boolean }
>();

function refuse(reason: string): never {
  throw new Error(`production controller admission refused: ${reason}`);
}

/** The policy must come from separately ratified operator configuration, never
 * candidate input. Matching it is a source admission check, not a platform
 * enforcement proof, credential grant, or accepted candidate descriptor.
 */
function admitController(
  workflow: string,
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  job = "admission",
  purpose: "application" | "catalog-publication" = "application",
) {
  if (!rawPolicy || Buffer.byteLength(rawPolicy) > 4096) refuse("missing or oversized policy");
  let policy: unknown;
  try {
    policy = JSON.parse(rawPolicy);
  } catch {
    refuse("policy JSON");
  }
  if (!isRecord(policy)) refuse("policy schema or exact identities");
  const legacy =
    policy.schema_version === 1 &&
    policy.mode === "admission-only" &&
    Object.keys(policy).sort().join(",") ===
      "actor_id,execution_ref,mode,revision,schema_version,workflow_sha256";
  const bounded =
    policy.schema_version === 2 &&
    policy.mode ===
      (purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication") &&
    Object.keys(policy).sort().join(",") ===
      "actor_id,authority_configuration_sha256,execution_ref,grant_sha256,mode,revision,schema_version,workflow_sha256" &&
    typeof policy.authority_configuration_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(policy.authority_configuration_sha256) &&
    typeof policy.grant_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(policy.grant_sha256);
  if (
    ((!legacy || purpose !== "application") && !bounded) ||
    typeof policy.execution_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      policy.execution_ref,
    ) ||
    typeof policy.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(policy.revision) ||
    typeof policy.workflow_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(policy.workflow_sha256) ||
    typeof policy.actor_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(policy.actor_id)
  )
    refuse("policy schema or exact identities");
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_SERVER_URL !== "https://github.com" ||
    environment.GITHUB_API_URL !== "https://api.github.com" ||
    environment.GITHUB_REPOSITORY !== repository ||
    environment.GITHUB_REPOSITORY_ID !== repositoryId
  )
    refuse("execution provider or repository identity");
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== policy.execution_ref ||
    environment.GITHUB_REF_TYPE !== "tag" ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    environment.GITHUB_SHA !== policy.revision ||
    environment.GITHUB_WORKFLOW_SHA !== policy.revision ||
    environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@${policy.execution_ref}` ||
    environment.PORTCOVE_CONTROLLER_REVISION !== policy.revision ||
    environment.PORTCOVE_CONTROLLER_REF !== policy.execution_ref
  )
    refuse("fixed workflow, protected tag or bootstrap identity");
  if (
    environment.GITHUB_ACTOR_ID !== policy.actor_id ||
    !environment.GITHUB_ACTOR ||
    environment.GITHUB_TRIGGERING_ACTOR !== environment.GITHUB_ACTOR ||
    !/^[1-9][0-9]{0,15}$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    environment.GITHUB_RUN_ATTEMPT !== "1" ||
    environment.GITHUB_JOB !== job ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    refuse("principal, first attempt, job or runner identity");
  if (
    workflowBytes.byteLength < 1 ||
    workflowBytes.byteLength > maximumWorkflowBytes ||
    createHash("sha256").update(workflowBytes).digest("hex") !== policy.workflow_sha256
  )
    refuse("workflow source byte identity");
  const result = {
    schema_version: policy.schema_version,
    mode: policy.mode,
    ...(bounded
      ? {
          authority_configuration_sha256: String(policy.authority_configuration_sha256),
          grant_sha256: String(policy.grant_sha256),
        }
      : {}),
    repository_id: repositoryId,
    repository,
    workflow,
    revision: policy.revision,
    execution_ref: policy.execution_ref,
    workflow_sha256: policy.workflow_sha256,
    actor_id: policy.actor_id,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
    qualification:
      "Source admission only; no candidate acceptance, platform reachability, execution, signing or publication authority",
  };
  admittedSources.set(result, {
    workflow,
    job,
    purpose,
    snapshot: JSON.stringify(result),
    sharedObserver: sharedObserverLayout(workflowBytes),
  });
  return result;
}

function sharedObserverLayout(bytes: Uint8Array) {
  // A protocol declaration in the actual workflow bytes authenticated above,
  // not an environment selector, dispatch input, candidate or authority grant.
  const count = Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line === applicationProtectionObserver.source_marker).length;
  if (count > 1) refuse("ambiguous observer layout");
  return count === 1;
}
export function isSharedApplicationProtectionObserverSource(value: unknown) {
  const saved = isRecord(value) ? admittedSources.get(value) : undefined;
  if (!saved || saved.snapshot !== JSON.stringify(value))
    throw new Error("original unchanged admitted production source required");
  return (
    saved.purpose === "application" &&
    saved.workflow === productionControllerWorkflow &&
    saved.job === applicationProtectionObserver.job &&
    saved.sharedObserver
  );
}
export function requireAdmittedProductionObserverSource(
  value: unknown,
  phase: "classification" | ReleaseControlPhase,
  purpose: "application" | "catalog-publication",
): asserts value is ReturnType<typeof admitProductionInputReader> {
  requireAdmittedProductionSource(
    value,
    admittedProductionObserverProfile(value, phase).job,
    purpose,
  );
}
/** Exact expected observer from the original reader/observer's admitted bytes.
 * A serialized source, candidate flag or default alias cannot select a layout. */
export function admittedProductionObserverProfile(
  value: unknown,
  phase: "classification" | ReleaseControlPhase,
) {
  const saved = isRecord(value) ? admittedSources.get(value) : undefined;
  if (
    !saved ||
    saved.workflow !== productionControllerWorkflow ||
    saved.snapshot !== JSON.stringify(value)
  )
    throw new Error("original unchanged admitted production source required");
  if (phase === "classification") {
    if (saved.purpose !== "application") refuse("classification purpose");
    return {
      job: "classification_protection_observation",
      name: "Observe release input protections",
    };
  }
  inspectControllerPurposePhase(phase, saved.purpose);
  const shared =
    saved.purpose === "application" &&
    saved.sharedObserver &&
    isSharedApplicationObserverPhase(phase);
  return shared
    ? { job: applicationProtectionObserver.job, name: applicationProtectionObserver.name }
    : {
        job: releaseControlPhaseProfile(phase).observer_job,
        name: releaseControlPhaseProfile(phase).observer_name,
      };
}

/** Same-process source validation only; still requires actual OIDC and the
 * complete separately ratified configuration before any selected operation. */
export function requireAdmittedProductionSource(
  value: unknown,
  job: string,
  purpose: "application" | "catalog-publication",
): asserts value is ReturnType<typeof admitProductionInputReader> {
  const saved = isRecord(value) ? admittedSources.get(value) : undefined;
  if (
    !saved ||
    saved.workflow !== productionControllerWorkflow ||
    saved.job !== job ||
    saved.purpose !== purpose ||
    saved.snapshot !== JSON.stringify(value)
  )
    throw new Error("original unchanged admitted production source required");
}

export function admitProductionController(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(productionControllerWorkflow, rawPolicy, environment, workflowBytes);
}
/** Secret-free bootstrap of the same immutable workflow, under the distinct
 * catalog grant. This source check confers no role or publication acceptance. */
export function admitProductionCatalogController(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    "admission",
    "catalog-publication",
  );
}
/** Fixed read-only consumer of the same reviewed controller and needs graph. */
export function admitProductionInputReader(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  phase: unknown = "admission",
) {
  if (typeof phase === "string" && phase.startsWith("catalog-"))
    refuse("application control phase");
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    releaseControlPhaseProfile(phase).reader_job,
  );
}

/** Four fixed native parent entry points, under the existing bounded
 * application source/grant. Source admission grants no candidate execution,
 * native acceptance, protected configuration or proof-signing capability. */
export function productionHostedNativeJob(platform: unknown, stage: unknown) {
  if (platform !== "windows-x86_64" && platform !== "linux-x86_64") refuse("fixed native platform");
  if (stage !== "payload-signing" && stage !== "release-publication") refuse("fixed native stage");
  // Both signed stages stay on the same actual job/VM. Stage remains closed in
  // parent admission, report/signature and controls; never spoof GITHUB_JOB.
  return `native_${platform === "windows-x86_64" ? "windows" : "linux"}`;
}
export function admitProductionNativeParent(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  platform: unknown,
  stage: unknown,
) {
  const job = productionHostedNativeJob(platform, stage);
  if (environment.PORTCOVE_EXECUTION_PURPOSE !== "application")
    refuse("native application purpose");
  const source = admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    job,
  );
  if (source.mode !== "bounded-application-release") refuse("bounded native source grant");
  return source;
}

/** Separate owner grant and purpose. Shared coordinator/Pages jobs may consume
 * catalog controls, but application admission and signing jobs cannot. */
export function admitProductionCatalogInputReader(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  phase: unknown,
) {
  if (
    ![
      "coordinator",
      "site-publication",
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
    ].includes(String(phase))
  )
    refuse("catalog control phase");
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    releaseControlPhaseProfile(phase).reader_job,
    "catalog-publication",
  );
}
export function admitProductionProtectionObserver(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  phase: unknown = "admission",
) {
  if (typeof phase === "string" && phase.startsWith("catalog-"))
    refuse("application protection phase");
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    sharedObserverLayout(workflowBytes) && isSharedApplicationObserverPhase(phase)
      ? applicationProtectionObserver.job
      : releaseControlPhaseProfile(phase).observer_job,
  );
}

export function admitProductionCatalogProtectionObserver(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  phase: unknown,
) {
  if (
    ![
      "coordinator",
      "site-publication",
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
    ].includes(String(phase))
  )
    refuse("catalog protection phase");
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    releaseControlPhaseProfile(phase).observer_job,
    "catalog-publication",
  );
}
/** Dedicated D1 jobs in the complete fixed controller. These named profiles do
 * not add a generic release-input reader or a capacity executor role. */
export function admitProductionClassificationWriter(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    "classification_writer",
  );
}
export function admitProductionClassificationObserver(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(
    productionControllerWorkflow,
    rawPolicy,
    environment,
    workflowBytes,
    "classification_protection_observation",
  );
}

export function admitReviewedInputsController(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(
    ".github/workflows/release-reviewed-inputs.yml",
    rawPolicy,
    environment,
    workflowBytes,
  );
}
export function admitReviewedInputsWriter(
  rawPolicy: string | undefined,
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
) {
  return admitController(
    ".github/workflows/release-reviewed-inputs.yml",
    rawPolicy,
    environment,
    workflowBytes,
    "classification_writer",
  );
}

export async function readProductionControllerWorkflowBytes() {
  return readFixedControllerWorkflowBytes(productionControllerWorkflow);
}
export async function readReviewedInputsWorkflowBytes() {
  return readFixedControllerWorkflowBytes(".github/workflows/release-reviewed-inputs.yml");
}
async function readFixedControllerWorkflowBytes(workflow: string) {
  // A fixed trusted-checkout path, never a candidate-supplied file. Read from one
  // handle with a one-byte growth probe; no dependency install or candidate code.
  const filename = new URL(`../${workflow}`, import.meta.url);
  const handle = await open(filename, "r");
  try {
    if (!(await handle.stat()).isFile()) refuse("workflow must be a regular file");
    const bytes = Buffer.alloc(maximumWorkflowBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
