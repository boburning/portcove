/** Fixed roles under the one ratified controller, never caller-selected job names.
 * Reserving a phase does not implement or activate its future publisher job. */
export type ReleaseControlPhase =
  | "admission"
  | "payload"
  | "coordinator"
  | "site-publication"
  | "release-publication"
  | "tuf-releases"
  | "tuf-preview"
  | "tuf-stable"
  | "tuf-snapshot"
  | "tuf-timestamp"
  | CatalogControlPhase;
export type CatalogControlPhase =
  | "catalog-definitions"
  | "catalog-policy"
  | "catalog-snapshot"
  | "catalog-timestamp";
export type TufSigningRole = "releases" | "preview" | "stable" | "snapshot" | "timestamp";
export type MaintenanceReleaseControlPhase =
  | "coordinator"
  | "site-publication"
  | CatalogControlPhase
  | `tuf-${TufSigningRole}`;
const tufTitles = Object.freeze({
  releases: "Releases",
  preview: "Preview",
  stable: "Stable",
  snapshot: "Snapshot",
  timestamp: "Timestamp",
});
function metadataProfile(role: TufSigningRole) {
  return Object.freeze({
    reader_job: `tuf_${role}` as const,
    reader_name: `Sign authenticated ${tufTitles[role]} metadata` as const,
    reader_audience: `portcove-tuf-${role}-signing-v1` as const,
    reader_environment: `production-tuf-${role}` as const,
    observer_job: "metadata_protection_observation",
    observer_name: "Observe application metadata signing protections",
    observer_audience: `portcove-release-tuf-${role}-protection-v1` as const,
    observer_environment: "production-release-protection-observer",
  });
}
function catalogProfile(role: "definitions" | "policy" | "snapshot" | "timestamp") {
  return Object.freeze({
    reader_job: `catalog_${role}` as const,
    reader_name: `Sign catalog ${role}` as const,
    reader_audience: `portcove-catalog-${role}-signing-v1` as const,
    reader_environment: `production-catalog-${role}` as const,
    observer_job: "catalog_metadata_protection_observation",
    observer_name: "Observe catalog metadata signing protections",
    observer_audience: `portcove-release-catalog-${role}-protection-v1` as const,
    observer_environment: "production-release-protection-observer",
  });
}
const phases = Object.freeze({
  "catalog-definitions": catalogProfile("definitions"),
  "catalog-policy": catalogProfile("policy"),
  "catalog-snapshot": catalogProfile("snapshot"),
  "catalog-timestamp": catalogProfile("timestamp"),
  coordinator: Object.freeze({
    reader_job: "coordinator",
    reader_name: "Coordinate application release",
    reader_audience: "portcove-release-coordinator-reader-v1",
    reader_environment: "production-release-coordinator",
    observer_job: "coordinator_protection_observation",
    observer_name: "Observe application coordinator protections",
    observer_audience: "portcove-release-coordinator-protection-v1",
    observer_environment: "production-release-protection-observer",
  }),
  "tuf-releases": metadataProfile("releases"),
  "tuf-preview": metadataProfile("preview"),
  "tuf-stable": metadataProfile("stable"),
  "tuf-snapshot": metadataProfile("snapshot"),
  "tuf-timestamp": metadataProfile("timestamp"),
  admission: Object.freeze({
    reader_job: "independent_admission",
    reader_name: "Authenticate release control inputs",
    reader_audience: "portcove-release-input-reader-v1",
    reader_environment: "production-release-admission",
    observer_environment: "production-release-protection-observer",
    observer_job: "protection_observation",
    observer_name: "Observe production release input protections",
    observer_audience: "portcove-release-protection-v1",
  }),
  payload: Object.freeze({
    reader_job: "payload_signing",
    reader_name: "Sign admitted updater payloads",
    reader_audience: "portcove-payload-signing",
    reader_environment: "production-payload-signing",
    observer_environment: "production-release-protection-observer",
    observer_job: "payload_protection_observation",
    observer_name: "Observe payload signing input protections",
    observer_audience: "portcove-release-protection-payload-v1",
  }),
  "site-publication": Object.freeze({
    reader_job: "site_publication",
    reader_name: "Publish authenticated application site",
    reader_audience: "portcove-release-site-publication-reader-v1",
    reader_environment: "github-pages",
    observer_environment: "production-release-protection-observer",
    observer_job: "site_protection_observation",
    observer_name: "Observe application site publication protections",
    observer_audience: "portcove-release-site-publication-protection-v1",
  }),
  "release-publication": Object.freeze({
    reader_job: "release_publication",
    reader_name: "Publish immutable application release",
    reader_audience: "portcove-release-publication-reader-v1",
    reader_environment: "production-release-publication",
    observer_environment: "production-release-protection-observer",
    observer_job: "release_protection_observation",
    observer_name: "Observe immutable application release publication protections",
    observer_audience: "portcove-release-publication-protection-v1",
  }),
});
export function inspectReleaseControlPhase(raw: unknown = "admission"): ReleaseControlPhase {
  if (
    raw !== "admission" &&
    raw !== "payload" &&
    raw !== "coordinator" &&
    raw !== "site-publication" &&
    raw !== "release-publication" &&
    raw !== "tuf-releases" &&
    raw !== "tuf-preview" &&
    raw !== "tuf-stable" &&
    raw !== "tuf-snapshot" &&
    raw !== "tuf-timestamp" &&
    raw !== "catalog-definitions" &&
    raw !== "catalog-policy" &&
    raw !== "catalog-snapshot" &&
    raw !== "catalog-timestamp"
  )
    throw new Error("only fixed admitted control phases are supported");
  return raw;
}
export function isMaintenanceReleaseControlPhase(
  raw: unknown,
): raw is MaintenanceReleaseControlPhase {
  return (
    raw === "site-publication" ||
    raw === "coordinator" ||
    raw === "tuf-releases" ||
    raw === "tuf-preview" ||
    raw === "tuf-stable" ||
    raw === "tuf-snapshot" ||
    raw === "tuf-timestamp" ||
    raw === "catalog-definitions" ||
    raw === "catalog-policy" ||
    raw === "catalog-snapshot" ||
    raw === "catalog-timestamp"
  );
}
export function releaseControlPhaseProfile(raw: unknown = "admission") {
  return phases[inspectReleaseControlPhase(raw)];
}
