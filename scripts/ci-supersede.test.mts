import assert from "node:assert/strict";
import test from "node:test";
import { ownRunId, supersededRunIds } from "./ci-supersede.mts";

const run = (id: number, ...pulls: number[]) => ({
  id,
  pull_requests: pulls.map((number) => ({ number })),
});

void test("a head's own run is its newest run for the pull request", () => {
  const listing = { workflow_runs: [run(5, 7), run(9, 8), run(8, 7)] };
  assert.equal(ownRunId(listing, 7), 8);
  assert.equal(ownRunId(listing, 99), undefined);
});

void test("only older runs of the same pull request are superseded", () => {
  const queued = { workflow_runs: [run(3, 7), run(10, 7), run(4, 8)] };
  const active = { workflow_runs: [run(3, 7), run(6, 7), run(8, 7)] };
  assert.deepEqual(supersededRunIds([queued, active], 8, 7), [3, 6]);
});

void test("malformed run listings are refused", () => {
  assert.throws(() => ownRunId({}, 1), /malformed/u);
  assert.throws(() => supersededRunIds([{ workflow_runs: [{ id: "x" }] }], 2, 1), /identity/u);
});
