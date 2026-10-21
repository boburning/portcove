import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
} from "./release-package-policy.mts";
import {
  inspectReleaseProducer,
  parseReleaseChecksumManifest,
} from "./reconcile-release-assets.mts";

function retainArchive(rawArchive: unknown, archiveIdentity: unknown) {
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
  const archive = Buffer.from(rawArchive);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== archiveIdentity.sha256) throw new Error("release artifact archive digest differs");
  return { archive, sha256 };
}

/** Acquire file facts from provider-authenticated opaque bytes using the same
 * maintained ZIP, checksum and producer-declaration contracts. These facts do
 * not accept the producer, executed workflow, package safety or publication. */
export async function discoverReleaseArtifactFiles(
  rawArchive: unknown,
  archiveIdentity: unknown,
  platform: string,
  expected: { version: string; run_id: string; run_attempt: number; source_commit: string },
  options: {
    retainCliPackage?: (
      identity: { platform_label: string; filename: string; bytes: number; sha256: string },
      bytes: Buffer,
    ) => Promise<void>;
    /** Inert NSIS/AppImage bytes only, after complete matrix/checksum/producer
     * validation. Retention supplies no package execution or native authority. */
    retainDesktopPackage?: (
      identity: { platform_label: string; filename: string; bytes: number; sha256: string },
      bytes: Buffer,
    ) => Promise<void>;
  } = {},
) {
  const deadline = performance.now() + 10 * 60 * 1000;
  const retained = retainArchive(rawArchive, archiveIdentity);
  expected = structuredClone(expected);
  const policy = await loadPackagePolicy(fileURLToPath(new URL("..", import.meta.url)));
  if (!releaseLabels(policy).some((label) => label === platform))
    throw new Error("unknown release artifact platform");
  const packages = packagesForPlatform(policy, platform).map((entry) =>
    artifactName(entry, expected.version),
  );
  const updaterPackages = new Set(
    packagesForPlatform(policy, platform)
      .filter(
        (entry) =>
          entry.interface === "desktop" && (entry.format === "nsis" || entry.format === "appimage"),
      )
      .map((entry) => artifactName(entry, expected.version)),
  );
  const checksum = `SHA256SUMS-${platform}.txt`;
  const producer = `release-producer-${platform}.json`;
  const names = [...packages, checksum, producer];
  const normalize = (name: string) =>
    name.startsWith("release-upload/") ? name.slice("release-upload/".length) : name;
  const { archive, entries } = inspectBoundedZip(
    retained.archive,
    {
      compressedBytes: 512 * 1024 * 1024,
      expandedBytes: 2 * 1024 * 1024 * 1024,
      files: names.length,
      nameBytes: 256,
      allowedPaths: new Set(names.flatMap((name) => [name, `release-upload/${name}`])),
    },
    { clock: performance.now.bind(performance), deadline },
  );
  if (
    entries.length !== names.length ||
    new Set(entries.map((e) => normalize(e.name))).size !== names.length
  )
    throw new Error("release artifact inventory is missing, duplicated or aliases layouts");
  for (const entry of entries) {
    const name = normalize(entry.name);
    const maximum = packages.includes(name) ? 512 * 1024 * 1024 : 64 * 1024;
    if (!names.includes(name) || entry.bytes < 1 || entry.bytes > maximum)
      throw new Error("release discovery member exceeds fixed policy bounds");
  }
  const metadata = new Map<string, string>();
  const files: { platform_label: string; filename: string; bytes: number; sha256: string }[] = [];
  const cliMembers = new Map<string, Buffer>();
  const desktopMembers = new Map<string, Buffer>();
  for (const entry of entries) {
    if (performance.now() >= deadline) throw new Error("release discovery deadline exhausted");
    const filename = normalize(entry.name);
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("release discovery size or CRC differs");
    files.push({
      platform_label: platform,
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (!packages.includes(filename)) {
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) throw new Error("release metadata is not UTF-8");
      metadata.set(filename, text);
    }
    if (
      options.retainCliPackage &&
      filename.startsWith("portcove-cli-") &&
      packages.includes(filename)
    ) {
      if (bytes.length > 128 * 1024 * 1024)
        throw new Error("CLI proof member exceeds fixed retained bound");
      cliMembers.set(filename, bytes);
    }
    if (options.retainDesktopPackage && updaterPackages.has(filename))
      desktopMembers.set(filename, bytes);
  }
  const manifest = parseReleaseChecksumManifest(metadata.get(checksum)!, platform);
  if (
    manifest.length !== packages.length ||
    manifest.some(
      (entry) =>
        !packages.includes(entry.name) ||
        files.find((file) => file.filename === entry.name)?.sha256 !== entry.sha256,
    )
  )
    throw new Error("release discovery checksum inventory differs from actual package bytes");
  const declared = inspectReleaseProducer(
    JSON.parse(metadata.get(producer)!),
    platform,
    expected.version,
    { runId: expected.run_id, revision: expected.source_commit, maxAttempt: expected.run_attempt },
  );
  if (declared.run_attempt !== expected.run_attempt)
    throw new Error("release discovery producer attempt differs from artifact identity");
  for (const [filename, bytes] of cliMembers)
    await options.retainCliPackage!(
      files.find((file) => file.filename === filename)!,
      bytes,
    );
  for (const [filename, bytes] of desktopMembers)
    await options.retainDesktopPackage!(
      structuredClone(files.find((file) => file.filename === filename)!),
      bytes,
    );
  return {
    files,
    declared_producer: {
      schema_version: declared.schema_version,
      platform_label: declared.platform_label,
      version: declared.version,
      run_id: declared.run_id,
      run_attempt: declared.run_attempt,
      revision: declared.revision,
    },
    archive_sha256: retained.sha256,
    authority: "none" as const,
  };
}

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
  options: { exactProducerAttempt?: boolean } = {},
) {
  const started = performance.now();
  const exactProducerAttempt = options.exactProducerAttempt === true;
  // Take exclusive custody before the first asynchronous operation. Copying a
  // shared or externally mutable buffer must reproduce the accepted digest.
  const { archive: retainedArchive, sha256: archiveSha256 } = retainArchive(
    rawArchive,
    archiveIdentity,
  );
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
      if (exactProducerAttempt && filename === `release-producer-${platform}.json`) {
        const declared = inspectReleaseProducer(
          JSON.parse(bytes.toString("utf8")),
          platform,
          accepted.version,
          {
            runId: accepted.run_id,
            revision: accepted.source_commit,
            maxAttempt: accepted.run_attempt,
          },
        );
        if (declared.run_attempt !== accepted.run_attempt)
          throw new Error("release artifact producer attempt differs from artifact identity");
      }
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
