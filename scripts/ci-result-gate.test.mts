import type { CiResultInputs } from "./ci-result-gate.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { evaluateCiResults, formatResultGateFailure } from "./ci-result-gate.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";
import { buildValidationPlan } from "./validation-plan.mts";

const sha = (character: string) => character.repeat(40);
const changed = (path: string) => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  oldPath: path,
  newPath: path,
});
const plan = (path: string) =>
  buildValidationPlan({
    changes: [changed(path)],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
const evaluate = (overrides: Partial<CiResultInputs> = {}) =>
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

void test("beta Rust qualification skips only the inapplicable Intel jobs and requires every Windows/Linux producer", () => {
  const beta = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: sha("d"),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  });
  const results = {
    rust_tests: "success",
    rust_workspace_tests: "success",
    rust_clippy: "success",
    windows_storage: "success",
    native_rust: "success",
    rust_docs: "success",
    intel_build: "skipped",
    intel_tests: "skipped",
  };
  const check = (qualification: Record<string, string>, selectedPlan = beta) =>
    evaluate({
      group: "rust",
      plan: selectedPlan,
      fast: { fast_rust: "skipped" },
      qualification,
    });
  assert.match(check(results), /Accepted qualification/);
  for (const name of Object.keys(results)) {
    assert.throws(() => check({ ...results, [name]: "failure" }));
    const omitted = { ...results };
    delete omitted[name as keyof typeof omitted];
    assert.throws(() => check(omitted), /every applicable/);
    assert.throws(() =>
      check({ ...results, [name]: name.startsWith("intel_") ? "success" : "skipped" }),
    );
  }
  assert.throws(() => check({ ...results, foreign: "success" }), /every applicable/);
  const full = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  assert.throws(() => check(results, full), /expected success/);
  for (const group of ["catalog", "dependency-review", "frontend", "rust-quality"])
    assert.throws(
      () =>
        evaluate({
          group,
          plan: beta,
          fast: { fast_group: "skipped" },
          qualification: { producer: "skipped" },
        }),
      /expected success/,
    );
});

void test("dependent aggregates name the failed producer without changing acceptance or asserting its cause", () => {
  for (const result of ["failure", "timed_out", "cancelled", "startup_failure"])
    assert.throws(
      () => evaluate({ fast: { fast_frontend: result } }),
      (error) => {
        assert.match(
          formatResultGateFailure(error),
          new RegExp(`Dependent aggregate failure: producer fast_frontend was ${result}`),
        );
        assert.match(formatResultGateFailure(error), /cause unknown\/unclassified/);
        assert(error instanceof Error);
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

void test("real aggregate CLI preserves failed exit and names its producer", () => {
  const result = spawnSync(process.execPath, ["scripts/ci-result-gate.mts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PORTCOVE_PLAN_GZIP_BASE64: undefined,
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

void test("the prose producer is identified only where success was required", () => {
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

void test("fast plans require only selected fast group work", () => {
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

void test("qualification plans require qualification and reject fast execution", () => {
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

void test("ordinary native changes use the Windows lane without secondary producers", () => {
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

void test("prose plans require prose and skip every product lane", () => {
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

void test("failed cancelled timed-out missing or unexpected results fail closed", () => {
  for (const result of ["failure", "cancelled", "timed_out", "", "skipped"])
    assert.throws(() => evaluate({ fast: { fast_frontend: result } }), /expected success/u);
  assert.throws(() => evaluate({ classifier: "failure" }), /classifier result/u);
  assert.throws(() => evaluate({ always: { provenance: "failure" } }), /every plan/u);
  assert.throws(() => evaluate({ fast: {} }), /plan is empty/u);
});

void test("stale plan content and protected-group omissions are rejected", () => {
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

void test("malformed lane result JSON cannot authorize an aggregate", () => {
  for (const malformed of [[], "success", { producer: null }, { producer: true }]) {
    assert.throws(() => evaluate({ fast: malformed }), /job-result map/u);
    assert.throws(() => evaluate({ qualification: malformed }), /job-result map/u);
    assert.throws(() => evaluate({ targeted: malformed }), /job-result map/u);
    assert.throws(() => evaluate({ always: malformed }), /job-result map/u);
  }
  assert.throws(() => evaluate({ reuse: false }), /postmerge reuse binding/u);
});
