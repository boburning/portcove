import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { semanticReviewCheckName } from "./release-control-phases.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { isRecord } from "./runtime-values.mts";

function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("fixed classification producer schema differs");
}
function hex(value: unknown, length: number) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("fixed classification source digest differs");
  return value;
}
/** Data only. Neither a descriptor nor an Actions-authored commit proves
 * actual writer identity, semantic acceptance or permission to persist. */
export function inspectFixedClassificationProducer(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(value, "purpose,review_app_id,review_check_name,schema_version,writer");
  if (
    value.schema_version !== 3 ||
    value.purpose !== "application" ||
    typeof value.review_app_id !== "number" ||
    !Number.isSafeInteger(value.review_app_id) ||
    value.review_app_id < 1 ||
    value.review_app_id === 15368 ||
    value.review_check_name !== semanticReviewCheckName
  )
    throw new Error("fixed classification independent producer differs");
  const writer = value.writer;
  exact(
    writer,
    "actor_id,authority_configuration_sha256,controller_ref,controller_revision,environment,job,kind,namespace,repository_id,setup_plan_sha256,workflow,workflow_sha256",
  );
  if (
    writer.kind !== "fixed-controller-classification-job" ||
    writer.repository_id !== 1354613114 ||
    writer.workflow !== productionControllerWorkflow ||
    writer.job !== "classification_writer" ||
    writer.environment !== "production-release-classification" ||
    typeof writer.actor_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(writer.actor_id) ||
    typeof writer.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      writer.controller_ref,
    )
  )
    throw new Error("fixed classification writer profile differs");
  return {
    schema_version: 3 as const,
    purpose: "application" as const,
    review_app_id: value.review_app_id,
    review_check_name: semanticReviewCheckName,
    writer: {
      kind: "fixed-controller-classification-job" as const,
      repository_id: 1354613114 as const,
      workflow: productionControllerWorkflow,
      job: "classification_writer" as const,
      environment: "production-release-classification" as const,
      actor_id: writer.actor_id,
      controller_ref: writer.controller_ref,
      controller_revision: hex(writer.controller_revision, 40),
      workflow_sha256: hex(writer.workflow_sha256, 64),
      authority_configuration_sha256: hex(writer.authority_configuration_sha256, 64),
      setup_plan_sha256: hex(writer.setup_plan_sha256, 64),
      namespace: inspectCoordinatorRemoteNamespace({
        schema_version: 1,
        namespace: writer.namespace,
      }),
    },
  };
}
