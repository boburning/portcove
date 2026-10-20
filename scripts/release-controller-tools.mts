import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source.mts";
export const controllerCompilerSourceAsset = "compiler-source-closure.json";
export const controllerToolEntries = Object.freeze([
  "production-controller-admission",
  "release-control-ready",
  "release-reviewed-inputs",
  "release-payload-preparation",
  "release-role-key-channel",
] as const);
export const controllerToolAssets = Object.freeze([
  ".github/workflows/application-update-production.yml",
  "release/package-policy.json",
] as const);
export const controllerToolPaths = Object.freeze(
  [
    "bin/node",
    "bin/portcove-release-tools",
    "bin/tauri-addon.node",
    controllerCompilerSourceAsset,
    ...controllerToolEntries.map((name) => `scripts/${name}.bundle.mjs`),
    ...controllerToolAssets,
  ].sort(),
);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function readControllerToolFile(filename: string, maximum = 128 * 1024 ** 2) {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      throw new Error("tool file exceeds regular-file bound");
    const output = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < output.length) {
      const next = await file.read(output, length, output.length - length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("tool file changed during acquisition");
    return output.subarray(0, length);
  } finally {
    await file.close();
  }
}

export const controllerToolPredicateType = "https://portcove.dev/attestations/controller-tools/v1";
export function inspectControllerToolManifest(raw: unknown) {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "bundler,files,node_version,platform,schema_version,source_commit,source_tree,tauri_cli_version" ||
    value.schema_version !== 2 ||
    value.platform !== "linux-x86_64" ||
    value.node_version !== "24.22.0" ||
    value.bundler !== "vite-plus@1.3.0" ||
    value.tauri_cli_version !== "2.12.2" ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_commit) ||
    typeof value.source_tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_tree) ||
    !Array.isArray(value.files) ||
    value.files.length !== controllerToolPaths.length
  )
    throw new Error("fixed controller tool manifest differs");
  let total = 0;
  const files = value.files.map((file: unknown, index) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      file.path !== controllerToolPaths[index] ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 128 * 1024 ** 2 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("controller tool inventory differs");
    total += file.bytes;
    return { path: controllerToolPaths[index]!, bytes: file.bytes, sha256: file.sha256 };
  });
  if (total > 320 * 1024 ** 2) throw new Error("controller tool expanded bytes exceed bound");
  return {
    schema_version: 2,
    source_commit: value.source_commit,
    source_tree: value.source_tree,
    platform: "linux-x86_64",
    node_version: "24.22.0",
    bundler: "vite-plus@1.3.0",
    tauri_cli_version: "2.12.2",
    files,
  };
}
/** No extraction: every opaque byte is checked before any receiver file write. */
export function inspectControllerToolArchive(
  raw: Buffer,
  expected: { source_commit: string; source_tree: string },
) {
  if (!Buffer.isBuffer(raw) || raw.length < 22 || raw.length > 320 * 1024 ** 2)
    throw new Error("controller tool ZIP exceeds compressed bound");
  const archive = Buffer.from(raw);
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 320 * 1024 ** 2,
    expandedBytes: 320 * 1024 ** 2 + 65536,
    files: controllerToolPaths.length + 1,
    nameBytes: 128,
    allowedPaths: new Set([...controllerToolPaths, "manifest.json"]),
  });
  if (entries.length !== controllerToolPaths.length + 1)
    throw new Error("controller tool ZIP inventory incomplete");
  const read = (name: string, maximum: number) => {
    const entry = entries.find((item) => item.name === name);
    if (!entry || entry.bytes < 1 || entry.bytes > maximum)
      throw new Error("controller tool ZIP member exceeds bound");
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maximum });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("controller tool ZIP member differs");
    return bytes;
  };
  const manifestBytes = read("manifest.json", 65536);
  const manifest = inspectControllerToolManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (
    manifest.source_commit !== expected.source_commit ||
    manifest.source_tree !== expected.source_tree
  )
    throw new Error("controller tool source/tree differs");
  const files = new Map<string, Buffer>([["manifest.json", manifestBytes]]);
  for (const file of manifest.files) {
    const bytes = read(file.path, file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("controller tool bytes differ from signed manifest");
    files.set(file.path, bytes);
  }
  const closureBytes = files.get(controllerCompilerSourceAsset)!;
  if (closureBytes.length > 65536) throw new Error("compiler source asset exceeds bound");
  const closure = inspectReleaseCompilerSourceClosure(
    JSON.parse(closureBytes.toString("utf8")) as unknown,
  );
  if (
    closure.source_commit !== manifest.source_commit ||
    closure.source_tree !== manifest.source_tree
  )
    throw new Error("compiler source asset differs from authenticated tool source");
  return { manifest, manifest_sha256: hash(manifestBytes), files };
}
