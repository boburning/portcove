import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const requiredProjectFiles = [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "apps/desktop/assets/brand/masters/portcove-logo-master.jpg",
  "apps/desktop/assets/brand/masters/portcove-mascot-master.jpg",
  "apps/desktop/assets/brand/generated/portcove-mascot-head-icon-master.png",
  "apps/desktop/public/brand/icons/portcove-mascot-head-256.png",
  "apps/desktop/public/brand/logo/portcove-logo-horizontal.jpg",
  "apps/desktop/public/brand/mascot/portcove-mascot-default.jpg",
  "apps/desktop/src-tauri/icons/32x32.png",
  "apps/desktop/src-tauri/icons/128x128.png",
  "apps/desktop/src-tauri/icons/icon.ico",
  "apps/desktop/src-tauri/icons/icon.icns",
];

export function parseWorkspacePackage(toml) {
  const table = toml.match(/(?:^|\r?\n)\[workspace\.package\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  if (!table) throw new Error("Cargo.toml has no [workspace.package] table");
  const stringValue = key => table.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  return {
    version: stringValue("version"),
    repository: stringValue("repository"),
    license: stringValue("license"),
  };
}

function present(values) {
  return values.filter(value => value !== undefined);
}

const versionRules = [
  ({ cargo }) => semverPattern.test(cargo.version ?? "")
    ? undefined
    : `Cargo workspace version is not valid SemVer: ${cargo.version ?? "missing"}`,
  ({ cargo, desktopPackage }) => desktopPackage.version === cargo.version
    ? undefined
    : `desktop package version ${desktopPackage.version ?? "missing"} does not match Cargo ${cargo.version ?? "missing"}`,
  ({ cargo, tauri }) => tauri.version === cargo.version
    ? undefined
    : `Tauri bundle version ${tauri.version ?? "missing"} does not match Cargo ${cargo.version ?? "missing"}`,
  ({ cargo }, { expectedVersion }) => !expectedVersion || expectedVersion === cargo.version
    ? undefined
    : `requested package version ${expectedVersion} does not match Cargo ${cargo.version ?? "missing"}`,
  ({ cargo }, { tag }) => !tag || tag === `v${cargo.version}`
    ? undefined
    : `release tag ${tag} must exactly match v${cargo.version ?? "missing"}`,
];

function validateVersions(metadata, options) {
  return present(versionRules.map(rule => rule(metadata, options)));
}

const metadataRules = [
  metadata => metadata.desktopPackage.packageManager === "pnpm@11.25.0"
    ? undefined
    : "desktop package manager must remain pinned to pnpm@11.25.0",
  metadata => metadata.cargo.license === "MIT OR Apache-2.0"
    ? undefined
    : "Cargo license must be MIT OR Apache-2.0",
  metadata => metadata.cargo.repository
    ? undefined
    : "Cargo repository metadata is missing",
  metadata => !metadata.cargo.repository || metadata.tauri.bundle?.homepage === metadata.cargo.repository
    ? undefined
    : `Tauri homepage ${metadata.tauri.bundle?.homepage ?? "missing"} does not match Cargo repository ${metadata.cargo.repository}`,
  metadata => metadata.tauri.productName === "Portcove" && metadata.tauri.app?.windows?.[0]?.title === "Portcove"
    ? undefined
    : "Tauri product and primary window names must both be Portcove",
  metadata => metadata.tauri.identifier?.match(/^[a-zA-Z][a-zA-Z0-9.-]+$/)
    ? undefined
    : "Tauri identifier is missing or malformed",
  metadata => metadata.tauri.bundle?.active === true
    ? undefined
    : "Tauri bundle must be active for a release",
  metadata => metadata.tauri.bundle?.shortDescription && metadata.tauri.bundle?.longDescription
    ? undefined
    : "Tauri bundle descriptions must be present",
  metadata => metadata.tauri.bundle?.licenseFile === "../../../LICENSE-MIT"
    ? undefined
    : "Tauri licenseFile must resolve to the preserved root MIT license",
];

export function validateReleaseMetadata(metadata, options = {}) {
  return [
    ...validateVersions(metadata, options),
    ...present(metadataRules.map(rule => rule(metadata))),
    ...(metadata.missingFiles ?? []).map(missingPath => `required release file is missing: ${missingPath}`),
  ];
}

async function collectReleaseMetadata(root = projectRoot) {
  const cargoPath = path.join(root, "Cargo.toml");
  const desktopPackagePath = path.join(root, "apps", "desktop", "package.json");
  const tauriPath = path.join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const [cargoToml, desktopPackageText, tauriText] = await Promise.all([
    readFile(cargoPath, "utf8"),
    readFile(desktopPackagePath, "utf8"),
    readFile(tauriPath, "utf8"),
  ]);
  const missingFiles = [];
  await Promise.all(requiredProjectFiles.map(async relativePath => {
    try {
      await access(path.join(root, relativePath));
    } catch {
      missingFiles.push(relativePath);
    }
  }));
  return {
    cargo: parseWorkspacePackage(cargoToml),
    desktopPackage: JSON.parse(desktopPackageText),
    tauri: JSON.parse(tauriText),
    missingFiles: missingFiles.sort(),
  };
}

const valuedArguments = {
  "--tag": "tag",
  "--expect-version": "expectedVersion",
};

function readArgumentValue(argv, index, name, inlineValue) {
  const value = inlineValue ?? argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumedNext: inlineValue === undefined };
}

export function parseArguments(argv) {
  const options = { printVersion: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split("=", 2);
    if (name === "--print-version") {
      options.printVersion = true;
      continue;
    }
    const optionKey = valuedArguments[name];
    if (!optionKey) throw new Error(`unknown argument: ${argv[index]}`);
    const { value, consumedNext } = readArgumentValue(argv, index, name, inlineValue);
    options[optionKey] = value;
    if (consumedNext) index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metadata = await collectReleaseMetadata();
  const errors = validateReleaseMetadata(metadata, options);
  if (errors.length) {
    console.error(`Release metadata check failed:\n${errors.map(error => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  if (options.printVersion) {
    console.log(metadata.cargo.version);
    return;
  }
  const tagSuffix = options.tag ? ` for ${options.tag}` : "";
  console.log(`Release metadata check passed: Portcove ${metadata.cargo.version}${tagSuffix}; ${requiredProjectFiles.length} required files present.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
