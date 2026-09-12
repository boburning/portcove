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
  await mkdir(assets, { recursive: true });
  await mkdir(path.dirname(inventoryPath), { recursive: true });
  const packageBytes = Buffer.from("package");
  const filename = "portcove-cli-1.2.3-windows-x86_64.zip";
  await writeFile(path.join(assets, filename), packageBytes);
  await writeFile(path.join(assets, "SHA256SUMS.txt"), `${sha256(packageBytes)}  ${filename}\n`);
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
      packages: [{ filename, bytes: packageBytes.length, sha256: sha256(packageBytes) }],
    })}\n`,
  );
  return { root, assets, inventoryPath, filename };
}

test("binds the generated SPDX SBOM into the public checksum manifest and inventory", async (t) => {
  const item = await fixture(t);
  const first = await finalizeReleaseAssets(item.assets, item.inventoryPath, {
    projectRoot: item.root,
  });
  const manifest = await readFile(path.join(item.assets, "SHA256SUMS.txt"), "utf8");
  assert.match(manifest, new RegExp(`  ${releaseSbomName}\\n`, "u"));
  assert.equal(first.inventory.sbom.filename, releaseSbomName);
  assert.match(first.inventory.sbom.sha256, /^[a-f0-9]{64}$/u);
  const second = await finalizeReleaseAssets(item.assets, item.inventoryPath, {
    projectRoot: item.root,
  });
  assert.deepEqual(second, first);
});

test("rejects undeclared final files and malformed or empty SBOMs", async (t) => {
  const extra = await fixture(t);
  await writeFile(path.join(extra.assets, "unexpected.txt"), "unexpected");
  await assert.rejects(
    finalizeReleaseAssets(extra.assets, extra.inventoryPath, { projectRoot: extra.root }),
    /final release assets mismatch/u,
  );

  const malformed = await fixture(t);
  await writeFile(path.join(malformed.assets, releaseSbomName), "{}\n");
  await assert.rejects(
    finalizeReleaseAssets(malformed.assets, malformed.inventoryPath, {
      projectRoot: malformed.root,
    }),
    /must be SPDX 2\.3 JSON/u,
  );
});
