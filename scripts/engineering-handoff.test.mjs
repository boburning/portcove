import assert from "node:assert/strict";
import test from "node:test";

import { planEngineeringHandoff } from "./engineering-handoff.mjs";

const base = "1".repeat(40);
const head = "2".repeat(40);
const controllerRevision = "3".repeat(40);
const checkNames = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const lease = {
  pr_number: 901,
  task_id: "task-901",
  lease_owner: "codex-event-task",
  lease_expires_at: "2026-09-14T12:30:00.000Z",
};

function checks(state = "success", failureKind = null, revision = head) {
  return checkNames.map((name, index) => ({
    name,
    state,
    failure_kind: failureKind,
    run_id: 100 + index,
    attempt: 1,
    head_commit: revision,
  }));
}

function fixture(overrides = {}) {
  const value = {
    schema_version: 1,
    now: "2026-09-14T12:00:00.000Z",
    controller: {
      workflow: ".github/codex/portcove-repair-resume.md",
      revision: controllerRevision,
      policy_sha256: "4".repeat(64),
      engineering_paused: false,
      active_tasks: [lease],
      max_active_tasks: 2,
    },
    authorization: {
      issue_number: 900,
      workstream: "fast-ci-followup",
      standing_rule: "owner-approved-implementation-prompt",
      authorized: true,
      merge_authorized: true,
      controller_revision: controllerRevision,
      expires_at: null,
    },
    work: {
      issue_number: 900,
      pr_number: 901,
      base_commit: base,
      head_commit: head,
      phase: "validating",
      protected_policy_changed: false,
    },
    observation: {
      complete: true,
      observed_at: "2026-09-14T11:59:00.000Z",
      checks: checks(),
      threads_resolved: true,
      review: null,
      merged: false,
      issue_status: "open",
      project_status: "Validating",
    },
    episode: {
      task_id: lease.task_id,
      lease_owner: lease.lease_owner,
      lease_expires_at: lease.lease_expires_at,
      transient_retries: 0,
      substantive_repairs: 0,
      last_action_sha256: null,
      last_exception_sha256: null,
    },
  };
  for (const [key, override] of Object.entries(overrides))
    value[key] =
      override && typeof override === "object" && !Array.isArray(override)
        ? { ...value[key], ...override }
        : override;
  return value;
}

function review(overrides = {}) {
  return {
    review_id: "review-1",
    reviewed_at: "2026-09-14T11:58:00.000Z",
    conclusion: "affirmative",
    head_commit: head,
    base_commit: base,
    controller_revision: controllerRevision,
    findings_resolved: true,
    ...overrides,
  };
}

test("a controlled authorized repair reaches the terminal plan without an owner prompt", () => {
  const failed = checks();
  failed[3] = { ...failed[3], state: "failure", failure_kind: "substantive" };
  const repair = planEngineeringHandoff(fixture({ observation: { checks: failed } }));
  assert.equal(repair.action, "dispatch-repair");
  assert.equal(repair.repair_number, 1);

  const requestReview = planEngineeringHandoff(fixture());
  assert.equal(requestReview.action, "request-review");

  const reviewed = planEngineeringHandoff(
    fixture({ work: { phase: "reviewing" }, observation: { review: review() } }),
  );
  assert.equal(reviewed.action, "mark-merge-ready");

  const merge = planEngineeringHandoff(
    fixture({ work: { phase: "merge-ready" }, observation: { review: review() } }),
  );
  assert.equal(merge.action, "enable-normal-auto-merge");
  assert.equal(merge.administrator_bypass, false);

  const finalize = planEngineeringHandoff(
    fixture({ observation: { merged: true, review: review() } }),
  );
  assert.equal(finalize.action, "finalize-records");

  const complete = planEngineeringHandoff(
    fixture({
      observation: {
        merged: true,
        review: review(),
        issue_status: "closed",
        project_status: "Done",
      },
    }),
  );
  assert.equal(complete.action, "complete");
});

test("pending, missing, stale, skipped, cancelled, and timed-out checks never authorize merge", () => {
  for (const state of ["pending", "failure", "skipped", "cancelled", "timed-out"]) {
    const inventory = checks();
    inventory[0] = {
      ...inventory[0],
      state,
      failure_kind: state === "pending" ? null : "transient",
    };
    assert.notEqual(
      planEngineeringHandoff(fixture({ observation: { checks: inventory, review: review() } }))
        .action,
      "enable-normal-auto-merge",
    );
  }
  assert.throws(
    () => planEngineeringHandoff(fixture({ observation: { checks: checks().slice(0, 4) } })),
    /missing a protected context/u,
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({
        observation: { checks: checks("success", null, "9".repeat(40)), review: review() },
      }),
    ).action,
    "hold-exception",
  );
});

test("stale, silent, processing, and finding reviews cannot become merge authority", () => {
  for (const candidate of [
    review({ head_commit: "9".repeat(40) }),
    review({ base_commit: "8".repeat(40) }),
    review({ controller_revision: "7".repeat(40) }),
    review({ conclusion: "no-comment" }),
    review({ conclusion: "processing" }),
    review({ conclusion: "timeout" }),
    review({ conclusion: "cancelled" }),
    review({ conclusion: "failed" }),
  ]) {
    assert.equal(
      planEngineeringHandoff(
        fixture({ work: { phase: "reviewing" }, observation: { review: candidate } }),
      ).action,
      "request-review",
    );
  }
  assert.equal(
    planEngineeringHandoff(
      fixture({
        observation: { review: review({ conclusion: "findings", findings_resolved: false }) },
        work: { phase: "reviewing" },
      }),
    ).action,
    "dispatch-review-repair",
  );
});

test("pause, capacity, leases, and protected-policy changes fail closed", () => {
  assert.equal(
    planEngineeringHandoff(fixture({ controller: { engineering_paused: true } })).action,
    "pause",
  );
  const activeTasks = [1, 2].map((pr) => ({
    pr_number: pr,
    task_id: `task-${pr}`,
    lease_owner: `owner-${pr}`,
    lease_expires_at: "2026-09-14T12:30:00.000Z",
  }));
  assert.equal(
    planEngineeringHandoff(
      fixture({
        controller: { active_tasks: activeTasks },
        episode: { task_id: null, lease_owner: null, lease_expires_at: null },
      }),
    ).action,
    "pause-capacity",
  );
  activeTasks[0] = { ...activeTasks[0], pr_number: 901 };
  assert.equal(
    planEngineeringHandoff(
      fixture({
        controller: { active_tasks: activeTasks },
        episode: {
          task_id: "task-1",
          lease_owner: "owner-1",
          lease_expires_at: "2026-09-14T12:30:00.000Z",
        },
      }),
    ).action,
    "request-review",
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({
        controller: { active_tasks: activeTasks },
        episode: {
          task_id: "different-task",
          lease_owner: "owner-1",
          lease_expires_at: "2026-09-14T12:30:00.000Z",
        },
      }),
    ).action,
    "hold-exception",
  );
  assert.equal(
    planEngineeringHandoff(fixture({ work: { protected_policy_changed: true } })).action,
    "hold-exception",
  );
});

test("retry and repair budgets survive restart and stop at their exact bounds", () => {
  const transient = checks();
  transient[0] = { ...transient[0], state: "timed-out", failure_kind: "transient" };
  assert.equal(
    planEngineeringHandoff(
      fixture({ observation: { checks: transient }, episode: { transient_retries: 1 } }),
    ).retry_number,
    2,
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({ observation: { checks: transient }, episode: { transient_retries: 2 } }),
    ).action,
    "hold-exception",
  );
  const substantive = checks();
  substantive[0] = { ...substantive[0], state: "failure", failure_kind: "substantive" };
  assert.equal(
    planEngineeringHandoff(
      fixture({ observation: { checks: substantive }, episode: { substantive_repairs: 2 } }),
    ).repair_number,
    3,
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({ observation: { checks: substantive }, episode: { substantive_repairs: 3 } }),
    ).action,
    "hold-exception",
  );
});

test("actions and exceptions deduplicate across interrupted restarts", () => {
  const first = planEngineeringHandoff(fixture());
  assert.equal(
    planEngineeringHandoff(fixture({ episode: { last_action_sha256: first.action_sha256 } }))
      .action,
    "quiet-duplicate",
  );
  const held = planEngineeringHandoff(fixture({ work: { protected_policy_changed: true } }));
  assert.equal(
    planEngineeringHandoff(
      fixture({
        work: { protected_policy_changed: true },
        episode: { last_exception_sha256: held.exception.exception_sha256 },
      }),
    ).action,
    "quiet-exception",
  );

  const refreshed = fixture({
    observation: { observed_at: "2026-09-14T11:59:30.000Z" },
    episode: { last_action_sha256: first.action_sha256 },
  });
  assert.equal(planEngineeringHandoff(refreshed).action, "quiet-duplicate");
});

test("work acquires a bounded lease before dispatch and follows explicit phases", () => {
  const unleased = {
    task_id: null,
    lease_owner: null,
    lease_expires_at: null,
  };
  const acquire = planEngineeringHandoff(
    fixture({ controller: { active_tasks: [] }, episode: unleased }),
  );
  assert.equal(acquire.action, "acquire-lease");
  assert.equal(acquire.lease_duration_seconds, 1800);

  assert.equal(
    planEngineeringHandoff(fixture({ work: { phase: "authoring" } })).action,
    "run-validation",
  );
  assert.equal(planEngineeringHandoff(fixture()).action, "request-review");
  assert.equal(
    planEngineeringHandoff(
      fixture({ work: { phase: "reviewing" }, observation: { review: review() } }),
    ).action,
    "mark-merge-ready",
  );
});

test("changed authority, missing merge permission, or unresolved threads refuse merge", () => {
  assert.throws(
    () =>
      planEngineeringHandoff(fixture({ authorization: { controller_revision: "9".repeat(40) } })),
    /authorization is stale/u,
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({
        authorization: { merge_authorized: false },
        work: { phase: "merge-ready" },
        observation: { review: review() },
      }),
    ).action,
    "hold-exception",
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({
        work: { phase: "merge-ready" },
        observation: { review: review(), threads_resolved: false },
      }),
    ).action,
    "resolve-review-threads",
  );
  assert.equal(
    planEngineeringHandoff(
      fixture({ observation: { issue_status: "closed", project_status: "Done" } }),
    ).action,
    "hold-exception",
  );
});
