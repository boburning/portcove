import assert from "node:assert/strict";

import { executableNodeCommands, parseNodeTestSuites } from "./node-test-suites.mts";

import { isRecord } from "./runtime-values.mts";

import { readFile, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { discoverCiPlan, qualificationMatrices, writeGithubOutputs } from "./select-ci-plan.mts";
import { parseDocument } from "yaml";

import os from "node:os";
import path from "node:path";

import {
  requiredFixture,
  workflow,
  workflowJob,
  workflowStep,
  executableLines,
  windowsQualificationRunner,
  fastRustTests,
  fastRustQuality,
  rustTests,
  rustWorkspaceTests,
  nativeRust,
  intelBuild,
  intelTests,
  rustDocs,
  rust,
  rustQuality,
} from "./ci-workflow-fixture.mts";

void test("standalone Linux environment tests retain native selection and bounded outcomes", () => {
  const step: Record<string, unknown> & { run: string } = workflowStep(
    "fast_rust_quality",
    "Test Linux update process environment",
  );
  assert.equal(step.if, "contains(fromJSON(needs.classify.outputs.groups_json), 'rust')");
  assert.equal(step["continue-on-error"] ?? false, false);
  assert.equal(workflowJob("fast_rust_quality")["continue-on-error"] ?? false, false);
  assert.deepEqual(executableLines(step.run), [
    'rustc --edition 2024 --test apps/desktop/src-tauri/src/application_update_process_environment.rs -o "$RUNNER_TEMP/portcove-update-environment-tests"',
    'node scripts/standalone-rust-tests.mts "$RUNNER_TEMP/portcove-update-environment-tests"',
  ]);
  const steps = workflowJob("fast_rust_quality").steps;
  assert.ok(Array.isArray(steps));
  const retained: unknown = steps.find(
    (value: unknown) => isRecord(value) && value.name === "Retain standalone Linux test outcomes",
  );
  assert.ok(isRecord(retained));
  assert.equal(
    retained.if,
    "always() && contains(fromJSON(needs.classify.outputs.groups_json), 'rust')",
  );
  assert.equal(retained.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.equal(retained["continue-on-error"] ?? false, false);
  assert.ok(isRecord(retained.with));
  assert.equal(retained.with.path, "work/standalone-rust-tests");
  assert.equal(retained.with["if-no-files-found"], "error");
});

void test("runtime diagnostics retain complete Windows and Linux typed fixture evidence", () => {
  assert.match(fastRustTests, /runs-on: windows-latest/u);
  assert.match(
    fastRustTests,
    /PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR: .*\/work\/runtime-diagnostics\/windows/u,
  );
  assert.match(fastRustTests, /windows-rust-tests\.mts run/u);
  assert.match(fastRustTests, /PORTCOVE_DIAGNOSTICS_SOURCE_REVISION=.*GITHUB_ENV/u);
  const quality = workflowJob("fast_rust_quality");
  assert.ok(Array.isArray(quality.steps));
  const qualitySetup: unknown = quality.steps.find(
    (step: unknown) => isRecord(step) && step.uses === "./.github/actions/setup-rust",
  );
  assert.ok(isRecord(qualitySetup) && isRecord(qualitySetup.with));
  assert.equal(qualitySetup.if, "contains(fromJSON(needs.classify.outputs.groups_json), 'rust')");
  assert.equal(qualitySetup.with["test-fixtures"], true);
  const tests = workflowJob("fast_rust_tests");
  assert.ok(Array.isArray(tests.steps));
  const windowsRetained: unknown = tests.steps.find(
    (step: unknown) =>
      isRecord(step) && step.name === "Retain runtime diagnostics acceptance and latency evidence",
  );
  assert.ok(isRecord(windowsRetained));
  assert.equal(windowsRetained.if, "always()");
  const linuxFixture: Record<string, unknown> & { run: string } = workflowStep(
    "fast_rust_quality",
    "Test typed runtime diagnostics and frontend admission on Linux",
  );
  assert.equal(
    linuxFixture.if,
    "contains(fromJSON(needs.classify.outputs.groups_json), 'rust') && needs.classify.outputs.linux_diagnostics != 'false'",
  );
  assert.equal(linuxFixture["continue-on-error"] ?? false, false);
  assert.doesNotMatch(
    linuxFixture.run,
    /rustc --edition|--workspace|tauri build|continue-on-error/u,
  );
  assert.equal(linuxFixture.shell, "bash"); // Bash's pipefail preserves a failed test before tee.
  const diagnosticCommands = executableLines(linuxFixture.run).filter((line) =>
    line.startsWith("node scripts/run-rust-tests.mts "),
  );
  assert.equal(diagnosticCommands.length, 3);
  for (const command of diagnosticCommands) {
    assert.match(command, /--locked -p portcove-(?:diagnostics|cli|core)/u);
    assert.match(
      command,
      /--test-threads=1 --success-output immediate --failure-output immediate 2>&1 \| tee/u,
    );
    assert.doesNotMatch(
      command,
      /--guard-command|cargo test|--workspace|--nocapture|continue-on-error/u,
    );
  }
  assert.ok(
    diagnosticCommands.some(
      (line) =>
        line.includes("-p portcove-diagnostics ") && line.endsWith('/shared-host-tests.txt"'),
    ),
  );
  assert.ok(
    diagnosticCommands.some(
      (line) =>
        line.includes(
          "-p portcove-cli --test runtime_diagnostics --test host_diagnostics --test desktop_host_diagnostics ",
        ) && line.endsWith('/runtime-tests.txt"'),
    ),
  );
  assert.ok(
    diagnosticCommands.some(
      (line) =>
        line.includes("-p portcove-core -E 'test(support_bundle_export)' ") &&
        line.endsWith('/support-export-tests.txt"'),
    ),
  );
  const setup: Record<string, unknown> & { run: string } = workflowStep(
    "fast_rust_quality",
    "Read pinned Linux diagnostic test runner",
  );
  assert.equal(setup.if, linuxFixture.if);
  assert.match(setup.run, /Get-Content \.github\/quality-tools\.json/u);
  assert.match(setup.run, /Where-Object id -eq "cargo-nextest"/u);
  const owner = workflowJob("fast_rust_quality");
  assert.ok(Array.isArray(owner.steps));
  const steps: unknown[] = owner.steps;
  const installer = steps.find(
    (step) => isRecord(step) && step.name === "Install pinned Linux diagnostic test runner",
  );
  assert.ok(isRecord(installer));
  assert.equal(installer.if, linuxFixture.if);
  assert.equal(installer.uses, "taiki-e/install-action@5488ac5a951645ce95062214902ac4b6bc1a1037");
  assert.deepEqual(installer.with, {
    tool: "${{ steps.linux-diagnostic-test-runner.outputs.spec }}",
  });
  const inventories = steps.find(
    (step) => isRecord(step) && step.name === "Retain Linux diagnostic nextest inventories",
  );
  assert.ok(isRecord(inventories) && isRecord(inventories.with));
  assert.equal(inventories.if, "always() && " + linuxFixture.if);
  assert.equal(inventories.with.path, "work/nextest-default-outcomes/");
  assert.equal(
    inventories.with.name,
    "runtime-diagnostics-nextest-linux-${{ github.run_id }}-${{ github.run_attempt }}",
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
  const retained = steps.find(
    (step) =>
      isRecord(step) && step.name === "Retain Linux runtime diagnostics acceptance evidence",
  );
  assert.ok(isRecord(retained) && isRecord(retained.with));
  assert.equal(retained.if, "always() && " + linuxFixture.if);
  assert.equal(retained.with.path, "work/runtime-diagnostics/linux/");
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
    "scripts/native-qualification-inventory.test.mts",
    "scripts/desktop-staged-layout.test.mts",
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
    "scripts/ci-windows-helpers.test.mts",
  ]);
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

void test("Windows qualification serializes machine-global registry fixtures with a bounded lock", async () => {
  const wrapper = windowsQualificationRunner;
  assert.match(wrapper, /Local\\Portcove\.WindowsQualification\.v1/);
  assert.match(wrapper, /WaitOne\(\[TimeSpan\]::FromSeconds\(\$WaitSeconds\)\)/);
  assert.match(wrapper, /AbandonedMutexException/);
  assert.match(wrapper, /finally \{[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/);
  const registry = parseNodeTestSuites(
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const commands = executableNodeCommands(wrapper, registry);
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
  assert.match(nativeRust, /node scripts\/qualification-nextest\.mts native/);
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

void test("Rust documentation coverage and pinned runners remain connected", async (t) => {
  assert.match(rustTests, /windows-rust-tests\.mts run-qualification/u);
  assert.doesNotMatch(rustTests + rustWorkspaceTests, /--test-threads 1/);
  assert.match(rustDocs, /node scripts\/qualification-rustdoc\.mts workspace/u);
  assert.match(rustDocs, /node scripts\/qualification-rustdoc\.mts desktop/u);
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
