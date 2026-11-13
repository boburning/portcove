/** Lossless inert source-checkpoint storage, never observation authority. */
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { isRecord, errorCode } from "./runtime-values.mts";

export const observerSourceCheckpointLimit = 32 * 1024 * 1024;
const format = "portcove-source-checkpoint-gzip-v1";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function requireStorage(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Observer checkpoint storage: ${message}`);
}

/** Callers still validate the decoded source/configuration schema. No recursive
 * decoding: a wrapper can contain only the original format-1 source document. */
export function decodeStoredObserverCheckpoint(
  value: unknown,
  deadline = Infinity,
  now = Date.now,
): unknown {
  if (!isRecord(value) || value.format !== format) return value;
  requireStorage(now() < deadline, "decode deadline exhausted");
  requireStorage(
    Object.keys(value).sort().join(",") === "expanded_bytes,format,payload,sha256" &&
      Buffer.byteLength(JSON.stringify(value)) <= observerSourceCheckpointLimit &&
      Number.isSafeInteger(value.expanded_bytes) &&
      Number(value.expanded_bytes) > 0 &&
      Number(value.expanded_bytes) <= observerSourceCheckpointLimit &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.sha256) &&
      typeof value.payload === "string",
    "encoded source fields invalid",
  );
  const compressed = Buffer.from(value.payload, "base64");
  requireStorage(compressed.toString("base64") === value.payload, "source base64 is not canonical");
  const bytes = gunzipSync(compressed, { maxOutputLength: Number(value.expanded_bytes) });
  requireStorage(
    now() < deadline && bytes.length === value.expanded_bytes && digest(bytes) === value.sha256,
    "decoded source integrity differs",
  );
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  requireStorage(isRecord(decoded) && decoded.format === 1, "decoded source is not format one");
  return decoded;
}

/** Preserve the old raw per-file ceiling. Compression cannot admit a source the
 * normal reader would reject. Incompressible small inputs retain their raw form. */
export function encodeStoredObserverCheckpoint(
  value: unknown,
  deadline = Infinity,
  now = Date.now,
): unknown {
  requireStorage(now() < deadline, "encode deadline exhausted");
  requireStorage(isRecord(value) && value.format === 1, "source is not format one");
  const bytes = Buffer.from(JSON.stringify(value));
  requireStorage(bytes.length <= observerSourceCheckpointLimit, "raw source exceeds read envelope");
  let compressed: Buffer;
  try {
    compressed = gzipSync(bytes, { level: 9, maxOutputLength: observerSourceCheckpointLimit });
  } catch (error) {
    if (errorCode(error) !== "ERR_BUFFER_TOO_LARGE") throw error;
    return value;
  }
  const stored = {
    format,
    expanded_bytes: bytes.length,
    sha256: digest(bytes),
    payload: compressed.toString("base64"),
  };
  requireStorage(now() < deadline, "encode deadline exhausted");
  return Buffer.byteLength(JSON.stringify(stored)) < bytes.length ? stored : value;
}

/** Never steal an interrupted coordinator's lock; preserve its checkpoint for recovery. */
export async function withCheckpointLock<T>(
  statePath: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const lockPath = await assertOwnedUnlinkedPath(
    fileURLToPath(new URL("../work", import.meta.url)),
    `${statePath}.lock`,
    "observer coordinator lock",
  );
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
    );
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath);
  }
}
