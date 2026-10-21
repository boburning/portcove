import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectNativeQualificationAssociation,
  requireNativeReleaseQualificationPair,
  collectNativeReleaseQualificationPair,
  deriveNativeQualificationExpectations,
  deriveNativeQualificationTemplates,
  bindNativeQualificationLocators,
} from "./release-native-admission.mts";
import {
  inspectPublicationAuthorities,
  inspectReleaseAuthorityConfiguration,
  inspectNativePrepublicationAuthorities,
} from "./release-authority-configuration.mts";
import { nativePrepublicationProfile } from "./release-native-qualification-contract.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  deriveNativePublicationJourneys,
  inspectNativeCompletionLineage,
  nativeCompletionUsesHistoricalLineage,
  inspectNativePublicationPredecessor,
  inspectNativeInitialPublicationJourney,
  collectConfiguredNativePublicationQualificationPair,
  collectConfiguredNativePublicationCompletionPair,
} from "./release-native-publication-admission.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import { metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requireRetainedActualTufPublication } from "./release-tuf-publication.mts";

void test("publication configuration pins only distinct immutable public data and setup identities", () => {
  const file = (path: string) => ({ path, bytes: 123, sha256: "a".repeat(64) });
  const value = {
    public_source: {
      commit: "b".repeat(40),
      root: file("release-public/root.json"),
      offline_targets: file("release-public/offline-targets.json"),
      payload_key_registry: file("release-public/payload.json"),
    },
    setup_plan_sha256: "c".repeat(64),
    initial_site_preimage_sha256: "d".repeat(64),
  };
  assert.deepEqual(inspectPublicationAuthorities(value), value);
  for (const changed of [
    { ...value, credential: "not-allowed" },
    { ...value, setup_plan_sha256: null },
    { ...value, public_source: { ...value.public_source, commit: "main" } },
    ...[
      "../root.json",
      "release-public/../../root.json",
      "https://example.invalid/root.json",
      "root.mjs",
    ].map((path) => ({ ...value, public_source: { ...value.public_source, root: file(path) } })),
    {
      ...value,
      public_source: { ...value.public_source, root: { ...file("root.json"), bytes: 1048577 } },
    },
    {
      ...value,
      public_source: { ...value.public_source, offline_targets: value.public_source.root },
    },
  ])
    assert.throws(() => inspectPublicationAuthorities(changed));
});
void test("historical native attribution requires the exact Tough-record reference and every source/package/run field", () => {
  const report = nativeQualificationFixture(),
    prepared = prepareNativeQualificationCheck(report),
    check = { id: 123, ...prepared.body },
    record = {
      source_commit: report.candidate.source_commit,
      source_tree: report.candidate.source_tree,
      target: report.platform_label,
      qualified_run: {
        run_id: Number(report.candidate.run_id),
        attempt: report.candidate.run_attempt,
      },
      artifact: {
        url: `https://github.com/boburning/portcove/releases/download/v0.1.0/${report.candidate.package.filename}`,
        sha256: report.candidate.package.sha256,
        bytes: report.candidate.package.bytes,
      },
      evidence_ids: [`native-check:123:${releaseCanonicalDigest(prepared.report)}`],
    };
  assert.deepEqual(inspectNativePublicationPredecessor(record, check), report.candidate);
  for (const changed of [
    { ...record, source_tree: "f".repeat(40) },
    { ...record, qualified_run: { ...record.qualified_run, attempt: 3 } },
    { ...record, artifact: { ...record.artifact, sha256: "f".repeat(64) } },
    { ...record, evidence_ids: [...record.evidence_ids, ...record.evidence_ids] },
    { ...record, evidence_ids: [`native-check:123:${"f".repeat(64)}`] },
  ])
    assert.throws(() => inspectNativePublicationPredecessor(changed, check));
  assert.throws(() => inspectNativePublicationPredecessor(record, { ...check, id: 124 }));
});
void test("initial native journey data binds completed exact bootstrap site effect, ratified anchors and empty prior only", () => {
  const f = metadataBootstrapFixture(),
    operation = "f".repeat(64),
    file = (name: string, sha256: unknown) => ({
      path: `release-public/${name}.json`,
      bytes: 1,
      sha256,
    }),
    pins = {
      public_source: {
        commit: "a".repeat(40),
        root: file("root", f.descriptor.root_sha256),
        offline_targets: file("targets", f.descriptor.offline_targets_sha256),
        payload_key_registry: file("payload", f.descriptor.payload_key_registry_sha256),
      },
      setup_plan_sha256: f.descriptor.setup_plan_sha256,
      initial_site_preimage_sha256: f.descriptor.initial_site_preimage_sha256,
    },
    group = {
      summary_schema_version: 1,
      subject: { kind: "metadata-bootstrap", identity: releaseCanonicalDigest(f.descriptor) },
      kind: "upload",
      destination_sha256: releaseCanonicalDigest("github-pages:boburning/portcove:complete-site"),
      transient_retries: 0,
      substantive_repairs: 0,
      completed: true,
      attempts: [{ checkpoint: "e".repeat(40), id: operation, operation_sha256: "1".repeat(64) }],
    },
    input = {
      bootstrap: f.descriptor,
      published: { ...f.published, operation_id: operation },
      capacity_groups: [group],
      public_pins: pins,
      payload_sha256: String(f.descriptor.payload_key_registry_sha256),
      signed_context_sha256: "2".repeat(64),
      signatures_sha256: "3".repeat(64),
      prior_records_sha256: releaseCanonicalDigest([]),
    };
  const result = inspectNativeInitialPublicationJourney(input);
  assert.equal(result.kind, "initial-empty-feed");
  assert.equal(result.signed_context_sha256, input.signed_context_sha256);
  for (const changed of [
    { ...input, prior_records_sha256: "4".repeat(64) },
    { ...input, published: { ...input.published, records_sha256: "4".repeat(64) } },
    { ...input, capacity_groups: [] },
    { ...input, capacity_groups: [{ ...group, completed: false }] },
    {
      ...input,
      capacity_groups: [
        {
          ...group,
          destination_sha256: releaseCanonicalDigest(
            "github-actions:boburning/portcove:metadata-bootstrap-context",
          ),
        },
      ],
    },
    { ...input, public_pins: { ...pins, setup_plan_sha256: "4".repeat(64) } },
  ])
    assert.throws(() => inspectNativeInitialPublicationJourney(changed));
});
void test("configured post-sign native entry refuses imported TUF/context before authority/provider/output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-postsign-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    collectConfiguredNativePublicationQualificationPair(
      root,
      [],
      {},
      [],
      {},
      {},
      performance.now() + 10000,
    ),
    /actual keyless/u,
  );
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(
    collectConfiguredNativePublicationCompletionPair(
      root,
      [],
      {},
      [],
      {},
      {},
      performance.now() + 10000,
    ),
    /actual keyless/u,
  );
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(
    requireRetainedActualTufPublication({}, performance.now() + 1000),
    /actual keyless/u,
  );
});

void test("actual native collection rejects incomplete or imported expectations before provider collection", async () => {
  for (const raw of [null, [], [{}], [{}, {}]])
    await assert.rejects(
      collectNativeReleaseQualificationPair("unused", raw, {}, [], "payload-signing"),
    );
});
void test("fixed authority supplies native issuer and host while locators cannot change acquired package facts", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const apps = Object.fromEntries(
    [
      "semantic",
      "classification",
      "native_qualification",
      "protection_observer",
      "coordinator_journal",
      "dispatch",
      "release_publication",
    ].map((role, index) => [
      role,
      {
        app_id: 100 + index,
        installation_id: 200 + index,
        ...(role === "dispatch" ? { actor_id: "123456" } : {}),
      },
    ]),
  );
  const native = Object.fromEntries(
    ["windows-x86_64", "linux-x86_64"].map((platform) => {
      const report = nativeQualificationFixture();
      const { started_at: _start, invocation_id: _invocation, ...producer } = report.producer;
      return [
        platform,
        {
          producer,
          host: {
            machine_id_sha256: report.host.machine_id_sha256,
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
          compatibility: report.compatibility,
        },
      ];
    }),
  );
  const authorities = {
    schema_version: 1,
    repository_id: 1354613114,
    namespace: "portcove-test",
    apps,
    native,
  };
  const temporal = {
    ...authorities,
    schema_version: 2,
    native_prepublication_profile: nativePrepublicationProfile,
  };
  const parsedTemporal = inspectReleaseAuthorityConfiguration(temporal);
  assert.equal(parsedTemporal.native_prepublication_profile, nativePrepublicationProfile);
  assert.equal(parsedTemporal.schema_version, 2);
  assert.deepEqual(inspectNativePrepublicationAuthorities(temporal), parsedTemporal);
  assert.throws(() => inspectNativePrepublicationAuthorities(authorities), /ratified/u);
  assert.notEqual(
    releaseCanonicalDigest(inspectReleaseAuthorityConfiguration(authorities)),
    releaseCanonicalDigest(parsedTemporal),
  );
  assert.equal(
    inspectReleaseAuthorityConfiguration(authorities).native_prepublication_profile,
    undefined,
  );
  for (const changed of [
    { ...temporal, native_prepublication_profile: "caller-profile" },
    { ...temporal, schema_version: 1 },
    { ...authorities, schema_version: 2 },
  ])
    assert.throws(() => inspectReleaseAuthorityConfiguration(changed));
  const locators = [
    { platform_label: "windows-x86_64", check_id: 101, invocation_id: "1".repeat(64) },
    { platform_label: "linux-x86_64", check_id: 102, invocation_id: "2".repeat(64) },
  ];
  const archives = [
    { platform: "windows-x86_64", artifact_id: 901 },
    { platform: "linux-x86_64", artifact_id: 902 },
  ];
  const expected = await deriveNativeQualificationExpectations(
    authorities,
    locators,
    f.request,
    archives,
    "payload-signing",
  );
  const templates = await deriveNativeQualificationTemplates(authorities, f.request, archives);
  assert.ok(
    templates.every(
      (item) => !Object.hasOwn(item, "check_id") && !Object.hasOwn(item.producer, "invocation_id"),
    ),
  );
  assert.deepEqual(bindNativeQualificationLocators(locators, templates), expected);
  assert.equal(expected[0]!.native_app_id, 102);
  assert.equal(expected[0]!.candidate.artifact_id, 901);
  assert.equal(expected[0]!.candidate.source_commit, f.request.source_commit);
  assert.equal(expected[0]!.host.engine.minimum_version, "155.0.4283.62");
  assert.equal(expected[0]!.journey, null);
  for (const changed of [
    [{ ...locators[0], native_app_id: 999 }, locators[1]],
    [{ ...locators[0], candidate: { sha256: "0".repeat(64) } }, locators[1]],
    [locators[0], locators[0]],
  ])
    await assert.rejects(
      deriveNativeQualificationExpectations(
        authorities,
        changed,
        f.request,
        archives,
        "payload-signing",
      ),
    );
  const conflated = structuredClone(authorities);
  conflated.apps.native_qualification!.app_id = conflated.apps.protection_observer!.app_id;
  await assert.rejects(
    deriveNativeQualificationExpectations(
      conflated,
      locators,
      f.request,
      archives,
      "payload-signing",
    ),
    /conflated/u,
  );
  await assert.rejects(
    deriveNativeQualificationExpectations(
      authorities,
      locators,
      f.request,
      archives,
      "release-publication",
    ),
    /pre-sign/u,
  );
});

void test("inert native association requires exact selected package bytes, source, run, attempt and immutable platform artifact", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const archives = [
    { platform: "windows-x86_64", artifact_id: 101, bytes: 100, sha256: "1".repeat(64) },
    { platform: "linux-x86_64", artifact_id: 102, bytes: 200, sha256: "2".repeat(64) },
  ];
  const reports = archives.map((archive) => {
    const report = nativeQualificationFixture();
    const file = f.request.files.find(
      (v) =>
        v.platform_label === archive.platform &&
        (v.filename.endsWith("-setup.exe") || v.filename.endsWith(".AppImage")),
    )!;
    report.platform_label = archive.platform;
    report.candidate = {
      source_commit: f.request.source_commit,
      source_tree: f.request.source_tree,
      run_id: f.request.run_id,
      run_attempt: f.request.run_attempt,
      artifact_id: archive.artifact_id,
      package: { filename: file.filename, bytes: file.bytes, sha256: file.sha256 },
    };
    if (archive.platform === "linux-x86_64") {
      report.host.account = { kind: "linux-uid", broker: "1000", qualification: "1001" };
      report.runtime.root_creation.kind = "linux-starttime-ticks";
      report.host.loaded_engine = { name: "WebKitGTK", version: "2.52.6", sha256: "3".repeat(64) };
      report.host.minimum_platform = "ubuntu-24.04-x86_64";
      report.host.qualification_profile = "ubuntu-24.04-x86_64";
      report.compatibility.minimum_os_version = "6.8.0";
    }
    return report;
  });
  const result = await inspectNativeQualificationAssociation(
    reports,
    f.request,
    archives,
    "payload-signing",
  );
  assert.equal(result.authority, "none");
  assert.match(result.scope, /no native authentication/u);
  assert.equal(result.reports.length, 2);
  await assert.rejects(
    requireNativeReleaseQualificationPair(reports, f.request, archives, "payload-signing"),
    /actual provider/u,
  );
  for (const mutate of [
    (r: typeof reports) => {
      r[0]!.candidate.package.sha256 = "0".repeat(64);
    },
    (r: typeof reports) => {
      r[0]!.candidate.source_tree = "0".repeat(40);
    },
    (r: typeof reports) => {
      r[0]!.candidate.run_attempt++;
    },
    (r: typeof reports) => {
      r[0]!.candidate.artifact_id++;
    },
    (r: typeof reports) => {
      r[1] = structuredClone(r[0]!);
    },
  ]) {
    const changed = structuredClone(reports);
    mutate(changed);
    await assert.rejects(
      inspectNativeQualificationAssociation(changed, f.request, archives, "payload-signing"),
    );
  }
  await assert.rejects(
    inspectNativeQualificationAssociation(
      reports,
      f.request,
      archives.slice(0, 1),
      "payload-signing",
    ),
  );
  await assert.rejects(
    inspectNativeQualificationAssociation(
      reports,
      f.request,
      [archives[0], archives[0]],
      "payload-signing",
    ),
  );
  await assert.rejects(
    inspectNativeQualificationAssociation(reports, f.request, archives, "release-publication"),
  );
  const full = await trustedAssemblyFixture(t);
  await assert.rejects(
    inspectNativeQualificationAssociation(reports, full.request, archives, "payload-signing"),
    /full package profile/u,
  );
});

void test("shared data-only journey derivation binds exact prior inventory and refuses bootstrap on changed or nonempty prior", () => {
  const f = metadataBootstrapFixture(),
    payload = Buffer.from("disposable-payload-registry");
  const payloadSha = createHash("sha256").update(payload).digest("hex");
  const bootstrap = { ...f.descriptor, payload_key_registry_sha256: payloadSha };
  const operation = "f".repeat(64),
    repositorySha = releaseCanonicalDigest([]);
  const published = { ...f.published, repository_sha256: repositorySha, operation_id: operation };
  const pins = inspectPublicationAuthorities({
    public_source: {
      commit: "a".repeat(40),
      root: { path: "release-public/root.json", bytes: 1, sha256: bootstrap.root_sha256 },
      offline_targets: {
        path: "release-public/targets.json",
        bytes: 1,
        sha256: bootstrap.offline_targets_sha256,
      },
      payload_key_registry: {
        path: "release-public/payload.json",
        bytes: payload.length,
        sha256: payloadSha,
      },
    },
    setup_plan_sha256: bootstrap.setup_plan_sha256,
    initial_site_preimage_sha256: bootstrap.initial_site_preimage_sha256,
  });
  let reads = 0;
  const input: Parameters<typeof deriveNativePublicationJourneys>[0] = {
    files: new Map([["payload.json", payload]]),
    coordinator_input: {
      metadata_bootstrap: bootstrap,
      published_metadata: published,
      controller: {
        capacity_attempt: {
          schema_version: 2,
          prior_operations: [
            {
              summary_schema_version: 1,
              subject: { kind: "metadata-bootstrap", identity: releaseCanonicalDigest(bootstrap) },
              kind: "upload",
              destination_sha256: releaseCanonicalDigest(
                "github-pages:boburning/portcove:complete-site",
              ),
              transient_retries: 0,
              substantive_repairs: 0,
              completed: true,
              attempts: [
                { checkpoint: "e".repeat(40), id: operation, operation_sha256: "1".repeat(64) },
              ],
            },
          ],
        },
      },
    },
    manifest: {
      facts: { opportunity: { base_commit: "a".repeat(40) } },
      binding: { signatures_sha256: "3".repeat(64) },
      previous_site_pins: {
        repository_sha256: repositorySha,
        root_sha256: published.root_sha256,
        site_generation_sha256: published.publication.site_generation_sha256,
      },
    },
    namespace: "qualification",
    signed_context_sha256: "2".repeat(64),
    platform_labels: ["windows-x86_64", "linux-x86_64"],
    public_pins: pins,
    api: {
      request: () => {
        reads++;
        throw new Error("unexpected provider request");
      },
      graphql: () => {
        reads++;
        throw new Error("unexpected provider query");
      },
    },
  };
  const candidate = {
    phase: "building",
    prepared_commit: "a".repeat(40),
    prepared_tree: "b".repeat(40),
    source_commit: "c".repeat(40),
    version: "0.1.0-beta.1",
    release_run: { run_id: "123", attempt: 1 },
    transient_retries: 0,
    substantive_repairs: 0,
    frozen_opportunity: structuredClone(
      input.manifest.facts && (input.manifest.facts as { opportunity: object }).opportunity,
    ),
  };
  const historical = { ...input.coordinator_input, active_candidate: candidate };
  const nextPublished = {
    ...published,
    repository_sha256: "4".repeat(64),
    snapshot_sha256: "5".repeat(64),
    timestamp_sha256: "6".repeat(64),
    records_sha256: "7".repeat(64),
    operation_id: "8".repeat(64),
  };
  const current = {
    ...historical,
    active_candidate: { ...candidate, phase: "promoting" },
    published_metadata: nextPublished,
  };
  const {
    operation_id: _operation,
    publication: _publication,
    ...signedPublication
  } = nextPublished;
  const beforePages = { ...current, published_metadata: published };
  assert.equal(nativeCompletionUsesHistoricalLineage(beforePages, input.manifest), false);
  assert.deepEqual(
    deriveNativePublicationJourneys({ ...input, coordinator_input: beforePages }),
    deriveNativePublicationJourneys(input),
  );
  assert.equal(nativeCompletionUsesHistoricalLineage(current, input.manifest), true);
  const wrongSeed = {
    ...current,
    published_metadata: { ...nextPublished, repository_sha256: "0".repeat(64) },
  };
  assert.equal(nativeCompletionUsesHistoricalLineage(wrongSeed, input.manifest), true);
  assert.throws(
    () => inspectNativeCompletionLineage(wrongSeed, historical, input.manifest, signedPublication),
    /signed candidate/,
  );
  const changedOldRoot = {
    ...beforePages,
    published_metadata: { ...published, root_sha256: "0".repeat(64) },
  };
  assert.equal(nativeCompletionUsesHistoricalLineage(changedOldRoot, input.manifest), false);
  assert.throws(
    () => deriveNativePublicationJourneys({ ...input, coordinator_input: changedOldRoot }),
    /prior differs/,
  );
  assert.throws(
    () =>
      nativeCompletionUsesHistoricalLineage(current, {
        ...input.manifest,
        previous_site_pins: null,
      }),
    /identity missing/,
  );
  const lineage = inspectNativeCompletionLineage(
    current,
    historical,
    input.manifest,
    signedPublication,
  );
  assert.equal(lineage.authority, "none");
  assert.deepEqual(lineage.input, historical);
  assert.notEqual(lineage.input, historical);
  // The unchanged reserved/signing path must still refuse a newer public seed.
  assert.throws(
    () => deriveNativePublicationJourneys({ ...input, coordinator_input: current }),
    /prior differs/,
  );
  assert.deepEqual(
    deriveNativePublicationJourneys({ ...input, coordinator_input: lineage.input }),
    deriveNativePublicationJourneys(input),
  );
  for (const name of [
    "prepared_commit",
    "prepared_tree",
    "source_commit",
    "version",
    "release_run",
    "transient_retries",
    "substantive_repairs",
    "frozen_opportunity",
  ] as const) {
    const changed = structuredClone(current) as Record<string, unknown>;
    (changed.active_candidate as Record<string, unknown>)[name] = "changed";
    assert.throws(
      () => inspectNativeCompletionLineage(changed, historical, input.manifest, signedPublication),
      /lineage differs/,
    );
  }
  assert.throws(
    () =>
      inspectNativeCompletionLineage(
        { ...current, active_candidate: candidate },
        historical,
        input.manifest,
        signedPublication,
      ),
    /promoting/,
  );
  assert.throws(
    () =>
      inspectNativeCompletionLineage(
        current,
        historical,
        { ...input.manifest, facts: { opportunity: { base_commit: "d".repeat(40) } } },
        signedPublication,
      ),
    /opportunity differs/,
  );
  for (const key of [
    "repository_sha256",
    "root_sha256",
    "offline_targets_sha256",
    "snapshot_sha256",
    "timestamp_sha256",
    "records_sha256",
  ] as const)
    assert.throws(
      () =>
        inspectNativeCompletionLineage(current, historical, input.manifest, {
          ...signedPublication,
          [key]: "0".repeat(64),
        }),
      /signed candidate/,
    );
  assert.throws(
    () =>
      inspectNativeCompletionLineage(current, historical, input.manifest, {
        ...signedPublication,
        versions: { ...signedPublication.versions, timestamp: "999" },
      }),
    /signed candidate/,
  );
  assert.throws(
    () =>
      inspectNativeCompletionLineage(current, historical, input.manifest, {
        ...signedPublication,
        expires: { ...signedPublication.expires, timestamp: "2030-01-01T00:00:00Z" },
      }),
    /signed candidate/,
  );
  const journeys = deriveNativePublicationJourneys(input);
  assert.equal(journeys.length, 2);
  assert.equal((journeys[0] as { kind: string }).kind, "initial-empty-feed");
  assert.equal(reads, 0);
  const locatorPins = {
    ...pins,
    public_source: {
      ...pins.public_source,
      initial_site_preimage: {
        path: "release-public/initial-site.json",
        bytes: 123,
        sha256: pins.initial_site_preimage_sha256,
      },
    },
  };
  const schema2 = inspectPublicationAuthorities(locatorPins, 2);
  assert.deepEqual(
    deriveNativePublicationJourneys({
      ...input,
      authority_schema_version: 2,
      public_pins: schema2,
    }),
    journeys,
  );
  assert.throws(
    () => deriveNativePublicationJourneys({ ...input, public_pins: schema2 }),
    /schema2/,
  );
  assert.throws(() =>
    deriveNativePublicationJourneys({
      ...input,
      files: new Map([["payload.json", Buffer.from("changed")]]),
    }),
  );
  assert.throws(() =>
    deriveNativePublicationJourneys({
      ...input,
      coordinator_input: { ...input.coordinator_input, metadata_bootstrap: null },
    }),
  );
  const record = Buffer.from(JSON.stringify({ version: "0.1.0-beta.1", artifact: {} }));
  const recordSha = createHash("sha256").update(record).digest("hex");
  const files = new Map(input.files);
  files.set(`prior/targets/${recordSha}.releases/old.json`, record);
  assert.throws(() => deriveNativePublicationJourneys({ ...input, files }), /prior differs/);
  assert.equal(reads, 0);
});
