import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type test from "node:test";
import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
  selectReleasePackagePolicy,
  type ReleaseProfile,
} from "../release-package-policy.mts";
const policy = await loadPackagePolicy();
const version = "0.1.0-alpha.3";
const source = "a".repeat(40);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function trustedAssemblyFixture(
  t: test.TestContext,
  profile: ReleaseProfile = "full",
) {
  const selected = selectReleasePackagePolicy(policy, profile);
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-trusted-assembly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const files: { platform_label: string; filename: string; bytes: number; sha256: string }[] = [];
  const contents = new Map<string, Buffer>();
  for (const label of releaseLabels(selected)) {
    const directory = path.join(input, `release-build-${label}`);
    await mkdir(directory, { recursive: true });
    const put = async (filename: string, value: string) => {
      const bytes = Buffer.from(value);
      await writeFile(path.join(directory, filename), bytes);
      files.push({ platform_label: label, filename, bytes: bytes.length, sha256: hash(bytes) });
      contents.set(`${label}/${filename}`, bytes);
    };
    const checksums = [];
    for (const entry of packagesForPlatform(selected, label)) {
      const filename = artifactName(entry, version);
      // Opaque deliberately inert fixtures, no real installer/gameplay claim.
      const bytes = `fixture package ${entry.id}; never execute`;
      await put(filename, bytes);
      checksums.push(`${hash(bytes)}  ${filename}`);
    }
    await put(`SHA256SUMS-${label}.txt`, `${checksums.join("\n")}\n`);
    await put(
      `release-producer-${label}.json`,
      `${JSON.stringify({ schema_version: 1, platform_label: label, version, run_id: "12345", run_attempt: 1, revision: source })}\n`,
    );
  }
  const request = {
    schema_version: profile === "full" ? 1 : 2,
    ...(profile === "full" ? {} : { release_profile: profile }),
    version,
    source_commit: source,
    source_tree: "b".repeat(40),
    run_id: "12345",
    run_attempt: 1,
    files,
  };
  return { root, input, request, contents };
}
