import { readFileSync } from "node:fs";
import { windowsApplicationQualificationFixture } from "./fixtures/application-qualification-fixture.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  inspectControllerWakeConfiguration,
  wakeRatifiedController,
  reconcilePreviousWakes,
  requireJobTokenWakeConfiguration,
  inspectControllerWakeChoices,
  inspectJobTokenDispatchRun,
  observeJobTokenDispatchRun,
} from "./release-controller-wake.mts";
import { isRecord } from "./runtime-values.mts";
import type { WakeProvider } from "./release-wake-provider.mts";
import { createWakeProvider } from "./release-wake-provider.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
import { isBuiltin } from "node:module";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test(
  "actual inert fixture charges setup to the original job and retains one refused dispatch",
  { skip: process.platform !== "linux" },
  async (context) => {
    const before = { ...process.env };
    for (const expired of [true, false]) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sdk-dispatch-fixture-"));
      let sends = 0,
        posts = 0;
      const source = "a".repeat(40);
      Object.assign(process.env, {
        PORTCOVE_DISPATCH_FIXTURE_MODE: "send",
        PORTCOVE_DISPATCH_PARENT_RUN: "",
        PORTCOVE_DISPATCH_PARENT_REVISION: "",
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_REPOSITORY: "boburning/portcove",
        GITHUB_REPOSITORY_ID: "1354613114",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "send",
        GITHUB_SHA: source,
        GITHUB_WORKFLOW_SHA: source,
        GITHUB_WORKFLOW_REF:
          "boburning/portcove/.github/workflows/job-token-dispatch-fixture.yml@refs/heads/main",
        GITHUB_RUN_ID: "42",
        RUNNER_TEMP: directory,
        GH_TOKEN: "synthetic-fixture-token",
      });
      const mocked = context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          sends++;
          const url = new URL(input instanceof Request ? input.url : String(input));
          assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
          if (url.pathname.endsWith("/attempts/1/jobs"))
            return Response.json({
              total_count: 1,
              jobs: [
                {
                  id: 77,
                  name: "Send inert job-token dispatch",
                  run_id: 42,
                  run_attempt: 1,
                  head_sha: source,
                  status: "in_progress",
                  started_at: new Date(Date.now() - (expired ? 60000 : 5000)).toISOString(),
                },
              ],
            });
          if (url.pathname.endsWith("/actions/runs/42"))
            return Response.json({
              id: 42,
              path: ".github/workflows/job-token-dispatch-fixture.yml",
              head_sha: source,
              head_branch: "main",
              event: "workflow_dispatch",
              run_attempt: 1,
              repository: { id: 1354613114, full_name: "boburning/portcove" },
              head_repository: { id: 1354613114 },
              actor: { id: 41898282 },
              triggering_actor: { id: 41898282 },
            });
          assert.equal(
            url.pathname,
            "/repos/boburning/portcove/actions/workflows/job-token-dispatch-fixture.yml/dispatches",
          );
          assert.equal(init?.method, "POST");
          posts++;
          return Response.json({ message: "unavailable" }, { status: 503 });
        },
      );
      try {
        await assert.rejects(
          import(
            new URL(`./qualify-job-token-dispatch.mts?fixture=${expired}`, import.meta.url).href
          ),
          expired ? /original job budget exhausted/ : /retain original dispatch/,
        );
        const records = (
          await readFile(path.join(directory, "job-token-dispatch-fixture/receipt.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { phase: string; value: unknown });
        assert.equal(posts, expired ? 0 : 1);
        assert.equal(sends, expired ? 1 : 3);
        if (!expired) {
          const response = records.findIndex((row) => row.phase === "dispatch-response");
          assert.ok(
            response >= 0 &&
              response < records.findIndex((row) => row.phase === "dispatch-ambiguous"),
          );
          assert.deepEqual(records[response]!.value, {
            status: 503,
            body: { message: "unavailable" },
          });
        }
      } finally {
        mocked.mock.restore();
        for (const key of Object.keys(process.env))
          if (!Object.hasOwn(before, key)) delete process.env[key];
        Object.assign(process.env, before);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

void test("locked wake SDK retains the acknowledged run before refusing expiry", async (context) => {
  let monotonic = 1000,
    sends = 0;
  context.mock.method(performance, "now", () => monotonic);
  const f = fixture(true),
    records: { phase: string; evidence: unknown }[] = [];
  const api = await createWakeProvider({
    token: "synthetic-wake-token",
    deadline: 2000,
    remainingDeadline: () => 2000,
    apiVersion: "2026-03-10",
    maxBytes: 2 * 1024 ** 2,
    now: () => monotonic,
    fetch: async (input, init) => {
      sends++;
      assert.equal(
        input instanceof Request ? input.url : String(input),
        "https://api.github.com/repos/boburning/portcove/actions/runs/900",
      );
      assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic-wake-token");
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2026-03-10");
      assert.equal(init?.redirect, "manual");
      return Response.json(f.actualRun());
    },
  });
  await assert.rejects(
    observeJobTokenDispatchRun(
      api,
      {
        run_id: "900",
        revision: f.config.revision,
        workflow: ".github/workflows/application-update-production.yml",
        display_title: "Portcove application release wake 42",
      },
      async (phase, evidence) => {
        await new Promise((resolve) => setImmediate(resolve));
        records.push({ phase, evidence });
        monotonic = 2001;
      },
      2000,
    ),
    /readback unavailable/,
  );
  assert.equal(sends, 1);
  assert.deepEqual(records, [
    {
      phase: "dispatch-run-readback",
      evidence: {
        run_id: "900",
        index: 1,
        status: 200,
        body: f.actualRun(),
      },
    },
  ]);
});

void test("locked wake SDK keeps dispatch one shot and never retains an incomplete run", async () => {
  for (const mode of ["dispatch", "stream", "cap", "redirect"] as const) {
    let sends = 0,
      retained = 0;
    const api = await createWakeProvider({
      token: "synthetic-wake-token",
      deadline: performance.now() + 5000,
      remainingDeadline: () => performance.now() + 5000,
      apiVersion: "2022-11-28",
      maxBytes: mode === "cap" ? 1 : 1024,
      fetch: async (_input, init) => {
        sends++;
        if (mode === "dispatch") {
          assert.equal(init?.method, "POST");
          assert.equal(typeof init?.body, "string");
          assert.deepEqual(JSON.parse(init?.body as string), {
            ref: "main",
            return_run_details: true,
            inputs: { mode: "receive" },
          });
          return Response.json({ message: "unavailable" }, { status: 503 });
        }
        if (mode === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("broken stream"));
              },
            }),
          );
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid" },
          });
        return Response.json({ id: 900 });
      },
    });
    const retain = async () => {
      retained++;
    };
    const body = { ref: "main", return_run_details: true, inputs: { mode: "receive" } };
    const pending =
      mode === "dispatch"
        ? api.dispatch("job-token-dispatch-fixture.yml", body, retain)
        : api.run("900", retain);
    body.ref = "unapproved";
    body.inputs.mode = "unapproved";
    await assert.rejects(pending);
    assert.equal(sends, 1);
    assert.equal(retained, mode === "dispatch" ? 1 : 0);
  }
});

void test("wake retains its original command identity across asynchronous reads", async () => {
  const f = fixture(true),
    repository = f.api.repository;
  f.api.repository = async () => {
    const result = await repository();
    f.env.GITHUB_RUN_ID = "99";
    return result;
  };
  const result = await wakeRatifiedController(f.config, f.env, f.api, f.record, {
    mode: "prepare",
  });
  assert.ok("intent" in result);
  assert.equal(result.intent.wake_run_id, "42");
  assert.ok(f.calls.some((call) => call.endpoint.endsWith("/42/attempts/1/jobs?per_page=100")));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});
function fixture(jobToken = false) {
  const bytes = Buffer.from("fixed inert controller workflow\n"),
    wakeBytes = Buffer.from("fixed inert wake workflow\n");
  const created = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const config = {
    schema_version: jobToken ? 4 : 2,
    ...(jobToken
      ? {
          dispatch_transport: "github-actions-job-v1",
          publication_purpose: "application",
          namespace: "portcove-fixture",
        }
      : {}),
    revision: "a".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    workflow_sha256: hash(bytes),
    wake_workflow_sha256: hash(wakeBytes),
    dispatch_actor_id: jobToken ? "41898282" : "991",
    activation_started_at: created,
  };
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/application-update-wake.yml@refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "wake",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "42",
  };
  const ownRun = {
    id: 42,
    run_number: 42,
    run_attempt: 1,
    head_sha: env.GITHUB_SHA,
    head_branch: "main",
    path: ".github/workflows/application-update-wake.yml",
    event: "push",
    created_at: created,
    status: "in_progress",
    conclusion: null,
  };
  const actualRun = (wake = "42") => ({
    id: 900,
    run_number: 900,
    created_at: created,
    head_sha: config.revision,
    path: ".github/workflows/application-update-production.yml",
    event: "workflow_dispatch",
    run_attempt: 1,
    display_title: `Portcove application release wake ${wake}`,
    actor: { id: Number(config.dispatch_actor_id) },
    triggering_actor: { id: Number(config.dispatch_actor_id) },
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  });
  const calls: { method: string; endpoint: string; body?: unknown }[] = [],
    records: { phase: string; evidence: unknown }[] = [];
  let changed = false,
    corrupt = false,
    privateRepo = false,
    postStatus: number | null = 200,
    archive = Buffer.alloc(0),
    priorArchive = Buffer.alloc(0),
    prior: Record<string, unknown>[] = [],
    recovered: Record<string, unknown>[] = [],
    skipped = false,
    wrongActor = false,
    downloadCalls = 0;
  const base = "repos/boburning/portcove";
  const file = (filename: string, contents: Buffer) => ({
    type: "file",
    path: filename,
    encoding: "base64",
    content: contents.toString("base64") + "\n",
    size: contents.length,
    sha: corrupt
      ? "d".repeat(40)
      : createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex"),
  });
  const seen = (endpoint: string) => calls.push({ method: "GET", endpoint });
  const api: WakeProvider = {
    async repository() {
      seen(base);
      return {
        id: 1354613114,
        full_name: "boburning/portcove",
        default_branch: "main",
        private: privateRepo,
      };
    },
    async ref(name) {
      seen(`${base}/git/ref/${name}`);
      return name === "heads/main"
        ? { ref: "refs/heads/main", object: { type: "commit", sha: env.GITHUB_SHA } }
        : {
            ref: config.execution_ref,
            object: {
              type: "commit",
              sha: changed && calls.length > 4 ? "c".repeat(40) : config.revision,
            },
          };
    },
    async file(filename) {
      seen(`${base}/contents/${filename}`);
      assert.ok(
        [
          ".github/workflows/application-update-production.yml",
          ".github/workflows/application-update-wake.yml",
        ].includes(filename),
      );
      return file(filename, filename.endsWith("application-update-wake.yml") ? wakeBytes : bytes);
    },
    async run(id, retain) {
      seen(`${base}/actions/runs/${id}`);
      assert.ok(["42", "900"].includes(id));
      const body =
        id === "42"
          ? ownRun
          : wrongActor
            ? { ...actualRun(), actor: { id: 99 } }
            : actualRun(prior.length ? "41" : "42");
      await retain?.({ status: 200, body });
      return body;
    },
    async jobs(id) {
      seen(`${base}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
      assert.ok(["42", "41"].includes(id));
      return {
        total_count: 1,
        jobs: [
          id === "42"
            ? {
                id: 77,
                name: "Wake fixed application controller",
                run_id: 42,
                run_attempt: 1,
                head_sha: env.GITHUB_SHA,
                status: "in_progress",
                started_at: created,
              }
            : {
                name: "Wake fixed application controller",
                run_id: 41,
                run_attempt: 1,
                head_sha: env.GITHUB_SHA,
                status: "completed",
                steps: [
                  {
                    name: "Dispatch retained immutable controller intent",
                    status: "completed",
                    conclusion: skipped ? "skipped" : "failure",
                  },
                ],
              },
        ],
      };
    },
    async runs(workflow, _filters, page) {
      seen(`${base}/actions/workflows/${workflow}/runs?page=${page}`);
      return workflow === "application-update-wake.yml"
        ? { total_count: 1 + prior.length, workflow_runs: [ownRun, ...prior] }
        : { total_count: recovered.length, workflow_runs: recovered };
    },
    async artifacts(id) {
      seen(`${base}/actions/runs/${id}/artifacts?per_page=100`);
      assert.equal(id, "41");
      return {
        total_count: 1,
        artifacts: [
          { id: 2, name: "controller-wake-intent-41-1", digest: `sha256:${hash(priorArchive)}` },
        ],
      };
    },
    async artifact(id) {
      seen(`${base}/actions/artifacts/${id}`);
      assert.ok([1, 2].includes(id));
      const selected = id === 1 ? archive : priorArchive;
      return {
        id,
        name: `controller-wake-intent-${id === 1 ? "42" : "41"}-1`,
        digest: `sha256:${hash(selected)}`,
        expired: false,
        size_in_bytes: selected.length,
        workflow_run: {
          id: id === 1 ? 42 : 41,
          repository_id: 1354613114,
          head_repository_id: 1354613114,
          head_sha: env.GITHUB_SHA,
        },
      };
    },
    async dispatch(workflow, body, retain) {
      assert.equal(workflow, "application-update-production.yml");
      calls.push({
        method: "POST",
        endpoint: `${base}/actions/workflows/application-update-production.yml/dispatches`,
        body,
      });
      if (postStatus === null) throw new Error("lost original response");
      const response = {
        status: postStatus,
        body: {
          workflow_run_id: 900,
          run_url: `https://api.github.com/${base}/actions/runs/900`,
          html_url: "https://github.com/boburning/portcove/actions/runs/900",
        },
      };
      await retain?.(response);
      return response;
    },
  };
  const record = async (phase: string, evidence: unknown) => {
    records.push({ phase, evidence });
  };
  return {
    config,
    env,
    calls,
    records,
    api,
    record,
    actualRun,
    async prepare() {
      const result = await wakeRatifiedController(config, env, api, record, { mode: "prepare" });
      assert.equal(result.decision, "intent-prepared-only");
      assert.ok("intent" in result);
      archive = createAuditZip([
        ["controller-wake-intent.json", Buffer.from(JSON.stringify(result.intent) + "\n")],
      ]);
    },
    dispatch() {
      return wakeRatifiedController(config, env, api, record, {
        mode: "dispatch",
        artifact: { id: 1, sha256: hash(archive) },
        directory: process.cwd(),
        download: (endpoint) => {
          downloadCalls++;
          return endpoint.includes("/artifacts/2/") ? priorArchive : archive;
        },
      });
    },
    downloads: () => downloadCalls,
    tamperIntent: () => {
      archive = createAuditZip([["controller-wake-intent.json", "{}\n"]]);
    },
    changeRef: () => {
      changed = true;
    },
    badDigest: () => {
      corrupt = true;
    },
    privateRepo: () => {
      privateRepo = true;
    },
    status: (status: number | null) => {
      postStatus = status;
    },
    wrongActor: () => {
      wrongActor = true;
    },
    priorFailure: () => {
      prior = [{ ...ownRun, id: 41, run_number: 41, status: "completed", conclusion: "failure" }];
    },
    priorSuccess: (changes: Record<string, unknown> = {}) => {
      prior = [{ ...ownRun, id: 41, run_number: 41, status: "completed", conclusion: "success" }];
      const selected = inspectControllerWakeConfiguration({ ...config, ...changes });
      const intent = {
        schema_version: 1,
        controller: selected,
        endpoint: `${base}/actions/workflows/application-update-production.yml/dispatches`,
        body: {
          ref: selected.execution_ref.slice("refs/tags/".length),
          inputs: { wake_run_id: "41" },
          return_run_details: true,
        },
        wake_run_id: "41",
        wake_revision: env.GITHUB_SHA,
      };
      priorArchive = createAuditZip([
        ["controller-wake-intent.json", Buffer.from(JSON.stringify(intent) + "\n")],
      ]);
    },
    recovered: () => {
      recovered = [actualRun("41")];
    },
    skipped: () => {
      skipped = true;
    },
  };
}

void test("automatic wake first retains and verifies immutable intent, then dispatches one exact correlated controller", async () => {
  for (const event of ["push", "schedule"]) {
    const f = fixture();
    f.env.GITHUB_EVENT_NAME = event;
    await f.prepare();
    assert.equal(f.calls.filter((x) => x.method === "POST").length, 0);
    const result = await f.dispatch();
    assert.equal(result.decision, "dispatch-acknowledged-only");
    assert.equal(result.authority, "none");
    assert.equal(f.downloads(), 1);
    const writes = f.calls.filter((x) => x.method === "POST");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.body, {
      ref: "portcove-production-controller-fixture",
      inputs: { wake_run_id: "42" },
      return_run_details: true,
    });
    assert.equal(f.records.at(-2)!.phase, "dispatch-provider-acknowledged-only");
    assert.equal(f.records.at(-1)!.phase, "dispatch-acknowledged");
  }
});

void test("changed durable intent and incomplete or saturated previous-run coverage stop before POST", async () => {
  const changed = fixture();
  await changed.prepare();
  changed.tamperIntent();
  await assert.rejects(changed.dispatch(), /original durable intent changed/);
  assert.equal(changed.calls.filter((call) => call.method === "POST").length, 0);
  for (const total of [2, 1000]) {
    const f = fixture();
    await f.prepare();
    const original = f.api.runs;
    f.api.runs = async (...args) => {
      const response = await original(...args);
      assert.ok(isRecord(response));
      return args[0] === "application-update-wake.yml"
        ? { ...response, total_count: total }
        : response;
    };
    await assert.rejects(f.dispatch(), /inventory|saturated/);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  }
});

void test("a successful prior workflow cuts off history only with its exact durable selected configuration", async () => {
  const same = fixture();
  await same.prepare();
  same.priorSuccess();
  // The actual current dispatch is not needed to prove the historical boundary.
  same.api.dispatch = async () => {
    throw new Error("stop after authenticated prior boundary");
  };
  await assert.rejects(same.dispatch(), /requires controller-run readback/);
  assert.ok(same.records.some((row) => row.phase === "prior-wake-boundary-observed"));
  for (const changed of [
    { revision: "c".repeat(40) },
    { activation_started_at: "2026-01-01T00:00:00Z" },
  ]) {
    const f = fixture();
    await f.prepare();
    f.priorSuccess(changed);
    await assert.rejects(f.dispatch(), /original durable intent changed/);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
    assert.ok(!f.records.some((row) => row.phase === "prior-wake-boundary-observed"));
  }
});

void test("fixed wake uses its job token and retains intent before dispatch without any App secret", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const closure = readFixtureModuleClosure(root, ["scripts/release-controller-wake.mts"]);
  assert.ok(closure.modules.length > 5);
  assert.deepEqual(
    closure.external.filter((name) => !isBuiltin(name)),
    ["@octokit/core", "@octokit/plugin-paginate-rest"],
  );
  const workflow = await readFile(
    path.join(root, "docs/qualification/application-update-wake.held.yml"),
    "utf8",
  );
  assert.match(workflow, /timeout-minutes: 1/u);
  assert.ok(
    workflow.indexOf("Retain intent before any dispatch") <
      workflow.indexOf("Dispatch retained immutable controller intent"),
  );
  assert.doesNotMatch(
    workflow,
    /\bnpm (?:ci|install)\b|^\s+cache:|secrets\.|create-github-app-token/mu,
  );
  assert.match(workflow, /    permissions:\n      contents: read\n      actions: write/u);
  assert.match(workflow, /fromJSON\(vars\.PORTCOVE_CONTROLLER_WAKE\)\.schema_version == 4/u);
  assert.match(
    workflow,
    /fromJSON\(vars\.PORTCOVE_CATALOG_CONTROLLER_WAKE\)\.schema_version == 4/u,
  );
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu) ?? []).length, 2);
});

void test("explicit job-token routing binds the exact live job and observes the actual bot after one POST", async () => {
  const f = fixture(true);
  await f.prepare();
  const result = await f.dispatch();
  assert.equal(result.decision, "dispatch-acknowledged-only");
  assert.equal(result.controller.dispatch_actor_id, "41898282");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(f.calls.some((call) => call.endpoint.endsWith("/42/attempts/1/jobs?per_page=100")));
  assert.equal(requireJobTokenWakeConfiguration(f.config).schema_version, 4);
  assert.throws(() => requireJobTokenWakeConfiguration(fixture().config), /explicitly ratified/);
  for (const change of [
    { dispatch_actor_id: "991" },
    { dispatch_transport: "app" },
    { dispatch_installation_id: 1 },
    { namespace: undefined },
  ])
    assert.throws(() => inspectControllerWakeConfiguration({ ...f.config, ...change }));
  const catalog = { ...f.config, publication_purpose: "catalog-publication" };
  assert.equal(inspectControllerWakeChoices(f.config, catalog).length, 2);
  assert.throws(() =>
    inspectControllerWakeChoices(f.config, {
      ...catalog,
      schema_version: 3,
      dispatch_transport: undefined,
    }),
  );
});

void test("wrong or stale job-token producer and wrong dispatched actor refuse without a second POST", async () => {
  for (const change of [
    { name: "candidate" },
    { head_sha: "c".repeat(40) },
    { run_id: 99 },
    { status: "completed" },
    { id: 0 },
    { run_attempt: 2 },
    { started_at: "2020-01-01T00:00:00Z" },
    { started_at: "2099-01-01T00:00:00Z" },
  ]) {
    const f = fixture(true),
      original = f.api.jobs;
    f.api.jobs = async (id) => {
      const response = await original(id);
      assert.ok(isRecord(response) && Array.isArray(response.jobs));
      assert.ok(isRecord(response.jobs[0]));
      return { ...response, jobs: [{ ...response.jobs[0], ...change }] };
    };
    await assert.rejects(f.prepare(), /exact live hosted job/);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  }
  const wrong = fixture(true);
  await wrong.prepare();
  wrong.wrongActor();
  await assert.rejects(wrong.dispatch(), /actor differs/);
  assert.equal(wrong.calls.filter((call) => call.method === "POST").length, 1);
  const ambiguous = fixture(true);
  await ambiguous.prepare();
  ambiguous.status(null);
  await assert.rejects(ambiguous.dispatch(), /readback; no retry/);
  assert.equal(ambiguous.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(ambiguous.records.at(-1)?.phase, "dispatch-ambiguous-no-retry");
});

void test("the shared job-token readback cannot turn a different workflow or generic bot check into a controller run", () => {
  const f = fixture(true),
    expected = {
      run_id: "900",
      revision: f.config.revision,
      workflow: ".github/workflows/application-update-production.yml",
      display_title: "Portcove application release wake 42",
    };
  assert.equal(inspectJobTokenDispatchRun(f.actualRun(), expected).actor_id, "41898282");
  for (const change of [
    { path: ".github/workflows/ci.yml" },
    { head_sha: "c".repeat(40) },
    { actor: { id: 991 } },
    { triggering_actor: { id: 991 } },
    { run_attempt: 2 },
    { event: "push" },
    { id: 901 },
    { display_title: "Portcove application release wake 41" },
    { repository: { id: 1354613114, full_name: "foreign/portcove" } },
    { head_repository: { id: 99 } },
  ])
    assert.throws(() => inspectJobTokenDispatchRun({ ...f.actualRun(), ...change }, expected));
  assert.throws(() =>
    inspectJobTokenDispatchRun(f.actualRun(), {
      ...expected,
      workflow: ".github/workflows/ci.yml",
    }),
  );
});

void test("post-ack title settlement retains each original readback and never repeats dispatch", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(true),
    original = f.api.run;
  let reads = 0;
  f.api.run = async (id, retain) => {
    if (id === "900" && ++reads === 1) {
      const body = { ...f.actualRun(), status: "queued", display_title: "pending title" };
      await retain?.({ status: 200, body });
      return body;
    }
    return original(id, retain);
  };
  await f.prepare();
  const pending = f.dispatch();
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.decision, "dispatch-acknowledged-only");
  assert.equal(reads, 2);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  const retained = f.records.filter((row) => row.phase === "dispatch-run-readback");
  assert.equal(retained.length, 2);
  assert.ok(isRecord(retained[0]!.evidence) && isRecord(retained[0]!.evidence.body));
  assert.equal(retained[0]!.evidence.body.display_title, "pending title");
  assert.ok(isRecord(retained[1]!.evidence) && isRecord(retained[1]!.evidence.body));
  assert.equal(retained[1]!.evidence.body.display_title, "Portcove application release wake 42");
});

void test("unsettled correlation exhausts four GETs inside the original budget without a POST", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(true),
    records: unknown[] = [],
    expected = {
      run_id: "900",
      revision: f.config.revision,
      workflow: ".github/workflows/application-update-production.yml",
      display_title: "Portcove application release wake 42",
    };
  let reads = 0;
  const pending = assert.rejects(
    observeJobTokenDispatchRun(
      {
        async run(id, retain) {
          assert.equal(id, "900");
          reads++;
          const body = { ...f.actualRun(), status: "queued", display_title: "pending title" };
          await retain?.({ status: 200, body });
          return body;
        },
      },
      expected,
      async (_phase, evidence) => {
        records.push(evidence);
      },
      performance.now() + 20000,
    ),
    /correlation remains unproven/,
  );
  for (let index = 0; index < 3; index++) {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(5000);
  }
  await pending;
  assert.equal(reads, 4);
  assert.equal(records.length, 4);
});

void test("a production-wrapped GET crossing expiry retains its returned body before refusing", async (context) => {
  let monotonic = 1000;
  context.mock.method(performance, "now", () => monotonic);
  const f = fixture(true),
    original = f.api.run;
  f.api.run = async (id, retain) => {
    const response = await original(id, retain);
    if (id === "900") monotonic = 60000;
    return response;
  };
  await f.prepare();
  await assert.rejects(f.dispatch(), /deadline exhausted|readback unavailable/);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  const retained = f.records.filter((row) => row.phase === "dispatch-run-readback");
  assert.equal(retained.length, 1);
  assert.ok(isRecord(retained[0]!.evidence) && isRecord(retained[0]!.evidence.body));
  assert.equal(retained[0]!.evidence.body.id, 900);
  assert.equal(retained[0]!.evidence.body.head_sha, f.config.revision);
});

void test("immutable identity failures, unavailable responses and deadline exhaustion retain readback and stop", async () => {
  const f = fixture(true),
    expected = {
      run_id: "900",
      revision: f.config.revision,
      workflow: ".github/workflows/application-update-production.yml",
      display_title: "Portcove application release wake 42",
    };
  for (const body of [
    { ...f.actualRun(), actor: { id: 991 }, status: "queued" },
    { ...f.actualRun(), head_sha: "c".repeat(40), status: "queued" },
    { ...f.actualRun(), status: "completed", display_title: "wrong correlation" },
    { ...f.actualRun(), extra: "x".repeat(65536) },
  ]) {
    const records: unknown[] = [];
    let reads = 0;
    await assert.rejects(
      observeJobTokenDispatchRun(
        {
          async run(_id, retain) {
            reads++;
            await retain?.({ status: 200, body });
            return body;
          },
        },
        expected,
        async (_phase, evidence) => {
          records.push(evidence);
        },
        performance.now() + 55000,
      ),
    );
    assert.equal(reads, 1);
    assert.equal(records.length, 1);
  }
  let reads = 0;
  const records: { phase: string; evidence: unknown }[] = [],
    api = {
      async run() {
        reads++;
        throw new Error("transport unavailable");
      },
    };
  const record = async (phase: string, evidence: unknown) => {
    records.push({ phase, evidence });
  };
  await assert.rejects(
    observeJobTokenDispatchRun(api, expected, record, performance.now() - 1),
    /deadline exhausted/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    observeJobTokenDispatchRun(api, expected, record, performance.now() + 55000),
    /readback unavailable/,
  );
  assert.equal(reads, 1);
  assert.equal(records[0]!.phase, "dispatch-run-readback-unavailable");
  await assert.rejects(
    observeJobTokenDispatchRun(
      {
        async run(_id, retain) {
          reads++;
          const body = { ...f.actualRun(), status: "queued", display_title: "pending" };
          await retain?.({ status: 200, body });
          return body;
        },
      },
      expected,
      record,
      performance.now() + 100,
    ),
    /deadline exhausted/,
  );
  assert.equal(reads, 2);
  await assert.rejects(
    observeJobTokenDispatchRun(
      api,
      { ...expected, run_id: "../foreign" },
      record,
      performance.now() + 55000,
    ),
    /fixed job-token dispatch expectation/,
  );
  assert.equal(reads, 2);
});
void test("manual, rerun, foreign, injected policy and unprotected wake refuse before reads or effects", async () => {
  for (const change of [
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_WORKFLOW_SHA: "c".repeat(40) },
    { GITHUB_REPOSITORY_ID: "1" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    const f = fixture();
    await assert.rejects(
      wakeRatifiedController(f.config, { ...f.env, ...change }, f.api, f.record, {
        mode: "prepare",
      }),
    );
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() =>
    inspectControllerWakeConfiguration({ ...fixture().config, candidate: "untrusted" }),
  );
});
void test("changed source/controller and private repository refuse before dispatch", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => f.changeRef(),
    (f: ReturnType<typeof fixture>) => f.badDigest(),
    (f: ReturnType<typeof fixture>) => f.privateRepo(),
  ]) {
    const f = fixture();
    alter(f);
    await assert.rejects(f.prepare());
    assert.equal(f.calls.filter((x) => x.method === "POST").length, 0);
  }
});
void test("lost/refused response and wrong actor preserve original attempt without retry", async () => {
  for (const status of [null, 403, 429, 500]) {
    const f = fixture();
    await f.prepare();
    f.status(status);
    await assert.rejects(f.dispatch());
    assert.equal(f.calls.filter((x) => x.method === "POST").length, 1);
    assert.match(f.records.at(-1)!.phase, /no-retry/u);
  }
  const f = fixture();
  await f.prepare();
  f.wrongActor();
  await assert.rejects(f.dispatch(), /actor/);
  assert.equal(f.calls.filter((x) => x.method === "POST").length, 1);
  assert.equal(f.records.at(-1)!.phase, "dispatch-provider-acknowledged-only");
  const g = fixture();
  await assert.rejects(
    wakeRatifiedController(
      g.config,
      g.env,
      g.api,
      async () => {
        throw new Error("retention failed");
      },
      { mode: "prepare" },
    ),
  );
  assert.equal(g.calls.filter((x) => x.method === "POST").length, 0);
});
void test("prior ambiguous dispatch requires exact readback before a later POST; provider-skipped step is independently absent", async () => {
  const held = fixture();
  await held.prepare();
  held.priorFailure();
  await assert.rejects(held.dispatch(), /missing or ambiguous/);
  assert.equal(held.calls.filter((x) => x.method === "POST").length, 0);
  const recovered = fixture();
  recovered.priorFailure();
  recovered.recovered();
  await reconcilePreviousWakes(
    inspectControllerWakeConfiguration(recovered.config),
    recovered.env,
    recovered.api,
    recovered.record,
  );
  assert.equal(recovered.records[0]!.phase, "prior-wake-dispatch-readback");
  assert.equal(recovered.calls.filter((x) => x.method === "POST").length, 0);
  const skipped = fixture();
  skipped.priorFailure();
  skipped.skipped();
  await reconcilePreviousWakes(
    inspectControllerWakeConfiguration(skipped.config),
    skipped.env,
    skipped.api,
    skipped.record,
  );
  assert.equal(skipped.records[0]!.phase, "prior-wake-no-dispatch-observed");
});
void test("invalid and expired wake deadline refuses before collection", async () => {
  for (const deadline of [NaN, -1]) {
    const f = fixture();
    await assert.rejects(
      wakeRatifiedController(f.config, f.env, f.api, f.record, { mode: "prepare", deadline }),
      /deadline/,
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.ok(isRecord(f.config));
});

function nativeFixture(jobToken: boolean, native: boolean) {
  const destination = native ? "application-release.yml" : "application-update-production.yml";
  const bytes = Buffer.from("fixed inert controller workflow\n"),
    wakeBytes = Buffer.from("fixed inert wake workflow\n");
  const created = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const config = {
    schema_version: native ? 5 : jobToken ? 4 : 2,
    ...(jobToken
      ? {
          dispatch_transport: "github-actions-job-v1",
          publication_purpose: "application",
          namespace: "portcove-fixture",
        }
      : {}),
    revision: "a".repeat(40),
    execution_ref: native
      ? "refs/tags/portcove-production-controller-windows-fixture"
      : "refs/tags/portcove-production-controller-fixture",
    workflow_sha256: hash(bytes),
    wake_workflow_sha256: hash(wakeBytes),
    dispatch_actor_id: jobToken ? "41898282" : "991",
    activation_started_at: created,
  };
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/application-update-wake.yml@refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "wake",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "42",
  };
  if (native) {
    env.PORTCOVE_APPLICATION_RELEASE_ACTIVE = "true";
    env.PORTCOVE_APPLICATION_RELEASE_REF = config.execution_ref;
    env.PORTCOVE_APPLICATION_RELEASE_REVISION = config.revision;
    env.PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256 = config.workflow_sha256;
    env.PORTCOVE_APPLICATION_RELEASE_SPENDING = JSON.stringify({
      budget_id: "4a6859d9-fdb7-4da2-afd3-acbdc9848eec",
      scope: "account",
      amount_usd: 0,
      stop_usage: true,
      operator_id: 43177418,
      application_minutes: 140,
      catalog_minutes: 40,
      workflow_sha256: config.workflow_sha256,
    });
  }
  const ownRun = {
    id: 42,
    run_number: 42,
    run_attempt: 1,
    head_sha: env.GITHUB_SHA,
    head_branch: "main",
    path: ".github/workflows/application-update-wake.yml",
    event: "push",
    created_at: created,
    status: "in_progress",
    conclusion: null,
  };
  const actualRun = (wake = "42") => ({
    id: 900,
    run_number: 900,
    created_at: created,
    head_sha: config.revision,
    path: `.github/workflows/${destination}`,
    event: "workflow_dispatch",
    run_attempt: 1,
    display_title: native
      ? `Application ${env.GITHUB_SHA} wake ${wake}`
      : `Portcove application release wake ${wake}`,
    actor: { id: Number(config.dispatch_actor_id) },
    triggering_actor: { id: Number(config.dispatch_actor_id) },
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  });
  const qualification = native ? windowsApplicationQualificationFixture(env.GITHUB_SHA!) : null;
  const qualificationArchive = qualification
    ? createAuditZip([["validation-plan.json", JSON.stringify(qualification.plan)]])
    : Buffer.alloc(0);
  const qualificationRun = () => ({
    ...actualRun(),
    id: 23,
    head_branch: "main",
    head_sha: env.GITHUB_SHA,
    display_title: `Windows qualification ${env.GITHUB_SHA}`,
    run_attempt: qualificationAttempt,
    status: "completed",
    conclusion: "success",
  });
  const calls: { method: string; endpoint: string; body?: unknown }[] = [],
    records: { phase: string; evidence: unknown }[] = [];
  let changed = false,
    corrupt = false,
    privateRepo = false,
    postStatus: number | null = 200,
    archive = Buffer.alloc(0),
    priorArchive = Buffer.alloc(0),
    prior: Record<string, unknown>[] = [],
    recovered: Record<string, unknown>[] = [],
    skipped = false,
    wrongActor = false,
    downloadCalls = 0,
    qualificationAttempt = 1,
    missingQualificationPlan = false,
    publicationPaused = false;
  const base = "repos/boburning/portcove";
  const file = (filename: string, contents: Buffer) => ({
    type: "file",
    path: filename,
    encoding: "base64",
    content: contents.toString("base64") + "\n",
    size: contents.length,
    sha: corrupt
      ? "d".repeat(40)
      : createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex"),
  });
  const transport = {
    request(method: string, endpoint: string, body?: unknown) {
      calls.push({ method, endpoint, body });
      let result: unknown;
      if (method === "POST") {
        assert.equal(endpoint, `${base}/actions/workflows/${destination}/dispatches`);
        if (postStatus === null) throw new Error("lost original response");
        return {
          status: postStatus,
          headers: new Map<string, string>(),
          body: {
            workflow_run_id: 900,
            run_url: `https://api.github.com/${base}/actions/runs/900`,
            html_url: "https://github.com/boburning/portcove/actions/runs/900",
          },
        };
      }
      if (endpoint === base)
        result = {
          id: 1354613114,
          full_name: "boburning/portcove",
          default_branch: "main",
          private: privateRepo,
        };
      else if (endpoint === `${base}/git/ref/heads/main`)
        result = { ref: "refs/heads/main", object: { type: "commit", sha: env.GITHUB_SHA } };
      else if (native && endpoint === `${base}/git/ref/heads/portcove-release-pause`)
        result = {
          ref: "refs/heads/portcove-release-pause",
          object: { type: "commit", sha: "f".repeat(40) },
        };
      else if (native && endpoint === `${base}/contents/publication.json?ref=${"f".repeat(40)}`)
        result = file(
          "publication.json",
          Buffer.from(JSON.stringify({ schema_version: 1, publication_paused: publicationPaused })),
        );
      else if (endpoint.includes("git/ref/tags/"))
        result = {
          ref: config.execution_ref,
          object: {
            type: "commit",
            sha: changed && calls.length > 4 ? "c".repeat(40) : config.revision,
          },
        };
      else if (
        native &&
        endpoint.includes("contents/.github/workflows/") &&
        endpoint.endsWith(`ref=${env.GITHUB_SHA}`) &&
        !endpoint.includes("application-update-wake.yml")
      ) {
        const filename = endpoint.slice(`${base}/contents/`.length).split("?")[0]!;
        result = file(filename, readFileSync(new URL(`../${filename}`, import.meta.url)));
      } else if (endpoint.includes(`contents/.github/workflows/${destination}`))
        result = file(`.github/workflows/${destination}`, bytes);
      else if (endpoint.includes("contents/.github/workflows/application-update-wake.yml"))
        result = file(".github/workflows/application-update-wake.yml", wakeBytes);
      else if (endpoint === `${base}/actions/runs/42`) result = ownRun;
      else if (endpoint === `${base}/actions/runs/42/attempts/1/jobs?per_page=100`)
        result = {
          total_count: 1,
          jobs: [
            {
              id: 77,
              name: "Wake fixed application controller",
              run_id: 42,
              run_attempt: 1,
              head_sha: env.GITHUB_SHA,
              status: "in_progress",
              started_at: created,
            },
          ],
        };
      else if (endpoint === `${base}/actions/runs/900`)
        result = wrongActor
          ? { ...actualRun(), actor: { id: 99 } }
          : actualRun(prior.length ? "41" : "42");
      else if (endpoint.includes("actions/workflows/application-update-wake.yml/runs?"))
        result = { total_count: 1 + prior.length, workflow_runs: [ownRun, ...prior] };
      else if (
        native &&
        endpoint.includes("application-release.yml/runs?branch=main&event=workflow_dispatch")
      ) {
        const runs = qualificationAttempt === 0 ? [] : [qualificationRun()];
        result = { total_count: runs.length, workflow_runs: runs };
      } else if (native && endpoint === `${base}/actions/runs/23`) result = qualificationRun();
      else if (
        native &&
        endpoint === `${base}/actions/runs/23/attempts/${qualificationAttempt}/jobs?per_page=100`
      ) {
        const jobs = [
          ...qualification!.jobs.jobs,
          ...[
            "selection",
            "dependency-review",
            "package_qualification / package",
            "package_qualification / provenance",
          ].map((name, index) => ({ ...qualification!.jobs.jobs[0]!, id: 99 + index, name })),
        ].map((job) => ({ ...job, run_id: 23, run_attempt: qualificationAttempt }));
        result = { total_count: jobs.length, jobs };
      } else if (native && endpoint === `${base}/actions/runs/23/artifacts?per_page=100`) {
        const artifacts = missingQualificationPlan
          ? []
          : [
              {
                id: 3,
                name: `validation-plan-qualification-23-${qualificationAttempt}`,
                digest: `sha256:${hash(qualificationArchive)}`,
                size_in_bytes: qualificationArchive.length,
                expired: false,
                workflow_run: { id: 23, head_sha: env.GITHUB_SHA, repository_id: 1354613114 },
              },
            ];
        result = { total_count: artifacts.length, artifacts };
      } else if (endpoint.includes(`actions/workflows/${destination}/runs?`))
        result = { total_count: recovered.length, workflow_runs: recovered };
      else if (endpoint.includes("/actions/runs/41/attempts/1/jobs"))
        result = {
          total_count: 1,
          jobs: [
            {
              name: "Wake fixed application controller",
              run_id: 41,
              run_attempt: 1,
              head_sha: env.GITHUB_SHA,
              status: "completed",
              steps: [
                {
                  name: "Dispatch retained immutable controller intent",
                  status: "completed",
                  conclusion: skipped ? "skipped" : "failure",
                },
              ],
            },
          ],
        };
      else if (endpoint === `${base}/actions/artifacts/1`)
        result = {
          id: 1,
          name: "controller-wake-intent-42-1",
          digest: `sha256:${hash(archive)}`,
          expired: false,
          size_in_bytes: archive.length,
          workflow_run: {
            id: 42,
            repository_id: 1354613114,
            head_repository_id: 1354613114,
            head_sha: env.GITHUB_SHA,
          },
        };
      else if (endpoint === `${base}/actions/runs/41/artifacts?per_page=100`)
        result = {
          total_count: 1,
          artifacts: [
            { id: 2, name: "controller-wake-intent-41-1", digest: `sha256:${hash(priorArchive)}` },
          ],
        };
      else if (endpoint === `${base}/actions/artifacts/2`)
        result = {
          id: 2,
          name: "controller-wake-intent-41-1",
          digest: `sha256:${hash(priorArchive)}`,
          expired: false,
          size_in_bytes: priorArchive.length,
          workflow_run: {
            id: 41,
            repository_id: 1354613114,
            head_repository_id: 1354613114,
            head_sha: env.GITHUB_SHA,
          },
        };
      else throw new Error(`unexpected route ${endpoint}`);
      return { status: 200, headers: new Map<string, string>(), body: result };
    },
  };
  const get = (route: string) => transport.request("GET", `${base}${route}`).body;
  const api: WakeProvider = {
    repository: async () => get(""),
    run: async (id, retain) => {
      const body = get(`/actions/runs/${id}`);
      await retain?.({ status: 200, body });
      return body;
    },
    jobs: async (id, attempt = 1) =>
      get(`/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`),
    ref: async (name) => get(`/git/ref/${name}`),
    file: async (filename, revision) => get(`/contents/${filename}?ref=${revision}`),
    runs: async (workflow, filters, page) =>
      get(
        `/actions/workflows/${workflow}/runs?${new URLSearchParams({ ...filters, per_page: "100", page: String(page) }).toString()}`,
      ),
    artifacts: async (id) => get(`/actions/runs/${id}/artifacts?per_page=100`),
    artifact: async (id) => get(`/actions/artifacts/${id}`),
    dispatch: async (workflow, body, retain) => {
      const response = transport.request(
        "POST",
        `${base}/actions/workflows/${workflow}/dispatches`,
        body,
      );
      await retain?.(response);
      return response;
    },
  };
  const record = async (phase: string, evidence: unknown) => {
    records.push({ phase, evidence });
  };
  return {
    config,
    env,
    calls,
    records,
    api,
    record,
    actualRun,
    async prepare() {
      const result = await wakeRatifiedController(config, env, api, record, {
        mode: "prepare",
        download: () => qualificationArchive,
      });
      assert.equal(result.decision, "intent-prepared-only");
      assert.ok("intent" in result);
      archive = createAuditZip([
        ["controller-wake-intent.json", Buffer.from(JSON.stringify(result.intent) + "\n")],
      ]);
    },
    dispatch() {
      return wakeRatifiedController(config, env, api, record, {
        mode: "dispatch",
        artifact: { id: 1, sha256: hash(archive) },
        directory: process.cwd(),
        download: (endpoint) => {
          if (endpoint.includes("/artifacts/3/")) return qualificationArchive;
          downloadCalls++;
          return endpoint.includes("/artifacts/2/") ? priorArchive : archive;
        },
      });
    },
    downloads: () => downloadCalls,
    removeQualificationPlan: () => {
      missingQualificationPlan = true;
    },
    qualificationAttempt: (attempt: number) => {
      qualificationAttempt = attempt;
    },
    tamperIntent: () => {
      archive = createAuditZip([["controller-wake-intent.json", "{}\n"]]);
    },
    changeRef: () => {
      changed = true;
    },
    badDigest: () => {
      corrupt = true;
    },
    privateRepo: () => {
      privateRepo = true;
    },
    status: (status: number | null) => {
      postStatus = status;
    },
    wrongActor: () => {
      wrongActor = true;
    },
    priorFailure: () => {
      prior = [{ ...ownRun, id: 41, run_number: 41, status: "completed", conclusion: "failure" }];
    },
    priorSuccess: (changes: Record<string, unknown> = {}) => {
      prior = [{ ...ownRun, id: 41, run_number: 41, status: "completed", conclusion: "success" }];
      const selected = inspectControllerWakeConfiguration({ ...config, ...changes });
      const intent = {
        schema_version: 1,
        controller: selected,
        endpoint: `${base}/actions/workflows/application-update-production.yml/dispatches`,
        body: {
          ref: selected.execution_ref.slice("refs/tags/".length),
          inputs: { wake_run_id: "41" },
          return_run_details: true,
        },
        wake_run_id: "41",
        wake_revision: env.GITHUB_SHA,
      };
      priorArchive = createAuditZip([
        ["controller-wake-intent.json", Buffer.from(JSON.stringify(intent) + "\n")],
      ]);
    },
    pausePublication: () => {
      publicationPaused = true;
    },
    nativeHistory: (...rows: Record<string, unknown>[]) => {
      recovered = rows;
    },
    recovered: () => {
      recovered = [actualRun("41")];
    },
    skipped: () => {
      skipped = true;
    },
  };
}

void test("native wake dispatches one fixed release prepare with the exact qualification attempt", async () => {
  const f = nativeFixture(true, true);
  await f.prepare();
  assert.equal((await f.dispatch()).decision, "dispatch-acknowledged-only");
  const writes = f.calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.body, {
    ref: "portcove-production-controller-windows-fixture",
    inputs: {
      mode: "prepare",
      opportunity: f.env.GITHUB_SHA,
      qualification_run: "23",
      qualification_attempt: "1",
      wake_run_id: "42",
    },
    return_run_details: true,
  });
});

void test("native wake refuses to dispatch a retained intent after the qualification is rerun", async () => {
  const f = nativeFixture(true, true);
  await f.prepare();
  f.qualificationAttempt(2);
  await assert.rejects(f.dispatch(), /intent/u);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});

void test("native wake with no current-main qualification leaves no dispatch intent", async () => {
  const f = nativeFixture(true, true);
  f.qualificationAttempt(0);
  const result = await wakeRatifiedController(f.config, f.env, f.api, f.record, {
    mode: "prepare",
  });
  assert.equal(result.decision, "no-intent");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(
    f.records.some(({ phase }) => phase === "dispatch-intent"),
    false,
  );
});

void test("native wake refuses aggregate success without the retained qualification plan", async () => {
  const f = nativeFixture(true, true);
  f.removeQualificationPlan();
  await assert.rejects(f.prepare());
  assert.equal(
    f.records.some(({ phase }) => phase === "dispatch-intent"),
    false,
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});

void test("native wake holds before qualification lookup without active production appointment", async () => {
  const f = nativeFixture(true, true);
  f.env.PORTCOVE_APPLICATION_RELEASE_ACTIVE = "false";
  const result = await wakeRatifiedController(f.config, f.env, f.api, f.record, {
    mode: "prepare",
  });
  assert.equal(result.decision, "no-intent");
  assert.equal(
    f.calls.some(({ endpoint }) => endpoint.includes("application-release.yml/runs?")),
    false,
  );
  assert.equal(
    f.calls.some(({ method }) => method === "POST"),
    false,
  );
});

void test("native wake refuses changed source, spending or activation before dispatch", async () => {
  for (const change of [
    { PORTCOVE_APPLICATION_RELEASE_REVISION: "c".repeat(40) },
    { PORTCOVE_APPLICATION_RELEASE_REF: "refs/tags/other" },
    { PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256: "d".repeat(64) },
    { PORTCOVE_APPLICATION_RELEASE_SPENDING: "{}" },
    { PORTCOVE_APPLICATION_RELEASE_ACTIVE: "false" },
  ]) {
    const f = nativeFixture(true, true);
    await f.prepare();
    Object.assign(f.env, change);
    await assert.rejects(f.dispatch());
    assert.equal(
      f.calls.some(({ method }) => method === "POST"),
      false,
    );
  }
});

void test("native wake counts existing production once and rejects duplicate or foreign inventory rows", async () => {
  const f = nativeFixture(true, true);
  const row = f.actualRun();
  f.nativeHistory(row);
  assert.equal(
    (await wakeRatifiedController(f.config, f.env, f.api, f.record, { mode: "prepare" })).decision,
    "no-intent",
  );
  for (const invalid of [row, { ...row, id: 901, head_repository: { id: 99 } }]) {
    f.nativeHistory(row, invalid);
    await assert.rejects(f.prepare(), /inventory identity/u);
  }
  assert.equal(
    f.calls.some(({ method }) => method === "POST"),
    false,
  );
});

void test("native wake leaves no intent during publication pause and refuses a pause after retention", async () => {
  const paused = nativeFixture(true, true);
  paused.pausePublication();
  const result = await wakeRatifiedController(
    paused.config,
    paused.env,
    paused.api,
    paused.record,
    { mode: "prepare" },
  );
  assert.equal(result.decision, "no-intent");
  assert.equal(
    paused.calls.some(({ endpoint }) => endpoint.includes("application-release.yml/runs?")),
    false,
  );
  const retained = nativeFixture(true, true);
  await retained.prepare();
  retained.pausePublication();
  await assert.rejects(retained.dispatch(), /selection changed/u);
  assert.equal(
    retained.calls.some(({ method }) => method === "POST"),
    false,
  );
});
