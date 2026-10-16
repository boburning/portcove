import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
} from "./native-helper-dependencies.mts";

const nativeToolInputs = new Set([
  "apps/desktop/scripts/desktop-install-fixture.native.test.mts",
  "apps/desktop/scripts/cli-command-shell.native.test.mts",
  "apps/desktop/src/cli-command.ts",
  "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
  "scripts/dev-storage.mts",
  "scripts/tool-cache.mts",
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
  "apps/desktop/scripts/desktop-test.mts",
  nativeHelperRegistryPath,
  "scripts/native-helper-dependencies.test.mts",
  "scripts/frontend-command-preflight.mts",
  "scripts/viteplus-cli.mts",
  "scripts/frontend-command-preflight.test.mts",
  "scripts/desktop-verify.mts",
  "scripts/desktop-verify.test.mts",
  "scripts/desktop-execution-plan.mts",
  "scripts/desktop-execution-plan.test.mts",
  "scripts/development-evidence.mts",
  "scripts/development-evidence.test.mts",
  "apps/desktop/scripts/build-frontend.mts",
  "apps/desktop/scripts/build-frontend.test.mts",
  "scripts/native-confirmation.test.mts",
  "scripts/native-session.test.mts",
  "scripts/native-session-lock.mts",
  "scripts/native-session-lock.test.mts",
  "scripts/dev-storage.mts",
  "scripts/dev-storage.test.mts",
  "scripts/windows-helper-checks.mts",
  "scripts/windows-helper-checks.test.mts",
  "scripts/select-ci-plan.mts",
  "scripts/select-ci-plan.test.mts",
  "scripts/validation-plan.mts",
  "scripts/validation-plan.test.mts",
  "scripts/ci-result-gate.mts",
  "scripts/ci-result-gate.test.mts",
  "scripts/ci-baseline.mts",
  "scripts/ci-baseline.test.mts",
  ".github/workflows/ci.yml",
  ".config/powershell-resources.psd1",
  ".config/PSScriptAnalyzerSettings.psd1",
  "scripts/run-powershell-lint.mts",
  "scripts/lint-tools.integration.mts",
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
          (file: string) =>
            helperPaths.has(file) || file.endsWith(".ps1") || file.endsWith(".psd1"),
        ),
      ))
  );
}
