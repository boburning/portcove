import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertExactArtifactNames } from "./release-package-policy.mjs";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));
export const releaseSbomName = "Portcove-SBOM.spdx.json";

async function identity(file) {
  const contents = await readFile(file);
  return {
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function parseChecksums(contents) {
  return contents
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64}) {2}([^/\\]+)$/u);
      if (!match) throw new Error(`invalid aggregate checksum line: ${line}`);
      return { sha256: match[1], filename: match[2] };
    });
}

function validateSbom(sbom) {
  if (sbom?.spdxVersion !== "SPDX-2.3") throw new Error("release SBOM must be SPDX 2.3 JSON");
  if (sbom.dataLicense !== "CC0-1.0")
    throw new Error("release SBOM must use the SPDX CC0-1.0 data license");
  if (!Array.isArray(sbom.packages) || sbom.packages.length === 0)
    throw new Error("release SBOM must describe at least one package");
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function finalizeReleaseAssets(assetRoot, inventoryFile, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const assets = path.resolve(assetRoot);
  const inventoryPath = path.resolve(inventoryFile);
  const sbomSubjectChecksumsPath = path.resolve(options.sbomSubjectChecksums ?? "");
  if (!options.sbomSubjectChecksums) throw new Error("SBOM subject checksum output is required");
  await assertOwnedUnlinkedPath(projectRoot, assets, "release aggregate assets");
  await assertOwnedUnlinkedPath(projectRoot, inventoryPath, "release inventory");
  await assertOwnedUnlinkedPath(
    projectRoot,
    sbomSubjectChecksumsPath,
    "SBOM subject checksum output",
  );
  if (contains(assets, sbomSubjectChecksumsPath))
    throw new Error("SBOM subject checksum output must remain outside public release assets");
  if (sbomSubjectChecksumsPath === inventoryPath)
    throw new Error("SBOM subject checksum output must not replace the release inventory");

  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (
    inventory?.schema_version !== 1 ||
    !inventory.repository ||
    inventory.tag !== `v${inventory.version}` ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length === 0
  ) {
    throw new Error("release inventory identity is incomplete");
  }
  const entries = await readdir(assets, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()))
    throw new Error("release aggregate must contain ordinary files only");
  const expectedNames = [
    ...inventory.packages.map((entry) => entry.filename),
    inventory.checksum_manifest,
    releaseSbomName,
  ];
  assertExactArtifactNames(
    expectedNames,
    entries.map((entry) => entry.name),
    "final release assets",
  );

  const manifestPath = path.join(assets, inventory.checksum_manifest);
  const checksums = parseChecksums(await readFile(manifestPath, "utf8"));
  const allowedChecksumNames = new Set([
    ...inventory.packages.map((entry) => entry.filename),
    releaseSbomName,
  ]);
  if (checksums.some((entry) => !allowedChecksumNames.has(entry.filename)))
    throw new Error("aggregate checksum manifest contains an undeclared asset");

  const finalIdentities = [];
  for (const entry of inventory.packages) {
    const actual = await identity(path.join(assets, entry.filename));
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
      throw new Error(`release package identity drifted: ${entry.filename}`);
    finalIdentities.push({ filename: entry.filename, ...actual });
  }
  const sbomPath = path.join(assets, releaseSbomName);
  validateSbom(JSON.parse(await readFile(sbomPath, "utf8")));
  const sbomIdentity = await identity(sbomPath);
  finalIdentities.push({ filename: releaseSbomName, ...sbomIdentity });

  const manifest = finalIdentities
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((entry) => `${entry.sha256}  ${entry.filename}`)
    .join("\n");
  await writeFile(manifestPath, `${manifest}\n`, "utf8");
  const sbomSubjects = finalIdentities
    .filter((entry) => inventory.packages.some((item) => item.filename === entry.filename))
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((entry) => `${entry.sha256}  ${entry.filename}`)
    .join("\n");
  await mkdir(path.dirname(sbomSubjectChecksumsPath), { recursive: true });
  await writeFile(sbomSubjectChecksumsPath, `${sbomSubjects}\n`, "utf8");
  inventory.sbom = {
    format: "SPDX-2.3 JSON",
    filename: releaseSbomName,
    ...sbomIdentity,
    download_url: `https://github.com/${inventory.repository}/releases/download/${inventory.tag}/${releaseSbomName}`,
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return { assets: expectedNames.sort(), inventory };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--assets", "--inventory", "--project-root", "--sbom-subject-checksums"].includes(name) ||
      !value
    )
      throw new Error(
        "usage: finalize-release-assets.mjs --assets PATH --inventory PATH --sbom-subject-checksums PATH [--project-root PATH]",
      );
    options[
      name
        .slice(2)
        .replace("project-root", "projectRoot")
        .replace("sbom-subject-checksums", "sbomSubjectChecksums")
    ] = path.resolve(value);
  }
  if (!options.assets || !options.inventory || !options.sbomSubjectChecksums)
    throw new Error("--assets, --inventory and --sbom-subject-checksums are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const result = await finalizeReleaseAssets(options.assets, options.inventory, options);
  console.log(`Finalized ${result.assets.length} public assets with an SPDX SBOM.`);
}
