/** Fixed rehearsal guards over native provider facts, never a scheduler,
 * reservation, permission grant or replacement for the production pause. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { isDeepStrictEqual } from "node:util";
import {
  rehearsalExecution,
  rehearsalExecutionRef,
  retainedRehearsal,
} from "./upstream-release-identity.mts";
import { rehearsalApi } from "./upstream-release-rehearsal.mts";

// The regression checks these against the actual native job timeouts. Prior
// attempts consume observed runtime; reserve the full remaining fixed tail.
// This bounds planned interruption/retry within the same application140 ceiling.
export const rehearsalJobMinutes = Object.freeze({
  package: 30,
  provenance: 3,
  sign: 10,
  baseline: 5,
  installed: 35,
  acceptance: 3,
  draft: 5,
  feed: 5,
  public_installed: 15,
  readback: 5,
});

export const recoveryJobMinutes = Object.freeze({
  recovery: 3,
  feed: 5,
  public_installed: 15,
  readback: 5,
});

export function inspectRehearsalBudget(
  job: string,
  completedAttempts: unknown[],
  contexts?: unknown[],
) {
  const names = Object.keys(rehearsalJobMinutes);
  const index = names.indexOf(job);
  assert.ok((index >= 0 || job === "recovery") && completedAttempts.length <= 3);
  if (contexts) assert.equal(contexts.length, completedAttempts.length);
  let observedMilliseconds = 0;
  let copiedSuccessfulObservations = 0;
  const executions: { attempt: number; value: Record<string, unknown> }[] = [];
  const proof = (value: Record<string, unknown>) =>
    Object.fromEntries(
      [
        "run_id",
        "name",
        "head_sha",
        "head_branch",
        "runner_id",
        "runner_name",
        "labels",
        "started_at",
        "completed_at",
        "steps",
      ].map((key) => [key, value[key]]),
    );
  for (const [collectionIndex, collection] of completedAttempts.entries()) {
    assert.ok(
      isRecord(collection) &&
        Array.isArray(collection.jobs) &&
        collection.jobs.length < 100 &&
        collection.total_count === collection.jobs.length,
    );
    const context = contexts?.[collectionIndex];
    if (contexts)
      assert.ok(
        isRecord(context) &&
          Number.isSafeInteger(context.id) &&
          Number(context.id) > 0 &&
          Number.isSafeInteger(context.run_attempt) &&
          Number(context.run_attempt) >= 1 &&
          Number(context.run_attempt) <= 3 &&
          typeof context.head_sha === "string" &&
          /^[a-f0-9]{40}$/u.test(context.head_sha) &&
          typeof context.run_started_at === "string" &&
          Number.isFinite(Date.parse(context.run_started_at)) &&
          context.event === "workflow_dispatch" &&
          context.path === ".github/workflows/upstream-release-rehearsal.yml",
      );
    for (const value of collection.jobs) {
      assert.ok(
        isRecord(value) &&
          typeof value.name === "string" &&
          [...names, "recovery"].includes(value.name),
      );
      if (isRecord(context)) {
        assert.equal(value.run_id, context.id);
        assert.equal(value.run_attempt, context.run_attempt);
        assert.equal(value.head_sha, context.head_sha);
      }
      if (job === "package" && value.name === "package" && value.conclusion === "success")
        throw new Error("successful original package must be reused; rerun failed jobs only");
      if (value.status !== "completed") continue;
      // GitHub assigns synthetic timestamps to skipped jobs, sometimes with
      // completed_at one second before started_at. Only a provider-confirmed
      // skipped job with no executed steps consumes zero runner time.
      if (value.conclusion === "skipped") {
        assert.deepEqual(value.steps, []);
        continue;
      }
      if (value.conclusion === "cancelled" && value.started_at === null) continue;
      assert.ok(typeof value.started_at === "string" && typeof value.completed_at === "string");
      const milliseconds = Date.parse(value.completed_at) - Date.parse(value.started_at);
      assert.ok(
        Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 6 * 60 * 60 * 1000,
      );
      // Native failed-only retries clone successful rows with new IDs and attempt
      // display metadata. Only exact prior execution evidence, completed before
      // the authenticated later attempt began, establishes a carried observation.
      if (
        isRecord(context) &&
        value.conclusion === "success" &&
        milliseconds > 0 &&
        Number.isSafeInteger(value.runner_id) &&
        Number(value.runner_id) > 0 &&
        typeof value.runner_name === "string" &&
        value.runner_name.length > 0 &&
        Array.isArray(value.steps) &&
        value.steps.length > 0
      ) {
        const carried =
          Date.parse(value.completed_at) < Date.parse(String(context.run_started_at)) &&
          executions.some(
            (previous) =>
              previous.attempt < Number(context.run_attempt) &&
              isDeepStrictEqual(proof(previous.value), proof(value)),
          );
        if (carried) {
          copiedSuccessfulObservations++;
          continue;
        }
        executions.push({ attempt: Number(context.run_attempt), value });
      }
      observedMilliseconds += milliseconds;
    }
  }
  const remainingMinutes =
    job === "recovery"
      ? Object.values(recoveryJobMinutes).reduce((a, b) => a + b, 0)
      : names
          .slice(index)
          .reduce(
            (total, name) => total + rehearsalJobMinutes[name as keyof typeof rehearsalJobMinutes],
            0,
          );
  if (observedMilliseconds + remainingMinutes * 60000 > 140 * 60000)
    throw new Error(
      "remaining rehearsal including retry cannot fit the appointed application140 bound",
    );
  return {
    authority: "none",
    observed_milliseconds: observedMilliseconds,
    copied_successful_observations: copiedSuccessfulObservations,
    remaining_declared_minutes: remainingMinutes,
    maximum_minutes: 140,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
  };
}

export function readRehearsalAttemptObservations() {
  const execution = rehearsalExecution();
  const attempts: unknown[] = [];
  const contexts: unknown[] = [];
  for (const selected of [
    { ...retainedRehearsal, run_attempt: 1 },
    { ...retainedRehearsal, run_attempt: 2 },
    { ...execution, ref: rehearsalExecutionRef },
  ]) {
    const actual = rehearsalApi(`actions/runs/${selected.run_id}/attempts/${selected.run_attempt}`);
    assert.ok(
      isRecord(actual) &&
        actual.id === Number(selected.run_id) &&
        actual.head_sha === selected.source &&
        actual.head_branch === selected.ref.slice("refs/tags/".length) &&
        actual.run_attempt === selected.run_attempt &&
        actual.path === ".github/workflows/upstream-release-rehearsal.yml" &&
        actual.event === "workflow_dispatch",
    );
    const jobs = rehearsalApi(
      `actions/runs/${selected.run_id}/attempts/${selected.run_attempt}/jobs?per_page=100`,
    );
    assert.ok(isRecord(jobs) && Array.isArray(jobs.jobs));
    if (selected.run_id !== execution.run_id)
      assert.ok(jobs.jobs.every((value) => isRecord(value) && value.status === "completed"));
    attempts.push(jobs);
    contexts.push(actual);
  }
  return { attempts, contexts };
}

export async function assertRehearsalBudget(job: string) {
  const execution = rehearsalExecution();
  const { attempts, contexts } = readRehearsalAttemptObservations();
  const current = attempts[2];
  assert.ok(isRecord(current) && Array.isArray(current.jobs));
  const order = Object.keys(recoveryJobMinutes);
  const position = order.indexOf(job);
  assert.ok(position >= 0);
  assert.equal(
    current.jobs.filter(
      (value) => isRecord(value) && value.name === job && value.status === "in_progress",
    ).length,
    1,
    "current native job observation is unavailable",
  );
  for (const prior of order.slice(0, position))
    assert.equal(
      current.jobs.filter(
        (value) =>
          isRecord(value) &&
          value.name === prior &&
          value.status === "completed" &&
          value.conclusion === "success",
      ).length,
      1,
      "prior execution has not settled in provider readback",
    );

  if (job === "package" && execution.run_attempt > 1) {
    const artifacts = rehearsalApi(`actions/runs/${execution.run_id}/artifacts?per_page=100`);
    assert.ok(
      isRecord(artifacts) &&
        Array.isArray(artifacts.artifacts) &&
        artifacts.total_count === artifacts.artifacts.length &&
        artifacts.artifacts.length < 100,
    );
    assert.ok(
      !artifacts.artifacts.some(
        (value) =>
          isRecord(value) &&
          new RegExp(`^upstream-(unsigned|candidate-executable)-${execution.run_id}-`, "u").test(
            String(value.name),
          ),
      ),
      "retain original package artifacts after a partial failure; no automatic rebuild",
    );
  }
  const receipt = inspectRehearsalBudget(job, attempts, contexts);
  assert.ok(
    Date.now() + receipt.remaining_declared_minutes * 60000 <=
      Date.parse(retainedRehearsal.deadline),
    "remaining recovery cannot fit the calibrated observation deadline",
  );
  await mkdir("work/upstream-runtime", { recursive: true });
  await writeFile(
    `work/upstream-runtime/budget-${job}.json`,
    `${JSON.stringify({ ...receipt, execution, original_observation_deadline: retainedRehearsal.original_deadline, observation_deadline: retainedRehearsal.deadline })}\n`,
    { flag: "wx" },
  );
}

export function inspectRehearsalProtection(raw: unknown) {
  assert.ok(
    isRecord(raw) &&
      raw.target === "tag" &&
      raw.source_type === "Repository" &&
      raw.source === "boburning/portcove" &&
      raw.enforcement === "active" &&
      Number.isSafeInteger(raw.id),
  );
  // GitHub hides bypass actors without Administration write. Disposable jobs
  // must not gain that permission merely to read this field. Setup retains the
  // independent actual no-bypass observation; runtime omission stays unknown.
  const bypassVisible = Object.hasOwn(raw, "bypass_actors");
  if (bypassVisible) assert.deepEqual(raw.bypass_actors, []);
  assert.ok(isRecord(raw.conditions) && isRecord(raw.conditions.ref_name));
  assert.deepEqual(raw.conditions.ref_name, { exclude: [], include: [rehearsalExecutionRef] });
  assert.ok(Array.isArray(raw.rules));
  assert.deepEqual(
    raw.rules
      .map((rule) => {
        assert.ok(isRecord(rule));
        assert.ok(typeof rule.type === "string");
        return rule.type;
      })
      .sort((a, b) => a.localeCompare(b)),
    ["creation", "deletion", "update"],
  );
  return {
    ruleset_id: raw.id,
    ref: rehearsalExecutionRef,
    no_bypass: bypassVisible ? true : null,
    runtime_bypass_observation: bypassVisible
      ? "observed-empty"
      : "unknown-not-exposed-by-provider",
    production_admission: false,
  };
}

export async function assertRehearsalProtection(phase = "protection") {
  const execution = rehearsalExecution();
  const tag = rehearsalExecutionRef.slice("refs/tags/".length);
  const ref = rehearsalApi(`git/ref/tags/${tag}`);
  assert.ok(
    isRecord(ref) &&
      ref.ref === rehearsalExecutionRef &&
      isRecord(ref.object) &&
      ref.object.type === "commit" &&
      ref.object.sha === execution.source,
  );
  const all = rehearsalApi("rulesets?per_page=100");
  assert.ok(Array.isArray(all) && all.length < 100);
  const named = all.filter(
    (value) => isRecord(value) && value.name === "Portcove upstream rehearsal 20261104r3 immutable",
  );
  assert.equal(named.length, 1);
  const rule: unknown = named[0];
  assert.ok(isRecord(rule) && typeof rule.id === "number" && Number.isSafeInteger(rule.id));
  const observed = inspectRehearsalProtection(rehearsalApi(`rulesets/${rule.id}`));
  const pause = rehearsalApi("contents/publication.json?ref=portcove-release-pause");
  assert.ok(
    isRecord(pause) &&
      pause.encoding === "base64" &&
      typeof pause.content === "string" &&
      pause.content.length < 1024,
  );
  const pausedBytes = Buffer.from(pause.content, "base64");
  assert.equal(
    createHash("sha256").update(pausedBytes).digest("hex"),
    "5b4d17ede911f33863d83939b0181c86c77fdd587f8e1605ff395b0fbad599df",
  );
  const control: unknown = JSON.parse(pausedBytes.toString("utf8"));
  assert.ok(isRecord(control) && control.publication_paused === true);
  await mkdir("work/upstream-runtime", { recursive: true });
  if (!/^[a-z-]{1,32}$/u.test(phase)) throw new Error("unknown protection observation phase");
  await writeFile(
    `work/upstream-runtime/protection-${phase}.json`,
    `${JSON.stringify({ ...observed, execution })}\n`,
    { flag: "wx" },
  );
  return observed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "budget" && process.argv[3]) await assertRehearsalBudget(process.argv[3]);
  else if (process.argv[2] === "protection") await assertRehearsalProtection();
  else throw new Error("expected budget JOB or protection");
}
