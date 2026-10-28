import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isRecord } from "./runtime-values.mts";
import {
  mergeRoadmapObservations,
  observationFromReceipt,
  renderRoadmapReport,
  reportDigest,
  replayRoadmapRuns,
  legacyRoadmapObservations,
  collectReplayWindows,
  ReplayWindowFull,
  journalCollectorRun,
  mainPublicationJournals,
  unavailableRoadmapStateReport,
} from "./roadmap-report.mts";
import type { RoadmapReportState } from "./roadmap-report.mts";
const repository = "boburning/portcove";
const blank = (): RoadmapReportState => ({
  format_version: 1,
  cursor: "2026-10-24T00:00:00Z",
  observations: {},
  publication_gaps: [],
});

void test("legacy failures migrate without losing unrelated scopes or reviving recovered setup history", () => {
  const comment = (id: number, issue: number, status: string) => ({
    id,
    user: { type: "Bot", login: "github-actions[bot]" },
    body: `<!-- portcove-roadmap-health:${JSON.stringify({ scope: JSON.stringify({ kind: "issues", issues: [issue] }), status })} -->\nObserved: 2026-10-24T01:00:00.000Z.\nClassification: \`planning_findings\`.`,
    updated_at: "2026-10-24T01:00:00Z",
  });
  const state = mergeRoadmapObservations(
    blank(),
    legacyRoadmapObservations(
      [
        comment(1, 1, "failed"),
        comment(2, 2, "failed"),
        comment(3, 1, "passed"),
        { ...comment(4, 3, "failed"), user: { type: "User", login: "github-actions[bot]" } },
      ],
      repository,
    ),
  );
  assert.equal(state.observations["issue:1"]?.status, "passed");
  assert.equal(state.observations["issue:2"]?.status, "needs_attention");
  assert.equal(state.observations["issue:3"], undefined);
});

void test("replay partitions the provider ceiling and deduplicates inclusive boundaries", () => {
  const start = "2026-10-24T00:00:00.000Z",
    end = "2026-10-24T02:00:00.000Z";
  const values = collectReplayWindows(start, end, (since, until) => {
    if (since === start && until === end) throw new ReplayWindowFull();
    return since === start ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }];
  });
  assert.deepEqual(
    values.map((value) => value.id),
    [1, 2, 3],
  );
  assert.throws(
    () =>
      collectReplayWindows(start, "2026-10-24T00:00:00.001Z", () => {
        throw new ReplayWindowFull();
      }),
    /one second/u,
  );
});

void test("queued or cancelled publisher journal entries recover reruns of old collectors", () => {
  const oldCollectorCreated = "2026-10-01T00:00:00Z";
  const journal = journalCollectorRun({
    path: ".github/workflows/roadmap-report.yml",
    head_branch: "main",
    event: "workflow_run",
    status: "completed",
    conclusion: "cancelled",
    created_at: "2026-10-24T03:00:00Z",
    display_title: "Roadmap publication 1 / 2",
  });
  assert(journal);
  assert(Date.parse(oldCollectorCreated) < Date.parse(blank().cursor));
  const state = replayRoadmapRuns(
    blank(),
    [{ ...journal, completed: true }],
    "2026-10-24T04:00:00Z",
    ({ run, attempt }) =>
      observationFromReceipt(
        receipt(1, "failed", "2026-10-24T02:59:00Z"),
        run,
        attempt,
        repository,
      ),
  );
  assert.equal(state.observations["issue:1"]?.attempt, 2);
  assert.deepEqual(state.publication_gaps, []);
  assert.throws(
    () =>
      journalCollectorRun({
        path: ".github/workflows/foreign.yml",
        head_branch: "main",
        event: "workflow_run",
      }),
    /Untrusted/u,
  );
});

void test("a verified newer collector attempt resolves an interrupted artifact gap without relabeling the old run", () => {
  const rows = [
    { run: 1, attempt: 1, created_at: "2026-10-24T01:00:00Z", completed: true },
    { run: 1, attempt: 2, created_at: "2026-10-24T02:00:00Z", completed: true },
  ];
  const attempts: number[] = [];
  const state = replayRoadmapRuns(blank(), rows, "2026-10-24T04:00:00Z", ({ run, attempt }) => {
    attempts.push(attempt);
    assert.equal(attempt, 2, "The failed/interrupted prior attempt stays in Actions history");
    return observationFromReceipt(
      receipt(1, "passed", "2026-10-24T03:00:00Z"),
      run,
      attempt,
      repository,
    );
  });
  assert.deepEqual(attempts, [2]);
  assert.equal(state.observations["issue:1"]?.status, "passed");
  assert.deepEqual(state.publication_gaps, []);
});
const receipt = (
  issue: number,
  status = "failed",
  time = "2026-10-24T01:00:00Z",
  kind = "planning_findings",
) => ({
  status,
  coverage: kind === "planning_findings" ? "complete" : "inconclusive",
  scope: { kind: "issues", issues: [issue], checked_issues: status === "passed" ? [issue] : [] },
  observation: { started_at: time },
  errors: ["Required declaration missing"],
  diagnosis: {
    kind,
    recovery_condition: "Correct the named description",
    provider: { status: 403, rate: { resetAt: "2026-10-24T02:00:00Z", remaining: 0 } },
  },
});
function render(state: RoadmapReportState) {
  return renderRoadmapReport(state, {
    repository,
    run: 99,
    attempt: 1,
    sha256: reportDigest(JSON.stringify(state)),
  });
}
void test("eight related failures retain eight scope results in one maintained report", () => {
  let state = blank();
  for (let issue = 1; issue <= 8; issue++)
    state = mergeRoadmapObservations(
      state,
      observationFromReceipt(receipt(issue), issue, 1, repository),
    );
  assert.equal(Object.keys(state.observations).length, 8);
  const body = render(state);
  assert.match(body, /8 affected issues/u);
  for (let issue = 1; issue <= 8; issue++) assert(body.includes(`[#${issue}]`));
  assert.match(body, /not established by these scoped checks/u);
  const repeat = mergeRoadmapObservations(
    state,
    observationFromReceipt(receipt(3), 3, 1, repository),
  );
  assert.deepEqual(repeat, state);
});
void test("out-of-order publishers commute and one recovery cannot clear another issue or global gap", () => {
  const failure1 = observationFromReceipt(receipt(1), 1, 1, repository);
  const failure2 = observationFromReceipt(receipt(2), 2, 1, repository);
  const recovery = observationFromReceipt(
    receipt(1, "passed", "2026-10-24T03:00:00Z"),
    3,
    1,
    repository,
  );
  const global = observationFromReceipt(
    {
      ...receipt(3, "failed", "2026-10-24T02:00:00Z", "inventory_changed"),
      scope: { kind: "global" },
    },
    4,
    1,
    repository,
  );
  const fold = (batches: (typeof failure1)[]) => batches.reduce(mergeRoadmapObservations, blank());
  const a = fold([failure1, failure2, recovery, global]);
  const b = fold([global, recovery, failure2, failure1]);
  assert.deepEqual(a.observations, b.observations);
  assert.equal(a.observations["issue:1"]?.status, "passed");
  assert.equal(a.observations["issue:2"]?.status, "needs_attention");
  assert.equal(a.observations.global?.status, "unable_to_verify");
  assert.match(render(a), /\*\*Unable to verify\*\*/u);
});
void test("eight shared quota failures form one incident with reset information and all scopes", () => {
  let state = blank();
  for (let issue = 1; issue <= 8; issue++)
    state = mergeRoadmapObservations(
      state,
      observationFromReceipt(
        receipt(issue, "failed", "2026-10-24T01:00:00Z", "rate_limit"),
        issue,
        1,
        repository,
      ),
    );
  const body = render(state);
  assert.equal(body.split("| Unable to verify: rate\\_limit |").length - 1, 1);
  assert.match(body, /Reset: 2026-10-24T02:00:00Z/u);
  assert.equal(Object.keys(state.observations).length, 8);
});
void test("incomplete success, unchecked issues, and publication gaps cannot establish health", () => {
  assert.equal(
    observationFromReceipt(
      { ...receipt(1, "passed"), coverage: "inconclusive" },
      1,
      1,
      repository,
    )[0]?.status,
    "unable_to_verify",
  );
  assert.throws(
    () =>
      observationFromReceipt(
        { ...receipt(1, "passed"), scope: { kind: "issues", issues: [1], checked_issues: [] } },
        1,
        1,
        repository,
      ),
    /checked records/u,
  );
  assert.throws(
    () =>
      observationFromReceipt(
        { ...receipt(1, "passed"), scope: { kind: "global" } },
        1,
        1,
        repository,
      ),
    /global health/u,
  );
  const state = blank();
  state.publication_gaps.push("Collector artifact missing; replay required");
  assert.match(render(state), /\*\*Unable to verify\*\*/u);
});
void test("health collection stays read-only beside owner-gated intake; publisher retains serialized recovery", () => {
  const collector = readFileSync(
    new URL("../.github/workflows/roadmap-health.yml", import.meta.url),
    "utf8",
  );
  const publisher = readFileSync(
    new URL("../.github/workflows/roadmap-report.yml", import.meta.url),
    "utf8",
  );
  const health: unknown = parse(collector);
  assert.ok(isRecord(health) && isRecord(health.jobs));
  assert.deepEqual(health.permissions, { contents: "read" });
  assert.equal(health.concurrency, undefined);
  for (const [name, job] of Object.entries(health.jobs)) {
    assert.ok(isRecord(job));
    assert.equal(job.concurrency, undefined);
    if (name === "hosted-intake") {
      assert.deepEqual(job.permissions, { contents: "read", issues: "write" });
      assert.equal(job.uses, "./.github/workflows/hosted-discovery-intake.yml");
      assert.equal(
        job.if,
        "github.event_name == 'workflow_dispatch' && inputs.hosted_intake != 'none' && inputs.hosted_intake != '' && github.actor == 'boburning'",
      );
    } else {
      const permissions = job.permissions ?? health.permissions;
      assert.ok(isRecord(permissions));
      for (const value of Object.values(permissions))
        assert.ok(value === "read" || value === "none", `${name} must stay read-only`);
    }
  }
  assert.match(publisher, /workflow_run:[\s\S]*types: \[completed\]/u);
  assert.match(publisher, /group: roadmap-maintained-report[\s\S]*cancel-in-progress: false/u);
  assert.doesNotMatch(publisher, /queue: max/u);
  assert.match(publisher, /ref: \$\{\{ github.event.repository.default_branch \}\}/u);
  assert.doesNotMatch(publisher, /schedule:|pull_request_target|issue_comment/u);
  assert(
    publisher.indexOf("roadmap-publish.mts prepare") <
      publisher.indexOf("path: work/roadmap-publisher/state.json"),
  );
  assert(
    publisher.indexOf("path: work/roadmap-publisher/state.json") <
      publisher.indexOf("roadmap-publish.mts publish"),
  );
});

void test("non-main publication dispatches cannot obstruct main journal replay", () => {
  const entry = {
    path: ".github/workflows/roadmap-report.yml",
    head_branch: "main",
    event: "workflow_run",
    created_at: "2026-10-24T03:00:00Z",
    display_title: "Roadmap publication 1 / 2",
  };
  assert.deepEqual(
    mainPublicationJournals([
      { ...entry, head_branch: "feature/unrelated", display_title: "foreign format" },
      entry,
    ]),
    [{ run: 1, attempt: 2, created_at: entry.created_at, completed: true }],
  );
});

void test("unavailable state changes the headline, preserves history and pointer, and is idempotent", () => {
  const original = render(blank());
  const body = unavailableRoadmapStateReport(original, "Artifact expired after retention");
  assert.equal(body.split("\n")[0], original.split("\n")[0]);
  assert.match(body, /Roadmap: \*\*Unable to verify\*\*/u);
  assert.match(body, /Missing history cannot seed a clean state/u);
  assert(body.endsWith(original.slice(original.indexOf("\n") + 1)));
  assert.equal(unavailableRoadmapStateReport(body, "Artifact expired after retention"), body);
});

void test("interrupted/overflowed publication replays retained results and preserves missing coverage", () => {
  const runs = Array.from({ length: 8 }, (_, index) => ({
    run: index + 1,
    attempt: 1,
    created_at: `2026-10-24T01:00:0${index}Z`,
    completed: true,
  }));
  const reads: number[] = [];
  const read = ({ run }: { run: number }) => {
    reads.push(run);
    if (run === 3) throw new Error("Missing retained artifact");
    return observationFromReceipt(receipt(run), run, 1, repository);
  };
  const first = replayRoadmapRuns(blank(), runs, "2026-10-24T05:00:00Z", read, 4);
  assert.match(render(first), /\*\*Unable to verify\*\*/u);
  assert.equal(first.cursor, runs[2]?.created_at);
  assert.equal(Object.keys(first.observations).length, 3);
  const second = replayRoadmapRuns(first, runs, "2026-10-24T05:00:00Z", ({ run }) =>
    observationFromReceipt(receipt(run), run, 1, repository),
  );
  assert.equal(Object.keys(second.observations).length, 8);
  assert.deepEqual(second.publication_gaps, []);
  assert.equal(second.cursor, "2026-10-24T05:00:00Z");
  assert.deepEqual(second.processed, {});
  // A publisher killed before updating the comment starts from the old snapshot;
  // replay is idempotent even when those artifact reads happened previously.
  const recovered = replayRoadmapRuns(blank(), runs, "2026-10-24T05:00:00Z", ({ run }) =>
    observationFromReceipt(receipt(run), run, 1, repository),
  );
  assert.deepEqual(recovered.observations, second.observations);
});
