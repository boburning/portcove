import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
  nativeHelperSharedSources,
} from "./native-helper-dependencies.mts";

const nativeToolInputs = new Set([
  "apps/desktop/scripts/desktop-artwork-observations.mts",
  "apps/desktop/scripts/desktop-artwork-observations.native.test.mts",
  "scripts/rust-test-impact.mts",
  "scripts/desktop-linux-x11.mts",
  "scripts/resource-capacity.mts",
  "scripts/resource-paths.mts",
  "scripts/resource-capacity.test.mts",
  "scripts/resource-command.mts",
  "scripts/resource-command.test.mts",
  "scripts/native-build.mts",
  "scripts/native-build.test.mts",
  "scripts/run-rust-tests.mts",
  "scripts/run-rust-tests.test.mts",
  "scripts/heavy-rust-test-lock.mts",
  "scripts/heavy-rust-test-lock.test.mts",
  "scripts/rust-test-tree-supervisor.mts",
  "scripts/rust-test-tree-supervisor.test.mts",

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

export function windowsNativeToolsRequired(plan: HelperSelectionPlan) {
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

interface HelperSelectionPlan {
  mode: string;
  fallback?: unknown;
  changes: readonly { oldPath: string; newPath: string }[];
}

const helperPaths = new Set([
  "scripts/release-local-worker-accounts.ps1",
  "scripts/release-local-worker-accounts.test.mts",
  "scripts/recover-local-worker-empty-setup.ps1",
  "scripts/resume-local-worker-profile.ps1",
  "scripts/recover-local-worker-empty-setup.test.mts",
  "scripts/release-native-account-capability.mts",
  "scripts/release-native-account-capability.test.mts",
  "scripts/native-qualification-account-client.mts",
  "scripts/native-qualification-account-client.ps1",
  "scripts/native-qualification-account-bridge.ps1",
  "scripts/native-qualification-account.cs.txt",
  "scripts/native-qualification-account-registry.ps1",
  "scripts/fixtures/native-account-gui-probe.ps1",
  "scripts/fixtures/native-desktop-observer.cs.txt",
  "scripts/daily-discovery-session.mts",
  "scripts/daily-discovery.test.mts",
  ...nativeHelperSharedSources,
  "apps/desktop/scripts/browser-script.mts",
  "apps/desktop/scripts/browser-readiness.mts",
  ...nativeToolInputs,
  ...Object.keys(nativeHelperDependencies),
  "apps/desktop/scripts/desktop-test.mts",
  nativeHelperRegistryPath,
  nativeHelperSharedSources,
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
export function windowsHelperChecksRequired(plan: HelperSelectionPlan) {
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
