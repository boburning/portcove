import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { encodeBackupEvidence, recoverBackupEvidence } from "./native-backup-evidence.mjs";
import { AUDIT_STAGES, receiptEnvelope } from "./audit.mjs";
import { renderDeepAuditSummary } from "./deep-audit-summary.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const qualificationWorkflow = await readFile(
  new URL("../.github/workflows/qualification.yml", import.meta.url),
  "utf8",
);
const nativeDesignCompatibilityWorkflow = await readFile(
  new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
  "utf8",
);
const nativeCompatibilityRunner = await readFile(
  new URL("../apps/desktop/test/native-compatibility.mjs", import.meta.url),
  "utf8",
);
const desktopPackage = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
const qualityGuide = await readFile(new URL("../docs/QUALITY.md", import.meta.url), "utf8");
const windowsQualificationRunner = await readFile(
  new URL("./run-windows-qualification.ps1", import.meta.url),
  "utf8",
);
const requiredCiSurface = `${workflow}\n${windowsQualificationRunner}`;

test("hosted backup focus is manual-only, pinned, isolated and retains real evidence without billed storage", async () => {
  const source = await readFile(
    new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^ {2}(pull_request|push|schedule|workflow_run):/m);
  assert.match(source, /^permissions:\n {2}contents: read$/m);
  assert.match(source, /runs-on: windows-2022/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /\$env:FOCUS_HEAD -ne '161e577dc48f93db98a9930853e808e22c43c7b2'/);
  assert.match(source, /git -c user.name=PortcoveQualification .* merge --no-ff --no-edit/);
  assert.match(source, /merge_head = \(git rev-parse HEAD\)/);
  assert.match(source, /merge_parents = \(git show -s --format=%P HEAD\)/);
  assert.match(source, /just desktop-verify --scenario native-backup-delete-focus --require-clean/);
  const windows = source.split("  backup_focus:\n")[1]?.split("\n  edge_driver_proof:")[0];
  assert.ok(windows);
  assert.doesNotMatch(
    windows,
    /VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE|upload-artifact|rust-cache|actions\/cache|cache: pnpm/,
  );
  assert.match(
    source,
    /qualify:\n {4}if: \$\{\{ !inputs\.edge_driver_proof && inputs\.runner != 'windows-2022' \}\}/,
  );
  assert.match(
    windows,
    /^ {4}if: \$\{\{ !inputs\.edge_driver_proof && inputs\.runner == 'windows-2022' \}\}/,
  );
  assert.match(windows, /PORTCOVE_TEMP_DIR: \$\{\{ github.workspace \}\}/);
  assert.doesNotMatch(windows.split("    steps:")[0], /\$\{\{ runner\./);
  assert.match(windows, /id: native-quality-pins/);
  assert.match(windows, /node scripts\/quality-tools.mjs --github-output >> \$env:GITHUB_OUTPUT/);
  assert.match(windows, /taiki-e\/install-action@c3ec0de9ae7f1019cea21aa96aa0a895b9552063/);
  assert.match(windows, /tool: \$\{\{ steps.native-quality-pins.outputs.required_prebuilt \}\}/);
  assert.ok(
    windows.indexOf("Provision existing pinned prebuilt quality tools") <
      windows.indexOf("./scripts/bootstrap-quality-tools.ps1 -Desktop"),
  );

  assert.match(source, /if: always\(\)[\s\S]*native-backup-evidence.mjs emit/);
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Required evidence retention failed/);
});

function jobSection(name, nextName) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

test("native scenario consumers keep Node and context contracts in both frontend lanes", () => {
  for (const section of [
    jobSection("fast_frontend", "fast_catalog"),
    jobSection("frontend_full", "frontend"),
  ]) {
    assert.match(
      section,
      /scripts\/desktop-scenarios\.test\.mjs scripts\/desktop-verify\.test\.mjs scripts\/development-evidence\.test\.mjs scripts\/native-session-lock\.test\.mjs/,
    );
    assert.match(
      section,
      /node apps\/desktop\/scripts\/desktop-preparation-test\.mjs --context-preflight/,
    );
    assert.match(section, /pnpm install --frozen-lockfile/);
  }
});

test("EdgeDriver trust proof is manual, isolated, and does not launch the application", () => {
  const job = nativeDesignCompatibilityWorkflow.split("\n  edge_driver_proof:")[1];
  assert.ok(job);
  assert.match(job, /if: inputs\.edge_driver_proof/u);
  assert.match(job, /runs-on: windows-2022/u);
  assert.match(job, /persist-credentials: false/u);
  assert.doesNotMatch(
    job,
    /upload-artifact|actions\/cache|cache:|cargo|bootstrap-quality-tools\.ps1 -Desktop|desktop-verify/u,
  );
  assert.match(job, /Test-VerifiedEdgeDriver \$downloaded \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached '0\.0\.0\.0'/u);
  assert.match(job, /https:\/\/msedgedriver\.microsoft\.com/u);
  assert.match(job, /bootstrap_sha256/u);
  assert.match(job, /driver_sha256/u);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /if: \$\{\{ !inputs\.edge_driver_proof && inputs\.runner != 'windows-2022' \}\}/u,
  );
});

test("native design compatibility remains explicit, isolated, and non-publishing", () => {
  assert.match(nativeDesignCompatibilityWorkflow, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /^ {2}(pull_request|push|schedule):/m);
  assert.match(nativeDesignCompatibilityWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /options:\r?\n {10}- ubuntu-22\.04\r?\n {10}- macos-15\r?\n {10}- macos-15-intel/,
  );
  assert.match(nativeDesignCompatibilityWorkflow, /--scenario native-design-system-compatibility/);
  assert.match(nativeDesignCompatibilityWorkflow, /test:desktop \\\r?\n {14}--app/);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /test:desktop -- \\/);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /--output "\$PWD\/work\/native-compatibility-evidence\/linux"/,
  );
  assert.doesNotMatch(
    nativeDesignCompatibilityWorkflow,
    /mkdir -p work\/native-compatibility-evidence\/linux/,
  );
  assert.match(nativeDesignCompatibilityWorkflow, /--features native-compatibility-qualification/);
  assert.match(nativeDesignCompatibilityWorkflow, /tauri\.native-compatibility\.conf\.json/);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /release|publish|deploy|schedule:/i);
  assert.match(nativeCompatibilityRunner, /createHash\("sha256"\)/);
  assert.match(nativeCompatibilityRunner, /"result\.json"/);
  assert.match(
    nativeCompatibilityRunner,
    /applicationProcess\.kill\("SIGKILL"\);[\s\S]*?await waitForApplicationExit\(5_000\)/,
  );
  assert.equal(
    desktopPackage.scripts["lint:style"],
    'stylelint --config stylelint.config.mjs --max-warnings 0 "src/**/*.css"',
  );
});

const classify = jobSection("classify", "provenance");
const provenance = jobSection("provenance", "prose_checks");
const proseChecks = jobSection("prose_checks", "fast_rust");
const fastRust = jobSection("fast_rust", "fast_platform");
const fastPlatform = jobSection("fast_platform", "fast_rust_quality");
const fastRustQuality = jobSection("fast_rust_quality", "fast_frontend");
const fastFrontend = jobSection("fast_frontend", "fast_catalog");
const fastCatalog = jobSection("fast_catalog", "rust_tests");
const rustTests = jobSection("rust_tests", "rust_workspace_tests");
const rustWorkspaceTests = jobSection("rust_workspace_tests", "rust_clippy");
const rustClippy = jobSection("rust_clippy", "windows_storage");
const windowsStorage = jobSection("windows_storage", "native_rust");
const nativeRust = jobSection("native_rust", "intel_build");
const intelBuild = jobSection("intel_build", "intel_tests");
const intelTests = jobSection("intel_tests", "rust_docs");
const rustDocs = jobSection("rust_docs", "rust");
const rust = jobSection("rust", "rust_quality_full");
const rustQuality = jobSection("rust_quality_full", "rust-quality");
const rustQualityGate = jobSection("rust-quality", "frontend_full");
const frontend = jobSection("frontend_full", "frontend");
const frontendGate = jobSection("frontend", "catalog_full");
const catalog = jobSection("catalog_full", "catalog");
const catalogGate = jobSection("catalog", "fast_dependency_review");
const fastDependencyReview = jobSection("fast_dependency_review", "dependency_review_full");
const dependencyReview = jobSection("dependency_review_full", "dependency-review");
const dependencyReviewGate = jobSection("dependency-review");

test("every Node test file is included in required CI and the local quality workflow", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const localQualitySurface = `${recipes}\n${windowsQualificationRunner}`;
  const files = (await readdir(new URL(".", import.meta.url))).filter((name) =>
    name.endsWith(".test.mjs"),
  );
  for (const file of files) {
    assert.ok(requiredCiSurface.includes(`scripts/${file}`), `${file} is absent from required CI`);
    assert.ok(
      localQualitySurface.includes(`scripts/${file}`),
      `${file} is absent from local quality checks`,
    );
  }
});

test("application release records run after the maintained SemVer dependency is installed", () => {
  const installation = frontend.indexOf("pnpm install --frozen-lockfile");
  const selection = frontend.indexOf("scripts/select-release-channel.test.mjs");
  const coordinator = frontend.indexOf("scripts/release-coordinator.test.mjs");
  const reconstruction = frontend.indexOf(
    "scripts/reconstruct-application-update-records.test.mjs",
  );
  assert.ok(installation >= 0 && selection > installation);
  assert.ok(coordinator > installation);
  assert.ok(reconstruction > installation);
  assert.ok(!catalog.includes("scripts/select-release-channel.test.mjs"));
  assert.ok(!catalog.includes("scripts/release-coordinator.test.mjs"));
  assert.ok(!catalog.includes("scripts/reconstruct-application-update-records.test.mjs"));
});

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    workflow,
    /^concurrency:\r?\n {2}group: ci-\$\{\{ inputs\.force_qualification && format\('qualification-\{0\}', github\.ref\) \|\| github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n {2}cancel-in-progress: \$\{\{ !inputs\.force_qualification \}\}$/m,
  );
  for (const section of [
    rustTests,
    rustWorkspaceTests,
    rustClippy,
    windowsStorage,
    nativeRust,
    intelBuild,
    intelTests,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ]) {
    assert.notEqual(section, "");
    assert.match(section, /^ {4}needs: (?:classify|\[classify, intel_build\])$/m);
    assert.match(section, /^ {4}if: .*classify\.outputs\.mode == 'qualification'$/m);
  }
  assert.match(classify, /fetch-depth: 0/);
  assert.match(classify, /node scripts\/select-ci-plan\.mjs/);
  assert.match(classify, /PORTCOVE_PROSE_POLICY_ACTIVATED: "true"/);
  assert.match(classify, /PORTCOVE_FAST_VALIDATION_ACTIVATED: "true"/);
  assert.match(provenance, /node scripts\/workflow-provenance\.mjs/);
  assert.match(provenance, /--observed-toolchains node/);
  assert.doesNotMatch(provenance, /pnpm\/action-setup|\.\/\.github\/actions\/setup-rust/);
  assert.match(
    provenance,
    /workflow-provenance-\$\{\{ inputs\.provenance_scope \|\| 'ci' \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(provenance, /retention-days: 7/);
  assert.match(
    rustQualityGate,
    /\[classify, provenance, prose_checks, fast_rust_quality, fast_platform, rust_quality_full\]/,
  );
  assert.match(rustQualityGate, /PORTCOVE_ALWAYS_RESULTS: '\{"provenance"/);
  assert.match(proseChecks, /^ {4}if: needs\.classify\.outputs\.mode == 'prose'$/m);
  assert.match(proseChecks, /pnpm install --frozen-lockfile/);
  assert.match(proseChecks, /scripts\/repository-settings\.test\.mjs/);
  assert.match(proseChecks, /scripts\/repository-skills\.test\.mjs/);
  assert.match(proseChecks, /node scripts\/check-ci-prose\.mjs/);
  for (const gate of [rust, rustQualityGate, frontendGate, catalogGate, dependencyReviewGate]) {
    assert.match(gate, /node scripts\/ci-result-gate\.mjs/);
    assert.match(gate, /PORTCOVE_CLASSIFIER_RESULT/);
    assert.match(gate, /PORTCOVE_PROSE_RESULT/);
    assert.match(gate, /PORTCOVE_PLAN_JSON/);
    assert.match(gate, /PORTCOVE_FAST_RESULTS/);
    assert.match(gate, /PORTCOVE_TARGETED_RESULTS/);
    assert.match(gate, /PORTCOVE_QUALIFICATION_RESULTS/);
  }
  for (const fast of [fastRust, fastRustQuality, fastFrontend, fastCatalog]) {
    assert.match(fast, /mode == 'fast'/);
    assert.match(fast, /runs-on: ubuntu-22\.04/);
  }
  assert.match(fastPlatform, /mode == 'fast'/);
  assert.match(fastPlatform, /platform_matrix_json/);
  assert.match(fastPlatform, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(fastPlatform, /cargo nextest run --locked --workspace/);
  assert.match(fastRustQuality, /actions\/setup-node@/);
  assert.match(fastRustQuality, /pnpm install --frozen-lockfile/);
  assert.match(fastRustQuality, /run-oxfmt\.mjs --check/);
  assert.match(fastRustQuality, /lint:oxlint/);
  assert.match(fastRust, /key: fast-rust-tests-/);
  assert.match(fastRustQuality, /key: fast-rust-quality-/);
  assert.match(fastDependencyReview, /actions\/dependency-review-action@/);
  assert.match(fastDependencyReview, /base-ref:/);
  assert.match(fastDependencyReview, /head-ref:/);
});

test("fast plans give Oxfmt and Oxlint one job owner", () => {
  const repositoryLintStep = fastRustQuality.match(
    /- name: Check repository formatting and JavaScript lint\r?\n([\s\S]*?)(?=^ {6}- name:)/m,
  )?.[1];
  assert.ok(repositoryLintStep, "fast Rust quality must retain repository formatting and lint");
  assert.match(
    repositoryLintStep,
    /if: \$\{\{ !contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'frontend'\) \}\}/,
  );
  assert.match(repositoryLintStep, /run-oxfmt\.mjs --check/);
  assert.match(repositoryLintStep, /pnpm --dir apps\/desktop lint:oxlint/);
  assert.equal(fastRustQuality.match(/run-oxfmt\.mjs --check/gu)?.length, 1);
  assert.equal(fastRustQuality.match(/lint:oxlint/gu)?.length, 1);
  assert.equal(fastFrontend.match(/pnpm format:check/gu)?.length, 1);
  assert.equal(fastFrontend.match(/pnpm lint/gu)?.length, 1);
  assert.equal(fastFrontend.match(/run-fallow\.mjs/gu)?.length, 1);
  assert.ok(fastFrontend.indexOf("run-fallow.mjs") < fastFrontend.indexOf("pnpm build"));
});

test("reusable qualification is read-only, daily, and coalesces without cancelling", () => {
  assert.match(qualificationWorkflow, /^ {2}workflow_call:\r?$/m);
  assert.match(qualificationWorkflow, /^ {2}workflow_dispatch:\r?$/m);
  assert.match(qualificationWorkflow, /cron: "17 5 \* \* \*"/);
  assert.match(qualificationWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    qualificationWorkflow,
    /^concurrency:\r?\n {2}group: portcove-qualification-.*\r?\n {2}cancel-in-progress: false$/m,
  );
  assert.match(qualificationWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(qualificationWorkflow, /force_qualification: true/);
  assert.match(qualificationWorkflow, /jobs\.qualify\.outputs\.plan_digest/);
  assert.match(qualificationWorkflow, /provenance_scope:/);
  assert.doesNotMatch(qualificationWorkflow, /secrets:|pull_request_target|contents: write/);
  assert.match(workflow, /^ {2}workflow_call:\r?$/m);
});

test("Linux desktop prerequisite installation is shared, bounded, and retrying", async () => {
  const deepQuality = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const updaterRehearsal = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const packageOwnershipRehearsal = await readFile(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const installer = await readFile(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
    "utf8",
  );
  const invocation =
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/g;

  assert.equal((workflow.match(invocation) ?? []).length, 6);
  assert.equal((deepQuality.match(invocation) ?? []).length, 1);
  assert.equal((release.match(invocation) ?? []).length, 2);
  assert.match(
    updaterRehearsal,
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm --include-appimage-runtime/,
  );
  assert.match(
    updaterRehearsal,
    /linux_runner:\r?\n\s+description: [^\r\n]+\r?\n\s+type: choice\r?\n\s+default: ubuntu-22\.04\r?\n\s+options: \[ubuntu-22\.04, ubuntu-24\.04\]/,
  );
  assert.match(
    updaterRehearsal,
    /runs-on: \$\{\{ matrix\.label == 'linux-x86_64' && inputs\.linux_runner \|\| fromJSON\('[^']+'\)\[matrix\.label\] \}\}/,
  );
  assert.match(updaterRehearsal, /work\/updater-rehearsal\/linux-host-baseline\.txt/g);
  assert.match(
    packageOwnershipRehearsal,
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm/,
  );
  for (const hostedWorkflow of [
    workflow,
    deepQuality,
    release,
    updaterRehearsal,
    packageOwnershipRehearsal,
  ]) {
    assert.doesNotMatch(hostedWorkflow, /sudo apt-get/);
  }
  for (const packageName of [
    "libwebkit2gtk-4.1-dev",
    "libappindicator3-dev",
    "librsvg2-dev",
    "patchelf",
    "libfuse2",
    "xvfb",
    "dbus-x11",
    "at-spi2-core",
    "util-linux",
  ]) {
    assert.ok(installer.includes(packageName), `${packageName} is missing`);
  }
  assert.match(installer, /Acquire::http::Timeout=30/);
  assert.match(installer, /Acquire::https::Timeout=30/);
  assert.match(installer, /Acquire::Retries=3/);
  assert.match(installer, /DPkg::Lock::Timeout=60/);
  assert.match(installer, /archive\.ubuntu\.com\/ubuntu/);
  assert.match(installer, /Dir::Etc::sourceparts=-/);
  assert.match(installer, /DEBIAN_FRONTEND=noninteractive/);
  assert.match(installer, /timeout --kill-after=10s/);
  assert.match(installer, /sudo -n true/);
  assert.match(installer, /privilege=\(sudo -n\)/);
  assert.match(installer, /"\$\{privilege\[@\]\}" timeout --kill-after=10s "\$deadline" env/);
  assert.doesNotMatch(installer, /timeout[^\n]*"\$\{privilege\[@\]\}"/);
  assert.match(installer, /install_from_current_mirror "the runner-configured mirror" 2m 3m/);
  assert.match(installer, /install_from_current_mirror "the archive mirror fallback" 4m 5m/);
  assert.ok(
    installer.indexOf('"the runner-configured mirror"') <
      installer.indexOf("archive.ubuntu.com/ubuntu"),
  );
  assert.match(installer, /--include-rpm\) packages\+=\(rpm\)/);
  assert.match(installer, /VERSION_ID:-} == 24\.04[\s\S]*fuse_package=libfuse2t64/);
  assert.match(installer, /--include-appimage-runtime\) packages\+=\("\$fuse_package"/);
  assert.match(installer, /usage: \$0 \[--include-rpm\]/);
});

test("Linux package ownership rehearsal is focused and preserves managed executables", async () => {
  const rehearsal = await readFile(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const qualification = await readFile(
    new URL("./test-linux-package-ownership.sh", import.meta.url),
    "utf8",
  );

  assert.match(rehearsal, /^on:\r?\n {2}pull_request:\r?\n {4}paths:/m);
  assert.match(rehearsal, /^ {2}workflow_dispatch:$/m);
  for (const governedPath of [
    "apps/desktop/src-tauri/src/application_update_linux.rs",
    "apps/desktop/src-tauri/src/application_update_recovery.rs",
    "apps/desktop/src-tauri/tauri.conf.json",
    "scripts/test-linux-package-ownership.sh",
  ]) {
    assert.ok(rehearsal.includes(`- ${governedPath}`));
  }
  assert.match(rehearsal, /runs-on: ubuntu-22\.04/);
  assert.match(rehearsal, /container: fedora:42/);
  assert.match(
    rehearsal,
    /PORTCOVE_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.equal(rehearsal.match(/ref: \$\{\{ env\.PORTCOVE_SOURCE_COMMIT \}\}/g)?.length, 3);
  assert.match(rehearsal, /pnpm tauri build --bundles deb,rpm --ci/);
  assert.match(rehearsal, /actions\/download-artifact@/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh deb/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh rpm/);
  assert.match(rehearsal, /dnf --assumeyes install findutils git nodejs rpm/);
  assert.match(
    rehearsal,
    /Install Fedora qualification tools[\s\S]*actions\/checkout@[\s\S]*Verify installed RPM ownership guidance/,
  );
  assert.doesNotMatch(rehearsal, /appimage|desktop-test|e2e/iu);
  assert.match(rehearsal, /\.\/scripts\/test-linux-package-ownership\.sh/);
  assert.match(rehearsal, /retention-days: 1/);

  assert.match(qualification, /env -u APPIMAGE -u APPDIR -u DISPLAY/);
  assert.match(qualification, /--application-update-recovery eligibility/);
  assert.match(qualification, /dpkg-query --search/);
  assert.match(qualification, /rpm --query --queryformat .* --file/);
  assert.match(qualification, /dnf --assumeyes install/);
  assert.match(qualification, /\$format-owners\.txt/);
  assert.match(qualification, /hash_before.*hash_after/s);
  assert.match(
    qualification,
    /git -c safe\.directory="\$repo_root" -C "\$repo_root" rev-parse HEAD/,
  );
  assert.doesNotMatch(qualification, /safe\.directory=(?:"?\*)/);
  assert.match(qualification, /checkout_commit.*PORTCOVE_SOURCE_COMMIT/s);
  assert.match(qualification, /package_managed_files_unchanged: true/);
});

test("Rust setup installs the repository pin instead of an unrelated stable toolchain", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  assert.doesNotMatch(workflow, /uses: dtolnay\/rust-toolchain/);
  for (const section of [
    rustTests,
    rustWorkspaceTests,
    rustClippy,
    nativeRust,
    intelBuild,
    intelTests,
    rustDocs,
    rustQuality,
  ]) {
    assert.match(section, /uses: \.\/\.github\/actions\/setup-rust/);
  }
  assert.match(setup, /node scripts\/run-rust-tests\.mjs --prepare-only/);
  assert.match(setup, /Record exact Rust toolchain and job context/);
  assert.match(setup, /rustc --version --verbose/);
  assert.match(setup, /cargo --version/);
  assert.match(setup, /github\.run_attempt/);
  assert.match(setup, /github\.sha/);
  assert.match(setup, /IsNullOrWhiteSpace\(\$env:PORTCOVE_TARGETS\)/);
  assert.match(setup, /host only/);
  assert.match(setup, /Cache state is not inferred from the attempt number/);
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelTests, rustQuality]) {
    assert.match(section, /test-fixtures: true/);
  }
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /node scripts\/run-rust-tests\.mjs --locked --workspace/);
});

test("release and rehearsal Rust callers preserve repository pin, components, targets and caches", async (t) => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const toolchain = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
  const components = JSON.parse(toolchain.match(/^components\s*=\s*(\[[^\n]+\])/m)?.[1]);
  assert.deepEqual(components.toSorted(), ["clippy", "rust-analyzer", "rustfmt"]);
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  // Ordinary shims honor the TOML's component requirements before reporting identity.
  assert.match(setup, /& rustc --version --verbose/);
  assert.match(setup, /& cargo --version/);
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
  assert.doesNotMatch(toolchain, /^targets\s*=/m);

  function job(source, name) {
    const section = source.match(
      new RegExp(`^ {2}${name}:\\r?\\n([\\s\\S]*?)(?=^ {2}\\S|$(?![\\s\\S]))`, "m"),
    )?.[1];
    assert.ok(section, `missing ${name} job`);
    return section;
  }

  function steps(source, reference) {
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      source.match(new RegExp(`^ {6}- uses: ${escaped}\\r?\\n(?: {8}[^\\r\\n]*\\r?\\n)*`, "gm")) ??
      []
    );
  }

  function assertHostSetup(section, cacheKey) {
    assert.deepEqual(steps(section, "./.github/actions/setup-rust"), [
      "      - uses: ./.github/actions/setup-rust\n",
    ]);
    assert.doesNotMatch(
      section,
      /dtolnay\/rust-toolchain|RUSTUP_TOOLCHAIN|(?:rustc|cargo) \+|rustup (?:default|override|toolchain|component|target)/,
    );
    const cache = steps(
      section,
      "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
    );
    assert.deepEqual(cache, [
      "      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n" +
        (cacheKey ? `        with:\n          key: ${cacheKey}\n` : ""),
    ]);
    assert.ok(
      section.indexOf("uses: ./.github/actions/setup-rust") <
        section.indexOf("uses: Swatinem/rust-cache@"),
    );
  }

  for (const [file, name, cacheKey] of [
    ["release.yml", "validate", undefined],
    ["linux-package-ownership-rehearsal.yml", "build", "linux-package-ownership-rehearsal"],
    ["updater-artifact-rehearsal.yml", "packages", "updater-artifact-rehearsal"],
  ]) {
    await t.test(`${file} ${name}`, async () => {
      const source = await readFile(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      const section = job(source, name);
      assertHostSetup(section, cacheKey);
      for (const replacement of [
        "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          toolchain: stable\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          targets: aarch64-unknown-linux-gnu\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          test-fixtures: true\n",
      ]) {
        assert.throws(() =>
          assertHostSetup(
            section.replace("      - uses: ./.github/actions/setup-rust\n", replacement),
            cacheKey,
          ),
        );
      }
      assert.throws(() =>
        assertHostSetup(
          section.replace(
            "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6",
            "Swatinem/rust-cache@floating",
          ),
          cacheKey,
        ),
      );
      if (cacheKey)
        assert.throws(() =>
          assertHostSetup(section.replace(`key: ${cacheKey}`, "key: changed"), cacheKey),
        );
      if (file === "release.yml") {
        for (const [crossJob, target, key] of [
          ["build", "${{ matrix.target }}", "release-${{ matrix.label }}"],
          ["build_intel", "x86_64-apple-darwin", "release-macos-x86_64"],
        ]) {
          const cross = job(source, crossJob);
          assert.deepEqual(steps(cross, "./.github/actions/setup-rust"), [
            `      - uses: ./.github/actions/setup-rust\n        with:\n          targets: ${target}\n`,
          ]);
          assert.match(
            cross,
            new RegExp(`shared-key: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          );
        }
      }
    });
  }
});

test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.match(rustTests, /^ {4}name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  assert.match(
    rustTests,
    /shard:\s*\[\s*core-service-1,\s*core-service-2,\s*core-recovery,\s*core-other-1,\s*core-other-2,?\s*\]/,
  );
  for (const shard of [
    "service::",
    "cancellation::",
    "database::",
    "import_execution::",
    "library_move::",
  ]) {
    assert.match(rustTests, new RegExp(`"${shard.replaceAll("::", "::")}"`));
  }
  assert.match(
    rustTests,
    /"--skip", "service::", "--skip", "cancellation::", "--skip", "database::", "--skip", "import_execution::", "--skip", "library_move::"/,
  );
  assert.equal((rustTests.match(/"hash:1\/2"/g) ?? []).length, 2);
  assert.equal((rustTests.match(/"hash:2\/2"/g) ?? []).length, 2);
  assert.doesNotMatch(rustTests, /workspace-other|pnpm|cargo check|cargo fmt|cargo clippy/);

  assert.match(rustWorkspaceTests, /^ {4}name: rust-test \(workspace-other\)$/m);
  assert.match(rustWorkspaceTests, /runs-on: windows-latest/);
  assert.match(
    rustWorkspaceTests,
    /cargo nextest run --locked --workspace --exclude portcove-core/,
  );
  assert.doesNotMatch(rustWorkspaceTests, /matrix|cargo fmt|cargo clippy/);

  assert.match(rustClippy, /^ {4}name: rust-clippy$/m);
  assert.match(rustClippy, /runs-on: windows-latest/);
  assert.match(rustClippy, /cargo fmt --all -- --check/);
  assert.match(rustClippy, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(rustClippy, /cargo test|matrix/);

  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /cargo clippy --workspace --all-targets -- -D warnings/);

  assert.match(windowsStorage, /^ {4}name: windows-storage$/m);
  assert.match(windowsStorage, /runs-on: windows-latest/);
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mjs/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.match(windowsStorage, /scripts\/windows-qualification-session\.test\.mjs/);
  assert.match(windowsStorage, /\.\/scripts\/run-windows-qualification\.ps1/);
  assert.match(
    windowsStorage,
    /--test-timeout=30000 --test-reporter=\.\/scripts\/test-duration-reporter\.mjs/,
  );
  assert.match(
    windowsStorage,
    /Install-PSResource -RequiredResourceFile \.config\/powershell-resources\.psd1 -Scope CurrentUser -TrustRepository/,
  );
  assert.match(windowsStorage, /run-powershell-lint\.mjs/);
  assert.match(windowsStorage, /lint-tools\.integration\.mjs psscriptanalyzer/);
  assert.doesNotMatch(windowsStorage, /rust-toolchain|rust-cache|cargo/);
  assert.doesNotMatch(windowsStorage, /continue-on-error/);

  assert.match(rust, /^ {4}if: always\(\)$/m);
  for (const dependency of [
    "classify",
    "prose_checks",
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.match(rust, new RegExp(`^ {8}${dependency},?$`, "m"));
  for (const dependency of [
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.ok(rust.includes(`"${dependency}":"` + "${{ needs." + dependency + '.result }}"'));
  assert.doesNotMatch(rust, /continue-on-error/);
});

test("Windows fixture setup selects runner-owned temporary storage before compilation", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const selection = setup.indexOf("name: Select Windows test temporary storage");
  assert.ok(selection >= 0 && selection < setup.indexOf("name: Read repository toolchain"));
  assert.match(setup, /if: runner\.os == 'Windows' && inputs\.test-fixtures == 'true'/);
  assert.match(windowsStorage, /scripts\/ci-workflow\.test\.mjs/);
});

test(
  "Windows fixture setup exports a usable directory and rejects invalid roots without partial exports",
  { skip: process.platform !== "win32" },
  async () => {
    const { mkdtemp, mkdir, writeFile, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const setup = await readFile(
      new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
      "utf8",
    );
    const body = setup.match(
      /- name: Select Windows test temporary storage[\s\S]*?run: \|\r?\n([\s\S]*?)(?= {4}- name:)/,
    )?.[1];
    assert.ok(body);
    const script = body.replace(/^ {8}/gm, "");
    const base = path.resolve(tmpdir());
    const directory = await mkdtemp(path.join(base, "portcove-ci-temp-"));
    try {
      const selected = path.join(directory, "runner temporary files");
      const environmentFile = path.join(directory, "github-env");
      const notDirectory = path.join(directory, "file");
      await mkdir(selected);
      await writeFile(notDirectory, "fixture");
      const invoke = (command, env) =>
        spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
          env: { ...process.env, ...env },
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
      const selectedIdentity = await realpath(selected);
      for (const selectedPath of [selected, `${selected}${path.sep}.`]) {
        await writeFile(environmentFile, "");
        const result = invoke(script, {
          RUNNER_TEMP: selectedPath,
          GITHUB_ENV: environmentFile,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const exported = Object.fromEntries(
          (await readFile(environmentFile, "utf8"))
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const delimiter = line.indexOf("=");
              return [line.slice(0, delimiter), line.slice(delimiter + 1)];
            }),
        );
        assert.deepEqual(exported, {
          TEMP: selectedIdentity,
          TMP: selectedIdentity,
        });
        const consumer = invoke("[System.IO.Path]::GetTempPath()", exported);
        assert.ifError(consumer.error);
        assert.equal(consumer.status, 0, consumer.stderr);
        assert.equal(await realpath(consumer.stdout.trim()), selectedIdentity);
      }
      for (const invalid of [
        "",
        "relative",
        path.join(directory, "missing"),
        notDirectory,
        `${selected}\nUNEXPECTED=value`,
      ]) {
        await writeFile(environmentFile, "");
        const rejected = invoke(script, {
          RUNNER_TEMP: invalid,
          GITHUB_ENV: environmentFile,
        });
        assert.ifError(rejected.error);
        assert.notEqual(rejected.status, 0, `accepted invalid root ${JSON.stringify(invalid)}`);
        assert.equal(await readFile(environmentFile, "utf8"), "");
      }
    } finally {
      const relative = path.relative(base, directory);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Windows qualification serializes machine-global registry fixtures with a bounded lock", () => {
  const wrapper = windowsQualificationRunner;
  assert.match(wrapper, /Local\\Portcove\.WindowsQualification\.v1/);
  assert.match(wrapper, /WaitOne\(\[TimeSpan\]::FromSeconds\(\$WaitSeconds\)\)/);
  assert.match(wrapper, /AbandonedMutexException/);
  assert.match(wrapper, /finally \{[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/);
  assert.match(
    wrapper,
    /node --test scripts\/windows-qualification-session\.integration\.test\.mjs/,
  );
});

test("native Rust runs the full workspace on every supported Unix architecture", () => {
  assert.match(
    nativeRust,
    /^ {4}name: native-rust \(\$\{\{ matrix\.platform \}\}, \$\{\{ matrix\.partition \}\}\)$/m,
  );
  for (const [platform, runner] of [
    ["linux-x86_64", "ubuntu-22.04"],
    ["macos-aarch64", "macos-15"],
  ]) {
    assert.match(nativeRust, new RegExp(`platform: ${platform}\\r?\\n\\s+runner: ${runner}`));
  }
  assert.match(nativeRust, /if: runner\.os == 'Linux'/);
  assert.match(nativeRust, /echo "TMPDIR=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(nativeRust, /run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/);
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(nativeRust, /--partition "\$\{\{ matrix\.partition \}\}"/);
  assert.equal((nativeRust.match(/partition: hash:1\/1/g) ?? []).length, 2);
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

test("Intel tests build once and retries preserve their attempt-scoped producer chain", () => {
  assert.match(intelBuild, /runs-on: macos-15$/m);
  assert.match(intelBuild, /targets: x86_64-apple-darwin/);
  assert.match(
    intelBuild,
    /cargo nextest archive --locked --workspace --target x86_64-apple-darwin/,
  );
  assert.match(intelBuild, /if-no-files-found: error/);
  assert.match(intelBuild, /retention-days: 1/);
  assert.match(intelTests, /needs: \[classify, intel_build\]/);
  assert.match(intelTests, /runs-on: macos-15-intel/);
  assert.match(intelTests, /partition:\s*\[\s*"hash:1\/2",\s*"hash:2\/2",?\s*\]/);
  assert.match(
    intelTests,
    /cargo nextest run --archive-file .* --workspace-remap "\$PWD" --partition "\$\{\{ matrix\.partition \}\}"/,
  );
  for (const section of [intelBuild, intelTests]) {
    assert.match(section, /name: intel-rust-tests-\$\{\{ github\.run_attempt \}\}/);
    assert.doesNotMatch(section, /continue-on-error/);
  }
  assert.match(
    qualityGuide,
    /gh run rerun <run-id> --job <build-intel-tests-job-id> --repo boburning\/portcove/,
  );
  assert.match(qualityGuide, /Do not use .*--failed.*Intel consumer/u);
  assert.match(qualityGuide, /never reuse an\s+artifact from an earlier attempt/u);
  for (const job of ["intel_build", "intel_tests"])
    assert.ok(rust.includes(`"${job}":"` + "${{ needs." + job + '.result }}"'));
});

test("Linux Rust quality keeps its platform-specific and policy gates without pnpm", () => {
  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /AQUA_ENFORCE_CHECKSUM: "true"/);
  assert.match(rustQuality, /AQUA_ENFORCE_REQUIRE_CHECKSUM: "true"/);
  assert.match(rustQuality, /aquaproj\/aqua-installer@96a9bc20066c5bf5e275b41019cfc165b25f4e2e/);
  assert.match(rustQuality, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(rustQuality, /enable_aqua_install: "false"/);
  assert.doesNotMatch(
    rustQuality,
    /machine_contract|backup_directory_durability_support_is_explicit_for_the_host/,
  );
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(rustQuality, /cargo shear --deny-warnings/);
  assert.match(rustQuality, /cargo deny check/);
  assert.match(rustQuality, /check-rust-architecture\.mjs/);
  assert.match(rustQuality, /run-rscheck\.mjs/);
  const bootstrap = rustQuality.indexOf("./scripts/bootstrap-quality-tools.sh");
  for (const lint of ["aqua exec -- ruff", "aqua exec -- shellcheck", "run-actionlint.mjs"]) {
    assert.ok(
      rustQuality.indexOf(lint) > bootstrap,
      `${lint} must run after the aqua tools are installed`,
    );
  }
  assert.match(rustQuality, /lint-tools\.integration\.mjs ruff shellcheck actionlint/);
  const desktopPrerequisites = rustQuality.indexOf(
    "./scripts/install-linux-desktop-prerequisites.sh",
  );
  assert.ok(
    desktopPrerequisites >= 0 &&
      desktopPrerequisites < rustQuality.indexOf("node scripts/check-transport-contract.mjs"),
  );
  assert.match(rustQuality, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rustQuality, /pnpm\/action-setup|pnpm install/);
  assert.doesNotMatch(rustQuality, /continue-on-error/);
});

test("frontend keeps deterministic product gates and delegates vulnerability changes", () => {
  assert.match(frontend, /^ {4}env:\r?\n {6}npm_config_audit: "false"$/m);
  assert.match(frontend, /pnpm install --frozen-lockfile/);
  assert.match(frontend, /Install pinned recipe runner/);
  const install = frontend.indexOf("pnpm install --frozen-lockfile");
  const formatting = frontend.indexOf("pnpm --dir apps/desktop format:check");
  const lint = frontend.indexOf("pnpm lint");
  const build = frontend.indexOf("pnpm build");
  assert.ok(install >= 0 && formatting > install && lint > formatting && build > lint);
  assert.match(frontend, /lint-tools\.integration\.mjs oxfmt oxlint stylelint/);
  assert.match(
    frontend,
    /--test-name-pattern "pnpm uses\|direct just recipes" scripts\/dev-storage\.test\.mjs/,
  );
  assert.match(frontend, /pnpm build/);
  assert.match(frontend, /pnpm test/);
  assert.match(frontend, /run-fallow\.mjs/);
  assert.doesNotMatch(frontend, /pnpm audit/);
  assert.doesNotMatch(frontend, /continue-on-error/);

  assert.match(dependencyReview, /github\.event_name == 'pull_request'/);
  assert.match(dependencyReview, /dependency-review-action/);
  assert.match(dependencyReview, /fail-on-severity: high/);
});

test("both frontend lanes provision browser artifacts before running the bounded composition", () => {
  for (const [name, job] of [
    ["fast", fastFrontend],
    ["full", frontend],
  ]) {
    const install = job.indexOf("pnpm install --frozen-lockfile");
    const bootstrap = job.indexOf("pnpm browser:bootstrap");
    const browserTest = job.indexOf("pnpm test:browser");
    assert.ok(install >= 0 && bootstrap > install && browserTest > bootstrap, name);
    assert.match(job, new RegExp(`browser-traces-${name}-`));
    assert.match(job, /work\/browser-traces/);
    assert.match(job, /apps\/desktop\/\.vitest\/attachments/);
    assert.doesNotMatch(job, /pnpm test:browser:trace-probe/);
  }
});

test("frontend tooling uses the pinned Oxc contracts without legacy quality layers", async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  const repositoryPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(desktopPackage.scripts["format:oxfmt"], "node ../../scripts/run-oxfmt.mjs --write");
  assert.equal(desktopPackage.scripts["lint:oxlint"], "node ../../scripts/run-oxlint.mjs");
  assert.equal(repositoryPackage.devDependencies.oxfmt, "0.71.0");
  assert.equal(repositoryPackage.devDependencies.oxlint, "1.86.0");
  assert.equal(repositoryPackage.devDependencies["oxlint-tsgolint"], "7.0.2003");
  assert.equal(desktopPackage.devDependencies["oxc-parser"], "0.151.0");
  assert.equal(desktopPackage.devDependencies.typescript, "7.0.2");
  for (const retired of [
    "@babel/parser",
    "@eslint/js",
    "@typescript/native",
    "eslint",
    "eslint-plugin-jsx-a11y",
    "eslint-plugin-react-hooks",
    "globals",
    "prettier",
    "typescript-eslint",
  ]) {
    assert.equal(repositoryPackage.devDependencies[retired], undefined);
    assert.equal(desktopPackage.devDependencies[retired], undefined);
  }

  const oxlint = JSON.parse(await readFile(new URL("../.oxlintrc.json", import.meta.url), "utf8"));
  assert.deepEqual(oxlint.plugins, [
    "eslint",
    "typescript",
    "react",
    "jsx-a11y",
    "oxc",
    "import",
    "vitest",
  ]);
  assert.deepEqual(oxlint.options, {
    reportUnusedDisableDirectives: "error",
    typeAware: false,
    typeCheck: false,
  });
  assert.equal(oxlint.categories.correctness, "error");
  assert.equal(oxlint.categories.suspicious, "off");
  assert.equal(oxlint.rules["react/rules-of-hooks"], "error");
  assert.equal(oxlint.rules["react/refs"], "error");
  assert.equal(oxlint.rules["react/set-state-in-effect"], "error");
  assert.equal(oxlint.rules["vitest/require-mock-type-parameters"], "off");
  assert.deepEqual(oxlint.rules["vitest/valid-expect"], ["error", { maxArgs: 2 }]);
  for (const rule of [
    "alt-text",
    "anchor-has-content",
    "anchor-is-valid",
    "aria-activedescendant-has-tabindex",
    "aria-props",
    "aria-proptypes",
    "aria-role",
    "aria-unsupported-elements",
    "autocomplete-valid",
    "click-events-have-key-events",
    "heading-has-content",
    "html-has-lang",
    "iframe-has-title",
    "img-redundant-alt",
    "interactive-supports-focus",
    "label-has-associated-control",
    "media-has-caption",
    "mouse-events-have-key-events",
    "no-access-key",
    "no-autofocus",
    "no-distracting-elements",
    "no-interactive-element-to-noninteractive-role",
    "no-noninteractive-element-interactions",
    "no-noninteractive-element-to-interactive-role",
    "no-noninteractive-tabindex",
    "no-redundant-roles",
    "no-static-element-interactions",
    "role-has-required-aria-props",
    "role-supports-aria-props",
    "scope",
    "tabindex-no-positive",
  ]) {
    assert.equal(oxlint.rules[`jsx-a11y/${rule}`], "error");
  }
  assert.equal(oxlint.rules["jsx-a11y/prefer-tag-over-role"], "off");
  for (const rule of ["no-array-constructor", "no-unused-expressions", "no-unused-vars"]) {
    assert.equal(oxlint.rules[rule], "error");
  }
  for (const rule of [
    "await-thenable",
    "ban-ts-comment",
    "no-array-delete",
    "no-base-to-string",
    "no-duplicate-enum-values",
    "no-duplicate-type-constituents",
    "no-empty-object-type",
    "no-explicit-any",
    "no-extra-non-null-assertion",
    "no-floating-promises",
    "no-for-in-array",
    "no-implied-eval",
    "no-misused-new",
    "no-misused-promises",
    "no-namespace",
    "no-non-null-asserted-optional-chain",
    "no-redundant-type-constituents",
    "no-require-imports",
    "no-this-alias",
    "no-unnecessary-type-assertion",
    "no-unnecessary-type-constraint",
    "no-unsafe-argument",
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-declaration-merging",
    "no-unsafe-enum-comparison",
    "no-unsafe-function-type",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "no-unsafe-unary-minus",
    "no-wrapper-object-types",
    "only-throw-error",
    "prefer-as-const",
    "prefer-namespace-keyword",
    "prefer-promise-reject-errors",
    "require-await",
    "restrict-plus-operands",
    "restrict-template-expressions",
    "triple-slash-reference",
    "unbound-method",
  ]) {
    assert.equal(oxlint.rules[`typescript/${rule}`], "error");
  }
  const oxlintRunner = await readFile(new URL("./run-oxlint.mjs", import.meta.url), "utf8");
  assert.match(oxlintRunner, /sourceRoot/);
  assert.match(oxlintRunner, /viteConfig/);
  assert.match(oxlintRunner, /"--type-aware"/);
  assert.match(oxlintRunner, /report\.number_of_files < 1/);
  assert.match(oxlintRunner, /report\.number_of_rules < 1/);

  const copyChecker = await readFile(
    new URL("../apps/desktop/scripts/check-copy.mjs", import.meta.url),
    "utf8",
  );
  assert.match(copyChecker, /import \{ parseSync, visitorKeys \} from "oxc-parser"/);
  assert.doesNotMatch(copyChecker, /@babel\/parser/);

  const oxfmt = JSON.parse(await readFile(new URL("../.oxfmtrc.json", import.meta.url), "utf8"));
  assert.equal(oxfmt.printWidth, 100);
  assert.equal(oxfmt.sortImports, false);
  assert.equal(oxfmt.sortPackageJson, true);
  assert.ok(oxfmt.ignorePatterns.includes("**/*.toml"));

  const fallow = JSON.parse(
    await readFile(new URL("../apps/desktop/.fallowrc.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(fallow, {
    $schema: "../../node_modules/fallow/schema.json",
    entry: [
      "i18next.invalid.config.ts",
      "src/i18next-contract.test-d.ts",
      "src/i18next.d.ts",
      "vitest.browser.config.ts",
    ],
    boundaries: {
      zones: [
        { name: "shared", patterns: ["src/shared/**"] },
        { name: "features", patterns: ["src/features/**"] },
      ],
      rules: [{ from: "shared", allow: ["shared"], allowTypeOnly: [] }],
    },
  });

  for (const retired of [
    "../.prettierignore",
    "../prettier.config.mjs",
    "../eslint.config.mjs",
    "../apps/desktop/eslint.config.mjs",
    "./run-eslint.mjs",
  ]) {
    await assert.rejects(readFile(new URL(retired, import.meta.url)), { code: "ENOENT" });
  }
});

test("catalog executes the CI workflow contract", () => {
  assert.match(catalog, /scripts\/ci-workflow\.test\.mjs/);
  assert.match(fastCatalog, /scripts\/repository-settings\.test\.mjs/);
  assert.match(fastCatalog, /scripts\/repository-skills\.test\.mjs/);
  assert.match(fastCatalog, /scripts\/generate-catalog\.test\.mjs/);
  assert.match(fastCatalog, /scripts\/migrate-catalog-schema2\.test\.mjs/);
});

test("routine checks retain architecture enforcement but make cycles optional", async () => {
  assert.doesNotMatch(rustQuality, /cargo modules/);
  assert.match(rustQuality, /node scripts\/check-rust-architecture\.mjs/);
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(
    recipes,
    /^audit \*args:\r?\n\s+\{\{storage\}\} node scripts\/audit\.mjs \{\{args\}\}$/m,
  );
  assert.match(recipes, /^cycles:\r?\n.*cargo modules/m);
});

test("validation recipes separate routine, release, and packaged Windows contracts", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const routine = recipes.match(/^check: (.+)$/m)?.[1] ?? "";
  assert.match(
    routine,
    /check-rust check-ui script-lint repository-tools roadmap-check development-tools/,
  );
  assert.doesNotMatch(routine, /release-check|windows-qualification/);
  const release = recipes.match(/^release-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(release, /check-release-metadata\.test\.mjs/);
  assert.match(release, /release-package-policy\.test\.mjs/);
  assert.match(release, /updater-artifact-inventory\.test\.mjs/);
  assert.match(release, /reconstruct-application-update-records\.test\.mjs/);
  assert.match(release, /windows-qualification-session\.test\.mjs/);
  assert.doesNotMatch(release, /windows-qualification-session\.integration\.test\.mjs/);
  for (const generic of [
    "ci-workflow.test.mjs",
    "ci-health.test.mjs",
    "test-duration-reporter.test.mjs",
    "quality-tools.test.mjs",
    "repository-settings.test.mjs",
    "pr-conventions.test.mjs",
    "dev-storage.test.mjs",
  ])
    assert.doesNotMatch(release, new RegExp(generic.replaceAll(".", "\\.")));
  const windows = recipes.match(/^windows-qualification-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(windows, /process\.platform !== 'win32'/);
  assert.match(windows, /run-windows-qualification\.ps1/);
  assert.match(catalog, /check-release-metadata\.test\.mjs/);
  assert.match(catalog, /release-package-policy\.test\.mjs/);
  assert.match(windowsStorage, /run-windows-qualification\.ps1/);
  const ui = recipes.match(/^check-ui: (.+)$/m)?.[1] ?? "";
  assert.match(ui, /fmt-frontend-check ui-check ui-lint-contracts/);
  const auditUi = recipes.match(/^ui-check: (.+)$/m)?.[1] ?? "";
  assert.doesNotMatch(auditUi, /fmt-frontend-check/);
  const recipeBody = (name) =>
    recipes.match(new RegExp(`^${name}:\\r?\\n([\\s\\S]*?)(?=^\\S)`, "m"))?.[1] ?? "";
  for (const scan of [
    "fmt-frontend-check",
    "oxlint",
    "stylelint",
    "python-lint",
    "shell-lint",
    "actions-lint",
    "powershell-lint",
  ])
    assert.doesNotMatch(recipeBody(scan), /lint-tools\.integration\.mjs/);
  assert.match(
    recipeBody("ui-lint-contracts"),
    /lint-tools\.integration\.mjs oxfmt oxlint stylelint/,
  );
  assert.match(
    recipeBody("script-lint-contracts"),
    /lint-tools\.integration\.mjs ruff shellcheck actionlint psscriptanalyzer/,
  );
  assert.match(
    recipes.match(/^script-lint: (.+)$/m)?.[1] ?? "",
    /python-lint shell-lint actions-lint powershell-lint script-lint-contracts/,
  );
});

test("release and deep preflights require a fresh audit", async () => {
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const localPreflight = await readFile(
    new URL("./release-preflight.ps1", import.meta.url),
    "utf8",
  );
  assert.match(release, /just audit --fresh/);
  assert.match(release, /id: aqua-version/);
  assert.match(release, /aquaproj\/aqua-installer@96a9bc20066c5bf5e275b41019cfc165b25f4e2e/);
  assert.match(release, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(release, /enable_aqua_install: "false"/);
  assert.match(deep, /just audit --fresh/);
  assert.match(deep, /id: aqua-version/);
  assert.match(deep, /aquaproj\/aqua-installer@96a9bc20066c5bf5e275b41019cfc165b25f4e2e/);
  assert.match(deep, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(deep, /enable_aqua_install: "false"/);
  assert.match(localPreflight, /just audit --fresh/);
});

test("manual deep workflow retains only the deterministic fresh audit", async () => {
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(deep, /^name: Deep audit$/m);
  assert.match(deep, /^ {2}audit:\r?$/m);
  assert.match(deep, /just audit --fresh/);
  assert.doesNotMatch(deep, /^ {2}(?:hawk|duplicates):/m);
  assert.doesNotMatch(deep, /semdup|cargo-hawk|run-hawk|run-semdup|dead-public/i);
});

test("live upstream health has bounded independent triggers while catalog stays offline", async () => {
  assert.doesNotMatch(catalog, /check-catalog-repositories\.mjs/);
  assert.match(catalog, /check-retcomm-upstreams\.mjs --offline/);
  const health = await readFile(
    new URL("../.github/workflows/upstream-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(health, /schedule:\r?\n {4}- cron:/);
  assert.match(health, /workflow_dispatch:/);
  assert.match(health, /timeout-minutes: 10/);
  assert.match(health, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(health, /pull_request_target|continue-on-error/);
  for (const trigger of ["pull_request", "push"]) {
    const section = health.split(`  ${trigger}:`)[1].split(/^ {2}\w+:/m)[0];
    for (const path of [
      "crates/portcove-core/catalog/**",
      "scripts/retcomm-psx-upstreams.json",
      "scripts/check-catalog-repositories.mjs",
      "scripts/check-retcomm-upstreams.mjs",
      ".node-version",
      ".github/workflows/upstream-health.yml",
    ]) {
      assert.ok(
        section.includes(`'${path}'`) || section.includes(`"${path}"`),
        `${trigger} must cover ${path}`,
      );
    }
  }
  assert.match(health, /run: node scripts\/check-catalog-repositories\.mjs/);
  assert.match(health, /run: node scripts\/check-retcomm-upstreams\.mjs\r?$/m);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
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
    await mkdir(join(root, "crates/portcove-core/catalog"), {
      recursive: true,
    });
    const checker = join(root, "scripts/check-retcomm-upstreams.mjs");
    await copyFile(new URL("./check-retcomm-upstreams.mjs", import.meta.url), checker);
    const preload = join(root, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
    const port = {
      id: "fixture",
      adapter: "psx-recomp-managed",
      release: { repository: "owner/game" },
    };
    const catalogFile = join(root, "crates/portcove-core/catalog/catalog.json");
    await writeFile(catalogFile, JSON.stringify({ ports: [port] }));
    const mappingFile = join(root, "scripts/retcomm-psx-upstreams.json");
    const run = (...args) =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, checker, ...args], {
        encoding: "utf8",
        env: { ...process.env, RETCOMM_CATALOG_DIR: "" },
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

test("Rust reports slow tests, terminates hangs and retains documentation coverage", async () => {
  const config = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  assert.match(
    config,
    /slow-timeout = \{ period = "5s", terminate-after = 6, grace-period = "0s" \}/,
  );
  assert.match(config, /^retries = 0$/m);
  assert.doesNotMatch(config, /on-timeout|default-filter/);
  assert.match(
    config,
    /filter = 'package\(portcove-cli\)'\r?\nthreads-required = 2\r?\npriority = -100/,
  );
  assert.match(
    config,
    /filter = 'package\(portcove-core\) & test\(output_relocation::tests::\)'\r?\nthreads-required = 2/,
  );
  assert.match(
    config,
    /filter = 'package\(portcove-core\) & test\(cancellation::tests::\)'\r?\nthreads-required = 2/,
  );
  assert.match(
    config,
    /filter = 'package\(portcove-core\) & test\(activity_diagnostics::tests::\)'\r?\nthreads-required = 2\r?\npriority = -50/,
  );
  assert.match(
    config,
    /filter = 'package\(portcove-core\) & test\(database::tests::\)'\r?\nthreads-required = 2/,
  );
  assert.match(
    config,
    /filter = 'package\(portcove-core\) & test\(adapter::source_conversion_tests::failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes\)'\r?\nthreads-required = 2/,
  );
  for (const override of config.split("[[profile.default.overrides]]").slice(1)) {
    assert.doesNotMatch(override, /slow-timeout|retries/);
  }
  assert.match(rustTests, /cargo nextest run --locked @Arguments/);
  assert.doesNotMatch(rustTests + rustWorkspaceTests, /--test-threads 1/);
  assert.match(config, /^test-threads = 2$/m);
  assert.match(rustDocs, /cargo test --locked --workspace --doc/);
  for (const platform of ["windows-x86_64", "linux-x86_64", "macos-x86_64", "macos-aarch64"]) {
    assert.ok(rustDocs.includes(`platform: ${platform}`));
  }
  assert.ok(rust.includes(`"rust_docs":"` + '${{ needs.rust_docs.result }}"'));
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelBuild, intelTests]) {
    assert.match(section, /Install pinned test runner/);
    assert.match(section, /Get-Content \.github\/quality-tools\.json/);
    assert.match(section, /Where-Object id -eq "cargo-nextest"/);
  }
  assert.doesNotMatch(rustQuality, /cargo nextest run/);
  assert.match(workflow, /CARGO_PROFILE_TEST_DEBUG: line-tables-only/);
  assert.match(workflow, /CARGO_PROFILE_DEV_DEBUG: line-tables-only/);
});

test("deep audit summary retains audit status without artifacts or privilege changes", async () => {
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(deep, /id: fresh-audit/);
  assert.match(deep, /just audit --fresh\r?\n {10}audit_status=\$\?/);
  assert.match(deep, /exit "\$audit_status"/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mjs --start/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mjs --finish "\$audit_status"/);
  assert.match(deep, /name: Summarize structured audit evidence\r?\n {8}if: always\(\)/);
  assert.match(deep, /AUDIT_OUTCOME: \$\{\{ steps\.fresh-audit\.outcome \}\}/);
  assert.match(deep, /AUDIT_EXIT_CODE: \$\{\{ steps\.fresh-audit\.outputs\.exit_code \}\}/);
  assert.match(
    deep,
    /run: node scripts\/deep-audit-summary\.mjs \|\| echo "Structured audit evidence unavailable"/,
  );
  assert.match(deep, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(deep, /upload-artifact|continue-on-error|secrets:|schedule:|tee /);
});

const auditSummarySource = "a".repeat(40);
const identity = {
  source: auditSummarySource,
  workflowSha: auditSummarySource,
  workflowDigest: "b".repeat(64),
  workflowRef: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/main",
  run: "12",
  attempt: "2",
  outcome: "success",
  exitCode: "0",
  started: "1700000000",
};
function fixture() {
  return {
    format: 1,
    kind: "audit-run",
    profile: "complete",
    head: auditSummarySource,
    success: true,
    completedAt: "2023-11-14T22:13:21Z",
    stages: AUDIT_STAGES.filter((stage) => !stage.platforms).map((stage) => ({
      id: stage.id,
      recipe: stage.recipe,
      originatingHead: auditSummarySource,
      status: "passed",
      durationMs: 123,
      rationale: "secret diagnostic /private/path",
    })),
  };
}
test("complete fresh success publishes bounded identities and stage results only", () => {
  const text = renderDeepAuditSummary(receiptEnvelope(fixture()), identity, binding(fixture()));
  assert.match(text, /Complete fresh audit receipt: passed/);
  assert.match(text, /Run: 12; attempt: 2/);
  assert.match(text, /\| rust \| passed \| 123 \| 0 \|/);
  assert.doesNotMatch(text, /secret diagnostic|private\/path|rationale/);
  assert.ok(text.length < 4096);
});
test("failed full audit retains actual stage failure and exit status", () => {
  const payload = fixture();
  payload.success = false;
  Object.assign(payload.stages[1], { status: "failed", exitCode: 2 });
  const text = renderDeepAuditSummary(
    receiptEnvelope(payload),
    {
      ...identity,
      outcome: "failure",
      exitCode: "1",
    },
    { ...binding(payload), exitCode: "1" },
  );
  assert.match(text, /receipt: failed/);
  assert.match(text, /\| rust \| failed \| 123 \| 2 \|/);
  assert.match(text, /Recorded audit exit status: 1/);
});
for (const [name, mutate] of [
  [
    "wrong source",
    (p) => {
      p.head = "c".repeat(40);
    },
  ],
  [
    "stale receipt",
    (p) => {
      p.completedAt = "2023-11-14T22:13:19Z";
    },
  ],
  [
    "partial profile",
    (p) => {
      p.profile = "transition";
    },
  ],
  [
    "missing stage",
    (p) => {
      p.stages.pop();
    },
  ],
  [
    "duplicate stage",
    (p) => {
      p.stages[1] = p.stages[0];
    },
  ],
  [
    "reused stage",
    (p) => {
      p.stages[1].status = "reused";
    },
  ],
  [
    "foreign stage source",
    (p) => {
      p.stages[1].originatingHead = "c".repeat(40);
    },
  ],
  [
    "injected label",
    (p) => {
      p.stages[1].id = "rust\nsecret";
    },
  ],
  [
    "invalid duration",
    (p) => {
      p.stages[1].durationMs = -1;
    },
  ],
  [
    "false success",
    (p) => {
      p.success = false;
    },
  ],
])
  test(`${name} never establishes coverage or success`, () => {
    const payload = fixture();
    mutate(payload);
    const text = renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload));
    assert.match(text, /unavailable or invalid/);
    assert.doesNotMatch(text, /receipt: passed|\| rust/);
  });
test("missing, corrupt, cancelled and unavailable exit receipts never pass", () => {
  for (const receipt of [undefined, {}, { ...receiptEnvelope(fixture()), integrity: "bad" }]) {
    assert.match(renderDeepAuditSummary(receipt, identity), /unavailable or invalid/);
  }
  for (const patch of [{ outcome: "cancelled" }, { exitCode: "" }, { exitCode: "1" }]) {
    assert.match(
      renderDeepAuditSummary(receiptEnvelope(fixture()), { ...identity, ...patch }),
      /unavailable or invalid/,
    );
  }
});
test("invalid identity cannot inject public output", () => {
  for (const key of [
    "source",
    "workflowSha",
    "workflowDigest",
    "workflowRef",
    "run",
    "attempt",
    "outcome",
  ]) {
    const text = renderDeepAuditSummary(receiptEnvelope(fixture()), {
      ...identity,
      [key]: "secret\n<script>",
    });
    assert.match(text, /Identity unavailable or invalid/);
    assert.doesNotMatch(text, /secret|script>/);
  }
});

function binding(payload) {
  return {
    ...identity,
    startedMs: 1700000000000,
    completedMs: 1700000002000,
    receiptIntegrity: receiptEnvelope(payload).integrity,
  };
}

test("deep audit rejects another attempt, missing completion and future receipt", () => {
  const payload = fixture();
  for (const patch of [
    { attempt: "1" },
    { run: "11" },
    { workflowSha: "c".repeat(40) },
    { workflowDigest: "c".repeat(64) },
    { completedMs: undefined },
    { receiptIntegrity: "bad" },
  ]) {
    assert.match(
      renderDeepAuditSummary(receiptEnvelope(payload), identity, { ...binding(payload), ...patch }),
      /unavailable or invalid/,
    );
  }
  payload.completedAt = "2023-11-14T22:13:23Z";
  assert.match(
    renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload)),
    /unavailable or invalid/,
  );
});

test("real evidence bytes round-trip through timestamped job logs without exporting library or profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-evidence-"));
  try {
    const source = path.join(root, "source");
    const native = path.join(source, "desktop-verify", "one-run", "native");
    await mkdir(path.join(native, "library"), { recursive: true });
    await mkdir(path.join(native, "webview"));
    await writeFile(path.join(source, "host.json"), '{"revision":"owned"}');
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 23]);
    await writeFile(path.join(native, "success.png"), image);
    await writeFile(path.join(native, "evidence.json"), '{"outcome":"failed"}');
    await writeFile(path.join(native, "library", "private.json"), "never-export");
    await writeFile(path.join(native, "webview", "profile.json"), "never-export");
    await writeFile(path.join(native, "session-startup-0.jsonl"), '{"owned_process":"identity"}\n');
    const encoded = await encodeBackupEvidence(source);
    const log = encoded
      .split("\n")
      .map((line) => `2026-10-01T00:00:00Z ${line}`)
      .join("\n");
    const recovered = path.join(root, "recovered");
    const names = await recoverBackupEvidence(log, recovered);
    assert.equal(names.length, 4);
    assert.ok(!names.some((name) => /library|webview/.test(name)));
    assert.deepEqual(
      await readFile(path.join(recovered, "desktop-verify/one-run/native/success.png")),
      image,
    );
    assert.equal(
      await readFile(path.join(recovered, "desktop-verify/one-run/native/evidence.json"), "utf8"),
      '{"outcome":"failed"}',
    );
    await assert.rejects(recoverBackupEvidence(log, recovered), /EEXIST/);
    await assert.rejects(
      recoverBackupEvidence(encoded + "\n" + encoded, path.join(root, "duplicate")),
      /Incomplete/,
    );
    await assert.rejects(
      recoverBackupEvidence(
        encoded.replace(/ [a-f0-9]{64} /, ` ${"0".repeat(64)} `),
        path.join(root, "corrupt"),
      ),
      /hash mismatch/,
    );
    await assert.rejects(
      recoverBackupEvidence("no retained evidence", path.join(root, "missing")),
      /Missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export refuses links and oversized evidence instead of silently dropping required images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-evidence-"));
  try {
    const file = path.join(root, "large.json");
    await writeFile(file, Buffer.alloc(12 * 1024 * 1024 + 1));
    await assert.rejects(encodeBackupEvidence(root), /excessive/);
    await rm(file);
    await mkdir(path.join(root, "target"));
    await symlink(
      path.join(root, "target"),
      path.join(root, "linked.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(encodeBackupEvidence(root), /regular files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
