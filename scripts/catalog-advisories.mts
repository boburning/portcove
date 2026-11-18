import { isRecord } from "./runtime-values.mts";

const features = new Set([
  "setup",
  "original-files",
  "launch",
  "updates",
  "settings",
  "backup",
  "restore",
  "previous-version",
  "gameplay",
  "controls",
  "audio",
  "performance",
  "save-compatibility",
]);
const fields = new Set([
  "id",
  "feature",
  "platform",
  "route",
  "release",
  "artifact_sha256",
  "edition",
  "explanation",
  "provenance",
  "observed_at",
  "evidence",
  "workaround",
  "launch_behavior",
]);
function text(v: unknown, max: number): v is string {
  if (typeof v !== "string" || !v || v.trim() !== v || Buffer.byteLength(v) > max) return false;
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const launchBehaviors = [
  "starts-game-directly",
  "opens-project-launcher",
  "asks-for-game-files",
  "unknown",
];
const descriptive = (v: unknown) =>
  text(v, 2048) && !/`|\$\(|(?:[a-z]:\\|\/(?:home|Users)\/)/iu.test(v);

/** Authoring is strict; runtime treats malformed/future optional advice as unavailable. */
export function checkCatalogAdvisories(
  value: unknown,
  platforms: readonly string[],
  now = Math.floor(Date.now() / 1000),
): void {
  if (
    !isRecord(value) ||
    (value.format_version !== 1 && value.format_version !== 2) ||
    Object.keys(value).some((k) => !["format_version", "records"].includes(k)) ||
    !Array.isArray(value.records) ||
    value.records.length > 64 ||
    Buffer.byteLength(JSON.stringify(value)) > 65536
  )
    throw new Error("Compatibility advisories require a bounded supported envelope.");
  if (
    value.format_version === 2 &&
    !value.records.some((r) => isRecord(r) && r.launch_behavior != null)
  )
    throw new Error("Compatibility format 2 requires a launch behavior record.");
  const ids = new Set<string>();
  for (const r of value.records) {
    if (
      !isRecord(r) ||
      Object.keys(r).some((k) => !fields.has(k)) ||
      !text(r.id, 128) ||
      !/^[a-z0-9_-]+$/iu.test(r.id) ||
      ids.has(r.id) ||
      typeof r.feature !== "string" ||
      !features.has(r.feature) ||
      typeof r.platform !== "string" ||
      !platforms.includes(r.platform) ||
      typeof r.route !== "string" ||
      (!["managed", "accepted-external", "existing-copy", "user-selected"].includes(r.route) &&
        !(r.route === "upstream-setup" && r.launch_behavior != null)) ||
      typeof r.evidence !== "string" ||
      !["observed", "upstream-reported", "manual-requirement"].includes(r.evidence) ||
      !descriptive(r.explanation) ||
      !Number.isSafeInteger(r.observed_at) ||
      Number(r.observed_at) <= 0 ||
      Number(r.observed_at) > now
    )
      throw new Error("Invalid scoped compatibility advisory.");
    ids.add(r.id);
    for (const key of ["release", "edition"] as const)
      if (r[key] != null && !text(r[key], 256)) throw new Error(`Invalid advisory ${key}.`);
    if (r.workaround != null && !descriptive(r.workaround))
      throw new Error(
        "Advisory workaround must be descriptive, without executable commands or private paths.",
      );
    if (
      r.artifact_sha256 != null &&
      (typeof r.artifact_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/iu.test(r.artifact_sha256) ||
        !r.release)
    )
      throw new Error("Artifact advisories require a release and SHA-256.");
    if (Object.hasOwn(r, "launch_behavior")) {
      const launch = r.launch_behavior;
      if (
        value.format_version !== 2 ||
        r.feature !== "launch" ||
        !r.release ||
        !r.artifact_sha256 ||
        !["observed", "upstream-reported"].includes(r.evidence) ||
        !isRecord(launch) ||
        Object.keys(launch).length !== 2 ||
        typeof launch.first_launch !== "string" ||
        !launchBehaviors.includes(launch.first_launch) ||
        typeof launch.repeat_launch !== "string" ||
        !launchBehaviors.includes(launch.repeat_launch)
      )
        throw new Error(
          "Launch behavior requires an exact release, artifact and both launch stages.",
        );
    }
    if (!text(r.provenance, 2048)) throw new Error("Advisory provenance is required.");
    const url = new URL(r.provenance);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search)
      throw new Error("Advisory provenance requires a public credential-free HTTPS reference.");
  }
}
