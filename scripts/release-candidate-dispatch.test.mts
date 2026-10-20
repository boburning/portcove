import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchPreparedReleaseCandidate,
  readPreparedReleaseCandidate,
  discoverPreparedReleaseCandidate,
} from "./release-candidate-dispatch.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";

const input = {
  version: "0.19.0-preview.1",
  prepared_commit: "a".repeat(40),
  remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
  dispatch_actor_id: "1234",
};
function provider(mode = "success") {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (raw, init) => {
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    const method = init?.method ?? "GET";
    assert.ok(init?.body === undefined || typeof init.body === "string");
    const body: unknown = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2026-03-10");
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/release.yml"))
      return Response.json({ id: 999, path: ".github/workflows/release.yml", state: "active" });
    if (url.endsWith("/dispatches")) {
      if (mode === "lost") throw new Error("credential-super-secret must not escape");
      if (mode === "legacy") return new Response(null, { status: 204 });
      return Response.json({
        workflow_run_id: 42,
        run_url: "https://api.github.com/repos/boburning/portcove/actions/runs/42",
        html_url: "https://github.com/boburning/portcove/actions/runs/42",
      });
    }
    assert.equal(url, "https://api.github.com/repos/boburning/portcove/actions/runs/42");
    return Response.json({
      id: 42,
      workflow_id: 999,
      path: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      run_attempt: mode === "attempt" ? 2 : 1,
      head_sha: mode === "source" ? "b".repeat(40) : input.prepared_commit,
      head_branch: "portcove-fixture-prepared/v0.19.0-preview.1",
      repository: { id: 1354613114, full_name: "boburning/portcove" },
      actor: { id: mode === "actor" ? 555 : 1234 },
      triggering_actor: { id: 1234 },
      status: "queued",
    });
  };
  return { calls, transport };
}
void test("one immutable prepared tag dispatch binds documented acknowledgment and exact run readback", async () => {
  const fixture = provider();
  let guard = 0;
  const result = await dispatchPreparedReleaseCandidate(
    input,
    "credential-super-secret",
    async () => {
      assert.equal(fixture.calls.length, 1);
      guard++;
    },
    fixture.transport,
  );
  assert.equal(guard, 1);
  assert.equal(result.remote_identity, "github-actions:boburning/portcove:run:42:attempt:1");
  assert.equal(result.evidence.ref, "refs/tags/portcove-fixture-prepared/v0.19.0-preview.1");
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(fixture.calls[1]?.body, {
    ref: "portcove-fixture-prepared/v0.19.0-preview.1",
    inputs: { release_profile: "initial-beta-win-linux" },
  });
});
void test("dispatch never retries lost acknowledgment, unsupported status or mismatched actual run", async () => {
  for (const mode of ["lost", "legacy", "attempt", "source", "actor"]) {
    const fixture = provider(mode);
    await assert.rejects(
      dispatchPreparedReleaseCandidate(
        input,
        "credential-super-secret",
        async () => {},
        fixture.transport,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.equal(error.evidence.mutation_attempted, true);
        assert.equal(JSON.stringify(error).includes("credential-super-secret"), false);
        return true;
      },
    );
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  }
});
void test("late control refusal performs zero POST and reports refusal before effect", async () => {
  const fixture = provider();
  await assert.rejects(
    dispatchPreparedReleaseCandidate(
      input,
      "credential-super-secret",
      async () => {
        throw new Error("expired observation");
      },
      fixture.transport,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      assert.equal(error.evidence.mutation_attempted, false);
      return true;
    },
  );
  assert.equal(fixture.calls.length, 1);
});

void test("exact retained run continuation repeats only GET and reproduces original receipt", async () => {
  const first = provider();
  const original = await dispatchPreparedReleaseCandidate(
    input,
    "secret",
    async () => {},
    first.transport,
  );
  const continuation = provider();
  const observed = await readPreparedReleaseCandidate(input, 42, "secret", continuation.transport);
  assert.equal(observed.evidence_sha256, original.evidence_sha256);
  assert.equal(observed.remote_identity, original.remote_identity);
  assert.deepEqual(
    continuation.calls.map((call) => call.method),
    ["GET", "GET"],
  );
});

function recoveryProvider(mode: string) {
  const fallback = provider();
  const calls: string[] = [];
  let firstReads = 0;
  const row = (index: number) => ({
    id: index === 0 ? 42 : 1000 + index,
    workflow_id: 999,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    run_attempt: 1,
    head_sha: input.prepared_commit,
    head_branch:
      index === 0 || mode === "ambiguous"
        ? "portcove-fixture-prepared/v0.19.0-preview.1"
        : "other-prepared-tag",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    actor: { id: index === 0 || mode === "ambiguous" ? 1234 : 5678 },
  });
  const transport: typeof fetch = async (raw, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    calls.push(url);
    if (!url.includes("/release.yml/runs?")) return fallback.transport(raw, init);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("head_sha"), input.prepared_commit);
    assert.equal(parsed.searchParams.get("event"), "workflow_dispatch");
    const page = Number(parsed.searchParams.get("page"));
    if (page === 1) firstReads++;
    const total = mode === "empty" ? 0 : mode === "ceiling" ? 1000 : mode === "ambiguous" ? 2 : 101;
    const rows = Array.from(
      { length: Math.max(0, Math.min(100, total - (page - 1) * 100)) },
      (_, offset) => row((page - 1) * 100 + offset),
    );
    if (mode === "duplicate" && page === 2) rows[0] = row(0);
    if (mode === "omitted" && page === 2) rows.pop();
    if (mode === "drift" && page === 1 && firstReads > 1)
      rows[0] = { ...row(0), actor: { id: 9999 } };
    return Response.json({ total_count: total, workflow_runs: rows });
  };
  return { transport, calls, firstReads: () => firstReads };
}
void test("lost dispatch response discovers one exact run across 101 records and brackets the first page without POST", async () => {
  const f = recoveryProvider("valid");
  const observed = await discoverPreparedReleaseCandidate(input, "secret", f.transport);
  assert.equal(observed.evidence.run_id, 42);
  assert.equal(f.firstReads(), 2);
  assert.ok(f.calls.some((url) => url.endsWith("&page=2")));
  const direct = provider();
  assert.equal(
    observed.evidence_sha256,
    (await readPreparedReleaseCandidate(input, 42, "secret", direct.transport)).evidence_sha256,
  );
});
void test("absent, ambiguous, duplicate, omitted, drifted and ceiling dispatch inventories stay unknown with zero POST", async () => {
  for (const mode of ["empty", "ambiguous", "duplicate", "omitted", "drift", "ceiling"]) {
    const f = recoveryProvider(mode);
    await assert.rejects(
      discoverPreparedReleaseCandidate(input, "secret", f.transport),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.equal(error.evidence.mutation_attempted, false);
        return true;
      },
    );
    assert.ok(f.calls.length <= 5);
  }
});
