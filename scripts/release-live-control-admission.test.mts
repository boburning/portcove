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

void test("production protection observer entry uses separate captured job and protection App credentials through the SDK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-protection-observer-entry-"));
  try {
    const phase = "coordinator";
    const profile = releaseControlPhaseProfile(phase);
    const configuration = selectedPublicationAuthoritiesFixture("application");
    const runtime = liveControlRuntimeFixture(
      protectionFixture("a".repeat(40)),
      config,
      phase,
      true,
    );
    const workflow = await readFile(new URL(`../${productionControllerWorkflow}`, import.meta.url));
    const observer = configuration.journal.apps.protection_observer;
    const command = new URL("./release-reviewed-inputs.mts", import.meta.url);
    const fixture = new URL("./fixtures/assembler-identity-fixture.mts", import.meta.url);
    const program = `
      import assert from "node:assert/strict";
      import { fileURLToPath } from "node:url";
      import { assemblerIdentityFixture, jwk } from ${JSON.stringify(fixture.href)};
      const provider = assemblerIdentityFixture({
        aud: ${JSON.stringify(profile.observer_audience)},
        sub: ${JSON.stringify(controllerOidcSubject(runtime.policy.execution_ref, profile.observer_environment))},
        environment: ${JSON.stringify(profile.observer_environment)},
      }, {}, {
        workflow: ${JSON.stringify(productionControllerWorkflow)},
        job: ${JSON.stringify(profile.observer_name)},
        runAttempt: 1,
      });
      const dispatches = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === "https://fixture.actions.githubusercontent.com") {
          assert.equal(request.headers.get("authorization"), "Bearer inert-oidc-bearer");
          process.env.GH_TOKEN = "different-late-job-token";
          return Response.json({ value: provider.token });
        }
        if (url.origin === "https://token.actions.githubusercontent.com") {
          assert.equal(request.headers.get("authorization"), null);
          return Response.json({ keys: [jwk] });
        }
        const authorization = request.headers.get("authorization");
        dispatches.push([request.method, url.href, authorization]);
        if (authorization === "token original-job-token")
          return Response.json(provider.metadata(url.pathname + url.search));
        assert.equal(authorization, "token different-protection-app-token");
        assert.equal(url.href, "https://api.github.com/repos/boburning/portcove");
        return Response.json({}, { status: 503 });
      };
      process.on("beforeExit", () => {
        assert.deepEqual(dispatches.map(row => row[2]), [
          ...Array(5).fill("token original-job-token"),
          "token different-protection-app-token",
        ]);
        assert.ok(dispatches.every(row => row[0] === "GET"));
      });
      process.argv = [process.execPath, fileURLToPath(${JSON.stringify(command.href)}), "observe-production-coordinator"];
      await import(${JSON.stringify(command.href)});
    `;
    const result = childProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      {
        env: {
          ...process.env,
          ...runtime.environment,
          GITHUB_JOB: profile.observer_job,
          RUNNER_TEMP: root,
          PORTCOVE_EXECUTION_PURPOSE: "application",
          PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
            ...runtime.policy,
            workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
            authority_configuration_sha256: capacityDigest(configuration),
          }),
          PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(configuration),
          PORTCOVE_EXPECTED_PROTECTION_APP_ID: String(observer.app_id),
          PORTCOVE_EXPECTED_INSTALLATION_ID: String(observer.installation_id),
          PORTCOVE_OBSERVED_INSTALLATION_ID: String(observer.installation_id),
          PORTCOVE_CONTROL_APP_TOKEN: "different-protection-app-token",
          PORTCOVE_STORAGE_APP_TOKEN: undefined,
          NODE_OPTIONS: undefined,
          NODE_PATH: undefined,
          GH_TOKEN: "original-job-token",
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://fixture.actions.githubusercontent.com/token?fixture=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-oidc-bearer",
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "reviewed input operation refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const role of ["observer", "writer"] as const) {
  void test(`fixed classification ${role} entry reads the original clock and OIDC identity through locked Octokit`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-classification-entry-"));
    try {
      const writer = role === "writer";
      const configuration = selectedPublicationAuthoritiesFixture("application");
      const runtime = liveControlRuntimeFixture(
        protectionFixture("a".repeat(40)),
        config,
        "coordinator",
        true,
      );
      const workflow = await readFile(
        new URL(`../${productionControllerWorkflow}`, import.meta.url),
      );
      const observer = configuration.journal.apps.protection_observer;
      const command = new URL("./release-reviewed-inputs.mts", import.meta.url);
      const fixture = new URL("./fixtures/assembler-identity-fixture.mts", import.meta.url);
      const name = writer
        ? "Persist independently reviewed classification"
        : "Observe release input protections";
      const oidcEnvironment = writer
        ? "production-release-classification"
        : "production-release-protection-observer";
      const audience = writer
        ? "portcove-release-classification-v1"
        : "portcove-release-classification-protection-v1";
      const program = `
        import assert from "node:assert/strict";
        import { fileURLToPath } from "node:url";
        import { assemblerIdentityFixture, jwk } from ${JSON.stringify(fixture.href)};
        const provider = assemblerIdentityFixture({
          aud: ${JSON.stringify(audience)},
          sub: ${JSON.stringify(controllerOidcSubject(runtime.policy.execution_ref, oidcEnvironment))},
          environment: ${JSON.stringify(oidcEnvironment)},
        }, {}, {
          workflow: ${JSON.stringify(productionControllerWorkflow)},
          job: ${JSON.stringify(name)},
          runAttempt: 1,
        });
        const calls = [];
        globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(request.method, "GET");
          if (url.origin === "https://fixture.actions.githubusercontent.com") {
            calls.push("oidc");
            assert.equal(url.searchParams.get("audience"), ${JSON.stringify(audience)});
            assert.equal(request.headers.get("authorization"), "Bearer fixture-oidc");
            return Response.json({ value: provider.token });
          }
          if (url.origin === "https://token.actions.githubusercontent.com") {
            calls.push("keys");
            assert.equal(request.headers.get("authorization"), null);
            return Response.json({ keys: [jwk] });
          }
          assert.equal(url.origin, "https://api.github.com");
          const authorization = request.headers.get("authorization");
          if (authorization === "token unrelated-protection-app-token") {
            assert.equal(${JSON.stringify(writer)}, false);
            assert.equal(url.href, "https://api.github.com/repos/boburning/portcove");
            calls.push("protection-app");
            return Response.json({}, { status: 503 });
          }
          assert.equal(authorization, "token original-classification-job-reader");
          calls.push(url.pathname + url.search);
          if (calls.length === 1 && url.pathname.endsWith("/attempts/1/jobs")) {
            process.env.GH_TOKEN = "unrelated-late-ambient-token";
            return Response.json({total_count:1,jobs:[{
              id:501, name:${JSON.stringify(name)}, run_id:9988, run_attempt:1,
              head_sha:${JSON.stringify(runtime.policy.revision)}, status:"in_progress",
              started_at:new Date(Date.now()-1000).toISOString(),
            }]});
          }
          return ${JSON.stringify(writer)}
            ? Response.json({}, { status: 503 })
            : Response.json(provider.metadata(url.pathname + url.search));
        };
        process.on("beforeExit", () => {
          assert.deepEqual(calls.slice(0, 4), [
            "/repos/boburning/portcove/actions/runs/9988/attempts/1/jobs?page=1&per_page=100",
            "oidc",
            "keys",
            "/repos/boburning/portcove/actions/runs/9988",
          ]);
          assert.equal(calls.at(-1), ${JSON.stringify(writer)}
            ? "/repos/boburning/portcove/actions/runs/9988" : "protection-app");
        });
        process.argv = [process.execPath, fileURLToPath(${JSON.stringify(command.href)}), ${JSON.stringify(writer ? "persist-production-request" : "observe-production-classification")}];
        await import(${JSON.stringify(command.href)});
      `;
      const result = childProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          env: {
            ...process.env,
            ...runtime.environment,
            GITHUB_JOB: writer ? "classification_writer" : "classification_protection_observation",
            RUNNER_TEMP: root,
            PORTCOVE_EXECUTION_PURPOSE: "application",
            PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
              ...runtime.policy,
              workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
              authority_configuration_sha256: capacityDigest(configuration),
            }),
            PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(configuration),
            PORTCOVE_EXPECTED_PROTECTION_APP_ID: String(observer.app_id),
            PORTCOVE_EXPECTED_INSTALLATION_ID: String(observer.installation_id),
            PORTCOVE_OBSERVED_INSTALLATION_ID: String(observer.installation_id),
            PORTCOVE_CONTROL_APP_TOKEN: writer ? undefined : "unrelated-protection-app-token",
            PORTCOVE_STORAGE_APP_TOKEN: writer ? "unrelated-storage-app-token" : undefined,
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
            GH_TOKEN: "original-classification-job-reader",
            ACTIONS_ID_TOKEN_REQUEST_URL:
              "https://fixture.actions.githubusercontent.com/token?fixture=1",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc",
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), "reviewed input operation refused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test("production observer joins original named source/OIDC and appointed mint output for both purposes, refusing copies, drift and expiry", async (t) => {
  let provider: ReturnType<typeof assemblerIdentityFixture>;
  const actualSpawn = childProcess.spawnSync;
  const jobToken = "fixture-protection-job-reader";
  const routes: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://token.actions.githubusercontent.com") {
        assert.equal(request.headers.get("authorization"), null);
        return Response.json({ keys: [jwk] });
      }
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), `token ${jobToken}`);
      const route = url.pathname + url.search;
      routes.push(route);
      return Response.json(provider.metadata(route));
    },
  );
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
    routes.length = 0;
    const sdkTransport = { sdkToken: jobToken, deadline: performance.now() + 15_000 };
    const identity =
      phase === "classification"
        ? await verifyProductionClassificationObserverJobIdentity(provider.token, expected, {
            transport: { cwd: process.cwd() },
          })
        : await verifyProductionProtectionObserverJobIdentity(
            provider.token,
            expected,
            { transport: sdkTransport },
            phase,
            source,
          );
    if (phase === "classification") {
      assert.deepEqual(routes, []);
    } else {
      const run = "/repos/boburning/portcove/actions/runs/9988";
      assert.deepEqual(routes, [
        run,
        `${run}/attempts/1/jobs?per_page=100&page=1`,
        `${run}/attempts/1/jobs?per_page=100&page=2`,
        "/repos/boburning/portcove/actions/jobs/501",
        run,
      ]);
    }
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
          { transport: sdkTransport },
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
        phase === "release-publication"
          ? publicationProtection("a".repeat(40), true)
          : protectionFixture("a".repeat(40)),
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
  // The original job verifier is unchanged; the new independently ratified
  // profile selects a distinct App and requires actual journal coverage too.
  const storageConfig = {
    ...configuration,
    kind: "three-app-fixed-jobs-v1",
    journal: {
      ...configuration.journal,
      kind: "three-app-fixed-jobs-v1",
      storage_setup_plan_sha256: "7".repeat(64),
      apps: {
        ...configuration.journal.apps,
        storage_writer: { app_id: 90001, installation_id: 90002 },
      },
    },
  };
  const storageSource = admitProductionClassificationWriter(
    JSON.stringify({ ...policy, authority_configuration_sha256: capacityDigest(storageConfig) }),
    environment,
    runtime.workflow,
  );
  const storagePrincipal = establishFixedClassificationPrincipal(
    storageConfig,
    storageSource,
    identity,
    "classification-writer",
  );
  assert.throws(() => requireFixedClassificationStoragePolicy(observation, storagePrincipal));
  const protectedStorage = structuredClone(observation);
  protectedStorage.inventory.rulesets[0]!.bypass_actors[0]!.actor_id = 90001;
  const branch = `${configuration.journal.namespace}-coordinator-state`;
  for (const [index, rule] of protectedStorage.inventory.rulesets.slice(0, 2).entries()) {
    const next = structuredClone(rule);
    next.id = index + 5;
    next.conditions.ref_name.include = [`refs/heads/${branch}`];
    protectedStorage.inventory.rulesets.push(next);
  }
  const journalBranch = structuredClone(protectedStorage.inventory.branches[0]!);
  journalBranch.branch = branch;
  journalBranch.ref.ref = `refs/heads/${branch}`;
  journalBranch.effective_rules.forEach((rule) => {
    rule.ruleset_id += 4;
  });
  protectedStorage.inventory.branches.push(journalBranch);
  protectedStorage.inventory_sha256 = capacityDigest(protectedStorage.inventory);
  assert.equal(
    requireFixedClassificationStoragePolicy(protectedStorage, storagePrincipal).provider_writer,
    "dedicated-storage-app-not-workflow-specific",
  );
  const advancedStorage = structuredClone(protectedStorage);
  advancedStorage.inventory.branches.at(-1)!.ref.object.sha = "f".repeat(40);
  advancedStorage.inventory_sha256 = capacityDigest(advancedStorage.inventory);
  const oldPolicy = requireFixedClassificationStoragePolicy(protectedStorage, storagePrincipal);
  const newPolicy = requireFixedClassificationStoragePolicy(advancedStorage, storagePrincipal);
  assert.notEqual(oldPolicy.inventory_sha256, newPolicy.inventory_sha256);
  assert.equal(oldPolicy.journal_policy_sha256, newPolicy.journal_policy_sha256);
  for (const mutation of [
    (raw: typeof protectedStorage) => {
      raw.inventory.branches.pop();
    },
    (raw: typeof protectedStorage) => {
      raw.inventory.rulesets[4]!.bypass_actors[0]!.actor_id = 15368;
    },
    (raw: typeof protectedStorage) => {
      raw.inventory.rulesets[5]!.bypass_actors.push({
        actor_type: "User",
        actor_id: 43177418,
        bypass_mode: "always",
      });
    },
  ]) {
    const changed = structuredClone(protectedStorage);
    mutation(changed);
    changed.inventory_sha256 = capacityDigest(changed.inventory);
    assert.throws(() => requireFixedClassificationStoragePolicy(changed, storagePrincipal));
  }
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

void test("scoped coordinator request reader accepts persisted proof and distinguishes negative or conflicting outcomes", async (t) => {
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
    const negativeCheck = {
      ...negative,
      id: 505,
      app: { id: selected.review_app_id },
      check_suite: { id: 404 },
      output: { ...negative.output, annotations_count: 0, text: "" },
    };
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
          if (conflict) records.push(negativeCheck);
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: { total_count: records.length, check_runs: records },
          };
        }
        if (endpoint.endsWith("/check-runs/303"))
          return { status: 200, headers: new Map<string, string>(), body: accepted() };
        if (conflict && endpoint.endsWith("/check-runs/505"))
          return { status: 200, headers: new Map<string, string>(), body: negativeCheck };
        return control.api.request(method, endpoint, body);
      },
    };
    if (persisted) persistReviewedClassification(api, selected, opportunity, 303, () => {});
    const runtime = liveControlRuntimeFixture(
      protectionFixture(control.head()),
      selected,
      "coordinator",
    );
    const { observerApi, ...options } = runtime.options;
    let observerReads = 0;
    const fetcher = t.mock.method(
      globalThis,
      "fetch",
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "token synthetic-coordinator",
        );
        if (url.pathname === "/graphql") {
          assert.equal(init?.method, "POST");
          assert.ok(typeof init.body === "string");
          const wire: unknown = JSON.parse(init.body);
          assert.ok(isRecord(wire) && typeof wire.query === "string" && isRecord(wire.variables));
          assert.match(wire.query, /^query\b/u);
          return Response.json({ data: api.graphql(wire.query, wire.variables).data });
        }
        assert.equal(init?.method, "GET");
        const endpoint = url.pathname.slice(1) + url.search;
        if (endpoint.includes("/actions/jobs/")) {
          observerReads++;
          const response = observerApi.request("GET", endpoint);
          return Response.json(response.body, { status: response.status ?? 500 });
        }
        const response = api.request("GET", endpoint);
        return Response.json(response.body ?? null, { status: response.status ?? 500 });
      },
    );
    const source = await authenticateReleaseControlSource(
      { ...runtime.environment, GH_TOKEN: "synthetic-coordinator" },
      runtime.workflow,
      { ...options, deadline: performance.now() + 10000, controlReader: "coordinator-application" },
    );
    const result = await source.readSdkRequest(request);
    assert.equal(observerReads, 3);
    assert.equal(result.classification.status, persisted ? "reviewed" : "missing");
    if (persisted) {
      assert.equal(result.classification.status, "reviewed");
      if (result.classification.status === "reviewed")
        assert.deepEqual(result.classification.opportunity, opportunity);
      conflict = true;
      await assert.rejects(source.readSdkRequest(request, "effect"), /conflict/);
      conflict = false;
      control.conflicting();
      await assert.rejects(source.readSdkRequest(request));
    } else {
      await assert.rejects(source.readSdkDisposition(request), /absent or ambiguous/u);
      conflict = true;
      const disposition = await source.readSdkDisposition(request);
      assert.equal(disposition.disposition.check_run_id, 505);
      assert.equal(disposition.disposition.wire.request.request_id, request.request_id);
    }
    runtime.advance(60001);
    await assert.rejects(source.readSdkRequest(request), /fresh/u);
    assert.equal(control.mutations(), persisted ? 1 : 0);
    fetcher.mock.restore();
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

for (const controlReader of [
  "admitted-aggregate",
  "coordinator-application",
  "site-application",
  "site-maintenance",
  "metadata-maintenance",
  "payload",
  "tuf-maintenance",
  "tuf-application",
  "publication-application",
] as const)
  void test(`fixed ${controlReader} joins locked SDK ref, file and original observer reads`, async (t) => {
    const aggregate = controlReader === "admitted-aggregate";
    const publication = controlReader === "publication-application";
    const classification =
      aggregate ||
      publication ||
      controlReader === "coordinator-application" ||
      controlReader === "payload" ||
      controlReader === "tuf-application" ||
      controlReader === "site-application";
    const phase = aggregate
      ? "admission"
      : controlReader === "site-maintenance" || controlReader === "site-application"
        ? "site-publication"
        : controlReader === "metadata-maintenance" || controlReader === "coordinator-application"
          ? "coordinator"
          : controlReader === "payload"
            ? "payload"
            : publication
              ? "release-publication"
              : "tuf-preview";
    const control = releaseControlInputsFixture(
      capacityDocumentFixture(),
      opportunity,
      config,
      true,
    );
    if (classification)
      persistReviewedClassification(control.api, config, opportunity, 303, () => {});
    const protection = publication
      ? publicationProtection(control.head())
      : protectionFixture(control.head());
    const runtime = liveControlRuntimeFixture(protection, config, phase, aggregate);
    const { observerApi, ...options } = runtime.options;
    const before = await runtime.create();
    const expected = classification
      ? before.read(control.api, opportunity)
      : before.readMaintenance(control.api);
    const priorMutations = control.mutations();
    const base = "https://api.github.com";
    const reads: string[] = [];
    let riskScope = false;
    let expireOnObserver = false;
    let stallBody = false;
    let oversizedBody = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        assert.ok(url.startsWith(base + "/"));
        const endpoint = url.slice(base.length);
        reads.push(endpoint);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          riskScope && !endpoint.includes("/actions/jobs/")
            ? "token synthetic-risk"
            : "token synthetic-site",
        );
        if (endpoint === "/graphql") {
          assert.equal(init?.method, "POST");
          assert.ok(typeof init.body === "string");
          const wire: unknown = JSON.parse(init.body);
          assert.ok(isRecord(wire) && typeof wire.query === "string" && isRecord(wire.variables));
          const { query, variables } = wire;
          assert.ok(
            variables.ref === "refs/heads/portcove-release-pause" ||
              (classification && variables.ref === "refs/heads/portcove-release-inputs"),
          );
          return Response.json({ data: control.api.graphql(query, variables).data });
        }
        assert.equal(init?.method, "GET");
        if (stallBody && endpoint === "/repos/boburning/portcove")
          return new Response(new ReadableStream(), {
            headers: { "content-type": "application/json" },
          });
        if (endpoint.startsWith("/repos/boburning/portcove/actions/jobs/")) {
          if (expireOnObserver) runtime.advance(60001);
          const result = observerApi.request("GET", endpoint.slice(1));
          return Response.json(result.body, { status: result.status ?? 500 });
        }
        if (classification && endpoint === "/repos/boburning/portcove/check-runs/303") {
          const check = control.api.request("GET", endpoint.slice(1));
          return Response.json(check.body, { status: check.status ?? 500 });
        }
        assert.match(
          endpoint,
          /^\/repos\/boburning\/portcove(?:\/git\/(?:commits|trees|blobs)\/[a-f0-9]{40})?$/u,
        );
        const result = control.api.request("GET", endpoint.slice(1));
        const body =
          oversizedBody && endpoint === "/repos/boburning/portcove" && isRecord(result.body)
            ? { ...result.body, padding: "x".repeat(256 * 1024) }
            : result.body;
        return Response.json(body, { status: result.status ?? 500 });
      },
    );
    const source = await authenticateReleaseControlSource(
      {
        ...runtime.environment,
        GH_TOKEN: "synthetic-site",
        PORTCOVE_RELEASE_READ_TOKEN: "synthetic-risk",
      },
      runtime.workflow,
      { ...options, deadline: performance.now() + 5000, controlReader },
    );
    const read = () =>
      classification
        ? source.readSdkApplicationControls(opportunity)
        : controlReader === "metadata-maintenance"
          ? source.readSdkMaintenance(undefined, {
              deadline: performance.now() + 1000,
              signingContext: true,
            })
          : source.readSdkMaintenance();
    const observed = await read();
    assert.deepEqual(observed.pause, expected.pause);
    assert.deepEqual(observed.capacity_source, expected.capacity_source);
    assert.equal(observed.facts_sha256, expected.facts_sha256);
    assert.equal(
      reads.filter((endpoint) => endpoint === "/graphql").length,
      classification ? 6 : 4,
    );
    assert.equal(
      reads.filter((endpoint) => endpoint === "/repos/boburning/portcove").length,
      classification ? 3 : 2,
    );
    assert.match(reads[0] ?? "", /\/actions\/jobs\//u);
    assert.equal(reads.at(-1), reads[0]);
    assert.equal(control.mutations(), priorMutations);
    const callsPerObservation = reads.length - 1;
    if (classification && controlReader !== "coordinator-application") {
      const start = reads.length;
      let charged = 0;
      let elapsed = 0;
      let measured = 0;
      const accounting = {
        reserve() {
          return {
            consumeBytes() {},
            settle({ dispatched }: { dispatched: boolean }) {
              if (dispatched) charged++;
            },
          };
        },
        elapsed(milliseconds: number) {
          measured++;
          elapsed += milliseconds;
        },
        currentDeadline: () => performance.now() + 1000 - elapsed,
      };
      assert.deepEqual(
        await source.readSdkApplicationControls(opportunity, { admission: accounting }),
        observed,
      );
      assert.equal(charged, reads.length - start - 1);
      assert.equal(measured, charged);
      assert.ok(elapsed > 0);
      assert.equal(reads.at(-1), reads[0]);
      if (aggregate) {
        const beforeOversize = reads.length;
        oversizedBody = true;
        await assert.rejects(
          source.readSdkApplicationControls(opportunity, { maxBytes: 256 * 1024 }),
          /exceeds its byte limit/u,
        );
        assert.deepEqual(reads.slice(beforeOversize), ["/repos/boburning/portcove"]);
        oversizedBody = false;
        const beforeTimeout = reads.length;
        await assert.rejects(
          source.readSdkApplicationControls(opportunity, {
            admission: { ...accounting, currentDeadline: () => performance.now() - 1 },
          }),
          /admission API acquisition bound/u,
        );
        assert.equal(reads.length, beforeTimeout);
      }
    }
    if (aggregate) {
      assert.equal(source.evidence_scope, "injected-provider");
      for (let round = 0; round < 2; round++) {
        const beforeRead = reads.length;
        assert.deepEqual(await read(), observed);
        assert.equal(reads.length - beforeRead, callsPerObservation);
      }
      const beforeRefusal = reads.length;
      const originalProxy = process.env.NODE_USE_ENV_PROXY;
      process.env.NODE_USE_ENV_PROXY = "1";
      try {
        await assert.rejects(read());
      } finally {
        if (originalProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
        else process.env.NODE_USE_ENV_PROXY = originalProxy;
      }
      const readOnly = liveControlRuntimeFixture(protection, config, "admission");
      const { observerApi: _observer, ...readOnlyOptions } = readOnly.options;
      await assert.rejects(
        authenticateReleaseControlSource(
          { ...readOnly.environment, GH_TOKEN: "synthetic-site" },
          readOnly.workflow,
          { ...readOnlyOptions, deadline: performance.now() + 5000, controlReader },
        ),
        /protected application admission/u,
      );
      assert.equal(reads.length, beforeRefusal);
    }
    if (publication || controlReader === "payload") {
      const start = reads.length;
      let reserved = 0;
      let dispatched = 0;
      riskScope = true;
      const risk = await source.readSdkApplicationControls(opportunity, {
        deadline: performance.now() + 1000,
        reserve: () => {
          reserved++;
          return {
            consumeBytes() {},
            settle(value) {
              if (value.dispatched) dispatched++;
            },
          };
        },
      });
      riskScope = false;
      assert.equal(risk.facts_sha256, expected.facts_sha256);
      assert.equal(reserved, dispatched);
      assert.equal(dispatched, reads.length - start - 1);
      assert.equal(reads.at(-1), reads[0]);
    }
    if (controlReader === "metadata-maintenance") {
      stallBody = true;
      const beforeStall = reads.length;
      await assert.rejects(
        source.readSdkMaintenance(undefined, {
          deadline: performance.now() + 150,
          signingContext: true,
        }),
        /deadline|abort/u,
      );
      assert.deepEqual(reads.slice(beforeStall), ["/repos/boburning/portcove"]);
      stallBody = false;
    }
    expireOnObserver = true;
    await assert.rejects(read(), /fresh|expired/u);
  });

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
      GH_TOKEN: "ghs_SYNTHETIC_SELECTED_CATALOG_READER",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token?fixture=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-fixture-control-bearer",
    };
    const before = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    let driftDuringTokenRead = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const auth = new Headers(init?.headers).get("authorization");
        if (url.hostname === "fixture.actions.githubusercontent.com") {
          assert.equal(url.searchParams.get("audience"), profile.reader_audience);
          assert.equal(auth, "Bearer inert-fixture-control-bearer");
          if (driftDuringTokenRead) process.env.PORTCOVE_EXECUTION_PURPOSE = "application";
          return Response.json({ value: provider.token });
        }
        if (url.hostname === "token.actions.githubusercontent.com") {
          assert.equal(auth, null);
          return Response.json({ keys: [jwk] });
        }
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(auth, `token ${environment.GH_TOKEN}`);
        const page = url.searchParams.get("page");
        const route = page ? `${url.pathname}?per_page=100&page=${page}` : url.pathname;
        return Response.json(provider.metadata(route));
      },
    );
    t.after(() => {
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
