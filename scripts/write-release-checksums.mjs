import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const packageExtensions = new Set([".appimage", ".deb", ".dmg", ".exe", ".msi", ".pkg", ".rpm"]);

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function isDesktopPackage(filePath) {
  return packageExtensions.has(path.extname(filePath).toLowerCase());
}

function validateLabel(label) {
  if (!label?.match(/^[a-z0-9][a-z0-9._-]*$/i)) {
    throw new Error(`invalid release platform label: ${label ?? "missing"}`);
  }
}

export async function collectReleaseArtifacts(projectRoot, label) {
  validateLabel(label);
  const releaseAssets = path.join(projectRoot, "release-assets");
  const cliBase = `portcove-${label}`;
  const cliArchives = (await readdir(releaseAssets, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (
      entry.name === `${cliBase}.zip` || entry.name === `${cliBase}.tar.gz`
    ))
    .map(entry => path.join(releaseAssets, entry.name));
  if (cliArchives.length !== 1) {
    throw new Error(`expected exactly one CLI archive for ${label}; found ${cliArchives.length}`);
  }

  const bundleRoot = path.join(projectRoot, "target", "release", "bundle");
  const desktopPackages = (await walkFiles(bundleRoot)).filter(isDesktopPackage);
  if (!desktopPackages.length) {
    throw new Error(`expected at least one desktop package under ${bundleRoot}`);
  }

  const artifacts = [...cliArchives, ...desktopPackages];
  const names = new Map();
  for (const artifact of artifacts) {
    const name = path.basename(artifact);
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new Error(`release artifacts contain duplicate filename: ${name}`);
    }
    names.set(normalized, artifact);
  }
  return artifacts.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeReleaseChecksums(projectRoot, label) {
  const artifacts = await collectReleaseArtifacts(projectRoot, label);
  const lines = [];
  for (const artifact of artifacts) {
    lines.push(`${await sha256(artifact)}  ${path.basename(artifact)}`);
  }
  const output = path.join(projectRoot, "release-assets", `SHA256SUMS-${label}.txt`);
  await writeFile(output, `${lines.join("\n")}\n`, "utf8");
  return { artifacts, output };
}

function parseArguments(argv) {
  const options = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== "--label" && name !== "--project-root") throw new Error(`unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--label") options.label = value;
    else options.projectRoot = path.resolve(value);
    index += 1;
  }
  return options;
}

async function main() {
  const { projectRoot, label } = parseArguments(process.argv.slice(2));
  const { artifacts, output } = await writeReleaseChecksums(projectRoot, label);
  console.log(`Wrote ${path.basename(output)} for ${artifacts.length} release artifacts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
