import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mjs";
import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
  packagesForPlatform,
} from "./release-package-policy.mjs";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";
import { updaterIdentity } from "./updater-artifact-inventory.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));
const limits = Object.freeze({
  descriptor: 1024 * 1024,
  eligibility: 256 * 1024,
  inventory: 64 * 1024,
  signature: 16 * 1024,
  output: 8 * 1024 * 1024,
  sources: 256,
  payload: 2 * 1024 * 1024 * 1024,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, required, optional, label) {
  object(value, label);
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

function boundedText(value, label, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function identity(value, label) {
  boundedText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label} is unsafe`);
  return value;
}

function hex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value))
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters`);
  return value;
}

function targetPath(value, label) {
  boundedText(value, label);
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (segment) =>
          !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._+-]+$/.test(segment),
      )
  )
    throw new Error(`${label} is unsafe`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function range(value, label) {
  exactKeys(value, ["min", "max"], [], label);
  positiveInteger(value.min, `${label} minimum`);
  positiveInteger(value.max, `${label} maximum`);
  if (value.max < value.min) throw new Error(`${label} is inverted`);
  return value;
}

function uniqueArray(value, label, validate, maximum = 32, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new Error(`${label} must be a bounded array`);
  value.forEach((entry) => validate(entry));
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function compatibility(value) {
  exactKeys(
    value,
    ["minimum_os_version", "required_capabilities", "cli_protocol", "catalog_formats", "library"],
    [],
    "compatibility",
  );
  compareApplicationVersionPrecedence(value.minimum_os_version, value.minimum_os_version);
  uniqueArray(
    value.required_capabilities,
    "required capabilities",
    (entry) => identity(entry, "required capability"),
    64,
    0,
  );
  range(value.cli_protocol, "CLI protocol range");
  uniqueArray(
    value.catalog_formats,
    "catalog formats",
    (entry) => positiveInteger(entry, "catalog format"),
    16,
  );
  exactKeys(value.library, ["read", "write_schema", "lock_protocol"], [], "library contract");
  range(value.library.read, "library read range");
  positiveInteger(value.library.write_schema, "library write schema");
  identity(value.library.lock_protocol, "library lock protocol");
  return value;
}

function canonicalCompatibility(value) {
  return {
    minimum_os_version: value.minimum_os_version,
    required_capabilities: [...value.required_capabilities].sort(),
    cli_protocol: { min: value.cli_protocol.min, max: value.cli_protocol.max },
    catalog_formats: [...value.catalog_formats].sort((left, right) => left - right),
    library: {
      read: { min: value.library.read.min, max: value.library.read.max },
      write_schema: value.library.write_schema,
      lock_protocol: value.library.lock_protocol,
    },
  };
}

function validateArtifact(entry, label) {
  boundedText(entry.filename, `${label} filename`);
  if (entry.filename !== path.basename(entry.filename) || /[\\/]/.test(entry.filename))
    throw new Error(`${label} filename is unsafe`);
  positiveInteger(entry.bytes, `${label} byte length`);
  if (entry.bytes > limits.payload) throw new Error(`${label} exceeds the payload limit`);
  hex(entry.sha256, 64, `${label} SHA-256`);
}

function validateInventory(inventory, policy) {
  exactKeys(
    inventory,
    [
      "schema_version",
      "repository",
      "version",
      "source_commit",
      "platform_label",
      "application_identifier",
      "packages",
      "updater",
    ],
    [],
    "updater inventory",
  );
  if (inventory.schema_version !== 1 || inventory.repository !== policy.repository)
    throw new Error("updater inventory authority mismatch");
  classifyApplicationVersion(inventory.version);
  hex(inventory.source_commit, 40, "inventory source commit");
  if (inventory.application_identifier !== "io.github.portcove.portcove")
    throw new Error("application identifier mismatch");
  const expected = updaterIdentity(policy, inventory.platform_label, inventory.version);
  const definitions = packagesForPlatform(policy, inventory.platform_label);
  if (!Array.isArray(inventory.packages)) throw new Error("updater inventory packages are invalid");
  assertExactArtifactNames(
    definitions.map((entry) => entry.id),
    inventory.packages.map((entry) => entry?.id),
    "updater inventory package identities",
  );
  for (const entry of inventory.packages) {
    exactKeys(entry, ["id", "filename", "bytes", "sha256"], [], "inventory package");
    const definition = definitions.find((candidate) => candidate.id === entry.id);
    if (entry.filename !== artifactName(definition, inventory.version))
      throw new Error("updater inventory package filename mismatch");
    validateArtifact(
      { filename: entry.filename, bytes: entry.bytes, sha256: entry.sha256 },
      `inventory package ${entry.id}`,
    );
  }
  exactKeys(
    inventory.updater,
    ["id", "target", "format", "filename", "bytes", "sha256", "signature", "public_key_sha256"],
    [],
    "updater payload",
  );
  for (const field of ["id", "target", "format", "filename"]) {
    if (inventory.updater[field] !== expected[field]) throw new Error(`updater ${field} mismatch`);
  }
  validateArtifact(inventory.updater, "updater payload");
  exactKeys(inventory.updater.signature, ["filename", "bytes", "sha256"], [], "updater signature");
  validateArtifact(inventory.updater.signature, "updater signature");
  if (inventory.updater.signature.filename !== `${inventory.updater.filename}.sig`)
    throw new Error("updater signature filename mismatch");
  hex(inventory.updater.public_key_sha256, 64, "updater public-key SHA-256");
  return expected;
}

function validateSource(source, policy) {
  exactKeys(
    source,
    [
      "inventoryBytes",
      "signatureBytes",
      "source_tree",
      "qualified_run",
      "execution_context",
      "compatibility",
      "evidence_ids",
    ],
    [],
    "qualified release source",
  );
  if (!Buffer.isBuffer(source.inventoryBytes) || source.inventoryBytes.length > limits.inventory)
    throw new Error("updater inventory bytes are missing or oversized");
  if (!Buffer.isBuffer(source.signatureBytes) || source.signatureBytes.length > limits.signature)
    throw new Error("updater signature bytes are missing or oversized");
  let inventory;
  try {
    inventory = JSON.parse(source.inventoryBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`updater inventory is malformed: ${error.message}`);
  }
  const expected = validateInventory(inventory, policy);
  if (
    source.signatureBytes.length !== inventory.updater.signature.bytes ||
    sha256(source.signatureBytes) !== inventory.updater.signature.sha256
  )
    throw new Error("updater signature does not match the qualified inventory");
  const rawSignature = source.signatureBytes.toString("utf8");
  const signature = rawSignature.replace(/\r?\n$/, "");
  if (rawSignature !== signature && !rawSignature.endsWith("\n"))
    throw new Error("Tauri updater signature has invalid trailing bytes");
  if (signature.includes("\uFFFD")) throw new Error("Tauri updater signature is not UTF-8");
  boundedText(signature, "Tauri updater signature", limits.signature);
  hex(source.source_tree, 40, "source tree");
  exactKeys(
    source.qualified_run,
    ["workflow", "workflow_commit", "run_id", "attempt"],
    [],
    "qualified run",
  );
  boundedText(source.qualified_run.workflow, "qualified workflow");
  hex(source.qualified_run.workflow_commit, 40, "qualified workflow commit");
  positiveInteger(source.qualified_run.run_id, "qualified run ID");
  positiveInteger(source.qualified_run.attempt, "qualified run attempt");
  identity(source.execution_context, "execution context");
  compatibility(source.compatibility);
  uniqueArray(source.evidence_ids, "evidence IDs", (entry) => boundedText(entry, "evidence ID"));
  return { inventory, expected, signature };
}

function validateEligibility(evidence, version, sourceTargets) {
  exactKeys(
    evidence,
    ["version", "preview_eligible", "production_eligible", "targets"],
    ["held", "withdrawn", "reason", "bridges"],
    `eligibility for v${version}`,
  );
  if (evidence.version !== version) throw new Error(`eligibility version mismatch for v${version}`);
  for (const field of ["preview_eligible", "production_eligible"]) {
    if (typeof evidence[field] !== "boolean") throw new Error(`${field} must be boolean`);
  }
  for (const field of ["held", "withdrawn"]) {
    if (evidence[field] !== undefined && typeof evidence[field] !== "boolean")
      throw new Error(`${field} must be boolean`);
  }
  if (evidence.production_eligible && !evidence.preview_eligible)
    throw new Error("production eligibility requires Preview eligibility");
  if (evidence.held && evidence.withdrawn)
    throw new Error("an eligibility record cannot be both held and withdrawn");
  classifyApplicationVersion(version, evidence.production_eligible);
  uniqueArray(evidence.targets, "eligibility targets", (entry) => identity(entry, "target"), 16);
  for (const target of evidence.targets) {
    if (!sourceTargets.has(target))
      throw new Error(`eligibility names unavailable target ${target}`);
  }
  const active = evidence.preview_eligible && !evidence.held && !evidence.withdrawn;
  if (!active) boundedText(evidence.reason, "inactive eligibility reason", 512);
  if (evidence.reason !== undefined) boundedText(evidence.reason, "eligibility reason", 512);
  const bridges = evidence.bridges ?? {};
  object(bridges, "eligibility bridges");
  for (const [target, bridge] of Object.entries(bridges)) {
    if (!evidence.targets.includes(target))
      throw new Error(`bridge names unavailable target ${target}`);
    exactKeys(bridge, ["path", "sha256"], [], `bridge for ${target}`);
    targetPath(bridge.path, "bridge path");
    hex(bridge.sha256, 64, "bridge SHA-256");
  }
  return evidence;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addFile(files, file, bytes) {
  if (files.has(file)) throw new Error(`duplicate reconstructed target path: ${file}`);
  files.set(file, bytes);
}

export async function reconstructApplicationUpdateRecords(sources, eligibility, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > limits.sources)
    throw new Error("qualified release sources must be a bounded nonempty array");
  object(eligibility, "eligibility evidence");
  const policy = options.policy ?? (await loadPackagePolicy(options.projectRoot));
  const parsed = sources.map((source) => ({ source, ...validateSource(source, policy) }));
  const sourceTargetsByVersion = new Map();
  const authorityByVersion = new Map();
  for (const entry of parsed) {
    const targets = sourceTargetsByVersion.get(entry.inventory.version) ?? new Set();
    targets.add(entry.inventory.platform_label);
    sourceTargetsByVersion.set(entry.inventory.version, targets);
    const authority = JSON.stringify({
      source_commit: entry.inventory.source_commit,
      source_tree: entry.source.source_tree,
      workflow: entry.source.qualified_run.workflow,
      workflow_commit: entry.source.qualified_run.workflow_commit,
      run_id: entry.source.qualified_run.run_id,
      attempt: entry.source.qualified_run.attempt,
    });
    const expectedAuthority = authorityByVersion.get(entry.inventory.version);
    if (expectedAuthority !== undefined && expectedAuthority !== authority)
      throw new Error(
        `v${entry.inventory.version} inventories span multiple source or qualified-run identities`,
      );
    authorityByVersion.set(entry.inventory.version, authority);
  }
  for (const [version, targets] of sourceTargetsByVersion) {
    const evidence = eligibility[`v${version}`];
    if (!evidence) throw new Error(`missing eligibility evidence for v${version}`);
    validateEligibility(evidence, version, targets);
  }
  const expectedEligibilityKeys = new Set(
    [...sourceTargetsByVersion.keys()].map((version) => `v${version}`),
  );
  for (const key of Object.keys(eligibility)) {
    if (!expectedEligibilityKeys.has(key))
      throw new Error(`eligibility has no qualified inventory: ${key}`);
  }
  parsed.sort((left, right) => {
    const target = left.inventory.updater.target.localeCompare(right.inventory.updater.target);
    if (target) return target;
    const packageOrder = left.inventory.updater.format.localeCompare(
      right.inventory.updater.format,
    );
    if (packageOrder) return packageOrder;
    return compareApplicationVersionPrecedence(left.inventory.version, right.inventory.version);
  });
  for (let index = 1; index < parsed.length; index += 1) {
    const left = parsed[index - 1].inventory;
    const right = parsed[index].inventory;
    if (
      left.updater.target === right.updater.target &&
      left.updater.format === right.updater.format &&
      compareApplicationVersionPrecedence(left.version, right.version) === 0
    )
      throw new Error("qualified inventories contain duplicate SemVer precedence");
  }

  const files = new Map();
  const records = [];
  for (const entry of parsed) {
    const { source, inventory, signature } = entry;
    const releasePath = `releases/${inventory.version}/${inventory.updater.target}/${inventory.updater.format}.json`;
    const release = {
      schema_version: 1,
      version: inventory.version,
      source_commit: inventory.source_commit,
      source_tree: source.source_tree,
      qualified_run: {
        workflow: source.qualified_run.workflow,
        workflow_commit: source.qualified_run.workflow_commit,
        run_id: source.qualified_run.run_id,
        attempt: source.qualified_run.attempt,
        inventory_sha256: sha256(source.inventoryBytes),
      },
      target: inventory.updater.target,
      os: packagesForPlatform(policy, inventory.platform_label)[0].os,
      architecture: packagesForPlatform(policy, inventory.platform_label)[0].architecture,
      execution_context: source.execution_context,
      package: {
        kind: inventory.updater.format,
        owner: "portcove",
        product_id: inventory.application_identifier,
      },
      artifact: {
        url: `https://github.com/${inventory.repository}/releases/download/v${inventory.version}/${inventory.updater.filename}`,
        sha256: inventory.updater.sha256,
        bytes: inventory.updater.bytes,
        tauri_signature: signature,
        payload_key_id: inventory.updater.public_key_sha256,
      },
      compatibility: canonicalCompatibility(source.compatibility),
      evidence_ids: [...source.evidence_ids].sort(),
    };
    const releaseBytes = jsonBytes(release);
    addFile(files, releasePath, releaseBytes);
    records.push({
      kind: "release",
      path: releasePath,
      version: inventory.version,
      target: inventory.updater.target,
      package: inventory.updater.format,
      bytes: releaseBytes.length,
      sha256: sha256(releaseBytes),
    });

    const evidence = eligibility[`v${inventory.version}`];
    if (!evidence.targets.includes(inventory.platform_label)) continue;
    for (const channel of ["preview", "stable"]) {
      if (channel === "stable" && !evidence.production_eligible) continue;
      const channelEligible =
        (channel === "preview" ? evidence.preview_eligible : evidence.production_eligible) &&
        !evidence.held &&
        !evidence.withdrawn;
      const promotion = {
        schema_version: 1,
        channel,
        target: inventory.updater.target,
        package: inventory.updater.format,
        version: inventory.version,
        release_path: releasePath,
        release_sha256: sha256(releaseBytes),
        eligible: channelEligible,
        production_eligible: evidence.production_eligible,
        withdrawn: evidence.withdrawn ?? false,
        reason: channelEligible ? (evidence.reason ?? null) : evidence.reason,
        required_bridge: evidence.bridges?.[inventory.platform_label]
          ? {
              path: evidence.bridges[inventory.platform_label].path,
              sha256: evidence.bridges[inventory.platform_label].sha256,
            }
          : null,
      };
      const promotionPath = `channels/${channel}/${inventory.updater.target}/${inventory.updater.format}/${inventory.version}.json`;
      const promotionBytes = jsonBytes(promotion);
      addFile(files, promotionPath, promotionBytes);
      records.push({
        kind: "promotion",
        channel,
        path: promotionPath,
        version: inventory.version,
        target: inventory.updater.target,
        package: inventory.updater.format,
        bytes: promotionBytes.length,
        sha256: sha256(promotionBytes),
      });
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = { schema_version: 1, records };
  const manifestBytes = jsonBytes(manifest);
  const total = [...files.values()].reduce(
    (sum, bytes) => sum + bytes.length,
    manifestBytes.length,
  );
  if (total > limits.output) throw new Error("reconstructed metadata exceeds its total limit");
  files.set("reconstruction-manifest.json", manifestBytes);
  return { files, manifest };
}

async function walkFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`reconstruction output contains a link: ${relative}`);
    if (entry.isDirectory()) files.push(...(await walkFiles(entryPath, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`reconstruction output contains an unsupported entry: ${relative}`);
  }
  return files.sort();
}

async function exists(value) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeApplicationUpdateReconstruction(
  outputPath,
  reconstruction,
  options = {},
) {
  if (!(reconstruction?.files instanceof Map) || reconstruction.files.size === 0)
    throw new Error("reconstruction files must be a nonempty map");
  for (const [relative, bytes] of reconstruction.files) {
    targetPath(relative, "reconstruction target path");
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw new Error(`reconstruction target bytes are invalid: ${relative}`);
  }
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const output = await assertOwnedUnlinkedPath(projectRoot, outputPath, "reconstruction output");
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  const currentExists = await exists(output);
  if (currentExists) {
    const metadata = await lstat(output);
    if (!metadata.isDirectory()) throw new Error("reconstruction output is not a directory");
    const currentFiles = await walkFiles(output);
    for (const relative of currentFiles.filter((file) => file.startsWith("releases/"))) {
      const expected = reconstruction.files.get(relative);
      if (!expected)
        throw new Error(`complete reconstruction omitted immutable record ${relative}`);
      const actual = await readFile(path.join(output, ...relative.split("/")));
      if (!actual.equals(expected))
        throw new Error(`immutable release record changed: ${relative}`);
    }
    const expectedFiles = [...reconstruction.files.keys()].sort();
    if (
      JSON.stringify(currentFiles) === JSON.stringify(expectedFiles) &&
      (
        await Promise.all(
          expectedFiles.map(async (relative) =>
            (await readFile(path.join(output, ...relative.split("/")))).equals(
              reconstruction.files.get(relative),
            ),
          ),
        )
      ).every(Boolean)
    )
      return { changed: false, output };
  }

  const nonce = `${process.pid}-${randomUUID()}`;
  const temporary = `${output}.new-${nonce}`;
  const previous = `${output}.previous-${nonce}`;
  await assertOwnedUnlinkedPath(projectRoot, temporary, "temporary reconstruction output");
  await assertOwnedUnlinkedPath(projectRoot, previous, "previous reconstruction output");
  await mkdir(temporary);
  try {
    for (const [relative, bytes] of [...reconstruction.files].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const destination = path.join(temporary, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    if (currentExists) await rename(output, previous);
    try {
      await rename(temporary, output);
    } catch (error) {
      if (currentExists && (await exists(previous))) await rename(previous, output);
      throw error;
    }
    if (currentExists) await rm(previous, { recursive: true });
    return { changed: true, output };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readBounded(file, maximum, label) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
    throw new Error(`${label} is missing or oversized`);
  return readFile(file);
}

async function loadSources(projectRoot, descriptorPath) {
  const descriptorFile = await assertOwnedUnlinkedPath(
    projectRoot,
    descriptorPath,
    "source descriptor",
  );
  const descriptorBytes = await readBounded(descriptorFile, limits.descriptor, "source descriptor");
  const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
  exactKeys(descriptor, ["schema_version", "releases"], [], "source descriptor");
  if (
    descriptor.schema_version !== 1 ||
    !Array.isArray(descriptor.releases) ||
    descriptor.releases.length === 0 ||
    descriptor.releases.length > limits.sources
  )
    throw new Error("source descriptor schema mismatch");
  const base = path.dirname(descriptorFile);
  const inputPaths = [descriptorFile];
  const sources = await Promise.all(
    descriptor.releases.map(async (entry) => {
      exactKeys(
        entry,
        [
          "inventory",
          "signature",
          "source_tree",
          "qualified_run",
          "execution_context",
          "compatibility",
          "evidence_ids",
        ],
        [],
        "source descriptor entry",
      );
      const inventory = await assertOwnedUnlinkedPath(
        projectRoot,
        path.resolve(base, entry.inventory),
        "inventory input",
      );
      const signature = await assertOwnedUnlinkedPath(
        projectRoot,
        path.resolve(base, entry.signature),
        "signature input",
      );
      inputPaths.push(inventory, signature);
      return {
        inventoryBytes: await readBounded(inventory, limits.inventory, "updater inventory"),
        signatureBytes: await readBounded(signature, limits.signature, "updater signature"),
        source_tree: entry.source_tree,
        qualified_run: entry.qualified_run,
        execution_context: entry.execution_context,
        compatibility: entry.compatibility,
        evidence_ids: entry.evidence_ids,
      };
    }),
  );
  return { sources, inputPaths };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function parseArguments(argv) {
  const options = { projectRoot: defaultProjectRoot };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--project-root", "--input", "--eligibility", "--output"].includes(name) || !value)
      throw new Error(
        "usage: reconstruct-application-update-records.mjs --input PATH --eligibility PATH --output PATH [--project-root PATH]",
      );
    if (seen.has(name)) throw new Error(`duplicate ${name}`);
    seen.add(name);
    const key = name === "--project-root" ? "projectRoot" : name.slice(2);
    options[key] = path.resolve(value);
  }
  if (!options.input || !options.eligibility || !options.output)
    throw new Error("input, eligibility and output are required");
  options.projectRoot = path.resolve(options.projectRoot);
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const eligibilityFile = await assertOwnedUnlinkedPath(
    options.projectRoot,
    options.eligibility,
    "eligibility input",
  );
  const eligibility = JSON.parse(
    (await readBounded(eligibilityFile, limits.eligibility, "eligibility input")).toString("utf8"),
  );
  const { sources, inputPaths } = await loadSources(options.projectRoot, options.input);
  for (const input of [eligibilityFile, ...inputPaths]) {
    if (contains(options.output, input) || contains(input, options.output))
      throw new Error("reconstruction output must not overlap an input path");
  }
  const reconstruction = await reconstructApplicationUpdateRecords(sources, eligibility, options);
  const result = await writeApplicationUpdateReconstruction(
    options.output,
    reconstruction,
    options,
  );
  console.log(
    `${result.changed ? "Reconstructed" : "Verified"} ${reconstruction.manifest.records.length} application update records.`,
  );
}
