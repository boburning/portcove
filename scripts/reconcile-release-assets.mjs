import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels as policyReleaseLabels,
  workspaceVersion,
} from "./release-package-policy.mjs";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`release matrix contains a symbolic link: ${entryPath}`);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function parseManifest(contents, label) {
  const entries = contents
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
      if (!match)
        throw new Error(`invalid checksum line for ${label}: ${line}`);
      return { sha256: match[1], name: match[2] };
    });
  const names = new Set();
  for (const entry of entries) {
    const normalized = entry.name.toLowerCase();
    if (names.has(normalized))
      throw new Error(`duplicate checksum entry for ${label}: ${entry.name}`);
    names.add(normalized);
  }
  return entries;
}

export async function reconcileReleaseAssets(
  inputRoot,
  outputRoot,
  options = {},
) {
  const input = path.resolve(inputRoot);
  const output = path.resolve(outputRoot);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  if (
    output === path.parse(output).root ||
    contains(output, input) ||
    contains(input, output)
  ) {
    throw new Error("unsafe or overlapping aggregate output path");
  }
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const inventoryPath = options.inventoryPath
    ? path.resolve(options.inventoryPath)
    : null;
  await assertOwnedUnlinkedPath(projectRoot, input, "release matrix input");
  await assertOwnedUnlinkedPath(
    projectRoot,
    output,
    "release aggregate output",
  );
  if (inventoryPath)
    await assertOwnedUnlinkedPath(
      projectRoot,
      inventoryPath,
      "release inventory output",
    );
  if (inventoryPath && contains(output, inventoryPath)) {
    throw new Error(
      "release inventory must remain outside the public asset directory",
    );
  }
  const policy = options.policy ?? (await loadPackagePolicy(projectRoot));
  const version = options.version ?? (await workspaceVersion(projectRoot));
  const tag = options.tag ?? `v${version}`;
  if (tag !== `v${version}`)
    throw new Error(`release tag ${tag} must exactly match v${version}`);
  const releaseLabels = policyReleaseLabels(policy);
  const directories = (await readdir(input, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedDirectories = releaseLabels
    .map((label) => `release-build-${label}`)
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    throw new Error(
      `release matrix must contain exactly: ${expectedDirectories.join(", ")}`,
    );
  }

  const selected = [];
  const globalNames = new Set();
  for (const label of releaseLabels) {
    const root = path.join(input, `release-build-${label}`);
    const files = await walk(root);
    for (const file of files) {
      const parts = path.relative(root, file).split(path.sep);
      const supportedLayout =
        parts.length === 1 ||
        (parts.length === 2 && parts[0] === "release-upload");
      if (!supportedLayout)
        throw new Error(
          `${label} contains an unexpected staged path: ${path.relative(root, file)}`,
        );
    }
    const manifestName = `SHA256SUMS-${label}.txt`;
    const manifests = files.filter(
      (file) => path.basename(file) === manifestName,
    );
    if (manifests.length !== 1)
      throw new Error(`expected exactly one ${manifestName}`);
    const entries = parseManifest(await readFile(manifests[0], "utf8"), label);
    const expectedEntries = packagesForPlatform(policy, label);
    const expectedNames = expectedEntries.map((entry) =>
      artifactName(entry, version),
    );
    assertExactArtifactNames(
      expectedNames,
      entries.map((entry) => entry.name),
      `${label} checksum entries`,
    );
    assertExactArtifactNames(
      [...expectedNames, manifestName],
      files.map((file) => path.basename(file)),
      `${label} staged files`,
    );
    for (const entry of entries) {
      const matches = files.filter(
        (file) => path.basename(file) === entry.name,
      );
      if (matches.length !== 1)
        throw new Error(
          `${label} expected exactly one package named ${entry.name}`,
        );
      const actual = await sha256(matches[0]);
      if (actual !== entry.sha256)
        throw new Error(`checksum mismatch for ${entry.name}`);
      const normalized = entry.name.toLowerCase();
      if (globalNames.has(normalized))
        throw new Error(`duplicate matrix artifact filename: ${entry.name}`);
      globalNames.add(normalized);
      const definition = expectedEntries.find(
        (item) => artifactName(item, version) === entry.name,
      );
      selected.push({
        ...definition,
        file: matches[0],
        filename: entry.name,
        bytes: (await stat(matches[0])).size,
        sha256: actual,
      });
    }
  }

  await assertOwnedUnlinkedPath(
    projectRoot,
    output,
    "release aggregate output",
  );
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await assertOwnedUnlinkedPath(
    projectRoot,
    output,
    "release aggregate output",
  );
  for (const artifact of selected)
    await copyFile(artifact.file, path.join(output, artifact.filename));
  const aggregate = selected
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
    .join("\n");
  await writeFile(
    path.join(output, policy.checksum_manifest),
    `${aggregate}\n`,
    "utf8",
  );
  const inventory = {
    schema_version: 1,
    repository: policy.repository,
    version,
    tag,
    checksum_manifest: policy.checksum_manifest,
    packages: policy.packages.map((definition) => {
      const artifact = selected.find((item) => item.id === definition.id);
      if (!artifact)
        throw new Error(`validated inventory is missing ${definition.id}`);
      return {
        id: definition.id,
        interface: definition.interface,
        platform_label: definition.platform_label,
        os: definition.os,
        architecture: definition.architecture,
        format: definition.format,
        format_label: definition.format_label,
        display_label: definition.display_label,
        experimental: definition.experimental,
        filename: artifact.filename,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        download_url: `https://github.com/${policy.repository}/releases/download/${tag}/${artifact.filename}`,
      };
    }),
    checksum_url: `https://github.com/${policy.repository}/releases/download/${tag}/${policy.checksum_manifest}`,
  };
  if (inventoryPath) {
    await assertOwnedUnlinkedPath(
      projectRoot,
      inventoryPath,
      "release inventory output",
    );
    await mkdir(path.dirname(inventoryPath), { recursive: true });
    await assertOwnedUnlinkedPath(
      projectRoot,
      inventoryPath,
      "release inventory output",
    );
    await writeFile(
      inventoryPath,
      `${JSON.stringify(inventory, null, 2)}\n`,
      "utf8",
    );
  }
  return {
    assets: selected
      .map((artifact) => artifact.filename)
      .concat(policy.checksum_manifest)
      .sort(),
    inventory,
  };
}

function parseArguments(argv) {
  const options = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--input",
        "--output",
        "--project-root",
        "--version",
        "--tag",
        "--inventory",
      ].includes(name) ||
      !value
    ) {
      throw new Error(
        "usage: reconcile-release-assets.mjs --input PATH --output PATH [--version VERSION] [--tag TAG] [--inventory PATH]",
      );
    }
    if (
      ["--input", "--output", "--project-root", "--inventory"].includes(name)
    ) {
      const key =
        name === "--project-root"
          ? "projectRoot"
          : name === "--inventory"
            ? "inventoryPath"
            : name.slice(2);
      options[key] = path.resolve(value);
    } else {
      options[name.slice(2)] = value;
    }
  }
  if (!options.input || !options.output)
    throw new Error("--input and --output are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const result = await reconcileReleaseAssets(
    options.input,
    options.output,
    options,
  );
  console.log(
    `Reconciled ${result.assets.length} public release assets from all four platform jobs.`,
  );
}
