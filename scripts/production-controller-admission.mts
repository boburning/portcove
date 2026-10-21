import { createHash } from "node:crypto";
import { open, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { errorMessage, isRecord } from "./runtime-values.mts";
import {
  releaseControlPhaseProfile,
  inspectControllerExecutionPurpose,
} from "./release-control-phases.mts";

export const productionControllerWorkflow = ".github/workflows/application-update-production.yml";
const repository = "boburning/portcove";
const repositoryId = "1354613114";
const maximumWorkflowBytes = 64 * 1024;

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
  return {
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
    releaseControlPhaseProfile(phase).observer_job,
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

async function main() {
  if (process.argv.length !== 2) refuse("no candidate or policy path arguments are accepted");
  const purpose = inspectControllerExecutionPurpose(process.env.PORTCOVE_EXECUTION_PURPOSE);
  const admitted = (
    purpose === "catalog-publication" ? admitProductionCatalogController : admitProductionController
  )(
    purpose === "catalog-publication"
      ? process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
      : process.env.PORTCOVE_CONTROLLER_ADMISSION,
    process.env,
    await readProductionControllerWorkflowBytes(),
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `publication_purpose=${purpose}\n`);
  console.log(JSON.stringify(admitted));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
