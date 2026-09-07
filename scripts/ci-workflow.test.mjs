import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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
const nativeRust = jobSection("native_rust", "intel_build");
const intelBuild = jobSection("intel_build", "intel_tests");
const intelTests = jobSection("intel_tests", "rust_docs");
const rustDocs = jobSection("rust_docs", "rust");
const rust = jobSection("rust", "rust-quality");
const rustQuality = jobSection("rust-quality", "frontend");
const frontend = jobSection("frontend", "catalog");
const catalog = jobSection("catalog", "dependency-review");
const dependencyReview = jobSection("dependency-review");

test("every Node test file is included in required CI and the local quality workflow", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const files = (await readdir(new URL(".", import.meta.url))).filter(name => name.endsWith(".test.mjs"));
  for (const file of files) {
    assert.ok(workflow.includes(`scripts/${file}`), `${file} is absent from required CI`);
    assert.ok(recipes.includes(`scripts/${file}`), `${file} is absent from local quality checks`);
  }
});

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: true$/m);
  for (const section of [rustTests, rustWorkspaceTests, rustClippy, windowsStorage, nativeRust, intelBuild, intelTests, rustDocs, rustQuality, frontend, catalog]) {
    assert.notEqual(section, "");
    assert.doesNotMatch(section, /^    if:/m);
  }
});

test("Rust setup installs the repository pin instead of an unrelated stable toolchain", async () => {
  const setup = await readFile(new URL("../.github/actions/setup-rust/action.yml", import.meta.url), "utf8");
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  assert.doesNotMatch(workflow, /uses: dtolnay\/rust-toolchain/);
  for (const section of [rustTests, rustWorkspaceTests, rustClippy, nativeRust, intelBuild, intelTests, rustDocs, rustQuality]) {
    assert.match(section, /uses: \.\/\.github\/actions\/setup-rust/);
  }
  assert.match(setup, /node scripts\/run-rust-tests\.mjs --prepare-only/);
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelTests, rustQuality]) {
    assert.match(section, /test-fixtures: true/);
  }
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /node scripts\/run-rust-tests\.mjs --locked --workspace/);
});

test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.match(rustTests, /^    name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-2022/);
  assert.match(rustTests, /shard: \[core-service-1, core-service-2, core-recovery, core-other-1, core-other-2\]/);
  for (const shard of ["service::", "cancellation::", "database::", "import_execution::", "library_move::"]) {
    assert.match(rustTests, new RegExp(`"${shard.replaceAll("::", "::")}"`));
  }
  assert.match(rustTests, /"--skip", "service::", "--skip", "cancellation::", "--skip", "database::", "--skip", "import_execution::", "--skip", "library_move::"/);
  assert.equal((rustTests.match(/"hash:1\/2"/g) ?? []).length, 2);
  assert.equal((rustTests.match(/"hash:2\/2"/g) ?? []).length, 2);
  assert.doesNotMatch(rustTests, /workspace-other|pnpm|cargo check|cargo fmt|cargo clippy/);

  assert.match(rustWorkspaceTests, /^    name: rust-test \(workspace-other\)$/m);
  assert.match(rustWorkspaceTests, /runs-on: windows-2022/);
  assert.match(rustWorkspaceTests, /cargo nextest run --locked --workspace --exclude portcove-core/);
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
  assert.match(windowsStorage, /scripts\/windows-qualification-session\.test\.mjs/);
  assert.match(windowsStorage, /node --test scripts\/windows-qualification-session\.integration\.test\.mjs/);
  assert.match(windowsStorage, /--test-timeout=5000 --test-reporter=\.\/scripts\/test-duration-reporter\.mjs/);
  assert.doesNotMatch(windowsStorage, /rust-toolchain|rust-cache|cargo/);

  assert.match(rust, /^    if: always\(\)$/m);
  assert.match(rust, /^    needs: \[rust_tests, rust_workspace_tests, rust_clippy, windows_storage, native_rust, intel_build, intel_tests, rust_docs\]$/m);
  assert.match(rust, /RUST_TEST_RESULT: \$\{\{ needs\.rust_tests\.result \}\}/);
  assert.match(rust, /RUST_WORKSPACE_TEST_RESULT: \$\{\{ needs\.rust_workspace_tests\.result \}\}/);
  assert.match(rust, /RUST_CLIPPY_RESULT: \$\{\{ needs\.rust_clippy\.result \}\}/);
  assert.match(rust, /WINDOWS_STORAGE_RESULT: \$\{\{ needs\.windows_storage\.result \}\}/);
  assert.match(rust, /NATIVE_RUST_RESULT: \$\{\{ needs\.native_rust\.result \}\}/);
  assert.match(rust, /exit 1/);
  assert.doesNotMatch(rust, /continue-on-error/);
});

test("native Rust runs the full workspace on every supported Unix architecture", () => {
  assert.match(nativeRust, /^    name: native-rust \(\$\{\{ matrix\.platform \}\}, \$\{\{ matrix\.partition \}\}\)$/m);
  for (const [platform, runner] of [
    ["linux-x86_64", "ubuntu-22.04"],
    ["macos-aarch64", "macos-15"],
  ]) {
    assert.match(nativeRust, new RegExp(`platform: ${platform}\\r?\\n\\s+runner: ${runner}`));
  }
  assert.match(nativeRust, /if: runner\.os == 'Linux'/);
  assert.match(nativeRust, /echo "TMPDIR=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(nativeRust, /libwebkit2gtk-4\.1-dev libappindicator3-dev librsvg2-dev patchelf/);
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(nativeRust, /--partition "\$\{\{ matrix\.partition \}\}"/);
  assert.equal((nativeRust.match(/partition: hash:1\/1/g) ?? []).length, 2);
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

test("Intel tests build once on Apple Silicon and execute every partition on Intel", () => {
  assert.match(intelBuild, /runs-on: macos-15$/m);
  assert.match(intelBuild, /targets: x86_64-apple-darwin/);
  assert.match(intelBuild, /cargo nextest archive --locked --workspace --target x86_64-apple-darwin/);
  assert.match(intelBuild, /if-no-files-found: error/);
  assert.match(intelBuild, /retention-days: 1/);
  assert.match(intelTests, /needs: intel_build/);
  assert.match(intelTests, /runs-on: macos-15-intel/);
  assert.match(intelTests, /partition: \["hash:1\/2", "hash:2\/2"\]/);
  assert.match(intelTests, /cargo nextest run --archive-file .* --workspace-remap "\$PWD" --partition "\$\{\{ matrix\.partition \}\}"/);
  for (const section of [intelBuild, intelTests]) {
    assert.match(section, /name: intel-rust-tests-\$\{\{ github\.run_attempt \}\}/);
    assert.doesNotMatch(section, /continue-on-error/);
  }
  for (const [variable, job] of [["INTEL_BUILD_RESULT", "intel_build"], ["INTEL_TEST_RESULT", "intel_tests"]]) {
    assert.ok(rust.includes(`${variable}: ` + "${{ needs." + job + ".result }}"));
    assert.ok(rust.includes(`"$${variable}" != "success"`));
  }
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

test("routine checks retain architecture enforcement but make cycles optional", async () => {
  assert.doesNotMatch(rustQuality, /cargo modules/);
  assert.match(rustQuality, /node scripts\/check-rust-architecture\.mjs/);
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /^audit: check deny rscheck$/m);
  assert.match(recipes, /^cycles:\r?\n.*cargo modules/m);
});

test("live upstream health has bounded independent triggers while catalog stays offline", async () => {
  assert.doesNotMatch(catalog, /check-catalog-repositories\.mjs/);
  assert.match(catalog, /check-retcomm-upstreams\.mjs --offline/);
  const health = await readFile(new URL("../.github/workflows/upstream-health.yml", import.meta.url), "utf8");
  assert.match(health, /schedule:\r?\n    - cron:/);
  assert.match(health, /workflow_dispatch:/);
  assert.match(health, /timeout-minutes: 10/);
  assert.match(health, /^permissions:\r?\n  contents: read$/m);
  assert.doesNotMatch(health, /pull_request_target|continue-on-error/);
  for (const trigger of ["pull_request", "push"]) {
    const section = health.split(`  ${trigger}:`)[1].split(/^  \w+:/m)[0];
    for (const path of ["crates/portcove-core/catalog/**", "scripts/retcomm-psx-upstreams.json", "scripts/check-catalog-repositories.mjs", "scripts/check-retcomm-upstreams.mjs", ".node-version", ".github/workflows/upstream-health.yml"]) {
      assert.ok(section.includes(`'${path}'`), `${trigger} must cover ${path}`);
    }
  }
  assert.match(health, /run: node scripts\/check-catalog-repositories\.mjs/);
  assert.match(health, /run: node scripts\/check-retcomm-upstreams\.mjs\r?$/m);
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(release, /run: node scripts\/check-retcomm-upstreams\.mjs\r?$/m);
});

test("offline RetComM validation rejects bad mappings without loading upstream data", async () => {
  const { mkdtemp, mkdir, writeFile, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "portcove-offline-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "crates/portcove-core/catalog"), { recursive: true });
    const checker = join(root, "scripts/check-retcomm-upstreams.mjs");
    await copyFile(new URL("./check-retcomm-upstreams.mjs", import.meta.url), checker);
    const preload = join(root, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
    const port = { id: "fixture", adapter: "psx-recomp-managed", release: { repository: "owner/game" } };
    const catalogFile = join(root, "crates/portcove-core/catalog/catalog.json");
    await writeFile(catalogFile, JSON.stringify({ ports: [port] }));
    const mappingFile = join(root, "scripts/retcomm-psx-upstreams.json");
    const run = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, checker, ...args], {
      encoding: "utf8", env: { ...process.env, RETCOMM_CATALOG_DIR: "" },
    });
    await writeFile(mappingFile, JSON.stringify({ fixture: "fixture-title" }));
    const valid = run("--offline");
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /live upstream checks were not run/);
    const live = run();
    assert.equal(live.status, 1);
    assert.match(live.stderr, /NETWORK_FORBIDDEN/);
    for (const mappings of [{}, { stale: "fixture-title" }]) {
      await writeFile(mappingFile, JSON.stringify(mappings));
      const invalid = run("--offline");
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /missing RetComM title mapping/);
      assert.doesNotMatch(invalid.stderr, /NETWORK_FORBIDDEN/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Rust unit budgets fail at five seconds and documentation coverage remains", async () => {
  const config = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  assert.match(config, /slow-timeout = \{ period = "5s", terminate-after = 1, grace-period = "0s" \}/);
  assert.match(config, /^retries = 0$/m);
  assert.doesNotMatch(config, /on-timeout|default-filter/);
  for (const override of config.split("[[profile.default.overrides]]").slice(1)) {
    assert.doesNotMatch(override, /slow-timeout|retries/);
  }
  assert.match(rustTests, /cargo nextest run --locked --test-threads 1 @Arguments/);
  assert.match(rustDocs, /cargo test --locked --workspace --doc/);
  for (const platform of ["windows-x86_64", "linux-x86_64", "macos-x86_64", "macos-aarch64"]) {
    assert.ok(rustDocs.includes(`platform: ${platform}`));
  }
  assert.match(rust, /RUST_DOC_RESULT: \$\{\{ needs\.rust_docs\.result \}\}/);
  assert.match(rust, /"\$RUST_DOC_RESULT" != "success"/);
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelBuild, intelTests]) {
    assert.match(section, /Install pinned test runner/);
    assert.match(section, /Get-Content \.github\/quality-tools\.json/);
    assert.match(section, /Where-Object id -eq "cargo-nextest"/);
  }
  assert.match(rustQuality, /cargo nextest run --locked -p portcove-core/);
  assert.match(workflow, /CARGO_PROFILE_TEST_DEBUG: line-tables-only/);
  assert.match(workflow, /CARGO_PROFILE_DEV_DEBUG: line-tables-only/);
});
