import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  checkDiscoveryAdmissionPaths,
  generatedAdmissionDirectory,
  generatedAdmissionRegistration,
  checkDiscoveryRegistrationDelta,
} from "./discovery-admission-branch.mts";
import {
  scheduledDiscoveryReplayReceipt,
  verifyScheduledDiscoveryReplay,
} from "./discovery-admission-receipt.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const run = 159;
const attempt = 2;
const route = "repos/boburning/portcove/actions";
const sourcePath = `${route}/runs/${run}/attempts/${attempt}`;
const artifactPath = `${route}/runs/${run}/artifacts?name=listing-admission-replay-${run}-${attempt}&per_page=100`;
const jobPath = `${sourcePath}/jobs?per_page=100`;
const zipPath = `${route}/artifacts/13/zip`;
const sourceRevision = "a".repeat(40);
const handoff = {
  format: "portcove-discovery-listing-handoff",
  format_version: 1,
  candidates: [
    {
      id: "github-42",
      project_url: "https://github.com/fixture/example",
      repository_id: 42,
      evidence_sha256: "b".repeat(64),
    },
  ],
};
const report = {
  admission: { sha256: "c".repeat(64) },
  released_validation: { status: "validated" },
  automatic_listed_date: "2026-11-26",
  handoff_semantic_sha256: orderedJsonSha256(handoff),
};
const workflow = ".github/workflows/maintenance-inventory.yml";
const context = {
  GITHUB_EVENT_NAME: "schedule",
  GITHUB_REPOSITORY: "boburning/portcove",
  GITHUB_WORKFLOW_REF: `boburning/portcove/${workflow}@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: sourceRevision,
  GITHUB_SHA: sourceRevision,
  GITHUB_RUN_ID: String(run),
  GITHUB_RUN_ATTEMPT: String(attempt),
};
const receiptFile = "listing-admission-replay.json";
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const bytes = scheduledDiscoveryReplayReceipt(report, handoff, context);
  assert.ok(bytes);
  const repositoryId = 1354613114;
  const runRecord = {
    id: run,
    run_attempt: attempt,
    workflow_id: 416797406,
    path: workflow,
    status: "completed",
    event: "schedule",
    conclusion: "failure",
    head_branch: "main",
    head_sha: sourceRevision,
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
  };
  const discover = {
    name: "discover",
    run_id: run,
    run_attempt: attempt,
    head_sha: sourceRevision,
    conclusion: "success",
    steps: [
      {
        name: "Prepare listing admission from scheduled discovery evidence",
        conclusion: "success",
      },
      { name: "Retain scheduled listing admission replay receipt", conclusion: "success" },
    ],
  };
  const jobs = { total_count: 2, jobs: [discover, { name: "collect", conclusion: "failure" }] };
  let zip: Buffer = createAuditZip([[receiptFile, bytes, { descriptor: true }]]);
  const artifact = {
    name: `listing-admission-replay-${run}-${attempt}`,
    id: 13,
    expired: false,
    digest: `sha256:${sha256(zip)}`,
    workflow_run: {
      id: run,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_branch: "main",
      head_sha: sourceRevision,
    },
  };
  const artifacts = { total_count: 1, artifacts: [artifact] };
  const responses = new Map<string, object>([
    [sourcePath, runRecord],
    [jobPath, jobs],
    [artifactPath, artifacts],
  ]);
  const read = (path: string) => {
    const response = path === zipPath ? zip : responses.get(path);
    assert.ok(response, `unexpected fetch of ${path}`);
    return Promise.resolve(response);
  };
  return {
    read,
    bytes,
    runRecord,
    discover,
    jobs,
    artifact,
    artifacts,
    replaceZip(archive: Buffer) {
      zip = archive;
      artifact.digest = `sha256:${sha256(zip)}`;
    },
  };
}

void test("seals only released-Core preparation from the scheduled source", () => {
  assert.equal(
    scheduledDiscoveryReplayReceipt({ ...report, admission: null }, handoff, context),
    null,
  );
  assert.throws(
    () =>
      scheduledDiscoveryReplayReceipt(report, handoff, { ...context, GITHUB_EVENT_NAME: "push" }),
    /approved read-only producer/u,
  );
  assert.throws(
    () => scheduledDiscoveryReplayReceipt(report, { ...handoff, candidates: [] }, context),
    /approved read-only producer/u,
  );
});

void test("binds the exact scheduled job, artifact bytes and replay inputs despite an unrelated job failure", async () => {
  const { read } = fixture();
  assert.deepEqual(await verifyScheduledDiscoveryReplay(`${run}/${attempt}`, read), {
    handoff,
    revision: sourceRevision,
    expectedPatchSha256: report.admission.sha256,
    previewListedDate: report.automatic_listed_date,
  });
});

void test("refuses incomplete or mismatched origin and artifact evidence", async () => {
  const cases: [RegExp, (input: ReturnType<typeof fixture>) => void][] = [
    [/completed scheduled/u, ({ runRecord }) => (runRecord.event = "workflow_dispatch")],
    [/completed scheduled/u, ({ runRecord }) => (runRecord.head_repository.id = 1)],
    [/enumeration is incomplete/u, ({ jobs }) => (jobs.total_count = 101)],
    [/successful scheduled discovery/u, ({ discover }) => (discover.run_attempt = 1)],
    [/exactly one retained/u, ({ artifacts }) => (artifacts.total_count = 2)],
    [/artifact metadata differs/u, ({ artifact }) => (artifact.expired = true)],
    [/archive differs/u, ({ artifact }) => (artifact.digest = `sha256:${"d".repeat(64)}`)],
    [
      /ZIP rejected/u,
      (f) =>
        f.replaceZip(
          createAuditZip([
            [receiptFile, f.bytes],
            ["extra.patch", "invalid"],
          ]),
        ),
    ],
    [
      /differs from its scheduled source or handoff/u,
      (f) => {
        const original: unknown = JSON.parse(f.bytes.toString());
        assert.ok(isRecord(original));
        const forged = {
          ...original,
          handoff: { ...handoff, candidates: [] },
        };
        f.replaceZip(createAuditZip([[receiptFile, JSON.stringify(forged)]]));
      },
    ],
  ];
  for (const [expected, change] of cases) {
    const input = fixture();
    change(input);
    await assert.rejects(verifyScheduledDiscoveryReplay(`${run}/${attempt}`, input.read), expected);
  }
});

void test("an admission proposal can only add numeric upstream listings and regenerate their directory", () => {
  const path = "crates/portcove-core/catalog/ports/github-52.json";
  const staged = `A\0${path}\0`;
  const projection = `M\0${generatedAdmissionDirectory}\0M\0${generatedAdmissionRegistration}\0`;
  assert.deepEqual(checkDiscoveryAdmissionPaths(staged, false), [path]);
  assert.deepEqual(checkDiscoveryAdmissionPaths(projection + staged, true), [path]);
  for (const invalid of [
    staged + "M\0.github/workflows/ci.yml\0",
    staged + "A\0crates/portcove-core/catalog/ports/github-0.json\0",
    `M\0${path}\0`,
    `D\0${path}\0`,
    staged + staged,
    projection,
    staged.slice(0, -1),
  ]) {
    assert.throws(() => checkDiscoveryAdmissionPaths(invalid, true), /admission/u);
  }
  assert.throws(() => checkDiscoveryAdmissionPaths(staged, true), /generated directory/u);
  assert.throws(() => checkDiscoveryAdmissionPaths(staged + projection, false), /append-only/u);
});

void test("admission registration output only accounts for added listings", () => {
  const before = {
    enrollments: [],
    blocked: { "no-observation": 8, "upstream-unavailable": 9, other: 2 },
  };
  const after = {
    ...before,
    blocked: { ...before.blocked, "no-observation": 9, "upstream-unavailable": 10 },
  };
  checkDiscoveryRegistrationDelta(before, after, 2);
  assert.throws(() => checkDiscoveryRegistrationDelta(before, after, 1), /registration counts/u);
  assert.throws(
    () =>
      checkDiscoveryRegistrationDelta(before, { ...after, enrollments: [{ id: "existing" }] }, 2),
    /registration counts/u,
  );
  assert.throws(
    () =>
      checkDiscoveryRegistrationDelta(
        before,
        { ...after, blocked: { ...after.blocked, other: 3 } },
        2,
      ),
    /registration counts/u,
  );
});
