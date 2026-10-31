import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

export interface ReleasePackageEntry {
  id: string;
  interface: "desktop" | "cli";
  platform_label: "windows-x86_64" | "linux-x86_64" | "macos-aarch64" | "macos-x86_64";
  os: string;
  architecture: "x86_64" | "aarch64";
  format: string;
  format_label: string;
  display_label: string;
  filename: string;
  experimental: boolean;
}
export interface ReleasePackagePolicy {
  schema_version: 1;
  repository: "boburning/portcove";
  checksum_manifest: "SHA256SUMS.txt";
  packages: ReleasePackageEntry[];
}

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

function hasControlCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
function diagnosticText(value: unknown): string {
  return value !== null && typeof value === "object"
    ? Object.prototype.toString.call(value)
    : String(value);
}

function safeBasename(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === path.basename(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !hasControlCharacter(value)
  );
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function safeFilenameTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    safeBasename(value) &&
    /^[A-Za-z0-9._-]*\{version\}[A-Za-z0-9._-]*$/.test(value) &&
    (value.match(/\{version\}/g) ?? []).length === 1
  );
}

export function validatePackagePolicy(value: unknown) {
  const policy = isRecord(value) ? value : {};
  const errors = [];
  if (policy?.schema_version !== 1) errors.push("package policy schema_version must be 1");
  if (policy?.repository !== "boburning/portcove")
    errors.push("package policy repository must be boburning/portcove");
  if (policy?.checksum_manifest !== "SHA256SUMS.txt")
    errors.push("public checksum manifest must be SHA256SUMS.txt");
  if (!Array.isArray(policy?.packages) || policy.packages.length === 0) {
    errors.push("package policy packages must be a non-empty array");
    return errors;
  }

  const ids = new Set<unknown>();
  const filenames = new Set<string>();
  const packages: unknown[] = policy.packages;
  for (const [index, rawEntry] of packages.entries()) {
    const entry = isRecord(rawEntry) ? rawEntry : {};
    const label = diagnosticText(entry.id ?? `entry ${index + 1}`);
    if (!safeIdentifier(entry?.id) || ids.has(entry.id))
      errors.push(`missing, unsafe, or duplicate package id: ${label}`);
    if (entry?.id) ids.add(entry.id);
    if (typeof entry.interface !== "string" || !allowedInterfaces.has(entry.interface))
      errors.push(`${label} has an invalid interface`);
    if (typeof entry.platform_label !== "string" || !allowedPlatforms.has(entry.platform_label))
      errors.push(`${label} has an invalid platform_label`);
    if (typeof entry.architecture !== "string" || !allowedArchitectures.has(entry.architecture))
      errors.push(`${label} has an invalid architecture`);
    if (
      [entry.os, entry.format, entry.format_label, entry.display_label].some(
        (value) => typeof value !== "string" || !value,
      )
    ) {
      errors.push(`${label} must declare OS, architecture, format, and display labels`);
    }
    const identity =
      typeof entry.platform_label === "string"
        ? platformIdentities.get(entry.platform_label)
        : undefined;
    if (identity && (entry.os !== identity.os || entry.architecture !== identity.architecture)) {
      errors.push(`${label} OS/architecture does not match ${String(entry.platform_label)}`);
    }
    const formatMatches =
      entry?.interface === "desktop"
        ? typeof entry.format === "string" && identity?.desktopFormats.has(entry.format)
        : entry?.interface === "cli" && entry?.format === identity?.cliFormat;
    if (
      identity &&
      typeof entry.interface === "string" &&
      allowedInterfaces.has(entry.interface) &&
      !formatMatches
    ) {
      errors.push(
        `${label} format ${diagnosticText(entry.format ?? "missing")} does not match ${String(entry.platform_label)} ${String(entry.interface)}`,
      );
    }
    if (typeof entry?.experimental !== "boolean")
      errors.push(`${label} experimental must be boolean`);
    if (!safeFilenameTemplate(entry?.filename)) {
      errors.push(`${label} must declare one safe {version} filename template`);
    } else {
      const normalized = entry.filename.toLowerCase();
      if (filenames.has(normalized))
        errors.push(`duplicate package filename template: ${diagnosticText(entry.filename)}`);
      filenames.add(normalized);
    }
  }

  for (const platform of allowedPlatforms) {
    const entries = packages.filter(isRecord).filter((entry) => entry.platform_label === platform);
    if (entries.filter((entry) => entry.interface === "cli").length !== 1) {
      errors.push(`${platform} must declare exactly one CLI archive`);
    }
    if (entries.filter((entry) => entry.interface === "desktop").length === 0) {
      errors.push(`${platform} must declare at least one desktop package`);
    }
  }
  return errors;
}

function assertPackagePolicy(policy: unknown): asserts policy is ReleasePackagePolicy {
  const errors = validatePackagePolicy(policy);
  if (errors.length)
    throw new Error(
      `invalid release package policy:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
}

export async function loadPackagePolicy(projectRoot = defaultProjectRoot) {
  const policy: unknown = JSON.parse(
    await readFile(path.join(projectRoot, "release", "package-policy.json"), "utf8"),
  );
  assertPackagePolicy(policy);
  return policy;
}

export function artifactName(entry: Pick<ReleasePackageEntry, "filename">, version: string) {
  if (!semverPattern.test(version ?? ""))
    throw new Error(`invalid release version: ${version ?? "missing"}`);
  const name = entry.filename.replace("{version}", version);
  if (!safeBasename(name)) throw new Error(`unsafe resolved package filename: ${name}`);
  return name;
}

export function assertExactArtifactNames(
  expected: readonly string[],
  actual: readonly string[],
  context: string,
) {
  const seen = new Set<string>();
  for (const name of actual) {
    const key = name.toLowerCase();
    if (seen.has(key))
      throw new Error(`${context} contains a duplicate or case-colliding filename: ${name}`);
    seen.add(key);
  }
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
    const missing = expectedSorted.filter((name) => !actualSorted.includes(name ?? ""));
    const unexpected = actualSorted.filter((name) => !expectedSorted.includes(name ?? ""));
    throw new Error(
      `${context} mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

export function packagesForPlatform(policy: ReleasePackagePolicy, platformLabel: string) {
  if (!allowedPlatforms.has(platformLabel))
    throw new Error(`unknown release platform: ${platformLabel}`);
  return policy.packages.filter((entry) => entry.platform_label === platformLabel);
}

export function releaseLabels(policy: ReleasePackagePolicy) {
  return [...new Set(policy.packages.map((entry) => entry.platform_label))];
}

export type ReleaseProfile =
  | "full"
  | "initial-beta-win-linux"
  | "initial-beta-windows-x86_64-v1";

export function inspectReleaseProfile(value: unknown = "full"): ReleaseProfile {
  if (
    value !== "full" &&
    value !== "initial-beta-win-linux" &&
    value !== "initial-beta-windows-x86_64-v1"
  )
    throw new Error("unknown trusted release profile");
  return value;
}

/** Closed native launch set. Full releases retain their separate qualification
 * route; neither missing artifacts nor execution host may choose this profile. */
export function nativePlatformsForReleaseProfile(rawProfile: unknown) {
  const profile = inspectReleaseProfile(rawProfile);
  if (profile === "full") throw new Error("explicit initial beta native profile required");
  return profile === "initial-beta-windows-x86_64-v1"
    ? (["windows-x86_64"] as const)
    : (["windows-x86_64", "linux-x86_64"] as const);
}

/** Select only after validating the complete repository-owned package policy.
 * The profile is bound by the controller/admission input, never inferred from
 * whatever packages happened to arrive. Every selected package remains required. */
export function selectReleasePackagePolicy(
  policy: ReleasePackagePolicy,
  rawProfile: unknown = "full",
) {
  assertPackagePolicy(policy);
  const profile = inspectReleaseProfile(rawProfile);
  const selected = {
    ...policy,
    packages: policy.packages
      .filter(
        (entry) =>
          profile === "full" ||
          entry.platform_label === "windows-x86_64" ||
          (profile === "initial-beta-win-linux" && entry.platform_label === "linux-x86_64"),
      )
      .map((entry) => ({ ...entry })),
  };
  if (
    profile === "initial-beta-win-linux" &&
    JSON.stringify(
      selected.packages
        .map((entry) => `${entry.interface}:${entry.platform_label}:${entry.format}`)
        .sort(),
    ) !==
      JSON.stringify(
        [
          "desktop:windows-x86_64:nsis",
          "cli:windows-x86_64:zip",
          "desktop:linux-x86_64:appimage",
          "desktop:linux-x86_64:deb",
          "desktop:linux-x86_64:rpm",
          "cli:linux-x86_64:tar.gz",
        ].sort(),
      )
  )
    throw new Error("initial beta must declare the exact six Windows/Linux distributions");
  if (
    profile === "initial-beta-windows-x86_64-v1" &&
    JSON.stringify(
      selected.packages.map((entry) => `${entry.interface}:${entry.platform_label}:${entry.format}`).sort(),
    ) !== JSON.stringify(["cli:windows-x86_64:zip", "desktop:windows-x86_64:nsis"])
  )
    throw new Error("Windows initial beta must declare the exact two Windows x86-64 distributions");
  return selected;
}

export function releaseBuildMatrix(rawProfile: unknown = "full") {
  const profile = inspectReleaseProfile(rawProfile);
  return {
    include: [
      { os: "windows-latest", label: "windows-x86_64", bundles: "nsis", target: "" },
      ...(profile === "initial-beta-windows-x86_64-v1"
        ? []
        : [{ os: "ubuntu-24.04", label: "linux-x86_64", bundles: "appimage,deb,rpm", target: "" }]),
      ...(profile === "full"
        ? [
            {
              os: "macos-14",
              label: "macos-aarch64",
              bundles: "dmg",
              target: "aarch64-apple-darwin",
            },
          ]
        : []),
    ],
  };
}

/** Provider artifact names identify one immutable producer attempt. Local
 * verified staging directories deliberately retain their platform-only layout. */
export function releaseBuildArtifactName(platform: string, runId: string, attempt: number) {
  if (
    !allowedPlatforms.has(platform) ||
    !/^[1-9][0-9]{0,15}$/u.test(runId) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("release artifact requires exact platform/run/attempt identity");
  return `release-build-${platform}-${runId}-${attempt}`;
}

export async function workspaceVersion(projectRoot = defaultProjectRoot) {
  const cargo = await readFile(path.join(projectRoot, "Cargo.toml"), "utf8");
  const table = cargo.match(/(?:^|\r?\n)\[workspace\.package\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  const version = table?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version || !semverPattern.test(version))
    throw new Error(`Cargo workspace version is invalid: ${version ?? "missing"}`);
  return version;
}

function parseArguments(argv: readonly string[]) {
  const options: {
    projectRoot: string;
    platform?: string;
    interface?: string;
    version?: string;
    profile?: ReleaseProfile;
    buildPlan?: boolean;
  } = { projectRoot: defaultProjectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--build-plan") {
      options.buildPlan = true;
      continue;
    }
    if (
      !["--project-root", "--platform", "--interface", "--version", "--profile"].includes(
        name ?? "",
      )
    ) {
      throw new Error(`unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--project-root") options.projectRoot = path.resolve(value);
    else if (name === "--profile") options.profile = inspectReleaseProfile(value);
    else if (name === "--platform") options.platform = value;
    else if (name === "--interface") options.interface = value;
    else options.version = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const policy = selectReleasePackagePolicy(
    await loadPackagePolicy(options.projectRoot),
    options.profile,
  );
  if (options.buildPlan) {
    console.log(
      `profile=${options.profile ?? "full"}\nbuild_matrix=${JSON.stringify(releaseBuildMatrix(options.profile))}`,
    );
    return;
  }
  const version = options.version ?? (await workspaceVersion(options.projectRoot));
  let entries = options.platform ? packagesForPlatform(policy, options.platform) : policy.packages;
  if (options.interface) entries = entries.filter((entry) => entry.interface === options.interface);
  if (entries.length !== 1)
    throw new Error(`expected exactly one matching package; found ${entries.length}`);
  const entry = entries[0];
  if (!entry) throw new Error("Matching package disappeared");
  console.log(artifactName(entry, version));
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
