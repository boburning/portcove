import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { capacityDigest as digest } from "./release-capacity.mts";
import { orderedJsonValue } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { readCompleteRunArtifactInventory } from "./release-run-artifact-inventory.mts";
import {
  inspectCandidateSigningOperation,
  inspectCandidateSigningProvider,
  readCandidateSigningOperations,
  recoverCandidateSigningCustody,
} from "./release-candidate-signing-recovery.mts";

const roles = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
const candidate = {
  phase: "publishing",
  version: "0.1.0-beta.1",
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  prepared_commit: "c".repeat(40),
  prepared_tree: "d".repeat(40),
  transient_retries: 0,
  substantive_repairs: 0,
};
type Output = "payload" | "context" | (typeof roles)[number];
function operation(output: Output, sequence = 1, changes: Record<string, unknown> = {}) {
  const capacity = capacityFixture();
  const identity = {
    before_checkpoint: "e".repeat(40),
    candidate: {
      source_commit: candidate.source_commit,
      prepared_commit: candidate.prepared_commit,
      version: candidate.version,
      transient_retries: 0,
      substantive_repairs: 0,
    },
    kind: "upload",
    sequence,
    destination: `github-actions:boburning/portcove:${candidate.version}:${output === "payload" ? "payload-signatures" : output === "context" ? "payload-signing-context" : `tuf-${output}-envelope`}`,
    executor_nonce: "f".repeat(64),
    receipt_limit: 1,
    executor_identity: {
      actor_id: "1122",
      check_run_id: "777",
      controller_revision: "1".repeat(40),
      execution_ref: "refs/tags/portcove-production-controller-fixture",
      job_id: 501,
      role: output === "payload" || output === "context" ? "payload-signing" : `tuf-${output}`,
      run_attempt: 1,
      run_id: "9988",
      workflow: productionControllerWorkflow,
    },
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: digest(capacity.ratification),
    ...changes,
  };
  return {
    ...identity,
    id: digest(identity),
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:100",
        evidence_sha256: "2".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: null,
  };
}
function provider(output: Exclude<Output, "payload">) {
  const op = operation(output),
    producer = op.executor_identity;
  const run = {
    id: 9988,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    actor: { id: 1122 },
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: 501,
    run_id: 9988,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
    status: "completed",
    conclusion: "success",
    name: releaseControlPhaseProfile(output === "context" ? "payload" : `tuf-${output}`)
      .reader_name,
  };
  const artifacts = [false, true].map((bundle, i) => ({
    id: 100 + i,
    name:
      output === "context"
        ? `trusted-payload-signing-context${bundle ? "-attestation" : ""}-9988-1`
        : `trusted-tuf-${output}-${bundle ? "attestation" : "output"}-9988-1`,
    digest: `sha256:${String(i + 3).repeat(64)}`,
    size_in_bytes: 200,
    expired: false,
    workflow_run: {
      id: 9988,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: producer.controller_revision,
    },
  }));
  return { op, run, job, inventory: { total_count: 2, artifacts } };
}
void test("original context and all five role provider joins preserve successful producer despite later workflow failure", () => {
  for (const output of ["context", ...roles] as const) {
    const f = provider(output);
    const result = inspectCandidateSigningProvider(
      f.run,
      f.run,
      f.job,
      f.inventory,
      f.op,
      candidate,
      output,
    );
    assert.equal(result.artifact.id, 100);
    assert.equal(result.bundle.id, 101);
    assert.equal(result.authority, "none");
    assert.equal(result.producer.role, output === "context" ? "payload-signing" : `tuf-${output}`);
  }
});
void test("candidate phase, original tuple, role and bounded counters cannot be replaced by current wake", () => {
  for (const output of ["payload", "context", ...roles] as const) {
    assert.ok(inspectCandidateSigningOperation(operation(output), candidate, output));
    assert.ok(
      inspectCandidateSigningOperation(
        operation(output),
        { ...candidate, phase: "promoting", transient_retries: 1 },
        output,
      ),
    );
    for (const changed of [
      { ...candidate, phase: "building" },
      { ...candidate, prepared_commit: "9".repeat(40) },
      { ...candidate, source_commit: "9".repeat(40) },
      { ...candidate, version: "0.1.0-beta.2" },
    ])
      assert.throws(() => inspectCandidateSigningOperation(operation(output), changed, output));
    const newer = operation(output, 1, {
      candidate: { ...operation(output).candidate, transient_retries: 1 },
    });
    assert.throws(() => inspectCandidateSigningOperation(newer, candidate, output));
  }
  assert.throws(() =>
    inspectCandidateSigningOperation(operation("releases"), candidate, "snapshot"),
  );
});
void test("missing bundle, expiration, duplicate names, producer failure and artifact identity drift are HOLD", () => {
  const f = provider("context");
  const check = (run: unknown, job: unknown, inventory: unknown) =>
    inspectCandidateSigningProvider(run, run, job, inventory, f.op, candidate, "context");
  assert.throws(() =>
    check(f.run, f.job, { total_count: 1, artifacts: f.inventory.artifacts.slice(0, 1) }),
  );
  assert.throws(() => check(f.run, { ...f.job, conclusion: "failure" }, f.inventory));
  assert.throws(() =>
    check({ ...f.run, status: "in_progress", conclusion: null }, f.job, f.inventory),
  );
  assert.throws(() => check(f.run, { ...f.job, id: 502 }, f.inventory));
  assert.throws(() =>
    check(f.run, f.job, {
      total_count: 3,
      artifacts: [...f.inventory.artifacts, { ...f.inventory.artifacts[1], id: 102 }],
    }),
  );
  for (const changed of [
    { ...f.inventory.artifacts[0], expired: true },
    { ...f.inventory.artifacts[0], id: 103 },
    {
      ...f.inventory.artifacts[0],
      workflow_run: { ...f.inventory.artifacts[0]!.workflow_run, head_repository_id: 42 },
    },
  ])
    assert.throws(() =>
      check(f.run, f.job, { total_count: 2, artifacts: [changed, f.inventory.artifacts[1]] }),
    );
  assert.throws(() => check(f.run, f.job, { ...f.inventory, total_count: 3 }));
});
void test("unresolved positive artifact observation remains data only and incomplete bounded inventory is refused", () => {
  const f = provider("timestamp");
  const pending = {
    ...f.op,
    outcome: "ambiguous",
    completed_effects: [],
    failure_evidence: { remote_identity: "inert-lost-response", evidence_sha256: "4".repeat(64) },
  };
  assert.equal(
    inspectCandidateSigningProvider(
      f.run,
      f.run,
      f.job,
      f.inventory,
      pending,
      candidate,
      "timestamp",
    ).authority,
    "none",
  );
  let requests = 0;
  assert.throws(() =>
    readCompleteRunArtifactInventory(() => {
      requests++;
      return { total_count: 401, artifacts: [] };
    }),
  );
  assert.equal(requests, 1);
  requests = 0;
  assert.throws(() =>
    readCompleteRunArtifactInventory(() => {
      requests++;
      return { total_count: 3, artifacts: f.inventory.artifacts };
    }),
  );
  assert.equal(requests, 2);
});
void test("unrelated unresolved operation is refused before raw receipt hydration/provider access", async () => {
  const op = operation("context", 1, { destination: "unrelated:effect" });
  await assert.rejects(
    readCandidateSigningOperations(
      "unused",
      {
        controller: {
          capacity_attempt: {
            schema_version: 2,
            operation: { ...op, outcome: "pending", completed_effects: [] },
            prior_operations: [],
          },
        },
      },
      candidate,
      {
        request() {
          assert.fail("unrelated pending must refuse before GET");
        },
      },
    ),
    /unrelated unresolved/u,
  );
});
void test("imported tool/executor JSON cannot invoke current custody receiver or provider", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-signing-held-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    recoverCandidateSigningCustody(
      {
        repository: directory,
        checkpoint: "a".repeat(40),
        remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
      },
      {},
      {} as Parameters<typeof recoverCandidateSigningCustody>[2],
      directory,
      performance.now() + 10000,
      async () => assert.fail("no controls before actual tools"),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      /same-process controller/u.test(error.cause.message),
  );
  await assert.rejects(
    recoverCandidateSigningCustody(
      { repository: directory, checkpoint: "a".repeat(40), remote_configuration: {} },
      {},
      {} as Parameters<typeof recoverCandidateSigningCustody>[2],
      directory,
      performance.now() - 1,
      async () => {},
    ),
    /deadline/u,
  );
});

void test(
  "real Git original signing receipt discovery preserves seven exact compact proofs without mutation",
  { timeout: 180000 },
  async (t) => {
    // Real inert Git objects and supplied provider-like facts. No attestation,
    // controller/private receipt, key, remote write or production grant is minted.
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-signing-journal-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", directory, ...args], {
        input,
        encoding: "utf8",
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_AUTHOR_NAME: "Inert signing receipt",
          GIT_AUTHOR_EMAIL: "fixture@portcove.invalid",
          GIT_COMMITTER_NAME: "Inert signing receipt",
          GIT_COMMITTER_EMAIL: "fixture@portcove.invalid",
          GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
        },
      }).trim();
    git(["init", "--bare", "--quiet", "--template="]);
    const legacy: unknown = JSON.parse(
      await readFile(
        new URL("./fixtures/release-coordinator-legacy.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      isRecord(legacy) &&
        Array.isArray(legacy.rows) &&
        isRecord(legacy.rows[1]) &&
        isRecord(legacy.rows[1].input),
    );
    const input = structuredClone(legacy.rows[1].input);
    assert.ok(isRecord(input.active_candidate) && isRecord(input.controller));
    const active: Record<string, unknown> = { ...input.active_candidate, phase: "publishing" };
    const proofs = [];
    let sequence = 0;
    for (const output of ["payload", "context", ...roles] as const) {
      const original = operation(output, ++sequence, {
        candidate: {
          source_commit: active.source_commit,
          prepared_commit: active.prepared_commit,
          version: active.version,
          transient_retries: active.transient_retries,
          substantive_repairs: active.substantive_repairs,
        },
        destination: `github-actions:boburning/portcove:${String(active.version)}:${output === "payload" ? "payload-signatures" : output === "context" ? "payload-signing-context" : `tuf-${output}-envelope`}`,
      });
      const capacity = {
        ...capacityFixture(),
        schema_version: 2,
        operation: original,
        prior_operations: [],
      };
      const prepared = {
        ...input,
        schema_version: 2,
        active_candidate: active,
        controller: {
          workflow: input.controller.workflow,
          revision: input.controller.revision,
          publication_paused: false,
          capacity_attempt: capacity,
        },
      };
      const raw = JSON.stringify(
        orderedJsonValue({ schema_version: 1, previous: null, input: prepared }),
      );
      const blob = git(["hash-object", "-w", "--stdin"], raw);
      const tree = git(["mktree"], `100644 blob ${blob}\tstate.json\n`);
      const checkpoint = git(["commit-tree", tree], "Inert original receipt\n");
      proofs.push({
        summary_schema_version: 1,
        subject: { kind: "candidate", identity: active.prepared_commit },
        kind: "upload",
        destination_sha256: digest(original.destination),
        completed: true,
        transient_retries: 0,
        substantive_repairs: 0,
        attempts: [{ checkpoint, id: original.id, operation_sha256: digest(original) }],
      });
    }
    const before = git(["for-each-ref", "--format=%(refname)"]); // Empty bare repository has no authority refs.
    assert.equal(before, "");
    const capacity = { schema_version: 2, operation: null, prior_operations: proofs };
    const found = await readCandidateSigningOperations(
      directory,
      { controller: { capacity_attempt: capacity } },
      active,
      {
        request() {
          assert.fail("all named original receipt objects already present; no provider read");
        },
      },
    );
    assert.equal(found.size, 7);
    assert.deepEqual([...found.keys()], ["payload", "context", ...roles]);
    for (const [output, original] of found) {
      assert.equal(inspectCandidateSigningOperation(original, active, output).id, original.id);
      const observed = provider(output === "payload" ? "context" : output);
      if (output !== "payload")
        assert.equal(
          inspectCandidateSigningProvider(
            observed.run,
            observed.run,
            observed.job,
            observed.inventory,
            original,
            active,
            output,
          ).artifact.id,
          100,
        );
    }
    assert.equal(git(["for-each-ref", "--format=%(refname)"]), before);
    const altered = structuredClone(proofs);
    altered[0]!.attempts[0]!.operation_sha256 = "0".repeat(64);
    await assert.rejects(
      readCandidateSigningOperations(
        directory,
        { controller: { capacity_attempt: { ...capacity, prior_operations: altered } } },
        active,
        {
          request() {
            throw new Error("inert altered-proof raw hydration refused");
          },
        },
      ),
      /altered-proof/u,
    );
  },
);
