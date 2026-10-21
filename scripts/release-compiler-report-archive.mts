/** Bounded data-only report ZIP decoding shared by hosted and local readers. */
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
export function readReleaseCompilerReportArchive(
  archive: Buffer,
  platform: "linux-x86_64" | "windows-x86_64",
  inter: "cli" | "desktop",
) {
  if (!["linux-x86_64", "windows-x86_64"].includes(platform) || !["cli", "desktop"].includes(inter))
    throw new Error("fixed compiler report slot required");
  const suffix = `${inter}-${platform}`;
  const names = [`compiler-observation-${suffix}.json`, `compiler-result-${suffix}.json`];
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 2 * 1024 * 1024,
    expandedBytes: 512 * 1024,
    files: 2,
    nameBytes: 128,
    allowedPaths: new Set(names),
  });
  if (entries.length !== 2)
    throw new Error("compiler report complete started/result inventory differs");
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("compiler report member length/CRC differs");
    files.set(entry.name, bytes);
  }
  return { files, initial: files.get(names[0]!)!, result: files.get(names[1]!)! };
}
