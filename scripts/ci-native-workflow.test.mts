import { readWorkflow } from "./ci-workflow-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import { workflowJobs } from "./qualification-coverage.mts";
import assert from "node:assert/strict";

import test from "node:test";

import {
  requiredFixture,
  workflowJob,
  workflowJobSource,
  workflowStep,
  executableLines,
  nativeDesignCompatibilityWorkflow,
  nativeCompatibilityRunner,
  desktopScripts,
  rustWorkspaceTests,
} from "./ci-workflow-fixture.mts";

void test("candidate consumer selects only existing selected, compiled and history jobs", () => {
  const jobs = workflowJobs(nativeDesignCompatibilityWorkflow);
  const consumers = Object.entries(jobs).filter(
    ([name, job]) =>
      name.startsWith("hosted_") &&
      typeof job.if === "string" &&
      job.if.includes("candidate-consumer"),
  );
  assert.deepEqual(consumers.map(([name]) => name).sort(), [
    "hosted_compiled",
    "hosted_history",
    "hosted_selected",
  ]);
  for (const [name, minutes, phase] of [
    ["hosted_selected", 60, "selected"],
    ["hosted_compiled", 120, "compiled"],
    ["hosted_history", 45, "native"],
  ] as const) {
    const job = requiredFixture(jobs[name]);
    assert.equal(job["timeout-minutes"], minutes);
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.ok(Array.isArray(job.steps));
    const steps: unknown[] = job.steps;
    assert.ok(
      steps.some(
        (step) =>
          isRecord(step) && isRecord(step.with) && step.with["persist-credentials"] === false,
      ),
    );
    assert.ok(
      steps.some(
        (step) =>
          isRecord(step) &&
          typeof step.run === "string" &&
          step.run.trim().endsWith("hosted-validation " + phase),
      ),
    );
    assert.doesNotMatch(
      workflowJobSource(nativeDesignCompatibilityWorkflow, name),
      /upload-artifact|actions\/cache|cache: pnpm/u,
    );
  }
});

void test("reviewed hosted phases retain independent allocations, fixed commands and read-only isolation", () => {
  const source = nativeDesignCompatibilityWorkflow;
  for (const [name, limit, phase] of [
    ["hosted_selected", 60, "selected"],
    ["hosted_audit", 30, "audit"],
    ["hosted_compiled", 120, "compiled"],
    ["hosted_history", 45, "native"],
  ] as const) {
    const section = workflowJobSource(source, name);
    assert.ok(section);
    assert.match(section, new RegExp(`timeout-minutes: ${limit}`));
    assert.match(section, /runs-on: ubuntu-24\.04/);
    assert.match(section, /persist-credentials: false/);
    assert.match(section, new RegExp(`hosted-validation ${phase}`));
    assert.match(section, /emit-hosted hosted-evidence/);
    assert.doesNotMatch(
      section,
      /upload-artifact|actions\/cache|rust-cache|secrets\.|VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE/,
    );
  }
  assert.match(source, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(source, /checks: write|contents: write|pull_request_target/);
});

void test("hosted selected setup prepares the provider observed by preflight and used by selected recipes", () => {
  const selected = workflowJobSource(nativeDesignCompatibilityWorkflow, "hosted_selected");
  const install = selected.indexOf("run: corepack pnpm install --frozen-lockfile");
  const preflight = selected.indexOf("hosted-validation provision");
  assert.ok(install >= 0 && install < preflight);
  const job = workflowJob("hosted_selected", nativeDesignCompatibilityWorkflow);
  assert.ok(Array.isArray(job.steps));
  const setup: unknown = job.steps.find(
    (step: unknown) => isRecord(step) && step.run === "corepack pnpm install --frozen-lockfile",
  );
  assert.ok(isRecord(setup));
  assert.equal(setup["working-directory"], "source");
  assert.doesNotMatch(
    selected,
    /COREPACK_ENABLE_PROJECT_SPEC: ["']?0|COREPACK_ENABLE_NETWORK: ["']?0/u,
  );
});

void test("hosted backup focus is manual-only, pinned, isolated and retains real evidence without billed storage", async () => {
  const source = await readWorkflow(
    new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
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
  const windows = workflowJobSource(source, "backup_focus");
  assert.ok(windows);
  assert.doesNotMatch(
    windows,
    /VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE|upload-artifact|rust-cache|actions\/cache|cache: pnpm/,
  );
  assert.equal(
    requiredFixture(workflowJobs(source).qualify).if,
    "${{ inputs.operation == 'compatibility' && !inputs.edge_driver_proof && inputs.runner != 'windows-2022' }}",
  );
  assert.equal(
    workflowJob("backup_focus", source).if,
    "${{ inputs.operation == 'compatibility' && !inputs.edge_driver_proof && inputs.runner == 'windows-2022' }}",
  );
  assert.match(windows, /PORTCOVE_TEMP_DIR: \$\{\{ github.workspace \}\}/);
  assert.doesNotMatch(requiredFixture(windows.split("    steps:")[0]), /\$\{\{ runner\./);
  assert.match(windows, /id: native-quality-pins/);
  assert.match(windows, /node scripts\/quality-tools.mts --github-output >> \$env:GITHUB_OUTPUT/);
  assert.match(windows, /taiki-e\/install-action@1e29709c0ec63babbe8f266397a465f29a825f91/);
  assert.match(windows, /tool: \$\{\{ steps.native-quality-pins.outputs.required_prebuilt \}\}/);
  assert.ok(
    windows.indexOf("Provision existing pinned prebuilt quality tools") <
      windows.indexOf("./scripts/bootstrap-quality-tools.ps1 -Desktop"),
  );

  assert.match(source, /if: always\(\)[\s\S]*native-backup-evidence.mts emit/);
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Required evidence retention failed/);
});

void test("native design compatibility remains explicit, isolated, and non-publishing", () => {
  assert.match(nativeDesignCompatibilityWorkflow, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /^ {2}(pull_request|push|schedule):/m);
  assert.match(nativeDesignCompatibilityWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /options:\r?\n {10}- ubuntu-22\.04\r?\n {10}- ubuntu-24\.04\r?\n {10}- macos-15\r?\n {10}- macos-15-intel/,
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
    desktopScripts["lint:style"],
    'stylelint --config stylelint.config.mjs --max-warnings 0 "src/**/*.css"',
  );
});

void test("fixed-account cases execute on Windows in both fast and qualification plans", () => {
  for (const job of ["windows_helpers", "windows_storage"]) {
    assert.equal(workflowJob(job)["runs-on"], "windows-latest");
    assert.deepEqual(
      executableLines(
        workflowStep(job, "Test inert fixed-account setup and capability contracts on Windows").run,
      ),
      [
        "node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/release-local-worker-accounts.test.mts scripts/release-native-account-capability.test.mts scripts/recover-local-worker-empty-setup.test.mts scripts/release-native-runtime-custody.test.mts scripts/release-hosted-native-windows-setup.test.mts",
      ],
    );
  }
});

void test("Playnite qualification installs pinned workspace dependencies before its lifecycle consumer", () => {
  const setup = rustWorkspaceTests.indexOf(
    "      - name: Install pinned dependencies for Playnite transport validation\n",
  );
  const consumer = rustWorkspaceTests.indexOf(
    "      - name: Build and test the public Playnite reference consumer\n",
  );
  assert.ok(setup >= 0 && consumer > setup);
  const dependencies = rustWorkspaceTests.slice(setup, consumer);
  assert.match(
    dependencies,
    /uses: voidzero-dev\/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76/,
  );
  assert.match(dependencies, /version-file: pnpm-workspace\.yaml/);
  assert.match(dependencies, /node-version-file: \.node-version/);
  assert.match(dependencies, /args: \[--frozen-lockfile\]/);
  assert.doesNotMatch(dependencies, /--prod|--filter|--ignore-scripts|continue-on-error/);
  assert.match(rustWorkspaceTests.slice(consumer), /\.\/integrations\/playnite\/check\.ps1 -Cli/);
  assert.doesNotMatch(rustWorkspaceTests.slice(consumer), /-ContractsOnly/);
});
