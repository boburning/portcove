import type { ReleasePackagePolicy, ReleasePackageEntry } from "./release-package-policy.mts";
import type { ReleaseProducerLineage } from "./write-release-checksums.mts";
import { isRecord } from "./runtime-values.mts";
export type ReleaseConsumerLineage = Pick<ReleaseProducerLineage, "runId" | "revision"> & {
  maxAttempt: number;
};
export interface ReleaseProducerRecord {
  schema_version: 1;
  platform_label: string;
  version: string;
  run_id: string;
  run_attempt: number;
  revision: string;
}
export interface ReconcileOptions {
  projectRoot?: string;
  inventoryPath?: string;
  policy?: ReleasePackagePolicy;
  version?: string;
  tag?: string;
  lineage?: ReleaseConsumerLineage;
  profile?: import("./release-package-policy.mts").ReleaseProfile;
  artifactLayout?: "staged" | "attempt";
}
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
  packagesForPlatform,
  releaseBuildArtifactName,
  inspectReleaseProfile,
  selectReleasePackagePolicy,
  releaseLabels as policyReleaseLabels,
  workspaceVersion,
} from "./release-package-policy.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`release matrix contains a symbolic link: ${entryPath}`);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export function parseReleaseChecksumManifest(contents: string, label: string) {
  const entries = contents
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line: string) => {
      const match = line.match(/^([a-f0-9]{64}) {2}([^/\\]+)$/);
      if (!match || !match[1] || !match[2])
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

export function inspectReleaseProducer(
  record: unknown,
  label: string,
  version: string,
  lineage: ReleaseConsumerLineage | undefined,
): ReleaseProducerRecord {
  if (
    !isRecord(record) ||
    record.schema_version !== 1 ||
    record.platform_label !== label ||
    record.version !== version ||
    typeof record.run_id !== "string" ||
    !/^\d+$/u.test(record.run_id) ||
    typeof record.run_attempt !== "number" ||
    !Number.isInteger(record.run_attempt) ||
    record.run_attempt < 1 ||
    typeof record.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(record.revision)
  ) {
    throw new Error(`invalid release producer identity for ${label}`);
  }
  if (lineage) {
    if (record.run_id !== lineage.runId) throw new Error(`${label} came from another workflow run`);
    if (record.revision !== lineage.revision)
      throw new Error(`${label} came from another revision`);
    if (record.run_attempt > lineage.maxAttempt)
      throw new Error(`${label} producer attempt is newer than the consumer attempt`);
  }
  return {
    ...record,
    schema_version: 1,
    platform_label: label,
    version,
    run_id: record.run_id,
    run_attempt: record.run_attempt,
    revision: record.revision,
  };
}

export async function reconcileReleaseAssets(
  inputRoot: string,
  outputRoot: string,
  options: ReconcileOptions = {},
) {
  const input = path.resolve(inputRoot);
  const output = path.resolve(outputRoot);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  if (output === path.parse(output).root || contains(output, input) || contains(input, output)) {
    throw new Error("unsafe or overlapping aggregate output path");
  }
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const inventoryPath = options.inventoryPath ? path.resolve(options.inventoryPath) : null;
  await assertOwnedUnlinkedPath(projectRoot, input, "release matrix input");
  await assertOwnedUnlinkedPath(projectRoot, output, "release aggregate output");
  if (inventoryPath)
    await assertOwnedUnlinkedPath(projectRoot, inventoryPath, "release inventory output");
  if (inventoryPath && contains(output, inventoryPath)) {
    throw new Error("release inventory must remain outside the public asset directory");
  }
  const policy =
    options.policy ??
    selectReleasePackagePolicy(await loadPackagePolicy(projectRoot), options.profile);
  const version = options.version ?? (await workspaceVersion(projectRoot));
  const tag = options.tag ?? `v${version}`;
  if (tag !== `v${version}`) throw new Error(`release tag ${tag} must exactly match v${version}`);
  const releaseLabels = policyReleaseLabels(policy);
  const directories = (await readdir(input, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (
    options.artifactLayout !== undefined &&
    !["staged", "attempt"].includes(options.artifactLayout)
  )
    throw new Error("invalid release artifact layout");
  if (options.artifactLayout === "attempt" && !options.lineage)
    throw new Error("attempt artifact layout requires exact consumer lineage");
  const directoryFor = (label: string) =>
    options.artifactLayout === "attempt"
      ? releaseBuildArtifactName(label, options.lineage!.runId, options.lineage!.maxAttempt)
      : `release-build-${label}`;
  const expectedDirectories = releaseLabels.map(directoryFor).sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    throw new Error(`release matrix must contain exactly: ${expectedDirectories.join(", ")}`);
  }

  const selected: (ReleasePackageEntry & { file: string; bytes: number; sha256: string })[] = [];
  const producers: ReleaseProducerRecord[] = [];
  const globalNames = new Set();
  for (const label of releaseLabels) {
    const root = path.join(input, directoryFor(label));
    const files = await walk(root);
    for (const file of files) {
      const parts = path.relative(root, file).split(path.sep);
      const supportedLayout =
        parts.length === 1 || (parts.length === 2 && parts[0] === "release-upload");
      if (!supportedLayout)
        throw new Error(
          `${label} contains an unexpected staged path: ${path.relative(root, file)}`,
        );
    }
    const manifestName = `SHA256SUMS-${label}.txt`;
    const producerName = `release-producer-${label}.json`;
    const manifests = files.filter((file: string) => path.basename(file) === manifestName);
    const manifest = manifests[0];
    if (manifests.length !== 1 || !manifest)
      throw new Error(`expected exactly one ${manifestName}`);
    const entries = parseReleaseChecksumManifest(await readFile(manifest, "utf8"), label);
    const expectedEntries = packagesForPlatform(policy, label);
    const expectedNames = expectedEntries.map((entry) => artifactName(entry, version));
    assertExactArtifactNames(
      expectedNames,
      entries.map((entry) => entry.name),
      `${label} checksum entries`,
    );
    const producerFiles = files.filter((file: string) => path.basename(file) === producerName);
    if (options.lineage && producerFiles.length !== 1)
      throw new Error(`expected exactly one ${producerName}`);
    if (!options.lineage && producerFiles.length > 1)
      throw new Error(`expected at most one ${producerName}`);
    const producerFile = producerFiles[0];
    if (producerFiles.length === 1 && producerFile) {
      const producer = inspectReleaseProducer(
        JSON.parse(await readFile(producerFile, "utf8")),
        label,
        version,
        options.lineage,
      );
      if (
        options.artifactLayout === "attempt" &&
        producer.run_attempt !== options.lineage!.maxAttempt
      )
        throw new Error(`${label} producer attempt differs from artifact identity`);
      producers.push(producer);
    }
    assertExactArtifactNames(
      [...expectedNames, manifestName, ...(producerFiles.length ? [producerName] : [])],
      files.map((file: string) => path.basename(file)),
      `${label} staged files`,
    );
    for (const entry of entries) {
      const matches = files.filter((file: string) => path.basename(file) === entry.name);
      const file = matches[0];
      if (matches.length !== 1 || !file)
        throw new Error(`${label} expected exactly one package named ${entry.name}`);
      const actual = await sha256(file);
      if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.name}`);
      const normalized = entry.name.toLowerCase();
      if (globalNames.has(normalized))
        throw new Error(`duplicate matrix artifact filename: ${entry.name}`);
      globalNames.add(normalized);
      const definition = expectedEntries.find((item) => artifactName(item, version) === entry.name);
      if (!definition) throw new Error(`validated package definition is missing for ${entry.name}`);
      selected.push({
        ...definition,
        file,
        filename: entry.name,
        bytes: (await stat(file)).size,
        sha256: actual,
      });
    }
  }

  await assertOwnedUnlinkedPath(projectRoot, output, "release aggregate output");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await assertOwnedUnlinkedPath(projectRoot, output, "release aggregate output");
  for (const artifact of selected)
    await copyFile(artifact.file, path.join(output, artifact.filename));
  const aggregate = selected
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
    .join("\n");
  await writeFile(path.join(output, policy.checksum_manifest), `${aggregate}\n`, "utf8");
  const inventory = {
    schema_version: 1,
    repository: policy.repository,
    version,
    tag,
    checksum_manifest: policy.checksum_manifest,
    workflow_producers: producers.sort((left, right) =>
      left.platform_label.localeCompare(right.platform_label),
    ),
    packages: policy.packages.map((definition) => {
      const artifact = selected.find((item) => item.id === definition.id);
      if (!artifact) throw new Error(`validated inventory is missing ${definition.id}`);
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
    await assertOwnedUnlinkedPath(projectRoot, inventoryPath, "release inventory output");
    await mkdir(path.dirname(inventoryPath), { recursive: true });
    await assertOwnedUnlinkedPath(projectRoot, inventoryPath, "release inventory output");
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  }
  return {
    assets: selected
      .map((artifact) => artifact.filename)
      .concat(policy.checksum_manifest)
      .sort(),
    inventory,
  };
}

function parseArguments(argv: readonly string[]) {
  const options: ReconcileOptions & {
    input?: string;
    output?: string;
    runId?: string;
    revision?: string;
    maxAttempt?: number;
  } = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      ![
        "--input",
        "--output",
        "--project-root",
        "--version",
        "--tag",
        "--inventory",
        "--run-id",
        "--revision",
        "--max-attempt",
        "--artifact-layout",
        "--profile",
      ].includes(name) ||
      !value
    ) {
      throw new Error(
        "usage: reconcile-release-assets.mts --input PATH --output PATH [--version VERSION] [--tag TAG] [--inventory PATH]",
      );
    }
    if (["--input", "--output", "--project-root", "--inventory"].includes(name)) {
      const key =
        name === "--project-root"
          ? "projectRoot"
          : name === "--inventory"
            ? "inventoryPath"
            : name === "--input"
              ? "input"
              : "output";
      options[key] = path.resolve(value);
    } else if (name === "--run-id") options.runId = value;
    else if (name === "--revision") options.revision = value;
    else if (name === "--max-attempt") options.maxAttempt = Number(value);
    else if (name === "--profile") options.profile = inspectReleaseProfile(value);
    else if (name === "--artifact-layout") {
      if (value !== "attempt" && value !== "staged")
        throw new Error("invalid release artifact layout");
      options.artifactLayout = value;
    } else if (name === "--version") options.version = value;
    else if (name === "--tag") options.tag = value;
  }
  if (!options.input || !options.output) throw new Error("--input and --output are required");
  const lineageValues = [options.runId, options.revision, options.maxAttempt].filter(
    (value) => value !== undefined,
  );
  if (lineageValues.length !== 0 && lineageValues.length !== 3)
    throw new Error("--run-id, --revision and --max-attempt must be supplied together");
  if (lineageValues.length === 3) {
    if (
      typeof options.runId !== "string" ||
      !/^\d+$/u.test(options.runId) ||
      typeof options.revision !== "string" ||
      !/^[a-f0-9]{40}$/u.test(options.revision)
    )
      throw new Error("release consumer lineage is invalid");
    if (
      typeof options.maxAttempt !== "number" ||
      !Number.isInteger(options.maxAttempt) ||
      options.maxAttempt < 1
    )
      throw new Error("release consumer attempt is invalid");
    options.lineage = {
      runId: options.runId,
      revision: options.revision,
      maxAttempt: options.maxAttempt,
    };
  }
  return { ...options, input: options.input, output: options.output };
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const options = parseArguments(process.argv.slice(2));
    const result = await reconcileReleaseAssets(options.input, options.output, options);
    console.log(
      `Reconciled ${result.assets.length} public release assets from all four platform jobs.`,
    );
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
