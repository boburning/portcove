import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(projectRoot, ".github", "quality-tools.json");
const managedRoot = path.resolve(
  process.env.PORTCOVE_QUALITY_TOOLS_DIR ??
    path.join(projectRoot, "work", "quality-tools"),
);
const managedPlatforms = new Set([
  "win32-x64",
  "linux-x64",
  "darwin-x64",
  "darwin-arm64",
]);
const governedConsumers = [
  ".github/workflows/ci.yml",
  ".github/workflows/deep-quality.yml",
  ".github/workflows/release.yml",
  "scripts/bootstrap-quality-tools.ps1",
  "scripts/bootstrap-quality-tools.sh",
  "scripts/run-hawk.mjs",
];

function semver(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
  ) {
    throw new Error(`${label} must be an exact semantic version`);
  }
}

export function validateQualityManifest(manifest) {
  if (manifest.schema_version !== 1)
    throw new Error("quality manifest schema_version must be 1");
  semver(manifest.rust?.channel, "Rust channel");
  if (
    JSON.stringify(manifest.rust.components) !==
    JSON.stringify(["clippy", "rustfmt"])
  ) {
    throw new Error("Rust components must be exactly clippy and rustfmt");
  }
  const ids = new Set();
  const crates = new Set();
  for (const tool of manifest.tools ?? []) {
    if (!tool.id || ids.has(tool.id))
      throw new Error(`duplicate or missing tool id: ${tool.id}`);
    ids.add(tool.id);
    semver(tool.version, `${tool.id} version`);
    if (
      !Array.isArray(tool.command) ||
      !tool.command.length ||
      tool.command.some((value) => !value)
    ) {
      throw new Error(`${tool.id} must define a non-empty command array`);
    }
    if (!["required", "deep"].includes(tool.tier))
      throw new Error(`${tool.id} has an invalid tier`);
    if (
      !["prebuilt", "cached", "local", "source", "managed"].includes(
        tool.ci_install,
      )
    ) {
      throw new Error(`${tool.id} has an invalid ci_install strategy`);
    }
    if (tool.rust_toolchain)
      semver(tool.rust_toolchain, `${tool.id} Rust toolchain`);
    if (tool.install) {
      if (tool.ci_install !== "managed")
        throw new Error(
          `${tool.id} managed install must use ci_install=managed`,
        );
      if (
        !["github-release", "powershell-gallery"].includes(tool.install.kind)
      ) {
        throw new Error(`${tool.id} has an invalid managed install kind`);
      }
      const assets = Object.entries(tool.install.assets ?? {});
      if (!assets.length)
        throw new Error(`${tool.id} must define managed assets`);
      const expectedPlatforms =
        tool.install.kind === "powershell-gallery"
          ? new Set(["win32-x64"])
          : managedPlatforms;
      const actualPlatforms = new Set(assets.map(([platform]) => platform));
      if (
        actualPlatforms.size !== expectedPlatforms.size ||
        [...expectedPlatforms].some(
          (platform) => !actualPlatforms.has(platform),
        )
      ) {
        throw new Error(
          `${tool.id} managed assets do not cover the required platforms`,
        );
      }
      if (
        tool.install.kind === "powershell-gallery" &&
        tool.install.platform_limited !== true
      ) {
        throw new Error(
          `${tool.id} PowerShell Gallery install must be platform-limited`,
        );
      }
      for (const [platform, asset] of assets) {
        if (!managedPlatforms.has(platform))
          throw new Error(
            `${tool.id} has an unsupported platform key: ${platform}`,
          );
        if (!asset.url?.startsWith("https://"))
          throw new Error(`${tool.id} ${platform} must use an HTTPS asset URL`);
        if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? ""))
          throw new Error(
            `${tool.id} ${platform} must define a lowercase SHA-256`,
          );
        validateArchiveEntries([asset.entry]);
      }
    } else {
      if (!tool.crate || crates.has(tool.crate))
        throw new Error(`duplicate or missing crate: ${tool.crate}`);
      crates.add(tool.crate);
    }
  }
  for (const required of [
    "just",
    "cargo-shear",
    "cargo-deny",
    "cargo-modules",
    "rscheck-cli",
    "semdup",
    "cargo-mutants",
    "cargo-hawk",
    "ruff",
    "actionlint",
    "shellcheck",
    "psscriptanalyzer",
  ]) {
    if (!ids.has(required))
      throw new Error(`quality manifest is missing ${required}`);
  }
}

export function findStaleConsumerPins(manifest, consumers) {
  const findings = [];
  for (const [name, contents] of Object.entries(consumers)) {
    for (const tool of manifest.tools) {
      const aliases = new Set(
        [
          tool.id,
          tool.crate,
          ...tool.command.filter(
            (value) => !value.startsWith("-") && value !== "cargo",
          ),
        ].filter(Boolean),
      );
      const identity = [...aliases]
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const identityPattern = new RegExp(
        `(?:^|[^A-Za-z0-9_-])(?:${identity})(?:$|[^A-Za-z0-9_-])`,
      );
      for (const [index, line] of contents.split(/\r?\n/).entries()) {
        if (!identityPattern.test(line)) continue;
        const versions =
          line.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
        for (const version of versions)
          findings.push(
            `${name}:${index + 1} duplicates ${tool.id} pin ${version}`,
          );
      }
    }
  }
  return [...new Set(findings)];
}

export function githubOutputs(manifest) {
  const byId = Object.fromEntries(
    manifest.tools.map((tool) => [tool.id, tool]),
  );
  const spec = (tool) => `${tool.crate}@${tool.version}`;
  const cargoTools = manifest.tools.filter((tool) => !tool.install);
  return {
    required_prebuilt: cargoTools
      .filter(
        (tool) => tool.tier === "required" && tool.ci_install === "prebuilt",
      )
      .map(spec)
      .join(","),
    required_all: cargoTools
      .filter((tool) => tool.tier === "required")
      .map(spec)
      .join(","),
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
  const entries = await Promise.all(
    governedConsumers.map(async (name) => [
      name,
      await readFile(path.join(projectRoot, name), "utf8"),
    ]),
  );
  const findings = findStaleConsumerPins(manifest, Object.fromEntries(entries));
  if (findings.length)
    throw new Error(
      `quality tool pins must come from .github/quality-tools.json:\n${findings.join("\n")}`,
    );
  const toolchain = await readFile(
    path.join(projectRoot, "rust-toolchain.toml"),
    "utf8",
  );
  const configuredRust = toolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (configuredRust !== manifest.rust.channel)
    throw new Error("rust-toolchain.toml drifted from quality-tools.json");
  const workspace = await readFile(
    path.join(projectRoot, "Cargo.toml"),
    "utf8",
  );
  const msrv = workspace.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
  if (`${msrv}.0` !== manifest.rust.channel)
    throw new Error("workspace MSRV drifted from the pinned Rust channel");
}

function toolById(manifest, id) {
  const tool = manifest.tools.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`unknown quality tool: ${id}`);
  return tool;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const normalizedArch =
    arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  return `${platform}-${normalizedArch}`;
}

export function validateArchiveEntries(entries) {
  for (const entry of entries) {
    const normalized = String(entry ?? "").replaceAll("\\", "/");
    if (
      !normalized ||
      normalized.includes("\0") ||
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`unsafe archive entry: ${entry}`);
    }
  }
}

export function verifySha256(contents, expected) {
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected)
    throw new Error(
      `asset checksum mismatch: expected ${expected}, received ${actual}`,
    );
  return actual;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function activateStaging(staging, target, renameEntry = rename) {
  if (!(await exists(staging)))
    throw new Error(`staged quality tool is missing: ${staging}`);
  const quarantine = `${target}.replaced-${randomUUID()}`;
  const hadTarget = await exists(target);
  if (hadTarget) await renameEntry(target, quarantine);
  try {
    await renameEntry(staging, target);
  } catch (error) {
    if (hadTarget) await renameEntry(quarantine, target);
    throw error;
  }
  if (hadTarget) await rm(quarantine, { force: true, recursive: true });
}

function managedAsset(tool, key = platformKey()) {
  const asset = tool.install?.assets?.[key];
  if (!asset && !tool.install?.platform_limited)
    throw new Error(`${tool.id} does not support ${key}`);
  return asset;
}

export function managedToolPath(tool, root = managedRoot, key = platformKey()) {
  const asset = managedAsset(tool, key);
  if (!asset) return undefined;
  return path.join(
    root,
    tool.id,
    tool.version,
    key,
    ...asset.entry.replaceAll("\\", "/").split("/"),
  );
}

function stagedToolPath(tool, staging, key = platformKey()) {
  const asset = managedAsset(tool, key);
  return path.join(staging, ...asset.entry.replaceAll("\\", "/").split("/"));
}

function verifyResult(tool, result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error ||
    result.status !== 0 ||
    !new RegExp(
      `(^|[^0-9])${tool.version.replaceAll(".", "\\.")}([^0-9]|$)`,
    ).test(output)
  ) {
    throw new Error(
      `${tool.id} did not report required version ${tool.version}`,
    );
  }
  return output.trim();
}

function verifyManagedEntry(tool, executable, key = platformKey()) {
  if (!executable) return `${tool.id} is not applicable to ${key}`;
  const result =
    tool.install.kind === "powershell-gallery"
      ? spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-File",
            path.join(projectRoot, "scripts", "verify-psscriptanalyzer.ps1"),
            "-ModulePath",
            executable,
            "-ExpectedVersion",
            tool.version,
          ],
          { encoding: "utf8" },
        )
      : spawnSync(executable, tool.command.slice(1), { encoding: "utf8" });
  return verifyResult(tool, result);
}

function verifyManagedTool(tool, root = managedRoot, key = platformKey()) {
  return verifyManagedEntry(tool, managedToolPath(tool, root, key), key);
}

function verifyTool(tool) {
  if (tool.install) return verifyManagedTool(tool);
  const result = spawnSync(tool.command[0], tool.command.slice(1), {
    encoding: "utf8",
  });
  return verifyResult(tool, result);
}

async function installManagedTool(tool, key = platformKey()) {
  const asset = managedAsset(tool, key);
  if (!asset) {
    console.log(
      `${tool.id} is not applicable to ${key}; hosted Windows CI provides its required coverage.`,
    );
    return;
  }
  try {
    console.log(
      `${tool.id} already pinned: ${verifyManagedTool(tool, managedRoot, key)}`,
    );
    return;
  } catch {
    // Continue with a verified staged installation.
  }
  const target = path.join(managedRoot, tool.id, tool.version, key);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const nonce = randomUUID();
  const archive = path.join(parent, `${tool.id}-${nonce}.archive`);
  const staging = `${target}.staging-${nonce}`;
  try {
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok || !response.body)
      throw new Error(`could not download ${tool.id}: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archive, { flags: "wx" }),
    );
    verifySha256(await readFile(archive), asset.sha256);
    const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    if (listing.error || listing.status !== 0)
      throw new Error(`${tool.id} archive could not be listed`);
    validateArchiveEntries(listing.stdout.split(/\r?\n/).filter(Boolean));
    const verbose = spawnSync("tar", ["-tvf", archive], { encoding: "utf8" });
    if (
      verbose.error ||
      verbose.status !== 0 ||
      verbose.stdout
        .split(/\r?\n/)
        .some((line) => /^[lh]/.test(line) || line.includes(" -> "))
    ) {
      throw new Error(`${tool.id} archive contains an unsupported link entry`);
    }
    await mkdir(staging, { recursive: true });
    const extraction = spawnSync("tar", ["-xf", archive, "-C", staging], {
      encoding: "utf8",
    });
    if (extraction.error || extraction.status !== 0)
      throw new Error(`${tool.id} archive extraction failed`);
    const installed = stagedToolPath(tool, staging, key);
    const metadata = await lstat(installed);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`${tool.id} managed entry is not a regular file`);
    if (
      process.platform !== "win32" &&
      tool.install.kind !== "powershell-gallery"
    )
      await chmod(installed, 0o755);
    verifyManagedEntry(tool, installed, key);
    await activateStaging(staging, target);
    console.log(
      `${tool.id} installed: ${verifyManagedTool(tool, managedRoot, key)}`,
    );
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { force: true, recursive: true });
  }
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
    for (const [name, value] of Object.entries(githubOutputs(manifest)))
      console.log(`${name}=${value}`);
    return;
  }
  if (mode === "--specs" && argv.length === 2) {
    const tier = argv[1];
    if (!["required", "deep"].includes(tier))
      throw new Error("--specs expects required or deep");
    for (const tool of manifest.tools.filter(
      (candidate) =>
        !candidate.install &&
        candidate.tier === tier &&
        candidate.id !== "cargo-hawk",
    )) {
      console.log(`${tool.crate}|${tool.version}|${tool.command.join(" ")}`);
    }
    return;
  }
  if (mode === "--install-managed" && argv.length === 2) {
    const selector = argv[1];
    const requestedIds = new Set(selector.split(","));
    const selected = ["required", "deep"].includes(selector)
      ? manifest.tools.filter(
          (candidate) => candidate.install && candidate.tier === selector,
        )
      : manifest.tools.filter(
          (candidate) => candidate.install && requestedIds.has(candidate.id),
        );
    if (
      !selected.length ||
      (!["required", "deep"].includes(selector) &&
        selected.length !== requestedIds.size)
    ) {
      throw new Error(
        "--install-managed expects required, deep, or a comma-separated managed tool list",
      );
    }
    for (const tool of selected) {
      await installManagedTool(tool);
    }
    return;
  }
  if (mode === "--path" && argv.length === 2) {
    const tool = toolById(manifest, argv[1]);
    if (!tool.install)
      throw new Error(`${tool.id} is not a managed quality tool`);
    const installed = managedToolPath(tool);
    if (!installed)
      throw new Error(`${tool.id} is not available on ${platformKey()}`);
    verifyManagedTool(tool);
    console.log(installed);
    return;
  }
  if (mode === "--run" && argv.length >= 3 && argv[2] === "--") {
    const tool = toolById(manifest, argv[1]);
    if (!tool.install || tool.install.kind === "powershell-gallery") {
      throw new Error(`${tool.id} is not a runnable managed executable`);
    }
    const executable = managedToolPath(tool);
    verifyManagedTool(tool);
    const arguments_ = argv.slice(3);
    if (
      tool.id === "actionlint" &&
      !arguments_.some((value) => value.startsWith("-shellcheck="))
    ) {
      const shellcheck = toolById(manifest, "shellcheck");
      verifyManagedTool(shellcheck);
      arguments_.unshift(`-shellcheck=${managedToolPath(shellcheck)}`);
    }
    const result = spawnSync(executable, arguments_, {
      cwd: projectRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (mode === "--version" && argv.length === 2) {
    console.log(toolById(manifest, argv[1]).version);
    return;
  }
  if (mode === "--rust-toolchain" && argv.length === 2) {
    const tool = toolById(manifest, argv[1]);
    if (!tool.rust_toolchain)
      throw new Error(`${tool.id} has no private Rust toolchain`);
    console.log(tool.rust_toolchain);
    return;
  }
  if (mode === "--verify" && argv.length === 2) {
    console.log(verifyTool(toolById(manifest, argv[1])));
    return;
  }
  throw new Error(
    "usage: quality-tools.mjs --validate|--github-output|--specs TIER|--install-managed SELECTOR|--path ID|--run ID -- ARGS|--version ID|--rust-toolchain ID|--verify ID",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
