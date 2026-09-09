import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { artifactName, assertExactArtifactNames, loadPackagePolicy, packagesForPlatform, workspaceVersion } from "./release-package-policy.mjs";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";
import { collectReleaseArtifacts, validateStageRoot } from "./write-release-checksums.mjs";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const maxPayloadBytes = 2 * 1024 * 1024 * 1024;

export function updaterIdentity(policy, label, version) {
  const packages = packagesForPlatform(policy, label);
  const desktop = packages.find(entry => entry.interface === "desktop" && ["nsis", "appimage", "dmg"].includes(entry.format));
  if (!desktop) throw new Error(`no supported updater identity for ${label}`);
  const mac = desktop.os === "macos";
  return {
    id: mac ? `desktop-${label}-app-tar-gz` : desktop.id,
    platform_label: label,
    target: `${mac ? "darwin" : desktop.os}-${desktop.architecture}`,
    format: mac ? "app.tar.gz" : desktop.format,
    filename: mac ? artifactName({ filename: `Portcove_{version}_${desktop.architecture}.app.tar.gz` }, version) : artifactName(desktop, version),
    source_filename: mac ? "Portcove.app.tar.gz" : artifactName(desktop, version),
    bundle_directory: mac ? "macos" : desktop.format,
  };
}

async function fileIdentity(root, file) {
  await assertOwnedUnlinkedPath(root, file, "updater artifact");
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxPayloadBytes) throw new Error(`invalid updater artifact file: ${file}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > maxPayloadBytes) throw new Error("updater artifact exceeds its size limit");
    hash.update(chunk);
  }
  if (bytes !== metadata.size) throw new Error("updater artifact changed while hashing");
  return { bytes, sha256: hash.digest("hex") };
}

async function verifySignature(verifier, artifact, signature, key, identity) {
  const { stdout } = await run(verifier, ["verify", artifact, signature, key, identity.sha256, String(identity.bytes)], { timeout: 120_000, maxBuffer: 64 * 1024 });
  const result = JSON.parse(stdout);
  if (result.schema_version !== 1 || result.signature_verified !== true || result.bytes !== identity.bytes || result.sha256 !== identity.sha256) {
    throw new Error("signature verifier returned a different artifact identity");
  }
}

function assertRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("an exact source commit is required");
}

/** Stage final package bytes, then verify the copied updater and emit evidence last.
 * The caller supplies the independently trusted public key; an inventory is not a trust root.
 */
export async function stageUpdaterInventory(options) {
  const root = path.resolve(options.projectRoot ?? project);
  const version = await workspaceVersion(root);
  const policy = await loadPackagePolicy(root);
  const identity = updaterIdentity(policy, options.label, version);
  assertRevision(options.revision);
  const stage = await assertOwnedUnlinkedPath(root, validateStageRoot(root, options.output), "updater staging directory");
  const key = await assertOwnedUnlinkedPath(root, options.publicKey, "updater verification public key");
  if ((await lstat(key)).size > 16 * 1024) throw new Error("updater public key exceeds its size limit");
  const packages = await collectReleaseArtifacts(root, options.label, version);
  const source = path.join(root, "target", "release", "bundle", identity.bundle_directory, identity.source_filename);
  const signature = `${source}.sig`;
  await assertOwnedUnlinkedPath(root, source, "updater payload");
  await assertOwnedUnlinkedPath(root, signature, "updater signature");
  if (!(await lstat(signature)).isFile() || (await lstat(signature)).size > 16 * 1024) throw new Error("invalid updater signature file");
  // Never overwrite an existing candidate or its evidence. Inputs have already
  // been collected from exact package names; a missing input cannot yield a manifest.
  await mkdir(stage);
  const definitions = packagesForPlatform(policy, options.label);
  for (const file of packages) await copyFile(file, path.join(stage, path.basename(file)), constants.COPYFILE_EXCL);
  if (!packages.includes(source)) await copyFile(source, path.join(stage, identity.filename), constants.COPYFILE_EXCL);
  await copyFile(signature, path.join(stage, `${identity.filename}.sig`), constants.COPYFILE_EXCL);
  const selected = [];
  for (const definition of definitions) {
    const filename = artifactName(definition, version);
    selected.push({ id: definition.id, filename, ...await fileIdentity(root, path.join(stage, filename)) });
  }
  const artifact = path.join(stage, identity.filename);
  const finalIdentity = await fileIdentity(root, artifact);
  await (options.verifySignature ?? verifySignature)(options.verifier, artifact, `${artifact}.sig`, key, finalIdentity);
  const signatureIdentity = await fileIdentity(root, `${artifact}.sig`);
  const keyIdentity = await fileIdentity(root, key);
  const inventory = {
    schema_version: 1, repository: policy.repository, version, source_commit: options.revision,
    platform_label: options.label, application_identifier: "io.github.portcove.portcove",
    packages: selected,
    updater: {
      id: identity.id, target: identity.target, format: identity.format, filename: identity.filename,
      ...finalIdentity, signature: { filename: `${identity.filename}.sig`, ...signatureIdentity },
      public_key_sha256: keyIdentity.sha256,
    },
  };
  await writeFile(path.join(stage, "updater-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
  return inventory;
}

/** Recheck staged bytes against exact version/platform identities and a caller-owned key. */
export async function verifyUpdaterInventory(options) {
  const root = path.resolve(options.projectRoot ?? project);
  const directory = await assertOwnedUnlinkedPath(root, options.input, "updater inventory input");
  const manifest = path.join(directory, "updater-inventory.json");
  await assertOwnedUnlinkedPath(root, manifest, "updater inventory manifest");
  if ((await lstat(manifest)).size > 64 * 1024) throw new Error("updater inventory exceeds its size limit");
  const inventory = JSON.parse(await readFile(manifest, "utf8"));
  const policy = await loadPackagePolicy(root);
  const version = options.version ?? await workspaceVersion(root);
  const expected = updaterIdentity(policy, options.label, version);
  assertRevision(options.revision);
  if (inventory.schema_version !== 1 || inventory.repository !== policy.repository || inventory.version !== version
      || inventory.source_commit !== options.revision || inventory.platform_label !== options.label
      || inventory.application_identifier !== "io.github.portcove.portcove") throw new Error("updater inventory identity mismatch");
  const definitions = packagesForPlatform(policy, options.label);
  assertExactArtifactNames(definitions.map(entry => entry.id), inventory.packages.map(entry => entry.id), "updater package identities");
  for (const entry of inventory.packages) {
    const definition = definitions.find(item => item.id === entry.id);
    if (entry.filename !== artifactName(definition, version)) throw new Error("updater package filename mismatch");
  }
  const updater = inventory.updater;
  for (const field of ["id", "target", "format", "filename"]) {
    if (updater?.[field] !== expected[field]) throw new Error(`updater ${field} mismatch`);
  }
  if (updater.signature?.filename !== `${expected.filename}.sig`) throw new Error("updater signature filename mismatch");
  const entries = [...inventory.packages, updater, updater.signature];
  const filenames = [...new Set(entries.map(entry => entry.filename)), "updater-inventory.json"];
  assertExactArtifactNames(filenames, await readdir(directory), "updater staged files");
  for (const entry of entries) {
    const actual = await fileIdentity(root, path.join(directory, entry.filename));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`updater checksum mismatch: ${entry.filename}`);
  }
  const key = await assertOwnedUnlinkedPath(root, options.publicKey, "updater verification public key");
  if ((await lstat(key)).size > 16 * 1024) throw new Error("updater public key exceeds its size limit");
  if ((await fileIdentity(root, key)).sha256 !== updater.public_key_sha256) throw new Error("updater public key mismatch");
  await (options.verifySignature ?? verifySignature)(options.verifier, path.join(directory, updater.filename), path.join(directory, updater.signature.filename), key, updater);
  return inventory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...args] = process.argv.slice(2);
  const options = {};
  const names = { "--input": "input", "--output": "output", "--label": "label", "--public-key": "publicKey", "--verifier": "verifier", "--revision": "revision", "--version": "version" };
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]];
    if (!key || !args[index + 1] || options[key]) throw new Error("invalid or duplicate updater inventory argument");
    options[key] = args[index + 1];
  }
  if (!options.label || !options.publicKey || !options.verifier || !options.revision) throw new Error("label, public-key, verifier and revision are required");
  if (operation === "stage" && options.output && !options.version) await stageUpdaterInventory(options);
  else if (operation === "verify" && options.input) await verifyUpdaterInventory(options);
  else throw new Error("use stage --output PATH or verify --input PATH");
  console.log(`Updater artifact ${operation} passed for ${options.label}.`);
}
