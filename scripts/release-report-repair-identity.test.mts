import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { publicationReportRepairStateFixture } from "./fixtures/publication-report-repair-fixture.mts";
import { inspectReportRepairIdentity } from "./release-report-repair-identity.mts";
import { reportRepairDispatchDestination } from "./release-report-repair-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { slice4CapacityResources } from "./release-capacity.mts";

function fixture() {
  const f = publicationReportRepairStateFixture();
  const input = {
    active_candidate: f.prepared,
    controller: {
      capacity_attempt: {
        operation: {
          ...f.operation,
          kind: "dispatch",
          destination: reportRepairDispatchDestination(f.prepared),
          candidate: { ...f.operation.candidate, transient_retries: 1 },
          completed_effects: [],
          outcome: "pending",
          executor_identity: { ...f.operation.executor_identity, role: "coordinator" },
        },
      },
    },
  };
  const environment = {
    PORTCOVE_REPORT_REPAIR_SHA256: digest(f.proof),
    PORTCOVE_RELEASE_PROFILE: "initial-beta-win-linux",
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify({
      repository_id: 1354613114,
      namespace: "portcove-fixture",
      apps: { dispatch: { actor_id: "1234" } },
    }),
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: f.candidate.prepared_commit,
    GITHUB_REF: `refs/tags/portcove-fixture-prepared/v${String(f.candidate.version)}`,
    GITHUB_ACTOR_ID: "1234",
    GITHUB_RUN_ID: "1111",
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release.yml@refs/tags/portcove-fixture-prepared/v${String(f.candidate.version)}`,
  };
  const run = {
    id: 1111,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    head_sha: f.candidate.prepared_commit,
    head_branch: environment.GITHUB_REF.slice(10),
    run_attempt: 1,
    status: "in_progress",
    actor: { id: 1234 },
    triggering_actor: { id: 1234 },
    display_title: `Report repair ${digest(f.proof)}`,
  };
  return { input, environment, run };
}
void test("report-only identity acknowledges exact pending intent, or its own settled run, without granting authority", () => {
  const f = fixture();
  assert.deepEqual(inspectReportRepairIdentity(f.input, f.environment, f.run), {
    report_only_repair: true,
    report_repair_sha256: f.environment.PORTCOVE_REPORT_REPAIR_SHA256,
    authority: "none",
  });
  const settled = structuredClone(f.input);
  Object.assign(settled.controller.capacity_attempt.operation, {
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:run:1111:attempt:1",
        evidence_sha256: "a".repeat(64),
      },
    ],
  });
  inspectReportRepairIdentity(settled, f.environment, f.run);
  for (const patch of [
    { head_sha: "f".repeat(40) },
    { head_branch: "main" },
    { actor: { id: 1235 } },
    { triggering_actor: { id: 1235 } },
    { run_attempt: 2 },
    { id: 1112 },
    { display_title: "Report repair copied" },
    { repository: { id: 1, full_name: "boburning/portcove" } },
  ])
    assert.throws(() =>
      inspectReportRepairIdentity(f.input, f.environment, { ...f.run, ...patch }),
    );
  const changed = structuredClone(f.input);
  changed.controller.capacity_attempt.operation.destination =
    "github-actions:boburning/portcove:release.yml:dispatch";
  assert.throws(() => inspectReportRepairIdentity(changed, f.environment, f.run));
  assert.throws(() =>
    inspectReportRepairIdentity(
      f.input,
      { ...f.environment, PORTCOVE_REPORT_REPAIR_SHA256: "e".repeat(64) },
      f.run,
    ),
  );
  Object.assign(settled.controller.capacity_attempt.operation, {
    outcome: "recovered",
    recovery: { resolution: "partial-effects-retained" },
  });
  assert.throws(() => inspectReportRepairIdentity(settled, f.environment, f.run));
});
void test("report-only workflow suppresses all candidate build and publication jobs and keeps acknowledgement read-only", async () => {
  const workflow = (
    await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  ).replaceAll("\r\n", "\n");
  const jobs = workflow
    .slice(workflow.indexOf("jobs:\n"))
    .split(/^  (?=[a-z_]+:\s*$)/mu)
    .slice(1);
  for (const block of jobs) {
    const job = block.slice(0, block.indexOf(":"));
    if (job === "identity") {
      assert.match(block, /timeout-minutes: \$\{\{ inputs\.report_only_repair && 2 \|\| 360 \}\}/u);
      assert.match(block, /report-repair-identity\.mts/u);
      assert.match(block, /actions: read/u);
      assert.doesNotMatch(block, /actions: write|contents: write/u);
    } else if (!["publish", "authorize_publication"].includes(job))
      assert.match(block, /if:.*!inputs\.report_only_repair/u, job);
    else assert.match(block, /if: github.event_name == 'push'/u);
  }
  assert.ok(jobs.length >= 10);
  assert.equal(slice4CapacityResources.report_repair_job_minutes, 2);
  assert.equal(slice4CapacityResources.report_repair_attempts_per_candidate, 2);
  assert.equal(slice4CapacityResources.report_repair_maximum_job_minutes_per_candidate, 4);
  assert.equal(slice4CapacityResources.declared_job_minutes, 85);
});
