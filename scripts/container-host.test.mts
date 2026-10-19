import assert from "node:assert/strict";
import test from "node:test";
import { containerFailure } from "./container-host.mts";

void test("container adapters preserve the causal command exit and diagnostic evidence", () => {
  const failure = {
    message: "container failed",
    observations: [{ phase: "build" }],
    observation: { status: "failed" },
    state: { causal_exit: 17 },
  };
  assert.deepEqual(containerFailure(failure), {
    report: {
      error: failure.message,
      observations: failure.observations,
      observation: failure.observation,
    },
    exitCode: 17,
  });
  assert.equal(containerFailure(new Error("failed")).report.error, "failed");
});

void test("container adapter failures cannot turn a missing or zero causal status into success", () => {
  for (const failure of [
    null,
    "failed",
    {},
    { state: null },
    { state: { causal_exit: 0 } },
    { state: { causal_exit: "17" } },
  ]) {
    assert.equal(containerFailure(failure).exitCode, 1);
  }
});
