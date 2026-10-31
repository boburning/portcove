import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { selectedPublicationAuthoritiesFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import {
  deriveHostedNativePayloadOpportunities,
  collectConfiguredHostedNativePayloadPair,
  collectConfiguredHostedNativePublicationPair,
  deriveHostedNativePublicationOpportunities,
} from "./release-hosted-native-admission.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import {
  inspectNativeQualificationAssociation,
  requireNativeReleaseQualificationPair,
  collectNativeReleaseQualificationPair,
  collectConfiguredNativeReleaseQualificationPair,
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

void test("Windows first beta requires ratified profile and complete exact Windows native evidence without Linux artifacts", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t, true, "initial-beta-windows-x86_64-v1");
  const broad = selectedPublicationAuthoritiesFixture("application");
  assert.equal(broad.purpose, "application");
  if (broad.purpose !== "application") throw new Error("fixture purpose");
  const selected = {
    ...broad,
    release_profile: "initial-beta-windows-x86_64-v1",
    hosted_native: { "windows-x86_64": broad.hosted_native["windows-x86_64"] },
  };
  const opportunities = await deriveHostedNativePayloadOpportunities(
    selected,
    f.request,
    f.archives,
  );
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0]!.platform_label, "windows-x86_64");
  const report = nativeQualificationFixture();
  report.candidate = opportunities[0]!.candidate;
  const associated = await inspectNativeQualificationAssociation(
    [report],
    f.request,
    f.archives,
    "payload-signing",
  );
  assert.equal(associated.reports.length, 1);
  for (const archives of [
    [],
    [...f.archives, f.archives[0]],
    [{ ...f.archives[0], platform: "linux-x86_64" }],
  ])
    await assert.rejects(deriveHostedNativePayloadOpportunities(selected, f.request, archives));
  await assert.rejects(deriveHostedNativePayloadOpportunities(broad, f.request, f.archives));
  await assert.rejects(
    deriveHostedNativePayloadOpportunities(
      { ...selected, hosted_native: broad.hosted_native },
      f.request,
      f.archives,
    ),
  );
  for (const reports of [
    [],
    [report, report],
    [{ ...report, candidate: { ...report.candidate, source_commit: "0".repeat(40) } }],
    [{ ...report, platform_label: "linux-x86_64" }],
  ])
    await assert.rejects(
      inspectNativeQualificationAssociation(reports, f.request, f.archives, "payload-signing"),
    );
  await assert.rejects(
    requireNativeReleaseQualificationPair([{}], f.request, f.archives, "payload-signing"),
  );
});
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  deriveNativePublicationJourneys,
  deriveHostedNativePublicationJourneys,
  inspectNativeCompletionLineage,
  nativeCompletionUsesHistoricalLineage,
  inspectNativePublicationPredecessor,
  inspectNativeInitialPublicationJourney,
  collectConfiguredNativePublicationQualificationPair,
  collectConfiguredNativePublicationCompletionPair,
} from "./release-native-publication-admission.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import { metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requireRetainedActualTufPublication } from "./release-tuf-publication.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  hostedNativeArtifactName,
  readHostedNativeProofArchive,
  readHostedNativeProofArtifact,
} from "./release-hosted-native-artifact.mts";
import { hostedNativeProofLimits } from "./release-hosted-native-proof-contract.mts";
import authorityOracle from "./fixtures/release-job-authorities-prechange.json" with { type: "json" };
import { releaseControlPhaseProfile } from "./release-control-phases.mts";

const hostedInitialJourney = () => ({
  kind: "initial-empty-feed",
  metadata_bootstrap_sha256: "1".repeat(64),
  setup_plan_sha256: "2".repeat(64),
  initial_site_preimage_sha256: "3".repeat(64),
  empty_records_sha256: createHash("sha256").update("[]").digest("hex"),
  signed_context_sha256: "4".repeat(64),
  signatures_sha256: "5".repeat(64),
});

void test("actual selected post-sign callers use the normalized namespace through context and anchor checks before reservation read", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "selected-postsign-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const row = authorityOracle.cases.find((entry) => entry.name === "selected-app")!;
  const workflow = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const data = {
    root,
    configuration: row.configuration,
    policy: row.policy,
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
    assembly: f.request,
    archives: [
      { platform: "windows-x86_64", artifact_id: 901 },
      { platform: "linux-x86_64", artifact_id: 902 },
    ],
  };
  // Private capability getters are replaced only inside a disposable test
  // process. This demonstrates composition, not actual TUF/native acceptance.
  const script = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const data = ${JSON.stringify(data)};
const base = pathToFileURL(process.cwd() + '/scripts/');
const url = name => new URL(name + '.mts', base).href;
const names = ['release-tuf-publication', 'release-signing-context-artifact', 'release-signing-context', 'release-coordinator-recovery'];
const original = await Promise.all(names.map(name => import(url(name))));
const { releaseCanonicalDigest: digest } = await import(url('release-canonical'));
const bytes = Buffer.from('{}');
const sha = createHash('sha256').update(bytes).digest('hex');
const configuration = structuredClone(data.configuration);
for (const key of ['root', 'offline_targets', 'payload_key_registry']) {
  configuration.publication.public_source[key].sha256 = sha;
  configuration.publication.public_source[key].bytes = bytes.length;
}
process.env.PORTCOVE_EXECUTION_PURPOSE = 'application';
process.env.PORTCOVE_RELEASE_AUTHORITIES = JSON.stringify(configuration);
process.env.PORTCOVE_CONTROLLER_ADMISSION = JSON.stringify({ ...data.policy, workflow_sha256: data.workflow_sha256, authority_configuration_sha256: digest(configuration) });
process.env.GITHUB_JOB = 'release_publication';
const namespace = configuration.journal.namespace;
assert.equal(configuration.namespace, undefined);
const contextReceipt = {}, tufReceipt = {};
const manifest = { facts: { configuration: { namespace }, opportunity: {}, assembly: data.assembly, archives: data.archives }, binding: {} };
let reads = 0;
mock.module(url(names[0]), { namedExports: { ...original[0], requireActualTufPublication: async receipt => {
  assert.equal(receipt, tufReceipt);
  return { context_receipt: contextReceipt, publication: { repository_sha256: 'a'.repeat(64) } };
} } });
mock.module(url(names[1]), { namedExports: { ...original[1], requireReceivedSigningContext: async receipt => {
  assert.equal(receipt, contextReceipt);
  return { manifest, context: data.root + '/context/manifest.json' };
} } });
mock.module(url(names[2]), { namedExports: { ...original[2], readBoundedReleaseContextFiles: async () => new Map(['trusted-root.json', 'offline-targets.json', 'payload.json'].map(name => [name, bytes])) } });
mock.module(url(names[3]), { namedExports: { ...original[3], readRemoteCoordinatorSnapshot: async (_directory, selected) => {
  assert.deepEqual(selected, { schema_version: 1, namespace });
  reads++;
  throw new Error('bounded synthetic reservation seam');
} } });
const collector = await import(url('release-native-publication-admission') + '?selected-composition');
for (const name of ['collectConfiguredNativePublicationQualificationPair', 'collectConfiguredNativePublicationCompletionPair']) {
  await assert.rejects(collector[name](data.root, null, data.assembly, data.archives, contextReceipt, tufReceipt, performance.now() + 10000), /configured post-sign native collection refused/);
}
assert.equal(reads, 2);
manifest.facts.configuration.namespace = 'wrong-namespace';
await assert.rejects(collector.collectConfiguredNativePublicationQualificationPair(data.root, null, data.assembly, data.archives, contextReceipt, tufReceipt, performance.now() + 10000), /acquired candidate differs/);
assert.equal(reads, 2);
process.stdout.write('selected-reservation-seam:2\\n');
`;
  const child = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-"],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...authorityOracle.environment },
      input: script,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      shell: false,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "selected-reservation-seam:2");
});

void test("hosted post-sign opportunities bind each exact package to a closed signed-repository journey and snapshot it", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const configuration = selectedPublicationAuthoritiesFixture("application");
  const archives = [
    { platform: "windows-x86_64", artifact_id: 901 },
    { platform: "linux-x86_64", artifact_id: 902 },
  ];
  const journeys = ["linux-x86_64", "windows-x86_64"].map((platform_label) => ({
    platform_label,
    journey: hostedInitialJourney(),
  }));
  const expected = structuredClone(journeys);
  const pending = deriveHostedNativePublicationOpportunities(
    configuration,
    f.request,
    archives,
    journeys,
  );
  journeys[0]!.journey.signatures_sha256 = "6".repeat(64);
  const opportunities = await pending;
  assert.equal(opportunities.length, 2);
  for (const opportunity of opportunities) {
    assert.equal(opportunity.stage, "release-publication");
    assert.deepEqual(
      opportunity.journey,
      expected.find((entry) => entry.platform_label === opportunity.platform_label)!.journey,
    );
    assert.equal(opportunity.candidate.source_commit, f.request.source_commit);
    assert.equal(
      opportunity.candidate.artifact_id,
      archives.find((entry) => entry.platform === opportunity.platform_label)!.artifact_id,
    );
  }
  for (const invalid of [
    null,
    expected.slice(1),
    [expected[0], expected[0]],
    expected.map((entry) => ({ ...entry, issuer: "imported" })),
    expected.map((entry) => ({ ...entry, journey: null })),
    expected.map((entry) => ({
      ...entry,
      journey: { ...entry.journey, empty_records_sha256: "a".repeat(64) },
    })),
    expected.map((entry) => ({
      ...entry,
      journey: {
        predecessor: opportunities.find((item) => item.platform_label === entry.platform_label)!
          .candidate,
        signatures_sha256: "a".repeat(64),
        signed_context_sha256: "b".repeat(64),
      },
    })),
  ])
    await assert.rejects(
      deriveHostedNativePublicationOpportunities(configuration, f.request, archives, invalid),
    );
});

void test("actual admission and payload source dispatch selects hosted proof readers without legacy App authority or ambient credentials", async (t) => {
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  const selected = authorityOracle.cases.find((row) => row.name === "selected-app")!;
  const workflow = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  Object.assign(process.env, authorityOracle.environment, {
    PORTCOVE_EXECUTION_PURPOSE: "application",
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(selected.configuration),
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
      ...selected.policy,
      workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
    }),
  });
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const archives = [
    { platform: "windows-x86_64", artifact_id: 901 },
    { platform: "linux-x86_64", artifact_id: 902 },
  ];
  for (const phase of ["admission", "payload"] as const) {
    process.env.GITHUB_JOB = releaseControlPhaseProfile(phase).reader_job;
    await assert.rejects(
      collectConfiguredNativeReleaseQualificationPair(
        process.cwd(),
        [{ authority: "imported" }, {}],
        {},
        [],
        phase,
      ),
      /cannot appoint/,
    );
    // The current actual selected source is admitted, but an ambient GH_TOKEN
    // cannot substitute for the explicitly confined transport context.
    await assert.rejects(
      collectConfiguredNativeReleaseQualificationPair(
        process.cwd(),
        null,
        f.request,
        archives,
        phase,
      ),
      /isolated reader credentials/,
    );
  }
  process.env.GITHUB_JOB = releaseControlPhaseProfile("release-publication").reader_job;
  await assert.rejects(
    collectConfiguredHostedNativePublicationPair(
      process.cwd(),
      null,
      f.request,
      archives,
      ["windows-x86_64", "linux-x86_64"].map((platform_label) => ({
        platform_label,
        journey: hostedInitialJourney(),
      })),
      performance.now() + 10000,
    ),
    /isolated reader credentials/,
  );
  await assert.rejects(
    collectConfiguredHostedNativePublicationPair(
      process.cwd(),
      null,
      {},
      [],
      [],
      performance.now() - 1,
    ),
    /deadline exhausted/,
  );
  await assert.rejects(
    collectConfiguredHostedNativePayloadPair(
      process.cwd(),
      null,
      {},
      [],
      "payload",
      performance.now() - 1,
    ),
    /deadline exhausted/,
  );
});

void test("native proof archive preflights all members before bounded decoding and never extracts", () => {
  const keys = ["subject", "report", "capture", "bundle"] as const;
  const archive = createAuditZip(
    keys.map((key) => [`${key}.json`, Buffer.alloc(hostedNativeProofLimits[key], 97)] as const),
  );
  const decoded = readHostedNativeProofArchive(archive, performance.now() + 10000);
  for (const key of keys) assert.equal(decoded[key].length, hostedNativeProofLimits[key]);
  const small = createAuditZip(keys.map((key) => [`${key}.json`, "{}"] as const));
  const declared = Buffer.from(small);
  const central = declared.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // A tiny payload declares an oversized first member while the total still
  // fits. Failure must precede inflation, which would instead report bad size.
  declared.writeUInt32LE(hostedNativeProofLimits.subject + 1, central + 24);
  declared.writeUInt32LE(hostedNativeProofLimits.subject + 1, 22);
  assert.throws(
    () => readHostedNativeProofArchive(declared, performance.now() + 10000),
    /member exceeds/,
  );
  assert.throws(
    () =>
      readHostedNativeProofArchive(small.subarray(0, small.length - 1), performance.now() + 10000),
    /ZIP rejected/,
  );
  for (const entries of [
    keys.slice(1).map((key) => [`${key}.json`, "{}"] as const),
    [...keys.map((key) => [`${key}.json`, "{}"] as const), ["extra.json", "{}"] as const],
    keys.map((key) => [key === "subject" ? "../subject.json" : `${key}.json`, "{}"] as const),
    keys.map(
      (key) =>
        [`${key}.json`, "{}", { attributes: key === "subject" ? 0xa1ff0000 : 0x81a40000 }] as const,
    ),
  ])
    assert.throws(() =>
      readHostedNativeProofArchive(createAuditZip(entries), performance.now() + 10000),
    );
  assert.throws(() => readHostedNativeProofArchive(small, performance.now() - 1), /deadline/);
});

void test("native proof artifact discovery brackets inert bytes with exact source-bound inventory and refuses drift", () => {
  const expected = {
    controller_revision: "a".repeat(40),
    run_id: "123",
    run_attempt: 1,
    platform_label: "windows-x86_64" as const,
    stage: "payload-signing" as const,
  };
  const name = hostedNativeArtifactName(expected);
  const subject = {
    schema_version: 1,
    purpose: "hosted-native-qualification",
    platform_label: expected.platform_label,
    stage: expected.stage,
    producer: {
      controller_revision: expected.controller_revision,
      run_id: "123",
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
    },
  };
  const fixture = (value = subject) =>
    createAuditZip([
      ["subject.json", JSON.stringify(value)],
      ["report.json", "{}"],
      ["capture.json", "{}"],
      ["bundle.json", "{}"],
    ]);
  const archive = fixture();
  const row = {
    id: 10,
    name,
    expired: false,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    size_in_bytes: archive.length,
    workflow_run: {
      id: 123,
      head_sha: expected.controller_revision,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
    },
  };
  const run = (
    mode:
      | "ok"
      | "missing"
      | "duplicate"
      | "drift"
      | "source"
      | "digest"
      | "subject"
      | "unavailable",
  ) => {
    let reads = 0,
      downloads = 0;
    const bytes =
      mode === "subject"
        ? fixture({ ...subject, producer: { ...subject.producer, run_id: "124" } })
        : archive;
    const current = {
      ...row,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_in_bytes: bytes.length,
    };
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        assert.equal(
          endpoint,
          "repos/boburning/portcove/actions/runs/123/artifacts?per_page=100&page=1",
        );
        reads++;
        const artifacts =
          mode === "missing"
            ? []
            : mode === "duplicate"
              ? [current, { ...current, id: 11 }]
              : [
                  {
                    ...current,
                    ...(mode === "drift" && reads === 2 ? { id: 11 } : {}),
                    ...(mode === "source"
                      ? { workflow_run: { ...current.workflow_run, head_sha: "b".repeat(40) } }
                      : {}),
                  },
                ];
        return {
          status: mode === "unavailable" ? 403 : 200,
          headers: new Map<string, string>(),
          body: { total_count: artifacts.length, artifacts },
        };
      },
    };
    const result = readHostedNativeProofArtifact(
      api,
      expected,
      process.cwd(),
      performance.now() + 10000,
      (endpoint, options) => {
        downloads++;
        assert.equal(endpoint, "repos/boburning/portcove/actions/artifacts/10/zip");
        assert.equal(options.maxBytes, bytes.length);
        return mode === "digest" ? Buffer.alloc(bytes.length) : bytes;
      },
    );
    assert.equal(reads, 2);
    assert.equal(downloads, 1);
    assert.equal(result.authority, "none");
    assert.deepEqual(result.locator, {
      run_id: "123",
      run_attempt: 1,
      platform_label: "windows-x86_64",
      job_id: 456,
      check_run_id: "789",
    });
    assert.equal(result.files.report.toString(), "{}");
    assert.equal(Object.hasOwn(result, "hosted_job"), false);
  };
  run("ok");
  for (const mode of [
    "missing",
    "duplicate",
    "drift",
    "source",
    "digest",
    "subject",
    "unavailable",
  ] as const)
    assert.throws(() => run(mode));
  assert.throws(() => hostedNativeArtifactName({ ...expected, run_attempt: 2 }), /slot/);
});

void test("selected hosted opportunities derive exact real package/source/archive identities without appointing a Native App or host", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const configuration = selectedPublicationAuthoritiesFixture("application");
  const archives = [
    { platform: "windows-x86_64", artifact_id: 901 },
    { platform: "linux-x86_64", artifact_id: 902 },
  ];
  const opportunities = await deriveHostedNativePayloadOpportunities(
    configuration,
    f.request,
    archives,
  );
  assert.equal(opportunities.length, 2);
  for (const opportunity of opportunities) {
    assert.equal(opportunity.stage, "payload-signing");
    assert.equal(opportunity.candidate.source_commit, f.request.source_commit);
    assert.equal(opportunity.candidate.source_tree, f.request.source_tree);
    assert.equal(
      opportunity.candidate.artifact_id,
      archives.find((entry) => entry.platform === opportunity.platform_label)?.artifact_id,
    );
    assert.equal(opportunity.journey, null);
    assert.equal(Object.hasOwn(opportunity, "native_app_id"), false);
    assert.equal(Object.hasOwn(opportunity, "producer"), false);
    assert.equal(Object.hasOwn(opportunity, "host"), false);
  }
  await assert.rejects(
    deriveHostedNativePayloadOpportunities(configuration, f.request, [archives[0], archives[0]]),
    /archive/,
  );
  await assert.rejects(
    deriveHostedNativePayloadOpportunities(configuration, f.request, [
      archives[0],
      { ...archives[1], artifact_id: 901 },
    ]),
    /duplicated/,
  );
  await assert.rejects(
    deriveHostedNativePayloadOpportunities(
      selectedPublicationAuthoritiesFixture("catalog-publication"),
      f.request,
      archives,
    ),
    /application/,
  );
});

void test("configured selected native entry refuses imported authority fields and non-byte proof transfers before source or provider access", async () => {
  const locator = {
    platform_label: "windows-x86_64",
    run_id: "1",
    run_attempt: 1,
    job_id: 1,
    check_run_id: "1",
  };
  const files = {
    subject: Buffer.from("{}"),
    report: Buffer.from("{}"),
    capture: Buffer.from("{}"),
    bundle: Buffer.from("{}"),
  };
  await assert.rejects(
    collectConfiguredHostedNativePayloadPair(
      process.cwd(),
      [
        { locator: { ...locator, grant_sha256: "a".repeat(64) }, files },
        { locator: { ...locator, platform_label: "linux-x86_64" }, files },
      ],
      {},
      [],
    ),
    /cannot appoint/,
  );
  await assert.rejects(
    collectConfiguredHostedNativePayloadPair(
      process.cwd(),
      [
        { locator, files: { ...files, report: "imported" } },
        { locator: { ...locator, platform_label: "linux-x86_64" }, files },
      ],
      {},
      [],
    ),
    /file exceeds/,
  );
});

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
    inspectNativeInitialPublicationJourney({
      ...input,
      authority_schema_version: 2,
      public_pins: schema2,
    }),
    result,
  );
  assert.throws(
    () => inspectNativeInitialPublicationJourney({ ...input, public_pins: schema2 }),
    /schema2/,
  );
  assert.throws(
    () =>
      inspectNativeInitialPublicationJourney({
        ...input,
        authority_schema_version: 3,
        public_pins: schema2,
      }),
    /schema/,
  );
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

void test("shared data-only journey derivation binds exact prior inventory and refuses bootstrap on changed or nonempty prior", async () => {
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
    await deriveHostedNativePublicationJourneys(
      { ...input, authority_schema_version: 4, public_pins: schema2 },
      os.tmpdir(),
      performance.now() + 60000,
    ),
    journeys,
  );
  await assert.rejects(
    deriveHostedNativePublicationJourneys(input, os.tmpdir(), performance.now() + 60000),
    /selected/,
  );
  await assert.rejects(
    deriveHostedNativePublicationJourneys(
      { ...input, authority_schema_version: 4, public_pins: schema2 },
      os.tmpdir(),
      performance.now() - 1,
    ),
    /deadline/,
  );
  assert.equal(reads, 0);
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
