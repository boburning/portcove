import { isRecord } from "./runtime-values.mts";
import type { PrerequisiteObservation } from "./local-validation.mts";
import type { LocalChange, ValidationCommand } from "./ordinary-validation.mts";
import type {
  RepositoryInventory,
  InventoryFile,
  ValidationDomain,
} from "./validation-evidence.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildPlan,
  classifyChanges,
  deduplicateCommands,
  executePlan,
  executePlanWithReceipts,
  fingerprintLocalStage,
  formatCommand,
  localChangesFromRaw,
  requireFocusedArguments,
  storageScopeForPlan,
  untrackedFileMode,
  buildExecutionPreflight,
  selectedPlanInventory,
  inspectHostedLocalRoute,
  main,
} from "./local-validation.mts";
import { buildValidationPlan } from "./validation-plan.mts";
import { resolveUiSelection } from "./ui-test-selection.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";

void test("maintenance registry and TOML sources retain explicit focused owners", () => {
  const consumer = "scripts/lock-maintenance-policy.test.mts";
  for (const file of [
    "scripts/lock-maintenance-policy.mts",
    "scripts/lock-maintenance-registry.mts",
    "scripts/cargo-lock-inventory.py",
    "scripts/dependency-security.mts",
    "scripts/pnpm-lock-inventory.mts",
  ]) {
    for (const status of ["A", "M", "D"]) {
      const selected = classifyChanges([{ status, path: file }], { fileExists: () => false });
      assert.ok(selected.nodeTests.has(consumer), `${status}: ${file}`);
      assert.ok(!selected.unknown.has(file), `${status}: ${file}`);
    }
  }
  assert.ok(
    classifyChanges([{ status: "M", path: "scripts/dependency-security.mts" }], {
      fileExists: () => false,
    }).nodeTests.has("scripts/dependency-security.test.mts"),
  );
  assert.ok(!classifyChanges([{ status: "M", path: "docs/README.md" }]).nodeTests.has(consumer));
});

const allFilesExist = () => true;

void test("native helper consumers survive shared custody registration across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const consumers: [string, string[]][] = [
    ["native-linux-isolated-session.mts", ["native-linux-isolated-plan", "desktop-linux-stop"]],
    ["native-linux-isolated-plan.mts", ["native-linux-isolated-plan"]],
    ["native-linux-public-plan.mts", ["native-linux-public-plan"]],
    ["native-linux-driver-http.mts", ["native-linux-driver-http"]],
    ["native-linux-isolated-init.py", ["native-linux-isolated-init"]],
    ["desktop-native-account-session.mts", ["desktop-native-account-session"]],
  ];
  const shared = [
    "native-helper-dependencies",
    "native-confirmation",
    "desktop-execution-plan",
    "windows-helper-checks",
  ];
  for (const [name, own] of consumers)
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const file = `apps/desktop/scripts/${name}`;
      const oldPath = variant === "R-new" ? "docs/moved.md" : file;
      const newPath = variant === "R-old" ? "docs/moved.md" : file;
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath,
        newPath,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ ...change, path: newPath, ...(oldPath !== newPath ? { previousPath: oldPath } : {}) }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      for (const tests of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        for (const consumer of [...own, ...shared])
          assert.ok(
            tests.has(`scripts/${consumer}.test.mts`),
            `${variant}: ${name} -> ${consumer}`,
          );
    }
  for (const path of ["docs/unrelated.md", "apps/desktop/src/components/OperationCancellation.tsx"])
    assert.ok(
      !classifyChanges([{ status: "M", path }]).nodeTests.has(
        "scripts/native-linux-isolated-plan.test.mts",
      ),
    );
});

void test("native dependency edits retain lifecycle consumers and the existing frontend route", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const inputs = [
    "native-linux-isolated-plan.mts",
    "native-linux-public-plan.mts",
    "native-linux-driver-http.mts",
    "native-linux-isolated-init.py",
  ];
  const expected = [
    "scripts/native-linux-public-plan.test.mts",
    "scripts/release-native-linux-driver.test.mts",
    "scripts/release-hosted-native-linux-report.test.mts",
    "apps/desktop/scripts/desktop-linux-public-update.native.test.mts",
  ];
  for (const name of inputs) {
    const path = `apps/desktop/scripts/${name}`;
    const selection = classifyChanges([{ status: "M", path }]);
    const plan = buildValidationPlan({
      changes: [{ status: "M", path, oldMode: "100644", newMode: "100644" }],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    for (const selected of [selection.nodeTests, new Set(baselineContractTests(plan))])
      for (const consumer of expected) assert.ok(selected.has(consumer), `${name} -> ${consumer}`);
    assert.ok(selection.ui, "native helper changes retain their existing frontend route");
  }
  const registry = classifyChanges([
    { status: "M", path: "scripts/native-helper-dependencies.mts" },
  ]);
  for (const consumer of [
    ...expected,
    "apps/desktop/scripts/desktop-windows-public-update.native.test.mts",
    "scripts/desktop-native-account-session.test.mts",
  ])
    assert.ok(registry.nodeTests.has(consumer), consumer);
  const unrelated = classifyChanges([
    { status: "M", path: "apps/desktop/src/components/OperationCancellation.tsx" },
  ]);
  for (const consumer of expected) assert.ok(!unrelated.nodeTests.has(consumer), consumer);
  const mixed = classifyChanges([
    { status: "M", path: "apps/desktop/src/components/OperationCancellation.tsx" },
    { status: "M", path: "apps/desktop/scripts/native-linux-isolated-plan.mts" },
  ]);
  for (const consumer of expected) assert.ok(mixed.nodeTests.has(consumer), consumer);
});

void test("release recovery and validation inputs retain their independent consumers", () => {
  for (const [path, consumer] of [
    ["scripts/release-semantic-worker-recovery.mts", "scripts/release-semantic-worker.test.mts"],
    ["scripts/ordinary-validation.mts", "scripts/validation-evidence.test.mts"],
    ["scripts/local-validation.mts", "scripts/repository-settings.test.mts"],
  ] as const) {
    const selected = classifyChanges([{ status: "M", path }], { fileExists: () => false });
    assert.ok(selected.nodeTests.has(consumer), `${path} -> ${consumer}`);
  }
});

void test("native observer fixture edits retain the owning Windows regression suite", () => {
  const fixture = "scripts/fixtures/native-desktop-observer.cs.txt";
  for (const change of [
    { status: "M", path: fixture },
    { status: "A", path: fixture },
    { status: "D", path: fixture },
    { status: "R100", path: "docs/moved.md", previousPath: fixture },
    { status: "R100", path: fixture, previousPath: "docs/moved.md" },
  ]) {
    const selected = classifyChanges([change], { fileExists: () => false });
    assert.ok(selected.nodeTests.has("scripts/release-hosted-native-windows-setup.test.mts"));
  }
});

void test("portability literal baseline retains its native scanner contract across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const input = "scripts/fixtures/rscheck-portability-baseline.json";
  const sibling = "scripts/fixtures/rscheck-portability-baseline-sibling.json";
  for (const file of [input, sibling])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      for (const selected of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        assert.equal(
          selected.has("scripts/run-rscheck.test.mts"),
          file === input,
          JSON.stringify(change),
        );
    }
});

void test("manual job timeout inputs retain direct contracts across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    ".node-version",
    "scripts/runtime-values.mts",
    "scripts/resource-command.mts",
    "scripts/heavy-rust-test-lock.mts",
    "scripts/ci-job-timeout-probe.mts",
    ".github/workflows/job-timeout-rehearsal.yml",
    "scripts/ci-job-timeout-probe-sibling.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      for (const selected of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        assert.equal(
          selected.has("scripts/ci-job-timeout-probe.test.mts"),
          !file.includes("-sibling"),
          JSON.stringify(change),
        );
    }
});

void test("browser artifact custody inputs retain direct contracts across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const inputs = [
    ".github/actions/retain-browser-diagnostics/action.yml",
    ".github/workflows/browser-artifact-custody.yml",
    "scripts/fixtures/browser-upload-baseline.json",
    "apps/desktop/scripts/browser-screenshot-custody.mts",
  ];
  const sibling = "scripts/fixtures/browser-upload-baseline-sibling.json";
  for (const file of [...inputs, sibling])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      for (const selected of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        assert.equal(
          selected.has("scripts/ci-frontend-workflow.test.mts"),
          file !== sibling,
          JSON.stringify(change),
        );
    }
});

void test("qualification outcome helpers retain all direct consumers across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const paths = [
    "scripts/qualification-nextest.mts",
    "scripts/runtime-values.mts",
    "scripts/fixtures/nextest-inventory-baseline.json",
    "scripts/nextest-outcomes.mts",
    "scripts/nextest-skip-routes.mts",
    ".node-version",
    ".github/quality-tools.json",
  ];
  for (const file of [...paths, "scripts/fixtures/nextest-inventory-baseline-sibling.json"])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = baselineContractTests(
        buildValidationPlan({
          changes: [change],
          eventName: "pull_request",
          base: "a".repeat(40),
          mergeBase: "a".repeat(40),
          head: "b".repeat(40),
          checkout: "b".repeat(40),
        }),
        { fileExists: () => false },
      );
      const expected = paths.includes(file);
      for (const selected of [local.nodeTests, new Set(hosted)])
        assert.equal(
          selected.has("scripts/qualification-nextest.test.mts"),
          expected,
          JSON.stringify(change),
        );
      if (
        [
          "scripts/qualification-nextest.mts",
          "scripts/nextest-outcomes.mts",
          "scripts/nextest-skip-routes.mts",
          "scripts/runtime-values.mts",
        ].includes(file)
      )
        for (const selected of [local.nodeTests, new Set(hosted)])
          for (const consumer of ["scripts/audit.test.mts", "scripts/precommit-check.test.mts"])
            assert.ok(selected.has(consumer), `${JSON.stringify(change)} must retain ${consumer}`);
    }
});

void test("native input observation and its fixed oracle retain direct consumers across lifecycle edits", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const consumer = "scripts/desktop-input-observation.test.mts";
  const sibling = "scripts/fixtures/desktop-input-observation-baseline-sibling.json";
  for (const file of [
    "scripts/native-helper-dependencies.mts",
    "apps/desktop/scripts/desktop-test.mts",
    "scripts/fixtures/desktop-input-observation-baseline.json",
    sibling,
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      assert.equal(local.nodeTests.has(consumer), file !== sibling, JSON.stringify(change));
      assert.equal(hosted.includes(consumer), file !== sibling, JSON.stringify(change));
      if (file === "scripts/native-helper-dependencies.mts")
        for (const retained of [
          "native-helper-dependencies",
          "native-confirmation",
          "desktop-execution-plan",
          "windows-helper-checks",
        ]) {
          assert.ok(local.nodeTests.has(`scripts/${retained}.test.mts`));
          assert.ok(hosted.includes(`scripts/${retained}.test.mts`));
        }
    }
});

void test("opt-in Rust coverage inputs retain contracts across lifecycle and rename edits", () => {
  for (const input of [
    "scripts/rust-coverage.mts",
    ".config/rust-coverage.json",
    "scripts/test-coverage-config.mts",
    "scripts/quality-tools.mts",
    "scripts/resource-command.mts",
    "scripts/resource-capacity.mts",
    "scripts/prepared-file-replacement.mts",
    "scripts/runtime-values.mts",
  ]) {
    for (const change of [
      { status: "M", path: input },
      { status: "A", path: input },
      { status: "D", path: input },
      { status: "R100", previousPath: input, path: "docs/moved.md" },
      { status: "R100", previousPath: "docs/moved.md", path: input },
    ]) {
      const selected = classifyChanges([change], { fileExists: () => false });
      assert.ok(selected.nodeTests.has("scripts/rust-coverage.test.mts"), JSON.stringify(change));
      if (input === "scripts/test-coverage-config.mts")
        assert.ok(selected.nodeTests.has("scripts/ui-test-selection.test.mts"));
    }
  }
});

void test("qualification archive helper and oracle retain surviving contracts without sibling inference", () => {
  for (const file of [
    "scripts/windows-qualification-rust.mts",
    "scripts/fixtures/windows-qualification-selection.json",
  ])
    for (const change of [
      { status: "M", path: file },
      { status: "A", path: file },
      { status: "D", path: file },
      { status: "R100", previousPath: file, path: "docs/moved.md" },
      { status: "R100", previousPath: "docs/moved.md", path: file },
    ]) {
      const selected = classifyChanges([change], { fileExists: () => false });
      for (const contract of [
        "windows-rust-tests",
        "ci-rust-workflow",
        "qualification-coverage",
        "ci-result-gate",
      ])
        assert.ok(
          selected.nodeTests.has(`scripts/${contract}.test.mts`),
          `${JSON.stringify(change)}:${contract}`,
        );
    }
});

void test("workflow contract families preserve surviving consumers across direct, missing and renamed inputs", () => {
  const contracts = [
    "scripts/ci-workflow.test.mts",
    "scripts/ci-frontend-workflow.test.mts",
    "scripts/ci-windows-helpers.test.mts",
    "scripts/ci-native-workflow.test.mts",
    "scripts/ci-release-workflow.test.mts",
    "scripts/ci-rust-workflow.test.mts",
    "scripts/native-backup-evidence.test.mts",
    "scripts/rust-toolchain-reader.test.mts",
    "scripts/windows-rust-tests.test.mts",
  ];
  const formerCompanions = [
    "scripts/check-catalog-repositories.test.mts",
    "scripts/check-retcomm-upstreams.test.mts",
    "scripts/deep-audit-summary.test.mts",
  ];
  for (const input of [
    ...contracts,
    "scripts/ci-workflow-fixture.mts",
    "scripts/windows-rust-tests.mts",
    "scripts/node-test-suites.json",
    ".github/workflows/ci.yml",
    ".github/actions/setup-rust/read-toolchain.ps1",
  ]) {
    for (const change of [
      { status: "M", path: input },
      { status: "A", path: input },
      { status: "D", path: input },
      { status: "R100", previousPath: input, path: "docs/moved-contract.md" },
      { status: "R100", previousPath: "docs/moved-contract.md", path: input },
    ]) {
      const removed = change.status === "D" ? change.path : change.previousPath;
      // No sibling fallback can hide a missing explicit ownership route.
      const selection = classifyChanges([change], { fileExists: () => false });
      for (const expected of [...contracts, ...formerCompanions]) {
        if (expected === removed && contracts.includes(expected))
          assert.equal(selection.nodeTests.has(expected), false, JSON.stringify(change));
        else assert.ok(selection.nodeTests.has(expected), `${JSON.stringify(change)}:${expected}`);
      }
    }
  }
  const mixed = classifyChanges(
    [
      { status: "M", path: "scripts/ci-workflow-fixture.mts" },
      { status: "R100", previousPath: "scripts/windows-rust-tests.mts", path: "docs/moved.md" },
      { status: "M", path: "apps/desktop/src/App.tsx" },
    ],
    { fileExists: allFilesExist },
  );
  assert.equal(mixed.ui, true);
  for (const file of contracts) assert.ok(mixed.nodeTests.has(file));
  const unrelated = classifyChanges([{ status: "M", path: "docs/unrelated-guide.md" }]);
  assert.equal(
    contracts.some((file) => unrelated.nodeTests.has(file)),
    false,
  );
});

void test("required Node execution and diagnostic edits retain their affected caller contracts", () => {
  const required = "scripts/required-node-test-reporter.test.mts";
  for (const [helper, consumers] of [
    [
      "scripts/required-node-test-reporter.mts",
      [required, "scripts/ci-baseline.test.mts", "scripts/node-test-inventory.test.mts"],
    ],
    ["scripts/test-duration-reporter.mts", [required, "scripts/test-duration-reporter.test.mts"]],
    ["scripts/node-case-observations.mts", [required, "scripts/test-duration-reporter.test.mts"]],
  ] as const) {
    for (const change of [
      { status: "M", path: helper },
      { status: "A", path: helper },
      { status: "D", path: helper },
      { status: "R100", previousPath: helper, path: "docs/renamed.md" },
      { status: "R100", previousPath: "docs/renamed.md", path: helper },
    ]) {
      const selection = classifyChanges([change], { fileExists: allFilesExist });
      for (const consumer of consumers) assert.ok(selection.nodeTests.has(consumer), consumer);
      const command = buildPlan(selection).find((entry) => entry.id === "node-tests");
      assert.ok(command);
      assert.ok(command.args.includes("--test-reporter=./scripts/required-node-test-reporter.mts"));
      for (const consumer of consumers) assert.ok(command.args.includes(consumer), consumer);
    }
  }
});

void test("selected nextest outcome edits retain native execution and every outcome consumer", () => {
  const helper = "scripts/nextest-outcomes.mts";
  for (const change of [
    { status: "M", path: helper },
    { status: "A", path: helper },
    { status: "D", path: helper },
    { status: "R100", previousPath: helper, path: "docs/renamed.md" },
    { status: "R100", previousPath: "docs/renamed.md", path: helper },
  ]) {
    const selection = classifyChanges([change], { fileExists: allFilesExist });
    for (const consumer of [
      "scripts/run-rust-tests.test.mts",
      "scripts/nextest-outcomes.test.mts",
      "scripts/rust-test-impact.test.mts",
      "scripts/ci-workflow.test.mts",
    ])
      assert.ok(selection.nodeTests.has(consumer), consumer);
    const hosted = buildValidationPlan({
      changes: [
        {
          status: change.status,
          oldPath: change.previousPath ?? change.path,
          newPath: change.path,
          oldMode: change.status === "A" ? "000000" : "100644",
          newMode: change.status === "D" ? "000000" : "100644",
        },
      ],
      eventName: "pull_request",
      checkout: "a".repeat(40),
      head: "a".repeat(40),
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
    });
    assert.ok(hosted.groups.includes("rust"));
  }
  for (const name of [
    "passed.jsonl",
    "failing.jsonl",
    "ignored.jsonl",
    "inventory.json",
    "provenance.json",
  ])
    assert.ok(
      classifyChanges([{ status: "M", path: `scripts/fixtures/nextest-outcomes/${name}` }], {
        fileExists: allFilesExist,
      }).nodeTests.has("scripts/nextest-outcomes.test.mts"),
    );
});

void test("disposable fixture helper changes retain every cleanup consumer across lifecycle and rename edits", async () => {
  const { baselineRequiresDesktopDependencies, baselineFrontendPlan, baselineContractTests } =
    await import("./ci-baseline.mts");
  const helper = "scripts/fixtures/disposable-directory.mts";
  const desktop = "apps/desktop/scripts/desktop-listener-lifetime.test.mts";
  const consumers = [
    "apps/desktop/scripts/desktop-listener-lifetime.test.mts",
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/desktop-boundary-wiring.test.mts",
    "scripts/desktop-staged-layout.test.mts",
    "scripts/fixture-module-closure.test.mts",
    "scripts/node-test-inventory.test.mts",
    "scripts/node-platform-skips.test.mts",
    "scripts/precommit-check.test.mts",
    "scripts/python-test-results.test.mts",
    "scripts/release-catalog-review-request.test.mts",
    "scripts/release-control-inputs.test.mts",
    "scripts/release-hosted-native-history.test.mts",
    "scripts/release-hosted-native-linux-capture.test.mts",
    "scripts/release-hosted-native-linux-report.test.mts",
    "scripts/release-hosted-native-proof-producer.test.mts",
    "scripts/release-hosted-native-job.test.mts",
    "scripts/release-hosted-native-runner.test.mts",
    "scripts/release-hosted-native-windows-bootstrap.test.mts",
    "scripts/release-hosted-native-windows-capture.test.mts",
    "scripts/release-hosted-native-windows-runner.test.mts",
    "scripts/release-hosted-native-windows-source.test.mts",
    "scripts/release-hosted-native-windows-workflow.test.mts",
    "scripts/release-hosted-native-windows-dependency-files.test.mts",
    "scripts/native-qualification-account.test.mts",
    "scripts/release-owned-windows-proof-store.test.mts",
    "scripts/release-windows-webview-driver.test.mts",
    "scripts/release-routing-marker.test.mts",
    "scripts/release-native-pre-sign-report.test.mts",
    "scripts/release-native-source-provider.test.mts",
    "scripts/release-native-wsl-capture.test.mts",
    "scripts/release-run-evidence.test.mts",
    "scripts/required-node-test-reporter.test.mts",
    "scripts/test-duration-reporter.test.mts",
    "scripts/ui-test-selection.test.mts",
    "scripts/updater-historical-inputs.test.mts",
    "scripts/installed-game-data-fixture.test.mts",
    "scripts/windows-installed-game-data.test.mts",
    "scripts/windows-historical-bootstrap.test.mts",
  ];
  const root = fileURLToPath(new URL("../", import.meta.url));
  const importers = ["scripts", "apps/desktop/scripts"].flatMap((directory) =>
    readdirSync(path.join(root, directory))
      .filter((file) => file.endsWith(".test.mts"))
      .map((file) => `${directory}/${file}`)
      .filter((file) =>
        /\bfrom\s+["'][^"']*fixtures\/disposable-directory\.mts["']/u.test(
          readFileSync(path.join(root, file), "utf8"),
        ),
      ),
  );
  assert.deepEqual(importers.sort(), [...consumers].sort());
  for (const change of [
    { status: "M", path: helper },
    { status: "A", path: helper },
    { status: "D", path: helper },
    { status: "R100", previousPath: helper, path: "docs/renamed.md" },
    { status: "R100", previousPath: "docs/renamed.md", path: helper },
  ]) {
    const selection = classifyChanges([change], { fileExists: allFilesExist });
    for (const consumer of consumers.filter((file) => file !== desktop))
      assert.ok(selection.nodeTests.has(consumer), `${JSON.stringify(change)}: ${consumer}`);
    assert.ok(!selection.nodeTests.has(desktop));
    assert.ok(selection.uiRelatedFiles.has(desktop));
    const commands = buildPlan(selection);
    assert.ok(
      commands
        .find((entry) => entry.id === "ui-related-tests")
        ?.args.includes(path.resolve(root, desktop)),
    );
    assert.ok(!commands.find((entry) => entry.id === "node-tests")?.args.includes(desktop));
    const plan = buildValidationPlan({
      changes: [
        {
          ...change,
          status: change.status.charAt(0),
          oldMode: change.status === "A" ? "000000" : "100644",
          newMode: change.status === "D" ? "000000" : "100644",
        },
      ],
      eventName: "pull_request",
      checkout: "a".repeat(40),
      head: "a".repeat(40),
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
    });
    const hosted = new Set(baselineContractTests(plan, { fileExists: allFilesExist }));
    assert.deepEqual(
      consumers.filter((file) => file !== desktop && !hosted.has(file)),
      [],
    );
    assert.ok(plan.groups.includes("frontend"));
    assert.ok(baselineRequiresDesktopDependencies(plan));
    assert.ok(
      baselineFrontendPlan(plan)
        .find((entry) => entry.id === "ui-related-tests")
        ?.args.includes(path.resolve(root, desktop)),
    );
    assert.ok(!selection.unknown.has(helper));
  }
});

void test("fixture module closure edits retain all independent policy and construction consumers", () => {
  const helper = "scripts/fixtures/module-closure.mts";
  const consumers = [
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/ci-windows-helpers.test.mts",
    "scripts/daily-discovery.test.mts",
    "scripts/desktop-boundary-wiring.test.mts",
    "scripts/desktop-staged-layout.test.mts",
    "scripts/fixture-module-closure.test.mts",
    "scripts/precommit-check.test.mts",
    "scripts/production-aggregate-steps.test.mts",
    "scripts/release-windows-webview-driver.test.mts",
    "scripts/renovate-engine-probe.test.mts",
  ];
  const root = fileURLToPath(new URL("../", import.meta.url));
  const importers = readdirSync(path.join(root, "scripts"))
    .filter((file) => file.endsWith(".test.mts"))
    .map((file) => `scripts/${file}`)
    .filter((file) =>
      /(?:\bfrom\s+|\bimport\(\s*)["']\.\/fixtures\/module-closure\.mts["']/u.test(
        readFileSync(path.join(root, file), "utf8"),
      ),
    );
  assert.deepEqual(importers.sort(), consumers);
  for (const change of [
    { status: "M", path: helper },
    { status: "A", path: helper },
    { status: "D", path: helper },
    { status: "R100", previousPath: helper, path: "docs/renamed.md" },
    { status: "R100", previousPath: "docs/renamed.md", path: helper },
  ]) {
    const selection = classifyChanges([change], { fileExists: allFilesExist });
    for (const consumer of consumers)
      assert.ok(selection.nodeTests.has(consumer), `${JSON.stringify(change)}: ${consumer}`);
    const command = buildPlan(selection).find((entry) => entry.id === "node-tests");
    assert.ok(command);
    for (const consumer of consumers) assert.ok(command.args.includes(consumer), consumer);
  }
});

void test("local Node contract plans enable the same fixed module mock capability", () => {
  const { plan } = planFor(["scripts/release-coordinator-signing-custody.test.mts"]);
  const node = plan.find((entry) => entry.id === "node-tests");
  assert.ok(node);
  assert.ok(node.args.includes("--experimental-test-module-mocks"));
  assert.ok(node.args.includes("--test-timeout=60000"));
  assert.ok(node.args.includes("scripts/release-coordinator-signing-custody.test.mts"));
});

void test("historical desktop oracle edits retain the decoder and unchanged planner consumers", () => {
  for (const file of [
    "scripts/desktop-execution-baseline.mts",
    "scripts/desktop-execution-baseline.test.mts",
    "scripts/testdata/desktop-execution-baseline.json",
    "scripts/desktop-execution-plan.test.mts",
    "scripts/desktop-execution-plan.mts",
    "scripts/desktop-scenarios.mts",
  ]) {
    const selection = classifyChanges([{ status: "M", path: file }], {
      fileExists: allFilesExist,
    });
    for (const contract of [
      "scripts/desktop-execution-baseline.test.mts",
      "scripts/desktop-execution-plan.test.mts",
      "scripts/native-qualification-inventory.test.mts",
    ])
      assert.ok(selection.nodeTests.has(contract), `${file}: ${contract}`);
  }
});

void test("checkpoint authentication sources retain security classification and their proof consumer", () => {
  for (const file of [
    "scripts/release-checkpoint-job-identity.mts",
    "scripts/release-coordinator-checkpoint-authentication.mts",
    "scripts/release-coordinator-checkpoint-signing.mts",
    "scripts/release-coordinator-signing-exchange.mts",
    "scripts/release-checkpoint-signing-transport.mts",
    "scripts/release-coordinator-checkpoint-evidence.mts",
    "scripts/fixtures/checkpoint-proof-fixture.mts",
    "scripts/github-controller-attestation.mts",
    "scripts/assembler-job-identity.mts",
    "scripts/release-coordinator-remote.mts",
  ]) {
    const selection = classifyChanges([{ status: "M", path: file }], { fileExists: () => false });
    assert.ok(selection.scopes.has("release-tooling"), file);
    assert.ok(
      selection.nodeTests.has("scripts/release-coordinator-checkpoint-authentication.test.mts"),
      file,
    );
    assert.ok(
      selection.nodeTests.has("scripts/release-coordinator-checkpoint-signing.test.mts"),
      file,
    );
    assert.ok(!selection.unknown.has(file), file);
  }
});

void test("Release recovery and Preview withdrawal inputs select complete test paths and serialize actual CI outputs", async (t) => {
  const files = [
    "scripts/release-pending-release-recovery.mts",
    "scripts/release-effect-contract.mts",
    "scripts/release-pending-result-recovery.mts",
    "scripts/release-report-repair-contract.mts",
    "scripts/release-report-repair-identity.mts",
    "scripts/release-preview-withdrawals.mts",
    "release-preview-withdrawals.json",
  ];
  for (const file of files) {
    const selection = classifyChanges([{ status: "M", path: file }], { fileExists: () => false });
    assert.ok(
      selection.nodeTests.has(
        file === "scripts/release-effect-contract.mts"
          ? "scripts/release-pending-release-recovery.test.mts"
          : file === "release-preview-withdrawals.json"
            ? "scripts/release-preview-withdrawals.test.mts"
            : file.replace(/\.mts$/u, ".test.mts"),
      ),
    );
    assert.ok(!selection.unknown.has(file));
    assert.ok(
      [...selection.nodeTests].every(
        (name) => name.startsWith("scripts/") && name.endsWith(".test.mts"),
      ),
    );
  }
  const root = mkdtempSync(path.join(tmpdir(), "portcove-pending-release-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = buildValidationPlan({
    changes: files.map((file) => ({
      status: "M",
      oldPath: file,
      newPath: file,
      oldMode: "100644",
      newMode: "100644",
    })),
    eventName: "pull_request",
    checkout: "a".repeat(40),
    head: "a".repeat(40),
    base: "b".repeat(40),
    mergeBase: "b".repeat(40),
  });
  const { writeGithubOutputs } = await import("./select-ci-plan.mts");
  const output = path.join(root, "github-output.txt");
  await writeGithubOutputs(output, plan);
  assert.match(readFileSync(output, "utf8"), /^plan_gzip_base64=.+$/mu);
});

void test("hook implementation-only edits select the real Git hook contract", () => {
  for (const file of ["scripts/hooks-install.mts", "scripts/precommit.mts"]) {
    const selection = classifyChanges([{ status: "M", path: file }], { fileExists: () => false });
    assert.ok(selection.nodeTests.has("scripts/precommit-check.test.mts"));
    assert.ok(!selection.unknown.has(file));
  }
});

void test("delivery helper changes retain CLI and transport snapshot consumers", () => {
  for (const file of ["scripts/pr-delivery.mts", "scripts/pr-delivery-snapshot.mts"]) {
    for (const change of [
      { status: "M", path: file },
      { status: "D", path: file },
      { status: "R100", path: "scripts/renamed-delivery.mts", previousPath: file },
    ]) {
      const selection = classifyChanges([change], { fileExists: () => false });
      assert.ok(selection.nodeTests.has("scripts/pr-delivery.test.mts"), file);
      assert.ok(selection.nodeTests.has("scripts/pr-delivery-snapshot.test.mts"), file);
      if (file === "scripts/pr-delivery.mts") {
        assert.ok(selection.nodeTests.has("scripts/repository-skills.test.mts"));
      }
    }
  }
});

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture entry is missing");
  return value;
}

void test("listener lifetime helper selects its actual callback cleanup regression", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const helper of [
    "apps/desktop/scripts/desktop-listener-lifetime-test.mts",
    "apps/desktop/scripts/desktop-listener-lifetime-probe.mts",
  ]) {
    const selection = classifyChanges([{ status: "M", path: helper }], {
      fileExists: () => false,
    });
    assert.ok(selection.nodeTests.has("scripts/desktop-listener-probe.test.mts"));
    assert.ok(!selection.unknown.has(helper));
    assert.ok(selection.uiRelatedFiles.has(helper));
    const commands = buildPlan(selection);
    assert.ok(
      commands
        .find((entry) => entry.id === "node-tests")
        ?.args.includes("scripts/desktop-listener-probe.test.mts"),
    );
    assert.ok(
      commands
        .find((entry) => entry.id === "ui-related-tests")
        ?.args.includes(path.resolve(root, helper)),
    );
    if (helper.endsWith("desktop-listener-lifetime-probe.mts"))
      assert.ok(selection.nodeTests.has("scripts/desktop-execution-plan.test.mts"));
  }
  assert.ok(!classifyChanges([]).nodeTests.has("scripts/desktop-listener-probe.test.mts"));
});

void test("manual native workflow selects its repository-dependency provenance contracts", () => {
  const selection = classifyChanges(
    [{ status: "M", path: ".github/workflows/native-design-compatibility.yml" }],
    { fileExists: () => false },
  );
  assert.ok(selection.nodeTests.has("scripts/workflow-provenance.test.mts"));
  assert.ok(!classifyChanges([]).nodeTests.has("scripts/workflow-provenance.test.mts"));
});

void test("removed, renamed-away and non-code frontend inputs retain complete execution", () => {
  for (const change of [
    { status: "D", path: "apps/desktop/src/components/removed.tsx" },
    {
      status: "R100",
      path: "apps/desktop/src/components/renamed.tsx",
      previousPath: "apps/desktop/src/components/old.tsx",
    },
    {
      status: "R100",
      path: "apps/desktop/src/components/new.browser.test.tsx",
      previousPath: "apps/desktop/src/components/old.browser.test.tsx",
    },
    { status: "M", path: "apps/desktop/src/image.png" },
  ]) {
    const selection = classifyChanges([change], { fileExists: allFilesExist });
    assert.equal(selection.uiFullTests, true, change.path);
    assert.ok(
      !selection.uiRelatedFiles.has(
        change.previousPath ?? (change.status === "D" ? change.path : ""),
      ),
    );
    const plan = buildPlan(selection);
    assert.ok(plan.some(({ id }) => id === "ui-tests"));
    assert.ok(!plan.some(({ id }) => id === "ui-related-tests"));
  }
});

void test("shared browser trace runtime selects full frontend tests and build", () => {
  const selection = classifyChanges([{ status: "M", path: "scripts/browser-traces.ts" }], {
    fileExists: allFilesExist,
  });
  assert.equal(selection.ui, true);
  assert.equal(selection.uiFullTests, true);
  const plan = buildPlan(selection);
  assert.ok(plan.some((entry) => entry.id === "ui-build"));
  const tests = requiredFixture(plan.find((entry) => entry.id === "ui-tests"));
  assert.ok(tests.args.includes("frontend:tests"));
  assert.ok(!tests.args.includes("--related"));
});

void test("current and deleted test configurations retain full frontend coverage on both rename sides", () => {
  for (const file of [
    "vite.config.ts",
    "apps/desktop/vite.config.ts",
    "scripts/frontend-tests.ts",
    "scripts/frontend-case-observations.ts",
    "apps/desktop/vitest.config.ts",
    "apps/desktop/vitest.browser.config.ts",
  ]) {
    for (const change of [
      { status: "M", path: file },
      { status: "A", path: file },
      { status: "D", path: file },
      { status: "R100", path: "docs/moved-config.md", previousPath: file },
      { status: "R100", path: file, previousPath: "docs/moved-config.md" },
    ]) {
      for (const fileExists of [() => true, () => false]) {
        const label = `${change.status} ${change.previousPath ?? ""} -> ${change.path}`;
        const selection = classifyChanges([change], { fileExists });
        assert.equal(selection.unknown.size, 0, label);
        assert.equal(selection.ui, true, label);
        assert.equal(selection.uiFullTests, true, label);
        assert.equal(selection.uiRelatedFiles.size, 0, label);
        const commands = buildPlan(selection);
        for (const [id, task] of [
          ["ui-tests", "frontend:tests"],
          ["ui-build", "frontend:build"],
        ] as const) {
          assert.ok(
            commands.some((entry) => entry.id === id && entry.args.includes(task)),
            label,
          );
        }
        assert.ok(!commands.some((entry) => entry.id === "ui-related-tests"), label);
      }
      const hosted = buildValidationPlan({
        changes: [
          {
            status: change.status,
            oldPath: change.previousPath ?? change.path,
            newPath: change.path,
            oldMode: change.status === "A" ? "000000" : "100644",
            newMode: change.status === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        checkout: "a".repeat(40),
        head: "a".repeat(40),
        base: "b".repeat(40),
        mergeBase: "b".repeat(40),
      });
      assert.equal(hosted.mode, "fast", file);
      assert.ok(hosted.groups.includes("frontend"), file);
    }
  }
});

void test("integrated source lint fails before expensive stages while preserving valid selected obligations", () => {
  const selection = classifyChanges([{ status: "M", path: "apps/desktop/tsconfig.json" }], {
    fileExists: allFilesExist,
  });
  const plan = buildPlan(selection);
  const ids = plan.map((entry) => entry.id);
  assert.ok(ids.indexOf("repository-lint") < ids.indexOf("ui-build"));
  assert.ok(ids.indexOf("repository-lint") < ids.indexOf("ui-tests"));
  assert.ok(ids.includes("ui-content"));
  const started: string[] = [];
  assert.throws(
    () =>
      executePlan(plan, {
        spawn: (_executable, args) => {
          const entry = requiredFixture(plan.find((item) => item.args === args));
          started.push(entry.id);
          return { status: entry.id === "repository-lint" ? 1 : 0 };
        },
      }),
    /repository-lint failed/,
  );
  assert.ok(!started.includes("ui-build") && !started.includes("ui-tests"));
  const successful: string[] = [];
  executePlan(plan, {
    spawn: (_executable, args) => {
      successful.push(requiredFixture(plan.find((item) => item.args === args)).id);
      return { status: 0 };
    },
  });
  assert.deepEqual(successful, ids);
  assert.ok(
    requiredFixture(plan.find((entry) => entry.id === "ui-tests")).args.includes("frontend:tests"),
  );
});

void test("hook entrypoints have explicit ownership and executable integration coverage", () => {
  for (const file of [".vite-hooks/pre-commit", "vite.config.ts", ".vite-hooks/pre-commit"]) {
    const selection = classifyChanges([{ status: "A", path: file }], { fileExists: allFilesExist });
    assert.equal(selection.unknown.size, 0);
    assert.ok(selection.nodeTests.has("scripts/precommit-check.test.mts"));
  }
});

void test("review inventory keeps command arguments while making candidate-root paths portable", () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const entry = {
    id: "owned",
    reason: "review inventory fixture",
    executable: process.execPath,
    args: [source + "scripts/check.mjs", "--all", "/other/input"],
    cwd: source + "apps/desktop",
  };
  assert.deepEqual(selectedPlanInventory([entry]), [
    {
      id: "owned",
      executable: "$NODE",
      args: ["$SOURCE/scripts/check.mjs", "--all", "/other/input"],
      cwd: "$SOURCE/apps/desktop",
    },
  ]);
  assert.equal(entry.executable, process.execPath);
  assert.equal(entry.args[0], source + "scripts/check.mjs");
});

function preflightFixture() {
  const context = { headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeBase: "b".repeat(40) };
  const validationPlan = buildValidationPlan({
    changes: [
      {
        status: "M",
        oldPath: "apps/desktop/src/App.tsx",
        newPath: "apps/desktop/src/App.tsx",
        oldMode: "100644",
        newMode: "100644",
      },
    ],
    eventName: "pull_request",
    head: context.headSha,
    base: context.baseSha,
    mergeBase: context.mergeBase,
    checkout: context.headSha,
  });
  const plan = [
    {
      id: "rust-clippy:portcove-desktop",
      reason: "compile the actual native target",
      executable: "cargo",
      args: ["clippy", "--locked", "-p", "portcove-desktop"],
      cwd: "/source",
    },
  ];
  const prerequisites: PrerequisiteObservation[] = ["node", "rustc", "cargo", "clippy-component"]
    .map((id): PrerequisiteObservation => ({ id, status: "ok" }))
    .concat({
      id: "native-desktop-build",
      status: "unavailable",
      remediation: "use an approved capable route",
    });
  return { context, validationPlan, plan, prerequisites };
}

void test("preflight selects the approved capable route without claiming execution or CI", () => {
  const inputs = preflightFixture();
  const hosted = { status: "eligible" as const, command: "exact frozen hosted dispatch" };
  const report = buildExecutionPreflight({ ...inputs, hosted });
  assert.equal(requiredFixture(report.obligations[0]).route, "hosted-local-check");
  assert.deepEqual(requiredFixture(report.obligations[0]).missing, ["native-desktop-build"]);
  assert.equal(requiredFixture(report.obligations[0]).next_action, hosted.command);
  assert.match(report.local_profile, /full-debug/);
  assert.match(report.hosted_ci.role, /mandatory exact-head CI/);
  assert.match(report.limits, /No dispatch or acceptance/);
  const blocked = buildExecutionPreflight({
    ...inputs,
    hosted: { status: "blocked", reason: "authority changed" },
  });
  assert.equal(requiredFixture(blocked.obligations[0]).route, "blocked");
  const local = buildExecutionPreflight({
    ...inputs,
    prerequisites: inputs.prerequisites.map((item) => ({ ...item, status: "ok" })),
    hosted,
  });
  assert.equal(requiredFixture(local.obligations[0]).route, "local");
  assert.equal(
    requiredFixture(local.obligations[0]).command,
    formatCommand(requiredFixture(inputs.plan[0])),
  );
  assert.throws(
    () =>
      buildExecutionPreflight({
        ...inputs,
        context: { ...inputs.context, headSha: "c".repeat(40) },
        hosted,
      }),
    /current complete comparison/,
  );
});

void test("preflight reports local prerequisites of the already selected audit stages", () => {
  const inputs = preflightFixture();
  const audit = {
    profile: "complete",
    route: "hosted-deep-audit",
    stages: [
      { id: "rust", command: "just check-rust" },
      { id: "release-unit", command: "just release-check" },
    ],
    local_stages: [
      { id: "rust", command: "just check-rust" },
      { id: "release-unit", command: "just release-check" },
    ],
  };
  const prerequisites = inputs.prerequisites.concat([
    { id: "complete-audit-prerequisites", status: "unverified" },
    { id: "aqua-state", status: "ok" },
    { id: "pwsh", status: "unavailable", remediation: "provide bare pwsh" },
    { id: "unix-socket-path", status: "unavailable", remediation: "shorten temporary path" },
  ]);
  const report = buildExecutionPreflight({
    ...inputs,
    prerequisites,
    hosted: { status: "blocked" },
    audit,
    platform: "linux",
  });
  assert.ok(report.pre_change_audit);
  assert.equal(report.pre_change_audit.profile, "complete");
  assert.equal(report.pre_change_audit.route, "hosted-deep-audit");
  assert.deepEqual(report.pre_change_audit.missing_local_prerequisites, [
    "complete-audit-prerequisites",
    "pwsh",
    "unix-socket-path",
  ]);
  assert.deepEqual(
    report.pre_change_audit.local_prerequisites.map((entry) => entry.id),
    ["node", "complete-audit-prerequisites", "aqua-state", "pwsh", "unix-socket-path"],
  );
});

void test("hosted preflight requires exact available ancestor authorities and a frozen clean source", () => {
  const { context } = preflightFixture();
  const sha = "b".repeat(40);
  const invoke =
    (paths = "", dirty = "") =>
    (args: string[]) => {
      if (args[0] === "status") return dirty;
      if (args[0] === "for-each-ref") return "refs/remotes/origin/ci/selected-check";
      if (args[0] === "rev-parse") return args[1]?.includes(":") ? "c".repeat(40) : sha;
      if (args[0] === "show") return "hosted-local-check controller\nhosted-local-check run";
      if (args[0] === "diff")
        return paths.startsWith(":")
          ? paths
          : paths
              .split("\0")
              .filter(Boolean)
              .map((name) => `:100644 100644 ${"b".repeat(40)} ${"a".repeat(40)} M\0${name}\0`)
              .join("");
      return "";
    };
  assert.equal(inspectHostedLocalRoute(context).status, "unverified");
  assert.throws(() => inspectHostedLocalRoute(context, "main", sha), /exact authority/);
  assert.equal(
    inspectHostedLocalRoute(context, sha, sha, invoke("", " M source")).status,
    "blocked",
  );
  for (const changed of [
    "Cargo.lock",
    "scripts/local-validation.mts",
    "scripts/dev-doctor.mts",
    "apps/desktop/scripts/new-helper.mjs",
    "docs/QUALITY.md",
  ]) {
    assert.equal(
      inspectHostedLocalRoute(context, sha, sha, invoke(changed + "\0")).status,
      "blocked",
      changed,
    );
  }
  const eligible = inspectHostedLocalRoute(
    context,
    sha,
    sha,
    invoke("apps/desktop/src-tauri/src/cli_context.rs\0scripts/example.test.mjs\0"),
    "ci/selected-check",
  );
  assert.equal(eligible.status, "eligible");
  assert.ok(eligible.command);
  assert.match(eligible.command, new RegExp(`source_sha=${context.headSha}`));
  assert.ok(eligible.dispatch_authority);
  assert.match(eligible.dispatch_authority, /not established/);
  assert.match(eligible.command, /--ref ci\/selected-check /);
  assert.match(eligible.command, new RegExp(`controller_sha=${sha}`));
  assert.equal(inspectHostedLocalRoute(context, sha, sha, invoke()).status, "unverified");
  for (const name of [
    sha,
    sha.toUpperCase(),
    "B" + sha.slice(1),
    "main;echo",
    "main$(echo)",
    "--main",
    "main'quoted",
  ])
    assert.throws(() => inspectHostedLocalRoute(context, sha, sha, invoke(), name), /safe branch/);
  for (const refs of ["", "refs/remotes/origin/ci/selected-check\nrefs/tags/ci/selected-check"])
    assert.equal(
      inspectHostedLocalRoute(
        context,
        sha,
        sha,
        (args) => (args[0] === "for-each-ref" ? refs : invoke()(args)),
        "ci/selected-check",
      ).status,
      "blocked",
    );
  assert.equal(
    inspectHostedLocalRoute(
      context,
      sha,
      sha,
      (args) =>
        args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/")
          ? "d".repeat(40)
          : invoke()(args),
      "ci/selected-check",
    ).status,
    "blocked",
  );
  assert.equal(
    inspectHostedLocalRoute(
      context,
      sha,
      sha,
      (args) =>
        args[0] === "for-each-ref"
          ? "refs/remotes/origin/ci/selected-check\trefs/remotes/origin/main"
          : invoke()(args),
      "ci/selected-check",
    ).status,
    "blocked",
  );
  const tagged = inspectHostedLocalRoute(
    context,
    sha,
    sha,
    (args) => (args[0] === "for-each-ref" ? "refs/tags/ci/selected-check" : invoke()(args)),
    "ci/selected-check",
  );
  assert.equal(tagged.status, "eligible");

  const renamed = `:100644 100644 ${"b".repeat(40)} ${"a".repeat(40)} R100\0scripts/owned-authority.mjs\0docs/moved.txt\0`;
  assert.equal(inspectHostedLocalRoute(context, sha, sha, invoke(renamed)).status, "blocked");
  assert.equal(
    inspectHostedLocalRoute(context, sha, sha, (args) =>
      args[0] === "rev-parse" && args[1] === `${context.headSha}:scripts/workflow-provenance.mts`
        ? "d".repeat(40)
        : invoke()(args),
    ).status,
    "blocked",
  );
  assert.throws(
    () =>
      inspectHostedLocalRoute(context, sha, sha, () => {
        throw new Error("unavailable comparison authority");
      }),
    /unavailable/,
  );
});

void test("hosted dispatch-ref arguments fail before discovery when missing or outside preflight", async () => {
  const options = {
    readContext: () => {
      throw new Error("unexpected discovery");
    },
  };
  await assert.rejects(main(["check", "--hosted-ref"], options), /requires a branch or tag/);
  await assert.rejects(
    main(["check", "--preflight", "--hosted-ref", "--json"], options),
    /requires a branch or tag/,
  );
  await assert.rejects(
    main(["check", "--hosted-ref", "ci/selected-check"], options),
    /require --preflight/,
  );
});

void test("a missing Windows/MSBuild Playnite capability cannot route to Ubuntu", () => {
  const inputs = preflightFixture();
  const plan = [
    {
      id: "playnite-contract",
      reason: "execute actual Windows consumer",
      executable: "pwsh",
      args: ["integrations/playnite/check.ps1"],
      cwd: "/source",
    },
  ];
  const prerequisites = ["node", "rustc", "cargo", "pwsh"]
    .map((id) => ({ id, status: "ok" }))
    .concat([
      { id: "windows-host", status: "unavailable" },
      { id: "msbuild", status: "unavailable" },
    ]);
  const report = buildExecutionPreflight({
    ...inputs,
    plan,
    prerequisites,
    platform: "linux",
    hosted: { status: "eligible", command: "Ubuntu dispatch" },
  });
  assert.equal(requiredFixture(report.obligations[0]).route, "blocked");
  assert.ok(requiredFixture(report.obligations[0]).missing.includes("windows-host"));
});

const change = (path: string, options: Partial<LocalChange> = {}): LocalChange => ({
  status: "M",
  path,
  ...options,
});
const ids = (plan: ValidationCommand[]) => plan.map((entry) => entry.id);

function planFor(paths: (string | LocalChange)[]) {
  const changes = paths.map((path) => (typeof path === "string" ? change(path) : path));
  const selection = classifyChanges(changes, { fileExists: allFilesExist });
  return {
    selection,
    plan: buildPlan(selection, {
      mergeBase: "base-sha",
      validationPlan: buildValidationPlan({
        changes: changes.map((entry) => ({
          status: entry.status,
          oldPath: entry.previousPath ?? entry.path,
          newPath: entry.path,
          oldMode: entry.status === "A" ? "000000" : "100644",
          newMode: entry.status === "D" ? "000000" : "100644",
        })),
        eventName: "pull_request",
        base: "b".repeat(40),
        mergeBase: "b".repeat(40),
        head: "a".repeat(40),
        checkout: "a".repeat(40),
      }),
    }),
  };
}

void test("execution planning helper and baseline changes select their preservation contracts", () => {
  const files = [
    "scripts/desktop-execution-plan.mts",
    "scripts/desktop-execution-plan.test.mts",
    "scripts/testdata/desktop-execution-baseline.json",
    "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
  ];
  for (const file of files) {
    for (const status of ["A", "M", "D"]) {
      const { selection, plan } = planFor([{ status, path: file }]);
      assert.deepEqual([...selection.unknown], []);
      assert(
        selection.nodeTests.has(
          file.endsWith(".test.mts") && status === "D"
            ? "scripts/desktop-scenarios.test.mts"
            : "scripts/desktop-execution-plan.test.mts",
        ),
      );
      assert(ids(plan).includes("node-tests"));
      assert(!ids(plan).some((id: string) => id === "rust-workspace-tests"));
    }
  }
  const mixed = planFor([requiredFixture(files[0]), "crates/portcove-core/src/artwork.rs"]);
  assert(ids(mixed.plan).some((id: string) => id === "rust-workspace-tests"));
});

void test("the maintained default-cover harness selects native scenario contracts without Rust execution", () => {
  const cover = "apps/desktop/scripts/desktop-default-cover-test.mts";
  for (const status of ["A", "M", "D"]) {
    const { selection, plan } = planFor([{ status, path: cover }]);
    assert.ok(selection.nodeTests.has("scripts/desktop-scenarios.test.mts"));
    assert.ok(ids(plan).includes("node-tests"));
    assert.ok(!ids(plan).some((id: string) => id === "rust-workspace-tests"));
    assert.ok(!plan.map(formatCommand).join("\n").includes("desktop-test"));
  }
  const mixed = planFor([cover, "crates/portcove-core/src/artwork.rs"]);
  assert.ok(ids(mixed.plan).some((id: string) => id === "rust-workspace-tests"));
});

void test("source-dialog consumer selects scenario contracts without running native or Rust acceptance", () => {
  const consumer = "apps/desktop/scripts/desktop-source-dialog-test.mts";
  for (const status of ["A", "M", "D"]) {
    const { selection, plan } = planFor([{ status, path: consumer }]);
    assert.ok(selection.nodeTests.has("scripts/desktop-scenarios.test.mts"));
    assert.ok(ids(plan).includes("node-tests"));
    assert.ok(!ids(plan).some((id: string) => id === "rust-workspace-tests"));
    assert.ok(!plan.map(formatCommand).join("\n").includes("desktop-test"));
  }
  const mixed = planFor([consumer, "crates/portcove-core/src/game_file_roots.rs"]);
  assert.ok(ids(mixed.plan).some((id: string) => id === "rust-workspace-tests"));
});

void test("native review presentation entrypoints select behavior and receipt contracts", () => {
  for (const consumer of [
    "apps/desktop/scripts/desktop-review-controls.mts",
    "apps/desktop/scripts/desktop-review-presentation.mts",
  ])
    for (const status of ["A", "M", "D"]) {
      const { selection, plan } = planFor([{ status, path: consumer }]);
      assert.ok(selection.nodeTests.has("scripts/desktop-scenarios.test.mts"));
      assert.ok(selection.nodeTests.has("scripts/desktop-execution-plan.test.mts"));
      assert.ok(ids(plan).includes("node-tests"));
      assert.ok(ids(plan).includes("rust-workspace-tests"));
      assert.ok(!plan.map(formatCommand).join("\n").includes("desktop-test"));
    }
});

void test("selected local resource scope follows actual commands and mixed or unknown work is conservative", () => {
  assert.equal(storageScopeForPlan([{ id: "diff-check" }, { id: "node-tests" }]), "tooling");
  assert.equal(storageScopeForPlan([{ id: "node-syntax:tool.mjs" }]), "tooling");
  assert.equal(storageScopeForPlan(planFor(["docs/QUALITY.md"]).plan), "frontend");
  assert.equal(
    storageScopeForPlan(planFor(["apps/desktop/src/features/game-details/detail-actions.ts"]).plan),
    "frontend",
  );
  assert.equal(
    storageScopeForPlan([{ id: "rust-core-tests" }, { id: "dependency-policy" }]),
    "rust",
  );
  assert.equal(storageScopeForPlan([{ id: "rust-core-tests" }, { id: "ui-build" }]), "all");
  assert.equal(storageScopeForPlan([{ id: "new-unclassified-stage" }]), "all");
});

void test("incomplete diff discovery fails closed before selecting tests", () => {
  assert.throws(
    () =>
      localChangesFromRaw(
        Buffer.from(":100644 100644 1111111 2222222 R100\0crates/portcove-core/src/old.rs\0"),
      ),
    /unsafe changed path|raw diff ended/u,
  );
});

void test("shared local planning retains raw file modes and both rename paths", () => {
  const raw = Buffer.from(
    ":100644 100755 1111111 2222222 M\0docs/QUALITY.md\0" +
      ":100644 000000 1111111 0000000 D\0old.md\0" +
      ":100644 100644 1111111 2222222 C090\0a.ts\0b.ts\0" +
      ":100644 100644 1111111 2222222 R100\0old.rs\0new.rs\0",
  );
  assert.deepEqual(localChangesFromRaw(raw), [
    {
      status: "M",
      path: "docs/QUALITY.md",
      previousPath: undefined,
      oldMode: "100644",
      newMode: "100755",
    },
    { status: "D", path: "old.md", previousPath: undefined, oldMode: "100644", newMode: "000000" },
    { status: "C", path: "b.ts", previousPath: "a.ts", oldMode: "100644", newMode: "100644" },
    {
      status: "R",
      path: "new.rs",
      previousPath: "old.rs",
      oldMode: "100644",
      newMode: "100644",
    },
  ]);
});

void test("active instruction changes run their semantic contracts", () => {
  const { selection, plan } = planFor(["docs/QUALITY.md", "AGENTS.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/repository-settings.test.mts",
    "scripts/repository-skills.test.mts",
  ]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

void test("documentation targets run the dynamic link contract", () => {
  const { selection, plan } = planFor(["docs/ARCHITECTURE.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mts"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

void test("archived documents retain checks while native formatting owns their exclusions", () => {
  for (const status of ["A", "M"]) {
    const { selection, plan } = planFor([{ status, path: "docs/archive/2026-09-25-audit.md" }]);
    assert.deepEqual([...selection.oxfmtFiles], ["docs/archive/2026-09-25-audit.md"]);
    assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mts"]);
    assert.deepEqual(ids(plan), ["diff-check", "node-tests"]);
  }
});

void test("format selection delegates exclusions to the formatter configuration", () => {
  const active = "docs/ARCHITECTURE.md";
  assert.deepEqual([...planFor([active]).selection.oxfmtFiles], [active]);
  const { selection, plan } = planFor([active, "docs/archive/2026-09-25-audit.md"]);
  assert.deepEqual([...selection.oxfmtFiles], [active, "docs/archive/2026-09-25-audit.md"]);
  const formatter = requiredFixture(plan.find((entry) => entry.id === "oxfmt"));
  assert.ok(formatter);
  assert.ok(formatter.args.some((argument: string) => argument.endsWith("ARCHITECTURE.md")));
  assert.ok(
    !formatter.args.some((argument: string) =>
      argument.replaceAll("\\", "/").includes("docs/archive/"),
    ),
  );
});

void test("root, hidden, app and crate TOML share the ordinary formatter route", () => {
  const files = [
    "Cargo.toml",
    ".config/nextest.toml",
    "apps/desktop/src-tauri/Cargo.toml",
    "crates/portcove-core/Cargo.toml",
  ];
  const { selection, plan } = planFor(files);
  assert.deepEqual([...selection.oxfmtFiles].sort(), files.sort());
  assert.ok(ids(plan).includes("oxfmt"));
  assert.ok(!ids(plan).includes("toml-format"));
});

void test("archive renames and deletions keep active formatter ownership precise", () => {
  const toActive = planFor([
    { status: "R100", previousPath: "docs/archive/old.md", path: "docs/new.md" },
  ]);
  assert.deepEqual([...toActive.selection.oxfmtFiles], ["docs/new.md"]);
  const toArchive = planFor([
    { status: "R100", previousPath: "docs/old.md", path: "docs/archive/new.md" },
  ]);
  assert.deepEqual([...toArchive.selection.oxfmtFiles], ["docs/archive/new.md"]);
  assert.deepEqual(ids(toArchive.plan), ["diff-check", "node-tests"]);
  const deletion = planFor([{ status: "D", path: "docs/archive/old.md" }]);
  assert.deepEqual([...deletion.selection.oxfmtFiles], []);
  assert.deepEqual(ids(deletion.plan), ["diff-check", "node-tests"]);
});

void test("current and historical catalog authorities select their generator contracts", () => {
  const current = planFor([
    "crates/portcove-core/catalog/catalog-current-authoring.json",
  ]).selection;
  assert.deepEqual([...current.nodeTests].sort(), [
    "scripts/catalog-artwork-backoff.test.mts",
    "scripts/catalog-artwork-batches.test.mts",
    "scripts/catalog-artwork-dispatch.test.mts",
    "scripts/catalog-artwork-lifecycle.test.mts",
    "scripts/catalog-artwork-provider.test.mts",
    "scripts/catalog-proposal-comparison.test.mts",
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/catalog-source-authoring.test.mts",
    "scripts/generate-catalog.test.mts",
  ]);

  const embedded = planFor(["crates/portcove-core/catalog/catalog.json"]).selection;
  assert.deepEqual([...embedded.nodeTests].sort(), [
    "scripts/catalog-artwork-backoff.test.mts",
    "scripts/catalog-artwork-batches.test.mts",
    "scripts/catalog-artwork-dispatch.test.mts",
    "scripts/catalog-artwork-lifecycle.test.mts",
    "scripts/catalog-artwork-provider.test.mts",
    "scripts/catalog-proposal-comparison.test.mts",
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/catalog-source-authoring.test.mts",
    "scripts/generate-catalog.test.mts",
    "scripts/release-native-source-contract.test.mts",
    "scripts/repository-skills.test.mts",
  ]);

  for (const path of [
    "crates/portcove-core/catalog/catalog-schema1-fixture.json",
    "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
  ]) {
    const historical = planFor([path]).selection;
    assert.equal(historical.nodeTests.has("scripts/migrate-catalog-schema2.test.mts"), true, path);
  }
});

void test("repository skill changes run the dynamic skill contract", () => {
  const { selection, plan } = planFor([".agents/skills/portcove-release-validation/SKILL.md"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mts"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

void test("bin-only Rust packages do not schedule an invalid doctest command", () => {
  const { plan } = planFor(["crates/portcove-cli/src/main.rs"]);
  assert.ok(ids(plan).includes("rust-workspace-tests"));
  assert.ok(!ids(plan).includes("rust-docs:portcove-cli"));
});

void test("native declaration inputs select their cheap consumer before Rust compilation", () => {
  const contract = "scripts/release-native-source-contract.test.mts";
  for (const source of nativeCompatibilitySourcePaths) {
    for (const input of [
      change(source),
      change(source, { status: "A" }),
      change(source, { status: "D" }),
      change("docs/moved-source.md", { status: "R100", previousPath: source }),
      change(source, { status: "R100", previousPath: "docs/moved-source.md" }),
    ]) {
      const { selection, plan } = planFor([input]);
      assert.ok(selection.nodeTests.has(contract), `${input.status} ${source}`);
      const node = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
      assert.equal(node.args.filter((argument) => argument === contract).length, 1);
      assert.ok(ids(plan).indexOf("node-tests") < ids(plan).indexOf("rust-workspace-tests"));
    }
  }
  const mixed = planFor([...nativeCompatibilitySourcePaths]);
  const node = requiredFixture(mixed.plan.find((entry) => entry.id === "node-tests"));
  assert.equal(node.args.filter((argument) => argument === contract).length, 1);
  for (const source of [
    "crates/portcove-core/src/database.rs",
    "crates/portcove-core/src/lib.rs",
  ]) {
    const { selection } = planFor([source]);
    assert.deepEqual([...selection.nodeTests], [contract]);
    assert.equal(selection.scopes.has("release-tooling"), false);
  }
  assert.equal(
    planFor(["crates/portcove-core/src/source_report.rs"]).selection.nodeTests.has(contract),
    false,
  );
});

void test("shared diagnostics changes retain explicit ownership and complete workspace Rust feedback", () => {
  const source = "crates/portcove-diagnostics/src/sessions/tests.rs";
  const changes = [
    ...["A", "M", "D"].map((status) => change(source, { status })),
    change("crates/portcove-diagnostics/Cargo.toml"),
    change("docs/moved-diagnostics.md", { status: "R100", previousPath: source }),
    change(source, { status: "R100", previousPath: "docs/moved-diagnostics.md" }),
  ];
  for (const changed of changes) {
    const { selection, plan } = planFor([changed]);
    assert.deepEqual([...selection.unknown], [], changed.path);
    assert.deepEqual([...selection.packages], ["portcove-diagnostics"], changed.path);
    assert.equal(selection.rustfmt, true, changed.path);
    const rust = requiredFixture(plan.find((entry) => entry.id === "rust-workspace-tests"));
    assert.deepEqual(rust.rustCoverage, ["all()"], changed.path);
    assert.ok(rust.args.includes("--guard-command"), changed.path);
  }
  const unowned = "crates/portcove-diagnostics-other/src/lib.rs";
  assert.ok(classifyChanges([change(unowned)]).unknown.has(unowned));
});

void test("all optional workspace Rust execution remains behind the existing admission runner", () => {
  for (const file of ["crates/portcove-core/src/database.rs", "Cargo.toml"]) {
    const commands = planFor([file]).plan;
    const rust = requiredFixture(commands.find((entry) => entry.id === "rust-workspace-tests"));
    assert.ok(rust);
    assert.equal(rust.executable, process.execPath);
    assert.deepEqual(rust.args.slice(0, 2), ["scripts/run-rust-tests.mts", "--guard-command"]);
    assert.ok(!commands.some((entry) => /clippy|rust-docs|rust-workspace-check/u.test(entry.id)));
  }
});

void test("UI sources build and run import-related units in optional feedback", () => {
  const { plan } = planFor(["apps/desktop/src/view-model.ts"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "repository-lint",
    "ui-content",
    "ui-build",
    "ui-related-tests",
  ]);
  assert.equal(
    requiredFixture(plan.find((entry) => entry.id === "ui-build")).executable,
    process.execPath,
  );
});

void test("related UI commands preserve validated absolute source paths", () => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const desktopRoot = path.join(projectRoot, "apps/desktop");
  const files = resolveUiSelection(["src/components/ChoiceSelect.tsx"], desktopRoot, "related");
  const { selection } = planFor(["apps/desktop/src/components/ChoiceSelect.tsx"]);
  selection.uiRelatedFiles = new Set(files);
  const plan = buildPlan(selection);
  const related = requiredFixture(plan.find((entry) => entry.id === "ui-related-tests"));
  assert.ok(related);
  assert.deepEqual(related.args.slice(2), files);
});

void test("frontend configuration changes use the complete small UI suite", () => {
  for (const path of ["package.json", "pnpm-lock.yaml"]) {
    const { selection, plan } = planFor([path]);
    assert.equal(selection.uiFullTests, true, path);
    assert.ok(selection.nodeTests.has("scripts/check-fallow-report.test.mts"), path);
    assert.ok(ids(plan).includes("ui-tests"), path);
    assert.ok(!ids(plan).includes("fallow"), path);
    assert.ok(!ids(plan).includes("ui-related-tests"), path);
    assert.ok(!ids(plan).includes("ui-theme-copy"), path);
    assert.ok(!ids(plan).includes("ui-copy"), "Oxlint owns source copy policy");
  }
  const { selection } = planFor(["package.json"]);
  assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mts"));
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  const scripts = manifest.scripts;
  assert.equal(typeof scripts["check:content"], "string");
  assert.ok(typeof scripts["check:content"] === "string");
  const aggregateCommands = scripts["check:content"].split(/\s*&&\s*/u);
  assert.ok(!aggregateCommands.some((command) => command.includes("check-theme.mjs")));
  assert.ok(!aggregateCommands.some((command) => command.includes("check-copy.mjs")));
});

for (const manifest of ["package.json", "apps/desktop/package.json"]) {
  void test(`${manifest} selects its direct workflow pin and script contract`, () => {
    const { selection, plan } = planFor([manifest]);
    assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mts"));
    const node = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
    assert.ok(node.args.includes("scripts/ci-workflow.test.mts"));
    assert.ok(selection.nodeTests.has("scripts/local-validation.test.mts"));
    assert.equal(selection.ui, true);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.browser, manifest === "apps/desktop/package.json");
    assert.ok(ids(plan).includes("ui-tests"));
    if (manifest === "package.json") {
      assert.ok(selection.nodeTests.has("scripts/dependency-automation.test.mts"));
      assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mts"));
      assert.ok(!ids(plan).includes("fallow"));
    }
  });
}

void test("manifest consumers coalesce in mixed plans without widening lock-only contracts", () => {
  const { selection, plan } = planFor([
    "package.json",
    "apps/desktop/package.json",
    "scripts/quality-tools.mts",
  ]);
  assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/quality-tools.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mts"));
  const node = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
  assert.equal(node.args.filter((arg) => arg === "scripts/ci-workflow.test.mts").length, 1);
  assert.ok(ids(plan).includes("ui-tests"));
  assert.ok(!ids(plan).includes("fallow"));
  for (const lock of ["pnpm-lock.yaml", "apps/desktop/pnpm-lock.yaml"]) {
    const selected = planFor([lock]);
    assert.equal(selected.selection.nodeTests.has("scripts/ci-workflow.test.mts"), false);
    assert.ok(selected.selection.nodeTests.has("scripts/dependency-automation.test.mts"));
  }
});

void test("localization configuration changes use the complete UI and i18n suite", () => {
  for (const path of ["apps/desktop/i18next.config.ts", "apps/desktop/i18next.invalid.config.ts"]) {
    const { selection, plan } = planFor([path]);
    assert.equal(selection.uiFullTests, true, path);
    assert.deepEqual([...selection.unknown], [], path);
    assert.ok(ids(plan).includes("ui-tests"), path);
  }
});

void test("retired desktop-local pnpm authorities remain owned on deletion", () => {
  for (const path of ["apps/desktop/pnpm-lock.yaml", "apps/desktop/pnpm-workspace.yaml"]) {
    const { selection, plan } = planFor([{ status: "D", path }]);
    assert.equal(selection.uiFullTests, true, path);
    assert.deepEqual([...selection.unknown], [], path);
    assert.ok(ids(plan).includes("ui-tests"), path);
    assert.ok(
      plan.some(
        (entry) =>
          entry.id === "node-tests" &&
          entry.args.includes("scripts/dependency-automation.test.mts"),
      ),
      path,
    );
  }
});

void test("pnpm package patches select full UI coverage including removal", () => {
  for (const status of ["A", "M", "D"]) {
    const { selection, plan } = planFor([
      { status, path: "patches/@tauri-apps__api@2.12.4.patch" },
    ]);
    assert.deepEqual([...selection.unknown], []);
    assert.equal(selection.uiFullTests, true);
    assert.ok(ids(plan).includes("ui-tests"));
    assert.ok(!ids(plan).includes("ui-related-tests"));
  }
  const { selection } = planFor(["patches/unowned.txt"]);
  assert.ok(selection.unknown.has("patches/unowned.txt"));
});

void test("the exact Fallow boundary configuration selects the complete UI suite", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection, plan } = planFor([{ status, path: "apps/desktop/.fallowrc.json" }]);
    assert.equal(selection.uiFullTests, true);
    assert.ok(ids(plan).includes("ui-tests"));
    assert.ok(!ids(plan).includes("fallow"));
    assert.ok(!ids(plan).includes("ui-related-tests"));
    assert.deepEqual([...selection.unknown], []);
  }
});

void test("advisory tooling configuration selects scope contracts without exhaustive analysis", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection, plan } = planFor([{ status, path: ".fallow-tooling.json" }]);
    assert.deepEqual([...selection.unknown], []);
    assert.ok(selection.nodeTests.has("scripts/fallow-scope.test.mts"));
    assert.ok(selection.nodeTests.has("scripts/run-fallow.test.mts"));
    assert.ok(!ids(plan).includes("fallow"));
    assert.equal(selection.ui, false);
  }
});

void test("command-identical obligations execute once while retaining every selection reason", () => {
  const duplicate = {
    id: "second-lint",
    reason: "second owner",
    executable: "lint",
    args: ["--all"],
    cwd: ".",
    obligation: "complete-lint",
  };
  const plan = deduplicateCommands([
    { ...duplicate, id: "first-lint", reason: "first owner" },
    duplicate,
    { id: "tests", reason: "tests", executable: "test", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["first-lint", "tests"]);
  assert.deepEqual(requiredFixture(plan[0]).selectedIds, ["first-lint", "second-lint"]);
  assert.match(
    requiredFixture(plan[0]).reason,
    /first owner; also selected as second-lint: second owner/u,
  );

  const seen: string[] = [];
  executePlan(plan, {
    spawn(executable) {
      seen.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(seen, ["lint", "test"]);
});

void test("command-identical stages with different evidence roles remain distinct", () => {
  const plan = deduplicateCommands([
    {
      id: "first",
      reason: "first role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "first-evidence",
    },
    {
      id: "second",
      reason: "second role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "second-evidence",
    },
  ]);
  assert.deepEqual(ids(plan), ["first", "second"]);
});

void test("a reused stage id cannot hide conflicting commands or obligations", () => {
  assert.throws(
    () =>
      deduplicateCommands([
        { id: "same", reason: "one", executable: "one", args: [], cwd: "." },
        { id: "same", reason: "two", executable: "two", args: [], cwd: "." },
      ]),
    /selected conflicting commands or obligations/u,
  );
  assert.throws(
    () =>
      deduplicateCommands([
        {
          id: "same",
          reason: "compile",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "compile",
        },
        {
          id: "same",
          reason: "security",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "security",
        },
      ]),
    /selected conflicting commands or obligations/u,
  );
});

void test("an exactly repeated stage id retains every selection reason", () => {
  const plan = deduplicateCommands([
    { id: "same", reason: "first", executable: "same", args: [], cwd: "." },
    { id: "same", reason: "second", executable: "same", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["same"]);
  assert.deepEqual(requiredFixture(plan[0]).selectedIds, ["same"]);
  assert.match(requiredFixture(plan[0]).reason, /first; also selected as same: second/u);
});

void test("transport changes select both language scopes and contract comparators", () => {
  const { selection, plan } = planFor([
    "apps/desktop/src/transport-types.generated.d.ts",
    "crates/portcove-core/src/types.rs",
  ]);
  assert.equal(selection.transport, true);
  assert.ok(selection.packages.has("portcove-core"));
  assert.ok(selection.nodeTests.has("scripts/transport-types.test.mts"));
  assert.ok(!ids(plan).includes("transport-export"));
  assert.ok(!ids(plan).includes("transport-policy"));
});

void test("workflow and justfile changes select exact contract tests and actionlint", () => {
  const { selection, plan } = planFor([".github/workflows/ci.yml", "justfile"]);
  assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mts"));
  assert.ok(ids(plan).includes("actionlint"));
  const nodeTests = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
  assert.ok(nodeTests.args.includes("--test-reporter=./scripts/required-node-test-reporter.mts"));
});

void test("changed Node implementations select sibling tests and syntax checks", () => {
  const { selection, plan } = planFor(["scripts/ci-health.mts"]);
  assert.ok(selection.nodeTests.has("scripts/ci-health.test.mts"));
  assert.ok(selection.nodeSyntax.has("scripts/ci-health.mts"));
  assert.ok(ids(plan).includes("node-syntax:scripts/ci-health.mts"));
  assert.ok(!ids(plan).includes("oxlint"));
  assert.ok(ids(plan).includes("node-tests"));
});

void test("competing Windows package lifecycle fixtures run serially", () => {
  const { plan } = planFor([
    "scripts/updater-artifact-inventory.test.mts",
    "scripts/windows-qualification-session.integration.test.mts",
  ]);
  const nodeTests = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
  assert.ok(nodeTests);
  assert.ok(nodeTests.args.includes("--test-concurrency=1"));
  assert.match(nodeTests.reason, /serialize competing Windows package lifecycle fixtures/u);
});

void test("heavy Rust runner and lock changes select both guarded execution contracts", () => {
  const { selection, plan } = planFor([
    "scripts/heavy-rust-test-lock.mts",
    "scripts/run-rust-tests.mts",
    "scripts/rust-support-cache.mts",
    "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  ]);
  assert.ok(selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/run-rust-tests.test.mts"));
  assert.ok(selection.nodeTests.has("scripts/rust-support-cache.test.mts"));
  assert.ok(
    plan.some(
      (entry) =>
        entry.id.startsWith("node-syntax:") &&
        entry.args.includes("scripts/heavy-rust-test-lock.mts"),
    ),
  );
  assert.ok(
    plan.some(
      (entry) =>
        entry.id.startsWith("node-syntax:") && entry.args.includes("scripts/run-rust-tests.mts"),
    ),
  );
  assert.ok(
    plan.some(
      (entry) =>
        entry.id.startsWith("node-syntax:") &&
        entry.args.includes("scripts/rust-support-cache.mts"),
    ),
  );
  assert.ok(ids(plan).includes("node-tests"));

  const fixtureOnly = planFor(["scripts/fixtures/windows-process-tree-supervisor.rs.txt"]);
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mts"));
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/run-rust-tests.test.mts"));
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/rust-support-cache.test.mts"));

  const hostFixtureOnly = planFor(["crates/portcove-core/src/testdata/host_tool_probe.rs.txt"]);
  assert.ok(hostFixtureOnly.selection.nodeTests.has("scripts/run-rust-tests.test.mts"));
  assert.ok(hostFixtureOnly.selection.nodeTests.has("scripts/rust-support-cache.test.mts"));
});

void test("production controller admission source and workflow retain their required contract", () => {
  for (const file of [
    "scripts/production-controller-admission.mts",
    ".github/workflows/application-update-production.yml",
  ]) {
    const { selection } = planFor([file]);
    assert.ok(selection.nodeTests.has("scripts/production-controller-admission.test.mts"), file);
  }
});

void test("release-script changes select deterministic release contracts without packaged qualification", () => {
  const { selection, plan } = planFor(["scripts/release-preflight.ps1"]);
  for (const contract of [
    "scripts/check-release-metadata.test.mts",
    "scripts/release-package-policy.test.mts",
    "scripts/release-coordinator.test.mts",
    "scripts/release-coordinator-state.test.mts",
    "scripts/production-controller-admission.test.mts",
    "scripts/release-workflow.test.mts",
    "scripts/windows-qualification-session.test.mts",
    "scripts/ci-workflow.test.mts",
  ])
    assert.ok(selection.nodeTests.has(contract));
  const rendered = plan.map(formatCommand).join("\n");
  assert.ok(!rendered.includes("windows-qualification-session.integration.test.mts"));
  assert.ok(!rendered.includes("desktop-test"));
});

void test("bootstrap manifest changes select cache, doctor, and quality contracts", () => {
  const { selection, plan } = planFor([".config/tool-bootstrap.json"]);
  assert.deepEqual([...selection.unknown], []);
  for (const file of [
    "scripts/tool-cache.test.mts",
    "scripts/quality-tools.test.mts",
    "scripts/dev-doctor.test.mts",
  ])
    assert.ok(selection.nodeTests.has(file));
  assert.ok(ids(plan).includes("node-tests"));
});

void test("renames classify both the old and new ownership paths", () => {
  const { selection, plan } = planFor([
    change("docs/moved.md", {
      status: "R100",
      previousPath: "crates/portcove-cli/src/removed.rs",
    }),
  ]);
  assert.ok(selection.scopes.has("documentation"));
  assert.ok(selection.packages.has("portcove-cli"));
  assert.ok(selection.oxfmtFiles.has("docs/moved.md"));
  assert.ok(!selection.oxfmtFiles.has("crates/portcove-cli/src/removed.rs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("removed.rs"));
});

void test("deleted files affect scope without becoming command arguments", () => {
  const { selection, plan } = planFor([{ status: "D", path: "scripts/retired-tool.test.mjs" }]);
  assert.ok(selection.scopes.has("tooling"));
  assert.ok(!selection.nodeTests.has("scripts/retired-tool.test.mjs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("retired-tool"));
});

void test("retired frontend tool configuration remains owned after deletion", () => {
  const retired = [
    ".prettierignore",
    "prettier.config.mjs",
    "eslint.config.mjs",
    "apps/desktop/eslint.config.mjs",
  ];
  const selection = classifyChanges(
    retired.map((path) => ({ status: "D", path })),
    { fileExists: () => false },
  );
  assert.deepEqual([...selection.unknown], []);
  assert.equal(selection.ui, true);
  assert.equal(selection.uiFullTests, true);
});

void test("retired GitHub policy JSON remains owned without a file-specific tombstone", () => {
  const selection = classifyChanges([{ status: "D", path: ".github/retired-policy.json" }], {
    fileExists: () => false,
  });
  assert.deepEqual([...selection.unknown], []);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/check-catalog-repositories.test.mts",
    "scripts/check-retcomm-upstreams.test.mts",
    "scripts/ci-frontend-workflow.test.mts",
    "scripts/ci-native-workflow.test.mts",
    "scripts/ci-release-workflow.test.mts",
    "scripts/ci-rust-workflow.test.mts",
    "scripts/ci-windows-helpers.test.mts",
    "scripts/ci-workflow-fixture.test.mts",
    "scripts/ci-workflow.test.mts",
    "scripts/deep-audit-summary.test.mts",
    "scripts/native-backup-evidence.test.mts",
    "scripts/nextest-equivalence.test.mts",
    "scripts/qualification-coverage.test.mts",
    "scripts/repository-settings.test.mts",
    "scripts/rust-toolchain-reader.test.mts",
    "scripts/rust-validation-setup.test.mts",
    "scripts/select-ci-plan.test.mts",
    "scripts/validation-plan.test.mts",
    "scripts/windows-rust-tests.test.mts",
  ]);
});

void test("retired root TOML policy remains owned without a file-specific tombstone", () => {
  const selection = classifyChanges([{ status: "D", path: "retired-policy.toml" }], {
    fileExists: () => false,
  });
  assert.deepEqual([...selection.unknown], []);
  assert.deepEqual([...selection.oxfmtFiles], []);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/local-validation.test.mts",
    "scripts/validation-plan.test.mts",
  ]);
});

void test("non-ignored untracked files use the same deterministic mapping", () => {
  const selection = classifyChanges([{ status: "?", path: "scripts/local-validation.test.mts" }], {
    fileExists: allFilesExist,
  });
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mts"));
});

void test("every tracked repository path has an explicit local selection owner", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL("../", import.meta.url),
  })
    .toString("utf8")
    .split("\0")
    .filter((file) => file && existsSync(new URL("../" + file, import.meta.url)));
  const selection = classifyChanges(files.map((path) => ({ status: "M", path })));
  assert.deepEqual([...selection.unknown].sort(), []);
});

void test("RFD source and provenance changes retain Rust, full UI and publisher contracts", () => {
  for (const file of [
    "vendor/rfd/src/backend/gtk3/message_dialog.rs",
    "vendor/rfd-provenance.json",
    "vendor/rfd-portcove.patch",
  ]) {
    for (const status of ["M", "A", "D"]) {
      const selection = classifyChanges([{ status, path: file }], { fileExists: allFilesExist });
      assert.equal(selection.workspaceRust, true);
      assert.equal(selection.uiFullTests, true);
      assert.equal(selection.browser, true);
      assert.ok(selection.nodeTests.has("scripts/dependency-automation.test.mts"));
      assert.equal(selection.unknown.size, 0);
    }
  }
});

void test("the exact development scenario entry selects full UI coverage without admitting other HTML", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection } = planFor([{ status, path: "apps/desktop/scenarios.html" }]);
    assert.equal(selection.ui, true);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.unknown.size, 0);
  }
  const renamed = classifyChanges(
    [
      {
        status: "R100",
        previousPath: "apps/desktop/scenarios.html",
        path: "apps/desktop/unknown.html",
      },
    ],
    { fileExists: allFilesExist },
  );
  assert.equal(renamed.uiFullTests, true);
  assert.ok(renamed.unknown.has("apps/desktop/unknown.html"));
});

void test("design-system configuration and native compatibility tests have UI owners", () => {
  const configuration = planFor(["apps/desktop/components.json"]).selection;
  assert.equal(configuration.ui, true);
  assert.equal(configuration.uiFullTests, true);
  assert.equal(configuration.unknown.size, 0);

  const nativeTest = planFor(["apps/desktop/test/native-compatibility.mts"]).selection;
  assert.equal(nativeTest.ui, true);
  assert.ok(nativeTest.uiRelatedFiles.has("apps/desktop/test/native-compatibility.mts"));
  assert.equal(nativeTest.unknown.size, 0);
});

function fallbackContext(changes: LocalChange[]) {
  const headSha = "a".repeat(40);
  const mergeBase = "b".repeat(40);
  return {
    changes,
    headSha,
    baseSha: mergeBase,
    mergeBase,
    validationPlan: buildValidationPlan({
      changes,
      eventName: "pull_request",
      base: mergeBase,
      mergeBase,
      head: headSha,
      checkout: headSha,
    }),
  };
}

void test("untracked modes preserve executable/type facts rather than treating every non-symlink as regular", () => {
  const file = { isSymbolicLink: () => false, isFile: () => true, mode: 0o100755 };
  assert.equal(untrackedFileMode(file, "linux"), "100755");
  assert.equal(untrackedFileMode(file, "win32"), "100644");
  assert.equal(untrackedFileMode({ ...file, mode: 0o100644 }, "linux"), "100644");
  assert.equal(untrackedFileMode({ ...file, isSymbolicLink: () => true }, "linux"), "120000");
  assert.throws(
    () => untrackedFileMode({ ...file, isSymbolicLink: () => false, isFile: () => false }),
    /non-regular/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-untracked-mode-"));
  try {
    assert.throws(() => untrackedFileMode(lstatSync(directory)), /non-regular/);
    const input = path.join(directory, "input.bin");
    writeFileSync(input, "untracked data");
    chmodSync(input, 0o644);
    assert.equal(untrackedFileMode(lstatSync(input)), "100644");
    if (process.platform !== "win32") {
      chmodSync(input, 0o755);
      assert.equal(untrackedFileMode(lstatSync(input)), "100755");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("ordinary plans never invoke aggregate, deep, release, installer, or native gates", () => {
  const { plan } = planFor([
    "docs/QUALITY.md",
    "crates/portcove-core/src/database.rs",
    "apps/desktop/src/view-model.ts",
    "scripts/ci-health.mts",
    ".github/workflows/ci.yml",
  ]);
  const rendered = plan.map(formatCommand).join("\n");
  for (const forbidden of [
    "just check",
    "just audit",
    "just deep",
    "release-preflight",
    "windows-qualification-session.integration",
    "desktop-test",
  ]) {
    assert.ok(!rendered.includes(forbidden), `unexpected ${forbidden}`);
  }
});

void test("focused wrappers require an explicit selection", () => {
  assert.throws(() => requireFocusedArguments("test-rust", []), /requires an explicit/);
  assert.throws(
    () => requireFocusedArguments("test-node", ["--test-name-pattern", "x"]),
    /requires an explicit/,
  );
  assert.doesNotThrow(() =>
    requireFocusedArguments("test-rust", ["-p", "portcove-core", "database::"]),
  );
});

void test("execution stops on the first failing stage", () => {
  const seen: string[] = [];
  const plan = [
    { id: "one", reason: "first", executable: "one", args: [], cwd: "." },
    { id: "two", reason: "second", executable: "two", args: [], cwd: "." },
    { id: "three", reason: "third", executable: "three", args: [], cwd: "." },
  ];
  assert.throws(
    () =>
      executePlan(plan, {
        spawn(executable) {
          seen.push(executable);
          return { status: executable === "two" ? 7 : 0 };
        },
      }),
    /two failed with exit code 7/,
  );
  assert.deepEqual(seen, ["one", "two"]);
});

const receiptRuntime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  osRelease: "test",
  node: "v24.21.0",
  git: "git test",
  just: "just test",
  rustc: "rustc test",
  cargo: "cargo test",
  cargoNextest: "nextest test",
  cargoShear: "shear test",
  rscheck: "rscheck test",
  aqua: "aqua test",
  powershell: "pwsh test",
  packageManager: "pnpm@12.4.1",
  packageManagerVersion: "12.4.1",
  environment: {},
});

function receiptInventory(repositoryIdentity = "repo-a"): RepositoryInventory {
  const file = (filePath: string, domain: ValidationDomain, identity: string): InventoryFile => ({
    path: filePath,
    kind: "file",
    headBlob: identity,
    headMode: "100644",
    indexBlob: identity,
    indexMode: "100644",
    worktreeMode: "100644",
    gitBlob: identity,
    sha256: identity,
    domains: [domain],
    ambiguous: false,
    untracked: false,
  });
  return {
    head: "a".repeat(40),
    objectFormat: "sha1",
    files: [
      file("crates/portcove-core/src/lib.rs", "rust", "rust-a"),
      file("scripts/repository-settings.mts", "repository", repositoryIdentity),
    ],
  };
}

void test("Node receipt fingerprints include the domain of each selected test", () => {
  const stage = {
    id: "node-tests",
    reason: "selector contract",
    executable: process.execPath,
    args: ["--test", "scripts/rust-test-impact.test.mts"],
    cwd: process.cwd(),
    obligation: "repository",
  };
  const first = receiptInventory();
  first.files.push({
    path: "scripts/rust-test-impact.mts",
    kind: "file",
    headBlob: "impact-a",
    headMode: "100644",
    indexBlob: "impact-a",
    indexMode: "100644",
    worktreeMode: "100644",
    gitBlob: "impact-a",
    sha256: "impact-a",
    domains: ["development", "format"],
    ambiguous: false,
    untracked: false,
  });
  const second = structuredClone(first);
  requiredFixture(second.files.at(-1)).headBlob = "impact-b";
  requiredFixture(second.files.at(-1)).indexBlob = "impact-b";
  requiredFixture(second.files.at(-1)).gitBlob = "impact-b";
  requiredFixture(second.files.at(-1)).sha256 = "impact-b";

  assert.notEqual(
    fingerprintLocalStage(stage, first, receiptRuntime),
    fingerprintLocalStage(stage, second, receiptRuntime),
  );

  const syntaxStage = {
    ...stage,
    id: "node-syntax:scripts/rust-test-impact.mts",
    args: ["--check", "scripts/rust-test-impact.mts"],
  };
  assert.notEqual(
    fingerprintLocalStage(syntaxStage, first, receiptRuntime),
    fingerprintLocalStage(syntaxStage, second, receiptRuntime),
  );
});

void test("native source declaration receipts invalidate when any consumed source changes", async () => {
  const { domainsForPath } = await import("./validation-evidence.mts");
  const { plan } = planFor(["crates/portcove-core/src/database.rs"]);
  const stage = requiredFixture(plan.find((entry) => entry.id === "node-tests"));
  const inventory = receiptInventory();
  inventory.files = nativeCompatibilitySourcePaths.map((source) => ({
    ...requiredFixture(receiptInventory().files[0]),
    path: source,
    domains: [...domainsForPath(source).domains],
  }));
  const original = fingerprintLocalStage(stage, inventory, receiptRuntime);
  for (const source of nativeCompatibilitySourcePaths) {
    const changed = structuredClone(inventory);
    const input = requiredFixture(changed.files.find((file) => file.path === source));
    input.sha256 = "changed-source";
    input.gitBlob = "changed-source";
    assert.notEqual(fingerprintLocalStage(stage, changed, receiptRuntime), original, source);
  }
  assert.equal(fingerprintLocalStage(stage, structuredClone(inventory), receiptRuntime), original);
});

void test("local receipts reuse proven independent stages while full repository lint reruns", (t) => {
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "portcove-local-receipts-"));
  t.after(() => rmSync(receiptRoot, { recursive: true, force: true }));
  const plan = [
    {
      id: "rust-clippy:portcove-core",
      reason: "rust",
      executable: "cargo",
      args: ["clippy"],
      cwd: process.cwd(),
      obligation: "rust",
    },
    {
      id: "node-tests",
      reason: "tooling",
      executable: "node",
      args: ["--test", "scripts/repository-settings.test.mts"],
      cwd: process.cwd(),
      obligation: "repository",
    },
    {
      id: "repository-lint",
      reason: "lint",
      executable: "corepack",
      args: ["pnpm", "check"],
      cwd: process.cwd(),
      obligation: "repository-lint",
    },
  ];
  const first: string[] = [];
  executePlanWithReceipts(plan, {
    receiptRoot,
    inventory: receiptInventory(),
    runtime: receiptRuntime,
    spawn(executable) {
      first.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(first, ["cargo", "node", "corepack"]);

  const second: string[] = [];
  const result = executePlanWithReceipts(plan, {
    receiptRoot,
    inventory: receiptInventory("repo-b"),
    runtime: receiptRuntime,
    spawn(executable) {
      second.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(second, ["node", "corepack"]);
  assert.equal(requiredFixture(result.timings[0]).status, "reused");
  assert.equal(requiredFixture(result.timings[1]).status, "executed");
  assert.equal(requiredFixture(result.timings[2]).status, "executed");
});

void test("failed, interrupted, invalid, missing, and fresh local stages cannot claim reuse", (t) => {
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "portcove-local-failure-"));
  t.after(() => rmSync(receiptRoot, { recursive: true, force: true }));
  const stage = {
    id: "node-tests",
    reason: "tooling",
    executable: "node",
    args: ["--test", "scripts/repository-settings.test.mts"],
    cwd: process.cwd(),
    obligation: "repository",
  };
  assert.throws(
    () =>
      executePlanWithReceipts([stage], {
        receiptRoot,
        inventory: receiptInventory(),
        runtime: receiptRuntime,
        spawn: () => ({ status: 9 }),
      }),
    /failed with exit code 9/u,
  );
  let executions = 0;
  const run = (options = {}) =>
    executePlanWithReceipts([stage], {
      receiptRoot,
      inventory: receiptInventory(),
      runtime: receiptRuntime,
      spawn: () => {
        executions += 1;
        return { status: 0 };
      },
      ...options,
    });
  run();
  assert.equal(executions, 1);
  run();
  assert.equal(executions, 1);

  const receiptFile = requiredFixture(
    readdirSync(receiptRoot, { recursive: true })
      .map(String)
      .find((file: string) => file.endsWith(".json")),
  );
  assert.ok(receiptFile);
  writeFileSync(path.join(receiptRoot, receiptFile), "{}\n");
  run();
  assert.equal(executions, 2);
  run({ fresh: true });
  assert.equal(executions, 3);
});

void test("selected validation uses the shared capability authority without narrowing Node obligations", async () => {
  const { selectedPrerequisites } = await import("./dev-doctor.mts");
  const { validationCapabilities, profileCapabilities } =
    await import("./development-capabilities.mts");
  assert.equal(selectedPrerequisites, validationCapabilities);
  assert.ok(!profileCapabilities("core").includes("node"));
  assert.deepEqual(selectedPrerequisites({ id: "rust-tests:portcove-cli" }), [
    "node",
    "rustc",
    "cargo",
    "cargo-nextest",
  ]);
  assert.deepEqual(selectedPrerequisites({ id: "oxfmt" }), [
    "node",
    "pnpm",
    "frontend-dependencies",
  ]);
});

void test("containment inputs select every execution contract and preserve unknown refusal", () => {
  const consumers = [
    "scripts/heavy-rust-test-lock.test.mts",
    "scripts/run-rust-tests.test.mts",
    "scripts/rust-support-cache.test.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
  ];
  const inputs = [
    ...consumers,
    ...consumers.map((file: string) => file.replace(/\.test\.([cm]?[jt]s)$/u, ".$1")),
    "scripts/fixtures/linux-process-tree-reaper.rs.txt",
    "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  ];
  const future = "new-subsystem/future-supervisor.mjs";
  for (const input of inputs) {
    for (const entry of [
      change(input),
      change(input, { status: "A" }),
      change(input, { status: "D" }),
      change(future, { status: "R100", previousPath: input, oldMode: "100644", newMode: "100644" }),
      change(input, { status: "R100", previousPath: future, oldMode: "100644", newMode: "100644" }),
    ]) {
      const selection = classifyChanges([entry], { fileExists: allFilesExist });
      for (const consumer of consumers)
        assert.ok(selection.nodeTests.has(consumer), `${input} -> ${consumer}`);
      if (entry.previousPath) {
        assert.ok(selection.unknown.has(future));
        const bound = fallbackContext([entry]);
        const commands = buildPlan(selection, bound);
        assert.ok(commands.some((command) => command.id === "rust-workspace-tests"));
        assert.ok(commands.some((command) => command.id === "ui-tests"));
        assert.ok(!commands.some((command) => command.id === "conservative-audit"));
      } else {
        const selected = buildPlan(selection);
        const contracts = requiredFixture(selected.find((command) => command.id === "node-tests"));
        for (const consumer of consumers) assert.ok(contracts.args.includes(consumer));
        if (entry.status === "D") assert.ok(!selection.nodeSyntax.has(input));
      }
    }
  }
  const mixed = planFor([...inputs, "docs/QUALITY.md"]);
  assert.ok(mixed.selection.nodeTests.has("scripts/repository-settings.test.mts"));
  for (const consumer of consumers) assert.ok(mixed.selection.nodeTests.has(consumer));
});

void test("containment selector changes retain their dependent audit and hosted contracts", () => {
  const consumers = [
    "scripts/validation-plan.test.mts",
    "scripts/local-validation.test.mts",
    "scripts/audit.test.mts",
    "scripts/select-ci-plan.test.mts",
  ];
  for (const input of [
    "scripts/validation-plan.mts",
    "scripts/validation-plan.test.mts",
    "scripts/local-validation.mts",
    "scripts/local-validation.test.mts",
  ]) {
    for (const status of ["M", "D"]) {
      const { selection } = planFor([change(input, { status })]);
      for (const consumer of consumers)
        assert.ok(selection.nodeTests.has(consumer), `${input} -> ${consumer}`);
    }
  }
});

void test("approved #706 record has an exact protected test owner without admitting another approval", () => {
  const owned = planFor([".github/linux-beta-risk-706.json"]);
  assert.equal(owned.selection.unknown.size, 0);
  assert.ok(owned.selection.nodeTests.has("scripts/linux-beta-risk-706.test.mts"));
  assert.ok(owned.selection.nodeTests.has("scripts/validation-plan.test.mts"));
  const other = classifyChanges([{ status: "M", path: ".github/linux-beta-risk-999.json" }], {
    fileExists: allFilesExist,
  });
  assert.ok(other.unknown.has(".github/linux-beta-risk-999.json"));
});

void test("reviewed upstream accounting has an exact health-test owner without admitting other configuration", () => {
  const owned = planFor([".github/upstream-health-accounting.json"]);
  assert.equal(owned.selection.unknown.size, 0);
  assert.ok(owned.selection.nodeTests.has("scripts/upstream-observer.test.mts"));
  assert.ok(owned.selection.nodeTests.has("scripts/check-catalog-repositories.test.mts"));
  assert.ok(ids(owned.plan).includes("node-tests"));
  const other = classifyChanges(
    [{ status: "M", path: ".github/unreviewed-health-accounting.json" }],
    { fileExists: allFilesExist },
  );
  assert.ok(other.unknown.has(".github/unreviewed-health-accounting.json"));
  for (const status of ["D", "R"]) {
    const change =
      status === "R"
        ? {
            status,
            path: ".github/renamed-health-accounting.json",
            previousPath: ".github/upstream-health-accounting.json",
          }
        : { status, path: ".github/upstream-health-accounting.json" };
    const selection = classifyChanges([change], { fileExists: () => false });
    assert.ok(selection.nodeTests.has("scripts/check-catalog-repositories.test.mts"));
  }
});

void test("upstream health sources select the affected offline contracts", () => {
  const healthTests = [
    "scripts/upstream-observer.test.mts",
    "scripts/upstream-health.test.mts",
    "scripts/upstream-health-plan.test.mts",
    "scripts/upstream-health-monitor.test.mts",
  ];
  for (const file of [
    "scripts/check-catalog-repositories.mts",
    "scripts/upstream-health-inputs.mts",
  ]) {
    const owned = planFor([file]);
    assert.equal(owned.selection.unknown.size, 0);
    const command = requiredFixture(owned.plan.find((entry) => entry.id === "node-tests"));
    for (const testFile of healthTests) assert.ok(command.args.includes(testFile), testFile);
    assert.ok(!command.args.some((arg) => /release-controller|desktop-scenarios/u.test(arg)));
  }
  for (const [file, tests] of [
    ["scripts/upstream-health-plan.mts", ["scripts/upstream-health-plan.test.mts"]],
    ["scripts/upstream-health-monitor.mts", ["scripts/upstream-health-monitor.test.mts"]],
    [
      ".github/workflows/upstream-health.yml",
      ["scripts/upstream-health-plan.test.mts", "scripts/upstream-health-monitor.test.mts"],
    ],
    ["scripts/node-test-suites.json", ["scripts/node-test-inventory.test.mts"]],
  ] as const) {
    const owned = planFor([file]);
    for (const testFile of tests) assert.ok(owned.selection.nodeTests.has(testFile), testFile);
  }
});

void test("optional local baseline compiles workspace tests once without duplicate lint/build stages", () => {
  for (const file of [
    "crates/portcove-core/src/source_report.rs",
    "Cargo.lock",
    "crates/portcove-cli/src/main.rs",
  ]) {
    const p = planFor([file]).plan;
    assert.equal(p.filter((entry) => entry.id === "rust-workspace-tests").length, 1);
    assert.ok(
      requiredFixture(p.find((entry) => entry.id === "rust-workspace-tests")).args.includes(
        "--guard-command",
      ),
    );
    assert.ok(!p.some((entry) => /clippy|rust-docs|audit|fallow/.test(entry.id)));
  }
});
void test("optional frontend baseline retains full lint, build and related units without deep analyzers", () => {
  const p = buildPlan(classifyChanges([{ status: "M", path: "apps/desktop/src/App.tsx" }]));
  assert.ok(p.some((entry) => entry.id === "ui-build"));
  assert.ok(p.some((entry) => entry.id === "ui-related-tests"));
  assert.deepEqual(
    p.filter((entry) => entry.id === "repository-lint").map((entry) => entry.args),
    [["scripts/run-viteplus.mts", "run", "frontend:static"]],
  );
  assert.ok(!p.some((entry) => /browser|fallow|theme/.test(entry.id)));
  assert.equal(p.filter((entry) => entry.id === "repository-lint").length, 1);
});

void test("lint follows source/configuration ownership on both rename sides without forcing UI work", () => {
  for (const change of [
    { status: "M", path: "scripts/tool.mjs" },
    { status: "M", path: "scripts/tool.mts" },
    { status: "M", path: "scripts/tsconfig.json" },
    { status: "M", path: "integrations/playnite/package.mts" },
    { status: "M", path: "integrations/playnite/tsconfig.json" },
    { status: "M", path: "apps/desktop/test/setup.ts" },
    { status: "M", path: "apps/desktop/public/theme-bootstrap.js" },
    { status: "R100", path: "docs/moved.md", previousPath: "scripts/tool.mts" },
    { status: "D", path: "scripts/deleted.mjs" },
    { status: "R100", path: "docs/moved.md", previousPath: "scripts/tool.mjs" },
    { status: "M", path: "apps/desktop/src/App.tsx" },
    { status: "M", path: "apps/desktop/src/app.css" },
    { status: "M", path: "vite.config.ts" },
    { status: "M", path: "pnpm-lock.yaml" },
  ]) {
    const { plan } = planFor([change]);
    assert.equal(plan.filter((entry) => entry.id === "repository-lint").length, 1, change.path);
  }
  const script = planFor([{ status: "M", path: "scripts/tool.mjs" }]).plan;
  assert.ok(!script.some((entry) => entry.id === "ui-build"));
  for (const file of [
    "docs/README.md",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/public/logo.png",
  ])
    assert.ok(
      !planFor([{ status: "M", path: file }]).plan.some((entry) => entry.id === "repository-lint"),
      file,
    );
});

void test("Rust receipts bind narrower or broader selection even when source inventory is identical", () => {
  const narrow = requiredFixture(
    planFor(["crates/portcove-core/src/source_report.rs"]).plan.find(
      (e) => e.id === "rust-workspace-tests",
    ),
  );
  const broad = requiredFixture(
    planFor([
      "crates/portcove-core/src/source_report.rs",
      "crates/portcove-core/src/types.rs",
    ]).plan.find((e) => e.id === "rust-workspace-tests"),
  );
  assert.deepEqual(narrow.args, broad.args);
  assert.notEqual(
    fingerprintLocalStage(narrow, receiptInventory(), receiptRuntime),
    fingerprintLocalStage(broad, receiptInventory(), receiptRuntime),
  );
  assert.throws(
    () =>
      fingerprintLocalStage(
        // @ts-expect-error Deliberately retain a malformed explicit-undefined coverage field.
        { ...narrow, rustCoverage: undefined },
        receiptInventory(),
        receiptRuntime,
      ),
    /exact selected coverage/,
  );
});

void test("live transport stages invalidate receipts when comparator and consumer inputs change", async () => {
  const { domainsForPath } = await import("./audit.mts");
  const stage = requiredFixture(
    planFor(["crates/portcove-core/src/types.rs"]).plan.find(
      (e) => e.id === "rust-workspace-tests",
    ),
  );
  for (const input of [
    "scripts/check-transport-contract.mts",
    "scripts/rust-test-impact.mts",
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/transport-host-output.generated.json",
  ]) {
    const inventory = receiptInventory();
    inventory.files.push({
      path: input,
      kind: "file",
      headBlob: "a",
      indexBlob: "a",
      gitBlob: "a",
      sha256: "a",
      headMode: "100644",
      indexMode: "100644",
      worktreeMode: "100644",
      domains: [...domainsForPath(input).domains],
      ambiguous: false,
      untracked: false,
    });
    const changed = structuredClone(inventory);
    Object.assign(requiredFixture(changed.files.at(-1)), {
      headBlob: "b",
      indexBlob: "b",
      gitBlob: "b",
      sha256: "b",
    });
    assert.notEqual(
      fingerprintLocalStage(stage, inventory, receiptRuntime),
      fingerprintLocalStage(stage, changed, receiptRuntime),
      input,
    );
    assert.notEqual(
      fingerprintLocalStage({ ...stage, id: "ui-content" }, inventory, receiptRuntime),
      fingerprintLocalStage({ ...stage, id: "ui-content" }, changed, receiptRuntime),
      input,
    );
  }
});

void test("native TypeScript syntax selection checks stripped JavaScript early errors", () => {
  const { plan } = planFor(["scripts/heavy-rust-test-lock.mts"]);
  const syntax = requiredFixture(
    plan.find((entry) => entry.id === "node-syntax:scripts/heavy-rust-test-lock.mts"),
  );
  assert.ok(syntax);
  assert.deepEqual(syntax.args, [
    "scripts/check-node-source.mts",
    "scripts/heavy-rust-test-lock.mts",
  ]);
});

void test("native TypeScript batches retain every file and reject a later invalid source", (t) => {
  const files = ["scripts/ci-health.mts", "scripts/dev-doctor.mts"];
  const syntax = planFor(files).plan.filter((entry) => entry.id.startsWith("node-syntax:"));
  assert.equal(syntax.length, 1);
  assert.deepEqual(requiredFixture(syntax[0]).args, ["scripts/check-node-source.mts", ...files]);
  const root = mkdtempSync(path.join(tmpdir(), "portcove-syntax-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first.mts"),
    last = path.join(root, "last.mts");
  writeFileSync(first, "const value: string = 'valid'; throw new Error('must not execute');");
  writeFileSync(last, "const duplicate = 1; const duplicate = 2;");
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/check-node-source.mts", first, last], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: "pipe",
      }),
    /already been declared/u,
  );
  writeFileSync(last, "const valid: number = 2;");
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["scripts/check-node-source.mts", first, last], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: "pipe",
    }),
  );
});

void test("syntax batch receipts bind the domains of earlier files as well as the last file", () => {
  const stage = requiredFixture(
    planFor(["scripts/ci-health.mts", "scripts/dev-doctor.mts"]).plan.find((entry) =>
      entry.id.startsWith("node-syntax:"),
    ),
  );
  assert.notEqual(
    fingerprintLocalStage(stage, receiptInventory("original"), receiptRuntime),
    fingerprintLocalStage(stage, receiptInventory("changed"), receiptRuntime),
  );
  assert.notEqual(
    fingerprintLocalStage(stage, receiptInventory(), receiptRuntime),
    fingerprintLocalStage(
      { ...stage, args: [...stage.args].reverse() },
      receiptInventory(),
      receiptRuntime,
    ),
  );
});

void test("large syntax selections retain every file within the existing native argv budget", () => {
  const files = readdirSync(new URL("./", import.meta.url))
    .filter((file) => file.endsWith(".mts") && !file.includes(".test."))
    .map((file) => `scripts/${file}`);
  const { plan, selection } = planFor(files);
  const batches = plan.filter((entry) => entry.id.startsWith("node-syntax:"));
  assert.ok(batches.length > 1);
  assert.equal(new Set(batches.map((entry) => entry.id)).size, batches.length);
  assert.deepEqual(
    batches.flatMap((entry) => entry.args.slice(1)),
    [...selection.nodeSyntax].sort((left, right) => left.localeCompare(right)),
  );
  for (const batch of batches)
    assert.ok(
      batch.args.slice(1).reduce((size, file) => size + JSON.stringify(file).length + 1, 0) <= 6000,
    );
});
void test("a successful payload cannot mint a reusable receipt after source changes", (t) => {
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "portcove-source-change-"));
  t.after(() => rmSync(receiptRoot, { recursive: true, force: true }));
  const inventory = receiptInventory();
  const stage = {
    id: "rust-clippy:portcove-core",
    reason: "fixture",
    executable: "cargo",
    args: ["clippy"],
    cwd: process.cwd(),
    obligation: "rust",
  };
  assert.throws(
    () =>
      executePlanWithReceipts([stage], {
        receiptRoot,
        inventory,
        runtime: receiptRuntime,
        spawn() {
          requiredFixture(inventory.files[0]).sha256 = "changed-during-owned-execution";
          return { status: 0 };
        },
      }),
    /source changed during execution; successful receipt withheld/u,
  );
});

void test("focused native and release selections retain independently executed companion suites", () => {
  for (const [file, primary, companion] of [
    [
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/native-compatibility.test.mts",
    ],
    [
      "apps/desktop/scripts/desktop-test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/native-compatibility.test.mts",
    ],
    [
      "scripts/release-workflow.test.mts",
      "scripts/release-workflow.test.mts",
      "scripts/sign-catalog.test.mts",
    ],
    [
      "scripts/check-release-metadata.mts",
      "scripts/release-workflow.test.mts",
      "scripts/sign-catalog.test.mts",
    ],
  ] as const) {
    const selected = classifyChanges([{ status: "M", path: file }], { fileExists: allFilesExist });
    assert.ok(selected.nodeTests.has(primary), `${file} selects ${primary}`);
    assert.ok(selected.nodeTests.has(companion), `${file} selects ${companion}`);
    const commands = buildPlan(selected);
    const args = commands.flatMap((command) => command.args);
    assert.equal(args.filter((arg) => arg === companion).length, 1, "run each companion once");
  }
});

void test("colocated workflow contracts retain every former route and their direct production owners", () => {
  const companions = [
    "scripts/check-catalog-repositories.test.mts",
    "scripts/check-retcomm-upstreams.test.mts",
    "scripts/deep-audit-summary.test.mts",
  ];
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/deep-quality.yml",
    ".github/workflows/upstream-health.yml",
    ".github/actions/setup-rust/action.yml",
    "package.json",
    "apps/desktop/package.json",
    "justfile",
    "scripts/ci-workflow.test.mts",
  ]) {
    // A deleted test file has no executable route; other consumers retain it.
    const statuses = file === "scripts/ci-workflow.test.mts" ? ["M"] : ["M", "D", "R"];
    for (const status of statuses) {
      const change =
        status === "R"
          ? { status, path: "renamed-workflow-input.txt", previousPath: file }
          : { status, path: file };
      const selection = classifyChanges([change], {
        fileExists: status === "M" ? allFilesExist : () => false,
      });
      assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mts"), `${status}:${file}`);
      for (const companion of companions)
        assert.ok(selection.nodeTests.has(companion), `${status}:${file}`);
    }
  }
  for (const companion of companions) {
    for (const file of [companion, companion.replace(".test.mts", ".mts")]) {
      const selection = classifyChanges([{ status: "M", path: file }], {
        fileExists: allFilesExist,
      });
      assert.ok(selection.nodeTests.has(companion), file);
    }
  }
});

void test("native enlargement helper edits select receipt contracts and related frontend tests", () => {
  const helper = "apps/desktop/scripts/native-enlargement.mts";
  const selection = classifyChanges([{ status: "M", path: helper }], {
    fileExists: allFilesExist,
  });
  assert.ok(selection.nodeTests.has("scripts/desktop-execution-plan.test.mts"));
  assert.ok(selection.uiRelatedFiles.has(helper));
  assert.equal(selection.ui, true);
});

void test("upstream families retain shared owners and narrow planner and retained-artifact consumers", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const broad = [
    "scripts/upstream-observer.test.mts",
    "scripts/upstream-health-providers.test.mts",
    "scripts/upstream-health-planning.test.mts",
    "scripts/upstream-health-accounting.test.mts",
    "scripts/upstream-health-source-archives.test.mts",
    "scripts/upstream-health.test.mts",
    "scripts/upstream-health-plan.test.mts",
    "scripts/upstream-health-monitor.test.mts",
  ];
  const planner = [
    "scripts/upstream-health-plan.test.mts",
    "scripts/upstream-health-planning.test.mts",
  ];
  const retainedArtifact = "scripts/fixtures/upstream-health-retained-artifacts.json";
  const sibling = "scripts/fixtures/upstream-health-retained-artifacts-sibling.json";
  const retainedConsumers = [
    "scripts/upstream-observer.test.mts",
    "scripts/upstream-health-providers.test.mts",
    "scripts/upstream-health-planning.test.mts",
    "scripts/upstream-health-accounting.test.mts",
    "scripts/upstream-health-source-archives.test.mts",
  ];
  for (const file of [
    "scripts/upstream-observer.mts",
    "scripts/observe-configured-upstream.mts",
    "scripts/check-catalog-repositories.mts",
    "scripts/upstream-health-inputs.mts",
    "scripts/upstream-health-plan.mts",
    "scripts/fixtures/upstream-observation-fixtures.mts",
    "scripts/fixtures/upstream-health-accounting-cases.json",
    "scripts/fixtures/upstream-health-pins.json",
    "scripts/fixtures/upstream-health-fade-to-black.json",
    retainedArtifact,
    sibling,
    "release/upstream-observer.json",
  ]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const input = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [
          {
            status: input.status,
            path: input.newPath,
            ...(input.oldPath !== input.newPath ? { previousPath: input.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [input],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      const expected =
        file === "scripts/upstream-health-plan.mts"
          ? planner
          : file === retainedArtifact
            ? retainedConsumers
            : file === sibling
              ? []
              : broad;
      const label = JSON.stringify(input);
      for (const required of expected) {
        assert.ok(local.nodeTests.has(required), "local " + required + ": " + label);
        assert.equal(
          hosted.filter((selected) => selected === required).length,
          1,
          "hosted " + required + ": " + label,
        );
      }
      if (
        file === "scripts/upstream-health-plan.mts" ||
        file === retainedArtifact ||
        file === sibling
      ) {
        assert.deepEqual(
          [...local.nodeTests]
            .filter((selected) => selected.startsWith("scripts/upstream-"))
            .sort(),
          [...expected].sort(),
          label,
        );
        if (variant.startsWith("R"))
          assert.ok(local.nodeTests.has("scripts/repository-skills.test.mts"), label);
        assert.deepEqual(
          hosted.filter((selected) => selected.startsWith("scripts/upstream-")).sort(),
          [...expected].sort(),
          label,
        );
      }
    }
  }
});

void test("Roadmap test families preserve shared owners and narrow the New Port form to intake", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const broad = [
    "scripts/roadmap-authoring.test.mts",
    "scripts/roadmap-report.test.mts",
    "scripts/roadmap-publish.test.mts",
    "scripts/roadmap-execution.test.mts",
    "scripts/roadmap.test.mts",
    "scripts/roadmap-intake.test.mts",
    "scripts/roadmap-views.test.mts",
    "scripts/roadmap-readiness.test.mts",
    "scripts/roadmap-mutations.test.mts",
    "scripts/roadmap-qualification.test.mts",
    "scripts/roadmap-provider-inventory.test.mts",
  ];
  const planner = ["scripts/roadmap-intake.test.mts"];
  for (const file of [
    "scripts/roadmap.mts",
    "scripts/roadmap-issue.mts",
    "scripts/roadmap-qualification.mts",
    "scripts/roadmap-execution.mts",
    "scripts/roadmap-readiness.mts",
    "scripts/runtime-values.mts",
    "scripts/github-api.mts",
    "scripts/repository-issue-inventory.mts",
    "scripts/repository-issue-inventory.fixture.mts",
    "scripts/roadmap-inventory.mts",
    "scripts/roadmap-scoped.mts",
    "scripts/linux-beta-risk-706.mts",
    ".github/linux-beta-risk-706.json",
    "deny.toml",
    ".github/roadmap.json",
    ".github/ISSUE_TEMPLATE/new-port.yml",
    "scripts/fixtures/roadmap-fixtures.mts",
  ]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const input = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [
          {
            status: input.status,
            path: input.newPath,
            ...(input.oldPath !== input.newPath ? { previousPath: input.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [input],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      const expected = file === ".github/ISSUE_TEMPLATE/new-port.yml" ? planner : broad;
      const label = JSON.stringify(input);
      for (const required of expected) {
        assert.ok(local.nodeTests.has(required), "local " + required + ": " + label);
        assert.equal(
          hosted.filter((selected) => selected === required).length,
          1,
          "hosted " + required + ": " + label,
        );
      }
      if (file === ".github/ISSUE_TEMPLATE/new-port.yml") {
        assert.deepEqual(
          [...local.nodeTests].filter((selected) => broad.includes(selected)).sort(),
          [...planner].sort(),
          label,
        );
        assert.deepEqual(
          hosted.filter((selected) => broad.includes(selected)).sort(),
          [...planner].sort(),
          label,
        );
      }
    }
  }
});

void test("catalog generator families retain shared inputs and narrow authoring to its consumers", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const broad = [
    "scripts/generate-catalog.test.mts",
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/catalog-source-authoring.test.mts",
    "scripts/catalog-proposal-comparison.test.mts",
    "scripts/catalog-artwork-dispatch.test.mts",
    "scripts/catalog-artwork-batches.test.mts",
    "scripts/catalog-artwork-provider.test.mts",
    "scripts/catalog-artwork-lifecycle.test.mts",
    "scripts/catalog-artwork-backoff.test.mts",
  ];
  const authoring = [
    "scripts/generate-catalog.test.mts",
    "scripts/catalog-proposal-costs.test.mts",
    "scripts/catalog-source-authoring.test.mts",
    "scripts/catalog-proposal-comparison.test.mts",
    "scripts/catalog-artwork-dispatch.test.mts",
  ];
  for (const file of [
    "scripts/generate-catalog.mts",
    "scripts/catalog-authoring.mts",
    "scripts/catalog-authoring-inspector.mts",
    "scripts/inspect-igdb-artwork.mts",
    "scripts/upstream-lineage.mts",
    "scripts/maintainer-config.mts",
    "scripts/runtime-values.mts",
    "scripts/fixtures/catalog-generator-fixtures.mts",
    "crates/portcove-core/catalog/catalog-current-authoring.json",
    "crates/portcove-core/catalog/catalog-schema1-fixture.json",
    "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
    "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/catalog/catalog-shared.json",
    "crates/portcove-core/catalog/listings.json",
    "crates/portcove-core/catalog/ports/historical-fixture.json",
  ]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const input = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [
          {
            status: input.status,
            path: input.newPath,
            ...(input.oldPath !== input.newPath ? { previousPath: input.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [input],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      const expected = file === "scripts/catalog-authoring.mts" ? authoring : broad;
      const label = JSON.stringify(input);
      for (const required of expected) {
        assert.ok(local.nodeTests.has(required), "local " + required + ": " + label);
        assert.equal(
          hosted.filter((selected) => selected === required).length,
          1,
          "hosted " + required + ": " + label,
        );
      }
      if (file === "scripts/catalog-authoring.mts") {
        assert.deepEqual(
          [...local.nodeTests].filter((selected) => broad.includes(selected)).sort(),
          [...authoring].sort(),
          label,
        );
        assert.deepEqual(
          hosted.filter((selected) => broad.includes(selected)).sort(),
          [...authoring].sort(),
          label,
        );
        for (const retained of [
          "scripts/prepare-port.test.mts",
          "scripts/catalog-staged-check.test.mts",
        ]) {
          assert.ok(local.nodeTests.has(retained), label);
          assert.ok(hosted.includes(retained), label);
        }
      }
    }
  }
});

void test("isolated executor recovery fixture edits retain the local and hosted controller consumer", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const file = "scripts/fixtures/release-executor-recovery-fixture.mts",
    consumer = "scripts/release-catalog-site-controller.test.mts";
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath: variant === "R-new" ? "docs/moved.md" : file,
      newPath: variant === "R-old" ? "docs/moved.md" : file,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const selected = classifyChanges(
      [
        {
          status: change.status,
          path: change.newPath,
          ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
        },
      ],
      { fileExists: () => false },
    );
    assert.ok(selected.nodeTests.has(consumer), variant);
    assert.ok(!selected.unknown.has(file), variant);
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(
      baselineContractTests(plan, { fileExists: () => false }).filter((value) => value === consumer)
        .length,
      1,
      variant,
    );
  }
  assert.ok(!classifyChanges([{ status: "M", path: "docs/README.md" }]).nodeTests.has(consumer));
});

void test("isolated signing fixtures retain local and hosted signer/getter coverage", async () => {
  for (const [file, consumer] of [
    [
      "scripts/fixtures/signing-context-artifact-fixture.mts",
      "scripts/release-signing-context-artifact.test.mts",
    ],
    [
      "scripts/fixtures/signing-context-receiver-fixture.mts",
      "scripts/release-signing-context-artifact.test.mts",
    ],
    ["scripts/fixtures/tuf-prekey-fixture.mts", "scripts/release-tuf-signing.test.mts"],
    [
      "scripts/fixtures/tuf-controller-guard-fixture.mts",
      "scripts/release-tuf-controller.test.mts",
    ],
  ] as const) {
    const { baselineContractTests } = await import("./ci-baseline.mts");
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const selected = classifyChanges(
        [
          {
            status: change.status,
            path: change.newPath,
            ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      assert.ok(selected.nodeTests.has(consumer), variant);
      assert.ok(!selected.unknown.has(file), variant);
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.equal(
        baselineContractTests(plan, { fileExists: () => false }).filter(
          (value) => value === consumer,
        ).length,
        1,
        variant,
      );
    }
    assert.ok(!classifyChanges([{ status: "M", path: "docs/README.md" }]).nodeTests.has(consumer));
  }
});

void test("coordinator phase diagnostics select their integration consumer without historical siblings", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const file = "scripts/fixtures/coordinator-fixture-phases.mts";
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath: variant === "R-new" ? "docs/moved.md" : file,
      newPath: variant === "R-old" ? "docs/moved.md" : file,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const local = classifyChanges(
      [
        {
          status: change.status,
          path: change.newPath,
          ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
        },
      ],
      { fileExists: () => false },
    );
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    for (const selected of [
      [...local.nodeTests],
      baselineContractTests(plan, { fileExists: () => false }),
    ]) {
      assert.ok(selected.includes("scripts/release-coordinator-state.test.mts"), variant);
      assert.equal(
        selected.includes("scripts/release-coordinator-owned-executor.test.mts"),
        false,
        variant,
      );
    }
  }
});

void test("coordinator families preserve broad consumers and isolate the signing exchange", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const broad = [
    "scripts/release-coordinator-state.test.mts",
    "scripts/release-coordinator-recovery.test.mts",
    "scripts/release-coordinator-remote.test.mts",
    "scripts/release-coordinator-checkpoint-evidence.test.mts",
    "scripts/release-coordinator-capacity-effects.test.mts",
    "scripts/release-coordinator-metadata.test.mts",
    "scripts/release-coordinator-signing-exchange.test.mts",
    "scripts/release-coordinator-owned-executor.test.mts",
  ];
  const signing = [
    "scripts/release-coordinator-state.test.mts",
    "scripts/release-coordinator-signing-exchange.test.mts",
    "scripts/release-coordinator-owned-executor.test.mts",
  ];
  const shared = [
    "scripts/fixtures/coordinator-state-fixtures.mts",
    "scripts/fixtures/release-capacity-fixture.mts",
    "scripts/release-capacity.mts",
    "scripts/release-capacity-operation.mts",
    "scripts/fixtures/release-metadata-fixture.mts",
    "scripts/runtime-values.mts",
    "apps/desktop/scripts/prepare-release-version.mts",
    "scripts/release-coordinator-state.mts",
    "scripts/release-coordinator-remote.mts",
    "scripts/release-coordinator-checkpoint-evidence.mts",
    "scripts/production-controller-admission.mts",
    "scripts/github-api.mts",
    "scripts/fixtures/assembler-identity-fixture.mts",
    "scripts/fixtures/release-catalog-publication-fixture.mts",
    "scripts/fixtures/checkpoint-proof-fixture.mts",
    ".github/workflows/application-update-production.yml",
    "scripts/release-coordinator-recovery.mts",
    "scripts/release-coordinator-checkpoint-authentication.mts",
    "scripts/release-coordinator-checkpoint-signing.mts",
    "scripts/release-capacity-executor.mts",
    "scripts/release-coordinator-journal-api.mts",
    "scripts/release-readonly-child-environment.mts",
    "docs/qualification/application-update-production.complete.yml",
    ...broad,
  ];
  const focused = "scripts/release-coordinator-signing-exchange.mts";
  const cases: {
    label: string;
    changes: {
      status: string;
      oldPath: string;
      newPath: string;
      oldMode: string;
      newMode: string;
    }[];
    expected: string[];
  }[] = [];
  for (const file of [...shared, focused]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      cases.push({
        label: file + ":" + variant,
        changes: [
          {
            status: variant.startsWith("R") ? "R100" : variant,
            oldPath: variant === "R-new" ? "docs/moved.md" : file,
            newPath: variant === "R-old" ? "docs/moved.md" : file,
            oldMode: variant === "A" ? "000000" : "100644",
            newMode: variant === "D" ? "000000" : "100644",
          },
        ],
        expected: file === focused ? signing : broad,
      });
    }
  }
  for (const [oldPath, newPath] of [
    [focused, "scripts/release-coordinator-state.mts"],
    ["scripts/release-coordinator-state.mts", focused],
  ] as const) {
    cases.push({
      label: oldPath + " -> " + newPath,
      changes: [{ status: "R100", oldPath, newPath, oldMode: "100644", newMode: "100644" }],
      expected: broad,
    });
  }
  cases.push({
    label: "mixed signing and shared state",
    changes: [focused, "scripts/runtime-values.mts"].map((file) => ({
      status: "M",
      oldPath: file,
      newPath: file,
      oldMode: "100644",
      newMode: "100644",
    })),
    expected: broad,
  });
  for (const scenario of cases) {
    const local = classifyChanges(
      scenario.changes.map((input) => ({
        status: input.status,
        path: input.newPath,
        ...(input.newPath !== input.oldPath ? { previousPath: input.oldPath } : {}),
      })),
      { fileExists: () => false },
    );
    const plan = buildValidationPlan({
      changes: scenario.changes,
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    const hosted = baselineContractTests(plan, { fileExists: () => false });
    for (const selected of [[...local.nodeTests], hosted]) {
      assert.deepEqual(
        selected.filter((file) => broad.includes(file)).sort(),
        [...scenario.expected].sort(),
        scenario.label,
      );
      for (const file of scenario.expected)
        assert.equal(selected.filter((entry) => entry === file).length, 1, scenario.label);
    }
  }
});

void test("case observation implementation selects the reporter consumer with missing historical siblings", async () => {
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const file = "scripts/node-case-observations.mts";
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath: variant === "R-new" ? "docs/moved.md" : file,
      newPath: variant === "R-old" ? "docs/moved.md" : file,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const selected = classifyChanges(
      [
        {
          status: change.status,
          path: change.newPath,
          ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
        },
      ],
      { fileExists: () => false },
    );
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.ok(selected.nodeTests.has("scripts/test-duration-reporter.test.mts"), variant);
    assert.ok(
      baselineContractTests(plan, { fileExists: () => false }).includes(
        "scripts/test-duration-reporter.test.mts",
      ),
      variant,
    );
  }
});

void test("doctest reporting dependencies retain their real consumers across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const helpers = ["scripts/qualification-rustdoc.mts", "scripts/rustdoc-outcomes.mts"];
  for (const file of [
    ...helpers,
    "scripts/runtime-values.mts",
    ".node-version",
    "rust-toolchain.toml",
    "scripts/fixtures/rustdoc-outcomes/merged.jsonl",
    "scripts/fixtures/rustdoc-outcomes/failed.jsonl",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = new Set(
        baselineContractTests(
          buildValidationPlan({
            changes: [change],
            eventName: "pull_request",
            base: "a".repeat(40),
            mergeBase: "a".repeat(40),
            head: "b".repeat(40),
            checkout: "b".repeat(40),
          }),
          { fileExists: () => false },
        ),
      );
      const required = helpers.includes(file)
        ? [
            "qualification-rustdoc",
            "qualification-coverage",
            "audit",
            "precommit-check",
            "local-validation",
            "node-test-inventory",
          ]
        : ["qualification-rustdoc"];
      const requiredPaths = required.map((consumer) => "scripts/" + consumer + ".test.mts");
      assert.deepEqual(
        requiredPaths.filter((consumer) => !local.nodeTests.has(consumer)),
        [],
        file + "/" + variant + "/local",
      );
      assert.deepEqual(
        requiredPaths.filter((consumer) => !hosted.has(consumer)),
        [],
        file + "/" + variant + "/hosted",
      );
    }
});

void test("Nextest configuration lifecycle changes select the executable timeout and output policy contract", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const file = ".config/nextest.toml";
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath: variant === "R-new" ? "docs/moved.md" : file,
      newPath: variant === "R-old" ? "docs/moved.md" : file,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const local = classifyChanges(
      [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
      { fileExists: () => false },
    );
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.ok(local.nodeTests.has("scripts/ci-rust-workflow.test.mts"), variant);
    assert.ok(
      baselineContractTests(plan, { fileExists: () => false }).includes(
        "scripts/ci-rust-workflow.test.mts",
      ),
      variant,
    );
  }
});

void test("controller decision modules retain their imported transport consumer across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    "scripts/release-publication-result-artifact.mts",
    "scripts/release-signing-context-artifact.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = baselineContractTests(
        buildValidationPlan({
          changes: [change],
          eventName: "pull_request",
          base: "a".repeat(40),
          mergeBase: "a".repeat(40),
          head: "b".repeat(40),
          checkout: "b".repeat(40),
        }),
        { fileExists: () => false },
      );
      assert.ok(
        local.nodeTests.has("scripts/release-controller-transport.test.mts"),
        file + "/" + variant + "/local",
      );
      assert.ok(
        hosted.includes("scripts/release-controller-transport.test.mts"),
        file + "/" + variant + "/hosted",
      );
    }
});

void test("platform skip inputs retain their declared case and policy consumers across lifecycle changes", async () => {
  const { baselineContractTests, baselineRequiresDesktopDependencies } =
    await import("./ci-baseline.mts");
  for (const file of [
    "scripts/node-platform-skips.mts",
    "scripts/node-test-suites.mts",
    "scripts/node-test-suites.json",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = new Set(
        baselineContractTests(
          buildValidationPlan({
            changes: [change],
            eventName: "pull_request",
            base: "a".repeat(40),
            mergeBase: "a".repeat(40),
            head: "b".repeat(40),
            checkout: "b".repeat(40),
          }),
          { fileExists: () => false },
        ),
      );
      const dependencyPlan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.equal(
        baselineRequiresDesktopDependencies(dependencyPlan),
        true,
        file + "/" + variant + "/desktop-dependencies",
      );
      const expected = [
        "scripts/node-platform-skips.test.mts",
        "scripts/required-node-test-reporter.test.mts",
        "scripts/node-test-inventory.test.mts",
        "scripts/release-checkpoint-store.test.mts",
        "scripts/release-controller-transport.test.mts",
        "scripts/ui-test-selection.test.mts",
        "scripts/audit.test.mts",
      ];
      assert.deepEqual(
        expected.filter((consumer) => !local.nodeTests.has(consumer)),
        [],
        file + "/" + variant + "/local",
      );
      assert.deepEqual(
        expected.filter((consumer) => !hosted.has(consumer)),
        [],
        file + "/" + variant + "/hosted",
      );
    }
});

void test("default nextest runtime inputs retain local and hosted consumers across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    "scripts/nextest-outcomes.mts",
    "scripts/nextest-skip-routes.mts",
    "scripts/nextest-outcomes-cli.mts",
    "scripts/run-rust-tests.mts",
    "scripts/report-summary.mts",
    "scripts/bounded-summary.mts",
    "scripts/fallow-summary.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: allFilesExist },
      );
      const hosted = baselineContractTests(
        buildValidationPlan({
          changes: [change],
          eventName: "pull_request",
          base: "a".repeat(40),
          mergeBase: "a".repeat(40),
          head: "b".repeat(40),
          checkout: "b".repeat(40),
        }),
        { fileExists: allFilesExist },
      );
      for (const consumer of [
        "scripts/nextest-outcomes.test.mts",
        "scripts/run-rust-tests.test.mts",
      ]) {
        assert.ok(local.nodeTests.has(consumer), file + "/" + variant + "/local");
        assert.ok(hosted.includes(consumer), file + "/" + variant + "/hosted");
      }
    }
});

void test("version runtime and relative fixture closure retain local and hosted consumers", async () => {
  const { baselineContractTests, baselineRequiresDesktopDependencies } =
    await import("./ci-baseline.mts");
  for (const file of [
    "apps/desktop/scripts/release-version-policy.mts",
    "apps/desktop/scripts/release-version-runtime.mts",
    "apps/desktop/scripts/release-version-bundled-runtime.mts",
    "scripts/release-controller-tool-build.mts",
    "scripts/fixtures/module-closure.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: allFilesExist },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const hosted = baselineContractTests(plan, { fileExists: allFilesExist });
      if (file.startsWith("apps/desktop/scripts/release-version-")) {
        const { validationOwnershipForPath } = await import("./validation-plan.mts");
        assert.equal(
          validationOwnershipForPath(file).qualificationRequired,
          true,
          file + "/" + variant + "/protected-route",
        );
      }
      assert.ok(baselineRequiresDesktopDependencies(plan), file + "/" + variant + "/dependencies");
      const expected = [
        "scripts/production-aggregate-steps.test.mts",
        ...(file !== "scripts/fixtures/module-closure.mts"
          ? ["scripts/release-controller-tools.test.mts"]
          : []),
      ];
      for (const consumer of expected) {
        assert.ok(local.nodeTests.has(consumer), file + "/" + variant + "/local");
        assert.ok(hosted.includes(consumer), file + "/" + variant + "/hosted");
      }
    }
});

void test("standalone reporter and binary-identity inputs retain local and hosted consumers", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of ["scripts/standalone-rust-tests.mts", "scripts/development-evidence.mts"])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
        { fileExists: () => false },
      );
      const hosted = baselineContractTests(
        buildValidationPlan({
          changes: [change],
          eventName: "pull_request",
          base: "a".repeat(40),
          mergeBase: "a".repeat(40),
          head: "b".repeat(40),
          checkout: "b".repeat(40),
        }),
        { fileExists: () => false },
      );
      for (const consumer of [
        "scripts/qualification-rustdoc.test.mts",
        "scripts/development-evidence.test.mts",
        "scripts/desktop-scenarios.test.mts",
        "scripts/validation-evidence.test.mts",
        "scripts/workflow-provenance.test.mts",
        "scripts/ci-rust-workflow.test.mts",
      ])
        assert.ok(
          local.nodeTests.has(consumer) && hosted.includes(consumer),
          `${file}:${variant}:${consumer}`,
        );
    }
});

void test("resource observation ledger remains an affected consumer of every maintained budget workflow", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    ".github/workflows/release.yml",
    ".github/workflows/application-update-production.yml",
    ".github/workflows/application-update-wake.yml",
    "scripts/release-capacity.mts",
    "scripts/release-resource-observation.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
          [{ status: change.status, path: change.newPath, previousPath: change.oldPath }],
          { fileExists: allFilesExist },
        ),
        hosted = baselineContractTests(
          buildValidationPlan({
            changes: [change],
            eventName: "pull_request",
            base: "a".repeat(40),
            mergeBase: "a".repeat(40),
            head: "b".repeat(40),
            checkout: "b".repeat(40),
          }),
          { fileExists: allFilesExist },
        );
      assert.ok(
        local.nodeTests.has("scripts/release-resource-observation.test.mts"),
        file + "/" + variant + "/local",
      );
      assert.ok(
        hosted.includes("scripts/release-resource-observation.test.mts"),
        file + "/" + variant + "/hosted",
      );
    }
});

void test("native transport producers retain their actual Node consumers across lifecycle changes", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const { windowsHelperChecksRequired, windowsNativeToolsRequired } =
    await import("./windows-helper-checks.mts");
  const consumers: [string, string[]][] = [
    ...[
      "apps/desktop/scripts/desktop-installed-update-harness.mts",
      "apps/desktop/scripts/desktop-windows-update-test.mts",
      "apps/desktop/scripts/desktop-macos-installed-update-test.mts",
    ].map((file): [string, string[]] => [
      file,
      ["scripts/desktop-scenarios.test.mts", "scripts/desktop-boundary-wiring.test.mts"],
    ]),
    [
      "apps/desktop/scripts/desktop-qualification-history-test.mts",
      [
        "scripts/desktop-scenarios.test.mts",
        "apps/desktop/scripts/desktop-qualification-history.native.test.mts",
      ],
    ],
    [
      "apps/desktop/scripts/desktop-host-publication-test.mts",
      [
        "scripts/desktop-scenarios.test.mts",
        "scripts/desktop-execution-plan.test.mts",
        "scripts/desktop-boundary-wiring.test.mts",
      ],
    ],
    [
      "apps/desktop/scripts/desktop-webview-boundary.mts",
      [
        "scripts/desktop-boundary-wiring.test.mts",
        "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
      ],
    ],
    [
      "apps/desktop/scripts/desktop-boundary-invoke.mts",
      ["apps/desktop/scripts/desktop-webview-boundary.native.test.mts"],
    ],
    [
      "apps/desktop/scripts/desktop-windows-embedded-session.mts",
      [
        "apps/desktop/scripts/desktop-native-observations.native.test.mts",
        "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
      ],
    ],
    [
      "apps/desktop/scripts/browser-script.mts",
      [
        "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
        "apps/desktop/scripts/desktop-main-webview-boundary.native.test.mts",
      ],
    ],
    ...[
      "apps/desktop/scripts/desktop-preparation-test.mts",
      "apps/desktop/scripts/desktop-artwork-correction-test.mts",
    ].map((file): [string, string[]] => [
      file,
      [
        "scripts/desktop-scenarios.test.mts",
        "scripts/desktop-boundary-wiring.test.mts",
        ...(file === "apps/desktop/scripts/desktop-preparation-test.mts"
          ? ["scripts/capture-target.test.mts"]
          : []),
      ],
    ]),
    [
      "apps/desktop/scripts/desktop-source-dialog-test.mts",
      ["scripts/desktop-scenarios.test.mts", "scripts/desktop-boundary-wiring.test.mts"],
    ],
    [
      "scripts/release-immutable-publication.mts",
      [
        "scripts/release-pending-release-recovery.test.mts",
        "scripts/release-immutable-publication.test.mts",
      ],
    ],
    [
      "scripts/fixtures/native-fetch-probe-fixture.mts",
      [
        "apps/desktop/scripts/desktop-readiness.native.test.mts",
        "apps/desktop/scripts/desktop-install.native.test.mts",
      ],
    ],
    [
      "scripts/fixtures/desktop-module-fixture.mts",
      [
        "apps/desktop/scripts/desktop-catalog-update.native.test.mts",
        "apps/desktop/scripts/desktop-default-cover.native.test.mts",
        "apps/desktop/scripts/desktop-reload.native.test.mts",
        "scripts/desktop-scenarios.test.mts",
        "scripts/desktop-boundary-wiring.test.mts",
        "scripts/desktop-execution-plan.test.mts",
        "scripts/desktop-real-runtime.test.mts",
        "scripts/native-compatibility.test.mts",
        "apps/desktop/scripts/desktop-remainder-scenarios.native.test.mts",
        "apps/desktop/scripts/desktop-artwork-correction.native.test.mts",
        "apps/desktop/scripts/desktop-workspace-refresh.native.test.mts",
        "apps/desktop/scripts/desktop-artwork.native.test.mts",
        "apps/desktop/scripts/desktop-macos-installed-update.native.test.mts",
        "scripts/capture-target.test.mts",
        "apps/desktop/scripts/desktop-bootstrap-recovery.native.test.mts",
        "apps/desktop/scripts/desktop-install.native.test.mts",
        "apps/desktop/scripts/desktop-main-webview-boundary.native.test.mts",
        "apps/desktop/scripts/desktop-readiness.native.test.mts",
        "scripts/desktop-staged-layout.test.mts",
        "apps/desktop/scripts/desktop-qualification-history.native.test.mts",
      ],
    ],
  ];
  for (const [file, tests] of consumers)
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const name = path.basename(file);
      const oldPath = variant === "R-new" ? "docs/moved.md" : file;
      const newPath = variant === "R-old" ? "docs/moved.md" : file;
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath,
        newPath,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ ...change, path: newPath, ...(oldPath !== newPath ? { previousPath: oldPath } : {}) }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      if (
        file === "scripts/fixtures/desktop-module-fixture.mts" ||
        file === "scripts/fixtures/native-fetch-probe-fixture.mts" ||
        file === "apps/desktop/scripts/desktop-qualification-history-test.mts"
      ) {
        assert.equal(windowsHelperChecksRequired(plan), true, variant);
        assert.equal(windowsNativeToolsRequired(plan), true, variant);
      }
      if (name === "browser-script.mts") {
        assert.equal(local.ui, true);
        assert.ok(plan.groups.includes("frontend"));
        assert.ok(
          buildPlan(local).some(
            (entry) => entry.id === "ui-tests" || entry.id === "ui-related-tests",
          ),
        );
        assert.ok(!local.nodeTests.has("apps/desktop/scripts/browser-script.test.mts"));
        assert.ok(
          !baselineContractTests(plan, { fileExists: () => false }).includes(
            "apps/desktop/scripts/browser-script.test.mts",
          ),
        );
      }
      for (const selected of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        for (const test of tests) assert.ok(selected.has(test), `${variant}: ${name} -> ${test}`);
    }
});

void test("desktop launcher changes retain evidence, CLI entry and package consumers", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const file = "scripts/desktop-test-cli.mts";
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const oldPath = variant === "R-new" ? "docs/moved.md" : file;
    const newPath = variant === "R-old" ? "docs/moved.md" : file;
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath,
      newPath,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const local = classifyChanges(
      [{ ...change, path: newPath, ...(oldPath !== newPath ? { previousPath: oldPath } : {}) }],
      { fileExists: () => false },
    );
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    for (const selected of [
      local.nodeTests,
      new Set(baselineContractTests(plan, { fileExists: () => false })),
    ])
      for (const test of [
        "scripts/development-evidence.test.mts",
        "scripts/development-cli-help.test.mts",
        "scripts/retained-package.test.mts",
      ])
        assert.ok(selected.has(test), `${variant}: missing ${test}`);
  }
});

void test("diagnostic provider and preparation changes retain budget and observer owners across every lifecycle status", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    "scripts/release-hosted-native-windows-diagnostic-source.mts",
    "scripts/release-hosted-native-windows-diagnostic-preparation.mts",
    "scripts/release-hosted-native-windows-diagnostic.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const oldPath = variant === "R-new" ? "docs/moved.md" : file,
        newPath = variant === "R-old" ? "docs/moved.md" : file;
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath,
        newPath,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [{ ...change, path: newPath, ...(oldPath !== newPath ? { previousPath: oldPath } : {}) }],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      for (const selected of [
        local.nodeTests,
        new Set(baselineContractTests(plan, { fileExists: () => false })),
      ])
        for (const consumer of [
          "scripts/release-hosted-native-windows-session.test.mts",
          "scripts/hosted-native-continuity.test.mts",
        ])
          assert.ok(selected.has(consumer), `${variant}/${file}/${consumer}`);
    }
});

void test("native runtime owners retain direct behavior and caller contracts on every path operation", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  for (const file of [
    "apps/desktop/scripts/desktop-owned-native-session.mts",
    "apps/desktop/scripts/desktop-real-runtime-test.mts",
    "apps/desktop/scripts/desktop-test.mts",
  ])
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const change = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved-native-runtime.md" : file,
        newPath: variant === "R-old" ? "docs/moved-native-runtime.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const local = classifyChanges(
        [
          {
            status: change.status,
            path: change.newPath,
            ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      const plan = buildValidationPlan({
        changes: [change],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      for (const consumer of [
        "scripts/desktop-real-runtime.test.mts",
        "scripts/desktop-boundary-wiring.test.mts",
      ]) {
        assert.ok(local.nodeTests.has(consumer), `${file}:${variant}:${consumer}`);
        assert.equal(
          hosted.filter((value) => value === consumer).length,
          1,
          `${file}:${variant}:${consumer}`,
        );
      }
      assert.ok(!local.unknown.has(file), `${file}:${variant}`);
    }
});

void test("POSIX qualification identity module retains its public caller tests on every path operation", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const file = "scripts/native-qualification-posix-identity.psm1";
  const consumer = "scripts/updater-artifact-inventory.test.mts";
  for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
    const change = {
      status: variant.startsWith("R") ? "R100" : variant,
      oldPath: variant === "R-new" ? "docs/moved-posix-identity.md" : file,
      newPath: variant === "R-old" ? "docs/moved-posix-identity.md" : file,
      oldMode: variant === "A" ? "000000" : "100644",
      newMode: variant === "D" ? "000000" : "100644",
    };
    const local = classifyChanges(
      [
        {
          status: change.status,
          path: change.newPath,
          ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
        },
      ],
      { fileExists: () => false },
    );
    assert.ok(local.nodeTests.has(consumer), variant);
    assert.ok(!local.unknown.has(file), variant);
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(
      baselineContractTests(plan, { fileExists: () => false }).filter((value) => value === consumer)
        .length,
      1,
      variant,
    );
  }
});
