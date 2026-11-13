import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReleaseReviewRequest,
  inspectReleaseReviewRequest,
  inspectReleaseReviewDisposition,
  advanceReleaseReviewRecovery,
} from "./release-review-request.mts";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import {
  readIndependentSemanticDisposition,
  createReleaseReviewDispositionReceipt,
} from "./release-semantic-disposition-reader.mts";
import { prepareNegativeSemanticDispositionCheck } from "./release-semantic-disposition.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "journal.git");
  execFileSync("git", ["-c", "core.fsmonitor=false", "init", "--bare", "--quiet", repository], {
    timeout: 10000,
    windowsHide: true,
  });
  const oracle: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-coordinator-legacy.json", import.meta.url), "utf8"),
  );
  assert.ok(
    isRecord(oracle) &&
      Array.isArray(oracle.rows) &&
      isRecord(oracle.rows[0]) &&
      isRecord(oracle.rows[0].input),
  );
  const input = structuredClone(oracle.rows[0].input);
  input.schema_version = 2;
  input.controller = {
    workflow: ".github/workflows/application-update-production.yml",
    revision: "3".repeat(40),
    publication_paused: false,
    capacity_attempt: { ...capacityFixture(), schema_version: 2 },
  };
  assert.ok(isRecord(input.opportunity) && isRecord(input.opportunity.classification));
  const opportunity = input.opportunity;
  assert.ok(isRecord(opportunity.classification));
  const first = await checkpointReleaseOpportunity(repository, null, input);
  const request = createReleaseReviewRequest({
    before_checkpoint: first.checkpoint,
    requested_at: String(input.now),
    base_commit: String(opportunity.base_commit),
    base_version: String(opportunity.classification.base_version),
    source_commit: String(opportunity.source_commit),
    source_tree: String(opportunity.source_tree),
    change_set_sha256: String(opportunity.change_set_sha256),
  });
  return { directory, repository, input, request, first };
}

function negativeReceipt(
  request: NonNullable<ReturnType<typeof inspectReleaseReviewRequest>>,
  checkpoint: string,
  previous: unknown,
) {
  const f = negativeSemanticDispositionFixture();
  const wire = {
    ...f,
    request,
    request_id: request.request_id,
    stage: "classification-proposal",
    disposition: "refused",
    opportunity: null,
    opportunity_sha256: null,
    review: {
      ...f.review,
      completed_at: request.requested_at.replace(/\.\d{3}Z$/u, "Z"),
      scope: "release-classification-proposal",
      coverage: null,
    },
  };
  const serialized = prepareNegativeSemanticDispositionCheck(wire);
  const observed = readIndependentSemanticDisposition(
    {
      request(method, endpoint) {
        assert.equal(method, "GET");
        assert.ok(
          ["repos/boburning/portcove", "repos/boburning/portcove/check-runs/99"].includes(endpoint),
        );
        return {
          status: 200,
          headers: new Map<string, string>(),
          body:
            endpoint === "repos/boburning/portcove"
              ? { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" }
              : {
                  ...serialized.proposed_request.body,
                  id: 99,
                  app: { id: 123 },
                  output: { ...serialized.proposed_request.body.output, annotations_count: 0 },
                },
        };
      },
    },
    {
      schema_version: 1,
      review_app_id: 123,
      writer_app_id: 456,
      review_check_name: semanticReviewCheckName,
    },
    request,
    99,
  );
  return createReleaseReviewDispositionReceipt(observed, checkpoint, previous);
}

void test("paused safety withdrawal clears only the exact request and refuses its reuse", async (t) => {
  const f = await fixture(t);
  const state = { ...f.input, review_request: f.request };
  const controller = f.input.controller;
  assert.ok(isRecord(controller));
  const saved = await checkpointReleaseOpportunity(f.repository, f.first.checkpoint, state);
  const withdrawal = {
    schema_version: 1,
    kind: "application-review-safety-withdrawal",
    request_id: f.request.request_id,
    source_commit: f.request.source_commit,
    source_tree: f.request.source_tree,
    request_checkpoint: saved.checkpoint,
    approval_sha256: "1".repeat(64),
    technical_stop_sha256: "2".repeat(64),
  };
  const {
    appendRetainedReviewWithdrawal,
    inspectReleaseReviewWithdrawal,
    matchesRetainedReviewWithdrawal,
  } = await import("./release-review-withdrawal.mts");
  const inspected = inspectReleaseReviewWithdrawal(withdrawal);
  assert.ok(inspected);
  assert.equal(matchesRetainedReviewWithdrawal(inspected, state), false);
  assert.equal(matchesRetainedReviewWithdrawal(inspected, { review_request: null }), false);
  const next = {
    ...state,
    controller: { ...controller, publication_paused: true },
    review_request: null,
    review_withdrawal: withdrawal,
  };
  assert.equal(matchesRetainedReviewWithdrawal(inspected, next), true);
  assert.equal(
    matchesRetainedReviewWithdrawal(inspected, { ...next, review_request: f.request }),
    false,
  );
  assert.equal(
    matchesRetainedReviewWithdrawal(inspected, {
      ...next,
      review_withdrawal: { ...withdrawal, approval_sha256: "3".repeat(64) },
    }),
    false,
  );
  for (const changed of [
    { ...next, controller: controller },
    { ...next, opportunity: null },
    { ...next, review_withdrawal: { ...withdrawal, request_checkpoint: f.first.checkpoint } },
    { ...next, review_withdrawal: { ...withdrawal, authority: "semantic-review" } },
  ]) {
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, saved.checkpoint, changed),
      /withdrawal|cannot erase an existing semantic opportunity/,
    );
  }
  const emptyRepository = path.join(f.directory, "fresh.git");
  execFileSync("git", ["init", "--bare", "--quiet", emptyRepository], { timeout: 10000 });
  await assert.rejects(
    checkpointReleaseOpportunity(emptyRepository, null, next),
    /first coordinator/,
  );
  const retired = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, next);
  const recovered = await recoverReleaseOpportunity(f.repository, retired.checkpoint);
  assert.deepEqual(recovered.input, next);
  assert.equal(recovered.plan.action, "pause");
  const repeated = createReleaseReviewRequest({
    base_commit: f.request.base_commit,
    base_version: f.request.base_version,
    source_commit: f.request.source_commit,
    source_tree: f.request.source_tree,
    change_set_sha256: f.request.change_set_sha256,
    before_checkpoint: retired.checkpoint,
    requested_at: String(f.input.now),
  });
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, retired.checkpoint, {
      ...next,
      review_request: repeated,
    }),
    /withdrawn application source/,
  );
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, retired.checkpoint, {
      ...next,
      review_withdrawal: null,
    }),
    /withdrawal/,
  );
  const successor = createReleaseReviewRequest({
    base_commit: f.request.base_commit,
    base_version: f.request.base_version,
    source_commit: "e".repeat(40),
    source_tree: "f".repeat(40),
    change_set_sha256: "e".repeat(64),
    before_checkpoint: retired.checkpoint,
    requested_at: String(f.input.now),
  });
  const followup = await checkpointReleaseOpportunity(f.repository, retired.checkpoint, {
    ...next,
    review_request: successor,
  });
  const accepted = await recoverReleaseOpportunity(f.repository, followup.checkpoint);
  assert.deepEqual(accepted.input.review_withdrawal, withdrawal);
  assert.deepEqual(accepted.input.review_request, successor);
  const second = inspectReleaseReviewWithdrawal({
    ...withdrawal,
    request_id: successor.request_id,
    source_commit: successor.source_commit,
    source_tree: successor.source_tree,
    request_checkpoint: followup.checkpoint,
    approval_sha256: "3".repeat(64),
  });
  assert.ok(second);
  const secondWithdrawal = {
    ...accepted.input,
    review_request: null,
    review_withdrawal: appendRetainedReviewWithdrawal(accepted.input.review_withdrawal, second),
  };
  for (const changed of [
    second,
    [second, withdrawal],
    [{ ...withdrawal, approval_sha256: "4".repeat(64) }, second],
    [withdrawal, second, second],
  ])
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, followup.checkpoint, {
        ...secondWithdrawal,
        review_withdrawal: changed,
      }),
      /withdrawal/,
    );
  const settled = await checkpointReleaseOpportunity(
    f.repository,
    followup.checkpoint,
    secondWithdrawal,
  );
  const retained = await recoverReleaseOpportunity(f.repository, settled.checkpoint);
  assert.deepEqual(retained.input.review_withdrawal, [withdrawal, second]);
  assert.equal(matchesRetainedReviewWithdrawal(second, retained.input), true);
  assert.equal(matchesRetainedReviewWithdrawal(inspected, retained.input), true);
  for (const withdrawn of [f.request, successor])
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, settled.checkpoint, {
        ...retained.input,
        review_request: createReleaseReviewRequest({
          base_commit: withdrawn.base_commit,
          base_version: withdrawn.base_version,
          source_commit: withdrawn.source_commit,
          source_tree: withdrawn.source_tree,
          change_set_sha256: withdrawn.change_set_sha256,
          before_checkpoint: settled.checkpoint,
          requested_at: String(f.input.now),
        }),
      }),
      /withdrawn application source/,
    );
});

void test(
  "negative Check custody retires only exact request, preserves opportunity, and bounds changed-source repairs in portable journal",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    let state: Record<string, unknown> = { ...f.input, review_request: f.request };
    let saved = await checkpointReleaseOpportunity(f.repository, f.first.checkpoint, state);
    const originalOpportunity = structuredClone(state.opportunity);
    const originalTree = f.request.source_tree;
    for (let count = 0; count <= 3; count++) {
      const request = inspectReleaseReviewRequest(state.review_request)!;
      const disposition = negativeReceipt(request, saved.checkpoint, state.review_disposition);
      assert.equal(disposition.substantive_repairs, count);
      assert.equal(disposition.prior_requests.length, count);
      const next = { ...state, review_request: null, review_disposition: disposition };
      for (const bad of [
        { ...next, review_disposition: { ...disposition, request_checkpoint: "f".repeat(40) } },
        {
          ...next,
          review_disposition: { ...disposition, substantive_repairs: count === 0 ? 1 : 0 },
        },
        {
          ...next,
          opportunity: { ...(isRecord(state.opportunity) ? state.opportunity : {}), urgency: true },
        },
      ])
        await assert.rejects(
          checkpointReleaseOpportunity(f.repository, saved.checkpoint, bad),
          /negative retirement/,
        );
      saved = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, next);
      state = next;
      assert.deepEqual(state.opportunity, originalOpportunity);
      const nextRequest = createReleaseReviewRequest({
        before_checkpoint: saved.checkpoint,
        requested_at: new Date(Date.parse(String(state.now)) + 1000).toISOString(),
        base_commit: request.base_commit,
        base_version: request.base_version,
        source_commit: (count + 3).toString(16).repeat(40),
        source_tree: (count + 7).toString(16).repeat(40),
        change_set_sha256: (count + 9).toString(16).repeat(64),
      });
      const repeated = createReleaseReviewRequest({
        before_checkpoint: saved.checkpoint,
        source_commit: "e".repeat(40),
        source_tree: originalTree,
        change_set_sha256: "e".repeat(64),
        requested_at: nextRequest.requested_at,
        base_commit: request.base_commit,
        base_version: request.base_version,
      });
      assert.throws(
        () => advanceReleaseReviewRecovery(disposition, repeated, state.publication),
        /changed source\/tree/,
      );
      if (count === 3) {
        assert.throws(
          () => advanceReleaseReviewRecovery(disposition, nextRequest, state.publication),
          /exhausted/,
        );
        break;
      }
      const advanced = advanceReleaseReviewRecovery(disposition, nextRequest, state.publication);
      const nextInput = {
        ...state,
        now: nextRequest.requested_at,
        review_request: nextRequest,
        review_disposition: advanced,
      };
      await assert.rejects(
        checkpointReleaseOpportunity(f.repository, saved.checkpoint, {
          ...nextInput,
          review_disposition: null,
        }),
        /cannot be dropped or reset/,
      );
      saved = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, nextInput);
      state = nextInput;
    }
    const disposition = inspectReleaseReviewDisposition(state.review_disposition)!;
    const recovery = await recoverReleaseOpportunity(f.repository, saved.checkpoint);
    assert.deepEqual(recovery.input.review_disposition, disposition);
    assert.equal(Object.hasOwn(disposition, "report"), false);
    const exported = await exportCoordinatorCheckpoint(f.repository, saved.checkpoint);
    const objects = new Map<
      string,
      { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }
    >();
    const git = (args: string[]) =>
      execFileSync("git", ["-C", f.repository, "-c", "core.fsmonitor=false", ...args], {
        timeout: 10000,
        windowsHide: true,
      });
    for (const commit of [saved.checkpoint, exported.previous!]) {
      const tree = git(["rev-parse", `${commit}^{tree}`])
        .toString()
        .trim();
      const blob = git(["rev-parse", `${commit}:state.json`])
        .toString()
        .trim();
      for (const [kind, oid] of [
        ["commit", commit],
        ["tree", tree],
        ["blob", blob],
      ] as const)
        objects.set(oid, { kind, oid, bytes: git(["cat-file", kind, oid]) });
    }
    const fresh = path.join(f.directory, "negative-fresh.git");
    execFileSync("git", ["init", "--bare", "--quiet", fresh], {
      timeout: 10000,
      windowsHide: true,
    });
    await importCoordinatorCheckpoint(fresh, saved.checkpoint, [...objects.values()]);
    assert.throws(() =>
      execFileSync("git", ["-C", fresh, "cat-file", "-e", f.first.checkpoint], {
        timeout: 10000,
        windowsHide: true,
        stdio: "pipe",
      }),
    );
    assert.deepEqual(
      (await recoverReleaseOpportunity(fresh, saved.checkpoint)).input.review_disposition,
      disposition,
    );
  },
);

void test("negative receipt cannot be initially manufactured, dropped, or reset without higher complete published baseline", async (t) => {
  const f = await fixture(t);
  const disposition = negativeReceipt(f.request, f.first.checkpoint, null);
  const fresh = path.join(f.directory, "negative-invalid.git");
  execFileSync("git", ["init", "--bare", "--quiet", fresh], { timeout: 10000, windowsHide: true });
  await assert.rejects(
    checkpointReleaseOpportunity(fresh, null, { ...f.input, review_disposition: disposition }),
    /first coordinator/,
  );
  const request = createReleaseReviewRequest({
    before_checkpoint: f.first.checkpoint,
    requested_at: f.request.requested_at,
    base_commit: f.request.base_commit,
    base_version: "0.1.0-alpha.3",
    source_commit: "4".repeat(40),
    source_tree: "5".repeat(40),
    change_set_sha256: "6".repeat(64),
  });
  assert.throws(
    () =>
      advanceReleaseReviewRecovery(
        { ...disposition, substantive_repairs: 3 },
        request,
        f.input.publication,
      ),
    /published baseline advance/,
  );
  const advanced = advanceReleaseReviewRecovery(
    { ...disposition, substantive_repairs: 3 },
    request,
    { complete: true, published_versions: ["0.1.0-alpha.2", "0.1.0-alpha.3"] },
  );
  assert.equal(advanced?.substantive_repairs, 0);
  assert.deepEqual(advanced?.request, disposition.request);
  assert.throws(
    () => inspectReleaseReviewDisposition({ ...disposition, prior_requests: Array(4).fill({}) }),
    /bound/,
  );
});

void test("frozen neutral request is retained in actual journal and sparse export without semantic acceptance", async (t) => {
  const f = await fixture(t);
  const input: Record<string, unknown> = { ...f.input, review_request: f.request };
  const saved = await checkpointReleaseOpportunity(f.repository, f.first.checkpoint, input);
  const later = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, {
    ...input,
    now: new Date(Date.parse(String(input.now)) + 1000).toISOString(),
  });
  const exported = await exportCoordinatorCheckpoint(f.repository, later.checkpoint);
  assert.equal(exported.previous, saved.checkpoint);
  const objects = new Map<
    string,
    { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }
  >();
  const git = (args: string[]) =>
    execFileSync("git", ["-C", f.repository, "-c", "core.fsmonitor=false", ...args], {
      timeout: 10000,
      windowsHide: true,
      stdio: "pipe",
    });
  for (const commit of [later.checkpoint, saved.checkpoint]) {
    const tree = git(["rev-parse", `${commit}^{tree}`])
      .toString()
      .trim();
    const blob = git(["rev-parse", `${commit}:state.json`])
      .toString()
      .trim();
    for (const [kind, oid] of [
      ["commit", commit],
      ["tree", tree],
      ["blob", blob],
    ] as const)
      objects.set(oid, { kind, oid, bytes: git(["cat-file", kind, oid]) });
  }
  const fresh = path.join(f.directory, "fresh.git");
  execFileSync("git", ["init", "--bare", "--quiet", fresh], { timeout: 10000, windowsHide: true });
  await importCoordinatorCheckpoint(fresh, later.checkpoint, [...objects.values()]);
  assert.throws(() =>
    execFileSync("git", ["-C", fresh, "cat-file", "-e", f.first.checkpoint], {
      timeout: 10000,
      windowsHide: true,
      stdio: "pipe",
    }),
  );
  const restored = await recoverReleaseOpportunity(fresh, later.checkpoint);
  assert.deepEqual(restored.input.review_request, f.request);
  assert.equal(Object.hasOwn(f.request, "classification"), false);
  assert.equal(Object.hasOwn(f.request, "accepted"), false);
  const changed = { ...f.request, requested_at: "2026-10-20T00:00:00.000Z" };
  const { request_id: _old, ...identity } = changed;
  void _old;
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, later.checkpoint, {
      ...input,
      review_request: { ...changed, request_id: capacityDigest(identity) },
    }),
    /replaced or retimed/,
  );
});

void test("request consumption binds full accepted opportunity and never permits initial manufacture", async (t) => {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.first.checkpoint, {
    ...f.input,
    review_request: f.request,
  });
  const next = structuredClone(f.input);
  next.review_request = null;
  assert.ok(isRecord(next.opportunity) && isRecord(next.opportunity.classification));
  next.opportunity.classification.change_set_scope = f.request.change_set_scope;
  const wrong = structuredClone(next);
  assert.ok(isRecord(wrong.opportunity));
  wrong.opportunity.base_commit = "9".repeat(40);
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, saved.checkpoint, wrong),
    /exact independently accepted opportunity/,
  );
  const consumed = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, next);
  assert.equal(
    (await recoverReleaseOpportunity(f.repository, consumed.checkpoint)).input.review_request,
    null,
  );
  assert.throws(() => inspectReleaseReviewRequest({ ...f.request, accepted: true }), /schema/);
  const fresh = path.join(f.directory, "invalid-first.git");
  execFileSync("git", ["init", "--bare", "--quiet", fresh], { timeout: 10000, windowsHide: true });
  await assert.rejects(
    checkpointReleaseOpportunity(fresh, null, { ...f.input, review_request: f.request }),
    /first coordinator/,
  );
});
