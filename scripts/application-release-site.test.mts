import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import {
  failedBootstrapRecovery,
  immutableApplicationBootstrap,
} from "./application-release-run.mts";
import {
  executeBootstrapPages,
  createApplicationFeedReader,
  readApplicationPagesStateAsync,
  readActualApplicationPagesState,
  assertBootstrapPagesActor,
  readApplicationPagesExecution,
} from "./application-release-site.mts";

const control = "a".repeat(40);
const body = {
  schema_version: 2,
  application_root_sha256: "b".repeat(64),
  catalog_root_sha256: null,
  previous_generation: null,
  files: [
    { path: ".nojekyll", bytes: 0, sha256: "c".repeat(64) },
    { path: "application/metadata/timestamp.json", bytes: 1, sha256: "d".repeat(64) },
  ],
};
const site = { ...body, generation: digest(body) };
function fixture(
  mode = "valid",
  prior = false,
  desired = false,
  ordinary = false,
  continuation = false,
) {
  const next = { ...body, previous_generation: "f".repeat(64) };
  const targetSite = ordinary ? { ...next, generation: digest(next) } : site;
  const events: string[] = [];
  let window = true,
    actor = 1,
    polls = 0;
  const provider = createPagesProviderTransport({
    token: async () => {
      events.push("OIDC");
      if (mode === "token-failure") throw new Error("OIDC unavailable");
      return "inert-token";
    },
    operations: {
      async create(input) {
        events.push("POST");
        assert.deepEqual(input, {
          artifact_id: 42,
          pages_build_version: continuation ? "9".repeat(64) : targetSite.generation,
          oidc_token: "inert-token",
        });
        if (mode === "lost-ack") throw new Error("ambiguous provider response");
        return {
          status: 200,
          body: {
            id: continuation ? "new-native-id" : targetSite.generation,
            status_url: `https://api.github.com/repos/boburning/portcove/pages/deployments/${continuation ? "new-native-id" : targetSite.generation}`,
            page_url: "https://boburning.github.io/portcove/",
          },
        };
      },
      async observe(id) {
        events.push("GET");
        polls++;
        if (continuation && id === "original-native-id") {
          if (mode === "auth-failure") return { status: 403, body: null };
          const status =
            mode === "cancel-race"
              ? polls === 1
                ? "deployment_in_progress"
                : "succeed"
              : mode === "cancelled"
                ? polls === 1
                  ? "deployment_in_progress"
                  : "deployment_cancelled"
                : mode === "still-pending"
                  ? "deployment_in_progress"
                  : mode === "terminal"
                    ? "deployment_failed"
                    : "";
          return { status: 200, body: { status } };
        }
        assert.equal(id, continuation ? "new-native-id" : targetSite.generation);
        if (mode === "new-exhausted")
          return {
            status: 200,
            body: {
              status: events.includes("cancel-new") ? "cancelled" : "deployment_in_progress",
            },
          };
        if (mode === "missing") throw new Error("unknown deployment outcome");
        return {
          status: 200,
          body: {
            status:
              mode === "failed"
                ? "deployment_failed"
                : mode === "pending" && polls < 3
                  ? "deployment_in_progress"
                  : "succeed",
          },
        };
      },
      async cancel(id) {
        if (mode === "new-exhausted") {
          assert.equal(id, "new-native-id");
          events.push("cancel-new");
          return { status: 204, body: null };
        }
        assert.equal(id, "original-native-id");
        events.push("cancel");
        return { status: 404, body: null };
      },
    },
  });
  const run = () =>
    executeBootstrapPages(
      {
        artifact_id: 42,
        control_commit: control,
        site: targetSite,
        ...(prior
          ? {
              prior_effect: {
                identity: {
                  artifact_id: 12,
                  controller_revision: control,
                  generation: mode === "changed" ? "f".repeat(64) : targetSite.generation,
                  id: continuation ? "original-native-id" : targetSite.generation,
                },
                qualified_native_id: continuation && !["opaque", "new-exhausted"].includes(mode),
                ...(continuation
                  ? {
                      continuation: {
                        build_version: "9".repeat(64),
                        async beforeCancel() {
                          events.push("cancel-guard");
                        },
                      },
                    }
                  : {}),
              },
            }
          : {}),
        preimage: desired
          ? continuation
            ? "recovery-visible"
            : "desired"
          : ordinary
            ? "prior"
            : "initial",
      },
      {
        provider,
        ...(mode === "new-exhausted"
          ? {
              async beforeCancelNewEffect() {
                events.push("cancel-new-guard");
              },
            }
          : {}),
        async beforeWrite() {
          events.push("guard");
          if (mode === "paused") throw new Error("paused");
          return () => {
            events.push("fresh");
            assert.ok(window, "original60s receipt expired");
          };
        },
        async assertPreimage() {
          events.push("preimage");
          if (mode === "preimage-drift") throw new Error("previous feed changed");
          if (mode === "expired") window = false;
        },
        async publicReadback() {
          events.push("public");
          if (mode === "wrong-bytes") throw new Error("public bytes differ");
          if (mode === "actor-drift") actor++;
          return { generation: targetSite.generation, evidence_sha256: "e".repeat(64) };
        },
        async providerReadback() {
          events.push("actor");
          return { id: actor };
        },
        async wait() {
          events.push("wait");
        },
      },
    );
  return { events, run };
}

void test("bootstrap Pages final guard runs after OIDC and preimage I/O immediately before the sole POST", async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(f.events.slice(0, 5), ["OIDC", "guard", "preimage", "fresh", "POST"]);
  assert.equal(f.events.filter((e) => e === "POST").length, 1);
  assert.equal(result.resolution, "new-effect");
  assert.deepEqual(f.events.slice(-3), ["actor", "public", "actor"]);
});

void test("ordinary prior-site deployment preserves post-OIDC guards and uncertain-outcome observation only", async () => {
  const valid = fixture("valid", false, false, true);
  assert.equal((await valid.run()).resolution, "new-effect");
  assert.deepEqual(valid.events.slice(0, 5), ["OIDC", "guard", "preimage", "fresh", "POST"]);
  for (const mode of ["preimage-drift", "expired"]) {
    const refused = fixture(mode, false, false, true);
    await assert.rejects(refused.run());
    assert.equal(refused.events.includes("POST"), false);
  }
  const uncertain = fixture("missing", true, false, true);
  await assert.rejects(uncertain.run());
  assert.equal(uncertain.events.includes("POST"), false);
  const lost = fixture("lost-ack", false, false, true);
  assert.equal((await lost.run()).resolution, "recovered-ambiguous-effect");
  assert.equal(lost.events.filter((event) => event === "POST").length, 1);
});

void test("prior Pages discovery checks the original feed attempt and refuses replayed deployment chronology", async () => {
  const ref = "portcove-production-controller-windows-fixture";
  const state = {
    deployment_id: 10,
    source_commit: site.generation,
    ref,
    environment: "github-pages",
    status_id: 20,
    log_url: "https://github.com/boburning/portcove/actions/runs/123/job/456",
    pages: {
      html_url: "https://boburning.github.io/portcove/",
      build_type: "workflow",
      cname: null,
      https_enforced: true,
    },
  };
  const repo = { id: 1354613114, full_name: "boburning/portcove" };
  const fixture = () => {
    const job = {
      id: 456,
      run_id: 123,
      run_attempt: 1,
      name: "feed",
      status: "completed",
      conclusion: "success",
      head_sha: control,
      started_at: "2026-11-04T12:00:00Z",
      completed_at: "2026-11-04T12:01:00Z",
    };
    const run = {
      id: 123,
      run_attempt: 1,
      head_sha: control,
      path: ".github/workflows/application-release.yml",
      event: "workflow_dispatch",
      repository: repo,
      head_repository: repo,
      head_branch: ref,
    };
    const deployment = {
      id: 10,
      environment: "github-pages",
      sha: site.generation,
      ref,
      created_at: "2026-11-04T12:00:10Z",
    };
    const status = {
      id: 20,
      state: "success",
      log_url: state.log_url,
      created_at: "2026-11-04T12:00:40Z",
    };
    const calls: string[] = [];
    const replies: Record<string, unknown> = {
      "actions/jobs/456": job,
      "actions/runs/123/attempts/1": run,
      "deployments/10": deployment,
      "deployments/10/statuses?per_page=1": [status],
      pages: state.pages,
      "deployments?environment=github-pages&per_page=1": [deployment],
    };
    const read = async (endpoint: string) => {
      const suffix = endpoint.replace(/^repos\/boburning\/portcove\//u, "");
      assert.ok(Object.hasOwn(replies, suffix), suffix);
      calls.push(suffix);
      return {
        status: 200,
        headers: new Map<string, string>(),
        body: structuredClone(replies[suffix]),
      };
    };
    return { job, run, deployment, status, calls, read };
  };
  const positive = fixture();
  const result = await readApplicationPagesExecution(positive.read, state);
  assert.deepEqual(result.run, {
    id: "123",
    control_commit: control,
    control_ref: `refs/tags/${ref}`,
  });
  assert.equal(result.authority, "none");
  assert.ok(positive.calls.includes("actions/runs/123/attempts/1"));
  const failedReadback = fixture();
  failedReadback.job.conclusion = "failure";
  const recoveredActor = await readApplicationPagesExecution(failedReadback.read, state);
  assert.equal(recoveredActor.conclusion, "failure");
  assert.equal(recoveredActor.authority, "none");
  assert.equal(recoveredActor.deployment_created_at, failedReadback.deployment.created_at);

  const actionsState = { ...state, source_commit: control };
  const admission = () => {
    const f = fixture();
    Object.assign(f.job, { html_url: state.log_url, head_branch: ref });
    Object.assign(f.run, {
      status: "completed",
      run_started_at: "2026-11-04T11:59:00Z",
      updated_at: "2026-11-04T12:02:00Z",
    });
    Object.assign(f.deployment, {
      sha: control,
      created_at: "2026-11-04T11:59:55Z",
      task: "deploy",
      payload: {},
      performed_via_github_app: { id: 15368, slug: "github-actions" },
    });
    Object.assign(f.status, {
      created_at: "2026-11-04T12:01:01Z",
      target_url: state.log_url,
      environment: "github-pages",
      deployment_url: "https://api.github.com/repos/boburning/portcove/deployments/10",
    });
    return f;
  };
  const actions = admission();
  const settled = await readApplicationPagesExecution(actions.read, actionsState);
  assert.equal(settled.deployment_created_at, actions.deployment.created_at);
  assert.equal(settled.deployed_at, actions.status.created_at);
  const recovery = admission();
  Object.assign(recovery.job, {
    completed_at: "2026-11-04T12:10:00Z",
    steps: [
      {
        name: "Reconcile initial application Pages deployment",
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  Object.assign(recovery.run, { status: "in_progress" });
  Object.assign(recovery.status, { created_at: "2026-11-04T12:10:01Z" });
  const current = { run_id: "123", run_attempt: 1, source: control, ref: `refs/tags/${ref}` };
  assert.equal(
    (await readApplicationPagesExecution(recovery.read, actionsState, current)).conclusion,
    "success",
  );
  await assert.rejects(readApplicationPagesExecution(recovery.read, actionsState));
  await assert.rejects(
    readApplicationPagesExecution(recovery.read, actionsState, { ...current, run_attempt: 2 }),
  );
  Object.assign(recovery.run, { status: "completed", updated_at: "2026-11-04T12:11:00Z" });
  assert.equal(
    (await readApplicationPagesExecution(recovery.read, actionsState)).conclusion,
    "success",
  );
  for (const mutate of [
    (f: ReturnType<typeof admission>) => Object.assign(f.job, { conclusion: "failure" }),
    (f: ReturnType<typeof admission>) => Object.assign(f.job, { head_branch: "main" }),
    (f: ReturnType<typeof admission>) =>
      Object.assign(f.deployment, { performed_via_github_app: null }),
    (f: ReturnType<typeof admission>) =>
      Object.assign(f.deployment, { payload: { replayed: true } }),
    (f: ReturnType<typeof admission>) =>
      Object.assign(f.status, { target_url: "https://github.com/other" }),
    (f: ReturnType<typeof admission>) =>
      Object.assign(f.run, { run_started_at: "2026-11-04T11:59:56Z" }),
    (f: ReturnType<typeof admission>) =>
      Object.assign(f.run, { updated_at: "2026-11-04T12:01:00Z" }),
  ]) {
    const negative = admission();
    mutate(negative);
    await assert.rejects(readApplicationPagesExecution(negative.read, actionsState));
  }

  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.job.name = "publication";
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.conclusion = "cancelled";
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.head_sha = "f".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.head_repository = { ...repo, id: 1 };
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.head_branch = "main";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.path = ".github/workflows/other.yml";
    },
    (f: ReturnType<typeof fixture>) => {
      f.deployment.created_at = "2026-11-04T12:02:00Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.created_at = "2026-11-04T12:02:00Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.deployment.created_at = "2026-11-04T11:59:59Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.completed_at = "2026-11-04T12:03:00Z";
    },
  ]) {
    const negative = fixture();
    mutate(negative);
    await assert.rejects(readApplicationPagesExecution(negative.read, state));
  }
});
void test("pause, missing OIDC, expired original receipt and changed public preimage cause zero Pages mutations", async () => {
  for (const mode of ["paused", "token-failure", "expired", "preimage-drift"]) {
    const f = fixture(mode);
    await assert.rejects(f.run());
    assert.equal(f.events.includes("POST"), false);
  }
});
void test("prior feed execution and ambiguous POST recover by observation only; absent recovery never reposts", async () => {
  const prior = fixture("valid", true);
  const result = await prior.run();
  assert.equal(result.resolution, "recovered-original-effect");
  assert.equal(prior.events.includes("OIDC"), false);
  assert.equal(prior.events.includes("POST"), false);
  const ambiguous = fixture("lost-ack");
  assert.equal((await ambiguous.run()).resolution, "recovered-ambiguous-effect");
  assert.equal(ambiguous.events.filter((e) => e === "POST").length, 1);
  const missing = fixture("missing", true);
  await assert.rejects(missing.run());
  assert.equal(missing.events.includes("POST"), false);
  const desired = fixture("valid", true, true);
  assert.equal((await desired.run()).resolution, "already-public");
  assert.equal(desired.events.includes("OIDC"), false);
  assert.equal(desired.events.includes("GET"), false);
});
void test("pending status is bounded, terminal failure cannot succeed, and public bytes/actor are both mandatory", async () => {
  const pending = fixture("pending");
  await pending.run();
  assert.equal(pending.events.filter((e) => e === "wait").length, 2);
  for (const mode of ["failed", "wrong-bytes", "actor-drift"]) {
    const f = fixture(mode);
    await assert.rejects(f.run());
    assert.equal(f.events.filter((e) => e === "POST").length, 1);
  }
});

void test("one appointed identical continuation retains unknown, cancelled or terminal history", async () => {
  for (const [mode, outcome] of [
    ["opaque", "unknown"],
    ["cancelled", "cancelled"],
    ["terminal", "terminal"],
  ]) {
    const f = fixture(mode, true, false, false, true);
    const result = await f.run();
    assert.equal(result.resolution, "continued-identical-effect");
    assert.equal(result.prior_outcome, outcome);
    assert.equal(result.native_deployment_id, "new-native-id");
    assert.equal(f.events.filter((event) => event === "POST").length, 1);
    assert.equal(f.events.includes("cancel"), mode === "cancelled");
  }
});

void test("an exhausted acknowledged continuation cancels only its returned native operation", async () => {
  const f = fixture("new-exhausted", true, false, false, true);
  await assert.rejects(f.run(), /did not settle successfully/u);
  assert.equal(f.events.filter((event) => event === "POST").length, 1);
  assert.deepEqual(
    f.events.filter((event) => event.startsWith("cancel")),
    ["cancel-new-guard", "cancel-new"],
  );
  assert.ok(!f.events.includes("public"));
});

void test("a cancellation race adopts success, while pending, changed content and expiry refuse", async () => {
  const raced = fixture("cancel-race", true, false, false, true);
  assert.equal((await raced.run()).resolution, "recovered-original-effect");
  assert.ok(raced.events.includes("cancel"));
  assert.ok(raced.events.includes("public"));
  assert.ok(!raced.events.includes("POST"));
  for (const mode of ["still-pending", "changed", "expired", "auth-failure"]) {
    const f = fixture(mode, true, false, false, true);
    await assert.rejects(f.run());
    assert.ok(!f.events.includes("POST"));
  }
  const visible = fixture("cancel-race", true, true, false, true);
  assert.equal((await visible.run()).resolution, "recovered-original-effect");
  const unconfirmed = fixture("opaque", true, true, false, true);
  await assert.rejects(unconfirmed.run());
  assert.ok(!unconfirmed.events.includes("POST"));
});
void test("Pages actor projection binds latest successful deployment, fixed repository settings, ref and registered run", async () => {
  const ref = "portcove-production-controller-windows-fixture";
  const replies = [
    {
      html_url: "https://boburning.github.io/portcove/",
      build_type: "workflow",
      cname: null,
      https_enforced: true,
    },
    [{ id: 10, sha: site.generation, ref, environment: "github-pages" }],
    [
      {
        id: 20,
        state: "success",
        log_url: "https://github.com/boburning/portcove/actions/runs/123/job/456",
      },
    ],
  ];
  const state = await readApplicationPagesStateAsync(async () => ({
    status: 200,
    headers: new Map(),
    body: replies.shift(),
  }));
  const runs = [{ id: "123", control_commit: control, control_ref: `refs/tags/${ref}` }];
  assert.doesNotThrow(() => assertBootstrapPagesActor(state, site.generation, runs));
  const retainedBootstrapRuns = [
    ...["119", "120", "121", "122"].map((id) => ({ ...runs[0]!, id })),
    ...runs,
  ];
  assert.doesNotThrow(() =>
    assertBootstrapPagesActor(state, site.generation, retainedBootstrapRuns),
  );
  assert.throws(() =>
    assertBootstrapPagesActor(state, site.generation, retainedBootstrapRuns.slice(0, -1)),
  );

  for (const change of [
    { source_commit: "f".repeat(40) },
    { ref: "main" },
    { log_url: "https://github.com/boburning/portcove/actions/runs/999/job/456" },
  ])
    assert.throws(() => assertBootstrapPagesActor({ ...state, ...change }, site.generation, runs));
});

void test("actual Pages observation aborts a stalled first response at the inherited deadline", async (t) => {
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-pages-observation";
  t.after(() => {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  });
  // Keep package initialization outside the deadline used to test body cancellation.
  await createApplicationFeedReader("inert-pages-observation", performance.now() + 5000);
  let calls = 0;
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://api.github.com/repos/boburning/portcove/pages");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token inert-pages-observation");
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("{"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 500, () =>
      readActualApplicationPagesState(performance.now() + 5000),
    ),
    { code: "deadline_exceeded" },
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

void test("the exact feed tag route retains uppercase SemVer metadata", async (t) => {
  const tag = "v1.2.3-beta.Build+Commit";
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(
        request.url,
        `https://api.github.com/repos/boburning/portcove/git/ref/tags/${tag}`,
      );
      assert.equal(request.headers.get("authorization"), "token inert-feed-tag");
      calls++;
      return Response.json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: control } });
    },
  );
  const read = await createApplicationFeedReader("inert-feed-tag", performance.now() + 5000);
  assert.deepEqual((await read(`repos/boburning/portcove/git/ref/tags/${tag}`)).body, {
    ref: `refs/tags/${tag}`,
    object: { type: "commit", sha: control },
  });
  assert.equal(calls, 1);
});

void test("feed selects the serving actor only behind its exact active Actions admission", async () => {
  const tag = "portcove-production-controller-windows-fixture";
  const logUrl = "https://github.com/boburning/portcove/actions/runs/123/job/456";
  const current = { source: control, ref: `refs/tags/${tag}`, run_id: "123", run_attempt: 2 };
  const own = {
    id: 17,
    sha: control,
    ref: tag,
    environment: "github-pages",
    task: "deploy",
    payload: {},
    performed_via_github_app: { slug: "github-actions" },
  };
  const old = { id: 10, sha: site.generation, ref: "prior", environment: "github-pages" };
  const status = { id: 18, state: "in_progress", environment: "github-pages", log_url: logUrl };
  const job = {
    id: 456,
    run_id: 123,
    run_attempt: 2,
    head_sha: control,
    head_branch: tag,
    name: "feed",
    status: "in_progress",
    html_url: logUrl,
  };
  const responses = {
    pages: {
      html_url: "https://boburning.github.io/portcove/",
      build_type: "workflow",
      cname: null,
      https_enforced: true,
    },
    "deployments?environment=github-pages&per_page=2": [own, old],
    "deployments?environment=github-pages&per_page=1": [own],
    "deployments/17/statuses?per_page=1": [status],
    "deployments/10/statuses?per_page=1": [{ ...status, id: 11, state: "success" }],
    "actions/jobs/456": job,
  };
  const read =
    (overrides: Record<string, unknown> = {}) =>
    async (endpoint: string) => {
      const route = endpoint.replace("repos/boburning/portcove/", "");
      const available: Record<string, unknown> = { ...responses, ...overrides };
      assert.ok(Object.hasOwn(available, route), route);
      return { status: 200, headers: new Map(), body: available[route] };
    };
  const serving = { ...current, selection: "serving" as const };
  const active = { ...current, selection: "current" as const, deployment_id: own.id };
  assert.equal((await readApplicationPagesStateAsync(read(), serving)).deployment_id, old.id);
  assert.equal((await readApplicationPagesStateAsync(read(), active)).deployment_id, own.id);
  const original = immutableApplicationBootstrap;
  const failed = [failedBootstrapRecovery, { ...original, ...original.assembly }];
  const failedDeployments = failed.map((execution) => ({
    id: execution.admission_id,
    sha: execution.control_commit,
    ref: execution.control_ref.slice("refs/tags/".length),
    environment: "github-pages",
  }));
  const failedStatuses = Object.fromEntries(
    failed.map((execution) => [
      `deployments/${execution.admission_id}/statuses?per_page=1`,
      [
        {
          id: execution.failed_admission_status_id,
          state: "failure",
          log_url: `https://github.com/boburning/portcove/actions/runs/${execution.run_id}/job/${execution.feed_job_id}`,
        },
      ],
    ]),
  );
  const recoveryResponses = {
    ...failedStatuses,
    "deployments?environment=github-pages&per_page=3": [...failedDeployments, old],
    "deployments?environment=github-pages&per_page=4": [own, ...failedDeployments, old],
  };
  assert.equal(
    (await readApplicationPagesStateAsync(read(recoveryResponses), undefined, true)).deployment_id,
    old.id,
  );
  assert.equal(
    (await readApplicationPagesStateAsync(read(recoveryResponses), serving, true)).deployment_id,
    old.id,
  );
  await assert.rejects(
    readApplicationPagesStateAsync(
      read({
        ...recoveryResponses,
        "deployments?environment=github-pages&per_page=4": [
          own,
          ...failedDeployments.toReversed(),
          old,
        ],
      }),
      serving,
      true,
    ),
  );
  const catalog = { ...serving, role: "site-publication" as const, job_id: job.id };
  const catalogJob = { ...job, name: "Publish authenticated application site" };
  assert.equal(
    (await readApplicationPagesStateAsync(read({ "actions/jobs/456": catalogJob }), catalog))
      .deployment_id,
    old.id,
  );
  await assert.rejects(readApplicationPagesStateAsync(read(), catalog));
  await assert.rejects(
    readApplicationPagesStateAsync(read({ "actions/jobs/456": catalogJob }), {
      ...catalog,
      job_id: job.id + 1,
    }),
  );
  await assert.rejects(
    readApplicationPagesStateAsync(
      read({
        "actions/jobs/456": catalogJob,
        "deployments/10/statuses?per_page=1": [{ ...status, state: "failure" }],
      }),
      catalog,
    ),
  );
  await assert.rejects(readApplicationPagesStateAsync(read()));
  await assert.rejects(
    readApplicationPagesStateAsync(read(), { ...active, deployment_id: old.id }),
  );
  for (const overrides of [
    { "deployments/17/statuses?per_page=1": [{ ...status, state: "failure" }] },
    { "deployments/10/statuses?per_page=1": [{ ...status, state: "failure" }] },
    { "actions/jobs/456": { ...job, run_attempt: 1 } },
    { "actions/jobs/456": { ...job, name: "another-job" } },
    {
      "deployments?environment=github-pages&per_page=2": [
        { ...own, payload: { unexpected: true } },
        old,
      ],
    },
  ])
    await assert.rejects(readApplicationPagesStateAsync(read(overrides), serving));
  assert.equal(
    (
      await readApplicationPagesStateAsync(
        read({
          "deployments/17/statuses?per_page=1": [{ ...status, state: "success" }],
        }),
      )
    ).deployment_id,
    own.id,
  );
});
