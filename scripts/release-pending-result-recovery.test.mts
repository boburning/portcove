import { publicationReportRepairFixture as fixture } from "./fixtures/publication-report-repair-fixture.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import {
  inspectPublicationReportRepair,
  validatePublicationReportRepairTransition,
} from "./release-report-repair-contract.mts";
import { capacityDigest as digest, inspectCapacityOperation } from "./release-capacity.mts";
import {
  inspectPendingResultOperation,
  inspectPendingResultProvider,
  inspectPendingResultAssociation,
  readPendingResultArchive,
} from "./release-pending-result-recovery.mts";
void test("exact terminal original report custody does not pretend failed publisher supplied an attestation", () => {
  const f = fixture();
  const projection = inspectPendingResultProvider(
    f.run,
    f.run,
    f.job,
    { total_count: 1, artifacts: f.rows },
    f.operation,
  );
  assert.equal(projection.bundle, null);
  assert.equal(projection.artifact.id, 700);
  assert.equal(projection.authority, "none");
  for (const selected of ["active", "missing", "duplicate", "expired", "partial", "wrong-source"]) {
    const rows = structuredClone(f.rows),
      job = { ...f.job };
    let total = rows.length;
    if (selected === "active") job.status = "in_progress";
    if (selected === "missing") {
      rows.length = 0;
      total = 0;
    }
    if (selected === "duplicate") {
      rows.push({ ...rows[0]!, id: 701 });
      total++;
    }
    if (selected === "expired") rows[0]!.expired = true;
    if (selected === "partial") total++;
    if (selected === "wrong-source") rows[0]!.workflow_run.head_sha = "f".repeat(40);
    assert.throws(() =>
      inspectPendingResultProvider(
        f.run,
        f.run,
        job,
        { total_count: total, artifacts: rows },
        f.operation,
      ),
    );
  }
});
void test("report binds original settled publish/current immutable identity and current exact attempt", () => {
  const f = fixture();
  assert.equal(
    inspectPendingResultAssociation(f.record, f.operation, f.candidate, f.published, f.release)
      .authority,
    "none",
  );
  for (const changed of [
    { ...f.record, producer: { ...f.record.producer, job_id: 999 } },
    { ...f.record, candidate: { ...f.record.candidate, prepared_commit: "f".repeat(40) } },
    {
      ...f.record,
      settlement: { ...f.record.settlement, operation: { ...f.published, id: "f".repeat(64) } },
    },
    { ...f.record, immutable_identity_sha256: "f".repeat(64) },
  ])
    assert.throws(() =>
      inspectPendingResultAssociation(changed, f.operation, f.candidate, f.published, f.release),
    );
  assert.throws(() =>
    inspectPendingResultAssociation(
      f.record,
      f.operation,
      f.candidate,
      {
        ...f.published,
        outcome: "recovered",
        recovery: { resolution: "partial-effects-retained" },
      },
      f.release,
    ),
  );
  assert.throws(() =>
    inspectPendingResultAssociation(f.record, f.operation, f.candidate, f.published, {
      ...f.release,
      release_id: 322,
    }),
  );
  assert.throws(() =>
    inspectPendingResultOperation(f.operation, { ...f.candidate, transient_retries: 1 }),
  );
});
void test("real bounded ZIP and copied context cannot mint result recovery provenance or reach Release", async () => {
  const f = fixture(),
    provider = inspectPendingResultProvider(
      f.run,
      f.run,
      f.job,
      { total_count: 1, artifacts: f.rows },
      f.operation,
    );
  let reads = 0;
  await assert.rejects(
    readPendingResultArchive(
      f.archive,
      provider,
      "3".repeat(40),
      {},
      f.operation,
      f.candidate,
      f.published,
      async () => {
        reads++;
        return f.release;
      },
      performance.now() + 10000,
    ),
    /actual|imported|context/,
  );
  assert.equal(reads, 0);
  const changed = Buffer.from(f.archive);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await assert.rejects(
    readPendingResultArchive(
      changed,
      provider,
      "3".repeat(40),
      {},
      f.operation,
      f.candidate,
      f.published,
      async () => {
        reads++;
        return f.release;
      },
      performance.now() + 10000,
    ),
  );
  assert.equal(reads, 0);
});

void test("source-bound result continuation settles only the exact positive report and never invokes an upload", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { readCompleteRunArtifactInventory } = await import("./release-run-artifact-inventory.mts");
  const source = await readFile(
    new URL("./release-candidate-signing-recovery.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("      if (pendingResult) {");
  const end = source.indexOf("      if (pendingRelease) {", start);
  assert.ok(start > 0 && end > start);
  const f = fixture();
  let mode = "positive",
    observations = 0,
    settlements = 0;
  const calls: string[] = [];
  const recoveredOperation = {
    ...f.operation,
    outcome: "recovered",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:700",
        evidence_sha256: "a".repeat(64),
      },
    ],
    recovery: {
      checkpoint: "b".repeat(40),
      resolution: "effect-completed",
      evidence_sha256: "a".repeat(64),
    },
  };
  const context = {
    assert,
    structuredClone,
    digest,
    candidateProgressIdentity,
    inspectPublicationReportRepair,
    String,
    Number,
    isRecord: (raw: unknown) => raw !== null && typeof raw === "object" && !Array.isArray(raw),
    pendingResult: f.operation,
    active: f.candidate,
    state: { input: {} },
    context: {},
    publication: {},
    toolsReceipt: {},
    input: { repository: "bare", remote_configuration: {} },
    api: {},
    directory: "private",
    deadline: 170000,
    environment: {},
    base: "repos/boburning/portcove",
    executor: {},
    settled: (op: { outcome: string }) => ["succeeded", "recovered"].includes(op.outcome),
    inspectCapacityOperation,
    readOriginalPublishedOperation: async () => {
      calls.push("original-journal-publish");
      return f.published;
    },
    derivePendingReleaseAssets: async () => {
      calls.push("actual-context-Tough");
      return {};
    },
    inspectPendingResultProvider,
    readCompleteRunArtifactInventory,
    get: (endpoint: string) => {
      if (endpoint.startsWith("git/commits/"))
        return {
          sha: f.operation.executor_identity!.controller_revision,
          tree: { sha: "3".repeat(40) },
        };
      if (endpoint.startsWith("actions/jobs/")) return f.job;
      if (endpoint.includes("/artifacts?")) return { total_count: 1, artifacts: f.rows };
      return f.run;
    },
    readGitHubArtifactArchive: () => {
      calls.push("GET-original-archive");
      return f.archive;
    },
    signingContextRemaining: () => 15000,
    readPendingResultArchive: async () => {
      calls.push("actual-report-context-Release");
      observations++;
      if (mode === "missing") throw new Error("missing exact report association");
      return {
        projection: { value: mode === "drift" ? observations : 1 },
        evidence_sha256: "a".repeat(64),
        report_sha256: "b".repeat(64),
        remote_identity: "github-actions:boburning/portcove:artifact:700",
        record: f.record,
      };
    },
    guard: async () => {
      calls.push("fresh-controls-current-CP");
    },
    requireRetainedActualTufPublication: async () => {
      calls.push("retained-Tough");
    },
    recoverOwnedCapacityEffect: async (
      _executor: unknown,
      _input: unknown,
      readback: (pending: unknown) => Promise<{ resolution: string }>,
    ) => {
      calls.push("actual-coordinator-readback");
      const value = await readback(
        mode === "wrong-intent" ? { ...f.operation, id: "f".repeat(64) } : f.operation,
      );
      assert.equal(value.resolution, "effect-completed");
      settlements++;
      return { checkpoint: "c".repeat(40) };
    },
    recoverReleaseOpportunity: async () => ({
      input: {
        active_candidate: f.candidate,
        controller: { capacity_attempt: { operation: recoveredOperation } },
      },
    }),
    checkpointReleaseOpportunity: async (
      _repo: string,
      checkpoint: string,
      input: { active_candidate: Record<string, unknown> },
    ) => {
      validatePublicationReportRepairTransition(
        f.candidate,
        input.active_candidate,
        checkpoint,
        recoveredOperation,
      );
      calls.push("same-journal-technical-failure");
      return { checkpoint: "d".repeat(40) };
    },
    refreshCapacityExecutor: async () => {},
    createCoordinatorJournalApi: () => ({ source: "dedicated-journal" }),
    publishCoordinatorCheckpoint: async (
      _repo: string,
      checkpoint: string,
      _config: unknown,
      options: { api: { source: string } },
    ) => {
      assert.equal(checkpoint, "d".repeat(40));
      assert.equal(options.api.source, "dedicated-journal");
      calls.push("remote-journal-CAS");
    },
  };
  const run = runInNewContext(
    stripTypeScriptTypes(
      `(async()=>{let phase='',checkpoint='${"a".repeat(40)}',originalCandidate=digest(active),publicationResultLocator,resultRepair;${source.slice(start, end)}return {checkpoint,resultRepair};})`,
    ),
    context,
  ) as () => Promise<{ checkpoint: string; resultRepair: unknown }>;
  const positive = await run();
  assert.equal(positive.checkpoint, "d".repeat(40));
  assert.ok(positive.resultRepair);
  assert.equal(settlements, 1);
  assert.deepEqual(calls.slice(0, 2), ["original-journal-publish", "actual-context-Tough"]);
  assert.ok(calls.includes("retained-Tough"));
  assert.ok(calls.includes("same-journal-technical-failure"));
  assert.ok(calls.includes("remote-journal-CAS"));
  for (mode of ["missing", "drift", "wrong-intent"]) {
    observations = 0;
    settlements = 0;
    calls.length = 0;
    await assert.rejects(run());
    assert.equal(settlements, 0);
  }
});
