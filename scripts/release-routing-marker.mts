/** Atomic visibility for public job-local routing data only. Callers retain
 * ownership, size, deadline and authority checks. This is not a durable journal. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { open, link } from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";

export async function retainReleaseRoutingMarker(file: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const staging = `${file}.retained-${randomBytes(16).toString("hex")}`;
  const handle = await open(staging, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Never replace a published marker or unlink its retained staging alias:
  // unlinking would race a concurrent reader's inode/ctime stability check.
  await link(staging, file);
}

/** Single-link custody data, then an atomic completion hint. Readers must wait
 * for the hint and verify its exact local basename, byte/hash identity and data
 * custody. Incomplete data is retained, never overwritten or retried. This is
 * routing evidence, not a durable journal or a serialized execution capability. */
export async function retainCompletedReleaseRoutingRecord(
  file: string,
  value: unknown,
  maximum = 8192,
) {
  assert.ok(path.isAbsolute(file) && path.normalize(file) === file);
  assert.match(path.basename(file), /^[a-z][a-z0-9-]{0,127}\.json$/u);
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 65536);
  if (lstatSync(`${file}.complete.json`, { throwIfNoEntry: false }) !== undefined)
    throw Object.assign(new Error("Retain existing routing completion; no retry"), {
      code: "EEXIST",
    });
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length > 0 && bytes.length <= maximum);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const observed = await handle.stat();
    assert.ok(observed.isFile() && observed.nlink === 1 && observed.size === bytes.length);
  } finally {
    await handle.close();
  }
  await retainReleaseRoutingMarker(`${file}.complete.json`, {
    schema_version: 1,
    record: path.basename(file),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    authority: "none",
  });
}
