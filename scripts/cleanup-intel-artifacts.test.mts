import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanup,
  consumedTransfer,
  parseCleanupArgs,
  createCleanupOperations,
} from "./cleanup-intel-artifacts.mts";

import type { CleanupOperations } from "./cleanup-intel-artifacts.mts";

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
function operations(overrides: Partial<CleanupOperations> = {}): CleanupOperations {
  return {
    artifacts: async () => [artifact],
    jobs: async () => jobs,
    run: async () => run,
    artifact: async () => artifact,
    removeArtifact: async () => assert.fail("Unexpected deletion"),
    ...overrides,
  };
}
void test("dry run never deletes; apply checks identity and verifies deletion", async () => {
  let deleted = false;
  const api = operations({
    removeArtifact: async () => {
      deleted = true;
    },
    artifact: async () => {
      if (deleted) throw Object.assign(new Error("not found"), { status: 404 });
      return artifact;
    },
  });
  assert.deepEqual((await cleanup(api, { runId: 20 })).eligible, [10]);
  assert.equal(deleted, false);
  assert.deepEqual((await cleanup(api, { apply: true, runId: 20 })).deleted, [10]);
});
void test("incomplete inventory and a concurrently restarted run block deletion", async () => {
  const incomplete = operations({
    artifacts: async () => {
      throw new Error("incomplete");
    },
    run: async () => assert.fail("Incomplete inventory must stop before run read"),
  });
  await assert.rejects(cleanup(incomplete, { apply: true, runId: 20 }), /incomplete/u);
  let reads = 0;
  const api = operations({ run: async () => ({ ...run, run_attempt: ++reads === 1 ? 1 : 2 }) });
  await assert.rejects(cleanup(api, { apply: true, runId: 20 }), /changed/u);
});
void test("unknown artifact expiry cannot authorize cleanup", async () => {
  for (const expired of [undefined, null, "false", 0]) {
    const result = await cleanup(
      operations({ artifacts: async () => [{ ...artifact, expired }] }),
      { apply: true, runId: 20 },
    );
    assert.deepEqual(result.deleted, []);
    assert.equal(result.preserved, 1);
  }
});
void test("uncertain deletion is not retried and readable readback retains exact failure", async () => {
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
    const api = operations({
      removeArtifact: async () => {
        deletions++;
        // Preserve deliberately malformed provider rejection identity.
        // oxlint-disable-next-line typescript/only-throw-error
        throw failure;
      },
      artifact: async () => {
        if (deletions) readbacks++;
        return artifact;
      },
    });
    await assert.rejects(
      cleanup(api, { apply: true, runId: 20 }),
      (error: unknown) => error === failure,
    );
    assert.equal(deletions, 1);
    assert.equal(readbacks, 1);
  }
});
void test("completion event enumerates only its exact run and higher attempts", async () => {
  for (const attempt of [1, 27]) {
    const scopes: unknown[] = [],
      selectedJobs: unknown[] = [];
    const candidate = { ...artifact, name: `intel-rust-tests-${attempt}` };
    const api = operations({
      artifacts: async (scope) => {
        scopes.push(scope);
        return [{ ...artifact, id: 11, name: "other" }, candidate];
      },
      jobs: async (id, number) => {
        selectedJobs.push([id, number]);
        return jobs;
      },
      run: async () => ({ ...run, run_attempt: attempt }),
    });
    assert.deepEqual((await cleanup(api, { runId: 20 })).eligible, [10]);
    assert.deepEqual(scopes, [{ runId: 20 }]);
    assert.deepEqual(selectedJobs, [[20, attempt]]);
  }
});
void test("hourly recovery completes all four exact inventories before reading eligibility", async () => {
  const calls: unknown[] = [];
  const api = operations({
    artifacts: async (scope) => {
      calls.push(scope);
      return "attempt" in scope && scope.attempt === 1 ? [artifact] : [];
    },
    run: async () => {
      assert.equal(calls.length, 4);
      return run;
    },
  });
  assert.deepEqual((await cleanup(api)).eligible, [10]);
  assert.deepEqual(
    calls,
    [1, 2, 3, 4].map((attempt) => ({ attempt })),
  );
});
void test("foreign artifact, duplicate inventory and invalid run ID fail before further effects", async () => {
  const foreign = operations({
    artifacts: async () => [{ ...artifact, workflow_run: { id: 99 } }],
    run: async () => assert.fail("Foreign artifact cannot be read"),
  });
  await assert.rejects(cleanup(foreign, { apply: true, runId: 20 }), /selected run/u);
  const duplicate = operations({
    run: async () => assert.fail("Duplicate inventory cannot be read"),
  });
  await assert.rejects(cleanup(duplicate, { apply: true }), /duplicate artifact/u);
  for (const runId of [NaN, 0])
    await assert.rejects(cleanup(duplicate, { runId }), /positive safe/u);
});
void test("locked SDK preserves complete pagination and makes DELETE exactly once", async () => {
  const sends: string[] = [];
  const api = await createCleanupOperations({
    token: "synthetic-cleanup-token",
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      sends.push(`${init?.method} ${url.pathname}${url.search}`);
      assert.match(
        new Headers(init?.headers).get("authorization") ?? "",
        /^(?:token|Bearer) synthetic-cleanup-token$/u,
      );
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
      if (init?.method === "DELETE")
        return new Response('{"message":"unavailable"}', {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      const second = url.searchParams.get("page") === "2";
      return new Response(
        JSON.stringify({
          total_count: 101,
          artifacts: second
            ? [{ id: 101 }]
            : Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        }),
        {
          headers: {
            "content-type": "application/json",
            ...(second
              ? {}
              : {
                  link: `<https://api.github.com/repos/boburning/portcove/actions/runs/20/artifacts?per_page=100&page=2>; rel="next"`,
                }),
          },
        },
      );
    },
  });
  assert.equal((await api.artifacts({ runId: 20 })).length, 101);
  await assert.rejects(api.removeArtifact(10));
  assert.equal(sends.length, 3);
  assert.equal(sends.filter((entry) => entry.startsWith("DELETE ")).length, 1);
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

void test("SDK collection refuses escaped pagination, duplicate IDs and missing terminal coverage", async () => {
  for (const failure of ["escape", "duplicate", "truncated"] as const) {
    let sends = 0;
    const api = await createCleanupOperations({
      token: "synthetic-token",
      fetch: async (input) => {
        sends++;
        const url = new URL(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        );
        const second = url.searchParams.get("page") === "2";
        const next = failure === "escape" ? "21" : "20";
        return new Response(
          JSON.stringify({
            total_count: 101,
            artifacts: second
              ? [{ id: 100 }]
              : Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
          }),
          {
            headers: {
              "content-type": "application/json",
              ...(second || failure === "truncated"
                ? {}
                : {
                    link: `<https://api.github.com/repos/boburning/portcove/actions/runs/${next}/artifacts?per_page=100&page=2>; rel="next"`,
                  }),
            },
          },
        );
      },
    });
    await assert.rejects(api.artifacts({ runId: 20 }), /collection|duplicate|count/u);
    assert.equal(sends, failure === "duplicate" ? 2 : 1);
  }
});
