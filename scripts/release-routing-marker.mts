/** Atomic visibility for public job-local routing data only. Callers retain
 * ownership, size, deadline and authority checks. This is not a durable journal. */
import { randomBytes } from "node:crypto";
import { open, link } from "node:fs/promises";

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
