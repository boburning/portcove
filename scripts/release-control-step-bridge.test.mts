import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { prepareControlReadiness } from "./release-control-handshake.mts";
import {
  controlBridgeOriginalDeadline,
  readControlBridgeOriginalJob,
  inspectControlStepReadiness,
  retainControlStepLocator,
  controlReadyUploadRoute,
} from "./release-control-step-bridge.mts";
const expected = {
  phase: "site-publication",
  index: 3,
  run_id: "123",
  revision: "a".repeat(40),
  ref: "refs/tags/portcove-production-controller-fixture",
};
const ready = () =>
  prepareControlReadiness(
    {
      kind: "oidc-job-identity-only",
      workflow: ".github/workflows/application-update-production.yml",
      workflow_revision: expected.revision,
      execution_ref: expected.ref,
      run_id: expected.run_id,
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
    },
    "b".repeat(64),
    expected.phase,
    { index: 3, nonce: "c".repeat(64) },
  );
void test("fixed ready routing binds own source/run/phase/round without granting a control proof", () => {
  assert.equal(inspectControlStepReadiness(ready(), expected).authority, "none");
  for (const change of [
    { phase: "payload" },
    { index: 2 },
    { run_id: "124" },
    { revision: "d".repeat(40) },
    { ref: "refs/heads/main" },
  ])
    assert.throws(() => inspectControlStepReadiness(ready(), { ...expected, ...change }));
  const changed = ready();
  changed.producer.run_attempt = 2;
  assert.throws(() => inspectControlStepReadiness(changed, expected));
  for (const invalid of [789, "0789", "789\n", "0"]) {
    const changed = ready();
    changed.producer.check_run_id = invalid;
    assert.throws(() => inspectControlStepReadiness(changed, expected));
  }
});
void test("trusted ready file crosses the fixed upload bridge; mutation and repeated locator refuse, settled producer skips unused rounds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-step-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ["RUNNER_TEMP", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_REF"];
  const original = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    }),
  );
  Object.assign(process.env, {
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: expected.run_id,
    GITHUB_SHA: expected.revision,
    GITHUB_REF: expected.ref,
  });
  const work = path.join(root, "actual-parent");
  await mkdir(work);
  const file = path.join(work, "ready-site-publication.json");
  await writeFile(file, JSON.stringify(ready()));
  const locator = await retainControlStepLocator(file, expected.phase, 3);
  const retained: unknown = JSON.parse(await readFile(locator, "utf8"));
  assert.deepEqual(retained, {
    path: file,
    sha256: createHash("sha256").update(JSON.stringify(ready())).digest("hex"),
  });
  const route = await controlReadyUploadRoute(root, expected.phase, 3, performance.now() + 1000);
  assert.deepEqual(route, {
    ready: true,
    path: file,
    name: "trusted-release-control-site-publication-ready-123-1-r3",
  });
  await assert.rejects(retainControlStepLocator(file, expected.phase, 3), /EEXIST/u);
  await writeFile(file, JSON.stringify({ ...ready(), facts_sha256: "d".repeat(64) }));
  await assert.rejects(
    controlReadyUploadRoute(root, expected.phase, 3, performance.now() + 1000),
    /bytes changed/u,
  );
  await writeFile(
    path.join(root, "release-control-site-publication-process-ended.json"),
    JSON.stringify({ exit_code: 2 }),
  );
  assert.deepEqual(
    await controlReadyUploadRoute(root, expected.phase, 4, performance.now() + 1000),
    { ready: false, producer_exit_code: 2 },
  );
});
void test("deadline refusal precedes any missing-file polling", async () => {
  await assert.rejects(
    controlReadyUploadRoute(path.resolve("unused"), expected.phase, 3, performance.now() - 1),
    /deadline/u,
  );
});

void test("readiness upload uses original provider start rather than allocating a fresh wait per round", (t) => {
  const keys = ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"],
    before = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    }),
  );
  Object.assign(process.env, {
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: expected.revision,
  });
  const start = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 77,
    run_id: 123,
    run_attempt: 1,
    head_sha: expected.revision,
    status: "in_progress",
    name: "Publish authenticated application site",
    started_at: new Date(start).toISOString(),
  };
  const raw = { total_count: 1, jobs: [job] };
  assert.equal(controlBridgeOriginalDeadline(raw, "site-publication", start + 50000, 1000), 241000);
  for (const bad of [
    { ...raw, total_count: 2 },
    { total_count: 2, jobs: [job, job] },
    { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
    { total_count: 1, jobs: [{ ...job, name: "other" }] },
  ])
    assert.throws(() =>
      controlBridgeOriginalDeadline(bad, "site-publication", start + 50000, 1000),
    );
  for (const now of [start - 1, start + 290000])
    assert.throws(() => controlBridgeOriginalDeadline(raw, "site-publication", now, 1000));
});

void test("locked Jobs clock refuses original source drift after its one fixed read", async (t) => {
  const values = {
    GITHUB_RUN_ID: expected.run_id,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: expected.revision,
    GITHUB_REF: expected.ref,
    GH_TOKEN: "fixed-controller-clock-fixture",
  };
  const previous = { ...process.env };
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of Object.keys(values))
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
  let calls = 0;
  let fault: "none" | "drift" | "link" | "http" | "stall" = "none";
  let cancelled = false;
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const started_at = new Date(Date.now() - 1000).toISOString();
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/repos/boburning/portcove/actions/runs/123/attempts/1/jobs");
    assert.deepEqual(Object.fromEntries(url.searchParams), { page: "1", per_page: "100" });
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "token fixed-controller-clock-fixture",
    );
    if (fault === "drift") process.env.GITHUB_REF = `${expected.ref}-drift`;
    if (fault === "stall")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    return Response.json(
      {
        total_count: 1,
        jobs: [
          {
            id: 77,
            run_id: 123,
            run_attempt: 1,
            head_sha: expected.revision,
            status: "in_progress",
            name: "Publish authenticated application site",
            started_at,
          },
        ],
      },
      {
        status: fault === "http" ? 503 : 200,
        ...(fault === "link"
          ? {
              headers: {
                link: '<https://api.github.com/repos/boburning/portcove/actions/runs/123/attempts/1/jobs?page=2&per_page=100>; rel="next"',
              },
            }
          : {}),
      },
    );
  };
  t.mock.method(globalThis, "fetch", fetcher);
  const observed = await readControlBridgeOriginalJob(expected.phase);
  assert.deepEqual(observed.job, { id: 77, started_at });
  assert.ok(observed.deadline > performance.now());
  for (const mode of ["drift", "link", "http"] as const) {
    fault = mode;
    await assert.rejects(readControlBridgeOriginalJob(expected.phase));
    process.env.GITHUB_REF = expected.ref;
  }
  fault = "stall";
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 350, () =>
      readControlBridgeOriginalJob(expected.phase),
    ),
  );
  assert.ok(cancelled);
  assert.equal(calls, 5);
});
