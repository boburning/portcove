import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { performance } from "node:perf_hooks";
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
  authenticateControlReaderJob,
  requireAuthenticatedReleaseControlSource,
} from "./release-live-control-admission.mts";
import { prepareProductionProtectionHandoff } from "./release-input-protections.mts";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest } from "./release-capacity.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import { prepareNegativeSemanticDispositionCheck } from "./release-semantic-disposition.mts";

void test("coordinator exact request reader accepts persisted independent proof and refuses conflicting outcomes", async () => {
  const selected = { ...config, review_check_name: semanticReviewCheckName };
  const request = createReleaseReviewRequest({
    before_checkpoint: "e".repeat(40),
    requested_at: "2025-12-31T00:00:00.000Z",
    base_commit: opportunity.base_commit,
    base_version: opportunity.classification.base_version,
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
  });
  for (const persisted of [false, true]) {
    const control = releaseControlInputsFixture(
      capacityDocumentFixture(),
      opportunity,
      selected,
      false,
    );
    let conflict = false;
    const full = negativeSemanticDispositionFixture();
    const negative = prepareNegativeSemanticDispositionCheck({
      ...full,
      request,
      request_id: request.request_id,
      opportunity,
      opportunity_sha256: capacityDigest(opportunity),
      review: { ...full.review, completed_at: "2026-01-01T00:00:00Z" },
    }).proposed_request.body;
    const accepted = () => {
      const value = control.api.request("GET", "repos/boburning/portcove/check-runs/303").body;
      assert.ok(isRecord(value));
      return {
        ...value,
        check_suite: { id: 404 },
        external_id: `portcove-release-review-v2:${capacityDigest(opportunity)}`,
      };
    };
    const api = {
      ...control.api,
      request(method: string, endpoint: string, body?: unknown) {
        if (endpoint.includes("/commits/") && endpoint.includes("/check-suites?"))
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: {
              total_count: 1,
              check_suites: [
                {
                  id: 404,
                  head_sha: opportunity.source_commit,
                  app: { id: selected.review_app_id },
                  repository: { id: 1354613114, full_name: "boburning/portcove" },
                },
              ],
            },
          };
        if (endpoint.includes("/check-suites/404/check-runs?")) {
          const records: Record<string, unknown>[] = persisted ? [accepted()] : [];
          if (conflict)
            records.push({
              ...negative,
              id: 505,
              app: { id: selected.review_app_id },
              check_suite: { id: 404 },
              output: { ...negative.output, annotations_count: 0, text: "" },
            });
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: { total_count: records.length, check_runs: records },
          };
        }
        if (endpoint.endsWith("/check-runs/303"))
          return { status: 200, headers: new Map<string, string>(), body: accepted() };
        return control.api.request(method, endpoint, body);
      },
    };
    if (persisted) persistReviewedClassification(api, selected, opportunity, 303, () => {});
    const runtime = liveControlRuntimeFixture(
      protectionFixture(control.head()),
      selected,
      "coordinator",
    );
    const source = await runtime.create();
    const result = source.readRequest(api, request);
    assert.equal(result.classification.status, persisted ? "reviewed" : "missing");
    if (persisted) {
      assert.equal(result.classification.status, "reviewed");
      if (result.classification.status === "reviewed")
        assert.deepEqual(result.classification.opportunity, opportunity);
      conflict = true;
      assert.throws(() => source.readRequest(api, request), /conflict/);
      conflict = false;
      control.conflicting();
      assert.throws(() => source.readRequest(api, request));
    }
    runtime.advance(60001);
    assert.throws(() => source.readRequest(api, request), /fresh/);
    assert.equal(control.mutations(), persisted ? 1 : 0);
  }
});

void test("source policy selects protected admission identity only in complete workflow mode", async () => {
  const runtime = liveControlRuntimeFixture(protectionFixture("a".repeat(40)));
  const policy: unknown = JSON.parse(runtime.environment.PORTCOVE_CONTROLLER_ADMISSION);
  assert.ok(isRecord(policy));
  const environment = {
    ...runtime.environment,
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
      ...policy,
      schema_version: 2,
      mode: "bounded-application-release",
      authority_configuration_sha256: "a".repeat(64),
      grant_sha256: "b".repeat(64),
    }),
  };
  await assert.rejects(
    authenticateControlReaderJob(environment, runtime.workflow, runtime.options),
  );
  const protectedRuntime = liveControlRuntimeFixture(
    protectionFixture("a".repeat(40)),
    config,
    "admission",
    true,
  );
  const protectedOptions = protectedRuntime.options;
  const result = await authenticateControlReaderJob(
    environment,
    runtime.workflow,
    protectedOptions,
  );
  assert.equal(result.admitted.mode, "bounded-application-release");
  assert.equal(result.identity.evidence_scope, "injected-provider");
  await assert.rejects(
    authenticateControlReaderJob(runtime.environment, runtime.workflow, protectedOptions),
  );
  assert.equal(
    (await authenticateControlReaderJob(runtime.environment, runtime.workflow, runtime.options))
      .admitted.mode,
    "admission-only",
  );
});

void test("source policy selects protected admission identity only in complete workflow mode", async () => {
  const runtime = liveControlRuntimeFixture(protectionFixture("a".repeat(40)));
  const policy: unknown = JSON.parse(runtime.environment.PORTCOVE_CONTROLLER_ADMISSION);
  assert.ok(isRecord(policy));
  const environment = {
    ...runtime.environment,
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
      ...policy,
      schema_version: 2,
      mode: "bounded-application-release",
      authority_configuration_sha256: "a".repeat(64),
      grant_sha256: "b".repeat(64),
    }),
  };
  await assert.rejects(
    authenticateControlReaderJob(environment, runtime.workflow, runtime.options),
  );
  const protectedRuntime = liveControlRuntimeFixture(
    protectionFixture("a".repeat(40)),
    config,
    "admission",
    true,
  );
  const protectedOptions = protectedRuntime.options;
  const result = await authenticateControlReaderJob(
    environment,
    runtime.workflow,
    protectedOptions,
  );
  assert.equal(result.admitted.mode, "bounded-application-release");
  assert.equal(result.identity.evidence_scope, "injected-provider");
  await assert.rejects(
    authenticateControlReaderJob(runtime.environment, runtime.workflow, protectedOptions),
  );
  assert.equal(
    (await authenticateControlReaderJob(runtime.environment, runtime.workflow, runtime.options))
      .admitted.mode,
    "admission-only",
  );
});

function publicationProtection(commit: string, enabled = true) {
  const original = protectionFixture(commit);
  const inventory = {
    ...original.inventory,
    immutable_releases: { enabled, enforced_by_owner: false },
  };
  return {
    ...original,
    inventory,
    coverage: "current-repository-input-branches-and-release-immutability",
    inventory_sha256: capacityDigest(inventory),
  };
}

function fixture(document: unknown = capacityDocumentFixture(), paused = false) {
  const control = releaseControlInputsFixture(document, opportunity, config, paused);
  persistReviewedClassification(control.api, config, opportunity, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(control.head()));
  return { control, runtime };
}

void test("controls cap the actual observer subprocess and refuse its late response without minting a source", async (t) => {
  const f = fixture();
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  const { observerApi, ...options } = f.runtime.options;
  let requests = 0;
  await assert.rejects(
    authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
      ...options,
      deadline: 2000,
      observerTransport: {
        spawn(_command, args, settings) {
          requests++;
          assert.ok(settings.timeout && settings.timeout <= 1000);
          const endpoint = args.find((arg) => arg.startsWith("repos/boburning/portcove/"));
          assert.ok(endpoint);
          const response = observerApi.request("GET", endpoint);
          clock = 2001;
          return {
            status: 0,
            stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(response.body)}`,
            stderr: "",
          };
        },
      },
    }),
    /phase deadline/u,
  );
  assert.equal(requests, 1);
});

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

void test("publication source requires isolated fresh enabled setting and never accepts input-only observation", async () => {
  const f = fixture();
  for (const mode of ["enabled", "disabled", "missing"] as const) {
    const observation =
      mode === "missing"
        ? protectionFixture(f.control.head())
        : publicationProtection(f.control.head(), mode === "enabled");
    const runtime = liveControlRuntimeFixture(observation, config, "release-publication");
    if (mode !== "enabled") {
      await assert.rejects(runtime.create(), /immutability/);
      continue;
    }
    const source = await runtime.create();
    requireAuthenticatedReleaseControlSource(source, "release-publication");
    const result = source.read(f.control.api, opportunity);
    assert.equal(result.protection.release_immutability?.enabled, true);
    assert.equal(source.evidence_scope, "injected-provider");
    runtime.advance(60001);
    assert.throws(() => source.read(f.control.api, opportunity), /fresh/);
  }
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
    const wrong = liveControlRuntimeFixture(
      phase === "release-publication"
        ? publicationProtection(control.head())
        : protectionFixture(control.head()),
      config,
      phase,
    );
    const wrongSource = await wrong.create();
    assert.throws(() => wrongSource.readMaintenance(control.api), /fixed maintenance/);
  }
});

void test("only selected online metadata roles may read pause/capacity without inventing release classification", async () => {
  for (const phase of [
    "coordinator",
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
  ] as const) {
    const control = releaseControlInputsFixture(
      capacityDocumentFixture(),
      opportunity,
      config,
      true,
    );
    const runtime = liveControlRuntimeFixture(protectionFixture(control.head()), config, phase);
    const source = await runtime.create();
    const facts = source.readMaintenance(control.api);
    assert.equal(
      facts.purpose,
      phase === "coordinator" ? "metadata-coordinator-controls" : "metadata-signing-controls",
    );
    assert.equal(facts.pause.publication_paused, true);
    assert.equal(facts.authority, "none");
    assert.throws(() => source.read(control.api, opportunity));
    runtime.advance(60001);
    assert.throws(() => source.readMaintenance(control.api), /fresh/);
    assert.equal(control.mutations(), 0);
  }
});
