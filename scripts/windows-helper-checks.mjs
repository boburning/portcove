import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
} from "./native-helper-dependencies.mjs";

const nativeToolInputs = new Set([
  "scripts/rust-test-impact.mjs",
  "scripts/desktop-linux-x11.mjs",
  "scripts/resource-capacity.mjs",
  "scripts/resource-paths.mjs",
  "scripts/resource-capacity.test.mjs",
  "scripts/resource-command.mjs",
  "scripts/resource-command.test.mjs",
  "scripts/native-build.mjs",
  "scripts/native-build.test.mjs",
  "scripts/run-rust-tests.mjs",
  "scripts/run-rust-tests.test.mjs",
  "scripts/heavy-rust-test-lock.mjs",
  "scripts/heavy-rust-test-lock.test.mjs",
  "scripts/rust-test-tree-supervisor.mjs",
  "scripts/rust-test-tree-supervisor.test.mjs",

  "apps/desktop/scripts/desktop-install-fixture.native.test.mjs",
  "apps/desktop/scripts/cli-command-shell.native.test.mjs",
  "apps/desktop/src/cli-command.ts",
  "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
  "scripts/dev-storage.mjs",
  "scripts/tool-cache.mjs",
  ".node-version",
  "rust-toolchain.toml",
  ".github/actions/setup-rust/action.yml",
  ".github/workflows/ci.yml",
]);

export function windowsNativeToolsRequired(plan) {
  return (
    plan.mode === "qualification" ||
    (plan.mode === "fast" &&
      (Boolean(plan.fallback) ||
        !plan.changes.length ||
        plan.changes.some((change) =>
          [change.oldPath, change.newPath].some((file) => nativeToolInputs.has(file)),
        )))
  );
}

const helperPaths = new Set([
  ...nativeToolInputs,
  ...Object.keys(nativeHelperDependencies),
  "apps/desktop/scripts/desktop-test.mjs",
  nativeHelperRegistryPath,
  "scripts/native-helper-dependencies.test.mjs",
  "scripts/frontend-command-preflight.mjs",
  "scripts/viteplus-cli.mjs",
  "scripts/frontend-command-preflight.test.mjs",
  "scripts/desktop-verify.mjs",
  "scripts/desktop-verify.test.mjs",
  "scripts/desktop-execution-plan.mjs",
  "scripts/desktop-execution-plan.test.mjs",
  "scripts/development-evidence.mjs",
  "scripts/development-evidence.test.mjs",
  "apps/desktop/scripts/build-frontend.mjs",
  "apps/desktop/scripts/build-frontend.test.mjs",
  "scripts/native-confirmation.test.mjs",
  "scripts/native-session.test.mjs",
  "scripts/native-session-lock.mjs",
  "scripts/native-session-lock.test.mjs",
  "scripts/dev-storage.mjs",
  "scripts/dev-storage.test.mjs",
  "scripts/windows-helper-checks.mjs",
  "scripts/windows-helper-checks.test.mjs",
  "scripts/select-ci-plan.mjs",
  "scripts/select-ci-plan.test.mjs",
  "scripts/validation-plan.mjs",
  "scripts/validation-plan.test.mjs",
  "scripts/ci-result-gate.mjs",
  "scripts/ci-result-gate.test.mjs",
  "scripts/ci-baseline.mjs",
  "scripts/ci-baseline.test.mjs",
  ".github/workflows/ci.yml",
  ".config/powershell-resources.psd1",
  ".config/PSScriptAnalyzerSettings.psd1",
  "scripts/run-powershell-lint.mjs",
  "scripts/lint-tools.integration.mjs",
  "package.json",
  "pnpm-lock.yaml",
  ".node-version",
]);

// The complete rename/delete sides come from the already validated CI plan.
// Broad fallback includes this Windows proof without narrowing Rust selection.
export function windowsHelperChecksRequired(plan) {
  return (
    plan.mode === "fast" &&
    (Boolean(plan.fallback) ||
      plan.changes.length === 0 ||
      plan.changes.some((change) =>
        [change.oldPath, change.newPath].some(
          (file) => helperPaths.has(file) || file.endsWith(".ps1") || file.endsWith(".psd1"),
        ),
      ))
  );
}
