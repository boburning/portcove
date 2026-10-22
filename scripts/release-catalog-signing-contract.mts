/** Integrity-only catalog signing inputs. No parser appoints a publisher, key or executor. */
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectCatalogPublicationDescriptor } from "./release-catalog-publication-contract.mts";
import { metadataInstant } from "./release-metadata-contract.mts";
import {
  inspectInitialRootProfile,
  initialRootProfileFields,
  inspectTopLevelTargetsProfile,
  topLevelTargetsProfileFields,
  type InitialRootProfile,
  type TopLevelTargetsProfile,
} from "./release-initial-root-profile.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import {
  inspectPublishedCatalogMetadata,
  currentPublishedSite,
} from "./release-catalog-metadata-contract.mts";

export const catalogSigningRoles = ["definitions", "policy", "snapshot", "timestamp"] as const;
export type CatalogSigningRole = (typeof catalogSigningRoles)[number];
export function inspectCatalogSigningRole(raw: unknown): CatalogSigningRole {
  if (!catalogSigningRoles.some((role) => role === raw))
    throw new Error("fixed catalog signing role required");
  return raw as CatalogSigningRole;
}
/** A caller must independently authenticate the durable journal or initial Git
 * source before this integrity comparison. No latest-app baseline is accepted. */
export function assertCatalogSemanticPublishedBaseline(
  raw: unknown,
  rawSeed: unknown,
  initial: { commit: string; tree: string; root_sha256: string } | null,
) {
  const opportunity = inspectCatalogSemanticOpportunity(raw),
    seed = inspectPublishedCatalogMetadata(rawSeed);
  const source = seed
    ? { commit: seed.source_commit, tree: seed.source_tree, root_sha256: seed.root_sha256 }
    : initial;
  if (
    !source ||
    opportunity.baseline.source_commit !== source.commit ||
    opportunity.baseline.source_tree !== source.tree ||
    opportunity.baseline.catalog_root_sha256 !== source.root_sha256 ||
    opportunity.baseline.catalog_repository_sha256 !== (seed?.repository_sha256 ?? null)
  )
    throw new Error("catalog review baseline differs from accepted catalog source");
  return opportunity;
}
/** Formatting/integrity only. The protected coordinator establishes all actual
 * Core, selected semantic producer, configuration and journal inputs first. */
export function deriveCatalogSigningDescriptor(
  rawOpportunity: unknown,
  inspection: {
    source: { commit: string; tree: string };
    bundle_sha256: string;
    inspection_sha256: string;
  },
  configuration_sha256: string,
  semantic_proof_sha256: string,
  input: Record<string, unknown>,
  initial_root_sha256: string,
) {
  const opportunity = inspectCatalogSemanticOpportunity(rawOpportunity),
    catalog = inspectPublishedCatalogMetadata(input.published_catalog_metadata),
    site = currentPublishedSite(input);
  if (
    opportunity.source_commit !== inspection.source.commit ||
    opportunity.source_tree !== inspection.source.tree ||
    opportunity.bundle_sha256 !== inspection.bundle_sha256 ||
    opportunity.core_inspection_sha256 !== inspection.inspection_sha256 ||
    opportunity.publisher_configuration_sha256 !== configuration_sha256
  )
    throw new Error("catalog actual inspection/configuration differs from semantic subject");
  const descriptor = inspectCatalogPublicationDescriptor({
    schema_version: 1,
    kind: "catalog-publication",
    source_commit: inspection.source.commit,
    source_tree: inspection.source.tree,
    bundle_sha256: inspection.bundle_sha256,
    core_inspection_sha256: inspection.inspection_sha256,
    publisher_configuration_sha256: configuration_sha256,
    admission_sha256: catalogSigningAdmissionDigest({ ...opportunity, semantic_proof_sha256 }),
    prior: {
      application_repository_sha256: site?.components.application?.repository_sha256 ?? null,
      application_root_sha256: site?.components.application?.root_sha256 ?? null,
      catalog_repository_sha256: catalog?.repository_sha256 ?? null,
      catalog_root_sha256: catalog?.root_sha256 ?? initial_root_sha256,
      site_generation_sha256: site?.generation_sha256 ?? null,
    },
  });
  for (const name of Object.keys(descriptor.prior) as (keyof typeof descriptor.prior)[])
    if (opportunity.baseline[name] !== descriptor.prior[name])
      throw new Error("catalog semantic whole-site baseline differs from actual journal");
  return descriptor;
}
/** Conservative producer preflight. Existing immutable history is never deleted
 * to make space; reserve all four maximum envelopes and the full site marker.
 * It is deliberately stricter than Core's independent bundle capability. */
export function inspectCatalogSigningPreflight(
  files: ReadonlyMap<string, Buffer>,
  priorSite: readonly { path: string; bytes: number; sha256: string }[],
) {
  let contextBytes = 0;
  for (const bytes of files.values()) {
    if (bytes.length < 1 || bytes.length > 1024 ** 2)
      throw new Error("catalog context per-file transport cap exceeded");
    contextBytes += bytes.length;
  }
  if (files.size > 2208 || contextBytes > 127 * 1024 ** 2)
    throw new Error("catalog context aggregate transport cap exceeded");
  const seen = new Set<string>();
  let siteBytes = 0;
  for (const file of priorSite) {
    if (
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 64 * 1024 ** 2
    )
      throw new Error("catalog prior site inventory differs");
    sha(file.sha256);
    seen.add(file.path);
    siteBytes += file.bytes;
  }
  const targets = [...files].filter(([name]) => name.startsWith("bundle/")),
    anchors = ["trusted-root.json", "offline-targets.json"].map((name) => files.get(name));
  if (anchors.some((bytes) => !bytes)) throw new Error("catalog preflight anchors missing");
  // Counting anchors/new targets even when already retained is a safe upper bound.
  const siteFilesUpperBound =
    priorSite.length + targets.length + 2 + 4 + 1 + (seen.has(".nojekyll") ? 0 : 1);
  const siteBytesUpperBound =
    siteBytes +
    targets.reduce((sum, [, bytes]) => sum + bytes.length, 0) +
    anchors.reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0) +
    4 * 512 * 1024 +
    4 * 1024 ** 2;
  if (siteFilesUpperBound > 6000 || siteBytesUpperBound > 256 * 1024 ** 2)
    throw new Error("catalog prospective complete-site bound exceeded before key release");
  return {
    context_files: files.size,
    context_bytes: contextBytes,
    site_files_upper_bound: siteFilesUpperBound,
    site_bytes_upper_bound: siteBytesUpperBound,
    authority: "none" as const,
  };
}
export const catalogRoleName = (raw: unknown) => {
  const role = inspectCatalogSigningRole(raw);
  return role === "definitions" || role === "policy" ? `official-${role}` : role;
};
export function catalogRoleDependencies(raw: unknown): readonly CatalogSigningRole[] {
  const role = inspectCatalogSigningRole(raw);
  return Object.freeze(
    role === "timestamp"
      ? catalogSigningRoles.slice(0, 3)
      : role === "snapshot"
        ? catalogSigningRoles.slice(0, 2)
        : [],
  );
}
function exact(raw: unknown, fields: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== fields)
    throw new Error("catalog signing exact schema differs");
}
function sha(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("catalog signing SHA differs");
}
function roleValues(raw: unknown, expiry: boolean) {
  exact(raw, "definitions,policy,snapshot,timestamp");
  return Object.fromEntries(
    catalogSigningRoles.map((role) => {
      const value = raw[role];
      if (expiry) metadataInstant(value);
      else if (
        typeof value !== "string" ||
        !/^[1-9][0-9]{0,19}$/u.test(value) ||
        BigInt(value) > 18446744073709551615n
      )
        throw new Error("catalog version must be positive u64 text");
      return [role, String(value)];
    }),
  ) as Record<CatalogSigningRole, string>;
}
export function inspectCatalogSigningFacts(raw: unknown) {
  exact(
    raw,
    [
      "descriptor",
      "expires",
      "generated_at",
      "kind",
      "namespace",
      "offline_targets_sha256",
      "root_sha256",
      "semantic_check_id",
      "semantic_opportunity",
      "semantic_proof_sha256",
      "versions",
      ...catalogProfileKeys(raw),
    ]
      .sort()
      .join(","),
  );
  if (raw.kind !== "catalog-signing") throw new Error("explicit catalog context purpose required");
  const descriptor = inspectCatalogPublicationDescriptor(raw.descriptor);
  const profiles = catalogProfileFields(raw);
  if (
    raw.top_level_targets_profile === "online-unchanged-authority-v1" &&
    descriptor.prior.catalog_repository_sha256 === null
  )
    throw new Error("online catalog Targets requires authenticated prior; bootstrap is separate");
  const opportunity = inspectCatalogSemanticOpportunity(raw.semantic_opportunity);
  if (
    typeof raw.namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(raw.namespace) ||
    typeof raw.semantic_check_id !== "number" ||
    !Number.isSafeInteger(raw.semantic_check_id) ||
    raw.semantic_check_id < 1
  )
    throw new Error("catalog context actual namespace/Check identity differs");
  for (const field of [
    "source_commit",
    "source_tree",
    "bundle_sha256",
    "core_inspection_sha256",
    "publisher_configuration_sha256",
  ] as const)
    if (opportunity[field] !== descriptor[field])
      throw new Error("catalog semantic opportunity differs from subject");
  for (const field of Object.keys(descriptor.prior) as (keyof typeof descriptor.prior)[])
    if (opportunity.baseline[field] !== descriptor.prior[field])
      throw new Error("catalog semantic prior tuple differs");
  for (const name of ["root_sha256", "offline_targets_sha256", "semantic_proof_sha256"])
    sha(raw[name]);
  if (raw.root_sha256 !== descriptor.prior.catalog_root_sha256)
    throw new Error("catalog context Root differs from subject");
  const at = metadataInstant(raw.generated_at),
    expires = roleValues(raw.expires, true);
  for (const role of catalogSigningRoles)
    if (metadataInstant(expires[role]) <= at)
      throw new Error("catalog role expires before context generation");
  if (
    descriptor.admission_sha256 !==
    catalogSigningAdmissionDigest({
      ...opportunity,
      semantic_proof_sha256: String(raw.semantic_proof_sha256),
    })
  )
    throw new Error("catalog admission proof differs from actual inputs");
  return {
    kind: "catalog-signing" as const,
    ...profiles,
    namespace: raw.namespace,
    descriptor,
    semantic_opportunity: opportunity,
    semantic_check_id: raw.semantic_check_id,
    generated_at: String(raw.generated_at),
    root_sha256: String(raw.root_sha256),
    offline_targets_sha256: String(raw.offline_targets_sha256),
    semantic_proof_sha256: String(raw.semantic_proof_sha256),
    versions: roleValues(raw.versions, false),
    expires,
  };
}
/** Exact admission tuple only. Its caller must establish actual Core/semantic/config provenance. */
export function catalogSigningAdmissionDigest(raw: {
  source_commit: string;
  source_tree: string;
  bundle_sha256: string;
  core_inspection_sha256: string;
  semantic_proof_sha256: string;
  publisher_configuration_sha256: string;
}) {
  const {
    source_commit,
    source_tree,
    bundle_sha256,
    core_inspection_sha256,
    semantic_proof_sha256,
    publisher_configuration_sha256,
  } = raw;
  if (!/^[a-f0-9]{40}$/u.test(source_commit) || !/^[a-f0-9]{40}$/u.test(source_tree))
    throw new Error("catalog admission source differs");
  for (const value of [
    bundle_sha256,
    core_inspection_sha256,
    semantic_proof_sha256,
    publisher_configuration_sha256,
  ])
    sha(value);
  return digest({
    source_commit,
    source_tree,
    bundle_sha256,
    core_inspection_sha256,
    semantic_proof_sha256,
    publisher_configuration_sha256,
  });
}
export function catalogSigningContextBytes(raw: unknown) {
  const facts = inspectCatalogSigningFacts(raw);
  const body = JSON.stringify({
    schema_version: 1,
    ...catalogProfileFields(facts),
    generated_at: facts.generated_at,
    trusted_root: "trusted-root.json",
    trusted_root_sha256: facts.root_sha256,
    offline_targets: "offline-targets.json",
    offline_targets_sha256: facts.offline_targets_sha256,
    prepared_bundle: "bundle",
    inspection: "core-inspection.json",
    inspection_sha256: facts.descriptor.core_inspection_sha256,
    previous_repository: facts.descriptor.prior.catalog_repository_sha256 === null ? null : "prior",
    expires: facts.expires,
  });
  const versions = catalogSigningRoles
    .map((role) => `${JSON.stringify(role)}:${facts.versions[role]}`)
    .join(",");
  return Buffer.from(`${body.slice(0, -1)},"versions":{${versions}}}\n`);
}
export function inspectCatalogSigningBinding(
  rawFacts: unknown,
  rawBinding: unknown,
  prior: unknown,
  expectedProfiles: {
    initial_root_profile?: InitialRootProfile;
    top_level_targets_profile?: TopLevelTargetsProfile;
  } = {},
) {
  exact(expectedProfiles, catalogProfileKeys(expectedProfiles).sort().join(","));
  const facts = inspectCatalogSigningFacts(rawFacts);
  if (digest(catalogProfileFields(facts)) !== digest(catalogProfileFields(expectedProfiles)))
    throw new Error("catalog context profile differs from independently selected authority");
  exact(
    rawBinding,
    "bundle_sha256,context_sha256,core_inspection_sha256,descriptor_sha256,offline_targets_sha256,root_sha256,semantic_proof_sha256,source_commit,source_tree",
  );
  if (digest(prior) !== digest(facts.descriptor.prior))
    throw new Error("catalog context prior component tuple differs");
  const expected = {
    source_commit: facts.descriptor.source_commit,
    source_tree: facts.descriptor.source_tree,
    bundle_sha256: facts.descriptor.bundle_sha256,
    core_inspection_sha256: facts.descriptor.core_inspection_sha256,
    descriptor_sha256: digest(facts.descriptor),
    root_sha256: facts.root_sha256,
    offline_targets_sha256: facts.offline_targets_sha256,
    semantic_proof_sha256: facts.semantic_proof_sha256,
  };
  for (const [field, value] of Object.entries(expected))
    if (rawBinding[field] !== value)
      throw new Error("catalog context exact source/admission binding differs");
  sha(rawBinding.context_sha256);
  return { facts, binding: { ...expected, context_sha256: rawBinding.context_sha256 } };
}
/** Structural paths only; the actual Rust engine checks signed identities and u64s. */
export function inspectCatalogContextPaths(raw: Buffer) {
  if (raw.length < 1 || raw.length > 65536 || !Buffer.from(raw.toString("utf8")).equals(raw))
    throw new Error("bounded UTF-8 catalog context required");
  const value: unknown = JSON.parse(raw.toString("utf8"));
  exact(
    value,
    [
      "expires",
      "generated_at",
      "inspection",
      "inspection_sha256",
      "offline_targets",
      "offline_targets_sha256",
      "prepared_bundle",
      "previous_repository",
      "schema_version",
      "trusted_root",
      "trusted_root_sha256",
      "versions",
      ...catalogProfileKeys(value),
    ]
      .sort()
      .join(","),
  );
  if (
    value.schema_version !== 1 ||
    value.trusted_root !== "trusted-root.json" ||
    value.offline_targets !== "offline-targets.json" ||
    value.inspection !== "core-inspection.json" ||
    value.prepared_bundle !== "bundle" ||
    !(value.previous_repository === null || value.previous_repository === "prior")
  )
    throw new Error("fixed catalog context paths required");
  for (const name of ["trusted_root_sha256", "offline_targets_sha256", "inspection_sha256"])
    sha(value[name]);
  catalogProfileFields(value);
  if (
    value.top_level_targets_profile === "online-unchanged-authority-v1" &&
    value.previous_repository !== "prior"
  )
    throw new Error("online catalog Targets requires authenticated prior");
  return { bootstrap: value.previous_repository === null };
}
function catalogProfileKeys(raw: unknown) {
  return ["initial_root_profile", "top_level_targets_profile"].filter(
    (key) => isRecord(raw) && Object.hasOwn(raw, key),
  );
}
function catalogProfileFields(raw: Record<string, unknown>) {
  const root = inspectInitialRootProfile(
    Object.hasOwn(raw, "initial_root_profile")
      ? raw.initial_root_profile
      : "legacy-two-of-three-v1",
  );
  const targets = inspectTopLevelTargetsProfile(
    Object.hasOwn(raw, "top_level_targets_profile")
      ? raw.top_level_targets_profile
      : "offline-pinned-v1",
  );
  if (targets === "online-unchanged-authority-v1" && root !== "single-owner-one-of-one-v1")
    throw new Error("online catalog Targets requires explicit single-owner profile");
  return { ...initialRootProfileFields(root), ...topLevelTargetsProfileFields(targets) };
}
export interface IsolatedCatalogRoleRequest {
  role: CatalogSigningRole;
  context_directory: string;
  tool: { path: string; sha256: string };
  signed_roles: readonly { filename: string; path: string; bytes: number; sha256: string }[];
  output: string;
}
export function inspectIsolatedCatalogRoleRequest(raw: unknown): IsolatedCatalogRoleRequest {
  const value: unknown = structuredClone(raw);
  exact(value, "context_directory,output,role,signed_roles,tool");
  const role = inspectCatalogSigningRole(value.role),
    dependencies = catalogRoleDependencies(role);
  exact(value.tool, "path,sha256");
  sha(value.tool.sha256);
  if (
    ![value.context_directory, value.output, value.tool.path].every(
      (name) => typeof name === "string" && path.isAbsolute(name),
    ) ||
    !Array.isArray(value.signed_roles) ||
    value.signed_roles.length !== dependencies.length
  )
    throw new Error("catalog role fixed inputs differ");
  const signed_roles = value.signed_roles.map((file: unknown, index: number) => {
    exact(file, "bytes,filename,path,sha256");
    sha(file.sha256);
    if (
      file.filename !== `${catalogRoleName(dependencies[index])}.json` ||
      typeof file.path !== "string" ||
      !path.isAbsolute(file.path) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024
    )
      throw new Error("catalog signed dependency differs");
    return {
      filename: String(file.filename),
      path: file.path,
      bytes: file.bytes,
      sha256: String(file.sha256),
    };
  });
  return {
    role,
    context_directory: String(value.context_directory),
    output: String(value.output),
    tool: { path: String(value.tool.path), sha256: String(value.tool.sha256) },
    signed_roles,
  };
}
