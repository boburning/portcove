import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectNativeIssuerBoundary,
  inspectNativeCheckAttempt,
  publishActualNativePreSignReport,
  prepareNativeCheckTransport,
} from "./release-native-check-broker.mts";
import { inspectSemanticIssuerRequest } from "./release-semantic-issuer-http.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { inspectNativeCheckRecoveryPlan } from "./release-native-candidate.mts";

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
