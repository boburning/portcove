import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, consumedTransfer } from "./cleanup-intel-artifacts.mts";

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
  assert.deepEqual(cleanup(api).eligible, [10]);
  assert.equal(deleted, false);
  assert.deepEqual(cleanup(api, { apply: true }).deleted, [10]);
});
void test("incomplete pagination and a concurrently restarted run block deletion", () => {
  const incomplete = {
    request: () => assert.fail("Incomplete pagination must abort before provider requests"),
    paginateRest: () => {
      throw new Error("incomplete");
    },
  };
  assert.throws(() => cleanup(incomplete, { apply: true }), /incomplete/u);
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
  assert.throws(() => cleanup(api, { apply: true }), /changed/u);
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
    const result = cleanup(api, { apply: true });
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
      () => cleanup(api, { apply: true }),
      (error: unknown) => error === failure,
    );
    assert.equal(deletions, 1);
    assert.equal(readbacks, 1);
  }
});
