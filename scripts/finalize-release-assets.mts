import { isRecord } from "./runtime-values.mts";
import type { reconcileReleaseAssets } from "./reconcile-release-assets.mts";
type ReconciledInventory = Awaited<ReturnType<typeof reconcileReleaseAssets>>["inventory"];
type FinalizationInventory = Pick<ReconciledInventory, "schema_version" | "version" | "tag"> & {
  repository: string;
  checksum_manifest: string;
  packages: Pick<ReconciledInventory["packages"][number], "filename" | "bytes" | "sha256">[];
  workflow_producers?: Pick<
    ReconciledInventory["workflow_producers"][number],
    "platform_label" | "revision"
  >[];
};
export interface FinalizeOptions {
  projectRoot?: string;
  sbomSubjectChecksums?: string;
  // The protected caller materializes/authenticates this exact inert prepared
  // source. Storage/policy ownership remains projectRoot; no scanner waiver.
  linuxQualificationRoot?: string;
}

function assertInventory(value: unknown): asserts value is FinalizationInventory {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    typeof value.repository !== "string" ||
    !value.repository ||
    typeof value.version !== "string" ||
    typeof value.tag !== "string" ||
    value.tag !== `v${value.version}` ||
    typeof value.checksum_manifest !== "string" ||
    !Array.isArray(value.packages) ||
    !value.packages.length ||
    !value.packages.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.filename === "string" &&
        typeof entry.bytes === "number" &&
        typeof entry.sha256 === "string",
    ) ||
    (value.workflow_producers !== undefined &&
      (!Array.isArray(value.workflow_producers) ||
        !value.workflow_producers.every(
          (entry: unknown) =>
            isRecord(entry) &&
            typeof entry.platform_label === "string" &&
            typeof entry.revision === "string",
        )))
  ) {
    throw new Error("release inventory identity is incomplete");
  }
}
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertExactArtifactNames } from "./release-package-policy.mts";
import {
  assertOwnedUnlinkedPath,
  releasePathContains as contains,
} from "./release-path-safety.mts";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));
export const releaseSbomName = "Portcove-SBOM.spdx.json";

async function identity(file: string) {
  const contents = await readFile(file);
  return {
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function parseChecksums(contents: string) {
  return contents
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line: string) => {
      const match = line.match(/^([a-f0-9]{64}) {2}([^/\\]+)$/u);
      if (!match || !match[1] || !match[2])
        throw new Error(`invalid aggregate checksum line: ${line}`);
      return { sha256: match[1], filename: match[2] };
    });
}

function validateSbom(sbom: unknown) {
  if (!isRecord(sbom) || sbom.spdxVersion !== "SPDX-2.3")
    throw new Error("release SBOM must be SPDX 2.3 JSON");
  if (sbom.dataLicense !== "CC0-1.0")
    throw new Error("release SBOM must use the SPDX CC0-1.0 data license");
  if (!Array.isArray(sbom.packages) || sbom.packages.length === 0)
    throw new Error("release SBOM must describe at least one package");
}

export async function finalizeReleaseAssets(
  assetRoot: string,
  inventoryFile: string,
  options: FinalizeOptions = {},
) {
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

  const inventory: unknown = JSON.parse(await readFile(inventoryPath, "utf8"));
  assertInventory(inventory);
  if (
    inventory.packages.some((entry) =>
      /(?:\.AppImage$|amd64\.deb$|x86_64\.rpm$)/iu.test(entry.filename),
    )
  ) {
    const { authorizeLinuxRelease } = await import("./linux-beta-risk-706.mts");
    const decision = authorizeLinuxRelease(
      options.linuxQualificationRoot ?? projectRoot,
      inventory.tag,
    );
    if (
      !inventory.workflow_producers?.some(
        (producer) =>
          producer.platform_label === "linux-x86_64" && producer.revision === decision.candidate,
      )
    )
      throw new Error("Linux release assets lack exact authorized source provenance");
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
  const sbom = {
    format: "SPDX-2.3 JSON",
    filename: releaseSbomName,
    ...sbomIdentity,
    download_url: `https://github.com/${inventory.repository}/releases/download/${inventory.tag}/${releaseSbomName}`,
  };
  const finalizedInventory = { ...inventory, sbom };
  await writeFile(inventoryPath, `${JSON.stringify(finalizedInventory, null, 2)}\n`, "utf8");
  return { assets: expectedNames.sort(), inventory: finalizedInventory };
}

function parseArguments(argv: readonly string[]) {
  const options: FinalizeOptions & { assets?: string; inventory?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      !["--assets", "--inventory", "--project-root", "--sbom-subject-checksums"].includes(name) ||
      !value
    )
      throw new Error(
        "usage: finalize-release-assets.mts --assets PATH --inventory PATH --sbom-subject-checksums PATH [--project-root PATH]",
      );
    const key =
      name === "--assets"
        ? "assets"
        : name === "--inventory"
          ? "inventory"
          : name === "--project-root"
            ? "projectRoot"
            : "sbomSubjectChecksums";
    options[key] = path.resolve(value);
  }
  if (!options.assets || !options.inventory || !options.sbomSubjectChecksums)
    throw new Error("--assets, --inventory and --sbom-subject-checksums are required");
  return {
    ...options,
    assets: options.assets,
    inventory: options.inventory,
    sbomSubjectChecksums: options.sbomSubjectChecksums,
  };
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const options = parseArguments(process.argv.slice(2));
    const result = await finalizeReleaseAssets(options.assets, options.inventory, options);
    console.log(`Finalized ${result.assets.length} public assets with an SPDX SBOM.`);
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
