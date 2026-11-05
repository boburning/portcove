import assert from "node:assert/strict";
import test from "node:test";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import {
  executeBootstrapPages,
  readApplicationPagesState,
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
function fixture(mode = "valid", prior = false, desired = false, ordinary = false) {
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
          pages_build_version: targetSite.generation,
          oidc_token: "inert-token",
        });
        if (mode === "lost-ack") throw new Error("ambiguous provider response");
        return {
          status: 200,
          body: {
            id: targetSite.generation,
            status_url: `https://api.github.com/repos/boburning/portcove/pages/deployments/${targetSite.generation}`,
            page_url: "https://boburning.github.io/portcove/",
          },
        };
      },
      async observe(id) {
        events.push("GET");
        polls++;
        assert.equal(id, targetSite.generation);
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
    },
  });
  const run = () =>
    executeBootstrapPages(
      {
        artifact_id: 42,
        control_commit: control,
        site: targetSite,
        prior_feed_execution: prior,
        preimage: desired ? "desired" : ordinary ? "prior" : "initial",
      },
      {
        provider,
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

void test("prior Pages discovery checks the original feed attempt and refuses replayed deployment chronology", () => {
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
      path: ".github/workflows/release.yml",
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
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        const suffix = endpoint.replace(/^repos\/boburning\/portcove\//u, "");
        assert.ok(Object.hasOwn(replies, suffix), suffix);
        calls.push(suffix);
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: structuredClone(replies[suffix]),
        };
      },
    };
    return { job, run, deployment, status, calls, api };
  };
  const positive = fixture();
  const result = readApplicationPagesExecution(positive.api, state);
  assert.deepEqual(result.run, {
    id: "123",
    control_commit: control,
    control_ref: `refs/tags/${ref}`,
  });
  assert.equal(result.authority, "none");
  assert.ok(positive.calls.includes("actions/runs/123/attempts/1"));
  const failedReadback = fixture();
  failedReadback.job.conclusion = "failure";
  const recoveredActor = readApplicationPagesExecution(failedReadback.api, state);
  assert.equal(recoveredActor.conclusion, "failure");
  assert.equal(recoveredActor.authority, "none");
  assert.equal(recoveredActor.deployment_created_at, failedReadback.deployment.created_at);

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
    assert.throws(() => readApplicationPagesExecution(negative.api, state));
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
void test("Pages actor projection binds latest successful deployment, fixed repository settings, ref and registered run", () => {
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
  const state = readApplicationPagesState({
    request(method) {
      assert.equal(method, "GET");
      return { status: 200, headers: new Map(), body: replies.shift() };
    },
  });
  const runs = [{ id: "123", control_commit: control, control_ref: `refs/tags/${ref}` }];
  assert.doesNotThrow(() => assertBootstrapPagesActor(state, site.generation, runs));
  for (const change of [
    { source_commit: "f".repeat(40) },
    { ref: "main" },
    { log_url: "https://github.com/boburning/portcove/actions/runs/999/job/456" },
  ])
    assert.throws(() => assertBootstrapPagesActor({ ...state, ...change }, site.generation, runs));
});
