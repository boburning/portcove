import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("execution planning preserves the independently reviewed pre-change oracle", () => {
  assert.equal(baseline.starting_main, "a9e3db4e6cd9fd41111b58705e4fa54790eb57d7");
  assert.equal(baseline.rows.length, 222);
  for (const row of baseline.rows) {
    if (row.selection_error) {
      assert.throws(() => resolveDesktopSelection({ ...row.options, platform: row.platform }), {
        message: row.selection_error,
      });
      continue;
    }
    const selection = resolveDesktopSelection({ ...row.options, platform: row.platform });
    assert.deepEqual(selection, row.selection);
    const plan = planDesktopExecution(selection);
    assert.deepEqual(plan.selection, row.selection);
    assert.deepEqual(
      plan.receiptInputs
        .filter((input) => {
          if (input.path === "apps/desktop/scripts/native-window-discovery.ps1") return false;
          // Keep the historical oracle immutable; only these explicit missing
          // browsing-helper receipts supplement it, without changing execution.
          return (
            row.initial_receipt_inputs.includes(input.path) ||
            ![
              "apps/desktop/scripts/desktop-native-confirmation.mjs",
              "apps/desktop/scripts/native-confirmation.ps1",
            ].includes(input.path)
          );
        })
        .map((input) => (input.kind === "executable" ? executableNames[input.name] : input.path)),
      row.initial_receipt_inputs,
    );
    if (!row.harness_admission.error) assert.deepEqual(plan.session, row.harness_admission);
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
      assert.deepEqual(actual, expected);
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
    selectedSetupCompletion: async () => trace.push("selected-setup-completion"),
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

test("harness hashes preserved inputs and the current planner/coordinator bytes", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const executionPlan =");
  const end = source.indexOf("let runnerMetadata = {}");
  assert(start > 0 && end > start);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const selection = resolveDesktopSelection({ profile: "smoke", platform: process.platform });
  const values = Object.fromEntries(
    Object.keys(executableNames).map((name) => [name, process.execPath]),
  );
  const inputs = await runInNewContext(`(async()=>{${source.slice(start, end)}return inputs})()`, {
    selection,
    planDesktopExecution,
    values,
    root,
    path,
    port: 4455,
    fileIdentity,
    Promise,
  });
  const golden = baseline.rows.find(
    (row) => row.platform === process.platform && row.options.profile === "smoke",
  );
  assert.equal(inputs.length, golden.initial_receipt_inputs.length + 3);
  for (let i = 0; i < golden.initial_receipt_inputs.length; i++) {
    const name = golden.initial_receipt_inputs[i];
    const expected = await fileIdentity(
      Object.values(executableNames).includes(name) ? process.execPath : path.join(root, name),
    );
    assert.deepEqual(inputs[i], expected);
  }
  for (const [index, name] of [
    "scripts/desktop-execution-plan.mjs",
    "apps/desktop/scripts/desktop-owned-fixture-journeys.mjs",
    "apps/desktop/scripts/desktop-owned-ipc-probe.mjs",
  ].entries())
    assert.deepEqual(
      inputs[golden.initial_receipt_inputs.length + index],
      await fileIdentity(path.join(root, name)),
    );
});
