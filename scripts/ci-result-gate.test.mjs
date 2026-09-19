import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCiResults } from "./ci-result-gate.mjs";
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
  const qualificationPlan = plan(".github/workflows/ci.yml");
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

test("affected-platform fast plans require their exact native producer", () => {
  const platformPlan = plan("apps/desktop/src-tauri/src/window_windows.rs");
  assert.match(
    evaluate({
      plan: platformPlan,
      group: "rust",
      fast: { fast_rust: "success" },
      targeted: { fast_platform: "success" },
      qualification: { rust_full: "skipped" },
    }),
    /Accepted fast/u,
  );
  assert.throws(
    () =>
      evaluate({
        plan: platformPlan,
        group: "rust",
        fast: { fast_rust: "success" },
        targeted: { fast_platform: "cancelled" },
        qualification: { rust_full: "skipped" },
      }),
    /expected success/u,
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
  const qualificationPlan = plan(".github/workflows/ci.yml");
  qualificationPlan.groups = qualificationPlan.groups.filter((group) => group !== "frontend");
  assert.throws(() => evaluate({ plan: qualificationPlan }), /digest|omitted/u);
});
