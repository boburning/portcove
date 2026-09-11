import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const pinFiles = [
  ".aqua-version",
  "aqua.yaml",
  "aqua-checksums.json",
  ".github/quality-tools.json",
  ".config/tool-bootstrap.json",
  "apps/desktop/package.json",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readToolPins(root = projectRoot) {
  const bootstrap = JSON.parse(
    readFileSync(path.join(root, ".config", "tool-bootstrap.json"), "utf8"),
  );
  if (bootstrap.schema_version !== 1) throw new Error("tool bootstrap schema_version must be 1");
  if (bootstrap.aqua?.release_base !== "https://github.com/aquaproj/aqua/releases/download")
    throw new Error("Aqua downloads must use the official release origin");
  for (const architecture of ["win32-x64", "win32-arm64"]) {
    const artifact = bootstrap.aqua?.artifacts?.[architecture];
    if (!/^aqua_windows_(?:amd64|arm64)\.zip$/u.test(artifact?.archive ?? ""))
      throw new Error(`invalid Aqua archive for ${architecture}`);
    if (!/^[A-F0-9]{64}$/u.test(artifact?.sha256 ?? ""))
      throw new Error(`invalid Aqua SHA-256 for ${architecture}`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(bootstrap.desktop?.tauri_driver ?? ""))
    throw new Error("tauri-driver must use an exact semantic version");
  if (bootstrap.desktop?.edge_driver_base !== "https://msedgedriver.microsoft.com")
    throw new Error("EdgeDriver downloads must use Microsoft's official origin");
  const aquaVersion = readFileSync(path.join(root, ".aqua-version"), "utf8").trim();
  if (!/^v\d+\.\d+\.\d+$/u.test(aquaVersion))
    throw new Error(".aqua-version must contain an exact v-prefixed semantic version");
  const desktop = JSON.parse(
    readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
  );
  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(desktop.packageManager ?? ""))
    throw new Error("desktop packageManager must pin an exact pnpm version");
  const fingerprint = sha256(
    pinFiles.map((name) => `${name}\0${readFileSync(path.join(root, name))}`).join("\0"),
  );
  return {
    aquaVersion,
    aquaSemver: aquaVersion.slice(1),
    packageManager: desktop.packageManager,
    bootstrap,
    fingerprint,
  };
}

function defaultSharedRoot(environment, platform) {
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

export function toolCachePaths(options = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const supportedArchitectures = {
    win32: new Set(["x64", "arm64"]),
    linux: new Set(["x64", "arm64"]),
    darwin: new Set(["x64", "arm64"]),
  };
  if (!supportedArchitectures[platform]?.has(architecture))
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
    aquaRoot: path.join(sharedRoot, "aqua-roots", pins.fingerprint),
    cargoRoot: path.join(sharedRoot, "cargo", `${platform}-${architecture}`),
    powershellModules: path.join(sharedRoot, "powershell-modules"),
    desktopRoot: path.join(sharedRoot, "desktop"),
    pins,
  };
}

function pathKey(environment) {
  return Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function checkoutToolEnvironment(baseEnvironment = process.env, options = {}) {
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

export function readToolState(options = {}) {
  const paths = options.paths ?? toolCachePaths(options);
  if (!existsSync(paths.statePath)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(paths.statePath, "utf8"));
  } catch {
    return null;
  }
  if (
    state?.format_version !== 1 ||
    state?.pin_fingerprint !== paths.pins.fingerprint ||
    state?.shared_root !== paths.sharedRoot ||
    state?.shim_directory !== paths.shimDirectory
  ) {
    return null;
  }
  return state;
}

export function cachedDesktopDrivers(options = {}) {
  const state = options.state ?? readToolState(options);
  if (!state?.desktop) return null;
  const drivers = {
    driver: state.desktop.tauri_driver,
    nativeDriver: state.desktop.native_driver,
  };
  if (
    !path.isAbsolute(drivers.driver ?? "") ||
    !path.isAbsolute(drivers.nativeDriver ?? "") ||
    !existsSync(drivers.driver) ||
    !existsSync(drivers.nativeDriver) ||
    !/^[a-f0-9]{64}$/iu.test(state.desktop.tauri_driver_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/iu.test(state.desktop.native_driver_sha256 ?? "") ||
    sha256File(drivers.driver).toLowerCase() !== state.desktop.tauri_driver_sha256.toLowerCase() ||
    sha256File(drivers.nativeDriver).toLowerCase() !==
      state.desktop.native_driver_sha256.toLowerCase()
  ) {
    return null;
  }
  return drivers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const mode = process.argv[2] ?? "--paths";
  if (mode === "--help") {
    console.log("usage: tool-cache.mjs [--paths|--state|--help]");
  } else if (mode === "--paths") {
    console.log(JSON.stringify(toolCachePaths(), null, 2));
  } else if (mode === "--state") {
    console.log(JSON.stringify(readToolState(), null, 2));
  } else {
    throw new Error("usage: tool-cache.mjs [--paths|--state|--help]");
  }
}
