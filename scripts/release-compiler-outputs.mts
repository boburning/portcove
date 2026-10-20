import { createHash } from "node:crypto";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface CompiledFileIdentity {
  bytes: number;
  sha256: string;
}
function identity(value: CompiledFileIdentity, maximum: number) {
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > maximum ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error("compiled/package identity exceeds the fixed byte/digest bounds");
}
function octal(bytes: Buffer) {
  const value = bytes.toString("ascii").replace(/[\0 ]+$/u, "");
  if (!/^[0-7]{1,12}$/u.test(value))
    throw new Error("CLI TAR uses unsupported binary/nonnumeric metadata");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("CLI TAR numeric metadata exceeds its bound");
  return number;
}

/** Fixed producer emits one normal portcove binary. Raw TAR structure is checked
 * without a semantic library that might preprocess PAX/GNU/link/sparse entries.
 * Gzip decoding is bounded by the independently captured binary size plus the
 * fixed GNU tar blocking overhead before any logical-entry interpretation. */
export function inspectCompiledCliPackage(
  archive: Buffer,
  platform: "windows-x86_64" | "linux-x86_64",
  expectedPackage: CompiledFileIdentity,
  expectedBinary: CompiledFileIdentity,
) {
  identity(expectedPackage, 512 * 1024 * 1024);
  identity(expectedBinary, 256 * 1024 * 1024);
  if (
    !Buffer.isBuffer(archive) ||
    archive.length !== expectedPackage.bytes ||
    hash(archive) !== expectedPackage.sha256
  )
    throw new Error("CLI package bytes differ from independently acquired identity");
  let binary: Buffer;
  if (platform === "windows-x86_64") {
    const { entries } = inspectBoundedZip(archive, {
      compressedBytes: 512 * 1024 * 1024,
      expandedBytes: 256 * 1024 * 1024,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set(["portcove.exe"]),
    });
    if (entries.length !== 1 || entries[0]!.bytes !== expectedBinary.bytes)
      throw new Error("CLI ZIP executable inventory differs");
    const entry = entries[0]!;
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    binary =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: expectedBinary.bytes });
    if (binary.length !== entry.bytes || crc32(binary) !== entry.crc)
      throw new Error("CLI ZIP executable length/CRC differs");
  } else if (platform === "linux-x86_64") {
    if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8)
      throw new Error("CLI package is not the fixed gzip route");
    const decoded = gunzipSync(archive, { maxOutputLength: expectedBinary.bytes + 16 * 1024 });
    if (decoded.length < 1536 || decoded.length % 512 !== 0)
      throw new Error("CLI TAR record boundaries differ");
    const header = decoded.subarray(0, 512);
    const type = header[156];
    // Refuse extension/link forms before reading their possibly huge size fields.
    if (type !== 0 && type !== 0x30)
      throw new Error("CLI TAR extensions, links and sparse entries are unsupported");
    if (
      !header.subarray(0, 100).equals(Buffer.concat([Buffer.from("portcove"), Buffer.alloc(92)])) ||
      header.subarray(157, 257).some((byte) => byte !== 0) ||
      header.subarray(345, 500).some((byte) => byte !== 0)
    )
      throw new Error("CLI TAR path/link/prefix inventory differs");
    const magic = header.subarray(257, 265);
    if (!magic.equals(Buffer.from("ustar\0" + "00")) && !magic.equals(Buffer.from("ustar  \0")))
      throw new Error("CLI TAR producer format differs");
    const checksum = octal(header.subarray(148, 156));
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (sum !== checksum) throw new Error("CLI TAR raw header checksum differs");
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    if (size !== expectedBinary.bytes || mode > 0o777 || (mode & 0o100) === 0)
      throw new Error("CLI TAR executable size/mode differs");
    const padded = Math.ceil(size / 512) * 512;
    const end = 512 + padded;
    if (
      decoded.length - end < 1024 ||
      decoded.length - end > 16 * 1024 ||
      decoded.subarray(512 + size).some((byte) => byte !== 0)
    )
      throw new Error("CLI TAR padding/end records contain unsupported extra content");
    binary = decoded.subarray(512, 512 + size);
  } else throw new Error("CLI package platform is outside the selected pair");
  if (binary.length !== expectedBinary.bytes || hash(binary) !== expectedBinary.sha256)
    throw new Error("CLI packaged executable differs from captured actual compiler output");
  return {
    package_sha256: expectedPackage.sha256,
    binary_sha256: expectedBinary.sha256,
    binary_bytes: binary.length,
    authority: "none",
    scope: "exact package member equality only; no compiler/producer/native acceptance",
  };
}
