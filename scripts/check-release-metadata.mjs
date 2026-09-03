import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const brandManifestRelativePath = "apps/desktop/assets/brand/manifest.json";
const modelManifestRelativePath = "apps/desktop/assets/brand/models/v2/model-manifest.json";
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const requiredProjectFiles = [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  brandManifestRelativePath,
  modelManifestRelativePath,
  "apps/desktop/assets/brand/masters/portcove-logo-master.jpg",
  "apps/desktop/assets/brand/masters/portcove-mascot-master.jpg",
  "apps/desktop/assets/brand/generated/portcove-mascot-head-icon-master.png",
  "apps/desktop/assets/brand/generated/v2/portcove-mascot-v2-front.png",
  "apps/desktop/assets/brand/generated/v2/portcove-mascot-v2-front-left-three-quarter.png",
  "apps/desktop/assets/brand/generated/v2/portcove-mascot-v2-front-right-three-quarter.png",
  "apps/desktop/assets/brand/generated/v2/portcove-mascot-v2-left-side.png",
  "apps/desktop/assets/brand/generated/v2/portcove-mascot-v2-back.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-graphite-stage.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-light-stage.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-tight-transparent.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-monochrome-white.png",
  "apps/desktop/assets/brand/generated/v2/portcove-logo-v2-monochrome-graphite.png",
  "apps/desktop/assets/brand/models/v2/build_portcove_mascot_v2.py",
  "apps/desktop/assets/brand/models/v2/create_portcove_mascot_v2_proofs.py",
  "apps/desktop/assets/brand/models/v2/portcove-mascot-v2.blend",
  "apps/desktop/assets/brand/models/v2/portcove-mascot-v2.glb",
  "apps/desktop/assets/brand/models/v2/validate_portcove_mascot_v2.py",
  "apps/desktop/public/brand/icons/portcove-mascot-head-256.png",
  "apps/desktop/public/brand/logo/portcove-logo-v2-transparent.png",
  "apps/desktop/public/brand/mascot/portcove-mascot-v2-front.png",
  "apps/desktop/src-tauri/icons/32x32.png",
  "apps/desktop/src-tauri/icons/128x128.png",
  "apps/desktop/src-tauri/icons/128x128@2x.png",
  "apps/desktop/src-tauri/icons/icon.ico",
  "apps/desktop/src-tauri/icons/icon.icns",
];

const requiredBundleIcons = [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico",
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

const pngColorModes = new Map([
  [0, "GRAYSCALE"],
  [2, "RGB"],
  [3, "INDEXED"],
  [4, "GRAYSCALE_ALPHA"],
  [6, "RGBA"],
]);

export function inspectPng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 29 || buffer.subarray(0, 8).toString("hex") !== signature
      || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("not a valid PNG with an IHDR header");
  }
  const colorMode = pngColorModes.get(buffer[25]);
  if (!colorMode) throw new Error(`unsupported PNG color type ${buffer[25]}`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorMode,
  };
}

export function validateBrandManifestDefinition(manifest) {
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push("brand manifest schema_version must be 1");
  if (manifest?.brand_version !== 2) errors.push("brand manifest brand_version must be 2");
  if (!Array.isArray(manifest?.assets) || manifest.assets.length === 0) {
    errors.push("brand manifest assets must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, asset] of manifest.assets.entries()) {
    const label = asset?.id || `entry ${index + 1}`;
    if (!asset?.id || ids.has(asset.id)) errors.push(`brand manifest has missing or duplicate id: ${label}`);
    if (asset?.id) ids.add(asset.id);
    const assetPath = asset?.path;
    const normalizedPath = typeof assetPath === "string" ? path.posix.normalize(assetPath) : "";
    const allowedRoot = normalizedPath.startsWith("apps/desktop/assets/brand/")
      || normalizedPath.startsWith("apps/desktop/public/brand/");
    if (!assetPath || assetPath !== normalizedPath || path.posix.isAbsolute(normalizedPath)
        || normalizedPath.includes("..") || !allowedRoot || path.posix.extname(normalizedPath) !== ".png") {
      errors.push(`brand manifest ${label} has an invalid PNG path`);
    } else if (paths.has(assetPath)) {
      errors.push(`brand manifest has duplicate path: ${assetPath}`);
    } else {
      paths.add(assetPath);
    }
    if (!asset?.category || !asset?.role) errors.push(`brand manifest ${label} must name a category and role`);
    if (!Number.isInteger(asset?.width) || asset.width <= 0
        || !Number.isInteger(asset?.height) || asset.height <= 0) {
      errors.push(`brand manifest ${label} must have positive integer dimensions`);
    }
    if (!['RGB', 'RGBA'].includes(asset?.color_mode)) {
      errors.push(`brand manifest ${label} color_mode must be RGB or RGBA`);
    }
    if (!/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) {
      errors.push(`brand manifest ${label} must have a lowercase SHA-256`);
    }
  }
  return errors;
}

async function collectBrandManifest(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, brandManifestRelativePath), "utf8"));
  } catch (error) {
    return {
      assetCount: 0,
      errors: [`brand manifest could not be read: ${error.message}`],
    };
  }
  const errors = validateBrandManifestDefinition(manifest);
  if (errors.length) return { assetCount: manifest.assets?.length ?? 0, errors };
  await Promise.all(manifest.assets.map(async asset => {
    let buffer;
    try {
      buffer = await readFile(path.join(root, ...asset.path.split("/")));
    } catch (error) {
      errors.push(`brand asset ${asset.id} could not be read: ${error.message}`);
      return;
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hash !== asset.sha256) {
      errors.push(`brand asset ${asset.id} SHA-256 ${hash} does not match manifest ${asset.sha256}`);
    }
    try {
      const png = inspectPng(buffer);
      if (png.bitDepth !== 8) errors.push(`brand asset ${asset.id} must use 8-bit PNG channels`);
      if (png.width !== asset.width || png.height !== asset.height) {
        errors.push(`brand asset ${asset.id} dimensions ${png.width}x${png.height} do not match manifest ${asset.width}x${asset.height}`);
      }
      if (png.colorMode !== asset.color_mode) {
        errors.push(`brand asset ${asset.id} color mode ${png.colorMode} does not match manifest ${asset.color_mode}`);
      }
    } catch (error) {
      errors.push(`brand asset ${asset.id} is invalid: ${error.message}`);
    }
  }));
  return { assetCount: manifest.assets.length, errors: errors.sort() };
}

const requiredModelFileIds = new Set([
  "mascot-v2-blender-source",
  "mascot-v2-glb-exchange",
  "mascot-v2-model-builder",
  "mascot-v2-model-validator",
  "mascot-v2-proof-builder",
]);

export function validateModelManifestDefinition(manifest) {
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push("model manifest schema_version must be 1");
  if (manifest?.brand_version !== 2) errors.push("model manifest brand_version must be 2");
  if (manifest?.model_version !== 1) errors.push("model manifest model_version must be 1");
  if (!manifest?.blender_version) errors.push("model manifest must name its Blender version");
  const geometry = manifest?.geometry ?? {};
  for (const [name, expected] of Object.entries({
    eyes: 2,
    claws: 2,
    walking_legs: 4,
    side_spikes: 4,
    fixed_cameras: 5,
    lid_hinges: 2,
  })) {
    if (geometry[name] !== expected) errors.push(`model manifest geometry ${name} must be ${expected}`);
  }
  if (!Number.isInteger(geometry.triangles) || geometry.triangles <= 0 || geometry.triangles >= 5000) {
    errors.push("model manifest must record a positive low-poly triangle count below 5000");
  }
  const requiredMaterials = [
    "MAT_SignatureRed",
    "MAT_CobaltBlue",
    "MAT_GoldenYellow",
    "MAT_EmeraldGreen",
    "MAT_WarmWhite",
    "MAT_Graphite",
  ];
  if (JSON.stringify(manifest?.materials) !== JSON.stringify(requiredMaterials)) {
    errors.push("model manifest canonical material set drifted");
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    errors.push("model manifest files must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, file] of manifest.files.entries()) {
    const label = file?.id || `entry ${index + 1}`;
    if (!file?.id || ids.has(file.id)) errors.push(`model manifest has missing or duplicate id: ${label}`);
    if (file?.id) ids.add(file.id);
    const filePath = file?.path;
    const normalizedPath = typeof filePath === "string" ? path.posix.normalize(filePath) : "";
    const extension = path.posix.extname(normalizedPath);
    const validPath = normalizedPath.startsWith("apps/desktop/assets/brand/models/v2/")
      && [".blend", ".glb", ".py"].includes(extension);
    if (!filePath || filePath !== normalizedPath || path.posix.isAbsolute(normalizedPath)
        || normalizedPath.includes("..") || !validPath) {
      errors.push(`model manifest ${label} has an invalid model path`);
    } else if (paths.has(filePath)) {
      errors.push(`model manifest has duplicate path: ${filePath}`);
    } else {
      paths.add(filePath);
    }
    if (!file?.role) errors.push(`model manifest ${label} must name a role`);
    if (!Number.isInteger(file?.bytes) || file.bytes <= 0) {
      errors.push(`model manifest ${label} must record a positive byte size`);
    }
    if (!/^[0-9a-f]{64}$/.test(file?.sha256 ?? "")) {
      errors.push(`model manifest ${label} must have a lowercase SHA-256`);
    }
  }
  for (const requiredId of requiredModelFileIds) {
    if (!ids.has(requiredId)) errors.push(`model manifest is missing required file id: ${requiredId}`);
  }
  return errors;
}

async function collectModelManifest(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, modelManifestRelativePath), "utf8"));
  } catch (error) {
    return { fileCount: 0, errors: [`model manifest could not be read: ${error.message}`] };
  }
  const errors = validateModelManifestDefinition(manifest);
  if (errors.length) return { fileCount: manifest.files?.length ?? 0, errors };
  await Promise.all(manifest.files.map(async file => {
    try {
      const buffer = await readFile(path.join(root, ...file.path.split("/")));
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (hash !== file.sha256) {
        errors.push(`model file ${file.id} SHA-256 ${hash} does not match manifest ${file.sha256}`);
      }
      if (buffer.length !== file.bytes) {
        errors.push(`model file ${file.id} byte size ${buffer.length} does not match manifest ${file.bytes}`);
      }
    } catch (error) {
      errors.push(`model file ${file.id} could not be read: ${error.message}`);
    }
  }));
  return { fileCount: manifest.files.length, errors: errors.sort() };
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
  metadata => requiredBundleIcons.every(icon => metadata.tauri.bundle?.icon?.includes(icon))
    ? undefined
    : "Tauri bundle must explicitly configure the complete platform icon set",
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
    ...(metadata.brandManifestErrors ?? []),
    ...(metadata.modelManifestErrors ?? []),
  ];
}

async function collectReleaseMetadata(root = projectRoot) {
  const cargoPath = path.join(root, "Cargo.toml");
  const desktopPackagePath = path.join(root, "apps", "desktop", "package.json");
  const tauriPath = path.join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const [cargoToml, desktopPackageText, tauriText, brandManifest, modelManifest] = await Promise.all([
    readFile(cargoPath, "utf8"),
    readFile(desktopPackagePath, "utf8"),
    readFile(tauriPath, "utf8"),
    collectBrandManifest(root),
    collectModelManifest(root),
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
    brandAssetCount: brandManifest.assetCount,
    brandManifestErrors: brandManifest.errors,
    modelFileCount: modelManifest.fileCount,
    modelManifestErrors: modelManifest.errors,
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
  console.log(`Release metadata check passed: Portcove ${metadata.cargo.version}${tagSuffix}; ${requiredProjectFiles.length} required files present; ${metadata.brandAssetCount} brand assets and ${metadata.modelFileCount} model files verified.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
