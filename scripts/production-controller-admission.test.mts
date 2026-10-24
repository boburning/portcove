import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, writeFile, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  admitProductionController,
  admitReviewedInputsController,
  admitReviewedInputsWriter,
  admitProductionClassificationWriter,
  admitProductionClassificationObserver,
} from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectReleaseAuthorityConfiguration,
  inspectCatalogAuthorityConfiguration,
  inspectFixedJobJournalAuthorities,
  inspectBoundFixedJobJournalAuthorities,
  requireControllerFixedJobJournalAuthorities,
  inspectSelectedPublicationAuthorityConfiguration,
  inspectBoundSelectedPublicationAuthorities,
  requireControllerSelectedApplicationAuthorities,
  requireControllerSelectedCatalogAuthorities,
} from "./release-authority-configuration.mts";
import {
  fixedJobJournalAuthoritiesFixture,
  selectedPublicationAuthoritiesFixture,
} from "./fixtures/checkpoint-proof-fixture.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  capacityExecutorRolesForPurpose,
  capacityExecutorJobProfile,
} from "./assembler-job-identity.mts";

const source = Buffer.from("independently selected workflow fixture\n");
const policy = {
  schema_version: 1,
  mode: "admission-only",
  execution_ref: "refs/tags/portcove-production-controller-fixture",
  revision: "a".repeat(40),
  workflow_sha256: createHash("sha256").update(source).digest("hex"),
  actor_id: "123456",
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "boburning/portcove",
  GITHUB_REPOSITORY_ID: "1354613114",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/tags/portcove-production-controller-fixture",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_REF:
    "boburning/portcove/.github/workflows/application-update-production.yml@refs/tags/portcove-production-controller-fixture",
  GITHUB_ACTOR: "fixture-principal",
  GITHUB_ACTOR_ID: "123456",
  GITHUB_TRIGGERING_ACTOR: "fixture-principal",
  GITHUB_RUN_ID: "987654",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "admission",
  RUNNER_ENVIRONMENT: "github-hosted",
  PORTCOVE_CONTROLLER_REVISION: "a".repeat(40),
  PORTCOVE_CONTROLLER_REF: "refs/tags/portcove-production-controller-fixture",
};
const raw = JSON.stringify(policy);

void test("full selected scopes have separate purpose digests and the same custody-only journal projection", () => {
  const app = inspectSelectedPublicationAuthorityConfiguration(
    selectedPublicationAuthoritiesFixture("application"),
  );
  const catalog = inspectSelectedPublicationAuthorityConfiguration(
    selectedPublicationAuthoritiesFixture("catalog-publication"),
  );
  assert.deepEqual(app.journal, catalog.journal);
  assert.notEqual(releaseCanonicalDigest(app), releaseCanonicalDigest(catalog));
  assert.deepEqual(Object.keys(app.journal.apps).sort(), ["protection_observer", "semantic"]);
  for (const value of [app, catalog]) {
    assert.throws(() => inspectFixedJobJournalAuthorities(value));
    assert.throws(() => inspectReleaseAuthorityConfiguration(value));
    assert.throws(() => inspectCatalogAuthorityConfiguration(value));
    const source = {
      mode:
        value.purpose === "application"
          ? "bounded-application-release"
          : "bounded-catalog-publication",
      authority_configuration_sha256: releaseCanonicalDigest(value),
      grant_sha256: "f".repeat(64),
    };
    const bound = inspectBoundSelectedPublicationAuthorities(value, source, value.purpose);
    assert.equal(bound.journal_configuration_sha256, releaseCanonicalDigest(app.journal));
    assert.equal(bound.configuration_sha256, source.authority_configuration_sha256);
    assert.throws(
      () =>
        inspectBoundSelectedPublicationAuthorities(
          value,
          { ...source, authority_configuration_sha256: bound.journal_configuration_sha256 },
          value.purpose,
        ),
      /ratification/,
    );
    assert.throws(() =>
      inspectBoundSelectedPublicationAuthorities(
        value,
        { ...source, mode: "admission-only" },
        value.purpose,
      ),
    );
    assert.throws(() =>
      inspectBoundSelectedPublicationAuthorities(
        value,
        source,
        value.purpose === "application" ? "catalog-publication" : "application",
      ),
    );
    assert.throws(() =>
      inspectBoundSelectedPublicationAuthorities(
        value,
        { ...source, grant_sha256: "invalid" },
        value.purpose,
      ),
    );
  }
  assert.throws(() => inspectSelectedPublicationAuthorityConfiguration(app.journal));
});

void test("selected full scope refuses obsolete App roles, weaker native floors and changed publisher boundaries", () => {
  const app = selectedPublicationAuthoritiesFixture("application");
  assert.ok(app.purpose === "application");
  const catalog = selectedPublicationAuthoritiesFixture("catalog-publication");
  assert.ok(catalog.purpose === "catalog-publication");
  const windows = app.hosted_native["windows-x86_64"];
  const linux = app.hosted_native["linux-x86_64"];
  for (const changed of [
    { ...app, schema_version: 3 },
    { ...app, kind: "generic-actions" },
    { ...app, purpose: "all" },
    { ...app, purpose: "catalog-publication" },
    { ...catalog, purpose: "application" },
    { ...catalog, purpose: ["application"] },
    { ...catalog, purpose: ["catalog-publication"] },
    { ...app, apps: { dispatch: app.journal.apps.semantic } },
    {
      ...app,
      journal: {
        ...app.journal,
        apps: { ...app.journal.apps, dispatch: app.journal.apps.semantic },
      },
    },
    { ...app, native_prepublication_profile: "report-only" },
    { ...app, publication: { ...app.publication, setup_plan_sha256: "0".repeat(64) } },
    { ...catalog, catalog: { ...catalog.catalog, setup_plan_sha256: "0".repeat(64) } },
    {
      ...app,
      hosted_native: {
        ...app.hosted_native,
        "windows-x86_64": {
          ...windows,
          engine: { ...windows.engine, minimum_version: "155.0.4283.61" },
        },
      },
    },
    {
      ...app,
      hosted_native: {
        ...app.hosted_native,
        "linux-x86_64": { ...linux, engine: { ...linux.engine, minimum_version: "2.52.5" } },
      },
    },
    {
      ...app,
      hosted_native: {
        ...app.hosted_native,
        "linux-x86_64": { ...linux, minimum_platform: "ubuntu-22.04-x64" },
      },
    },
    {
      ...app,
      hosted_native: {
        ...app.hosted_native,
        "windows-x86_64": { ...windows, account: { password: "must-not-be-accepted" } },
      },
    },
    {
      ...app,
      hosted_native: {
        ...app.hosted_native,
        "windows-x86_64": {
          ...windows,
          compatibility: { ...windows.compatibility, cli_protocol: { min: 2, max: 1 } },
        },
      },
    },
    {
      ...catalog,
      catalog: {
        ...catalog.catalog,
        publisher_scope: [{ ...catalog.catalog.publisher_scope[0], namespace: "unreviewed" }],
      },
    },
    {
      ...catalog,
      catalog: {
        ...catalog.catalog,
        publisher_scope: [{ ...catalog.catalog.publisher_scope[0], max_redirects: 6 }],
      },
    },
    {
      ...catalog,
      catalog: {
        ...catalog.catalog,
        publisher_scope: [{ ...catalog.catalog.publisher_scope[0], policy_schemas: [5] }],
      },
    },
  ])
    assert.throws(() => inspectSelectedPublicationAuthorityConfiguration(changed));
  const source = {
    mode: "bounded-application-release",
    authority_configuration_sha256: releaseCanonicalDigest(app),
    grant_sha256: "f".repeat(64),
  };
  const changed = {
    ...app,
    publication: {
      ...app.publication,
      public_source: {
        ...app.publication.public_source,
        root: { ...app.publication.public_source.root, sha256: "1".repeat(64) },
      },
    },
  };
  assert.deepEqual(changed.journal, app.journal);
  assert.throws(
    () => inspectBoundSelectedPublicationAuthorities(changed, source, "application"),
    /ratification/,
  );
});

void test("actual full selected readers bind their own frozen source while journal readers retain only common custody", async (t) => {
  const workflow = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const app = selectedPublicationAuthoritiesFixture("application");
  const catalog = selectedPublicationAuthoritiesFixture("catalog-publication");
  assert.ok(app.purpose === "application" && catalog.purpose === "catalog-publication");
  const bounded = {
    ...policy,
    schema_version: 2,
    mode: "bounded-application-release",
    authority_configuration_sha256: releaseCanonicalDigest(app),
    grant_sha256: "f".repeat(64),
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
  };
  const runtime = {
    ...environment,
    GITHUB_JOB: "coordinator",
    PORTCOVE_EXECUTION_PURPOSE: "application",
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(app),
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify(bounded),
    PORTCOVE_CATALOG_AUTHORITIES: "unavailable unused catalog record",
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: "unavailable unused catalog policy",
  };
  const before = new Map(Object.keys(runtime).map((key) => [key, process.env[key]]));
  Object.assign(process.env, runtime);
  t.after(() => {
    for (const [key, value] of before)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("configuration source binding must not mint or infer live OIDC acceptance");
  });
  const full = await requireControllerSelectedApplicationAuthorities("coordinator");
  assert.deepEqual(full.configuration, app);
  const journal = await requireControllerFixedJobJournalAuthorities("coordinator");
  assert.deepEqual(journal.configuration, app.journal);
  assert.equal(journal.configuration_sha256, full.journal_configuration_sha256);
  assert.equal(journal.authority_configuration_sha256, full.configuration_sha256);
  await assert.rejects(requireControllerSelectedCatalogAuthorities("coordinator"));
  process.env.PORTCOVE_EXECUTION_PURPOSE = "catalog-publication";
  process.env.PORTCOVE_CATALOG_AUTHORITIES = JSON.stringify(catalog);
  process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION = JSON.stringify({
    ...bounded,
    mode: "bounded-catalog-publication",
    authority_configuration_sha256: releaseCanonicalDigest(catalog),
    grant_sha256: "e".repeat(64),
  });
  process.env.PORTCOVE_RELEASE_AUTHORITIES = "unavailable unused application record";
  const other = await requireControllerSelectedCatalogAuthorities("coordinator");
  const common = await requireControllerFixedJobJournalAuthorities("coordinator");
  assert.equal(common.configuration_sha256, journal.configuration_sha256);
  assert.notEqual(other.configuration_sha256, full.configuration_sha256);
  await assert.rejects(requireControllerSelectedApplicationAuthorities("coordinator"));
  await assert.rejects(requireControllerFixedJobJournalAuthorities("payload-signing"));
  process.env.PORTCOVE_CATALOG_AUTHORITIES = JSON.stringify({
    ...catalog,
    catalog: {
      ...catalog.catalog,
      public_source: {
        ...catalog.catalog.public_source,
        root: { ...catalog.catalog.public_source.root, sha256: "1".repeat(64) },
      },
    },
  });
  await assert.rejects(requireControllerFixedJobJournalAuthorities("coordinator"), /ratification/);
  process.env.PORTCOVE_CATALOG_AUTHORITIES = JSON.stringify(catalog.journal);
  process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION = JSON.stringify({
    ...bounded,
    mode: "bounded-catalog-publication",
    authority_configuration_sha256: releaseCanonicalDigest(catalog.journal),
  });
  await requireControllerFixedJobJournalAuthorities("coordinator");
  await assert.rejects(requireControllerSelectedCatalogAuthorities("coordinator"));
});

void test("selected journal profile has exactly two distinct Apps and cannot satisfy legacy release or catalog authority", () => {
  const configuration = fixedJobJournalAuthoritiesFixture();
  assert.deepEqual(inspectFixedJobJournalAuthorities(configuration), configuration);
  assert.throws(() => inspectReleaseAuthorityConfiguration(configuration));
  assert.throws(() => inspectCatalogAuthorityConfiguration(configuration));
  for (const changed of [
    { ...configuration, schema_version: 2 },
    { ...configuration, purpose: "all" },
    { ...configuration, publication: {} },
    { ...configuration, journal_seed: { ...configuration.journal_seed, state_sha256: "bad" } },
    {
      ...configuration,
      apps: { ...configuration.apps, classification: configuration.apps.semantic },
    },
    {
      ...configuration,
      apps: { ...configuration.apps, semantic: { app_id: 15368, installation_id: 1001 } },
    },
    {
      ...configuration,
      apps: { ...configuration.apps, protection_observer: configuration.apps.semantic },
    },
  ])
    assert.throws(() => inspectFixedJobJournalAuthorities(changed));
  const selected = {
    ...admitProductionController(raw, environment, source),
    mode: "bounded-application-release",
    authority_configuration_sha256: releaseCanonicalDigest(configuration),
    grant_sha256: "f".repeat(64),
  };
  assert.deepEqual(
    inspectBoundFixedJobJournalAuthorities(JSON.stringify(configuration), selected, "application"),
    configuration,
  );
  assert.deepEqual(
    inspectBoundFixedJobJournalAuthorities(
      JSON.stringify(configuration),
      { ...selected, mode: "bounded-catalog-publication" },
      "catalog-publication",
    ),
    configuration,
  );
  assert.throws(() =>
    inspectBoundFixedJobJournalAuthorities(
      JSON.stringify(configuration),
      selected,
      "catalog-publication",
    ),
  );
  assert.throws(() =>
    inspectBoundFixedJobJournalAuthorities(
      JSON.stringify({ ...configuration, namespace: "portcove-other" }),
      selected,
      "application",
    ),
  );
  assert.throws(() =>
    inspectBoundFixedJobJournalAuthorities(
      JSON.stringify(configuration),
      { ...selected, mode: "admission-only" },
      "application",
    ),
  );
});

void test("fixed journal roles separate application and catalog jobs using the existing identity profiles", () => {
  const application = capacityExecutorRolesForPurpose("application"),
    catalog = capacityExecutorRolesForPurpose("catalog-publication");
  assert.ok(
    application.includes("payload-signing") &&
      !application.some((role) => role.startsWith("catalog-")),
  );
  assert.deepEqual(
    catalog.sort(),
    [
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
      "coordinator",
      "site-publication",
    ].sort(),
  );
  assert.equal(
    new Set(application.map((role) => capacityExecutorJobProfile(role).job)).size,
    application.length,
  );
  assert.throws(() => capacityExecutorRolesForPurpose("all"));
});

void test("actual selected journal source reader binds fixed job, immutable source and configuration digest", async (t) => {
  const workflow = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const configuration = fixedJobJournalAuthoritiesFixture();
  const bounded = {
    ...policy,
    schema_version: 2,
    mode: "bounded-application-release",
    authority_configuration_sha256: releaseCanonicalDigest(configuration),
    grant_sha256: "f".repeat(64),
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
  };
  const runtime: NodeJS.ProcessEnv = {
    ...environment,
    GITHUB_JOB: "coordinator",
    PORTCOVE_EXECUTION_PURPOSE: "application",
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(configuration),
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify(bounded),
    PORTCOVE_CATALOG_AUTHORITIES: JSON.stringify(configuration),
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: JSON.stringify({
      ...bounded,
      mode: "bounded-catalog-publication",
      grant_sha256: "e".repeat(64),
    }),
  };
  const before = new Map(Object.keys(runtime).map((key) => [key, process.env[key]]));
  Object.assign(process.env, runtime);
  t.after(() => {
    for (const [key, value] of before)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const selected = await requireControllerFixedJobJournalAuthorities("coordinator");
  assert.equal(selected.configuration_sha256, bounded.authority_configuration_sha256);
  assert.equal(selected.source.revision, policy.revision);
  process.env.PORTCOVE_RELEASE_AUTHORITIES = JSON.stringify({
    ...configuration,
    setup_plan_sha256: "e".repeat(64),
  });
  await assert.rejects(
    requireControllerFixedJobJournalAuthorities("coordinator"),
    /ratified configuration/,
  );
  process.env.PORTCOVE_RELEASE_AUTHORITIES = runtime.PORTCOVE_RELEASE_AUTHORITIES;
  process.env.GITHUB_JOB = "payload_signing";
  await assert.rejects(requireControllerFixedJobJournalAuthorities("coordinator"), /job/);
  await requireControllerFixedJobJournalAuthorities("payload-signing");
  process.env.PORTCOVE_EXECUTION_PURPOSE = "catalog-publication";
  await assert.rejects(requireControllerFixedJobJournalAuthorities("payload-signing"));
  process.env.GITHUB_JOB = "coordinator";
  const catalog = await requireControllerFixedJobJournalAuthorities("coordinator");
  assert.equal(catalog.purpose, "catalog-publication");
  assert.equal(catalog.source.mode, "bounded-catalog-publication");
  assert.equal(catalog.configuration_sha256, selected.configuration_sha256);
  assert.notEqual(catalog.source.grant_sha256, selected.source.grant_sha256);
});

void test("classification writer admits only its own fixed workflow, job and ratified bytes", () => {
  const writer = {
    ...environment,
    GITHUB_JOB: "classification_writer",
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release-reviewed-inputs.yml@${policy.execution_ref}`,
  };
  const accepted = admitReviewedInputsWriter(raw, writer, source);
  assert.equal(accepted.workflow, ".github/workflows/release-reviewed-inputs.yml");
  for (const change of [
    { GITHUB_JOB: "admission" },
    { GITHUB_JOB: "protection_observation" },
    { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_REF_PROTECTED: "false" },
  ])
    assert.throws(() => admitReviewedInputsWriter(raw, { ...writer, ...change }, source));
  assert.throws(() => admitReviewedInputsWriter(raw, writer, Buffer.from("other workflow")));
  assert.throws(() => admitProductionController(raw, writer, source));
});

void test("exact separately configured fixture admits only its source execution", () => {
  const result = admitProductionController(raw, environment, source);
  assert.equal(result.repository_id, "1354613114");
  assert.equal(result.repository, "boburning/portcove");
  assert.equal(result.workflow, ".github/workflows/application-update-production.yml");
  assert.equal(result.actor_id, "123456");
  assert.equal(result.run_id, "987654");
  assert.equal(result.run_attempt, 1);
  assert.equal(result.mode, "admission-only");
  assert.match(result.qualification, /no candidate acceptance/u);
  assert.equal("candidate" in result, false);
  assert.equal("signing" in result, false);
});

void test("policy is absent by default and cannot add candidate or privileged modes", () => {
  for (const candidate of [undefined, "", "null", "[]", "{", " ".repeat(4097)])
    assert.throws(() => admitProductionController(candidate, environment, source), /refused/u);
  const cases = [
    { ...policy, schema_version: 2 },
    { ...policy, mode: "publish" },
    { ...policy, candidate: { accepted: true } },
    { ...policy, actor_id: 123456 },
    { ...policy, actor_id: "0" },
    { ...policy, revision: "a".repeat(39) },
    { ...policy, workflow_sha256: "A".repeat(64) },
    { ...policy, execution_ref: "refs/heads/main" },
    { ...policy, execution_ref: "refs/tags/portcove-controller-canary-20261010" },
    { ...policy, execution_ref: "refs/tags/portcove-production-controller-a/../../main" },
  ];
  for (const candidate of cases)
    assert.throws(
      () => admitProductionController(JSON.stringify(candidate), environment, source),
      /policy schema/u,
    );
  for (const key of Object.keys(policy)) {
    const missing: Record<string, unknown> = { ...policy };
    delete missing[key];
    assert.throws(() => admitProductionController(JSON.stringify(missing), environment, source));
  }
});

void test("bounded source policy binds both complete authority configuration and the separate grant", () => {
  const selected = {
    ...policy,
    schema_version: 2,
    mode: "bounded-application-release",
    authority_configuration_sha256: "b".repeat(64),
    grant_sha256: "c".repeat(64),
  };
  const result = admitProductionController(JSON.stringify(selected), environment, source);
  assert.equal(result.mode, selected.mode);
  assert.equal(result.authority_configuration_sha256, selected.authority_configuration_sha256);
  assert.equal(result.grant_sha256, selected.grant_sha256);
  assert.match(result.qualification, /no candidate acceptance/u);
  for (const change of [
    { grant_sha256: null },
    { authority_configuration_sha256: "b".repeat(63) },
    { mode: "admission-only" },
    { accepted: true },
  ])
    assert.throws(() =>
      admitProductionController(JSON.stringify({ ...selected, ...change }), environment, source),
    );
  for (const changed of [
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_ACTOR_ID: "2" },
    { GITHUB_RUN_ATTEMPT: "2" },
  ])
    assert.throws(() =>
      admitProductionController(JSON.stringify(selected), { ...environment, ...changed }, source),
    );
});

void test("global configured role inventory refuses every App conflation and weakened beta host floor", () => {
  const names = [
    "semantic",
    "classification",
    "native_qualification",
    "protection_observer",
    "coordinator_journal",
    "dispatch",
    "release_publication",
  ];
  const apps = Object.fromEntries(
    names.map((name, index) => [
      name,
      {
        app_id: 100 + index,
        installation_id: 200 + index,
        ...(name === "dispatch" ? { actor_id: "123456" } : {}),
      },
    ]),
  );
  const native = Object.fromEntries(
    ["windows-x86_64", "linux-x86_64"].map((platform) => [
      platform,
      {
        producer: {
          source_commit: "a".repeat(40),
          source_tree: "b".repeat(40),
          harness: { path: "scripts/qualify-native-release.ps1", sha256: "c".repeat(64) },
        },
        host: {
          machine_id_sha256: "d".repeat(64),
          qualification_profile: "inert-config-only",
          minimum_platform:
            platform === "windows-x86_64" ? "windows-11-26h2-x64" : "ubuntu-24.04-x64",
          account:
            platform === "windows-x86_64"
              ? {
                  kind: "windows-sid",
                  broker: "S-1-5-21-1-2-3-1001",
                  qualification: "S-1-5-21-1-2-3-1002",
                }
              : { kind: "linux-uid", broker: "1000", qualification: "1001" },
          engine: {
            name: platform === "windows-x86_64" ? "WebView2" : "WebKitGTK",
            minimum_version: platform === "windows-x86_64" ? "155.0.4283.62" : "2.52.6",
          },
        },
        compatibility: {
          minimum_os_version: "fixture",
          required_capabilities: [],
          cli_protocol: { min: 1, max: 1 },
          catalog_formats: [3],
          library: { read: { min: 1, max: 1 }, write_schema: 1, lock_protocol: "fixture" },
        },
      },
    ]),
  );
  const config = {
    schema_version: 1,
    repository_id: 1354613114,
    namespace: "portcove-fixture",
    apps,
    native,
  };
  assert.equal(inspectReleaseAuthorityConfiguration(config).apps.semantic.app_id, 100);
  for (const name of names) {
    const changed = structuredClone(config);
    changed.apps[name]!.app_id = 15368;
    assert.throws(() => inspectReleaseAuthorityConfiguration(changed), /conflated/);
    for (const other of names.filter((entry) => entry !== name)) {
      const conflated = structuredClone(config);
      conflated.apps[name] = conflated.apps[other]!;
      assert.throws(() => inspectReleaseAuthorityConfiguration(conflated));
    }
  }
  for (const [platform, lower] of [
    ["windows-x86_64", "155.0.4283.61"],
    ["linux-x86_64", "2.52.5"],
  ] as const) {
    const changed = structuredClone(config);
    changed.native[platform]!.host.engine.minimum_version = lower;
    assert.throws(() => inspectReleaseAuthorityConfiguration(changed), /floor weakened/);
  }
});

void test("every execution identity is required and mismatches refuse", () => {
  for (const key of Object.keys(environment)) {
    assert.throws(
      () => admitProductionController(raw, { ...environment, [key]: undefined }, source),
      /refused/u,
      `missing ${key}`,
    );
    assert.throws(
      () => admitProductionController(raw, { ...environment, [key]: "different" }, source),
      /refused/u,
      `changed ${key}`,
    );
  }
});

void test("main, same-name branch, fork, reusable identity and rerun never inherit admission", () => {
  for (const delta of [
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/heads/portcove-production-controller-fixture", GITHUB_REF_TYPE: "branch" },
    { GITHUB_REF: "refs/pull/7/merge", GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REPOSITORY_ID: "100", GITHUB_REPOSITORY: "another/portcove" },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/caller.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_TRIGGERING_ACTOR: "other-principal" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
  ])
    assert.throws(() => admitProductionController(raw, { ...environment, ...delta }, source));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537), Buffer.from("changed source")])
    assert.throws(
      () => admitProductionController(raw, environment, bytes),
      /source byte identity/u,
    );
});

const workflow = await readFile(
  new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  "utf8",
);

void test("configured held workflow enforces bootstrap identities before checkout or any credential role", () => {
  const parsed = parse(workflow) as {
    env: Record<string, string>;
    jobs: {
      admission: {
        environment?: string;
        env?: Record<string, string>;
        "timeout-minutes": number;
        steps: { run?: string; uses?: string }[];
      };
    };
  };
  const bootstrap = parsed.jobs.admission;
  const script = bootstrap.steps[0]?.run;
  assert.ok(script, "bootstrap script must precede checkout");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const execute = (delta: Record<string, string | undefined>) =>
    execFileSync(bash, ["-c", script], {
      env: {
        ...process.env,
        ...environment,
        PORTCOVE_EXECUTION_PURPOSE: "application",
        PORTCOVE_CONTROLLER_ADMISSION: raw,
        PORTCOVE_CATALOG_CONTROLLER_ADMISSION: "",
        ...delta,
      },
      windowsHide: true,
      timeout: 5000,
      stdio: "pipe",
    });
  execute({});
  execute({
    PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
    PORTCOVE_CONTROLLER_ADMISSION: "",
    PORTCOVE_CATALOG_CONTROLLER_ADMISSION: "configured-catalog-only",
  });
  for (const delta of [
    { PORTCOVE_EXECUTION_PURPOSE: undefined },
    { PORTCOVE_EXECUTION_PURPOSE: "unknown" },
    {
      PORTCOVE_EXECUTION_PURPOSE: "application",
      PORTCOVE_CONTROLLER_ADMISSION: "",
      PORTCOVE_CATALOG_CONTROLLER_ADMISSION: "catalog-cannot-substitute",
    },
    {
      PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
      PORTCOVE_CATALOG_CONTROLLER_ADMISSION: "",
      PORTCOVE_CONTROLLER_ADMISSION: raw,
    },
    { PORTCOVE_CONTROLLER_REVISION: undefined },
    { PORTCOVE_CONTROLLER_REF: "refs/heads/main" },
    { PORTCOVE_CONTROLLER_ADMISSION: "" },
    { GITHUB_REPOSITORY_ID: "100" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REF: "refs/heads/portcove-production-controller-fixture" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/caller.yml@refs/heads/main" },
    { GITHUB_RUN_ATTEMPT: "2" },
  ])
    assert.throws(() => execute(delta));
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.equal(bootstrap["timeout-minutes"], 1);
  assert.match(workflow, /run: node scripts\/production-controller-admission-cli\.mts/u);
  assert.equal(bootstrap.environment, undefined);
  assert.ok(!JSON.stringify(bootstrap).includes("secrets."));
  assert.equal(parsed.env.PORTCOVE_EXECUTION_PURPOSE, "${{ inputs.publication_purpose }}");
  assert.deepEqual(
    [
      ...new Set(
        [...JSON.stringify(bootstrap).matchAll(/inputs\.([a-z_]+)/gu)].map((match) => match[1]),
      ),
    ],
    ["publication_purpose"],
  );
  assert.doesNotMatch(script, /\$\{\{ inputs\.|eval|node|gh /u);
  assert.ok(!bootstrap.steps.some((step) => step.uses?.startsWith("./")));
  assert.ok(bootstrap.steps[1]?.uses?.startsWith("actions/checkout@"));
});

void test("CLI runs with only fixed source files and no installed dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-controller-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  for (const file of [
    "production-controller-admission.mts",
    "production-controller-admission-cli.mts",
    "runtime-values.mts",
    "release-control-phases.mts",
    "release-authority-configuration.mts",
    "release-authority-configuration-contract.mts",
    "release-canonical.mts",
    "release-catalog-publication-contract.mts",
    "release-metadata-contract.mts",
    "controller-node-runtime.mts",
    "release-coordinator-deadline.mts",
    "release-coordinator-namespace.mts",
    "linux-beta-risk-706-profile.mts",
    "release-native-qualification-contract.mts",
  ])
    await copyFile(new URL(file, import.meta.url), path.join(root, "scripts", file));
  await writeFile(path.join(root, ".github/workflows/application-update-production.yml"), source);
  const command = path.join(root, "scripts/production-controller-admission-cli.mts");
  const invoke = (extra: string[], delta: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [command, ...extra], {
      cwd: root,
      env: { ...process.env, ...environment, PORTCOVE_CONTROLLER_ADMISSION: raw, ...delta },
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    });
  const result: unknown = JSON.parse(invoke([], {}));
  assert.ok(isRecord(result));
  assert.equal(result.run_id, "987654");
  assert.throws(() => invoke([], { PORTCOVE_CONTROLLER_ADMISSION: "" }), /missing or oversized/u);
  assert.throws(() => invoke(["candidate.json"], {}), /no candidate or policy path/u);
  await writeFile(
    path.join(root, ".github/workflows/application-update-production.yml"),
    "changed",
  );
  assert.throws(() => invoke([], {}), /source byte identity/u);
  await writeFile(
    path.join(root, ".github/workflows/application-update-production.yml"),
    Buffer.alloc(65537),
  );
  assert.throws(() => invoke([], {}), /source byte identity/u);
});

void test("full selected admission derives both purpose observer roles without installed dependencies or a legacy fallback", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "selected-input-roles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const entry = new URL("./production-controller-admission-cli.mts", import.meta.url);
  const loader =
    "data:text/javascript," +
    encodeURIComponent(
      `import {registerHooks,isBuiltin} from 'node:module';registerHooks({resolve(spec,context,next){if(!isBuiltin(spec)&&!spec.startsWith('.')&&!spec.startsWith('file:')&&!spec.startsWith('data:'))throw Error('external dependency refused: '+spec);return next(spec,context);}});`,
    );
  for (const purpose of ["application", "catalog-publication"] as const) {
    const config = selectedPublicationAuthoritiesFixture(purpose);
    const bounded = {
      ...policy,
      schema_version: 2,
      mode:
        purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication",
      workflow_sha256: createHash("sha256").update(bytes).digest("hex"),
      authority_configuration_sha256: releaseCanonicalDigest(config),
      grant_sha256: "e".repeat(64),
    };
    let ordinal = 0;
    const invoke = async (raw: unknown) => {
      const output = path.join(directory, `${purpose}-${ordinal++}`);
      await writeFile(output, "", { flag: "wx" });
      let failure: unknown;
      try {
        execFileSync(process.execPath, ["--import", loader, fileURLToPath(entry)], {
          env: {
            ...process.env,
            ...environment,
            GITHUB_OUTPUT: output,
            PORTCOVE_EXECUTION_PURPOSE: purpose,
            PORTCOVE_CONTROLLER_ADMISSION:
              purpose === "application" ? JSON.stringify(bounded) : undefined,
            PORTCOVE_CATALOG_CONTROLLER_ADMISSION:
              purpose === "catalog-publication" ? JSON.stringify(bounded) : undefined,
            PORTCOVE_RELEASE_AUTHORITIES:
              purpose === "application" ? JSON.stringify(raw) : undefined,
            PORTCOVE_CATALOG_AUTHORITIES:
              purpose === "catalog-publication" ? JSON.stringify(raw) : undefined,
          },
          timeout: 15000,
          windowsHide: true,
          stdio: "pipe",
        });
      } catch (error) {
        failure = error;
      }
      return { failure, text: await readFile(output, "utf8") };
    };
    const result = await invoke(config);
    assert.equal(result.failure, undefined, String(result.failure));
    assert.match(result.text, /classification_transport=fixed-job\n/);
    assert.match(result.text, /protection_app_id=202\n/);
    assert.match(result.text, /protection_installation_id=1002\n/);
    for (const bad of [
      { ...config, schema_version: 3 },
      config.journal,
      {
        ...config,
        journal: {
          ...config.journal,
          apps: {
            ...config.journal.apps,
            protection_observer: { app_id: 0, installation_id: 1002 },
          },
        },
        apps: { protection_observer: { app_id: 202, installation_id: 1002 } },
      },
    ]) {
      const refused = await invoke(bad);
      assert.ok(refused.failure);
      assert.equal(refused.text, "");
    }
  }
});

void test("actual readiness CLI binds appointed targets before its private directory or handshake, with controlled handshake only", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "selected-observer-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const entry = new URL("./release-control-ready.mts", import.meta.url);
  const handshake = new URL("./release-control-handshake.mts", import.meta.url).href;
  const loader =
    "data:text/javascript," +
    encodeURIComponent(
      `import {registerHooks,isBuiltin} from 'node:module'; const stub='data:text/javascript,'+encodeURIComponent('export {inspectControlRound} from '+${JSON.stringify(JSON.stringify(handshake))}+';import {writeFile} from "node:fs/promises";export async function waitForControlArtifact(root,role,value){if(role!=="ready")throw Error("wrong role");await writeFile(root+"/controlled-handshake.json",JSON.stringify(value),{flag:"wx"});}');registerHooks({resolve(spec,context,next){if(context.parentURL===${JSON.stringify(entry.href)}&&spec==='./release-control-handshake.mts')return {url:stub,shortCircuit:true};if(!isBuiltin(spec)&&!spec.startsWith('.')&&!spec.startsWith('file:')&&!spec.startsWith('data:'))throw Error('external dependency refused: '+spec);return next(spec,context);}});`,
    );
  for (const purpose of ["application", "catalog-publication"] as const) {
    const config = selectedPublicationAuthoritiesFixture(purpose);
    const bounded = {
      ...policy,
      schema_version: 2,
      mode:
        purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication",
      workflow_sha256: createHash("sha256").update(bytes).digest("hex"),
      authority_configuration_sha256: releaseCanonicalDigest(config),
      grant_sha256: "e".repeat(64),
    };
    for (const valid of [true, false]) {
      const parent = path.join(directory, `${purpose}-${valid}`);
      await mkdir(parent);
      let failure: unknown;
      try {
        execFileSync(process.execPath, ["--import", loader, fileURLToPath(entry), "coordinator"], {
          env: {
            ...process.env,
            ...environment,
            GITHUB_JOB: "coordinator_protection_observation",
            RUNNER_TEMP: parent,
            GH_TOKEN: "inert-not-an-authority",
            PORTCOVE_EXECUTION_PURPOSE: purpose,
            PORTCOVE_CONTROLLER_ADMISSION:
              purpose === "application" ? JSON.stringify(bounded) : undefined,
            PORTCOVE_CATALOG_CONTROLLER_ADMISSION:
              purpose === "catalog-publication" ? JSON.stringify(bounded) : undefined,
            PORTCOVE_RELEASE_AUTHORITIES:
              purpose === "application" ? JSON.stringify(config) : undefined,
            PORTCOVE_CATALOG_AUTHORITIES:
              purpose === "catalog-publication" ? JSON.stringify(config) : undefined,
            PORTCOVE_EXPECTED_PROTECTION_APP_ID: valid ? "202" : "999",
            PORTCOVE_EXPECTED_INSTALLATION_ID: "1002",
          },
          timeout: 15000,
          windowsHide: true,
          stdio: "pipe",
        });
      } catch (error) {
        failure = error;
      }
      if (valid) {
        assert.equal(failure, undefined, String(failure));
        const observed: unknown = JSON.parse(
          await readFile(
            path.join(parent, "release-control-ready-coordinator/controlled-handshake.json"),
            "utf8",
          ),
        );
        assert.ok(isRecord(observed));
        assert.equal(observed.phase, "coordinator");
        assert.equal(observed.controller_revision, policy.revision);
      } else {
        assert.ok(failure instanceof Error);
        assert.match(String(failure), /fixed reader readiness refused/);
        assert.deepEqual(await readdir(parent), []);
      }
    }
  }
});

void test("reviewed inputs source admission pins its own fixed workflow and rejects production cross-use", () => {
  const env = {
    ...environment,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release-reviewed-inputs.yml@${policy.execution_ref}`,
  };
  assert.equal(
    admitReviewedInputsController(raw, env, source).workflow,
    ".github/workflows/release-reviewed-inputs.yml",
  );
  assert.throws(() => admitProductionController(raw, env, source));
  assert.throws(() => admitReviewedInputsController(raw, environment, source));
});

void test("complete controller classification jobs retain separate fixed source and roles", () => {
  for (const [admit, job] of [
    [admitProductionClassificationWriter, "classification_writer"],
    [admitProductionClassificationObserver, "classification_protection_observation"],
  ] as const) {
    const env = { ...environment, GITHUB_JOB: job };
    assert.equal(
      admit(raw, env, source).workflow,
      ".github/workflows/application-update-production.yml",
    );
    for (const changed of [
      { GITHUB_JOB: "admission" },
      {
        GITHUB_JOB:
          job === "classification_writer"
            ? "classification_protection_observation"
            : "classification_writer",
      },
      { GITHUB_RUN_ATTEMPT: "2" },
      {
        GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release-reviewed-inputs.yml@${policy.execution_ref}`,
      },
    ])
      assert.throws(() => admit(raw, { ...env, ...changed }, source));
    assert.throws(() => admit(raw, env, Buffer.from("changed controller")));
  }
});
