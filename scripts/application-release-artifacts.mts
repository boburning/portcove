/** Windows package data contract. Incoming payloads are never executable tools. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { artifactName, packagesForPlatform } from "./release-package-policy.mts";
import type { ReleasePackagePolicy } from "./release-package-policy.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import type { UpdaterInventory } from "./updater-artifact-inventory.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import {
  applicationReleaseTrust,
  inspectApplicationPackageExecution,
} from "./application-release-policy.mts";

export function applicationPackageNames(version: string) {
  assert.match(
    version,
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/u,
  );
  assert.ok(version.length <= 96);
  return [
    `Portcove_${version}_x64-setup.exe`,
    `portcove-cli-${version}-windows-x86_64.zip`,
    "portcove-desktop.exe",
    "sbom.spdx.json",
    "build-inputs.json",
  ].sort();
}

export interface ApplicationPackageExpectation {
  source_commit: string;
  source_tree: string;
  version: string;
  control_commit: string;
  control_ref: string;
  run_id: string;
  package_attempt: number;
}

function inspectExpectation(expected: ApplicationPackageExpectation) {
  for (const value of [expected.source_commit, expected.source_tree, expected.control_commit])
    assert.match(value, /^[a-f0-9]{40}$/u);
  assert.match(
    expected.control_ref,
    /^(?:refs\/heads\/main|refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64})$/u,
  );
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    Number.isSafeInteger(expected.package_attempt) &&
      expected.package_attempt >= 1 &&
      expected.package_attempt <= 3,
  );
  applicationPackageNames(expected.version);
}

export function inspectApplicationBuildInputs(raw: unknown, control: string) {
  assert.ok(isRecord(raw));
  assert.equal(raw.schema_version, 3);
  assert.equal(raw.authority, "none");
  assert.equal(raw.initial_root_profile, "single-owner-one-of-one-v1");
  assert.equal(raw.control_commit, control);
  assert.equal(raw.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(
    raw.payload_public_key_sha256,
    "f24b27f315a1682698a91997dd3a5cc62cf2850454167866b830c8bb7e640d44",
  );
  assert.equal(
    raw.packaging_sha256,
    "96a88182f65fe5ca713adf240b84f1c12aa44e639565a5bd2e9a09b3d5c94ae7",
  );
  assert.equal(
    raw.tauri_configuration_sha256,
    "285912b604b05815a1f8932651926b756b16d92005384766e5c19fcc028013f0",
  );
  assert.equal(raw.metadata_url, applicationReleaseTrust.metadata);
  assert.equal(raw.targets_url, applicationReleaseTrust.content);
  assert.equal(raw.signing, "deferred; secret-free --no-sign build");
}

export async function inspectApplicationPackageBytes(
  directory: string,
  expected: ApplicationPackageExpectation,
) {
  inspectExpectation(expected);
  const filenames = applicationPackageNames(expected.version);
  const files = [];
  let total = 0;
  for (const filename of filenames) {
    const maximum = filename.endsWith(".json") ? 16 * 1024 ** 2 : 512 * 1024 ** 2;
    const file = await assertOwnedUnlinkedPath(
      directory,
      path.join(directory, filename),
      "application package",
    );
    const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum);
    const handle = await open(file, "r");
    const digest = createHash("sha256");
    let length = 0;
    try {
      const before = await handle.stat();
      assert.equal(before.dev, stat.dev);
      assert.equal(before.ino, stat.ino);
      assert.equal(before.nlink, 1);
      const chunk = Buffer.alloc(65536);
      while (length <= maximum) {
        const read = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, maximum + 1 - length),
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
        digest.update(chunk.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      const current = await lstat(file);
      assert.ok(
        length <= maximum &&
          length === stat.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          after.nlink === 1 &&
          current.ino === after.ino &&
          current.dev === after.dev &&
          !current.isSymbolicLink(),
      );
    } finally {
      await handle.close();
    }
    total += length;
    assert.ok(total <= 2 * 1024 ** 3);
    const bytes = filename.endsWith(".json")
      ? await readBoundedPublicBuildInputFile(directory, filename, maximum)
      : null;
    if (filename === "build-inputs.json") {
      assert.ok(bytes);
      inspectApplicationBuildInputs(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        expected.control_commit,
      );
    }
    if (filename === "sbom.spdx.json") {
      assert.ok(bytes);
      const sbom: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assert.ok(
        isRecord(sbom) &&
          typeof sbom.spdxVersion === "string" &&
          sbom.spdxVersion.startsWith("SPDX-2."),
      );
      assert.ok(Array.isArray(sbom.packages) && sbom.packages.length > 0);
    }
    if (bytes)
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest.copy().digest("hex"));
    files.push({ filename, bytes: length, sha256: digest.digest("hex") });
  }
  return {
    schema_version: 1,
    repository: "boburning/portcove",
    profile: "initial-beta-windows-x86_64-v1",
    ...expected,
    files,
  };
}

/** Canonical updater data for the already verified package and native report.
 * This transformation grants no acceptance: the caller verifies source,
 * provenance, native execution and the payload signature before publishing it. */
export function createApplicationUpdaterInventory(
  manifest: Awaited<ReturnType<typeof inspectApplicationPackageBytes>>,
  nativeRaw: unknown,
  artifact: number,
  signature: Buffer,
  publicKeySha256: string,
  policy: ReleasePackagePolicy,
): UpdaterInventory {
  inspectExpectation(manifest);
  assert.equal(manifest.profile, "initial-beta-windows-x86_64-v1");
  assert.equal(manifest.repository, "boburning/portcove");
  assert.equal(policy.repository, manifest.repository);
  assert.deepEqual(
    manifest.files.map((file) => file.filename).sort(),
    applicationPackageNames(manifest.version),
  );
  for (const file of manifest.files) {
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 512 * 1024 ** 2);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.ok(Number.isSafeInteger(artifact) && artifact > 0);
  assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 16384);
  assert.match(publicKeySha256, /^[a-f0-9]{64}$/u);
  const native = inspectNativeReleaseQualification(nativeRaw);
  assert.equal(native.stage, "payload-signing");
  assert.equal(native.platform_label, "windows-x86_64");
  assert.equal(native.producer.source_commit, manifest.control_commit);
  const packages = packagesForPlatform(policy, "windows-x86_64").map((definition) => {
    const filename = artifactName(definition, manifest.version);
    const file = manifest.files.find((file) => file.filename === filename);
    assert.ok(file, "complete Windows package policy inventory required");
    return { id: definition.id, ...file };
  });
  const updater = updaterIdentity(policy, "windows-x86_64", manifest.version);
  const payload = packages.find((file) => file.filename === updater.filename);
  assert.ok(payload);
  assert.deepEqual(native.candidate, {
    source_commit: manifest.source_commit,
    source_tree: manifest.source_tree,
    run_id: manifest.run_id,
    run_attempt: manifest.package_attempt,
    artifact_id: artifact,
    package: { filename: payload.filename, bytes: payload.bytes, sha256: payload.sha256 },
  });
  return {
    schema_version: 1,
    repository: manifest.repository,
    version: manifest.version,
    source_commit: manifest.source_commit,
    platform_label: "windows-x86_64",
    application_identifier: "io.github.portcove.portcove",
    packages,
    updater: {
      ...payload,
      target: updater.target,
      format: updater.format,
      public_key_sha256: publicKeySha256,
      signature: {
        filename: `${payload.filename}.sig`,
        bytes: signature.length,
        sha256: createHash("sha256").update(signature).digest("hex"),
      },
    },
  };
}

/** A fresh, read-only attester constructs the manifest; the compiler cannot
 * select its expected source, control identity or signing policy. */
async function main() {
  const execution = inspectApplicationPackageExecution(process.env);
  const directory = path.resolve("work/application-unsigned");
  const expected = {
    source_commit: process.env.PORTCOVE_PRODUCT_SOURCE ?? "",
    source_tree: process.env.PORTCOVE_PRODUCT_TREE ?? "",
    version: process.env.PORTCOVE_PRODUCT_VERSION ?? "",
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    package_attempt: Number(process.env.PORTCOVE_PACKAGE_ATTEMPT),
  };
  assert.deepEqual((await readdir(directory)).sort(), applicationPackageNames(expected.version));
  const manifest = await inspectApplicationPackageBytes(directory, expected);
  await writeFile(
    path.join(directory, "application-release.json"),
    `${JSON.stringify(manifest)}\n`,
    { flag: "wx" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
