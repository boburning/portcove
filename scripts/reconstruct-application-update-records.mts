import type { BinaryLike } from "node:crypto";
import type { ReleasePackagePolicy } from "./release-package-policy.mts";
import type { UpdaterInventory } from "./updater-artifact-inventory.mts";
interface ReconstructionOptions {
  policy?: ReleasePackagePolicy;
  projectRoot?: string;
}
interface QualifiedRun {
  workflow: string;
  workflow_commit: string;
  run_id: number;
  attempt: number;
}
interface QualifiedSource {
  inventoryBytes: Buffer;
  signatureBytes: Buffer;
  source_tree: string;
  qualified_run: QualifiedRun;
  execution_context: string;
  compatibility: ReturnType<typeof compatibility>;
  evidence_ids: string[];
}
interface Eligibility {
  version: string;
  preview_eligible: boolean;
  production_eligible: boolean;
  targets: string[];
  held?: boolean;
  withdrawn?: boolean;
  reason?: string;
  bridges?: Record<string, { path: string; sha256: string }>;
}
interface ReconstructionRecord {
  kind: "release" | "promotion";
  channel?: "preview" | "stable";
  path: string;
  version: string;
  target: string;
  package: string;
  bytes: number;
  sha256: string;
}
export interface ApplicationUpdateReconstruction {
  files: Map<string, Buffer>;
  manifest: { schema_version: 1; records: ReconstructionRecord[] };
}
function required<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null)
    throw new Error("Required reconstruction value is missing");
  return value;
}
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mts";
import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
  packagesForPlatform,
} from "./release-package-policy.mts";
import {
  assertOwnedUnlinkedPath,
  releasePathContains as contains,
} from "./release-path-safety.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";

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

function sha256(bytes: BinaryLike) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  object(value, label);
  const keys = new Set(Object.keys(object(value, label)));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

function boundedText(value: unknown, label: string, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} is invalid`);
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${label} is invalid`);
  }
  return value;
}

function identity(input: unknown, label: string) {
  const value = boundedText(input, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label} is unsafe`);
  return value;
}

function hex(value: unknown, length: number, label: string) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value))
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters`);
  return value;
}

function targetPath(input: unknown, label: string) {
  const value = boundedText(input, label);
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

function positiveInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} must be positive`);
  return value;
}

function range(value: unknown, label: string) {
  exactKeys(value, ["min", "max"], [], label);
  const min = positiveInteger(value.min, `${label} minimum`),
    max = positiveInteger(value.max, `${label} maximum`);
  if (max < min) throw new Error(`${label} is inverted`);
  return { min, max };
}
function uniqueArray<Value>(
  value: unknown,
  label: string,
  validate: (entry: unknown) => Value,
  maximum = 32,
  minimum = 1,
): Value[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new Error(`${label} must be a bounded array`);
  const entries: unknown[] = value;
  const validated = entries.map(validate);
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicates`);
  return validated;
}
function compatibility(value: unknown) {
  exactKeys(
    value,
    ["minimum_os_version", "required_capabilities", "cli_protocol", "catalog_formats", "library"],
    [],
    "compatibility",
  );
  const minimum_os_version = boundedText(value.minimum_os_version, "minimum OS version");
  compareApplicationVersionPrecedence(minimum_os_version, minimum_os_version);
  const required_capabilities = uniqueArray(
    value.required_capabilities,
    "required capabilities",
    (entry) => identity(entry, "required capability"),
    64,
    0,
  );
  const cli_protocol = range(value.cli_protocol, "CLI protocol range");
  const catalog_formats = uniqueArray(
    value.catalog_formats,
    "catalog formats",
    (entry) => positiveInteger(entry, "catalog format"),
    16,
  );
  const library = value.library;
  exactKeys(library, ["read", "write_schema", "lock_protocol"], [], "library contract");
  return {
    minimum_os_version,
    required_capabilities,
    cli_protocol,
    catalog_formats,
    library: {
      read: range(library.read, "library read range"),
      write_schema: positiveInteger(library.write_schema, "library write schema"),
      lock_protocol: identity(library.lock_protocol, "library lock protocol"),
    },
  };
}

function canonicalCompatibility(value: ReturnType<typeof compatibility>) {
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

function validateArtifact(value: unknown, label: string) {
  const entry = object(value, label);
  const filename = boundedText(entry.filename, `${label} filename`);
  if (filename !== path.basename(filename) || /[\\/]/.test(filename))
    throw new Error(`${label} filename is unsafe`);
  const bytes = positiveInteger(entry.bytes, `${label} byte length`);
  if (bytes > limits.payload) throw new Error(`${label} exceeds the payload limit`);
  return { filename, bytes, sha256: hex(entry.sha256, 64, `${label} SHA-256`) };
}
function validateInventory(value: unknown, policy: ReleasePackagePolicy) {
  exactKeys(
    value,
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
  if (value.schema_version !== 1 || value.repository !== policy.repository)
    throw new Error("updater inventory authority mismatch");
  const version = boundedText(value.version, "inventory version");
  classifyApplicationVersion(version);
  const source_commit = hex(value.source_commit, 40, "inventory source commit");
  if (value.application_identifier !== "io.github.portcove.portcove")
    throw new Error("application identifier mismatch");
  const platform_label = boundedText(value.platform_label, "inventory platform");
  const expected = updaterIdentity(policy, platform_label, version),
    definitions = packagesForPlatform(policy, platform_label);
  if (!Array.isArray(value.packages)) throw new Error("updater inventory packages are invalid");
  const packages = (value.packages as unknown[]).map((entry) => {
    exactKeys(entry, ["id", "filename", "bytes", "sha256"], [], "inventory package");
    const id = boundedText(entry.id, "inventory package ID");
    const definition = definitions.find((candidate) => candidate.id === id);
    if (!definition || entry.filename !== artifactName(definition, version))
      throw new Error("updater inventory package filename mismatch");
    return { id, ...validateArtifact(entry, `inventory package ${id}`) };
  });
  assertExactArtifactNames(
    definitions.map((entry) => entry.id),
    packages.map((entry) => entry.id),
    "updater inventory package identities",
  );
  const updater = value.updater;
  exactKeys(
    updater,
    ["id", "target", "format", "filename", "bytes", "sha256", "signature", "public_key_sha256"],
    [],
    "updater payload",
  );
  for (const field of ["id", "target", "format", "filename"] as const)
    if (updater[field] !== expected[field]) throw new Error(`updater ${field} mismatch`);
  const artifact = validateArtifact(updater, "updater payload");
  exactKeys(updater.signature, ["filename", "bytes", "sha256"], [], "updater signature");
  const signature = validateArtifact(updater.signature, "updater signature");
  if (signature.filename !== `${artifact.filename}.sig`)
    throw new Error("updater signature filename mismatch");
  const inventory: UpdaterInventory = {
    schema_version: 1,
    repository: policy.repository,
    version,
    source_commit,
    platform_label,
    application_identifier: value.application_identifier,
    packages,
    updater: {
      ...artifact,
      id: expected.id,
      target: expected.target,
      format: expected.format,
      signature,
      public_key_sha256: hex(updater.public_key_sha256, 64, "updater public-key SHA-256"),
    },
  };
  return { inventory, expected };
}

function validateSource(source: unknown, policy: ReleasePackagePolicy) {
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
  let rawInventory: unknown;
  try {
    rawInventory = JSON.parse(source.inventoryBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`updater inventory is malformed: ${errorMessage(error)}`);
  }
  const { inventory, expected } = validateInventory(rawInventory, policy);
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
  const source_tree = hex(source.source_tree, 40, "source tree");
  const run = source.qualified_run;
  exactKeys(run, ["workflow", "workflow_commit", "run_id", "attempt"], [], "qualified run");
  const qualified_run: QualifiedRun = {
    workflow: boundedText(run.workflow, "qualified workflow"),
    workflow_commit: hex(run.workflow_commit, 40, "qualified workflow commit"),
    run_id: positiveInteger(run.run_id, "qualified run ID"),
    attempt: positiveInteger(run.attempt, "qualified run attempt"),
  };
  const validated: QualifiedSource = {
    inventoryBytes: source.inventoryBytes,
    signatureBytes: source.signatureBytes,
    source_tree,
    qualified_run,
    execution_context: identity(source.execution_context, "execution context"),
    compatibility: compatibility(source.compatibility),
    evidence_ids: uniqueArray(source.evidence_ids, "evidence IDs", (entry) =>
      boundedText(entry, "evidence ID"),
    ),
  };
  return { source: validated, inventory, expected, signature };
}

function validateEligibility(
  evidence: unknown,
  version: string,
  sourceTargets: ReadonlySet<string>,
): Eligibility {
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
  const preview_eligible = evidence.preview_eligible,
    production_eligible = evidence.production_eligible;
  if (typeof preview_eligible !== "boolean" || typeof production_eligible !== "boolean")
    throw new Error("Eligibility flags must be boolean");
  classifyApplicationVersion(version, production_eligible);
  const targets = uniqueArray(
    evidence.targets,
    "eligibility targets",
    (entry) => identity(entry, "target"),
    16,
  );
  for (const target of targets) {
    if (!sourceTargets.has(target))
      throw new Error(`eligibility names unavailable target ${target}`);
  }
  const active = evidence.preview_eligible && !evidence.held && !evidence.withdrawn;
  if (!active) boundedText(evidence.reason, "inactive eligibility reason", 512);
  if (evidence.reason !== undefined) boundedText(evidence.reason, "eligibility reason", 512);
  const bridges = evidence.bridges ?? {};
  const bridgeRecords = object(bridges, "eligibility bridges");
  const validatedBridges: NonNullable<Eligibility["bridges"]> = {};
  for (const [target, bridge] of Object.entries(bridgeRecords)) {
    if (!targets.includes(target)) throw new Error(`bridge names unavailable target ${target}`);
    exactKeys(bridge, ["path", "sha256"], [], `bridge for ${target}`);
    validatedBridges[target] = {
      path: targetPath(bridge.path, "bridge path"),
      sha256: hex(bridge.sha256, 64, "bridge SHA-256"),
    };
  }
  const parsed: Eligibility = { version, preview_eligible, production_eligible, targets };
  if (typeof evidence.held === "boolean") parsed.held = evidence.held;
  if (typeof evidence.withdrawn === "boolean") parsed.withdrawn = evidence.withdrawn;
  if (evidence.reason !== undefined)
    parsed.reason = boundedText(evidence.reason, "eligibility reason", 512);
  if (evidence.bridges !== undefined) parsed.bridges = validatedBridges;
  return parsed;
}

function jsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addFile(files: Map<string, Buffer>, file: string, bytes: Buffer) {
  if (files.has(file)) throw new Error(`duplicate reconstructed target path: ${file}`);
  files.set(file, bytes);
}

export async function reconstructApplicationUpdateRecords(
  sources: unknown,
  eligibilityValue: unknown,
  options: ReconstructionOptions = {},
): Promise<ApplicationUpdateReconstruction> {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > limits.sources)
    throw new Error("qualified release sources must be a bounded nonempty array");
  const eligibilityInput = object(eligibilityValue, "eligibility evidence");
  const eligibility = new Map<string, Eligibility>();
  const policy = options.policy ?? (await loadPackagePolicy(options.projectRoot));
  const parsed = (sources as unknown[]).map((source) => validateSource(source, policy));
  const sourceTargetsByVersion = new Map<string, Set<string>>();
  const authorityByVersion = new Map<string, string>();
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
    const evidence = eligibilityInput[`v${version}`];
    if (!evidence) throw new Error(`missing eligibility evidence for v${version}`);
    eligibility.set(`v${version}`, validateEligibility(evidence, version, targets));
  }
  const expectedEligibilityKeys = new Set(
    [...sourceTargetsByVersion.keys()].map((version) => `v${version}`),
  );
  for (const key of Object.keys(eligibilityInput)) {
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
    const left = required(parsed[index - 1]).inventory;
    const right = required(parsed[index]).inventory;
    if (
      left.updater.target === right.updater.target &&
      left.updater.format === right.updater.format &&
      compareApplicationVersionPrecedence(left.version, right.version) === 0
    )
      throw new Error("qualified inventories contain duplicate SemVer precedence");
  }

  const files = new Map<string, Buffer>();
  const records: ReconstructionRecord[] = [];
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
      os: required(packagesForPlatform(policy, inventory.platform_label)[0]).os,
      architecture: required(packagesForPlatform(policy, inventory.platform_label)[0]).architecture,
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

    const evidence = required(eligibility.get(`v${inventory.version}`));
    if (!evidence.targets.includes(inventory.platform_label)) continue;
    for (const channel of ["preview", "stable"] as const) {
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
              path: required(evidence.bridges[inventory.platform_label]).path,
              sha256: required(evidence.bridges[inventory.platform_label]).sha256,
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
  const manifest = { schema_version: 1 as const, records };
  const manifestBytes = jsonBytes(manifest);
  const total = [...files.values()].reduce(
    (sum, bytes) => sum + bytes.length,
    manifestBytes.length,
  );
  if (total > limits.output) throw new Error("reconstructed metadata exceeds its total limit");
  files.set("reconstruction-manifest.json", manifestBytes);
  return { files, manifest };
}

async function walkFiles(root: string, prefix = ""): Promise<string[]> {
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

async function exists(value: string) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function writeApplicationUpdateReconstruction(
  outputPath: string,
  reconstruction: Pick<ApplicationUpdateReconstruction, "files">,
  options: Pick<ReconstructionOptions, "projectRoot"> = {},
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
    for (const relative of currentFiles.filter((file: string) => file.startsWith("releases/"))) {
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
          expectedFiles.map(async (relative: string) =>
            (await readFile(path.join(output, ...relative.split("/")))).equals(
              required(reconstruction.files.get(relative)),
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

async function readBounded(file: string, maximum: number, label: string) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
    throw new Error(`${label} is missing or oversized`);
  return readFile(file);
}

async function loadSources(projectRoot: string, descriptorPath: string) {
  const descriptorFile = await assertOwnedUnlinkedPath(
    projectRoot,
    descriptorPath,
    "source descriptor",
  );
  const descriptorBytes = await readBounded(descriptorFile, limits.descriptor, "source descriptor");
  const descriptor: unknown = JSON.parse(descriptorBytes.toString("utf8"));
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
    (descriptor.releases as unknown[]).map(async (entry) => {
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
        path.resolve(base, boundedText(entry.inventory, "inventory input")),
        "inventory input",
      );
      const signature = await assertOwnedUnlinkedPath(
        projectRoot,
        path.resolve(base, boundedText(entry.signature, "signature input")),
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

function parseArguments(argv: string[]) {
  const options: { projectRoot: string; input?: string; eligibility?: string; output?: string } = {
    projectRoot: defaultProjectRoot,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !(
        name === "--project-root" ||
        name === "--input" ||
        name === "--eligibility" ||
        name === "--output"
      ) ||
      !value
    )
      throw new Error(
        "usage: reconstruct-application-update-records.mts --input PATH --eligibility PATH --output PATH [--project-root PATH]",
      );
    if (seen.has(name)) throw new Error(`duplicate ${name}`);
    seen.add(name);
    const key =
      name === "--project-root"
        ? "projectRoot"
        : name === "--input"
          ? "input"
          : name === "--eligibility"
            ? "eligibility"
            : "output";
    options[key] = path.resolve(value);
  }
  if (!options.input || !options.eligibility || !options.output)
    throw new Error("input, eligibility and output are required");
  options.projectRoot = path.resolve(options.projectRoot);
  return {
    projectRoot: options.projectRoot,
    input: options.input,
    eligibility: options.eligibility,
    output: options.output,
  };
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const options = parseArguments(process.argv.slice(2));
    const eligibilityFile = await assertOwnedUnlinkedPath(
      options.projectRoot,
      options.eligibility,
      "eligibility input",
    );
    const eligibility: unknown = JSON.parse(
      (await readBounded(eligibilityFile, limits.eligibility, "eligibility input")).toString(
        "utf8",
      ),
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
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
