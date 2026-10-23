import { inspectCatalogListingIdentity } from "./release-catalog-publication-contract.mts";
import { isRecord } from "./runtime-values.mts";

function exact(raw: unknown, keys: string) {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("catalog semantic purpose schema differs");
  return raw;
}
function hash(raw: unknown, length = 64): string {
  if (typeof raw !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw))
    throw new Error("catalog semantic identity differs");
  return raw;
}
function revision(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)
    throw new Error("catalog semantic revision differs");
  return raw;
}

/** Inert exact-purpose input, never Core inspection, current Tough custody or
 * semantic acceptance. The fixed caller independently establishes those facts. */
export function inspectCatalogSemanticOpportunity(raw: unknown) {
  const value = exact(
    raw,
    "base_commit,baseline,bundle_sha256,change_set_sha256,classification,compatibility,core_inspection_sha256,kind,publisher_configuration_sha256,source_commit,source_tree",
  );
  if (value.kind !== "catalog-publication") throw new Error("catalog semantic purpose differs");
  const baseline = exact(
    value.baseline,
    "application_repository_sha256,application_root_sha256,catalog_repository_sha256,catalog_root_sha256,site_generation_sha256,source_commit,source_tree",
  );
  const hasListings =
    isRecord(value.classification) && Object.hasOwn(value.classification, "listings");
  const classification = exact(
    value.classification,
    hasListings ? "change,definitions,index_sha256,listings" : "change,definitions,index_sha256",
  );
  const listings = hasListings ? inspectCatalogListingIdentity(classification.listings) : null;
  if (
    (classification.change !== "initial" && classification.change !== "update") ||
    !Array.isArray(classification.definitions) ||
    classification.definitions.length > 4096
  )
    throw new Error("catalog semantic classification differs");
  let previous = "";
  const definitions = classification.definitions.map((rawDefinition) => {
    const definition = exact(
      rawDefinition,
      "definition_target,grant_id,launch_revision,launch_target,namespace,policy_revision,policy_schema,policy_target,revision,stable_id",
    );
    if (
      definition.namespace !== "official" ||
      typeof definition.stable_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(definition.stable_id) ||
      definition.stable_id <= previous ||
      typeof definition.grant_id !== "string" ||
      !definition.grant_id.trim() ||
      Buffer.byteLength(definition.grant_id) > 512 ||
      Array.from(definition.grant_id).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof definition.definition_target !== "string" ||
      !/^sha256\/[a-f0-9]{64}\.json$/u.test(definition.definition_target) ||
      definition.policy_target !== `policy/official/${definition.stable_id}.json` ||
      typeof definition.policy_schema !== "number" ||
      ![1, 2, 3, 4].includes(definition.policy_schema)
    )
      throw new Error("catalog semantic Core definition/policy identity differs");
    previous = definition.stable_id;
    if (
      definition.policy_schema <= 2
        ? definition.launch_target !== null || definition.launch_revision !== null
        : definition.launch_target !== `policy/official/${definition.stable_id}.launch.json`
    )
      throw new Error("catalog semantic launch identity differs");
    return {
      namespace: "official" as const,
      stable_id: definition.stable_id,
      revision: revision(definition.revision),
      definition_target: definition.definition_target,
      policy_target: definition.policy_target,
      policy_schema: definition.policy_schema,
      policy_revision: revision(definition.policy_revision),
      grant_id: definition.grant_id,
      launch_target: definition.launch_target as string | null,
      launch_revision:
        definition.launch_revision === null ? null : revision(definition.launch_revision),
    };
  });
  const compatibility = exact(value.compatibility, "contract,notes");
  if (
    compatibility.contract !==
      (hasListings ? "official-catalog-listings-v2" : "official-definition-policy-launch-v1") ||
    typeof compatibility.notes !== "string" ||
    !compatibility.notes.trim() ||
    Buffer.byteLength(compatibility.notes) > 8192
  )
    throw new Error("catalog semantic compatibility evidence differs");
  const sourceCommit = hash(value.source_commit, 40),
    baseCommit = hash(value.base_commit, 40);
  const baselineSource = hash(baseline.source_commit, 40);
  if (baseCommit !== baselineSource) throw new Error("catalog semantic baseline source differs");
  const nullableHash = (value: unknown) => (value === null ? null : hash(value));
  const catalogRepository = nullableHash(baseline.catalog_repository_sha256);
  const siteGeneration = nullableHash(baseline.site_generation_sha256);
  const applicationRoot = nullableHash(baseline.application_root_sha256);
  const applicationRepository = nullableHash(baseline.application_repository_sha256);
  if (
    (applicationRoot === null) !== (applicationRepository === null) ||
    (siteGeneration === null && (catalogRepository !== null || applicationRoot !== null)) ||
    (siteGeneration !== null && catalogRepository === null && applicationRoot === null) ||
    (classification.change === "initial") !== (catalogRepository === null)
  )
    throw new Error("catalog semantic authenticated baseline component tuple differs");
  const result = {
    kind: "catalog-publication" as const,
    source_commit: sourceCommit,
    source_tree: hash(value.source_tree, 40),
    base_commit: baseCommit,
    change_set_sha256: hash(value.change_set_sha256),
    bundle_sha256: hash(value.bundle_sha256),
    core_inspection_sha256: hash(value.core_inspection_sha256),
    publisher_configuration_sha256: hash(value.publisher_configuration_sha256),
    baseline: {
      source_commit: baselineSource,
      source_tree: hash(baseline.source_tree, 40),
      catalog_root_sha256: hash(baseline.catalog_root_sha256),
      catalog_repository_sha256: catalogRepository,
      site_generation_sha256: siteGeneration,
      application_root_sha256: applicationRoot,
      application_repository_sha256: applicationRepository,
    },
    classification: {
      change: classification.change,
      index_sha256: hash(classification.index_sha256),
      definitions,
      ...(listings ? { listings } : {}),
    },
    compatibility: {
      contract: compatibility.contract as
        | "official-definition-policy-launch-v1"
        | "official-catalog-listings-v2",
      notes: compatibility.notes,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024)
    throw new Error("catalog semantic opportunity exceeds complete Check bound");
  return result;
}
export function isCatalogSemanticPurpose(raw: unknown): boolean {
  return isRecord(raw) && raw.kind === "catalog-publication";
}
