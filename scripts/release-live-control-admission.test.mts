import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  config,
  opportunity,
  releaseControlInputsFixture,
} from "./fixtures/release-control-inputs-fixture.mts";
import {
  capacityDocumentFixture,
  liveControlRuntimeFixture,
  protectionFixture,
} from "./fixtures/release-live-control-fixture.mts";
import { persistReviewedClassification } from "./release-control-inputs.mts";
import {
  authenticateReleaseControlSource,
  requireAuthenticatedReleaseControlSource,
} from "./release-live-control-admission.mts";
import { prepareProductionProtectionHandoff } from "./release-input-protections.mts";
import { isRecord } from "./runtime-values.mts";

function fixture(document: unknown = capacityDocumentFixture(), paused = false) {
  const control = releaseControlInputsFixture(document, opportunity, config, paused);
  persistReviewedClassification(control.api, config, opportunity, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(control.head()));
  return { control, runtime };
}

void test("default observer REST path explicitly pins github.com despite ambient GH_HOST", async (t) => {
  const f = fixture();
  const previous = process.env.GH_HOST;
  process.env.GH_HOST = "ambient.invalid";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previous;
  });
  const { observerApi, ...options } = f.runtime.options;
  let requests = 0;
  const source = await authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
    ...options,
    observerTransport: {
      spawn(command, args) {
        requests++;
        assert.equal(command, "gh");
        assert.equal(process.env.GH_HOST, "ambient.invalid");
        assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
        assert.equal(args[0], "api");
        assert.equal(args[args.indexOf("--method") + 1], "GET");
        const endpoint = args.find((arg) => arg.startsWith("repos/boburning/portcove/"));
        assert.ok(endpoint);
        const response = observerApi.request("GET", endpoint);
        return {
          status: 0,
          stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(response.body)}`,
          stderr: "",
        };
      },
    },
  });
  assert.equal(source.read(f.control.api, opportunity).classification.review_check_id, 303);
  assert.ok(requests >= 2);
  assert.equal(source.evidence_scope, "injected-provider");
});

void test("live source establishes fixed runtime and predecessor job then reuses actual classification, pause and capacity readers", async () => {
  const f = fixture();
  const source = await f.runtime.create();
  requireAuthenticatedReleaseControlSource(source);
  assert.equal(source.evidence_scope, "injected-provider");
  const first = source.read(f.control.api, opportunity);
  const second = source.read(f.control.api, opportunity);
  assert.equal(first.facts_sha256, second.facts_sha256);
  assert.equal(first.classification.review_check_id, 303);
  assert.equal(first.pause.publication_paused, false);
  assert.equal(first.capacity_source.report.eligibility, "eligible");
  assert.equal(first.capacity_source.report.availability, "unknown");
  assert.equal(first.capacity_source.report.headroom, "unknown");
  assert.equal(first.capacity_source.report.reservation, "none");
  assert.equal(first.resource_policy_matches_controller, false);
  assert.equal(first.authority, "none");
  assert.equal(f.control.mutations(), 1);
});

void test("a caller Boolean, imported JSON, wrong source/job, cross-run receipt or generic Actions issuer cannot establish controls", async () => {
  for (const raw of [true, { authenticated: true }, { read() {}, evidence_scope: "github.com" }])
    assert.throws(() => requireAuthenticatedReleaseControlSource(raw), /fixed runtime verifier/);
  for (const patch of [
    { GITHUB_JOB: "admission" },
    { GITHUB_REF_PROTECTED: "false" },
    { PORTCOVE_TRUSTED_PROTECTION_OBSERVATION: "{}" },
    { PORTCOVE_REVIEW_PRODUCER: JSON.stringify({ ...config, review_app_id: 15368 }) },
    { PORTCOVE_TRUSTED_PROTECTION_OBSERVATION: undefined },
  ]) {
    const f = fixture();
    await assert.rejects(
      authenticateReleaseControlSource(
        { ...f.runtime.environment, ...patch },
        f.runtime.workflow,
        f.runtime.options,
      ),
    );
  }
  const f = fixture();
  f.runtime.handoff.producer.run_id = "9989";
  f.runtime.environment.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION = JSON.stringify(f.runtime.handoff);
  await assert.rejects(f.runtime.create(), /exact admitted controller attempt/);
  const g = fixture();
  g.runtime.observerJob.name = "Trusted package assembly";
  await assert.rejects(g.runtime.create(), /isolated observer job/);
  const h = fixture();
  await assert.rejects(
    authenticateReleaseControlSource(h.runtime.environment, h.runtime.workflow, {
      ...h.runtime.options,
      requestToken: async () => "wrong-issuer-token",
    }),
  );
});

void test("complete-opportunity changes, semantic wrong issuer and incomplete acceptance refuse without additional writes", async () => {
  for (const fault of ["issuer", "failure", "input", "pr-scope", "report-change", "report-bytes"]) {
    const f = fixture();
    const source = await f.runtime.create();
    f.control.faults.value = fault;
    assert.throws(() => source.read(f.control.api, opportunity));
    assert.equal(f.control.mutations(), 1);
  }
  const f = fixture();
  const source = await f.runtime.create();
  assert.throws(() => source.read(f.control.api, { ...opportunity, urgency: true }));
});

void test("stale protection, late expiry, changed ref and unavailable capacity refuse; a revocation remains an authenticated ineligible input", async () => {
  const f = fixture();
  f.runtime.handoff.observation = protectionFixture(
    f.control.head(),
    new Date(Date.now() - 61000).toISOString(),
  );
  f.runtime.environment.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION = JSON.stringify(f.runtime.handoff);
  await assert.rejects(f.runtime.create(), /fresh authenticated protection/);
  const g = fixture();
  const source = await g.runtime.create();
  g.runtime.advance(61000);
  assert.throws(() => source.read(g.control.api, opportunity), /fresh authenticated protection/);
  const h = fixture();
  const source2 = await h.runtime.create();
  h.control.faults.value = "pause-drift";
  assert.throws(() => source2.read(h.control.api, opportunity));
  const missing = releaseControlInputsFixture();
  persistReviewedClassification(missing.api, config, opportunity, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(missing.head()));
  const missingSource = await runtime.create();
  assert.throws(() => missingSource.read(missing.api, opportunity), /unavailable/);
  const revoked = capacityDocumentFixture();
  revoked.capacity.ratification.active = false;
  const r = fixture(revoked, true);
  const read = (await r.runtime.create()).read(r.control.api, opportunity);
  assert.equal(read.capacity_source.report.eligibility, "ineligible");
  assert.equal(read.pause.publication_paused, true);
});

void test("production handoff serialization is token-free and requires an unexpired exact observer identity", () => {
  const identity = {
    kind: "oidc-job-identity-only",
    repository_id: 1354613114,
    workflow: ".github/workflows/application-update-production.yml",
    workflow_revision: "a".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "9988",
    run_attempt: 1,
    job_id: 600,
    check_run_id: "888",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const handoff = prepareProductionProtectionHandoff(identity, protectionFixture("b".repeat(40)));
  assert.equal(handoff.producer.controller_revision, identity.workflow_revision);
  assert.equal(handoff.producer.controller_ref, identity.execution_ref);
  assert.doesNotMatch(JSON.stringify(handoff), /token|PRIVATE/);
  assert.throws(() =>
    prepareProductionProtectionHandoff({ ...identity, expires_at: "2000-01-01T00:00:00Z" }, {}),
  );
});

void test("held controller uses a parallel tiny-artifact handshake and isolates Administration authority after readiness", async () => {
  const raw: unknown = parse(
    await readFile(
      new URL("../docs/qualification/application-update-production.aggregate.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(raw) && isRecord(raw.jobs));
  const observer = raw.jobs.protection_observation;
  const admission = raw.jobs.independent_admission;
  assert.ok(isRecord(observer) && isRecord(admission));
  assert.equal(observer.if, "${{ false }}");
  assert.equal(admission.if, "${{ false }}");
  assert.equal(admission.needs, "admission");
  assert.equal(observer.needs, "admission");
  assert.match(JSON.stringify(observer), /permission-administration.*write/);
  assert.doesNotMatch(
    JSON.stringify(admission),
    /secrets\.|CONTROL_APP_TOKEN|permission-administration|observer-token/,
  );
  assert.match(JSON.stringify(admission), /--handshake/);
  assert.match(JSON.stringify(admission), /trusted-release-control-admission-ready-/);
  assert.doesNotMatch(JSON.stringify(admission), /needs.protection_observation/);
  assert.ok(
    JSON.stringify(observer).indexOf("release-control-ready.mts") <
      JSON.stringify(observer).indexOf("create-github-app-token"),
  );
  assert.match(JSON.stringify(observer), /trusted-release-control-admission-observation-/);
  assert.match(JSON.stringify(observer), /observe-production/);
  const live = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    live,
    /permission-administration|release-reviewed-inputs.mts observe-production/,
  );
});

void test("payload reader and observer are fresh distinct fixed jobs and cannot reuse admission source", async () => {
  const control = releaseControlInputsFixture(
    capacityDocumentFixture(),
    opportunity,
    config,
    false,
  );
  persistReviewedClassification(control.api, config, opportunity, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(control.head()), config, "payload");
  const source = await runtime.create();
  requireAuthenticatedReleaseControlSource(source, "payload");
  assert.throws(() => requireAuthenticatedReleaseControlSource(source));
  const facts = source.read(control.api, opportunity);
  assert.equal(facts.phase, "payload");
  assert.equal(facts.reader.job_id, 501);
  assert.equal(facts.reader.scope, "oidc-job-identity-only");
  await assert.rejects(
    authenticateReleaseControlSource(runtime.environment, runtime.workflow, {
      ...runtime.options,
      phase: "admission",
    }),
  );
  runtime.advance(60001);
  assert.throws(() => source.read(control.api, opportunity), /fresh/);
});

void test("site maintenance reads only current pause/capacity under the same fresh isolated source proof", async () => {
  // Deliberately no persisted semantic classification or opportunity acceptance.
  const control = releaseControlInputsFixture(capacityDocumentFixture(), opportunity, config, true);
  const runtime = liveControlRuntimeFixture(
    protectionFixture(control.head()),
    config,
    "site-publication",
  );
  const source = await runtime.create();
  requireAuthenticatedReleaseControlSource(source, "site-publication");
  control.faults.value = "issuer";
  const api = {
    ...control.api,
    request(method: string, endpoint: string, body?: unknown) {
      assert.doesNotMatch(endpoint, /portcove-release-inputs|check-runs/);
      return control.api.request(method, endpoint, body);
    },
  };
  const first = source.readMaintenance(api);
  assert.equal(first.purpose, "metadata-renewal");
  assert.equal(first.phase, "site-publication");
  assert.equal(first.pause.publication_paused, true);
  assert.equal(first.capacity_source.report.eligibility, "eligible");
  assert.equal(first.authority, "none");
  assert.equal(first.facts_sha256, source.readMaintenance(api).facts_sha256);
  assert.equal(control.mutations(), 0);
  control.conflicting();
  assert.throws(() => source.readMaintenance(api), /ref differ/);
  runtime.advance(60001);
  assert.throws(() => source.readMaintenance(api), /fresh/);
  for (const phase of ["admission", "payload", "release-publication"] as const) {
    const wrong = liveControlRuntimeFixture(protectionFixture(control.head()), config, phase);
    const wrongSource = await wrong.create();
    assert.throws(() => wrongSource.readMaintenance(control.api), /site-publication phase/);
  }
});
