import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadQualityManifest } from "./quality-tools.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const developmentProfiles = Object.freeze(["frontend", "core", "daily", "native-desktop"]);

// Capability names describe requested work, never successful execution evidence.
export function profileCapabilities(
  profile,
  { platform = process.platform, requiredTools = null } = {},
) {
  if (!developmentProfiles.includes(profile))
    throw new Error(`unknown development profile: ${profile}`);
  const frontend = ["node", "pnpm", "frontend-dependencies"];
  const core = ["rustc", "cargo", "rustfmt-component", "clippy-component", "cargo-nextest"];
  if (profile === "frontend") return frontend;
  if (profile === "core") return core;
  if (!Array.isArray(requiredTools) || requiredTools.length === 0)
    throw new Error("daily capability selection requires the current required-tool inventory");
  const daily = [
    ...new Set([
      ...frontend,
      ...core,
      "git",
      "pwsh",
      "aqua-state",
      "aqua",
      "ruff",
      "shellcheck",
      "actionlint",
      ...requiredTools,
      ...(platform === "win32" ? ["psscriptanalyzer"] : []),
    ]),
  ];
  return profile === "daily"
    ? daily
    : [
        ...daily,
        "native-desktop-build",
        "tauri-driver",
        "native-driver",
        ...(platform === "linux" ? ["xvfb"] : []),
      ];
}

export async function developmentCapabilityPlan(profile, options = {}) {
  const projectRoot = options.projectRoot ?? root;
  const manifest = options.manifest ?? (await loadQualityManifest());
  const capabilities = profileCapabilities(profile, {
    platform: options.platform ?? process.platform,
    requiredTools: manifest.tools.filter((tool) => tool.tier === "required").map((tool) => tool.id),
  });
  const read = (name) => readFileSync(path.join(projectRoot, name), "utf8");
  const rust = read("rust-toolchain.toml").match(/^channel\s*=\s*"([^"]+)"/mu)?.[1];
  if (rust !== manifest.rust.channel)
    throw new Error("rust-toolchain.toml drifted from quality-tools.json");
  return {
    format_version: 1,
    profile,
    platform: options.platform ?? process.platform,
    capabilities,
    setup: {
      frontend: capabilities.includes("frontend-dependencies"),
      rust: capabilities.includes("rustc"),
      aqua: capabilities.includes("aqua"),
      native: capabilities.includes("native-desktop-build"),
      cargo_tools: manifest.tools.filter((tool) => capabilities.includes(tool.id)),
    },
    pins: {
      node: read(".node-version").trim(),
      package_manager: JSON.parse(read("package.json")).packageManager,
      rust,
      rust_components: manifest.rust.components,
    },
  };
}

export function validationCapabilities(entry, platform = process.platform) {
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
    if (entry.args?.includes("release-unit")) ids.add("pwsh");
    if (platform === "linux" && entry.args?.includes("rust")) ids.add("unix-socket-path");
  }
  return [...ids];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help"))
    console.log(
      "usage: development-capabilities.mjs --profile frontend|core|daily|native-desktop [--platform win32|linux|darwin]",
    );
  else {
    try {
      let profile,
        platform = process.platform;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "--profile") profile = args[++index];
        else if (args[index] === "--platform") platform = args[++index];
        else throw new Error(`unknown capability option: ${args[index]}`);
      }
      if (!["win32", "linux", "darwin"].includes(platform))
        throw new Error(`unsupported capability platform: ${platform}`);
      console.log(JSON.stringify(await developmentCapabilityPlan(profile, { platform })));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
