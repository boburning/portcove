import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectCatalogAuthorityConfiguration,
  inspectReleaseAuthorityConfiguration,
  inspectBoundCatalogControllerAuthorities,
  requireControllerCatalogPublicationAuthorities,
  assertControllerCatalogPublisherScope,
} from "./release-authority-configuration.mts";
import {
  admitProductionCatalogInputReader,
  admitProductionInputReader,
  admitProductionController,
  admitProductionCatalogController,
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
  capacityDocumentFixture,
} from "./fixtures/release-live-control-fixture.mts";
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
function runtime() {
  const control = releaseControlInputsFixture(capacityDocumentFixture());
  const actual = liveControlRuntimeFixture(
    protectionFixture(control.head()),
    undefined,
    "coordinator",
    true,
  );
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
  return { actual, config, policy, environment, control };
}
void test("catalog configuration appoints only distinct minimal roles and never application authorities", () => {
  const config = configuration();
  const parsed = inspectCatalogAuthorityConfiguration(config);
  assert.equal(parsed.kind, "catalog-publication-authorities");
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
  ])
    assert.throws(() => inspect({ ...policy, decision: { ...policy.decision, ...delta } }));
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
});
