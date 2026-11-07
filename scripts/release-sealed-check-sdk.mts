import { createHash } from "node:crypto";
import path from "node:path";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord } from "./runtime-values.mts";

export const sealedCheckSdkFilename = "release-semantic-issuer-sdk-http.bundle.mjs";
export const sealedCheckSdkMaximumBytes = 2 * 1024 * 1024;

export function inspectSealedCheckSdkIdentity(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "bytes,sha256" ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > sealedCheckSdkMaximumBytes ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error("sealed Check SDK identity differs");
  return { bytes: value.bytes, sha256: value.sha256 };
}

/** Verify the appointed bytes under the caller's already protected controller. */
export async function verifySealedCheckSdkBundle(controller: string, identity: unknown) {
  const expected = inspectSealedCheckSdkIdentity(identity);
  const relative = path.join("scripts", sealedCheckSdkFilename);
  const bytes = await readBoundedPublicBuildInputFile(controller, relative, expected.bytes);
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error("sealed Check SDK bundle differs from installed custody");
  return path.join(controller, relative);
}
