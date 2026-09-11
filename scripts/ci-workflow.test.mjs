import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const windowsQualificationRunner = await readFile(
  new URL("./run-windows-qualification.ps1", import.meta.url),
  "utf8",
);
const requiredCiSurface = `${workflow}\n${windowsQualificationRunner}`;

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
  const files = (await readdir(new URL(".", import.meta.url))).filter((name) =>
    name.endsWith(".test.mjs"),
  );
  for (const file of files) {
    assert.ok(requiredCiSurface.includes(`scripts/${file}`), `${file} is absent from required CI`);
    assert.ok(recipes.includes(`scripts/${file}`), `${file} is absent from local quality checks`);
  }
});

test("release selection runs after the maintained SemVer dependency is installed", () => {
  const installation = frontend.indexOf("pnpm install --frozen-lockfile");
  const selection = frontend.indexOf("scripts/select-release-channel.test.mjs");
  assert.ok(installation >= 0 && selection > installation);
  assert.ok(!catalog.includes("scripts/select-release-channel.test.mjs"));
});

test("required CI keeps its cancellation and least-privilege contracts", () => {
  assert.match(workflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    workflow,
    /^concurrency:\r?\n {2}group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n {2}cancel-in-progress: true$/m,
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
    assert.doesNotMatch(section, /^ {4}if:/m);
  }
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
  const installer = await readFile(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
    "utf8",
  );
  const invocation =
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/g;

  assert.equal((workflow.match(invocation) ?? []).length, 3);
  assert.equal((deepQuality.match(invocation) ?? []).length, 2);
  assert.equal((release.match(invocation) ?? []).length, 2);
  assert.match(
    updaterRehearsal,
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm/,
  );
  for (const hostedWorkflow of [workflow, deepQuality, release, updaterRehearsal]) {
    assert.doesNotMatch(hostedWorkflow, /sudo apt-get/);
  }
  for (const packageName of [
    "libwebkit2gtk-4.1-dev",
    "libappindicator3-dev",
    "librsvg2-dev",
    "patchelf",
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
  assert.match(installer, /install_from_current_mirror "the runner-configured mirror" 2m 3m/);
  assert.match(installer, /install_from_current_mirror "the archive mirror fallback" 4m 5m/);
  assert.ok(
    installer.indexOf('"the runner-configured mirror"') <
      installer.indexOf("archive.ubuntu.com/ubuntu"),
  );
  assert.match(installer, /--include-rpm\) packages\+=\(rpm\)/);
  assert.match(installer, /usage: \$0 \[--include-rpm\]/);
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
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelTests, rustQuality]) {
    assert.match(section, /test-fixtures: true/);
  }
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /node scripts\/run-rust-tests\.mjs --locked --workspace/);
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
  assert.match(
    rust,
    /needs:\s*\[\s*rust_tests,\s*rust_workspace_tests,\s*rust_clippy,\s*windows_storage,\s*native_rust,\s*intel_build,\s*intel_tests,\s*rust_docs,?\s*\]/,
  );
  assert.match(rust, /RUST_TEST_RESULT: \$\{\{ needs\.rust_tests\.result \}\}/);
  assert.match(rust, /RUST_WORKSPACE_TEST_RESULT: \$\{\{ needs\.rust_workspace_tests\.result \}\}/);
  assert.match(rust, /RUST_CLIPPY_RESULT: \$\{\{ needs\.rust_clippy\.result \}\}/);
  assert.match(rust, /WINDOWS_STORAGE_RESULT: \$\{\{ needs\.windows_storage\.result \}\}/);
  assert.match(rust, /NATIVE_RUST_RESULT: \$\{\{ needs\.native_rust\.result \}\}/);
  assert.match(rust, /exit 1/);
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

test("Intel tests build once on Apple Silicon and execute every partition on Intel", () => {
  assert.match(intelBuild, /runs-on: macos-15$/m);
  assert.match(intelBuild, /targets: x86_64-apple-darwin/);
  assert.match(
    intelBuild,
    /cargo nextest archive --locked --workspace --target x86_64-apple-darwin/,
  );
  assert.match(intelBuild, /if-no-files-found: error/);
  assert.match(intelBuild, /retention-days: 1/);
  assert.match(intelTests, /needs: intel_build/);
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
  for (const [variable, job] of [
    ["INTEL_BUILD_RESULT", "intel_build"],
    ["INTEL_TEST_RESULT", "intel_tests"],
  ]) {
    assert.ok(rust.includes(`${variable}: ` + "${{ needs." + job + ".result }}"));
    assert.ok(rust.includes(`"$${variable}" != "success"`));
  }
});

test("Linux Rust quality keeps its platform-specific and policy gates without pnpm", () => {
  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /AQUA_ENFORCE_CHECKSUM: "true"/);
  assert.match(rustQuality, /AQUA_ENFORCE_REQUIRE_CHECKSUM: "true"/);
  assert.match(rustQuality, /aquaproj\/aqua-installer@96a9bc20066c5bf5e275b41019cfc165b25f4e2e/);
  assert.match(rustQuality, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(rustQuality, /enable_aqua_install: "false"/);
  assert.match(rustQuality, /machine_contract/);
  assert.match(rustQuality, /backup_directory_durability_support_is_explicit_for_the_host/);
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

test("frontend tooling uses the pinned Oxc contracts without legacy quality layers", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["format:oxfmt"], "node ../../scripts/run-oxfmt.mjs --write");
  assert.equal(packageJson.scripts["lint:oxlint"], "node ../../scripts/run-oxlint.mjs");
  assert.equal(packageJson.devDependencies.oxfmt, "0.67.0");
  assert.equal(packageJson.devDependencies.oxlint, "1.82.0");
  assert.equal(packageJson.devDependencies["oxlint-tsgolint"], "7.0.2001");
  assert.equal(packageJson.devDependencies["oxc-parser"], "0.149.0");
  assert.equal(packageJson.devDependencies.typescript, "7.0.2");
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
    assert.equal(packageJson.devDependencies[retired], undefined);
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

  const copyChecker = await readFile(
    new URL("../apps/desktop/scripts/check-copy.mjs", import.meta.url),
    "utf8",
  );
  assert.match(copyChecker, /import \{ parseSync, visitorKeys \} from "oxc-parser"/);
  assert.doesNotMatch(copyChecker, /@babel\/parser/);
  const dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dependabot, /frontend-toolchain:[\s\S]*"oxc-parser"/);

  const oxfmt = JSON.parse(await readFile(new URL("../.oxfmtrc.json", import.meta.url), "utf8"));
  assert.equal(oxfmt.printWidth, 100);
  assert.equal(oxfmt.sortImports, false);
  assert.equal(oxfmt.sortPackageJson, true);
  assert.ok(oxfmt.ignorePatterns.includes("**/*.toml"));

  for (const retired of [
    "../.prettierignore",
    "../prettier.config.mjs",
    "../eslint.config.mjs",
    "../apps/desktop/eslint.config.mjs",
    "../apps/desktop/.fallowrc.json",
    "./run-eslint.mjs",
  ]) {
    await assert.rejects(readFile(new URL(retired, import.meta.url)), { code: "ENOENT" });
  }
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
