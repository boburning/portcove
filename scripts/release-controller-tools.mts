import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";
export const controllerCompilerSourceAsset = "compiler-source-closure.json";
export const controllerToolSourceAssetMaximumBytes = 128 * 1024;
/** Same reviewed dependency as the maintained desktop bootstrap. */
export const controllerNativeDriverVersion = "2.0.6";
export const controllerToolEntries = Object.freeze([
  "production-controller-admission",
  "release-control-ready",
  "release-reviewed-inputs",
  "release-payload-preparation",
  "release-signing-controller",
  "release-role-key-channel",
  "release-coordinator-driver",
  "release-publication-controller",
  "release-site-controller",
  "release-tuf-controller",
  "release-controller-job",
  "release-hosted-native-runner",
  "release-hosted-native-worker",
  "release-hosted-native-windows-source",
  "release-native-keyless-assembly",
] as const);
/** These child entry paths are part of the existing driver's/supervisor's ABI. */
export const controllerToolChildren = Object.freeze([
  "scripts/release-hosted-native-linux-driver.mts",
  "scripts/release-hosted-native-bootstrap.mts",
  "scripts/rust-test-tree-supervisor.mts",
] as const);
export const controllerToolAssets = Object.freeze([
  "deny.toml",
  ".github/workflows/application-update-production.yml",
  ".github/workflows/release.yml",
  ".github/repository-ruleset.json",
  ".github/qualification-coverage.json",
  "release/package-policy.json",
  "apps/desktop/src-tauri/tauri.release-public.conf.json",
  "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  "scripts/qualify-hosted-native-linux.py",
  "scripts/native-qualification-linux-supervisor.py",
  "scripts/prepare-hosted-native-linux-installation.py",
] as const);
export const controllerToolPaths = Object.freeze(
  [
    "bin/node",
    "bin/portcove",
    "bin/portcove-release-tools",
    "bin/tauri-addon.node",
    "bin/tauri-driver",
    "bin/pnpm",
    "pnpm-license.txt",
    "pnpm-notices.txt",
    "bin/native-linux-tree-reaper",
    "native-linux-support.json",
    controllerCompilerSourceAsset,
    ...controllerToolEntries.map((name) => `scripts/${name}.bundle.mjs`),
    ...controllerToolChildren,
    ...controllerToolAssets,
  ].sort(),
);
export type ControllerToolPlatform = "linux-x86_64" | "windows-x86_64";
/** Windows bootstrap inventory is explicit. It has no Linux process-tree product
 * and does not make the currently Linux-only native runner Windows-capable. */
const windowsAssets = Object.freeze([
  "deny.toml",
  ".github/workflows/application-update-production.yml",
  ".github/workflows/release.yml",
  ".github/repository-ruleset.json",
  ".github/qualification-coverage.json",
  "release/package-policy.json",
  "apps/desktop/src-tauri/tauri.release-public.conf.json",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  "scripts/release-hosted-native-windows-setup.ps1",
  "scripts/release-hosted-native-windows-setup.cs.txt",
  "scripts/release-hosted-native-windows-audit.cs.txt",
  "scripts/native-qualification-account.cs.txt",
  "scripts/native-qualification-account-bridge.ps1",
  "scripts/native-qualification-account-client.ps1",
  "scripts/native-qualification-runtime-observation.psm1",
  "scripts/release-hosted-native-windows-owner.ps1",
  "scripts/release-hosted-native-windows-owner-mechanism.ps1",
  "scripts/release-hosted-native-windows-diagnostic-owner.ps1",
  "scripts/release-hosted-native-windows-recovery.ps1",
  "scripts/native-qualification-account-registry.ps1",
  "scripts/fixtures/native-account-gui-probe.ps1",
  "scripts/windows-webview-driver-policy.psm1",
] as const);
const windowsPaths = Object.freeze(
  [
    "bin/node.exe",
    "bin/portcove.exe",
    "bin/portcove-release-tools.exe",
    "bin/tauri-addon.node",
    "bin/tauri-driver.exe",
    "bin/msedgedriver.exe",
    "webview-driver.json",
    "windows-runtime-prerequisite.json",
    "webview-driver-license.txt",
    "webview-driver-eula.txt",
    "webview-driver-notices.html",
    "bin/pnpm.exe",
    "pnpm-license.txt",
    "pnpm-notices.txt",
    "bin/native-windows-tree-supervisor.exe",
    "native-windows-support.json",
    controllerCompilerSourceAsset,
    ...controllerToolEntries.map((name) => `scripts/${name}.bundle.mjs`),
    ...windowsAssets,
  ].sort(),
);
export function controllerToolPlatformProfile(platform: ControllerToolPlatform) {
  if (platform !== "linux-x86_64" && platform !== "windows-x86_64")
    throw new Error("fixed controller tool platform required");
  return Object.freeze({
    platform,
    schema_version: platform === "linux-x86_64" ? 2 : 3,
    suffix: platform === "linux-x86_64" ? "" : ".exe",
    assets: platform === "linux-x86_64" ? controllerToolAssets : windowsAssets,
    children: platform === "linux-x86_64" ? controllerToolChildren : [],
    paths: platform === "linux-x86_64" ? controllerToolPaths : windowsPaths,
  });
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function readControllerToolFile(
  filename: string,
  maximum = 128 * 1024 ** 2,
  expected?: {
    dev: number | bigint;
    ino: number | bigint;
    uid: number | bigint;
    nlink: number | bigint;
  },
) {
  const identityFields = ["dev", "ino", "uid", "nlink"] as const;
  // Preserve exact fs identities. An old rounded numeric descriptor cannot be
  // repaired by coercion: only safe numbers or original bigint values qualify.
  const identities = expected
    ? identityFields.map((key) => {
        const value = expected[key];
        if (typeof value === "bigint") return value;
        if (!Number.isSafeInteger(value)) throw new Error("tool file held identity differs");
        return BigInt(value);
      })
    : undefined;
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error("tool file exceeds regular-file bound");
    if (identities && identityFields.some((key, index) => before[key] !== identities[index]))
      throw new Error("tool file held identity differs");
    const output = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < output.length) {
      const next = await file.read(output, length, output.length - length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("tool file changed during acquisition");
    if (identities && identityFields.some((key, index) => after[key] !== identities[index]))
      throw new Error("tool file held identity changed");
    return output.subarray(0, length);
  } finally {
    await file.close();
  }
}

export const controllerToolPredicateType = "https://portcove.dev/attestations/controller-tools/v1";
export const windowsControllerToolPredicateType =
  "https://portcove.dev/attestations/controller-tools/windows-v1";
export function inspectControllerToolManifest(
  raw: unknown,
  platform: ControllerToolPlatform = "linux-x86_64",
) {
  const profile = controllerToolPlatformProfile(platform);
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "bundler,files,node_version,platform,schema_version,source_commit,source_tree,tauri_cli_version" ||
    value.schema_version !== profile.schema_version ||
    value.platform !== profile.platform ||
    value.node_version !== controllerNodeVersion ||
    value.bundler !== "vite-plus@1.4.0" ||
    value.tauri_cli_version !== "2.12.2" ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_commit) ||
    typeof value.source_tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_tree) ||
    !Array.isArray(value.files) ||
    value.files.length !== profile.paths.length
  )
    throw new Error("fixed controller tool manifest differs");
  let total = 0;
  const files = value.files.map((file: unknown, index) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      file.path !== profile.paths[index] ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 128 * 1024 ** 2 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("controller tool inventory differs");
    total += file.bytes;
    return { path: profile.paths[index]!, bytes: file.bytes, sha256: file.sha256 };
  });
  if (total > 320 * 1024 ** 2) throw new Error("controller tool expanded bytes exceed bound");
  return {
    schema_version: profile.schema_version,
    source_commit: value.source_commit,
    source_tree: value.source_tree,
    platform: profile.platform,
    node_version: controllerNodeVersion,
    bundler: "vite-plus@1.4.0",
    tauri_cli_version: "2.12.2",
    files,
  };
}
/** No extraction: every opaque byte is checked before any receiver file write. */
export function inspectControllerToolArchive(
  raw: Buffer,
  expected: { source_commit: string; source_tree: string; platform?: ControllerToolPlatform },
) {
  const profile = controllerToolPlatformProfile(expected.platform ?? "linux-x86_64");
  if (!Buffer.isBuffer(raw) || raw.length < 22 || raw.length > 320 * 1024 ** 2)
    throw new Error("controller tool ZIP exceeds compressed bound");
  const archive = Buffer.from(raw);
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 320 * 1024 ** 2,
    expandedBytes: 320 * 1024 ** 2 + 65536,
    files: profile.paths.length + 1,
    nameBytes: 128,
    allowedPaths: new Set([...profile.paths, "manifest.json"]),
  });
  if (entries.length !== profile.paths.length + 1)
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
  const manifest = inspectControllerToolManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    profile.platform,
  );
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
