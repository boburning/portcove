import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  deferralMarkerStep,
  deferredWindowsRun,
  ownRunId,
  readyForReviewAction,
  supersededRunIds,
} from "./ci-supersede.mts";
import { workflowStep } from "./ci-workflow-fixture.mts";

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

void test("only a run that deferred its Windows partitions for a draft is re-run", () => {
  const job = (name: string, conclusion: string, status = "completed") => ({
    name,
    status,
    conclusion,
  });
  const partition = (conclusion: string) =>
    job("fast-rust-test (windows-x86_64, ${{ matrix.partition }})", conclusion);
  const deferred = [
    job("rust", "failure"),
    job("fast-rust-build (windows-x86_64)", "success"),
    partition("skipped"),
  ];
  assert.equal(deferredWindowsRun({ jobs: deferred }), true);
  assert.equal(
    deferredWindowsRun({ jobs: [...deferred.slice(0, 2), job("fast_rust_tests", "skipped")] }),
    true,
  );
  // A real test failure, a failed build, a passing gate or partitions that ran are not deferrals.
  assert.equal(
    deferredWindowsRun({ jobs: [...deferred.slice(0, 2), partition("failure")] }),
    false,
  );
  assert.equal(
    deferredWindowsRun({
      jobs: [deferred[0], job("fast-rust-build (windows-x86_64)", "failure"), deferred[2]],
    }),
    false,
  );
  assert.equal(deferredWindowsRun({ jobs: [job("rust", "success"), ...deferred.slice(1)] }), false);
  assert.equal(
    deferredWindowsRun({ jobs: [job("rust", "failure", "in_progress"), ...deferred.slice(1)] }),
    false,
  );
  assert.equal(deferredWindowsRun({ jobs: deferred.slice(0, 2) }), false);
  assert.equal(deferredWindowsRun({ jobs: [...deferred, job("rust", "failure")] }), false);
  assert.throws(() => deferredWindowsRun({}), /malformed/u);
});

void test("ready_for_review re-runs only a run that actually deferred its Windows partitions", () => {
  const job = (
    name: string,
    conclusion: string | null,
    status = "completed",
    steps?: unknown[],
  ) => ({
    name,
    status,
    conclusion,
    ...(steps ? { steps } : {}),
  });
  const marker = (conclusion: string | null, status = "completed") => ({
    name: deferralMarkerStep,
    status,
    conclusion,
  });
  const classified = (...steps: unknown[]) =>
    job("classify-ci-plan", "success", "completed", steps);
  const buildPending = job("fast-rust-build (windows-x86_64)", null, "queued");
  const partition = (conclusion: string | null, status = "completed") =>
    job("fast-rust-test (windows-x86_64, ${{ matrix.partition }})", conclusion, status);
  const active = { status: "in_progress" };
  const done = { status: "completed" };

  // An unclassified run reads the live (ready) state itself.
  assert.equal(readyForReviewAction(active, { jobs: [] }), "wait");
  assert.equal(
    readyForReviewAction(active, { jobs: [job("classify-ci-plan", null, "in_progress")] }),
    "wait",
  );
  // The marker decides at once, even while the build is pending and no partition job exists.
  assert.equal(
    readyForReviewAction(active, { jobs: [classified(marker("success")), buildPending] }),
    "cancel-and-rerun",
  );
  assert.equal(
    readyForReviewAction(active, { jobs: [classified(marker("skipped")), buildPending] }),
    "none",
  );
  assert.equal(
    readyForReviewAction(active, { jobs: [classified(marker(null, "in_progress"))] }),
    "wait",
  );
  assert.equal(
    readyForReviewAction(active, { jobs: [job("classify-ci-plan", "failure")] }),
    "none",
  );
  // Heads without the marker fall back to the job graph, conservatively while the build pends.
  assert.equal(
    readyForReviewAction(active, { jobs: [classified(), buildPending] }),
    "cancel-and-rerun",
  );
  assert.equal(
    readyForReviewAction(active, {
      jobs: [
        classified(),
        job("fast-rust-build (windows-x86_64)", "success"),
        partition("skipped"),
      ],
    }),
    "cancel-and-rerun",
  );
  for (const jobs of [
    // Non-Rust plan: the build is skipped.
    [classified(), job("fast-rust-build (windows-x86_64)", "skipped"), partition("skipped")],
    // Partitions running, or skipped because the build failed.
    [
      classified(),
      job("fast-rust-build (windows-x86_64)", "success"),
      partition(null, "in_progress"),
    ],
    [classified(), job("fast-rust-build (windows-x86_64)", "failure"), partition("skipped")],
  ])
    assert.equal(readyForReviewAction(active, { jobs }), "none");
  // A completed run follows the job-outcome detector.
  assert.equal(
    readyForReviewAction(done, {
      jobs: [
        classified(marker("success")),
        job("rust", "failure"),
        job("fast-rust-build (windows-x86_64)", "success"),
        partition("skipped"),
      ],
    }),
    "rerun",
  );
  assert.equal(
    readyForReviewAction(done, { jobs: [classified(), job("rust", "success")] }),
    "none",
  );
});

void test("the classifier records deferral as the marker step the supersede script reads", () => {
  const step = workflowStep("classify", deferralMarkerStep);
  assert.equal(step.if, "steps.plan.outputs.windows_tests_deferred == 'true'");
});

void test("fast pull request producers stop at once when a newer head superseded their run", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const action = readFileSync(
    new URL("../.github/actions/stop-if-superseded/action.yml", import.meta.url),
    "utf8",
  );
  const uses = "uses: ./.github/actions/stop-if-superseded";
  // classify, the three Windows Rust producers and the Linux quality, frontend, browser and catalog producers.
  assert.equal(ci.split(uses).length - 1, 8);
  for (const block of ci.split(uses).slice(1)) {
    assert.match(
      block,
      /^\s+with:\s+pull-request: \$\{\{ github\.event\.pull_request\.number \}\}\s+head-sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
    );
  }
  // Only a pull request event with a proven different head stops; anything unreadable continues.
  assert.match(action, /if: inputs\.pull-request != '' && inputs\.head-sha != ''/u);
  assert.match(action, /ls-remote origin "refs\/pull\/\$\{PORTCOVE_PULL_REQUEST\}\/head"/u);
  assert.match(action, /\|\| true\)"/u);
  assert.match(action, /=~ \^\[0-9a-f\]\{40\}\$ && "\$current" != "\$PORTCOVE_RUN_HEAD"/u);
  assert.doesNotMatch(action, /GH_TOKEN|github\.token|secrets\./u);
});

void test("the required ci status is posted from trusted code and never for a cancelled run", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci-required-status.yml", import.meta.url),
    "utf8",
  );
  // Default-branch code only: no pull request trigger, no checkout and no script from the candidate.
  assert.match(
    workflow,
    /^on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n/mu,
  );
  assert.doesNotMatch(workflow, /pull_request_target|^ {2}pull_request:|checkout|node |pnpm /mu);
  // The one action is the pinned API client; the GitHub CLI is not a maintained API route.
  assert.deepEqual(
    [...workflow.matchAll(/^\s+uses: (\S+)/gmu)].map((match) => match[1]),
    ["actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3"],
  );
  assert.doesNotMatch(workflow, /\bgh /u);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(workflow, /permissions:\n {6}actions: read\n {6}statuses: write\n/u);
  assert.equal(workflow.split("permissions:").length - 1, 2);
  // Only a pull request run of ci.yml, and only a decided conclusion.
  assert.match(workflow, /github\.event\.workflow_run\.event == 'pull_request'/u);
  assert.match(workflow, /github\.event\.workflow_run\.path == '\.github\/workflows\/ci\.yml'/u);
  assert.match(
    workflow,
    /fromJSON\('\["success","failure","timed_out","startup_failure"\]'\), github\.event\.workflow_run\.conclusion/u,
  );
  // One post at a time per head, and only from the run's current attempt.
  assert.match(
    workflow,
    /group: ci-required-status-\$\{\{ github\.event\.workflow_run\.head_sha \}\}\n {2}cancel-in-progress: false/u,
  );
  const script = workflow.slice(workflow.indexOf("script: |"));
  assert.match(script, /if \(run\.run_attempt !== attempt\) \{\n[^\n]*\n\s+return;/u);
  // Event values reach the script through the environment, and only success posts success.
  assert.doesNotMatch(script, /\$\{\{/u);
  assert.match(script, /const passed = process\.env\.PORTCOVE_CONCLUSION === "success";/u);
  assert.match(script, /state: passed \? "success" : "failure",\n\s+context: "ci",/u);
  assert.match(script, /\/\^\[0-9a-f\]\{40\}\$\/u\.test\(sha\)/u);
});
