import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedIntakeAttention,
  hostedIntakeFacts,
  hostedIntakeObservation,
  hostedIntakeRevision,
  hostedIntakeSummary,
} from "./maintenance-hosted-intake.mts";
import { GitHubApiError } from "./github-operation.mts";
import type { HostedRequestStatus, HostedStatusAll } from "./hosted-discovery-intake.mts";

const resume =
  "Use owner process dispatch when the exact repository ID and primary evidence are accessible.";
const slot = (index: number, overrides = {}) => ({
  candidate_index: index,
  port_key: `game-${index}`,
  repository_id: 1000 + index,
  upstream: `https://github.com/owner/game-${index}`,
  delivery_status: "delivered",
  linked_issue: 200 + index,
  existing: false,
  hold: null,
  ...overrides,
});
/** One request exactly as the executor's status() reports it, clocks included. */
const row = (id: number, overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    request_comment: id,
    receipt_comment: id + 1,
    reconciles: null,
    body_request_comment: id,
    status: "complete",
    candidates: 2,
    delivered: 2,
    existing: 0,
    held: 0,
    pending: 0,
    full_doctor_required: false,
    doctor: null,
    last_error: null,
    observed_at: "2026-11-10T00:00:00.000Z",
    slots: [slot(0), slot(1)],
    withdrawn: false,
    superseded_by: [],
    ...overrides,
  }) as HostedRequestStatus;
const read = (
  requests: HostedRequestStatus[],
  updated = "2026-11-11T00:00:00Z",
): HostedStatusAll => ({
  queue: { node_id: "I177", comments: 9, updated_at: updated, comments_sha256: "a".repeat(64) },
  requests,
});

void test("request facts keep stable receipt state and drop clocks, run identities and messages", () => {
  const blocked = (observed: string, message: string, receipt: string) =>
    row(30, {
      status: "blocked",
      last_error: { code: "operation_failed", message },
      observed_at: observed,
      doctor: {
        status: "passed",
        coverage: "complete",
        global_health: "passed",
        receipt_sha256: receipt,
      },
    });
  const first = hostedIntakeFacts(
    read([row(10), blocked("2026-11-10T00:00:00Z", "a", "1".repeat(64))]),
  );
  const second = hostedIntakeFacts(
    read(
      [
        row(10, { observed_at: "2026-11-11T09:00:00Z" }),
        blocked("2026-11-11T00:00:00Z", "b", "2".repeat(64)),
      ],
      "2026-11-11T09:00:00Z",
    ),
  );
  assert.equal(first.expected, 2);
  assert.deepEqual([...first.facts.keys()], ["intake:10", "intake:30"]);
  assert.deepEqual(
    first.facts,
    second.facts,
    "a re-read with new clocks and messages is unchanged",
  );
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(first.facts.get("intake:30"), {
    request_comment: 30,
    receipt_comment: 31,
    withdrawn: false,
    reconciles: null,
    superseded_by: [],
    body_request_comment: 30,
    status: "blocked",
    candidates: 2,
    delivered: 2,
    existing: 0,
    held: 0,
    pending: 0,
    full_doctor_required: false,
    doctor: { status: "passed", coverage: "complete", global_health: "passed" },
    blocker: { code: "operation_failed" },
    slots: [slot(0), slot(1)],
  });
  assert.deepEqual(first.gaps, []);
});

void test("an unvalidated request is a gap and the read revision stays within the store limit", () => {
  const facts = hostedIntakeFacts(
    read([
      row(10),
      {
        request_comment: 20,
        withdrawn: false,
        superseded_by: [],
        error: {
          code: "operation_failed",
          message: "Retained receipt body lineage or coverage differs",
        },
      },
    ]),
  );
  assert.equal(facts.expected, 2);
  assert.deepEqual([...facts.facts.keys()], ["intake:10"]);
  assert.deepEqual(
    facts.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [["intake:20", "invalid-receipt"]],
  );
  assert.match(facts.revision, /^hosted-intake:I177:9@2026-11-11T00:00:00Z#sha256:a{64}$/u);
  const long = hostedIntakeRevision({
    node_id: "I".repeat(150),
    comments: 9,
    updated_at: "2026-11-11T00:00:00Z",
    comments_sha256: "a".repeat(64),
  });
  assert.match(long, /^hosted-intake:sha256:[a-f0-9]{64}$/u);
  assert.throws(() => hostedIntakeFacts(read([row(10), row(10)])), /Unsupported/u);
});

void test("drift and unavailable reads are failed runs that observe nothing", async () => {
  const changed = await hostedIntakeObservation(() =>
    Promise.reject(
      new GitHubApiError("inventory_changed", "Hosted request queue changed during collection"),
    ),
  );
  const unavailable = await hostedIntakeObservation(() =>
    Promise.reject(
      new GitHubApiError("budget_exhausted", "Hosted status read exceeded its budget"),
    ),
  );
  for (const [observation, code] of [
    [changed, "inventory-changed"],
    [unavailable, "unavailable"],
  ] as const) {
    assert.equal(observation.failed, true);
    assert.equal(observation.expected, null);
    assert.equal(observation.facts.size, 0);
    assert.deepEqual(
      observation.gaps.map(({ subject_key, code: gap }) => [subject_key, gap]),
      [["source:hosted-intake-queue", code]],
    );
  }
  const complete = await hostedIntakeObservation(() => Promise.resolve(read([row(10)])));
  assert.equal(complete.failed, false);
  assert.equal(complete.facts.size, 1);
});

void test("attention reuses the executor classification and withdrawn requests stay quiet", () => {
  const fact = (overrides: Partial<Record<string, unknown>>) =>
    hostedIntakeFacts(read([row(10, overrides)])).facts.get("intake:10");
  assert.deepEqual(
    hostedIntakeAttention(
      fact({
        status: "blocked",
        reconciles: 5,
        last_error: { code: "operation_failed", message: "m" },
      }),
    ),
    ["hosted intake blocked: operation_failed (receipt comment 11; reconciles request 5)"],
  );
  assert.deepEqual(
    hostedIntakeAttention(
      fact({
        status: "complete_with_holds",
        held: 2,
        pending: 2,
        delivered: 0,
        slots: [
          slot(0, {
            delivery_status: "prepared",
            linked_issue: null,
            hold: { http_status: 404, resume },
          }),
          slot(1, {
            delivery_status: "prepared",
            linked_issue: null,
            hold: { http_status: 404, resume },
          }),
        ],
      }),
    ),
    [`hosted intake held candidates (receipt comment 11): ${resume}`],
  );
  for (const quiet of [
    { status: "partial", last_error: { code: "repository_changed", message: "m" } },
    { status: "submitted", receipt_comment: null },
    { status: "complete" },
    { status: "blocked", withdrawn: true, last_error: { code: "operation_failed", message: "m" } },
  ])
    assert.deepEqual(hostedIntakeAttention(fact(quiet)), [], JSON.stringify(quiet));
  assert.equal(
    hostedIntakeSummary(fact({ withdrawn: true, status: "partial", superseded_by: [12] })),
    "withdrawn; partial; 2 candidates: 2 delivered, 0 existing, 0 held, 0 pending; superseded by 12; issues #200, #201",
  );
  assert.equal(hostedIntakeSummary(undefined), null);
});
