/** Integrity-only catalog subject contracts. JSON, digests and journal custody
 * never establish catalog admission, a trust root or permission to publish. */
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { metadataInstant } from "./release-metadata-contract.mts";
function exact(raw: unknown, fields: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== fields)
    throw new Error("catalog publication schema differs");
}
function sha(raw: unknown, length = 64): asserts raw is string {
  if (typeof raw !== "string" || !(length === 40 ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(raw))
    throw new Error("catalog publication exact identity required");
}
function nullableSha(raw: unknown): asserts raw is string | null {
  if (raw !== null) sha(raw);
}
export function inspectCatalogPublicationDescriptor(raw: unknown) {
  exact(
    raw,
    "admission_sha256,bundle_sha256,core_inspection_sha256,kind,prior,publisher_configuration_sha256,schema_version,source_commit,source_tree",
  );
  if (raw.schema_version !== 1 || raw.kind !== "catalog-publication")
    throw new Error("explicit catalog publication required");
  sha(raw.source_commit, 40);
  sha(raw.source_tree, 40);
  for (const field of [
    "admission_sha256",
    "bundle_sha256",
    "core_inspection_sha256",
    "publisher_configuration_sha256",
  ] as const)
    sha(raw[field]);
  exact(
    raw.prior,
    "application_repository_sha256,application_root_sha256,catalog_repository_sha256,catalog_root_sha256,site_generation_sha256",
  );
  sha(raw.prior.catalog_root_sha256);
  for (const field of [
    "catalog_repository_sha256",
    "site_generation_sha256",
    "application_root_sha256",
    "application_repository_sha256",
  ] as const)
    nullableSha(raw.prior[field]);
  if (
    (raw.prior.application_root_sha256 === null) !==
      (raw.prior.application_repository_sha256 === null) ||
    (raw.prior.site_generation_sha256 === null &&
      (raw.prior.catalog_repository_sha256 !== null ||
        raw.prior.application_root_sha256 !== null)) ||
    (raw.prior.site_generation_sha256 !== null &&
      raw.prior.catalog_repository_sha256 === null &&
      raw.prior.application_root_sha256 === null)
  )
    throw new Error("catalog prior components require actual whole-site identity");
  return {
    schema_version: 1 as const,
    kind: "catalog-publication" as const,
    source_commit: raw.source_commit,
    source_tree: raw.source_tree,
    admission_sha256: raw.admission_sha256,
    bundle_sha256: raw.bundle_sha256,
    core_inspection_sha256: raw.core_inspection_sha256,
    publisher_configuration_sha256: raw.publisher_configuration_sha256,
    prior: {
      application_repository_sha256: raw.prior.application_repository_sha256,
      application_root_sha256: raw.prior.application_root_sha256,
      catalog_repository_sha256: raw.prior.catalog_repository_sha256,
      catalog_root_sha256: raw.prior.catalog_root_sha256,
      site_generation_sha256: raw.prior.site_generation_sha256,
    },
  };
}
/** Bundle/source/config or app-only site changes do not create fresh retry
 * allowance for the same catalog publication baseline. */
export function catalogPublicationLifecycle(raw: unknown) {
  const descriptor = inspectCatalogPublicationDescriptor(raw);
  return digest({
    catalog_root_sha256: descriptor.prior.catalog_root_sha256,
    catalog_repository_sha256: descriptor.prior.catalog_repository_sha256,
  });
}
export function inspectCatalogCapacitySubject(raw: unknown) {
  exact(raw, "descriptor,descriptor_sha256,observed_at,substantive_repairs,transient_retries");
  const descriptor = inspectCatalogPublicationDescriptor(raw.descriptor);
  sha(raw.descriptor_sha256);
  if (raw.descriptor_sha256 !== digest(descriptor))
    throw new Error("catalog descriptor digest differs");
  metadataInstant(raw.observed_at);
  for (const [field, maximum] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const)
    if (
      typeof raw[field] !== "number" ||
      !Number.isInteger(raw[field]) ||
      raw[field] < 0 ||
      raw[field] > maximum
    )
      throw new Error("catalog recovery exceeds existing limits");
  return {
    descriptor,
    descriptor_sha256: raw.descriptor_sha256,
    observed_at: String(raw.observed_at),
    transient_retries: Number(raw.transient_retries),
    substantive_repairs: Number(raw.substantive_repairs),
  };
}
export function inspectCatalogSitePublicationExpectation(raw: unknown) {
  exact(
    raw,
    "application_root_sha256,archive_sha256,artifact_id,catalog_repository_sha256,catalog_root_sha256,prior_site_generation_sha256,site_generation_sha256",
  );
  for (const field of [
    "archive_sha256",
    "catalog_repository_sha256",
    "catalog_root_sha256",
    "site_generation_sha256",
  ] as const)
    sha(raw[field]);
  nullableSha(raw.application_root_sha256);
  nullableSha(raw.prior_site_generation_sha256);
  if (
    typeof raw.artifact_id !== "number" ||
    !Number.isSafeInteger(raw.artifact_id) ||
    raw.artifact_id < 1 ||
    raw.prior_site_generation_sha256 === raw.site_generation_sha256
  )
    throw new Error("catalog site effect requires exact new generation and artifact");
  return {
    application_root_sha256: raw.application_root_sha256,
    archive_sha256: raw.archive_sha256,
    artifact_id: raw.artifact_id,
    catalog_repository_sha256: raw.catalog_repository_sha256,
    catalog_root_sha256: raw.catalog_root_sha256,
    prior_site_generation_sha256: raw.prior_site_generation_sha256,
    site_generation_sha256: raw.site_generation_sha256,
  };
}
export function assertCatalogSitePublicationBinding(
  descriptorRaw: unknown,
  expectationRaw: unknown,
) {
  const descriptor = inspectCatalogPublicationDescriptor(descriptorRaw);
  const expected = inspectCatalogSitePublicationExpectation(expectationRaw);
  if (
    expected.catalog_root_sha256 !== descriptor.prior.catalog_root_sha256 ||
    expected.application_root_sha256 !== descriptor.prior.application_root_sha256 ||
    expected.prior_site_generation_sha256 !== descriptor.prior.site_generation_sha256
  )
    throw new Error("catalog site expectation changed admitted prior/root");
  return expected;
}
