import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validationOwnershipForPath } from "./validation-plan.mjs";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const receiptFormat = 1;
const allReusableDomains = [
  "format",
  "rust",
  "ui",
  "lint",
  "repository",
  "roadmap",
  "development",
  "release",
  "rscheck",
];

const environmentWhitelist = Object.freeze([
  "CI",
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUSTUP_TOOLCHAIN",
  "CARGO_BUILD_TARGET",
  "CARGO_PROFILE_DEV_DEBUG",
  "CARGO_PROFILE_TEST_DEBUG",
  "NODE_OPTIONS",
  "PORTCOVE_TEST_FIXTURES",
]);

const oxfmtSupportedExtension =
  /\.(?:astro|cjs|css|html|js|json|json5|jsonc|jsx|less|md|mdx|mjs|mts|scss|svelte|ts|tsx|vue|ya?ml)$/iu;
const oxfmtExcludedPath =
  /^(?:node_modules\/|apps\/desktop\/(?:dist|node_modules|src-tauri\/gen)\/|target\/|work\/|outputs\/|release-assets\/|\.codex-remote-attachments\/|\.fallow(?:-review)?\/|\.rscheck\/|\.tmp\/|mutants\.out(?:\.old)?\/|Portcove-CI-FiveMinutes\/|integrations\/playnite\/(?:bin|obj|tests\/(?:bin|obj))\/|crates\/portcove-core\/catalog\/|crates\/[^/]+\/tests\/fixtures\/|docs\/archive\/|docs\/releases\/\d+\.md$)/u;
const oxfmtExcludedFile =
  /(?:\.generated\.[^/]+$|(?:^|\/)pnpm-lock\.yaml$|integrations\/playnite\/(?:tests\/)?packages\.lock\.json$)/u;

function isFormatInput(file) {
  if (file.endsWith(".toml") && !file.startsWith("apps/desktop/src-tauri/gen/")) return true;
  return (
    oxfmtSupportedExtension.test(file) &&
    !oxfmtExcludedPath.test(file) &&
    !oxfmtExcludedFile.test(file)
  );
}

function normalizeRepositoryPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe repository path: ${value}`);
  return normalized;
}

function add(domains, ...values) {
  for (const value of values) domains.add(value);
}

export function domainsForPath(input) {
  const file = normalizeRepositoryPath(input);
  const domains = new Set();
  let recognized = false;
  // Hosted policy classification is deliberately broader than command inputs.
  // The release handbook is read by documentation/release contracts, not by
  // product compilation or UI tests. Fresh audits still execute every stage.
  if (file === "docs/RELEASING.md") {
    add(domains, "format", "release", "repository", "roadmap");
    return { domains, ambiguous: false };
  }
  const validationOwnership = validationOwnershipForPath(file);
  if (validationOwnership.areas.includes("policy")) {
    add(domains, ...allReusableDomains);
    recognized = true;
  }
  if (validationOwnership.areas.includes("release-security")) {
    add(domains, "release");
    recognized = true;
  }

  // Keep repository-wide formatting independent from UI behavior so a
  // documentation-only rebase cannot invalidate otherwise-identical code evidence.
  if (isFormatInput(file)) add(domains, "format");

  if (
    file === "justfile" ||
    file === "scripts/audit.mjs" ||
    file === "scripts/audit.test.mjs" ||
    file === "scripts/local-validation.mjs" ||
    file === "scripts/local-validation.test.mjs" ||
    file === "scripts/validation-plan.mjs" ||
    file === "scripts/validation-plan.test.mjs" ||
    file === "scripts/dev-storage.mjs" ||
    file === "scripts/tool-cache.mjs" ||
    file === "scripts/test-duration-reporter.mjs" ||
    file === ".config/rust-test-impact.json" ||
    file === ".github/quality-tools.json" ||
    file === ".config/tool-bootstrap.json" ||
    file === "aqua.yaml" ||
    file === "aqua-checksums.json" ||
    file === ".aqua-version" ||
    file === ".node-version"
  ) {
    add(domains, ...allReusableDomains);
    recognized = true;
  }

  if (
    file === "Cargo.toml" ||
    file === "Cargo.lock" ||
    file === "rust-toolchain.toml" ||
    file === "deny.toml" ||
    file === ".config/nextest.toml" ||
    file.startsWith("crates/") ||
    file.startsWith("apps/desktop/src-tauri/")
  ) {
    add(domains, "rust", "rscheck");
    if (file === "Cargo.toml" || file === "Cargo.lock") add(domains, "release");
    if (file.startsWith("crates/portcove-release-tools/")) add(domains, "release");
    recognized = true;
  }

  if (
    file.startsWith("apps/desktop/src/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("apps/desktop/assets/") ||
    file.startsWith("apps/desktop/public/") ||
    /^apps\/desktop\/(?:index\.html|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|stylelint\.config\.mjs|\.fallowrc\.json)$/u.test(
      file,
    ) ||
    file === ".oxfmtrc.json" ||
    file === ".oxlintrc.json" ||
    file === "vite.config.ts" ||
    ["tsconfig.json", "tsconfig.base.json"].includes(file)
  ) {
    add(domains, "ui");
    if (
      [
        "apps/desktop/package.json",
        "apps/desktop/pnpm-lock.yaml",
        "apps/desktop/pnpm-workspace.yaml",
      ].includes(file)
    )
      add(domains, "release");
    if (file === "apps/desktop/pnpm-lock.yaml") add(domains, "format");
    if (file.startsWith("apps/desktop/assets/brand/models/v2/")) add(domains, "lint");
    recognized = true;
  }

  if (["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file)) {
    for (const domain of ["format", "ui", "release"]) add(domains, domain);
    recognized = true;
  }

  if (/^apps\/desktop\/src\/transport-(?:schemas|inputs|host-.+)\.generated\.json$/u.test(file)) {
    add(domains, "rust");
    recognized = true;
  }

  if (file.startsWith(".github/workflows/") || file.startsWith(".github/actions/")) {
    add(domains, "lint", "repository");
    recognized = true;
  }

  if (file.startsWith(".github/")) {
    add(domains, "repository");
    if (file.includes("roadmap") || file.startsWith(".github/ISSUE_TEMPLATE/"))
      add(domains, "roadmap");
    if (file === ".github/release.yml") add(domains, "release");
    recognized = true;
  }

  if (file.startsWith("scripts/")) {
    const name = path.posix.basename(file);
    if (/roadmap|source-provenance|catalog-schema/u.test(name)) add(domains, "roadmap");
    if (
      ["desktop-scenarios.mjs", "desktop-scenarios.test.mjs"].includes(name) ||
      /dev-|development-|local-validation|rust-test-impact|native-session|desktop-test|tool-cache|bootstrap-quality/u.test(
        name,
      )
    )
      add(domains, "development");
    if (/lint|oxfmt|fallow|copy|actionlint|powershell|vitest-duration/u.test(name))
      add(domains, "lint");
    if (/rscheck/u.test(name)) add(domains, "rscheck");
    if (
      /ci-|repository-settings|pr-conventions|test-duration|quality-tools|upstream-observer|retcomm/u.test(
        name,
      )
    )
      add(domains, "repository");
    if (domains.size === 0) add(domains, ...allReusableDomains);
    recognized = true;
  }

  if (file.startsWith("release/") || file.startsWith("release-metadata/")) {
    add(domains, "release");
    recognized = true;
  }

  if (file.startsWith("docs/") || file.endsWith(".md")) {
    add(domains, "repository");
    if (/development|quality|contributing/iu.test(file) || file === "AGENTS.md")
      add(domains, "development");
    if (/project-governance|roadmap/iu.test(file)) add(domains, "roadmap");
    recognized = true;
  }

  if (file === ".rscheck.toml") {
    add(domains, "rscheck");
    recognized = true;
  }
  if (/\.(?:ps1|sh|py)$/u.test(file)) {
    add(domains, "lint");
    recognized = true;
  }
  if (file.startsWith("integrations/")) {
    add(domains, "repository");
    recognized = true;
  }
  if (
    [
      ".editorconfig",
      ".gitattributes",
      ".gitignore",
      ".git-blame-ignore-revs",
      "pyproject.toml",
      "LICENSE-APACHE",
      "LICENSE-MIT",
      "SECURITY.md",
    ].includes(file) ||
    file.startsWith(".vscode/")
  ) {
    add(domains, "repository");
    if (file === ".editorconfig") add(domains, "format");
    if (file === "pyproject.toml") add(domains, "lint");
    if ([".gitattributes", ".gitignore"].includes(file)) add(domains, ...allReusableDomains);
    recognized = true;
  }

  if (!recognized) add(domains, ...allReusableDomains);
  return { domains, ambiguous: !recognized };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: options.env ?? process.env,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  return String(result.stdout ?? "");
}

function git(root, args) {
  return run("git", args, { cwd: root });
}

function parseTree(buffer) {
  const result = new Map();
  for (const record of buffer.split("\0").filter(Boolean)) {
    const delimiter = record.indexOf("\t");
    const [mode, type, blob, ...extra] = record.slice(0, delimiter).split(/\s+/u);
    const file = record.slice(delimiter + 1);
    if (delimiter < 0 || !mode || !type || !blob || extra.length || !file)
      throw new Error(`unexpected Git tree record: ${record}`);
    result.set(normalizeRepositoryPath(file), { mode, blob });
  }
  return result;
}

export function parseIndex(buffer) {
  const result = new Map();
  for (const record of buffer.split("\0").filter(Boolean)) {
    const delimiter = record.indexOf("\t");
    const [mode, blob, stage, ...extra] = record.slice(0, delimiter).split(/\s+/u);
    const file = record.slice(delimiter + 1);
    if (delimiter < 0 || !mode || !blob || !stage || extra.length || !file)
      throw new Error(`unexpected Git index record: ${record}`);
    if (stage !== "0")
      throw new Error(`cannot audit unresolved index path: ${normalizeRepositoryPath(file)}`);
    result.set(normalizeRepositoryPath(file), { mode, blob });
  }
  return result;
}

function gitBlobIdentity(contents, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${contents.length}\0`))
    .update(contents)
    .digest("hex");
}

export function canonicalTextBlob(contents, objectFormat, attributes) {
  if (
    !["set", "auto"].includes(attributes.text) ||
    attributes.eol !== "lf" ||
    !["unset", "unspecified"].includes(attributes.filter) ||
    !["unset", "unspecified"].includes(attributes["working-tree-encoding"]) ||
    contents.includes(0)
  )
    return null;
  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents)) return null;
  return gitBlobIdentity(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"), objectFormat);
}

function textAttributes(root, file) {
  const values = git(root, [
    "check-attr",
    "-z",
    "text",
    "eol",
    "filter",
    "working-tree-encoding",
    "--",
    file,
  ]).split("\0");
  const attributes = {};
  for (let offset = 0; offset + 2 < values.length; offset += 3) {
    if (values[offset] !== file) throw new Error(`Unexpected Git attribute path for ${file}`);
    attributes[values[offset + 1]] = values[offset + 2];
  }
  return attributes;
}

function contentIdentity(root, file, objectFormat, expectedBlob) {
  const absolute = path.join(root, ...file.split("/"));
  if (!existsSync(absolute))
    return { kind: "missing", worktreeMode: null, sha256: null, gitBlob: null };
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(readlinkSync(absolute));
    return {
      kind: "symlink",
      worktreeMode: "120000",
      sha256: createHash("sha256").update(target).digest("hex"),
      gitBlob: gitBlobIdentity(target, objectFormat),
    };
  }
  if (!stat.isFile()) return { kind: "other", worktreeMode: null, sha256: null, gitBlob: null };
  const contents = readFileSync(absolute);
  const gitBlob = gitBlobIdentity(contents, objectFormat);
  // Preserve raw bytes for fingerprints. Only explicit LF text attributes,
  // without filters/encoding, permit a separate CRLF-normalized comparison.
  const canonical =
    gitBlob !== expectedBlob && contents.includes(Buffer.from("\r\n"))
      ? canonicalTextBlob(contents, objectFormat, textAttributes(root, file))
      : null;
  return {
    kind: "file",
    worktreeMode: stat.mode & 0o111 ? "100755" : "100644",
    sha256: createHash("sha256").update(contents).digest("hex"),
    gitBlob,
    canonicalTextBlob: canonical,
  };
}

function nulPaths(buffer) {
  return buffer.split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

export function assertNoSplitIndex(stagedPaths, unstagedPaths) {
  const unstaged = new Set(unstagedPaths);
  const split = [...new Set(stagedPaths.filter((file) => unstaged.has(file)))].sort();
  if (split.length) throw new Error(`cannot audit partially staged paths: ${split.join(", ")}`);
}

export function repositoryInventory(root = projectRoot) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const objectFormat = git(root, ["rev-parse", "--show-object-format"]).trim();
  if (!["sha1", "sha256"].includes(objectFormat))
    throw new Error(`unsupported Git object format: ${objectFormat}`);
  const headTree = parseTree(git(root, ["ls-tree", "-r", "-z", "HEAD"]));
  const index = parseIndex(git(root, ["ls-files", "-s", "-z"]));
  assertNoSplitIndex(
    nulPaths(git(root, ["diff", "--cached", "--name-only", "-z", "HEAD"])),
    nulPaths(git(root, ["diff-files", "--name-only", "-z"])),
  );
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepositoryPath);
  const files = [...new Set([...headTree.keys(), ...index.keys(), ...untracked])]
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const ownership = domainsForPath(file);
      return {
        path: file,
        headBlob: headTree.get(file)?.blob ?? null,
        headMode: headTree.get(file)?.mode ?? null,
        indexBlob: index.get(file)?.blob ?? null,
        indexMode: index.get(file)?.mode ?? null,
        ...contentIdentity(root, file, objectFormat, headTree.get(file)?.blob),
        domains: [...ownership.domains].sort(),
        ambiguous: ownership.ambiguous,
        untracked: !index.has(file),
      };
    });
  return { head, objectFormat, files };
}

function commandVersion(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (result.error) return `unavailable:${result.error.code ?? result.error.message}`;
  if (result.status !== 0) return `error:${result.status}`;
  return String(result.stdout || result.stderr).trim();
}

/** Observe only runtime fields consumed by the selected receipt domains. */
export function validationRuntime(root = projectRoot, options = {}) {
  const domains = options.domains ?? allReusableDomains;
  const environment = options.environment ?? process.env;
  const version =
    options.commandVersion ?? ((command, args) => commandVersion(command, args, root));
  const includes = (...names) => names.some((name) => domains.includes(name));
  const runtime = {
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    node: process.version,
    git: version("git", ["--version"]),
    just: version("just", ["--version"]),
    environment: Object.fromEntries(
      environmentWhitelist.map((name) => [name, environment[name] ?? null]),
    ),
  };
  if (includes("rust", "rscheck")) {
    runtime.rustc = version("rustc", ["--version", "--verbose"]);
    runtime.cargo = version("cargo", ["--version"]);
  }
  if (includes("rust")) {
    runtime.cargoNextest = version("cargo", ["nextest", "--version"]);
    runtime.cargoShear = version("cargo", ["shear", "--version"]);
  }
  if (includes("rscheck")) runtime.rscheck = version("rscheck", ["--version"]);
  if (includes("lint")) {
    runtime.aqua = version("aqua", ["--version"]);
    runtime.powershell = version("pwsh", ["--version"]);
  }
  if (includes("format", "ui", "lint", "release")) {
    runtime.packageManager = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).packageManager;
    runtime.packageManagerVersion = version("pnpm", ["--version"]);
  }
  return runtime;
}

// Exhaustive audit retains the complete historical runtime inventory.
export const auditRuntime = validationRuntime;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export function fingerprintInputs(stage, inventory, runtime) {
  const inputs = inventory.files
    .filter((file) => file.domains.includes(stage.domain))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      modes: [
        ...new Set([file.headMode, file.indexMode, file.worktreeMode].filter(Boolean)),
      ].sort(),
      contentIdentities: [
        ...new Set([file.headBlob, file.indexBlob, file.gitBlob].filter(Boolean)),
      ].sort(),
      sha256: file.sha256,
      domains: file.domains,
      ambiguous: file.ambiguous,
    }));
  const applicableRuntime = {
    platform: runtime.platform,
    architecture: runtime.architecture,
    osRelease: runtime.osRelease,
    node: runtime.node,
    git: runtime.git,
    just: runtime.just,
    environment: runtime.environment,
    ...(["rust", "rscheck"].includes(stage.domain)
      ? { rustc: runtime.rustc, cargo: runtime.cargo }
      : {}),
    ...(stage.domain === "rust"
      ? { cargoNextest: runtime.cargoNextest, cargoShear: runtime.cargoShear }
      : {}),
    ...(stage.domain === "rscheck" ? { rscheck: runtime.rscheck } : {}),
    ...(stage.domain === "lint" ? { aqua: runtime.aqua, powershell: runtime.powershell } : {}),
    ...(["format", "ui", "lint", "release"].includes(stage.domain)
      ? {
          packageManager: runtime.packageManager,
          packageManagerVersion: runtime.packageManagerVersion,
        }
      : {}),
  };
  return {
    contract: receiptFormat,
    gitObjectFormat: inventory.objectFormat ?? "sha1",
    stage: { id: stage.id, recipe: stage.recipe, domain: stage.domain },
    inputs,
    runtime: applicableRuntime,
  };
}

export function fingerprintStage(stage, inventory, runtime) {
  return digest(fingerprintInputs(stage, inventory, runtime));
}

export function receiptEnvelope(payload) {
  return { payload, integrity: digest(payload) };
}

export function validateReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== "object") return { valid: false, reason: "missing receipt" };
  if (!receipt.payload || receipt.integrity !== digest(receipt.payload))
    return { valid: false, reason: "receipt integrity mismatch" };
  const payload = receipt.payload;
  if (payload.format !== receiptFormat || payload.kind !== "successful-stage")
    return { valid: false, reason: "receipt is incomplete or has an unsupported format" };
  if (payload.success !== true)
    return { valid: false, reason: "receipt does not record a successful stage" };
  if (expected.stageId && payload.stageId !== expected.stageId)
    return { valid: false, reason: "receipt stage does not match" };
  if (expected.fingerprint && payload.fingerprint !== expected.fingerprint)
    return { valid: false, reason: "stage fingerprint changed" };
  return { valid: true, payload };
}
