import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobSection(name, nextName) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

const rustTests = jobSection("rust_tests", "windows_storage");
const windowsStorage = jobSection("windows_storage", "rust");
const rust = jobSection("rust", "rust-quality");
const rustQuality = jobSection("rust-quality", "frontend");
const frontend = jobSection("frontend", "catalog");
const catalog = jobSection("catalog", "dependency-review");
const dependencyReview = jobSection("dependency-review");

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /upload-artifact/);
  for (const section of [rustTests, windowsStorage, rustQuality, frontend, catalog]) {
    assert.notEqual(section, "");
    assert.doesNotMatch(section, /^    if:/m);
  }
});

test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.match(rustTests, /^    name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  assert.match(rustTests, /shard: \[core-service, core-recovery, core-other, workspace-other\]/);
  for (const shard of ["service::", "cancellation::", "database::", "import_execution::", "library_move::"]) {
    assert.match(rustTests, new RegExp(`"${shard.replaceAll("::", "::")}"`));
  }
  assert.match(rustTests, /"--workspace", "--exclude", "portcove-core"/);
  assert.match(rustTests, /"--skip", "service::", "--skip", "cancellation::", "--skip", "database::", "--skip", "import_execution::", "--skip", "library_move::"/);
  assert.match(rustTests, /if: matrix\.shard == 'workspace-other'[\s\S]*cargo fmt --all -- --check/);
  assert.match(rustTests, /if: matrix\.shard == 'workspace-other'[\s\S]*cargo clippy --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(rustTests, /setup-node|pnpm|cargo check/);

  assert.match(windowsStorage, /^    name: windows-storage$/m);
  assert.match(windowsStorage, /runs-on: windows-latest/);
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mjs/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(windowsStorage, /rust-toolchain|rust-cache|cargo/);

  assert.match(rust, /^    if: always\(\)$/m);
  assert.match(rust, /^    needs: \[rust_tests, windows_storage\]$/m);
  assert.match(rust, /RUST_TEST_RESULT: \$\{\{ needs\.rust_tests\.result \}\}/);
  assert.match(rust, /WINDOWS_STORAGE_RESULT: \$\{\{ needs\.windows_storage\.result \}\}/);
  assert.match(rust, /exit 1/);
  assert.doesNotMatch(rust, /continue-on-error/);
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
