import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationPlan, validationOwnershipForPath } from "./validation-plan.mjs";
import { selectWorkspaceRustImpact } from "./rust-test-impact.mjs";
import { hasNextestEquivalence } from "./nextest-equivalence.mjs";
import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
} from "./native-helper-dependencies.mjs";
import { ordinaryOwnershipForPath } from "./validation-plan.mjs";
import { spawnCommand } from "./dev-storage.mjs";
export function isRepositoryLintInput(file) {
  return (
    /^(?:scripts|apps\/desktop\/(?:scripts|src))\/.*\.(?:[cm]?[jt]sx?)$/u.test(file) ||
    /^apps\/desktop\/src\/.*\.css$/u.test(file) ||
    /^apps\/desktop\/(?:vite\.config\.ts|(?:.*\/)?tsconfig[^/]*\.json|stylelint\.config\.mjs)$/u.test(
      file,
    ) ||
    /^(?:apps\/desktop\/)?(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/u.test(
      file,
    ) ||
    [
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      ".gitignore",
      ".node-version",
    ].includes(file)
  );
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
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

const metadataObservations = new WeakMap();
const metadataErrorCode = (error) => {
  try {
    const code = error?.code;
    return ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "E2BIG", "EIO"].includes(code)
      ? code
      : code === undefined
        ? null
        : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
};
export function readDoctestPackages(options = {}) {
  const started = performance.now();
  const result = (options.spawn ?? spawnSync)(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      ...(options.observeOnly ? ["--offline", "--locked"] : []),
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.observeOnly ? 15_000 : undefined,
      env: options.observeOnly
        ? { ...process.env, RUSTUP_AUTO_INSTALL: "0", CARGO_NET_OFFLINE: "true" }
        : process.env,
    },
  );
  const refuse = (reason, error) => {
    try {
      if (options.observeOnly) {
        const fingerprint = (value) =>
          typeof value === "string"
            ? {
                bytes: Buffer.byteLength(value),
                sha256: createHash("sha256").update(value).digest("hex"),
              }
            : null;
        metadataObservations.set(error, {
          reason,
          code: metadataErrorCode(error),
          status: Number.isInteger(result.status) ? result.status : null,
          signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"].includes(result.signal)
            ? result.signal
            : result.signal == null
              ? null
              : "UNKNOWN",
          elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
          observe_only: true,
          offline: true,
          locked: true,
          timeout_ms: 15_000,
          capture_complete:
            !result.error && Number.isInteger(result.status) && result.signal == null,
          stdout: fingerprint(result.stdout),
          stderr: fingerprint(result.stderr),
        });
      }
    } catch {
      /* Diagnostic failure must preserve the original planning error. */
    }
    throw error;
  };
  if (result.error) refuse("spawn-error", result.error);
  if (result.status !== 0)
    refuse("cargo-exit", new Error(`cargo metadata failed: ${result.stderr.trim()}`));
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    refuse("metadata-json", error);
  }
  try {
    return packagesWithDoctests(metadata);
  } catch (error) {
    refuse("package-inventory", error);
  }
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
  ".toml",
  ".yaml",
  ".yml",
]);

// Exact containment inputs share admission, registration, source-cache and
// descendant-closure consumers. Helper-only edits must exercise those contracts.
const containmentContractTests = [
  "scripts/heavy-rust-test-lock.test.mjs",
  "scripts/run-rust-tests.test.mjs",
  "scripts/rust-support-cache.test.mjs",
  "scripts/rust-test-tree-supervisor.test.mjs",
];
const containmentInputs = new Set([
  ...containmentContractTests,
  ...containmentContractTests.map((file) => file.replace(".test.mjs", ".mjs")),
  "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
]);
const selectionContractTests = [
  "scripts/validation-plan.test.mjs",
  "scripts/local-validation.test.mjs",
  "scripts/audit.test.mjs",
  "scripts/select-ci-plan.test.mjs",
];

const explicitNodeTests = new Map([
  [
    "scripts/validation-evidence.mjs",
    [...selectionContractTests, "scripts/validation-evidence.test.mjs", "scripts/audit.test.mjs"],
  ],
  [".fallow-tooling.json", ["scripts/fallow-scope.test.mjs", "scripts/run-fallow.test.mjs"]],
  ...[
    "scripts/container-host.mjs",
    "scripts/container-build.mjs",
    "scripts/container-build-entry.mjs",
    "scripts/container-build-policy.mjs",
    "tools/containers/build/Dockerfile",
  ].map((file) => [
    file,
    ["scripts/container-browser.test.mjs", "scripts/container-build.test.mjs"],
  ]),
  ...[
    "scripts/container-browser.mjs",
    "scripts/container-entry.mjs",
    "scripts/container-source.mjs",
    "tools/containers/browser/Dockerfile",
  ].map((file) => [file, ["scripts/container-browser.test.mjs"]]),
  ...[...Object.keys(nativeHelperDependencies), nativeHelperRegistryPath].map((file) => [
    file,
    [
      "scripts/native-helper-dependencies.test.mjs",
      "scripts/native-confirmation.test.mjs",
      "scripts/desktop-execution-plan.test.mjs",
      "scripts/windows-helper-checks.test.mjs",
    ],
  ]),
  ...[
    "scripts/frontend-command-preflight.mjs",
    "apps/desktop/scripts/build-frontend.mjs",
    "scripts/viteplus-cli.mjs",
  ].map((file) => [
    file,
    [
      "scripts/frontend-command-preflight.test.mjs",
      "scripts/desktop-verify.test.mjs",
      "scripts/desktop-execution-plan.test.mjs",
      "scripts/windows-helper-checks.test.mjs",
    ],
  ]),
  [
    "scripts/desktop-execution-plan.test.mjs",
    ["scripts/desktop-scenarios.test.mjs", "scripts/desktop-verify.test.mjs"],
  ],
  ...[
    "scripts/desktop-execution-plan.mjs",
    "scripts/desktop-scenarios.mjs",
    "scripts/desktop-verify.mjs",
    "scripts/testdata/desktop-execution-baseline.json",
    "apps/desktop/scripts/desktop-owned-fixture-journeys.mjs",
    "apps/desktop/scripts/desktop-test.mjs",
  ].map((file) => [
    file,
    [
      "scripts/desktop-execution-plan.test.mjs",
      "scripts/desktop-scenarios.test.mjs",
      "scripts/desktop-verify.test.mjs",
      "scripts/frontend-command-preflight.test.mjs",
      "scripts/native-helper-dependencies.test.mjs",
      "scripts/windows-helper-checks.test.mjs",
    ],
  ]),
  ...[
    "scripts/validation-plan.mjs",
    "scripts/validation-plan.test.mjs",
    "scripts/local-validation.mjs",
    "scripts/ordinary-validation.mjs",
    "scripts/local-validation.test.mjs",
  ].map((file) => [file, selectionContractTests]),
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
  [
    "scripts/local-validation.mjs",
    [...selectionContractTests, "scripts/repository-settings.test.mjs"],
  ],
  [
    ".config/rust-test-impact.json",
    ["scripts/rust-test-impact.test.mjs", "scripts/local-validation.test.mjs"],
  ],
  [
    "scripts/ci-baseline.mjs",
    ["scripts/ci-baseline.test.mjs", "scripts/local-validation.test.mjs"],
  ],
  ["scripts/rust-test-impact.mjs", ["scripts/rust-test-impact.test.mjs"]],
  ["scripts/ui-test-selection.mjs", ["scripts/ui-test-selection.test.mjs"]],
  ["scripts/run-ui-tests.mjs", ["scripts/ui-test-selection.test.mjs"]],
  ["scripts/run-viteplus.mjs", ["scripts/frontend-command-preflight.test.mjs"]],
  ["scripts/pr-delivery.mjs", ["scripts/repository-skills.test.mjs"]],
  ["scripts/package-local.ps1", ["scripts/repository-skills.test.mjs"]],
  ["scripts/release-preflight.ps1", ["scripts/repository-skills.test.mjs"]],
  [
    "scripts/roadmap.mjs",
    ["scripts/repository-skills.test.mjs", "scripts/discovery-intake.test.mjs"],
  ],
  ["scripts/upstream-observer.mjs", ["scripts/discovery-checkpoint.test.mjs"]],
  ["scripts/observe-configured-upstream.mjs", ["scripts/discovery-checkpoint.test.mjs"]],
  ["scripts/test-windows-installer.ps1", ["scripts/repository-skills.test.mjs"]],
  ["scripts/windows-qualification-session.ps1", ["scripts/repository-skills.test.mjs"]],
  [
    "crates/portcove-core/catalog/catalog-current-authoring.json",
    ["scripts/generate-catalog.test.mjs"],
  ],
  [
    "crates/portcove-core/catalog/catalog-schema1-fixture.json",
    ["scripts/migrate-catalog-schema2.test.mjs"],
  ],
  [
    "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
    ["scripts/migrate-catalog-schema2.test.mjs"],
  ],
  [
    "crates/portcove-core/catalog/catalog.json",
    ["scripts/generate-catalog.test.mjs", "scripts/repository-skills.test.mjs"],
  ],
  ["crates/portcove-core/src/catalog.rs", ["scripts/repository-skills.test.mjs"]],
  [
    "apps/desktop/scripts/desktop-test.mjs",
    [
      "scripts/desktop-execution-plan.test.mjs",
      "scripts/desktop-scenarios.test.mjs",
      "scripts/development-evidence.test.mjs",
      "scripts/native-session-lock.test.mjs",
    ],
  ],
  ["apps/desktop/scripts/desktop-preparation-test.mjs", ["scripts/desktop-scenarios.test.mjs"]],
  ["apps/desktop/scripts/desktop-default-cover-test.mjs", ["scripts/desktop-scenarios.test.mjs"]],
  ["apps/desktop/scripts/desktop-source-dialog-test.mjs", ["scripts/desktop-scenarios.test.mjs"]],
  [
    ".github/quality-tools.json",
    ["scripts/quality-tools.test.mjs", "scripts/dependency-automation.test.mjs"],
  ],
  [".node-version", ["scripts/dependency-automation.test.mjs"]],
  ["Cargo.toml", ["scripts/dependency-automation.test.mjs"]],
  ["rust-toolchain.toml", ["scripts/dependency-automation.test.mjs"]],
  [
    "package.json",
    [
      "scripts/ci-workflow.test.mjs",
      "scripts/dependency-automation.test.mjs",
      "scripts/dev-storage.test.mjs",
      "scripts/local-validation.test.mjs",
    ],
  ],
  ["pnpm-lock.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["pnpm-workspace.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["apps/desktop/pnpm-lock.yaml", ["scripts/dependency-automation.test.mjs"]],
  ["apps/desktop/pnpm-workspace.yaml", ["scripts/dependency-automation.test.mjs"]],
  [
    "apps/desktop/package.json",
    ["scripts/ci-workflow.test.mjs", "scripts/local-validation.test.mjs"],
  ],
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
  [".github/upstream-health-accounting.json", ["scripts/upstream-observer.test.mjs"]],
  [
    ".github/linux-beta-risk-706.json",
    ["scripts/linux-beta-risk-706.test.mjs", "scripts/validation-plan.test.mjs"],
  ],
  [
    ".github/qualification-coverage.json",
    ["scripts/qualification-coverage.test.mjs", "scripts/ci-workflow.test.mjs"],
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
  [
    "scripts/ordinary-validation.mjs",
    [...selectionContractTests, "scripts/validation-evidence.test.mjs"],
  ],
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
  "scripts/controller-canary.test.mjs",
  "scripts/check-release-metadata.test.mjs",
  "scripts/release-package-policy.test.mjs",
  "scripts/write-release-checksums.test.mjs",
  "scripts/updater-artifact-inventory.test.mjs",
  "scripts/reconcile-release-assets.test.mjs",
  "scripts/finalize-release-assets.test.mjs",
  "scripts/generate-release-downloads.test.mjs",
  "scripts/select-release-channel.test.mjs",
  "scripts/release-coordinator.test.mjs",
  "scripts/release-run-evidence.test.mjs",
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

export function command(id, reason, executable, args, options = {}) {
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

function frontendTask(id, reason, task) {
  return command(id, reason, process.execPath, ["scripts/run-viteplus.mjs", "run", task], {
    cwd: projectRoot,
  });
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
  if (isRepositoryLintInput(file)) selection.repositoryLint = true;
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === ".sh") {
    selection.shellLint = true;
    if (options.includeFileChecks ?? true) selection.shellFiles.add(file);
  }
  if (extension === ".py") {
    selection.pythonLint = true;
    if (options.includeFileChecks ?? true) selection.pythonFiles.add(file);
  }
  const includeFileChecks = options.includeFileChecks ?? true;
  let recognized = false;
  if (
    file.startsWith("apps/desktop/src/browser/") ||
    file.startsWith("apps/desktop/src/components/ui/") ||
    file.startsWith("apps/desktop/src/styles/") ||
    file.endsWith(".module.css") ||
    [
      "apps/desktop/scripts/browser-runtime.mjs",
      "apps/desktop/vitest.config.ts",
      "apps/desktop/vitest.browser.config.ts",
      "apps/desktop/vite.config.ts",
      "apps/desktop/package.json",
      "pnpm-lock.yaml",
      "apps/desktop/src/components/AdoptionModal.tsx",
      "apps/desktop/src/components/ui.tsx",
      "apps/desktop/src/features/installation/use-installation-planning.ts",
      "apps/desktop/src/shared/concurrency-state.ts",
      "apps/desktop/src/api.ts",
      "apps/desktop/src/styles/index.css",
      "apps/desktop/src/test-fixtures.ts",
      "apps/desktop/src/view-model.ts",
    ].includes(file)
  )
    selection.browser = true;

  if (includeFileChecks && oxfmtExtensions.has(extension)) {
    selection.oxfmtFiles.add(file);
  }
  if (options.isDeletion && extension === ".toml" && !file.includes("/")) {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/local-validation.test.mjs");
    addNodeTest(selection, "scripts/validation-plan.test.mjs");
    recognized = true;
  }

  if (options.isDeletion && file.startsWith(".github/") && extension === ".json") {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/ci-workflow.test.mjs");
    addNodeTest(selection, "scripts/validation-plan.test.mjs");
    addNodeTest(selection, "scripts/repository-settings.test.mjs");
    recognized = true;
  }

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
    (file === ".config/nextest.toml" && !options.nextestUnchanged)
  ) {
    selection.workspaceRust = true;
    if (file !== "Cargo.lock" || options.isDeletion) selection.workspaceRustTests = true;
    selection.rustfmt = true;
    selection.scopes.add("rust-workspace");
    recognized = true;
  }

  if (
    file.startsWith("apps/desktop/src/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("apps/desktop/test/") ||
    file.startsWith("apps/desktop/assets/") ||
    file.startsWith("apps/desktop/public/") ||
    file === "apps/desktop/.fallowrc.json" ||
    /^apps\/desktop\/(?:(?:index|scenarios)\.html|(?:components|package)\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|vitest(?:\.browser)?\.config\.ts|i18next(?:\.invalid)?\.config\.ts|eslint\.config\.mjs|stylelint\.config\.mjs)$/.test(
      file,
    )
  ) {
    selection.ui = true;
    selection.scopes.add("ui");
    recognized = true;
    if (
      file.startsWith("apps/desktop/src/") ||
      file.startsWith("apps/desktop/scripts/") ||
      file.startsWith("apps/desktop/test/")
    ) {
      if (options.isDeletion || !/\.(?:[cm]?[jt]sx?|css)$/u.test(file))
        selection.uiFullTests = true;
      else selection.uiRelatedFiles.add(file);
    } else {
      selection.uiFullTests = true;
    }
    if (extension === ".css") selection.stylelint = true;
    if (file === "apps/desktop/.fallowrc.json") {
      addNodeTest(selection, "scripts/check-fallow-report.test.mjs");
    }
  }

  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      "apps/desktop/pnpm-workspace.yaml",
      "scripts/browser-traces.ts",
      "scripts/viteplus-cli.mjs",
      "scripts/frontend-tests.ts",
      "scripts/run-ui-tests.mjs",
      "scripts/run-viteplus.mjs",
    ].includes(file)
  ) {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    recognized = true;
    if (["package.json", "pnpm-lock.yaml"].includes(file)) {
      addNodeTest(selection, "scripts/check-fallow-report.test.mjs");
    }
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
    if (containmentInputs.has(file))
      for (const testFile of containmentContractTests) addNodeTest(selection, testFile);
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

  if (file === ".config/nextest.toml" && options.nextestUnchanged) {
    recognized = true;
    addNodeTest(selection, "scripts/nextest-equivalence.test.mjs");
  }

  if (file.startsWith(".vite-hooks/") || file === "vite.config.ts") {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/precommit-check.test.mjs");
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
    addNodeTest(selection, "integrations/playnite/lifecycle-check.test.mjs");
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
    workspaceRustTests: false,
    ui: false,
    browser: false,
    uiFullTests: false,
    oxlint: false,
    repositoryLint: false,
    stylelint: false,
    actionsLint: false,
    powershellLint: false,
    shellLint: false,
    pythonLint: false,
    playnite: false,
    transport: false,
    shellFiles: new Set(),
    pythonFiles: new Set(),
    rustChanges: [],
  };
  for (const change of changes) {
    classifyOnePath(selection, change.path, fileExists, {
      includeFileChecks: change.status !== "D",
      isDeletion: change.status === "D",
      nextestUnchanged: hasNextestEquivalence({
        ...change,
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
      }),
    });
    if (change.previousPath)
      classifyOnePath(selection, change.previousPath, fileExists, {
        includeFileChecks: false,
        isDeletion: true,
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
  for (const change of changes) {
    for (const file of [change.path, change.previousPath].filter(Boolean)) {
      const owned = ordinaryOwnershipForPath(file);
      if (owned.groups.includes("frontend") && !selection.ui) {
        selection.ui = true;
        selection.uiFullTests = true;
      }
    }
  }
  return selection;
}

function sorted(set) {
  return [...set].sort((left, right) => left.localeCompare(right));
}

export function nodeTestCommand(files) {
  const serialWindowsQualification = [
    "scripts/updater-artifact-inventory.test.mjs",
    "scripts/windows-qualification-session.integration.test.mjs",
  ].every((file) => files.includes(file));
  return command(
    "node-tests",
    serialWindowsQualification
      ? "exact repository-tool contract tests selected from changed paths; serialize competing Windows package lifecycle fixtures"
      : "exact repository-tool contract tests selected from changed paths",
    process.execPath,
    [
      "--test",
      "--test-timeout=30000",
      `--test-reporter=${durationReporter}`,
      ...(serialWindowsQualification ? ["--test-concurrency=1"] : []),
      ...files,
    ],
  );
}

export function uiRelatedCommand(files) {
  return command(
    "ui-related-tests",
    "bundled Vitest import-graph tests across maintained projects",
    process.execPath,
    [
      "scripts/run-ui-tests.mjs",
      "related",
      ...files.map((file) => path.resolve(projectRoot, file)),
    ],
    { cwd: projectRoot },
  );
}

export function buildPlan(selection, context = {}) {
  const validation = context.validationPlan;
  if (validation) validateValidationPlan(validation);
  if (validation?.mode === "blocked")
    throw new Error(`Local plan is blocked: ${validation.reason}`);
  if (selection.unknown.size && (!validation?.fallback || validation.discovery !== "complete"))
    throw new Error("Unknown ownership requires a complete bound baseline plan");
  const broad = selection.unknown.size > 0;
  const commands = [
    command("diff-check", "complete candidate whitespace", "git", [
      "diff",
      "--check",
      context.mergeBase ?? "<merge-base>",
    ]),
  ];
  const fullStatic =
    selection.repositoryLint || broad || validation?.fallback || validation?.changes.length === 0;
  if (fullStatic)
    commands.push(
      frontendTask(
        "repository-lint",
        "integrated repository static checks",
        selection.ui || broad ? "frontend:static" : "repository:static",
      ),
    );
  const files = sorted(selection.oxfmtFiles).filter((file) =>
    existsSync(path.join(projectRoot, file)),
  );
  if (!fullStatic && files.length)
    commands.push(
      command("oxfmt", "supported-file formatting", process.execPath, [
        "scripts/run-viteplus.mjs",
        "fmt",
        "--check",
        ...(broad || files.includes("vite.config.ts") ? [] : ["--no-error-on-unmatched-pattern"]),
        ...(broad || files.includes("vite.config.ts")
          ? []
          : files.map((file) => path.join(projectRoot, file))),
      ]),
    );
  if (selection.actionsLint)
    commands.push(
      command("actionlint", "workflow and embedded shell contracts", process.execPath, [
        "scripts/run-actionlint.mjs",
      ]),
    );
  if (selection.shellLint && selection.shellFiles.size)
    commands.push(
      command("shell-lint", "owned shell script lint", "aqua", [
        "exec",
        "--",
        "shellcheck",
        "--severity=warning",
        ...sorted(selection.shellFiles),
      ]),
    );
  if (selection.pythonLint && selection.pythonFiles.size)
    commands.push(
      command("python-lint", "owned Python script lint", "aqua", [
        "exec",
        "--",
        "ruff",
        "check",
        ...sorted(selection.pythonFiles),
      ]),
    );
  if (selection.rustfmt || broad)
    commands.push(
      command("rustfmt", "Rust formatting", "cargo", ["fmt", "--all", "--", "--check"]),
    );
  for (const file of sorted(selection.nodeSyntax))
    if (existsSync(path.join(projectRoot, file)))
      commands.push(
        command(`node-syntax:${file}`, "changed script syntax", process.execPath, [
          "--check",
          file,
        ]),
      );
  if (selection.nodeTests.size) commands.push(nodeTestCommand(sorted(selection.nodeTests)));
  if (
    selection.packages.size ||
    selection.workspaceRust ||
    broad ||
    validation?.groups.includes("rust")
  ) {
    if (!validation) throw new Error("Rust feedback requires a complete validation plan");
    commands.push({
      rustCoverage: selectWorkspaceRustImpact(validation).map((group) => group.filter),
      ...command(
        "rust-workspace-tests",
        "compile workspace test targets and execute selected maintained families",
        process.execPath,
        [
          "scripts/run-rust-tests.mjs",
          "--guard-command",
          process.execPath,
          "scripts/rust-test-impact.mjs",
          "--workspace-run",
          "work/local-validation-plan.json",
        ],
      ),
    });
  }
  if (selection.ui || broad) {
    commands.push(
      ...(!fullStatic
        ? [frontendTask("ui-check", "frontend static checks", "frontend:static")]
        : []),
      frontendTask("ui-content", "frontend content policy", "frontend:content"),
      frontendTask("ui-build", "frontend production build", "frontend:build"),
    );
    if (selection.uiFullTests || broad || !selection.uiRelatedFiles.size)
      commands.push(
        frontendTask("ui-tests", "complete frontend Node project", "frontend:unit"),
        frontendTask("ui-browser-tests", "complete real DOM project", "frontend:browser"),
      );
    else commands.push(uiRelatedCommand(sorted(selection.uiRelatedFiles)));
  }
  return deduplicateCommands(commands);
}

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

export function formatCommand(entry) {
  return [entry.executable, ...entry.args].map(quote).join(" ");
}

// Portable review inventory only; these records are never accepted as shell input.
export function selectedPlanInventory(plan) {
  const relative = (value) =>
    typeof value === "string" && value.startsWith(projectRoot)
      ? `$SOURCE/${value.slice(projectRoot.length).replaceAll("\\", "/")}`
      : value;
  return plan.map(({ id, executable, args, cwd }) => ({
    id,
    executable: executable === process.execPath ? "$NODE" : relative(executable),
    args: args.map(relative),
    cwd: relative(cwd),
  }));
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
      env: options.env ?? process.env,
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
