import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import type { FileIdentity } from "./development-evidence.mts";
import { readBoundedEvidenceFile } from "./development-evidence.mts";

export const gameFirstInstalledArgumentNames = [
  "game-first-inputs",
  "game-first-source",
  "game-first-runtime",
  "game-first-shapes",
  "game-first-logic",
  "game-first-archive",
] as const;
export interface GameFirstInstalledInputPaths {
  metadata: string;
  source: string;
  runtime: string;
  shapes: string;
  logic: string;
  archive: string;
}
interface Digest {
  bytes: number;
  sha256: string;
}
const runtimePaths = ["tmc_pc.exe", "voxel_shapes.json", "assets/rando/default.logic"] as const;
type RuntimePath = (typeof runtimePaths)[number];
export interface GameFirstInstalledMetadata {
  format_version: 1;
  port_id: "project-picori";
  source_profile: "minish-cap-gba";
  upstream_release: string;
  archive: Digest;
  source: Digest & { sha1: string };
  runtime_files: (Digest & { path: RuntimePath })[];
}
const maximum = {
  archive: 128 * 1024 ** 2,
  source: 32 * 1024 ** 2,
  "tmc_pc.exe": 128 * 1024 ** 2,
  "voxel_shapes.json": 16 * 1024 ** 2,
  "assets/rando/default.logic": 8 * 1024 ** 2,
};
function keys(value: Record<string, unknown>, expected: string[], kind = "Picori") {
  assert.deepEqual(
    Object.keys(value).sort(),
    expected.toSorted(),
    `Unexpected ${kind} metadata fields`,
  );
}
function digest(value: unknown, limit: number, source = false): Digest {
  assert.ok(isRecord(value), "File identity must be an object");
  assert.ok(
    Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= limit,
    "File identity exceeds its finite byte bound",
  );
  assert.ok(
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256),
    "SHA256 required",
  );
  if (source)
    assert.ok(
      typeof value.sha1 === "string" && /^[a-f0-9]{40}$/u.test(value.sha1),
      "Source SHA1 required",
    );
  return { bytes: Number(value.bytes), sha256: value.sha256 };
}
export function parseGameFirstInstalledInputPaths(
  values: Record<string, unknown>,
): GameFirstInstalledInputPaths {
  const selected = gameFirstInstalledArgumentNames.map((name) => {
    const file = values[name];
    assert.ok(
      typeof file === "string" &&
        file.length <= 4096 &&
        !file.includes("\0") &&
        path.isAbsolute(file),
      `An absolute captured argument-file is required for ${name}`,
    );
    return file;
  });
  const [metadata, source, runtime, shapes, logic, archive] = selected;
  assert.ok(metadata && source && runtime && shapes && logic && archive);
  return { metadata, source, runtime, shapes, logic, archive };
}
export function parseGameFirstInstalledMetadata(value: unknown): GameFirstInstalledMetadata {
  assert.ok(isRecord(value), "Picori metadata must be an object");
  keys(value, [
    "format_version",
    "port_id",
    "source_profile",
    "upstream_release",
    "archive",
    "source",
    "runtime_files",
  ]);
  assert.equal(value.format_version, 1);
  assert.equal(value.port_id, "project-picori");
  assert.equal(value.source_profile, "minish-cap-gba");
  assert.ok(
    typeof value.upstream_release === "string" &&
      /^[a-z0-9][a-z0-9._+-]{0,63}$/iu.test(value.upstream_release),
  );
  assert.ok(isRecord(value.archive) && isRecord(value.source));
  keys(value.archive, ["bytes", "sha256"]);
  keys(value.source, ["bytes", "sha256", "sha1"]);
  const archive = digest(value.archive, maximum.archive);
  const source = { ...digest(value.source, maximum.source, true), sha1: String(value.source.sha1) };
  assert.ok(
    Array.isArray(value.runtime_files) && value.runtime_files.length === 3,
    "Exactly the three reviewed upstream runtime files are required",
  );
  const files = value.runtime_files.map((file: unknown) => {
    assert.ok(isRecord(file));
    keys(file, ["path", "bytes", "sha256"]);
    const relative = runtimePaths.find((candidate) => candidate === file.path);
    assert.ok(relative, "Only the reviewed fixed runtime paths are accepted");
    return { path: relative, ...digest(file, maximum[relative]) };
  });
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    [...runtimePaths].sort(),
    "Runtime paths must be unique",
  );
  assert.ok(
    files.reduce((sum, file) => sum + file.bytes, source.bytes) <= 192 * 1024 ** 2,
    "Owned runtime preparation exceeds its aggregate byte bound",
  );
  return {
    format_version: 1,
    port_id: "project-picori",
    source_profile: "minish-cap-gba",
    upstream_release: value.upstream_release,
    archive,
    source,
    runtime_files: files,
  };
}
async function noLinks(file: string) {
  assert.ok(path.isAbsolute(file));
  for (let current = file; ;) {
    assert.ok(
      !(await lstat(current)).isSymbolicLink(),
      "Captured inputs must not traverse symbolic links",
    );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
/** Read/copy from one ordinary bounded handle. Never modifies captured inputs. */
async function observeFile(
  file: string,
  expected: Digest & { sha1?: string },
  destination?: string,
  prefix?: readonly number[],
) {
  await noLinks(file);
  const before = await lstat(file, { bigint: true });
  assert.ok(
    before.isFile() && before.size === BigInt(expected.bytes),
    "Captured input size/type changed",
  );
  const input = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  const stable = (value: typeof before) =>
    value.isFile() &&
    value.dev === before.dev &&
    value.ino === before.ino &&
    value.size === before.size &&
    value.mtimeNs === before.mtimeNs &&
    value.ctimeNs === before.ctimeNs;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assert.ok(
      stable(await input.stat({ bigint: true })),
      "Captured input identity changed before reading",
    );
    if (destination) output = await open(destination, "wx", 0o600);
    const sha256 = createHash("sha256");
    const sha1 = createHash("sha1");
    const buffer = Buffer.alloc(1024 * 1024);
    const observedPrefix = Buffer.alloc(prefix?.length ?? 0);
    let prefixBytes = 0;
    let bytes = 0;
    for (;;) {
      const read = await input.read(
        buffer,
        0,
        Math.min(buffer.length, expected.bytes - bytes + 1),
        null,
      );
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      assert.ok(bytes <= expected.bytes, "Captured input grew while reading");
      const chunk = buffer.subarray(0, read.bytesRead);
      if (prefix && prefixBytes < prefix.length)
        prefixBytes += chunk.copy(observedPrefix, prefixBytes, 0, prefix.length - prefixBytes);
      sha256.update(chunk);
      sha1.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    assert.equal(bytes, expected.bytes);
    if (prefix)
      assert.ok(
        observedPrefix.equals(Buffer.from(prefix)),
        "Canonical raw big-endian N64 source required",
      );
    assert.equal(sha256.digest("hex"), expected.sha256, "Captured input SHA256 differs");
    const sourceSha1 = sha1.digest("hex");
    if (expected.sha1) assert.equal(sourceSha1, expected.sha1, "Captured source SHA1 differs");
    assert.ok(
      stable(await input.stat({ bigint: true })) && stable(await lstat(file, { bigint: true })),
      "Captured input identity changed during reading",
    );
    if (output) await output.sync();
    return {
      path: file,
      bytes,
      sha256: expected.sha256,
      ...(expected.sha1 ? { sha1: sourceSha1 } : {}),
    };
  } finally {
    try {
      await output?.close();
    } finally {
      await input.close();
    }
  }
}
export async function prepareGameFirstInstalledInputs(
  inputPaths: GameFirstInstalledInputPaths,
  output: string,
) {
  await noLinks(output);
  assert.ok((await lstat(output)).isDirectory());
  await noLinks(inputPaths.metadata);
  const captured = await readBoundedEvidenceFile(inputPaths.metadata, 16 * 1024);
  const metadata = parseGameFirstInstalledMetadata(JSON.parse(captured.bytes.toString("utf8")));
  const runtimeDirectory = path.join(output, "picori-incoming-runtime");
  const sourceDirectory = path.join(output, "selected-setup-inputs");
  // Exclusive directories retain partial preparation after failure; no cleanup
  // or retry can overwrite the original evidence or a prior scenario's files.
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await mkdir(sourceDirectory, { mode: 0o700 });
  assert.equal(
    path.relative(await realpath(output), await realpath(runtimeDirectory)),
    "picori-incoming-runtime",
  );
  const files = {
    "tmc_pc.exe": inputPaths.runtime,
    "voxel_shapes.json": inputPaths.shapes,
    "assets/rando/default.logic": inputPaths.logic,
  };
  const identities = [captured.identity, await observeFile(inputPaths.archive, metadata.archive)];
  for (const file of metadata.runtime_files) {
    const destination = path.join(runtimeDirectory, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    identities.push(await observeFile(files[file.path], file, destination));
    await observeFile(destination, file);
  }
  const source = path.join(sourceDirectory, "baserom.gba");
  identities.push(await observeFile(inputPaths.source, metadata.source, source));
  await observeFile(source, metadata.source, path.join(runtimeDirectory, "baserom.gba"));
  await observeFile(path.join(runtimeDirectory, "baserom.gba"), metadata.source);
  return {
    metadata,
    metadataIdentity: captured.identity,
    identities,
    runtimeDirectory,
    sourceDirectory,
    source,
    runtimeExecutable: path.join(runtimeDirectory, "tmc_pc.exe"),
  };
}
export async function verifyGameFirstInstalledInputs(
  inputPaths: GameFirstInstalledInputPaths,
  metadata: GameFirstInstalledMetadata,
  metadataIdentity: FileIdentity,
) {
  await noLinks(inputPaths.metadata);
  const current = await readBoundedEvidenceFile(inputPaths.metadata, 16 * 1024);
  assert.equal(current.identity.bytes, metadataIdentity.bytes, "Captured metadata size changed");
  assert.equal(current.identity.sha256, metadataIdentity.sha256, "Captured metadata bytes changed");
  await observeFile(inputPaths.archive, metadata.archive);
  await observeFile(inputPaths.source, metadata.source);
  const files = {
    "tmc_pc.exe": inputPaths.runtime,
    "voxel_shapes.json": inputPaths.shapes,
    "assets/rando/default.logic": inputPaths.logic,
  };
  for (const file of metadata.runtime_files) await observeFile(files[file.path], file);
}

export const gameFirstMMArgumentNames = ["game-first-mm-inputs", "game-first-mm-source"] as const;
export interface GameFirstMMInputPaths {
  metadata: string;
  source: string;
}
/** Fixture expectations only: normal Core still establishes source compatibility. */
export interface GameFirstMMMetadata {
  format_version: 1;
  source_profile: "majoras-mask";
  variant: "ntsc-u-1-0";
  source: Digest & { sha1: string };
}
const maximumMMSourceBytes = 64 * 1024 ** 2;
const canonicalN64Prefix = [0x80, 0x37, 0x12, 0x40] as const;
export function parseGameFirstMMInputPaths(values: Record<string, unknown>): GameFirstMMInputPaths {
  const selected = gameFirstMMArgumentNames.map((name) => {
    const file = values[name];
    assert.ok(
      typeof file === "string" &&
        file.length <= 4096 &&
        !file.includes("\0") &&
        path.isAbsolute(file),
      `An absolute captured argument-file is required for ${name}`,
    );
    return file;
  });
  const [metadata, source] = selected;
  assert.ok(metadata && source);
  return { metadata, source };
}
function parseGameFirstMMMetadata(value: unknown): GameFirstMMMetadata {
  assert.ok(isRecord(value), "MM fixture metadata must be an object");
  keys(value, ["format_version", "source_profile", "variant", "source"], "MM fixture");
  assert.equal(value.format_version, 1);
  assert.equal(value.source_profile, "majoras-mask");
  assert.equal(value.variant, "ntsc-u-1-0");
  assert.ok(isRecord(value.source));
  keys(value.source, ["bytes", "sha256", "sha1"], "MM fixture source");
  const source = {
    ...digest(value.source, maximumMMSourceBytes, true),
    sha1: String(value.source.sha1),
  };
  assert.ok(source.bytes >= canonicalN64Prefix.length, "Canonical N64 header required");
  return { format_version: 1, source_profile: "majoras-mask", variant: "ntsc-u-1-0", source };
}
export async function prepareGameFirstMMInputs(inputPaths: GameFirstMMInputPaths, output: string) {
  await noLinks(output);
  assert.ok((await lstat(output)).isDirectory());
  await noLinks(inputPaths.metadata);
  const captured = await readBoundedEvidenceFile(inputPaths.metadata, 16 * 1024);
  const metadata = parseGameFirstMMMetadata(JSON.parse(captured.bytes.toString("utf8")));
  const sourceDirectory = path.join(output, "selected-setup-inputs");
  await mkdir(sourceDirectory, { mode: 0o700 });
  assert.equal(
    path.relative(await realpath(output), await realpath(sourceDirectory)),
    "selected-setup-inputs",
  );
  const sourcePath = path.join(sourceDirectory, "majoras-mask.z64");
  // Exact bytes only. Header/order and fixture digests do not grant admission;
  // ordinary Core scan/review/install must independently accept this source.
  await observeFile(inputPaths.source, metadata.source, sourcePath, canonicalN64Prefix);
  const copied = await observeFile(sourcePath, metadata.source, undefined, canonicalN64Prefix);
  const source: FileIdentity = { path: copied.path, bytes: copied.bytes, sha256: copied.sha256 };
  return { metadata, metadataIdentity: captured.identity, sourceDirectory, source };
}
export async function verifyGameFirstMMInputs(
  inputPaths: GameFirstMMInputPaths,
  metadata: GameFirstMMMetadata,
  metadataIdentity: FileIdentity,
  source: FileIdentity,
) {
  await noLinks(inputPaths.metadata);
  const current = await readBoundedEvidenceFile(inputPaths.metadata, 16 * 1024);
  assert.equal(current.identity.bytes, metadataIdentity.bytes, "Captured MM metadata size changed");
  assert.equal(
    current.identity.sha256,
    metadataIdentity.sha256,
    "Captured MM metadata bytes changed",
  );
  assert.deepEqual(parseGameFirstMMMetadata(JSON.parse(current.bytes.toString("utf8"))), metadata);
  assert.equal(source.bytes, metadata.source.bytes);
  assert.equal(source.sha256, metadata.source.sha256);
  assert.notEqual(
    path.resolve(source.path),
    path.resolve(inputPaths.source),
    "Separate owned MM copy required",
  );
  await observeFile(inputPaths.source, metadata.source, undefined, canonicalN64Prefix);
  await observeFile(source.path, metadata.source, undefined, canonicalN64Prefix);
}
