import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");

/** Mirrors Tauri's fixed NSIS bundle-type slot in memory only. It neither
 * modifies a payload nor proves that an installer contains these bytes. */
export function projectWindowsNsisExecutable(bytes: Buffer) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024 * 1024);
  const offset = bytes.indexOf(marker);
  assert.ok(
    offset >= 0 && bytes.indexOf(marker, offset + 1) === -1,
    "Desktop compiler output must contain exactly one fixed unbundled Tauri slot",
  );
  const projected = Buffer.from(bytes);
  projected.write("NSS", offset + marker.length - 3, "ascii");
  return Object.freeze({
    filename: "portcove-desktop.exe" as const,
    bytes: bytes.length,
    sha256: hash(bytes),
    nsis_sha256: hash(projected),
    bundle_slot_offset: offset,
  });
}

/** Integrity interpretation only; actual report provenance belongs to the
 * existing compiler attestation/provider/retained-byte consumer. */
export function inspectWindowsDesktopCompilerIdentity(raw: unknown) {
  assert.ok(isRecord(raw));
  assert.deepEqual(Object.keys(raw).sort(), [
    "bundle_slot_offset",
    "bytes",
    "filename",
    "nsis_sha256",
    "sha256",
  ]);
  assert.equal(raw.filename, "portcove-desktop.exe");
  assert.ok(
    typeof raw.bytes === "number" &&
      Number.isSafeInteger(raw.bytes) &&
      raw.bytes >= marker.length &&
      raw.bytes <= 256 * 1024 * 1024,
  );
  assert.ok(
    typeof raw.bundle_slot_offset === "number" &&
      Number.isSafeInteger(raw.bundle_slot_offset) &&
      raw.bundle_slot_offset >= 0 &&
      raw.bundle_slot_offset <= raw.bytes - marker.length,
  );
  assert.ok(typeof raw.sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.sha256));
  assert.ok(typeof raw.nsis_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.nsis_sha256));
  assert.notEqual(raw.sha256, raw.nsis_sha256);
  return Object.freeze({
    filename: "portcove-desktop.exe" as const,
    bytes: raw.bytes,
    sha256: raw.sha256,
    nsis_sha256: raw.nsis_sha256,
    bundle_slot_offset: raw.bundle_slot_offset,
  });
}
