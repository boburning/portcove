import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopSelection, desktopHarnessDeadlineMs } from "./desktop-scenarios.mts";
import { planDesktopExecution } from "./desktop-execution-plan.mts";
import { classifyChanges } from "./ordinary-validation.mts";
import { ordinaryOwnershipForPath } from "./validation-plan.mts";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";

const id = "native-registered-source-reuse";
const helper = "apps/desktop/scripts/desktop-source-reuse-test.mts";

void test("real source reuse requires standalone Windows with normal production features", () => {
  const selection = resolveDesktopSelection({ platform: "win32", scenarios: [id] });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.ok(selection.prerequisites.includes("native-dialog"));
  assert.equal(selection.prerequisites.includes("install-fixture"), false);
  assert.equal(plan.session.identityBoundSession, true);
  assert.deepEqual(plan.build.cliFeatures, []);
  assert.deepEqual(plan.build.qualificationFeatures, []);
  assert.equal(plan.receiptInputs.filter((input) => input.path === helper).length, 1);
  assert.equal(desktopHarnessDeadlineMs(selection), 1_200_000);
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(() => resolveDesktopSelection({ platform, scenarios: [id] }));
  assert.throws(() => resolveDesktopSelection({ platform: "win32", scenarios: [id, "startup"] }));
  assert.equal(
    resolveDesktopSelection({ platform: "win32", profile: "full" }).selected_scenarios.includes(id),
    false,
  );
});

void test("source reuse helper changes retain maintained native and focused validation ownership", () => {
  assert.equal(ordinaryOwnershipForPath(helper).unknown, false);
  for (const change of [
    { status: "M", path: helper },
    { status: "A", path: helper },
    { status: "D", path: helper },
    { status: "R100", path: "docs/moved.md", previousPath: helper },
    { status: "R100", path: helper, previousPath: "docs/moved.md" },
  ]) {
    const selected = classifyChanges([change]);
    assert.ok(selected.nodeTests.has("scripts/desktop-source-reuse.test.mts"));
    assert.ok(selected.nodeTests.has("scripts/desktop-boundary-wiring.test.mts"));
    assert.equal(selected.unknown.has(helper), false);
  }
});

void test("a failed real setup retains its route and failure stage before any native mutation", () => {
  runDesktopModuleFixture(
    new URL(`../${helper}`, import.meta.url),
    `
    const {installRegisteredSourceAndPlay} = await import(entry);
    const report = {routes: []};
    const failure = new Error('controlled review read failure');
    await assert.rejects(() => installRegisteredSourceAndPlay({
      browser: {
        findElements: async () => assert.fail('Alternative must await its pending review'),
        wait: async () => {throw failure},
      },
      output: 'unused-output', artifacts: [], cli: 'unused-cli', library: 'unused-library',
    }, {id: 'zelda64-recomp'}, {}, report, 'alternative'), /controlled review read failure/);
    assert.equal(report.routes.length, 1);
    assert.equal(report.routes[0].port_id, 'zelda64-recomp');
    assert.equal(report.routes[0].stage, 'review');
    assert.match(report.routes[0].failure.message, /controlled review read failure/);
  `,
  );
});
