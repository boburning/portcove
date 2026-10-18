import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { AUDIT_STAGES } from "./audit.mts";
import { AUDIT_BUNDLE_LIMITS } from "./audit-evidence.mts";

const allowed = new Set([
  "manifest.json",
  "inputs.json",
  "audit.json",
  "binding.json",
  ...AUDIT_STAGES.filter((s) => s.reusable).map((s) => `receipts/${s.id}.json`),
]);
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Audit ZIP rejected: ${reason}`);
}

export function parseAuditArchive(
  archive: unknown,
  { inflate = inflateRawSync, clock = Date.now, deadline = Infinity } = {},
) {
  const active = () => check(clock() < deadline, "collection deadline");
  let inspected;
  try {
    inspected = inspectBoundedZip(
      archive,
      { ...AUDIT_BUNDLE_LIMITS, nameBytes: 128, allowedPaths: allowed },
      { clock, deadline },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ZIP rejected:"))
      throw new Error(`Audit ${error.message}`, { cause: error });
    throw error;
  }
  const { archive: verifiedArchive, entries } = inspected;
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    active();
    const compressed = verifiedArchive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflate(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
    check(bytes.length === entry.bytes, "actual expanded size");
    check(crc32(bytes) === entry.crc, "CRC mismatch");
    files.set(entry.name, bytes);
  }
  active();
  return files;
}
