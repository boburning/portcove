import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobSection(name, nextName) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

const rustTests = jobSection("rust_tests", "rust_workspace_tests");
const rustWorkspaceTests = jobSection("rust_workspace_tests", "rust_clippy");
const rustClippy = jobSection("rust_clippy", "windows_storage");
const windowsStorage = jobSection("windows_storage", "native_rust");
const nativeRust = jobSection("native_rust", "rust");
const rust = jobSection("rust", "rust-quality");
const rustQuality = jobSection("rust-quality", "frontend");
const frontend = jobSection("frontend", "catalog");
const catalog = jobSection("catalog", "dependency-review");
const dependencyReview = jobSection("dependency-review");

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /upload-artifact/);
  for (const section of [rustTests, rustWorkspaceTests, rustClippy, windowsStorage, nativeRust, rustQuality, frontend, catalog]) {
    assert.notEqual(section, "");
    assert.doesNotMatch(section, /^    if:/m);
  }
});

test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.match(rustTests, /^    name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  assert.match(rustTests, /shard: \[core-service, core-recovery, core-other\]/);
  for (const shard of ["service::", "cancellation::", "database::", "import_execution::", "library_move::"]) {
    assert.match(rustTests, new RegExp(`"${shard.replaceAll("::", "::")}"`));
  }
  assert.match(rustTests, /"--skip", "service::", "--skip", "cancellation::", "--skip", "database::", "--skip", "import_execution::", "--skip", "library_move::"/);
  assert.doesNotMatch(rustTests, /workspace-other|setup-node|pnpm|cargo check|cargo fmt|cargo clippy/);

  assert.match(rustWorkspaceTests, /^    name: rust-test \(workspace-other\)$/m);
  assert.match(rustWorkspaceTests, /runs-on: windows-latest/);
  assert.match(rustWorkspaceTests, /cargo test --workspace --exclude portcove-core/);
  assert.doesNotMatch(rustWorkspaceTests, /matrix|cargo fmt|cargo clippy/);

  assert.match(rustClippy, /^    name: rust-clippy$/m);
  assert.match(rustClippy, /runs-on: windows-latest/);
  assert.match(rustClippy, /cargo fmt --all -- --check/);
  assert.match(rustClippy, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(rustClippy, /cargo test|matrix/);

  assert.match(windowsStorage, /^    name: windows-storage$/m);
  assert.match(windowsStorage, /runs-on: windows-latest/);
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mjs/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(windowsStorage, /rust-toolchain|rust-cache|cargo/);

  assert.match(rust, /^    if: always\(\)$/m);
  assert.match(rust, /^    needs: \[rust_tests, rust_workspace_tests, rust_clippy, windows_storage, native_rust\]$/m);
  assert.match(rust, /RUST_TEST_RESULT: \$\{\{ needs\.rust_tests\.result \}\}/);
  assert.match(rust, /RUST_WORKSPACE_TEST_RESULT: \$\{\{ needs\.rust_workspace_tests\.result \}\}/);
  assert.match(rust, /RUST_CLIPPY_RESULT: \$\{\{ needs\.rust_clippy\.result \}\}/);
  assert.match(rust, /WINDOWS_STORAGE_RESULT: \$\{\{ needs\.windows_storage\.result \}\}/);
  assert.match(rust, /NATIVE_RUST_RESULT: \$\{\{ needs\.native_rust\.result \}\}/);
  assert.match(rust, /exit 1/);
  assert.doesNotMatch(rust, /continue-on-error/);
});

test("native Rust runs the full workspace on every supported Unix architecture", () => {
  assert.match(nativeRust, /^    name: native-rust \(\$\{\{ matrix\.platform \}\}\)$/m);
  for (const [platform, runner] of [
    ["linux-x86_64", "ubuntu-22.04"],
    ["macos-x86_64", "macos-15-intel"],
    ["macos-aarch64", "macos-15"],
  ]) {
    assert.match(nativeRust, new RegExp(`platform: ${platform}\\r?\\n\\s+runner: ${runner}`));
  }
  assert.match(nativeRust, /if: runner\.os == 'Linux'/);
  assert.match(nativeRust, /echo "TMPDIR=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(nativeRust, /libwebkit2gtk-4\.1-dev libappindicator3-dev librsvg2-dev patchelf/);
  assert.match(nativeRust, /cargo test --workspace/);
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

test("Linux Rust quality keeps its platform-specific and policy gates without pnpm", () => {
  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /machine_contract/);
  assert.match(rustQuality, /backup_directory_durability_support_is_explicit_for_the_host/);
  assert.match(rustQuality, /cargo shear --deny-warnings/);
  assert.match(rustQuality, /cargo deny check/);
  assert.match(rustQuality, /check-rust-architecture\.mjs/);
  assert.match(rustQuality, /run-rscheck\.mjs/);
  assert.match(rustQuality, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rustQuality, /pnpm\/action-setup|pnpm install/);
});

test("frontend keeps deterministic product gates and delegates vulnerability changes", () => {
  assert.match(frontend, /^    env:\r?\n      npm_config_audit: "false"$/m);
  assert.match(frontend, /pnpm install --frozen-lockfile/);
  assert.match(frontend, /Install pinned recipe runner/);
  assert.match(frontend, /--test-name-pattern "pnpm uses\|direct just recipes" scripts\/dev-storage\.test\.mjs/);
  assert.match(frontend, /pnpm build/);
  assert.match(frontend, /pnpm test/);
  assert.match(frontend, /run-fallow\.mjs/);
  assert.doesNotMatch(frontend, /pnpm audit/);

  assert.match(dependencyReview, /github\.event_name == 'pull_request'/);
  assert.match(dependencyReview, /dependency-review-action/);
  assert.match(dependencyReview, /fail-on-severity: high/);
});

test("catalog executes the CI workflow contract", () => {
  assert.match(catalog, /scripts\/ci-workflow\.test\.mjs/);
});
