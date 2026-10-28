import { readWorkflow } from "./ci-workflow-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import { workflowJobs } from "./qualification-coverage.mts";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";

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
  const quality = workflowJob("backup_focus", source);
  assert.ok(Array.isArray(quality.steps));
  const qualitySteps = quality.steps.filter(isRecord);
  const provisioning = qualitySteps.findIndex(
    (step) =>
      step.uses === "taiki-e/install-action@1e29709c0ec63babbe8f266397a465f29a825f91" &&
      isRecord(step.with) &&
      step.with.tool === "${{ steps.native-quality-pins.outputs.required_prebuilt }}",
  );
  const bootstrap = qualitySteps.findIndex(
    (step) =>
      typeof step.run === "string" &&
      executableLines(step.run).includes("./scripts/bootstrap-quality-tools.ps1 -Desktop"),
  );
  assert.ok(provisioning >= 0, "Pinned quality provisioning must execute");
  assert.ok(bootstrap > provisioning, "Pinned quality tools must precede Desktop bootstrap");
  for (const index of [provisioning, bootstrap]) {
    const step = qualitySteps[index];
    assert.ok(step);
    assert.ok(!("if" in step), "Required setup is unconditional within its selected job");
    assert.ok(!("continue-on-error" in step), "Required setup failures must propagate");
  }
  const bootstrapStep = qualitySteps[bootstrap];
  assert.ok(bootstrapStep && typeof bootstrapStep.run === "string");
  // Normalize the maintained direct-call recipe, preserving statement order,
  // exit guards and inputs while allowing layout and diagnostic wording changes.
  const normalizeBootstrap = (value: string) =>
    executableLines(value.replace(/`\r?\n/gu, " "))
      .join(" ")
      .replace(/throw\s+(?:'(?:[^']|'')*'|"(?:[^"`]|`.)*")/gu, "throw '<failure>'")
      .replace(/(["'])Stop\1/gu, "'Stop'")
      .replace(/\s+/gu, " ")
      .replace(/\s*([{}();])\s*/gu, "$1")
      .replace(/;(?=pnpm\b|if\b|\.\/scripts|\}|$)/gu, "")
      .trim();
  assert.equal(
    normalizeBootstrap(bootstrapStep.run),
    normalizeBootstrap(`
    $ErrorActionPreference = 'Stop'
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '<failure>' }
    ./scripts/bootstrap-quality-tools.ps1 -Desktop
    if ($LASTEXITCODE -ne 0) { throw '<failure>' }
  `),
  );

  assert.match(source, /if: always\(\)[\s\S]*native-backup-evidence.mts emit/);
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Required evidence retention failed/);
});

void test("native design compatibility remains explicit, isolated, and non-publishing", () => {
  assert.match(nativeDesignCompatibilityWorkflow, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /^ {2}(pull_request|push|schedule):/m);
  assert.match(nativeDesignCompatibilityWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  const configuration: unknown = parseDocument(nativeDesignCompatibilityWorkflow).toJS();
  assert.ok(isRecord(configuration) && isRecord(configuration.on));
  const dispatch = configuration.on.workflow_dispatch;
  assert.ok(isRecord(dispatch) && isRecord(dispatch.inputs) && isRecord(dispatch.inputs.runner));
  assert.ok(Array.isArray(dispatch.inputs.runner.options));
  const options: unknown[] = dispatch.inputs.runner.options;
  const runners = options.map((option) => {
    assert.ok(typeof option === "string");
    return option;
  });
  assert.deepEqual(
    runners.sort((left, right) => left.localeCompare(right)),
    ["ubuntu-22.04", "ubuntu-24.04", "macos-15", "macos-15-intel", "windows-2022"].sort(
      (left, right) => left.localeCompare(right),
    ),
  );
  const harness = Object.values(workflowJobs(nativeDesignCompatibilityWorkflow))
    .flatMap((job) => (isRecord(job) && Array.isArray(job.steps) ? job.steps.filter(isRecord) : []))
    .filter(
      (step) =>
        step.if === "runner.os == 'Linux'" &&
        typeof step.run === "string" &&
        /\btest:desktop\b/u.test(step.run),
    );
  const commands = harness.flatMap((step) => {
    assert.equal(typeof step.run, "string");
    return executableLines(String(step.run).replace(/\\\r?\n/gu, " "));
  });
  const desktop = commands.filter((line) =>
    /^xvfb-run\s+-a\s+dbus-run-session\s+--\s+pnpm\s+--dir\s+apps\/desktop\s+test:desktop\b/u.test(
      line,
    ),
  );
  assert.equal(desktop.length, 1, "One real Linux native Desktop harness must execute");
  const normalizeLinux = (value: string) =>
    executableLines(value.replace(/\\\r?\n/gu, " "))
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
  assert.equal(harness.length, 1);
  const linux = harness[0];
  assert.ok(linux && typeof linux.run === "string");
  assert.ok(!("continue-on-error" in linux));
  assert.equal(
    normalizeLinux(linux.run),
    normalizeLinux(String.raw`
    pnpm --dir apps/desktop build
    cargo build --locked -p portcove-desktop --features tauri/custom-protocol
    xvfb-run -a dbus-run-session -- pnpm --dir apps/desktop test:desktop \
      --app "$(realpath target/debug/portcove-desktop)" \
      --driver "$(command -v tauri-driver)" \
      --native-driver "$(command -v WebKitWebDriver)" \
      --output "$PWD/work/native-compatibility-evidence/linux" \
      --scenario native-design-system-compatibility
  `),
  );
  assert.ok(
    desktop.some((line) => /\btest:desktop\s+--app\b/u.test(line)),
    "The app argument must reach the existing Desktop harness",
  );
  assert.ok(
    desktop.every((line) => !/\btest:desktop\s+--\s/u.test(line)),
    "An extra argument separator must not hide harness arguments",
  );
  assert.ok(
    desktop.some((line) => /--scenario\s+native-design-system-compatibility(?:\s|$)/u.test(line)),
  );
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

function assertPlayniteLifecycle(job: Record<string, unknown>) {
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const setups = steps.flatMap((step, index) =>
    isRecord(step) &&
    typeof step.uses === "string" &&
    step.uses.startsWith("voidzero-dev/setup-vp@")
      ? [{ step, index }]
      : [],
  );
  const consumers = steps.flatMap((step, index) =>
    isRecord(step) &&
    typeof step.run === "string" &&
    executableLines(step.run).some((line) =>
      /^(?:&\s+)?\.\/integrations\/playnite\/check\.ps1\s+-Cli\b/u.test(line),
    )
      ? [{ step, index }]
      : [],
  );
  assert.equal(setups.length, 1, "one pinned dependency setup is required");
  assert.equal(consumers.length, 1, "one real lifecycle consumer is required");
  const setup = setups[0]!;
  const consumer = consumers[0]!;
  assert.ok(setup.index < consumer.index, "dependencies must precede their consumer");
  assert.equal(setup.step.uses, "voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76");
  assert.ok(isRecord(setup.step.with));
  assert.equal(setup.step.with["version-file"], "pnpm-workspace.yaml");
  assert.equal(setup.step.with["node-version-file"], ".node-version");
  assert.equal(typeof setup.step.with["run-install"], "string");
  const installation = parseDocument(String(setup.step.with["run-install"]), { uniqueKeys: true });
  assert.equal(installation.errors.length, 0);
  const install: unknown = installation.toJS();
  assert.ok(isRecord(install));
  assert.deepEqual(install.args, ["--frozen-lockfile"]);
  assert.ok(!("continue-on-error" in setup.step));
  assert.ok(!("continue-on-error" in consumer.step));
  assert.ok(!("if" in setup.step), "dependency setup must be unconditional within this job");
  assert.ok(!("if" in consumer.step), "lifecycle execution must be unconditional within this job");
  assert.equal(typeof consumer.step.run, "string");
  const commands = executableLines(String(consumer.step.run)).join("\n");
  assert.match(commands, /^(?:&\s+)?\.\/integrations\/playnite\/check\.ps1\s+-Cli\b/mu);
  assert.doesNotMatch(commands, /-ContractsOnly/u);
}

void test("Playnite qualification installs pinned workspace dependencies before its lifecycle consumer", () => {
  const original = workflowJob("rust_workspace_tests");
  assertPlayniteLifecycle(original);
  const renamed = structuredClone(original);
  assert.ok(Array.isArray(renamed.steps));
  renamed.steps = renamed.steps.map((step: unknown, index: number) =>
    isRecord(step) ? { ...step, name: "Harmless display label " + index } : step,
  );
  assertPlayniteLifecycle(renamed);
  for (const variant of [
    "missing-setup",
    "unfrozen",
    "contracts-only",
    "wrong-order",
    "suppressed",
    "inert-string",
    "echo-only",
    "comment-only",
    "disabled",
  ]) {
    const changed = structuredClone(original);
    assert.ok(Array.isArray(changed.steps));
    const setup = changed.steps.findIndex(
      (step: unknown) =>
        isRecord(step) &&
        typeof step.uses === "string" &&
        step.uses.startsWith("voidzero-dev/setup-vp@"),
    );
    const consumer = changed.steps.findIndex(
      (step: unknown) =>
        isRecord(step) &&
        typeof step.run === "string" &&
        step.run.includes("./integrations/playnite/check.ps1"),
    );
    const dependency: unknown = changed.steps[setup];
    const lifecycle: unknown = changed.steps[consumer];
    assert.ok(
      isRecord(dependency) &&
        isRecord(dependency.with) &&
        isRecord(lifecycle) &&
        typeof lifecycle.run === "string",
    );
    if (variant === "missing-setup") changed.steps.splice(setup, 1);
    if (variant === "unfrozen") dependency.with["run-install"] = "args: []";
    if (variant === "contracts-only") lifecycle.run += " -ContractsOnly";
    if (variant === "wrong-order")
      [changed.steps[setup], changed.steps[consumer]] = [lifecycle, dependency];
    if (variant === "suppressed") lifecycle["continue-on-error"] = true;
    if (variant === "inert-string")
      lifecycle.run = "Write-Host './integrations/playnite/check.ps1 -Cli'";
    if (variant === "echo-only") lifecycle.run = "echo './integrations/playnite/check.ps1 -Cli'";
    if (variant === "comment-only") lifecycle.run = "# ./integrations/playnite/check.ps1 -Cli";
    if (variant === "disabled") lifecycle.if = false;
    assert.throws(() => assertPlayniteLifecycle(changed), { name: "AssertionError" }, variant);
  }
});
