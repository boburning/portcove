import {
  rustAction,
  compactActionExpression,
  rustTemporaryStorage,
  powerShellAvailable,
  observeToolchainReaders,
  actionEnvironment,
  observeRustIdentity,
} from "./fixtures/rust-action-fixture.mts";
import {
  prerequisiteInvocation,
  prerequisiteOperations,
} from "./fixtures/linux-prerequisites-fixture.mts";
import { workflowJobs } from "./qualification-coverage.mts";
import { readWorkflow } from "./ci-workflow-fixture.mts";
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { errorCode } from "./runtime-values.mts";
import { readFile } from "node:fs/promises";

import test from "node:test";
import { parseDocument } from "yaml";
import { spawnSync } from "node:child_process";

import { requiredFixture } from "./ci-workflow-fixture.mts";
import { workflow, workflowJob } from "./ci-workflow-fixture.mts";
import { workflowStep } from "./ci-workflow-fixture.mts";
import { rustTests } from "./ci-workflow-fixture.mts";
import { rustWorkspaceTests } from "./ci-workflow-fixture.mts";
import { rustClippy } from "./ci-workflow-fixture.mts";
import { windowsStorage } from "./ci-workflow-fixture.mts";
import { nativeRust } from "./ci-workflow-fixture.mts";
import { intelBuild } from "./ci-workflow-fixture.mts";
import { intelTests } from "./ci-workflow-fixture.mts";
import { rustDocs } from "./ci-workflow-fixture.mts";

import { rustQuality } from "./ci-workflow-fixture.mts";

void test("Linux desktop prerequisite installation is shared, bounded, and retrying", async () => {
  const deepQuality = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const release = await readWorkflow(new URL("../.github/workflows/release.yml", import.meta.url));
  const updaterRehearsal = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  const packageOwnershipRehearsal = await readWorkflow(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
  );

  const installerSteps = (source: string) =>
    Object.values(workflowJobs(source))
      .flatMap((job): unknown[] => (Array.isArray(job.steps) ? job.steps : []))
      .filter(
        (step: unknown): step is Record<string, unknown> & { run: string } =>
          isRecord(step) &&
          typeof step.run === "string" &&
          /(?:^|[\s"'])\.\/scripts\/install-linux-desktop-prerequisites\.sh(?:[\s"']|$)/u.test(
            step.run,
          ),
      );
  const invocation = (step: { run: string }, expected: string[]) =>
    assert.deepEqual(prerequisiteInvocation(step.run).toSorted(), expected.toSorted());
  assert.equal(installerSteps(workflow).length, 3);
  assert.equal(
    installerSteps(workflow).filter(
      (step) => prerequisiteInvocation(step.run).length === 0 && step["timeout-minutes"] === 15,
    ).length,
    0,
  );
  const installedBy = (jobId: string) => {
    const job = workflowJobs(workflow)[jobId];
    assert.ok(job && Array.isArray(job.steps));
    const selected = job.steps.filter(
      (step): step is Record<string, unknown> & { run: string } =>
        isRecord(step) &&
        typeof step.run === "string" &&
        step.run.includes("./scripts/install-linux-desktop-prerequisites.sh"),
    );
    assert.equal(selected.length, 1);
    return requiredFixture(selected[0]);
  };
  const schemaInstall = installedBy("rust_quality_full");
  assert.equal(schemaInstall["timeout-minutes"], 30);
  invocation(schemaInstall, ["--prefer-archive-mirror", "--install-timeout-seconds=600"]);
  const nativeInstall = installedBy("native_rust");
  assert.equal(nativeInstall["timeout-minutes"], 30);
  invocation(nativeInstall, ["--prefer-archive-mirror", "--install-timeout-seconds=600"]);
  const docsInstall = installedBy("rust_docs");
  assert.equal(docsInstall["timeout-minutes"], 30);
  invocation(docsInstall, ["--prefer-archive-mirror", "--install-timeout-seconds=600"]);
  assert.equal(
    installerSteps(deepQuality).filter(
      (step) => prerequisiteInvocation(step.run).length === 0 && step["timeout-minutes"] === 15,
    ).length,
    2,
  );
  assert.equal(
    installerSteps(release).filter(
      (step) => prerequisiteInvocation(step.run).length === 0 && step["timeout-minutes"] === 15,
    ).length,
    2,
  );
  assert.equal(
    installerSteps(updaterRehearsal).filter(
      (step) =>
        JSON.stringify(prerequisiteInvocation(step.run).toSorted()) ===
          JSON.stringify(
            ["--include-rpm", "--include-appimage-runtime", "--include-webdriver"].toSorted(),
          ) && step["timeout-minutes"] === 15,
    ).length,
    1,
  );
  const settings: unknown = parseDocument(updaterRehearsal).toJS();
  assert.ok(
    isRecord(settings) &&
      isRecord(settings.on) &&
      isRecord(settings.on.workflow_dispatch) &&
      isRecord(settings.on.workflow_dispatch.inputs),
  );
  const runner = settings.on.workflow_dispatch.inputs.linux_runner;
  assert.ok(isRecord(runner));
  assert.equal(runner.type, "choice");
  assert.equal(runner.default, "ubuntu-24.04");
  assert.ok(Array.isArray(runner.options));
  assert.deepEqual(runner.options, ["ubuntu-22.04", "ubuntu-24.04"]);
  assert.ok(typeof runner.description === "string" && runner.description.length);
  const packageJobs = Object.values(workflowJobs(updaterRehearsal)).filter(
    (job) =>
      Array.isArray(job.steps) &&
      job.steps.some(
        (step: unknown) =>
          isRecord(step) &&
          typeof step.run === "string" &&
          step.run.includes("./scripts/install-linux-desktop-prerequisites.sh"),
      ),
  );
  assert.equal(packageJobs.length, 1);
  const packageJob = requiredFixture(packageJobs[0]);
  assert.equal(typeof packageJob["runs-on"], "string");
  // Collapse only expression whitespace; preserve the JSON string verbatim.
  const expression = compactActionExpression(packageJob["runs-on"]);
  const selection = expression.match(
    /^\$\{\{matrix\.([\w-]+)=='linux-x86_64'&&inputs\.linux_runner\|\|fromJSON\('([^']+)'\)\[matrix\.\1\]\}\}$/u,
  );
  assert.ok(selection, "UPDATER_RUNNER_SELECTION");
  assert.ok(isRecord(packageJob.strategy) && isRecord(packageJob.strategy.matrix));
  assert.equal(typeof packageJob.strategy.matrix[requiredFixture(selection[1])], "string");
  const fallback: unknown = JSON.parse(requiredFixture(selection[2]));
  assert.ok(isRecord(fallback));
  const platforms = settings.on.workflow_dispatch.inputs.platform;
  assert.ok(isRecord(platforms) && Array.isArray(platforms.options));
  const labels: unknown[] = platforms.options;
  assert.ok(labels.every((label): label is string => typeof label === "string"));
  assert.deepEqual(
    Object.keys(fallback).toSorted(),
    labels.filter((label) => label !== "all" && label !== "linux-x86_64").toSorted(),
  );
  for (const label of labels) {
    if (label === "all") continue;
    if (label === "linux-x86_64") {
      for (const selected of runner.options)
        assert.match(String(selected), /^ubuntu-(?:22|24)\.04$/u);
    } else {
      assert.equal(typeof fallback[label], "string");
      assert.ok(
        String(fallback[label]).startsWith(label.startsWith("windows-") ? "windows-" : "macos-"),
      );
    }
  }
  assert.match(updaterRehearsal, /work\/updater-rehearsal\/linux-host-baseline\.txt/g);
  assert.equal(
    installerSteps(packageOwnershipRehearsal).filter(
      (step) =>
        JSON.stringify(prerequisiteInvocation(step.run).toSorted()) ===
          JSON.stringify(
            [
              "--include-rpm",
              "--include-dialog-tests",
              "--install-timeout-seconds=600",
              "--prefer-archive-mirror",
            ].toSorted(),
          ) && step["timeout-minutes"] === 30,
    ).length,
    1,
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
  // Production operations are exercised with inert command boundaries in
  // container-build.test.mts; no source spelling establishes their behavior.
  const planned = prerequisiteOperations(`
plan_desktop_prerequisites ubuntu 24.04 --include-appimage-runtime --include-rpm
printf '%s\\0' "\${packages[@]}"
`);
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(planned.stdout.slice(0, -1).split("\0"), [
    "libwebkit2gtk-4.1-dev",
    "libappindicator3-dev",
    "librsvg2-dev",
    "patchelf",
    "libfuse2t64",
    "xvfb",
    "dbus-x11",
    "at-spi2-core",
    "util-linux",
    "rpm",
  ]);
});

void test("repository Rust setup provisions components before ordinary identity probes", async (t) => {
  const setup = await readWorkflow(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
  );
  const action = rustAction(setup);
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
  await t.test(
    "Rust action records consumed toolchain context and stops at each failed probe",
    async (t) => {
      if (!powerShellAvailable()) {
        t.skip("PowerShell unavailable; required Windows job executes this contract");
        return;
      }
      const config = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
      const observed = requiredFixture(observeToolchainReaders(action, [config])[0]);
      assert.equal(observed.accepted, true);
      const pin = observed.outputs[action.toolchain.field],
        components = observed.outputs[action.components.field];
      assert.ok(pin && components);
      for (const target of ["", "wasm32-unknown-unknown"]) {
        const bound = actionEnvironment(action, observed.outputs, {
          "inputs.targets": target,
          "runner.os": "fixtureOS",
          "runner.arch": "fixtureArch",
          "github.job": "fixture-job",
          "github.run_attempt": "7",
          "github.sha": "b".repeat(40),
        });
        const result = observeRustIdentity(action, bound);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          result.calls.map((call) => call.command),
          ["rustup", "rustc", "cargo"],
          "RUST_PROBE_ORDER",
        );
        assert.deepEqual(result.calls[0]?.arguments.slice(0, 2), ["component", "list"]);
        const options = requiredFixture(result.calls[0]).arguments.slice(2);
        const toolchainOption = options.indexOf("--toolchain");
        assert.ok(toolchainOption >= 0);
        assert.equal(options[toolchainOption + 1], pin);
        assert.equal(options.filter((value) => value === "--installed").length, 1);
        assert.equal(options.length, 3);
        assert.deepEqual(result.calls[1]?.arguments.toSorted(), ["--verbose", "--version"]);
        assert.deepEqual(result.calls[2]?.arguments, ["--version"]);
        for (const value of [
          pin,
          components,
          "fixture-clippy,fixture-rustfmt,fixture-rust-analyzer",
          "fixture rustc\\|version<br>fixture verbose identity",
          "fixture Cargo version",
          "fixtureOS-fixtureArch",
          "fixture-job",
          "7",
          "b".repeat(40),
          target || "host only",
        ])
          assert.ok(result.summary.includes(value), `RUST_CONTEXT_VALUE: ${value}`);
      }
      const bound = actionEnvironment(action, observed.outputs, {
        "inputs.targets": "",
        "runner.os": "fixtureOS",
        "runner.arch": "fixtureArch",
        "github.job": "fixture-job",
        "github.run_attempt": "7",
        "github.sha": "b".repeat(40),
      });
      for (const [index, failure] of (["rustup", "rustc", "cargo"] as const).entries()) {
        const result = observeRustIdentity(action, bound, failure);
        assert.equal(result.status, 37 + index, `RUST_PROBE_FAILURE: ${failure}: ${result.stderr}`);
        assert.deepEqual(
          result.calls.map((call) => call.command),
          ["rustup", "rustc", "cargo"].slice(0, index + 1),
          "RUST_PROBE_FAILURE_DRAIN",
        );
        assert.equal(result.summary, "", "RUST_PROBE_PARTIAL_SUMMARY");
      }
    },
  );
});

void test("Rust setup installs the repository pin instead of an unrelated stable toolchain", async (t) => {
  const setup = await readWorkflow(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
  );
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  const action = rustAction(setup);
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
  assert.match(setup, /rustc --version --verbose/);
  assert.match(setup, /cargo --version/);
  assert.match(setup, /github\.run_attempt/);
  assert.match(setup, /github\.sha/);
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelTests, rustQuality]) {
    assert.match(section, /test-fixtures: true/);
  }
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /node scripts\/run-rust-tests\.mts --locked --workspace/);
  await t.test(
    "Rust pin reader consumes the repository TOML and refuses malformed inputs without partial outputs",
    async (t) => {
      if (!powerShellAvailable()) {
        t.skip("PowerShell unavailable; required Windows job executes this contract");
        return;
      }
      const config = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
      const channel = requiredFixture(config.match(/^channel\s*=\s*"([^"]+)"/mu)?.[1]);
      const components: unknown = JSON.parse(
        requiredFixture(config.match(/^components\s*=\s*(\[[^\n]+\])/mu)?.[1]),
      );
      assert.ok(Array.isArray(components));
      const invalid = [
        config.replace(/^channel[^\n]*\n/mu, ""),
        config.replace(/^components[^\n]*\n/mu, ""),
        config.replace(/^components[^\n]*/mu, "components = []"),
        config.replace(/^components[^\n]*/mu, "components = [7]"),
        config.replace(/^components[^\n]*/mu, 'components = ["invalid component"]'),
      ];
      const [accepted, ...rejected] = observeToolchainReaders(action, [config, ...invalid]);
      assert.ok(accepted?.accepted);
      assert.equal(accepted.outputs[action.toolchain.field], channel);
      assert.equal(accepted.outputs[action.components.field], components.join(","));
      for (const observation of rejected) {
        assert.equal(observation.accepted, false, "RUST_PIN_REJECTS_INVALID_INPUT");
        assert.equal(observation.outputText, "", "RUST_PIN_PARTIAL_OUTPUT");
      }
    },
  );
});

void test("release, rehearsal and deep audit Rust callers preserve repository pin, components, targets and caches", async (t) => {
  const setup = await readWorkflow(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
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
  rustAction(setup);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  // Ordinary shims honor the TOML's component requirements before reporting identity.
  assert.match(setup, /& rustc --version --verbose/);
  assert.match(setup, /& cargo --version/);
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
  assert.doesNotMatch(toolchain, /^targets\s*=/m);

  const cachePin = "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0";
  function actionSteps(owner: Record<string, unknown>, reference: string) {
    assert.ok(Array.isArray(owner.steps));
    const steps: unknown[] = owner.steps;
    return steps.filter(
      (step): step is Record<string, unknown> => isRecord(step) && step.uses === reference,
    );
  }
  function assertHostSetup(owner: Record<string, unknown>, cacheSetting?: string) {
    const setupSteps = actionSteps(owner, "./.github/actions/setup-rust");
    const caches = actionSteps(owner, cachePin);
    assert.equal(setupSteps.length, 1);
    assert.equal(caches.length, 1);
    const shim = requiredFixture(setupSteps[0]),
      cache = requiredFixture(caches[0]);
    assert.equal(shim.with, undefined);
    for (const step of [shim, cache]) {
      assert.equal(step.if, undefined);
      assert.equal(step["continue-on-error"], undefined);
    }
    const expected: unknown = cacheSetting ? parseDocument(cacheSetting).toJS() : {};
    assert.deepEqual(cache.with ?? {}, expected);
    assert.doesNotMatch(
      JSON.stringify(owner),
      /dtolnay\/rust-toolchain|RUSTUP_TOOLCHAIN|(?:rustc|cargo) \+|rustup (?:default|override|toolchain|component|target)/,
    );
    assert.ok(Array.isArray(owner.steps) && owner.steps.indexOf(shim) < owner.steps.indexOf(cache));
  }

  for (const [file, name, cacheSetting] of [
    ["release.yml", "validate", undefined],
    ["linux-package-ownership-rehearsal.yml", "build", "key: linux-package-ownership-rehearsal"],
    ["updater-artifact-rehearsal.yml", "packages", "key: updater-artifact-rehearsal"],
    ["deep-quality.yml", "audit", "shared-key: deep-quality-ubuntu-22.04"],
  ] as const) {
    await t.test(`${file} ${name}`, async () => {
      const source = await readWorkflow(new URL(`../.github/workflows/${file}`, import.meta.url));
      const owner = workflowJob(name, source);
      assertHostSetup(owner, cacheSetting);
      for (const replacement of [
        { uses: "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c" },
        { uses: "./.github/actions/setup-rust", with: { toolchain: "stable" } },
        { uses: "./.github/actions/setup-rust", with: { targets: "aarch64-unknown-linux-gnu" } },
        { uses: "./.github/actions/setup-rust", with: { "test-fixtures": true } },
      ]) {
        const changed = structuredClone(owner);
        assert.ok(Array.isArray(changed.steps));
        changed.steps = changed.steps.map((step: unknown) =>
          isRecord(step) && step.uses === "./.github/actions/setup-rust" ? replacement : step,
        );
        assert.throws(() => assertHostSetup(changed, cacheSetting));
      }
      const floating = structuredClone(owner);
      requiredFixture(actionSteps(floating, cachePin)[0]).uses = "Swatinem/rust-cache@floating";
      assert.throws(() => assertHostSetup(floating, cacheSetting));
      if (cacheSetting) {
        const changed = structuredClone(owner);
        requiredFixture(actionSteps(changed, cachePin)[0]).with = { key: "changed" };
        assert.throws(() => assertHostSetup(changed, cacheSetting));
      }
      if (file === "release.yml") {
        for (const [crossJob, target, key] of [
          ["build", "${{ matrix.target }}", "release-${{ matrix.label }}"],
          ["build_intel", "x86_64-apple-darwin", "release-macos-x86_64"],
        ] as const) {
          const cross = workflowJob(crossJob, source);
          const setupSteps = actionSteps(cross, "./.github/actions/setup-rust");
          assert.equal(setupSteps.length, 1);
          assert.deepEqual(requiredFixture(setupSteps[0]).with, { targets: target });
          const cache = requiredFixture(actionSteps(cross, cachePin)[0]);
          assert.ok(isRecord(cache.with));
          assert.equal(cache.with["shared-key"], key);
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

void test("Windows analyzer acquisition retains the exact pin and both mandatory gates", (t) => {
  const lint = workflowStep("windows_storage", "Lint PowerShell scripts");
  assert.equal(lint.shell, "pwsh");
  const script = lint.run;
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

function windowsTemporaryStorageStep(setup: string) {
  const action = rustAction(setup);
  const step = rustTemporaryStorage(action);
  return { action, step };
}
function windowsTemporaryStorageScript(setup: string) {
  return String(windowsTemporaryStorageStep(setup).step.run);
}

void test("Windows fixture setup selects runner-owned temporary storage before compilation", async () => {
  const setup = await readWorkflow(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
  );
  const { action, step } = windowsTemporaryStorageStep(setup);
  const withCondition = (condition: string) => ({
    ...action,
    steps: action.steps.map((candidate) =>
      candidate === step ? { ...step, if: condition } : candidate,
    ),
  });
  for (const condition of [
    "runner.os  ==  'Windows' && inputs.test-fixtures == 'true'",
    "${{ runner.os == 'Windows' && inputs.test-fixtures == 'true' }}",
  ])
    rustTemporaryStorage(withCondition(condition));
  for (const condition of [
    "runner.os == 'Win dows' && inputs.test-fixtures == 'true'",
    "runner.os == 'Windows' && inputs.test-fixtures == 'tr ue'",
    "runner.os == 'Linux' && inputs.test-fixtures == 'true'",
  ])
    assert.throws(
      () => rustTemporaryStorage(withCondition(condition)),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.message.includes("WINDOWS_TEMP_FIXTURE_CONDITION"),
    );
  const selected = action.steps.indexOf(step);
  const compilers = action.steps.filter(
    (candidate) =>
      candidate === action.installer ||
      (typeof candidate.run === "string" &&
        candidate.run.includes("node scripts/run-rust-tests.mts --prepare-only")),
  );
  assert.equal(compilers.length, 2);
  assert.ok(
    compilers.every((candidate) => selected < action.steps.indexOf(candidate)),
    "WINDOWS_TEMP_BEFORE_COMPILATION",
  );
  assert.match(windowsStorage, /scripts\/ci-workflow\.test\.mts/);
});

void test(
  "Windows fixture setup exports a usable directory and rejects invalid roots without partial exports",
  { skip: process.platform !== "win32" },
  async () => {
    const { mkdtemp, mkdir, writeFile, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const setup = await readWorkflow(
      new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    );
    const script = windowsTemporaryStorageScript(setup);
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
