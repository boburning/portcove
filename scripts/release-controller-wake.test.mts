import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
  const api = {
    request(method: string, endpoint: string, body?: unknown) {
      calls.push({ method, endpoint, body });
      let result: unknown;
      if (method === "POST") {
        assert.equal(
          endpoint,
          `${base}/actions/workflows/application-update-production.yml/dispatches`,
        );
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
      else if (endpoint.includes("git/ref/tags/"))
        result = {
          ref: config.execution_ref,
          object: {
            type: "commit",
            sha: changed && calls.length > 4 ? "c".repeat(40) : config.revision,
          },
        };
      else if (endpoint.includes("contents/.github/workflows/application-update-production.yml"))
        result = file(".github/workflows/application-update-production.yml", bytes);
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
      else if (endpoint.includes("actions/workflows/application-update-production.yml/runs?"))
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
    const original = f.api.request.bind(f.api);
    f.api.request = (method, endpoint, body) => {
      const response = original(method, endpoint, body);
      if (endpoint.includes("application-update-wake.yml/runs?")) {
        assert.ok(isRecord(response.body));
        return { ...response, body: { ...response.body, total_count: total } };
      }
      return response;
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
  const original = same.api.request.bind(same.api);
  same.api.request = (method, endpoint, body) => {
    if (method === "POST") throw new Error("stop after authenticated prior boundary");
    return original(method, endpoint, body);
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
  const root = fileURLToPath(new URL("..", import.meta.url)),
    seen = new Set<string>();
  async function visit(filename: string) {
    if (seen.has(filename)) return;
    seen.add(filename);
    const text = await readFile(filename, "utf8");
    for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) continue;
      assert.ok(
        specifier.startsWith("./") && specifier.endsWith(".mts"),
        `external wake dependency ${specifier}`,
      );
      await visit(path.resolve(path.dirname(filename), specifier));
    }
  }
  await visit(path.join(root, "scripts/release-controller-wake.mts"));
  assert.ok(seen.size > 5);
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
    /pnpm install|npm install|^\s+cache:|secrets\.|create-github-app-token/mu,
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
      original = f.api.request.bind(f.api);
    f.api.request = (method, endpoint, body) => {
      const response = original(method, endpoint, body);
      if (endpoint.endsWith("/42/attempts/1/jobs?per_page=100")) {
        assert.ok(isRecord(response.body) && Array.isArray(response.body.jobs));
        assert.ok(isRecord(response.body.jobs[0]));
        return {
          ...response,
          body: { ...response.body, jobs: [{ ...response.body.jobs[0], ...change }] },
        };
      }
      return response;
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
    original = f.api.request.bind(f.api);
  let reads = 0;
  f.api.request = (method, endpoint, body) => {
    const response = original(method, endpoint, body);
    if (endpoint.endsWith("/actions/runs/900") && ++reads === 1)
      return {
        ...response,
        body: { ...f.actualRun(), status: "queued", display_title: "pending title" },
      };
    return response;
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
        request(method, endpoint) {
          assert.equal(method, "GET");
          assert.equal(endpoint, "repos/boburning/portcove/actions/runs/900");
          reads++;
          return {
            status: 200,
            headers: new Map(),
            body: {
              ...f.actualRun(),
              status: "queued",
              display_title: "pending title",
            },
          };
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
    original = f.api.request.bind(f.api);
  f.api.request = (method, endpoint, body) => {
    const response = original(method, endpoint, body);
    if (endpoint.endsWith("/actions/runs/900")) monotonic = 60000;
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
          request(method) {
            assert.equal(method, "GET");
            reads++;
            return { status: 200, headers: new Map(), body };
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
      request() {
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
        request() {
          reads++;
          return {
            status: 200,
            headers: new Map(),
            body: { ...f.actualRun(), status: "queued", display_title: "pending" },
          };
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
