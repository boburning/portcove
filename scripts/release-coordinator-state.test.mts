import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import {
  runBoundedCapacityOperation,
  recordCapacityReadback,
  recordPublishedMetadata,
  runBoundedMetadataBootstrapOperation,
} from "./release-capacity-operation.mts";
import { metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { createCoordinatorFixturePhases } from "./fixtures/coordinator-fixture-phases.mts";

import {
  remoteFixture,
  fixture,
  remoteCapacityFixture,
} from "./fixtures/coordinator-state-fixtures.mts";

const execute = promisify(execFile);

const moduleUrl = new URL("./release-coordinator-state.mts", import.meta.url).href;

void test("coordinator fixture phases retain the failed span through successful cleanup", async () => {
  const lines: string[] = [];
  let clock = 10;
  const phases = createCoordinatorFixturePhases("owned phase control", {
    write: (line) => {
      lines.push(line);
    },
    now: () => ++clock,
    environment: { PORTCOVE_HEAD_SHA: "b".repeat(40), NODE_TEST_CONTEXT: "child-v8" },
    fileConcurrency: 1,
  });
  const value = {};
  assert.equal(await phases.measure("directory", async () => value), value);
  const original = new Error("retained setup failure");
  await assert.rejects(
    phases.measure("source", async () => {
      throw original;
    }),
    (error) => error === original,
  );
  let cleaned = false;
  await phases.measure("cleanup", async () => {
    cleaned = true;
  });
  assert.equal(cleaned, true);
  const rows = lines.map((line) => {
    assert.ok(Buffer.byteLength(line) <= 4096);
    const row: unknown = JSON.parse(line.slice("Coordinator fixture phase: ".length));
    assert.ok(isRecord(row));
    return row;
  });
  assert.deepEqual(
    rows.map((row) => [row.phase, row.state]),
    [
      ["directory", "started"],
      ["directory", "completed"],
      ["source", "started"],
      ["source", "failed"],
      ["cleanup", "started"],
      ["cleanup", "completed"],
    ],
  );
  assert.equal(rows[3]!.last_completed, "directory");
  assert.equal(rows[3]!.last_failed, "source");
  assert.equal(rows[5]!.last_completed, "cleanup");
  assert.equal(rows[5]!.last_failed, "source");
  assert.ok(rows.every((row) => typeof row.elapsed_ms === "number" && row.elapsed_ms >= 0));
  assert.ok(isRecord(rows[0]!.context));
  assert.equal(rows[0]!.context.source, "b".repeat(40));
  assert.equal(rows[0]!.context.file_concurrency, 1);
});

void test("coordinator fixture phases cannot replace operation results when diagnostics are unavailable", async () => {
  const phases = createCoordinatorFixturePhases("owned diagnostic failure", {
    write() {
      throw new Error("diagnostic writer unavailable");
    },
    now() {
      throw new Error("diagnostic clock unavailable");
    },
    environment: {},
  });
  const result = {};
  assert.equal(await phases.measure("directory", async () => result), result);
  const original = new Error("original operation failure");
  await assert.rejects(
    phases.measure("source", async () => {
      throw original;
    }),
    (error) => error === original,
  );
  const bounded: string[] = [];
  await createCoordinatorFixturePhases("x".repeat(100000), {
    write: (line) => {
      bounded.push(line);
    },
    environment: { PORTCOVE_HEAD_SHA: "invalid", GITHUB_SHA: "not a revision" },
  }).measure("directory", async () => undefined);
  assert.equal(bounded.length, 2);
  for (const line of bounded) {
    assert.ok(Buffer.byteLength(line) <= 4096);
    const row: unknown = JSON.parse(line.slice("Coordinator fixture phase: ".length));
    assert.ok(isRecord(row) && isRecord(row.context));
    assert.equal(row.context.test_truncated, true);
    assert.equal(row.context.source, null);
    assert.equal(row.context.checkout, null);
    assert.equal(row.context.file_concurrency, null);
  }
});

void test("coordinator fixture phases are retained by an actually failing child and its cleanup", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-fixture-phase-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "phase.test.mjs");
  const factory = new URL("./fixtures/coordinator-fixture-phases.mts", import.meta.url).href;
  await writeFile(
    file,
    `import test from "node:test";
import { createCoordinatorFixturePhases } from ${JSON.stringify(factory)};
test("actual owned setup failure", async (t) => {
  const phases = createCoordinatorFixturePhases(t.name, { fileConcurrency: 1 });
  t.after(() => phases.measure("cleanup", async () => undefined));
  await phases.measure("directory", async () => undefined);
  await phases.measure("source", async () => { throw new Error("retained original phase failure"); });
});\n`,
  );
  const environment = { ...process.env, PORTCOVE_HEAD_SHA: "b".repeat(40) };
  const result = await execute(
    process.execPath,
    ["--test", "--test-timeout=10000", "--test-concurrency=1", file],
    {
      env: { ...environment, NODE_TEST_CONTEXT: undefined },
      windowsHide: true,
      timeout: 20000,
    },
  ).then(
    (value) => ({ ...value, code: 0 }),
    (error: unknown) => {
      assert.ok(isRecord(error));
      return error;
    },
  );
  assert.equal(result.code, 1);
  const output = String(result.stdout) + "\n" + String(result.stderr);
  assert.match(output, /retained original phase failure/u);
  const rows = output.split("\n").flatMap((line) => {
    const marker = "Coordinator fixture phase: ",
      index = line.indexOf(marker);
    if (index < 0) return [];
    const row: unknown = JSON.parse(line.slice(index + marker.length));
    assert.ok(isRecord(row));
    return [row];
  });
  assert.equal(rows.length, 6, output);
  const failed = rows.find((row) => row.state === "failed");
  assert.ok(failed && isRecord(failed.context));
  assert.equal(failed.phase, "source");
  assert.equal(failed.last_completed, "directory");
  assert.equal(failed.context.source, "b".repeat(40));
  assert.equal(failed.context.file_concurrency, 1);
  assert.equal(rows.at(-1)?.state, "completed");
  assert.equal(rows.at(-1)?.phase, "cleanup");
  assert.equal(rows.at(-1)?.last_failed, "source");
});

void test(
  "report-only technical repair consumes existing journal counter and distinct dispatch while retaining original compiler and publication",
  { timeout: 180000 },
  async (t) => {
    // Real local Git plus inert provider transport, never private authentication.
    const { releaseEffectFixture } = await import("./fixtures/release-effect-fixture.mts");
    const { reportRepairDispatchDestination, inspectConsumedPublicationReportRepair } =
      await import("./release-report-repair-contract.mts");
    const f = await remoteCapacityFixture(t, true, createCoordinatorFixturePhases(t.name));
    let checkpoint = f.migrated.checkpoint;
    const read = () => recoverReleaseOpportunity(f.bare, checkpoint);
    const save = async (input: Record<string, unknown>) => {
      const next = await checkpointReleaseOpportunity(f.bare, checkpoint, input);
      await publishCoordinatorCheckpoint(f.bare, next.checkpoint, f.config, { api: f.api });
      checkpoint = next.checkpoint;
      return next;
    };
    let input = structuredClone((await read()).input);
    assert.ok(isRecord(input.active_candidate));
    const active = input.active_candidate;
    active.phase = "qualifying";
    const compiler = { run_id: 999, attempt: 1, revision: active.prepared_commit };
    active.release_run = compiler;
    await save(input);
    const advance = async (
      phase: string,
      locators: { kind: string; id: string; sha256: string }[],
    ) => {
      input = structuredClone((await read()).input);
      assert.ok(isRecord(input.active_candidate));
      const current = input.active_candidate;
      const proof = {
        schema_version: 1,
        candidate_sha256: candidateProgressIdentity(current),
        controller_revision: "3".repeat(40),
        locators,
      };
      const histories = Array.isArray(current.stage_evidence)
        ? structuredClone(current.stage_evidence)
        : [];
      histories.push({
        phase,
        attempts: [
          {
            previous_checkpoint: checkpoint,
            evidence_sha256: capacityDigest(proof),
            proof,
            release_run: compiler,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      });
      current.phase = phase;
      current.stage_evidence = histories;
      await save(input);
    };
    await advance("building", [{ kind: "native-check", id: "101", sha256: "b".repeat(64) }]);
    await advance("publishing", [{ kind: "native-check", id: "102", sha256: "c".repeat(64) }]);
    const publisher = {
      controller_revision: "3".repeat(40),
      execution_ref: "refs/tags/controller-v1",
      workflow: productionControllerWorkflow,
      run_id: "123",
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
      actor_id: "43177418",
      role: "release-publication",
    };
    const executeOnce = async (
      request: Parameters<typeof runBoundedCapacityOperation>[2],
      remote: string,
      identity: unknown = publisher,
    ) => {
      const operation = await runBoundedCapacityOperation(
        f.bare,
        checkpoint,
        request,
        async () => f.capacity.boundary,
        async (record) => {
          await record(remote, "a".repeat(64));
        },
        { ...f.options, executorIdentity: identity, maximumReceipts: 1 },
      );
      checkpoint = operation.checkpoint;
      const completed = await recordCapacityReadback(
        f.bare,
        checkpoint,
        "effect-completed",
        "b".repeat(64),
        f.options,
      );
      checkpoint = completed.checkpoint;
      const saved = (await read()).input.controller;
      assert.ok(isRecord(saved) && isRecord(saved.capacity_attempt));
      return inspectCapacityOperation(saved.capacity_attempt.operation);
    };
    assert.ok(typeof active.version === "string" && typeof active.prepared_commit === "string");
    const published = await executeOnce(
      {
        kind: "upload",
        destination: `github-release:boburning/portcove:v${active.version}:publish`,
        release_expectation: releaseEffectFixture(checkpoint, {
          version: active.version,
          source_commit: active.prepared_commit,
          assets: [{ filename: "package.exe", bytes: 1, sha256: "a".repeat(64) }],
        }),
      },
      "github-release:boburning/portcove:release:321:immutable:abc",
    );
    assert.ok(published);
    await advance("promoting", [
      { kind: "operation", id: published.id, sha256: capacityDigest(published) },
      { kind: "immutable-release", id: "321", sha256: "d".repeat(64) },
    ]);
    const report = await executeOnce(
      {
        kind: "upload",
        destination: `github-actions:boburning/portcove:${active.version}:immutable-release-result`,
      },
      "github-actions:boburning/portcove:artifact:700",
    );
    assert.ok(report);
    await executeOnce(
      { kind: "retention", destination: "qualification:settled-metadata-interleaving" },
      "qualification:metadata-settled",
      { ...publisher, role: "coordinator" },
    );
    input = structuredClone((await read()).input);
    assert.ok(isRecord(input.active_candidate));
    const history = structuredClone(input.active_candidate.stage_evidence);
    input.active_candidate = {
      ...input.active_candidate,
      phase: "failed",
      failure_kind: "transient",
      report_repair: {
        schema_version: 1,
        candidate_sha256: candidateProgressIdentity(input.active_candidate),
        expected_transient_retry: 1,
        substantive_repairs: 0,
        failure: "attestation-missing",
        artifact_id: 700,
        artifact_sha256: "a".repeat(64),
        report_sha256: "b".repeat(64),
        context_manifest_sha256: "c".repeat(64),
        result_checkpoint: checkpoint,
        result_operation_id: report.id,
        result_operation_sha256: capacityDigest(report),
        result_operation: report,
        publish_operation_id: published.id,
        publish_operation_sha256: capacityDigest(published),
        release_id: 321,
        immutable_identity_sha256: "d".repeat(64),
      },
    };
    const failed = await save(input);
    assert.equal(failed.plan.action, "retry-active");
    const unconsumed = checkpoint;
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        checkpoint,
        {
          kind: "dispatch",
          destination: `github-actions:boburning/portcove:release.yml:dispatch:report-repair-1-0:${"f".repeat(64)}`,
        },
        async () => f.capacity.boundary,
        async () => assert.fail("unconsumed repair cannot dispatch"),
        {
          ...f.options,
          executorIdentity: { ...publisher, role: "coordinator" },
          maximumReceipts: 1,
        },
      ),
    );
    assert.equal((await read()).checkpoint, unconsumed);
    assert.ok(isRecord(input.active_candidate));
    input.active_candidate = {
      ...input.active_candidate,
      phase: "prepared",
      failure_kind: null,
      transient_retries: 1,
      release_run: null,
    };
    await save(input);
    assert.ok(isRecord(input.active_candidate));
    const dispatched = await executeOnce(
      { kind: "dispatch", destination: reportRepairDispatchDestination(input.active_candidate) },
      "github-actions:boburning/portcove:run:1111:attempt:1",
      { ...publisher, role: "coordinator" },
    );
    assert.ok(dispatched);
    input = structuredClone((await read()).input);
    assert.ok(isRecord(input.active_candidate));
    input.active_candidate = {
      ...input.active_candidate,
      phase: "qualifying",
      release_run: compiler,
    };
    await save(input);
    const final = await read();
    assert.ok(isRecord(final.input.active_candidate));
    inspectConsumedPublicationReportRepair(final.input.active_candidate);
    assert.deepEqual(final.input.active_candidate.stage_evidence, history);
    assert.deepEqual(final.input.active_candidate.release_run, compiler);
    assert.equal(
      dispatched.completed_effects[0]!.remote_identity,
      "github-actions:boburning/portcove:run:1111:attempt:1",
    );
    assert.equal(final.input.active_candidate.transient_retries, 1);
    assert.equal(f.refs.get(f.stateRef), checkpoint);
  },
);

void test(
  "admitted aggregate exact preimage survives remote pending/lost response and GET-only completion without repeat",
  { timeout: 180000 },
  async (t) => {
    // Real local Git and injected provider transport only. No authenticated
    // executor, network, protected effect, artifact or production proof is made.
    const f = await remoteCapacityFixture(t, true);
    const input = structuredClone(
      (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input,
    );
    assert.ok(isRecord(input.active_candidate));
    const candidate = input.active_candidate;
    candidate.phase = "qualifying";
    candidate.release_run = { run_id: 12345, attempt: 1, revision: candidate.prepared_commit };
    const qualifying = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, qualifying.checkpoint, f.config, { api: f.api });
    const proof = {
      schema_version: 1,
      candidate_sha256: candidateProgressIdentity(candidate),
      controller_revision: "3".repeat(40),
      locators: [{ kind: "native-check", id: "101", sha256: "b".repeat(64) }],
    };
    candidate.phase = "building";
    candidate.stage_evidence = [
      {
        phase: "building",
        attempts: [
          {
            previous_checkpoint: qualifying.checkpoint,
            evidence_sha256: capacityDigest(proof),
            proof,
            release_run: candidate.release_run,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      },
    ];
    const building = await checkpointReleaseOpportunity(f.bare, qualifying.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, building.checkpoint, f.config, { api: f.api });
    const expectation = {
      assembly_sha256: "1".repeat(64),
      files: [{ filename: "opaque.zip", bytes: 23, sha256: "2".repeat(64) }],
    };
    const executor = {
      controller_revision: "a".repeat(40),
      execution_ref: "refs/tags/portcove-production-controller-fixture",
      workflow: productionControllerWorkflow,
      run_id: "9988",
      run_attempt: 1,
      job_id: 501,
      check_run_id: "777",
      actor_id: "1122",
      role: "aggregate-assembly",
    };
    const request = {
      kind: "upload" as const,
      destination: "github-actions:boburning/portcove:admitted-aggregate",
      aggregate_expectation: expectation,
    };
    let effects = 0,
      ambiguous = "";
    try {
      await runBoundedCapacityOperation(
        f.bare,
        building.checkpoint,
        request,
        async () => f.capacity.boundary,
        async (_record, pending) => {
          effects++;
          const retained = await recoverReleaseOpportunity(f.bare, pending.checkpoint);
          assert.ok(
            isRecord(retained.input.controller) &&
              isRecord(retained.input.controller.capacity_attempt),
          );
          const operation = retained.input.controller.capacity_attempt.operation;
          assert.ok(isRecord(operation));
          assert.deepEqual(operation.aggregate_expectation, expectation);
          assert.equal(
            f.refs.get(f.stateRef),
            pending.checkpoint,
            "remote pending was read back before effect",
          );
          assert.deepEqual(operation.completed_effects, []);
          throw new Error("inert upload response lost before receipt");
        },
        { ...f.options, executorIdentity: executor, maximumReceipts: 1 },
      );
      assert.fail("lost response must stay ambiguous");
    } catch (error) {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      ambiguous = String(error.evidence.checkpoint);
    }
    const retained = await recoverReleaseOpportunity(f.bare, ambiguous);
    assert.ok(
      isRecord(retained.input.controller) && isRecord(retained.input.controller.capacity_attempt),
    );
    const original = retained.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(original));
    assert.equal(original.outcome, "ambiguous");
    assert.deepEqual(original.aggregate_expectation, expectation);
    assert.deepEqual(retained.input.active_candidate, candidate);
    const completed = {
      remote_identity: "github-actions-artifact:123",
      evidence_sha256: "4".repeat(64),
    };
    const recovered = await recordCapacityReadback(
      f.bare,
      ambiguous,
      "effect-completed",
      completed.evidence_sha256,
      { ...f.options, completedEffect: completed },
    );
    assert.ok(
      "durable_checkpoint" in recovered && recovered.durable_checkpoint === recovered.checkpoint,
    );
    const settled = await recoverReleaseOpportunity(f.bare, recovered.checkpoint);
    assert.ok(
      isRecord(settled.input.controller) && isRecord(settled.input.controller.capacity_attempt),
    );
    const operation = settled.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.deepEqual(operation.completed_effects, [completed]);
    assert.equal(operation.id, original.id);
    assert.deepEqual(settled.input.active_candidate, candidate);
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        recovered.checkpoint,
        request,
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        { ...f.options, executorIdentity: executor, maximumReceipts: 1 },
      ),
    );
    assert.equal(effects, 1);
  },
);

void test("exact Pages expectation survives real pending checkpoint and ambiguous partial effect without replay", async (t) => {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
  const expected = {
    archive_sha256: "1".repeat(64),
    artifact_id: 123,
    prior_site_generation_sha256: "2".repeat(64),
    repository_sha256: "3".repeat(64),
    root_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  const executor = {
    controller_revision: "a".repeat(40),
    execution_ref: "refs/tags/controller-v1",
    workflow: ".github/workflows/controller.yml",
    run_id: "123",
    run_attempt: 1,
    job_id: 456,
    check_run_id: "789",
    actor_id: "43177418",
    role: "site-publication",
  };
  let effects = 0,
    failedCheckpoint = "";
  try {
    await runBoundedCapacityOperation(
      f.repository,
      migrated.checkpoint,
      {
        kind: "upload",
        destination: "github-pages:boburning/portcove:complete-site",
        site_expectation: expected,
      },
      async () => capacity.boundary,
      async (record, pending) => {
        effects++;
        const retained = await recoverReleaseOpportunity(f.repository, pending.checkpoint);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        const operation = retained.input.controller.capacity_attempt.operation;
        assert.ok(isRecord(operation));
        assert.deepEqual(operation.site_expectation, expected);
        assert.equal(operation.outcome, "pending");
        // Controlled data seam only: no GitHub executor, upload or public proof.
        await record("github-pages:boburning/portcove:fixture-deployment", "6".repeat(64));
        throw Error("lost response after observed partial fixture effect");
      },
      { executorIdentity: executor, maximumReceipts: 1 },
    );
    assert.fail("ambiguous response must stop");
  } catch (error) {
    assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
    failedCheckpoint = String(error.evidence.checkpoint);
  }
  const failed = await recoverReleaseOpportunity(f.repository, failedCheckpoint);
  assert.ok(
    isRecord(failed.input.controller) && isRecord(failed.input.controller.capacity_attempt),
  );
  const operation = failed.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.deepEqual(operation.site_expectation, expected);
  assert.equal(operation.outcome, "ambiguous");
  assert.deepEqual(failed.input.active_candidate, f.input.active_candidate);
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      failedCheckpoint,
      {
        kind: "upload",
        destination: "github-pages:boburning/portcove:complete-site",
        site_expectation: expected,
      },
      async () => capacity.boundary,
      async () => {
        effects++;
      },
      { executorIdentity: executor, maximumReceipts: 1 },
    ),
  );
  assert.equal(effects, 1);
  await assert.rejects(
    recordCapacityReadback(f.repository, failedCheckpoint, "effect-not-applied", "7".repeat(64)),
  );
});

void test(
  "candidate stage evidence survives real Git checkpoint custody and refuses backfill or same-phase rewrites",
  { timeout: 60000 },
  async (t) => {
    const f = await remoteFixture(t);
    const active = f.input.active_candidate!;
    active.phase = "qualifying";
    active.release_run = { run_id: 12345, attempt: 1, revision: active.prepared_commit };
    const qualifying = await checkpointReleaseOpportunity(f.bare, f.saved.checkpoint, f.input);
    const proof = {
      schema_version: 1,
      candidate_sha256: candidateProgressIdentity(active),
      controller_revision: "3".repeat(40),
      locators: [{ kind: "native-check", id: "101", sha256: "b".repeat(64) }],
    };
    active.phase = "building";
    active.stage_evidence = [
      {
        phase: "building",
        attempts: [
          {
            previous_checkpoint: qualifying.checkpoint,
            evidence_sha256: capacityDigest(proof),
            proof,
            release_run: active.release_run,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      },
    ];
    const building = await checkpointReleaseOpportunity(f.bare, qualifying.checkpoint, f.input);
    const recovered = await recoverReleaseOpportunity(f.bare, building.checkpoint);
    assert.deepEqual(
      isRecord(recovered.input.active_candidate) && recovered.input.active_candidate.stage_evidence,
      active.stage_evidence,
    );
    assert.equal(
      capacityDigest(
        (await checkpointReleaseOpportunity(f.bare, qualifying.checkpoint, f.input)).plan,
      ),
      capacityDigest(building.plan),
    );
    let latest = building.checkpoint;
    for (const phase of ["publishing", "promoting"]) {
      const prior = latest;
      active.phase = phase;
      assert.ok(Array.isArray(active.stage_evidence));
      active.stage_evidence.push({
        phase,
        attempts: [
          {
            previous_checkpoint: prior,
            evidence_sha256: capacityDigest(proof),
            proof,
            release_run: active.release_run,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      });
      latest = (await checkpointReleaseOpportunity(f.bare, prior, f.input)).checkpoint;
    }
    const final = await recoverReleaseOpportunity(f.bare, latest);
    assert.deepEqual(
      isRecord(final.input.active_candidate) && final.input.active_candidate.stage_evidence,
      active.stage_evidence,
    );
    const exported = await exportCoordinatorCheckpoint(f.bare, latest);
    assert.equal(exported.commit.oid, latest);
    assert.ok(exported.blob.contents.includes('"stage_evidence"'));
    const original = structuredClone(active.stage_evidence);
    delete active.stage_evidence;
    await assert.rejects(
      checkpointReleaseOpportunity(f.bare, latest, f.input),
      /history cannot be removed/,
    );
    active.stage_evidence = original;
    assert.ok(Array.isArray(active.stage_evidence));
    const slot: unknown = active.stage_evidence[0];
    assert.ok(isRecord(slot) && Array.isArray(slot.attempts));
    slot.attempts.push(structuredClone(slot.attempts[0]));
    await assert.rejects(
      checkpointReleaseOpportunity(f.bare, latest, f.input),
      /duplicated|regressed/,
    );
    assert.equal(
      execFileSync("git", ["-C", f.bare, "rev-parse", coordinatorStateRef], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      latest,
    );
  },
);

void test(
  "initial metadata remote pending and exact readback preserve an existing candidate",
  { timeout: 60000 },
  async (t) => {
    // Real Git and existing injected provider CAS, never a live protected effect.
    const f = await remoteCapacityFixture(t, true);
    const original = structuredClone(f.input.active_candidate);
    const { descriptor, published } = metadataBootstrapFixture();
    let effects = 0;
    const result = await runBoundedMetadataBootstrapOperation(
      f.bare,
      f.migrated.checkpoint,
      descriptor,
      { kind: "upload", destination: "qualification:bootstrap-shared-pages" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        effects++;
        await record("qualification:initial-shared-publication", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(result.completion, "readback-required");
    assert.equal(result.operation.outcome, "pending");
    assert.match(String(result.operation.executor_nonce), /^[a-f0-9]{64}$/u);
    assert.equal(f.refs.get(f.stateRef), result.checkpoint);
    await assert.rejects(
      runBoundedMetadataBootstrapOperation(
        f.bare,
        result.checkpoint,
        descriptor,
        { kind: "upload", destination: "qualification:bootstrap-shared-pages" },
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        { ...f.options, maximumReceipts: 1 },
      ),
      /held|recovery|repeat/,
    );
    const resolved = await recordCapacityReadback(
      f.bare,
      result.checkpoint,
      "effect-completed",
      "b".repeat(64),
      f.options,
    );
    const seeded = await recordPublishedMetadata(
      f.bare,
      resolved.checkpoint,
      {
        ...published,
        operation_id: result.operation.id,
        publication: {
          remote_identity: "qualification:initial-shared-publication",
          evidence_sha256: "a".repeat(64),
          site_generation_sha256: "c".repeat(64),
        },
      },
      f.options,
    );
    const final = await recoverReleaseOpportunity(f.bare, seeded.checkpoint);
    assert.deepEqual(final.input.active_candidate, original);
    assert.deepEqual(final.input.metadata_bootstrap, descriptor);
    assert.equal(f.refs.get(f.stateRef), seeded.checkpoint);
    assert.equal(effects, 1);
  },
);

for (const lost of [false, true])
  void test(
    `initial metadata bootstrap ${lost ? "retains ambiguous intent through sparse recovery" : "settles exact empty publication without a candidate"}`,
    { timeout: 60000 },
    async (t) => {
      const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-initial-metadata-"));
      t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
      const f = {
        repository: repositoryRoot,
        git: (...args: string[]) =>
          execFileSync("git", ["-C", repositoryRoot, ...args], {
            encoding: "utf8",
            windowsHide: true,
          }).trim(),
      };
      f.git("init", "--bare", "--quiet");
      const capacity = { ...capacityFixture(), schema_version: 2 };
      const { descriptor, published } = metadataBootstrapFixture();
      const input = {
        schema_version: 2,
        now: new Date(descriptor.generated_at).toISOString(),
        opportunity: null,
        active_candidate: null,
        metadata_bootstrap: descriptor,
        published_metadata: null,
        publication: {
          complete: true,
          observed_at: new Date(descriptor.generated_at).toISOString(),
          published_versions: [],
          published_sources: [],
          reserved_versions: [],
          last_routine_preview_at: null,
        },
        controller: {
          workflow: ".github/workflows/release-coordinator.yml",
          revision: "3".repeat(40),
          publication_paused: false,
          capacity_attempt: capacity,
        },
      };
      const migrated = await checkpointReleaseOpportunity(f.repository, null, input);
      assert.equal(migrated.plan.action, "skip");
      assert.equal(Object.hasOwn(migrated.plan.authority, "opportunity_commit"), false);
      let effects = 0;
      const request = {
        kind: "upload" as const,
        destination: "qualification:initial-application-pages",
      };
      let checkpoint: string;
      if (lost) {
        await assert.rejects(
          runBoundedMetadataBootstrapOperation(
            f.repository,
            migrated.checkpoint,
            descriptor,
            request,
            async () => capacity.boundary,
            async () => {
              effects++;
              throw new Error("fixture provider effect response lost");
            },
            { maximumReceipts: 1 },
          ),
          /recover and read back/,
        );
        checkpoint = f.git("rev-parse", coordinatorStateRef);
      } else {
        const result = await runBoundedMetadataBootstrapOperation(
          f.repository,
          migrated.checkpoint,
          descriptor,
          request,
          async () => capacity.boundary,
          async (record) => {
            effects++;
            await record("qualification:initial-public-site", "8".repeat(64));
          },
          { maximumReceipts: 1 },
        );
        checkpoint = result.checkpoint;
      }
      let repository = f.repository;
      if (lost) {
        const mirror = path.join(f.repository, "bootstrap-transport.git");
        execFileSync("git", ["clone", "--mirror", "--quiet", f.repository, mirror], {
          windowsHide: true,
        });
        const exported = await exportCoordinatorCheckpoint(mirror, checkpoint);
        const sparse = path.join(f.repository, "bootstrap-sparse.git");
        execFileSync("git", ["init", "--bare", "--quiet", sparse], { windowsHide: true });
        const objects: { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }[] = [];
        for (const ref of [exported.checkpoint, exported.previous]) {
          assert.ok(ref);
          for (const [kind, suffix] of [
            ["commit", ""],
            ["tree", "^{tree}"],
            ["blob", ":state.json"],
          ] as const) {
            const oid = execFileSync("git", ["-C", mirror, "rev-parse", ref + suffix], {
              encoding: "utf8",
              windowsHide: true,
            }).trim();
            if (!objects.some((object) => object.oid === oid))
              objects.push({
                kind,
                oid,
                bytes: execFileSync("git", ["-C", mirror, "cat-file", kind, oid], {
                  windowsHide: true,
                }),
              });
          }
        }
        await importCoordinatorCheckpoint(sparse, checkpoint, objects);
        assert.throws(() =>
          execFileSync("git", ["-C", sparse, "cat-file", "-e", migrated.checkpoint], {
            windowsHide: true,
            stdio: "ignore",
          }),
        );
        repository = sparse;
        const resolved = await recordCapacityReadback(
          repository,
          checkpoint,
          "effect-completed",
          "9".repeat(64),
          {
            completedEffect: {
              remote_identity: "qualification:initial-public-site",
              evidence_sha256: "8".repeat(64),
            },
          },
        );
        checkpoint = resolved.checkpoint;
      }
      const recovered = await recoverReleaseOpportunity(repository, checkpoint);
      assert.equal(recovered.input.active_candidate, null);
      assert.deepEqual(recovered.input.metadata_bootstrap, descriptor);
      assert.ok(
        isRecord(recovered.input.controller) &&
          isRecord(recovered.input.controller.capacity_attempt),
      );
      const operation = recovered.input.controller.capacity_attempt.operation;
      assert.ok(isRecord(operation) && isRecord(operation.metadata_bootstrap));
      assert.equal(operation.metadata_bootstrap.descriptor_sha256, capacityDigest(descriptor));
      const initial = {
        ...published,
        operation_id: operation.id,
        publication: {
          remote_identity: "qualification:initial-public-site",
          evidence_sha256: "8".repeat(64),
          site_generation_sha256: "7".repeat(64),
        },
      };
      await assert.rejects(
        recordPublishedMetadata(repository, checkpoint, {
          ...initial,
          records_sha256: "6".repeat(64),
        }),
        /bootstrap descriptor/,
      );
      const final = await recordPublishedMetadata(repository, checkpoint, initial);
      const finalState = await recoverReleaseOpportunity(repository, final.checkpoint);
      assert.deepEqual(finalState.input.published_metadata, initial);
      assert.equal(finalState.input.active_candidate, null);
      await assert.rejects(
        runBoundedMetadataBootstrapOperation(
          repository,
          final.checkpoint,
          descriptor,
          request,
          async () => capacity.boundary,
          async () => {
            effects++;
          },
          { maximumReceipts: 1 },
        ),
        /permanently closed/,
      );
      const changed = structuredClone(finalState.input);
      changed.metadata_bootstrap = { ...descriptor, setup_plan_sha256: "f".repeat(64) };
      await assert.rejects(
        checkpointReleaseOpportunity(repository, final.checkpoint, changed),
        /cannot disappear or be replaced/,
      );
      assert.equal(effects, 1);
    },
  );

void test("optional frozen opportunity binds allocation and cannot be changed, removed or retroactively supplied", async (t) => {
  const f = await fixture(t);
  assert.ok(f.input.active_candidate);
  const original = structuredClone(f.input.opportunity);
  f.input.active_candidate.frozen_opportunity = structuredClone(original);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const queued = structuredClone(f.input);
  queued.opportunity.source_commit = "7".repeat(40);
  queued.opportunity.classification.source_commit = "7".repeat(40);
  queued.opportunity.classification.reviewed_commit = "7".repeat(40);
  const next = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, queued);
  assert.ok("active_candidate" in next.plan);
  assert.deepEqual(next.plan.active_candidate.frozen_opportunity, original);
  const recovered = await recoverReleaseOpportunity(f.repository, next.checkpoint);
  assert.ok(isRecord(recovered.input.active_candidate));
  assert.deepEqual(recovered.input.active_candidate.frozen_opportunity, original);
  for (const mutation of ["remove", "change", "null"]) {
    const changed = structuredClone(queued);
    assert.ok(changed.active_candidate);
    if (mutation === "remove") delete changed.active_candidate.frozen_opportunity;
    else if (mutation === "null") changed.active_candidate.frozen_opportunity = null;
    else changed.active_candidate.frozen_opportunity = { ...original, urgency: true };
    await assert.rejects(checkpointReleaseOpportunity(f.repository, next.checkpoint, changed));
    assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), next.checkpoint);
  }
  const legacy = await fixture(t);
  const legacySaved = await checkpointReleaseOpportunity(
    legacy.repository,
    legacy.initial.checkpoint,
    legacy.input,
  );
  assert.ok(legacy.input.active_candidate);
  legacy.input.active_candidate.frozen_opportunity = structuredClone(legacy.input.opportunity);
  await assert.rejects(
    checkpointReleaseOpportunity(legacy.repository, legacySaved.checkpoint, legacy.input),
    /cannot be added/u,
  );
  const legacyRecovered = await recoverReleaseOpportunity(
    legacy.repository,
    legacySaved.checkpoint,
  );
  assert.ok(isRecord(legacyRecovered.input.active_candidate));
  assert.equal(Object.hasOwn(legacyRecovered.input.active_candidate, "frozen_opportunity"), false);
});

void test("allocation snapshot must match the whole preceding opportunity and never widens checkpoint bytes", async (t) => {
  const f = await fixture(t);
  assert.ok(f.input.active_candidate);
  f.input.active_candidate.frozen_opportunity = {
    ...structuredClone(f.input.opportunity),
    urgency: true,
  };
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input),
    /preceding preparation input/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), f.initial.checkpoint);
  const candidate = structuredClone(f.input.active_candidate);
  delete candidate.frozen_opportunity;
  f.input.active_candidate = null;
  f.input.publication.reserved_versions = [];
  Object.assign(f.input.opportunity.classification, { evidence_note: "x".repeat(33000) });
  const larger = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  candidate.frozen_opportunity = structuredClone(f.input.opportunity);
  f.input.active_candidate = candidate;
  f.input.publication.reserved_versions = [f.prepared.version];
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, larger.checkpoint, f.input),
    /byte bound/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), larger.checkpoint);
});

void test("checkpoint rejects physical trailing whitespace and invalid UTF-8 without normalizing history", async (t) => {
  const f = await fixture(t);
  const original = execFileSync("git", [
    "-C",
    f.repository,
    "cat-file",
    "blob",
    `${f.initial.checkpoint}:state.json`,
  ]);
  for (const suffix of [Buffer.from("\n"), Buffer.from("\t"), Buffer.from([0xff])]) {
    const blob = execFileSync("git", ["-C", f.repository, "hash-object", "-w", "--stdin"], {
      input: Buffer.concat([original, suffix]),
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["-C", f.repository, "mktree"], {
      input: `100644 blob ${blob}\tstate.json\n`,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["-C", f.repository, "commit-tree", tree], {
      input: "physical bytes fixture\n",
      encoding: "utf8",
    }).trim();
    f.git("update-ref", coordinatorStateRef, commit);
    await assert.rejects(recoverReleaseOpportunity(f.repository, commit), /canonical|UTF-8/u);
    assert.equal(f.git("rev-parse", coordinatorStateRef), commit);
  }
});

void test("checkpoint recovers exact prepared candidate and parent history without touching index or branch", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const head = git("rev-parse", "HEAD");
  const index = git("write-tree");
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  assert.equal(saved.plan.action, "resume-active");
  assert.equal(git("rev-parse", `${saved.checkpoint}^`), initial.checkpoint);
  assert.deepEqual((await recoverReleaseOpportunity(repository, saved.checkpoint)).input, input);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("write-tree"), index);
  // A process may lose its response after commit. Same preimage/input must find
  // that exact checkpoint; newer snapshot retries must never roll it back.
  assert.deepEqual(
    await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    saved,
  );
  const next = structuredClone(input);
  next.active_candidate!.phase = "qualifying";
  const advanced = await checkpointReleaseOpportunity(repository, saved.checkpoint, next);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), advanced.checkpoint);
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, saved.checkpoint));
});

void test("missing and conflicting prepared receipts refuse atomically including identical checkpoint retry", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const [versionRef, sourceRef] = prepared.allocation_refs;
  git("update-ref", "-d", sourceRef);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
  git("update-ref", sourceRef, prepared.prepared_commit);
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  git("update-ref", versionRef, input.opportunity.source_commit);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, saved.checkpoint));
  assert.equal(git("rev-parse", coordinatorStateRef), saved.checkpoint);
});

void test("frozen identity, counters, phases, run and active reservation cannot be silently replaced", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  for (const [field, value] of Object.entries({
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    version: "0.1.0-alpha.4",
    intent_sha256: "e".repeat(64),
    phase: "publishing",
    transient_retries: 1,
    substantive_repairs: 1,
  })) {
    const next = structuredClone(input);
    next.active_candidate![field] = value;
    await assert.rejects(
      async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, next),
      Error,
      field,
    );
    assert.equal(git("rev-parse", coordinatorStateRef), saved.checkpoint);
  }
  const clear = structuredClone(input);
  clear.active_candidate = null;
  clear.publication.reserved_versions = [];
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, clear),
    /discard/u,
  );
  const changed = structuredClone(input);
  changed.controller.revision = "f".repeat(40);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, changed),
    /controller/u,
  );
});

void test("failed candidate resumes only through bounded recovery and preserves the run identity", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  input.active_candidate!.phase = "qualifying";
  input.active_candidate!.release_run = {
    run_id: 123,
    attempt: 1,
    revision: input.active_candidate!.prepared_commit,
  };
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const replaced = structuredClone(input);
  replaced.active_candidate!.release_run = {
    run_id: 124,
    attempt: 1,
    revision: input.active_candidate!.prepared_commit,
  };
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, replaced),
    /release run/u,
  );
  input.active_candidate!.phase = "failed";
  input.active_candidate!.failure_kind = "transient";
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const resume = structuredClone(input);
  resume.active_candidate!.phase = "qualifying";
  resume.active_candidate!.failure_kind = null;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, resume),
    /recovery increment/u,
  );
  resume.active_candidate!.transient_retries = 1;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, resume),
    /restart/u,
  );
  resume.active_candidate!.phase = "prepared";
  resume.active_candidate!.release_run = null;
  const recovered = await checkpointReleaseOpportunity(repository, saved.checkpoint, resume);
  assert.equal(recovered.plan.action, "resume-active");
  const reset = structuredClone(resume);
  reset.active_candidate!.transient_retries = 0;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, recovered.checkpoint, reset),
    /regressed/u,
  );
});

void test("competing processes and linked worktrees share one CAS preimage; identical retries agree", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const linked = path.join(repository, "linked");
  git("worktree", "add", "--detach", linked, "HEAD");
  const invoke = (root: string, data: unknown) =>
    execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {checkpointReleaseOpportunity as save} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await save(${JSON.stringify(root)},${JSON.stringify(initial.checkpoint)},${JSON.stringify(data)})));`,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
  const other = structuredClone(input);
  other.controller.publication_paused = true;
  const raced = await Promise.allSettled([invoke(repository, input), invoke(linked, other)]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
  const winner = raced[0]?.status === "fulfilled" ? input : other;
  const receipts = await Promise.all([invoke(repository, winner), invoke(linked, winner)]);
  const first: unknown = JSON.parse(receipts[0].stdout);
  const second: unknown = JSON.parse(receipts[1].stdout);
  assert.ok(isRecord(first) && isRecord(second));
  assert.equal(first.checkpoint, second.checkpoint);
});

void test("a differently prepared classification cannot replace the planned intent even through both allocation refs", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const message = git("show", "-s", "--format=%B", prepared.prepared_commit);
  const payload: unknown = JSON.parse(message.split("\n").slice(3).join("\n"));
  assert.ok(isRecord(payload));
  payload.migration_notes = "different reviewed intent";
  const bytes = JSON.stringify(payload);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const commit = execFileSync(
    "git",
    [
      "-C",
      repository,
      "commit-tree",
      prepared.prepared_tree,
      "-p",
      input.opportunity.source_commit,
    ],
    {
      encoding: "utf8",
      input: `Prepare application ${prepared.version}\n\nPortcove-Preparation-SHA256: ${digest}\n${bytes}\n`,
      windowsHide: true,
    },
  ).trim();
  for (const ref of prepared.allocation_refs) git("update-ref", ref, commit);
  input.active_candidate!.prepared_commit = commit;
  input.active_candidate!.intent_sha256 = digest;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /reviewed classification/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
});

void test("pause preserves the candidate, failure reclassification and phase-skipping recovery refuse", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  input.controller.publication_paused = true;
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  assert.equal(saved.plan.action, "pause");
  assert.deepEqual(
    (await recoverReleaseOpportunity(repository, saved.checkpoint)).input.active_candidate,
    input.active_candidate,
  );
  input.controller.publication_paused = false;
  input.active_candidate!.phase = "failed";
  input.active_candidate!.failure_kind = "transient";
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const changed = structuredClone(input);
  changed.active_candidate!.failure_kind = "substantive";
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, changed),
    /reclassified/u,
  );
  const skipped = structuredClone(input);
  skipped.active_candidate!.phase = "promoting";
  skipped.active_candidate!.failure_kind = null;
  skipped.active_candidate!.transient_retries = 1;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, skipped),
    /restart/u,
  );
});

void test("only ordered promotion and matching publication can clear an active reservation", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  for (const phase of ["qualifying", "building", "publishing", "promoting"]) {
    input.active_candidate!.phase = phase;
    saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  }
  const published = structuredClone(input);
  published.active_candidate = null;
  published.publication.reserved_versions = [];
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, published),
    /discard/u,
  );
  published.publication.published_versions.push("0.1.0-alpha.3");
  published.publication.published_sources = [input.opportunity.source_commit];
  const completed = await checkpointReleaseOpportunity(repository, saved.checkpoint, published);
  assert.equal(completed.plan.action, "skip");
  assert.equal(
    (await recoverReleaseOpportunity(repository, completed.checkpoint)).input.active_candidate,
    null,
  );
});

void test("lost state, oversized input and unrecognized checkpoint tree remain refusals", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  await assert.rejects(
    async () => await recoverReleaseOpportunity(repository, git("rev-parse", "HEAD")),
    /state.json/u,
  );
  await assert.rejects(
    async () =>
      await checkpointReleaseOpportunity(repository, initial.checkpoint, {
        ...input,
        opportunity: {
          ...input.opportunity,
          classification: {
            ...input.opportunity.classification,
            migration_notes: { second: "b", first: "a" },
          },
        },
      }),
    /migration notes must be a string/u,
  );
  await assert.rejects(
    async () =>
      await checkpointReleaseOpportunity(repository, initial.checkpoint, {
        ...input,
        padding: "x".repeat(65536),
      }),
    /byte bound/u,
  );
  git("update-ref", "-d", coordinatorStateRef);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, initial.checkpoint));
});

void test("symbolic state or prepared refs cannot redirect a checkpoint transaction", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const alias = "refs/portcove/unrelated-state";
  git("update-ref", alias, initial.checkpoint);
  git("symbolic-ref", coordinatorStateRef, alias);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, initial.checkpoint));
  assert.equal(git("rev-parse", alias), initial.checkpoint);
  git("update-ref", "--no-deref", coordinatorStateRef, initial.checkpoint);
  const versionRef = prepared.allocation_refs[0];
  const preparedAlias = "refs/portcove/unrelated-preparation";
  git("update-ref", preparedAlias, prepared.prepared_commit);
  git("symbolic-ref", versionRef, preparedAlias);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
  assert.equal(git("rev-parse", preparedAlias), prepared.prepared_commit);
  git("update-ref", "--no-deref", "-d", coordinatorStateRef);
  git("symbolic-ref", coordinatorStateRef, "refs/portcove/missing-state");
  const first = structuredClone(input);
  first.active_candidate = null;
  first.publication.reserved_versions = [];
  await assert.rejects(async () => await checkpointReleaseOpportunity(repository, null, first));
  assert.equal(git("symbolic-ref", coordinatorStateRef), "refs/portcove/missing-state");
});
