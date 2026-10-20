/** Fixed roles under the one ratified controller, never caller-selected job names.
 * Reserving a phase does not implement or activate its future publisher job. */
export type ReleaseControlPhase =
  | "admission"
  | "payload"
  | "site-publication"
  | "release-publication";
const phases = Object.freeze({
  admission: Object.freeze({
    reader_job: "independent_admission",
    reader_name: "Authenticate release control inputs",
    reader_audience: "portcove-release-input-reader-v1",
    observer_job: "protection_observation",
    observer_name: "Observe production release input protections",
    observer_audience: "portcove-release-protection-v1",
  }),
  payload: Object.freeze({
    reader_job: "payload_signing",
    reader_name: "Sign admitted updater payloads",
    reader_audience: "portcove-payload-signing",
    observer_job: "payload_protection_observation",
    observer_name: "Observe payload signing input protections",
    observer_audience: "portcove-release-protection-payload-v1",
  }),
  "site-publication": Object.freeze({
    reader_job: "site_publication",
    reader_name: "Publish authenticated application site",
    reader_audience: "portcove-release-site-publication-reader-v1",
    observer_job: "site_protection_observation",
    observer_name: "Observe application site publication protections",
    observer_audience: "portcove-release-site-publication-protection-v1",
  }),
  "release-publication": Object.freeze({
    reader_job: "release_publication",
    reader_name: "Publish immutable application release",
    reader_audience: "portcove-release-publication-reader-v1",
    observer_job: "release_protection_observation",
    observer_name: "Observe immutable application release publication protections",
    observer_audience: "portcove-release-publication-protection-v1",
  }),
});
export function inspectReleaseControlPhase(raw: unknown = "admission"): ReleaseControlPhase {
  if (
    raw !== "admission" &&
    raw !== "payload" &&
    raw !== "site-publication" &&
    raw !== "release-publication"
  )
    throw new Error("only fixed admitted control phases are supported");
  return raw;
}
export function releaseControlPhaseProfile(raw: unknown = "admission") {
  return phases[inspectReleaseControlPhase(raw)];
}
