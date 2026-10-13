import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, consumedTransfer } from "./cleanup-intel-artifacts.mjs";

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

test("both successful Intel consumers permit deletion, including reusable calls", () => {
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
test("active, failed, missing, ambiguous, changed-attempt and foreign evidence is preserved", () => {
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
test("dry run never deletes; apply checks identity and verifies deletion", () => {
  let deleted = false;
  const api = {
    paginateRest: (endpoint) => (endpoint.includes("/jobs?") ? jobs : [artifact]),
    request: (method, endpoint) => {
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
test("incomplete pagination and a concurrently restarted run block deletion", () => {
  const incomplete = {
    paginateRest: () => {
      throw new Error("incomplete");
    },
  };
  assert.throws(() => cleanup(incomplete, { apply: true }), /incomplete/u);
  let reads = 0;
  const api = {
    paginateRest: (endpoint) => (endpoint.includes("/jobs?") ? jobs : [artifact]),
    request: (method, endpoint) => {
      assert.notEqual(method, "DELETE");
      if (endpoint.endsWith("/runs/20"))
        return { body: ++reads === 1 ? run : { ...run, status: "in_progress" } };
      return { body: artifact };
    },
  };
  assert.throws(() => cleanup(api, { apply: true }), /changed/u);
});
