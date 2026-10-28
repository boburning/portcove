import { isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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
];

export interface QualityTool {
  id: string;
  crate: string;
  version: string;
  command: [string, ...string[]];
  tier: "required" | "deep";
  ci_install: "prebuilt" | "cached" | "local" | "source";
}
export interface QualityManifest {
  schema_version: 1;
  rust: { channel: string; components: ["clippy", "rustfmt"] };
  tools: QualityTool[];
}

function semver(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(
      `${label} must be an exact semantic version; received ${JSON.stringify(value)}.`,
    );
  }
}

export function validateQualityManifest(manifest: unknown): asserts manifest is QualityManifest {
  if (!isRecord(manifest) || manifest.schema_version !== 1)
    throw new Error("The quality manifest `schema_version` must be 1.");
  if (!isRecord(manifest.rust))
    throw new Error("The quality manifest requires a `rust` configuration object.");
  semver(manifest.rust.channel, "The quality manifest `rust.channel`");
  if (JSON.stringify(manifest.rust.components) !== JSON.stringify(["clippy", "rustfmt"])) {
    throw new Error("The quality manifest `rust.components` must be exactly clippy and rustfmt.");
  }
  const ids = new Set<string>();
  const crates = new Set<string>();
  if (!Array.isArray(manifest.tools))
    throw new Error("The quality manifest `tools` must be an array.");
  const tools: readonly unknown[] = manifest.tools;
  for (const tool of tools) {
    if (!isRecord(tool)) throw new Error("Each quality manifest tool must be an object.");
    if (typeof tool.id !== "string" || !tool.id || ids.has(tool.id))
      throw new Error(`Duplicate or missing tool ID in \`id\`: ${JSON.stringify(tool.id)}.`);
    if (typeof tool.crate !== "string" || !tool.crate || crates.has(tool.crate))
      throw new Error(
        `Duplicate or missing tool crate in \`crate\`: ${JSON.stringify(tool.crate)}.`,
      );
    ids.add(tool.id);
    crates.add(tool.crate);
    semver(tool.version, `The quality tool ${JSON.stringify(tool.id)} \`version\``);
    if (
      !Array.isArray(tool.command) ||
      !tool.command.length ||
      tool.command.some((value: unknown) => typeof value !== "string" || !value)
    ) {
      throw new Error(
        `The quality tool ${JSON.stringify(tool.id)} must define a non-empty command array in \`command\`.`,
      );
    }
    if (tool.tier !== "required" && tool.tier !== "deep")
      throw new Error(
        `The quality tool ${JSON.stringify(tool.id)} has an invalid \`tier\`: ${JSON.stringify(tool.tier)}. Use required or deep.`,
      );
    if (
      tool.ci_install !== "prebuilt" &&
      tool.ci_install !== "cached" &&
      tool.ci_install !== "local" &&
      tool.ci_install !== "source"
    ) {
      throw new Error(
        `The quality tool ${JSON.stringify(tool.id)} has an invalid \`ci_install\` strategy: ${JSON.stringify(tool.ci_install)}. Use prebuilt, cached, local or source.`,
      );
    }
  }
  for (const required of [
    "just",
    "cargo-shear",
    "cargo-deny",
    "cargo-modules",
    "rscheck-cli",
    "cargo-mutants",
    "cargo-nextest",
  ]) {
    if (!ids.has(required))
      throw new Error(`The quality manifest is missing required tool ${JSON.stringify(required)}.`);
  }
}

export function findStaleConsumerPins(
  manifest: QualityManifest,
  consumers: Readonly<Record<string, string>>,
) {
  const findings = [];
  for (const [name, contents] of Object.entries(consumers)) {
    for (const tool of manifest.tools) {
      const aliases = new Set([
        tool.id,
        tool.crate,
        ...tool.command.filter((value: string) => !value.startsWith("-") && value !== "cargo"),
      ]);
      const identity = [...aliases]
        .map((value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const identityPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])(?:${identity})(?:$|[^A-Za-z0-9_-])`);
      for (const [index, line] of contents.split(/\r?\n/).entries()) {
        if (!identityPattern.test(line)) continue;
        const versions = line.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
        for (const version of versions)
          findings.push(`${name}:${index + 1} duplicates ${tool.id} pin ${version}`);
      }
    }
  }
  return [...new Set(findings)];
}

export function githubOutputs(manifest: QualityManifest) {
  const spec = (tool: QualityTool) => `${tool.crate}@${tool.version}`;
  return {
    required_prebuilt: manifest.tools
      .filter((tool) => tool.tier === "required" && tool.ci_install === "prebuilt")
      .map(spec)
      .join(","),
    required_all: manifest.tools
      .filter((tool) => tool.tier === "required")
      .map(spec)
      .join(","),
    rscheck_spec: spec(toolById(manifest, "rscheck-cli")),
  };
}

export async function loadQualityManifest() {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  validateQualityManifest(manifest);
  return manifest;
}

async function validateConsumers(manifest: QualityManifest) {
  const entries = await Promise.all(
    governedConsumers.map(
      async (name: string) => [name, await readFile(path.join(projectRoot, name), "utf8")] as const,
    ),
  );
  const findings = findStaleConsumerPins(manifest, Object.fromEntries(entries));
  if (findings.length)
    throw new Error(
      `Quality tool pins must come from .github/quality-tools.json. Remove the duplicate consumer pins:\n${findings.join("\n")}`,
    );
  const toolchain = await readFile(path.join(projectRoot, "rust-toolchain.toml"), "utf8");
  const configuredRust = toolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (configuredRust !== manifest.rust.channel)
    throw new Error(
      "The `channel` in rust-toolchain.toml differs from `rust.channel` in .github/quality-tools.json. Synchronize the pinned Rust versions.",
    );
  const workspace = await readFile(path.join(projectRoot, "Cargo.toml"), "utf8");
  const msrv = workspace.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
  if (manifest.rust.channel !== msrv && !manifest.rust.channel.startsWith(`${msrv}.`))
    throw new Error(
      "The workspace `rust-version` in Cargo.toml differs from the pinned Rust channel. Synchronize the minimum supported Rust version.",
    );
}

function toolById(manifest: QualityManifest, id: string) {
  const tool = manifest.tools.find((candidate) => candidate.id === id);
  if (!tool)
    throw new Error(
      `Unknown quality tool: ${JSON.stringify(id)}. Use an \`id\` from .github/quality-tools.json.`,
    );
  return tool;
}

function verifyTool(tool: QualityTool) {
  const command = tool.command;
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error ||
    result.status !== 0 ||
    !new RegExp(`(^|[^0-9])${tool.version.replaceAll(".", "\\.")}([^0-9]|$)`).test(output)
  ) {
    const cause = result.error
      ? result.error.message
      : result.status !== 0
        ? `command exited with status ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}`
        : `received ${JSON.stringify(output.trim())}`;
    throw new Error(
      `The quality tool ${JSON.stringify(tool.id)} did not report required version ${tool.version}: ${cause}. Run ${command.join(" ")} to diagnose the installed tool.`,
    );
  }
  return output.trim();
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`Usage: node scripts/quality-tools.mts --validate|--github-output|--specs TIER|--version ID|--verify ID|--help

Read the repository's pinned Rust quality-tool manifest and validate its consumers.
This command does not install tools.

Options (choose one):
  --validate       Check manifest, consumer pins, Rust toolchain and workspace MSRV.
  --github-output  Print the existing name=value outputs consumed by GitHub Actions.
  --specs TIER     Print crate|version|command records for required or deep tools.
  --version ID     Print the pinned version for an exact tool id.
  --verify ID      Run the tool's version command and require the pinned version.
  --help           Show this help without reading configuration or running a tool.

Tool ids and tiers are defined in .github/quality-tools.json.

Example:
  node scripts/quality-tools.mts --verify cargo-nextest`);
    return;
  }
  const manifest = await loadQualityManifest();
  const mode = argv[0] ?? "--validate";
  if (mode === "--validate" && argv.length === 1) {
    await validateConsumers(manifest);
    console.log("Quality tool manifest and consumers are synchronized.");
    return;
  }
  if (mode === "--github-output" && argv.length === 1) {
    for (const [name, value] of Object.entries(githubOutputs(manifest)))
      console.log(`${name}=${value}`);
    return;
  }
  if (mode === "--specs" && argv.length === 2) {
    const tier = argv[1];
    if (!["required", "deep"].includes(tier ?? ""))
      throw new Error(`--specs expects required or deep; received ${JSON.stringify(tier)}.`);
    for (const tool of manifest.tools.filter((candidate) => candidate.tier === tier)) {
      console.log(`${tool.crate}|${tool.version}|${tool.command.join(" ")}`);
    }
    return;
  }
  if (mode === "--version" && argv.length === 2) {
    console.log(toolById(manifest, argv[1] ?? "").version);
    return;
  }
  if (mode === "--verify" && argv.length === 2) {
    console.log(verifyTool(toolById(manifest, argv[1] ?? "")));
    return;
  }
  throw new Error(
    "Usage: node scripts/quality-tools.mts --validate|--github-output|--specs TIER|--version ID|--verify ID. Run with --help for an example.",
  );
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked === scriptPath) {
  await main(process.argv.slice(2));
}
