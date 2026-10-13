import { crc32, inflateRawSync } from "node:zlib";
import { AUDIT_STAGES } from "./audit.mjs";
import { AUDIT_BUNDLE_LIMITS } from "./audit-evidence.mjs";

const allowed = new Set([
  "manifest.json",
  "inputs.json",
  "audit.json",
  "binding.json",
  ...AUDIT_STAGES.filter((s) => s.reusable).map((s) => `receipts/${s.id}.json`),
]);
function check(condition, reason) {
  if (!condition) throw new Error(`Audit ZIP rejected: ${reason}`);
}

export function parseAuditArchive(
  archive,
  { inflate = inflateRawSync, clock = Date.now, deadline = Infinity } = {},
) {
  const active = () => check(clock() < deadline, "collection deadline");
  active();
  check(
    Buffer.isBuffer(archive) &&
      archive.length >= 22 &&
      archive.length <= AUDIT_BUNDLE_LIMITS.compressedBytes,
    "compressed byte limit",
  );
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--)
    if (
      archive.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + archive.readUInt16LE(i + 20) === archive.length
    ) {
      end = i;
      break;
    }
  check(end >= 0, "missing terminal directory");
  const count = archive.readUInt16LE(end + 10),
    size = archive.readUInt32LE(end + 12),
    start = archive.readUInt32LE(end + 16);
  check(
    archive.readUInt16LE(end + 4) === 0 &&
      archive.readUInt16LE(end + 6) === 0 &&
      archive.readUInt16LE(end + 8) === count,
    "multipart unsupported",
  );
  check(
    count > 0 &&
      count <= AUDIT_BUNDLE_LIMITS.files &&
      start + size === end &&
      size <= 65536 &&
      archive.readUInt16LE(end + 20) <= 1024,
    "directory limits or ZIP64",
  );
  let cursor = start,
    expanded = 0,
    metadata = size + 22,
    names = new Set();
  const entries = [];
  const extra = (offset, length) => {
    check(length <= 1024 && offset + length <= archive.length, "extra field limit");
    metadata += length;
    check(metadata <= 65536, "metadata byte limit");
    const limit = offset + length;
    while (offset < limit) {
      check(offset + 4 <= limit, "truncated extra field");
      const kind = archive.readUInt16LE(offset),
        bytes = archive.readUInt16LE(offset + 2);
      offset += 4;
      check(
        [0x5455, 0x000a].includes(kind) && offset + bytes <= limit,
        "unsupported extension or ZIP64",
      );
      offset += bytes;
    }
  };
  for (let index = 0; index < count; index++) {
    active();
    check(cursor + 46 <= end && archive.readUInt32LE(cursor) === 0x02014b50, "central header");
    const version = archive.readUInt16LE(cursor + 6),
      flags = archive.readUInt16LE(cursor + 8),
      method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16),
      compressed = archive.readUInt32LE(cursor + 20),
      bytes = archive.readUInt32LE(cursor + 24);
    const nameSize = archive.readUInt16LE(cursor + 28),
      extraSize = archive.readUInt16LE(cursor + 30),
      commentSize = archive.readUInt16LE(cursor + 32);
    const attributes = archive.readUInt32LE(cursor + 38),
      local = archive.readUInt32LE(cursor + 42);
    check(
      version <= 20 &&
        (flags & ~0x808) === 0 &&
        [0, 8].includes(method) &&
        archive.readUInt16LE(cursor + 34) === 0,
      "method, encryption, disk or ZIP64",
    );
    check(
      nameSize > 0 &&
        nameSize <= 128 &&
        commentSize <= 1024 &&
        cursor + 46 + nameSize + extraSize + commentSize <= end,
      "name or metadata limit",
    );
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameSize),
      name = nameBytes.toString("utf8");
    check(
      allowed.has(name) && Buffer.from(name).equals(nameBytes) && !names.has(name),
      "path or collision",
    );
    names.add(name);
    const kind = (attributes >>> 16) & 0xf000;
    check((kind === 0 || kind === 0x8000) && (attributes & 0x10) === 0, "nonregular entry");
    expanded += bytes;
    check(
      expanded <= AUDIT_BUNDLE_LIMITS.expandedBytes && compressed <= archive.length,
      "declared byte limit",
    );
    extra(cursor + 46 + nameSize, extraSize);
    check(local + 30 <= start && archive.readUInt32LE(local) === 0x04034b50, "local header offset");
    const localName = archive.readUInt16LE(local + 26),
      localExtra = archive.readUInt16LE(local + 28);
    check(
      archive.readUInt16LE(local + 4) <= 20 &&
        archive.readUInt16LE(local + 6) === flags &&
        archive.readUInt16LE(local + 8) === method &&
        localName === nameSize &&
        local + 30 + localName + localExtra <= start &&
        archive.subarray(local + 30, local + 30 + localName).equals(nameBytes),
      "local header mismatch",
    );
    extra(local + 30 + localName, localExtra);
    const data = local + 30 + localName + localExtra,
      dataEnd = data + compressed;
    let localEnd = dataEnd;
    check(dataEnd <= start, "truncated payload");
    if (flags & 8) {
      check(dataEnd + 12 <= start, "missing data descriptor");
      const descriptor = dataEnd + (archive.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      check(
        descriptor + 12 <= start &&
          archive.readUInt32LE(descriptor) === crc &&
          archive.readUInt32LE(descriptor + 4) === compressed &&
          archive.readUInt32LE(descriptor + 8) === bytes,
        "data descriptor mismatch",
      );
      localEnd = descriptor + 12;
      check(
        [0, crc].includes(archive.readUInt32LE(local + 14)) &&
          [0, compressed].includes(archive.readUInt32LE(local + 18)) &&
          [0, bytes].includes(archive.readUInt32LE(local + 22)),
        "local descriptor header mismatch",
      );
    } else
      check(
        archive.readUInt32LE(local + 14) === crc &&
          archive.readUInt32LE(local + 18) === compressed &&
          archive.readUInt32LE(local + 22) === bytes,
        "local sizes mismatch",
      );
    entries.push({ name, local, localEnd, data, dataEnd, method, bytes, crc });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  check(cursor === end, "central inventory mismatch");
  let boundary = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    check(entry.local === boundary, "overlap or unlisted record");
    boundary = entry.localEnd;
  }
  check(boundary === start, "unlisted payload");
  const files = new Map();
  for (const entry of entries) {
    active();
    const compressed = archive.subarray(entry.data, entry.dataEnd);
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
