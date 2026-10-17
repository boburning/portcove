import { isRecord } from "./runtime-values.mts";
import type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const aquaPinFiles = [".aqua-version", "aqua.yaml", "aqua-checksums.json"];
const pinFiles = [
  ...aquaPinFiles,
  ".github/quality-tools.json",
  ".config/tool-bootstrap.json",
  "package.json",
];

export interface ToolCachePins {
  aquaVersion: string;
  aquaSemver: string;
  packageManager: string;
  bootstrap: {
    schema_version: number;
    aqua?: {
      release_base?: string;
      artifacts: Readonly<Record<string, { archive?: string; sha256: string }>>;
    };
    desktop?: { tauri_driver: string; edge_driver_base: string };
  };
  fingerprint: string;
  aquaFingerprint: string;
}
export interface ToolCacheOptions {
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: string;
  architecture?: string;
  pins?: ToolCachePins;
}
export type ToolCachePaths = ReturnType<typeof toolCachePaths>;
export interface ToolEnvironmentOptions extends ToolCacheOptions {
  paths?: ToolCachePaths;
}
export interface PinnedAquaOptions extends ToolEnvironmentOptions {
  osArchitecture?: string;
  probe?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout?: string | null; error?: unknown };
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readToolPins(root = projectRoot): ToolCachePins {
  const bootstrap: unknown = JSON.parse(
    readFileSync(path.join(root, ".config", "tool-bootstrap.json"), "utf8"),
  );
  if (!isRecord(bootstrap) || bootstrap.schema_version !== 1)
    throw new Error("tool bootstrap schema_version must be 1");
  if (
    !isRecord(bootstrap.aqua) ||
    bootstrap.aqua.release_base !== "https://github.com/aquaproj/aqua/releases/download"
  )
    throw new Error("Aqua downloads must use the official release origin");
  if (!isRecord(bootstrap.aqua.artifacts)) throw new Error("Aqua artifacts must be an object");
  const artifacts: Record<string, { archive: string; sha256: string }> = {};
  for (const architecture of ["win32-x64", "win32-arm64"]) {
    const artifact = bootstrap.aqua.artifacts[architecture];
    if (
      !isRecord(artifact) ||
      typeof artifact.archive !== "string" ||
      typeof artifact.sha256 !== "string"
    )
      throw new Error(`invalid Aqua artifact for ${architecture}`);
    if (!/^aqua_windows_(?:amd64|arm64)\.zip$/u.test(artifact?.archive ?? ""))
      throw new Error(`invalid Aqua archive for ${architecture}`);
    if (!/^[A-F0-9]{64}$/u.test(artifact?.sha256 ?? ""))
      throw new Error(`invalid Aqua SHA-256 for ${architecture}`);
    artifacts[architecture] = { archive: artifact.archive, sha256: artifact.sha256 };
  }
  if (
    !isRecord(bootstrap.desktop) ||
    typeof bootstrap.desktop.tauri_driver !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(bootstrap.desktop.tauri_driver)
  )
    throw new Error("tauri-driver must use an exact semantic version");
  if (bootstrap.desktop?.edge_driver_base !== "https://msedgedriver.microsoft.com")
    throw new Error("EdgeDriver downloads must use Microsoft's official origin");
  const aquaVersion = readFileSync(path.join(root, ".aqua-version"), "utf8").trim();
  if (!/^v\d+\.\d+\.\d+$/u.test(aquaVersion))
    throw new Error(".aqua-version must contain an exact v-prefixed semantic version");
  const repositoryPackage: unknown = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (
    !isRecord(repositoryPackage) ||
    typeof repositoryPackage.packageManager !== "string" ||
    !/^pnpm@\d+\.\d+\.\d+$/u.test(repositoryPackage.packageManager)
  )
    throw new Error("repository packageManager must pin an exact pnpm version");
  const fingerprint = sha256(
    pinFiles
      .map((name: string) => `${name}\0${readFileSync(path.join(root, name)).toString("utf8")}`)
      .join("\0"),
  );
  const aquaFingerprint = sha256(
    [
      "portcove-aqua-cache-v1",
      ...aquaPinFiles.map(
        (name: string) => `${name}\0${readFileSync(path.join(root, name)).toString("utf8")}`,
      ),
      JSON.stringify({ schema_version: bootstrap.schema_version, aqua: bootstrap.aqua }),
    ].join("\0"),
  );
  return {
    aquaVersion,
    aquaSemver: aquaVersion.slice(1),
    packageManager: repositoryPackage.packageManager,
    bootstrap: {
      schema_version: bootstrap.schema_version,
      aqua: { release_base: bootstrap.aqua.release_base, artifacts },
      desktop: {
        tauri_driver: bootstrap.desktop.tauri_driver,
        edge_driver_base: bootstrap.desktop.edge_driver_base,
      },
    },
    fingerprint,
    aquaFingerprint,
  };
}

function defaultSharedRoot(environment: NodeJS.ProcessEnv, platform: string) {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData || !path.win32.isAbsolute(localAppData))
      throw new Error("LOCALAPPDATA must be an absolute path for the shared Windows tool cache");
    return path.win32.join(localAppData, "Portcove", "tool-cache");
  }
  const cacheHome = environment.XDG_CACHE_HOME;
  if (cacheHome && path.posix.isAbsolute(cacheHome)) return path.posix.join(cacheHome, "portcove");
  return path.join(os.homedir(), ".cache", "portcove");
}

export function toolCachePaths(options: ToolCacheOptions = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const supportedArchitectures = {
    win32: new Set(["x64", "arm64"]),
    linux: new Set(["x64", "arm64"]),
    darwin: new Set(["x64", "arm64"]),
  };
  if (
    !Object.entries(supportedArchitectures).some(
      ([name, architectures]) => name === platform && architectures.has(architecture),
    )
  )
    throw new Error(`unsupported tool-cache platform or architecture: ${platform}/${architecture}`);
  const pins = options.pins ?? readToolPins(root);
  const configured = environment.PORTCOVE_SHARED_TOOL_CACHE;
  const sharedRoot = configured
    ? path.resolve(configured)
    : defaultSharedRoot(environment, platform);
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const aquaDirectory = path.join(
    sharedRoot,
    "aqua",
    pins.aquaSemver,
    `${platform}-${architecture}`,
  );
  return {
    projectRoot: root,
    sharedRoot,
    shimDirectory: path.join(root, "work", "tool-bin"),
    statePath: path.join(root, "work", "tool-bin", "tool-state.json"),
    aquaExecutable: path.join(aquaDirectory, `aqua${executableSuffix}`),
    aquaRoot: path.join(sharedRoot, "aqua-roots", pins.aquaFingerprint),
    cargoRoot: path.join(sharedRoot, "cargo", `${platform}-${architecture}`),
    powershellModules: path.join(sharedRoot, "powershell-modules"),
    desktopRoot: path.join(sharedRoot, "desktop"),
    pins,
  };
}

function pathKey(environment: NodeJS.ProcessEnv) {
  return Object.keys(environment).find((key: string) => key.toLowerCase() === "path") ?? "PATH";
}

export function checkoutToolEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  options: ToolEnvironmentOptions = {},
) {
  const paths = options.paths ?? toolCachePaths(options);
  const environment = { ...baseEnvironment };
  const key = pathKey(environment);
  const separator = options.platform === "win32" || process.platform === "win32" ? ";" : ":";
  const inherited = environment[key] ?? "";
  environment[key] = inherited
    ? `${paths.shimDirectory}${separator}${inherited}`
    : paths.shimDirectory;
  environment.AQUA_ROOT_DIR = paths.aquaRoot;
  environment.AQUA_ENFORCE_CHECKSUM = "true";
  environment.AQUA_ENFORCE_REQUIRE_CHECKSUM = "true";
  const inheritedModules = environment.PSModulePath ?? "";
  environment.PSModulePath = inheritedModules
    ? `${paths.powershellModules}${separator}${inheritedModules}`
    : paths.powershellModules;
  return environment;
}

export function readToolState(options: ToolEnvironmentOptions = {}) {
  const paths = options.paths ?? toolCachePaths(options);
  if (!existsSync(paths.statePath)) return null;
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(paths.statePath, "utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(state) ||
    state.format_version !== 1 ||
    state?.pin_fingerprint !== paths.pins.fingerprint ||
    state?.shared_root !== paths.sharedRoot ||
    state?.shim_directory !== paths.shimDirectory ||
    state?.aqua_root !== paths.aquaRoot
  ) {
    return null;
  }
  return state;
}

let windowsOSArchitecture: string | undefined;

function readWindowsOSArchitecture() {
  if (windowsOSArchitecture) return windowsOSArchitecture;
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      "[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  const architecture = result.stdout?.trim();
  if (result.error || result.status !== 0 || !["x64", "arm64"].includes(architecture))
    throw new Error(
      "Windows OS architecture is unavailable; inspect the required PowerShell setup",
    );
  // OS architecture is immutable for this bounded command process; no tool,
  // receipt, output or authorization is reused through this observation.
  windowsOSArchitecture = architecture;
  return architecture;
}

export function pinnedAquaCommand(options: PinnedAquaOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "aqua";
  const paths = options.paths ?? toolCachePaths(options);
  const state = readToolState({ paths });
  const artifact =
    paths.pins.bootstrap.aqua?.artifacts?.[
      `win32-${options.osArchitecture ?? readWindowsOSArchitecture()}`
    ];
  const repair = "run ./scripts/bootstrap-quality-tools.ps1";
  if (!artifact || state?.aqua !== paths.aquaExecutable)
    throw new Error(`Pinned Aqua checkout state is unavailable; ${repair}`);
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(`${paths.aquaExecutable}.receipt.json`, "utf8"));
  } catch {
    throw new Error(`Pinned Aqua cache receipt is unavailable; ${repair}`);
  }
  if (
    !isRecord(receipt) ||
    receipt.version !== paths.pins.aquaSemver ||
    receipt.archive_sha256 !== artifact.sha256
  )
    throw new Error(`Pinned Aqua cache receipt does not match checkout pins; ${repair}`);
  // Preserve the bootstrap's archive receipt + exact version cache boundary.
  // Do not fall back to PATH: Node may find an older .exe before our .cmd shim.
  const result = (options.probe ?? spawnSync)(paths.aquaExecutable, ["--version"], {
    cwd: paths.projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    env: checkoutToolEnvironment(options.environment ?? process.env, { paths, platform }),
  });
  if (
    result.error ||
    result.status !== 0 ||
    result.stdout?.trim() !== `aqua version ${paths.pins.aquaSemver}`
  )
    throw new Error(`Pinned Aqua executable is unavailable or reports another version; ${repair}`);
  return paths.aquaExecutable;
}

export function runAqua(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function runAqua(
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function runAqua(
  args: readonly string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function runAqua(
  arguments_: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const paths = toolCachePaths({ environment: options.env ?? process.env });
  const env = checkoutToolEnvironment(options.env ?? process.env, { paths });
  const executable = pinnedAquaCommand({ paths, environment: env });
  return spawnSync(executable, arguments_, { ...options, env });
}

export function cachedDesktopDrivers(options: ToolEnvironmentOptions & { state?: unknown } = {}) {
  const state = options.state ?? readToolState(options);
  if (!isRecord(state) || !isRecord(state.desktop)) return null;
  const desktop = state.desktop;
  if (
    typeof desktop.tauri_driver !== "string" ||
    typeof desktop.native_driver !== "string" ||
    typeof desktop.tauri_driver_sha256 !== "string" ||
    typeof desktop.native_driver_sha256 !== "string"
  )
    return null;
  const drivers = {
    driver: desktop.tauri_driver,
    nativeDriver: desktop.native_driver,
  };
  if (
    !path.isAbsolute(drivers.driver ?? "") ||
    !path.isAbsolute(drivers.nativeDriver ?? "") ||
    !existsSync(drivers.driver) ||
    !existsSync(drivers.nativeDriver) ||
    !/^[a-f0-9]{64}$/iu.test(desktop.tauri_driver_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/iu.test(desktop.native_driver_sha256 ?? "") ||
    sha256File(drivers.driver).toLowerCase() !== desktop.tauri_driver_sha256.toLowerCase() ||
    sha256File(drivers.nativeDriver).toLowerCase() !== desktop.native_driver_sha256.toLowerCase()
  ) {
    return null;
  }
  return drivers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const mode = process.argv[2] ?? "--paths";
  if (mode === "--help") {
    console.log("usage: tool-cache.mts [--paths|--state|--help]");
  } else if (mode === "--paths") {
    console.log(JSON.stringify(toolCachePaths(), null, 2));
  } else if (mode === "--state") {
    console.log(JSON.stringify(readToolState(), null, 2));
  } else {
    throw new Error("usage: tool-cache.mts [--paths|--state|--help]");
  }
}
