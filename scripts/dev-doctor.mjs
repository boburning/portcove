import { existsSync, readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand, getPaths, preflight, minimumFreeGiB } from "./dev-storage.mjs";
import { loadQualityManifest } from "./quality-tools.mjs";
import {
  cachedDesktopDrivers,
  checkoutToolEnvironment,
  readToolState,
  runAqua,
  toolCachePaths,
} from "./tool-cache.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function doctorCommand(command, arguments_, options) {
  return command === "aqua"
    ? runAqua(arguments_, options)
    : spawnCommand(command, arguments_, options);
}

function aquaToolPaths(command, environment) {
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

function aquaDefinitions(environment, locate = true) {
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
        cachePackage: packageName,
        cacheVersion: version,
        paths: locate ? aquaToolPaths(command[0], environment) : [],
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

// These are prerequisite observations, never successful execution receipts.
// Test fixtures and build scripts can expose further prerequisites at execution.
export function selectedPrerequisites(entry, platform = process.platform) {
  const ids = new Set(["node"]);
  const rust =
    entry.id === "rustfmt" ||
    entry.id.startsWith("rust-") ||
    ["dependency-policy", "transport-export", "playnite-contract"].includes(entry.id);
  if (rust) {
    ids.add("rustc");
    ids.add("cargo");
  }
  if (entry.id === "rustfmt") ids.add("rustfmt-component");
  if (entry.id.startsWith("rust-clippy") || entry.id === "rust-workspace-clippy")
    ids.add("clippy-component");
  if (entry.id.startsWith("rust-tests") || entry.id === "rust-workspace-tests")
    ids.add("cargo-nextest");
  if (entry.id === "dependency-policy") ids.add("cargo-deny");
  if (
    entry.id.startsWith("ui-") ||
    ["oxfmt", "oxlint", "toml-format", "fallow", "transport-export"].includes(entry.id)
  ) {
    ids.add("pnpm");
    ids.add("frontend-dependencies");
  }
  if (entry.id === "playnite-contract") {
    ids.add("pwsh");
    ids.add("windows-host");
    ids.add("msbuild");
  }
  if (entry.id === "powershell-lint" && platform === "win32") {
    ids.add("pwsh");
    ids.add("psscriptanalyzer");
  }
  if (["shell-lint", "python-lint", "actionlint"].includes(entry.id)) ids.add("aqua-state");
  if (entry.id === "shell-lint") ids.add("shellcheck");
  if (entry.id === "python-lint") ids.add("ruff");
  if (entry.id === "actionlint") {
    ids.add("actionlint");
    ids.add("shellcheck");
  }
  if (entry.id === "lint-tool-fixtures") {
    const selected = entry.args?.slice(1) ?? [];
    const fixtures = {
      oxfmt: ["npm-oxfmt"],
      oxlint: ["npm-oxlint", "npm-oxlint-tsgolint"],
      stylelint: ["npm-stylelint"],
      ruff: ["ruff"],
      shellcheck: ["shellcheck"],
      actionlint: ["actionlint", "shellcheck"],
      psscriptanalyzer: platform === "win32" ? ["pwsh", "psscriptanalyzer"] : [],
    };
    if (!selected.length || selected.some((name) => !Object.hasOwn(fixtures, name)))
      throw new Error("lint fixture prerequisite inventory is unavailable");
    for (const name of selected) for (const id of fixtures[name]) ids.add(id);
    if (["ruff", "shellcheck", "actionlint"].some((id) => ids.has(id))) ids.add("aqua-state");
  }
  if (rust && (entry.id.includes("workspace") || entry.id.includes("portcove-desktop")))
    ids.add("native-desktop-build");
  if (entry.id === "conservative-audit") {
    ids.add("complete-audit-prerequisites");
    ids.add("aqua-state");
  }
  return [...ids];
}

export function existingPnpmDefinition(version, environment = process.env) {
  // Corepack's bundled v1 cache is observed; Corepack itself is never invoked.
  const cache =
    environment.COREPACK_HOME ??
    path.join(
      environment.XDG_CACHE_HOME ??
        environment.LOCALAPPDATA ??
        path.join(os.homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
      "node/corepack",
    );
  const directory = path.join(cache, "v1", "pnpm", version);
  try {
    const cacheRelative = path.relative(realpathSync(cache), realpathSync(directory));
    if (!cacheRelative || cacheRelative.startsWith("..") || path.isAbsolute(cacheRelative))
      return null;
    const metadata = JSON.parse(readFileSync(path.join(directory, ".corepack"), "utf8"));
    if (
      metadata.locator?.name !== "pnpm" ||
      metadata.locator.reference.split("+")[0] !== version ||
      typeof metadata.bin?.pnpm !== "string"
    )
      return null;
    const executable = path.resolve(directory, metadata.bin.pnpm);
    const relative = path.relative(realpathSync(directory), realpathSync(executable));
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !lstatSync(executable).isFile()
    )
      return null;
    return {
      id: "pnpm",
      version,
      command: [process.execPath, executable, "--version"],
      remediation: "run the normal pinned package-manager bootstrap",
    };
  } catch {
    return null;
  }
}

export function existingAquaDefinition(definition, aquaRoot, platform = process.platform) {
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
    const matches = [];
    let entries = 0;
    const visit = (directoryPath, depth) => {
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
    if (matches.length !== 1) return null;
    const payloadRelative = path.relative(realpathSync(directory), realpathSync(matches[0]));
    if (!payloadRelative || payloadRelative.startsWith("..") || path.isAbsolute(payloadRelative))
      return null;
    return {
      ...definition,
      command: [matches[0], definition.id === "actionlint" ? "-version" : "--version"],
    };
  } catch {
    return null;
  }
}

export function existingNpmDefinition(id, base, name, bin) {
  try {
    const desired = JSON.parse(readFileSync(path.join(base, "package.json"), "utf8"))
      .devDependencies?.[name];
    const packageRoot = path.join(base, "node_modules", name);
    const installed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (installed.name !== name || !/^\d+\.\d+\.\d+$/u.test(desired ?? "")) return null;
    const executable = path.resolve(
      packageRoot,
      typeof installed.bin === "string" ? installed.bin : installed.bin[bin],
    );
    const relative = path.relative(realpathSync(packageRoot), realpathSync(executable));
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !lstatSync(executable).isFile()
    )
      return null;
    return {
      id,
      command: [process.execPath, executable, "--version"],
      version: desired,
      installed_version: installed.version,
    };
  } catch {
    return null;
  }
}

export async function collectSelectedPrerequisites(plan, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? doctorCommand;
  const manifest = await loadQualityManifest();
  const repositoryPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const cachePaths = toolCachePaths();
  const environment = {
    ...checkoutToolEnvironment(options.environment ?? process.env, { paths: cachePaths }),
    RUSTUP_AUTO_INSTALL: "0",
  };
  const definitions = {
    node: {
      id: "node",
      command: [process.execPath, "--version"],
      version: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
    },
    pnpm: (options.pnpmDefinition ?? existingPnpmDefinition)(
      repositoryPackage.packageManager.split("@")[1],
      environment,
    ),
    rustc: { id: "rustc", command: ["rustc", "--version"], version: manifest.rust.channel },
    cargo: { id: "cargo", command: ["cargo", "--version"] },
    pwsh: { id: "pwsh", command: ["pwsh", "--version"] },
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
  for (const tool of manifest.tools) definitions[tool.id] = { ...tool, command: tool.command };
  for (const tool of aquaDefinitions(environment, false))
    definitions[tool.id] = (options.aquaDefinition ?? existingAquaDefinition)(
      tool,
      cachePaths.aquaRoot,
      platform,
    );
  const npm = {
    "npm-oxfmt": [root, "oxfmt", "oxfmt"],
    "npm-oxlint": [root, "oxlint", "oxlint"],
    "npm-oxlint-tsgolint": [root, "oxlint-tsgolint", "tsgolint"],
    "npm-stylelint": [path.join(root, "apps/desktop"), "stylelint", "stylelint"],
  };
  for (const [id, [base, name, bin]] of Object.entries(npm)) {
    definitions[id] = existingNpmDefinition(id, base, name, bin);
  }
  const ids = new Set(plan.flatMap((entry) => selectedPrerequisites(entry, platform)));
  const results = [];
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
        status:
          existsSync(path.join(root, "node_modules")) &&
          existsSync(path.join(root, "apps/desktop/node_modules"))
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
    else if (id === "native-desktop-build") {
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
    else if (definitions[id]) results.push(probeTool(definitions[id], run, { environment }));
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
  const repositoryPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const requiredRustDefinitions = manifest.tools.filter((tool) => tool.tier === "required");
  const aquaVersion = readFileSync(path.join(root, ".aqua-version"), "utf8")
    .trim()
    .replace(/^v/u, "");
  const definitions = [
    {
      id: "node",
      command: [process.execPath, "--version"],
      version: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
      remediation:
        process.platform === "win32"
          ? "activate the .node-version runtime, then run ./scripts/bootstrap-quality-tools.ps1"
          : "activate the repository .node-version runtime",
    },
    {
      id: "pnpm",
      command: ["corepack", repositoryPackage.packageManager, "--version"],
      version: repositoryPackage.packageManager.split("@")[1],
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
