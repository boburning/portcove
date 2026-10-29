import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, consumedTransfer, parseCleanupArgs } from "./cleanup-intel-artifacts.mts";

const artifact = { id: 10, name: "intel-rust-tests-1", expired: false, workflow_run: { id: 20 } };
const run = {
  id: 20,
  run_attempt: 1,
  status: "completed",
  repository: { full_name: "boburning/portcove" },
};
const jobs = [
  "build-intel-tests",
  "native-rust (macos-x86_64, hash:1/2)",
  "native-rust (macos-x86_64, hash:2/2)",
].map((name, index) => ({
  name,
  id: index + 1,
  run_id: 20,
  status: "completed",
  conclusion: "success",
}));

void test("both successful Intel consumers permit deletion, including reusable calls", () => {
  assert.equal(consumedTransfer(artifact, run, jobs), true);
  assert.equal(
    consumedTransfer(
      artifact,
      run,
      jobs.map((job) => ({ ...job, name: `qualify / ${job.name}` })),
    ),
    true,
  );
});
void test("active, failed, missing, ambiguous, changed-attempt and foreign evidence is preserved", () => {
  for (const changed of [
    { ...run, status: "in_progress" },
    { ...run, run_attempt: 2 },
    { ...run, repository: { full_name: "other/repo" } },
  ])
    assert.equal(consumedTransfer(artifact, changed, jobs), false);
  for (const changed of [
    jobs.slice(0, 2),
    [...jobs, jobs[0]],
    jobs.map((job, index) => (index === 2 ? { ...job, conclusion: "failure" } : job)),
  ])
    assert.equal(consumedTransfer(artifact, run, changed), false);
  assert.equal(consumedTransfer({ ...artifact, name: "release-payload" }, run, jobs), false);
});
void test("dry run never deletes; apply checks identity and verifies deletion", () => {
  let deleted = false;
  const api = {
    paginateRest: (endpoint: string) => (endpoint.includes("/jobs?") ? jobs : [artifact]),
    request: (method: string, endpoint: string) => {
      if (method === "DELETE") {
        deleted = true;
        return { body: null };
      }
      if (endpoint.endsWith("/runs/20")) return { body: run };
      if (deleted) throw Object.assign(new Error("not found"), { status: 404 });
      return { body: artifact };
    },
  };
  assert.deepEqual(cleanup(api, { runId: 20 }).eligible, [10]);
  assert.equal(deleted, false);
  assert.deepEqual(cleanup(api, { apply: true, runId: 20 }).deleted, [10]);
});
void test("incomplete pagination and a concurrently restarted run block deletion", () => {
  const incomplete = {
    request: () => assert.fail("Incomplete pagination must abort before provider requests"),
    paginateRest: () => {
      throw new Error("incomplete");
    },
  };
  assert.throws(() => cleanup(incomplete, { apply: true, runId: 20 }), /incomplete/u);
  let reads = 0;
  const api = {
    paginateRest: (endpoint: string) => (endpoint.includes("/jobs?") ? jobs : [artifact]),
    request: (method: string, endpoint: string) => {
      assert.notEqual(method, "DELETE");
      if (endpoint.endsWith("/runs/20"))
        return { body: ++reads === 1 ? run : { ...run, status: "in_progress" } };
      return { body: artifact };
    },
  };
  assert.throws(() => cleanup(api, { apply: true, runId: 20 }), /changed/u);
});

void test("unknown artifact expiry cannot authorize cleanup", () => {
  for (const expired of [undefined, null, 0, "false", true]) {
    const candidate = { ...artifact, expired };
    assert.equal(consumedTransfer(candidate, run, jobs), false);
    let deletions = 0;
    const api = {
      paginateRest: (endpoint: string) => (endpoint.includes("/jobs?") ? jobs : [candidate]),
      request: (method: string) => {
        if (method === "DELETE") deletions++;
        return { body: run };
      },
    };
    const result = cleanup(api, { apply: true, runId: 20 });
    assert.equal(deletions, 0);
    assert.deepEqual(result.eligible, []);
    assert.equal(result.preserved, 1);
  }
});
void test("uncertain deletion is not retried and readable artifacts retain the original provider failure", () => {
  for (const failure of [
    new Error("provider failure"),
    null,
    undefined,
    0,
    false,
    "original failure",
  ]) {
    let deletions = 0,
      readbacks = 0;
    const api = {
      paginateRest: (endpoint: string) => (endpoint.includes("/jobs?") ? jobs : [artifact]),
      request: (method: string, endpoint: string) => {
        if (method === "DELETE") {
          deletions++;
          // Deliberately malformed provider rejections must keep their exact identity.
          // oxlint-disable-next-line typescript/only-throw-error
          throw failure;
        }
        if (endpoint.endsWith("/runs/20")) return { body: run };
        if (deletions) readbacks++;
        return { body: artifact };
      },
    };
    assert.throws(
      () => cleanup(api, { apply: true, runId: 20 }),
      (error: unknown) => error === failure,
    );
    assert.equal(deletions, 1);
    assert.equal(readbacks, 1);
  }
});

void test("completion event enumerates only its run and ignores unrelated artifacts", () => {
  const calls: string[] = [];
  let deletions = 0;
  const api = {
    paginateRest: (endpoint: string) => {
      calls.push(endpoint);
      return endpoint.includes("/jobs?")
        ? jobs
        : [{ ...artifact, id: 11, name: "other" }, artifact];
    },
    request: (method: string, endpoint: string) => {
      if (method === "DELETE") deletions++;
      return { body: endpoint.endsWith("/runs/20") ? run : artifact };
    },
  };
  assert.deepEqual(cleanup(api, { runId: 20 }).eligible, [10]);
  assert.equal(deletions, 0);
  assert.equal(calls[0], "repos/boburning/portcove/actions/runs/20/artifacts?per_page=100");
  assert.equal(calls[1], "repos/boburning/portcove/actions/runs/20/attempts/1/jobs?per_page=100");
  assert.equal(calls.length, 2);
});

void test("hourly recovery enumerates exact names, never the entire repository inventory", () => {
  const calls: string[] = [];
  const api = {
    paginateRest: (endpoint: string) => {
      calls.push(endpoint);
      if (endpoint.includes("/jobs?")) return jobs;
      return endpoint.includes("name=intel-rust-tests-1&") ? [artifact] : [];
    },
    request: (_method: string, endpoint: string) => ({
      body: endpoint.endsWith("/runs/20") ? run : artifact,
    }),
  };
  assert.deepEqual(cleanup(api).eligible, [10]);
  assert.deepEqual(
    calls.slice(0, 4),
    [1, 2, 3, 4].map(
      (attempt) =>
        `repos/boburning/portcove/actions/artifacts?name=intel-rust-tests-${attempt}&per_page=100`,
    ),
  );
  assert.equal(calls.length, 5);
});

void test("an exact run supports arbitrary higher attempts without requiring a broad scan", () => {
  const attempt = 27;
  const candidate = { ...artifact, name: `intel-rust-tests-${attempt}` };
  const runAtAttempt = { ...run, run_attempt: attempt };
  const calls: string[] = [];
  const api = {
    paginateRest: (endpoint: string) => {
      calls.push(endpoint);
      return endpoint.includes("/jobs?") ? jobs : [candidate];
    },
    request: (_method: string, endpoint: string) => ({
      body: endpoint.endsWith("/runs/20") ? runAtAttempt : candidate,
    }),
  };
  assert.deepEqual(cleanup(api, { runId: 20 }).eligible, [10]);
  assert.equal(calls.length, 2);
});

void test("a foreign artifact, duplicate sweep inventory or invalid run ID fails before deletion", () => {
  let effects = 0;
  const foreign = {
    paginateRest: () => [{ ...artifact, workflow_run: { id: 99 } }],
    request: () => {
      effects++;
      return { body: run };
    },
  };
  assert.throws(() => cleanup(foreign, { apply: true, runId: 20 }), /selected run/u);
  assert.equal(effects, 0);
  const duplicates = {
    paginateRest: () => [artifact],
    request: () => {
      effects++;
      return { body: run };
    },
  };
  assert.throws(() => cleanup(duplicates, { apply: true }), /duplicate artifact/u);
  assert.equal(effects, 0);
  assert.throws(() => cleanup(duplicates, { runId: Number.NaN }), /positive safe/u);
  assert.throws(() => cleanup(duplicates, { runId: 0 }), /positive safe/u);
  assert.equal(effects, 0);
});

void test("CLI accepts only valid exact run IDs and explicit apply", () => {
  assert.deepEqual(parseCleanupArgs([]), { apply: false, runId: null });
  assert.deepEqual(parseCleanupArgs(["--apply", "--run-id", "20"]), { apply: true, runId: 20 });
  assert.deepEqual(parseCleanupArgs(["--run-id", "27"]), { apply: false, runId: 27 });
  for (const args of [
    ["--run-id"],
    ["--run-id", "0"],
    ["--run-id", "-1"],
    ["--run-id", "1e3"],
    ["--run-id", "9007199254740992"],
    ["--run-id", "1", "--run-id", "2"],
    ["--apply", "--apply"],
    ["--unknown"],
  ])
    assert.throws(() => parseCleanupArgs(args));
});
