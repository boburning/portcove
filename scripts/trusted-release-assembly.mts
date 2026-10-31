import { isInitialBetaReleaseProfile } from "./release-package-policy.mts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
  inspectReleaseProfile,
  selectReleasePackagePolicy,
} from "./release-package-policy.mts";
import { reconcileReleaseAssets } from "./reconcile-release-assets.mts";
import { inspectPublicBuildInputBinding } from "./release-public-build-provenance.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

const trustedProject = fileURLToPath(new URL("..", import.meta.url));
const maximumFileBytes = 512 * 1024 * 1024;
const maximumTotalBytes = 2 * 1024 * 1024 * 1024;
const maximumMetadataBytes = 64 * 1024;
const maximumMilliseconds = 10 * 60 * 1000;

interface InputFile {
  platform_label: string;
  filename: string;
  bytes: number;
  sha256: string;
}

function hex(value: unknown, length: number): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("assembly requires exact input identities");
}

function request(raw: unknown) {
  if (
    !isRecord(raw) ||
    !(
      (raw.schema_version === 1 &&
        Object.keys(raw).sort().join(",") ===
          "files,run_attempt,run_id,schema_version,source_commit,source_tree,version") ||
      (raw.schema_version === 2 &&
        Object.keys(raw).sort().join(",") ===
          "files,release_profile,run_attempt,run_id,schema_version,source_commit,source_tree,version") ||
      (raw.schema_version === 3 &&
        isInitialBetaReleaseProfile(raw.release_profile) &&
        Object.keys(raw).sort().join(",") ===
          "files,public_build_inputs,release_profile,run_attempt,run_id,schema_version,source_commit,source_tree,version")
    ) ||
    typeof raw.version !== "string" ||
    raw.version.length > 128 ||
    typeof raw.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.run_id) ||
    typeof raw.run_attempt !== "number" ||
    !Number.isSafeInteger(raw.run_attempt) ||
    raw.run_attempt < 1 ||
    !Array.isArray(raw.files) ||
    raw.files.length < 1 ||
    raw.files.length > 64
  )
    throw new Error("assembly input schema or count exceeds its bound");
  if (raw.release_profile === "initial-beta-windows-x86_64-v1" && raw.schema_version !== 3)
    throw new Error("Windows initial beta requires independently bound public build inputs");
  hex(raw.source_commit, 40);
  hex(raw.source_tree, 40);
  const files: InputFile[] = [];
  let total = 0;
  for (const file of raw.files) {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,filename,platform_label,sha256" ||
      typeof file.platform_label !== "string" ||
      file.platform_label.length > 32 ||
      typeof file.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file.filename) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > maximumFileBytes
    )
      throw new Error("assembly file identity or bytes exceed their bound");
    hex(file.sha256, 64);
    total += file.bytes;
    if (total > maximumTotalBytes) throw new Error("assembly total input bytes exceed their bound");
    files.push({
      platform_label: file.platform_label,
      filename: file.filename,
      bytes: file.bytes,
      sha256: file.sha256,
    });
  }
  if (
    new Set(files.map((file) => `${file.platform_label}/${file.filename.toLowerCase()}`)).size !==
    files.length
  )
    throw new Error("duplicate assembly input identity");
  return {
    schema_version:
      raw.schema_version === 3
        ? (3 as const)
        : raw.schema_version === 2
          ? (2 as const)
          : (1 as const),
    ...(raw.schema_version === 3
      ? { public_build_inputs: inspectPublicBuildInputBinding(raw.public_build_inputs) }
      : {}),
    ...(raw.schema_version === 2 || raw.schema_version === 3
      ? { release_profile: inspectReleaseProfile(raw.release_profile) }
      : {}),
    version: raw.version,
    source_commit: raw.source_commit,
    source_tree: raw.source_tree,
    run_id: raw.run_id,
    run_attempt: raw.run_attempt,
    files,
  };
}

async function copyVerified(
  source: string,
  destination: string,
  expected: InputFile,
  withinBound: () => void,
) {
  const leaf = await lstat(source);
  if (!leaf.isFile() || leaf.nlink !== 1 || leaf.size !== expected.bytes)
    throw new Error("assembly input must be one regular unlinked exact-size file");
  const input = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size !== expected.bytes || before.nlink !== 1)
      throw new Error("assembly input must be one regular unlinked exact-size file");
    const output = await open(destination, "wx");
    try {
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (bytes <= expected.bytes) {
        withinBound();
        const result = await input.read(
          buffer,
          0,
          Math.min(buffer.length, expected.bytes - bytes + 1),
          null,
        );
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > expected.bytes) throw new Error("assembly input grew during copy");
        const chunk = buffer.subarray(0, result.bytesRead);
        digest.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          withinBound();
          const result = await output.write(chunk, written, chunk.length - written, null);
          if (!result.bytesWritten) throw new Error("assembly output write made no progress");
          written += result.bytesWritten;
        }
      }
      const after = await input.stat();
      if (
        bytes !== expected.bytes ||
        digest.digest("hex") !== expected.sha256 ||
        ["size", "mtimeMs", "ctimeMs", "dev", "ino", "nlink"].some(
          (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
        )
      )
        throw new Error("assembly input changed or differs from independently supplied bytes");
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function outputIdentity(filename: string, maximum: number, withinBound: () => void) {
  const leaf = await lstat(filename);
  if (!leaf.isFile() || leaf.nlink !== 1 || leaf.size < 1 || leaf.size > maximum)
    throw new Error("assembled output is not a bounded regular file");
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum)
      throw new Error("assembled output is not a bounded regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (bytes <= before.size) {
      withinBound();
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - bytes + 1),
        null,
      );
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > before.size) throw new Error("assembled output grew during verification");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (
      bytes !== before.size ||
      ["size", "mtimeMs", "ctimeMs", "dev", "ino", "nlink"].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      throw new Error("assembled output changed during verification");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Shared exact input validation for staging and assembly. No authority grant. */
export async function inspectTrustedAssemblyInput(rawRequest: unknown) {
  const accepted = request(rawRequest);
  // The policy is loaded only from this fixed trusted checkout, never inputs.
  const policy = selectReleasePackagePolicy(
    await loadPackagePolicy(trustedProject),
    accepted.release_profile,
  );
  const labels = releaseLabels(policy);
  const expected = labels
    .flatMap((label) => [
      ...packagesForPlatform(policy, label).map(
        (entry) => `${label}/${artifactName(entry, accepted.version)}`,
      ),
      `${label}/SHA256SUMS-${label}.txt`,
      `${label}/release-producer-${label}.json`,
    ])
    .sort();
  if (
    JSON.stringify(
      accepted.files.map((file) => `${file.platform_label}/${file.filename}`).sort(),
    ) !== JSON.stringify(expected)
  )
    throw new Error("assembly requires the complete fixed package-policy matrix and metadata");
  for (const file of accepted.files) {
    if (
      (file.filename.startsWith("SHA256SUMS-") || file.filename.startsWith("release-producer-")) &&
      file.bytes > maximumMetadataBytes
    )
      throw new Error("assembly metadata exceeds its byte bound");
  }
  return { accepted, policy, labels };
}

/** Inactive assembly seam. The trusted caller independently authenticates the
 * source/tree and expected input bytes. This function verifies equality and
 * creates a new aggregate; supplied producer declarations are not authority.
 * No workflow, transport, signing, upload, installation or publication occurs.
 */
export async function assembleTrustedRelease(
  ownedRoot: string,
  inputRoot: string,
  rawRequest: unknown,
  options: { deadline?: number } = {},
) {
  const started = performance.now();
  const deadline = Math.min(started + maximumMilliseconds, options.deadline ?? Infinity);
  const withinBound = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("assembly duration bound exhausted");
  };
  withinBound();
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(rawRequest);
  const root = path.resolve(ownedRoot);
  const input = await assertOwnedUnlinkedPath(root, inputRoot, "assembly input");
  for (const file of accepted.files) {
    await assertOwnedUnlinkedPath(
      root,
      path.join(input, `release-build-${file.platform_label}`, file.filename),
      "assembly input file",
    );
  }
  withinBound();
  const directory = await mkdtemp(path.join(root, "trusted-assembly-"));
  try {
    const staging = path.join(directory, "inputs");
    const assets = path.join(directory, "assets");
    const inventoryPath = path.join(directory, "release-inventory.json");
    for (const label of labels)
      await mkdir(path.join(staging, `release-build-${label}`), { recursive: true });
    for (const file of accepted.files) {
      withinBound();
      await copyVerified(
        path.join(input, `release-build-${file.platform_label}`, file.filename),
        path.join(staging, `release-build-${file.platform_label}`, file.filename),
        file,
        withinBound,
      );
    }
    const assembled = await reconcileReleaseAssets(staging, assets, {
      projectRoot: directory,
      inventoryPath,
      policy,
      version: accepted.version,
      tag: `v${accepted.version}`,
      lineage: {
        runId: accepted.run_id,
        revision: accepted.source_commit,
        maxAttempt: accepted.run_attempt,
      },
    });
    const identities = [];
    for (const filename of assembled.assets) {
      const identity = await outputIdentity(
        path.join(assets, filename),
        maximumFileBytes,
        withinBound,
      );
      const packageIdentity = assembled.inventory.packages.find(
        (item) => item.filename === filename,
      );
      const acceptedIdentity = accepted.files.find(
        (item) =>
          item.filename === filename && item.platform_label === packageIdentity?.platform_label,
      );
      if (
        packageIdentity &&
        (!acceptedIdentity ||
          identity.bytes !== acceptedIdentity.bytes ||
          identity.sha256 !== acceptedIdentity.sha256 ||
          identity.bytes !== packageIdentity.bytes ||
          identity.sha256 !== packageIdentity.sha256)
      )
        throw new Error("copied aggregate package differs from accepted input bytes");
      identities.push({ filename, ...identity });
    }
    const inventory = await outputIdentity(inventoryPath, maximumMetadataBytes, withinBound);
    // Ensure bounded JSON remains parseable before handing it to a later stage.
    JSON.parse(await readFile(inventoryPath, "utf8"));
    return {
      schema_version: 1,
      role: "package-aggregate-assembler",
      directory,
      assets,
      inventory: { path: inventoryPath, ...inventory },
      source_commit: accepted.source_commit,
      source_tree: accepted.source_tree,
      input_files: accepted.files,
      output_files: identities,
      declared_input_lineage: { run_id: accepted.run_id, maximum_attempt: accepted.run_attempt },
      authenticated_assembler: null,
      original_compiler: null,
      release_authorization: "not-evaluated",
      sbom_finalization: "not-evaluated",
    };
  } catch (cause) {
    throw new Error(`trusted assembly refused; retain owned directory ${directory}`, { cause });
  }
}
