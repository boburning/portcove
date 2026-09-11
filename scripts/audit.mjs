import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const receiptFormat = 1;
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

export const AUDIT_STAGES = Object.freeze([
  { id: "format", recipe: "fmt-frontend-check", domain: "format", reusable: true },
  { id: "rust", recipe: "check-rust", domain: "rust", reusable: true },
  { id: "ui", recipe: "ui-check", domain: "ui", reusable: true },
  { id: "script-lint", recipe: "script-lint", domain: "lint", reusable: true },
  {
    id: "repository-tooling",
    recipe: "repository-tools",
    domain: "repository",
    reusable: true,
  },
  { id: "roadmap", recipe: "roadmap-check", domain: "roadmap", reusable: true },
  {
    id: "development-tools",
    recipe: "development-tools",
    domain: "development",
    reusable: true,
  },
  {
    id: "dependency-policy",
    recipe: "deny",
    domain: "rust",
    reusable: false,
    reason: "dependency and advisory state is externally mutable",
  },
  { id: "rscheck", recipe: "rscheck", domain: "rscheck", reusable: true },
  {
    id: "release-unit",
    recipe: "release-check",
    domain: "release",
    reusable: true,
  },
  {
    id: "windows-qualification",
    recipe: "windows-qualification-check",
    domain: "release",
    reusable: false,
    platforms: ["win32"],
    reason: "packaged Windows and machine-global state must be observed each audit",
  },
]);

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
  "PORTCOVE_REQUIRE_DEEP_TOOLS",
]);

const oxfmtSupportedExtension =
  /\.(?:astro|cjs|css|html|js|json|json5|jsonc|jsx|less|md|mdx|mjs|mts|scss|svelte|ts|tsx|vue|ya?ml)$/iu;
const oxfmtExcludedPath =
  /^(?:apps\/desktop\/(?:dist|node_modules|src-tauri\/gen)\/|target\/|work\/|outputs\/|release-assets\/|\.codex-remote-attachments\/|\.fallow(?:-review)?\/|\.rscheck\/|\.semdup\/|\.tmp\/|mutants\.out(?:\.old)?\/|Portcove-CI-FiveMinutes\/|integrations\/playnite\/(?:bin|obj|tests\/(?:bin|obj))\/|crates\/portcove-core\/catalog\/|crates\/[^/]+\/tests\/fixtures\/|docs\/archive\/|docs\/releases\/\d+\.md$)/u;
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

  // Keep repository-wide formatting independent from UI behavior so a
  // documentation-only rebase cannot invalidate otherwise-identical code evidence.
  if (isFormatInput(file)) add(domains, "format");

  if (
    file === "justfile" ||
    file === "scripts/audit.mjs" ||
    file === "scripts/audit.test.mjs" ||
    file === "scripts/dev-storage.mjs" ||
    file === "scripts/tool-cache.mjs" ||
    file === "scripts/test-duration-reporter.mjs" ||
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
    file === ".oxlintrc.json"
  ) {
    add(domains, "ui");
    if (file === "apps/desktop/package.json" || file === "apps/desktop/pnpm-lock.yaml")
      add(domains, "release");
    // Oxfmt is resolved through the frontend lockfile even though the lockfile
    // itself is intentionally excluded from formatting.
    if (file === "apps/desktop/pnpm-lock.yaml") add(domains, "format");
    if (file.startsWith("apps/desktop/assets/brand/models/v2/")) add(domains, "lint");
    recognized = true;
  }

  if (/^apps\/desktop\/src\/transport-(?:schemas|inputs|host-.+)\.generated\.json$/u.test(file)) {
    add(domains, "rust");
    recognized = true;
  }

  if (file.startsWith(".github/workflows/") || file.startsWith(".github/actions/")) {
    add(domains, "lint", "repository");
    if (/release|updater|qualification/u.test(file)) add(domains, "release");
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
    if (/release|updater|checksum|qualification|installer|package-cli|smoke-test-cli/u.test(name))
      add(domains, "release");
    if (/roadmap|source-provenance|catalog-schema/u.test(name)) add(domains, "roadmap");
    if (
      /dev-|development-|local-validation|native-session|desktop-test|tool-cache|bootstrap-quality/u.test(
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
    if (/release|delivery|updater/iu.test(file)) add(domains, "release");
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
      "taplo.toml",
      "hawk.toml",
      "semdup.toml",
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

function contentIdentity(root, file, objectFormat) {
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
  return {
    kind: "file",
    worktreeMode: stat.mode & 0o111 ? "100755" : "100644",
    sha256: createHash("sha256").update(contents).digest("hex"),
    gitBlob: gitBlobIdentity(contents, objectFormat),
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
        ...contentIdentity(root, file, objectFormat),
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

export function auditRuntime(root = projectRoot) {
  const packageManager = JSON.parse(
    readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
  ).packageManager;
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    node: process.version,
    git: commandVersion("git", ["--version"], root),
    just: commandVersion("just", ["--version"], root),
    rustc: commandVersion("rustc", ["--version", "--verbose"], root),
    cargo: commandVersion("cargo", ["--version"], root),
    cargoNextest: commandVersion("cargo", ["nextest", "--version"], root),
    cargoShear: commandVersion("cargo", ["shear", "--version"], root),
    rscheck: commandVersion("rscheck", ["--version"], root),
    aqua: commandVersion("aqua", ["--version"], root),
    powershell: commandVersion("pwsh", ["--version"], root),
    packageManager,
    packageManagerVersion: commandVersion("pnpm", ["--version"], root),
    environment: Object.fromEntries(
      environmentWhitelist.map((name) => [name, process.env[name] ?? null]),
    ),
  };
}

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

export function fingerprintStage(stage, inventory, runtime) {
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
  return digest({
    contract: receiptFormat,
    gitObjectFormat: inventory.objectFormat ?? "sha1",
    stage: { id: stage.id, recipe: stage.recipe, domain: stage.domain },
    inputs,
    runtime: applicableRuntime,
  });
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

function stageReceiptPath(receiptRoot, stage, fingerprint) {
  return path.join(receiptRoot, "stages", stage.id, `${fingerprint}.json`);
}

function readReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

export function planAudit(options = {}) {
  const root = options.root ?? projectRoot;
  const stages = options.stages ?? AUDIT_STAGES;
  const inventory = options.inventory ?? repositoryInventory(root);
  const runtime = options.runtime ?? auditRuntime(root);
  const receiptRoot = options.receiptRoot ?? path.join(root, "work", "validation-receipts");
  const fresh = options.fresh ?? false;
  return {
    head: inventory.head,
    receiptRoot,
    inventory,
    runtime,
    stages: stages
      .filter((stage) => !stage.platforms || stage.platforms.includes(runtime.platform))
      .map((stage) => {
        const fingerprint = fingerprintStage(stage, inventory, runtime);
        if (!stage.reusable)
          return {
            ...stage,
            fingerprint,
            action: "run",
            rationale: stage.reason,
          };
        if (fresh)
          return {
            ...stage,
            fingerprint,
            action: "run",
            rationale: "--fresh requires execution",
          };
        const receiptPath = stageReceiptPath(receiptRoot, stage, fingerprint);
        const validation = validateReceipt(readReceipt(receiptPath), {
          stageId: stage.id,
          fingerprint,
        });
        return validation.valid
          ? {
              ...stage,
              fingerprint,
              action: "reuse",
              rationale: `matching successful receipt from ${validation.payload.originatingHead}`,
              prior: validation.payload,
            }
          : {
              ...stage,
              fingerprint,
              action: "run",
              rationale:
                validation.reason === "missing receipt"
                  ? "no successful receipt matches the complete fingerprint"
                  : validation.reason,
            };
      }),
  };
}

function displayPlan(plan) {
  console.log(`# Portcove audit plan`);
  console.log(`Head: ${plan.head}`);
  for (const stage of plan.stages)
    console.log(
      `- ${stage.id}: ${stage.action} (${stage.rationale}); fingerprint ${stage.fingerprint}`,
    );
}

export function executeAudit(plan, options = {}) {
  const execute =
    options.execute ??
    ((stage) =>
      spawnSync("just", [stage.recipe], {
        cwd: options.root ?? projectRoot,
        stdio: "inherit",
        windowsHide: true,
        env: process.env,
      }));
  const clock = options.clock ?? (() => Date.now());
  const results = [];

  for (const stage of plan.stages) {
    if (stage.action === "reuse") {
      results.push({
        id: stage.id,
        recipe: stage.recipe,
        status: "reused",
        fingerprint: stage.fingerprint,
        originatingHead: stage.prior.originatingHead,
        durationMs: stage.prior.durationMs,
        rationale: stage.rationale,
      });
      console.log(`\n[audit] ${stage.id}: reused (${stage.rationale})`);
      continue;
    }

    const receiptPath = stageReceiptPath(plan.receiptRoot, stage, stage.fingerprint);
    if (stage.reusable) rmSync(receiptPath, { force: true });
    console.log(`\n[audit] ${stage.id}: running just ${stage.recipe} (${stage.rationale})`);
    const started = clock();
    let execution;
    try {
      execution = execute(stage);
    } catch (error) {
      execution = { status: null, error };
    }
    const durationMs = Math.max(0, clock() - started);
    const passed = !execution?.error && execution?.status === 0;
    const result = {
      id: stage.id,
      recipe: stage.recipe,
      status: passed ? "passed" : "failed",
      fingerprint: stage.fingerprint,
      originatingHead: plan.head,
      durationMs,
      rationale: stage.rationale,
      ...(passed ? {} : { exitCode: execution?.status ?? null }),
    };
    results.push(result);
    if (passed && stage.reusable) {
      const payload = {
        format: receiptFormat,
        kind: "successful-stage",
        success: true,
        stageId: stage.id,
        recipe: stage.recipe,
        fingerprint: stage.fingerprint,
        originatingHead: plan.head,
        durationMs,
        completedAt: new Date().toISOString(),
      };
      writeJsonAtomic(receiptPath, receiptEnvelope(payload));
    }
    console.log(
      `[audit] ${stage.id}: ${passed ? "passed" : "failed"} in ${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  const success = results.every((result) => result.status !== "failed");
  const reportPayload = {
    format: receiptFormat,
    kind: "audit-run",
    head: plan.head,
    success,
    completedAt: new Date().toISOString(),
    stages: results,
  };
  writeJsonAtomic(
    path.join(plan.receiptRoot, "audits", `${plan.head}.json`),
    receiptEnvelope(reportPayload),
  );
  return { success, results, report: reportPayload };
}

function parseArguments(argv) {
  let fresh = false;
  let planOnly = false;
  for (const argument of argv) {
    if (argument === "--fresh") fresh = true;
    else if (argument === "--plan") planOnly = true;
    else if (argument === "--help") return { help: true, fresh: false, planOnly: false };
    else throw new Error(`unknown audit option: ${argument}`);
  }
  if (fresh && planOnly) throw new Error("--fresh and --plan cannot be combined");
  return { help: false, fresh, planOnly };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log("usage: audit.mjs [--plan|--fresh]");
    console.log("  --plan   report stage execution/reuse without running or writing receipts");
    console.log("  --fresh  ignore receipts and execute every applicable stage");
    return;
  }
  const plan = planAudit({ fresh: options.fresh });
  displayPlan(plan);
  if (options.planOnly) return;
  const result = executeAudit(plan);
  if (!result.success) {
    const failed = result.results
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.id);
    throw new Error(`audit failed after all independent stages completed: ${failed.join(", ")}`);
  }
  console.log("\nPortcove audit passed.");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
