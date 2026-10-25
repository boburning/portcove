import assert from "node:assert/strict";
import qualificationOracle from "./fixtures/windows-qualification-selection.json" with { type: "json" };

import { annotatedNodeCommands, parseNodeTestSuites } from "./node-test-suites.mts";

import { isRecord, errorCode } from "./runtime-values.mts";

import { readFile, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { discoverCiPlan, qualificationMatrices, writeGithubOutputs } from "./select-ci-plan.mts";
import { parseDocument } from "yaml";
import { spawnSync } from "node:child_process";

import os from "node:os";
import path from "node:path";

import {
  assertNoDuplicateRustSetup,
  requiredFixture,
  workflow,
  workflowJob,
  workflowStep,
  executableLines,
  qualificationWorkflow,
  qualityGuide,
  windowsQualificationRunner,
  fastRust,
  fastRustTests,
  fastRustQuality,
  rustTests,
  rustWorkspaceTests,
  rustClippy,
  windowsStorage,
  nativeRust,
  intelBuild,
  intelTests,
  rustDocs,
  rust,
  rustQuality,
  frontend,
  catalog,
} from "./ci-workflow-fixture.mts";

void test("storage setup policy distinguishes executable setup from harmless test filenames and YAML layout", () => {
  for (const source of [
    "steps: [{run: 'node --test scripts/rust-toolchain-reader.test.mts scripts/cargo.test.mts'}]",
    "# cargo policy is checked on executable fields\nsteps:\n  - run: |\n      # rust-toolchain is a test filename\n      node --test scripts/rust-toolchain-reader.test.mts scripts/cargo.test.mts\n",
  ])
    assert.doesNotThrow(() => assertNoDuplicateRustSetup(parseDocument(source).toJS()));
  for (const step of [
    { uses: "dtolnay/rust-toolchain@fixed" },
    { uses: "Swatinem/rust-cache@fixed" },
    { run: "cargo test --workspace" },
    { run: "node scripts/dev-storage.mts run -- cargo.exe test --workspace" },
    { run: "& 'cargo' test --workspace" },
    { run: '& "cargo.exe" test --workspace' },
    { run: '& "C:\\Rust\\bin\\cargo.exe" test --workspace' },
    { run: "cargo.exe|Out-Null" },
    { run: "cargo; Write-Output done" },
    { run: '& "cargo.exe">out.txt' },
    { run: "$(cargo.exe)" },
  ])
    assert.throws(() => assertNoDuplicateRustSetup({ steps: [step] }));
});

void test("runtime diagnostics retain complete Windows and Linux typed fixture evidence", () => {
  assert.match(fastRust, /runs-on: windows-latest/u);
  assert.match(
    fastRust,
    /PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR: .*\/work\/runtime-diagnostics\/windows/u,
  );
  assert.match(fastRustTests, /windows-rust-tests\.mts run/u);
  assert.match(fastRust, /PORTCOVE_DIAGNOSTICS_SOURCE_REVISION=.*GITHUB_ENV/u);
  assert.match(
    fastRustQuality,
    /uses: \.\/\.github\/actions\/setup-rust\n\s+if: contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'rust'\)\n\s+with:\n\s+test-fixtures: true/u,
  );
  assert.match(
    fastRust,
    /- name: Retain runtime diagnostics acceptance and latency evidence\n\s+if: always\(\)/u,
  );
  const linuxFixture = requiredFixture(
    requiredFixture(
      fastRustQuality.split(
        "      - name: Test typed runtime diagnostics and frontend admission on Linux",
      )[1],
    ).split("      - name: Retain Linux runtime diagnostics acceptance evidence")[0],
  );
  assert.match(
    linuxFixture,
    /if: contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'rust'\) && needs\.classify\.outputs\.linux_diagnostics != 'false'/u,
  );
  assert.match(linuxFixture, /shell: bash/u); // Bash's pipefail preserves a failed test before tee.
  assert.match(
    linuxFixture,
    /node scripts\/run-rust-tests\.mts --guard-command cargo test --locked -p portcove-cli --test runtime_diagnostics --test host_diagnostics --test desktop_host_diagnostics -- --test-threads=1 --nocapture/u,
  );
  assert.match(linuxFixture, /--test-threads=1 --nocapture 2>&1 \| tee/u);
  assert.doesNotMatch(linuxFixture, /rustc --edition|--workspace|tauri build|continue-on-error/u);
  assert.match(linuxFixture, /\/runtime-tests\.txt/u);
  assert.match(
    linuxFixture,
    /cargo test --locked -p portcove-diagnostics -- --test-threads=1 --nocapture/u,
  );
  assert.match(
    linuxFixture,
    /cargo test --locked -p portcove-core support_bundle_export -- --test-threads=1 --nocapture/u,
  );
  for (const lane of [fastRustTests, fastRustQuality]) {
    assert.match(lane, /checked-git\.mts rev-parse HEAD/u);
    assert.match(lane, /rustc --version --verbose/u);
    assert.match(lane, /source_sha256:hashes/u);
    for (const source of [
      "crates/portcove-diagnostics/src/lib.rs",
      "crates/portcove-diagnostics/src/sessions.rs",
      "crates/portcove-diagnostics/src/writer.rs",
      "crates/portcove-diagnostics/src/writer_tests.rs",
      "crates/portcove-diagnostics/src/events.rs",
      "crates/portcove-diagnostics/src/events_tests.rs",
      "apps/desktop/src-tauri/src/host_startup.rs",
      "crates/portcove-cli/tests/host_diagnostics.rs",
      "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
      "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
      "crates/portcove-core/src/runtime_diagnostics.rs",
      "crates/portcove-core/src/operation.rs",
      "crates/portcove-core/src/support_bundle.rs",
      "crates/portcove-core/src/service.rs",
      "crates/portcove-core/src/preparation_execution.rs",
      "crates/portcove-core/src/tool_process.rs",
      "crates/portcove-cli/tests/runtime_diagnostics.rs",
    ])
      assert.ok(lane.includes(source), source);
    assert.match(lane, /name: runtime-diagnostics-(?:windows|linux)-/u);
    assert.match(lane, /path:\s*(?:\|\s*)?work\/runtime-diagnostics\/(?:windows|linux)\//u);
  }
  assert.match(
    fastRustQuality,
    /- name: Retain Linux runtime diagnostics acceptance evidence\n\s+if: always\(\) && contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'rust'\) && needs\.classify\.outputs\.linux_diagnostics != 'false'/u,
  );
  const outputs = workflowJob("classify").outputs;
  assert.ok(isRecord(outputs));
  assert.equal(outputs.linux_diagnostics, "${{ steps.plan.outputs.linux_diagnostics }}");
});

void test("Windows diagnostics serialize file workers without changing coverage or deadlines", () => {
  const command = requiredFixture(
    executableLines(
      workflowStep("windows_storage", "Test development diagnostics and evidence").run,
    )[0],
  )
    .trim()
    .split(/\s+/u);
  assert.ok(command);
  assert.deepEqual(command.slice(0, 9), [
    "node",
    "scripts/dev-storage.mts",
    "run",
    "--",
    "node",
    "--test",
    "--test-concurrency=1",
    "--test-timeout=30000",
    "--test-reporter=./scripts/required-node-test-reporter.mts",
  ]);
  assert.deepEqual(command.slice(9), [
    "scripts/desktop-scenarios.test.mts",
    "scripts/native-compatibility.test.mts",
    "scripts/desktop-execution-plan.test.mts",
    "scripts/desktop-execution-baseline.test.mts",
    "scripts/desktop-real-runtime.test.mts",
    "scripts/desktop-linux-native-session.test.mts",
    "scripts/desktop-linux-stop.test.mts",
    "scripts/desktop-listener-probe.test.mts",
    "scripts/desktop-verify.test.mts",
    "scripts/dev-doctor.test.mts",
    "scripts/development-capabilities.test.mts",
    "scripts/development-cli-help.test.mts",
    "scripts/development-evidence.test.mts",
    "scripts/retained-package.test.mts",
    "scripts/capture-target.test.mts",
    "scripts/handoff-evidence.test.mts",
    "scripts/native-confirmation.test.mts",
    "scripts/native-helper-dependencies.test.mts",
    "scripts/frontend-command-preflight.test.mts",
    "scripts/windows-helper-checks.test.mts",
    "scripts/heavy-rust-test-lock.test.mts",
    "scripts/local-validation.test.mts",
    "scripts/validation-evidence.test.mts",
    "scripts/native-session-lock.test.mts",
    "scripts/native-session.test.mts",
    "scripts/run-rust-tests.test.mts",
    "scripts/rust-support-cache.test.mts",
    "scripts/rust-test-impact.test.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
    "scripts/tool-cache.test.mts",
    "scripts/resource-capacity.test.mts",
    "scripts/resource-command.test.mts",
  ]);
});

void test("Linux desktop prerequisite installation is shared, bounded, and retrying", async () => {
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

  assert.equal((workflow.match(invocation) ?? []).length, 3);
  assert.equal((deepQuality.match(invocation) ?? []).length, 1);
  assert.equal((release.match(invocation) ?? []).length, 2);
  assert.match(
    updaterRehearsal,
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm --include-appimage-runtime/,
  );
  assert.match(
    updaterRehearsal,
    /linux_runner:\r?\n\s+description: [^\r\n]+\r?\n\s+type: choice\r?\n\s+default: ubuntu-24\.04\r?\n\s+options: \[ubuntu-22\.04, ubuntu-24\.04\]/,
  );
  assert.match(
    updaterRehearsal,
    /runs-on: \$\{\{ matrix\.label == 'linux-x86_64' && inputs\.linux_runner \|\| fromJSON\('[^']+'\)\[matrix\.label\] \}\}/,
  );
  assert.match(updaterRehearsal, /work\/updater-rehearsal\/linux-host-baseline\.txt/g);
  assert.match(
    packageOwnershipRehearsal,
    /timeout-minutes: 30\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm --install-timeout-seconds=600 --prefer-archive-mirror/,
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
  assert.match(installer, /install_deadline=3m/);
  assert.match(installer, /fallback_install_deadline=5m/);
  assert.match(
    installer,
    /install_from_current_mirror "the runner-configured mirror" 2m "\$install_deadline"/,
  );
  assert.match(
    installer,
    /install_from_current_mirror "the archive mirror fallback" 4m "\$fallback_install_deadline"/,
  );
  assert.ok(
    installer.indexOf('if install_from_current_mirror "the runner-configured mirror"') <
      installer.indexOf('echo "Retrying Linux desktop prerequisites'),
  );
  assert.match(installer, /--include-rpm\) packages\+=\(rpm\)/);
  assert.match(installer, /VERSION_ID:-} == 24\.04[\s\S]*fuse_package=libfuse2t64/);
  assert.match(installer, /--include-appimage-runtime\) packages\+=\("\$fuse_package"/);
  assert.match(installer, /usage: \$0 \[--include-rpm\]/);
});

void test("repository Rust setup provisions components before ordinary identity probes", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(setup, /components: \$\{\{ steps\.repository-toolchain\.outputs\.components \}\}/);
  assert.match(
    setup,
    /PORTCOVE_COMPONENTS: \$\{\{ steps\.repository-toolchain\.outputs\.components \}\}/,
  );
  const installed = setup.indexOf(
    "& rustup component list --toolchain $env:PORTCOVE_TOOLCHAIN --installed",
  );
  assert.ok(installed >= 0 && installed < setup.indexOf("& rustc --version --verbose"));
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
});

void test("Rust setup installs the repository pin instead of an unrelated stable toolchain", async () => {
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
  assert.match(setup, /node scripts\/run-rust-tests\.mts --prepare-only/);
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
  assert.match(recipes, /node scripts\/run-rust-tests\.mts --locked --workspace/);
});

void test("release, rehearsal and deep audit Rust callers preserve repository pin, components, targets and caches", async (t) => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const toolchain = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
  const components: unknown = JSON.parse(
    requiredFixture(toolchain.match(/^components\s*=\s*(\[[^\n]+\])/m)?.[1]),
  );
  assert.ok(Array.isArray(components));
  const componentValues: unknown[] = components;
  assert.ok(componentValues.every((value): value is string => typeof value === "string"));
  assert.deepEqual(componentValues.toSorted(), ["clippy", "rust-analyzer", "rustfmt"]);
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  // Ordinary shims honor the TOML's component requirements before reporting identity.
  assert.match(setup, /& rustc --version --verbose/);
  assert.match(setup, /& cargo --version/);
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
  assert.doesNotMatch(toolchain, /^targets\s*=/m);

  function job(source: string, name: string) {
    const section = source.match(
      new RegExp(`^ {2}${name}:\\r?\\n([\\s\\S]*?)(?=^ {2}\\S|$(?![\\s\\S]))`, "m"),
    )?.[1];
    assert.ok(section, `missing ${name} job`);
    return section;
  }

  function steps(source: string, reference: string) {
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      source.match(new RegExp(`^ {6}- uses: ${escaped}\\r?\\n(?: {8}[^\\r\\n]*\\r?\\n)*`, "gm")) ??
      []
    );
  }

  function assertHostSetup(section: string, cacheSetting?: string) {
    assert.deepEqual(steps(section, "./.github/actions/setup-rust"), [
      "      - uses: ./.github/actions/setup-rust\n",
    ]);
    assert.doesNotMatch(
      section,
      /dtolnay\/rust-toolchain|RUSTUP_TOOLCHAIN|(?:rustc|cargo) \+|rustup (?:default|override|toolchain|component|target)/,
    );
    const cache = steps(
      section,
      "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3",
    );
    assert.deepEqual(
      cache.map((step: string) => step.replace(/^ {10}#.*\r?\n/gm, "")),
      [
        "      - uses: Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3\n" +
          (cacheSetting ? `        with:\n          ${cacheSetting}\n` : ""),
      ],
    );
    assert.ok(
      section.indexOf("uses: ./.github/actions/setup-rust") <
        section.indexOf("uses: Swatinem/rust-cache@"),
    );
  }

  for (const [file, name, cacheSetting] of [
    ["release.yml", "validate", undefined],
    ["linux-package-ownership-rehearsal.yml", "build", "key: linux-package-ownership-rehearsal"],
    ["updater-artifact-rehearsal.yml", "packages", "key: updater-artifact-rehearsal"],
    ["deep-quality.yml", "audit", "shared-key: deep-quality-ubuntu-22.04"],
  ] as const) {
    await t.test(`${file} ${name}`, async () => {
      const source = await readFile(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      const section = job(source, name);
      assertHostSetup(section, cacheSetting);
      for (const replacement of [
        "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          toolchain: stable\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          targets: aarch64-unknown-linux-gnu\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          test-fixtures: true\n",
      ]) {
        assert.throws(() =>
          assertHostSetup(
            section.replace("      - uses: ./.github/actions/setup-rust\n", replacement),
            cacheSetting,
          ),
        );
      }
      assert.throws(() =>
        assertHostSetup(
          section.replace(
            "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0",
            "Swatinem/rust-cache@floating",
          ),
          cacheSetting,
        ),
      );
      if (cacheSetting)
        assert.throws(() =>
          assertHostSetup(section.replace(cacheSetting, "key: changed"), cacheSetting),
        );
      if (file === "release.yml") {
        for (const [crossJob, target, key] of [
          ["build", "${{ matrix.target }}", "release-${{ matrix.label }}"],
          ["build_intel", "x86_64-apple-darwin", "release-macos-x86_64"],
        ] as const) {
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

void test("CI toolchain caches retain exact repository version authorities", async () => {
  const workspace: unknown = parseDocument(
    await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
    { uniqueKeys: true },
  ).toJS();
  assert.ok(isRecord(workspace) && isRecord(workspace.catalog));
  assert.match(String(workspace.catalog["vite-plus"]), /^\d+\.\d+\.\d+$/);
  assert.match(
    (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim(),
    /^\d+\.\d+\.\d+$/,
  );
  let count = 0;
  for (const name of ["ci.yml", "deep-quality.yml", "linux-package-ownership-rehearsal.yml"]) {
    const document: unknown = parseDocument(
      await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"),
      { uniqueKeys: true },
    ).toJS();
    assert.ok(isRecord(document) && isRecord(document.jobs), name);
    for (const job of Object.values(document.jobs)) {
      assert.ok(isRecord(job));
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        assert.ok(isRecord(step));
        if (typeof step.uses !== "string" || !step.uses.startsWith("voidzero-dev/setup-vp@"))
          continue;
        count++;
        assert.equal(step.uses, "voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76");
        assert.ok(isRecord(step.with));
        assert.equal(step.with["version-file"], "pnpm-workspace.yaml");
        assert.equal(step.with["node-version-file"], ".node-version");
        assert.equal(step.with["cache-toolchain"], true);
        assert.notEqual(step.with["node-manager"], false);
        assert.notEqual(step.with["package-manager"], false);
      }
    }
  }
  assert.equal(count, 8);
});

void test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.equal(
    workflowStep("rust_workspace_tests", "Build and test the public Playnite reference consumer")
      .run,
    qualificationOracle.workspace_other.public_cli_source,
  );
  const workspace = workflowJob("rust_workspace_tests");
  assert.ok(Array.isArray(workspace.steps));
  assert.ok(
    workspace.steps.some(
      (step: unknown) =>
        isRecord(step) &&
        step.run === `cargo nextest run ${qualificationOracle.workspace_other.arguments.join(" ")}`,
    ),
  );
  assert.match(rustTests, /^ {4}name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  assert.match(
    rustTests,
    /shard:\s*\[\s*core-service-1,\s*core-service-2,\s*core-recovery,\s*core-other-1,\s*core-other-2,?\s*\]/,
  );
  assert.match(rustTests, /needs: \[classify, qualification_core_archive\]/u);
  assert.match(rustTests, /windows-rust-tests\.mts run-qualification \$\{\{ matrix\.shard \}\}/u);
  assert.match(
    rustTests,
    /PORTCOVE_WINDOWS_MANIFEST_SHA256: \$\{\{ needs\.qualification_core_archive\.outputs\.manifest_sha256 \}\}/u,
  );
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
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mts/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.match(windowsStorage, /scripts\/windows-qualification-session\.test\.mts/);
  assert.match(windowsStorage, /\.\/scripts\/run-windows-qualification\.ps1/);
  assert.match(
    windowsStorage,
    /--test-timeout=30000 --test-reporter=\.\/scripts\/required-node-test-reporter\.mts/,
  );
  assert.match(
    windowsStorage,
    /Install-PSResource -RequiredResourceFile \.config\/powershell-resources\.psd1 -Scope CurrentUser -TrustRepository/,
  );
  assert.match(windowsStorage, /run-powershell-lint\.mts/);
  assert.match(windowsStorage, /lint-tools\.integration\.mts psscriptanalyzer/);
  assertNoDuplicateRustSetup(workflowJob("windows_storage"));
  assert.doesNotMatch(windowsStorage, /continue-on-error/);

  assert.match(rust, /^ {4}if: always\(\)$/m);
  for (const dependency of [
    "classify",
    "prose_checks",
    "qualification_core_archive",
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
    "qualification_core_archive",
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

void test("Windows analyzer acquisition retains the exact pin and both mandatory gates", (t) => {
  const body = windowsStorage.match(
    /- name: Lint PowerShell scripts\r?\n {8}shell: pwsh\r?\n {8}run: \|\r?\n([\s\S]*)/,
  )?.[1];
  assert.ok(body);
  const script = body.replace(/^ {10}/gm, "");
  assert.match(
    script,
    /Import-PowerShellDataFile -LiteralPath \.config\/powershell-resources\.psd1/,
  );
  assert.match(
    script,
    /Get-Module -ListAvailable -Name PSScriptAnalyzer \| Where-Object Version -EQ \$requiredVersion/,
  );
  assert.match(
    script,
    /Import-Module -Name PSScriptAnalyzer -RequiredVersion \$requiredVersion -Force/,
  );
  assert.doesNotMatch(script, /PSModulePath|ModuleBase|continue-on-error|SilentlyContinue/);
  const available = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (errorCode(available.error) === "ENOENT" && process.platform !== "win32") {
    t.skip("PowerShell unavailable; required Windows job executes this contract");
    return;
  }
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stdout + available.stderr);
  const mocks = `
$ErrorActionPreference = 'Stop'
$script:pin = [string](Import-PowerShellDataFile -LiteralPath .config/powershell-resources.psd1).PSScriptAnalyzer.version
$script:available = @($env:PORTCOVE_ANALYZER_VERSIONS | ConvertFrom-Json)
function Get-Module {
  param([switch]$ListAvailable, [string]$Name)
  if (-not $ListAvailable -or $Name -ne 'PSScriptAnalyzer') { throw 'unexpected module lookup' }
  $script:available | ForEach-Object { [pscustomobject]@{ Version = [version]$_ } }
}
function Install-PSResource {
  param([string]$RequiredResourceFile, [string]$Scope, [switch]$TrustRepository)
  if ($RequiredResourceFile -ne '.config/powershell-resources.psd1' -or $Scope -ne 'CurrentUser' -or -not $TrustRepository) { throw 'changed acquisition contract' }
  Write-Output 'acquire-exact-pin'
  if ($env:PORTCOVE_ANALYZER_FAILURE -eq 'acquisition') { throw 'acquisition failed' }
  $script:available = @($script:pin)
}
function Import-Module {
  param([string]$Name, [string]$RequiredVersion, [switch]$Force)
  if ($Name -ne 'PSScriptAnalyzer' -or $RequiredVersion -ne $script:pin -or -not $Force) { throw 'changed import contract' }
  Write-Output 'import-exact-pin'
  if ($script:available -notcontains $RequiredVersion -or $env:PORTCOVE_ANALYZER_FAILURE -eq 'import') { throw 'exact import failed' }
}
function node {
  param([string]$Script, [string]$Fixture)
  Write-Output "gate:$Script"
  if ($Script -eq 'scripts/run-powershell-lint.mts' -and -not $Fixture) {
    $global:LASTEXITCODE = [int]($env:PORTCOVE_ANALYZER_FAILURE -eq 'lint')
  } elseif ($Script -eq 'scripts/lint-tools.integration.mts' -and $Fixture -eq 'psscriptanalyzer') {
    $global:LASTEXITCODE = [int]($env:PORTCOVE_ANALYZER_FAILURE -eq 'fixture')
  } else { throw 'changed mandatory gate' }
}
`;
  for (const [versions, failure, acquisition, gates, success] of [
    [["1.25.0"], "", false, 2, true],
    [["1.24.0", "1.25.0", "1.26.0"], "", false, 2, true],
    [[], "", true, 2, true],
    [["1.24.0", "1.26.0"], "", true, 2, true],
    [[], "acquisition", true, 0, false],
    [["1.25.0"], "import", false, 0, false],
    [["1.25.0"], "lint", false, 1, false],
    [["1.25.0"], "fixture", false, 2, false],
  ] as const) {
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", mocks + script],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          PORTCOVE_ANALYZER_VERSIONS: JSON.stringify(versions),
          PORTCOVE_ANALYZER_FAILURE: failure,
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    const context = JSON.stringify({ versions, failure }) + result.stdout + result.stderr;
    assert.equal(result.status === 0, success, context);
    assert.equal(result.stdout.includes("acquire-exact-pin"), acquisition, context);
    assert.equal((result.stdout.match(/gate:/g) ?? []).length, gates, context);
    assert.equal(result.stdout.includes("import-exact-pin"), failure !== "acquisition", context);
  }
});

void test("Windows fixture setup selects runner-owned temporary storage before compilation", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const selection = setup.indexOf("name: Select Windows test temporary storage");
  assert.ok(selection >= 0 && selection < setup.indexOf("name: Read repository toolchain"));
  assert.match(setup, /if: runner\.os == 'Windows' && inputs\.test-fixtures == 'true'/);
  assert.match(windowsStorage, /scripts\/ci-workflow\.test\.mts/);
});

void test("Windows storage installs pinned root dependencies after native-only checks and before YAML consumers", () => {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  const job = settings.jobs.windows_storage;
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  const steps: Record<string, unknown>[] = job.steps.map((step: unknown) => {
    assert.ok(isRecord(step));
    return step;
  });
  const native = steps.findIndex(
    (step) =>
      step.name === "Test native compiler and shell integrations without frontend dependencies",
  );
  const setup = steps.findIndex(
    (step) => step.uses === "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
  );
  const install = steps.findIndex(
    (step) =>
      typeof step.run === "string" &&
      step.run.trim().split(/\s+/u).join(" ") ===
        "pnpm install --filter portcove-repository --frozen-lockfile --ignore-scripts",
  );
  const consumer = steps.findIndex((step) => step.name === "Test Windows CI setup contract");
  assert.ok(native >= 0 && setup > native && install > setup && consumer > install);
  assert.deepEqual(steps[setup]?.with, { package_json_file: "package.json" });
  for (const index of [setup, install]) {
    assert.equal(steps[index]?.if, undefined);
    assert.equal(steps[index]?.["continue-on-error"], undefined);
  }
});

void test(
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
      const invoke = (command: string, env: NodeJS.ProcessEnv) =>
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

void test("Windows qualification serializes machine-global registry fixtures with a bounded lock", async () => {
  const wrapper = windowsQualificationRunner;
  assert.match(wrapper, /Local\\Portcove\.WindowsQualification\.v1/);
  assert.match(wrapper, /WaitOne\(\[TimeSpan\]::FromSeconds\(\$WaitSeconds\)\)/);
  assert.match(wrapper, /AbandonedMutexException/);
  assert.match(wrapper, /finally \{[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/);
  const registry = parseNodeTestSuites(
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const commands = annotatedNodeCommands(wrapper, registry);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.id, "mutex-owned-payload");
  assert.deepEqual(commands[0]!.arguments, [
    "--test",
    "--test-reporter=./scripts/required-node-test-reporter.mts",
  ]);
  assert.deepEqual(commands[0]!.files, [
    "scripts/windows-qualification-session.integration.test.mts",
  ]);
});

void test("native Rust runs the full workspace on every supported Unix architecture", () => {
  assert.match(
    nativeRust,
    /^ {4}name: native-rust \(\$\{\{ matrix\.platform \}\}, \$\{\{ matrix\.partition \}\}\)$/m,
  );
  assert.match(
    nativeRust,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_native_matrix_json\) \}\}/,
  );
  const full = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: "a".repeat(40),
    forceQualification: true,
  });
  assert.deepEqual(qualificationMatrices(full).native, [
    { platform: "linux-x86_64", runner: "ubuntu-22.04", partition: "hash:1/1" },
    { platform: "macos-aarch64", runner: "macos-15", partition: "hash:1/1" },
  ]);
  assert.match(nativeRust, /if: runner\.os == 'Linux'/);
  assert.match(nativeRust, /echo "TMPDIR=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(nativeRust, /run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/);
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(nativeRust, /--partition "\$\{\{ matrix\.partition \}\}"/);
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

void test("release qualification profile connects bounded matrices and skips only absent macOS coverage", () => {
  assert.match(
    workflow,
    /PORTCOVE_RELEASE_PROFILE: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    workflow,
    /PORTCOVE_QUALIFICATION_CALLER: \$\{\{ inputs\.qualification_caller \|\| '' \}\}/,
  );
  assert.match(workflow, /PORTCOVE_CALLER_WORKFLOW: \$\{\{ inputs\.caller_workflow \|\| '' \}\}/);
  assert.match(
    qualificationWorkflow,
    /release_profile: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    rustDocs,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_docs_matrix_json\) \}\}/,
  );
  for (const body of [intelBuild, intelTests])
    assert.match(
      body,
      /if: needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-x86_64'\)/,
    );
  const portability = workflow.split("  frontend_portability:")[1] ?? "";
  assert.match(
    portability,
    /if: \(needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-aarch64'\)\)/,
  );
  const beta = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: "a".repeat(40),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  });
  assert.deepEqual(
    qualificationMatrices(beta).native.map(({ platform }) => platform),
    ["linux-x86_64"],
  );
  assert.deepEqual(
    qualificationMatrices(beta).docs.map(({ platform }) => platform),
    ["linux-x86_64", "windows-x86_64"],
  );
  for (const body of [
    rustTests,
    rustWorkspaceTests,
    windowsStorage,
    nativeRust,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ])
    assert.match(body, /if: needs\.classify\.outputs\.mode == 'qualification'/);
});

void test("Intel tests build once and retries preserve their attempt-scoped producer chain", async () => {
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
  const transferGuide = await readFile(
    new URL("../docs/reference/quality-operations.md", import.meta.url),
    "utf8",
  );
  assert.match(qualityGuide, /reference\/quality-operations\.md#consumed-intel-test-transfers/);
  assert.match(
    transferGuide,
    /gh run rerun <run-id> --job <build-intel-tests-job-id> --repo boburning\/portcove/,
  );
  assert.match(transferGuide, /Do not use .*--failed.*Intel consumer/u);
  assert.match(transferGuide, /never reuse an\s+artifact from an earlier attempt/u);
  for (const job of ["intel_build", "intel_tests"])
    assert.ok(rust.includes(`"${job}":"` + "${{ needs." + job + '.result }}"'));
});

void test("Linux Rust quality keeps its platform-specific and policy gates without pnpm", () => {
  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /AQUA_ENFORCE_CHECKSUM: "true"/);
  assert.match(rustQuality, /AQUA_ENFORCE_REQUIRE_CHECKSUM: "true"/);
  assert.match(rustQuality, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(rustQuality, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(rustQuality, /enable_aqua_install: "false"/);
  assert.doesNotMatch(
    rustQuality,
    /machine_contract|backup_directory_durability_support_is_explicit_for_the_host/,
  );
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(rustQuality, /cargo shear --deny-warnings/);
  assert.match(rustQuality, /node scripts\/dependency-security\.mts/);
  assert.doesNotMatch(rustQuality, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(rustQuality, /check-rust-architecture\.mts/);
  assert.match(rustQuality, /run-rscheck\.mts/);
  const bootstrap = rustQuality.indexOf("./scripts/bootstrap-quality-tools.sh");
  for (const lint of ["aqua exec -- ruff", "aqua exec -- shellcheck", "run-actionlint.mts"]) {
    assert.ok(
      rustQuality.indexOf(lint) > bootstrap,
      `${lint} must run after the aqua tools are installed`,
    );
  }
  assert.match(rustQuality, /lint-tools\.integration\.mts ruff shellcheck actionlint/);
  const desktopPrerequisites = rustQuality.indexOf(
    "./scripts/install-linux-desktop-prerequisites.sh",
  );
  assert.ok(
    desktopPrerequisites >= 0 &&
      desktopPrerequisites < rustQuality.indexOf("node scripts/check-transport-contract.mts"),
  );
  assert.match(rustQuality, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rustQuality, /pnpm\/action-setup|pnpm install/);
  assert.doesNotMatch(rustQuality, /continue-on-error/);
});

void test("Rust reports slow tests, terminates hangs and retains documentation coverage", async (t) => {
  const config = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  // Parse the actual configuration consumed by nextest, using the same TOML
  // implementation already used by production nextest-equivalence selection.
  const parsed = spawnSync(
    "python",
    ["-c", "import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    { input: config, encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const document: unknown = JSON.parse(parsed.stdout);
  assert.ok(isRecord(document) && isRecord(document.profile));
  const profile = document.profile.default;
  assert.ok(isRecord(profile));
  assert.deepEqual(profile["slow-timeout"], {
    period: "5s",
    "terminate-after": 6,
    "grace-period": "0s",
  });
  assert.equal(profile.retries, 0);
  assert.equal(profile["fail-fast"], false);
  assert.equal(profile["test-threads"], 2);
  assert.equal(profile["success-output"], undefined);
  assert.equal(profile["default-filter"], undefined);
  assert.ok(Array.isArray(profile.overrides));
  const overrides: Record<string, unknown>[] = profile.overrides.map((value: unknown) => {
    assert.ok(isRecord(value));
    return value;
  });
  // Filters are execution identities, so exact values remain contractual.
  const overrideFor = (filter: string, platform?: string) => {
    const values = overrides.filter(
      (value) => value.filter === filter && (platform === undefined || value.platform === platform),
    );
    assert.equal(values.length, 1, filter);
    return requiredFixture(values[0]);
  };
  for (const filter of [
    "package(portcove-cli)",
    "package(portcove-core) & test(output_relocation::tests::)",
    "package(portcove-core) & test(cancellation::tests::)",
    "package(portcove-core) & test(definition_repository::tests::)",
    "package(portcove-core) & test(activity_diagnostics::tests::)",
    "package(portcove-core) & test(database::tests::)",
    "package(portcove-core) & test(adapter::source_conversion_tests::failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes)",
  ])
    assert.equal(overrideFor(filter)["threads-required"], "num-test-threads");
  const hosted = document.profile["hosted-windows"];
  assert.ok(isRecord(hosted));
  assert.equal(hosted["test-threads"], 4);
  assert.equal(hosted["default-filter"], undefined);
  assert.equal(overrideFor("package(portcove-cli)").priority, -100);
  const argumentContracts = overrideFor("package(portcove-cli) & test(/^args::tests::/)");
  assert.deepEqual(argumentContracts, {
    filter: "package(portcove-cli) & test(/^args::tests::/)",
    priority: 100,
  });
  assert.ok(
    overrides.indexOf(argumentContracts) < overrides.indexOf(overrideFor("package(portcove-cli)")),
    "the first matching priority must run pure command contracts before CLI lifecycles",
  );
  assert.equal(
    overrideFor("package(portcove-core) & test(activity_diagnostics::tests::)").priority,
    -50,
  );
  // These observed Windows-only failures retain exact case identities and
  // finite room for complete durable fixture setup, without broader policy.
  const observedImportCases = [
    "import_execution::tests::admitted_post_client_definition_survives_interrupted_import_resume",
    "import_execution::tests::admitted_post_client_definition_survives_offline_import_with_its_full_graph",
    "import_execution::tests::changed_import_destination_is_retained_and_never_published",
    "import_execution::tests::changed_import_input_is_retained_and_never_published",
    "import_execution::tests::copied_successor_snapshot_without_admission_cannot_grant_unknown_port_authority",
    "import_execution::tests::copying_import_recovers_without_replaying_old_saves",
    "import_execution::tests::forged_but_self_consistent_successor_admission_cannot_reuse_portability_authority",
    "import_execution::tests::import_missing_retained_reference_stops_recovery",
    "import_execution::tests::import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library",
    "import_execution::tests::imported_retained_arguments_cannot_grant_themselves_execution_authority",
    "import_execution::tests::interrupted_abort_cannot_be_resumed_as_a_successful_import",
    "import_execution::tests::journal_phase_cannot_manufacture_import_publication",
    "import_execution::tests::late_credentials_hold_import_before_the_open_gate",
    "import_execution::tests::published_import_recovers_without_replaying_old_saves",
    "import_execution::tests::verified_import_recovers_without_replaying_old_saves",
    "library_transfer::tests::move_plan_accepts_an_admitted_post_client_definition",
  ];
  const observedCapabilityCases = [
    "definition_capability_contract::advertised_engine_templates_match_negotiation_and_exported_schemas",
    "definition_capability_contract::fixed_definition_authority_is_advertised_reviewable_and_unconfigured",
    "definition_capability_contract::listing_delivery_is_negotiable_and_cannot_provision_an_incoming_authority",
    "definition_capability_contract::ordinary_definition_refresh_advertises_contract_and_refuses_unconfigured_authority",
  ];
  const observedCoreFilter = `package(portcove-core) & (${observedImportCases.map((name) => `test(/^${name}$/)`).join(" | ")})`;
  const observedCliFilter = `package(portcove-cli) & (${observedCapabilityCases.map((name) => `test(/^${name}$/)`).join(" | ")})`;
  const outputOverrides = overrides.filter((value) => value["success-output"] !== undefined);
  const linuxLifecycleFilter =
    "package(portcove-cli) & (test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/) | test(/^preparation_contract::reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd$/) | test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/))";
  const windowsLifecycleFilters = [
    "package(portcove-core) & test(/^service::tests::backups::historical_byte_only_backup_keeps_its_existing_integrity_contract$/)",
    "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/))",
    "package(portcove-cli) & test(/^artwork_contract::artwork_cli_keeps_cover_and_detail_independent_through_the_local_lifecycle$/)",
    "package(portcove-core) & (test(/^service::tests::backups::current_persistence_cannot_restore_an_unmanifested_companion_into_lifecycle_paths$/) | test(/^service::tests::backups::interrupted_backup_stages_are_visible_without_hiding_verified_backups$/))",
    "package(portcove-core) & test(/^service::psx_mod_data::tests::lifecycle::explicit_backup_restore_preserves_successor_packages_and_preflights_conflicts$/)",
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_revocation_preserves_unaffected_active_and_recovery_evidence$/))",
    "package(portcove-core) & (test(/^service::shipwright_persistence_tests::shipwright_activation_and_rollback_collect_before_replacing_working_save$/) | test(/^service::shipwright_persistence_tests::shipwright_backup_restore_keeps_the_displaced_runtime_save_in_safety_backup$/))",
    "package(portcove-core) & (test(/^import_execution::tests::late_credentials_hold_import_before_the_open_gate$/) | test(/^library_move::tests::late_credentials_hold_move_before_authority_or_destination_activation$/))",
    "package(portcove-core) & (test(/^service::tests::tfe_recovery_hold_protects_inactive_versions_and_invalidates_earlier_removal_consent$/) | test(/^service::tests::tfe_recovery_hold_survives_quarantine_reopen_and_committed_metadata_removal$/))",
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_withdrawal_permits_exact_retained_target$/)",
    "package(portcove-core) & test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/)",
    "package(portcove-core) & (test(/^service::tests::publication_recovery_retains_conflicting_relocation_intent$/) | test(/^service::tests::publication_recovery_retains_conflicting_source_import_intent$/))",
  ];
  const replacementDownloadFilter =
    "package(portcove-core) & test(/^service::catalog_download::tests::replacement_download_keeps_current_registration_until_reviewed_relink$/)";
  const psxProgressionFilter =
    "package(portcove-core) & test(/^service::runtime_tests::psx_progression::(unchanged_psx_definition_completes_provider_install_and_update_with_registered_inputs|retained_direct_psx_runtime_updates_through_current_provider_without_rewriting_contract)$/)";
  const namedSaveRestoreFilter =
    "package(portcove-core) & test(/^service::runtime_tests::named_save_restore_updates_every_version_and_preserves_import_policy$/)";
  const publicationFilters = [
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::managed_ordinary_artifacts_and_compatible_correction_retain_exact_contract$/)",
      platform: undefined,
    },
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_permitted_artifact_commits_once$/)",
      platform: "x86_64-apple-darwin",
    },
  ];
  // Admit only these exact platform/filter identities. Comparing the complete
  // inventory also rejects duplicates without a separately maintained count.
  const outputIdentity = (value: Readonly<Record<string, unknown>>) =>
    JSON.stringify([value.platform ?? null, value.filter]);
  assert.deepEqual(
    outputOverrides.map(outputIdentity).sort(),
    [
      ...windowsLifecycleFilters.map((filter) => ({ platform: "x86_64-pc-windows-msvc", filter })),
      ...publicationFilters,
      { platform: "x86_64-unknown-linux-gnu", filter: linuxLifecycleFilter },
      { platform: "x86_64-pc-windows-msvc", filter: observedCoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: observedCliFilter },
      { platform: "x86_64-pc-windows-msvc", filter: replacementDownloadFilter },
      { platform: "x86_64-pc-windows-msvc", filter: namedSaveRestoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: psxProgressionFilter },
    ]
      .map(outputIdentity)
      .sort(),
  );
  const linuxLifecycle = overrideFor(linuxLifecycleFilter, "x86_64-unknown-linux-gnu");
  assert.deepEqual(linuxLifecycle["slow-timeout"], {
    period: "5s",
    "terminate-after": 18,
    "grace-period": "0s",
  });
  assert.equal(linuxLifecycle["success-output"], "immediate");
  for (const field of ["retries", "threads-required", "priority", "default-filter"])
    assert.equal(linuxLifecycle[field], undefined);
  for (const [filter, periods] of [
    [observedCoreFilter, 18],
    [observedCliFilter, 12],
  ] as const) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": periods,
      "grace-period": "0s",
    });
    assert.equal(override["success-output"], "immediate");
    for (const field of ["retries", "threads-required", "priority", "default-filter"])
      assert.equal(override[field], undefined);
    assert.ok(
      overrides.indexOf(override) < overrides.indexOf(overrideFor(windowsLifecycleFilters[0]!)),
    );
  }
  for (const filter of windowsLifecycleFilters) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override.platform, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": 12,
      "grace-period": "0s",
    });
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  // The measured copy-start wait must fit inside an exact Windows-only outer
  // budget; it must not add output, retries, workers or priority exceptions.
  const cacheRetention = overrideFor(
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_cancellation_preserves_partial_after_worker_exit$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_revocation_during_copy_refuses_publication$/))",
  );
  assert.equal(cacheRetention.platform, "x86_64-pc-windows-msvc");
  assert.deepEqual(cacheRetention["slow-timeout"], {
    period: "5s",
    "terminate-after": 12,
    "grace-period": "0s",
  });
  for (const field of ["success-output", "retries", "threads-required", "priority"])
    assert.equal(cacheRetention[field], undefined);
  for (const { filter, platform } of publicationFilters) {
    const override = overrideFor(filter);
    assert.equal(override.platform, platform);
    assert.equal(override["success-output"], "immediate");
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  for (const filter of [replacementDownloadFilter, namedSaveRestoreFilter, psxProgressionFilter]) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": 18,
      "grace-period": "0s",
    });
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  for (const value of [profile, ...overrides]) {
    assert.ok(value.retries === undefined || value.retries === 0);
    assert.equal(value["on-timeout"], undefined);
    if (value !== profile) assert.equal(typeof value.filter, "string");
    const timeout: unknown = value["slow-timeout"];
    if (timeout === undefined) continue;
    assert.ok(isRecord(timeout));
    // Nextest owns duration syntax; calibrated warning/grace durations may vary.
    assert.equal(typeof timeout.period, "string");
    if (timeout["grace-period"] !== undefined)
      assert.equal(typeof timeout["grace-period"], "string");
    assert.ok(Number.isSafeInteger(timeout["terminate-after"]));
    assert.ok(typeof timeout["terminate-after"] === "number" && timeout["terminate-after"] > 0);
  }
  assert.match(rustTests, /windows-rust-tests\.mts run-qualification/u);
  assert.doesNotMatch(rustTests + rustWorkspaceTests, /--test-threads 1/);
  assert.match(rustDocs, /cargo test --locked --workspace --exclude portcove-desktop --doc/);
  assert.match(rustDocs, /cargo test --locked -p portcove-desktop --doc/);
  assert.doesNotMatch(rustDocs, /--no-default-features|--no-deps|--exclude (?!portcove-desktop)/);
  assert.match(
    rustDocs,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_docs_matrix_json\) \}\}/,
  );
  const matrixRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-doc-qualification-"));
  t.after(() => rm(matrixRoot, { recursive: true, force: true }));
  for (const [releaseProfile, expected] of [
    ["full", ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]],
    ["initial-beta-win-linux", ["linux-x86_64", "windows-x86_64"]],
  ] as const) {
    const selected = discoverCiPlan({
      eventName: "workflow_dispatch",
      checkoutSha: "a".repeat(40),
      forceQualification: true,
      qualificationCaller: "release",
      callerWorkflow: "release.yml",
      releaseProfile,
    });
    const output = path.join(matrixRoot, releaseProfile);
    await writeGithubOutputs(output, selected);
    const line = (await readFile(output, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("qualification_docs_matrix_json="));
    assert.ok(line);
    const matrix: unknown = JSON.parse(line.slice(line.indexOf("=") + 1));
    assert.ok(Array.isArray(matrix));
    assert.deepEqual(
      matrix.map((entry: unknown) => {
        assert.ok(isRecord(entry));
        return entry.platform;
      }),
      expected,
    );
    assert.deepEqual(matrix, qualificationMatrices(selected).docs);
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

void test("ordinary Windows Rust compiles once and joins every execution and live transport producer", () => {
  const build = workflowJob("fast_rust");
  const execution = workflowJob("fast_rust_tests");
  const transport = workflowJob("fast_rust_transport");
  for (const producer of [build, execution, transport]) {
    assert.equal(producer["runs-on"], "windows-latest");
    assert.equal(
      producer.if,
      "needs.classify.outputs.mode == 'fast' && contains(fromJSON(needs.classify.outputs.groups_json), 'rust')",
    );
    assert.equal(producer["continue-on-error"], undefined);
  }
  assert.deepEqual(execution.needs, ["classify", "fast_rust"]);
  assert.equal(transport.needs, "classify");
  assert.ok(isRecord(build.outputs));
  assert.equal(build.outputs.manifest_sha256, "${{ steps.archive.outputs.manifest_sha256 }}");
  assert.ok(isRecord(execution.strategy) && isRecord(execution.strategy.matrix));
  assert.equal(execution.strategy["fail-fast"], false);
  assert.equal(
    execution.strategy.matrix.include,
    "${{ fromJSON(needs.fast_rust.outputs.matrix) }}",
  );
  assert.ok(isRecord(execution.env));
  assert.equal(
    execution.env.PORTCOVE_WINDOWS_MANIFEST_SHA256,
    "${{ needs.fast_rust.outputs.manifest_sha256 }}",
  );
  assert.equal(
    workflowStep("fast_rust", "Compile workspace targets and archive balanced test partitions").run,
    "node scripts/run-rust-tests.mts --guard-command node scripts/windows-rust-tests.mts build",
  );
  assert.match(
    workflowStep("fast_rust_tests", "Execute the verified Windows test partition").run,
    /run-rust-tests\.mts --guard-command node scripts\/windows-rust-tests\.mts run/u,
  );
  assert.equal(
    workflowStep(
      "fast_rust_transport",
      "Compare live CLI and headless and native Desktop serialization",
    ).run,
    "node scripts/run-rust-tests.mts --guard-command node scripts/check-transport-contract.mts",
  );
  const aggregate = workflowJob("rust");
  assert.ok(Array.isArray(aggregate.needs));
  const gate: Record<string, unknown> = workflowStep("rust", "Require every Rust lane");
  assert.ok(isRecord(gate.env) && typeof gate.env.PORTCOVE_FAST_RESULTS === "string");
  const results: unknown = JSON.parse(gate.env.PORTCOVE_FAST_RESULTS);
  assert.ok(isRecord(results));
  assert.deepEqual(Object.keys(results).sort(), [
    "fast_rust",
    "fast_rust_tests",
    "fast_rust_transport",
  ]);
  for (const id of Object.keys(results)) {
    assert.ok(aggregate.needs.includes(id));
    assert.equal(results[id], `\${{ needs.${id}.result }}`);
  }
  assert.ok(Array.isArray(build.steps) && Array.isArray(execution.steps));
  const buildSteps: unknown[] = build.steps;
  const executionSteps: unknown[] = execution.steps;
  const uploaded = buildSteps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@") &&
      isRecord(step.with) &&
      String(step.with.name).startsWith("windows-rust-tests-"),
  );
  const downloaded = executionSteps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/download-artifact@"),
  );
  assert.ok(
    isRecord(uploaded) &&
      isRecord(uploaded.with) &&
      isRecord(downloaded) &&
      isRecord(downloaded.with),
  );
  assert.equal(
    uploaded.with.name,
    "windows-rust-tests-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(downloaded.with.name, uploaded.with.name);
  assert.match(String(uploaded.with.path), /tests\.tar\.zst/u);
  assert.match(String(uploaded.with.path), /manifest\.json/u);
  assert.equal(uploaded.with["if-no-files-found"], "error");
});
