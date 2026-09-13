import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finalizeReleaseAssets, releaseSbomName } from "./finalize-release-assets.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-final-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const inventoryPath = path.join(root, "metadata", "inventory.json");
  const sbomSubjectChecksums = path.join(root, "attestation", "sbom-subject-checksums.txt");
  await mkdir(assets, { recursive: true });
  await mkdir(path.dirname(inventoryPath), { recursive: true });
  const packages = [
    {
      filename: "portcove-cli-1.2.3-windows-x86_64.zip",
      contents: Buffer.from("windows package"),
    },
    {
      filename: "portcove-cli-1.2.3-linux-x86_64.tar.gz",
      contents: Buffer.from("linux package"),
    },
  ];
  for (const item of packages) await writeFile(path.join(assets, item.filename), item.contents);
  await writeFile(
    path.join(assets, "SHA256SUMS.txt"),
    `${packages.map((item) => `${sha256(item.contents)}  ${item.filename}`).join("\n")}\n`,
  );
  await writeFile(
    path.join(assets, releaseSbomName),
    `${JSON.stringify({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", packages: [{ name: "portcove" }] })}\n`,
  );
  await writeFile(
    inventoryPath,
    `${JSON.stringify({
      schema_version: 1,
      repository: "boburning/portcove",
      version: "1.2.3",
      tag: "v1.2.3",
      checksum_manifest: "SHA256SUMS.txt",
      packages: packages.map((item) => ({
        filename: item.filename,
        bytes: item.contents.length,
        sha256: sha256(item.contents),
      })),
    })}\n`,
  );
  return { root, assets, inventoryPath, sbomSubjectChecksums, packages };
}

test("binds the SBOM publicly while limiting SBOM attestation subjects to packages", async (t) => {
  const item = await fixture(t);
  const first = await finalizeReleaseAssets(item.assets, item.inventoryPath, {
    projectRoot: item.root,
    sbomSubjectChecksums: item.sbomSubjectChecksums,
  });
  const manifest = await readFile(path.join(item.assets, "SHA256SUMS.txt"), "utf8");
  assert.match(manifest, new RegExp(`  ${releaseSbomName}\\n`, "u"));
  const subjectChecksums = await readFile(item.sbomSubjectChecksums, "utf8");
  assert.equal(
    subjectChecksums,
    `${item.packages
      .toSorted((left, right) => left.filename.localeCompare(right.filename))
      .map((entry) => `${sha256(entry.contents)}  ${entry.filename}`)
      .join("\n")}\n`,
  );
  assert.doesNotMatch(subjectChecksums, new RegExp(releaseSbomName, "u"));
  assert.equal(first.inventory.sbom.filename, releaseSbomName);
  assert.match(first.inventory.sbom.sha256, /^[a-f0-9]{64}$/u);
  const second = await finalizeReleaseAssets(item.assets, item.inventoryPath, {
    projectRoot: item.root,
    sbomSubjectChecksums: item.sbomSubjectChecksums,
  });
  assert.deepEqual(second, first);
});

test("rejects undeclared final files and malformed or empty SBOMs", async (t) => {
  const extra = await fixture(t);
  await writeFile(path.join(extra.assets, "unexpected.txt"), "unexpected");
  await assert.rejects(
    finalizeReleaseAssets(extra.assets, extra.inventoryPath, {
      projectRoot: extra.root,
      sbomSubjectChecksums: extra.sbomSubjectChecksums,
    }),
    /final release assets mismatch/u,
  );

  const malformed = await fixture(t);
  await writeFile(path.join(malformed.assets, releaseSbomName), "{}\n");
  await assert.rejects(
    finalizeReleaseAssets(malformed.assets, malformed.inventoryPath, {
      projectRoot: malformed.root,
      sbomSubjectChecksums: malformed.sbomSubjectChecksums,
    }),
    /must be SPDX 2\.3 JSON/u,
  );
});

test("refuses to place internal SBOM subject checksums in public release assets", async (t) => {
  const item = await fixture(t);
  await assert.rejects(
    finalizeReleaseAssets(item.assets, item.inventoryPath, {
      projectRoot: item.root,
      sbomSubjectChecksums: path.join(item.assets, "sbom-subject-checksums.txt"),
    }),
    /must remain outside public release assets/u,
  );
});
