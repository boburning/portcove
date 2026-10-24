/** Closed fixed-DAG locator serialization. Every result is inert routing data;
 * existing consumers independently authenticate artifacts, jobs and authority. */
import { isRecord } from "./runtime-values.mts";
import {
  inspectAssemblerIdentityExpectation,
  controllerOidcSubject,
} from "./assembler-job-identity.mts";
import {
  inspectControllerExecutionPurpose,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import { tufRoleDependencies } from "./release-tuf-signing.mts";
import {
  catalogRoleDependencies,
  catalogSigningRoles,
} from "./release-catalog-signing-contract.mts";
import { inspectCatalogRoleArtifactExpected } from "./release-tuf-role-artifact.mts";
import { inspectTufRoleArtifactExpected } from "./release-tuf-role-artifact.mts";
import { inspectControllerAggregateLocator } from "./release-aggregate-locator.mts";

type Fixed = {
  controller_revision: string;
  source_tree: string;
  controller_ref: string;
  run_id: string;
  run_attempt: number;
  actor_id: string;
};
function hex(value: unknown, length = 64) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("fixed DAG digest unavailable");
  return value;
}
function positive(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("fixed DAG artifact ID unavailable");
  return Number(value);
}
function json(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536)
    throw new Error("bounded fixed DAG output required");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("fixed DAG output must be an object");
  return parsed;
}
function output(needs: Record<string, unknown>, job: string) {
  const value = needs[job];
  if (!isRecord(value) || value.result !== "success" || !isRecord(value.outputs))
    throw new Error(`successful fixed DAG producer ${job} required`);
  return value.outputs;
}
function controller(raw: Fixed): Fixed {
  if (
    raw.run_attempt !== 1 ||
    typeof raw.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.run_id) ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.actor_id)
  )
    throw new Error("original fixed DAG invocation required");
  hex(raw.controller_revision, 40);
  hex(raw.source_tree, 40);
  controllerOidcSubject(raw.controller_ref);
  return structuredClone(raw);
}
function contextLocator(raw: unknown, fixed: Fixed) {
  const value = json(raw);
  if (
    Object.keys(value).sort().join(",") !==
      "artifact,binding_sha256,bundle,controller_ref,controller_revision,facts_sha256,manifest_sha256,run_attempt,run_id,source_tree" ||
    value.controller_revision !== fixed.controller_revision ||
    value.source_tree !== fixed.source_tree ||
    value.controller_ref !== fixed.controller_ref ||
    value.run_attempt !== 1 ||
    typeof value.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value.run_id)
  )
    throw new Error("fixed DAG context controller differs");
  for (const key of ["manifest_sha256", "binding_sha256", "facts_sha256"]) hex(value[key]);
  for (const key of ["artifact", "bundle"]) {
    const entry = value[key];
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "id,sha256" ||
      typeof entry.id !== "number" ||
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1
    )
      throw new Error("fixed DAG context artifact differs");
    hex(entry.sha256);
  }
  if (
    (value.artifact as Record<string, unknown>).id === (value.bundle as Record<string, unknown>).id
  )
    throw new Error("distinct context attestation required");
  return value;
}
function nativeLocators(raw: unknown) {
  // The named actual consumers resolve this automatic marker from their
  // authenticated source tuple; it never imports a positive native result.
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length !== 2)
    throw new Error("two fixed native locators required");
  const values: unknown[] = raw;
  const seen = new Set<string>(),
    ids = new Set<number>();
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "check_id,invocation_id,platform_label" ||
      !["windows-x86_64", "linux-x86_64"].includes(String(entry.platform_label)) ||
      typeof entry.check_id !== "number" ||
      !Number.isSafeInteger(entry.check_id) ||
      entry.check_id < 1 ||
      seen.has(String(entry.platform_label)) ||
      ids.has(entry.check_id)
    )
      throw new Error("fixed native locator tuple differs");
    hex(entry.invocation_id);
    seen.add(String(entry.platform_label));
    ids.add(entry.check_id);
  }
  return structuredClone(values);
}
/** Only the immutable workflow chooses these named operations and needs keys.
 * Unknown needs are ignored, never used as an alternate producer or entry. */
export function prepareFixedControllerConfiguration(input: {
  operation: unknown;
  publication_purpose?: unknown;
  fixed: Fixed;
  needs: unknown;
  admission_configuration: unknown;
  native_locators?: unknown;
  payload_public_key_sha256?: unknown;
}) {
  const fixed = controller(input.fixed),
    needs: unknown = structuredClone(input.needs);
  if (!isRecord(needs) || Buffer.byteLength(JSON.stringify(needs)) > 256 * 1024)
    throw new Error("bounded fixed DAG needs required");
  const operation = input.operation;
  const purpose = inspectControllerExecutionPurpose(input.publication_purpose);
  if (
    operation !== "coordinator" &&
    operation !== "building" &&
    operation !== "payload" &&
    operation !== "release-publication" &&
    operation !== "site-publication" &&
    ![
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
      "tuf-releases",
      "tuf-preview",
      "tuf-stable",
      "tuf-snapshot",
      "tuf-timestamp",
    ].includes(String(operation))
  )
    throw new Error("fixed DAG operation required");
  const bootstrap = output(needs, "tool_bootstrap"),
    attestation = output(needs, "tool_attest");
  if (bootstrap.source_tree !== fixed.source_tree)
    throw new Error("fixed tool source tree differs");
  const { actor_id: _actor, ...producer } = fixed;
  const tools = {
    artifact: {
      ...producer,
      artifact_id: positive(bootstrap.artifact_id),
      sha256: hex(bootstrap.artifact_sha256),
    },
    bundle: {
      artifact_id: positive(attestation.bundle_artifact_id),
      sha256: hex(attestation.bundle_artifact_sha256),
    },
  };
  if (tools.artifact.artifact_id === tools.bundle.artifact_id)
    throw new Error("separate fixed tool attestation required");
  const admission: unknown = structuredClone(input.admission_configuration);
  if (
    !isRecord(admission) ||
    typeof admission.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(admission.namespace)
  )
    throw new Error("ratified admission namespace required");
  if (
    purpose === "application" &&
    typeof operation === "string" &&
    operation.startsWith("catalog-")
  )
    throw new Error("application cannot select catalog operation");
  if (
    purpose === "catalog-publication" &&
    operation !== "coordinator" &&
    operation !== "site-publication" &&
    !(typeof operation === "string" && operation.startsWith("catalog-"))
  )
    throw new Error("catalog cannot select application operation");
  if (operation === "coordinator")
    return { remote_configuration: { schema_version: 1, namespace: admission.namespace }, tools };
  if (purpose === "catalog-publication") {
    const coordinated = output(needs, "coordinator");
    if (coordinated.mode !== "catalog")
      throw new Error("authenticated catalog coordinator route required");
    const context = contextLocator(coordinated.context_locator, fixed);
    const selectedPhase = releaseControlPhaseProfile(operation);
    const identity = inspectAssemblerIdentityExpectation({
      audience: selectedPhase.reader_audience,
      subject: controllerOidcSubject(fixed.controller_ref, selectedPhase.reader_environment),
      controller_revision: fixed.controller_revision,
      controller_ref: fixed.controller_ref,
      actor_id: fixed.actor_id,
      run_id: fixed.run_id,
      run_attempt: 1,
    });
    const roleLocator = (role: (typeof catalogSigningRoles)[number]) => {
      const value = inspectCatalogRoleArtifactExpected(
        json(output(needs, `catalog_${role}`).role_locator),
      );
      if (
        value.role !== role ||
        value.controller.controller_revision !== fixed.controller_revision ||
        value.controller.source_tree !== fixed.source_tree ||
        value.controller.controller_ref !== fixed.controller_ref ||
        value.controller.run_id !== fixed.run_id ||
        value.controller.run_attempt !== 1 ||
        value.context_manifest_sha256 !== context.manifest_sha256 ||
        value.context_binding_sha256 !== context.binding_sha256 ||
        value.context_facts_sha256 !== context.facts_sha256
      )
        throw new Error("fixed catalog role/context differs");
      return value;
    };
    if (operation === "site-publication")
      return {
        mode: "catalog",
        identity,
        tools,
        context,
        roles: catalogSigningRoles.map(roleLocator),
      };
    const role = String(operation).slice(8);
    return {
      role,
      identity,
      tools,
      context,
      dependencies: catalogRoleDependencies(role).map(roleLocator),
    };
  }

  if (operation === "building" && output(needs, "coordinator").publication_custody === "reused")
    throw new Error("retained publication cannot repeat aggregate preparation");
  if (operation === "building")
    return {
      configuration: admission,
      tools,
      native_locators: nativeLocators(input.native_locators),
    };
  const phase = operation === "payload" ? "payload" : operation;
  const profile = releaseControlPhaseProfile(phase);
  const identity = inspectAssemblerIdentityExpectation({
    audience: profile.reader_audience,
    subject: controllerOidcSubject(fixed.controller_ref, profile.reader_environment),
    controller_revision: fixed.controller_revision,
    controller_ref: fixed.controller_ref,
    actor_id: fixed.actor_id,
    run_id: fixed.run_id,
    run_attempt: 1,
  });
  const aggregate = () => {
    const built = output(needs, "independent_admission"),
      signed = output(needs, "attest");
    return inspectControllerAggregateLocator({
      controller_revision: fixed.controller_revision,
      controller_ref: fixed.controller_ref,
      run_id: fixed.run_id,
      run_attempt: 1,
      artifact_id: positive(built.artifact_id),
      sha256: hex(built.artifact_sha256),
      bundle_artifact_id: positive(signed.bundle_artifact_id),
      bundle_sha256: hex(signed.bundle_artifact_sha256),
      ...(built.original_upload === undefined || built.original_upload === ""
        ? {}
        : { original_upload: json(built.original_upload) }),
      ...(built.native_custody === undefined || built.native_custody === ""
        ? {}
        : { native_custody: json(built.native_custody) }),
    });
  };
  const coordinated = output(needs, "coordinator");
  const resumed = coordinated.signing_custody === "reused";
  const reportRepair =
    coordinated.report_only_repair === "true" &&
    typeof coordinated.report_repair_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(coordinated.report_repair_sha256);
  if (
    resumed &&
    (coordinated.mode !== "release" ||
      ![...(reportRepair ? ["qualifying", "building"] : []), "publishing", "promoting"].includes(
        String(coordinated.stage),
      ))
  )
    throw new Error("original signing custody requires later candidate phase");
  if (operation === "payload" && coordinated.mode !== "release")
    throw new Error("payload requires release coordinator mode");
  if (operation === "payload" && resumed)
    throw new Error("retained signing custody cannot repeat payload signing");
  if (operation === "payload")
    return {
      configuration: {
        admission_configuration: admission,
        aggregate: aggregate(),
        public_key_sha256: hex(input.payload_public_key_sha256),
      },
      signer_identity: identity,
      tools,
      native_locators: nativeLocators(input.native_locators),
    };
  if (coordinated.mode !== "release" && coordinated.mode !== "metadata")
    throw new Error("fixed coordinator mode unavailable");
  const context = contextLocator(
    output(needs, coordinated.mode === "metadata" || resumed ? "coordinator" : "payload_signing")
      .context_locator,
    fixed,
  );
  const context_kind =
    coordinated.mode === "metadata" ? "metadata-signing-context" : "release-signing-context";
  let retainedRoles: unknown[] | undefined;
  if (resumed) {
    if (
      typeof coordinated.role_locators !== "string" ||
      Buffer.byteLength(coordinated.role_locators) > 65536
    )
      throw new Error("bounded original role locators unavailable");
    const parsed: unknown = JSON.parse(coordinated.role_locators);
    if (!Array.isArray(parsed) || parsed.length !== 5)
      throw new Error("five original role locators required");
    retainedRoles = parsed;
  }
  const roleLocator = (role: string) => {
    const value = inspectTufRoleArtifactExpected(
      resumed
        ? retainedRoles![["releases", "preview", "stable", "snapshot", "timestamp"].indexOf(role)]
        : json(output(needs, `tuf_${role}`).role_locator),
    );
    if (
      value.role !== role ||
      value.controller.controller_revision !== fixed.controller_revision ||
      value.controller.source_tree !== fixed.source_tree ||
      value.controller.controller_ref !== fixed.controller_ref ||
      (!resumed && value.controller.run_id !== fixed.run_id) ||
      value.controller.run_attempt !== 1 ||
      value.context_manifest_sha256 !== context.manifest_sha256 ||
      value.context_binding_sha256 !== context.binding_sha256 ||
      value.context_facts_sha256 !== context.facts_sha256
    )
      throw new Error("fixed DAG role/context differs");
    return value;
  };
  if (typeof operation === "string" && operation.startsWith("tuf-")) {
    if (resumed) throw new Error("retained signing custody cannot repeat TUF signing");
    const role = operation.slice(4) as Parameters<typeof tufRoleDependencies>[0];
    return {
      role,
      identity,
      tools,
      context,
      context_kind,
      dependencies: tufRoleDependencies(role).map(roleLocator),
    };
  }
  const roles = ["releases", "preview", "stable", "snapshot", "timestamp"].map(roleLocator);
  if (operation === "release-publication") {
    if (coordinated.publication_custody === "reused")
      throw new Error("retained publication cannot repeat result production");
    if (coordinated.mode !== "release") throw new Error("metadata cannot publish a Release");
    return {
      configuration: {
        admission_configuration: admission,
        aggregate: aggregate(),
        native_locators: nativeLocators(input.native_locators),
      },
      context,
      identity,
      roles,
      tools,
    };
  }
  if (coordinated.mode === "metadata") return { mode: "metadata", context, identity, roles, tools };
  const reusedPublication = coordinated.publication_custody === "reused";
  if (reusedPublication && (!resumed || coordinated.stage !== "promoting"))
    throw new Error("retained publication requires exact later signing custody");
  const result = json(
    output(needs, reusedPublication ? "coordinator" : "release_publication").publication_locator,
  );
  if (
    Object.keys(result).sort().join(",") !==
      "artifact,bundle,controller_ref,controller_revision,report_sha256,run_attempt,run_id,source_tree" ||
    result.controller_revision !== fixed.controller_revision ||
    result.controller_ref !== fixed.controller_ref ||
    result.source_tree !== fixed.source_tree ||
    (!reusedPublication && result.run_id !== fixed.run_id) ||
    typeof result.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(result.run_id) ||
    result.run_attempt !== 1
  )
    throw new Error("fixed DAG publication result differs");
  hex(result.report_sha256);
  for (const key of ["artifact", "bundle"]) {
    const item = result[key];
    if (
      !isRecord(item) ||
      Object.keys(item).sort().join(",") !== "id,sha256" ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      item.id < 1
    )
      throw new Error("fixed DAG publication artifact differs");
    hex(item.sha256);
  }
  if (
    (result.artifact as Record<string, unknown>).id ===
    (result.bundle as Record<string, unknown>).id
  )
    throw new Error("separate publication attestation required");
  return { context, identity, roles, tools, publication_result: result };
}
