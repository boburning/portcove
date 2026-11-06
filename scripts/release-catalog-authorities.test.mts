import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { createFixedControlReadAllowance } from "./release-control-inputs.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { isRecord } from "./runtime-values.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectCatalogAuthorityConfiguration,
  inspectReleaseAuthorityConfiguration,
  inspectBoundCatalogControllerAuthorities,
  requireControllerCatalogPublicationAuthorities,
  requireControllerJobCredentialRoute,
  assertControllerCatalogPublisherScope,
  requireFixedControllerJobSourceConfiguration,
  requireCoordinatorAuthorityConfiguration,
} from "./release-authority-configuration.mts";
import {
  admitProductionCatalogInputReader,
  admitProductionInputReader,
  admitProductionController,
  admitProductionCatalogController,
  productionControllerWorkflow,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import {
  authenticateCatalogControlReaderJob,
  authenticateControlReaderJob,
  authenticateCatalogReleaseControlSource,
  requireAuthenticatedCatalogControlSource,
  requireAuthenticatedReleaseControlSource,
} from "./release-live-control-admission.mts";
import {
  liveControlRuntimeFixture,
  protectionFixture,
  catalogProtectionFixture,
  capacityDocumentFixture,
} from "./fixtures/release-live-control-fixture.mts";
import { selectedPublicationAuthoritiesFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { assemblerIdentityFixture, jwk } from "./fixtures/assembler-identity-fixture.mts";
import { releaseControlInputsFixture } from "./fixtures/release-control-inputs-fixture.mts";

function configuration() {
  return {
    schema_version: 1,
    kind: "catalog-publication-authorities",
    namespace: "portcove-catalog",
    repository_id: 1354613114,
    apps: {
      semantic: { app_id: 101, installation_id: 1001 },
      classification: { app_id: 202, installation_id: 1002 },
      protection_observer: { app_id: 303, installation_id: 1003 },
      coordinator_journal: { app_id: 404, installation_id: 1004 },
      dispatch: { app_id: 505, installation_id: 1005, actor_id: "123456" },
    },
    catalog: {
      public_source: {
        commit: "a".repeat(40),
        root: { path: "public/catalog-root.json", bytes: 2, sha256: "b".repeat(64) },
        offline_targets: { path: "public/catalog-targets.json", bytes: 2, sha256: "c".repeat(64) },
      },
      setup_plan_sha256: "d".repeat(64),
      publisher_scope: [
        {
          namespace: "official",
          stable_id: "fixture",
          template: "staged-source-portable",
          repository_id: 123,
          artifact_hosts: ["github.com", "release-assets.githubusercontent.com"],
          max_redirects: 2,
          operations: ["install", "update", "prepare", "launch"],
          policy_schemas: [1, 2, 3, 4],
        },
      ],
    },
  };
}
function runtime(
  catalogCoverage = true,
  phase: "coordinator" | "catalog-timestamp" = "coordinator",
) {
  const control = releaseControlInputsFixture(capacityDocumentFixture());
  const observation = catalogCoverage
    ? catalogProtectionFixture(control.head())
    : protectionFixture(control.head());
  const actual = liveControlRuntimeFixture(observation, undefined, phase, true);
  const config = configuration();
  config.apps.dispatch.actor_id = actual.policy.actor_id;
  const policy = {
    ...actual.policy,
    mode: "bounded-catalog-publication",
    authority_configuration_sha256: digest(inspectCatalogAuthorityConfiguration(config)),
  };
  const environment = {
    ...actual.environment,
    PORTCOVE_CONTROLLER_ADMISSION: undefined,
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: JSON.stringify(policy),
    PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify(config),
  };
  return { actual, config, policy, environment, control, observation };
}
void test("fixed legacy catalog source routing retains configured dispatch-actor equality", () => {
  const f = runtime();
  const source = admitProductionCatalogInputReader(
    JSON.stringify(f.policy),
    f.environment,
    f.actual.workflow,
    "coordinator",
  );
  const binding = requireFixedControllerJobSourceConfiguration(
    f.config,
    source,
    "coordinator",
    "catalog-publication",
  );
  assert.equal(binding.actor_id, f.config.apps.dispatch.actor_id);
  const view = requireCoordinatorAuthorityConfiguration(f.config, source, "catalog-publication");
  assert.equal(view.configuration_sha256, digest(inspectCatalogAuthorityConfiguration(f.config)));
  assert.equal(view.semantic_producer.schema_version, 1);
  assert.ok("writer_app_id" in view.semantic_producer);
  const changed = structuredClone(f.config);
  changed.apps.dispatch.actor_id = "999";
  const changedPolicy = { ...f.policy, authority_configuration_sha256: digest(changed) };
  const changedSource = admitProductionCatalogInputReader(
    JSON.stringify(changedPolicy),
    f.environment,
    f.actual.workflow,
    "coordinator",
  );
  assert.throws(
    () =>
      requireFixedControllerJobSourceConfiguration(
        changed,
        changedSource,
        "coordinator",
        "catalog-publication",
      ),
    /configuration\/dispatch changed/,
  );
  assert.throws(
    () => requireCoordinatorAuthorityConfiguration(changed, changedSource, "catalog-publication"),
    /configuration\/dispatch changed/,
  );
});
void test("catalog configuration appoints only distinct minimal roles and never application authorities", () => {
  const config = configuration();
  const parsed = inspectCatalogAuthorityConfiguration(config);
  assert.equal(parsed.kind, "catalog-publication-authorities");
  const bootstrap = structuredClone(config) as typeof config & {
    catalog: {
      public_source: { initial_site_preimage?: { path: string; bytes: number; sha256: string } };
    };
  };
  bootstrap.catalog.public_source.initial_site_preimage = {
    path: "public/catalog-initial-site.json",
    bytes: 123,
    sha256: "e".repeat(64),
  };
  assert.notEqual(digest(inspectCatalogAuthorityConfiguration(bootstrap)), digest(parsed));
  for (const changed of [
    { ...bootstrap.catalog.public_source.initial_site_preimage, bytes: 128 * 1024 + 1 },
    {
      ...bootstrap.catalog.public_source.initial_site_preimage,
      path: config.catalog.public_source.root.path,
    },
    {
      ...bootstrap.catalog.public_source.initial_site_preimage,
      sha256: config.catalog.public_source.root.sha256,
    },
  ])
    assert.throws(() =>
      inspectCatalogAuthorityConfiguration({
        ...bootstrap,
        catalog: {
          ...bootstrap.catalog,
          public_source: { ...bootstrap.catalog.public_source, initial_site_preimage: changed },
        },
      }),
    );
  assert.throws(() => inspectReleaseAuthorityConfiguration(config));
  for (const changed of [
    { ...config, native: {} },
    {
      ...config,
      apps: { ...config.apps, native_qualification: { app_id: 606, installation_id: 1006 } },
    },
    { ...config, apps: { ...config.apps, semantic: config.apps.classification } },
    { ...config, apps: { ...config.apps, semantic: { app_id: 15368, installation_id: 1001 } } },
    {
      ...config,
      catalog: {
        ...config.catalog,
        public_source: { ...config.catalog.public_source, payload_key_registry: {} },
      },
    },
    {
      ...config,
      catalog: {
        ...config.catalog,
        publisher_scope: [{ ...config.catalog.publisher_scope[0], operations: ["sign"] }],
      },
    },
  ])
    assert.throws(() => inspectCatalogAuthorityConfiguration(changed));
});
void test("catalog source policy and complete configuration digest refuse app grants, changed scope and mismatched dispatch", () => {
  const f = runtime();
  const bootstrap = { ...f.environment, GITHUB_JOB: "admission" };
  assert.equal(
    admitProductionCatalogController(
      f.environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      bootstrap,
      f.actual.workflow,
    ).mode,
    "bounded-catalog-publication",
  );
  assert.throws(() =>
    admitProductionController(
      f.environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      bootstrap,
      f.actual.workflow,
    ),
  );
  const admitted = admitProductionCatalogInputReader(
    f.environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
    f.environment,
    f.actual.workflow,
    "coordinator",
  );
  const bound = inspectBoundCatalogControllerAuthorities(f.config, admitted);
  assert.equal(bound.configuration_sha256, digest(inspectCatalogAuthorityConfiguration(f.config)));
  assert.throws(() =>
    admitProductionInputReader(
      f.environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      f.environment,
      f.actual.workflow,
      "coordinator",
    ),
  );
  assert.throws(() =>
    admitProductionCatalogInputReader(
      JSON.stringify({ ...f.policy, mode: "bounded-application-release" }),
      f.environment,
      f.actual.workflow,
      "coordinator",
    ),
  );
  assert.throws(() =>
    admitProductionCatalogInputReader(
      f.environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      f.environment,
      f.actual.workflow,
      "payload",
    ),
  );
  assert.throws(() =>
    inspectBoundCatalogControllerAuthorities(
      { ...f.config, catalog: { ...f.config.catalog, setup_plan_sha256: "f".repeat(64) } },
      admitted,
    ),
  );
  assert.throws(() =>
    inspectBoundCatalogControllerAuthorities(f.config, { ...admitted, actor_id: "99999" }),
  );
});
void test("catalog OIDC control source is purpose-separated and retains existing pause/capacity/protection protocol", async () => {
  const f = runtime();
  const identity = await authenticateCatalogControlReaderJob(
    f.environment,
    f.actual.workflow,
    f.actual.options,
  );
  assert.equal(identity.identity.evidence_scope, "injected-provider");
  const source = await authenticateCatalogReleaseControlSource(
    f.environment,
    f.actual.workflow,
    f.actual.options,
  );
  requireAuthenticatedCatalogControlSource(source, "coordinator");
  assert.throws(() => requireAuthenticatedReleaseControlSource(source, "coordinator"));
  assert.throws(() => requireAuthenticatedCatalogControlSource({ ...source }, "coordinator"));
  const controls = source.readMaintenance(f.control.api);
  assert.equal(controls.purpose, "catalog-coordinator-controls");
  assert.equal(controls.capacity_source.report.availability, "unknown");
  assert.equal(controls.capacity_source.report.headroom, "unknown");
  assert.equal(controls.capacity_source.report.reservation, "none");
  assert.throws(() => source.read(f.control.api, {}), /application classification/);
  assert.throws(() => source.readRequest(f.control.api, {}), /application request/);
  assert.throws(() => source.readDisposition(f.control.api, {}), /application disposition/);
  await assert.rejects(
    authenticateControlReaderJob(f.environment, f.actual.workflow, f.actual.options),
    /missing/,
  );
  const changed = {
    ...f.environment,
    PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify({
      ...f.config,
      catalog: { ...f.config.catalog, setup_plan_sha256: "f".repeat(64) },
    }),
  };
  await assert.rejects(
    authenticateCatalogReleaseControlSource(changed, f.actual.workflow, f.actual.options),
    /changed after ratification/,
  );
});
for (const phase of ["catalog-timestamp", "coordinator"] as const)
  void test(`fixed catalog ${phase} maintenance joins SDK pause and capacity reads with original observer identity`, async (t) => {
    const f = runtime(true, phase);
    const { observerApi, ...options } = f.actual.options;
    const original = await authenticateCatalogReleaseControlSource(
      f.environment,
      f.actual.workflow,
      f.actual.options,
    );
    const expected = original.readMaintenance(f.control.api);
    const routes: string[] = [];
    let jobToken = "inert-catalog-controls";
    let expireOnObserver = false;
    let stallObserver = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(
          request.headers.get("authorization"),
          `token ${url.pathname.includes("/actions/jobs/") ? jobToken : "inert-catalog-controls"}`,
        );
        routes.push(url.pathname);
        if (url.pathname === "/graphql") {
          assert.equal(request.method, "POST");
          const wire: unknown = await request.json();
          assert.ok(isRecord(wire) && typeof wire.query === "string" && isRecord(wire.variables));
          assert.equal(wire.variables.ref, "refs/heads/portcove-release-pause");
          return Response.json({ data: f.control.api.graphql(wire.query, wire.variables).data });
        }
        assert.equal(request.method, "GET");
        const route = url.pathname.slice(1) + url.search;
        if (route.includes("/actions/jobs/")) {
          if (stallObserver)
            return new Response(new ReadableStream(), {
              headers: { "content-type": "application/json" },
            });
          if (expireOnObserver) f.actual.advance(60001);
          const job = observerApi.request("GET", route);
          return Response.json(job.body, { status: job.status });
        }
        const result = f.control.api.request("GET", route);
        return Response.json(result.body, { status: result.status ?? 500 });
      },
    );
    const source = await authenticateCatalogReleaseControlSource(
      { ...f.environment, GH_TOKEN: "inert-catalog-controls" },
      f.actual.workflow,
      { ...options, controlReader: "catalog-maintenance", deadline: performance.now() + 5000 },
    );
    await assert.rejects(source.readSdkMaintenance(), /scoped maintenance reader unavailable/u);
    const reserve = createFixedControlReadAllowance();
    const coordinator =
      phase === "coordinator"
        ? { deadline: performance.now() + 1000, signingContext: true as const }
        : undefined;
    const observed = await source.readSdkMaintenance(reserve, coordinator);
    assert.equal(
      observed.purpose,
      phase === "coordinator" ? "catalog-coordinator-controls" : "catalog-signing-controls",
    );
    assert.equal(observed.facts_sha256, expected.facts_sha256);
    assert.equal(routes[0], "/repos/boburning/portcove/actions/jobs/600");
    assert.equal(routes.at(-1), routes[0]);
    assert.equal(routes.filter((route) => route === "/graphql").length, 4);
    assert.equal(f.control.mutations(), 0);
    if (coordinator) {
      const scoped = await mkdtemp(path.join(os.tmpdir(), "catalog-observer-"));
      t.after(() => rm(scoped, { recursive: true, force: true }));
      const previousToken = process.env.GH_TOKEN;
      const mixed = await (async () => {
        jobToken = "original-observer-scope";
        process.env.GH_TOKEN = jobToken;
        try {
          return await withReadOnlyReleaseChildren(scoped, () =>
            authenticateCatalogReleaseControlSource(
              { ...f.environment, GH_TOKEN: "inert-catalog-controls" },
              f.actual.workflow,
              {
                ...f.actual.options,
                deadline: performance.now() + 3000,
                catalogRecoveryObserver: true,
              },
            ),
          );
        } finally {
          if (previousToken === undefined) delete process.env.GH_TOKEN;
          else process.env.GH_TOKEN = previousToken;
        }
      })();
      assert.equal(routes.at(-1), "/repos/boburning/portcove/actions/jobs/600");
      const start = routes.length;
      let dispatched = 0;
      const reserveMixed = () => ({
        consumeBytes() {},
        settle(observation: { dispatched: boolean }) {
          if (observation.dispatched) dispatched++;
        },
      });
      await assert.rejects(
        mixed.readCatalogRecoveryMaintenance("different-token", reserveMixed),
        /original fixed maintenance reader/u,
      );
      assert.equal(routes.length, start);
      const mixedFacts = await mixed.readCatalogRecoveryMaintenance(
        "inert-catalog-controls",
        reserveMixed,
      );
      assert.equal(mixedFacts.facts_sha256, expected.facts_sha256);
      assert.equal(dispatched, routes.length - start - 1);
      assert.ok(dispatched > 0);
      assert.equal(routes.at(-1), "/repos/boburning/portcove/actions/jobs/600");
      assert.equal(
        routes.slice(start).filter((route) => route.includes("/actions/jobs/")).length,
        1,
      );
      const beforeExhaustion = routes.length;
      await assert.rejects(
        mixed.readCatalogRecoveryMaintenance("inert-catalog-controls", () => {
          throw new Error("catalog continuation read budget exhausted");
        }),
        /catalog continuation read budget exhausted/u,
      );
      assert.equal(routes.length, beforeExhaustion);
      assert.equal(mixed.readMaintenance(f.control.api).facts_sha256, expected.facts_sha256);
      jobToken = "inert-catalog-controls";
      assert.equal(f.control.mutations(), 0);
      const shared = createFixedControlReadAllowance();
      const provider = await createReleaseCustodyProvider({
        token: "inert-catalog-controls",
        deadline: coordinator.deadline,
        reserve: shared,
      });
      for (let count = 0; count < 32; count++) await provider.repository(coordinator.deadline);
      const beforeRefusal = routes.length;
      await assert.rejects(source.readSdkMaintenance(shared, coordinator), /read bound exhausted/u);
      assert.equal(routes.length, beforeRefusal);

      stallObserver = true;
      await assert.rejects(
        source.readSdkMaintenance(createFixedControlReadAllowance(), {
          ...coordinator,
          deadline: performance.now() + 150,
        }),
        /deadline|abort/u,
      );
      assert.equal(routes.at(-1), "/repos/boburning/portcove/actions/jobs/600");
      stallObserver = false;
    }
    expireOnObserver = true;
    await assert.rejects(
      source.readSdkMaintenance(createFixedControlReadAllowance(), coordinator),
      /fresh|expired/u,
    );
  });
void test("selected full catalog controls retain actual fixed reader and isolated observer verification without a Classification App", async () => {
  const f = runtime();
  const configuration = selectedPublicationAuthoritiesFixture("catalog-publication");
  const environment = {
    ...f.environment,
    PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify(configuration),
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: JSON.stringify({
      ...f.policy,
      authority_configuration_sha256: digest(configuration),
    }),
  };
  const source = await authenticateCatalogReleaseControlSource(
    environment,
    f.actual.workflow,
    f.actual.options,
  );
  requireAuthenticatedCatalogControlSource(source, "coordinator");
  assert.throws(() => requireAuthenticatedReleaseControlSource(source, "coordinator"));
  const facts = source.readMaintenance(f.control.api);
  assert.equal(facts.purpose, "catalog-coordinator-controls");
  assert.equal(facts.capacity_source.report.availability, "unknown");
  assert.equal(facts.capacity_source.report.headroom, "unknown");
  assert.equal(facts.capacity_source.report.reservation, "none");
  assert.equal(facts.authority, "none");
  for (const raw of [
    configuration.journal,
    selectedPublicationAuthoritiesFixture("application"),
    { ...configuration, purpose: ["catalog-publication"] },
    { ...configuration, journal: { ...configuration.journal, setup_plan_sha256: "f".repeat(64) } },
  ]) {
    await assert.rejects(
      authenticateCatalogReleaseControlSource(
        {
          ...environment,
          PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify(raw),
        },
        f.actual.workflow,
        f.actual.options,
      ),
    );
  }
  await assert.rejects(
    authenticateCatalogReleaseControlSource(
      {
        ...environment,
        GITHUB_JOB: "classification",
      },
      f.actual.workflow,
      f.actual.options,
    ),
  );
  f.actual.observerJob.head_sha = "f".repeat(40);
  await assert.rejects(
    authenticateCatalogReleaseControlSource(environment, f.actual.workflow, f.actual.options),
    /observer/,
  );
  f.actual.observerJob.head_sha = f.actual.policy.revision;
  f.actual.advance(60_001);
  assert.throws(() => source.readMaintenance(f.control.api), /protection inventory unavailable/);
});
void test("catalog live controls reject application-coverage observations rather than requiring its classification ref", async () => {
  const oldAppObservation = runtime(false);
  await assert.rejects(
    authenticateCatalogReleaseControlSource(
      oldAppObservation.environment,
      oldAppObservation.actual.workflow,
      oldAppObservation.actual.options,
    ),
    /protection inventory unavailable/,
  );
  const catalog = runtime();
  const source = await authenticateCatalogReleaseControlSource(
    catalog.environment,
    catalog.actual.workflow,
    catalog.actual.options,
  );
  const facts = source.readMaintenance(catalog.control.api);
  assert.equal(facts.purpose, "catalog-coordinator-controls");
  assert.deepEqual(
    catalog.observation.inventory.branches.map((row) => row.branch),
    ["portcove-release-pause"],
  );
  assert.equal(facts.authority, "none");
});
void test("fixed catalog source routing reads the actual signed job through the locked SDK", async (t) => {
  const f = runtime();
  const profile = releaseControlPhaseProfile("coordinator");
  const identity = assemblerIdentityFixture(
    {
      aud: profile.reader_audience,
      sub: controllerOidcSubject(f.policy.execution_ref, profile.reader_environment),
      environment: profile.reader_environment,
    },
    {},
    { workflow: productionControllerWorkflow, job: profile.reader_name, runAttempt: 1 },
  );
  const readerToken = "ghs_SYNTHETIC_CATALOG_SOURCE_READER";
  const environment = {
    ...f.environment,
    PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: JSON.stringify({
      ...f.policy,
      workflow_sha256: createHash("sha256")
        .update(await readProductionControllerWorkflowBytes())
        .digest("hex"),
    }),
    GH_TOKEN: readerToken,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-oidc-bearer",
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const providerRoutes: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.origin === "https://fixture.actions.githubusercontent.com") {
        assert.equal(url.searchParams.get("audience"), profile.reader_audience);
        assert.equal(auth, "Bearer inert-oidc-bearer");
        return Response.json({ value: identity.token });
      }
      if (url.origin === "https://token.actions.githubusercontent.com") {
        assert.equal(url.pathname, "/.well-known/jwks");
        assert.equal(auth, null);
        return Response.json({ keys: [jwk] });
      }
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(auth, `token ${readerToken}`);
      const page = url.searchParams.get("page");
      const route = page ? `${url.pathname}?per_page=100&page=${page}` : url.pathname;
      providerRoutes.push(route);
      return Response.json(identity.metadata(route));
    },
  );
  const routed = await requireControllerJobCredentialRoute("coordinator");
  assert.equal(routed.route.purpose, "catalog-publication");
  routed.recheck();
  const catalog = await requireControllerCatalogPublicationAuthorities("coordinator");
  assert.equal(catalog.configuration_sha256, f.policy.authority_configuration_sha256);
  const run = "/repos/boburning/portcove/actions/runs/9988";
  const expected = [
    run,
    `${run}/attempts/1/jobs?per_page=100&page=1`,
    `${run}/attempts/1/jobs?per_page=100&page=2`,
    "/repos/boburning/portcove/actions/jobs/501",
    run,
  ];
  assert.deepEqual(providerRoutes, [...expected, ...expected]);
});
void test("catalog actual getter refuses missing protected configuration before any OIDC effect", async () => {
  const saved = process.env.PORTCOVE_CATALOG_AUTHORITIES;
  delete process.env.PORTCOVE_CATALOG_AUTHORITIES;
  try {
    await assert.rejects(
      requireControllerCatalogPublicationAuthorities("coordinator"),
      /protected catalog/,
    );
  } finally {
    if (saved === undefined) delete process.env.PORTCOVE_CATALOG_AUTHORITIES;
    else process.env.PORTCOVE_CATALOG_AUTHORITIES = saved;
  }
});

void test("catalog actual getter respects the inherited expired phase before source or provider reads", async (t) => {
  const started = performance.now();
  await withCoordinatorDeadline(started + 1000, async () => {
    const clock = t.mock.method(performance, "now", () => started + 2000);
    try {
      await assert.rejects(
        requireControllerCatalogPublicationAuthorities("coordinator"),
        /phase deadline/,
      );
    } finally {
      clock.mock.restore();
    }
  });
});
void test("appointed catalog scope limits exact Core-bound titles/templates/schema and managed capabilities without granting acceptance", () => {
  const config = configuration();
  const entry = Buffer.from(JSON.stringify({ port: { adapter: "staged-source-portable" } }));
  const target = `sha256/${createHash("sha256").update(entry).digest("hex")}.json`;
  const policy = {
    policy_schema: 2,
    decision: {
      status: "managed_github",
      template: "staged-source-portable",
      repository_id: 123,
      artifact_hosts: ["github.com"],
      max_redirects: 1,
      operations: ["install"],
    },
  };
  const inspect = (rawPolicy: unknown, rawConfig: unknown = config) => {
    // Data-only model of an actual Core projection; this fixture never runs
    // Core or creates an authenticated report/accepted catalog receipt.
    const files = new Map([
      ["definitions/index.json", Buffer.from("{}")],
      [target, entry],
      ["policy/official/fixture.json", Buffer.from(JSON.stringify(rawPolicy))],
    ]);
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const report = {
      publication_schema: 1,
      authority: "none",
      scope: "inert-managed-definition-publication-inspection",
      index_sha256: sha(files.get("definitions/index.json")!),
      files: [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([target, bytes]) => ({ target, bytes: bytes.length, sha256: sha(bytes) })),
      definitions: [
        {
          namespace: "official",
          stable_id: "fixture",
          definition_target: target,
          policy_target: "policy/official/fixture.json",
          policy_schema: (rawPolicy as typeof policy).policy_schema,
        },
      ],
    };
    return assertControllerCatalogPublisherScope(rawConfig, report, files);
  };
  assert.equal(inspect(policy).authority, "none");
  const selected = selectedPublicationAuthoritiesFixture("catalog-publication");
  assert.ok(selected.purpose === "catalog-publication");
  selected.catalog = { ...config.catalog, setup_plan_sha256: selected.journal.setup_plan_sha256 };
  assert.equal(inspect(policy, selected).authority, "none");
  assert.equal(
    inspect({
      policy_schema: 1,
      decision: { status: "availability", template: "staged-source-portable" },
    }).authority,
    "none",
  );
  assert.equal(inspect({ policy_schema: 1, decision: { status: "revoked" } }).authority, "none");
  for (const delta of [
    { repository_id: 124 },
    { artifact_hosts: ["foreign.invalid"] },
    { max_redirects: 3 },
    { operations: ["launch", "sign"] },
    { template: "foreign" },
  ]) {
    assert.throws(() => inspect({ ...policy, decision: { ...policy.decision, ...delta } }));
    assert.throws(() =>
      inspect({ ...policy, decision: { ...policy.decision, ...delta } }, selected),
    );
  }
  assert.throws(() =>
    inspect(policy, {
      ...config,
      catalog: {
        ...config.catalog,
        publisher_scope: [{ ...config.catalog.publisher_scope[0], stable_id: "other" }],
      },
    }),
  );
  assert.throws(() => inspect(policy, { ...config, configuration_sha256: "0".repeat(64) }));
  assert.throws(() => inspect(policy, { ...selected, configuration_sha256: "0".repeat(64) }));
  assert.throws(() => inspect(policy, selectedPublicationAuthoritiesFixture("application")));
});

void test("descriptive directory requires explicit appointment without extending operational title scope", () => {
  const config = configuration();
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const target = "policy/official/catalog.listings.json";
  const files = new Map([
    ["definitions/index.json", Buffer.from("{}")],
    [target, Buffer.from("inert Core-inspected listing fixture")],
  ]);
  const report = {
    publication_schema: 2,
    authority: "none",
    scope: "inert-catalog-publication-inspection",
    index_sha256: sha(files.get("definitions/index.json")!),
    files: [...files].map(([target, bytes]) => ({
      target,
      bytes: bytes.length,
      sha256: sha(bytes),
    })),
    definitions: [],
    listings: {
      target,
      revision: 1,
      sha256: sha(files.get(target)!),
      listing_count: 1,
      withdrawn_count: 0,
    },
  };
  assert.throws(
    () => assertControllerCatalogPublisherScope(config, report, files),
    /outside appointed/,
  );
  const appointment = { listing_delivery_schema: 1, target };
  const appointed = {
    ...config,
    catalog: { ...config.catalog, publisher_scope: [], descriptive_directory: appointment },
  };
  assert.equal(assertControllerCatalogPublisherScope(appointed, report, files).authority, "none");
  for (const descriptive_directory of [
    { ...appointment, operations: ["launch"] },
    { ...appointment, listing_delivery_schema: 2 },
    { ...appointment, target: "policy/official/foreign.json" },
  ])
    assert.throws(() =>
      inspectCatalogAuthorityConfiguration({
        ...appointed,
        catalog: { ...appointed.catalog, descriptive_directory },
      }),
    );
  assert.throws(
    () =>
      assertControllerCatalogPublisherScope(
        appointed,
        {
          ...report,
          definitions: [
            {
              namespace: "official",
              stable_id: "foreign",
              definition_target: "definitions/official/foreign.json",
              policy_target: "policy/official/foreign.json",
            },
          ],
        },
        files,
      ),
    /outside appointed/,
  );
});
