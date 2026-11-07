import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
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

function assertBundleBytes(
  bytes: Buffer,
  expected: ReturnType<typeof inspectSealedCheckSdkIdentity>,
) {
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error("sealed Check SDK bundle differs from installed custody");
}

/** Verify the appointed bytes under the caller's already protected controller. */
export async function verifySealedCheckSdkBundle(controller: string, identity: unknown) {
  const expected = inspectSealedCheckSdkIdentity(identity);
  const relative = path.join("scripts", sealedCheckSdkFilename);
  const bytes = await readBoundedPublicBuildInputFile(controller, relative, expected.bytes);
  assertBundleBytes(bytes, expected);
  return path.join(controller, relative);
}

/** The semantic broker's credential request interface is synchronous. */
export function verifyLinuxSealedCheckSdkBundle(controller: string, identity: unknown) {
  const expected = inspectSealedCheckSdkIdentity(identity);
  const uid = process.getuid?.();
  if (process.platform !== "linux" || !uid || !path.isAbsolute(controller))
    throw new Error("sealed Check SDK requires the ordinary Linux broker");
  const file = path.join(controller, "scripts", sealedCheckSdkFilename);
  for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
    const directory = lstatSync(cursor);
    if (!directory.isDirectory() || ![0, uid].includes(directory.uid) || directory.mode & 0o022)
      throw new Error("sealed Check SDK ancestry is linked, foreign-owned or writable");
    if (cursor === path.dirname(cursor)) break;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.mode & 0o077 ||
      before.nlink !== 1 ||
      before.size !== expected.bytes
    )
      throw new Error("sealed Check SDK file custody differs");
    const bytes = Buffer.alloc(expected.bytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = lstatSync(file);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error("sealed Check SDK file changed during verification");
    assertBundleBytes(bytes.subarray(0, length), expected);
    return file;
  } finally {
    closeSync(fd);
  }
}
