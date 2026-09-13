import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCiResults } from "./ci-result-gate.mjs";

const evaluate = (overrides = {}) =>
  evaluateCiResults({
    classifier: "success",
    mode: "full",
    prose: "skipped",
    required: { first: "success", second: "success" },
    ...overrides,
  });

test("full and prose plans accept only their exact expected lane results", () => {
  assert.match(evaluate(), /Accepted full/u);
  assert.match(
    evaluate({ mode: "prose", prose: "success", required: { first: "skipped" } }),
    /Accepted prose/u,
  );
});

test("failed cancelled timed-out missing or unexpectedly skipped full work fails", () => {
  for (const result of ["failure", "cancelled", "timed_out", "", "skipped"])
    assert.throws(() => evaluate({ required: { lane: result } }), /expected success/u);
});

test("classifier failures missing outputs and unexpected prose execution fail", () => {
  assert.throws(() => evaluate({ classifier: "failure" }), /classifier result/u);
  assert.throws(() => evaluate({ mode: "" }), /classifier mode/u);
  assert.throws(() => evaluate({ prose: "success" }), /expected skipped/u);
  assert.throws(() => evaluate({ required: {} }), /plan is empty/u);
});

test("prose mode requires its checks and rejects missing or unexpectedly executed native lanes", () => {
  for (const prose of ["failure", "cancelled", "skipped", ""])
    assert.throws(
      () => evaluate({ mode: "prose", prose, required: { lane: "skipped" } }),
      /prose lane/u,
    );
  for (const result of ["success", "failure", "cancelled", ""])
    assert.throws(
      () => evaluate({ mode: "prose", prose: "success", required: { lane: result } }),
      /expected skipped/u,
    );
});
