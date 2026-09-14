import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const controllerWorkflow = ".github/codex/portcove-repair-resume.md";
const leaseMilliseconds = 30 * 60 * 1000;
const requiredChecks = Object.freeze([
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
]);
const checkStates = new Set(["success", "failure", "pending", "cancelled", "timed-out", "skipped"]);
const failureKinds = new Set(["transient", "substantive", "authority"]);
const phases = new Set(["authoring", "validating", "reviewing", "merge-ready"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, required, optional, label) {
  object(value, label);
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

function sha(value, label, length = 40) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error(`${label} is not an exact identity`);
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} is outside its bound`);
  return value;
}

function instant(value, label, optional = false) {
  if (optional && value === null) return null;
  const milliseconds = Date.parse(value ?? "");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${label} must be a canonical UTC instant`);
  return milliseconds;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function validateController(controller, now) {
  exactKeys(
    controller,
    [
      "workflow",
      "revision",
      "policy_sha256",
      "engineering_paused",
      "active_tasks",
      "max_active_tasks",
    ],
    [],
    "controller",
  );
  if (controller.workflow !== controllerWorkflow)
    throw new Error("controller workflow must match the checked-in repair/resume prompt");
  sha(controller.revision, "controller revision");
  sha(controller.policy_sha256, "controller policy", 64);
  if (typeof controller.engineering_paused !== "boolean")
    throw new Error("engineering pause must be boolean");
  if (controller.max_active_tasks !== 2)
    throw new Error("initial repository task capacity must remain exactly two");
  if (!Array.isArray(controller.active_tasks) || controller.active_tasks.length > 2)
    throw new Error("active task inventory exceeds repository capacity");
  const seen = new Set();
  const seenTasks = new Set();
  const active = controller.active_tasks.filter((entry) => {
    exactKeys(
      entry,
      ["pr_number", "task_id", "lease_owner", "lease_expires_at"],
      [],
      "active task",
    );
    boundedInteger(entry.pr_number, 1, Number.MAX_SAFE_INTEGER, "active task PR");
    for (const field of ["task_id", "lease_owner"])
      if (typeof entry[field] !== "string" || !entry[field].trim())
        throw new Error(`active task ${field} is invalid`);
    if (seen.has(entry.pr_number)) throw new Error("active task inventory duplicates a PR");
    if (seenTasks.has(entry.task_id)) throw new Error("active task inventory duplicates a task");
    seen.add(entry.pr_number);
    seenTasks.add(entry.task_id);
    const leaseExpires = instant(entry.lease_expires_at, "active task lease");
    if (leaseExpires > now + leaseMilliseconds)
      throw new Error("active task lease exceeds the bounded duration");
    return leaseExpires > now;
  });
  return { ...controller, active };
}

function validateAuthorization(authorization, controller, now) {
  exactKeys(
    authorization,
    [
      "issue_number",
      "workstream",
      "standing_rule",
      "authorized",
      "merge_authorized",
      "controller_revision",
      "expires_at",
    ],
    [],
    "standing authorization",
  );
  boundedInteger(authorization.issue_number, 1, Number.MAX_SAFE_INTEGER, "authorized issue");
  for (const field of ["workstream", "standing_rule"])
    if (typeof authorization[field] !== "string" || !authorization[field].trim())
      throw new Error(`standing authorization ${field} is invalid`);
  if (authorization.authorized !== true)
    throw new Error("work is not covered by affirmative standing authorization");
  if (typeof authorization.merge_authorized !== "boolean")
    throw new Error("merge authority must be explicit");
  if (authorization.controller_revision !== controller.revision)
    throw new Error("standing authorization is stale for the controller revision");
  const expires = instant(authorization.expires_at, "standing authorization expiry", true);
  if (expires !== null && expires <= now) throw new Error("standing authorization has expired");
  return authorization;
}

function validateWork(work, authorization) {
  exactKeys(
    work,
    [
      "issue_number",
      "pr_number",
      "base_commit",
      "head_commit",
      "phase",
      "protected_policy_changed",
    ],
    [],
    "work",
  );
  if (work.issue_number !== authorization.issue_number)
    throw new Error("work issue does not match standing authorization");
  boundedInteger(work.pr_number, 1, Number.MAX_SAFE_INTEGER, "work PR");
  sha(work.base_commit, "work base");
  sha(work.head_commit, "work head");
  if (!phases.has(work.phase)) throw new Error("work phase is invalid");
  if (typeof work.protected_policy_changed !== "boolean")
    throw new Error("protected-policy classification must be explicit");
  return work;
}

function validateReview(review, observed) {
  if (review === null) return null;
  exactKeys(
    review,
    [
      "review_id",
      "reviewed_at",
      "conclusion",
      "head_commit",
      "base_commit",
      "controller_revision",
      "findings_resolved",
    ],
    [],
    "review",
  );
  if (
    !new Set([
      "affirmative",
      "findings",
      "processing",
      "timeout",
      "cancelled",
      "failed",
      "no-comment",
    ]).has(review.conclusion)
  )
    throw new Error("review conclusion is invalid");
  if (typeof review.review_id !== "string" || !review.review_id.trim())
    throw new Error("review identity is invalid");
  const reviewed = instant(review.reviewed_at, "review observation");
  if (reviewed > observed) throw new Error("review observation is newer than its GitHub snapshot");
  sha(review.head_commit, "review head");
  sha(review.base_commit, "review base");
  sha(review.controller_revision, "review controller revision");
  if (typeof review.findings_resolved !== "boolean")
    throw new Error("review finding resolution must be explicit");
  return review;
}

function validateObservation(observation, now) {
  exactKeys(
    observation,
    [
      "complete",
      "observed_at",
      "checks",
      "threads_resolved",
      "review",
      "merged",
      "issue_status",
      "project_status",
    ],
    [],
    "observation",
  );
  if (observation.complete !== true) throw new Error("GitHub observation is incomplete");
  const observed = instant(observation.observed_at, "GitHub observation");
  if (observed > now || now - observed > 15 * 60 * 1000)
    throw new Error("GitHub observation is stale");
  if (!Array.isArray(observation.checks)) throw new Error("check inventory must be an array");
  const checks = new Map();
  for (const check of observation.checks) {
    exactKeys(
      check,
      ["name", "state", "failure_kind", "run_id", "attempt", "head_commit"],
      [],
      "check",
    );
    if (!requiredChecks.includes(check.name) || checks.has(check.name))
      throw new Error("check inventory is unknown or duplicated");
    if (!checkStates.has(check.state)) throw new Error("check state is invalid");
    if (check.state === "success" || check.state === "pending") {
      if (check.failure_kind !== null) throw new Error("nonfailed check has a failure kind");
    } else if (!failureKinds.has(check.failure_kind)) {
      throw new Error("nonsuccess check requires a classified failure kind");
    }
    boundedInteger(check.run_id, 1, Number.MAX_SAFE_INTEGER, "check run");
    boundedInteger(check.attempt, 1, Number.MAX_SAFE_INTEGER, "check attempt");
    sha(check.head_commit, "check head");
    checks.set(check.name, check);
  }
  if (checks.size !== requiredChecks.length)
    throw new Error("check inventory is missing a protected context");
  if (
    JSON.stringify(observation.checks.map((check) => check.name)) !== JSON.stringify(requiredChecks)
  )
    throw new Error("check inventory must use canonical protected-context order");
  for (const field of ["threads_resolved", "merged"])
    if (typeof observation[field] !== "boolean") throw new Error(`${field} must be boolean`);
  if (!new Set(["open", "closed"]).has(observation.issue_status))
    throw new Error("issue status is invalid");
  if (!new Set(["In progress", "Validating", "Done"]).has(observation.project_status))
    throw new Error("Project status is invalid");
  return { ...observation, checks, review: validateReview(observation.review, observed) };
}

function validateEpisode(episode, now) {
  exactKeys(
    episode,
    [
      "task_id",
      "lease_owner",
      "lease_expires_at",
      "transient_retries",
      "substantive_repairs",
      "last_action_sha256",
      "last_exception_sha256",
    ],
    [],
    "episode",
  );
  const identityFields = [episode.task_id, episode.lease_owner];
  if (
    identityFields.some((value) => value !== null && (typeof value !== "string" || !value.trim()))
  )
    throw new Error("episode task identity is invalid");
  if ((episode.task_id === null) !== (episode.lease_owner === null))
    throw new Error("episode task and owner must be recorded together");
  const leaseExpires = instant(episode.lease_expires_at, "episode lease", true);
  if ((episode.task_id === null) !== (leaseExpires === null))
    throw new Error("episode task and lease expiry must be recorded together");
  if (leaseExpires !== null && leaseExpires > now + leaseMilliseconds)
    throw new Error("episode lease exceeds the bounded duration");
  boundedInteger(episode.transient_retries, 0, 2, "transient retry count");
  boundedInteger(episode.substantive_repairs, 0, 3, "substantive repair count");
  for (const [value, label] of [
    [episode.last_action_sha256, "last action"],
    [episode.last_exception_sha256, "last exception"],
  ])
    if (value !== null) sha(value, label, 64);
  return { ...episode, leaseExpires };
}

function action(kind, reason, authority, details = {}) {
  const value = { schema_version: 1, action: kind, reason, authority, ...details };
  return { ...value, action_sha256: digest(value) };
}

function exception(reason, authority, work, episode, resumeCondition) {
  const evidence = {
    issue_number: work.issue_number,
    pr_number: work.pr_number,
    head_commit: work.head_commit,
    transient_retries: episode.transient_retries,
    substantive_repairs: episode.substantive_repairs,
    reason,
    resume_condition: resumeCondition,
  };
  return action("hold-exception", reason, authority, {
    exception: { ...evidence, exception_sha256: digest(evidence) },
  });
}

function deduplicate(result, episode) {
  if (result.action_sha256 !== episode.last_action_sha256) return result;
  return {
    schema_version: 1,
    action: "quiet-duplicate",
    reason: "the exact action is already recorded",
    authority: result.authority,
    duplicate_action_sha256: result.action_sha256,
    action_sha256: digest({ action: "quiet-duplicate", duplicate: result.action_sha256 }),
  };
}

function leaseDecision(now, controller, work, episode, authority) {
  const ownTask = controller.active.find((entry) => entry.pr_number === work.pr_number);
  const ownershipMismatch =
    ownTask &&
    (episode.task_id !== ownTask.task_id ||
      episode.lease_owner !== ownTask.lease_owner ||
      episode.lease_expires_at !== ownTask.lease_expires_at);
  const liveOrphanedLease = !ownTask && episode.task_id !== null && episode.leaseExpires > now;
  if (ownershipMismatch || liveOrphanedLease)
    return exception(
      "task lease ownership does not match the complete active-task inventory",
      authority,
      work,
      episode,
      "wait for expiry or reconcile the exact task and lease owner",
    );
  if (!ownTask && controller.active.length >= controller.max_active_tasks)
    return action("pause-capacity", "repository task capacity is exhausted", authority);
  if (!ownTask)
    return action("acquire-lease", "claim one bounded task slot before execution", authority, {
      lease_duration_seconds: leaseMilliseconds / 1000,
      reclaim_task_id: episode.task_id,
    });
  return null;
}

function classifiedCheckFailure(failed, kind) {
  return failed.find((check) => check.failure_kind === kind);
}

function checkDecision(observation, work, episode, authority) {
  const inventory = [...observation.checks.values()];
  const wrongHead = inventory.find((check) => check.head_commit !== work.head_commit);
  if (wrongHead)
    return exception(
      `protected check ${wrongHead.name} is stale for the current head`,
      authority,
      work,
      episode,
      "observe a complete protected-check inventory on the current head",
    );

  const failed = inventory.filter((check) => !["success", "pending"].includes(check.state));
  const authorityFailure = classifiedCheckFailure(failed, "authority");
  if (authorityFailure)
    return exception(
      `protected check ${authorityFailure.name} lacks required authority`,
      authority,
      work,
      episode,
      "restore the separately authorized check authority and observe a fresh run",
    );

  const substantive = classifiedCheckFailure(failed, "substantive");
  if (substantive)
    return episode.substantive_repairs < 3
      ? action("dispatch-repair", `diagnose ${substantive.name} before rerunning`, authority, {
          repair_number: episode.substantive_repairs + 1,
          repair_limit: 3,
          failed_check: substantive,
        })
      : exception(
          "substantive repair budget is exhausted",
          authority,
          work,
          episode,
          "record new authority or a reviewed narrower recovery plan",
        );

  const transient = classifiedCheckFailure(failed, "transient");
  if (transient)
    return episode.transient_retries < 2
      ? action("retry-check", `retry transient ${transient.name} infrastructure`, authority, {
          retry_number: episode.transient_retries + 1,
          retry_limit: 2,
          failed_check: transient,
        })
      : exception(
          "transient retry budget is exhausted",
          authority,
          work,
          episode,
          "observe infrastructure recovery and start a separately recorded episode",
        );

  const pending = inventory.filter((check) => check.state === "pending");
  return pending.length
    ? action("wait-checks", "protected checks are still running", authority, {
        pending_checks: pending.map((check) => check.name).sort(),
      })
    : null;
}

function reviewDecision(
  controller,
  authorization,
  work,
  observation,
  episode,
  authority,
  mergeReady,
) {
  const review = observation.review;
  const reviewIsCurrent =
    review &&
    review.head_commit === work.head_commit &&
    review.base_commit === work.base_commit &&
    review.controller_revision === controller.revision;
  if (
    !reviewIsCurrent ||
    ["processing", "timeout", "cancelled", "failed", "no-comment"].includes(review?.conclusion)
  )
    return action("request-review", "a fresh affirmative exact-diff review is required", authority);
  if (review.conclusion === "findings" || !review.findings_resolved)
    return episode.substantive_repairs < 3
      ? action("dispatch-review-repair", "resolve substantive review findings", authority, {
          repair_number: episode.substantive_repairs + 1,
          repair_limit: 3,
        })
      : exception(
          "review repair budget is exhausted",
          authority,
          work,
          episode,
          "record a reviewed recovery decision for the unresolved findings",
        );
  if (!observation.threads_resolved)
    return action("resolve-review-threads", "review threads remain unresolved", authority);
  if (!mergeReady)
    return action(
      "mark-merge-ready",
      "exact review is affirmative and threads are resolved",
      authority,
      {
        next_phase: "merge-ready",
        review_id: review.review_id,
      },
    );
  if (!authorization.merge_authorized)
    return exception(
      "standing rule does not authorize merge",
      authority,
      work,
      episode,
      "record separate merge authority for this exact workstream and controller revision",
    );
  return action(
    "enable-normal-auto-merge",
    "all protected checks and exact review authority are current",
    authority,
    { merge_method: "squash", administrator_bypass: false },
  );
}

function currentWorkDecision(
  now,
  controller,
  authorization,
  work,
  observation,
  episode,
  authority,
) {
  const lease = leaseDecision(now, controller, work, episode, authority);
  if (lease) return lease;
  if (work.phase === "authoring")
    return action(
      "run-validation",
      "authoring is complete; begin deterministic validation",
      authority,
      {
        next_phase: "validating",
      },
    );
  const check = checkDecision(observation, work, episode, authority);
  if (check) return check;
  if (work.phase === "validating")
    return action(
      "request-review",
      "successful checks require a distinct exact-diff review",
      authority,
      {
        next_phase: "reviewing",
      },
    );
  return reviewDecision(
    controller,
    authorization,
    work,
    observation,
    episode,
    authority,
    work.phase === "merge-ready",
  );
}

export function planEngineeringHandoff(input) {
  exactKeys(
    input,
    ["schema_version", "now", "controller", "authorization", "work", "observation", "episode"],
    [],
    "engineering handoff input",
  );
  if (input.schema_version !== 1) throw new Error("unsupported engineering handoff schema");
  const now = instant(input.now, "controller time");
  const controller = validateController(input.controller, now);
  const authorization = validateAuthorization(input.authorization, controller, now);
  const work = validateWork(input.work, authorization);
  const observation = validateObservation(input.observation, now);
  const episode = validateEpisode(input.episode, now);
  const observationEvidence = Object.fromEntries(
    Object.entries(input.observation).filter(([key]) => key !== "observed_at"),
  );
  const authority = {
    controller_workflow: controller.workflow,
    controller_revision: controller.revision,
    policy_sha256: controller.policy_sha256,
    standing_rule: authorization.standing_rule,
    workstream: authorization.workstream,
    issue_number: work.issue_number,
    pr_number: work.pr_number,
    base_commit: work.base_commit,
    head_commit: work.head_commit,
    work_phase: work.phase,
    task_id: episode.task_id,
    lease_owner: episode.lease_owner,
    authorization_sha256: digest(input.authorization),
    observation_sha256: digest(observationEvidence),
  };

  let result;
  if (controller.engineering_paused) {
    result = action("pause", "engineering emergency pause is active", authority);
  } else if (work.protected_policy_changed) {
    result = exception(
      "candidate changes protected controller or merge policy",
      authority,
      work,
      episode,
      "record separate owner authorization or remove the protected-policy change",
    );
  } else if (
    !observation.merged &&
    (observation.issue_status === "closed" || observation.project_status === "Done")
  ) {
    result = exception(
      "canonical planning record is terminal before the pull request merged",
      authority,
      work,
      episode,
      "reconcile the issue and Project to the actual unmerged pull request state",
    );
  } else if (observation.merged) {
    result =
      observation.issue_status === "closed" && observation.project_status === "Done"
        ? action("complete", "merged work and canonical planning records are terminal", authority)
        : action(
            "finalize-records",
            "merge succeeded; reconcile the issue and live Project",
            authority,
          );
  } else {
    result = currentWorkDecision(
      now,
      controller,
      authorization,
      work,
      observation,
      episode,
      authority,
    );
  }
  if (
    result.action === "hold-exception" &&
    result.exception.exception_sha256 === episode.last_exception_sha256
  ) {
    result = action("quiet-exception", "the unresolved exception is already recorded", authority, {
      exception_sha256: result.exception.exception_sha256,
    });
  }
  return deduplicate(result, episode);
}

async function readInput(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1024 * 1024)
    throw new Error("engineering handoff input must be a bounded regular file");
  return JSON.parse(await readFile(filename, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.length !== 3) throw new Error("usage: engineering-handoff.mjs INPUT.json");
  console.log(
    JSON.stringify(planEngineeringHandoff(await readInput(path.resolve(process.argv[2]))), null, 2),
  );
}
