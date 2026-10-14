import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
  nativeHelperSharedSources,
  captureDesktopReceiptInputs,
} from "./native-helper-dependencies.mjs";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { fileIdentity } from "./development-evidence.mjs";
import { planDesktopExecution } from "./desktop-execution-plan.mjs";
import { resolveDesktopSelection, desktopHarnessDeadlineMs } from "./desktop-scenarios.mjs";
import { buildDesktopVerifyPlan } from "./desktop-verify.mjs";
import { runOwnedFixtureJourneys } from "../apps/desktop/scripts/desktop-owned-fixture-journeys.mjs";
const baseline = JSON.parse(
  await readFile(new URL("./testdata/desktop-execution-baseline.json", import.meta.url), "utf8"),
);
const executableNames = {
  app: "baseline-app.exe",
  driver: "baseline-driver.exe",
  "native-driver": "baseline-native-driver.exe",
  "preparation-cli": "baseline-cli.exe",
  "preparation-tool": "baseline-tool.exe",
};

test("hash continuation routes only the isolated selected-setup fixture with positive closure", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-saved-folder-hash-resume"],
    platform: "win32",
  });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "saved-folder-hash-resume");
  assert.equal(plan.fixtures.hashResumeJourney, true);
  assert.equal(plan.fixtures.sourceJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.equal(plan.fixtures.holdFirstDownload, false);
  assert.deepEqual(plan.fixtureFamilies.find((item) => item.family === "selected-setup").members, [
    { id: "native-saved-folder-hash-resume", role: "selected" },
  ]);
  assert.deepEqual(plan.fixtureFamilies.find((item) => item.family === "preparation").members, []);
  assert.ok(
    plan.receiptInputs.some(
      (item) => item.path === "apps/desktop/scripts/desktop-source-dialog-test.mjs",
    ),
  );
  for (const platform of ["linux", "darwin"])
    assert.throws(
      () => resolveDesktopSelection({ scenarios: ["native-saved-folder-hash-resume"], platform }),
      /requires Windows/,
    );
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: ["native-saved-folder-hash-resume", "native-selected-setup-completion"],
        platform: "win32",
      }),
    /standalone/,
  );
});

test("execution planning preserves the independently reviewed pre-change oracle", () => {
  assert.equal(baseline.starting_main, "a9e3db4e6cd9fd41111b58705e4fa54790eb57d7");
  assert.equal(baseline.rows.length, 222);
  for (const row of baseline.rows) {
    if (row.selection_error) {
      // Keep the historical rejection bytes intact. #244 now admits only these
      // two exact Linux opt-ins, with the existing fixture and deadline contract.
      const linuxOptIn =
        row.platform === "linux" &&
        row.options.scenarios?.length === 1 &&
        ["native-selected-setup-completion", "native-saved-folder-selected-setup"].includes(
          row.options.scenarios[0],
        );
      if (linuxOptIn) {
        const selection = resolveDesktopSelection({ ...row.options, platform: row.platform });
        assert.deepEqual(selection.selected_scenarios, row.options.scenarios);
        assert.deepEqual(selection.setup_scenarios, []);
        assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
        const plan = planDesktopExecution(selection, { platform: row.platform });
        assert.ok(plan.build.cliFeatures.includes("portcove-core/qualification-fixtures"));
        continue;
      }
      assert.throws(() => resolveDesktopSelection({ ...row.options, platform: row.platform }), {
        message:
          row.options.scenarios?.length === 1 &&
          ["native-selected-setup-completion", "native-saved-folder-selected-setup"].includes(
            row.options.scenarios[0],
          )
            ? `${row.options.scenarios[0]} requires Windows or Linux`
            : row.selection_error,
      });
      continue;
    }
    const selection = resolveDesktopSelection({ ...row.options, platform: row.platform });
    // Preserve the frozen oracle. This new opt-in scenario was absent from its
    // inventory and remains excluded from every historical execution.
    const historicalSelection = (value) => ({
      ...value,
      excluded_scenarios: value.excluded_scenarios.filter(
        (id) =>
          ![
            "native-preliminary-source-review",
            "native-saved-folder-hash-resume",
            "native-preliminary-selected-setup",
          ].includes(id),
      ),
    });
    assert.ok(!selection.selected_scenarios.includes("native-preliminary-source-review"));
    assert.ok(selection.excluded_scenarios.includes("native-preliminary-source-review"));
    assert.ok(!selection.selected_scenarios.includes("native-saved-folder-hash-resume"));
    assert.ok(selection.excluded_scenarios.includes("native-saved-folder-hash-resume"));
    assert.deepEqual(historicalSelection(selection), row.selection);
    const plan = planDesktopExecution(selection, { platform: row.platform });
    assert.deepEqual(historicalSelection(plan.selection), row.selection);
    // Frozen oracle retains every historical input. Registry additions and
    // deduplication affect receipt identities only, never dispatch/acceptance.
    const actualInputs = plan.receiptInputs.map((input) =>
      input.kind === "executable" ? executableNames[input.name] : input.path,
    );
    for (const historical of row.initial_receipt_inputs)
      assert(actualInputs.includes(historical), historical);
    for (const added of actualInputs.filter((file) => !row.initial_receipt_inputs.includes(file)))
      assert(
        Object.hasOwn(nativeHelperDependencies, added) ||
          nativeHelperSharedSources.includes(added) ||
          added === nativeHelperRegistryPath,
        added,
      );
    assert.equal(new Set(actualInputs).size, actualInputs.length);

    if (!row.harness_admission.error) {
      const expectedSession = structuredClone(row.harness_admission);
      // Preserve the historical oracle while requiring positive cleanup for
      // #1168's owned retained-data backup creation journey on Windows.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-reviewed-backup-restore-and-delete")
      ) {
        expectedSession.identityBoundSession = true;
        expectedSession.cleanupName = "backup-review";
      }
      // The retained oracle stays immutable; #244 deliberately adds positive
      // owned exit proof to the completion journey through the existing owner.
      if (selection.selected_scenarios.includes("native-selected-setup-completion")) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "selected-setup-completion";
      }
      // #1168's retained rollback witness also requires the existing positive
      // exit owner. This intentional delta does not rewrite historical bytes.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-retained-contract-repair-state")
      ) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "retained-contract-repair";
      }
      // Current-update review uses the same positive Windows exit owner.
      // Keep the historical oracle unchanged and state the intentional delta.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-game-update-review")
      ) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "game-update-review";
      }
      assert.deepEqual(plan.session, expectedSession);
    }
    assert.deepEqual(plan.build.cliFeatures, row.serialized_verify_plan.cli_features);
    assert.deepEqual(
      plan.build.qualificationFeatures,
      row.serialized_verify_plan.qualification_features,
    );
    assert.deepEqual(
      plan.fixtureFamilies.filter((entry) => entry.family).map((entry) => entry.family),
      baseline.dispatch.families.filter(
        (f) => f !== "preparation" || selection.prerequisites.includes("owned-fixture"),
      ),
    );
    assert(Object.isFrozen(plan));
    assert(Object.isFrozen(plan.selection.selected_scenarios));
    if (row.platform === process.platform) {
      const actual = buildDesktopVerifyPlan({
        selection,
        paths: { output_root: "<output>", target_directory: "<target>" },
        drivers: null,
        source: { revision: "<source>" },
        packages: [],
      });
      const expected = structuredClone(row.serialized_verify_plan);
      expected.harness_deadline_ms = desktopHarnessDeadlineMs(selection); // Deliberately retained pre-change deadline owner.
      // This prerequisite now runs before lease/build; preserve the old oracle.
      delete actual.frontend_command;
      expected.phases = [
        "workspace-package-preflight",
        "frontend-command-preflight",
        "desktop-doctor",
        ...expected.phases.filter(
          (phase) => !["workspace-package-preflight", "desktop-doctor"].includes(phase),
        ),
      ];
      assert.deepEqual(historicalSelection(actual), expected);
    }
  }
});

test("library browsing receipts bind every confirmation helper exactly once", () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({
      scenarios: ["native-library-browsing-context"],
      platform: "win32",
    }),
  );
  for (const name of [
    "desktop-native-confirmation.mjs",
    "native-confirmation.ps1",
    "native-window-discovery.ps1",
  ])
    assert.equal(
      plan.receiptInputs.filter((input) => input.path === `apps/desktop/scripts/${name}`).length,
      1,
    );
  for (const row of baseline.rows.filter((row) => !row.selection_error)) {
    const inputs = planDesktopExecution(
      resolveDesktopSelection({ ...row.options, platform: row.platform }),
    ).receiptInputs;
    if (inputs.some((input) => input.path === "apps/desktop/scripts/native-confirmation.ps1"))
      assert.equal(
        inputs.filter((input) => input.path === "apps/desktop/scripts/native-window-discovery.ps1")
          .length,
        1,
      );
  }
});

test("setup-only requirements and membership belong to the execution plan", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
    platform: "win32",
  });
  assert(selection.setup_scenarios.length > 0);
  const plan = planDesktopExecution(selection);
  assert.equal(plan.fixtures.owned, true);
  const preparation = plan.fixtureFamilies.find((e) => e.family === "preparation");
  for (const id of selection.setup_scenarios)
    assert(preparation.members.some((m) => m.id === id && m.role === "setup"));
  const copy = structuredClone(selection);
  planDesktopExecution(selection);
  assert.deepEqual(selection, copy);
});

test("selected setup completion requires identity-bound positive exit evidence", () => {
  const completion = planDesktopExecution(
    resolveDesktopSelection({ scenarios: ["native-selected-setup-completion"], platform: "win32" }),
  );
  assert.equal(completion.session.identityBoundSession, true);
  assert.equal(completion.session.cleanupName, "selected-setup-completion");
  assert.equal(desktopHarnessDeadlineMs(completion.selection), 180000);
  const discovery = planDesktopExecution(
    resolveDesktopSelection({
      scenarios: ["native-saved-folder-selected-setup"],
      platform: "win32",
    }),
  );
  assert.equal(discovery.session.identityBoundSession, false);
});

test("preliminary review is isolated and retains positive cleanup without setup execution", () => {
  const id = "native-preliminary-source-review";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.fixtures.preliminaryJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.deepEqual(plan.build.cliFeatures, ["portcove-core/qualification-fixtures"]);
  assert.deepEqual(plan.build.qualificationFeatures, ["qualification-fixtures"]);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "preliminary-source-review");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  assert.equal(
    plan.receiptInputs.filter((input) => input.path?.endsWith("desktop-source-dialog-test.mjs"))
      .length,
    1,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "win32" }),
    /standalone/,
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }), /Windows/);
});

test("game-update review binds Windows cleanup without first-play or wider deadlines", () => {
  for (const platform of ["win32", "linux"]) {
    const selection = resolveDesktopSelection({
      scenarios: ["native-game-update-review"],
      platform,
    });
    const plan = planDesktopExecution(selection, { platform });
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(
      plan.session.cleanupName,
      platform === "win32" ? "game-update-review" : "backup-focus",
    );
    assert.deepEqual(selection.setup_scenarios, []);
    assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  }
});

test("backup review requires identity-bound Windows cleanup under the existing deadline", () => {
  for (const platform of ["win32", "linux"]) {
    const selection = resolveDesktopSelection({
      scenarios: ["native-reviewed-backup-restore-and-delete"],
      platform,
    });
    const plan = planDesktopExecution(selection, { platform });
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(plan.session.cleanupName, platform === "win32" ? "backup-review" : "backup-focus");
    assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  }
});

test("qualified reviews and a running setup restart reject missing or foreign native identities", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function validateBackupFocusInventory(");
  const end = source.indexOf("function captureBackupFocusCleanup(", start);
  assert(start >= 0 && end > start);
  for (const { scenario, outcome = "passed", requireQualified = false } of [
    { scenario: "native-reviewed-backup-restore-and-delete" },
    { scenario: "native-preliminary-source-review" },
    { scenario: "native-selected-setup-completion", outcome: "running", requireQualified: true },
  ]) {
    const validate = runInNewContext(`${source.slice(start, end)}; validateBackupFocusInventory`, {
      assert,
      path,
      savedLibraryRecoverySession: false,
      checks: [{ scenario, outcome }],
      values: { app: "/owned/app.exe", "native-driver": "/owned/driver.exe" },
    });
    const entries = [
      { path: "/owned/app.exe" },
      { path: "/owned/driver.exe" },
      { path: "/owned/msedgewebview2.exe" },
    ];
    validate({ processes: entries }, requireQualified);
    for (let missing = 0; missing < entries.length; missing++) {
      assert.throws(() =>
        validate({ processes: entries.filter((_, i) => i !== missing) }, requireQualified),
      );
    }
    assert.throws(() =>
      validate(
        { processes: [{ path: "/foreign/app.exe" }, ...entries.slice(1)] },
        requireQualified,
      ),
    );
  }
});

test("retained rollback repair requires identity-bound cleanup without changing its deadline", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-retained-contract-repair-state"],
    platform: "win32",
  });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "retained-contract-repair");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
});

test("retained rollback Linux coverage keeps its existing portable session", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-retained-contract-repair-state"],
    platform: "linux",
  });
  const plan = planDesktopExecution(selection, { platform: "linux" });
  assert.deepEqual(selection.selected_scenarios, ["native-retained-contract-repair-state"]);
  assert.equal(plan.session.identityBoundSession, false);
  assert.equal(plan.session.cleanupName, "backup-focus");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
});

test("coordinator consumes supplied order and obtains browser at each invocation", async () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({ profile: "full", platform: "win32" }),
  );
  const trace = ["workspaceRefreshScenario", "qualificationHistoryScenario"];
  let browser = "first";
  let confirmationCalls = 0;
  const context = {
    invoke() {},
    scenario() {},
    library: "library",
    output: "output",
    artifacts: [],
    inputs: [],
    installFixture: {},
    restartApplication() {},
    cli: "cli",
    tool: "tool",
    interruptApplication() {},
    closeApplication() {},
    captureLivePreparation() {},
    chooseGameFileFolder() {},
  };
  const runtime = {
    context: () => ({ ...context, browser }),
    recordKnownGap: (gap) => trace.push("gap:" + gap.scenario),
    confirmNative: () => {
      confirmationCalls++;
      return () => {};
    },
  };
  const journeys = {
    install: async (c) => {
      assert.equal(c.browser, "first");
      trace.push("install");
      browser = "replacement";
    },
    selectedSetup: async (c) => {
      assert.equal(c.browser, "replacement");
      trace.push("selected-setup");
    },
    selectedSetupCompletion: async (c) => {
      assert.equal(c.browser, "replacement");
      assert.equal(c.restartApplication, context.restartApplication);
      assert.equal(c.chooseGameFileFolder, context.chooseGameFileFolder);
      trace.push("selected-setup-completion");
    },
    preparation: async (c) => {
      assert.equal(c.browser, "replacement");
      assert.equal(c.cli, "cli");
      assert.equal(c.tool, "tool");
      trace.push("preparation");
    },
  };
  await runOwnedFixtureJourneys({ plan, runtime }, journeys);
  trace.push("native-repeated-library-reload");
  assert.deepEqual(trace, [
    baseline.dispatch.before.split(" then ")[0],
    baseline.dispatch.before.split(" then ")[1],
    ...baseline.dispatch.families,
    baseline.dispatch.after,
  ]);
  assert.equal(confirmationCalls, 1);
  // A supplied order must be consumed verbatim, never recreated from selection.
  const reversed = { fixtureFamilies: [...plan.fixtureFamilies].reverse() };
  const reversedTrace = [];
  const handlers = Object.fromEntries(
    Object.keys(journeys).map((name) => [name, async () => reversedTrace.push(name)]),
  );
  await runOwnedFixtureJourneys({ plan: reversed, runtime }, handlers);
  assert.deepEqual(reversedTrace, [
    "preparation",
    "selectedSetupCompletion",
    "selectedSetup",
    "install",
  ]);
});

test("coordinator preserves gap position and leaves attempt attribution to its caller", async () => {
  const selection = resolveDesktopSelection({ scenarios: ["empty-library"], platform: "win32" });
  const plan = planDesktopExecution(selection);
  const calls = [];
  const runtime = {
    context: () => ({ scenario: (id, action) => calls.push({ id, action }) }),
    confirmNative: () => assert.fail("No preparation consent"),
    recordKnownGap: (gap) => calls.push(gap),
  };
  const journeys = {
    install: async (c) =>
      c.scenario("install-progress-cancellation", () =>
        assert.fail("Attempt owner must gate this"),
      ),
    selectedSetup: async () => {},
    selectedSetupCompletion: async () => {},
    preparation: async () => assert.fail("No owned prerequisite"),
  };
  await runOwnedFixtureJourneys({ plan, runtime }, journeys);
  assert.equal(calls[0].id, "install-progress-cancellation");
  await assert.rejects(
    runOwnedFixtureJourneys(
      { plan: { fixtureFamilies: [{ family: "unknown" }] }, runtime },
      journeys,
    ),
    /Unknown owned fixture family/,
  );
});

test("harness hashes preserved inputs and the current planner/coordinator bytes", async (t) => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const inputs = await captureDesktopReceiptInputs");
  const end = source.indexOf("let runnerMetadata = {}");
  assert(start > 0 && end > start);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const selection = resolveDesktopSelection({ profile: "smoke", platform: process.platform });
  const values = Object.fromEntries(
    Object.keys(executableNames).map((name) => [name, process.execPath]),
  );
  const output = await mkdtemp(path.join(os.tmpdir(), "pcv-harness-inputs-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const inputs = await runInNewContext(`(async()=>{${source.slice(start, end)}return inputs})()`, {
    selection,
    planDesktopExecution,
    values,
    root,
    path,
    port: 4455,
    fileIdentity,
    Promise,
    executionPlan: planDesktopExecution(selection),
    captureDesktopReceiptInputs,
    output,
    revision: "a".repeat(40),
  });
  const expectedFiles = planDesktopExecution(selection).receiptInputs.map((input) =>
    input.kind === "executable" ? process.execPath : path.join(root, input.path),
  );
  expectedFiles.push(
    ...[
      "scripts/desktop-execution-plan.mjs",
      "apps/desktop/scripts/desktop-owned-fixture-journeys.mjs",
      "apps/desktop/scripts/desktop-owned-ipc-probe.mjs",
    ].map((file) => path.join(root, file)),
  );
  assert.equal(inputs.length, expectedFiles.length);
  for (const [index, file] of expectedFiles.entries())
    assert.deepEqual(inputs[index], await fileIdentity(file));
});

test("preliminary selected setup is standalone, identity-bound and excluded from historical runs", () => {
  const id = "native-preliminary-selected-setup";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.fixtures.preliminaryJourney, true);
  assert.equal(plan.fixtures.preliminarySetupJourney, true);
  assert.equal(plan.fixtures.sourceJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "preliminary-selected-setup");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  assert.equal(
    plan.receiptInputs.filter((input) => input.path?.endsWith("desktop-source-dialog-test.mjs"))
      .length,
    1,
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }), /Windows/);
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: [id, "native-preliminary-source-review"],
        platform: "win32",
      }),
    /standalone/,
  );
});
