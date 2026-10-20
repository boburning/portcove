import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReleaseReviewRequest,
  inspectReleaseReviewRequest,
} from "./release-review-request.mts";
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
