import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const allowedInterfaces = new Set(["desktop", "cli"]);
const allowedArchitectures = new Set(["x86_64", "aarch64"]);
const allowedPlatforms = new Set([
  "windows-x86_64",
  "linux-x86_64",
  "macos-aarch64",
  "macos-x86_64",
]);
const platformIdentities = new Map([
  [
    "windows-x86_64",
    {
      os: "windows",
      architecture: "x86_64",
      desktopFormats: new Set(["nsis"]),
      cliFormat: "zip",
    },
  ],
  [
    "linux-x86_64",
    {
      os: "linux",
      architecture: "x86_64",
      desktopFormats: new Set(["appimage", "deb", "rpm"]),
      cliFormat: "tar.gz",
    },
  ],
  [
    "macos-aarch64",
    {
      os: "macos",
      architecture: "aarch64",
      desktopFormats: new Set(["dmg"]),
      cliFormat: "tar.gz",
    },
  ],
  [
    "macos-x86_64",
    {
      os: "macos",
      architecture: "x86_64",
      desktopFormats: new Set(["dmg"]),
      cliFormat: "tar.gz",
    },
  ],
]);

function safeBasename(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === path.basename(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function safeFilenameTemplate(value) {
  return (
    safeBasename(value) &&
    /^[A-Za-z0-9._-]*\{version\}[A-Za-z0-9._-]*$/.test(value) &&
    (value.match(/\{version\}/g) ?? []).length === 1
  );
}

export function validatePackagePolicy(policy) {
  const errors = [];
  if (policy?.schema_version !== 1)
    errors.push("package policy schema_version must be 1");
  if (policy?.repository !== "boburning/portcove")
    errors.push("package policy repository must be boburning/portcove");
  if (policy?.checksum_manifest !== "SHA256SUMS.txt")
    errors.push("public checksum manifest must be SHA256SUMS.txt");
  if (!Array.isArray(policy?.packages) || policy.packages.length === 0) {
    errors.push("package policy packages must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  const filenames = new Set();
  for (const [index, entry] of policy.packages.entries()) {
    const label = entry?.id ?? `entry ${index + 1}`;
    if (!safeIdentifier(entry?.id) || ids.has(entry.id))
      errors.push(`missing, unsafe, or duplicate package id: ${label}`);
    if (entry?.id) ids.add(entry.id);
    if (!allowedInterfaces.has(entry?.interface))
      errors.push(`${label} has an invalid interface`);
    if (!allowedPlatforms.has(entry?.platform_label))
      errors.push(`${label} has an invalid platform_label`);
    if (!allowedArchitectures.has(entry?.architecture))
      errors.push(`${label} has an invalid architecture`);
    if (
      !entry?.os ||
      !entry?.format ||
      !entry?.format_label ||
      !entry?.display_label
    ) {
      errors.push(
        `${label} must declare OS, architecture, format, and display labels`,
      );
    }
    const identity = platformIdentities.get(entry?.platform_label);
    if (
      identity &&
      (entry.os !== identity.os || entry.architecture !== identity.architecture)
    ) {
      errors.push(
        `${label} OS/architecture does not match ${entry.platform_label}`,
      );
    }
    const formatMatches =
      entry?.interface === "desktop"
        ? identity?.desktopFormats.has(entry?.format)
        : entry?.interface === "cli" && entry?.format === identity?.cliFormat;
    if (identity && allowedInterfaces.has(entry?.interface) && !formatMatches) {
      errors.push(
        `${label} format ${entry?.format ?? "missing"} does not match ${entry.platform_label} ${entry.interface}`,
      );
    }
    if (typeof entry?.experimental !== "boolean")
      errors.push(`${label} experimental must be boolean`);
    if (!safeFilenameTemplate(entry?.filename)) {
      errors.push(`${label} must declare one safe {version} filename template`);
    } else {
      const normalized = entry.filename.toLowerCase();
      if (filenames.has(normalized))
        errors.push(`duplicate package filename template: ${entry.filename}`);
      filenames.add(normalized);
    }
  }

  for (const platform of allowedPlatforms) {
    const entries = policy.packages.filter(
      (entry) => entry.platform_label === platform,
    );
    if (entries.filter((entry) => entry.interface === "cli").length !== 1) {
      errors.push(`${platform} must declare exactly one CLI archive`);
    }
    if (entries.filter((entry) => entry.interface === "desktop").length === 0) {
      errors.push(`${platform} must declare at least one desktop package`);
    }
  }
  return errors;
}

export async function loadPackagePolicy(projectRoot = defaultProjectRoot) {
  const policy = JSON.parse(
    await readFile(
      path.join(projectRoot, "release", "package-policy.json"),
      "utf8",
    ),
  );
  const errors = validatePackagePolicy(policy);
  if (errors.length)
    throw new Error(
      `invalid release package policy:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  return policy;
}

export function artifactName(entry, version) {
  if (!semverPattern.test(version ?? ""))
    throw new Error(`invalid release version: ${version ?? "missing"}`);
  const name = entry.filename.replace("{version}", version);
  if (!safeBasename(name))
    throw new Error(`unsafe resolved package filename: ${name}`);
  return name;
}

export function assertExactArtifactNames(expected, actual, context) {
  const seen = new Set();
  for (const name of actual) {
    const key = name.toLowerCase();
    if (seen.has(key))
      throw new Error(
        `${context} contains a duplicate or case-colliding filename: ${name}`,
      );
    seen.add(key);
  }
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
    const missing = expectedSorted.filter(
      (name) => !actualSorted.includes(name),
    );
    const unexpected = actualSorted.filter(
      (name) => !expectedSorted.includes(name),
    );
    throw new Error(
      `${context} mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

export function packagesForPlatform(policy, platformLabel) {
  if (!allowedPlatforms.has(platformLabel))
    throw new Error(`unknown release platform: ${platformLabel}`);
  return policy.packages.filter(
    (entry) => entry.platform_label === platformLabel,
  );
}

export function releaseLabels(policy) {
  return [...new Set(policy.packages.map((entry) => entry.platform_label))];
}

export async function workspaceVersion(projectRoot = defaultProjectRoot) {
  const cargo = await readFile(path.join(projectRoot, "Cargo.toml"), "utf8");
  const table = cargo.match(
    /(?:^|\r?\n)\[workspace\.package\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/,
  )?.[1];
  const version = table?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!semverPattern.test(version ?? ""))
    throw new Error(
      `Cargo workspace version is invalid: ${version ?? "missing"}`,
    );
  return version;
}

function parseArguments(argv) {
  const options = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (
      !["--project-root", "--platform", "--interface", "--version"].includes(
        name,
      )
    ) {
      throw new Error(`unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    if (name === "--project-root") options.projectRoot = path.resolve(value);
    else if (name === "--platform") options.platform = value;
    else if (name === "--interface") options.interface = value;
    else options.version = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const policy = await loadPackagePolicy(options.projectRoot);
  const version =
    options.version ?? (await workspaceVersion(options.projectRoot));
  let entries = options.platform
    ? packagesForPlatform(policy, options.platform)
    : policy.packages;
  if (options.interface)
    entries = entries.filter((entry) => entry.interface === options.interface);
  if (entries.length !== 1)
    throw new Error(
      `expected exactly one matching package; found ${entries.length}`,
    );
  console.log(artifactName(entries[0], version));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath)
  await main();
