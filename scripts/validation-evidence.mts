import { normalizeRepositoryPath } from "./repository-path.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validationOwnershipForPath } from "./validation-plan.mts";
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
] as const;

export type ValidationDomain = (typeof allReusableDomains)[number];
export function isValidationDomain(value: unknown): value is ValidationDomain {
  return allReusableDomains.some((domain) => domain === value);
}
export interface StageIdentity {
  id: string;
  recipe: string;
  domain: ValidationDomain;
}
/** Runtime data is persisted JSON; optional unavailable tool observations may be null. */
export function isFingerprintRuntime(value: unknown): value is FingerprintRuntime {
  if (!isRecord(value) || !isRecord(value.environment)) return false;
  if (
    !["platform", "architecture", "osRelease", "node", "git", "just"].every(
      (key) => typeof value[key] === "string",
    )
  )
    return false;
  if (
    !Object.values(value.environment).every((entry) => entry === null || typeof entry === "string")
  )
    return false;
  return [
    "rustc",
    "cargo",
    "cargoNextest",
    "cargoShear",
    "rscheck",
    "aqua",
    "powershell",
    "packageManager",
    "packageManagerVersion",
  ].every(
    (key) => value[key] === undefined || value[key] === null || typeof value[key] === "string",
  );
}
interface GitEntry {
  mode: string;
  blob: string;
}
interface ContentIdentity {
  kind: "missing" | "symlink" | "other" | "file";
  worktreeMode: string | null;
  sha256: string | null;
  gitBlob: string | null;
  canonicalTextBlob?: string | null;
}
export interface InventoryFile extends ContentIdentity {
  path: string;
  headBlob: string | null;
  headMode: string | null;
  indexBlob: string | null;
  indexMode: string | null;
  domains: ValidationDomain[];
  ambiguous: boolean;
  untracked: boolean;
}
export interface RepositoryInventory {
  head: string;
  objectFormat: "sha1" | "sha256";
  files: InventoryFile[];
}
export interface ValidationRuntime {
  platform: string;
  architecture: string;
  osRelease: string;
  node: string;
  git: string;
  just: string;
  environment: Record<string, string | null>;
  rustc?: string;
  cargo?: string;
  cargoNextest?: string;
  cargoShear?: string;
  rscheck?: string;
  aqua?: string;
  powershell?: string;
  packageManager?: string;
  packageManagerVersion?: string;
}
interface RuntimeOptions {
  domains?: readonly ValidationDomain[];
  environment?: NodeJS.ProcessEnv;
  commandVersion?: (command: string, args: string[]) => string;
}
export interface SuccessfulStageReceipt {
  format: 1;
  kind: "successful-stage";
  success: true;
  stageId: string;
  fingerprint: string;
  originatingHead: string;
  completedAt: string;
  recipe?: string;
  durationMs?: number;
}
type ReceiptValidation =
  | { valid: false; reason: string }
  | { valid: true; payload: SuccessfulStageReceipt };

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

function isFormatInput(file: string) {
  if (file.endsWith(".toml") && !file.startsWith("apps/desktop/src-tauri/gen/")) return true;
  return (
    oxfmtSupportedExtension.test(file) &&
    !oxfmtExcludedPath.test(file) &&
    !oxfmtExcludedFile.test(file)
  );
}

function add(domains: Set<ValidationDomain>, ...values: ValidationDomain[]) {
  for (const value of values) domains.add(value);
}

export function domainsForPath(input: string) {
  const file = normalizeRepositoryPath(input);
  const domains = new Set<ValidationDomain>();
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
    file === "scripts/audit.mts" ||
    file === "scripts/audit.test.mts" ||
    file === "scripts/local-validation.mts" ||
    file === "scripts/local-validation.test.mts" ||
    file === "scripts/validation-plan.mts" ||
    file === "scripts/validation-plan.test.mts" ||
    file === "scripts/dev-storage.mts" ||
    file === "scripts/tool-cache.mts" ||
    file === "scripts/test-duration-reporter.mts" ||
    file === "scripts/required-node-test-reporter.mts" ||
    file === "scripts/node-case-observations.mts" ||
    [
      "scripts/node-platform-skips.mts",
      "scripts/node-test-suites.mts",
      "scripts/node-test-suites.json",
      "scripts/nextest-outcomes.mts",
      "scripts/nextest-outcomes-cli.mts",
      "scripts/report-summary.mts",
      "scripts/bounded-summary.mts",
      "scripts/fallow-summary.mts",
      "scripts/qualification-rustdoc.mts",
      "scripts/standalone-rust-tests.mts",
      "scripts/development-evidence.mts",
      "scripts/rustdoc-outcomes.mts",
    ].includes(file) ||
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
    for (const domain of ["format", "ui", "release"] as const) add(domains, domain);
    recognized = true;
  }

  if (/^patches\/[^/]+\.patch$/u.test(file)) {
    add(domains, "format", "ui", "release");
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
      ["desktop-scenarios.mts", "desktop-scenarios.test.mts"].includes(name) ||
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
    // Formatting says nothing about the behavioral stages consuming a script.
    if (/^(?:retained-package|retained-evidence|native-helper-dependencies)(?:\.|$)/u.test(name))
      add(domains, "development", "release", "repository");
    if (/^release-semantic-/u.test(name)) add(domains, "release");
    if (/^github-api(?:\.|$)/u.test(name))
      add(domains, "repository", "roadmap", "development", "release");
    if (name === "runtime-values.mts" || ![...domains].some((domain) => domain !== "format"))
      add(domains, ...allReusableDomains);
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

function run(
  command: string,
  args: string[],
  options: Pick<SpawnSyncOptionsWithStringEncoding, "cwd" | "env" | "stdio"> = {},
) {
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

function git(root: string, args: string[]) {
  return run("git", args, { cwd: root });
}

function parseTree(buffer: string) {
  const result = new Map<string, GitEntry>();
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

export function parseIndex(buffer: string) {
  const result = new Map<string, GitEntry>();
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

function gitBlobIdentity(contents: Buffer, objectFormat: string) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${contents.length}\0`))
    .update(contents)
    .digest("hex");
}

export function canonicalTextBlob(
  contents: Buffer,
  objectFormat: string,
  attributes: Readonly<Record<string, string | undefined>>,
) {
  if (
    !["set", "auto"].includes(attributes.text ?? "") ||
    attributes.eol !== "lf" ||
    !["unset", "unspecified"].includes(attributes.filter ?? "") ||
    !["unset", "unspecified"].includes(attributes["working-tree-encoding"] ?? "") ||
    contents.includes(0)
  )
    return null;
  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents)) return null;
  return gitBlobIdentity(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"), objectFormat);
}

function textAttributes(root: string, file: string) {
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
  const attributes: Record<string, string> = {};
  for (let offset = 0; offset + 2 < values.length; offset += 3) {
    if (values[offset] !== file) throw new Error(`Unexpected Git attribute path for ${file}`);
    const name = values[offset + 1],
      value = values[offset + 2];
    if (name === undefined || value === undefined)
      throw new Error(`Incomplete Git attribute record for ${file}`);
    attributes[name] = value;
  }
  return attributes;
}

function contentIdentity(
  root: string,
  file: string,
  objectFormat: string,
  expectedBlob: string | undefined,
): ContentIdentity {
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

function nulPaths(buffer: string) {
  return buffer.split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

export function assertNoSplitIndex(stagedPaths: string[], unstagedPaths: string[]) {
  const unstaged = new Set(unstagedPaths);
  const split = [...new Set(stagedPaths.filter((file) => unstaged.has(file)))].sort();
  if (split.length) throw new Error(`cannot audit partially staged paths: ${split.join(", ")}`);
}

export function repositoryInventory(root = projectRoot): RepositoryInventory {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const objectFormat = git(root, ["rev-parse", "--show-object-format"]).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
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
        domains: [...ownership.domains].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        ambiguous: ownership.ambiguous,
        untracked: !index.has(file),
      };
    });
  return { head, objectFormat, files };
}

function commandVersion(command: string, args: string[], root: string) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (result.error) return `unavailable:${errorCode(result.error) ?? result.error.message}`;
  if (result.status !== 0) return `error:${result.status}`;
  return String(result.stdout || result.stderr).trim();
}

/** Observe only runtime fields consumed by the selected receipt domains. */
export function validationRuntime(
  root = projectRoot,
  options: RuntimeOptions = {},
): ValidationRuntime {
  const domains = options.domains ?? allReusableDomains;
  const environment = options.environment ?? process.env;
  const version =
    options.commandVersion ?? ((command, args) => commandVersion(command, args, root));
  const includes = (...names: ValidationDomain[]) => names.some((name) => domains.includes(name));
  const runtime: ValidationRuntime = {
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
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (!isRecord(manifest) || typeof manifest.packageManager !== "string")
      throw new Error("Validation runtime requires the declared packageManager identity");
    runtime.packageManager = manifest.packageManager;
    runtime.packageManagerVersion = version("pnpm", ["--version"]);
  }
  return runtime;
}

// Exhaustive audit retains the complete historical runtime inventory.
export const auditRuntime = validationRuntime;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  return value;
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

/** Fingerprints preserve absent historical identity fields as absent, rather than inventing values. */
export interface FingerprintInventory {
  objectFormat?: RepositoryInventory["objectFormat"];
  files: (Pick<InventoryFile, "path" | "kind" | "domains" | "ambiguous"> &
    Partial<
      Pick<
        InventoryFile,
        "sha256" | "headMode" | "indexMode" | "worktreeMode" | "headBlob" | "indexBlob" | "gitBlob"
      >
    >)[];
}
type RequiredRuntimeKey =
  | "platform"
  | "architecture"
  | "osRelease"
  | "node"
  | "git"
  | "just"
  | "environment";
export type FingerprintRuntime = Pick<ValidationRuntime, RequiredRuntimeKey> & {
  [Key in keyof Omit<ValidationRuntime, RequiredRuntimeKey>]?: ValidationRuntime[Key] | null;
};
export function fingerprintInputs(
  stage: StageIdentity,
  inventory: FingerprintInventory,
  runtime: FingerprintRuntime,
) {
  const inputs = inventory.files
    .filter((file) => file.domains.includes(stage.domain))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      modes: [
        ...new Set(
          [file.headMode, file.indexMode, file.worktreeMode].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        ),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      contentIdentities: [
        ...new Set(
          [file.headBlob, file.indexBlob, file.gitBlob].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        ),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
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

export function fingerprintStage(
  stage: StageIdentity,
  inventory: FingerprintInventory,
  runtime: FingerprintRuntime,
) {
  return digest(fingerprintInputs(stage, inventory, runtime));
}

export function receiptEnvelope<Payload>(payload: Payload) {
  return { payload, integrity: digest(payload) };
}

export function validateReceipt(
  receipt: unknown,
  expected: { stageId?: string; fingerprint?: string } = {},
): ReceiptValidation {
  if (!isRecord(receipt)) return { valid: false, reason: "missing receipt" };
  if (!isRecord(receipt.payload) || receipt.integrity !== digest(receipt.payload))
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
  if (!isSuccessfulStageReceipt(payload))
    return { valid: false, reason: "receipt stage identity is incomplete or malformed" };
  return { valid: true, payload };
}

function isSuccessfulStageReceipt(payload: unknown): payload is SuccessfulStageReceipt {
  return (
    isRecord(payload) &&
    payload.format === receiptFormat &&
    payload.kind === "successful-stage" &&
    payload.success === true &&
    typeof payload.stageId === "string" &&
    payload.stageId.length > 0 &&
    typeof payload.fingerprint === "string" &&
    payload.fingerprint.length > 0 &&
    typeof payload.originatingHead === "string" &&
    payload.originatingHead.length > 0 &&
    typeof payload.completedAt === "string" &&
    payload.completedAt.length > 0 &&
    (payload.recipe === undefined || typeof payload.recipe === "string") &&
    (payload.durationMs === undefined ||
      (typeof payload.durationMs === "number" &&
        Number.isFinite(payload.durationMs) &&
        payload.durationMs >= 0))
  );
}
