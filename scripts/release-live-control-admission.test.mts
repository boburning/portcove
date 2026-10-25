import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { selectedPublicationAuthoritiesFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { assemblerIdentityFixture, jwk } from "./fixtures/assembler-identity-fixture.mts";
import {
  admitProductionClassificationWriter,
  admitProductionClassificationObserver,
  admitProductionProtectionObserver,
  admitProductionCatalogProtectionObserver,
  productionControllerWorkflow,
} from "./production-controller-admission.mts";
import {
  controllerOidcSubject,
  verifyProductionClassificationWriterJobIdentity,
  verifyProductionClassificationObserverJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
} from "./assembler-job-identity.mts";
import {
  establishFixedClassificationPrincipal,
  requireFixedClassificationPrincipal,
  requireProductionFixedClassificationWriter,
  requireProductionProtectionObserver,
} from "./release-classification-principal.mts";
import {
  requireFixedClassificationStoragePolicy,
  requireReleaseInputWriterPolicy,
} from "./release-input-protections.mts";
import {
  readReviewedClassification,
  inspectApplicationReviewProducerConfiguration,
} from "./release-control-inputs.mts";
import { requireCurrentClassificationRequest } from "./release-classification-request.mts";
import {
  applicationProtectionObserver,
  releaseControlPhaseProfile,
  type ReleaseControlPhase,
} from "./release-control-phases.mts";
import { retainProtectionObservationOutputs } from "./release-reviewed-inputs.mts";
import {
  requireControllerJobSourceConfiguration,
  requireControllerJobCredentialRoute,
  requireControllerCatalogJobAuthorities,
  requireControllerApplicationJobAuthorities,
} from "./release-authority-configuration.mts";

void test("observer output transport refuses expiry after every awaited write and retains partial effects", async (t) => {
  for (const delayed of ["output", "observation", "receipt", "none"]) {
    await t.test(delayed, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "portcove-observer-output-"));
      try {
        const output = path.join(root, "output");
        const observation = path.join(root, "observation.json");
        const receipt = path.join(root, "receipt.jsonl");
        const result = { evidence: "controlled-output-transport", authority: "none" };
        const encoded = JSON.stringify(result);
        let now = 1;
        const writes: string[] = [];
        const finish = (stage: string) => {
          writes.push(stage);
          if (delayed === stage) now = 2;
        };
        const attempt = retainProtectionObservationOutputs(
          output,
          observation,
          result,
          "observe-production",
          {
            writeFile: async (value) => {
              await appendFile(receipt, value);
              finish("receipt");
            },
          },
          () => {
            assert.ok(now < 2, "original observer identity/deadline expired");
          },
          {
            appendFile: async (...args) => {
              await appendFile(...args);
              finish("output");
            },
            writeFile: async (...args) => {
              await writeFile(...args);
              finish("observation");
            },
          },
        );
        if (delayed === "none") await attempt;
        else await assert.rejects(attempt, /original observer identity\/deadline expired/);
        const expected =
          delayed === "output"
            ? ["output"]
            : delayed === "observation"
              ? ["output", "observation"]
              : ["output", "observation", "receipt"];
        assert.deepEqual(writes, expected);
        assert.equal(await readFile(output, "utf8"), `observation=${encoded}\n`);
        if (writes.includes("observation"))
          assert.equal(await readFile(observation, "utf8"), encoded);
        else await assert.rejects(readFile(observation), { code: "ENOENT" });
        if (writes.includes("receipt")) {
          const retained: unknown = JSON.parse(await readFile(receipt, "utf8"));
          assert.ok(isRecord(retained) && isRecord(retained.result));
          assert.equal(retained.result.evidence, result.evidence);
        } else await assert.rejects(readFile(receipt), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

void test("production observer joins original named source/OIDC and appointed mint output for both purposes, refusing copies, drift and expiry", async (t) => {
  let provider: ReturnType<typeof assemblerIdentityFixture>;
  const actualSpawn = childProcess.spawnSync;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
  t.mock.method(
    childProcess,
    "spawnSync",
    (
      command: string,
      args: readonly string[],
      options: childProcess.SpawnSyncOptionsWithStringEncoding,
    ) =>
      command === "gh"
        ? provider.transport.spawn(command, args, options)
        : actualSpawn(command, args, options),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const [purpose, phase, shared] of [
    ["application", "classification", false],
    ["application", "coordinator", false],
    ["catalog-publication", "catalog-definitions", false],
    ...(["payload", "tuf-timestamp", "release-publication"] as const).flatMap(
      (phase) =>
        [
          ["application", phase, false],
          ["application", phase, true],
        ] as const,
    ),
  ] as const) {
    const configuration = selectedPublicationAuthoritiesFixture(purpose);
    const runtime = liveControlRuntimeFixture(
      protectionFixture("a".repeat(40)),
      undefined,
      "coordinator",
      true,
    );
    const profile =
      phase === "classification"
        ? {
            observer_job: "classification_protection_observation",
            observer_name: "Observe release input protections",
            observer_environment: "production-release-protection-observer" as const,
            observer_audience: "portcove-release-classification-protection-v1",
          }
        : releaseControlPhaseProfile(phase);
    const workflow = shared
      ? Buffer.concat([
          Buffer.from(applicationProtectionObserver.source_marker + "\n"),
          runtime.workflow,
        ])
      : runtime.workflow;
    const environment = {
      ...runtime.environment,
      GITHUB_JOB: shared ? applicationProtectionObserver.job : profile.observer_job,
    };
    const policy = {
      ...runtime.policy,
      mode:
        purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication",
      authority_configuration_sha256: capacityDigest(configuration),
      workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
    };
    const source =
      phase === "classification"
        ? admitProductionClassificationObserver(JSON.stringify(policy), environment, workflow)
        : (purpose === "application"
            ? admitProductionProtectionObserver
            : admitProductionCatalogProtectionObserver)(
            JSON.stringify(policy),
            environment,
            workflow,
            phase,
          );
    const expected = {
      audience: profile.observer_audience,
      subject: controllerOidcSubject(policy.execution_ref, profile.observer_environment),
      controller_revision: policy.revision,
      controller_ref: policy.execution_ref,
      actor_id: policy.actor_id,
      run_id: environment.GITHUB_RUN_ID,
      run_attempt: 1,
    };
    provider = assemblerIdentityFixture(
      { aud: expected.audience, sub: expected.subject, environment: profile.observer_environment },
      {},
      {
        workflow: productionControllerWorkflow,
        job: shared ? applicationProtectionObserver.name : profile.observer_name,
        runAttempt: 1,
      },
    );
    const identity =
      phase === "classification"
        ? await verifyProductionClassificationObserverJobIdentity(provider.token, expected, {
            transport: { cwd: process.cwd() },
          })
        : await verifyProductionProtectionObserverJobIdentity(
            provider.token,
            expected,
            { transport: { cwd: process.cwd() } },
            phase,
            source,
          );
    const observer = configuration.journal.apps.protection_observer;
    const join = (
      raw: unknown = configuration,
      originalSource: unknown = source,
      originalIdentity: unknown = identity,
      selectedPhase: "classification" | ReleaseControlPhase = phase,
      app = String(observer.app_id),
      installation = String(observer.installation_id),
      now = Date.now(),
    ) =>
      requireProductionProtectionObserver(
        raw,
        originalSource,
        originalIdentity,
        selectedPhase,
        purpose,
        app,
        installation,
        now,
      );
    assert.equal(join().classification_transport, "fixed-job");
    assert.equal(join().authority, "none");
    if (phase === "payload" || phase === "tuf-timestamp" || phase === "release-publication") {
      const otherWorkflow = shared
        ? runtime.workflow
        : Buffer.concat([
            Buffer.from(applicationProtectionObserver.source_marker + "\n"),
            runtime.workflow,
          ]);
      const otherPolicy = {
        ...policy,
        workflow_sha256: createHash("sha256").update(otherWorkflow).digest("hex"),
      };
      const otherSource = admitProductionProtectionObserver(
        JSON.stringify(otherPolicy),
        {
          ...environment,
          GITHUB_JOB: shared ? profile.observer_job : applicationProtectionObserver.job,
        },
        otherWorkflow,
        phase,
      );
      assert.throws(
        () => join(configuration, otherSource),
        /original unexpired fixed protection observer identity/u,
      );
      await assert.rejects(
        verifyProductionProtectionObserverJobIdentity(
          provider.token,
          expected,
          { transport: { cwd: process.cwd() } },
          phase,
          otherSource,
        ),
        /signed check-run identity/u,
      );
    }
    assert.throws(() => join(configuration, { ...source }));
    assert.throws(() => join(configuration, source, { ...identity }));
    assert.throws(() =>
      join(
        configuration,
        source,
        identity,
        phase === "classification" ? "coordinator" : "classification",
      ),
    );
    assert.throws(() =>
      join(
        configuration,
        source,
        identity,
        phase,
        String(configuration.journal.apps.semantic.app_id),
      ),
    );
    assert.throws(() =>
      join(configuration, source, identity, phase, String(observer.app_id), "999"),
    );
    assert.throws(() =>
      join(
        configuration,
        source,
        identity,
        phase,
        String(observer.app_id),
        String(observer.installation_id),
        Date.parse(identity.expires_at),
      ),
    );
    const changed = structuredClone(configuration);
    changed.journal.setup_plan_sha256 = "f".repeat(64);
    assert.throws(() => join(changed));
    assert.throws(() => join(configuration.journal));
    const injected =
      phase === "classification"
        ? await verifyProductionClassificationObserverJobIdentity(provider.token, expected, {
            readKeys: provider.readKeys,
            transport: provider.transport,
          })
        : await verifyProductionProtectionObserverJobIdentity(
            provider.token,
            expected,
            { readKeys: provider.readKeys, transport: provider.transport },
            phase,
            source,
          );
    assert.throws(() => join(configuration, source, injected));
  }
});

void test("reader direct handoffs require the exact observer layout in admitted source bytes", async () => {
  for (const phase of ["payload", "tuf-timestamp", "release-publication"] as const) {
    for (const shared of [false, true]) {
      const runtime = liveControlRuntimeFixture(
        protectionFixture("a".repeat(40)),
        undefined,
        phase,
        true,
      );
      const workflow = shared
        ? Buffer.concat([
            Buffer.from(applicationProtectionObserver.source_marker + "\n"),
            runtime.workflow,
          ])
        : runtime.workflow;
      const environment = {
        ...runtime.environment,
        PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
          ...runtime.policy,
          workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
        }),
      };
      runtime.observerJob.name = shared
        ? applicationProtectionObserver.name
        : releaseControlPhaseProfile(phase).observer_name;
      const source = await authenticateReleaseControlSource(environment, workflow, runtime.options);
      assert.equal(source.evidence_scope, "injected-provider");
      requireAuthenticatedReleaseControlSource(source, phase);
      runtime.observerJob.name = shared
        ? releaseControlPhaseProfile(phase).observer_name
        : applicationProtectionObserver.name;
      await assert.rejects(
        authenticateReleaseControlSource(environment, workflow, runtime.options),
        /completed isolated observer job/u,
      );
    }
  }
});

void test("selected full application controls bind their complete record and fixed writer instead of legacy App configuration", async () => {
  const control = releaseControlInputsFixture(capacityDocumentFixture());
  const observation = protectionFixture(control.head());
  observation.inventory.rulesets[0]!.bypass_actors[0]!.actor_id = 15368;
  observation.inventory_sha256 = capacityDigest(observation.inventory);
  const runtime = liveControlRuntimeFixture(observation, undefined, "coordinator", true);
  const configuration = selectedPublicationAuthoritiesFixture("application");
  const environment = {
    ...runtime.environment,
    PORTCOVE_REVIEW_PRODUCER: undefined,
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(configuration),
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
      ...runtime.policy,
      authority_configuration_sha256: capacityDigest(configuration),
    }),
  };
  const source = await authenticateReleaseControlSource(
    environment,
    runtime.workflow,
    runtime.options,
  );
  const facts = source.readMaintenance(control.api);
  assert.equal(facts.authority, "none");
  assert.equal(facts.capacity_source.report.availability, "unknown");
  assert.ok("provider_writer" in facts.protection);
  assert.equal(
    facts.protection.provider_writer,
    "github-actions-integration-not-workflow-specific",
  );
  for (const raw of [undefined, "{}", JSON.stringify(configuration.journal)])
    await assert.rejects(
      authenticateReleaseControlSource(
        {
          ...environment,
          PORTCOVE_RELEASE_AUTHORITIES: raw,
          PORTCOVE_REVIEW_PRODUCER: runtime.environment.PORTCOVE_REVIEW_PRODUCER,
        },
        runtime.workflow,
        runtime.options,
      ),
    );
});

void test("selected fixed writer joins original source/OIDC objects and preserves semantic verification, CAS and ambiguity under controlled providers", async (t) => {
  const fixture = () =>
    releaseControlInputsFixture(undefined, opportunity, {
      ...config,
      review_check_name: semanticReviewCheckName,
    });
  const control = fixture();
  const observation = protectionFixture(control.head());
  observation.inventory.rulesets[0]!.bypass_actors[0]!.actor_id = 15368;
  observation.inventory_sha256 = capacityDigest(observation.inventory);
  const runtime = liveControlRuntimeFixture(observation, undefined, "coordinator", true);
  const configuration = selectedPublicationAuthoritiesFixture("application");
  const environment = { ...runtime.environment, GITHUB_JOB: "classification_writer" };
  const policy = {
    ...runtime.policy,
    authority_configuration_sha256: capacityDigest(configuration),
  };
  const source = admitProductionClassificationWriter(
    JSON.stringify(policy),
    environment,
    runtime.workflow,
  );
  const expected = {
    audience: "portcove-release-classification-v1",
    subject: controllerOidcSubject(policy.execution_ref, "production-release-classification"),
    controller_revision: policy.revision,
    controller_ref: policy.execution_ref,
    actor_id: policy.actor_id,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
  };
  const provider = assemblerIdentityFixture(
    {
      aud: expected.audience,
      sub: expected.subject,
      environment: "production-release-classification",
    },
    {},
    {
      workflow: productionControllerWorkflow,
      job: "Persist independently reviewed classification",
      runAttempt: 1,
    },
  );
  const actualSpawn = childProcess.spawnSync;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
  t.mock.method(
    childProcess,
    "spawnSync",
    (
      command: string,
      args: readonly string[],
      options: childProcess.SpawnSyncOptionsWithStringEncoding,
    ) =>
      command === "gh"
        ? provider.transport.spawn(command, args, options)
        : actualSpawn(command, args, options),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Default verifier code, with controlled JWKS/GET responses. This is not a
  // real GitHub issuer, credential, setup or protected acceptance observation.
  const identity = await verifyProductionClassificationWriterJobIdentity(provider.token, expected, {
    transport: { cwd: process.cwd() },
  });
  const principal = establishFixedClassificationPrincipal(
    configuration,
    source,
    identity,
    "classification-writer",
  );
  assert.equal(requireProductionFixedClassificationWriter(principal).role, "classification-writer");
  const producer = principal.producer;
  assert.equal(producer.writer.job, "classification_writer");
  assert.equal("writer_app_id" in producer, false);
  assert.equal(
    requireFixedClassificationStoragePolicy(observation, principal).semantic_authority,
    "none",
  );
  assert.throws(() => requireReleaseInputWriterPolicy(observation, 15368));
  for (const copy of [{ ...principal }, producer, 15368, {}])
    assert.throws(() => requireFixedClassificationStoragePolicy(observation, copy));
  assert.throws(() =>
    establishFixedClassificationPrincipal(
      configuration,
      { ...source },
      identity,
      "classification-writer",
    ),
  );
  assert.throws(() =>
    establishFixedClassificationPrincipal(
      configuration,
      source,
      { ...identity },
      "classification-writer",
    ),
  );
  assert.throws(() =>
    establishFixedClassificationPrincipal(configuration, source, identity, "coordinator"),
  );
  const changed = structuredClone(configuration);
  changed.journal.setup_plan_sha256 = "f".repeat(64);
  assert.throws(() =>
    establishFixedClassificationPrincipal(changed, source, identity, "classification-writer"),
  );
  const beforeMutation = () => {
    requireFixedClassificationStoragePolicy(observation, principal);
  };
  const result = persistReviewedClassification(
    control.api,
    producer,
    opportunity,
    303,
    beforeMutation,
  );
  assert.equal(result.changed, true);
  assert.equal(control.mutations(), 1);
  assert.equal(readReviewedClassification(control.api, producer, opportunity).review_check_id, 303);
  assert.equal(
    persistReviewedClassification(control.api, producer, opportunity, 303, beforeMutation).changed,
    false,
  );
  for (const fault of [
    "issuer",
    "failure",
    "annotations",
    "input",
    "report-bytes",
    "pr-scope",
    "legacy-report",
  ]) {
    const f = fixture();
    f.faults.value = fault;
    assert.throws(() =>
      persistReviewedClassification(f.api, producer, opportunity, 303, beforeMutation),
    );
    assert.equal(f.mutations(), 0);
  }
  const ambiguous = fixture();
  ambiguous.faults.value = "ambiguous";
  assert.equal(
    persistReviewedClassification(ambiguous.api, producer, opportunity, 303, beforeMutation)
      .recovered,
    true,
  );
  assert.equal(ambiguous.mutations(), 1);
  const expiry = fixture();
  const observedAt = Date.parse(observation.observed_at);
  let clock = observedAt + 59_000;
  let heads = 0;
  const headApi = {
    request() {
      heads++;
      clock += 2_000;
      return {
        status: 200,
        headers: new Map<string, string>(),
        body: {
          ref: `refs/heads/${producer.writer.namespace}-coordinator-state`,
          object: { type: "commit", sha: "a".repeat(40) },
        },
      };
    },
    graphql() {
      throw new Error("no mutation");
    },
  };
  assert.throws(
    () =>
      persistReviewedClassification(expiry.api, producer, opportunity, 303, () =>
        requireCurrentClassificationRequest(
          headApi,
          producer.writer.namespace,
          "a".repeat(40),
          () => {
            requireFixedClassificationStoragePolicy(observation, principal, clock);
          },
        ),
      ),
    /protection inventory unavailable/,
  );
  assert.equal(heads, 1);
  assert.equal(expiry.mutations(), 0);
  assert.throws(() =>
    requireFixedClassificationStoragePolicy(observation, principal, Date.now() + 60_001),
  );
  assert.throws(() =>
    requireFixedClassificationPrincipal(principal, Date.parse(identity.expires_at)),
  );
  const bad = { ...producer, purpose: "catalog-publication" };
  assert.throws(() => inspectApplicationReviewProducerConfiguration(bad));
  principal.producer.writer.actor_id = "999";
  assert.throws(() => requireFixedClassificationPrincipal(principal));
});

void test("selected full application control drift cannot hide behind an unchanged legacy producer configuration", async () => {
  const control = releaseControlInputsFixture(capacityDocumentFixture());
  const runtime = liveControlRuntimeFixture(
    protectionFixture(control.head()),
    undefined,
    "coordinator",
    true,
  );
  const configuration = selectedPublicationAuthoritiesFixture("application");
  const policy = {
    ...runtime.policy,
    authority_configuration_sha256: capacityDigest(configuration),
  };
  configuration.journal.setup_plan_sha256 = "f".repeat(64);
  await assert.rejects(
    authenticateReleaseControlSource(
      {
        ...runtime.environment,
        PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(configuration),
        PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify(policy),
      },
      runtime.workflow,
      runtime.options,
    ),
  );
});

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
  const installed: unknown = parse(live);
  assert.ok(isRecord(installed) && isRecord(installed.jobs));
  const jobs = Object.entries(installed.jobs);
  const observers = jobs.filter(([name]) => name.endsWith("protection_observation"));
  assert.deepEqual(
    observers.map(([name]) => name).sort(),
    [
      "classification_protection_observation",
      "coordinator_protection_observation",
      "protection_observation",
      "payload_protection_observation",
      "metadata_protection_observation",
      "release_protection_observation",
      "site_protection_observation",
      "catalog_metadata_protection_observation",
    ].sort(),
  );
  for (const [name, job] of jobs) {
    assert.ok(isRecord(job));
    if (name.endsWith("protection_observation")) {
      assert.equal(job.environment, "production-release-protection-observer");
      if (name === "catalog_metadata_protection_observation") {
        assert.match(JSON.stringify(job), /PORTCOVE_CATALOG_PROTECTION_APP_PRIVATE_KEY/);
        assert.doesNotMatch(JSON.stringify(job), /secrets\.PORTCOVE_PROTECTION_APP_PRIVATE_KEY/);
      } else {
        assert.match(JSON.stringify(job), /PORTCOVE_PROTECTION_APP_PRIVATE_KEY/);
        if (["coordinator_protection_observation", "site_protection_observation"].includes(name)) {
          assert.match(
            JSON.stringify(job),
            /publication_purpose == 'catalog-publication'.*PORTCOVE_CATALOG_PROTECTION_APP_PRIVATE_KEY/su,
          );
          assert.match(
            JSON.stringify(job),
            /publication_purpose == 'application'.*secrets\.PORTCOVE_PROTECTION_APP_PRIVATE_KEY/su,
          );
        } else
          assert.doesNotMatch(JSON.stringify(job), /PORTCOVE_CATALOG_PROTECTION_APP_PRIVATE_KEY/);
      }
    } else {
      assert.doesNotMatch(
        JSON.stringify(job),
        /permission-administration|PORTCOVE_(?:CATALOG_)?PROTECTION_APP_PRIVATE_KEY/,
      );
    }
  }
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

void test("application control re-read refuses expiry inside its final observer GET before a following mutation", async (t) => {
  const control = releaseControlInputsFixture(
    capacityDocumentFixture(),
    opportunity,
    config,
    false,
  );
  persistReviewedClassification(control.api, config, opportunity, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(control.head()), config, "payload");
  const request = runtime.options.observerApi.request.bind(runtime.options.observerApi);
  let armed = false,
    posts = 0;
  t.mock.method(runtime.options.observerApi, "request", (method: string, endpoint: string) => {
    const result = request(method, endpoint);
    if (armed) runtime.advance(2000);
    return result;
  });
  const source = await runtime.create();
  runtime.advance(59000);
  armed = true;
  const before = control.mutations();
  assert.throws(() => {
    source.read(control.api, opportunity);
    posts++;
  }, /fresh/);
  assert.equal(posts, 0);
  assert.equal(control.mutations(), before);
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

for (const phase of [
  "coordinator",
  "site-publication",
  "catalog-definitions",
  "catalog-policy",
  "catalog-snapshot",
  "catalog-timestamp",
] as const)
  void test(`actual selected catalog ${phase} entry retains default signed OIDC/provider verification before source routing`, async (t) => {
    const runtime = liveControlRuntimeFixture(
      protectionFixture("a".repeat(40)),
      undefined,
      phase,
      true,
    );
    const configuration = selectedPublicationAuthoritiesFixture("catalog-publication");
    assert.ok("catalog" in configuration);
    const workflow = await readFile(
      new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    );
    const profile = releaseControlPhaseProfile(phase);
    const provider = assemblerIdentityFixture(
      {
        aud: profile.reader_audience,
        sub: controllerOidcSubject(runtime.policy.execution_ref, profile.reader_environment),
        environment: profile.reader_environment,
      },
      {},
      { workflow: productionControllerWorkflow, job: profile.reader_name, runAttempt: 1 },
    );
    const environment = {
      ...runtime.environment,
      PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
      PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify(configuration),
      PORTCOVE_CATALOG_CONTROLLER_ADMISSION: JSON.stringify({
        ...runtime.policy,
        mode: "bounded-catalog-publication",
        workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
        authority_configuration_sha256: capacityDigest(configuration),
      }),
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token?fixture=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-fixture-control-bearer",
    };
    const before = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const actualSpawn = childProcess.spawnSync;
    let driftDuringTokenRead = false;
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      if (url.hostname === "fixture.actions.githubusercontent.com") {
        assert.equal(url.searchParams.get("audience"), profile.reader_audience);
        if (driftDuringTokenRead) process.env.PORTCOVE_EXECUTION_PURPOSE = "application";
        return new Response(JSON.stringify({ value: provider.token }));
      }
      assert.equal(url.hostname, "token.actions.githubusercontent.com");
      return new Response(JSON.stringify({ keys: [jwk] }));
    });
    t.mock.method(
      childProcess,
      "spawnSync",
      (
        command: string,
        args: readonly string[],
        options: childProcess.SpawnSyncOptionsWithStringEncoding,
      ) =>
        command === "gh"
          ? provider.transport.spawn(command, args, options)
          : actualSpawn(command, args, options),
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const actual = await requireControllerJobSourceConfiguration(phase);
    assert.equal(actual.binding.purpose, "catalog-publication");
    assert.equal(actual.binding.actor_id, runtime.policy.actor_id);
    assert.equal(actual.binding.namespace, configuration.journal.namespace);
    assert.ok(
      provider.counts().requests > 0,
      "default named verifier used controlled provider readback",
    );
    actual.recheck();
    const credential = await requireControllerJobCredentialRoute(phase);
    assert.equal(credential.route.credential_transport, "fixed-job");
    assert.equal(credential.route.purpose, "catalog-publication");
    assert.equal(credential.route.phase, phase);
    assert.deepEqual(credential.route.source, actual.binding);
    credential.recheck();
    const coordinator = await requireControllerCatalogJobAuthorities(phase);
    assert.equal(coordinator.configuration_sha256, capacityDigest(configuration));
    assert.equal(coordinator.dispatch_actor_id, runtime.policy.actor_id);
    assert.deepEqual(coordinator.catalog, configuration.catalog);
    assert.deepEqual(coordinator.semantic_producer, {
      schema_version: 2,
      purpose: "catalog-publication",
      review_app_id: configuration.journal.apps.semantic.app_id,
      review_check_name: semanticReviewCheckName,
    });
    await assert.rejects(
      requireControllerApplicationJobAuthorities(phase),
      /application job source/,
    );
    driftDuringTokenRead = true;
    await assert.rejects(requireControllerCatalogJobAuthorities(phase), /environment changed/);
    process.env.PORTCOVE_EXECUTION_PURPOSE = "catalog-publication";
    driftDuringTokenRead = false;
    provider.faults.value = "job-completed";
    await assert.rejects(requireControllerJobSourceConfiguration(phase));
    await assert.rejects(requireControllerCatalogJobAuthorities(phase));
  });
