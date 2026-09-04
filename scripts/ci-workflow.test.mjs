import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobSection(name, nextName) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

const rustLint = jobSection("rust_lint", "rust_test");
const rustTest = jobSection("rust_test", "rust");
const rust = jobSection("rust", "rust-quality");
const rustQuality = jobSection("rust-quality", "frontend");
const frontend = jobSection("frontend", "catalog");
const catalog = jobSection("catalog", "dependency-review");
const dependencyReview = jobSection("dependency-review");

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /upload-artifact/);
  for (const section of [rustLint, rustTest, rustQuality, frontend, catalog]) {
    assert.notEqual(section, "");
    assert.doesNotMatch(section, /^    if:/m);
  }
});

test("Windows Rust keeps complete parallel gates without unused or duplicate setup", () => {
  assert.match(rustLint, /^    name: rust-lint$/m);
  assert.match(rustLint, /runs-on: windows-latest/);
  assert.match(rustLint, /cargo fmt --all -- --check/);
  assert.match(rustLint, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.match(rustLint, /scripts\/dev-storage\.test\.mjs/);
  assert.match(rustLint, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rustLint, /pnpm\/action-setup|quality-pins|Install pinned recipe runner|cargo test|cargo check/);

  assert.match(rustTest, /^    name: rust-test$/m);
  assert.match(rustTest, /runs-on: windows-latest/);
  assert.match(rustTest, /cargo test --workspace/);
  assert.doesNotMatch(rustTest, /setup-node|pnpm|cargo fmt|cargo clippy|cargo check/);

  assert.match(rust, /^    if: always\(\)$/m);
  assert.match(rust, /^    needs: \[rust_lint, rust_test\]$/m);
  assert.match(rust, /RUST_LINT_RESULT: \$\{\{ needs\.rust_lint\.result \}\}/);
  assert.match(rust, /RUST_TEST_RESULT: \$\{\{ needs\.rust_test\.result \}\}/);
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
