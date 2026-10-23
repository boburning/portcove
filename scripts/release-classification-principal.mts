import {
  requireAdmittedProductionSource,
  productionControllerWorkflow,
} from "./production-controller-admission.mts";
import { requireVerifiedClassificationPrincipalIdentity } from "./assembler-job-identity.mts";
import { inspectBoundSelectedPublicationAuthorities } from "./release-authority-configuration.mts";
import { inspectFixedClassificationProducer } from "./release-classification-contract.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";
import { semanticReviewCheckName } from "./release-control-phases.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";

type Role = "classification-writer" | ReleaseControlPhase;
type Source = ReturnType<
  typeof import("./production-controller-admission.mts").admitProductionInputReader
>;

export function prepareFixedClassificationProducer(raw: unknown, source: Source) {
  const selected = inspectBoundSelectedPublicationAuthorities(raw, source, "application");
  if (selected.configuration.purpose !== "application")
    throw new Error("application classification scope required");
  return inspectFixedClassificationProducer({
    schema_version: 3,
    purpose: "application",
    review_app_id: selected.configuration.journal.apps.semantic.app_id,
    review_check_name: semanticReviewCheckName,
    writer: {
      kind: "fixed-controller-classification-job",
      repository_id: 1354613114,
      workflow: productionControllerWorkflow,
      job: "classification_writer",
      environment: "production-release-classification",
      actor_id: source.actor_id,
      controller_revision: source.revision,
      controller_ref: source.execution_ref,
      workflow_sha256: source.workflow_sha256,
      authority_configuration_sha256: selected.configuration_sha256,
      namespace: selected.configuration.journal.namespace,
      setup_plan_sha256: selected.configuration.journal.setup_plan_sha256,
    },
  });
}
const principals = new WeakMap<
  object,
  {
    role: Role;
    source: Source;
    identity: unknown;
    snapshot: string;
    producer: ReturnType<typeof inspectFixedClassificationProducer>;
  }
>();

/** Joins original source and job verifier results without another OIDC round.
 * Injected provider provenance remains injected and cannot activate a writer. */
export function establishFixedClassificationPrincipal(
  raw: unknown,
  source: unknown,
  identity: unknown,
  role: Role,
  now = Date.now(),
) {
  if (!Number.isFinite(now) || now < 0) throw new Error("fixed classification clock unavailable");
  if (role.startsWith("catalog-"))
    throw new Error("catalog jobs cannot establish application classification principals");
  requireAdmittedProductionSource(
    source,
    role === "classification-writer"
      ? "classification_writer"
      : releaseControlPhaseProfile(role).reader_job,
    "application",
  );
  requireVerifiedClassificationPrincipalIdentity(identity, role, now);
  if (
    identity.workflow !== source.workflow ||
    identity.workflow_revision !== source.revision ||
    identity.execution_ref !== source.execution_ref ||
    identity.actor_id !== source.actor_id ||
    identity.run_id !== source.run_id ||
    identity.run_attempt !== source.run_attempt
  )
    throw new Error("fixed classification source/job binding differs");
  const producer = prepareFixedClassificationProducer(raw, source);
  const result = Object.freeze({
    producer: structuredClone(producer),
    evidence_scope: identity.evidence_scope,
    authority: "none" as const,
  });
  principals.set(result, {
    role,
    source,
    identity,
    snapshot: releaseCanonicalDigest(result),
    producer,
  });
  return result;
}
export function requireFixedClassificationPrincipal(
  value: unknown,
  now = Date.now(),
  writer = false,
) {
  if (!Number.isFinite(now) || now < 0) throw new Error("fixed classification clock unavailable");
  const saved = typeof value === "object" && value !== null ? principals.get(value) : undefined;
  if (
    !saved ||
    saved.snapshot !== releaseCanonicalDigest(value) ||
    (writer && saved.role !== "classification-writer")
  )
    throw new Error("original unchanged fixed classification principal required");
  requireAdmittedProductionSource(
    saved.source,
    saved.role === "classification-writer"
      ? "classification_writer"
      : releaseControlPhaseProfile(saved.role).reader_job,
    "application",
  );
  requireVerifiedClassificationPrincipalIdentity(saved.identity, saved.role, now);
  return {
    producer: structuredClone(saved.producer),
    source: saved.source,
    role: saved.role,
    identity: saved.identity,
  };
}
export function requireProductionFixedClassificationWriter(value: unknown, now = Date.now()) {
  const saved = requireFixedClassificationPrincipal(value, now, true);
  if (saved.identity.evidence_scope !== "github.com")
    throw new Error("actual provider fixed classification writer required");
  return saved;
}
