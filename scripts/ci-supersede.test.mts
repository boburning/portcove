import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ownRunId, supersededRunIds } from "./ci-supersede.mts";

const run = (id: number, ...pulls: number[]) => ({
  id,
  pull_requests: pulls.map((number) => ({ number })),
});

void test("a head's own run is its newest run for the pull request", () => {
  const listing = { workflow_runs: [run(5, 7), run(9, 8), run(8, 7)] };
  assert.equal(ownRunId(listing, { number: 7 }), 8);
  assert.equal(ownRunId(listing, { number: 99 }), undefined);
});

void test("only older runs of the same pull request are superseded", () => {
  const queued = { workflow_runs: [run(3, 7), run(10, 7), run(4, 8)] };
  const active = { workflow_runs: [run(3, 7), run(6, 7), run(8, 7)] };
  assert.deepEqual(supersededRunIds([queued, active], 8, { number: 7 }), [3, 6]);
});

void test("malformed run listings are refused", () => {
  assert.throws(() => ownRunId({}, { number: 1 }), /malformed/u);
  assert.throws(
    () => supersededRunIds([{ workflow_runs: [{ id: "x" }] }], 2, { number: 1 }),
    /identity/u,
  );
});

void test("the workflow installs the locked dependencies its script imports before running it", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci-supersede.yml", import.meta.url),
    "utf8",
  );
  const install = workflow.indexOf("pnpm install --filter portcove-repository --frozen-lockfile");
  const run = workflow.indexOf("node scripts/ci-supersede.mts");
  assert.ok(
    install > 0,
    "the workflow must install dependencies (the script imports the GitHub client)",
  );
  assert.ok(run > install, "dependencies must be installed before the script runs");
  assert.match(workflow, /--ignore-scripts/u);
  assert.match(workflow, /--ignore-pnpmfile/u);
});

void test("runs GitHub left without pull_requests match by head branch and repository", () => {
  const bare = (id: number, branch: string, repository: string) => ({
    id,
    head_branch: branch,
    head_repository: { full_name: repository },
    pull_requests: [],
  });
  const pull = { number: 7, headRef: "feature/x", headRepository: "owner/repo" };
  const listing = {
    workflow_runs: [
      bare(3, "feature/x", "owner/repo"),
      bare(5, "feature/x", "fork/repo"),
      bare(6, "other", "owner/repo"),
      bare(9, "feature/x", "owner/repo"),
    ],
  };
  assert.equal(ownRunId(listing, pull), 9);
  assert.deepEqual(supersededRunIds([listing], 9, pull), [3]);
  // Without the head identity the fallback is off, so nothing is guessed.
  assert.equal(ownRunId(listing, { number: 7 }), undefined);
  // A run that names a different pull request never matches by branch.
  const named = {
    workflow_runs: [{ ...bare(4, "feature/x", "owner/repo"), pull_requests: [{ number: 99 }] }],
  };
  assert.deepEqual(supersededRunIds([named], 9, pull), []);
});
