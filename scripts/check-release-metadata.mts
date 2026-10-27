import { errorMessage, isRecord } from "./runtime-values.mts";
import { vectorFamilyManifest, verifyVectorFamily } from "./brand-vector-contract.mts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const execFileAsync = promisify(execFile);
const HELP = `Check Portcove release versions, required files, and brand/model integrity.

Usage: node scripts/check-release-metadata.mts [options]

Options:
  --tag TAG                Require the release tag to match the central version.
  --expect-version VALUE  Require this version across release metadata.
  --print-version         Print only the verified version after all checks pass.
  --help                  Show this help without reading metadata or running Cargo.

Example:
  node scripts/check-release-metadata.mts --tag v0.1.0
`;
const brandManifestRelativePath = "apps/desktop/assets/brand/manifest.json";
const modelManifestRelativePath = "apps/desktop/assets/brand/models/v2/model-manifest.json";
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const requiredProjectFiles = [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "release/package-policy.json",
  "scripts/package-cli.ps1",
  "scripts/smoke-test-cli-archive.ps1",
  "scripts/generate-release-downloads.mts",
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

const qualificationOnlyDesktopFeatures = [
  "application-update-qualification",
  "native-compatibility-qualification",
  "qualification-fixtures",
];

export function parseWorkspacePackage(toml: string) {
  const table = toml.match(/(?:^|\r?\n)\[workspace\.package\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  if (!table) throw new Error("Cargo.toml has no [workspace.package] table");
  const stringValue = (key: string) =>
    table.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  return {
    version: stringValue("version"),
    repository: stringValue("repository"),
    license: stringValue("license"),
  };
}

// Cargo owns the schema. This projection checks only fields consumed by the release guard.
interface CargoDependency {
  name: string;
  kind: string | null;
  path?: string;
  rename?: string | null;
  optional?: boolean;
  features?: string[];
  uses_default_features?: boolean;
}
interface CargoPackage {
  name: string;
  manifest_path: string;
  features: Record<string, string[]>;
  dependencies: CargoDependency[];
}
export interface DesktopCargoFeatures {
  names: string[];
  default: string[];
  definitions: Record<string, string[]>;
  coreQualificationReferences: string[];
  alwaysEnabledCoreFeatures: string[];
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}
// Preserve diagnostic rendering of arbitrary rejected input; never use this to validate identity.
function diagnosticText(value: unknown): string {
  return String(value);
}
function parseJson(text: string): unknown {
  return JSON.parse(text);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function cargoPackage(value: unknown): CargoPackage {
  const candidate = record(value);
  if (typeof candidate.name !== "string" || typeof candidate.manifest_path !== "string")
    throw new Error("Cargo metadata package identity is incomplete");
  if (candidate.features !== undefined && !isRecord(candidate.features))
    throw new Error("Cargo metadata features are invalid");
  const definitions = Object.fromEntries(
    Object.entries(record(candidate.features)).map(([name, references]) => {
      if (!stringArray(references))
        throw new Error("Cargo metadata feature references are invalid");
      return [name, references] as const;
    }),
  );
  const dependencies: CargoDependency[] = [];
  if (candidate.dependencies !== undefined && !Array.isArray(candidate.dependencies))
    throw new Error("Cargo metadata dependencies are invalid");
  const rawDependencies: unknown[] = Array.isArray(candidate.dependencies)
    ? candidate.dependencies
    : [];
  for (const raw of rawDependencies) {
    const dependency = record(raw);
    if (
      typeof dependency.name !== "string" ||
      (dependency.kind !== null && typeof dependency.kind !== "string") ||
      (dependency.path !== undefined && typeof dependency.path !== "string") ||
      (dependency.rename !== undefined &&
        dependency.rename !== null &&
        typeof dependency.rename !== "string") ||
      (dependency.optional !== undefined && typeof dependency.optional !== "boolean") ||
      (dependency.features !== undefined && !stringArray(dependency.features)) ||
      (dependency.uses_default_features !== undefined &&
        typeof dependency.uses_default_features !== "boolean")
    )
      throw new Error("Cargo metadata dependency is invalid");
    dependencies.push({
      name: dependency.name,
      kind: dependency.kind,
      ...(typeof dependency.path === "string" ? { path: dependency.path } : {}),
      ...(dependency.rename !== undefined ? { rename: dependency.rename } : {}),
      ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
      ...(dependency.features !== undefined ? { features: dependency.features } : {}),
      ...(dependency.uses_default_features !== undefined
        ? { uses_default_features: dependency.uses_default_features }
        : {}),
    });
  }
  return {
    name: candidate.name,
    manifest_path: candidate.manifest_path,
    features: definitions,
    dependencies,
  };
}
function featureReferences(
  definitions: Readonly<Record<string, readonly string[]>>,
  roots: readonly string[],
) {
  const pending = [...roots];
  const references = new Set<string>();
  while (pending.length > 0) {
    const reference = pending.pop();
    if (reference === undefined || references.has(reference)) continue;
    references.add(reference);
    const children = Object.hasOwn(definitions, reference) ? definitions[reference] : undefined;
    if (children) pending.push(...children);
  }
  return references;
}
export function parseDesktopCargoFeatures(
  cargoMetadata: unknown,
  desktopCargoPath: string,
): DesktopCargoFeatures {
  const metadata = record(cargoMetadata);
  if (!Array.isArray(metadata.packages)) throw new Error("Cargo metadata has no package inventory");
  const rawPackages: unknown[] = metadata.packages;
  const packages = rawPackages.map(cargoPackage);
  const resolvedDesktopCargoPath = path.resolve(desktopCargoPath);
  const desktopPackages = packages.filter(
    (candidate) => path.resolve(candidate.manifest_path) === resolvedDesktopCargoPath,
  );
  const desktopPackage = desktopPackages[0];
  if (desktopPackages.length !== 1 || !desktopPackage)
    throw new Error("Cargo metadata must contain exactly one Desktop package");
  const corePackages = packages.filter((candidate) => candidate.name === "portcove-core");
  const corePackage = corePackages[0];
  if (corePackages.length !== 1 || !corePackage)
    throw new Error("Cargo metadata must contain exactly one portcove-core package");
  const corePackageRoot = path.dirname(path.resolve(corePackage.manifest_path));
  const coreDependencies = desktopPackage.dependencies.filter(
    (dependency) =>
      dependency.name === "portcove-core" &&
      dependency.kind === null &&
      dependency.path !== undefined &&
      path.resolve(dependency.path) === corePackageRoot,
  );
  if (coreDependencies.length === 0 || coreDependencies.some((dependency) => dependency.optional))
    throw new Error("Desktop must retain a non-optional production dependency on portcove-core");
  const definitions = desktopPackage.features;
  const coreDefinitions = corePackage.features;
  const coreQualificationReferences = new Set<string>();
  const alwaysEnabledCoreFeatures = new Set<string>();
  for (const dependency of coreDependencies) {
    const dependencyName = dependency.rename ?? dependency.name;
    coreQualificationReferences.add(`${dependencyName}/qualification-fixtures`);
    coreQualificationReferences.add(`${dependencyName}?/qualification-fixtures`);
    for (const feature of featureReferences(coreDefinitions, dependency.features ?? []))
      alwaysEnabledCoreFeatures.add(feature);
    if (dependency.uses_default_features !== false)
      for (const feature of featureReferences(coreDefinitions, coreDefinitions.default ?? []))
        alwaysEnabledCoreFeatures.add(feature);
  }
  return {
    names: Object.keys(definitions),
    default: definitions.default ?? [],
    definitions,
    coreQualificationReferences: [...coreQualificationReferences],
    alwaysEnabledCoreFeatures: [...alwaysEnabledCoreFeatures],
  };
}

export async function loadDesktopCargoFeatures(desktopCargoPath: string, { locked = true } = {}) {
  const arguments_ = ["metadata"];
  if (locked) arguments_.push("--locked");
  arguments_.push("--no-deps", "--format-version", "1", "--manifest-path", desktopCargoPath);
  const { stdout } = await execFileAsync("cargo", arguments_, {
    cwd: path.dirname(desktopCargoPath),
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  let cargoMetadata: unknown;
  try {
    cargoMetadata = JSON.parse(stdout);
  } catch {
    throw new Error("cargo metadata did not return valid JSON");
  }
  return parseDesktopCargoFeatures(cargoMetadata, desktopCargoPath);
}

function defaultDesktopFeatureReferences(features: DesktopCargoFeatures | undefined) {
  return featureReferences(features?.definitions ?? {}, features?.default ?? []);
}

function present<T>(values: readonly (T | undefined)[]) {
  return values.filter((value) => value !== undefined);
}

const pngColorModes = new Map([
  [0, "GRAYSCALE"],
  [2, "RGB"],
  [3, "INDEXED"],
  [4, "GRAYSCALE_ALPHA"],
  [6, "RGBA"],
]);

export function inspectPng(buffer: Buffer) {
  const signature = "89504e470d0a1a0a";
  if (
    buffer.length < 29 ||
    buffer.subarray(0, 8).toString("hex") !== signature ||
    buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("not a valid PNG with an IHDR header");
  }
  const colorMode = pngColorModes.get(buffer.readUInt8(25));
  if (!colorMode) throw new Error(`unsupported PNG color type ${buffer[25]}`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorMode,
  };
}

export function validateBrandManifestDefinition(input: unknown) {
  const manifest = record(input);
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push("brand manifest schema_version must be 1");
  if (manifest?.brand_version !== 2) errors.push("brand manifest brand_version must be 2");
  if (manifest.vector_family !== undefined) {
    const family = record(manifest.vector_family);
    if (
      family.path !== vectorFamilyManifest ||
      typeof family.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(family.sha256) ||
      !["candidate", "approved"].includes(String(family.status))
    )
      errors.push("brand vector-family reference is invalid");
  }
  if (!Array.isArray(manifest?.assets) || manifest.assets.length === 0) {
    errors.push("brand manifest assets must be a non-empty array");
    return errors;
  }
  const ids = new Set<unknown>();
  const paths = new Set<unknown>();
  const assets: unknown[] = manifest.assets;
  for (const [index, raw] of assets.entries()) {
    const asset = record(raw);
    const label = diagnosticText(asset.id || `entry ${index + 1}`);
    if (typeof asset.id !== "string" || !asset.id || ids.has(asset.id))
      errors.push(`brand manifest has missing or duplicate id: ${label}`);
    if (typeof asset.id === "string" && asset.id) ids.add(asset.id);
    const assetPath = asset?.path;
    const normalizedPath = typeof assetPath === "string" ? path.posix.normalize(assetPath) : "";
    const allowedRoot =
      normalizedPath.startsWith("apps/desktop/assets/brand/") ||
      normalizedPath.startsWith("apps/desktop/public/brand/");
    if (
      !assetPath ||
      assetPath !== normalizedPath ||
      path.posix.isAbsolute(normalizedPath) ||
      normalizedPath.includes("..") ||
      !allowedRoot ||
      path.posix.extname(normalizedPath) !== ".png"
    ) {
      errors.push(`brand manifest ${label} has an invalid PNG path`);
    } else if (paths.has(assetPath)) {
      errors.push(`brand manifest has duplicate path: ${assetPath}`);
    } else {
      paths.add(assetPath);
    }
    if (
      typeof asset.category !== "string" ||
      !asset.category ||
      typeof asset.role !== "string" ||
      !asset.role
    )
      errors.push(`brand manifest ${label} must name a category and role`);
    if (
      typeof asset.width !== "number" ||
      !Number.isInteger(asset.width) ||
      asset.width <= 0 ||
      typeof asset.height !== "number" ||
      !Number.isInteger(asset.height) ||
      asset.height <= 0
    ) {
      errors.push(`brand manifest ${label} must have positive integer dimensions`);
    }
    if (typeof asset.color_mode !== "string" || !["RGB", "RGBA"].includes(asset.color_mode)) {
      errors.push(`brand manifest ${label} color_mode must be RGB or RGBA`);
    }
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      errors.push(`brand manifest ${label} must have a lowercase SHA-256`);
    }
  }
  return errors;
}

async function collectBrandManifest(root: string) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(root, brandManifestRelativePath), "utf8"));
  } catch (error) {
    return {
      assetCount: 0,
      errors: [`brand manifest could not be read: ${errorMessage(error)}`],
    };
  }
  const errors = validateBrandManifestDefinition(manifest);
  const assets = record(manifest).assets;
  if (errors.length) return { assetCount: Array.isArray(assets) ? assets.length : 0, errors };
  if (!Array.isArray(assets)) throw new Error("brand assets were not validated");
  const checkedAssets: unknown[] = assets;
  await Promise.all(
    checkedAssets.map(async (raw) => {
      const asset = record(raw);
      if (typeof asset.path !== "string" || typeof asset.id !== "string")
        throw new Error("brand asset identity was not validated");
      let buffer;
      try {
        buffer = await readFile(path.join(root, ...asset.path.split("/")));
      } catch (error) {
        errors.push(`brand asset ${asset.id} could not be read: ${errorMessage(error)}`);
        return;
      }
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (hash !== asset.sha256) {
        errors.push(
          `brand asset ${asset.id} SHA-256 ${hash} does not match manifest ${String(asset.sha256)}`,
        );
      }
      try {
        const png = inspectPng(buffer);
        if (png.bitDepth !== 8) errors.push(`brand asset ${asset.id} must use 8-bit PNG channels`);
        if (png.width !== asset.width || png.height !== asset.height) {
          errors.push(
            `brand asset ${asset.id} dimensions ${png.width}x${png.height} do not match manifest ${String(asset.width)}x${String(asset.height)}`,
          );
        }
        if (png.colorMode !== asset.color_mode) {
          errors.push(
            `brand asset ${asset.id} color mode ${png.colorMode} does not match manifest ${String(asset.color_mode)}`,
          );
        }
      } catch (error) {
        errors.push(`brand asset ${asset.id} is invalid: ${errorMessage(error)}`);
      }
    }),
  );
  let vectorCount = 0;
  if (record(manifest).vector_family !== undefined) {
    try {
      const reference = record(record(manifest).vector_family);
      const result = await verifyVectorFamily(root);
      if (result.sha256 !== reference.sha256 || result.family.status !== reference.status)
        throw new Error("Vector-family reference does not bind the current manifest/status");
      vectorCount = result.family.masters.length + result.family.derivatives.length;
    } catch (error) {
      errors.push(`brand vector family is invalid: ${errorMessage(error)}`);
    }
  }
  return { assetCount: assets.length + vectorCount, errors: errors.sort() };
}

const requiredModelFileIds = new Set([
  "mascot-v2-blender-source",
  "mascot-v2-glb-exchange",
  "mascot-v2-model-builder",
  "mascot-v2-model-validator",
  "mascot-v2-proof-builder",
]);

export function validateModelManifestDefinition(input: unknown) {
  const manifest = record(input);
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push("model manifest schema_version must be 1");
  if (manifest?.brand_version !== 2) errors.push("model manifest brand_version must be 2");
  if (manifest?.model_version !== 1) errors.push("model manifest model_version must be 1");
  if (typeof manifest.blender_version !== "string" || !manifest.blender_version)
    errors.push("model manifest must name its Blender version");
  const geometry = record(manifest.geometry);
  for (const [name, expected] of Object.entries({
    eyes: 2,
    claws: 2,
    walking_legs: 4,
    side_spikes: 4,
    fixed_cameras: 5,
    lid_hinges: 2,
  })) {
    if (geometry[name] !== expected)
      errors.push(`model manifest geometry ${name} must be ${expected}`);
  }
  if (
    typeof geometry.triangles !== "number" ||
    !Number.isInteger(geometry.triangles) ||
    geometry.triangles <= 0 ||
    geometry.triangles >= 5000
  ) {
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
  const ids = new Set<unknown>();
  const paths = new Set<unknown>();
  const files: unknown[] = manifest.files;
  for (const [index, raw] of files.entries()) {
    const file = record(raw);
    const label = diagnosticText(file.id || `entry ${index + 1}`);
    if (typeof file.id !== "string" || !file.id || ids.has(file.id))
      errors.push(`model manifest has missing or duplicate id: ${label}`);
    if (typeof file.id === "string" && file.id) ids.add(file.id);
    const filePath = file?.path;
    const normalizedPath = typeof filePath === "string" ? path.posix.normalize(filePath) : "";
    const extension = path.posix.extname(normalizedPath);
    const validPath =
      normalizedPath.startsWith("apps/desktop/assets/brand/models/v2/") &&
      [".blend", ".glb", ".py"].includes(extension);
    if (
      !filePath ||
      filePath !== normalizedPath ||
      path.posix.isAbsolute(normalizedPath) ||
      normalizedPath.includes("..") ||
      !validPath
    ) {
      errors.push(`model manifest ${label} has an invalid model path`);
    } else if (paths.has(filePath)) {
      errors.push(`model manifest has duplicate path: ${filePath}`);
    } else {
      paths.add(filePath);
    }
    if (typeof file.role !== "string" || !file.role)
      errors.push(`model manifest ${label} must name a role`);
    if (typeof file.bytes !== "number" || !Number.isInteger(file.bytes) || file.bytes <= 0) {
      errors.push(`model manifest ${label} must record a positive byte size`);
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      errors.push(`model manifest ${label} must have a lowercase SHA-256`);
    }
  }
  for (const requiredId of requiredModelFileIds) {
    if (!ids.has(requiredId))
      errors.push(`model manifest is missing required file id: ${requiredId}`);
  }
  return errors;
}

async function collectModelManifest(root: string) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(root, modelManifestRelativePath), "utf8"));
  } catch (error) {
    return {
      fileCount: 0,
      errors: [`model manifest could not be read: ${errorMessage(error)}`],
    };
  }
  const errors = validateModelManifestDefinition(manifest);
  const files = record(manifest).files;
  if (errors.length) return { fileCount: Array.isArray(files) ? files.length : 0, errors };
  if (!Array.isArray(files)) throw new Error("model files were not validated");
  const checkedFiles: unknown[] = files;
  await Promise.all(
    checkedFiles.map(async (raw) => {
      const file = record(raw);
      if (typeof file.path !== "string" || typeof file.id !== "string")
        throw new Error("model file identity was not validated");
      try {
        const buffer = await readFile(path.join(root, ...file.path.split("/")));
        const hash = createHash("sha256").update(buffer).digest("hex");
        if (hash !== file.sha256) {
          errors.push(
            `model file ${file.id} SHA-256 ${hash} does not match manifest ${String(file.sha256)}`,
          );
        }
        if (buffer.length !== file.bytes) {
          errors.push(
            `model file ${file.id} byte size ${buffer.length} does not match manifest ${String(file.bytes)}`,
          );
        }
      } catch (error) {
        errors.push(`model file ${file.id} could not be read: ${errorMessage(error)}`);
      }
    }),
  );
  return { fileCount: files.length, errors: errors.sort() };
}

interface ReleaseOptions {
  expectedVersion?: string;
  tag?: string;
  printVersion?: boolean;
  help?: boolean;
}
function releaseProjection(input: unknown) {
  const value = record(input);
  const tauri = record(value.tauri);
  const app = record(tauri.app);
  const bundle = record(tauri.bundle);
  const cargo = record(value.cargo);
  const capability = record(value.desktopCapability);
  const features = record(value.desktopCargoFeatures);
  if (features.definitions !== undefined && !isRecord(features.definitions))
    throw new Error("desktop Cargo feature definitions are invalid");
  const definitions = Object.fromEntries(
    Object.entries(record(features.definitions)).map(([name, references]) => {
      if (!stringArray(references)) throw new Error("desktop Cargo feature references are invalid");
      return [name, references] as const;
    }),
  );
  const featureList = (key: string) => {
    const raw = features[key];
    if (raw === undefined) return [];
    if (!stringArray(raw)) throw new Error(`desktop Cargo ${key} inventory is invalid`);
    return raw;
  };
  const checkedFeatures: DesktopCargoFeatures = {
    names: featureList("names"),
    default: featureList("default"),
    definitions,
    coreQualificationReferences:
      features.coreQualificationReferences === undefined
        ? ["portcove-core/qualification-fixtures"]
        : featureList("coreQualificationReferences"),
    alwaysEnabledCoreFeatures: featureList("alwaysEnabledCoreFeatures"),
  };
  const messages = (key: string) => {
    const raw = value[key];
    if (raw === undefined) return [];
    if (!stringArray(raw)) throw new Error(`release metadata ${key} must be a string inventory`);
    return raw;
  };
  const windows: unknown[] = Array.isArray(app.windows) ? app.windows : [];
  return {
    cargo: { version: cargo.version, license: cargo.license, repository: cargo.repository },
    repositoryPackage: { packageManager: record(value.repositoryPackage).packageManager },
    desktopPackage: { version: record(value.desktopPackage).version },
    desktopCargoFeatures: checkedFeatures,
    desktopCapability: {
      identifier: capability.identifier,
      local: capability.local,
      remote: capability.remote,
      windows: capability.windows,
      webviews: capability.webviews,
    },
    tauri: {
      version: tauri.version,
      identifier: tauri.identifier,
      productName: tauri.productName,
      app: {
        windows: windows.map((raw) => {
          const window = record(raw);
          return {
            title: window.title,
            label: window.label,
            create: window.create,
            url: window.url,
          };
        }),
      },
      bundle: {
        active: bundle.active,
        icon: bundle.icon,
        homepage: bundle.homepage,
        shortDescription: bundle.shortDescription,
        longDescription: bundle.longDescription,
        licenseFile: bundle.licenseFile,
      },
    },
    missingFiles: messages("missingFiles"),
    brandManifestErrors: messages("brandManifestErrors"),
    modelManifestErrors: messages("modelManifestErrors"),
  };
}
type ReleaseProjection = ReturnType<typeof releaseProjection>;
type VersionRule = (metadata: ReleaseProjection, options: ReleaseOptions) => string | undefined;
type MetadataRule = (metadata: ReleaseProjection) => string | undefined;
const versionRules: VersionRule[] = [
  ({ cargo }) =>
    typeof cargo.version === "string" && semverPattern.test(cargo.version)
      ? undefined
      : `Cargo workspace version is not valid SemVer: ${diagnosticText(cargo.version ?? "missing")}`,
  ({ cargo, desktopPackage }) =>
    desktopPackage.version === cargo.version
      ? undefined
      : `desktop package version ${diagnosticText(desktopPackage.version ?? "missing")} does not match Cargo ${diagnosticText(cargo.version ?? "missing")}`,
  ({ cargo, tauri }) =>
    tauri.version === cargo.version
      ? undefined
      : `Tauri bundle version ${diagnosticText(tauri.version ?? "missing")} does not match Cargo ${diagnosticText(cargo.version ?? "missing")}`,
  ({ cargo }, { expectedVersion }) =>
    !expectedVersion || expectedVersion === cargo.version
      ? undefined
      : `requested package version ${expectedVersion} does not match Cargo ${diagnosticText(cargo.version ?? "missing")}`,
  ({ cargo }, { tag }) =>
    !tag || tag === `v${diagnosticText(cargo.version)}`
      ? undefined
      : `release tag ${tag} must exactly match v${diagnosticText(cargo.version ?? "missing")}`,
];

function validateVersions(metadata: ReleaseProjection, options: ReleaseOptions) {
  return present(versionRules.map((rule) => rule(metadata, options)));
}

const metadataRules: MetadataRule[] = [
  (metadata) =>
    typeof metadata.repositoryPackage.packageManager === "string" &&
    /^pnpm@\d+\.\d+\.\d+$/u.test(metadata.repositoryPackage.packageManager)
      ? undefined
      : "repository package manager must use an exact pnpm version",
  (metadata) =>
    metadata.cargo.license === "MIT OR Apache-2.0"
      ? undefined
      : "Cargo license must be MIT OR Apache-2.0",
  (metadata) => (metadata.cargo.repository ? undefined : "Cargo repository metadata is missing"),
  (metadata) =>
    !metadata.cargo.repository || metadata.tauri.bundle?.homepage === metadata.cargo.repository
      ? undefined
      : `Tauri homepage ${diagnosticText(metadata.tauri.bundle?.homepage ?? "missing")} does not match Cargo repository ${diagnosticText(metadata.cargo.repository)}`,
  (metadata) =>
    metadata.tauri.productName === "Portcove" &&
    metadata.tauri.app?.windows?.[0]?.title === "Portcove"
      ? undefined
      : "Tauri product and primary window names must both be Portcove",
  (metadata) => {
    const windows = metadata.tauri.app?.windows;
    return windows?.length === 1 &&
      (windows[0]?.label ?? "main") === "main" &&
      windows[0]?.create !== false &&
      windows[0]?.url === undefined
      ? undefined
      : "Tauri release configuration must define exactly one local main window";
  },
  (metadata) => {
    const capability = metadata.desktopCapability;
    return capability?.identifier === "default" &&
      capability.local !== false &&
      capability.remote === undefined &&
      JSON.stringify(capability.windows) === JSON.stringify(["main"]) &&
      (capability.webviews === undefined ||
        (Array.isArray(capability.webviews) && capability.webviews.length === 0))
      ? undefined
      : "desktop release capability must apply only to the local main window and no independent webviews";
  },
  (metadata) =>
    qualificationOnlyDesktopFeatures.every((feature) =>
      metadata.desktopCargoFeatures?.names?.includes(feature),
    )
      ? undefined
      : "desktop Cargo features must retain the qualification-only feature declarations",
  (metadata) => {
    const defaultReferences = defaultDesktopFeatureReferences(metadata.desktopCargoFeatures);
    const forbiddenReferences = [
      ...qualificationOnlyDesktopFeatures,
      ...(metadata.desktopCargoFeatures?.coreQualificationReferences ?? [
        "portcove-core/qualification-fixtures",
      ]),
    ];
    const enabledByDefault = forbiddenReferences.filter((feature) =>
      defaultReferences.has(feature),
    );
    if (
      metadata.desktopCargoFeatures?.alwaysEnabledCoreFeatures?.includes("qualification-fixtures")
    ) {
      enabledByDefault.push("portcove-core/qualification-fixtures (dependency declaration)");
    }
    return enabledByDefault.length === 0
      ? undefined
      : `desktop default features must exclude qualification-only features: ${enabledByDefault.join(", ")}`;
  },
  (metadata) =>
    typeof metadata.tauri.identifier === "string" &&
    metadata.tauri.identifier.match(/^[a-zA-Z][a-zA-Z0-9.-]+$/)
      ? undefined
      : "Tauri identifier is missing or malformed",
  (metadata) =>
    metadata.tauri.bundle?.active === true
      ? undefined
      : "Tauri bundle must be active for a release",
  (metadata) =>
    requiredBundleIcons.every((icon) => {
      const icons: unknown = metadata.tauri.bundle.icon;
      return stringArray(icons) && icons.includes(icon);
    })
      ? undefined
      : "Tauri bundle must explicitly configure the complete platform icon set",
  (metadata) =>
    metadata.tauri.bundle?.shortDescription && metadata.tauri.bundle?.longDescription
      ? undefined
      : "Tauri bundle descriptions must be present",
  (metadata) =>
    metadata.tauri.bundle?.licenseFile === "../../../LICENSE-MIT"
      ? undefined
      : "Tauri licenseFile must resolve to the preserved root MIT license",
];

export function validateReleaseMetadata(input: unknown, options: ReleaseOptions = {}) {
  let metadata: ReleaseProjection;
  try {
    metadata = releaseProjection(input);
  } catch (error) {
    return [errorMessage(error)];
  }
  return [
    ...validateVersions(metadata, options),
    ...present(metadataRules.map((rule) => rule(metadata))),
    ...(metadata.missingFiles ?? []).map(
      (missingPath) => `required release file is missing: ${missingPath}`,
    ),
    ...(metadata.brandManifestErrors ?? []),
    ...(metadata.modelManifestErrors ?? []),
  ];
}

async function collectReleaseMetadata(root = projectRoot) {
  const cargoPath = path.join(root, "Cargo.toml");
  const repositoryPackagePath = path.join(root, "package.json");
  const desktopPackagePath = path.join(root, "apps", "desktop", "package.json");
  const desktopCargoPath = path.join(root, "apps", "desktop", "src-tauri", "Cargo.toml");
  const tauriPath = path.join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const capabilityPath = path.join(
    root,
    "apps",
    "desktop",
    "src-tauri",
    "capabilities",
    "default.json",
  );
  const [
    cargoToml,
    repositoryPackageText,
    desktopPackageText,
    desktopCargoFeatures,
    tauriText,
    capabilityText,
    brandManifest,
    modelManifest,
  ] = await Promise.all([
    readFile(cargoPath, "utf8"),
    readFile(repositoryPackagePath, "utf8"),
    readFile(desktopPackagePath, "utf8"),
    loadDesktopCargoFeatures(desktopCargoPath),
    readFile(tauriPath, "utf8"),
    readFile(capabilityPath, "utf8"),
    collectBrandManifest(root),
    collectModelManifest(root),
  ]);
  const missingFiles: string[] = [];
  await Promise.all(
    requiredProjectFiles.map(async (relativePath: string) => {
      try {
        await access(path.join(root, relativePath));
      } catch {
        missingFiles.push(relativePath);
      }
    }),
  );
  return {
    cargo: parseWorkspacePackage(cargoToml),
    repositoryPackage: parseJson(repositoryPackageText),
    desktopPackage: parseJson(desktopPackageText),
    desktopCargoFeatures,
    tauri: parseJson(tauriText),
    desktopCapability: parseJson(capabilityText),
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
} as const;

function readArgumentValue(
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
) {
  const value = inlineValue ?? argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumedNext: inlineValue === undefined };
}

export function parseArguments(argv: readonly string[]) {
  const options: ReleaseOptions = { printVersion: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) throw new Error("missing argument");
    const [name = "", inlineValue] = argument.split("=", 2);
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (name === "--print-version") {
      options.printVersion = true;
      continue;
    }
    const optionKey =
      name === "--tag"
        ? valuedArguments["--tag"]
        : name === "--expect-version"
          ? valuedArguments["--expect-version"]
          : undefined;
    if (!optionKey) throw new Error(`unknown argument: ${argv[index]}`);
    const { value, consumedNext } = readArgumentValue(argv, index, name, inlineValue);
    options[optionKey] = value;
    if (consumedNext) index += 1;
  }
  return options;
}

export function formatReleaseMetadataSummary(
  version: string | undefined,
  tag: string | undefined,
  counts: { requiredFiles: number; brandAssets: number; modelFiles: number },
) {
  const count = (value: number, singular: string) =>
    `${value} ${singular}${value === 1 ? "" : "s"}`;
  return `Release metadata passed for Portcove ${version}${tag ? ` (tag ${tag})` : ""}. Checked ${count(counts.requiredFiles, "required file")}, ${count(counts.brandAssets, "brand asset")}, and ${count(counts.modelFiles, "model file")}.`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const metadata = await collectReleaseMetadata();
  const errors = validateReleaseMetadata(metadata, options);
  if (errors.length) {
    console.error(
      `Release metadata check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  if (options.printVersion) {
    console.log(metadata.cargo.version);
    return;
  }
  console.log(
    formatReleaseMetadataSummary(metadata.cargo.version, options.tag, {
      requiredFiles: requiredProjectFiles.length,
      brandAssets: metadata.brandAssetCount,
      modelFiles: metadata.modelFileCount,
    }),
  );
}

async function settleDirectCli() {
  if (import.meta.main) {
    await main();
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
