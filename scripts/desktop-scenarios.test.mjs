import assert from "node:assert/strict";
import test from "node:test";
import { steamEntryScenario } from "../apps/desktop/scripts/desktop-steam-entry-test.mjs";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  DESKTOP_PROFILES,
  DESKTOP_SCENARIOS,
  resolveDesktopSelection,
} from "./desktop-scenarios.mjs";

test("desktop scenario catalog is nonempty, unique, and fully profiled", () => {
  assert.ok(DESKTOP_SCENARIOS.length > 0);
  assert.equal(new Set(DESKTOP_SCENARIOS.map((item) => item.id)).size, DESKTOP_SCENARIOS.length);
  for (const [profile, ids] of Object.entries(DESKTOP_PROFILES)) {
    assert.ok(ids.length > 0, profile);
    assert.equal(new Set(ids).size, ids.length, profile);
    for (const id of ids)
      assert.ok(
        DESKTOP_SCENARIOS.some((item) => item.id === id),
        `${profile}: ${id}`,
      );
  }
  for (const item of catalogReport()) {
    if (item.id === "native-repeated-library-reload" || item.qualification_only) continue;
    assert.ok(item.profiles.length > 0, item.id);
    for (const dependency of item.dependencies) {
      const dependencyIndex = DESKTOP_SCENARIOS.findIndex(
        (candidate) => candidate.id === dependency,
      );
      const itemIndex = DESKTOP_SCENARIOS.findIndex((candidate) => candidate.id === item.id);
      assert.ok(dependencyIndex >= 0, `${item.id}: missing dependency ${dependency}`);
      assert.ok(dependencyIndex < itemIndex, `${item.id}: dependency must execute first`);
      assert.equal(DESKTOP_SCENARIOS[dependencyIndex].runnable, true, dependency);
    }
  }
});

test("smoke includes isolated install cancellation and committed-refresh recovery", () => {
  const selection = resolveDesktopSelection();
  assert.equal(selection.profile, "smoke");
  assert.ok(selection.selected_scenarios.includes("keyboard-layout"));
  assert.ok(selection.selected_scenarios.includes("install-progress-cancellation"));
  assert.ok(selection.selected_scenarios.includes("install-commit-refresh-recovery"));
  assert.ok(selection.prerequisites.includes("install-fixture"));
  assert.deepEqual(selection.known_gaps, []);
});

test("exact selections are deduplicated and returned in catalog order", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["accessibility", "keyboard-layout", "accessibility"],
  });
  assert.equal(selection.profile, null);
  assert.deepEqual(selection.selected_scenarios, ["keyboard-layout", "accessibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
});

test("design compatibility stays exact-selection-only and requests its isolated fixture", () => {
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-design-system-compatibility"));
  const selection = resolveDesktopSelection({
    scenarios: ["native-design-system-compatibility"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-design-system-compatibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("design-compatibility-fixture"));
});

test("focused lifecycle selection resolves setup without claiming it", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-installed-game-removal"]);
  assert.deepEqual(selection.setup_scenarios, [
    "native-preparation-review-and-play",
    "native-reviewed-backup-restore-and-delete",
  ]);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
});

test("fixture-only reviews select without first-play while continuity keeps its setup", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-steam-entry-add-and-remove"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-steam-entry-add-and-remove"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.prerequisites.includes("steam-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const id of ["native-game-update-review", "native-reviewed-backup-restore-and-delete"])
    assert.deepEqual(resolveDesktopSelection({ scenarios: [id] }).setup_scenarios, [], id);
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: ["native-game-return-continuity"] }).setup_scenarios,
    ["native-preparation-review-and-play"],
  );
  assert.ok(
    resolveDesktopSelection({ profile: "full" }).selected_scenarios.includes(
      "native-preparation-review-and-play",
    ),
  );
});

test("missing Steam review context fails before a scenario callback", async () => {
  let entered = false;
  await assert.rejects(
    steamEntryScenario({
      browser: {},
      invoke: async () => {},
      scenario: async () => {
        entered = true;
      },
      output: "<negative-fixture>",
      artifacts: [],
      command: () => {},
      seed: async () => {},
      confirmNative: async () => {},
    }),
    /Steam review scenario requires context\.open/,
  );
  assert.equal(entered, false);
});

test("selection rejects ambiguity, unknown IDs, and invalid reload requests", () => {
  assert.throws(
    () => resolveDesktopSelection({ profile: "smoke", scenarios: ["accessibility"] }),
    /cannot be combined/,
  );
  assert.throws(() => resolveDesktopSelection({ profile: "unknown" }), /Unknown desktop profile/);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["missing"] }),
    /Unknown desktop scenario/,
  );
  const install = resolveDesktopSelection({ scenarios: ["install-progress-cancellation"] });
  assert.deepEqual(install.selected_scenarios, ["install-progress-cancellation"]);
  assert.ok(install.prerequisites.includes("install-fixture"));
  const refresh = resolveDesktopSelection({ scenarios: ["install-commit-refresh-recovery"] });
  assert.deepEqual(refresh.selected_scenarios, ["install-commit-refresh-recovery"]);
  assert.deepEqual(refresh.setup_scenarios, []);
  assert.ok(refresh.prerequisites.includes("install-fixture"));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["native-repeated-library-reload"] }),
    /requires --reload-cycles/,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["accessibility"], reloadCycles: 2 }),
    /requires --scenario/,
  );
});

test("reload is opt-in for restart and full profiles", () => {
  assert.ok(
    !resolveDesktopSelection({ profile: "restart" }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
  assert.ok(
    resolveDesktopSelection({ profile: "restart", reloadCycles: 3 }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
});

test("large lifecycle profiles receive a bounded profile-scale watchdog", () => {
  assert.equal(
    desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "presentation" })),
    180_000,
  );
  assert.equal(desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "full" })), 600_000);
});
