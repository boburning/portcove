import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobSection(name, nextName) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

const rust = jobSection("rust", "rust-quality");
const rustQuality = jobSection("rust-quality", "frontend");
const frontend = jobSection("frontend", "catalog");
const catalog = jobSection("catalog", "dependency-review");
const dependencyReview = jobSection("dependency-review");

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /upload-artifact/);
  for (const section of [rust, rustQuality, frontend, catalog]) {
    assert.notEqual(section, "");
    assert.doesNotMatch(section, /^    if:/m);
  }
});

test("Windows Rust keeps complete gates without unused or duplicate setup", () => {
  assert.match(rust, /runs-on: windows-latest/);
  assert.match(rust, /cargo fmt --all -- --check/);
  assert.match(rust, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.match(rust, /cargo test --workspace/);
  assert.match(rust, /scripts\/dev-storage\.test\.mjs/);
  assert.match(rust, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rust, /pnpm\/action-setup|quality-pins|Install pinned recipe runner/);
  assert.doesNotMatch(rust, /cargo check/);
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
