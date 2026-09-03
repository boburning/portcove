import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const releaseLabels = [
  "windows-x86_64",
  "linux-x86_64",
  "macos-x86_64",
  "macos-aarch64",
];
const packageExtensions = new Set([".appimage", ".deb", ".dmg", ".exe", ".msi", ".pkg", ".rpm"]);

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function parseManifest(contents, label) {
  const entries = contents.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    if (!match) throw new Error(`invalid checksum line for ${label}: ${line}`);
    return { sha256: match[1], name: match[2] };
  });
  const names = new Set();
  for (const entry of entries) {
    const normalized = entry.name.toLowerCase();
    if (names.has(normalized)) throw new Error(`duplicate checksum entry for ${label}: ${entry.name}`);
    names.add(normalized);
  }
  return entries;
}

function isPackage(name, label) {
  const lower = name.toLowerCase();
  return lower === `portcove-${label}.zip` || lower === `portcove-${label}.tar.gz`
    || packageExtensions.has(path.extname(lower));
}

export async function reconcileReleaseAssets(inputRoot, outputRoot) {
  const input = path.resolve(inputRoot);
  const output = path.resolve(outputRoot);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (output === path.parse(output).root || contains(output, input) || contains(input, output)) {
    throw new Error("unsafe or overlapping aggregate output path");
  }
  const directories = (await readdir(input, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const expectedDirectories = releaseLabels.map(label => `release-build-${label}`).sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    throw new Error(`release matrix must contain exactly: ${expectedDirectories.join(", ")}`);
  }

  const selected = [];
  const globalNames = new Set();
  for (const label of releaseLabels) {
    const root = path.join(input, `release-build-${label}`);
    const files = await walk(root);
    const manifestName = `SHA256SUMS-${label}.txt`;
    const manifests = files.filter(file => path.basename(file) === manifestName);
    if (manifests.length !== 1) throw new Error(`expected exactly one ${manifestName}`);
    const entries = parseManifest(await readFile(manifests[0], "utf8"), label);
    const packages = files.filter(file => isPackage(path.basename(file), label));
    if (packages.length !== entries.length) {
      throw new Error(`${label} checksum manifest does not cover every distributable package`);
    }
    const cli = entries.filter(entry => {
      const lower = entry.name.toLowerCase();
      return lower === `portcove-${label}.zip` || lower === `portcove-${label}.tar.gz`;
    });
    if (cli.length !== 1) throw new Error(`${label} must contain exactly one CLI archive`);
    for (const entry of entries) {
      const matches = packages.filter(file => path.basename(file).toLowerCase() === entry.name.toLowerCase());
      if (matches.length !== 1) throw new Error(`${label} expected exactly one package named ${entry.name}`);
      const actual = await sha256(matches[0]);
      if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.name}`);
      const normalized = entry.name.toLowerCase();
      if (globalNames.has(normalized)) throw new Error(`duplicate matrix artifact filename: ${entry.name}`);
      globalNames.add(normalized);
      selected.push({ file: matches[0], name: entry.name, sha256: actual });
    }
    selected.push({ file: manifests[0], name: manifestName, sha256: await sha256(manifests[0]) });
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const artifact of selected) await copyFile(artifact.file, path.join(output, artifact.name));
  const aggregate = selected
    .filter(artifact => !artifact.name.startsWith("SHA256SUMS-"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(artifact => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  await writeFile(path.join(output, "SHA256SUMS.txt"), `${aggregate}\n`, "utf8");
  return selected.map(artifact => artifact.name).concat("SHA256SUMS.txt").sort();
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--input", "--output"].includes(name) || !value) {
      throw new Error("usage: reconcile-release-assets.mjs --input PATH --output PATH");
    }
    options[name.slice(2)] = path.resolve(value);
  }
  if (!options.input || !options.output) throw new Error("--input and --output are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const assets = await reconcileReleaseAssets(options.input, options.output);
  console.log(`Reconciled ${assets.length} release assets from all four platform jobs.`);
}
