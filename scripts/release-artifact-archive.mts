import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

/** Stage one bounded artifact into a new platform directory under a private,
 * caller-owned root. The caller authenticates the expected input facts and
 * opaque archive identity before this operation. No network/code execution,
 * signer authority, publication or producer attribution is established here.
 */
export async function stageReleaseArtifact(
  privateRoot: string,
  rawArchive: unknown,
  rawRequest: unknown,
  platform: string,
  archiveIdentity: unknown,
) {
  const started = performance.now();
  if (
    !Buffer.isBuffer(rawArchive) ||
    !isRecord(archiveIdentity) ||
    Object.keys(archiveIdentity).sort().join(",") !== "bytes,sha256" ||
    typeof archiveIdentity.bytes !== "number" ||
    !Number.isSafeInteger(archiveIdentity.bytes) ||
    archiveIdentity.bytes < 22 ||
    archiveIdentity.bytes > 512 * 1024 * 1024 ||
    rawArchive.length !== archiveIdentity.bytes ||
    typeof archiveIdentity.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(archiveIdentity.sha256)
  )
    throw new Error("release artifact requires bounded independently expected archive bytes");
  // Take exclusive custody before the first asynchronous operation. Copying a
  // shared or externally mutable buffer must reproduce the accepted digest.
  const retainedArchive = Buffer.from(rawArchive);
  const archiveSha256 = createHash("sha256").update(retainedArchive).digest("hex");
  if (archiveSha256 !== archiveIdentity.sha256)
    throw new Error("release artifact archive digest differs");
  const deadline = started + 10 * 60 * 1000;
  const active = () => {
    if (performance.now() >= deadline)
      throw new Error("release artifact staging deadline exhausted");
  };
  const { accepted, labels } = await inspectTrustedAssemblyInput(rawRequest);
  if (!labels.some((label) => label === platform))
    throw new Error("unknown release artifact platform");
  const expected = accepted.files.filter((file) => file.platform_label === platform);
  const allowedPaths = new Set(
    expected.flatMap((file) => [file.filename, `release-upload/${file.filename}`]),
  );
  const { archive, entries } = inspectBoundedZip(
    retainedArchive,
    {
      compressedBytes: 512 * 1024 * 1024,
      expandedBytes: expected.reduce((bytes, file) => bytes + file.bytes, 0),
      files: expected.length,
      nameBytes: 256,
      allowedPaths,
    },
    { clock: performance.now.bind(performance), deadline },
  );
  // Validate the complete semantic inventory BEFORE creating any output or
  // invoking inflation. The two supported layouts cannot alias one filename.
  const normalize = (name: string) =>
    name.startsWith("release-upload/") ? name.slice("release-upload/".length) : name;
  const names = new Set(entries.map((entry) => normalize(entry.name)));
  if (entries.length !== expected.length || names.size !== expected.length)
    throw new Error("release artifact inventory is missing, duplicated or aliases layouts");
  for (const entry of entries) {
    const file = expected.find((file) => file.filename === normalize(entry.name));
    if (!file || entry.bytes !== file.bytes)
      throw new Error("release artifact declared bytes differ from accepted inputs");
  }
  active();
  const directory = await assertOwnedUnlinkedPath(
    path.resolve(privateRoot),
    path.join(path.resolve(privateRoot), `release-build-${platform}`),
    "release artifact stage",
  );
  // EEXIST is a refusal; this operation never replaces a previous stage.
  await mkdir(directory);
  try {
    const files = [];
    for (const entry of entries) {
      active();
      const filename = normalize(entry.name);
      const expectedFile = expected.find((file) => file.filename === filename)!;
      const compressed = archive.subarray(entry.data, entry.dataEnd);
      // Inflation is bounded by the already accepted per-file length, not an
      // attacker-selected declaration. Keep only one inflated file in memory.
      const bytes =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: expectedFile.bytes });
      if (
        bytes.length !== expectedFile.bytes ||
        crc32(bytes) !== entry.crc ||
        createHash("sha256").update(bytes).digest("hex") !== expectedFile.sha256
      )
        throw new Error("release artifact bytes or CRC differ from accepted input");
      active();
      await writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
      active();
      files.push({ filename, bytes: bytes.length, sha256: expectedFile.sha256 });
    }
    return {
      directory,
      platform,
      files,
      archive_sha256: archiveSha256,
      authority: "none" as const,
    };
  } catch (cause) {
    throw new Error(`release artifact staging refused; retain owned directory ${directory}`, {
      cause,
    });
  }
}
