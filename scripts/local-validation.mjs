import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const durationReporter = "./scripts/test-duration-reporter.mjs";
const corepackEntrypoint = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "corepack",
  "dist",
  "corepack.js",
);

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
  ["scripts/check-vitest-durations.mjs", ["scripts/test-duration-reporter.test.mjs"]],
  [
    "apps/desktop/scripts/desktop-test.mjs",
    [
      "scripts/desktop-scenarios.test.mjs",
      "scripts/development-evidence.test.mjs",
      "scripts/native-session-lock.test.mjs",
    ],
  ],
  ["apps/desktop/scripts/desktop-preparation-test.mjs", ["scripts/desktop-scenarios.test.mjs"]],
  [".github/quality-tools.json", ["scripts/quality-tools.test.mjs"]],
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
    "justfile",
    [
      "scripts/local-validation.test.mjs",
      "scripts/dev-storage.test.mjs",
      "scripts/ci-workflow.test.mjs",
    ],
  ],
  [".oxfmtrc.json", ["scripts/local-validation.test.mjs", "scripts/ci-workflow.test.mjs"]],
  ["taplo.toml", ["scripts/local-validation.test.mjs"]],
]);

const workflowTests = new Map([
  ["release.yml", ["scripts/release-workflow.test.mjs"]],
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
  "scripts/generate-release-downloads.test.mjs",
  "scripts/select-release-channel.test.mjs",
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
  return { id, reason, executable, args, cwd: options.cwd ?? projectRoot };
}

function corepackCommand(id, reason, args, options = {}) {
  return process.platform === "win32"
    ? command(id, reason, process.execPath, [corepackEntrypoint, ...args], options)
    : command(id, reason, "corepack", args, options);
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
    /^apps\/desktop\/(?:index\.html|package\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|eslint\.config\.mjs|stylelint\.config\.mjs)$/.test(
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

  if (file === "apps/desktop/pnpm-workspace.yaml") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    recognized = true;
  }

  if (file.startsWith("scripts/")) {
    selection.scopes.add("tooling");
    recognized = true;
    if (/\.(?:mjs|cjs|js)$/.test(file)) {
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
    if (
      /(?:release|updater|package|installer|qualification|checksum|channel)/iu.test(
        path.posix.basename(file),
      )
    ) {
      selection.scopes.add("release-tooling");
      for (const testFile of releaseContractTests) addNodeTest(selection, testFile);
      addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    }
  }

  if (file.startsWith(".github/workflows/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    for (const testFile of workflowTests.get(path.posix.basename(file)) ?? [])
      addNodeTest(selection, testFile);
    recognized = true;
  }

  if (file.startsWith(".github/actions/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
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
    selection.oxcFixtures.add("oxlint");
    selection.scopes.add("ui");
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    recognized = true;
  }

  if (file === ".oxfmtrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.oxcFixtures.add("oxfmt");
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

export function classifyChanges(changes, options = {}) {
  const fileExists = options.fileExists ?? ((file) => existsSync(path.join(projectRoot, file)));
  const selection = {
    scopes: new Set(),
    packages: new Set(),
    nodeTests: new Set(),
    nodeSyntax: new Set(),
    oxfmtFiles: new Set(),
    uiRelatedFiles: new Set(),
    oxcFixtures: new Set(),
    unknown: new Set(),
    rustfmt: false,
    workspaceRust: false,
    ui: false,
    uiFullTests: false,
    stylelint: false,
    actionsLint: false,
    powershellLint: false,
    shellLint: false,
    pythonLint: false,
    fallow: false,
    playnite: false,
    transport: false,
  };
  for (const change of changes) {
    classifyOnePath(selection, change.path, fileExists, {
      includeFileChecks: change.status !== "D",
    });
    if (change.previousPath)
      classifyOnePath(selection, change.previousPath, fileExists, {
        includeFileChecks: false,
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
        )}\nAdd and test a focused rule; exhaustive CI must not be replaced by silent local success.`,
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
  if (selection.nodeTests.size) commands.push(nodeTestCommand(sorted(selection.nodeTests)));

  if (selection.oxcFixtures.size)
    commands.push(
      command(
        "oxc-fixtures",
        "prove changed Oxc configuration accepts and rejects the maintained fixtures",
        process.execPath,
        ["scripts/lint-tools.integration.mjs", ...sorted(selection.oxcFixtures)],
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
      command(
        "rust-workspace-check",
        "root dependency or toolchain change compiles every workspace target",
        "cargo",
        ["check", "--locked", "--workspace", "--all-targets"],
      ),
      command(
        "rust-workspace-clippy",
        "root dependency or toolchain change lints every workspace target",
        "cargo",
        ["clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ),
      command(
        "dependency-policy",
        "root dependency changes retain license, source, and advisory policy",
        "cargo",
        ["deny", "check", "--hide-inclusion-graph", "-W", "unmaintained"],
      ),
    );
  } else {
    const doctestPackages = context.doctestPackages ?? new Set();
    for (const packageName of sorted(selection.packages)) {
      commands.push(
        command(
          `rust-check:${packageName}`,
          `compile every target in affected package ${packageName}`,
          "cargo",
          ["check", "--locked", "-p", packageName, "--all-targets"],
        ),
        command(
          `rust-clippy:${packageName}`,
          `lint every target in affected package ${packageName}`,
          "cargo",
          ["clippy", "--locked", "-p", packageName, "--all-targets", "--", "-D", "warnings"],
        ),
        command(
          `rust-tests:${packageName}`,
          `run the affected package ${packageName} without unrelated packages`,
          process.execPath,
          ["scripts/run-rust-tests.mjs", "--locked", "-p", packageName],
        ),
      );
      if (doctestPackages.has(packageName))
        commands.push(
          command(
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
        { cwd: desktopRoot },
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

  const unique = [];
  const ids = new Set();
  for (const entry of commands) {
    if (!ids.has(entry.id)) {
      ids.add(entry.id);
      unique.push(entry);
    }
  }
  return unique;
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

export function readChangeContext(base = "origin/main") {
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const mergeBase = git(["merge-base", "HEAD", baseSha]).trim();
  const tracked = parseNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", mergeBase], {
      encoding: "buffer",
    }),
  );
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ status: "?", path: file }));
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

function printPlan(context, selection, plan) {
  console.log("# Focused local validation");
  console.log(`Base: ${context.base} (${context.baseSha})`);
  console.log(`Merge base: ${context.mergeBase}`);
  console.log(`Head: ${context.headSha}`);
  console.log(`Changed paths: ${context.changes.length}`);
  console.log(`Scopes: ${sorted(selection.scopes).join(", ") || "none"}`);
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
  const spawn = options.spawn ?? spawnSync;
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
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--plan") planOnly = true;
    else if (value === "--base") {
      base = args[++index];
      if (!base) throw new Error("--base requires a Git revision");
    } else throw new Error(`unknown local-check option: ${value}`);
  }
  return { base, planOnly };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log(
      "usage: local-validation.mjs [check [--base REV] [--plan]|test-rust ARGS|test-ui-related FILES|test-node TESTS]",
    );
    return;
  }
  const [kind = "check", ...args] = argv;
  if (["test-rust", "test-ui-related", "test-node"].includes(kind)) {
    runFocusedCommand(kind, args);
    return;
  }
  if (kind !== "check") throw new Error(`unknown local validation command: ${kind}`);
  const { base, planOnly } = parseCheckArgs(args);
  const context = readChangeContext(base);
  const selection = classifyChanges(context.changes);
  const planContext =
    selection.packages.size > 0 && !selection.workspaceRust
      ? { ...context, doctestPackages: readDoctestPackages() }
      : context;
  const plan = buildPlan(selection, planContext);
  printPlan(context, selection, plan);
  if (planOnly) return;
  const result = executePlan(plan);
  console.log(`\nFocused local validation passed in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  if (result.elapsedMs > 120_000)
    console.warn(
      "Warm local validation exceeded the two-minute agility target; inspect the stage timings above without weakening checks.",
    );
  console.log(
    "The exhaustive cross-platform suite remains mandatory in GitHub CI on the exact pull-request head.",
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
