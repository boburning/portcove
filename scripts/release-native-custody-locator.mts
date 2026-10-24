/** Dependency-free routing data for the pre-acquisition launcher. Parsing this
 * locator authenticates no checkpoint, native report or execution authority. */
import { isRecord } from "./runtime-values.mts";

export function inspectNativeCheckpointLocator(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "checkpoint,native_bundle_bytes,native_bundle_sha256" ||
    typeof raw.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.checkpoint) ||
    typeof raw.native_bundle_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.native_bundle_sha256) ||
    typeof raw.native_bundle_bytes !== "number" ||
    !Number.isSafeInteger(raw.native_bundle_bytes) ||
    raw.native_bundle_bytes < 1 ||
    raw.native_bundle_bytes > 1048576
  )
    throw new Error("exact native checkpoint custody locator required");
  return {
    checkpoint: raw.checkpoint,
    native_bundle_sha256: raw.native_bundle_sha256,
    native_bundle_bytes: raw.native_bundle_bytes,
  };
}

export function nativeCheckpointEvidenceId(raw: unknown) {
  const value = inspectNativeCheckpointLocator(raw);
  return `native-checkpoint:${value.checkpoint}:${value.native_bundle_sha256}:${value.native_bundle_bytes}`;
}
