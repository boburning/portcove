import { inflateRawSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
// Read one bounded JSON member into memory; archive paths never become output paths.
export function readDiscoveryReport(zip: Buffer, digest?: string) {
  if (zip.length > 2 * 1024 * 1024 || zip.length < 22)
    throw new Error("Observer archive size invalid");
  const archive_sha256 = createHash("sha256").update(zip).digest("hex");
  if (digest && digest !== `sha256:${archive_sha256}`)
    throw new Error("Observer archive digest mismatch");
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0)
    throw new Error("Unsupported observer archive");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (
    zip.readUInt16LE(end + 8) !== count ||
    end + 22 + zip.readUInt16LE(end + 20) !== zip.length ||
    offset + zip.readUInt32LE(end + 12) !== end
  )
    throw new Error("Malformed observer archive extent");
  if (count < 1 || count > 16) throw new Error("Observer archive member cap exceeded");
  let report: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Malformed observer directory");
    const method = zip.readUInt16LE(offset + 10),
      compressed = zip.readUInt32LE(offset + 20),
      size = zip.readUInt32LE(offset + 24),
      nameLength = zip.readUInt16LE(offset + 28),
      extra = zip.readUInt16LE(offset + 30),
      comment = zip.readUInt16LE(offset + 32),
      local = zip.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extra + comment > end)
      throw new Error("Malformed observer member");
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/(^|\/)report\.json$/u.test(name)) {
      if (
        report ||
        size > 2 * 1024 * 1024 ||
        size === 0 ||
        local + 30 > offset ||
        zip.readUInt32LE(local) !== 0x04034b50 ||
        zip.readUInt16LE(local + 6) & 1
      )
        throw new Error("Invalid or duplicate observer report");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (
        zip.readUInt16LE(offset + 8) & 1 ||
        zip.readUInt16LE(local + 8) !== method ||
        zip.subarray(local + 30, local + 30 + zip.readUInt16LE(local + 26)).toString("utf8") !==
          name
      )
        throw new Error("Observer member metadata differs");
      if (start + compressed > offset) throw new Error("Observer payload exceeds archive bounds");
      const bytes = zip.subarray(start, start + compressed);
      report =
        method === 0
          ? Buffer.from(bytes)
          : method === 8
            ? inflateRawSync(bytes, { maxOutputLength: 2 * 1024 * 1024 })
            : undefined;
      if (!report || report.length !== size)
        throw new Error("Unsupported or malformed observer compression");
      if (crc32(report) !== zip.readUInt32LE(offset + 16))
        throw new Error("Observer report CRC mismatch");
    }
    offset += 46 + nameLength + extra + comment;
  }
  if (!report) throw new Error("Observer report missing");
  return { archive_sha256, report: JSON.parse(report.toString("utf8")) as unknown };
}
