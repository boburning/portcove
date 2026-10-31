/** Closed public input identities and profile-bound artifact contract only. */
import { isRecord } from "./runtime-values.mts";
import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
export const maximumArchiveBytes = 1024 * 1024;

export function inspectPublicBuildInputIdentity(revision: unknown, digest: unknown) {
  if (
    typeof revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error("ratified public configuration commit and manifest SHA-256 are required");
  return { revision, digest };
}

export function inspectPublicBuildConfiguration(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      (Object.hasOwn(raw, "release_profile")
        ? "configuration_revision,manifest_sha256,release_profile"
        : "configuration_revision,manifest_sha256") ||
    (Object.hasOwn(raw, "release_profile") &&
      raw.release_profile !== "initial-beta-windows-x86_64-v1")
  )
    throw new Error("public build configuration requires independent exact identities");
  inspectPublicBuildInputIdentity(raw.configuration_revision, raw.manifest_sha256);
  return {
    ...(raw.release_profile === undefined
      ? {}
      : { release_profile: "initial-beta-windows-x86_64-v1" as const }),
    configuration_revision: String(raw.configuration_revision),
    manifest_sha256: String(raw.manifest_sha256),
  };
}

export function inspectPublicBuildInputBinding(raw: unknown, expectedProfile?: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      (Object.hasOwn(raw, "release_profile")
        ? "artifacts,configuration_revision,manifest_sha256,release_profile"
        : "artifacts,configuration_revision,manifest_sha256")
  )
    throw new Error("public build input binding schema differs");
  const configuration = inspectPublicBuildConfiguration({
    ...(Object.hasOwn(raw, "release_profile") ? { release_profile: raw.release_profile } : {}),
    configuration_revision: raw.configuration_revision,
    manifest_sha256: raw.manifest_sha256,
  });
  if (
    expectedProfile !== undefined &&
    (configuration.release_profile ?? "initial-beta-win-linux") !== expectedProfile
  )
    throw new Error("public build input profile differs from selected assembly");
  const labels: readonly string[] = nativePlatformsForReleaseProfile(
    configuration.release_profile ?? "initial-beta-win-linux",
  );
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== labels.length)
    throw new Error("public build inputs require the complete selected platform matrix");
  const artifacts = raw.artifacts
    .map((item) => {
      if (
        !isRecord(item) ||
        Object.keys(item).sort().join(",") !== "artifact_id,bytes,platform,sha256" ||
        typeof item.platform !== "string" ||
        !labels.includes(item.platform) ||
        typeof item.artifact_id !== "number" ||
        !Number.isSafeInteger(item.artifact_id) ||
        item.artifact_id < 1 ||
        typeof item.bytes !== "number" ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 22 ||
        item.bytes > maximumArchiveBytes ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256)
      )
        throw new Error("public build artifact identity exceeds its bounds");
      return {
        platform: item.platform,
        artifact_id: item.artifact_id,
        bytes: item.bytes,
        sha256: item.sha256,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
  if (
    new Set(artifacts.map((item) => item.platform)).size !== labels.length ||
    new Set(artifacts.map((item) => item.artifact_id)).size !== labels.length
  )
    throw new Error("public build artifact matrix is duplicated");
  return { ...configuration, artifacts };
}
