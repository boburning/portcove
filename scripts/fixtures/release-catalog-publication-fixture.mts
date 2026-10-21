/** Inert supplied facts, never catalog/source/provider authority. */
export function catalogPublicationFixture() {
  return {
    schema_version: 1,
    kind: "catalog-publication",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    bundle_sha256: "3".repeat(64),
    core_inspection_sha256: "4".repeat(64),
    admission_sha256: "5".repeat(64),
    publisher_configuration_sha256: "6".repeat(64),
    prior: {
      catalog_root_sha256: "7".repeat(64),
      catalog_repository_sha256: null,
      site_generation_sha256: null,
      application_root_sha256: null,
      application_repository_sha256: null,
    },
  };
}
