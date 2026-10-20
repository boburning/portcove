import {
  inspectMetadataRenewalDescriptor,
  inspectPublishedMetadata,
} from "../release-metadata-contract.mts";

// Disposable declared facts, never authenticated public feed/source evidence.
export function metadataFixture(at = Date.now()) {
  const time = (days: number) =>
    new Date(Math.floor(at / 1000) * 1000 + days * 86_400_000).toISOString().replace(".000Z", "Z");
  const current_versions = {
    targets: "1",
    snapshot: "1",
    timestamp: "1",
    releases: "1",
    preview: "1",
    stable: "1",
  };
  const next_versions = {
    ...current_versions,
    snapshot: "2",
    timestamp: "2",
    releases: "2",
    preview: "2",
    stable: "2",
  };
  const current_expires = {
    targets: time(365),
    snapshot: time(6),
    timestamp: time(1),
    releases: time(89),
    preview: time(6),
    stable: time(6),
  };
  const next_expires = {
    targets: time(365),
    snapshot: time(7),
    timestamp: time(2),
    releases: time(90),
    preview: time(7),
    stable: time(7),
  };
  const descriptor = inspectMetadataRenewalDescriptor({
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: time(0),
    root_sha256: "1".repeat(64),
    offline_targets_sha256: "2".repeat(64),
    prior_repository_sha256: "3".repeat(64),
    prior_snapshot_sha256: "4".repeat(64),
    prior_timestamp_sha256: "5".repeat(64),
    unchanged_records_sha256: "6".repeat(64),
    current_versions,
    next_versions,
    current_expires,
    next_expires,
  });
  const published = inspectPublishedMetadata({
    schema_version: 1,
    root_sha256: descriptor.root_sha256,
    offline_targets_sha256: descriptor.offline_targets_sha256,
    repository_sha256: descriptor.prior_repository_sha256,
    snapshot_sha256: descriptor.prior_snapshot_sha256,
    timestamp_sha256: descriptor.prior_timestamp_sha256,
    records_sha256: descriptor.unchanged_records_sha256,
    versions: current_versions,
    expires: current_expires,
    operation_id: null,
    publication: {
      remote_identity: "qualification:public-readback",
      evidence_sha256: "7".repeat(64),
      site_generation_sha256: "8".repeat(64),
    },
  })!;
  return { descriptor, published, now: time(0) };
}
