import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
  packagesForPlatform,
  workspaceVersion,
} from "./release-package-policy.mjs";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const desktopPackageExtensions = new Set([
  ".appimage",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".pkg",
  ".rpm",
]);

function isDesktopPackage(filePath) {
  return desktopPackageExtensions.has(path.extname(filePath).toLowerCase());
}

async function collectDesktopPackages(projectRoot, bundleRoot, expectedEntries) {
  const packages = [];
  const formats = [
    ...new Set(
      expectedEntries.filter((entry) => entry.interface === "desktop").map((entry) => entry.format),
    ),
  ];
  for (const format of formats) {
    const formatRoot = path.join(bundleRoot, format);
    await assertOwnedUnlinkedPath(projectRoot, formatRoot, `release ${format} bundle directory`);
    for (const entry of await readdir(formatRoot, { withFileTypes: true })) {
      const entryPath = path.join(formatRoot, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`release package is a symbolic link: ${entryPath}`);
      if (entry.isFile() && isDesktopPackage(entryPath)) packages.push(entryPath);
    }
  }
  return packages;
}

function validateLabel(label) {
  if (!label?.match(/^[a-z0-9][a-z0-9._-]*$/i)) {
    throw new Error(`invalid release platform label: ${label ?? "missing"}`);
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function validateStageRoot(projectRoot, stageRoot) {
  const project = path.resolve(projectRoot);
  const stage = path.resolve(stageRoot);
  const sourceRoots = [
    path.join(project, "release-assets"),
    path.join(project, "target", "release", "bundle"),
  ];
  if (stage === path.parse(stage).root || stage === project || !contains(project, stage)) {
    throw new Error("release staging path must be a child directory inside the project");
  }
  if (sourceRoots.some((source) => contains(source, stage) || contains(stage, source))) {
    throw new Error("release staging path must not overlap release inputs");
  }
  return stage;
}

export async function collectReleaseArtifacts(projectRoot, label, requestedVersion) {
  validateLabel(label);
  const policy = await loadPackagePolicy(projectRoot);
  const version = requestedVersion ?? (await workspaceVersion(projectRoot));
  const expectedEntries = packagesForPlatform(policy, label);
  const expectedNames = expectedEntries.map((entry) => artifactName(entry, version));
  const releaseAssets = path.join(projectRoot, "release-assets");
  await assertOwnedUnlinkedPath(projectRoot, releaseAssets, "release CLI asset directory");
  const cliArchives = (await readdir(releaseAssets, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith(".zip") || entry.name.endsWith(".tar.gz")),
    )
    .map((entry) => path.join(releaseAssets, entry.name));

  const bundleRoot = path.join(projectRoot, "target", "release", "bundle");
  await assertOwnedUnlinkedPath(projectRoot, bundleRoot, "release desktop bundle directory");
  const desktopPackages = await collectDesktopPackages(projectRoot, bundleRoot, expectedEntries);
  const artifacts = [...cliArchives, ...desktopPackages];
  assertExactArtifactNames(
    expectedNames,
    artifacts.map((artifact) => path.basename(artifact)),
    `${label} package set`,
  );
  return artifacts.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeReleaseChecksums(projectRoot, label, requestedVersion) {
  const artifacts = await collectReleaseArtifacts(projectRoot, label, requestedVersion);
  const lines = [];
  for (const artifact of artifacts) {
    lines.push(`${await sha256(artifact)}  ${path.basename(artifact)}`);
  }
  const output = path.join(projectRoot, "release-assets", `SHA256SUMS-${label}.txt`);
  await assertOwnedUnlinkedPath(projectRoot, output, "release checksum output");
  await writeFile(output, `${lines.join("\n")}\n`, "utf8");
  return { artifacts, output };
}

export async function stageReleaseArtifacts(projectRoot, label, stageRoot, requestedVersion) {
  const stage = validateStageRoot(projectRoot, stageRoot);
  await assertOwnedUnlinkedPath(projectRoot, stage, "release staging output");
  const result = await writeReleaseChecksums(projectRoot, label, requestedVersion);
  await assertOwnedUnlinkedPath(projectRoot, stage, "release staging output");
  await mkdir(stage);
  await assertOwnedUnlinkedPath(projectRoot, stage, "release staging output");
  const sources = [...result.artifacts, result.output];
  for (const source of sources) await copyFile(source, path.join(stage, path.basename(source)));
  return {
    ...result,
    staged: sources.map((source) => path.join(stage, path.basename(source))),
  };
}

function parseArguments(argv) {
  const options = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--label", "--project-root", "--stage-dir", "--version"].includes(name))
      throw new Error(`unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--label") options.label = value;
    else if (name === "--project-root") options.projectRoot = path.resolve(value);
    else if (name === "--stage-dir") options.stageRoot = path.resolve(value);
    else options.version = value;
    index += 1;
  }
  return options;
}

async function main() {
  const { projectRoot, label, stageRoot, version } = parseArguments(process.argv.slice(2));
  if (stageRoot) {
    const { artifacts, output, staged } = await stageReleaseArtifacts(
      projectRoot,
      label,
      stageRoot,
      version,
    );
    console.log(
      `Wrote ${path.basename(output)} for ${artifacts.length} release artifacts and staged ${staged.length} files.`,
    );
  } else {
    const { artifacts, output } = await writeReleaseChecksums(projectRoot, label, version);
    console.log(`Wrote ${path.basename(output)} for ${artifacts.length} release artifacts.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
