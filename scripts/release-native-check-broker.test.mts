import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  inspectNativeIssuerBoundary,
  inspectNativeCheckAttempt,
  publishActualNativePreSignReport,
  prepareNativeCheckTransport,
} from "./release-native-check-broker.mts";
import { inspectSemanticIssuerRequest } from "./release-semantic-issuer-http.mts";
import { runSemanticIssuerSdkRequest } from "./release-semantic-issuer-sdk-http.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { inspectNativeCheckRecoveryPlan } from "./release-native-candidate.mts";
import { bundleSealedCheckSdkIssuer } from "./release-controller-tool-build.mts";

void test("actual broker transport envelope round trips through the existing original-attempt recovery contract", () => {
  const report = nativeQualificationFixture(),
    authorities = nativeAuthorityConfigurationFixture();
  const request = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: report.stage,
      platform_label: report.platform_label,
      candidate: report.candidate,
      journey: report.journey,
      invocation_id: report.producer.invocation_id,
      setup_descriptor_sha256: "a".repeat(64),
    },
    authorities,
  );
  const wire = prepareNativeCheckTransport(report);
  assert.deepEqual(Object.keys(wire).sort(), ["body", "endpoint", "method"]);
  assert.deepEqual(inspectNativeCheckRecoveryPlan(request, wire, authorities).wire.body, wire.body);
  assert.throws(
    () =>
      inspectNativeCheckRecoveryPlan(request, prepareNativeQualificationCheck(report), authorities),
    /original Check request/,
  );
  assert.throws(
    () =>
      inspectNativeCheckRecoveryPlan(
        request,
        { ...wire, endpoint: "repos/other/repository/check-runs" },
        authorities,
      ),
    /original Check request/,
  );
});

void test("native issuer boundary requires the exact isolated App installation and single repository", () => {
  const issuer = { app_id: 102, installation_id: 202 };
  const repo = { id: 1354613114, full_name: "boburning/portcove" };
  const installation = {
    id: 202,
    app_id: 102,
    account: { id: 43177418, login: "boburning" },
    suspended_at: null,
    repository_selection: "selected",
    permissions: { checks: "write", metadata: "read" },
  };
  const input = {
    app: { id: 102 },
    installation,
    repositories: { total_count: 1, repositories: [repo] },
    repository: repo,
  };
  assert.equal(inspectNativeIssuerBoundary(input, issuer).authority, "none");
  for (const changed of [
    { ...input, app: { id: 100 } },
    { ...input, installation: { ...installation, id: 200 } },
    { ...input, installation: { ...installation, suspended_at: "2026-10-20T12:00:00Z" } },
    { ...input, installation: { ...installation, repository_selection: "all" } },
    {
      ...input,
      installation: {
        ...installation,
        permissions: { checks: "write", metadata: "read", contents: "write" },
      },
    },
    { ...input, repositories: { total_count: 2, repositories: [repo] } },
    { ...input, repository: { ...repo, id: 1 } },
  ])
    assert.throws(() => inspectNativeIssuerBoundary(changed, issuer));
});

void test("fixed credential HTTP route binds native exact Check body and forbids other writers or destinations", () => {
  const wire = prepareNativeQualificationCheck(nativeQualificationFixture());
  const request = {
    kind: "installation",
    token: "inert",
    configuration: {
      app_id: 102,
      installation_id: 202,
      head: wire.body.head_sha,
      check_body_sha256: digest(wire.body),
    },
    method: "POST",
    endpoint: "repos/boburning/portcove/check-runs",
    body: wire.body,
  };
  assert.equal(inspectSemanticIssuerRequest(request).endpoint, request.endpoint);
  for (const changed of [
    { ...request, body: { ...wire.body, head_sha: "0".repeat(40) } },
    { ...request, body: { ...wire.body, name: "another check" } },
    { ...request, endpoint: "repos/another/repository/check-runs" },
    { ...request, method: "PATCH" },
    { ...request, endpoint: "repos/boburning/portcove/releases" },
  ])
    assert.throws(() => inspectSemanticIssuerRequest(changed));
});

const successorCheck = prepareNativeQualificationCheck(nativeQualificationFixture()).body;
const successorRequest = {
  kind: "installation",
  token: "inert-check-token",
  configuration: {
    app_id: 102,
    installation_id: 202,
    head: successorCheck.head_sha,
    check_body_sha256: digest(successorCheck),
  },
  method: "POST",
  endpoint: "repos/boburning/portcove/check-runs",
  body: successorCheck,
};

void test("sealed SDK successor preserves fixed bearer routes and complete private HTTP evidence", async () => {
  const app = { ...successorRequest, kind: "app", token: "inert.app.jwt", body: null };
  const installation = { ...successorRequest, method: "GET", body: null };
  const requestCases = [
    { ...app, method: "GET", endpoint: "app" },
    { ...app, method: "GET", endpoint: "app/installations/202" },
    {
      ...app,
      endpoint: "app/installations/202/access_tokens",
      body: { repository_ids: [1354613114], permissions: { checks: "write", metadata: "read" } },
    },
    { ...installation, endpoint: "installation/repositories?per_page=100" },
    { ...installation, endpoint: "repos/boburning/portcove/check-runs/789" },
    {
      ...installation,
      endpoint: `repos/boburning/portcove/commits/${successorCheck.head_sha}/check-suites?app_id=102&per_page=100&page=1`,
    },
    {
      ...installation,
      endpoint:
        "repos/boburning/portcove/check-suites/789/check-runs?check_name=Portcove%20independent%20release%20semantic%20review&filter=all&per_page=100&page=10",
    },
    successorRequest,
  ];
  for (const request of requestCases) {
    const statuses =
      request === successorRequest ? [201, 403, 429, 503] : [request.method === "POST" ? 201 : 200];
    for (const status of statuses) {
      let dispatched = 0;
      const providerBody = { token: "inert-private-pipe-token", nested: { label: "exact" } };
      const expectedHeaders = new Headers({
        "x-github-request-id": "inert-request",
        "x-private-example": "must stay on the private pipe",
        "content-type": "text/plain",
      });
      const result = await runSemanticIssuerSdkRequest(request, {
        transport: async (input, init) => {
          dispatched++;
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${request.token}`);
          assert.equal(headers.get("x-github-api-version"), "2026-03-10");
          assert.equal(headers.get("user-agent"), "portcove-fixed-semantic-broker");
          assert.equal(init?.method, request.method);
          assert.equal(init?.redirect, "error");
          assert.equal(input, `https://api.github.com/${request.endpoint}`);
          assert.equal(
            init?.body,
            request.body === null ? undefined : JSON.stringify(request.body),
          );
          return new Response(JSON.stringify(providerBody), { status, headers: expectedHeaders });
        },
      });
      assert.equal(dispatched, 1);
      assert.deepEqual(result, { status, headers: [...expectedHeaders], body: providerBody });
    }
  }
});

void test("sealed SDK successor refuses changed authority, redirects and unavailable response bytes", async () => {
  let dispatched = 0;
  const transport: typeof fetch = async () => {
    dispatched++;
    throw new Error("not expected to dispatch");
  };
  await assert.rejects(
    runSemanticIssuerSdkRequest(
      { ...successorRequest, body: { ...successorCheck, name: "changed" } },
      { transport },
    ),
    /escaped the fixed broker routes/u,
  );
  assert.equal(dispatched, 0);

  const responses = [
    () =>
      new Response("inert redirect body", {
        status: 302,
        headers: { location: "https://elsewhere.invalid/" },
      }),
    () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 400 }),
    () => new Response("{ malformed inert-check-token", { status: 500 }),
    () => new Response(Uint8Array.of(0xff), { status: 200 }),
    () => new Response(null, { status: 304 }),
  ];
  for (const provider of responses) {
    dispatched = 0;
    await assert.rejects(
      runSemanticIssuerSdkRequest(successorRequest, {
        transport: async () => {
          dispatched++;
          return provider();
        },
      }),
      /^Error: semantic credential HTTP transport failed; reconcile any attempted effect before retry$/u,
    );
    assert.equal(dispatched, 1);
  }

  let cancelled = false;
  // The SDK timeout is unref'ed. Keep the fixture alive until the stalled
  // response is cancelled under the shorter inherited deadline.
  const keepAlive = setTimeout(100);
  await assert.rejects(
    runSemanticIssuerSdkRequest(successorRequest, {
      deadline: performance.now() + 50,
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("{"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    /semantic credential HTTP transport failed/u,
  );
  await keepAlive;
  assert.equal(cancelled, true);
});

void test("sealed SDK successor and isolated bundle preserve the private CLI pipe", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "sealed-check-sdk-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const identity = await bundleSealedCheckSdkIssuer(
    fileURLToPath(new URL("../", import.meta.url)),
    output,
  );
  const bundle = "release-semantic-issuer-sdk-http.bundle.mjs";
  assert.deepEqual(await readdir(output), ["scripts"]);
  assert.deepEqual(await readdir(path.join(output, "scripts")), [bundle]);
  const bytes = await readFile(path.join(output, "scripts", bundle));
  assert.deepEqual(identity, {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const spawn = (entry: string, source: string, input: string) =>
    spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(source)}`, entry],
      {
        cwd: output,
        input,
        encoding: "utf8",
        env: {
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          LANG: "C.UTF-8",
        },
        timeout: 15_000,
      },
    );
  const input = JSON.stringify(successorRequest);
  const exactInput = " ".repeat(128 * 1024 - Buffer.byteLength(input)) + input;
  const ok = `globalThis.fetch = async () => Response.json({ id: 789 }, { status: 201 });`;
  const malformed = `globalThis.fetch = async () => new Response("{ malformed inert-check-token");`;
  for (const entry of [
    fileURLToPath(new URL("./release-semantic-issuer-sdk-http.mts", import.meta.url)),
    path.join(output, "scripts", bundle),
  ]) {
    const success = spawn(entry, ok, exactInput);
    assert.ifError(success.error);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, "");
    assert.deepEqual(JSON.parse(success.stdout), {
      status: 201,
      headers: [["content-type", "application/json"]],
      body: { id: 789 },
    });
    for (const result of [spawn(entry, malformed, input), spawn(entry, ok, " " + exactInput)]) {
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "semantic credential HTTP transport failed; reconcile any attempted effect before retry\n",
      );
    }
  }
});

void test("native handoff recovery preserves original phase and rejects truncated, repeated or changed attempts", async () => {
  const expected = { invocation_id: "a".repeat(64), body_sha256: "b".repeat(64) };
  const line = (phase: string) => JSON.stringify({ schema_version: 1, ...expected, phase }) + "\n";
  assert.equal(inspectNativeCheckAttempt(line("prepared"), expected).post_attempted, false);
  assert.equal(
    inspectNativeCheckAttempt(line("prepared") + line("post-started"), expected).post_attempted,
    true,
  );
  assert.equal(
    inspectNativeCheckAttempt(
      line("prepared") + line("post-started") + line("readback-completed"),
      expected,
    ).readback_completed,
    true,
  );
  for (const raw of [
    "",
    line("prepared").trim(),
    line("post-started"),
    line("prepared") + line("prepared"),
    line("prepared") + line("readback-completed"),
    line("prepared").replace("a".repeat(64), "c".repeat(64)),
  ])
    assert.throws(() => inspectNativeCheckAttempt(raw, expected));
  await assert.rejects(
    publishActualNativePreSignReport({
      ...prepareNativeQualificationCheck(nativeQualificationFixture()),
    }),
    /actual direct native pre-sign report/,
  );
});
