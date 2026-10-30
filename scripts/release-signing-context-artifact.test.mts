import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import childProcess, { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  signingContextArtifactFixture as fixture,
  signingContextDefaultTransport,
} from "./fixtures/signing-context-artifact-fixture.mts";
import { syncBuiltinESMExports } from "node:module";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { inspectHostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import {
  inspectSigningContextArchive,
  prepareSigningContextArtifact,
  prepareSigningContextPredicate,
  receiveSigningContextArtifact,
  receiveMetadataSigningContextArtifact,
  prepareMetadataSigningContextArtifact,
  requireReceivedSigningContext,
  requireRetainedSigningContext,
  signingContextPredicateType,
  handoffSigningContextArtifact,
} from "./release-signing-context-artifact.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
void test("retained context rechecks its original deadline after asynchronous full-tree read", async () => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      fileURLToPath(new URL("./fixtures/signing-context-receiver-fixture.mts", import.meta.url)),
    ],
    { env: environment, timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true },
  );
  assert.match(stdout, /actual receiver deadline PASS; controlled provider, no hosted authority/u);
});

void test("context upload handoff cannot start from imported custody or renew an expired phase", async () => {
  const pending = { checkpoint: "a".repeat(40), operation_id: "b".repeat(64) };
  await assert.rejects(
    handoffSigningContextArtifact({}, {}, pending, performance.now() + 1000),
    /actual private/,
  );
  await assert.rejects(
    handoffSigningContextArtifact({}, {}, pending, performance.now() - 1),
    /deadline/,
  );
});

void test("bounded context ZIP has exactly two fixed members and complete packed public-file identity", () => {
  const f = fixture();
  const inspected = inspectSigningContextArchive(f.archive);
  assert.equal(inspected.authority, "none");
  assert.deepEqual([...inspected.files], [...f.files]);
  for (const archive of [
    f.archiveFor(f.manifestBytes, Buffer.concat([f.packed, Buffer.from("extra")])),
    f.archiveFor(Buffer.from(JSON.stringify({ ...f.manifest, files: f.manifest.files.slice(1) }))),
    f.archiveFor(Buffer.from(JSON.stringify({ ...f.manifest, facts_sha256: "0".repeat(64) }))),
    createAuditZip([["context.json", Buffer.from("{}")]]),
  ])
    assert.throws(() => inspectSigningContextArchive(archive));
});
void test("selected native proof identities survive the existing context archive without legacy Check substitution", () => {
  const f = fixture();
  const native_proofs = (["linux-x86_64", "windows-x86_64"] as const).map((platform) => {
    const native = hostedNativeProofFixture(platform),
      proof = inspectHostedNativeProofFiles(native.files, native.authorities, native.producer);
    return {
      platform,
      transport: "fixed-hosted-job",
      report_sha256: proof.report_sha256,
      hosted_job: {
        ...native.producer,
        subject_sha256: proof.subject_sha256,
        report_sha256: proof.report_sha256,
        bundle_sha256: "b".repeat(64),
      },
    };
  });
  const binding = {
    ...Object.fromEntries(
      Object.entries(f.manifest.binding).filter(([key]) => key !== "native_checks"),
    ),
    native_proofs,
  };
  const archive = (replacement: unknown) =>
    f.archiveFor(Buffer.from(JSON.stringify({ ...f.manifest, binding: replacement })));
  const inspected = inspectSigningContextArchive(archive(binding));
  assert.deepEqual(inspected.manifest.binding, binding);
  assert.equal(Object.hasOwn(inspected.manifest.binding, "native_checks"), false);
  for (const changed of [
    { ...binding, native_checks: [{ id: 1 }, { id: 2 }] },
    { ...binding, native_proofs: [native_proofs[0], native_proofs[0]] },
    { ...binding, native_proofs: [{ ...native_proofs[0], check_id: 1 }, native_proofs[1]] },
    {
      ...binding,
      native_proofs: [{ ...native_proofs[0], report_sha256: "e".repeat(64) }, native_proofs[1]],
    },
  ])
    assert.throws(() => inspectSigningContextArchive(archive(changed)));
});
void test("coordinator metadata context reuses complete bounded custody and fixed attestation without release/native claims", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "metadata-context-transport-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const f = fixture("metadata-signing-context");
  const inspected = inspectSigningContextArchive(f.archive);
  assert.equal(inspected.manifest.kind, "metadata-signing-context");
  assert.deepEqual(inspected.manifest.binding, f.manifest.binding);
  assert.deepEqual([...inspected.files], [...f.files]);
  const receipt = await receiveMetadataSigningContextArtifact(
    parent,
    f.expected,
    performance.now() + 5000,
    f.options,
  );
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.equal(receipt.kind, "attested-metadata-signing-context");
  assert.equal(receipt.authority, "none");
  await assert.rejects(requireReceivedSigningContext(receipt), /actual authenticated/);
  assert.deepEqual(f.counts(), { requests: 12, downloads: 2 });
  const wrongJob = fixture("metadata-signing-context");
  wrongJob.faults.value = "wrong-role-job";
  await assert.rejects(
    receiveMetadataSigningContextArtifact(
      parent,
      wrongJob.expected,
      performance.now() + 5000,
      wrongJob.options,
    ),
    /retain/,
  );
  await assert.rejects(
    receiveSigningContextArtifact(parent, f.expected, performance.now() + 5000, f.options),
    /retain/,
  );
  const release = fixture();
  await assert.rejects(
    receiveMetadataSigningContextArtifact(
      parent,
      release.expected,
      performance.now() + 5000,
      release.options,
    ),
    /retain/,
  );
  await assert.rejects(prepareMetadataSigningContextArtifact({}, parent), /actual coordinator/);
  for (const replacement of [
    { ...f.manifest, kind: "release-signing-context" },
    { ...f.manifest, binding: { ...f.manifest.binding, version: "1.0.0" } },
    {
      ...f.manifest,
      facts: { ...f.manifest.facts, mode: "bootstrap" },
      facts_sha256: digest({ ...f.manifest.facts, mode: "bootstrap" }),
    },
    {
      ...f.manifest,
      previous_site_pins: { ...f.manifest.previous_site_pins, root_sha256: "0".repeat(64) },
    },
  ])
    assert.throws(() =>
      inspectSigningContextArchive(f.archiveFor(Buffer.from(JSON.stringify(replacement)))),
    );
  const changed = Buffer.from(f.packed);
  const declaration = f.files.get("renewal.json")!;
  const at = changed.indexOf(declaration);
  assert.ok(at >= 0);
  changed[at] = "[".charCodeAt(0);
  assert.throws(() => inspectSigningContextArchive(f.archiveFor(f.manifestBytes, changed)));
});
void test("successful exact payload context survives a later sibling workflow failure but not a failed producer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-completed-component-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  f.run.status = "completed";
  f.run.conclusion = "failure";
  const result = await receiveSigningContextArtifact(
    root,
    f.expected,
    performance.now() + 5000,
    f.options,
  );
  assert.equal(result.evidence_scope, "injected-provider");
  await assert.rejects(requireReceivedSigningContext(result), /actual authenticated/);
  for (const fault of ["job-failure", "job"]) {
    const failed = fixture();
    failed.run.status = "completed";
    failed.run.conclusion = "failure";
    failed.faults.value = fault;
    await assert.rejects(
      receiveSigningContextArtifact(
        root,
        failed.expected,
        performance.now() + 5000,
        failed.options,
      ),
      /retain/,
    );
  }
  const impossible = fixture();
  impossible.run.conclusion = "failure";
  await assert.rejects(
    receiveSigningContextArtifact(
      root,
      impossible.expected,
      performance.now() + 5000,
      impossible.options,
    ),
    /retain/,
  );
});
void test("injected complete provider/attestation path proves data association but cannot mint actual context brand", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const result = await receiveSigningContextArtifact(
    root,
    f.expected,
    performance.now() + 5000,
    f.options,
  );
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.publication_admission, "not-established");
  assert.deepEqual(f.counts(), { requests: 12, downloads: 2 });
  await assert.rejects(requireReceivedSigningContext(result), /actual authenticated/);
  await assert.rejects(
    requireRetainedSigningContext(result, performance.now() + 1000),
    /actual authenticated/,
  );
  assert.deepEqual(f.counts(), { requests: 12, downloads: 2 });
  for (const fault of ["job", "certificate", "drift"]) {
    const changed = fixture();
    changed.faults.value = fault;
    await assert.rejects(
      receiveSigningContextArtifact(
        root,
        changed.expected,
        performance.now() + 5000,
        changed.options,
      ),
      /retain/,
    );
  }
});
void test("the fixed default transport shares one finite context read budget across the complete callable graph", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-default-transport-")),
    f = fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Simulated provider at the OS transport boundary only. The maintained
  // default receiver still performs all archive/certificate/producer joins;
  // production has no imported-proof or test-only constructor.
  const mocked = t.mock.method(childProcess, "spawnSync", signingContextDefaultTransport(f));
  syncBuiltinESMExports();
  try {
    const receipt = await receiveSigningContextArtifact(
      root,
      f.expected,
      performance.now() + 15000,
    );
    assert.equal(receipt.evidence_scope, "github.com");
    for (let round = 0; round < 62; round++) await requireReceivedSigningContext(receipt);
    assert.deepEqual(f.counts(), { requests: 384, downloads: 2 });
    await assert.rejects(requireReceivedSigningContext(receipt), /readback budget exceeded/);
    assert.deepEqual(f.counts(), { requests: 384, downloads: 2 });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
void test("missing private producer receipt and exhausted receiver budget refuse before effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareSigningContextArtifact({}, root), /same-process/);
  await assert.rejects(
    prepareSigningContextPredicate(
      {},
      { artifact_id: 1, sha256: "0".repeat(64) },
      {},
      performance.now() + 1000,
    ),
    /private/,
  );
  const f = fixture();
  await assert.rejects(
    receiveSigningContextArtifact(root, f.expected, performance.now() - 1, f.options),
    /deadline/,
  );
  assert.deepEqual(f.counts(), { requests: 0, downloads: 0 });
  assert.deepEqual(await readdir(root), []);
});

void test("existing pinned attestation verifier respects the remaining role budget before and after execution", (t) => {
  const f = fixture();
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  const spawn: NonNullable<
    NonNullable<Parameters<typeof verifyControllerArtifactStatement>[5]>["spawn"]
  > = (command, args, settings) => {
    calls++;
    assert.equal(settings.timeout, 1000);
    const result = f.options.spawn(command, args);
    clock += 1001;
    return result;
  };
  assert.throws(
    () =>
      verifyControllerArtifactStatement(
        os.tmpdir(),
        "manifest.json",
        "attestation.json",
        f.expected,
        signingContextPredicateType,
        { spawn, deadline: 999 },
      ),
    /deadline/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      verifyControllerArtifactStatement(
        os.tmpdir(),
        "manifest.json",
        "attestation.json",
        f.expected,
        signingContextPredicateType,
        { spawn, deadline: 2000 },
      ),
    /deadline/,
  );
  assert.equal(calls, 1);
});

void test("initial context archive is exactly six public inputs with explicit empty records and no prior", async () => {
  const { metadataBootstrapFixture } = await import("./fixtures/release-metadata-fixture.mts");
  const { descriptor } = metadataBootstrapFixture();
  const files = new Map<string, Buffer>([
    [
      "context.json",
      Buffer.from(
        JSON.stringify({ schema_version: 1, initial_bootstrap: "initial-bootstrap.json" }),
      ),
    ],
    ["initial-bootstrap.json", Buffer.from(JSON.stringify(descriptor))],
    ["trusted-root.json", Buffer.from("public root fixture")],
    ["offline-targets.json", Buffer.from("public offline fixture")],
    ["payload.json", Buffer.from("public registry fixture")],
    [
      "records/reconstruction-manifest.json",
      Buffer.from(JSON.stringify({ schema_version: 1, records: [] })),
    ],
  ]);
  const facts = {
    mode: "bootstrap",
    descriptor,
    namespace: "portcove-fixture",
    checkpoint: "2".repeat(40),
    previous_site_pins: null,
    setup_plan_sha256: descriptor.setup_plan_sha256,
    public_source_commit: "c".repeat(40),
  };
  const binding = {
    kind: "metadata-bootstrap",
    descriptor_sha256: digest(descriptor),
    records_sha256: digest([]),
  };
  const archive = (
    source = files,
    prior: unknown = null,
    boundFacts: unknown = facts,
    boundBinding: unknown = binding,
  ) => {
    const ordered = [...source].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const manifest = {
      schema_version: 1,
      kind: "metadata-signing-context",
      authority: "none",
      controller: {
        controller_revision: "a".repeat(40),
        source_tree: "b".repeat(40),
        controller_ref: "refs/tags/portcove-production-controller-fixture",
        run_id: "123",
        run_attempt: 1,
      },
      facts: boundFacts,
      binding: boundBinding,
      control_facts: { fixture: true },
      previous_site_pins: prior,
      facts_sha256: digest(boundFacts),
      files: ordered.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
    };
    return createAuditZip([
      ["signing-context-manifest.json", Buffer.from(JSON.stringify(manifest))],
      ["signing-context-bytes.bin", Buffer.concat(ordered.map(([, bytes]) => bytes))],
    ]);
  };
  const inspected = inspectSigningContextArchive(archive());
  assert.equal(inspected.files.size, 6);
  assert.equal(inspected.manifest.authority, "none");
  assert.throws(
    () =>
      inspectSigningContextArchive(
        archive(files, {
          root_sha256: "3".repeat(64),
          repository_sha256: "4".repeat(64),
          site_generation_sha256: "5".repeat(64),
        }),
      ),
    /prior/,
  );
  const catalogPins = {
    kind: "catalog-only",
    root_sha256: "3".repeat(64),
    repository_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  const initialSitePreimage = JSON.stringify({
    kind: "catalog-only-application-site-preimage",
    pins: catalogPins,
  });
  const catalogFacts = {
    ...facts,
    previous_site_pins: catalogPins,
    initial_site_preimage: initialSitePreimage,
    catalog_readback_sha256: "a".repeat(64),
    descriptor: {
      ...descriptor,
      initial_site_preimage_sha256: hash(Buffer.from(initialSitePreimage)),
    },
  };
  const catalogContext = inspectSigningContextArchive(
    archive(
      new Map([
        ...files,
        ["initial-bootstrap.json", Buffer.from(JSON.stringify(catalogFacts.descriptor))],
      ]),
      catalogPins,
      catalogFacts,
      { ...binding, descriptor_sha256: digest(catalogFacts.descriptor) },
    ),
  );
  assert.deepEqual(catalogContext.manifest.previous_site_pins, catalogPins);
  assert.equal(catalogContext.files.size, 6);
  assert.throws(() =>
    inspectSigningContextArchive(
      archive(files, catalogPins, {
        ...facts,
        previous_site_pins: { ...catalogPins, root_sha256: "6".repeat(64) },
      }),
    ),
  );
  for (const [name, bytes] of [
    ["prior/repository-manifest.json", Buffer.from("{}")],
    ["context.json", Buffer.from(JSON.stringify({ previous_repository: "prior" }))],
    [
      "records/reconstruction-manifest.json",
      Buffer.from(JSON.stringify({ schema_version: 1, records: [{ path: "releases/fake.json" }] })),
    ],
  ] as const) {
    const changed = new Map(files);
    changed.set(name, bytes);
    assert.throws(() => inspectSigningContextArchive(archive(changed)), /initial context/);
  }
});
