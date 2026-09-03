import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(projectRoot, ".github", "quality-tools.json");
const governedConsumers = [
  ".github/workflows/ci.yml",
  ".github/workflows/deep-quality.yml",
  ".github/workflows/release.yml",
  "scripts/bootstrap-quality-tools.ps1",
  "scripts/bootstrap-quality-tools.sh",
  "scripts/run-hawk.mjs",
];

function semver(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must be an exact semantic version`);
  }
}

export function validateQualityManifest(manifest) {
  if (manifest.schema_version !== 1) throw new Error("quality manifest schema_version must be 1");
  semver(manifest.rust?.channel, "Rust channel");
  if (JSON.stringify(manifest.rust.components) !== JSON.stringify(["clippy", "rustfmt"])) {
    throw new Error("Rust components must be exactly clippy and rustfmt");
  }
  const ids = new Set();
  const crates = new Set();
  for (const tool of manifest.tools ?? []) {
    if (!tool.id || ids.has(tool.id)) throw new Error(`duplicate or missing tool id: ${tool.id}`);
    if (!tool.crate || crates.has(tool.crate)) throw new Error(`duplicate or missing crate: ${tool.crate}`);
    ids.add(tool.id);
    crates.add(tool.crate);
    semver(tool.version, `${tool.id} version`);
    if (!Array.isArray(tool.command) || !tool.command.length || tool.command.some(value => !value)) {
      throw new Error(`${tool.id} must define a non-empty command array`);
    }
    if (!["required", "deep"].includes(tool.tier)) throw new Error(`${tool.id} has an invalid tier`);
    if (!["prebuilt", "cached", "local", "source"].includes(tool.ci_install)) {
      throw new Error(`${tool.id} has an invalid ci_install strategy`);
    }
    if (tool.rust_toolchain) semver(tool.rust_toolchain, `${tool.id} Rust toolchain`);
  }
  for (const required of ["just", "cargo-shear", "cargo-deny", "cargo-modules", "rscheck-cli", "semdup", "cargo-mutants", "cargo-hawk"]) {
    if (!ids.has(required)) throw new Error(`quality manifest is missing ${required}`);
  }
}

export function findStaleConsumerPins(manifest, consumers) {
  const findings = [];
  for (const [name, contents] of Object.entries(consumers)) {
    for (const tool of manifest.tools) {
      const aliases = new Set([
        tool.id,
        tool.crate,
        ...tool.command.filter(value => !value.startsWith("-") && value !== "cargo"),
      ]);
      const identity = [...aliases]
        .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const identityPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])(?:${identity})(?:$|[^A-Za-z0-9_-])`);
      for (const [index, line] of contents.split(/\r?\n/).entries()) {
        if (!identityPattern.test(line)) continue;
        const versions = line.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
        for (const version of versions) findings.push(`${name}:${index + 1} duplicates ${tool.id} pin ${version}`);
      }
    }
  }
  return [...new Set(findings)];
}

export function githubOutputs(manifest) {
  const byId = Object.fromEntries(manifest.tools.map(tool => [tool.id, tool]));
  const spec = tool => `${tool.crate}@${tool.version}`;
  return {
    required_prebuilt: manifest.tools
      .filter(tool => tool.tier === "required" && tool.ci_install === "prebuilt")
      .map(spec)
      .join(","),
    required_all: manifest.tools.filter(tool => tool.tier === "required").map(spec).join(","),
    rscheck_spec: spec(byId["rscheck-cli"]),
    semdup_spec: spec(byId.semdup),
    hawk_version: byId["cargo-hawk"].version,
    hawk_rust: byId["cargo-hawk"].rust_toolchain,
  };
}

export async function loadQualityManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateQualityManifest(manifest);
  return manifest;
}

async function validateConsumers(manifest) {
  const entries = await Promise.all(governedConsumers.map(async name => [
    name,
    await readFile(path.join(projectRoot, name), "utf8"),
  ]));
  const findings = findStaleConsumerPins(manifest, Object.fromEntries(entries));
  if (findings.length) throw new Error(`quality tool pins must come from .github/quality-tools.json:\n${findings.join("\n")}`);
  const toolchain = await readFile(path.join(projectRoot, "rust-toolchain.toml"), "utf8");
  const configuredRust = toolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (configuredRust !== manifest.rust.channel) throw new Error("rust-toolchain.toml drifted from quality-tools.json");
  const workspace = await readFile(path.join(projectRoot, "Cargo.toml"), "utf8");
  const msrv = workspace.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
  if (`${msrv}.0` !== manifest.rust.channel) throw new Error("workspace MSRV drifted from the pinned Rust channel");
}

function toolById(manifest, id) {
  const tool = manifest.tools.find(candidate => candidate.id === id);
  if (!tool) throw new Error(`unknown quality tool: ${id}`);
  return tool;
}

function verifyTool(tool) {
  const result = spawnSync(tool.command[0], tool.command.slice(1), { encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0 || !new RegExp(`(^|[^0-9])${tool.version.replaceAll(".", "\\.")}([^0-9]|$)`).test(output)) {
    throw new Error(`${tool.id} did not report required version ${tool.version}`);
  }
  return output.trim();
}

async function main(argv) {
  const manifest = await loadQualityManifest();
  const mode = argv[0] ?? "--validate";
  if (mode === "--validate" && argv.length === 1) {
    await validateConsumers(manifest);
    console.log("Quality tool manifest and consumers are synchronized.");
    return;
  }
  if (mode === "--github-output" && argv.length === 1) {
    for (const [name, value] of Object.entries(githubOutputs(manifest))) console.log(`${name}=${value}`);
    return;
  }
  if (mode === "--specs" && argv.length === 2) {
    const tier = argv[1];
    if (!["required", "deep"].includes(tier)) throw new Error("--specs expects required or deep");
    for (const tool of manifest.tools.filter(candidate => candidate.tier === tier && candidate.id !== "cargo-hawk")) {
      console.log(`${tool.crate}|${tool.version}|${tool.command.join(" ")}`);
    }
    return;
  }
  if (mode === "--version" && argv.length === 2) {
    console.log(toolById(manifest, argv[1]).version);
    return;
  }
  if (mode === "--rust-toolchain" && argv.length === 2) {
    const tool = toolById(manifest, argv[1]);
    if (!tool.rust_toolchain) throw new Error(`${tool.id} has no private Rust toolchain`);
    console.log(tool.rust_toolchain);
    return;
  }
  if (mode === "--verify" && argv.length === 2) {
    console.log(verifyTool(toolById(manifest, argv[1])));
    return;
  }
  throw new Error("usage: quality-tools.mjs --validate|--github-output|--specs TIER|--version ID|--rust-toolchain ID|--verify ID");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
