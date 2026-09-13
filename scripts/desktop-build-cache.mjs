import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";

const FORMAT_VERSION = 1;
const FRONTEND_INPUTS = [
  ".node-version",
  "apps/desktop/public",
  "apps/desktop/src",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/pnpm-lock.yaml",
  "apps/desktop/pnpm-workspace.yaml",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.node.json",
  "apps/desktop/vite.config.ts",
];
const FRONTEND_OPTIONAL_INPUTS = [
  "apps/desktop/.env",
  "apps/desktop/.env.local",
  "apps/desktop/.env.production",
  "apps/desktop/.env.production.local",
];

const portable = (value) => value.split(path.sep).join("/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function inventoryEntry(absolute, relative, entries) {
  const details = await lstat(absolute, { bigint: false });
  if (details.isSymbolicLink()) {
    const target = await readlink(absolute);
    throw new Error(`desktop build reuse refuses linked input ${portable(relative)} -> ${target}`);
  }
  if (details.isFile()) {
    const contents = await readFile(absolute);
    entries.push({ path: portable(relative), bytes: details.size, sha256: sha256(contents) });
    return;
  }
  if (!details.isDirectory())
    throw new Error(`desktop build reuse refuses non-file input ${portable(relative)}`);
  for (const child of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const childRelative = path.join(relative, child.name);
    if (child.isSymbolicLink()) {
      const target = await readlink(path.join(absolute, child.name));
      throw new Error(
        `desktop build reuse refuses linked input ${portable(childRelative)} -> ${target}`,
      );
    }
    await inventoryEntry(path.join(absolute, child.name), childRelative, entries);
  }
}

async function inventory(root, names) {
  const entries = [];
  for (const name of names) await inventoryEntry(path.join(root, name), name, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function optionalInventory(root, names) {
  const entries = [];
  for (const name of names) {
    try {
      await inventoryEntry(path.join(root, name), name, entries);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push({ path: portable(name), missing: true });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(
        ([name]) => name === "NODE_ENV" || name.startsWith("TAURI_") || name.startsWith("VITE_"),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function createFrontendBuildIdentity({
  root,
  packageManager,
  packageManagerVersion,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
}) {
  const identity = {
    format_version: FORMAT_VERSION,
    command: [packageManager, "--dir", "apps/desktop", "build"],
    toolchain: {
      node: process.version,
      package_manager: packageManager,
      package_manager_version: packageManagerVersion,
      platform,
      architecture,
    },
    environment: buildEnvironment(environment),
    inputs: [
      ...(await inventory(root, FRONTEND_INPUTS)),
      ...(await optionalInventory(root, FRONTEND_OPTIONAL_INPUTS)),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...identity, fingerprint: sha256(JSON.stringify(identity)) };
}

async function outputInventory(outputDirectory) {
  const entries = await inventory(path.dirname(outputDirectory), [path.basename(outputDirectory)]);
  if (entries.length === 0) throw new Error("desktop frontend build produced no output files");
  return entries.map((entry) => ({ ...entry, path: entry.path.replace(/^dist\//u, "") }));
}

export async function checkFrontendBuildReuse({ identity, outputDirectory, stampPath }) {
  let stamp;
  try {
    stamp = JSON.parse(await readFile(stampPath, "utf8"));
  } catch (error) {
    return {
      reused: false,
      reason: error.code === "ENOENT" ? "missing-cache-record" : "invalid-cache-record",
    };
  }
  if (stamp.format_version !== FORMAT_VERSION || stamp.input_fingerprint !== identity.fingerprint)
    return { reused: false, reason: "frontend-inputs-changed" };
  let outputs;
  try {
    outputs = await outputInventory(outputDirectory);
  } catch {
    return { reused: false, reason: "frontend-output-missing-or-unsafe" };
  }
  if (JSON.stringify(outputs) !== JSON.stringify(stamp.outputs))
    return { reused: false, reason: "frontend-output-changed" };
  return {
    reused: true,
    reason: "exact-inputs-and-outputs-match",
    input_fingerprint: identity.fingerprint,
    output_fingerprint: stamp.output_fingerprint,
    output_files: outputs.length,
  };
}

export async function recordFrontendBuild({ identity, outputDirectory, stampPath }) {
  const outputs = await outputInventory(outputDirectory);
  const stamp = {
    format_version: FORMAT_VERSION,
    input_fingerprint: identity.fingerprint,
    output_fingerprint: sha256(JSON.stringify(outputs)),
    outputs,
  };
  await writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  return {
    reused: false,
    reason: "frontend-built-and-recorded",
    input_fingerprint: stamp.input_fingerprint,
    output_fingerprint: stamp.output_fingerprint,
    output_files: outputs.length,
  };
}
