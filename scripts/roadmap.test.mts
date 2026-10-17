import type { RoadmapIssueItem } from "./roadmap.mts";
import { validateApproval706 } from "./linux-beta-risk-706.mts";
import type { GitHubRunner } from "./github-api.mts";
import type { SetManyClient, SetManyAssignment } from "./roadmap.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { createGitHubRunner } from "./github-api.mts";

import {
  RoadmapClient,
  roadmapCommandHelp,
  deliveryMode,
  analyzeReleaseReadiness,
  renderReadinessSummary,
  catalogQualificationSummary,
  completionEvidenceLinks,
  dependencyCycles,
  executeSetMany,
  executeCommitmentRename,
  executionSnapshot,
  validateExecutionSnapshot,
  normalizeRequirements,
  compareExecutionSnapshots,
  deriveExecutionContext,
  coordinationTarget,
  readOperationalBoard,
  parseOperationalBoard,
  parseRunnerCheckpoint,
  operationalChanges,
  operationalBaseline,
  operationalEnvelope,
  bindOperationalAssignment,
  prepareOperationalCheckpoint,
  prepareOperationalConsumption,
  prepareOperationalOffer,
  prepareOperationalReturn,
  prepareOperationalReturnAcceptance,
  prepareOperationalReleaseEvidence,
  readOperationalReturnEvidence,
  prepareConsumption,
  parseConsumptionRecord,
  consumedReference,
  executeConsumption,
  executionQueueData,
  consumptionEnvelope,
  fieldValue,
  featureIntakeFields,
  findPortIssueDuplicates,
  materializeViews,
  manualUiChecklist,
  maximumMutationChunkAssignments,
  normalizePortKey,
  parseArguments,
  parsePortIssueForm,
  planFieldReconciliation,
  planPortStageReconciliation,
  planViewReconciliation,
  portFieldInitialization,
  projectMachineDrift,
  qualifiedPlatforms,
  reconcilePortIssueMarkers,
  renderPortIssueBody,
  renderSnapshot,
  renderExecutionQueue,
  resolveSnapshotOutput,
  selectNextItems,
  setManyRequiredReserve,
  uxAuditOriginIds,
  uxAuditOrigins,
  validateConfig,
  validateDurableIssueBody,
  validatePlanOriginCoverage,
  validatePortIssueCoverage,
  validatePortStageSemantics,
  validateSetManySpec,
  validateUxAuditOriginCoverage,
  viewMachineDrift,
} from "./roadmap.mts";

interface RunnerCall {
  args: readonly string[];
  input?: string | undefined;
}
function fixtureValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "expected present fixture value");
  return value;
}
function fixtureFind<T>(values: readonly T[], predicate: (value: T) => boolean): T {
  return fixtureValue(values.find(predicate));
}
function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `expected fixture element ${index}`);
  return value;
}
function fixtureObject(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected a structured fixture boundary value");
  return value;
}
function fixtureJsonObject(input: unknown) {
  assert.ok(typeof input === "string", "expected serialized fixture input");
  const value: unknown = JSON.parse(input);
  return fixtureObject(value);
}
function fixtureSelectInput(value: unknown) {
  const input = fixtureObject(value);
  const selected = fixtureObject(input.value);
  assert.ok(typeof input.fieldId === "string" && typeof selected.singleSelectOptionId === "string");
  return { fieldId: input.fieldId, value: { singleSelectOptionId: selected.singleSelectOptionId } };
}
function fixtureGraphql(input: unknown) {
  const value = fixtureJsonObject(input);
  assert.ok(typeof value.query === "string" && isRecord(value.variables));
  return { query: value.query, variables: value.variables };
}
const config = validateConfig(
  JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const newPortForm = await readFile(
  new URL("../.github/ISSUE_TEMPLATE/new-port.yml", import.meta.url),
  "utf8",
);

type PickupItem = Parameters<typeof deriveExecutionContext>[1];
type PickupRelationships = Parameters<typeof deriveExecutionContext>[2];
type PickupOptions = Parameters<typeof deriveExecutionContext>[3];
const pickupIssue = (
  number = 1104,
  body = "## Acceptance\n- [ ] Preserve recovery.",
): PickupItem => ({
  id: `item-${number}`,
  status: "Ready",
  priority: "High",
  horizon: "Next",
  "release commitment": "Planned",
  "target release": "1.0",
  content: {
    id: `issue-${number}`,
    number,
    title: `Outcome ${number}`,
    body,
    state: "OPEN",
    url: `https://github.com/${config.repository}/issues/${number}`,
  },
});
const pickupRelations = (): PickupRelationships => ({
  parent: null,
  subIssues: [],
  blockedBy: [],
  blocking: [],
});
type ContextFixture = ReturnType<typeof deriveExecutionContext> & {
  operational_baseline?: ReturnType<typeof operationalBaseline>;
  operational_binding?: NonNullable<ReturnType<typeof bindOperationalAssignment>>;
};
const pickupContext = (
  item = pickupIssue(),
  relationships = pickupRelations(),
  options: Partial<PickupOptions> = {},
): ContextFixture =>
  deriveExecutionContext(config, item, relationships, {
    runner: "Local",
    comments: [],
    coverage: { complete: false, count: 50, total: 2200 },
    ...options,
  });
const acknowledgment = (context = pickupContext(), runner = "Local") =>
  prepareConsumption(
    context,
    {
      runner,
      action: "Compared acceptance; continue owned task",
      evidence: "https://github.com/boburning/portcove/pull/1",
    },
    [],
  );
const acknowledgmentComment = (context = pickupContext(), runner = "Local") => ({
  id: 1,
  body: acknowledgment(context, runner).body,
  url: `${context.coordination_target.url}#issuecomment-1`,
  author: { login: "recorder" },
});

function operationalFixture() {
  const lanes = ["cloud-a", "cloud-b", "local"] as const;
  const configured = {
    ...config,
    delivery_mode: "coordinated",
    runner_coordination: {
      schema_version: 1,
      board_issue: 1800,
      coordinator_github_login: "boburning",
      coordinator_github_id: 43177418,
      coordinator_instance_id: "dot-fixture-1",
      durable_writer_mode: "coordinator-only",
      checkpoint_comment_ids: { "cloud-a": 101, "cloud-b": 102, local: 103 },
    },
  };
  const board: ReturnType<typeof parseOperationalBoard> = {
    repository: config.repository,
    protocol_revision: 1,
    cutover_state: "staged",
    coordinator_instance_id: "dot-fixture-1",
    assignment_generation: 1,
    checkpoint_pointers: configured.runner_coordination.checkpoint_comment_ids,
    pending_transfers: [],
    assignments: lanes.map((lane, index) => ({
      lane,
      runner_instance_id: `fixture-${lane}`,
      assignment_id: `fixture-task-${index + 1}`,
      generation: 1,
      owning_issue: 1104,
      pr_and_source: "PR1543 private fixture source",
      reserved_scope: "fixture only",
      intentional_pause: false,
      execution_slot: "active",
      accepted_ack: {
        request_id: `fixture-request-${index + 1}`,
        observed_ack_reference: `https://github.com/${config.repository}/issues/1104#issuecomment-${index + 1}`,
      },
    })),
  };
  const format = (kind: string, value: unknown) =>
    `<!-- portcove-${kind}:v1 -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  const issueUrl = `https://github.com/${config.repository}/issues/1800`;
  const records: Record<
    string,
    {
      number?: number;
      id?: number;
      html_url: string;
      comments?: number;
      user: { login: string; id: number };
      updated_at: string;
      body: string;
      issue_url?: string;
    }
  > = {};
  records[`repos/${config.repository}/issues/1800`] = {
    number: 1800,
    html_url: issueUrl,
    comments: 3,
    user: { login: "boburning", id: 43177418 },
    updated_at: "2026-10-06T16:00:00Z",
    body: format("runner-board", board),
  };
  const checkpoints: Partial<
    Record<(typeof lanes)[number], ReturnType<typeof parseRunnerCheckpoint>>
  > = {};
  for (const [index, lane] of lanes.entries()) {
    const assignment = board.assignments[index];
    assert.ok(assignment);
    const checkpoint: ReturnType<typeof parseRunnerCheckpoint> = {
      lane,
      runner_instance_id: assignment.runner_instance_id,
      assignment_id: assignment.assignment_id,
      assignment_generation: 1,
      owning_task: 1104,
      pr_and_source: "PR1543 fixture source",
      execution_phase: "fixture development",
      last_meaningful_progress: { at: "2026-10-06T15:00:00Z", summary: "Fixture only" },
      next_action: "Fixture check",
      outstanding_requests: [
        {
          request_id: `fixture-handoff-${index + 1}`,
          recipient_instance_or_coordinator: "dot-fixture-1",
          acknowledgment_state: "pending",
          disposition_reference: null,
        },
      ],
      necessary_evidence_pointers: [],
    };
    checkpoints[lane] = checkpoint;
    const id = configured.runner_coordination.checkpoint_comment_ids[lane];
    records[`repos/${config.repository}/issues/comments/${id}`] = {
      id,
      html_url: `${issueUrl}#issuecomment-${id}`,
      issue_url: `https://api.github.com/repos/${config.repository}/issues/1800`,
      user: { login: "boburning", id: 43177418 },
      updated_at: "2026-10-06T16:00:00Z",
      body: format("runner-checkpoint", checkpoint),
    };
  }
  const calls: { method: string; endpoint: string; options: { timeoutMs: number } }[] = [];
  const api = {
    request(method: string, endpoint: string, _body: unknown, options: { timeoutMs: number }) {
      calls.push({ method, endpoint, options });
      assert.equal(method, "GET");
      const record = records[endpoint];
      assert.ok(record, "only fixed endpoints allowed");
      return { body: record };
    },
  };
  return { configured, board, checkpoints, records, format, api, calls };
}

function observedBoard(...args: Parameters<typeof readOperationalBoard>) {
  const snapshot = readOperationalBoard(...args);
  assert.ok(
    snapshot.status === "observed" || snapshot.status === "staged",
    "expected available operational fixture",
  );
  return snapshot;
}
function observedSnapshot(snapshot: ReturnType<typeof readOperationalBoard>) {
  assert.ok(
    snapshot.status === "observed" || snapshot.status === "staged",
    "expected observed fixture snapshot",
  );
  return snapshot;
}
function fixtureBinding(...args: Parameters<typeof bindOperationalAssignment>) {
  const binding = bindOperationalAssignment(...args);
  assert.ok(binding, "expected coordinated fixture binding");
  return binding;
}
function checkpointPlan<T extends object>(value: T) {
  assert.ok("body" in value && typeof value.body === "string");
  assert.ok("writer_mode" in value && value.writer_mode === "coordinator-only");
  return { ...value, body: value.body, writer_mode: value.writer_mode };
}
function fixtureRecord(
  fixture: Pick<ReturnType<typeof operationalFixture>, "records">,
  endpoint: string,
) {
  const record = fixture.records[endpoint];
  assert.ok(record, `expected fixed fixture record ${endpoint}`);
  return record;
}
function fixtureCheckpoint(
  value: {
    checkpoints: Partial<
      Record<"cloud-a" | "cloud-b" | "local", ReturnType<typeof parseRunnerCheckpoint>>
    >;
  },
  lane: "cloud-a" | "cloud-b" | "local",
) {
  const checkpoint = value.checkpoints[lane];
  assert.ok(checkpoint, `expected fixture checkpoint ${lane}`);
  return checkpoint;
}
function fixtureAssignment(board: ReturnType<typeof parseOperationalBoard>, index: number) {
  const assignment = board.assignments[index];
  assert.ok(assignment, `expected fixture assignment ${index}`);
  return assignment;
}
function fixtureObservation(
  value: { observations: NonNullable<ReturnType<typeof operationalBaseline>>["observations"] },
  index: number,
) {
  const observation = value.observations[index];
  assert.ok(observation, `expected fixture observation ${index}`);
  return observation;
}
function fixtureRequest(checkpoint: ReturnType<typeof parseRunnerCheckpoint>, index: number) {
  const request = checkpoint.outstanding_requests[index];
  assert.ok(request, `expected fixture request ${index}`);
  return request;
}
function measuredEnvelope(...args: Parameters<typeof operationalEnvelope>) {
  const envelope = operationalEnvelope(...args);
  assert.ok("operational_metrics" in envelope && envelope.operational_metrics);
  return { ...envelope, operational_metrics: envelope.operational_metrics };
}

void test("ordinary operational snapshot reads exactly four fixed records and measures final model envelope", () => {
  const fixture = operationalFixture();
  const snapshot = observedBoard(fixture.configured, fixture.api);
  assert.equal(snapshot.status, "staged");
  assert.equal(fixture.calls.length, 4);
  assert.ok(
    fixture.calls.every(({ endpoint }) => !endpoint.includes("793") && !endpoint.includes("?")),
  );
  assert.equal(
    fixtureRequest(fixtureCheckpoint(snapshot, "cloud-a"), 0).acknowledgment_state,
    "pending",
  );
  const envelope = measuredEnvelope(snapshot);
  assert.equal(
    envelope.operational_metrics.model_facing_bytes,
    Buffer.byteLength(JSON.stringify(envelope), "utf8"),
  );
  assert.match(envelope.operational_metrics.estimate_method, /not billed/);
});

void test("edited fixed checkpoints change raw identity while quiet reads never mutate progress", () => {
  const fixture = operationalFixture();
  const first = observedBoard(fixture.configured, fixture.api);
  const endpoint = `repos/${config.repository}/issues/comments/101`;
  const original = fixtureRecord(fixture, endpoint).body;
  fixtureRecord(fixture, endpoint).body = fixture.format("runner-checkpoint", {
    ...fixtureCheckpoint(fixture, "cloud-a"),
    next_action: "A changed action",
  });
  const changed = observedBoard(fixture.configured, fixture.api);
  assert.notEqual(
    fixtureObservation(first, 1).raw_revision,
    fixtureObservation(changed, 1).raw_revision,
  );
  const delta = operationalChanges(changed, operationalBaseline(first));
  assert.ok(delta.state === "changed");
  assert.equal(delta.original_evidence_manifest, changed.original_evidence_manifest);
  assert.equal(
    measuredEnvelope(changed, operationalBaseline(first)).operational_snapshot
      .original_evidence_manifest,
    changed.original_evidence_manifest,
  );
  assert.equal(delta.board, null);
  assert.deepEqual(Object.keys(delta.checkpoints), ["cloud-a"]);
  assert.deepEqual(
    fixtureCheckpoint(first, "cloud-a").last_meaningful_progress,
    fixtureCheckpoint(changed, "cloud-a").last_meaningful_progress,
  );
  const quiet = observedBoard(fixture.configured, fixture.api);
  assert.deepEqual(
    { ...changed, original_evidence_manifest: null },
    { ...quiet, original_evidence_manifest: null },
  );
  const quietDelta = operationalChanges(quiet, operationalBaseline(changed));
  assert.ok(quietDelta.state === "unchanged");
  assert.equal(quietDelta.snapshot, undefined);
  assert.notEqual(original, fixtureRecord(fixture, endpoint).body);
  assert.ok(fixture.calls.every(({ method }) => method === "GET"));
});

void test("timestamp-only fixed checkpoint edits are detected and invalid baselines cannot suppress state", () => {
  const fixture = operationalFixture();
  const first = observedBoard(fixture.configured, fixture.api);
  fixtureRecord(fixture, `repos/${config.repository}/issues/comments/101`).updated_at =
    "2026-10-06T16:01:00Z";
  const edited = observedBoard(fixture.configured, fixture.api);
  assert.equal(
    fixtureObservation(first, 1).raw_revision,
    fixtureObservation(edited, 1).raw_revision,
  );
  const delta = operationalChanges(edited, operationalBaseline(first));
  assert.ok(delta.state === "changed");
  assert.deepEqual(Object.keys(delta.checkpoints), ["cloud-a"]);
  assert.deepEqual(
    fixtureCheckpoint(first, "cloud-a").last_meaningful_progress,
    fixtureCheckpoint(edited, "cloud-a").last_meaningful_progress,
  );
  type BaselineFixture = Omit<
    NonNullable<ReturnType<typeof operationalBaseline>>,
    "schema_version" | "status"
  > & { schema_version: number; status: string };
  for (const mutate of [
    (baseline: BaselineFixture) => (baseline.schema_version = 2),
    (baseline: BaselineFixture) => (baseline.status = "unknown"),
    (baseline: BaselineFixture) => (baseline.coordinator_instance_id = "another-coordinator"),
    (baseline: BaselineFixture) => (baseline.assignment_generation = 2),
    (baseline: BaselineFixture) => (baseline.assignment_binding_revision = "0".repeat(64)),
    (baseline: BaselineFixture) => baseline.observations.reverse(),
    (baseline: BaselineFixture) => (fixtureObservation(baseline, 0).raw_revision = "invalid"),
    (baseline: BaselineFixture) => (fixtureObservation(baseline, 0).edited_at = "invalid"),
  ]) {
    const baseline = structuredClone(operationalBaseline(edited));
    assert.ok(baseline);
    mutate(baseline);
    assert.equal(operationalChanges(edited, baseline).state, "baseline_unavailable");
  }
});

void test("the actual subprocess runner clips its request timeout to the remaining monotonic budget", () => {
  const fixture = operationalFixture();
  let time = 0;
  const timeouts: number[] = [];
  const client = new RoadmapClient(fixture.configured);
  const snapshot = client.operationalSnapshot({
    now: () => time,
    runnerFactory: (options) => {
      assert.ok(options && typeof options.timeoutMs === "number");
      timeouts.push(options.timeoutMs);
      return (args: readonly string[]) => {
        const endpoint = args[args.indexOf("--include") + 1];
        assert.ok(endpoint);
        time += timeouts.length === 3 ? 29_500 : 15_000;
        return `HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(fixtureRecord(fixture, endpoint))}`;
      };
    },
  });
  assert.deepEqual(timeouts, [15_000, 15_000, 15_000, 500]);
  assert.equal(snapshot.status, "unknown");
});

void test("fresh changed and unchanged coordination envelopes include metadata in their measured ceiling", () => {
  const fixture = operationalFixture();
  const snapshot = observedBoard(fixture.configured, fixture.api);
  const baseline = operationalBaseline(snapshot);
  assert.ok(baseline);
  for (const old of [
    null,
    baseline,
    {
      ...baseline,
      observations: baseline.observations.map((record, index) =>
        index === 1 ? { ...record, edited_at: "2026-10-06T15:59:00Z" } : record,
      ),
    },
  ]) {
    const envelope = measuredEnvelope(snapshot, old);
    assert.equal(
      envelope.operational_metrics.model_facing_bytes,
      Buffer.byteLength(JSON.stringify(envelope), "utf8"),
    );
    const oversized = structuredClone(snapshot);
    oversized.authority_limit = "x".repeat(12_000);
    assert.throws(() => operationalEnvelope(oversized, old), /oversized/);
  }
  for (let size = 0; size < 1000; size++) {
    const padded = structuredClone(snapshot);
    padded.authority_limit = "x".repeat(size);
    const envelope = measuredEnvelope(padded);
    assert.equal(
      envelope.operational_metrics.model_facing_bytes,
      Buffer.byteLength(JSON.stringify(envelope), "utf8"),
    );
    assert.equal(typeof envelope.operational_metrics.over_design_target, "number");
  }
});

void test("missing, oversized, malformed, stale and unavailable operational state stays unknown without fallback", () => {
  const missing = operationalFixture();
  // @ts-expect-error Missing configured issue identity is deliberate malformed input.
  missing.configured.runner_coordination.board_issue = null;
  assert.equal(readOperationalBoard(missing.configured, missing.api).status, "unknown");
  assert.equal(missing.calls.length, 0);
  for (const replacement of ["not a board", "x".repeat(8193)]) {
    const fixture = operationalFixture();
    fixtureRecord(fixture, `repos/${config.repository}/issues/1800`).body = replacement;
    const result = readOperationalBoard(fixture.configured, fixture.api);
    assert.equal(result.status, "unknown");
    assert.equal(result.state, null);
    assert.match(result.authority_limit, /not unowned/);
  }
  const stale = operationalFixture();
  fixtureRecord(stale, `repos/${config.repository}/issues/comments/101`).body = stale.format(
    "runner-checkpoint",
    {
      ...fixtureCheckpoint(stale, "cloud-a"),
      assignment_generation: 2,
    },
  );
  assert.equal(readOperationalBoard(stale.configured, stale.api).status, "unknown");
  const inaccessible = operationalFixture();
  inaccessible.api.request = () => {
    throw Error("unavailable observation");
  };
  assert.equal(readOperationalBoard(inaccessible.configured, inaccessible.api).status, "unknown");
  const expired = operationalFixture();
  let time = 0;
  const result = readOperationalBoard(expired.configured, expired.api, {
    now: () => (time += 20000),
  });
  assert.equal(result.status, "unknown");
  assert.ok(expired.calls.length < 4);
});

void test("operational observations reject coerced timestamps at issue and checkpoint boundaries", () => {
  for (const endpoint of [
    `repos/${config.repository}/issues/1800`,
    `repos/${config.repository}/issues/comments/101`,
  ]) {
    for (const timestamp of [0, ["2026-10-06T16:00:00Z"]]) {
      const fixture = operationalFixture();
      // @ts-expect-error Coercible nonstring timestamps must reach the runtime validator.
      fixtureRecord(fixture, endpoint).updated_at = timestamp;
      const result = readOperationalBoard(fixture.configured, fixture.api);
      assert.equal(result.status, "unknown");
      assert.equal(result.state, null);
      assert.ok(result.original_evidence_manifest);
    }
  }
});

void test("conflicting assignments and malformed outstanding requests refuse interpretation", () => {
  const fixture = operationalFixture();
  const duplicate = {
    ...fixture.board,
    assignments: [...fixture.board.assignments, fixtureAssignment(fixture.board, 0)],
  };
  assert.throws(
    () => parseOperationalBoard(fixture.format("runner-board", duplicate), fixture.configured),
    /conflicting/,
  );
  const request = fixtureCheckpoint(fixture, "cloud-a").outstanding_requests[0];
  const checkpoint = {
    ...fixtureCheckpoint(fixture, "cloud-a"),
    outstanding_requests: [request, request],
  };
  assert.throws(
    () =>
      parseRunnerCheckpoint(
        fixture.format("runner-checkpoint", checkpoint),
        "cloud-a",
        fixture.board,
      ),
    /ambiguous/,
  );
});

void test("completed assignments retain their accepted checkpoint and release evidence without an active scope", () => {
  const fixture = operationalFixture();
  const assignment = fixtureAssignment(fixture.board, 1);
  const accepted = structuredClone(assignment.accepted_ack);
  assignment.execution_slot = "completed";
  assignment.reserved_scope = null;
  assignment.released_reference = `https://github.com/${config.repository}/issues/1104#issuecomment-6021341506`;
  const checkpoint = fixtureCheckpoint(fixture, "cloud-b");
  checkpoint.execution_phase = "completed";
  checkpoint.necessary_evidence_pointers = ["issue1104#issuecomment-6021341506"];
  fixtureRecord(fixture, `repos/${config.repository}/issues/1800`).body = fixture.format(
    "runner-board",
    fixture.board,
  );
  fixtureRecord(fixture, `repos/${config.repository}/issues/comments/102`).body = fixture.format(
    "runner-checkpoint",
    checkpoint,
  );
  const snapshot = observedBoard(fixture.configured, fixture.api);
  assert.equal(snapshot.status, "staged");
  assert.deepEqual(fixtureAssignment(snapshot.board, 1).accepted_ack, accepted);
  assert.equal(fixtureCheckpoint(snapshot, "cloud-b").assignment_id, assignment.assignment_id);
  const binding = fixtureBinding(snapshot, "fixture-cloud-b", 1104);
  assert.equal(binding.execution_slot, "completed");
  assert.equal(binding.reserved_scope, null);
  assert.equal(binding.released_reference, assignment.released_reference);
  const output = measuredEnvelope(snapshot, null, binding);
  assert.ok("details" in output.operational_snapshot);
  assert.ok(output.operational_binding);
  assert.match(output.operational_snapshot.details, /Scope: none; assignment released/);
  assert.match(output.operational_snapshot.details, /Release: https:\/\/github.com/);
  assert.equal(output.operational_binding.released_reference, assignment.released_reference);
  const retainedWaiting = {
    ...assignment,
    assignment_id: "retained-frozen-assignment",
    owning_issue: 1550,
    execution_slot: "reviewed_waiting",
    reserved_scope: "four frozen query paths",
    released_reference: undefined,
  };
  const withWaiting = {
    ...fixture.board,
    assignments: [...fixture.board.assignments, retainedWaiting],
  };
  const preserved = parseOperationalBoard(
    fixture.format("runner-board", withWaiting),
    fixture.configured,
  );
  assert.equal(preserved.assignments.at(-1)?.reserved_scope, "four frozen query paths");
  assert.equal(
    parseRunnerCheckpoint(fixture.format("runner-checkpoint", checkpoint), "cloud-b", preserved)
      .assignment_id,
    assignment.assignment_id,
  );
  const revisedRelease = structuredClone(snapshot);
  fixtureAssignment(revisedRelease.board, 1).released_reference =
    "issue1104#issuecomment-6021341507";
  assert.equal(
    operationalChanges(revisedRelease, operationalBaseline(snapshot)).state,
    "baseline_unavailable",
  );
  const context = pickupContext(pickupIssue(), pickupRelations(), { runner: "fixture-cloud-b" });
  context.operational_baseline = operationalBaseline(snapshot);
  context.operational_binding = binding;
  assert.throws(
    () =>
      prepareOperationalConsumption({
        client: {
          operationalSnapshot: () => snapshot,
          executionIssue: () =>
            assert.fail("completed assignment must fail before requirements read"),
        },
        config: fixture.configured,
        context,
        runner: "fixture-cloud-b",
        action: "Start another task",
        evidence: assignment.released_reference,
      }),
    /no active reservation/,
  );
  for (const patch of [
    { reserved_scope: "old active scope" },
    { reserved_scope: "" },
    { released_reference: null },
    { released_reference: "issue314#issuecomment-6021341506" },
    { intentional_pause: true },
  ]) {
    const board = structuredClone(fixture.board);
    Object.assign(fixtureAssignment(board, 1), patch);
    assert.throws(
      () => parseOperationalBoard(fixture.format("runner-board", board), fixture.configured),
      /conflicting/,
    );
  }
  for (const patch of [
    { assignment_generation: 2 },
    { assignment_id: "previous-assignment" },
    { runner_instance_id: "previous-instance" },
    { execution_phase: "active" },
    { necessary_evidence_pointers: [] },
  ]) {
    assert.throws(
      () =>
        parseRunnerCheckpoint(
          fixture.format("runner-checkpoint", { ...checkpoint, ...patch }),
          "cloud-b",
          fixture.board,
        ),
      /stale|conflicts|delivered phase/,
    );
  }
  const active = {
    ...assignment,
    assignment_id: "successor-not-yet-accepted",
    execution_slot: "active",
    reserved_scope: "new scope",
    released_reference: undefined,
  };
  for (const records of [
    [assignment, active],
    [active, assignment],
    [assignment, { ...assignment, assignment_id: "duplicate-completed" }],
  ]) {
    const board = {
      ...fixture.board,
      assignments: [
        fixtureAssignment(fixture.board, 0),
        ...records,
        fixtureAssignment(fixture.board, 2),
      ],
    };
    assert.throws(
      () => parseOperationalBoard(fixture.format("runner-board", board), fixture.configured),
      /conflicting/,
    );
  }
  const missingRelease = structuredClone(fixture.board);
  delete fixtureAssignment(missingRelease, 1).released_reference;
  fixtureRecord(fixture, `repos/${config.repository}/issues/1800`).body = fixture.format(
    "runner-board",
    missingRelease,
  );
  assert.equal(readOperationalBoard(fixture.configured, fixture.api).status, "unknown");
});

void test("task instance binding and fixed checkpoint planning preserve unresolved requests and preimages", () => {
  const fixture = operationalFixture();
  const snapshot = observedBoard(fixture.configured, fixture.api);
  const binding = bindOperationalAssignment(snapshot, "fixture-cloud-a", 1104);
  assert.ok(binding);
  assert.equal(binding.assignment_id, "fixture-task-1");
  assert.throws(() => bindOperationalAssignment(snapshot, "unknown-instance", 1104), /exactly one/);
  assert.throws(() => bindOperationalAssignment(snapshot, "fixture-cloud-a", 1550), /exactly one/);
  const original = fixtureCheckpoint(snapshot, "cloud-a");
  const expected = snapshot.observations[1];
  const plan = prepareOperationalCheckpoint(
    fixture.configured,
    snapshot,
    "cloud-a",
    original,
    expected,
  );
  assert.equal(plan.status, "planned");
  assert.equal(plan.writer_mode, "coordinator-only");
  assert.throws(
    () =>
      prepareOperationalCheckpoint(
        fixture.configured,
        snapshot,
        "cloud-a",
        { ...original, outstanding_requests: [] },
        expected,
      ),
    /cannot disappear/,
  );
  const resolution = {
    request_id: fixtureRequest(original, 0).request_id,
    recipient_instance_or_coordinator: fixtureRequest(original, 0)
      .recipient_instance_or_coordinator,
    disposition: "cancelled",
    observed_response_reference: "PR1543#issuecomment-6020220069",
  };
  assert.equal(
    prepareOperationalCheckpoint(
      fixture.configured,
      snapshot,
      "cloud-a",
      { ...original, outstanding_requests: [] },
      expected,
      [resolution],
    ).status,
    "planned",
  );
  assert.throws(
    () =>
      prepareOperationalCheckpoint(
        fixture.configured,
        snapshot,
        "cloud-a",
        { ...original, outstanding_requests: [] },
        expected,
        [{ ...resolution, observed_response_reference: null }],
      ),
    /resolution/,
  );
  assert.throws(
    () =>
      prepareOperationalCheckpoint(fixture.configured, snapshot, "cloud-a", original, {
        ...expected,
        edited_at: "2026-10-06T16:01:00Z",
      }),
    /preimage changed/,
  );
  assert.throws(
    () =>
      prepareOperationalCheckpoint(
        fixture.configured,
        snapshot,
        "cloud-a",
        { ...original, owning_task: 1550 },
        expected,
      ),
    /conflicts/,
  );
  const request = original.outstanding_requests[0];
  assert.throws(
    () =>
      prepareOperationalCheckpoint(
        fixture.configured,
        snapshot,
        "cloud-a",
        {
          ...original,
          outstanding_requests: [
            { ...request, recipient_instance_or_coordinator: "another-instance" },
          ],
        },
        expected,
      ),
    /change recipient/,
  );
  const acknowledged = {
    ...original,
    outstanding_requests: [
      {
        ...request,
        acknowledgment_state: "acknowledged",
        disposition_reference: "PR1543#issuecomment-6020220069",
      },
    ],
  };
  assert.equal(
    prepareOperationalCheckpoint(fixture.configured, snapshot, "cloud-a", acknowledged, expected)
      .status,
    "planned",
  );
  const missing = structuredClone(fixture.board);
  // @ts-expect-error Required reservation intentionally removed from external board JSON.
  delete fixtureAssignment(missing, 0).reserved_scope;
  assert.throws(
    () => parseOperationalBoard(fixture.format("runner-board", missing), fixture.configured),
    /conflicting/,
  );
  const substituted = structuredClone(fixture.board);
  substituted.assignments.push({
    ...fixtureAssignment(substituted, 0),
    assignment_id: "waiting-assignment",
    runner_instance_id: "substituted-instance",
    execution_slot: "reviewed_waiting",
  });
  assert.throws(
    () => parseOperationalBoard(fixture.format("runner-board", substituted), fixture.configured),
    /conflicting/,
  );
  fixtureRecord(fixture, `repos/${config.repository}/issues/comments/101`).user.id = 1;
  assert.equal(readOperationalBoard(fixture.configured, fixture.api).status, "unknown");
});

function handoffFixture() {
  const fixture = operationalFixture();
  const snapshot = observedBoard(fixture.configured, fixture.api);
  const spec = {
    request_id: "finite-offer",
    runner_instance_id: "fixture-cloud-a",
    assignment_id: "next-bounded-task",
    generation: 2,
    owning_issue: 1104,
    source: "a".repeat(40),
    scope: "scripts/roadmap.mts and roadmap.test.mts; existing fixtures only",
    outcome: "Preserve an actual bounded acknowledgment return",
    evidence: "issue1104#issuecomment-20",
  };
  const offer = checkpointPlan(
    prepareOperationalOffer({ config: fixture.configured, snapshot, spec }),
  );
  const checkpoint = parseRunnerCheckpoint(offer.body, "cloud-a", snapshot.board);
  fixtureRecord(fixture, `repos/${config.repository}/issues/comments/101`).body = fixture.format(
    "runner-checkpoint",
    checkpoint,
  );
  const current = () => readOperationalBoard(fixture.configured, fixture.api);
  const receipt = prepareOperationalReturn({
    config: fixture.configured,
    snapshot: current(),
    offer: offer.offer,
    runner: spec.runner_instance_id,
    source: spec.source,
    disposition: "accepted",
    evidence: "issue1104#issuecomment-21",
    evidenceObservation: {
      url: "issue1104#issuecomment-21",
      body_sha256: "b".repeat(64),
      edited_at: "2026-10-07T03:00:00Z",
    },
  });
  assert.ok(receipt.receipt.evidence_observation);
  return {
    ...fixture,
    spec,
    offer,
    receipt: {
      ...receipt,
      receipt: { ...receipt.receipt, evidence_observation: receipt.receipt.evidence_observation },
    },
    current,
  };
}

void test("offer and exact release evidence reject coercible scalar metadata", () => {
  const fixture = operationalFixture();
  const snapshot = observedBoard(fixture.configured, fixture.api);
  const spec = handoffFixture().spec;
  assert.throws(
    () =>
      prepareOperationalOffer({
        config: fixture.configured,
        snapshot,
        spec: { ...spec, source: [spec.source] },
      }),
    /malformed/,
  );
  const pr = {
    number: 1543,
    html_url: `https://github.com/${config.repository}/pull/1543`,
    head: { sha: spec.source },
    merged: false,
    merge_commit_sha: null,
    updated_at: "2026-10-07T03:00:00Z",
    body: "## Linked issue\nRefs #1104.",
  };
  for (const timestamp of [0, [pr.updated_at]]) {
    assert.throws(
      () =>
        prepareOperationalReleaseEvidence({
          config: fixture.configured,
          snapshot,
          runner: spec.runner_instance_id,
          source: spec.source,
          pullRequest: { ...pr, updated_at: timestamp },
        }),
      /unavailable/,
    );
    const url = `https://github.com/${config.repository}/issues/1104#issuecomment-21`;
    const api = {
      request: () => ({
        body: {
          id: 21,
          html_url: url,
          issue_url: `https://api.github.com/repos/${config.repository}/issues/1104`,
          body: "retained exact evidence",
          updated_at: timestamp,
        },
      }),
    };
    assert.throws(
      () => readOperationalReturnEvidence(fixture.configured, api, url, 1104, spec.source),
      /timestamp.*unavailable/,
    );
  }
});

void test("bounded offers preserve the accepted assignment and reject altered or superseded proposals", () => {
  const f = handoffFixture();
  assert.equal(f.offer.writer_mode, "coordinator-only");
  assert.equal(f.receipt.status, "pending");
  assert.deepEqual(observedSnapshot(f.current()).board, observedBoard(f.configured, f.api).board);
  assert.equal(
    prepareOperationalOffer({ config: f.configured, snapshot: f.current(), spec: f.spec }).status,
    "quiet",
  );
  for (const delta of [
    { source: "b".repeat(40) },
    { scope: "extra product boundary" },
    { evidence: "issue1104#issuecomment-22" },
    { generation: 3 },
  ]) {
    assert.throws(
      () =>
        prepareOperationalOffer({
          config: f.configured,
          snapshot: f.current(),
          spec: { ...f.spec, ...delta },
        }),
      /changed|conflict/,
    );
  }
  for (const delta of [{ runner: "other-instance" }, { source: "b".repeat(40) }]) {
    assert.throws(
      () =>
        prepareOperationalReturn({
          config: f.configured,
          snapshot: f.current(),
          offer: f.offer.offer,
          runner: f.spec.runner_instance_id,
          source: f.spec.source,
          disposition: "accepted",
          evidence: "issue1104#issuecomment-21",
          ...delta,
        }),
      /identity|source/,
    );
  }
  const stale = observedSnapshot(f.current());
  fixtureAssignment(stale.board, 0).generation++;
  assert.throws(
    () =>
      prepareOperationalReturn({
        config: f.configured,
        snapshot: stale,
        offer: f.offer.offer,
        runner: f.spec.runner_instance_id,
        source: f.spec.source,
        disposition: "accepted",
        evidence: "issue1104#issuecomment-21",
      }),
    /superseded|generation/,
  );
});

void test("worker receipts cannot authenticate themselves and preserve unavailable delivery as unknown", () => {
  const f = handoffFixture();
  const input = {
    config: f.configured,
    snapshot: f.current(),
    offer: f.offer.offer,
    receipt: { ...f.receipt.receipt, verified: true, github_author: "boburning" },
  };
  const unknown = prepareOperationalReturnAcceptance(input);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.acknowledged, false);
  assert.equal(
    prepareOperationalReturnAcceptance({ ...input, verifyDelivery: () => null }).status,
    "unknown",
  );
  assert.throws(
    () =>
      prepareOperationalReturnAcceptance({
        ...input,
        readEvidence: () => f.receipt.receipt.evidence_observation,
        verifyDelivery: () => ({ status: "established", runner_instance_id: "other-instance" }),
      }),
    /delivery|identity/,
  );
  assert.throws(
    () => prepareOperationalReturnAcceptance({ ...input, apply: true }),
    /coordinator-only/,
  );
});

void test("independently established returns preserve other requests and refuse conflicting replay", () => {
  const f = handoffFixture();
  const verifyDelivery: NonNullable<
    Parameters<typeof prepareOperationalReturnAcceptance>[0]["verifyDelivery"]
  > = ({ receipt }) => ({
    status: "established",
    runner_instance_id: f.spec.runner_instance_id,
    request_id: f.spec.request_id,
    receipt_digest: receipt.receipt_digest,
    observed_response_reference: receipt.evidence,
    invocation_reference: "fixture native role-bearing response; not production proof",
  });
  const readEvidence = () => f.receipt.receipt.evidence_observation;
  const input = {
    config: f.configured,
    snapshot: f.current(),
    offer: f.offer.offer,
    receipt: f.receipt.receipt,
    verifyDelivery,
    readEvidence,
  };
  const accepted = checkpointPlan(prepareOperationalReturnAcceptance(input));
  assert.equal(accepted.status, "planned");
  assert.equal(accepted.writer_mode, "coordinator-only");
  const updated = parseRunnerCheckpoint(
    accepted.body,
    "cloud-a",
    observedSnapshot(input.snapshot).board,
  );
  assert.deepEqual(
    updated.outstanding_requests[0],
    fixtureCheckpoint(f, "cloud-a").outstanding_requests[0],
  );
  assert.deepEqual(
    updated.last_meaningful_progress,
    fixtureCheckpoint(f, "cloud-a").last_meaningful_progress,
  );
  fixtureRecord(f, `repos/${config.repository}/issues/comments/101`).body = f.format(
    "runner-checkpoint",
    updated,
  );
  assert.equal(
    prepareOperationalReturnAcceptance({ ...input, snapshot: f.current() }).status,
    "quiet",
  );
  const changed = prepareOperationalReturn({
    config: f.configured,
    snapshot: f.current(),
    offer: f.offer.offer,
    runner: f.spec.runner_instance_id,
    source: f.spec.source,
    disposition: "accepted",
    evidence: "issue1104#issuecomment-22",
    evidenceObservation: {
      ...f.receipt.receipt.evidence_observation,
      url: "issue1104#issuecomment-22",
    },
  });
  assert.throws(
    () =>
      prepareOperationalReturnAcceptance({
        ...input,
        snapshot: f.current(),
        receipt: changed.receipt,
      }),
    /changed|conflict/,
  );
});

void test("pending offer evidence edits cannot acquire a worker acknowledgment", () => {
  const f = handoffFixture();
  const snapshot = observedSnapshot(f.current());
  const pendingOffer = fixtureCheckpoint(snapshot, "cloud-a").outstanding_requests.find((entry) =>
    entry.request_id.startsWith("OFFER-"),
  );
  assert.ok(pendingOffer);
  pendingOffer.disposition_reference = "issue1104#issuecomment-99";
  assert.throws(
    () =>
      prepareOperationalReturn({
        config: f.configured,
        snapshot,
        offer: f.offer.offer,
        runner: f.spec.runner_instance_id,
        source: f.spec.source,
        disposition: "accepted",
        evidence: "issue1104#issuecomment-21",
      }),
    /evidence.*changed|conflict/,
  );
});

void test("owned PR release fallback pins actual body and source and cannot authenticate itself", () => {
  const f = operationalFixture();
  const snapshot = observedBoard(f.configured, f.api);
  const pullRequest = {
    number: 1543,
    html_url: `https://github.com/${config.repository}/pull/1543`,
    head: { sha: "a".repeat(40) },
    merged: false,
    merge_commit_sha: null,
    updated_at: "2026-10-07T03:00:00Z",
    body: "## Linked issue\nRefs #1104.\n\n## Release\nRemaining delivery passes to Local after actual ACK.",
  };
  const input = {
    config: f.configured,
    snapshot,
    runner: "fixture-cloud-a",
    source: "a".repeat(40),
    pullRequest,
  };
  // @ts-expect-error Caller-supplied verification flags cannot establish delivery.
  assert.equal(prepareOperationalReleaseEvidence({ ...input, verified: true }).status, "unknown");
  const verifyDelivery: NonNullable<
    Parameters<typeof prepareOperationalReleaseEvidence>[0]["verifyDelivery"]
  > = ({ receipt }) => ({
    status: "established",
    role: "source-owner-release",
    runner_instance_id: input.runner,
    assignment_id: "fixture-task-1",
    generation: 1,
    receipt_digest: receipt.receipt_digest,
    invocation_reference: "fixture independent native release; not production",
  });
  const proof = prepareOperationalReleaseEvidence({ ...input, verifyDelivery });
  assert.equal(proof.status, "planned");
  assert.ok("reference" in proof && typeof proof.reference === "string");
  assert.match(proof.reference, /pull\/1543#body-sha256-[a-f0-9]{64}$/);
  assert.equal(proof.receipt.merged, false);
  assert.throws(
    () =>
      prepareOperationalReleaseEvidence({
        ...input,
        verifyDelivery,
        pullRequest: { ...pullRequest, head: { sha: "b".repeat(40) } },
      }),
    /source/,
  );
  assert.throws(
    () =>
      prepareOperationalReleaseEvidence({
        ...input,
        verifyDelivery,
        pullRequest: { ...pullRequest, body: "Refs #999." },
      }),
    /owning/,
  );
  assert.throws(
    () =>
      prepareOperationalReleaseEvidence({
        ...input,
        verifyDelivery,
        expectedReference: proof.reference,
        pullRequest: { ...pullRequest, body: pullRequest.body + "\nChanged evidence." },
      }),
    /evidence.*changed|hash/,
  );
});

void test("receipt acceptance detects same-reference raw edits and cannot replace unavailable reads", () => {
  const f = handoffFixture();
  const input = {
    config: f.configured,
    snapshot: f.current(),
    offer: f.offer.offer,
    receipt: f.receipt.receipt,
    verifyDelivery: ({
      receipt,
    }: Parameters<
      NonNullable<Parameters<typeof prepareOperationalReturnAcceptance>[0]["verifyDelivery"]>
    >[0]) => ({
      status: "established",
      runner_instance_id: f.spec.runner_instance_id,
      request_id: f.spec.request_id,
      receipt_digest: receipt.receipt_digest,
      observed_response_reference: receipt.evidence,
      invocation_reference: "fixture independently delivered return",
    }),
  };
  assert.equal(prepareOperationalReturnAcceptance(input).status, "unknown");
  for (const delta of [{ body_sha256: "c".repeat(64) }, { edited_at: "2026-10-07T03:01:00Z" }]) {
    assert.throws(
      () =>
        prepareOperationalReturnAcceptance({
          ...input,
          readEvidence: () => ({ ...f.receipt.receipt.evidence_observation, ...delta }),
        }),
      /evidence.*changed/,
    );
  }
  assert.equal(
    prepareOperationalReturnAcceptance({ ...input, readEvidence: () => null }).status,
    "unknown",
  );
});

void test("return evidence reads only exact bounded references and detects foreign, wrong-source or body edits", () => {
  const f = operationalFixture();
  const body = "## Linked issue\nRefs #1104.\n\n## Outcome\nFixture owning PR.";
  const pr = {
    number: 1543,
    html_url: `https://github.com/${config.repository}/pull/1543`,
    head: { sha: "a".repeat(40) },
    merged: false,
    merge_commit_sha: null,
    updated_at: "2026-10-07T03:00:00Z",
    body,
  };
  const release = prepareOperationalReleaseEvidence({
    config: f.configured,
    snapshot: readOperationalBoard(f.configured, f.api),
    runner: "fixture-cloud-a",
    source: "a".repeat(40),
    pullRequest: pr,
  });
  const reference = release.receipt.reference;
  const calls: { method: string; endpoint: string; options: { timeoutMs: number } }[] = [];
  const api = {
    request(method: string, endpoint: string, _body: unknown, options: { timeoutMs: number }) {
      calls.push({ method, endpoint, options });
      return { body: pr };
    },
  };
  const observed = readOperationalReturnEvidence(
    f.configured,
    api,
    reference,
    1104,
    "a".repeat(40),
  );
  assert.equal(observed.url, reference);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.endpoint, `repos/${config.repository}/pulls/1543`);
  assert.equal(call.options.timeoutMs, 15000);
  assert.throws(
    () => readOperationalReturnEvidence(f.configured, api, pr.html_url, 1104, "a".repeat(40)),
    /exact/,
  );
  assert.throws(
    () => readOperationalReturnEvidence(f.configured, api, reference, 1104, "b".repeat(40)),
    /source/,
  );
  assert.throws(
    () =>
      readOperationalReturnEvidence(
        f.configured,
        api,
        reference.replace(config.repository, "foreign/repository"),
        1104,
        "a".repeat(40),
      ),
    /exact/,
  );
  pr.body += "\nChanged.";
  assert.throws(
    () => readOperationalReturnEvidence(f.configured, api, reference, 1104, "a".repeat(40)),
    /hash changed/,
  );
  pr.body = body;
  pr.number = 1544;
  assert.throws(
    () => readOperationalReturnEvidence(f.configured, api, reference, 1104, "a".repeat(40)),
    /identity/,
  );
  assert.throws(
    () =>
      readOperationalReturnEvidence(
        f.configured,
        {
          request() {
            throw new Error("unavailable transport");
          },
        },
        reference,
        1104,
        "a".repeat(40),
      ),
    /unavailable/,
  );
});

void test("hash-pinned PR evidence roundtrips through released checkpoints and return requests", () => {
  const f = operationalFixture();
  const reference = `https://github.com/${config.repository}/pull/1543#body-sha256-${"d".repeat(64)}`;
  const assignment = fixtureAssignment(f.board, 1);
  assignment.execution_slot = "completed";
  assignment.reserved_scope = null;
  assignment.released_reference = reference;
  fixtureCheckpoint(f, "cloud-b").execution_phase = "completed";
  fixtureCheckpoint(f, "cloud-b").necessary_evidence_pointers = [reference];
  fixtureRecord(f, `repos/${config.repository}/issues/1800`).body = f.format(
    "runner-board",
    f.board,
  );
  fixtureRecord(f, `repos/${config.repository}/issues/comments/102`).body = f.format(
    "runner-checkpoint",
    fixtureCheckpoint(f, "cloud-b"),
  );
  assert.equal(readOperationalBoard(f.configured, f.api).status, "staged");
  assignment.released_reference = fixtureElement(reference.split("#"), 0);
  assert.throws(
    () => parseOperationalBoard(f.format("runner-board", f.board), f.configured),
    /assignment|release/,
  );
  const h = handoffFixture();
  const receipt = prepareOperationalReturn({
    config: h.configured,
    snapshot: h.current(),
    offer: h.offer.offer,
    runner: h.spec.runner_instance_id,
    source: h.spec.source,
    disposition: "accepted",
    evidence: reference,
    evidenceObservation: {
      url: reference,
      body_sha256: "d".repeat(64),
      edited_at: "2026-10-07T03:00:00Z",
    },
  }).receipt;
  const accepted = prepareOperationalReturnAcceptance({
    config: h.configured,
    snapshot: h.current(),
    offer: h.offer.offer,
    receipt,
    readEvidence: () => receipt.evidence_observation,
    verifyDelivery: () => ({
      status: "established",
      runner_instance_id: h.spec.runner_instance_id,
      request_id: h.spec.request_id,
      receipt_digest: receipt.receipt_digest,
      observed_response_reference: reference,
      invocation_reference: "fixture genuine response",
    }),
  });
  assert.equal(accepted.status, "planned");
});

void test("return observations reject raw extra fields and oversized packets without truncation", () => {
  const f = handoffFixture();
  const input = {
    config: f.configured,
    snapshot: f.current(),
    offer: f.offer.offer,
    runner: f.spec.runner_instance_id,
    source: f.spec.source,
    disposition: "accepted",
    evidence: "issue1104#issuecomment-21",
  };
  assert.throws(
    () =>
      prepareOperationalReturn({
        ...input,
        evidenceObservation: {
          ...f.receipt.receipt.evidence_observation,
          raw_body: "private evidence",
        },
      }),
    /observation|unsupported/,
  );
  assert.throws(
    () =>
      prepareOperationalReturn({
        ...input,
        evidenceObservation: { ...f.receipt.receipt.evidence_observation, url: "x".repeat(13000) },
      }),
    /oversized|observation/,
  );
});

void test("receipt tuple edits and pause changes cannot acknowledge or replace current ownership", () => {
  const f = handoffFixture();
  const original = observedSnapshot(f.current());
  const input = {
    config: f.configured,
    snapshot: original,
    offer: f.offer.offer,
    receipt: f.receipt.receipt,
  };
  for (const delta of [
    { generation: 3 },
    { assignment_id: "other-task" },
    { scope: "other scope" },
    { owning_issue: 999 },
    { source: "c".repeat(40) },
    { runner_instance_id: "other-instance" },
    { outcome: "other outcome" },
  ]) {
    assert.throws(
      () =>
        prepareOperationalReturnAcceptance({
          ...input,
          receipt: { ...f.receipt.receipt, ...delta },
        }),
      /conflict/,
    );
  }
  const paused = observedSnapshot(f.current());
  fixtureAssignment(paused.board, 0).intentional_pause = true;
  assert.throws(
    () => prepareOperationalReturnAcceptance({ ...input, snapshot: paused }),
    /superseded|changed/,
  );
  assert.deepEqual(observedSnapshot(f.current()).board, original.board);
});

void test("owning PR evidence accepts normal section order and refuses absent wrong or duplicate linked sections", () => {
  const f = operationalFixture();
  const input = {
    config: f.configured,
    snapshot: readOperationalBoard(f.configured, f.api),
    runner: "fixture-cloud-a",
    source: "a".repeat(40),
  };
  const pr = {
    number: 1543,
    html_url: `https://github.com/${config.repository}/pull/1543`,
    head: { sha: input.source },
    merged: false,
    merge_commit_sha: null,
    updated_at: "2026-10-07T03:00:00Z",
    body: "## Summary\nPreserve real evidence.\n\n## Linked issue\nRefs #1104.\n\n## Validation\nRemain draft.",
  };
  assert.equal(prepareOperationalReleaseEvidence({ ...input, pullRequest: pr }).status, "unknown");
  for (const body of [
    "## Summary\nRefs #1104.\n\n## Validation\nNo linked section.",
    pr.body.replace("Refs #1104.", "Refs #999."),
    pr.body + "\n\n## Linked issue\nRefs #1104.",
    pr.body.replace("Refs #1104.", "Refs #11040."),
  ]) {
    assert.throws(
      () => prepareOperationalReleaseEvidence({ ...input, pullRequest: { ...pr, body } }),
      /owning|ambiguous/,
    );
  }
});

void test("normal consumption plans only a fixed checkpoint native handoff, preserving progress and refusing lane writes", () => {
  const fixture = operationalFixture();
  let snapshot = observedBoard(fixture.configured, fixture.api);
  let item = pickupIssue();
  const relationships = pickupRelations();
  const context = pickupContext(item, relationships, { runner: "fixture-cloud-a" });
  context.operational_baseline = operationalBaseline(snapshot);
  context.operational_binding = fixtureBinding(snapshot, "fixture-cloud-a", 1104);
  const client = {
    operationalSnapshot: () => snapshot,
    executionIssue: () => ({ item, relationships }),
    coordinationRecords: () => assert.fail("normal path must never read task history"),
    postCoordinationComment: () => assert.fail("normal path must never append comments"),
  };
  const input = {
    client,
    config: fixture.configured,
    context,
    runner: "fixture-cloud-a",
    action: "Consumed actual material acceptance",
    evidence: "PR1543#issuecomment-6020220069",
  };
  const plan = checkpointPlan(prepareOperationalConsumption(input));
  assert.equal(plan.status, "planned");
  assert.equal(plan.request.acknowledgment_state, "pending");
  const updated = parseRunnerCheckpoint(plan.body, "cloud-a", snapshot.board);
  assert.deepEqual(
    updated.last_meaningful_progress,
    fixtureCheckpoint(snapshot, "cloud-a").last_meaningful_progress,
  );
  assert.equal(updated.outstanding_requests.length, 2);
  assert.throws(() => prepareOperationalConsumption({ ...input, apply: true }), /coordinator-only/);
  assert.throws(
    () => prepareOperationalConsumption({ ...input, runner: "other-instance" }),
    /exactly one/,
  );
  const wrongContext = structuredClone(context);
  wrongContext.pickup.reported_runner = "fixture-cloud-b";
  assert.throws(
    () => prepareOperationalConsumption({ ...input, context: wrongContext }),
    /does not bind/,
  );
  const staleBinding = structuredClone(context);
  assert.ok(staleBinding.operational_binding);
  staleBinding.operational_binding.generation = 2;
  assert.throws(
    () => prepareOperationalConsumption({ ...input, context: staleBinding }),
    /does not bind/,
  );
  item = pickupIssue(1104, "Changed mandatory acceptance");
  assert.throws(
    () => prepareOperationalConsumption(input),
    /requirements or raw observation changed/,
  );
  item = pickupIssue();
  snapshot.checkpoints["cloud-a"] = updated;
  // Simulate a fresh validated context after the coordinator preserved this request.
  context.operational_baseline = operationalBaseline(snapshot);
  assert.equal(prepareOperationalConsumption(input).status, "quiet");
  const oldId = plan.request.request_id;
  item = { ...pickupIssue(), priority: "Low" };
  const changedContext = pickupContext(item, relationships, { runner: "fixture-cloud-a" });
  changedContext.operational_baseline = operationalBaseline(snapshot);
  changedContext.operational_binding = fixtureBinding(snapshot, "fixture-cloud-a", 1104);
  assert.equal(changedContext.observation_revision, context.observation_revision);
  const material = checkpointPlan(
    prepareOperationalConsumption({ ...input, context: changedContext }),
  );
  assert.equal(material.status, "planned");
  assert.notEqual(material.request.request_id, oldId);
  snapshot.checkpoints["cloud-a"] = parseRunnerCheckpoint(material.body, "cloud-a", snapshot.board);
  fixtureCheckpoint(snapshot, "cloud-a").outstanding_requests.reverse();
  item = pickupIssue();
  const revisited = prepareOperationalConsumption(input);
  assert.equal(revisited.status, "planned");
  assert.notEqual(revisited.request.request_id, oldId);
  item = { ...pickupIssue(), priority: "Low" };
  fixtureAssignment(snapshot.board, 0).generation = 2;
  fixtureCheckpoint(snapshot, "cloud-a").assignment_generation = 2;
  changedContext.operational_baseline = operationalBaseline(snapshot);
  changedContext.operational_binding = fixtureBinding(snapshot, "fixture-cloud-a", 1104);
  const generation = prepareOperationalConsumption({ ...input, context: changedContext });
  assert.equal(generation.status, "planned");
  assert.notEqual(generation.request.request_id, material.request.request_id);
  const currentCheckpoint = fixtureCheckpoint(snapshot, "cloud-a");
  const anchor = currentCheckpoint.outstanding_requests.find(
    (request) => request.request_id === material.request.request_id,
  );
  assert.ok(anchor);
  const withoutAnchor = {
    ...currentCheckpoint,
    outstanding_requests: currentCheckpoint.outstanding_requests.filter(
      (request) => request !== anchor,
    ),
  };
  assert.throws(
    () =>
      prepareOperationalCheckpoint(
        fixture.configured,
        snapshot,
        "cloud-a",
        withoutAnchor,
        snapshot.observations[1],
        [
          {
            request_id: anchor.request_id,
            recipient_instance_or_coordinator: anchor.recipient_instance_or_coordinator,
            disposition: "resolved",
            observed_response_reference: input.evidence,
          },
        ],
      ),
    /latest consumption anchor/,
  );
  const duplicate = {
    ...currentCheckpoint,
    outstanding_requests: [
      ...currentCheckpoint.outstanding_requests,
      { ...anchor, request_id: `CONSUME-${"f".repeat(64)}-2` },
    ],
  };
  assert.throws(
    () =>
      parseRunnerCheckpoint(
        fixture.format("runner-checkpoint", duplicate),
        "cloud-a",
        snapshot.board,
      ),
    /duplicated/,
  );
});

void test("requirements comparison ignores formatting, check marks and bare delivered links, not safety text", () => {
  const first = pickupIssue(
    1104,
    "## Acceptance\n- [ ] Preserve recovery.\n## Delivered evidence\n- [PR](https://github.com/boburning/portcove/pull/1)",
  );
  const second = pickupIssue(
    1104,
    "# Acceptance\r\n- [x]  Preserve recovery.\r\n## Delivered evidence\n- [new PR](https://github.com/boburning/portcove/pull/2)",
  );
  assert.equal(
    executionSnapshot(config, first, pickupRelations()).scope_revision,
    executionSnapshot(config, second, pickupRelations()).scope_revision,
  );
  for (const [old, next] of [
    ["Never delete originals", "Delete originals"],
    ["```\nnode verify.mjs --safe\n```", "```\nnode verify.mjs --unsafe\n```"],
    ["Preserve /saves", "Preserve /configuration"],
    ['```\nnode task.mjs "two  spaces"\n```', '```\nnode task.mjs "two spaces"\n```'],
    ['Use `"two  spaces"`', 'Use `"two spaces"`'],
    ['    command "two  spaces"', '    command "two spaces"'],
  ])
    assert.notEqual(
      normalizeRequirements(`## Delivered evidence\n${old}`),
      normalizeRequirements(`## Delivered evidence\n${next}`),
    );
});

void test("scope, planning, genuine prerequisites and organization are separate comparison facets", () => {
  const initial = executionSnapshot(config, pickupIssue(), pickupRelations());
  assert.equal(compareExecutionSnapshots(initial).state, "unknown");
  assert.equal(compareExecutionSnapshots(initial, initial).state, "unchanged");
  const planned = executionSnapshot(
    config,
    { ...pickupIssue(), priority: "Medium" },
    pickupRelations(),
  );
  assert.deepEqual(compareExecutionSnapshots(planned, initial).changes, ["planning_changed"]);
  assert.deepEqual(compareExecutionSnapshots(planned, initial).planning_fields, ["Priority"]);
  const changed = executionSnapshot(
    config,
    pickupIssue(1104, "Do not activate until the current plan passes"),
    pickupRelations(),
  );
  assert.deepEqual(compareExecutionSnapshots(changed, initial).changes, [
    "scope_comparison_required",
  ]);
  const reference = { ...pickupIssue(925).content, projectStatus: "In progress" };
  const dependency = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    blockedBy: [reference],
  });
  assert.deepEqual(compareExecutionSnapshots(dependency, initial).changes, [
    "prerequisites_changed",
  ]);
  const organization = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    parent: reference,
  });
  assert.deepEqual(compareExecutionSnapshots(organization, initial).changes, [
    "organization_changed",
  ]);
  const closed = pickupIssue();
  closed.content.state = "CLOSED";
  assert.deepEqual(
    compareExecutionSnapshots(executionSnapshot(config, closed, pickupRelations()), initial)
      .changes,
    ["issue_state_changed"],
  );
  const closedPrerequisite = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    blockedBy: [{ ...reference, state: "CLOSED" }],
  });
  assert.deepEqual(compareExecutionSnapshots(closedPrerequisite, dependency).changes, [
    "prerequisites_changed",
  ]);
  assert.throws(
    () =>
      compareExecutionSnapshots(
        initial,
        executionSnapshot(config, pickupIssue(209), pickupRelations()),
      ),
    /another repository or issue/,
  );
});

void test("snapshot validation rejects altered hashes, malformed identities and missing facets", () => {
  const snapshot = pickupContext().snapshot;
  assert.equal(validateExecutionSnapshot(snapshot), snapshot);
  assert.throws(
    () => validateExecutionSnapshot({ ...snapshot, scope_revision: "changed" }),
    /invalid/,
  );
  assert.throws(
    () => validateExecutionSnapshot({ ...snapshot, issue: { ...snapshot.issue, number: 0 } }),
    /invalid/,
  );
  assert.throws(() => validateExecutionSnapshot({ ...snapshot, planning: {} }), /invalid/);
  assert.throws(
    () => parseConsumptionRecord("<!-- portcove-roadmap-consumed:v1 -->\nmissing JSON"),
    /incomplete/,
  );
});

void test("snapshot validation rejects coercible scalar identities even with a matching revision", () => {
  const original = pickupContext().snapshot;
  const mutations = [
    (value: typeof original) => {
      // @ts-expect-error Array-valued identity deliberately crosses the runtime boundary.
      value.repository = [value.repository];
    },
    (value: typeof original) => {
      // @ts-expect-error Array-valued URL deliberately crosses the runtime boundary.
      value.issue.url = [value.issue.url];
    },
    (value: typeof original) => {
      // @ts-expect-error Array-valued hash deliberately crosses the runtime boundary.
      value.scope_revision = [value.scope_revision];
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    const { revision: _previous, ...inputs } = value;
    value.revision = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
    assert.throws(() => validateExecutionSnapshot(value), /invalid/);
  }
});

void test("context distinguishes bounded absence, actual API recorder, reported consumption and worker activity", () => {
  const first = pickupContext();
  assert.equal(first.pickup.current_requirements, "unknown");
  assert.equal(first.pickup.invoked, "unknown");
  const comment = acknowledgmentComment(first);
  const consumed = pickupContext(pickupIssue(), pickupRelations(), { comments: [comment] });
  assert.equal(consumed.pickup.current_requirements, "recorded consumed");
  assert.ok(consumed.pickup.last_record);
  assert.equal(consumed.pickup.last_record.recorder, "recorder");
  assert.equal(consumed.pickup.assigned, "unknown");
  assert.equal(consumed.reservation.assessment, "unknown");
  const changed = pickupContext(pickupIssue(1104, "New acceptance"), pickupRelations(), {
    comments: [comment],
  });
  assert.equal(changed.pickup.current_requirements, "pending comparison");
  assert.equal(changed.comparison.state, "comparison_required");
  assert.equal(changed.recommendation.execution_capability.startsWith("not assessed"), true);
});

void test("exact older consumption reference is bound to configured repository, runner and task", () => {
  const comment = acknowledgmentComment();
  assert.equal(
    consumedReference(comment, { repository: config.repository, runner: "Local", issue: 1104 })
      .issue.number,
    1104,
  );
  for (const override of [{ repository: "other/repo" }, { runner: "Cloud A" }, { issue: 209 }])
    assert.throws(
      () =>
        consumedReference(comment, {
          repository: config.repository,
          runner: "Local",
          issue: 1104,
          ...override,
        }),
      /does not match/,
    );
  assert.throws(
    () =>
      new RoadmapClient(config).coordinationComment(
        "https://github.com/other/repo/issues/793#issuecomment-1",
        coordinationTarget(config, 1104),
      ),
    /this repository/,
  );
});

void test("repeated recorded consumption is quiet, but returning to an earlier revision is a new comparison", () => {
  const context = pickupContext();
  const options = { runner: "Local", action: "Continue", evidence: "actual inspected task" };
  const first = acknowledgmentComment(context);
  assert.equal(prepareConsumption(context, options, [first]).needed, false);
  assert.equal(
    prepareConsumption(context, { ...options, runner: "Cloud A" }, [first]).needed,
    true,
  );
  const changed = acknowledgmentComment(pickupContext(pickupIssue(1104, "Changed acceptance")));
  assert.equal(prepareConsumption(context, options, [first, changed]).needed, true);
});

void test("acknowledgment payload roundtrips action and evidence code fences without poisoning later reads", () => {
  const context = pickupContext();
  const action = 'Compared example: ```json\n{}\n```; preserve "two  spaces"';
  const evidence = 'Actual recipe:\n```json\n{"observed":true}\n```';
  const prepared = prepareConsumption(context, { runner: "Local", action, evidence }, []);
  const record = parseConsumptionRecord(prepared.body);
  assert.ok(record);
  assert.equal(record.action, action);
  assert.equal(record.evidence, evidence);
  assert.equal(
    prepareConsumption(context, { runner: "Local", action, evidence }, [
      { body: prepared.body, url: `${context.coordination_target.url}#issuecomment-1` },
    ]).needed,
    false,
  );
});

function consumptionClient({
  changed = false,
  transport = false,
  readback = true,
  prior = [],
  context = pickupContext(),
  complete = true,
}: {
  changed?: boolean;
  transport?: boolean;
  readback?: boolean;
  prior?: Parameters<typeof prepareConsumption>[2];
  context?: ContextFixture;
  complete?: boolean;
} = {}) {
  const writes: { body: string }[] = [];
  const saved = acknowledgment(context);
  const client: Parameters<typeof executeConsumption>[0]["client"] = {
    coordinationRecords: () => ({
      nodes: writes.length
        ? [
            ...prior,
            {
              ...acknowledgmentComment(context),
              id: 2,
              body: writes[0]?.body ?? assert.fail("expected recorded fixture write"),
              url: `${context.coordination_target.url}#issuecomment-2`,
            },
          ]
        : [...prior],
      coverage: { complete, count: prior.length, total: complete ? prior.length : 100 },
    }),
    executionIssue: () => ({
      item: changed ? pickupIssue(1104, "Concurrent requirements") : pickupIssue(),
      relationships: pickupRelations(),
    }),
    api: {
      request(method, endpoint, payload) {
        assert.equal(method, "POST");
        assert.equal(
          endpoint,
          `repos/${config.repository}/issues/${context.coordination_target.number}/comments`,
        );
        assert.ok(isRecord(payload) && typeof payload.body === "string");
        writes.push({ body: payload.body });
        if (transport) throw new Error("lost POST response");
        return { body: { id: 2 } };
      },
    },
    coordinationComment: () => {
      if (!readback) throw new Error("unavailable readback");
      return {
        ...acknowledgmentComment(context),
        id: 2,
        url: `${context.coordination_target.url}#issuecomment-2`,
        body: writes[0]?.body ?? saved.body,
      };
    },
  };
  return { writes, context, client };
}

void test("acknowledgment plans by default and stale requirements cause zero writes", () => {
  const options = {
    config,
    runner: "Local",
    action: "Compared live scope",
    evidence: "actual task read",
  };
  const fresh = consumptionClient();
  assert.equal(executeConsumption({ ...options, ...fresh }).status, "planned");
  assert.equal(fresh.writes.length, 0);
  const stale = consumptionClient({ changed: true });
  assert.throws(
    () => executeConsumption({ ...options, ...stale, apply: true }),
    /snapshot is stale/,
  );
  assert.equal(stale.writes.length, 0);
  const repeated = consumptionClient({ prior: [acknowledgmentComment()] });
  assert.equal(executeConsumption({ ...options, ...repeated, apply: true }).needed, false);
  assert.equal(repeated.writes.length, 0);
});

void test("literal blank lines and boundary spaces invalidate stale consumption with zero writes", () => {
  for (const [before, after] of [
    ["```sh\ncat <<'EOF'\na\n\nb\nEOF\n```", "```sh\ncat <<'EOF'\na\nb\nEOF\n```"],
    ["    a\n\n    b", "    a\n    b"],
    ["    printf 'trailing spaces'  ", "    printf 'trailing spaces' "],
    [
      "## Delivered evidence\n```sh\ncat <<'EOF'\n```json\n[target](https://example.com/first)\nEOF\n```",
      "## Delivered evidence\n```sh\ncat <<'EOF'\n```json\n[target](https://example.com/second)\nEOF\n```",
    ],
    ["Use `a\n\nb`", "Use `a\nb`"],
  ]) {
    const scenario = consumptionClient();
    scenario.context = pickupContext(pickupIssue(1104, before));
    scenario.client.executionIssue = () => ({
      item: pickupIssue(1104, after),
      relationships: pickupRelations(),
    });
    assert.throws(
      () =>
        executeConsumption({
          ...scenario,
          config,
          runner: "Local",
          action: "Compared",
          evidence: "actual source",
          apply: true,
        }),
      /snapshot is stale/,
    );
    assert.equal(scenario.writes.length, 0);
  }
});

void test("ambiguous acknowledgment POST is read back without retry; unavailable result retains exact pending body", () => {
  const options = {
    config,
    runner: "Local",
    action: "Compared live scope",
    evidence: "actual task read",
    apply: true,
  };
  const ambiguous = consumptionClient({ transport: true });
  assert.equal(executeConsumption({ ...options, ...ambiguous }).readback, "exact");
  assert.equal(ambiguous.writes.length, 1);
  const unavailable = consumptionClient({ readback: false });
  assert.throws(
    () => executeConsumption({ ...options, ...unavailable }),
    (error) => {
      assert.equal(fixtureObject(error).operationStatus, "unknown");
      assert.equal(
        fixtureObject(fixtureObject(error).operationEvidence).pending_body,
        fixtureElement(unavailable.writes, 0).body,
      );
      return true;
    },
  );
  assert.equal(unavailable.writes.length, 1);
});

void test("structured queue preserves Planned recommendations without inferring a grant or execution route", () => {
  const planned = pickupIssue();
  const required = { ...pickupIssue(925), "release commitment": "Required" };
  const output = executionQueueData([planned, required]);
  assert.equal(output.candidates.length, 2);
  assert.equal(
    fixtureElement(output.candidates, 1).after,
    fixtureElement(output.candidates, 0).url,
  );
  assert.equal(fixtureElement(output.candidates, 0).reservation, "unknown");
  assert.equal(fixtureElement(output.candidates, 0).execution_capability, "not assessed");
});

void test("consumption JSON preserves the planned body and quiet success in the existing operation envelope", () => {
  const planned = consumptionEnvelope({ status: "planned", ...acknowledgment() });
  assert.equal(planned.operation, "roadmap.acknowledge");
  assert.equal(planned.status, "planned");
  assert.equal(
    fixtureValue(parseConsumptionRecord(fixtureObject(planned.evidence).body)).snapshot.issue
      .number,
    1104,
  );
  const quiet = consumptionEnvelope({
    status: "succeeded",
    needed: false,
    reason: "Already consumed",
    url: "retained reference",
  });
  assert.equal(quiet.summary, "Already consumed");
  assert.equal(quiet.evidence.needed, false);
});

void test("selected context collects typed relationships completely and matches opaque Project identity", () => {
  const connection = <T,>(nodes: T[], totalCount = nodes.length, hasNextPage = false) => ({
    nodes,
    totalCount,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
  });
  const projectItem = (id: string, project = "PVT-selected") => ({
    id,
    project: { id: project },
    fieldValues: connection([{ name: "Ready", field: { name: "Status" } }]),
  });
  const reference = pickupIssue(925).content;
  const issue = {
    ...pickupIssue().content,
    parent: null,
    projectItems: connection([projectItem("selected"), projectItem("other", "PVT-other")]),
    blockedBy: connection([], 1, true),
    blocking: connection([reference]),
    subIssues: connection<PickupItem["content"]>([]),
  };
  const client = new RoadmapClient(config);
  client.projectDetails = () => ({ id: "PVT-selected" });
  client.graphql = (query) => {
    if (query.includes("repository(owner")) return { repository: { issue } };
    return {
      node: {
        blockedBy: connection([
          { ...reference, projectItems: connection([projectItem("dependency")]) },
        ]),
      },
    };
  };
  const result = client.executionIssue(1104);
  assert.equal(result.item.id, "selected");
  assert.equal(result.relationships.blockedBy.length, 1);
  assert.equal(fixtureElement(result.relationships.blockedBy, 0).projectStatus, "Ready");
  assert.equal(fixtureElement(result.relationships.blocking, 0).number, 925);
  issue.blockedBy = connection([]);
  issue.subIssues = connection([reference, reference]);
  client.graphql = () => ({ repository: { issue }, node: { subIssues: issue.subIssues } });
  assert.throws(() => client.executionIssue(1104), /duplicate/);
});

void test("acknowledgment history validates bounded coverage and refuses count changes", () => {
  const client = new RoadmapClient(config);
  const target = coordinationTarget(config, 1104);
  client.coordinationBinding = () => ({ number: 1104, comments: 100 });
  client.graphql = () => ({
    repository: {
      issue: {
        url: target.url,
        comments: { nodes: [], totalCount: 100, pageInfo: { hasPreviousPage: true } },
      },
    },
  });
  assert.throws(() => client.coordinationRecords(target), /incomplete/);
  const nodes = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    url: `${target.url}#issuecomment-${i + 1}`,
    body: "plain checkpoint",
    createdAt: "2026-10-06T12:00:00Z",
    updatedAt: "2026-10-06T12:00:00Z",
  }));
  client.graphql = () => ({
    repository: {
      issue: {
        url: target.url,
        comments: { nodes, totalCount: 100, pageInfo: { hasPreviousPage: true } },
      },
    },
  });
  assert.equal(client.coordinationRecords(target).coverage.complete, false);
  let reads = 0;
  client.coordinationBinding = () => ({ number: 1104, comments: ++reads === 1 ? 100 : 101 });
  assert.throws(() => client.coordinationRecords(target), /incomplete/);
});

void test("selected issue and explicit PR routes bind work/repository and never write legacy793", () => {
  const target = coordinationTarget(config, 1104, 1543);
  const context = pickupContext(pickupIssue(), pickupRelations(), { target });
  const scenario = consumptionClient({ context });
  const result = executeConsumption({
    ...scenario,
    config,
    runner: "Local",
    action: "Consumed",
    evidence: "actual",
    apply: true,
  });
  assert.equal(result.url, `${target.url}#issuecomment-2`);
  let node = {
    number: 1543,
    html_url: target.url,
    pull_request: { url: "bound" },
    comments: 2,
    body: "Refs #1104.",
  };
  const client = new RoadmapClient(config, () => JSON.stringify(node));
  assert.equal(client.coordinationBinding(target).number, 1543);
  for (const body of [
    "Refs #11040",
    "https://github.com/other/repo/issues/1104",
    "no work reference",
    `https://github.com/${config.repository}/issues/1104x`,
    `https://github.com/${config.repository}/issues/1104-not-the-issue`,
    `https://github.com/${config.repository}/issues/11040`,
  ]) {
    node = { ...node, body };
    assert.throws(() => client.coordinationBinding(target), /does not reference/);
  }
  for (const suffix of ["", ")", "#issuecomment-1", "?query=value"]) {
    node = {
      ...node,
      body: `[Owner](https://github.com/${config.repository}/issues/1104${suffix}`,
    };
    assert.equal(client.coordinationBinding(target).number, 1543);
  }
  node = { ...node, body: "Refs #1104", html_url: "https://github.com/other/repo/pull/1543" };
  assert.throws(() => client.coordinationBinding(target), /identity/);
  assert.throws(() => coordinationTarget(config, 793), /read-only/);
  assert.throws(() => coordinationTarget(config, 1104, 793), /read-only/);
  for (const mutation of [
    { pickup: { reported_runner: "Other" } },
    { coordination_target: { ...target, work_issue: 209 } },
    { coordination_target: { ...target, repository: "other/repo" } },
  ]) {
    const invalid = consumptionClient({ context });
    // @ts-expect-error Deliberately incomplete or mismatched identity exercises runtime refusal.
    invalid.context = { ...context, ...mutation };
    assert.throws(() =>
      executeConsumption({
        ...invalid,
        config,
        runner: "Local",
        action: "Consumed",
        evidence: "actual",
        apply: true,
      }),
    );
    assert.equal(invalid.writes.length, 0);
  }
});

void test("exact legacy refs are read-only comparison; other work refs and identity substitutions fail", () => {
  const target = coordinationTarget(config, 1104);
  const url = `https://github.com/${config.repository}/issues/793#issuecomment-1`;
  const requests: string[][] = [];
  let original = {
    html_url: url,
    issue_url: `https://api.github.com/repos/${config.repository}/issues/793`,
    body: acknowledgment().body,
  };
  const client = new RoadmapClient(config, (args) => {
    requests.push([fixtureElement(args, args.indexOf("--method") + 1), fixtureElement(args, 2)]);
    return JSON.stringify(original);
  });
  assert.equal(
    consumedReference(client.coordinationComment(url, target), {
      repository: config.repository,
      runner: "Local",
      issue: 1104,
    }).issue.number,
    1104,
  );
  assert.deepEqual(requests, [["GET", `repos/${config.repository}/issues/comments/1`]]);
  assert.throws(
    () =>
      client.coordinationComment(
        `https://github.com/${config.repository}/issues/209#issuecomment-1`,
        target,
      ),
    /selected issue/,
  );
  assert.throws(
    () =>
      consumedReference(client.coordinationComment(url, target), {
        repository: config.repository,
        runner: "Other",
        issue: 1104,
      }),
    /does not match/,
  );
  original = {
    ...original,
    issue_url: `https://api.github.com/repos/${config.repository}/issues/1104`,
  };
  assert.throws(() => client.coordinationComment(url, target), /identity/);
  const substituted = acknowledgmentComment(
    pickupContext(pickupIssue(), pickupRelations(), {
      target: coordinationTarget(config, 1104, 1543),
    }),
  );
  substituted.url = `${target.url}#issuecomment-1`;
  assert.throws(
    () =>
      consumedReference(substituted, {
        repository: config.repository,
        runner: "Local",
        issue: 1104,
        target,
      }),
    /bound issue\/PR/,
  );
});

void test("incomplete absence refuses new writes while covered quiet repeats and revisited revisions remain correct", () => {
  const options = { config, runner: "Local", action: "Consumed", evidence: "actual", apply: true };
  const absent = consumptionClient({ complete: false });
  assert.throws(() => executeConsumption({ ...options, ...absent }), /absence\/latest is unknown/);
  assert.equal(absent.writes.length, 0);
  const outside = consumptionClient({ complete: false });
  Object.assign(outside.context, {
    consumed_reference: {
      url: "exact old reference",
      latest_consumption: "not established",
    },
  });
  assert.throws(() => executeConsumption({ ...options, ...outside }), /absence\/latest is unknown/);
  const quiet = consumptionClient({ complete: false, prior: [acknowledgmentComment()] });
  assert.equal(executeConsumption({ ...options, ...quiet }).needed, false);
  assert.equal(quiet.writes.length, 0);
  const reordered = structuredClone(acknowledgmentComment());
  const prepared = acknowledgment();
  const preparedRecord = fixtureValue(prepared.record);
  Object.assign(preparedRecord, {
    coordination_target: Object.fromEntries(
      Object.entries(preparedRecord.coordination_target).reverse(),
    ),
  });
  reordered.body = `<!-- portcove-roadmap-consumed:v1 -->\n\`\`\`json\n${JSON.stringify(prepared.record)}\n\`\`\``;
  const semanticQuiet = consumptionClient({ complete: false, prior: [reordered] });
  assert.equal(executeConsumption({ ...options, ...semanticQuiet }).needed, false);
  assert.equal(semanticQuiet.writes.length, 0);
  const changed = pickupContext(pickupIssue(1104, "Changed acceptance"));
  const revisited = consumptionClient({
    complete: false,
    prior: [acknowledgmentComment(), acknowledgmentComment(changed)],
  });
  assert.equal(executeConsumption({ ...options, ...revisited }).needed, true);
  assert.equal(revisited.writes.length, 1);
});

void test("same-count raw history edits and changed raw observations stop before writing", () => {
  const scenario = consumptionClient();
  let reads = 0;
  scenario.client.coordinationRecords = () => ({
    nodes: [{ id: 1, body: ++reads === 1 ? "before" : "after" }],
    coverage: { complete: true, count: 1, total: 1 },
  });
  assert.throws(
    () =>
      executeConsumption({
        ...scenario,
        config,
        runner: "Local",
        action: "Consumed",
        evidence: "actual",
        apply: true,
      }),
    /history changed/,
  );
  assert.equal(scenario.writes.length, 0);
  const raw = consumptionClient();
  let observations = 0;
  raw.client.executionIssue = () => ({
    item:
      ++observations === 1
        ? pickupIssue()
        : pickupIssue(1104, "## Acceptance\n- [x] Preserve recovery."),
    relationships: pickupRelations(),
  });
  assert.throws(
    () =>
      executeConsumption({
        ...raw,
        config,
        runner: "Local",
        action: "Consumed",
        evidence: "actual",
        apply: true,
      }),
    /snapshot is stale/,
  );
  assert.equal(raw.writes.length, 0);
});

void test("capability milestones preserve history and fail closed during partial migration", () => {
  const item = (
    number: number,
    target: string,
    status = "Done",
    commitment = "Required",
    state = "CLOSED",
    dependencies: number[] = [],
  ) => ({
    id: `item-${number}`,
    status,
    "target release": target,
    "release commitment": commitment,
    content: {
      number,
      state,
      title: `Outcome ${number}`,
      blockedBy: {
        totalCount: dependencies.length,
        nodes: dependencies.map((n) => ({ number: n })),
      },
    },
  });
  const history = item(1, "Alpha 2");
  const beta = item(2, "Public beta");
  const production = item(3, "1.0", "Ready", "Required", "OPEN");
  assert.equal(analyzeReleaseReadiness([history, beta, production], "Public beta").ready, true);
  assert.equal(analyzeReleaseReadiness([history, beta, production], "1.0").ready, false);
  assert.equal(
    analyzeReleaseReadiness([history, beta, production], "Public beta", {
      candidateIssues: [1],
    }).ready,
    true,
  );
  assert.equal(
    analyzeReleaseReadiness([history, beta, production], "Public beta", {
      candidateIssues: [3],
    }).ready,
    false,
  );
  assert.throws(
    () =>
      analyzeReleaseReadiness([history], "Public beta", {
        candidateIssues: [],
      }),
    /explicit positive/,
  );
  assert.throws(
    () =>
      analyzeReleaseReadiness([history], "Public beta", {
        candidateIssues: [999],
      }),
    /missing from the Project/,
  );
  assert.equal(analyzeReleaseReadiness([history], "Alpha 2").ready, true);
  const unmigrated = item(4, "Alpha 3", "Ready", "Opportunistic", "OPEN");
  assert.equal(
    analyzeReleaseReadiness([history, beta, unmigrated], "Public beta").migrationConflicts.length,
    1,
  );
  assert.equal(analyzeReleaseReadiness([history, beta, unmigrated], "Public beta").ready, false);
  // @ts-expect-error Missing release target intentionally exercises incomplete planning.
  const missingTarget = item(5, undefined);
  assert.equal(analyzeReleaseReadiness([history, beta, missingTarget], "Public beta").ready, false);
  assert.equal(analyzeReleaseReadiness([item(5, "Unscheduled")], "Public beta").ready, false);
  assert.equal(analyzeReleaseReadiness([item(5, "Typo")], "1.0").ready, false);
  assert.equal(
    analyzeReleaseReadiness([item(6, "Public beta", "Done", "Required", "OPEN")], "Public beta")
      .ready,
    false,
  );
  assert.equal(
    analyzeReleaseReadiness(
      [item(7, "Public beta", "Done", "Required", "CLOSED", [3]), production],
      "Public beta",
    ).dependencyConflicts.length,
    1,
  );
  assert.equal(
    analyzeReleaseReadiness([item(8, "Public beta", "Done", "")], "Public beta").ready,
    false,
  );
  const selected = item(9, "1.0", "Done", "Opportunistic", "CLOSED", [10]);
  const blocker = item(10, "Post-1.0", "Ready", "Opportunistic", "OPEN");
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    false,
  );
  blocker.status = "Done";
  blocker.content.state = "CLOSED";
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    true,
  );
  blocker["release commitment"] = "";
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    false,
  );
});

void test("checked-in configuration contains schema rather than volatile item state", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  Object.assign(invalid.project, { items: [{ title: "mutable backlog" }] });
  assert.throws(() => validateConfig(invalid), /volatile planning data/);
});

void test("New Port form requires canonical identity input without a Project-token workflow", () => {
  assert.match(newPortForm, /id: port_key/);
  assert.match(newPortForm, /label: Durable game or target key/);
  assert.match(newPortForm, /lowercase kebab-case/);
  assert.match(newPortForm, /id: upstream[\s\S]*?required: true/);
  assert.doesNotMatch(newPortForm, /(?:PROJECT_TOKEN|personal access token)/i);
});

void test("argument parsing keeps positional item references and named values distinct", () => {
  assert.deepEqual(parseArguments(["set", "#42", "--status", "In progress", "--release=Alpha 1"]), {
    command: "set",
    positionals: ["#42"],
    options: { "--status": "In progress", "--release": "Alpha 1" },
  });
  assert.deepEqual(parseArguments(["set-many", "--spec-file", "plan.json", "--apply", "--json"]), {
    command: "set-many",
    positionals: [],
    options: { "--spec-file": "plan.json", "--apply": true, "--json": true },
  });
  assert.throws(() => parseArguments(["move", "PVTI_1", "--before"]), /requires a value/);
});

void test("field reconciliation preserves existing option identities and user data", () => {
  const desired = [{ name: "Status", options: ["Inbox", "Done"] }];
  const mockedGhFields = {
    fields: [
      {
        id: "PVTSSF_status",
        name: "Status",
        type: "ProjectV2SingleSelectField",
        options: [
          {
            id: "existing",
            name: "Custom",
            color: "BLUE",
            description: "user data",
          },
        ],
      },
    ],
  };
  const existingPlan = planFieldReconciliation(desired, mockedGhFields);
  const existingStep = fixtureElement(existingPlan, 0);
  assert.ok(existingStep.action === "update");
  assert.deepEqual(
    existingStep.options.map((option) => option.name),
    ["Custom", "Inbox", "Done"],
  );
  assert.equal(fixtureElement(existingStep.options, 0).id, "existing");

  const freshPlan = planFieldReconciliation(desired, mockedGhFields, {
    freshProject: true,
  });
  const freshStep = fixtureElement(freshPlan, 0);
  assert.ok(freshStep.action === "update");
  assert.deepEqual(
    freshStep.options.map((option) => option.name),
    ["Inbox", "Done"],
  );
});

void test("view reconciliation reuses matching GraphQL views and creates only missing views", () => {
  const desired = [
    {
      name: "Now Board",
      layout: "BOARD_LAYOUT",
      filter: "horizon:Now",
      fields: ["Title"],
      manual_group_by: null,
      manual_sort_by: "manual",
    },
    {
      name: "Port Pipeline",
      layout: "BOARD_LAYOUT",
      filter: "work-type:Port",
      fields: ["Title"],
      manual_group_by: null,
      manual_sort_by: "manual",
    },
  ];
  const mockedGraphqlViews = [
    {
      id: "PVTV_now",
      name: "Now Board",
      layout: "TABLE_LAYOUT",
      filter: "horizon:Now",
      fields: { nodes: [{ name: "Title" }] },
    },
  ];
  assert.deepEqual(
    planViewReconciliation(desired, mockedGraphqlViews).map((step) => [
      step.action,
      step.desired.name,
    ]),
    [
      ["update", "Now Board"],
      ["create", "Port Pipeline"],
    ],
  );
});

void test("active port work is additive and preserves the complete inventory view", () => {
  const inventory = config.views.find((view) => view.name === "Port Pipeline");
  assert.ok(inventory);
  assert.equal(inventory.filter, "work-type:Port");
  const active = config.views.find((view) => view.name === "Active Port Work");
  assert.ok(active);
  assert.equal(active.layout, "TABLE_LAYOUT");
  assert.equal(active.filter, "work-type:Port -status:Done -status:Deferred");
  assert.deepEqual(active.fields, [
    "Title",
    "Priority",
    "Horizon",
    "Status",
    "Port stage",
    "Platform",
    "Assignees",
  ]);
  assert.equal(active.manual_group_by, "Status");
  assert.equal(active.manual_sort_by, "Priority,manual");
  const existing = config.views
    .filter((view) => view !== active)
    .map((view, index) => ({
      ...view,
      id: `V${index}`,
      fields: { nodes: view.fields.map((name) => ({ name })) },
    }));
  const plan = planViewReconciliation(config.views, existing);
  assert.deepEqual(
    plan.filter((step) => step.action === "create").map((step) => step.desired.name),
    ["Active Port Work"],
  );
  const inventoryStep = plan.find((step) => step.desired.name === inventory.name);
  assert.ok(inventoryStep && inventoryStep.actual);
  assert.equal(inventoryStep.actual.id, "V2");
});

void test("next work excludes workstreams, completed items, and Later horizon", () => {
  const items = [
    {
      title: "Next medium",
      status: "Ready",
      priority: "Medium",
      horizon: "Next",
      "work type": "Bug",
    },
    {
      title: "Now high",
      status: "In progress",
      priority: "High",
      horizon: "Now",
      "work type": "Product feature",
    },
    {
      title: "Now urgent",
      status: "Ready",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Security",
    },
    {
      title: "Parent",
      status: "Ready",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Workstream",
    },
    {
      title: "Done",
      status: "Done",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Bug",
    },
    {
      title: "Later",
      status: "Ready",
      priority: "Urgent",
      horizon: "Later",
      "work type": "Bug",
    },
  ];
  assert.deepEqual(
    selectNextItems(items).map((item) => item.title),
    ["Now urgent", "Now high", "Next medium"],
  );
});

void test("catalog summary and release snapshot derive qualification data from catalog JSON", () => {
  const catalog = {
    ports: [
      {
        id: "one",
        support_tier: "stable",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
      {
        id: "two",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
    ],
  };
  assert.deepEqual(catalogQualificationSummary(catalog), {
    ports: 2,
    byTier: { stable: 1, beta: 1 },
    declaredPlatformPairs: 3,
    automatedPlatformPairs: 1,
    manuallyValidatedPlatformPairs: 1,
  });
  const document = renderSnapshot({
    release: "Alpha 1",
    generatedAt: "2026-09-03T12:00:00.000Z",
    commit: "abcdef",
    projectUrl: "https://github.com/users/boburning/projects/1",
    items: [
      {
        title: "Trust",
        status: "Blocked",
        priority: "Urgent",
        horizon: "Now",
        type: "Security",
        "target release": "Alpha 1",
        "release commitment": "Required",
        content: { url: "https://github.com/boburning/portcove/issues/1" },
      },
    ],
    catalog,
  });
  assert.match(document, /## Open blockers[\s\S]*Trust/);
  assert.match(document, /Catalog entries: 2/);
  assert.match(document, /This snapshot does not grant qualification/);
});

void test("release snapshots are cumulative and Project Status alone authorizes completion", () => {
  const items = [
    {
      title: "Alpha blocker",
      status: "Blocked",
      "target release": "Alpha 1",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/1",
        body: "Upstream https://example.test/not-evidence",
      },
    },
    {
      title: "Closed not planned",
      status: "Deferred",
      "target release": "Alpha 2",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/2",
        body: "## Completion evidence\n\nNone.",
      },
    },
    {
      title: "Beta complete",
      status: "Done",
      "target release": "Beta 1",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/3",
        body: "## Completion evidence\n\nhttps://github.com/boburning/portcove/pull/12",
      },
    },
    {
      title: "Later beta",
      status: "Ready",
      "target release": "Beta 2",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/4",
      },
    },
  ];
  const document = renderSnapshot({
    release: "Beta 1",
    generatedAt: "2026-09-03T00:00:00Z",
    commit: "abc",
    projectUrl: "https://example.test/project",
    items,
    catalog: { ports: [] },
  });
  assert.match(document, /Cumulative required stages: Alpha 1, Alpha 2, Alpha 3, Beta 1/);
  assert.match(document, /## Open blockers[\s\S]*Alpha blocker/);
  assert.match(document, /## Completed required items[\s\S]*Beta complete/);
  assert.match(document, /## Unfinished required items[\s\S]*Closed not planned/);
  assert.match(
    document,
    /## Repository closure and Project Status inconsistencies[\s\S]*Closed not planned/,
  );
  assert.doesNotMatch(document, /Later beta/);
  assert.doesNotMatch(document, /example\.test\/not-evidence/);
  assert.match(document, /portcove\/pull\/12/);
});

void test("release readiness separates required, opportunistic, unclassified, and genuine blocking dependencies", () => {
  const issue = (
    number: number,
    title: string,
    fields: Record<string, string> = {},
    blockedBy: number[] = [],
    parent: number | null = null,
  ) => ({
    id: `item-${number}`,
    title,
    ...fields,
    content: {
      number,
      title,
      state: fields.status === "Done" ? "CLOSED" : "OPEN",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      blockedBy: {
        nodes: blockedBy.map((dependency) => ({
          number: dependency,
          title: `Issue ${dependency}`,
          state: "OPEN",
          url: `https://github.com/boburning/portcove/issues/${dependency}`,
        })),
      },
      parent: parent ? { number: parent } : null,
    },
  });
  const items = [
    issue(
      1,
      "Required outcome",
      {
        status: "Ready",
        "target release": "Alpha 2",
        "release commitment": "Required",
        "work type": "Product feature",
      },
      [2],
    ),
    issue(2, "Misclassified dependency", {
      status: "Ready",
      "target release": "Post-V1",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(3, "Optional slice", {
      status: "Ready",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(4, "Unclassified release work", {
      status: "Ready",
      "target release": "Alpha 2",
      "work type": "Product feature",
    }),
    issue(5, "Unrelated intake", {
      status: "Inbox",
      "target release": "Unscheduled",
      "work type": "Port",
    }),
    issue(6, "Misclassified safety failure", {
      status: "Blocked",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Security",
    }),
    issue(
      7,
      "Child but not blocker",
      {
        status: "Ready",
        "target release": "Post-V1",
        "release commitment": "Opportunistic",
        "work type": "Product feature",
      },
      [],
      1,
    ),
  ];
  const analysis = analyzeReleaseReadiness(items, "Alpha 2");
  assert.deepEqual(
    analysis.effectiveRequired
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [1, 2, 6],
  );
  assert.deepEqual(
    analysis.opportunistic
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [3, 6],
  );
  assert.deepEqual(
    analysis.relevantUnclassified.map((item) => fixtureValue(item.content).number),
    [4],
  );
  assert.deepEqual(
    analysis.safetyConflicts.map((item) => fixtureValue(item.content).number),
    [6],
  );
  assert.equal(analysis.dependencyConflicts.length, 1);
  assert.equal(
    fixtureValue(fixtureElement(analysis.dependencyConflicts, 0).dependency.content).number,
    2,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 7),
    false,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 5),
    false,
  );
  assert.equal(analysis.ready, false);
});

void test("dependency analysis reports cycles and Project-missing blockers", () => {
  const one = {
    id: "one",
    title: "One",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { nodes: [{ number: 2, title: "Two" }] },
    },
  };
  const two = {
    id: "two",
    title: "Two",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 2,
      url: "https://github.com/boburning/portcove/issues/2",
      blockedBy: {
        nodes: [
          { number: 1, title: "One" },
          {
            number: 99,
            title: "Missing",
            url: "https://github.com/boburning/portcove/issues/99",
          },
        ],
      },
    },
  };
  assert.deepEqual(dependencyCycles([one, two]), [[1, 2, 1]]);
  const analysis = analyzeReleaseReadiness([one, two], "Alpha 1");
  assert.equal(analysis.missingProjectDependencies.length, 1);
  assert.equal(
    fixtureValue(fixtureElement(analysis.missingProjectDependencies, 0).dependency.content).number,
    99,
  );
  assert.equal(analysis.ready, false);
});

void test("readiness fails closed when a blocking-dependency page is truncated", () => {
  const item = {
    id: "one",
    title: "One",
    status: "Done",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      state: "CLOSED",
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { totalCount: 11, nodes: [] },
    },
  };
  const analysis = analyzeReleaseReadiness([item], "Alpha 1");
  assert.deepEqual(analysis.truncatedDependencies, [item]);
  assert.equal(analysis.ready, false);

  const unrelated = {
    ...item,
    id: "later",
    "target release": "Post-V1",
    "release commitment": "Opportunistic",
    content: { ...item.content, number: 2 },
  };
  const required = {
    ...item,
    content: { ...item.content, blockedBy: { totalCount: 0, nodes: [] } },
  };
  const scoped = analyzeReleaseReadiness([required, unrelated], "Alpha 1");
  assert.deepEqual(scoped.truncatedDependencies, []);
  assert.equal(scoped.ready, true);
});

void test("completion evidence excludes ordinary upstream URLs and accepts explicit or typed records", () => {
  const links = completionEvidenceLinks([
    {
      body: [
        "Upstream: https://github.com/vendor/game",
        "Implementation: https://github.com/boburning/portcove/pull/22",
        "Qualification: https://example.test/qualification/windows",
        "## Completion evidence",
        "https://example.test/evidence/result.json",
        "## Dependencies and blockers",
        "https://example.test/not-evidence",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(links, [
    "https://example.test/evidence/result.json",
    "https://example.test/qualification/windows",
    "https://github.com/boburning/portcove/pull/22",
  ]);
});

void test("snapshot output is confined to docs/releases", () => {
  assert.match(resolveSnapshotOutput("docs/releases/alpha.md"), /docs[\\/]releases[\\/]alpha\.md$/);
  assert.throws(() => resolveSnapshotOutput("docs/alpha.md"), /must be under docs\/releases/);
  assert.throws(() => resolveSnapshotOutput("../outside.md"), /must be under docs\/releases/);
});

void test("durable promotion rejects missing sections and accepts a complete specification", () => {
  assert.throws(() => validateDurableIssueBody("## User outcome\n\nUseful"), /incomplete/);
  const body = [
    "## User outcome\n\nUseful outcome",
    "## Current behavior and evidence\n\nObserved behavior",
    "## Scope\n\nExact scope",
    "## Non-goals\n\nExcluded behavior",
    "## Acceptance criteria\n\n- [ ] Proven",
    "## Required tests\n\nFocused test",
    "## Documentation impact\n\nNo stable contract change",
    "## Dependencies and blockers\n\nNone",
    "## Completion evidence\n\nRequired before Done",
  ].join("\n\n");
  assert.equal(validateDurableIssueBody(body), body);
});

void test("feature intake accepts neutral and explicit planning fields", () => {
  assert.deepEqual(featureIntakeFields(config), {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Product feature",
    Effort: "Unknown",
  });
  assert.equal(
    featureIntakeFields(config, {
      "--workstream": "Desktop UX",
      "--platform": "Windows",
      "--priority": "High",
      "--horizon": "Now",
      "--release": "Alpha 2",
    }).Workstream,
    "Desktop UX",
  );
  assert.equal(
    featureIntakeFields(config, { "--commitment": "Planned" })["Release commitment"],
    "Planned",
  );
  assert.throws(
    () => featureIntakeFields(config, { "--platform": "Everywhere" }),
    /not a valid Platform/,
  );
});

void test("Release commitment field migration is idempotent", () => {
  const desired = [fixtureFind(config.fields, (field) => field.name === "Release commitment")];
  assert.equal(
    fixtureElement(planFieldReconciliation(desired, { fields: [] }), 0).action,
    "create",
  );
  const actual = {
    fields: [
      {
        id: "commitment",
        name: "Release commitment",
        type: "ProjectV2SingleSelectField",
        options: fixtureElement(desired, 0).options.map((name, index) => ({
          id: `option-${index}`,
          name,
        })),
      },
    ],
  };
  assert.equal(fixtureElement(planFieldReconciliation(desired, actual), 0).action, "keep");
});

void test("active release materialization and manual checklist are explicit", () => {
  const current = fixtureFind(
    materializeViews(config),
    (view) => view.name === "Required for Beta",
  );
  assert.equal(
    current.filter,
    `-status:Done target-release:"${config.active_release}" release-commitment:Required`,
  );
  const alpha1 = materializeViews({
    ...config,
    active_release: "Alpha 1",
  }).find((view) => view.name === "Required for Beta");
  assert.ok(alpha1);
  assert.equal(alpha1.filter, '-status:Done target-release:"Alpha 1" release-commitment:Required');
  assert.equal(
    manualUiChecklist(config).filter((line) => /^\d+\. .*: group by/.test(line)).length,
    config.views.length,
  );
  assert.match(fixtureValue(manualUiChecklist(config).at(-1)), /completion workflows/);
});

void test("doctor drift covers identity linkage field options and view properties", () => {
  const desiredViews = materializeViews(config);
  const fields = config.fields.map((field, index) => ({
    id: `F${index}`,
    name: field.name,
    type: "ProjectV2SingleSelectField",
    options: field.options.map((name, option) => ({
      id: `${index}-${option}`,
      name,
    })),
  }));
  const views = desiredViews.map((view, index) => ({
    id: `V${index}`,
    name: view.name,
    layout: view.layout,
    filter: view.filter,
    fields: { nodes: view.fields.map((name) => ({ name })) },
  }));
  assert.deepEqual(
    projectMachineDrift(config, {
      details: { title: config.project.title, number: 1, public: true },
      fields,
      views,
      repositories: [{ owner: { login: "boburning" }, name: "portcove" }],
    }),
    [],
  );
  fixtureElement(views, 0).filter = "wrong";
  fixtureElement(fields, 0).options = fixtureElement(fields, 0).options.filter(
    (option) => option.name !== "Done",
  );
  fixtureElement(fields, 1).options.push({ id: "unexpected", name: "Unexpected" });
  views.push({
    id: "extra",
    name: "Unexpected",
    layout: "TABLE_LAYOUT",
    filter: "",
    fields: { nodes: [{ name: "Title" }] },
  });
  const drift = projectMachineDrift(config, {
    details: { title: "Wrong", number: 1, public: false },
    fields,
    views,
    repositories: [],
  });
  assert.ok(drift.some((value) => value.includes("project title")));
  assert.ok(drift.some((value) => value.includes("visibility")));
  assert.ok(drift.some((value) => value.includes("not linked")));
  assert.ok(drift.some((value) => value.includes("field Status")));
  assert.ok(drift.some((value) => value.includes("unexpected options")));
  assert.ok(drift.some((value) => value.includes("view Next Queue")));
  assert.ok(drift.some((value) => value.includes("unexpected view")));
  assert.ok(
    viewMachineDrift(fixtureElement(desiredViews, 0), fixtureElement(views, 0)).some((value) =>
      value.includes("filter"),
    ),
  );
});

void test("one-port-one-issue coverage rejects missing duplicate grouped and draft authority", () => {
  const catalog = { ports: [{ id: "one" }, { id: "two" }] };
  const repositoryIssue = (number: number, id: string) => ({
    number,
    title: `[Port] ${id}`,
    type: "Issue",
    url: `https://github.com/boburning/portcove/issues/${number}`,
    body: renderPortIssueBody({
      title: id,
      upstream: `https://example.test/${id}`,
      catalogId: id,
    }),
  });
  const projectItem = (issue: RoadmapIssueItem, workType = "Port") => ({
    title: issue.title,
    "work type": workType,
    content: issue,
  });
  const first = repositoryIssue(1, "one");
  const second = repositoryIssue(2, "two");
  assert.deepEqual(
    validatePortIssueCoverage(
      catalog,
      [projectItem(first), projectItem(second)],
      "boburning/portcove",
      [first, second],
    ),
    [],
  );
  const duplicateIssue = repositoryIssue(2, "one");
  const duplicate = validatePortIssueCoverage(
    catalog,
    [projectItem(first), projectItem(duplicateIssue)],
    "boburning/portcove",
    [first, duplicateIssue],
  );
  assert.ok(duplicate.some((value) => value.includes("Two live issues")));
  assert.ok(duplicate.some((value) => value.includes("lacks a canonical")));
  const grouped = repositoryIssue(3, "one");
  grouped.body += "\n<!-- portcove-catalog-id: two -->";
  assert.ok(
    validatePortIssueCoverage(catalog, [projectItem(grouped)], "boburning/portcove", [
      grouped,
    ]).some((value) => value.includes("multiple catalog ports")),
  );
  const draft = {
    title: "Draft only",
    "work type": "Port",
    content: { type: "DraftIssue", body: "<!-- portcove-port -->" },
  };
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [draft], "boburning/portcove").some((value) =>
      value.includes("not backed"),
    ),
  );
  assert.ok(
    validatePortIssueCoverage(catalog, [projectItem(first)], "boburning/portcove", [
      first,
      second,
    ]).some((value) => value.includes("not in the Project")),
  );
  assert.ok(
    validatePortIssueCoverage(
      { ports: [{ id: "one" }] },
      [projectItem(first, "Research")],
      "boburning/portcove",
      [first],
    ).some((value) => value.includes("not classified as Work type = Port")),
  );
  const external = structuredClone(first);
  external.url = "https://github.com/example/other/issues/1";
  assert.ok(
    validatePortIssueCoverage(
      { ports: [{ id: "one" }] },
      [projectItem(external)],
      "boburning/portcove",
      [first],
    ).some((value) => value.includes("not in the Project")),
  );
});

void test("intake permits integration completion without inventing gameplay qualification", () => {
  const body = renderPortIssueBody({
    title: "Fixture",
    upstream: "https://example.test/fixture",
    portKey: "fixture",
  });
  assert.doesNotThrow(() => validateDurableIssueBody(body));
  assert.match(body, /absent optional gameplay evidence as Unknown, not failure/);
  assert.match(body, /explicit hands-on support claims still require actual observations/);
  assert.match(body, /Unsupported management operations remain unavailable with reasons/);
  assert.match(body, /Manual qualification: Not yet recorded/);
  assert.doesNotMatch(body, /required hands-on behavior for each claimed platform/);
});

void test("one-port-one-issue coverage requires unique candidate keys and allows shared upstream multi-game repositories", () => {
  const issue = (number: number, title: string, body: string) => ({
    number,
    title,
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/" + number,
    body,
  });
  const projectItem = (repositoryIssue: RoadmapIssueItem) => ({
    title: repositoryIssue.title,
    "work type": "Port",
    content: repositoryIssue,
  });
  const first = issue(
    1,
    "[Port] One",
    renderPortIssueBody({
      title: "One",
      upstream: "https://example.test/shared",
      portKey: "one",
    }),
  );
  const second = issue(
    2,
    "[Port] Two",
    renderPortIssueBody({
      title: "Two",
      upstream: "https://example.test/shared/",
      portKey: "two",
    }),
  );
  assert.deepEqual(
    validatePortIssueCoverage(
      { ports: [] },
      [projectItem(first), projectItem(second)],
      "boburning/portcove",
      [first, second],
    ),
    [],
  );
  const duplicateKey = issue(
    3,
    "[Port] Different title",
    renderPortIssueBody({
      title: "Different title",
      upstream: "https://example.test/other",
      portKey: "one",
    }),
  );
  assert.ok(
    validatePortIssueCoverage(
      { ports: [] },
      [projectItem(first), projectItem(duplicateKey)],
      "boburning/portcove",
      [first, duplicateKey],
    ).some((value) => value.includes("non-catalog port key one")),
  );
  const unlabeled = issue(
    4,
    "[Port] Three",
    "<!-- portcove-port -->\n<!-- portcove-upstream: https://example.test/three -->",
  );
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [
      unlabeled,
    ]).some((value) => value.includes("research/watchlist")),
  );
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [
      unlabeled,
    ]).some((value) => value.includes("durable port key")),
  );
});

void test("capture-port deduplication normalizes punctuation titles and combines upstream with game identity", () => {
  const existing = {
    number: 1,
    title: "[Port] Pokémon: Yellow!",
    url: "https://github.com/boburning/portcove/issues/1",
    body: renderPortIssueBody({
      title: "Pokémon: Yellow!",
      upstream: "https://github.com/example/shared.git/",
      portKey: "pokemon-yellow",
    }),
  };
  assert.equal(normalizePortKey("Pokémon: Yellow!"), "pokemon-yellow");
  assert.ok(
    findPortIssueDuplicates([existing], {
      title: "Pokemon Yellow",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-yellow",
    }).length === 1,
  );
  assert.deepEqual(
    findPortIssueDuplicates([existing], {
      title: "Pokemon Red",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-red",
    }),
    [],
  );
  assert.throws(
    () =>
      renderPortIssueBody({
        title: "Missing key",
        upstream: "https://example.test/port",
      }),
    /requires a durable --port-key/,
  );
});

void test("New Port form parsing requires a canonical key and direct https upstream", () => {
  const body = `### Direct upstream URL

https://github.com/example/shared

### Durable game or target key

pokemon-yellow

### User outcome and why this port matters

Play the game.`;
  assert.deepEqual(parsePortIssueForm(body), {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  assert.throws(
    () => parsePortIssueForm(body.replace("pokemon-yellow", "Pokemon Yellow")),
    /canonical lowercase kebab-case: pokemon-yellow/,
  );
  assert.throws(
    () =>
      parsePortIssueForm(
        body.replace("https://github.com/example/shared", "http://example.test/shared"),
      ),
    /valid https URL/,
  );
  assert.throws(
    () => parsePortIssueForm(body.replace("https://github.com/example/shared", "_No response_")),
    /missing Direct upstream/,
  );
  assert.throws(
    () => parsePortIssueForm(body.replace("pokemon-yellow", "_No response_")),
    /missing Durable game/,
  );
});

void test("marker reconciliation preserves form content and is repeatable", () => {
  const body = `### Direct upstream URL

https://github.com/example/shared

### Durable game or target key

pokemon-yellow

Contributor evidence stays here.

<!-- portcove-port -->
<!-- portcove-port -->
<!-- portcove-upstream: https://wrong.test -->
<!-- portcove-port-key: wrong -->`;
  const once = reconcilePortIssueMarkers(body, {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  const twice = reconcilePortIssueMarkers(once, {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  assert.equal(once, twice);
  assert.match(once, /Contributor evidence stays here/);
  assert.equal(fixtureValue(once.match(/<!-- portcove-port -->/g)).length, 1);
  assert.equal(fixtureValue(once.match(/<!-- portcove-upstream:/g)).length, 1);
  assert.equal(fixtureValue(once.match(/<!-- portcove-port-key:/g)).length, 1);
});

void test("doctor discovers unnormalized open [Port] issues but ignores ordinary body mentions", () => {
  const form = {
    number: 10,
    title: "[Port] Form Candidate",
    state: "OPEN",
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://example.test/form\n\n### Durable game or target key\n\nform-candidate\n\nSubmitting this form does not grant support.`,
  };
  const item = { title: form.title, "work type": "Research", content: form };
  const errors = validatePortIssueCoverage({ ports: [] }, [item], "boburning/portcove", [form]);
  assert.ok(
    errors.some(
      (value) =>
        value.includes("lacks the canonical port marker") &&
        value.includes("normalize-port --issue 10"),
    ),
  );
  assert.ok(errors.some((value) => value.includes("exactly one direct upstream")));
  assert.ok(errors.some((value) => value.includes("not classified as Work type = Port")));
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [form]).some((value) =>
      value.includes("not in the Project"),
    ),
  );
  const unrelated = {
    number: 11,
    title: "Discuss intake",
    state: "OPEN",
    body: "The text [Port] appears here.",
    url: "https://github.com/boburning/portcove/issues/11",
  };
  assert.deepEqual(
    validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [unrelated]),
    [],
  );
});

void test("deduplication sees punctuation-equivalent unnormalized form issues and permits distinct shared-upstream targets", () => {
  const formIssue = {
    number: 10,
    title: "[Port] Pokémon: Yellow!",
    state: "OPEN",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://github.com/example/shared\n\n### Durable game or target key\n\npokemon-yellow`,
  };
  assert.ok(
    fixtureElement(
      findPortIssueDuplicates([formIssue], {
        title: "Pokemon Yellow",
        upstream: "https://github.com/example/shared/",
        portKey: "pokemon-yellow",
      }),
      0,
    ).reasons.includes("normalized title pokemon-yellow"),
  );
  assert.deepEqual(
    findPortIssueDuplicates([formIssue], {
      title: "Pokemon Red",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-red",
    }),
    [],
  );
});

void test("Port stage validation is evidence-based and platform-scoped", () => {
  const catalog = {
    ports: [
      {
        id: "no-evidence",
        support_tier: "stable",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "automated",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "windows-qualified",
        support_tier: "alpha",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id: string, stage: string, blocker?: string) => ({
    id: `item-${id}-${stage}`,
    title: `[Port] ${id}`,
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: `https://github.com/boburning/portcove/issues/${id}`,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
        ...(blocker === undefined ? {} : { blocker }),
      }),
    },
  });
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("no-evidence", "Cataloged")]).errors,
    [],
  );
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("automated", "Automated qualification")]).errors,
    [],
  );
  const stableOverclaim = validatePortStageSemantics(catalog, [item("no-evidence", "Supported")]);
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no automated evidence")));
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no platform with matching")));
  const supported = validatePortStageSemantics(catalog, [item("windows-qualified", "Supported")]);
  assert.deepEqual(supported.errors, []);
  assert.deepEqual(qualifiedPlatforms(catalog.ports[2]), ["windows"]);
  assert.match(fixtureElement(supported.diagnostics, 0), /qualified platforms = windows/);
  assert.ok(
    validatePortStageSemantics(catalog, [item("windows-qualified", "Cataloged")]).warnings.length >
      0,
  );
});

function qualificationScope(portId: string, platform = "windows") {
  return {
    port_id: portId,
    platform,
    artifact_sha256: "a".repeat(64),
    upstream_ref: "v1",
    contract_id: "fixture-contract",
    variant: {
      state: "exact",
      identity: {
        game_id: "fixture-game",
        variant_id: "retail",
        representation_id: "canonical",
      },
    },
    check_version: "fixture-v1",
  };
}

void test("Port stage validation consumes only passed exact qualification records", () => {
  const port = {
    id: "exact",
    platforms: ["windows", "linux"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const record = (kind: string, outcome: string, platform = "windows") => ({
    scope: qualificationScope(port.id, platform),
    kind,
    outcome,
  });
  const item = (stage: string) => ({
    id: `exact-${stage}`,
    title: "[Port] Exact",
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Exact",
        upstream: "https://example.test/exact",
        catalogId: port.id,
      }),
    },
  });
  const records = [
    record("automated_lifecycle", "passed"),
    record("automated_lifecycle", "passed"),
    record("known_failure", "failed"),
    record("hands_on", "passed"),
    record("structural_check", "passed", "linux"),
    record("automated_lifecycle", "failed", "linux"),
  ];
  const catalog = { ports: [port], source_catalog: { qualification: records } };

  assert.deepEqual(qualifiedPlatforms(port, records), ["windows"]);
  assert.deepEqual(validatePortStageSemantics(catalog, [item("Supported")]).errors, []);
  assert.match(
    fixtureElement(validatePortStageSemantics(catalog, [item("Supported")]).diagnostics, 0),
    /qualified platforms = windows/,
  );

  for (const disallowed of [
    [record("structural_check", "passed")],
    [record("automated_lifecycle", "failed")],
    [record("automated_lifecycle", "passed", "steam-deck")],
  ]) {
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: disallowed } },
      [item("Automated qualification")],
    );
    assert.ok(result.errors.some((value) => value.includes("no automated evidence")));
  }

  const handsOnOnly = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: { qualification: [record("hands_on", "passed")] },
    },
    [item("Supported")],
  );
  assert.ok(handsOnOnly.errors.some((value) => value.includes("manual evidence without matching")));
  assert.ok(handsOnOnly.errors.some((value) => value.includes("no platform with matching")));

  const undeclaredHandsOn = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: {
        qualification: [
          record("automated_lifecycle", "passed"),
          record("hands_on", "passed", "steam-deck"),
        ],
      },
    },
    [item("Automated qualification")],
  );
  assert.ok(
    undeclaredHandsOn.errors.some(
      (value) =>
        value.includes("manual evidence without matching declared automated qualification") &&
        value.includes("steam-deck"),
    ),
  );
});

void test("Supported requires complete matching exact scopes and separate legacy intersections", () => {
  const port = {
    id: "scoped",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const auto = {
    scope: qualificationScope(port.id),
    kind: "automated_lifecycle",
    outcome: "passed",
  };
  const hands = { ...structuredClone(auto), kind: "hands_on" };
  const item = {
    id: "scoped",
    title: "[Port] Scoped",
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Scoped",
        upstream: "https://example.test/scoped",
        catalogId: port.id,
      }),
    },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, hands]), ["windows"]);
  for (const path of [
    ["port_id"],
    ["platform"],
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
    ["check_version"],
  ]) {
    const changed = structuredClone(hands);
    const parent = fixtureObject(
      path.slice(0, -1).reduce<unknown>((value, key) => fixtureObject(value)[key], changed.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    const previous = parent[key];
    assert.ok(typeof previous === "string");
    parent[key] = key === "artifact_sha256" ? "b".repeat(64) : `${previous}-different`;
    const records = [auto, changed];
    assert.deepEqual(qualifiedPlatforms(port, records), [], path.join("."));
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: records } },
      [item],
    );
    assert.ok(
      result.errors.some((error) => error.includes("no platform with matching")),
      path.join("."),
    );
    assert.deepEqual(
      planPortStageReconciliation({ ports: [port], source_catalog: { qualification: records } }, [
        item,
      ]).map((change) => change.to),
      ["Automated qualification"],
    );
  }
  for (const path of [
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["check_version"],
    ["variant"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
  ]) {
    const incomplete = structuredClone(hands);
    const parent = fixtureObject(
      path
        .slice(0, -1)
        .reduce<unknown>((value, key) => fixtureObject(value)[key], incomplete.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    delete parent[key];
    assert.deepEqual(qualifiedPlatforms(port, [auto, incomplete]), [], path.join("."));
    const incompleteAuto = { ...incomplete, kind: "automated_lifecycle" };
    assert.deepEqual(qualifiedPlatforms(port, [incompleteAuto, incomplete]), [], path.join("."));
  }
  const unknown = {
    ...structuredClone(hands),
    scope: { ...hands.scope, variant: { state: "unknown" } },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, unknown]), []);
  for (const digest of [["a".repeat(64)], 42, {}]) {
    const malformedAuto = {
      ...structuredClone(auto),
      scope: { ...auto.scope, artifact_sha256: digest },
    };
    const malformedHands = { ...structuredClone(malformedAuto), kind: "hands_on" };
    assert.deepEqual(qualifiedPlatforms(port, [malformedAuto, malformedHands]), []);
    const malformedCatalog = {
      ports: [port],
      source_catalog: {
        qualification: [malformedAuto, malformedHands],
      },
    };
    assert.ok(
      validatePortStageSemantics(malformedCatalog, [
        { ...item, "port stage": "Automated qualification" },
      ]).errors.some((error) => error.includes("no automated evidence")),
    );
  }
  const failed = { ...hands, outcome: "failed" };
  assert.deepEqual(qualifiedPlatforms(port, [auto, failed]), []);
  const legacyAuto = { ...port, automated_tested_platforms: ["windows"] };
  const legacyHands = { ...port, manually_validated_platforms: ["windows"] };
  assert.deepEqual(qualifiedPlatforms(legacyAuto, [hands]), []);
  assert.deepEqual(qualifiedPlatforms(legacyHands, [auto]), []);
  assert.deepEqual(
    qualifiedPlatforms({ ...legacyAuto, manually_validated_platforms: ["windows"] }, []),
    ["windows"],
  );
  assert.deepEqual(qualifiedPlatforms(port, [hands, auto, hands]), ["windows"]);
});

void test("Port stage validation rejects broken manual evidence non-catalog overclaim and unsupported rejection", () => {
  const invalidManual = {
    id: "manual-only",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: ["windows"],
  };
  const nonCatalog = {
    title: "[Port] Candidate",
    "port stage": "Supported",
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Candidate",
        upstream: "https://example.test/candidate",
        portKey: "candidate",
      }),
    },
  };
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, [nonCatalog]).errors.some((value) =>
      value.includes("exactly one valid catalog ID"),
    ),
  );
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, []).errors.some((value) =>
      value.includes("manual evidence without matching"),
    ),
  );

  const blocked = structuredClone(nonCatalog);
  blocked["port stage"] = "Blocked";
  blocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
    blocker: "No artifact exists. Resume when upstream publishes one.",
  });
  const rejected = structuredClone(nonCatalog);
  rejected["port stage"] = "Rejected";
  assert.deepEqual(validatePortStageSemantics({ ports: [] }, [blocked, rejected]).errors, []);
  const invalidBlocked = structuredClone(blocked);
  invalidBlocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
  });
  assert.ok(
    validatePortStageSemantics({ ports: [] }, [invalidBlocked]).errors.some((value) =>
      value.includes("lacks a usable blocker and exact resume condition"),
    ),
  );

  const catalogRejected = structuredClone(rejected);
  catalogRejected.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    catalogId: "candidate",
  });
  assert.ok(
    validatePortStageSemantics(
      {
        ports: [
          {
            id: "candidate",
            platforms: [],
            automated_tested_platforms: [],
            manually_validated_platforms: [],
          },
        ],
      },
      [catalogRejected],
    ).errors.some((value) => value.includes("still represented as catalog-supported")),
  );
});

void test("Supported reconciliation only downgrades overstatement and becomes idempotent after application", () => {
  const catalog = {
    ports: [
      {
        id: "none",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "auto",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "qualified",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id: string) => ({
    id,
    title: `[Port] ${id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: id,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
      }),
    },
  });
  const items = catalog.ports.map((port) => item(port.id));
  const plan = planPortStageReconciliation(catalog, items);
  assert.deepEqual(
    plan.map((change) => [change.itemId, change.to]),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
  for (const change of plan)
    fixtureFind(items, (candidate) => candidate.id === change.itemId)["port stage"] = change.to;
  assert.deepEqual(planPortStageReconciliation(catalog, items), []);
});

void test("Supported reconciliation planning uses exact automated and hands-on records", () => {
  const ports = ["none", "auto", "qualified"].map((id) => ({
    id,
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  }));
  const qualification = [
    {
      scope: qualificationScope("auto"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
      kind: "hands_on",
      outcome: "passed",
    },
  ];
  const items = ports.map((port) => ({
    id: port.id,
    title: `[Port] ${port.id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: port.id,
      body: renderPortIssueBody({
        title: port.id,
        upstream: `https://example.test/${port.id}`,
        catalogId: port.id,
      }),
    },
  }));

  assert.deepEqual(
    planPortStageReconciliation({ ports, source_catalog: { qualification } }, items).map(
      (change) => [change.itemId, change.to],
    ),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
});

void test("normalization initializes only unset neutral fields and always classifies Work type as Port", () => {
  const existing = {
    status: "Ready",
    priority: "High",
    horizon: "Next",
    "target release": "Alpha 2",
    "work type": "Research",
    workstream: "Sources and ROM validation",
    platform: "Windows",
    "port stage": "Researching",
    effort: "M",
  };
  assert.deepEqual(portFieldInitialization(existing), { "Work type": "Port" });
  assert.deepEqual(portFieldInitialization(null), {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Port",
    Workstream: "Port catalog",
    Platform: "Unknown",
    "Port stage": "Watchlist",
    Effort: "Unknown",
  });
});

void test("final UX audit origins require complete unique enumerated canonical ownership", () => {
  assert.equal(uxAuditOriginIds.length, 178);
  const completeBody = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.join(" ") + " -->";
  const item = (number: number, body: string) => ({
    title: "Owner " + number,
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/" + number,
      body,
    },
  });
  assert.deepEqual(uxAuditOrigins(completeBody), uxAuditOriginIds);
  assert.deepEqual(validateUxAuditOriginCoverage([item(1, completeBody)]), []);

  const missing = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.slice(1).join(" ") + " -->";
  assert.ok(
    validateUxAuditOriginCoverage([item(1, missing)]).some((value) =>
      value.includes("lacks a canonical issue: SYS-01"),
    ),
  );

  const duplicate = "<!-- portcove-ux-audit-origins: SYS-01 -->";
  assert.ok(
    validateUxAuditOriginCoverage([item(1, completeBody), item(2, duplicate)]).some((value) =>
      value.includes("duplicate owners: SYS-01"),
    ),
  );

  for (const [body, expected] of [
    ["<!-- portcove-ux-audit-origins: SYS-99 -->", "Unknown UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-1 -->", "Malformed UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-01..SYS-14 -->", "range must enumerate"],
    ["<!-- portcove-wording-audit-origins: WORD-01 -->", "Superseded wording audit"],
  ] as const) {
    assert.ok(
      validateUxAuditOriginCoverage([item(1, body)]).some((value) => value.includes(expected)),
    );
  }
});

void test("supported-source plan origin has exactly one canonical owner", () => {
  const marker = "<!-- portcove-origins: PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04 -->";
  const item = (number: number, body: string) => ({
    title: "Owner " + number,
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/" + number,
      body,
    },
  });
  assert.deepEqual(validatePlanOriginCoverage([item(36, marker)]), []);
  assert.ok(fixtureElement(validatePlanOriginCoverage([]), 0).includes("found 0"));
  assert.ok(
    fixtureElement(validatePlanOriginCoverage([item(36, marker), item(99, marker)]), 0).includes(
      "found 2",
    ),
  );
  assert.ok(
    fixtureElement(validatePlanOriginCoverage([item(99, marker)]), 0).includes(
      "must be owned by issue #36",
    ),
  );
});

void test("RoadmapClient capture uses mocked gh output and stores planning fields only in Project calls", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "item-create") return JSON.stringify({ id: "PVTI_draft", title: "Candidate" });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list")
      return JSON.stringify({
        fields: [
          {
            id: "PVTSSF_status",
            name: "Status",
            options: [{ id: "OPT_inbox", name: "Inbox" }],
          },
          {
            id: "PVTSSF_priority",
            name: "Priority",
            options: [{ id: "OPT_none", name: "None" }],
          },
        ],
      });
    if (args[1] === "graphql") return JSON.stringify({ data: {} });
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const result = client.capture({
    title: "Candidate",
    body: "Upstream: https://example.test/port",
    fields: { Status: "Inbox", Priority: "None" },
  });
  assert.equal(result.id, "PVTI_draft");
  assert.equal(calls.filter((call) => call.args[1] === "item-create").length, 1);
  const edit = calls.find((call) => call.input?.includes("updateProjectV2ItemFieldValue"));
  const variables = fixtureGraphql(edit?.input).variables;
  assert.deepEqual(
    Object.values(variables).map((value) => {
      const input = fixtureSelectInput(value);
      return [input.fieldId, input.value.singleSelectOptionId];
    }),
    [
      ["PVTSSF_status", "OPT_inbox"],
      ["PVTSSF_priority", "OPT_none"],
    ],
  );
});

void test("capture-port creates one Project-backed issue without depending on parent capacity", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const expectedFields = {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Port",
    Workstream: "Port catalog",
    Platform: "Unknown",
    "Port stage": "Watchlist",
    Effort: "Unknown",
  };
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues")
      return JSON.stringify({
        node_id: "I_new",
        html_url: "https://github.com/boburning/portcove/issues/88",
        number: 88,
      });
    if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[0] === "project" && args[1] === "field-list")
      return JSON.stringify({
        fields: Object.entries(expectedFields).map(([name, value], index) => ({
          id: `F${index}`,
          name,
          options: [{ id: `O${index}`, name: value }],
        })),
      });
    if (args[0] === "api" && args[1] === "graphql") {
      assert.doesNotMatch(
        fixtureValue(input),
        /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/,
      );
      if (fixtureValue(input).includes("issues(first: 100"))
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                totalCount: 0,
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      if (fixtureValue(input).includes("addProjectV2ItemById"))
        return JSON.stringify({
          data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } },
        });
      return JSON.stringify({
        data: {
          node: {
            projectItems: {
              totalCount: 0,
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  client.repositoryIssues = () => [];
  const result = client.createPortIssue({
    title: "New Port",
    upstream: "https://example.test/upstream",
    portKey: "new-port",
  });
  assert.equal(result.itemId, "PVTI_new");
  assert.equal(
    calls.filter((call) => call.args[2] === "repos/boburning/portcove/issues").length,
    1,
  );
  assert.ok(calls.some((call) => call.input?.includes("<!-- portcove-port -->")));
  assert.ok(calls.some((call) => call.input?.includes("<!-- portcove-port-key: new-port -->")));
  const fieldEdit = calls.find((call) => call.input?.includes("updateProjectV2ItemFieldValue"));
  assert.ok(
    Object.values(fixtureGraphql(fieldEdit?.input).variables).some((value) => {
      const input = fixtureSelectInput(value);
      return input.fieldId === "F6" && input.value.singleSelectOptionId === "O6";
    }),
  );
  assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 1);
});

for (const parentNumber of [null, 16, 777]) {
  void test(`normalize-port preserves planning and parent ${parentNumber ?? "absence"} idempotently`, () => {
    const calls: RunnerCall[] = [];
    const mockedConfig = structuredClone(config);
    mockedConfig.project.number = 7;
    let body = `### Direct upstream URL

https://github.com/example/form-port

### Durable game or target key

form-port

### User outcome and why this port matters

Preserve this contributor text.`;
    let workType = "Research";
    const issue = () => ({
      node_id: "I_form",
      html_url: "https://github.com/boburning/portcove/issues/42",
      number: 42,
      title: "[Port] Form Port",
      body,
      state: "OPEN",
      parent: parentNumber === null ? null : { number: parentNumber },
    });
    const fieldValues = () =>
      [
        ["Status", "Ready"],
        ["Priority", "High"],
        ["Horizon", "Next"],
        ["Target release", "Alpha 2"],
        ["Work type", workType],
        ["Workstream", "Sources and ROM validation"],
        ["Platform", "Windows"],
        ["Port stage", "Researching"],
        ["Effort", "M"],
      ].map(([name, value]) => ({ name: value, field: { name } }));
    const runner: GitHubRunner = (args, input) => {
      calls.push({ args, input });
      if (
        args[0] === "api" &&
        args[2] === "repos/boburning/portcove/issues/42" &&
        args.includes("PATCH")
      ) {
        const payload = fixtureJsonObject(input);
        assert.ok(typeof payload.body === "string");
        body = payload.body;
        return JSON.stringify(issue());
      }
      if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues/42")
        return JSON.stringify(issue());
      if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
      if (args[0] === "project" && args[1] === "field-list")
        return JSON.stringify({
          fields: [
            {
              id: "F_work_type",
              name: "Work type",
              options: [{ id: "O_port", name: "Port" }],
            },
          ],
        });
      if (args[0] === "api" && args[1] === "graphql") {
        assert.doesNotMatch(
          fixtureValue(input),
          /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/,
        );
        if (fixtureValue(input).includes("issues(first: 100"))
          return JSON.stringify({
            data: {
              repository: {
                issues: {
                  totalCount: 1,
                  nodes: [{ ...issue(), __typename: "Issue", url: issue().html_url }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        if (fixtureValue(input).includes("items(first: 50"))
          return JSON.stringify({
            data: {
              node: {
                items: {
                  totalCount: 1,
                  nodes: [
                    {
                      id: "PVTI_form",
                      content: {
                        __typename: "Issue",
                        number: 42,
                        title: issue().title,
                        body,
                        url: issue().html_url,
                        state: "OPEN",
                      },
                      fieldValues: {
                        totalCount: fieldValues().length,
                        nodes: fieldValues().map((value) => ({
                          ...value,
                          field: {
                            __typename: "ProjectV2SingleSelectField",
                            ...value.field,
                          },
                        })),
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        if (fixtureValue(input).includes("updateProjectV2ItemFieldValue")) {
          workType = "Port";
          return JSON.stringify({
            data: { f0: { projectV2Item: { id: "PVTI_form" } } },
          });
        }
      }
      return "";
    };
    const client = new RoadmapClient(mockedConfig, runner);
    client.repositoryIssues = () => [{ ...issue(), type: "Issue", url: issue().html_url }];
    const catalog = { ports: [] };
    const first = client.normalizePortIssue({ number: 42, catalog });
    assert.equal(first.bodyChanged, true);
    assert.equal(first.projectItemAdded, false);
    assert.deepEqual(first.fieldsChanged, ["Work type"]);
    assert.match(body, /Preserve this contributor text/);
    const second = client.normalizePortIssue({ number: 42, catalog });
    assert.equal(second.bodyChanged, false);
    assert.deepEqual(second.fieldsChanged, []);
    assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 0);
    assert.equal(calls.filter((call) => call.input?.includes("addSubIssue")).length, 0);
  });
}

function included(body: unknown, headers: Readonly<Record<string, string>> = {}) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/2.0 200 OK\r\n${lines.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`;
}

function restIssue(number: number, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    node_id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    html_url: `https://github.com/boburning/portcove/issues/${number}`,
    state: "open",
    ...overrides,
  };
}

void test("repository issue inventory follows every REST page and filters pull requests", () => {
  const calls: (readonly string[])[] = [];
  let markers = 0;
  const runner: GitHubRunner = (args: readonly string[]) => {
    calls.push(args);
    const endpoint = fixtureElement(args, 2);
    if (endpoint.includes("direction=desc")) {
      markers += 1;
      return included([restIssue(3, { pull_request: { url: "https://example.test" } })]);
    }
    if (endpoint === "https://api.github.test/issues?page=2")
      return included([restIssue(3, { pull_request: { url: "https://example.test" } })]);
    return included([restIssue(1), restIssue(2)], {
      link: '<https://api.github.test/issues?page=2>; rel="next"',
    });
  };
  const issues = new RoadmapClient(config, runner).repositoryIssues();
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.equal(markers, 2);
  assert.equal(calls.length, 4);
});

void test("repository issue inventory rejects pagination loops duplicates and a changing high-water mark", () => {
  const scenarios = [
    (args: readonly string[]) => {
      const endpoint = fixtureElement(args, 2);
      if (endpoint.includes("direction=desc")) return included([restIssue(1)]);
      return included([restIssue(1)], {
        link: `<${endpoint}>; rel="next"`,
      });
    },
    (args: readonly string[]) => {
      const endpoint = fixtureElement(args, 2);
      if (endpoint.includes("direction=desc")) return included([restIssue(1)]);
      return included([restIssue(1), restIssue(1)]);
    },
    (() => {
      let marker = 1;
      return (args: readonly string[]) => {
        if (fixtureElement(args, 2).includes("direction=desc"))
          return included([restIssue(marker++)]);
        return included([restIssue(1)]);
      };
    })(),
  ];
  for (const runner of scenarios) {
    assert.throws(
      () => new RoadmapClient(config, runner).repositoryIssues(),
      /inventory|pagination/,
    );
  }
});

void test("promotion validation happens before any GitHub mutation", () => {
  let calls = 0;
  const client = new RoadmapClient(config, () => {
    calls += 1;
    return "";
  });
  assert.throws(() => client.promote("PVTI_draft", "lightweight note"), /incomplete/);
  assert.equal(calls, 0);
});

void test("move refuses ambiguous item references", () => {
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args: readonly string[]) => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "graphql")
      return JSON.stringify({
        data: {
          node: {
            items: {
              totalCount: 3,
              nodes: [
                {
                  id: "A",
                  content: { __typename: "DraftIssue", title: "Same" },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "B",
                  content: { __typename: "DraftIssue", title: "Same" },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "C",
                  content: { __typename: "DraftIssue", title: "Before" },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    return "";
  };
  assert.throws(
    () => new RoadmapClient(mockedConfig, runner).moveBefore("Same", "Before"),
    /ambiguous/,
  );
});

void test("Project membership refuses malformed or stalled coverage before mutation", () => {
  const cases = [
    () => ({ totalCount: 0, nodes: [], pageInfo: {} }),
    () => ({ totalCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } }),
    (read: number) => ({
      totalCount: 4,
      nodes: [{ id: `I_${read}`, project: { id: "OTHER" } }],
      pageInfo: { hasNextPage: true, endCursor: "repeated" },
    }),
  ];
  for (const page of cases) {
    let reads = 0,
      mutations = 0;
    const client = new RoadmapClient(config, (args, input) => {
      if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "P_selected" });
      if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: [] });
      if (input?.includes("addProjectV2ItemById")) {
        mutations++;
        return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "I_new" } } } });
      }
      assert.ok(++reads <= 3, "fixture read budget exceeded");
      return JSON.stringify({ data: { node: { projectItems: page(reads) } } });
    });
    assert.throws(() => client.ensureIssueItem("I_source"), /incomplete GitHub inventory/);
    assert.equal(mutations, 0);
  }
});

void test("repository marker reserves empty sentinel for an actually empty response", () => {
  for (const marker of [
    [{}],
    [null],
    [{ number: null }],
    [{ number: 0 }],
    [{ number: 1 }, { number: 2 }],
  ]) {
    const client = new RoadmapClient(config, (args: readonly string[]) =>
      JSON.stringify(fixtureElement(args, 2).includes("per_page=1") ? marker : []),
    );
    assert.throws(() => client.repositoryIssues(), /invalid repository issue marker/);
  }
  const empty = new RoadmapClient(config, () => "[]");
  assert.deepEqual(empty.repositoryIssues(), []);
});

void test("RoadmapClient reuses an existing issue item instead of duplicating it", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list") return JSON.stringify({ fields: [] });
    if (args[0] === "api" && args[1] === "graphql") {
      const after = fixtureGraphql(input).variables.after;
      return JSON.stringify({
        data: {
          node: {
            projectItems: after
              ? {
                  totalCount: 2,
                  nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  totalCount: 2,
                  nodes: [{ id: "PVTI_other", project: { id: "OTHER" } }],
                  pageInfo: { hasNextPage: true, endCursor: "page2" },
                },
          },
        },
      });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  assert.deepEqual(client.ensureIssueItem("I_existing"), {
    id: "PVTI_existing",
    project: { id: "PVT_project" },
  });
  assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 0);
  assert.equal(calls.filter((call) => call.input?.includes("projectItems(first: 100")).length, 2);
});

void test("GraphQL view pagination reads every page", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const after = fixtureGraphql(input).variables.after;
    return JSON.stringify({
      data: {
        node: {
          id: "PVT",
          views: after
            ? {
                totalCount: 2,
                nodes: [completeView("V2", "Second")],
                pageInfo: { hasNextPage: false, endCursor: null },
              }
            : {
                totalCount: 2,
                nodes: [completeView("V1", "First")],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
        },
      },
    });
  };
  assert.deepEqual(
    new RoadmapClient(config, runner).viewList("PVT").map((view) => view.name),
    ["First", "Second"],
  );
  assert.equal(calls.length, 2);
});

function completeView(id: string, name: string) {
  type Field = { id: string; name: string };
  const empty = <T,>() => {
    const nodes: T[] = [];
    return { totalCount: 0, nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  };
  return {
    id,
    name,
    fields: empty<Field>(),
    groupByFields: empty<Field>(),
    verticalGroupByFields: empty<Field>(),
    sortByFields: empty<{ direction: string; field: Field }>(),
  };
}

void test("view renames retain identity and repeated reconciliation creates no duplicate", () => {
  const desired = {
    name: "Product Outcomes",
    previous_name: "Product Roadmap",
    layout: "TABLE_LAYOUT",
    filter: "label:roadmap-outcome",
    fields: ["Title"],
    manual_group_by: null,
    manual_sort_by: "manual",
  };
  const original = {
    ...completeView("V_original", "Product Roadmap"),
    layout: desired.layout,
    filter: desired.filter,
    fields: { nodes: [{ id: "F_title", name: "Title" }] },
  };
  const plan = planViewReconciliation([desired], [original]);
  assert.equal(fixtureElement(plan, 0).action, "update");
  assert.equal(fixtureValue(fixtureElement(plan, 0).actual).id, "V_original");
  const saved = { ...original, name: desired.name };
  assert.equal(fixtureElement(planViewReconciliation([desired], [saved]), 0).action, "keep");
  assert.throws(
    () => planViewReconciliation([desired], [original, { ...saved, id: "V_duplicate" }]),
    /ambiguous/,
  );
  assert.throws(() => planViewReconciliation([desired], [original, original]), /duplicate actual/);
  assert.throws(
    () => planViewReconciliation([desired, { ...desired, name: "Other" }], [original]),
    /duplicate view identity/,
  );
});

type ViewInventoryFixture = {
  id: string;
  views: {
    totalCount: number;
    nodes: ReturnType<typeof completeView>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
void test("view inventory refuses incomplete records rather than claiming a complete UI", () => {
  for (const alter of [
    (node: ViewInventoryFixture) => {
      node.id = "wrong";
    },
    (node: ViewInventoryFixture) => {
      // @ts-expect-error Missing total intentionally exercises incomplete provider data.
      delete node.views.totalCount;
    },
    (node: ViewInventoryFixture) => {
      node.views.totalCount = 2;
    },
    (node: ViewInventoryFixture) => {
      node.views.nodes.push(fixtureElement(node.views.nodes, 0));
      node.views.totalCount = 2;
    },
    (node: ViewInventoryFixture) => {
      fixtureElement(node.views.nodes, 0).fields.pageInfo.hasNextPage = true;
    },
    (node: ViewInventoryFixture) => {
      // @ts-expect-error Missing sort inventory intentionally exercises unavailable provider data.
      delete fixtureElement(node.views.nodes, 0).sortByFields;
    },
    (node: ViewInventoryFixture) => {
      node.views.pageInfo.hasNextPage = true;
      node.views.pageInfo.endCursor = null;
    },
  ]) {
    const node = {
      id: "PVT",
      views: {
        totalCount: 1,
        nodes: [completeView("V1", "One")],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    alter(node);
    assert.throws(
      () => new RoadmapClient(config, () => JSON.stringify({ data: { node } })).viewList("PVT"),
      /incomplete GitHub inventory/,
    );
  }
});

void test("Project provider observations reject malformed option scalars before planning", () => {
  const client = new RoadmapClient(config, () =>
    JSON.stringify({
      fields: [{ id: "F_status", name: "Status", options: [{ id: "O_bad", name: 7 }] }],
    }),
  );
  assert.throws(() => client.fieldList(config.project.number), /malformed Project option/);
});

void test("coordination history rejects coerced creation and edit timestamps", () => {
  const client = new RoadmapClient(config, () => assert.fail("unexpected API call"));
  const target = coordinationTarget(config, 1104);
  client.coordinationBinding = () => ({ number: target.number, comments: 1 });
  for (const field of ["createdAt", "updatedAt"]) {
    for (const timestamp of [0, ["2026-10-07T03:00:00Z"]]) {
      const record = {
        id: "IC_1",
        url: `${target.url}#issuecomment-1`,
        body: "retained",
        createdAt: "2026-10-07T03:00:00Z",
        updatedAt: "2026-10-07T03:00:00Z",
        [field]: timestamp,
      };
      client.graphql = () => ({
        repository: {
          issue: {
            url: target.url,
            comments: {
              totalCount: 1,
              nodes: [record],
              pageInfo: { hasPreviousPage: false },
            },
          },
        },
      });
      assert.throws(() => client.coordinationRecords(target), /unavailable or incomplete/);
    }
  }
});

void test("readable grouping and sorting distinguish empty settings from unavailable evidence", () => {
  const desired = {
    name: "One",
    layout: "TABLE_LAYOUT",
    filter: "",
    fields: [],
    manual_group_by: "Status",
    manual_sort_by: "Priority,manual",
  };
  const actual = { ...completeView("V1", "One"), layout: desired.layout, filter: "" };
  assert.match(
    viewMachineDrift(desired, actual).join("\n"),
    /grouping nothing.*UI change required/,
  );
  actual.groupByFields.nodes = [{ id: "F_status", name: "Status" }];
  actual.sortByFields.nodes = [{ direction: "ASC", field: { id: "F_priority", name: "Priority" } }];
  assert.deepEqual(viewMachineDrift(desired, actual), []);
  fixtureElement(actual.sortByFields.nodes, 0).direction = "DESC";
  assert.match(viewMachineDrift(desired, actual).join("\n"), /Priority:DESC/);
  fixtureElement(actual.sortByFields.nodes, 0).direction = "ASC";
  actual.verticalGroupByFields.nodes = [{ id: "F_hidden", name: "Platform" }];
  assert.match(viewMachineDrift(desired, actual).join("\n"), /secondary grouping Platform/);
});

void test("view reconciliation preflights every view and verifies saved identities", () => {
  const desired = {
    name: "One",
    layout: "TABLE_LAYOUT",
    filter: "wanted",
    fields: ["Title"],
    manual_group_by: null,
    manual_sort_by: "manual",
  };
  const views = [desired, { ...desired, name: "Two" }];
  const settings = { ...config, views };
  const saved = views.map((view, index) => ({
    ...completeView(`V${index}`, view.name),
    layout: view.layout,
    filter: "old",
    fields: { nodes: [{ id: "Ftitle", name: "Title" }] },
  }));
  const client = new RoadmapClient(settings, () => {
    throw new Error("unexpected GitHub call");
  });
  client.viewList = () => saved;
  const writes = [];
  client.graphql = (_query, variables) => {
    const input = fixtureObject(fixtureValue(variables).input);
    assert.ok(typeof input.viewId === "string" && typeof input.filter === "string");
    writes.push(input);
    const target = fixtureValue(saved.find((view) => view.id === input.viewId));
    Object.assign(target, { filter: input.filter });
  };
  fixtureElement(saved, 1).groupByFields.nodes = [{ id: "Fstatus", name: "Status" }];
  assert.throws(() => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]), /owner UI/);
  assert.equal(writes.length, 0);
  fixtureElement(saved, 1).groupByFields.nodes = [];
  client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]);
  assert.equal(writes.length, 2);
  assert.equal(
    client
      .reconcileViews("P", [{ id: "Ftitle", name: "Title" }])
      .every((step) => step.action === "keep"),
    true,
  );
  fixtureElement(saved, 0).filter = "old";
  client.graphql = () => {};
  assert.throws(
    () => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]),
    /readback did not match/,
  );
});

void test("display outcome markers and release views cannot change gate or execution membership", () => {
  const fields = {
    Status: "Ready",
    Horizon: "Next",
    Priority: "High",
    "Work type": "Product feature",
    "Target release": "Public beta",
    "Release commitment": "Planned",
  };
  const item = {
    id: "PVTI_demo",
    content: { number: 99, state: "OPEN", title: "Demo", body: "" },
    fieldValues: Object.entries(fields).map(([name, value]) => ({ name: value, field: { name } })),
  };
  const marked = { ...item, labels: [config.outcome_label] };
  const summarize = (record: RoadmapIssueItem) => {
    const analysis = analyzeReleaseReadiness([record], "Public beta");
    return {
      ready: analysis.ready,
      required: analysis.effectiveRequired.map((entry) => entry.id),
      unfinished: analysis.unfinishedRequired.map((entry) => entry.id),
      planned: analysis.planned.map((entry) => entry.id),
    };
  };
  assert.deepEqual(summarize(item), summarize(marked));
  assert.equal(selectNextItems([marked])[0], marked);
  const byName = new Map(materializeViews(config).map((view) => [view.name, view]));
  assert.match(fixtureValue(byName.get("Product Outcomes")).filter, /label:roadmap-outcome/);
  assert.doesNotMatch(fixtureValue(byName.get("Product Outcomes")).filter, /-status:Done/);
  assert.match(fixtureValue(byName.get("In Progress")).filter, /status:/);
  assert.doesNotMatch(fixtureValue(byName.get("In Progress")).filter, /horizon:/);
  assert.equal(fixtureValue(byName.get("Port Pipeline")).filter, "work-type:Port");
  assert.match(fixtureValue(byName.get("Required for Beta")).filter, /release-commitment:Required/);
  assert.match(fixtureValue(byName.get("Planned Additions")).filter, /release-commitment:Planned/);
});

void test("complete Project context reads every field page with opaque identity checks", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    const request = fixtureGraphql(input);
    const after = request.variables.after;
    return JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT",
            number: 1,
            title: "Portcove Roadmap",
            url: "https://github.test/project/1",
            public: true,
            closed: false,
            fields: {
              totalCount: 2,
              nodes: [
                {
                  id: after ? "F2" : "F1",
                  name: after ? "Priority" : "Status",
                  dataType: "SINGLE_SELECT",
                  options: [],
                },
              ],
              pageInfo: after
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: "field-page-2" },
            },
          },
        },
      },
    });
  };
  const context = new RoadmapClient(config, runner).completeProjectContext(1);
  assert.deepEqual(
    context.fields.map((field) => field.id),
    ["F1", "F2"],
  );
  assert.equal(calls.filter((call) => call.input).length, 2);
});

void test("GraphQL Project item pagination reads every item with normalized fields", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT" });
    const after = fixtureGraphql(input).variables.after;
    const item = after
      ? {
          id: "I2",
          content: { __typename: "DraftIssue", title: "Second", body: "Draft" },
          fieldValues: {
            totalCount: 1,
            nodes: [{ name: "Inbox", field: { name: "Status" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      : {
          id: "I1",
          content: {
            __typename: "Issue",
            number: 1,
            title: "First",
            body: "Issue",
            url: "https://github.com/boburning/portcove/issues/1",
            state: "OPEN",
          },
          fieldValues: {
            totalCount: 1,
            nodes: [{ name: "Port", field: { name: "Work type" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 2,
            nodes: [item],
            pageInfo: after
              ? { hasNextPage: false, endCursor: null }
              : { hasNextPage: true, endCursor: "next" },
          },
        },
      },
    });
  };
  const items = new RoadmapClient(config, runner).itemList(1);
  assert.deepEqual(
    items.map((item) => [item.id, item.title, item.type]),
    [
      ["I1", "First", "Issue"],
      ["I2", "Second", "DraftIssue"],
    ],
  );
  assert.equal(fieldValue(items[0], "Work type"), "Port");
  assert.equal(fieldValue(items[1], "Status"), "Inbox");
  assert.equal(calls.filter((call) => call.args[1] === "graphql").length, 2);
});

void test("Project item inventory rejects a truncated nested field connection", () => {
  const runner: GitHubRunner = (args: readonly string[]) => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT" });
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 1,
            nodes: [
              {
                id: "I1",
                fieldValues: {
                  totalCount: 2,
                  nodes: [{ name: "Ready", field: { name: "Status" } }],
                  pageInfo: { hasNextPage: true, endCursor: "field-page" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };
  assert.throws(() => new RoadmapClient(config, runner).itemList(1), /fields are truncated/);
});

void test("set-many validates transitions before one mutation and exact readback", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  let status = "Ready";
  const fieldConnection = () => ({
    totalCount: 1,
    nodes: [{ name: status, field: { name: "Status" } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    if (args[0] === "project" && args[1] === "view")
      return JSON.stringify({ id: "PVT", number: 7 });
    if (args[0] === "project" && args[1] === "field-list")
      return JSON.stringify({
        fields: [
          {
            id: "F_status",
            name: "Status",
            options: [
              { id: "O_ready", name: "Ready" },
              { id: "O_done", name: "Done" },
            ],
          },
        ],
      });
    const request = fixtureGraphql(input);
    if (request.query.includes("projectV2(number:"))
      return JSON.stringify({
        data: {
          user: {
            projectV2: {
              id: "PVT",
              number: 7,
              title: "Portcove Roadmap",
              url: "https://github.test/project/7",
              public: true,
              closed: false,
              shortDescription: "Roadmap",
              readme: "Readme",
              fields: {
                totalCount: 1,
                nodes: [
                  {
                    __typename: "ProjectV2SingleSelectField",
                    id: "F_status",
                    name: "Status",
                    dataType: "SINGLE_SELECT",
                    options: [
                      { id: "O_ready", name: "Ready" },
                      { id: "O_done", name: "Done" },
                    ],
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    if (request.query.includes("items(first: 50"))
      return JSON.stringify({
        data: {
          node: {
            items: {
              totalCount: 1,
              nodes: [
                {
                  id: "PVTI_838",
                  content: {
                    __typename: "Issue",
                    number: 838,
                    url: "https://github.com/boburning/portcove/issues/838",
                  },
                  fieldValues: fieldConnection(),
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (request.query.includes("updateProjectV2ItemFieldValue")) {
      status = "Done";
      return JSON.stringify({ data: { f0: { projectV2Item: { id: "PVTI_838" } } } });
    }
    if (request.query.includes("nodes(ids:"))
      return JSON.stringify({
        data: { nodes: [{ id: "PVTI_838", fieldValues: fieldConnection() }] },
      });
    throw new Error(`unexpected GraphQL request: ${request.query}`);
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const spec = {
    schema_version: 1,
    updates: [{ target: "#838", fields: { Status: { from: "Ready", to: "Done" } } }],
  };
  const plan = client.planSetMany(spec);
  assert.equal(plan.pending.length, 1);
  client.applySetMany(plan);
  assert.ok(client.verifySetMany(plan).every((result) => result.verified));
  assert.equal(calls.filter((call) => call.input?.includes("items(first: 50")).length, 1);
  assert.equal(
    calls.filter((call) => call.input?.includes("updateProjectV2ItemFieldValue")).length,
    1,
  );
});

void test("set-many specifications fail closed before GitHub access", () => {
  const invalid = [
    { schema_version: 2, updates: [] },
    { schema_version: 1, updates: [] },
    {
      schema_version: 1,
      updates: [{ target: "#1", fields: { Status: { from: "Ready", to: "Ready" } } }],
    },
    {
      schema_version: 1,
      updates: [
        { target: "#1", fields: { Status: { from: "Ready", to: "Done" } } },
        { target: "#1", fields: { Status: { from: "Ready", to: "Done" } } },
      ],
    },
  ];
  for (const spec of invalid) assert.throws(() => validateSetManySpec(config, spec));
  const tooLarge = {
    schema_version: 1,
    updates: Array.from({ length: 11 }, (_, index) => ({
      target: `#${index + 1}`,
      fields: Object.fromEntries(
        config.fields.map((field) => [
          field.name,
          { from: field.options[0], to: field.options[1] },
        ]),
      ),
    })),
  };
  assert.throws(() => validateSetManySpec(config, tooLarge), /at most 100/);
  assert.equal(setManyRequiredReserve(11, 1), 123);
  assert.equal(setManyRequiredReserve(11, 100), 147);
  for (const values of [
    [-1, 1],
    [1, -1],
    [1, 101],
  ] as const)
    assert.throws(() => setManyRequiredReserve(values[0], values[1]), /quota inputs/);
});

function adaptiveSetManyFixture(
  count: number,
  {
    rates = null,
    mutationError = false,
  }: {
    rates?: readonly ReturnType<SetManyClient["sampleGraphqlRate"]>[] | null;
    mutationError?: boolean;
  } = {},
) {
  const changes: SetManyAssignment[] = Array.from({ length: count }, (_, index) => ({
    target: `#${index + 1}`,
    itemId: `ITEM_${index + 1}`,
    fieldName: "Status",
    from: "Ready",
    to: "Done",
    observed: "Ready",
  }));
  const values = new Map(changes.map((change) => [change.itemId, change.from]));
  const mutations: string[][] = [];
  let rateIndex = 0;
  const client: SetManyClient = {
    sampleGraphqlRate() {
      const rate = rates?.[rateIndex] ?? {
        used: rateIndex,
        remaining: 5000 - rateIndex,
        resetAt: "2026-09-16T12:00:00.000Z",
      };
      rateIndex += 1;
      return rate;
    },
    planSetMany() {
      return { context: {}, pending: changes, alreadyApplied: [], assignments: changes.length };
    },
    verifySetMany(plan) {
      return [...plan.pending, ...plan.alreadyApplied].map((change) => {
        const observed = values.get(change.itemId);
        return { ...change, observed, verified: observed === change.to };
      });
    },
    applySetMany(_plan, pending) {
      mutations.push(pending.map((change) => change.itemId));
      for (const change of pending) values.set(change.itemId, change.to);
      if (mutationError) throw new Error("connection closed after send");
    },
  };
  return { changes, client, mutations, values };
}

void test("set-many applies at most 25 assignments per verified adaptive chunk", async () => {
  const fixture = adaptiveSetManyFixture(52);
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {},
  });
  assert.equal(maximumMutationChunkAssignments, 25);
  assert.deepEqual(
    fixture.mutations.map((chunk) => chunk.length),
    [25, 25, 2],
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.verified, 52);
  assert.equal(result.evidence.remaining, 0);
  assert.equal(result.evidence.chunks.length, 3);
});

void test("set-many reconciles an ambiguous mutation response without retrying", async () => {
  const fixture = adaptiveSetManyFixture(2, { mutationError: true });
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {},
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.reconciled_after_error, 2);
  assert.equal(fixture.mutations.length, 1);
});

void test("set-many resumes already-applied assignments with exact readback and no repeated writes", async () => {
  const fixture = adaptiveSetManyFixture(2);
  for (const change of fixture.changes) fixture.values.set(change.itemId, change.to);
  fixture.client.planSetMany = () => ({
    context: {},
    pending: [],
    alreadyApplied: fixture.changes,
    assignments: 2,
  });
  let readbacks = 0;
  const verify = fixture.client.verifySetMany;
  fixture.client.verifySetMany = (plan) => {
    readbacks += 1;
    return verify(plan);
  };
  let doctors = 0;
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {
      doctors += 1;
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.already_applied_at_start, 2);
  assert.equal(result.evidence.verified, 2);
  assert.equal(result.evidence.remaining, 0);
  assert.equal(result.evidence.doctor, "passed");
  assert.equal(fixture.mutations.length, 0);
  assert.equal(readbacks, 1);
  assert.equal(doctors, 1);
});

void test("the Project reader preserves full bodies and all pages above the ordinary transport limit", () => {
  const node = (number: number) => ({
    id: `PVTI_${number}`,
    content: { __typename: "Issue", number, body: "x".repeat(22000) },
    fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  });
  const first = Array.from({ length: 50 }, (_, i) => node(i + 1));
  const last = [node(51)];
  for (const failedLastPage of [false, true]) {
    const cursors: unknown[] = [];
    const bytes: number[] = [];
    const run = createGitHubRunner({
      spawn: (_command, args, options) => {
        assert.equal(args[0], "api");
        const request = fixtureGraphql(options.input);
        assert.match(request.query, /items\(first: 50/);
        assert.doesNotMatch(request.query, /mutation/);
        const cursor = request.variables.after;
        cursors.push(cursor);
        const output = JSON.stringify({
          data: {
            node: {
              items: {
                totalCount: 51,
                nodes: cursor ? last : first,
                pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "page-two" },
              },
            },
          },
        });
        bytes.push(Buffer.byteLength(output));
        if (cursor && failedLastPage)
          return {
            error: Object.assign(new Error("private partial response"), { code: "ENOBUFS" }),
            status: 0,
            stdout: output,
            stderr: "private diagnostics",
          };
        return spawnSync(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
          ...options,
          input: output,
        });
      },
    });
    const client = new RoadmapClient(config, run);
    const collect = () => client.itemList(1, { details: { id: "PVT" } });
    if (failedLastPage) assert.throws(collect, /collection limit/);
    else {
      const items = collect();
      assert.equal(items.length, 51);
      assert.equal(new Set(items.map((item) => item.id)).size, 51);
      assert.deepEqual(
        items.map(({ id, content }) => ({ id, content })),
        [...first, ...last].map(({ id, content }) => ({
          id,
          content: { ...content, type: "Issue" },
        })),
      );
    }
    assert.deepEqual(cursors, [null, "page-two"]);
    assert.ok(fixtureElement(bytes, 0) > 1024 * 1024);
    assert.equal(first.length, 50);
    assert.equal(fixtureElement(first, 0).content.body.length, 22000);
  }
});

void test("set-many stops before the next chunk when preserving quota requires a resume", async () => {
  const fixture = adaptiveSetManyFixture(30, {
    rates: [
      { used: 0, remaining: 500, resetAt: "later" },
      { used: 10, remaining: 490, resetAt: "later" },
      { used: 11, remaining: 489, resetAt: "later" },
      { used: 12, remaining: 0, resetAt: "later" },
    ],
  });
  await assert.rejects(
    () =>
      executeSetMany({
        client: fixture.client,
        config,
        spec: {},
        apply: true,
        doctor: async () => {},
      }),
    (error) =>
      fixtureObject(error).operationStatus === "partial" &&
      fixtureObject(fixtureObject(error).operationEvidence).verified === 25 &&
      fixtureObject(fixtureObject(error).operationEvidence).remaining === 5,
  );
  assert.equal(fixture.mutations.length, 1);
});

void test("set-many refuses unexpected pre-chunk state without mutation", async () => {
  const fixture = adaptiveSetManyFixture(2);
  fixture.values.set("ITEM_1", "In progress");
  await assert.rejects(
    () =>
      executeSetMany({
        client: fixture.client,
        config,
        spec: {},
        apply: true,
        doctor: async () => {},
      }),
    (error) =>
      error instanceof Error &&
      fixtureObject(error).operationStatus === "partial" &&
      /stopped before mutation/.test(error.message),
  );
  assert.equal(fixture.mutations.length, 0);
});

void test("GraphQL failures retain provider quota and reset evidence", () => {
  const runner: GitHubRunner = () =>
    included(
      {
        data: null,
        errors: [{ message: "API rate limit exceeded" }],
      },
      {
        "x-ratelimit-resource": "graphql",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "5000",
        "x-ratelimit-reset": "1789524000",
      },
    );
  assert.throws(
    () => new RoadmapClient(config, runner).graphql("query { viewer { login } }"),
    /0 points remain.*reset at/,
  );
});

for (const kind of ["items"]) {
  const node = (value: number) => ({
    id: `PVTI_${value}`,
    fieldValues: {
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const page = (numbers: readonly number[], totalCount: number, cursor: string | null = null) => ({
    nodes: numbers.map(node),
    totalCount,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  function readPages(pages: readonly unknown[]) {
    let index = 0;
    const client = new RoadmapClient(config, (args, input) => {
      if (args[0] === "project") return JSON.stringify({ id: "PVT" });
      assert.match(fixtureGraphql(input).query, /totalCount/);
      const current = pages[index++];
      if (current instanceof Error) throw current;
      assert.ok(index <= pages.length, "reader must stop before exhausting the fixture");
      return JSON.stringify({ data: { node: { items: current } } });
    });
    return client.itemList(1);
  }

  void test(`${kind} inventory accepts an empty connection`, () => {
    assert.deepEqual(readPages([page([], 0)]), []);
  });
  void test(`${kind} inventory accepts an exact page boundary`, () => {
    const size = 50;
    assert.equal(
      readPages([
        page(
          Array.from({ length: size }, (_, i) => i + 1),
          size,
        ),
      ]).length,
      size,
    );
  });
  const failures: readonly (readonly [string, readonly unknown[]])[] = [
    ["missing connection", [null]],
    ["missing nodes", [{ totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } }]],
    ["missing pagination", [{ nodes: [], totalCount: 0 }]],
    ["missing total", [{ ...page([], 0), totalCount: undefined }]],
    ["invalid total", [page([], -1)]],
    [
      "invalid hasNextPage",
      [{ ...page([], 0), pageInfo: { hasNextPage: "false", endCursor: null } }],
    ],
    ["missing cursor", [{ ...page([1], 2), pageInfo: { hasNextPage: true, endCursor: null } }]],
    ["repeated cursor", [page([1], 3, "next"), page([2], 3, "next")]],
    ["cursor cycle", [page([1], 4, "a"), page([2], 4, "b"), page([3], 4, "a")]],
    ["empty intermediate page", [page([], 1, "next")]],
    ["duplicate records", [page([1], 2, "next"), page([1], 2)]],
    ["null record", [{ ...page([], 1), nodes: [null] }]],
    ["missing identity", [{ ...page([], 1), nodes: [{}] }]],
    ["short total", [page([1], 2)]],
    ["excess records", [page([1, 2], 1)]],
    ["changing total", [page([1], 2, "next"), page([2], 3)]],
    ["missing final page", [page([1], 2, "next"), null]],
    ["failed final request", [page([1], 2, "next"), new Error("API unavailable")]],
  ];
  for (const [reason, pages] of failures) {
    void test(`${kind} inventory rejects ${reason}`, () => {
      assert.throws(() => readPages(pages), /inventory|API unavailable/);
    });
  }
}

void test("Planned and historical non-gating work share execution without changing Required readiness", () => {
  const make = (n: number, commitment: string | null, status = "Ready", deps: number[] = []) => ({
    id: `i${n}`,
    title: `Work ${n}`,
    status,
    priority: "High",
    horizon: "Next",
    "work type": "Product feature",
    "target release": "Public beta",
    "release commitment": commitment,
    content: {
      number: n,
      state: status === "Done" ? "CLOSED" : "OPEN",
      url: `https://example.test/${n}`,
      blockedBy: { totalCount: deps.length, nodes: deps.map((number) => ({ number })) },
    },
  });
  const items = [
    make(1, "Required", "Done"),
    make(2, "Planned"),
    make(3, "Opportunistic"),
    make(4, "Planned", "Deferred"),
  ];
  assert.equal(analyzeReleaseReadiness(items, "Public beta").ready, true);
  assert.deepEqual(
    analyzeReleaseReadiness(items, "Public beta").planned.map(
      (i) => fixtureValue(i.content).number,
    ),
    [2, 3, 4],
  );
  assert.deepEqual(
    selectNextItems(items).map((i) => fixtureValue(i.content).number),
    [2, 3],
  );
  const text = renderExecutionQueue(items);
  assert.match(text, /Planned/);
  assert.match(text, /after: https:\/\/example.test\/2/);
  assert.equal(analyzeReleaseReadiness(items, "Public beta").effectiveRequired.length, 1);
  fixtureElement(items, 0).content.blockedBy = { totalCount: 1, nodes: [{ number: 2 }] };
  const gates = analyzeReleaseReadiness(items, "Public beta");
  assert.equal(gates.ready, false);
  assert.equal(gates.dependencyConflicts.length, 1);
  assert.equal(gates.effectiveRequired.length, 2);
  fixtureElement(items, 0).content.blockedBy = { totalCount: 0, nodes: [] };
  Object.assign(fixtureElement(items, 0).content, { parent: { number: 2 } });
  assert.equal(analyzeReleaseReadiness(items, "Public beta").ready, true);
});

void test("commitment rename preserves IDs, assignments and metadata and resumes without mutation", () => {
  const desired = { ...config, project: { ...config.project, number: 1 } };
  let fields: [
    {
      id: string;
      name: string;
      type: string;
      options: Parameters<
        Parameters<typeof executeCommitmentRename>[0]["client"]["updateField"]
      >[1];
    },
  ] = [
    {
      id: "field",
      name: "Release commitment",
      type: "SINGLE_SELECT",
      options: [
        { id: "required", name: "Required", color: "RED", description: "Gate" },
        { id: "planned", name: "Opportunistic", color: "BLUE", description: "Approved" },
      ],
    },
  ];
  let writes = 0;
  const client: Parameters<typeof executeCommitmentRename>[0]["client"] = {
    fieldList: () => structuredClone(fields),
    sampleGraphqlRate: () => ({ remaining: 2000 }),
    itemList: () => [
      {
        id: "a",
        fieldValues: [
          {
            field: { name: "Release commitment" },
            name: fixtureElement(fixtureElement(fields, 0).options, 1).name,
          },
        ],
      },
      { id: "b", fieldValues: [] },
    ],
    updateField: (id, options) => {
      assert.equal(id, "field");
      writes++;
      fixtureElement(fields, 0).options = options;
    },
  };
  assert.equal(executeCommitmentRename({ client, config: desired }).status, "planned");
  assert.equal(writes, 0);
  const result = executeCommitmentRename({ client, config: desired, apply: true });
  assert.equal(result.assignmentsVerified, 2);
  assert.equal(result.option, "planned");
  assert.equal(writes, 1);
  assert.equal(fixtureElement(fixtureElement(fields, 0).options, 1).color, "BLUE");
  assert.equal(fixtureElement(fixtureElement(fields, 0).options, 1).description, "Approved");
  assert.equal(
    executeCommitmentRename({ client, config: desired, apply: true }).alreadyApplied,
    true,
  );
  assert.equal(writes, 1);
  fixtureElement(fields, 0).options.push({ id: "duplicate", name: "Opportunistic" });
  assert.throws(
    () => executeCommitmentRename({ client, config: desired, apply: true }),
    /both historical and active/,
  );
  assert.equal(writes, 1);
});

void test("commitment rename refuses divergent assignment readback and reconciles ambiguous transport", () => {
  const fields: [
    {
      id: string;
      name: string;
      type: string;
      options: Parameters<
        Parameters<typeof executeCommitmentRename>[0]["client"]["updateField"]
      >[1];
    },
  ] = [
    {
      id: "f",
      name: "Release commitment",
      type: "SINGLE_SELECT",
      options: [
        { id: "r", name: "Required" },
        { id: "p", name: "Opportunistic" },
      ],
    },
  ];
  let reads = 0;
  const client: Parameters<typeof executeCommitmentRename>[0]["client"] = {
    fieldList: () => structuredClone(fields),
    sampleGraphqlRate: () => ({ remaining: 1000 }),
    itemList: () => [
      {
        id: "a",
        fieldValues: [
          { field: { name: "Release commitment" }, name: reads++ ? "Required" : "Opportunistic" },
        ],
      },
    ],
    updateField: (_id, opts) => {
      fixtureElement(fields, 0).options = opts;
    },
  };
  assert.throws(
    () => executeCommitmentRename({ client, config, apply: true }),
    /assignment changed/,
  );
  fixtureElement(fixtureElement(fields, 0).options, 1).name = "Opportunistic";
  client.itemList = () => [
    {
      id: "a",
      fieldValues: [
        {
          field: { name: "Release commitment" },
          name: fixtureElement(fixtureElement(fields, 0).options, 1).name,
        },
      ],
    },
  ];
  client.updateField = (_id, opts) => {
    fixtureElement(fields, 0).options = opts;
    throw Error("lost response");
  };
  assert.equal(executeCommitmentRename({ client, config, apply: true }).reconciledAfterError, true);
});

void test("queue displays incomplete dependency coverage instead of an empty prerequisite claim", () => {
  const record = {
    title: "Partial",
    status: "Ready",
    priority: "High",
    horizon: "Next",
    "work type": "Bug",
    "release commitment": "Planned",
    content: { number: 1, state: "OPEN", blockedBy: { totalCount: 11, nodes: [] } },
  };
  assert.match(renderExecutionQueue([record]), /prerequisite coverage incomplete/);
});

void test("single-local pickup avoids obsolete board reads without claiming writer release", () => {
  const single = { ...config, delivery_mode: "single-local-runner", runner_coordination: null };
  const snapshot = readOperationalBoard(single, {
    request: () => assert.fail("retired board must not be read"),
  });
  assert.equal(snapshot.status, "retired");
  assert.equal(snapshot.active_writer_overlap, "not assessed");
  assert.equal(bindOperationalAssignment(snapshot, "Local", 244), null);
  const envelope = operationalEnvelope(snapshot, { status: "observed" });
  assert.equal(envelope.operational_baseline, null);
  assert.equal(fixtureObject(envelope).operational_binding, undefined);
  assert.match(
    fixtureValue(envelope.operational_snapshot.authority_limit),
    /does not prove release or inactivity/,
  );
  assert.throws(() => bindOperationalAssignment(snapshot, "", 244), /identity/);
  assert.throws(() => bindOperationalAssignment(snapshot, "Local", 0), /positive/);
});

void test("retired coordinator planners cannot revive historical grants or writes", () => {
  const single = { ...config, delivery_mode: "single-local-runner" };
  for (const apply of [false, true]) {
    for (const plan of [
      prepareOperationalConsumption,
      prepareOperationalOffer,
      prepareOperationalReturn,
      prepareOperationalReturnAcceptance,
      prepareOperationalReleaseEvidence,
    ])
      assert.throws(() => {
        // @ts-expect-error Retired entry points must reject before reading missing historical grant inputs.
        plan({ config: single, apply });
      }, /coordination is retired/);
  }
  assert.throws(() => {
    // @ts-expect-error Retirement must be checked before reading absent checkpoint inputs.
    prepareOperationalCheckpoint(single);
  }, /coordination is retired/);
  assert.equal(deliveryMode({}), "coordinated");
  assert.throws(() => validateConfig({ ...config, delivery_mode: "local-ish" }), /delivery_mode/);
});

void test("explicit pickup references do not revive coordinator authority in single mode", () => {
  const reservation = { url: "https://github.com/boburning/portcove/issues/244#issuecomment-1" };
  const options = { runner: "Local", comments: [], coverage: { complete: false }, reservation };
  const context = deriveExecutionContext(config, pickupIssue(244), pickupRelations(), options);
  assert.match(context.reservation.assessment, /actual writer activity, source-owner release/);
  assert.equal(fixtureObject(context.reservation).url, reservation.url);
  const historical = deriveExecutionContext(
    { ...config, delivery_mode: "coordinated" },
    pickupIssue(244),
    pickupRelations(),
    options,
  );
  assert.match(historical.reservation.assessment, /accepted grant.*coordinator/);
});

void test("set help renders every configured field option without live access", async () => {
  const config = validateConfig(
    JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
  );
  const help = roadmapCommandHelp("set", config);
  assert.match(help, /--type:/);
  assert.match(help, /--status: Inbox/);
  for (const name of ["Status", "Work type", "Effort"])
    for (const value of fixtureValue(
      fixtureFind(config.fields, (field) => field.name === name).options,
    ))
      assert(help.includes(value));
  assert.match(roadmapCommandHelp("doctor", config), /--summary/);
  assert.throws(() => roadmapCommandHelp("unknown", config), /unknown/);
});

void test("Roadmap command help is available without the GitHub executable or operation lock", () => {
  for (const command of ["set", "capture-feature", "doctor", "context"]) {
    const result = spawnSync(process.execPath, ["scripts/roadmap.mts", command, "--help"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(command));
    assert.equal(result.stderr, "");
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/roadmap.mts", "doctor", "--summary", "--json"],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mutually exclusive/);
});

{
  const approval: unknown = JSON.parse(
    readFileSync(new URL("../.github/linux-beta-risk-706.json", import.meta.url), "utf8"),
  );
  validateApproval706(approval, "2026-10-15T01:21:44.000Z");
  assert.ok(
    typeof approval.reconfirmedHead === "string" && typeof approval.policySha256 === "string",
  );
  const canonicalApproval = {
    ...approval,
    reconfirmedHead: approval.reconfirmedHead,
    policySha256: approval.policySha256,
  };
  const now = "2026-10-16T00:00:00.000Z";
  const item = (n: number, deps: number[] = []) => ({
    id: `i${n}`,
    title: `Remediation ${n}`,
    status: "Blocked",
    platform: "Linux",
    "work type": "Security",
    "target release": "Public beta",
    "release commitment": "Planned",
    content: {
      number: n,
      state: "OPEN",
      url: `https://github.com/boburning/portcove/issues/${n}`,
      blockedBy: { totalCount: deps.length, nodes: deps.map((number) => ({ number })) },
    },
  });
  const items = () => [item(49, [706]), item(706)];
  function evidence() {
    const policy = { ...canonicalApproval, firstPublicationTag: "v0.1.0-beta.1" };
    const candidate = {
      head: "a".repeat(40),
      lockSha256: "b".repeat(64),
      target: "x86_64-unknown-linux-gnu",
      features: ["default", "tauri/custom-protocol"],
      productionChanges: "",
      reviewedHead: policy.reconfirmedHead,
    };
    const diagnostic = {
      type: "diagnostic",
      fields: {
        severity: "error",
        code: "unsound",
        advisory: { id: policy.advisory, package: "glib" },
        labels: [{ span: "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index" }],
      },
    };
    const summary = Object.fromEntries(
      ["advisories", "bans", "licenses", "sources"].map((g) => [
        g,
        { errors: g === "advisories" ? 1 : 0, warnings: 0, notes: 0, helps: 0 },
      ]),
    );
    return {
      risk706Approval: policy,
      now,
      risk706Evidence: {
        approval: policy,
        candidate,
        scan: {
          head: candidate.head,
          lockSha256: candidate.lockSha256,
          completedAt: now,
          complete: true,
          signal: null,
          error: null,
          exitCode: 1,
          unsoundAll: true,
          configSha256: policy.policySha256,
          sourceConfigSha256: policy.policySha256,
          sourceConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          executionConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          toolVersion: "cargo-deny 0.20.2",
          scope: "workspace-default-all-targets-all-checks",
          stdout: "",
          stderr: [diagnostic, { type: "summary", fields: summary }]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        },
        releases: [],
        purpose: "release",
        publicationTag: policy.firstPublicationTag,
      },
    };
  }
  void test("approved remediation planning is valid but never establishes release eligibility", () => {
    assert.deepEqual(
      parseArguments(["readiness", "--release", "Public beta", "--linux-beta-706"]),
      {
        command: "readiness",
        positionals: [],
        options: { "--release": "Public beta", "--linux-beta-706": true },
      },
    );
    const result = analyzeReleaseReadiness(items(), "Public beta", { now });
    assert.equal(result.safetyConflicts.length, 0);
    assert.equal(result.dependencyConflicts.length, 0);
    assert.equal(result.pendingRiskDispositions.length, 2);
    assert.equal(result.ready, false);
    assert.match(renderReadinessSummary(result), /Pending:.*actual candidate/);
    const expired = analyzeReleaseReadiness(items(), "Public beta", {
      now: "2026-11-15T04:59:00.000Z",
    });
    assert.equal(expired.safetyConflicts.length, 0);
    assert.equal(expired.ready, false);
    assert.equal(expired.pendingRiskDispositions.length, 2);
    const expiredRelease = evidence();
    expiredRelease.now = "2026-11-15T04:59:00.000Z";
    assert.throws(
      () => analyzeReleaseReadiness(items(), "Public beta", expiredRelease),
      /not valid/,
    );

    for (const options of [{ now, risk706Approval: null }]) {
      assert.equal(
        analyzeReleaseReadiness(items(), "Public beta", options).safetyConflicts.length,
        2,
      );
    }
  });
  void test("only a fully revalidated release candidate can satisfy the scoped pending nodes", () => {
    const options = evidence();
    const result = analyzeReleaseReadiness(items(), "Public beta", options);
    assert.equal(result.ready, true);
    assert.equal(fixtureValue(result.candidateDisposition706).scanPassed, false);
    assert.equal(result.effectiveRequired.length, 2);
    assert.equal(result.unfinishedRequired.length, 0);
    assert.ok(items().every((i) => i.content.state === "OPEN"));
    for (const mutate of [
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.scan.complete = false;
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.candidate.productionChanges = "crates/portcove-core/src/lib.rs";
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.purpose = "qualification";
      },
    ]) {
      const changed = evidence();
      mutate(changed.risk706Evidence);
      assert.throws(() => analyzeReleaseReadiness(items(), "Public beta", changed));
    }
    assert.throws(() => analyzeReleaseReadiness(items(), "1.0", options));
  });
  void test("canonical scope and all other dependency checks remain enforced", () => {
    for (const change of [
      (i: ReturnType<typeof item>) => {
        i.platform = "Steam Deck";
      },
      (i: ReturnType<typeof item>) => {
        i.content.url = "https://example.test/706";
      },
      (i: ReturnType<typeof item>) => {
        i["release commitment"] = "Opportunistic";
      },
    ]) {
      const list = items();
      change(fixtureElement(list, 1));
      assert.equal(analyzeReleaseReadiness(list, "Public beta", { now }).safetyConflicts.length, 1);
    }
    assert.equal(analyzeReleaseReadiness(items(), "1.0", { now }).safetyConflicts.length, 2);
    assert.equal(
      analyzeReleaseReadiness(items(), "Public beta", { now, candidateIssues: [49] })
        .safetyConflicts.length,
      1,
    );
    const list = items();
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 999 }] };
    assert.equal(
      analyzeReleaseReadiness(list, "Public beta", evidence()).missingProjectDependencies.length,
      1,
    );
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 49 }] };
    const cycle = analyzeReleaseReadiness(list, "Public beta", evidence());
    assert.equal(cycle.cycles.length, 1);
    assert.equal(cycle.dependencyConflicts.length, 1);
    assert.equal(cycle.ready, false);
    const deck = item(215, [49]);
    deck.platform = "Steam Deck";
    deck["release commitment"] = "Required";
    assert.equal(
      analyzeReleaseReadiness([...items(), deck], "Public beta", evidence()).dependencyConflicts
        .length,
      1,
    );
  });
}

void test("configuration validation retains the original Project definitions and rejects malformed view arrays", () => {
  const candidate = structuredClone(config);
  const before = structuredClone(candidate);
  const checked = validateConfig(candidate);
  assert.equal(checked, candidate);
  assert.deepEqual(checked, before);
  for (const views of [undefined, null, {}])
    assert.throws(() => validateConfig({ ...candidate, views }), /views must be an array/);
  assert.throws(
    () => validateConfig({ ...candidate, views: [{ ...candidate.views[0], fields: [42] }] }),
    /visible fields/,
  );
});
