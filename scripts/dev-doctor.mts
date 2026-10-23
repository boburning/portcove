import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { StoragePaths, StorageVolume } from "./dev-storage.mts";
import type { ValidationCapabilityEntry } from "./development-capabilities.mts";
import { existsSync, readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnCommand,
  getPaths,
  preflight,
  minimumFreeGiB,
  resolvePhysicalPath,
} from "./dev-storage.mts";
import { loadQualityManifest } from "./quality-tools.mts";
import type { QualityTool } from "./quality-tools.mts";
import type { ToolCachePaths } from "./tool-cache.mts";
import {
  cachedDesktopDrivers,
  checkoutToolEnvironment,
  readToolState,
  runAqua,
  toolCachePaths,
} from "./tool-cache.mts";

import {
  developmentProfiles,
  developmentCapabilityPlan,
  validationCapabilities as selectedPrerequisites,
} from "./development-capabilities.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
function isWebViewVersion(value: unknown): value is string {
  // Same registered Evergreen identity admitted by bootstrap's Get-WebViewRuntimeVersion.
  return typeof value === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(value);
}
export interface ToolDefinition {
  id: string;
  command: [string, ...string[]];
  version?: string | null | undefined;
  required?: boolean;
  remediation?: string | undefined;
  version_source?: "installed-package";
  installed_version?: string | undefined;
  applicable?: boolean;
  paths?: string[];
  reportedPath?: string;
  reportedVersion?: string | null;
}
interface AquaDefinition extends Omit<ToolDefinition, "command"> {
  command?: ToolDefinition["command"];
  cachePackage: string;
  cacheVersion: string;
}
export type DoctorRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => {
  status: number | null;
  stdout?: string | undefined;
  stderr?: string;
  error?: unknown;
};
export interface DoctorOptions {
  platform?: string;
  profile?: string;
  run?: DoctorRunner;
  environment?: NodeJS.ProcessEnv;
  capabilities?: readonly string[];
  pnpmDefinition?: (version: string, environment: NodeJS.ProcessEnv) => ToolDefinition | null;
  aquaDefinition?: typeof existingAquaDefinition;
  readToolState?: typeof readToolState;
  desktopDrivers?: typeof cachedDesktopDrivers;
  frontendDependenciesAvailable?: () => boolean;
  temporaryDirectory?: string;
  storage?: { paths?: Partial<StoragePaths>; volumes?: StorageVolume[] };
}

function doctorCommand(
  command: string,
  arguments_: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  return command === "aqua"
    ? runAqua(arguments_, options)
    : spawnCommand(command, arguments_, options);
}

function aquaToolPaths(command: string, environment: NodeJS.ProcessEnv) {
  try {
    const result = doctorCommand("aqua", ["which", command], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: environment,
    });
    return result.status === 0 && result.stdout.trim() ? [result.stdout.trim()] : [];
  } catch {
    return [];
  }
}

function aquaDefinitions(
  environment: NodeJS.ProcessEnv,
  locate = true,
): (AquaDefinition & ToolDefinition)[] {
  const contents = readFileSync(path.join(root, "aqua.yaml"), "utf8");
  const commands = new Map<string, [string, ...string[]]>([
    ["astral-sh/ruff", ["ruff", "--version"]],
    ["rhysd/actionlint", ["actionlint", "-version"]],
    ["koalaman/shellcheck", ["shellcheck", "--version"]],
  ]);
  return [...contents.matchAll(/^\s*- name: ([^@\s]+)@([^\s]+)$/gmu)].map(
    ([, packageName, version]) => {
      const command = packageName ? commands.get(packageName) : undefined;
      if (!command) throw new Error(`unsupported aqua quality tool: ${packageName}`);
      if (!packageName || !version) throw new Error("incomplete Aqua quality tool identity");
      return {
        id: command[0],
        command: ["aqua", "exec", "--", ...command],
        version: version.replace(/^v/u, ""),
        cachePackage: packageName,
        cacheVersion: version,
        paths: locate ? aquaToolPaths(command[0], environment) : [],
        remediation: "./scripts/bootstrap-quality-tools.ps1",
      };
    },
  );
}

function powershellAnalyzerDefinition(): ToolDefinition {
  const contents = readFileSync(path.join(root, ".config", "powershell-resources.psd1"), "utf8");
  const version = contents.match(/version\s*=\s*'([^']+)'/u)?.[1];
  if (!version) throw new Error("PSScriptAnalyzer version is missing");
  return {
    id: "psscriptanalyzer",
    command: [
      "pwsh",
      "-NoProfile",
      "-Command",
      `Import-Module PSScriptAnalyzer -RequiredVersion ${version} -Force; (Get-Module PSScriptAnalyzer).Version.ToString()`,
    ],
    version,
  };
}

function probePnpmVersion(
  command: string,
  version: string | null,
  run: DoctorRunner,
  options: SpawnSyncOptionsWithStringEncoding,
) {
  const deadline = Date.now() + 15_000;
  const environment: NodeJS.ProcessEnv = { ...options.env, COREPACK_ENABLE_NETWORK: "0" };
  delete environment.VP_DUMP_DIRS;
  const invoke = (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0)
      throw Object.assign(new Error("pnpm observation timed out"), { code: "ETIMEDOUT" });
    return run(executable, args, { ...options, env, timeout });
  };
  const layoutDump = (output: string) => /^(?:layout|data|bin|cache|config|state)\t/mu.test(output);
  // The supported Vite+ installer probe exits before shim acquisition. Other
  // pnpm providers ignore it and retain their ordinary version observation.
  const initial = invoke(command, ["--version"], { ...environment, VP_DUMP_DIRS: "1" });
  if (initial.error || initial.status !== 0 || !layoutDump(initial.stdout ?? "")) return initial;
  const directories = [...(initial.stdout ?? "").matchAll(/^bin\t([^\r\n]+)$/gmu)];
  const bin = directories[0]?.[1];
  if (directories.length !== 1 || !bin || !path.isAbsolute(bin) || bin.includes("\0"))
    throw new Error("Vite+ did not report an absolute executable directory");
  const resolved = invoke(
    path.join(bin, process.platform === "win32" ? "vp.exe" : "vp"),
    ["env", "current", "pnpm", "--json"],
    environment,
  );
  if (resolved.error || resolved.status !== 0) return resolved;
  const metadata: unknown = JSON.parse(resolved.stdout ?? "");
  const manager = isRecord(metadata) ? metadata.package_manager : null;
  if (
    !isRecord(manager) ||
    manager.name !== "pnpm" ||
    manager.installed !== true ||
    typeof manager.version !== "string" ||
    (version !== null && manager.version !== version) ||
    !isRecord(manager.bin_paths) ||
    typeof manager.bin_paths.pnpm !== "string" ||
    !path.isAbsolute(manager.bin_paths.pnpm) ||
    manager.bin_paths.pnpm.includes("\0")
  )
    throw new Error(
      "The repository-pinned pnpm payload is not installed in the selected environment",
    );
  const searchPath =
    Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const payloadEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== "path"),
  );
  const observed = invoke(manager.bin_paths.pnpm, ["--version"], {
    ...payloadEnvironment,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${searchPath}`,
    VP_DUMP_DIRS: "1",
  });
  if (layoutDump(observed.stdout ?? ""))
    throw new Error("Vite+ resolved pnpm to another acquiring shim");
  return observed;
}

export function probeTool(
  definition: ToolDefinition,
  run: DoctorRunner = spawnCommand,
  options: { environment?: NodeJS.ProcessEnv } = {},
): PrerequisiteObservation {
  const { id, command, version = null, required = true } = definition;
  const versionEvidence =
    definition.version_source === "installed-package"
      ? { version_source: definition.version_source }
      : {};
  let result;
  try {
    const probeOptions: SpawnSyncOptionsWithStringEncoding = {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      env: options.environment ?? process.env,
    };
    result =
      id === "pnpm" && command.length === 2 && command[1] === "--version"
        ? probePnpmVersion(command[0], version, run, probeOptions)
        : run(command[0], command.slice(1), probeOptions);
  } catch (error) {
    return {
      id,
      required,
      expected: version,
      status: errorCode(error) === "ETIMEDOUT" ? "timeout" : "unavailable",
      observed: null,
      remediation: definition.remediation,
      ...versionEvidence,
    };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const observed =
    definition.version_source === "installed-package"
      ? definition.installed_version
      : (output.match(/(?<![0-9])\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/u)?.[0] ?? null);
  const status =
    errorCode(result.error) === "ETIMEDOUT"
      ? "timeout"
      : result.error || result.status !== 0
        ? "unavailable"
        : version && observed !== version
          ? "mismatch"
          : "ok";
  // Never include raw tool output: unexpected output can contain credentials.
  return {
    id,
    required,
    expected: version,
    observed,
    status,
    remediation: definition.remediation,
    ...versionEvidence,
  };
}

// These are prerequisite observations, never successful execution receipts.
// Test fixtures and build scripts can expose further prerequisites at execution.
export { selectedPrerequisites };

export function pnpmDefinition(version: string): ToolDefinition {
  return {
    id: "pnpm",
    version,
    command: ["pnpm", "--version"],
    remediation: "run vp env install, then provide the repository-pinned pnpm on PATH",
  };
}

export function cachedRustDefinition(
  definition: QualityTool,
  cachePaths: Pick<ToolCachePaths, "cargoRoot">,
  platform = process.platform,
): ToolDefinition {
  const binary = definition.id === "rscheck-cli" ? "rscheck" : definition.crate;
  // Windows executable lookup can prefer an ambient .exe over a preceding .cmd shim.
  // Probe the bootstrap-owned versioned payload directly, and fail if it is absent.
  const command =
    platform === "win32"
      ? path.join(
          cachePaths.cargoRoot,
          definition.crate,
          definition.version,
          "bin",
          `${binary}.exe`,
        )
      : binary;
  return {
    ...definition,
    command: [command, "--version"],
    remediation: "./scripts/bootstrap-quality-tools.ps1",
  };
}

export function existingAquaDefinition(
  definition: AquaDefinition,
  aquaRoot: string,
  platform: string = process.platform,
): (AquaDefinition & ToolDefinition) | null {
  try {
    const rootPath = realpathSync(aquaRoot);
    const directory = path.join(
      aquaRoot,
      "pkgs/github_release/github.com",
      definition.cachePackage,
      definition.cacheVersion,
    );
    const relative = path.relative(rootPath, realpathSync(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const matches: string[] = [];
    let entries = 0;
    const visit = (directoryPath: string, depth: number): void => {
      if (depth > 4) throw new Error("cached payload depth exceeds the bounded observation");
      for (const item of readdirSync(directoryPath, { withFileTypes: true })) {
        if (++entries > 256 || item.isSymbolicLink())
          throw new Error("cached payload discovery is ambiguous or linked");
        const absolute = path.join(directoryPath, item.name);
        if (item.isDirectory()) visit(absolute, depth + 1);
        else if (
          item.isFile() &&
          item.name === `${definition.id}${platform === "win32" ? ".exe" : ""}`
        )
          matches.push(absolute);
      }
    };
    visit(directory, 0);
    const payload = matches[0];
    if (matches.length !== 1 || !payload) return null;
    const payloadRelative = path.relative(realpathSync(directory), realpathSync(payload));
    if (!payloadRelative || payloadRelative.startsWith("..") || path.isAbsolute(payloadRelative))
      return null;
    return {
      ...definition,
      command: [payload, definition.id === "actionlint" ? "-version" : "--version"],
    };
  } catch {
    return null;
  }
}

function isYamlModule(value: unknown): value is Pick<typeof import("yaml"), "parse"> {
  return isRecord(value) && typeof value.parse === "function";
}
export function existingNpmDefinition(
  id: string,
  base: string,
  name: string,
  bin: string,
): ToolDefinition | null {
  try {
    const repositoryPackage: unknown = JSON.parse(
      readFileSync(path.join(base, "package.json"), "utf8"),
    );
    let desired: unknown =
      isRecord(repositoryPackage) && isRecord(repositoryPackage.devDependencies)
        ? repositoryPackage.devDependencies[name]
        : undefined;
    if (desired === "catalog:") {
      const yaml: unknown = createRequire(import.meta.url)("yaml");
      if (!isYamlModule(yaml)) return null;
      const workspace: unknown = yaml.parse(
        readFileSync(path.join(base, "pnpm-workspace.yaml"), "utf8"),
      );
      if (!isRecord(workspace) || !isRecord(workspace.catalog)) return null;
      desired = String(workspace.catalog[name]);
    }
    const packageRoot = path.join(base, "node_modules", name);
    const installed: unknown = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (
      !isRecord(installed) ||
      installed.name !== name ||
      typeof desired !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(desired)
    )
      return null;
    const launcher =
      typeof installed.bin === "string"
        ? installed.bin
        : isRecord(installed.bin)
          ? installed.bin[bin]
          : undefined;
    if (typeof launcher !== "string") return null;
    const executable = path.resolve(packageRoot, launcher);
    const relative = path.relative(realpathSync(packageRoot), realpathSync(executable));
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !lstatSync(executable).isFile()
    )
      return null;
    // tsgolint has no version flag. Its help command checks launcher/native
    // startup; the installed package metadata supplies distinct version evidence.
    const packageVersion = name === "oxlint-tsgolint" && bin === "tsgolint";
    if (
      packageVersion &&
      (typeof installed.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(installed.version))
    )
      return null;
    if (installed.version !== undefined && typeof installed.version !== "string") return null;
    return {
      id,
      command: [process.execPath, executable, packageVersion ? "--help" : "--version"],
      version: desired,
      installed_version: installed.version,
      ...(packageVersion ? { version_source: "installed-package" } : {}),
    };
  } catch {
    return null;
  }
}

export interface PrerequisiteObservation {
  id: string;
  status: string;
  remediation?: string | undefined;
  required?: boolean;
  expected?: string | null | undefined;
  observed?: string | null | undefined;
  version_source?: string;
  observed_bytes?: number;
  maximum_bytes?: number;
  interpretation?: string;
}

export async function collectSelectedPrerequisites(
  plan: readonly ValidationCapabilityEntry[],
  options: DoctorOptions = {},
): Promise<PrerequisiteObservation[]> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? doctorCommand;
  const manifest = await loadQualityManifest();
  const cachePaths = toolCachePaths();
  const packageManagerVersion = cachePaths.pins.packageManager.split("@")[1];
  if (!packageManagerVersion) throw new Error("packageManager version is unavailable");
  const environment = {
    ...checkoutToolEnvironment(options.environment ?? process.env, { paths: cachePaths }),
    RUSTUP_AUTO_INSTALL: "0",
    COREPACK_ENABLE_NETWORK: "0",
  };
  const definitions: Record<string, ToolDefinition | null> = {
    node: {
      id: "node",
      command: [process.execPath, "--version"],
      version: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
    },
    pnpm: (options.pnpmDefinition ?? pnpmDefinition)(packageManagerVersion, environment),
    git: { id: "git", command: ["git", "--version"] },
    aqua: { id: "aqua", command: ["aqua", "--version"], version: cachePaths.pins.aquaSemver },
    "tauri-driver": { id: "tauri-driver", command: ["tauri-driver", "--help"] },
    "native-driver": { id: "native-driver", command: ["WebKitWebDriver", "--help"] },
    xvfb: { id: "xvfb", command: ["Xvfb", "-help"] },
    rustc: { id: "rustc", command: ["rustc", "--version"], version: manifest.rust.channel },
    cargo: { id: "cargo", command: ["cargo", "--version"] },
    pwsh: {
      id: "pwsh",
      command: ["pwsh", "--version"],
      remediation: "provide bare pwsh on PATH on the selected host",
    },
    "rustfmt-component": { id: "rustfmt-component", command: ["cargo", "fmt", "--version"] },
    "clippy-component": { id: "clippy-component", command: ["cargo", "clippy", "--version"] },
    psscriptanalyzer: powershellAnalyzerDefinition(),
    msbuild: {
      id: "msbuild",
      command: [
        "pwsh",
        "-NoProfile",
        "-Command",
        "$locator=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'; if (!(Test-Path -LiteralPath $locator)) { exit 1 }; $candidate=& $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\\**\\Bin\\MSBuild.exe' | Select-Object -First 1; if (!$candidate) { exit 1 }; & $candidate -version -nologo; exit $LASTEXITCODE",
      ],
      remediation: "use Windows with the existing Visual Studio MSBuild installation",
    },
  };
  for (const tool of manifest.tools)
    definitions[tool.id] =
      platform === "win32"
        ? cachedRustDefinition(tool, cachePaths, platform)
        : { ...tool, command: tool.command };
  for (const tool of aquaDefinitions(environment, false))
    definitions[tool.id] = (options.aquaDefinition ?? existingAquaDefinition)(
      tool,
      cachePaths.aquaRoot,
      platform,
    );
  const npm: [id: string, source: [base: string, name: string, bin: string]][] = [
    ["npm-vite-plus", [root, "vite-plus", "vp"]],
    ["npm-stylelint", [path.join(root, "apps/desktop"), "stylelint", "stylelint"]],
  ];
  for (const [id, [base, name, bin]] of npm) {
    definitions[id] = existingNpmDefinition(id, base, name, bin);
  }
  const ids = new Set(
    options.capabilities ?? plan.flatMap((entry) => selectedPrerequisites(entry, platform)),
  );
  if (platform === "win32" && (ids.has("tauri-driver") || ids.has("native-driver"))) {
    const state = (options.readToolState ?? readToolState)({ paths: cachePaths });
    const drivers = (options.desktopDrivers ?? cachedDesktopDrivers)({ paths: cachePaths, state });
    const desktopState = isRecord(state) && isRecord(state.desktop) ? state.desktop : null;
    const desktopPin = cachePaths.pins.bootstrap.desktop;
    const version = desktopState?.tauri_driver_version;
    const pinned = desktopPin && typeof version === "string" && version === desktopPin.tauri_driver;
    definitions["tauri-driver"] =
      drivers && pinned
        ? {
            id: "tauri-driver",
            command: [drivers.driver, "--help"],
            version: desktopPin.tauri_driver,
            version_source: "installed-package",
            installed_version: version,
          }
        : null;
    definitions["native-driver"] =
      drivers && pinned && isWebViewVersion(desktopState?.webview2_version)
        ? {
            id: "native-driver",
            command: [drivers.nativeDriver, "--version"],
            version: desktopState.webview2_version,
          }
        : null;
  }
  if (platform === "darwin" && ids.has("native-driver")) definitions["native-driver"] = null;
  const results: PrerequisiteObservation[] = [];
  for (const id of ids) {
    if (id === "windows-host")
      results.push({
        id,
        status: platform === "win32" ? "ok" : "unavailable",
        remediation:
          "use the owning Windows qualification route; the Ubuntu selected route cannot execute this obligation",
      });
    else if (id === "msbuild" && platform !== "win32")
      results.push({
        id,
        status: "unavailable",
        remediation: "Windows/MSBuild execution is required",
      });
    else if (id === "frontend-dependencies")
      results.push({
        id,
        status: (
          options.frontendDependenciesAvailable ??
          (() =>
            existsSync(path.join(root, "node_modules")) &&
            existsSync(path.join(root, "apps/desktop/node_modules")))
        )()
          ? "ok"
          : "unavailable",
        remediation: "pnpm install --frozen-lockfile",
      });
    else if (id === "aqua-state")
      results.push({
        id,
        status:
          platform !== "win32" || (options.readToolState ?? readToolState)({ paths: cachePaths })
            ? "ok"
            : "unavailable",
        remediation: "./scripts/bootstrap-quality-tools.ps1",
      });
    else if (["tauri-driver", "native-driver"].includes(id) && platform !== "win32") {
      results.push({
        id,
        status: "unverified",
        remediation:
          "use the owning approved native platform route to establish driver pin and installed identity; arbitrary PATH help is not native readiness",
      });
    } else if (id === "native-desktop-build") {
      if (platform === "linux")
        results.push(
          probeTool(
            {
              id,
              command: ["pkg-config", "--exists", "gtk+-3.0", "webkit2gtk-4.1", "libsoup-3.0"],
              remediation:
                "use the approved hosted local-check route or scripts/install-linux-desktop-prerequisites.sh",
            },
            run,
            { environment },
          ),
        );
      else if (platform === "win32" && options.profile === "native-desktop")
        results.push({
          ...probeTool(
            {
              id,
              command: [
                "pwsh",
                "-NoProfile",
                "-Command",
                "$locator=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'; if (!(Test-Path -LiteralPath $locator)) { exit 1 }; $compiler=& $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\\Tools\\MSVC\\*\\bin\\Hostx64\\x64\\cl.exe' | Select-Object -First 1; if (!$compiler -or !(Test-Path -LiteralPath $compiler) -or !(Test-Path -LiteralPath (Join-Path (Split-Path $compiler) 'link.exe'))) { exit 1 }; Write-Output 'MSVC compiler and linker are installed'",
              ],
              remediation: "establish the existing Visual Studio C++ build prerequisites",
            },
            run,
            { environment },
          ),
          interpretation:
            "Installed compiler/linker presence only; Cargo selection and native execution remain separate evidence",
        });
      else
        results.push({
          id,
          status: "unverified",
          remediation:
            platform === "win32"
              ? "just doctor --profile desktop; establish the selected MSVC build environment"
              : "establish the Xcode command-line build prerequisites",
        });
    } else if (id === "complete-audit-prerequisites")
      results.push({
        id,
        status: "unverified",
        remediation: "just doctor; qualify the complete audit on an approved capable host",
      });
    else if (id === "unix-socket-path") {
      // The selected Linux Rust stage runs source_import_tests.rs's UnixListener
      // under tempfile::tempdir(): .tmp plus six ASCII characters, then owned-bus.
      // Linux sockaddr_un.sun_path holds 108 bytes including its terminator.
      const remediation =
        "use a shorter physical temporary directory on the selected Linux audit host";
      try {
        const temporary = resolvePhysicalPath(
          options.temporaryDirectory ?? getPaths("tooling").temporary_directory,
        );
        const observedBytes = Buffer.byteLength(path.join(temporary, ".tmpXXXXXX", "owned-bus"));
        results.push({
          id,
          status: observedBytes <= 107 ? "ok" : "unavailable",
          observed_bytes: observedBytes,
          maximum_bytes: 107,
          remediation,
        });
      } catch {
        results.push({ id, status: "unverified", remediation });
      }
    } else if (definitions[id]) results.push(probeTool(definitions[id], run, { environment }));
    else if (Object.hasOwn(definitions, id))
      results.push({
        id,
        status: "unavailable",
        remediation:
          "run the normal pinned tool bootstrap; no cache bytes are provisioned by preflight",
      });
    else throw new Error(`unowned prerequisite: ${id}`);
  }
  return results;
}

function executablePaths(command: string, environment = process.env) {
  if (path.isAbsolute(command)) return existsSync(command) ? [command] : [];
  try {
    const result = spawnCommand(process.platform === "win32" ? "where.exe" : "which", [command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      env: environment,
    });
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function windowsCompilers() {
  if (process.platform !== "win32") return null;
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const installations: { name: string; version: string; path: string }[] = [];
  if (existsSync(vswhere)) {
    try {
      const result = spawnCommand(
        vswhere,
        [
          "-all",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-format",
          "json",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        },
      );
      if (result.status === 0) {
        const inventory: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(inventory)) throw new Error("invalid Visual Studio inventory");
        const candidates: unknown[] = inventory;
        const observed = candidates.map((item) => {
          if (
            !isRecord(item) ||
            typeof item.displayName !== "string" ||
            typeof item.installationVersion !== "string" ||
            typeof item.installationPath !== "string"
          )
            throw new Error("invalid Visual Studio installation");
          return {
            name: item.displayName,
            version: item.installationVersion,
            path: item.installationPath,
          };
        });
        installations.push(...observed);
      }
    } catch {
      /* Absence is reported below; never infer the compiler selected by Cargo. */
    }
  }
  return {
    installations,
    path_compilers: executablePaths("cl.exe"),
    path_linkers: executablePaths("link.exe"),
    developer_environment: process.env.VCToolsInstallDir ?? null,
    interpretation:
      "Installed and PATH candidates only. Cargo may auto-discover another MSVC installation; use a verbose build to establish its selection.",
  };
}

type StorageObservation =
  | { status: "ok"; paths?: Partial<StoragePaths>; volumes?: StorageVolume[] }
  | { status: "failed"; message: string };
interface DoctorReport {
  format_version: 2;
  profile: string;
  platform: string;
  architecture: string;
  workspace: string;
  capabilities?: string[];
  ok: boolean;
  tools: (PrerequisiteObservation & { paths: string[] })[];
  cache: {
    status: string;
    shared_root?: string;
    shim_directory?: string;
    pin_fingerprint?: string;
  };
  storage: StorageObservation;
  msvc: ReturnType<typeof windowsCompilers>;
}
export async function collectProfileDoctor(
  profile: string,
  options: DoctorOptions = {},
): Promise<DoctorReport & { capabilities: string[] }> {
  const plan = await developmentCapabilityPlan(profile, {
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const tools = await collectSelectedPrerequisites([], {
    ...options,
    profile,
    capabilities: plan.capabilities,
  });
  let storage: StorageObservation;
  try {
    const scope = profile === "frontend" ? "frontend" : profile === "core" ? "rust" : "all";
    storage = {
      status: "ok",
      ...(options.storage ?? preflight(getPaths(scope), minimumFreeGiB())),
    };
  } catch (error) {
    storage = { status: "failed", message: errorMessage(error) };
  }
  return {
    format_version: 2,
    profile,
    platform: options.platform ?? process.platform,
    architecture: process.arch,
    workspace: root,
    capabilities: plan.capabilities,
    ok: storage.status === "ok" && tools.every((tool) => tool.status === "ok"),
    tools: tools.map((tool) => ({ ...tool, required: true, paths: [] })),
    cache: { status: "not inferred from profile observations" },
    storage,
    msvc: null,
  };
}

export async function collectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const profile = options.profile ?? "standard";
  if (developmentProfiles.some((known) => known === profile))
    return collectProfileDoctor(profile, options);
  if (!["standard", "desktop"].includes(profile))
    throw new Error(`unknown doctor profile: ${profile}`);
  const cachePaths = toolCachePaths({ environment: options.environment ?? process.env });
  const environment = checkoutToolEnvironment(options.environment ?? process.env, {
    paths: cachePaths,
  });
  const toolState = readToolState({ paths: cachePaths });
  const manifest = await loadQualityManifest();
  const bootstrapManifest = cachePaths.pins.bootstrap;
  const packageManagerVersion = cachePaths.pins.packageManager.split("@")[1];
  if (!packageManagerVersion) throw new Error("packageManager version is unavailable");
  const requiredRustDefinitions = manifest.tools.filter((tool) => tool.tier === "required");
  const aquaVersion = readFileSync(path.join(root, ".aqua-version"), "utf8")
    .trim()
    .replace(/^v/u, "");
  const definitions: ToolDefinition[] = [
    {
      id: "node",
      command: [process.execPath, "--version"],
      version: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
      remediation:
        process.platform === "win32"
          ? "activate the .node-version runtime, then run ./scripts/bootstrap-quality-tools.ps1"
          : "activate the repository .node-version runtime",
    },
    pnpmDefinition(packageManagerVersion),
    {
      id: "rustc",
      command: ["rustc", "--version"],
      version: manifest.rust.channel,
    },
    { id: "cargo", command: ["cargo", "--version"] },
    { id: "git", command: ["git", "--version"] },
    { id: "gh", command: ["gh", "--version"], required: false },
    {
      id: "aqua",
      command: ["aqua", "--version"],
      version: aquaVersion,
      ...(process.platform === "win32" ? { paths: [cachePaths.aquaExecutable] } : {}),
      remediation: "./scripts/bootstrap-quality-tools.ps1",
    },
    ...aquaDefinitions(environment),
    process.platform === "win32"
      ? powershellAnalyzerDefinition()
      : {
          id: "psscriptanalyzer",
          command: ["pwsh", "-NoProfile", "-Command"],
          applicable: false,
          required: false,
        },
    ...requiredRustDefinitions.map((definition) => cachedRustDefinition(definition, cachePaths)),
  ];
  const tools: DoctorReport["tools"] = definitions.map((definition) =>
    definition.applicable === false
      ? {
          id: definition.id,
          required: false,
          expected: definition.version,
          observed: null,
          status: "not-applicable",
          paths: [],
        }
      : {
          ...probeTool(definition, doctorCommand, { environment }),
          paths:
            definition.paths ??
            (definition.reportedPath
              ? [definition.reportedPath]
              : executablePaths(definition.command[0], environment)),
        },
  );
  if (profile === "desktop") {
    const drivers = cachedDesktopDrivers({ paths: cachePaths, state: toolState });
    const desktopPin = bootstrapManifest.desktop;
    if (!desktopPin) throw new Error("desktop bootstrap pins are unavailable");
    const desktopState =
      isRecord(toolState) && isRecord(toolState.desktop) ? toolState.desktop : null;
    const reportedDriverVersion =
      typeof desktopState?.tauri_driver_version === "string"
        ? desktopState.tauri_driver_version
        : null;
    const reportedWebviewVersion = isWebViewVersion(desktopState?.webview2_version)
      ? desktopState.webview2_version
      : null;
    const desktopDefinitions: ToolDefinition[] = [
      {
        id: "tauri-driver",
        command: [
          drivers?.driver ?? path.join(cachePaths.shimDirectory, "missing-tauri-driver.exe"),
          "--help",
        ],
        version: desktopPin.tauri_driver,
        reportedVersion: reportedDriverVersion,
      },
      {
        id: "msedgedriver",
        command: [
          drivers?.nativeDriver ?? path.join(cachePaths.shimDirectory, "missing-msedgedriver.exe"),
          "--version",
        ],
        version: reportedWebviewVersion,
      },
    ];
    for (const definition of desktopDefinitions) {
      if (definition.id === "msedgedriver" && !reportedWebviewVersion) {
        tools.push({
          id: definition.id,
          required: true,
          expected: null,
          observed: null,
          status: "unavailable",
          remediation: "./scripts/bootstrap-quality-tools.ps1 -Desktop",
          paths: [],
        });
        continue;
      }
      let result = probeTool(definition, doctorCommand, { environment });
      if (definition.reportedVersion && result.status === "mismatch") {
        result = { ...result, observed: definition.reportedVersion, status: "ok" };
      }
      tools.push({
        ...result,
        required: true,
        remediation: "./scripts/bootstrap-quality-tools.ps1 -Desktop",
        paths: path.isAbsolute(definition.command[0]) ? [definition.command[0]] : [],
      });
    }
  }
  let storage: StorageObservation;
  try {
    storage = { status: "ok", ...preflight(getPaths(), minimumFreeGiB()) };
  } catch (error) {
    storage = { status: "failed", message: errorMessage(error) };
  }
  return {
    format_version: 2,
    profile,
    platform: process.platform,
    architecture: process.arch,
    workspace: root,
    ok: storage.status === "ok" && tools.every((tool) => !tool.required || tool.status === "ok"),
    tools,
    cache: {
      status: toolState ? "ready" : "not-bootstrapped",
      shared_root: cachePaths.sharedRoot,
      shim_directory: cachePaths.shimDirectory,
      pin_fingerprint: cachePaths.pins.fingerprint,
    },
    storage,
    msvc: windowsCompilers(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "usage: dev-doctor.mts [--json] [--profile standard|desktop|frontend|core|daily|native-desktop|native-drivers] [--help]",
    );
    process.exit(0);
  }
  let profile = "standard";
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") asJson = true;
    else if (args[index] === "--profile") {
      const nextProfile = args[++index];
      if (!nextProfile) throw new Error("--profile requires a development profile");
      profile = nextProfile;
    } else
      throw new Error(
        "usage: dev-doctor.mts [--json] [--profile standard|desktop|frontend|core|daily|native-desktop|native-drivers] [--help]",
      );
  }
  const report = await collectDoctor({ profile });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Development doctor: ${report.ok ? "ready" : "needs attention"} (${report.platform}/${report.architecture})`,
    );
    for (const tool of report.tools)
      console.log(
        `${tool.id}: ${tool.status} (${tool.observed ?? "unknown"}; expected ${tool.expected ?? "available"}) ${tool.paths.join(", ")}`,
      );
    for (const tool of report.tools)
      if (tool.status !== "ok" && tool.remediation)
        console.log(`  remedy ${tool.id}: ${tool.remediation}`);
    console.log(`Tool cache: ${report.cache.status}`);
    console.log(`  shared: ${report.cache.shared_root}`);
    console.log(`  shims:  ${report.cache.shim_directory}`);
    console.log(`Storage: ${report.storage.status}`);
    if (report.storage.status === "ok" && report.storage.paths)
      for (const [name, value] of Object.entries(report.storage.paths))
        console.log(`  ${name}: ${value}`);
    if (report.storage.status === "failed") console.log(report.storage.message);
    if (report.msvc) console.log(`MSVC: ${JSON.stringify(report.msvc)}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
