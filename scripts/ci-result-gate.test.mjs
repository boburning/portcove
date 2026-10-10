import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { evaluateCiResults, formatResultGateFailure } from "./ci-result-gate.mjs";
import { discoverCiPlan } from "./select-ci-plan.mjs";
import { buildValidationPlan } from "./validation-plan.mjs";

const sha = (character) => character.repeat(40);
const changed = (path) => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  oldPath: path,
  newPath: path,
});
const plan = (path) =>
  buildValidationPlan({
    changes: [changed(path)],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
const evaluate = (overrides = {}) =>
  evaluateCiResults({
    classifier: "success",
    plan: plan("apps/desktop/src/App.tsx"),
    group: "frontend",
    prose: "skipped",
    fast: { fast_frontend: "success" },
    targeted: { fast_platform: "skipped" },
    qualification: { frontend_full: "skipped" },
    ...overrides,
  });

test("dependent aggregates name the failed producer without changing acceptance or asserting its cause", () => {
  for (const result of ["failure", "timed_out", "cancelled", "startup_failure"])
    assert.throws(
      () => evaluate({ fast: { fast_frontend: result } }),
      (error) => {
        assert.match(
          formatResultGateFailure(error),
          new RegExp(`Dependent aggregate failure: producer fast_frontend was ${result}`),
        );
        assert.match(formatResultGateFailure(error), /cause unknown\/unclassified/);
        assert.match(error.message, /expected success/);
        return true;
      },
    );
  assert.throws(
    () => evaluate({ fast: { fast_frontend: "skipped" } }),
    (error) => {
      assert.match(formatResultGateFailure(error), /Aggregate contract failure/);
      assert.doesNotMatch(formatResultGateFailure(error), /Dependent aggregate/);
      return true;
    },
  );
});

test("real aggregate CLI preserves failed exit and names its producer", () => {
  const result = spawnSync(process.execPath, ["scripts/ci-result-gate.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PORTCOVE_PLAN_JSON: JSON.stringify(plan("apps/desktop/src/App.tsx")),
      PORTCOVE_FAST_RESULTS: JSON.stringify({ fast_frontend: "failure" }),
      PORTCOVE_TARGETED_RESULTS: "{}",
      PORTCOVE_QUALIFICATION_RESULTS: JSON.stringify({ frontend_full: "skipped" }),
      PORTCOVE_ALWAYS_RESULTS: "{}",
      PORTCOVE_CLASSIFIER_RESULT: "success",
      PORTCOVE_GROUP: "frontend",
      PORTCOVE_PROSE_RESULT: "skipped",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependent aggregate failure: producer fast_frontend/);
  assert.match(result.stderr, /expected success/);
  assert.equal(result.stdout, "");
});

test("the prose producer is identified only where success was required", () => {
  assert.throws(
    () => evaluate({ plan: plan("docs/README.md"), group: "catalog", prose: "failure" }),
    (error) => {
      assert.match(formatResultGateFailure(error), /Dependent aggregate failure: producer prose/);
      return true;
    },
  );
  assert.throws(
    () => evaluate({ prose: "failure" }),
    (error) => {
      assert.match(formatResultGateFailure(error), /Aggregate contract failure/);
      return true;
    },
  );
});

test("fast plans require only selected fast group work", () => {
  assert.match(evaluate(), /Accepted fast/u);
  assert.match(
    evaluate({
      group: "rust",
      fast: { fast_rust: "skipped" },
      qualification: { rust_full: "skipped" },
    }),
    /Accepted fast/u,
  );
});

test("qualification plans require qualification and reject fast execution", () => {
  const qualificationPlan = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  assert.match(
    evaluate({
      plan: qualificationPlan,
      fast: { fast_frontend: "skipped" },
      qualification: { frontend_full: "success" },
    }),
    /Accepted qualification/u,
  );
  assert.throws(
    () =>
      evaluate({
        plan: qualificationPlan,
        fast: { fast_frontend: "success" },
        qualification: { frontend_full: "success" },
      }),
    /expected skipped/u,
  );
});

test("ordinary native changes use the Windows lane without secondary producers", () => {
  const platformPlan = plan("apps/desktop/src-tauri/src/window_windows.rs");
  const inputs = {
    plan: platformPlan,
    group: "rust",
    fast: { fast_rust: "success" },
    targeted: {},
    qualification: { rust_full: "skipped" },
  };
  assert.match(evaluate(inputs), /Accepted fast/u);
  assert.throws(() => evaluate({ ...inputs, fast: { fast_rust: "skipped" } }), /expected success/u);
  assert.throws(
    () => evaluate({ ...inputs, targeted: { obsolete_platform: "success" } }),
    /expected skipped/u,
  );
});

test("prose plans require prose and skip every product lane", () => {
  const prosePlan = plan("docs/README.md");
  assert.match(
    evaluate({
      plan: prosePlan,
      group: "catalog",
      prose: "success",
      fast: { fast_catalog: "skipped" },
      qualification: { catalog_full: "skipped" },
    }),
    /Accepted prose/u,
  );
});

test("failed cancelled timed-out missing or unexpected results fail closed", () => {
  for (const result of ["failure", "cancelled", "timed_out", "", "skipped"])
    assert.throws(() => evaluate({ fast: { fast_frontend: result } }), /expected success/u);
  assert.throws(() => evaluate({ classifier: "failure" }), /classifier result/u);
  assert.throws(() => evaluate({ always: { provenance: "failure" } }), /every plan/u);
  assert.throws(() => evaluate({ fast: {} }), /plan is empty/u);
});

test("stale plan content and protected-group omissions are rejected", () => {
  const stale = { ...plan("apps/desktop/src/App.tsx"), reason: "substituted" };
  assert.throws(() => evaluate({ plan: stale }), /digest/u);
  assert.throws(() => evaluate({ group: "unknown" }), /protected group/u);
  const qualificationPlan = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  qualificationPlan.groups = qualificationPlan.groups.filter((group) => group !== "frontend");
  assert.throws(() => evaluate({ plan: qualificationPlan }), /digest|omitted/u);
});
