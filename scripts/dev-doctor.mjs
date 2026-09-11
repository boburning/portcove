import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand, getPaths, preflight, minimumFreeGiB } from "./dev-storage.mjs";
import { loadQualityManifest } from "./quality-tools.mjs";
import {
  cachedDesktopDrivers,
  checkoutToolEnvironment,
  readToolState,
  toolCachePaths,
} from "./tool-cache.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function aquaToolPaths(command, environment) {
  try {
    const result = spawnCommand("aqua", ["which", command], {
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

function aquaDefinitions(environment) {
  const contents = readFileSync(path.join(root, "aqua.yaml"), "utf8");
  const commands = {
    "astral-sh/ruff": ["ruff", "--version"],
    "rhysd/actionlint": ["actionlint", "-version"],
    "koalaman/shellcheck": ["shellcheck", "--version"],
  };
  return [...contents.matchAll(/^\s*- name: ([^@\s]+)@([^\s]+)$/gmu)].map(
    ([, packageName, version]) => {
      const command = commands[packageName];
      if (!command) throw new Error(`unsupported aqua quality tool: ${packageName}`);
      return {
        id: command[0],
        command: ["aqua", "exec", "--", ...command],
        version: version.replace(/^v/u, ""),
        paths: aquaToolPaths(command[0], environment),
        remediation: "./scripts/bootstrap-quality-tools.ps1",
      };
    },
  );
}

function powershellAnalyzerDefinition() {
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

export function probeTool(definition, run = spawnCommand, options = {}) {
  const { id, command, version = null, required = true } = definition;
  let result;
  try {
    result = run(command[0], command.slice(1), {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      env: options.environment ?? process.env,
    });
  } catch (error) {
    return {
      id,
      required,
      expected: version,
      status: error.code === "ETIMEDOUT" ? "timeout" : "unavailable",
      observed: null,
      remediation: definition.remediation,
    };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const observed = output.match(/(?<![0-9])\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/u)?.[0] ?? null;
  const status =
    result.error?.code === "ETIMEDOUT"
      ? "timeout"
      : result.error || result.status !== 0
        ? "unavailable"
        : version && observed !== version
          ? "mismatch"
          : "ok";
  // Never include raw tool output: unexpected output can contain credentials.
  return { id, required, expected: version, observed, status, remediation: definition.remediation };
}

function executablePaths(command, environment = process.env) {
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
  let installations = [];
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
      if (result.status === 0)
        installations = JSON.parse(result.stdout).map((item) => ({
          name: item.displayName,
          version: item.installationVersion,
          path: item.installationPath,
        }));
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

export async function collectDoctor(options = {}) {
  const profile = options.profile ?? "standard";
  if (!["standard", "desktop"].includes(profile))
    throw new Error(`unknown doctor profile: ${profile}`);
  const cachePaths = toolCachePaths();
  const environment = checkoutToolEnvironment(process.env, { paths: cachePaths });
  const toolState = readToolState({ paths: cachePaths });
  const manifest = await loadQualityManifest();
  const bootstrapManifest = JSON.parse(
    readFileSync(path.join(root, ".config", "tool-bootstrap.json"), "utf8"),
  );
  const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
  const requiredRustDefinitions = manifest.tools.filter((tool) => tool.tier === "required");
  const aquaVersion = readFileSync(path.join(root, ".aqua-version"), "utf8")
    .trim()
    .replace(/^v/u, "");
  const definitions = [
    {
      id: "node",
      command: [process.execPath, "--version"],
      version: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
    },
    {
      id: "pnpm",
      command: ["pnpm", "--version"],
      version: desktop.packageManager.split("@")[1],
      remediation: "./scripts/bootstrap-quality-tools.ps1",
    },
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
    ...requiredRustDefinitions.map((definition) => ({
      ...definition,
      command: [definition.id === "rscheck-cli" ? "rscheck" : definition.crate, "--version"],
      remediation: "./scripts/bootstrap-quality-tools.ps1",
    })),
  ];
  const tools = definitions.map((definition) =>
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
          ...probeTool(definition, spawnCommand, { environment }),
          paths:
            definition.paths ??
            (definition.reportedPath
              ? [definition.reportedPath]
              : executablePaths(definition.command[0], environment)),
        },
  );
  if (profile === "desktop") {
    const drivers = cachedDesktopDrivers({ paths: cachePaths, state: toolState });
    const desktopDefinitions = [
      {
        id: "tauri-driver",
        command: [
          drivers?.driver ?? path.join(cachePaths.shimDirectory, "missing-tauri-driver.exe"),
          "--help",
        ],
        version: bootstrapManifest.desktop.tauri_driver,
        reportedVersion: toolState?.desktop?.tauri_driver_version ?? null,
      },
      {
        id: "msedgedriver",
        command: [
          drivers?.nativeDriver ?? path.join(cachePaths.shimDirectory, "missing-msedgedriver.exe"),
          "--version",
        ],
        version: toolState?.desktop?.webview2_version ?? null,
      },
    ];
    for (const definition of desktopDefinitions) {
      let result = probeTool(definition, spawnCommand, { environment });
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
  let storage;
  try {
    storage = { status: "ok", ...preflight(getPaths(), minimumFreeGiB()) };
  } catch (error) {
    storage = { status: "failed", message: error.message };
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
    console.log("usage: dev-doctor.mjs [--json] [--profile standard|desktop] [--help]");
    process.exit(0);
  }
  let profile = "standard";
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") asJson = true;
    else if (args[index] === "--profile") {
      profile = args[++index];
      if (!profile) throw new Error("--profile requires standard or desktop");
    } else throw new Error("usage: dev-doctor.mjs [--json] [--profile standard|desktop] [--help]");
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
    if (report.storage.paths)
      for (const [name, value] of Object.entries(report.storage.paths))
        console.log(`  ${name}: ${value}`);
    if (report.storage.message) console.log(report.storage.message);
    if (report.msvc) console.log(`MSVC: ${JSON.stringify(report.msvc)}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
