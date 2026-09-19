import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildValidationPlan,
  validateValidationPlan,
  validationOwnershipForPath,
} from "./validation-plan.mjs";
import {
  auditRuntime,
  domainsForPath,
  fingerprintStage,
  receiptEnvelope,
  repositoryInventory,
  validateReceipt,
} from "./audit.mjs";
import { spawnCommand } from "./dev-storage.mjs";
import { parseRawDiff } from "./select-ci-plan.mjs";
import { readRustTestImpactMap, selectRustTestImpact } from "./rust-test-impact.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const durationReporter = "./scripts/test-duration-reporter.mjs";

const packagePrefixes = new Map([
  ["crates/portcove-core/", "portcove-core"],
  ["crates/portcove-cli/", "portcove-cli"],
  ["crates/portcove-release-tools/", "portcove-release-tools"],
  ["apps/desktop/src-tauri/", "portcove-desktop"],
]);

export function packagesWithDoctests(metadata) {
  if (!Array.isArray(metadata?.packages))
    throw new Error("cargo metadata did not return a package inventory");
  return new Set(
    metadata.packages
      .filter(
        (pkg) =>
          typeof pkg?.name === "string" &&
          Array.isArray(pkg.targets) &&
          pkg.targets.some((target) => target?.doctest === true),
      )
      .map((pkg) => pkg.name),
  );
}

function readDoctestPackages() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo metadata failed: ${result.stderr.trim()}`);
  return packagesWithDoctests(JSON.parse(result.stdout));
}

const oxfmtExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const explicitNodeTests = new Map([
  ["AGENTS.md", ["scripts/repository-settings.test.mjs", "scripts/repository-skills.test.mjs"]],
  [
    "CONTRIBUTING.md",
    ["scripts/repository-settings.test.mjs", "scripts/repository-skills.test.mjs"],
  ],
  ["docs/README.md", ["scripts/repository-skills.test.mjs"]],
  [
    "docs/CONTRIBUTION-CONVENTIONS.md",
    ["scripts/repository-settings.test.mjs", "scripts/repository-skills.test.mjs"],
  ],
  [
    "docs/DEVELOPMENT-TOOLS.md",
    ["scripts/repository-settings.test.mjs", "scripts/repository-skills.test.mjs"],
  ],
  ["docs/PROJECT-GOVERNANCE.md", ["scripts/repository-settings.test.mjs"]],
  ["docs/QUALITY.md", ["scripts/repository-settings.test.mjs"]],
  ["docs/REPOSITORY-SETTINGS.md", ["scripts/repository-settings.test.mjs"]],
  ["scripts/local-validation.mjs", ["scripts/repository-settings.test.mjs"]],
  [
    ".config/rust-test-impact.json",
    ["scripts/rust-test-impact.test.mjs", "scripts/local-validation.test.mjs"],
  ],
  ["scripts/check-vitest-durations.mjs", ["scripts/test-duration-reporter.test.mjs"]],
  ["scripts/pr-delivery.mjs", ["scripts/repository-skills.test.mjs"]],
  ["scripts/package-local.ps1", ["scripts/repository-skills.test.mjs"]],
  ["scripts/release-preflight.ps1", ["scripts/repository-skills.test.mjs"]],
  ["scripts/roadmap.mjs", ["scripts/repository-skills.test.mjs"]],
  ["scripts/test-windows-installer.ps1", ["scripts/repository-skills.test.mjs"]],
  ["scripts/windows-qualification-session.ps1", ["scripts/repository-skills.test.mjs"]],
  ["crates/portcove-core/catalog/catalog.json", ["scripts/repository-skills.test.mjs"]],
  ["crates/portcove-core/src/catalog.rs", ["scripts/repository-skills.test.mjs"]],
  [
    "apps/desktop/scripts/desktop-test.mjs",
    [
      "scripts/desktop-scenarios.test.mjs",
      "scripts/development-evidence.test.mjs",
      "scripts/native-session-lock.test.mjs",
    ],
  ],
  ["apps/desktop/scripts/desktop-preparation-test.mjs", ["scripts/desktop-scenarios.test.mjs"]],
  [
    ".github/quality-tools.json",
    ["scripts/quality-tools.test.mjs", "scripts/dependency-automation.test.mjs"],
  ],
  [".node-version", ["scripts/dependency-automation.test.mjs"]],
  ["Cargo.toml", ["scripts/dependency-automation.test.mjs"]],
  ["rust-toolchain.toml", ["scripts/dependency-automation.test.mjs"]],
  ["package.json", ["scripts/dependency-automation.test.mjs", "scripts/local-validation.test.mjs"]],
  ["pnpm-lock.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["pnpm-workspace.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["apps/desktop/pnpm-lock.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["apps/desktop/pnpm-workspace.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["apps/desktop/package.json", ["scripts/local-validation.test.mjs"]],
  [".github/dependabot.yml", ["scripts/dependency-automation.test.mjs"]],
  [
    ".config/tool-bootstrap.json",
    [
      "scripts/tool-cache.test.mjs",
      "scripts/quality-tools.test.mjs",
      "scripts/dev-doctor.test.mjs",
    ],
  ],
  [".github/roadmap.json", ["scripts/roadmap.test.mjs"]],
  [".github/pr-conventions.json", ["scripts/pr-conventions.test.mjs"]],
  [
    ".github/qualification-coverage.json",
    ["scripts/qualification-coverage.test.mjs", "scripts/ci-workflow.test.mjs"],
  ],
  [
    ".github/fast-host-policy.json",
    ["scripts/select-fast-host.test.mjs", "scripts/ci-workflow.test.mjs"],
  ],
  [
    "justfile",
    [
      "scripts/local-validation.test.mjs",
      "scripts/dev-storage.test.mjs",
      "scripts/ci-workflow.test.mjs",
      "scripts/dependency-automation.test.mjs",
      "scripts/repository-settings.test.mjs",
    ],
  ],
  [".oxfmtrc.json", ["scripts/local-validation.test.mjs", "scripts/ci-workflow.test.mjs"]],
  ["taplo.toml", ["scripts/local-validation.test.mjs"]],
]);

const workflowTests = new Map([
  ["release.yml", ["scripts/release-workflow.test.mjs"]],
  ["qualification.yml", ["scripts/qualification-coverage.test.mjs"]],
  ["configured-upstream-observer.yml", ["scripts/upstream-observer.test.mjs"]],
  ["upstream-health.yml", ["scripts/upstream-observer.test.mjs"]],
  ["updater-artifact-rehearsal.yml", ["scripts/updater-artifact-inventory.test.mjs"]],
  ["pr-conventions.yml", ["scripts/pr-conventions.test.mjs"]],
]);

const releaseContractTests = Object.freeze([
  "scripts/check-release-metadata.test.mjs",
  "scripts/release-package-policy.test.mjs",
  "scripts/write-release-checksums.test.mjs",
  "scripts/updater-artifact-inventory.test.mjs",
  "scripts/reconcile-release-assets.test.mjs",
  "scripts/finalize-release-assets.test.mjs",
  "scripts/generate-release-downloads.test.mjs",
  "scripts/select-release-channel.test.mjs",
  "scripts/release-coordinator.test.mjs",
  "scripts/reconstruct-application-update-records.test.mjs",
  "scripts/release-workflow.test.mjs",
  "scripts/windows-qualification-session.test.mjs",
]);

function normalizePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe repository path: ${value}`);
  return normalized;
}

function command(id, reason, executable, args, options = {}) {
  return {
    id,
    reason,
    executable,
    args,
    cwd: options.cwd ?? projectRoot,
    obligation: options.obligation ?? id,
  };
}

function commandIdentity(entry) {
  return JSON.stringify([entry.cwd, entry.executable, entry.args]);
}

export function deduplicateCommands(commands) {
  const unique = [];
  const byId = new Map();
  const byObligation = new Map();
  for (const entry of commands) {
    const identity = commandIdentity(entry);
    const obligation = entry.obligation ?? entry.id;
    const existingId = byId.get(entry.id);
    if (existingId) {
      if (existingId.identity !== identity || existingId.obligation !== obligation)
        throw new Error(
          `validation stage ${entry.id} selected conflicting commands or obligations`,
        );
      existingId.retained.reason = `${existingId.retained.reason}; also selected as ${entry.id}: ${entry.reason}`;
      continue;
    }

    const obligationIdentity = JSON.stringify([obligation, identity]);
    const existing = byObligation.get(obligationIdentity);
    if (existing) {
      existing.selectedIds.push(entry.id);
      existing.reason = `${existing.reason}; also selected as ${entry.id}: ${entry.reason}`;
      byId.set(entry.id, { identity, obligation, retained: existing });
      continue;
    }
    const retained = { ...entry, selectedIds: [entry.id] };
    unique.push(retained);
    byObligation.set(obligationIdentity, retained);
    byId.set(entry.id, { identity, obligation, retained });
  }
  return unique;
}

function heavyRustCommand(id, reason, executable, args, options = {}) {
  return command(
    id,
    reason,
    process.execPath,
    ["scripts/run-rust-tests.mjs", "--guard-command", executable, ...args],
    options,
  );
}

function corepackCommand(id, reason, args, options = {}) {
  return command(id, reason, "corepack", args, options);
}

function addNodeTest(selection, file) {
  selection.nodeTests.add(normalizePath(file));
}

function existingSiblingTest(file, fileExists) {
  if (!/\.(?:mjs|cjs|js)$/.test(file) || file.endsWith(".test.mjs")) return null;
  const sibling = file.replace(/\.(?:mjs|cjs|js)$/, ".test.mjs");
  return fileExists(sibling) ? sibling : null;
}

function classifyOnePath(selection, input, fileExists, options = {}) {
  const file = normalizePath(input);
  const extension = path.posix.extname(file).toLowerCase();
  const includeFileChecks = options.includeFileChecks ?? true;
  let recognized = false;

  if (includeFileChecks && oxfmtExtensions.has(extension)) {
    selection.oxfmtFiles.add(file);
  }
  if (extension === ".toml") selection.toml = true;

  for (const [prefix, packageName] of packagePrefixes) {
    if (file.startsWith(prefix)) {
      selection.packages.add(packageName);
      selection.scopes.add("rust");
      selection.rustfmt = true;
      recognized = true;
      break;
    }
  }

  if (
    file === "Cargo.toml" ||
    file === "Cargo.lock" ||
    file === "rust-toolchain.toml" ||
    file === "deny.toml" ||
    file === ".config/nextest.toml"
  ) {
    selection.workspaceRust = true;
    selection.rustfmt = true;
    selection.scopes.add("rust-workspace");
    recognized = true;
  }

  if (
    file.startsWith("apps/desktop/src/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("apps/desktop/assets/") ||
    file.startsWith("apps/desktop/public/") ||
    file === "apps/desktop/.fallowrc.json" ||
    /^apps\/desktop\/(?:(?:index|scenarios)\.html|package\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|eslint\.config\.mjs|stylelint\.config\.mjs)$/.test(
      file,
    )
  ) {
    selection.ui = true;
    selection.scopes.add("ui");
    recognized = true;
    if (file.startsWith("apps/desktop/src/") || file.startsWith("apps/desktop/scripts/")) {
      selection.uiRelatedFiles.add(file);
    } else {
      selection.uiFullTests = true;
    }
    if (extension === ".css") selection.stylelint = true;
    if (file === "apps/desktop/.fallowrc.json") {
      selection.fallow = true;
      addNodeTest(selection, "scripts/check-fallow-report.test.mjs");
    }
  }

  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "apps/desktop/pnpm-workspace.yaml",
    ].includes(file)
  ) {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    recognized = true;
  }

  if (file.startsWith("scripts/")) {
    selection.scopes.add("tooling");
    recognized = true;
    if (/\.(?:mjs|cjs|js)$/.test(file)) {
      selection.oxlint = true;
      if (file.endsWith(".test.mjs")) {
        if (includeFileChecks) addNodeTest(selection, file);
      } else {
        if (includeFileChecks) selection.nodeSyntax.add(file);
        const sibling = existingSiblingTest(file, fileExists);
        if (sibling) addNodeTest(selection, sibling);
      }
    }
    if (extension === ".ps1") selection.powershellLint = true;
    if (extension === ".sh") selection.shellLint = true;
    if (file === "scripts/fixtures/windows-process-tree-supervisor.rs.txt") {
      addNodeTest(selection, "scripts/heavy-rust-test-lock.test.mjs");
      addNodeTest(selection, "scripts/run-rust-tests.test.mjs");
      addNodeTest(selection, "scripts/rust-support-cache.test.mjs");
    }
    if (file === "scripts/lint-tools.integration.mjs") {
      for (const fixture of [
        "actionlint",
        "oxfmt",
        "oxlint",
        "psscriptanalyzer",
        "ruff",
        "shellcheck",
        "stylelint",
      ])
        selection.lintToolFixtures.add(fixture);
    }
    if (["scripts/run-rust-tests.mjs", "scripts/rust-support-cache.mjs"].includes(file)) {
      addNodeTest(selection, "scripts/run-rust-tests.test.mjs");
      addNodeTest(selection, "scripts/rust-support-cache.test.mjs");
    }
    if (validationOwnershipForPath(file).areas.includes("release-security")) {
      selection.scopes.add("release-tooling");
      for (const testFile of releaseContractTests) addNodeTest(selection, testFile);
      addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    }
  }

  if (file === "crates/portcove-core/src/testdata/host_tool_probe.rs.txt") {
    selection.scopes.add("tooling");
    recognized = true;
    addNodeTest(selection, "scripts/run-rust-tests.test.mjs");
    addNodeTest(selection, "scripts/rust-support-cache.test.mjs");
  }

  if (file.startsWith(".github/workflows/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    addNodeTest(selection, "scripts/dependency-automation.test.mjs");
    for (const testFile of workflowTests.get(path.posix.basename(file)) ?? [])
      addNodeTest(selection, testFile);
    recognized = true;
  }

  if (file.startsWith(".github/actions/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    addNodeTest(selection, "scripts/dependency-automation.test.mjs");
    recognized = true;
  }

  if (file.startsWith(".github/ISSUE_TEMPLATE/")) {
    selection.scopes.add("repository-config");
    if (file.endsWith("new-port.yml")) addNodeTest(selection, "scripts/roadmap.test.mjs");
    recognized = true;
  }

  if (file === ".github/dependabot.yml") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    recognized = true;
  }

  if (file === "renovate.json") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/dependency-automation.test.mjs");
    recognized = true;
  }

  if (file === ".github/release.yml") {
    selection.scopes.add("release-tooling");
    addNodeTest(selection, "scripts/release-workflow.test.mjs");
    addNodeTest(selection, "scripts/release-package-policy.test.mjs");
    recognized = true;
  }

  if (file === ".github/repository-ruleset.json" || file === ".github/repository-security.json") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/repository-settings.test.mjs");
    recognized = true;
  }

  for (const testFile of explicitNodeTests.get(file) ?? []) {
    selection.scopes.add("tooling");
    addNodeTest(selection, testFile);
    recognized = true;
  }

  if (
    file === "aqua.yaml" ||
    file === "aqua-checksums.json" ||
    file === ".aqua-version" ||
    file === ".config/tool-bootstrap.json" ||
    file === ".config/powershell-resources.psd1"
  ) {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/quality-tools.test.mjs");
    recognized = true;
  }

  if (
    file === ".editorconfig" ||
    file === ".oxfmtrc.json" ||
    file === ".oxlintrc.json" ||
    file === ".prettierignore" ||
    file === "prettier.config.mjs" ||
    file === "eslint.config.mjs" ||
    file === ".gitignore" ||
    file === ".gitattributes" ||
    file === ".git-blame-ignore-revs" ||
    file === ".node-version" ||
    file === ".rscheck.toml"
  ) {
    selection.scopes.add("repository-config");
    recognized = true;
  }

  if (file.startsWith(".vscode/")) {
    selection.scopes.add("repository-config");
    recognized = true;
  }

  if (file === ".oxlintrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.lintToolFixtures.add("oxlint");
    selection.scopes.add("ui");
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    recognized = true;
  }

  if (file === ".oxfmtrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.lintToolFixtures.add("oxfmt");
    selection.scopes.add("ui");
    recognized = true;
  }

  if (file === "hawk.toml" || file === "semdup.toml") {
    selection.scopes.add("repository-config");
    recognized = true;
  }

  if (file === "pyproject.toml") {
    selection.scopes.add("tooling");
    selection.pythonLint = true;
    recognized = true;
  }

  if (
    file.startsWith("docs/") ||
    extension === ".md" ||
    file === "LICENSE-APACHE" ||
    file === "LICENSE-MIT" ||
    file === "SECURITY.md" ||
    file === "CONTRIBUTING.md" ||
    file === "AGENTS.md"
  ) {
    selection.scopes.add("documentation");
    if (file.startsWith("docs/") || extension === ".md") {
      selection.scopes.add("tooling");
      addNodeTest(selection, "scripts/repository-skills.test.mjs");
    }
    recognized = true;
  }

  if (file.startsWith(".agents/skills/") && file.endsWith("/SKILL.md")) {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/repository-skills.test.mjs");
    recognized = true;
  }

  if (file.startsWith("integrations/playnite/")) {
    selection.scopes.add("playnite");
    selection.playnite = true;
    recognized = true;
  }

  if (file.startsWith("release/")) {
    selection.scopes.add("release-tooling");
    addNodeTest(selection, "scripts/release-package-policy.test.mjs");
    addNodeTest(selection, "scripts/check-release-metadata.test.mjs");
    recognized = true;
  }

  if (
    /(?:transport|schema)/i.test(file) &&
    (file.startsWith("crates/") || file.startsWith("apps/desktop/") || file.startsWith("scripts/"))
  ) {
    selection.scopes.add("transport");
    selection.transport = true;
    addNodeTest(selection, "scripts/check-transport-contract.test.mjs");
    addNodeTest(selection, "scripts/check-transport-contract.integration.test.mjs");
    addNodeTest(selection, "scripts/transport-types.test.mjs");
    recognized = true;
  }

  if (!recognized) selection.unknown.add(file);
}

function packageForPath(input) {
  const file = normalizePath(input);
  for (const [prefix, packageName] of packagePrefixes)
    if (file.startsWith(prefix)) return packageName;
  return null;
}

export function classifyChanges(changes, options = {}) {
  const fileExists = options.fileExists ?? ((file) => existsSync(path.join(projectRoot, file)));
  const selection = {
    scopes: new Set(),
    packages: new Set(),
    nodeTests: new Set(),
    nodeSyntax: new Set(),
    oxfmtFiles: new Set(),
    uiRelatedFiles: new Set(),
    lintToolFixtures: new Set(),
    unknown: new Set(),
    rustfmt: false,
    workspaceRust: false,
    ui: false,
    uiFullTests: false,
    oxlint: false,
    stylelint: false,
    actionsLint: false,
    powershellLint: false,
    shellLint: false,
    pythonLint: false,
    fallow: false,
    playnite: false,
    transport: false,
    rustChanges: [],
  };
  for (const change of changes) {
    classifyOnePath(selection, change.path, fileExists, {
      includeFileChecks: change.status !== "D",
    });
    if (change.previousPath)
      classifyOnePath(selection, change.previousPath, fileExists, {
        includeFileChecks: false,
      });
    const currentPackage = packageForPath(change.path);
    if (currentPackage) selection.rustChanges.push({ ...change, packageName: currentPackage });
    const previousPackage = change.previousPath ? packageForPath(change.previousPath) : null;
    if (previousPackage && previousPackage !== currentPackage)
      selection.rustChanges.push({
        status: change.status,
        path: change.previousPath,
        previousPath: change.path,
        packageName: previousPackage,
      });
  }
  return selection;
}

function sorted(set) {
  return [...set].sort((left, right) => left.localeCompare(right));
}

function nodeTestCommand(files) {
  return command(
    "node-tests",
    "exact repository-tool contract tests selected from changed paths",
    process.execPath,
    ["--test", "--test-timeout=30000", `--test-reporter=${durationReporter}`, ...files],
  );
}

function uiRelatedCommand(files) {
  return corepackCommand(
    "ui-related-tests",
    "Vitest import-graph tests related to changed UI sources",
    [
      "pnpm",
      "exec",
      "vitest",
      "related",
      ...files.map((file) => path.join(projectRoot, file)),
      "--run",
      "--pool=threads",
      "--isolate",
      "--maxWorkers=2",
      "--testTimeout=5000",
      "--passWithNoTests",
      "--reporter=default",
      "--reporter=json",
      "--outputFile=../../work/ui-related-tests.json",
    ],
    { cwd: desktopRoot },
  );
}

function uiRelatedDurationCommand() {
  return command(
    "ui-related-durations",
    "validate complete timing data for the related UI selection",
    process.execPath,
    ["scripts/check-vitest-durations.mjs", "work/ui-related-tests.json", "--allow-empty"],
  );
}

export function buildPlan(selection, context = {}) {
  if (selection.unknown.size) {
    throw new Error(
      `local validation has no selection rule for:\n${sorted(selection.unknown)
        .map((file) => `- ${file}`)
        .join(
          "\n",
        )}\nAdd and test a focused rule; the required hosted plan must not be replaced by silent local success.`,
    );
  }
  const mergeBase = context.mergeBase ?? "<merge-base>";
  const commands = [
    command("diff-check", "reject whitespace errors across the complete local change", "git", [
      "diff",
      "--check",
      mergeBase,
    ]),
  ];

  const existingOxfmtFiles = sorted(selection.oxfmtFiles).filter((file) =>
    existsSync(path.join(projectRoot, file)),
  );
  if (existingOxfmtFiles.length) {
    const targets = existingOxfmtFiles.includes(".oxfmtrc.json")
      ? []
      : existingOxfmtFiles.map((file) => path.join(projectRoot, file));
    commands.push(
      command("oxfmt", "format-check changed supported files only", process.execPath, [
        "scripts/run-oxfmt.mjs",
        "--check",
        ...targets,
      ]),
    );
  }
  if (selection.toml) {
    commands.push(
      corepackCommand(
        "toml-format",
        "verify the repository-owned TOML inventory",
        ["pnpm", "run", "format:toml:check"],
        { cwd: desktopRoot },
      ),
    );
  }
  if (selection.rustfmt) {
    commands.push(
      command("rustfmt", "Rust formatting is workspace-coherent and inexpensive", "cargo", [
        "fmt",
        "--all",
        "--",
        "--check",
      ]),
    );
  }
  for (const file of sorted(selection.nodeSyntax)) {
    if (existsSync(path.join(projectRoot, file))) {
      commands.push(
        command(
          `node-syntax:${file}`,
          "syntax-check a changed Node implementation",
          process.execPath,
          ["--check", file],
        ),
      );
    }
  }
  if (selection.oxlint) {
    commands.push(
      corepackCommand(
        "oxlint",
        "lint changed repository JavaScript with the complete Oxc contract",
        ["pnpm", "run", "lint:oxlint"],
        { cwd: desktopRoot, obligation: "repository-oxlint" },
      ),
    );
  }
  if (selection.nodeTests.size) commands.push(nodeTestCommand(sorted(selection.nodeTests)));

  if (selection.lintToolFixtures.size)
    commands.push(
      command(
        "lint-tool-fixtures",
        "prove changed lint tooling accepts and rejects the maintained fixtures",
        process.execPath,
        ["scripts/lint-tools.integration.mjs", ...sorted(selection.lintToolFixtures)],
      ),
    );

  if (selection.actionsLint)
    commands.push(
      command(
        "actionlint",
        "lint changed hosted automation with the pinned wrapper",
        process.execPath,
        ["scripts/run-actionlint.mjs"],
      ),
    );
  if (selection.powershellLint)
    commands.push(
      command(
        "powershell-lint",
        "lint PowerShell through the repository wrapper",
        process.execPath,
        ["scripts/run-powershell-lint.mjs"],
      ),
    );
  if (selection.shellLint)
    commands.push(
      command("shell-lint", "lint the maintained shell scripts", "aqua", [
        "exec",
        "--",
        "shellcheck",
        "--severity=warning",
        "scripts/bootstrap-quality-tools.sh",
        "scripts/install-linux-desktop-prerequisites.sh",
        "scripts/test-linux-package-ownership.sh",
      ]),
    );
  if (selection.pythonLint)
    commands.push(
      command("python-lint", "lint the repository's maintained Python asset tools", "aqua", [
        "exec",
        "--",
        "ruff",
        "check",
        "apps/desktop/assets/brand/models/v2",
      ]),
    );

  if (selection.workspaceRust) {
    commands.push(
      heavyRustCommand(
        "rust-workspace-clippy",
        "root dependency or toolchain change compiles and lints every workspace target",
        "cargo",
        ["clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ),
      command(
        "dependency-policy",
        "root dependency changes retain license, source, and advisory policy",
        "cargo",
        ["deny", "check", "--hide-inclusion-graph", "-W", "unmaintained"],
      ),
      command(
        "rust-workspace-tests",
        "root dependency or toolchain changes use the documented broad workspace fallback",
        process.execPath,
        ["scripts/run-rust-tests.mjs", "--locked", "--workspace"],
      ),
    );
  } else {
    const doctestPackages = context.doctestPackages ?? new Set();
    let rustTestImpactMap = context.rustTestImpactMap;
    let rustTestImpactLoadError = context.rustTestImpactLoadError;
    if (!Object.hasOwn(context, "rustTestImpactMap")) {
      try {
        rustTestImpactMap = readRustTestImpactMap();
      } catch (error) {
        rustTestImpactMap = null;
        rustTestImpactLoadError = error.message;
      }
    }
    for (const packageName of sorted(selection.packages)) {
      const impact = selectRustTestImpact(
        rustTestImpactMap,
        packageName,
        selection.rustChanges.filter((change) => change.packageName === packageName),
      );
      if (rustTestImpactLoadError) impact.reason = `${impact.reason}; ${rustTestImpactLoadError}`;
      commands.push(
        heavyRustCommand(
          `rust-clippy:${packageName}`,
          `compile and lint every target in affected package ${packageName}`,
          "cargo",
          ["clippy", "--locked", "-p", packageName, "--all-targets", "--", "-D", "warnings"],
        ),
      );
      if (impact.mode === "broad")
        commands.push(
          command(`rust-tests:${packageName}`, impact.reason, process.execPath, [
            "scripts/run-rust-tests.mjs",
            "--locked",
            "-p",
            packageName,
          ]),
        );
      else if (impact.groups.length > 1)
        commands.push(
          command(
            `rust-tests:${packageName}:union`,
            impact.groups.map((group) => `${group.id}: ${group.reason}`).join("; "),
            process.execPath,
            [
              "scripts/run-rust-tests.mjs",
              "--impact-union",
              packageName,
              ...impact.groups.map((group) => group.id),
            ],
          ),
        );
      else
        for (const group of impact.groups)
          commands.push(
            command(
              `rust-tests:${packageName}:${group.id}`,
              `${group.reason}; ${impact.reason}`,
              process.execPath,
              ["scripts/run-rust-tests.mjs", "--locked", "-p", packageName, "-E", group.filter],
            ),
          );
      if (doctestPackages.has(packageName))
        commands.push(
          heavyRustCommand(
            `rust-docs:${packageName}`,
            `run documentation tests for affected package ${packageName}`,
            "cargo",
            ["test", "--locked", "-p", packageName, "--doc"],
          ),
        );
    }
  }

  if (selection.ui) {
    commands.push(
      corepackCommand(
        "ui-build",
        "type-check and build the affected frontend",
        ["pnpm", "run", "build"],
        { cwd: desktopRoot },
      ),
      corepackCommand(
        "ui-oxlint",
        "run the repository's typed frontend lint contract",
        ["pnpm", "run", "lint:oxlint"],
        { cwd: desktopRoot, obligation: "repository-oxlint" },
      ),
    );
    if (selection.stylelint)
      commands.push(
        corepackCommand(
          "ui-stylelint",
          "lint the changed stylesheet contract",
          ["pnpm", "run", "lint:style"],
          { cwd: desktopRoot },
        ),
      );
    if (selection.uiFullTests)
      commands.push(
        corepackCommand(
          "ui-tests",
          "frontend configuration changes require the complete small UI suite",
          ["pnpm", "run", "test"],
          { cwd: desktopRoot },
        ),
      );
    else if (selection.uiRelatedFiles.size)
      commands.push(uiRelatedCommand(sorted(selection.uiRelatedFiles)), uiRelatedDurationCommand());
    if (!selection.uiFullTests)
      commands.push(
        corepackCommand(
          "ui-theme-copy",
          "retain theme and player-facing copy validation",
          ["pnpm", "run", "test:theme"],
          { cwd: desktopRoot },
        ),
        command(
          "ui-copy",
          "retain player-facing copy validation",
          process.execPath,
          ["scripts/check-copy.mjs"],
          { cwd: desktopRoot },
        ),
      );
  }

  if (selection.fallow)
    commands.push(
      command(
        "fallow",
        "run the quality report governed by the changed Fallow configuration",
        process.execPath,
        ["scripts/run-fallow.mjs"],
      ),
    );

  if (selection.transport) {
    commands.push(
      command(
        "transport-export",
        "compare generated declarations with the live Rust schema export",
        process.execPath,
        ["apps/desktop/scripts/generate-transport-types.mjs"],
      ),
      command(
        "transport-policy",
        "verify shared child-process and transport policy",
        process.execPath,
        ["scripts/check-transport-contract.mjs"],
      ),
    );
  }

  if (selection.playnite)
    commands.push(
      command(
        "playnite-contract",
        "build and test the affected external reference client",
        "pwsh",
        ["-NoProfile", "-File", "integrations/playnite/check.ps1"],
      ),
    );

  return deduplicateCommands(commands);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: options.encoding === "buffer" ? null : (options.encoding ?? "utf8"),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  return result.stdout;
}

export function parseNameStatus(buffer) {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++];
    let embeddedPath = null;
    if (status.includes("\t")) {
      [status, embeddedPath] = status.split("\t", 2);
    }
    if (!status) throw new Error("empty git name-status record");
    if (/^[RC]/.test(status)) {
      const previousPath = embeddedPath ?? tokens[index++];
      const currentPath = tokens[index++];
      if (!previousPath || !currentPath)
        throw new Error(`incomplete git rename/copy record: ${status}`);
      changes.push({ status, path: currentPath, previousPath });
    } else {
      const currentPath = embeddedPath ?? tokens[index++];
      if (!currentPath) throw new Error(`incomplete git change record: ${status}`);
      changes.push({ status, path: currentPath });
    }
  }
  return changes;
}

export function localChangesFromRaw(buffer) {
  return parseRawDiff(buffer).map((change) => ({
    status: change.status,
    path: change.newPath,
    previousPath: change.oldPath === change.newPath ? undefined : change.oldPath,
    oldMode: change.oldMode,
    newMode: change.newMode,
  }));
}

export function readChangeContext(base = "origin/main") {
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const mergeBase = git(["merge-base", "HEAD", baseSha]).trim();
  const tracked = localChangesFromRaw(
    git(["diff", "--raw", "-z", "--find-renames", mergeBase], {
      encoding: "buffer",
    }),
  );
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => ({
      status: "?",
      path: file,
      oldMode: "000000",
      newMode: lstatSync(path.join(projectRoot, file)).isSymbolicLink() ? "120000" : "100644",
    }));
  return {
    base,
    baseSha,
    headSha,
    mergeBase,
    changes: [...tracked, ...untracked],
  };
}

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

export function formatCommand(entry) {
  return [entry.executable, ...entry.args].map(quote).join(" ");
}

function printPlan(context, selection, plan, validationPlan) {
  console.log("# Focused local validation");
  console.log(`Base: ${context.base} (${context.baseSha})`);
  console.log(`Merge base: ${context.mergeBase}`);
  console.log(`Head: ${context.headSha}`);
  console.log(`Changed paths: ${context.changes.length}`);
  console.log(`Scopes: ${sorted(selection.scopes).join(", ") || "none"}`);
  console.log(`Validation plan: ${validationPlan.mode} (${validationPlan.digest})`);
  console.log(`Validation groups: ${validationPlan.groups.join(", ") || "none"}`);
  console.log(`Qualification required: ${validationPlan.qualification_required}`);
  for (const change of context.changes) {
    const rename = change.previousPath ? ` <- ${change.previousPath}` : "";
    console.log(`- ${change.status} ${change.path}${rename}`);
  }
  console.log("Commands:");
  for (const entry of plan) {
    console.log(`- ${entry.id}: ${entry.reason}`);
    console.log(`  ${formatCommand(entry)}`);
  }
}

export function executePlan(plan, options = {}) {
  const spawn = options.spawn ?? spawnCommand;
  const started = Date.now();
  const timings = [];
  for (const entry of plan) {
    console.log(`\n[local-check] ${entry.id}: ${entry.reason}`);
    const stageStarted = Date.now();
    const result = spawn(entry.executable, entry.args, {
      cwd: entry.cwd,
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    });
    const elapsedMs = Date.now() - stageStarted;
    timings.push({ id: entry.id, elapsedMs });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${entry.id} failed with exit code ${result.status ?? "unknown"}`);
    console.log(`[local-check] ${entry.id} passed in ${(elapsedMs / 1000).toFixed(1)}s`);
  }
  return { elapsedMs: Date.now() - started, timings };
}

function localStageDomains(entry) {
  if (entry.id === "diff-check") return [];
  if (["oxfmt", "toml-format"].includes(entry.id)) return ["format"];
  if (entry.id === "rustfmt" || entry.id === "dependency-policy" || entry.id.startsWith("rust-"))
    return ["rust"];
  if (entry.id.startsWith("ui-")) return ["ui"];
  if (
    [
      "actionlint",
      "lint-tool-fixtures",
      "oxlint",
      "powershell-lint",
      "python-lint",
      "shell-lint",
    ].includes(entry.id)
  )
    return ["lint"];
  if (["transport-export", "transport-policy"].includes(entry.id))
    return ["repository", "rust", "ui"];
  if (entry.id === "playnite-contract") return ["repository"];
  if (entry.id === "fallow") return ["ui"];
  if (entry.id === "node-tests") {
    const domains = new Set();
    for (const file of entry.args.filter((argument) => argument.endsWith(".test.mjs"))) {
      for (const domain of domainsForPath(file).domains) domains.add(domain);
    }
    return [...domains].sort();
  }
  if (entry.id.startsWith("node-syntax:")) {
    const file = entry.args.at(-1);
    return file ? [...domainsForPath(file).domains].sort() : [];
  }
  return [];
}

function localStageReusable(entry) {
  return (
    localStageDomains(entry).length > 0 &&
    entry.id !== "dependency-policy" &&
    entry.id !== "ui-related-durations"
  );
}

export function fingerprintLocalStage(entry, inventory, runtime) {
  const recipe = JSON.stringify({
    obligation: entry.obligation,
    executable: entry.executable === process.execPath ? "<active-node-runtime>" : entry.executable,
    args: entry.args,
    cwd: path.relative(projectRoot, entry.cwd).replaceAll("\\", "/") || ".",
  });
  const domainFingerprints = localStageDomains(entry).map((domain) =>
    fingerprintStage({ id: entry.id, recipe, domain }, inventory, runtime),
  );
  return createHash("sha256").update(JSON.stringify(domainFingerprints)).digest("hex");
}

function localReceiptPath(receiptRoot, entry, fingerprint) {
  const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return path.join(receiptRoot, "local", safeId, `${fingerprint}.json`);
}

function readLocalReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeLocalReceipt(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

export function executePlanWithReceipts(plan, options = {}) {
  const spawn = options.spawn ?? spawnCommand;
  const root = options.root ?? projectRoot;
  const inventory = options.inventory ?? repositoryInventory(root);
  const runtime = options.runtime ?? auditRuntime(root);
  const receiptRoot = options.receiptRoot ?? path.join(root, "work", "validation-receipts");
  const fresh = options.fresh ?? false;
  const started = Date.now();
  const timings = [];
  for (const entry of plan) {
    const reusable = localStageReusable(entry);
    const fingerprint = reusable ? fingerprintLocalStage(entry, inventory, runtime) : null;
    const receiptPath = reusable ? localReceiptPath(receiptRoot, entry, fingerprint) : null;
    const validation =
      reusable && !fresh
        ? validateReceipt(readLocalReceipt(receiptPath), {
            stageId: `local:${entry.id}`,
            fingerprint,
          })
        : { valid: false, reason: fresh ? "fresh execution required" : "stage is not reusable" };
    if (validation.valid) {
      console.log(
        `\n[local-check] ${entry.id}: reused matching successful receipt from ${validation.payload.originatingHead}`,
      );
      timings.push({ id: entry.id, elapsedMs: 0, status: "reused" });
      continue;
    }

    if (receiptPath) rmSync(receiptPath, { force: true });
    console.log(`\n[local-check] ${entry.id}: ${entry.reason}`);
    const stageStarted = Date.now();
    const result = spawn(entry.executable, entry.args, {
      cwd: entry.cwd,
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    });
    const elapsedMs = Date.now() - stageStarted;
    timings.push({ id: entry.id, elapsedMs, status: "executed" });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${entry.id} failed with exit code ${result.status ?? "unknown"}`);
    if (receiptPath)
      writeLocalReceipt(
        receiptPath,
        receiptEnvelope({
          format: 1,
          kind: "successful-stage",
          success: true,
          stageId: `local:${entry.id}`,
          fingerprint,
          originatingHead: inventory.head,
          completedAt: new Date().toISOString(),
        }),
      );
    console.log(`[local-check] ${entry.id} passed in ${(elapsedMs / 1000).toFixed(1)}s`);
  }
  return { elapsedMs: Date.now() - started, timings };
}

export function requireFocusedArguments(kind, args) {
  const hasSelection =
    kind === "test-node"
      ? args.some((value) => /\.(?:test|integration\.test)\.(?:mjs|cjs|js)$/.test(value))
      : kind === "test-ui-related"
        ? args.some((value) => /\.(?:[cm]?[jt]sx?|css)$/.test(value))
        : args.some((value) => !value.startsWith("-"));
  if (!args.length || !hasSelection)
    throw new Error(`${kind} requires an explicit package, filter, or test path`);
}

function runFocusedCommand(kind, args) {
  requireFocusedArguments(kind, args);
  let plan;
  if (kind === "test-rust") {
    plan = [
      command(kind, "explicitly focused Rust test selection", process.execPath, [
        "scripts/run-rust-tests.mjs",
        "--locked",
        ...args,
      ]),
    ];
  } else if (kind === "test-ui-related") {
    plan = [uiRelatedCommand(args.map(normalizePath)), uiRelatedDurationCommand()];
  } else if (kind === "test-node") {
    plan = [nodeTestCommand(args)];
  } else {
    throw new Error(`unknown focused command: ${kind}`);
  }
  executePlan(plan);
}

function parseCheckArgs(args) {
  let base = "origin/main";
  let planOnly = false;
  let fresh = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--plan") planOnly = true;
    else if (value === "--fresh") fresh = true;
    else if (value === "--base") {
      base = args[++index];
      if (!base) throw new Error("--base requires a Git revision");
    } else throw new Error(`unknown local-check option: ${value}`);
  }
  return { base, planOnly, fresh };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log(
      "usage: local-validation.mjs [check [--base REV] [--plan] [--fresh]|test-rust ARGS|test-ui-related FILES|test-node TESTS]",
    );
    return;
  }
  const [kind = "check", ...args] = argv;
  if (["test-rust", "test-ui-related", "test-node"].includes(kind)) {
    runFocusedCommand(kind, args);
    return;
  }
  if (kind !== "check") throw new Error(`unknown local validation command: ${kind}`);
  const { base, planOnly, fresh } = parseCheckArgs(args);
  const context = readChangeContext(base);
  const validationPlan = validateValidationPlan(
    buildValidationPlan({
      changes: context.changes.map((change) => ({
        status: change.status,
        oldMode: change.oldMode,
        newMode: change.newMode,
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
      })),
      eventName: "pull_request",
      base: context.baseSha,
      mergeBase: context.mergeBase,
      head: context.headSha,
      checkout: context.headSha,
    }),
  );
  const selection = classifyChanges(context.changes);
  const planContext =
    selection.packages.size > 0 && !selection.workspaceRust
      ? { ...context, doctestPackages: readDoctestPackages() }
      : context;
  const plan = buildPlan(selection, planContext);
  printPlan(context, selection, plan, validationPlan);
  if (planOnly) return;
  const result = executePlanWithReceipts(plan, { fresh });
  console.log(`\nFocused local validation passed in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  if (result.elapsedMs > 120_000)
    console.warn(
      "Warm local validation exceeded the two-minute agility target; inspect the stage timings above without weakening checks.",
    );
  console.log(
    "The selected hosted validation plan remains mandatory in GitHub CI on the exact pull-request head.",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
