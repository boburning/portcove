import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectInitialApplicationDescriptor,
  prepareInitialApplicationContext,
  unpackApplicationContext,
  inspectApplicationBootstrapSource,
  applicationContextPriorRepositorySha256,
  applicationMetadataContextIdentity,
  inspectApplicationRenewalSource,
  assertApplicationRenewalContext,
  prepareApplicationMetadataRenewalContext,
} from "./application-release-context.mts";
import { applicationReleaseTrust } from "./application-release-policy.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  readBoundedReleaseContextFiles,
  releaseSigningContextBytes,
} from "./release-signing-context.mts";
import { inspectMetadataRenewalDescriptor } from "./release-metadata-contract.mts";
import { sha256 } from "./application-release-io.mts";
import { isRecord } from "./runtime-values.mts";

void test("metadata renewal binds one stable public basis and its exact authenticated-context input", async (t) => {
  // These declared bytes exercise the join, not TUF signature verification.
  const files = new Map([["prior/metadata/timestamp.json", Buffer.from("declared prior")]]);
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: applicationReleaseTrust.root.sha256,
    repository_sha256: applicationContextPriorRepositorySha256(files),
    site_generation: "a".repeat(64),
  };
  const source = {
    purpose: "metadata-renewal",
    execution_path: "metadata-maintenance",
    opportunity: digest(basis),
    renewal_basis: basis,
    renewal_generated_at: "2026-11-04T00:00:00Z",
  };
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"];
  const before = "2026-11-03T00:00:00Z",
    after = "2026-11-05T00:00:00Z";
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: source.renewal_generated_at,
    root_sha256: basis.root_sha256,
    offline_targets_sha256: applicationReleaseTrust.targets.sha256,
    prior_repository_sha256: basis.repository_sha256,
    prior_timestamp_sha256: "b".repeat(64),
    prior_snapshot_sha256: "c".repeat(64),
    unchanged_records_sha256: digest([]),
    current_versions: Object.fromEntries(roles.map((role) => [role, "1"])),
    next_versions: Object.fromEntries(roles.map((role) => [role, role === "targets" ? "1" : "2"])),
    current_expires: Object.fromEntries(roles.map((role) => [role, before])),
    next_expires: Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? before : after]),
    ),
  };
  files.set("renewal.json", Buffer.from(JSON.stringify(descriptor)));
  files.set(
    "context.json",
    releaseSigningContextBytes(
      inspectMetadataRenewalDescriptor(descriptor),
      "single-owner-one-of-one-v1",
    ),
  );
  assert.deepEqual(inspectApplicationRenewalSource(source), basis);
  const nativeClockSource = {
    purpose: source.purpose,
    execution_path: source.execution_path,
    opportunity: source.opportunity,
    renewal_basis: basis,
    renewal_clock: "native-context-reservation-v1",
  };
  assert.deepEqual(inspectApplicationRenewalSource(nativeClockSource), basis);
  assert.equal(
    assertApplicationRenewalContext(files, nativeClockSource).generated_at,
    descriptor.generated_at,
  );
  assert.throws(() =>
    inspectApplicationRenewalSource({
      ...nativeClockSource,
      renewal_generated_at: source.renewal_generated_at,
    }),
  );

  const forward = {
    ...source,
    renewal_parent: { release_id: 10, opportunity: "b".repeat(40) },
    renewal_public_prior_repository_sha256: "e".repeat(64),
  };
  assert.deepEqual(inspectApplicationRenewalSource(forward), basis);
  const historical = {
    ...descriptor,
    schema_version: 3,
    prior_expiration_policy: "historical-online-expired-v1" as const,
  };
  const historicalFiles = new Map(files);
  historicalFiles.set("renewal.json", Buffer.from(JSON.stringify(historical)));
  historicalFiles.set(
    "context.json",
    releaseSigningContextBytes(
      inspectMetadataRenewalDescriptor(historical),
      "single-owner-one-of-one-v1",
    ),
  );
  const member = {
    ...forward,
    run_custody: {
      custody: {
        schema_version: 2,
        kind: "application-release-run-custody",
        source: "a".repeat(40),
        source_tree: "b".repeat(40),
        opportunity: source.opportunity,
        preparation: null,
        runs: [
          {
            id: "123",
            control_commit: "c".repeat(40),
            control_ref: "refs/tags/portcove-production-controller-windows-fixture",
          },
        ],
        budget: { kind: "member", owner_release_id: 9, owner_opportunity: "9".repeat(64) },
      },
    },
  };
  assert.equal(assertApplicationRenewalContext(historicalFiles, member).schema_version, 3);
  assert.throws(() => assertApplicationRenewalContext(historicalFiles, source));
  assert.throws(() => assertApplicationRenewalContext(historicalFiles, forward));
  assert.throws(() => assertApplicationRenewalContext(files, member));

  assert.throws(() =>
    inspectApplicationRenewalSource({
      ...forward,
      renewal_public_prior_repository_sha256: basis.repository_sha256,
    }),
  );
  assert.throws(() =>
    inspectApplicationRenewalSource({
      ...forward,
      renewal_parent: { release_id: 10, opportunity: source.opportunity },
    }),
  );
  assert.throws(() =>
    inspectApplicationRenewalSource({
      ...source,
      renewal_public_prior_repository_sha256: "e".repeat(64),
    }),
  );
  assert.deepEqual(
    inspectApplicationRenewalSource({ ...source, execution_path: "metadata-recovery" }),
    basis,
  );
  assert.deepEqual(
    assertApplicationRenewalContext(files, source).current_versions,
    descriptor.current_versions,
  );
  assert.deepEqual(
    inspectApplicationRenewalSource({ ...source, run_id: "999", renewal_generated_at: after }),
    basis,
    "run IDs and clocks cannot allocate a different logical basis",
  );
  for (const changed of [
    { opportunity: "d".repeat(64) },
    { execution_path: "ordinary" },
    { renewal_basis: { ...basis, nonce: "reset" } },
    { renewal_basis: { ...basis, repository_sha256: "e".repeat(64) } },
    { renewal_basis: { ...basis, root_sha256: "e".repeat(64) } },
    { renewal_generated_at: "2026-11-04T00:00:00.000Z" },
  ])
    assert.throws(() => inspectApplicationRenewalSource({ ...source, ...changed }));
  assert.throws(() =>
    assertApplicationRenewalContext(files, { ...source, renewal_generated_at: after }),
  );
  const substituted = new Map(files);
  substituted.set("prior/metadata/timestamp.json", Buffer.from("changed public bytes"));
  assert.throws(() => assertApplicationRenewalContext(substituted, source));
  const bootstrap = new Map(files);
  bootstrap.set("initial-bootstrap.json", Buffer.from("{}"));
  assert.throws(() => assertApplicationRenewalContext(bootstrap, source));
  const changedContext = new Map(files);
  changedContext.set(
    "context.json",
    Buffer.from(files.get("context.json")!.toString().replace(source.renewal_generated_at, after)),
  );
  assert.throws(
    () => assertApplicationRenewalContext(changedContext, source),
    /actual signing context differs/u,
  );
  const floors = structuredClone(descriptor);
  floors.current_versions.releases = "9007199254740992";
  floors.next_versions.releases = "9007199254740993";
  const exactContext = new Map(files);
  exactContext.set("renewal.json", Buffer.from(JSON.stringify(floors)));
  exactContext.set(
    "context.json",
    releaseSigningContextBytes(
      inspectMetadataRenewalDescriptor(floors),
      "single-owner-one-of-one-v1",
    ),
  );
  assert.doesNotThrow(() => assertApplicationRenewalContext(exactContext, source));
  exactContext.set(
    "context.json",
    Buffer.from(
      exactContext.get("context.json")!.toString().replace("9007199254740993", "9007199254740992"),
    ),
  );
  assert.throws(
    () => assertApplicationRenewalContext(exactContext, source),
    /actual signing context differs/u,
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "application-renewal-context-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, "context");
  await assert.rejects(
    prepareApplicationMetadataRenewalContext(
      destination,
      {
        kind: "authenticated-metadata-renewal-preparation",
        descriptor_sha256: digest(descriptor),
        input_manifest_sha256: "f".repeat(64),
      },
      source,
    ),
    /not prepared/u,
  );
  await assert.rejects(access(destination), { code: "ENOENT" });
});

void test("assembly prior identity covers exact metadata paths and bytes independent of map order", () => {
  const files = new Map<string, Buffer>([
    ["prior/targets/abc.keys/payload.json", Buffer.from("inert registry")],
    ["prior/metadata/timestamp.json", Buffer.from("inert timestamp")],
    ["records/reconstruction-manifest.json", Buffer.from("new record fixture")],
    ["prior/metadata/1.root.json", Buffer.from("inert root")],
  ]);
  const identities = [...files]
    .filter(([name]) => name.startsWith("prior/"))
    .map(([name, bytes]) => ({ path: name.slice(6), bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const expected = digest(identities);
  assert.equal(applicationContextPriorRepositorySha256(files), expected);
  assert.equal(applicationContextPriorRepositorySha256(new Map([...files].reverse())), expected);
  assert.equal(
    applicationContextPriorRepositorySha256(
      new Map([
        ...files,
        ["prior/repository-manifest.json", Buffer.from("internal derived manifest")],
      ]),
    ),
    expected,
    "the internal artifact manifest is not a served endpoint or authority basis",
  );
  const changed = new Map(files);
  changed.set("prior/metadata/timestamp.json", Buffer.from("substituted metadata"));
  assert.notEqual(applicationContextPriorRepositorySha256(changed), expected);
  const renamed = new Map(files);
  renamed.delete("prior/metadata/1.root.json");
  renamed.set("prior/metadata/2.root.json", Buffer.from("inert root"));
  assert.notEqual(applicationContextPriorRepositorySha256(renamed), expected);
  assert.throws(() => applicationContextPriorRepositorySha256(new Map()));
  assert.throws(() =>
    applicationContextPriorRepositorySha256(
      new Map([["prior/metadata/../root.json", Buffer.from("unsafe")]]),
    ),
  );
});

function fixture() {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const instant = (days: number) =>
    new Date(now + days * 86400000).toISOString().replace(".000Z", "Z");
  const targets: unknown = JSON.parse(
    readFileSync(new URL(`../${applicationReleaseTrust.targets.path}`, import.meta.url), "utf8"),
  );
  assert.ok(
    isRecord(targets) && isRecord(targets.signed) && typeof targets.signed.expires === "string",
  );
  const raw = {
    schema_version: 1,
    kind: "application-tuf-initial-bootstrap",
    generated_at: instant(0),
    setup_plan_sha256: "1".repeat(64),
    initial_site_preimage_sha256: "2".repeat(64),
    root_sha256: applicationReleaseTrust.root.sha256,
    offline_targets_sha256: applicationReleaseTrust.targets.sha256,
    payload_key_registry_sha256: applicationReleaseTrust.payload.sha256,
    initial_records_sha256: digest([]),
    versions: {
      targets: "1",
      releases: "1",
      preview: "1",
      stable: "1",
      snapshot: "1",
      timestamp: "1",
    },
    expires: {
      targets: targets.signed.expires,
      releases: instant(60),
      preview: instant(6),
      stable: instant(6),
      snapshot: instant(6),
      timestamp: instant(1),
    },
  };
  return {
    raw,
    now,
    expected: {
      descriptor_sha256: digest(raw),
      setup_plan_sha256: raw.setup_plan_sha256,
      site_preimage_sha256: raw.initial_site_preimage_sha256,
    },
  };
}

void test("bootstrap descriptor binds existing anchors, empty records, exact appointments and current time", () => {
  const f = fixture();
  assert.equal(
    inspectInitialApplicationDescriptor(f.raw, f.expected, f.now).initial_records_sha256,
    digest([]),
  );
  const reordered = Object.fromEntries(Object.entries(f.raw).reverse());
  assert.deepEqual(
    inspectInitialApplicationDescriptor(reordered, f.expected, f.now),
    inspectInitialApplicationDescriptor(f.raw, f.expected, f.now),
  );
  for (const key of ["descriptor_sha256", "setup_plan_sha256", "site_preimage_sha256"] as const)
    assert.throws(() =>
      inspectInitialApplicationDescriptor(f.raw, { ...f.expected, [key]: "f".repeat(64) }, f.now),
    );
  for (const change of [
    { root_sha256: "f".repeat(64) },
    { offline_targets_sha256: "f".repeat(64) },
    { payload_key_registry_sha256: "f".repeat(64) },
    { initial_records_sha256: digest(["not empty"]) },
    { versions: { ...f.raw.versions, timestamp: "2" } },
    { generated_at: new Date(f.now + 3600000).toISOString().replace(".000Z", "Z") },
    {
      expires: { ...f.raw.expires, timestamp: new Date(f.now).toISOString().replace(".000Z", "Z") },
    },
  ]) {
    const raw = { ...f.raw, ...change };
    assert.throws(() =>
      inspectInitialApplicationDescriptor(
        raw,
        { ...f.expected, descriptor_sha256: digest(raw) },
        f.now,
      ),
    );
  }
});

void test("every bootstrap consumer binds the exact source purpose, opportunity and appointed epoch", () => {
  const f = fixture();
  const source = {
    purpose: "metadata-bootstrap",
    opportunity: f.expected.descriptor_sha256,
    bootstrap_descriptor: f.raw,
    bootstrap_appointment: f.expected,
  };
  assert.equal(
    inspectApplicationBootstrapSource(source, f.expected, f.now).root_sha256,
    applicationReleaseTrust.root.sha256,
  );
  for (const change of [
    { purpose: "application-release" },
    { opportunity: "f".repeat(64) },
    { bootstrap_appointment: { ...f.expected, setup_plan_sha256: "f".repeat(64) } },
    { bootstrap_descriptor: { ...f.raw, generated_at: "2000-01-01T00:00:00Z" } },
  ])
    assert.throws(() =>
      inspectApplicationBootstrapSource({ ...source, ...change }, f.expected, f.now),
    );
});

void test("initial context copies only actual public anchors and transfers bytes without granting authority", async () => {
  const f = fixture(),
    parent = await mkdtemp(path.join(os.tmpdir(), "application-context-"));
  try {
    const context = path.join(parent, "context");
    await prepareInitialApplicationContext(context, f.raw, f.expected);
    assert.equal(
      sha256(await readFile(path.join(context, "trusted-root.json"))),
      applicationReleaseTrust.root.sha256,
    );
    assert.equal(
      sha256(await readFile(path.join(context, "offline-targets.json"))),
      applicationReleaseTrust.targets.sha256,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(context, "records/reconstruction-manifest.json"), "utf8"),
      ),
      { schema_version: 1, records: [] },
    );
    const files = [...(await readBoundedReleaseContextFiles(context))].map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      sha256: sha256(bytes),
      base64: bytes.toString("base64"),
    }));
    const expected = { source: "a".repeat(40), run_id: "123", attempt: 1 };
    const packet = {
      schema_version: 1,
      authority: "none",
      source: expected.source,
      run_id: expected.run_id,
      producer_attempt: 1,
      files,
    };
    const output = path.join(parent, "unpacked");
    const restored = await unpackApplicationContext(packet, output, expected);
    assert.equal(restored.size, files.length);
    for (const [name, bytes] of restored)
      assert.deepEqual(await readFile(path.join(output, name)), bytes);
    for (const [index, invalid] of [
      { ...packet, authority: "production" },
      { ...packet, source: "b".repeat(40) },
      { ...packet, producer_attempt: 2 },
      { ...packet, files: [...files, files[0]] },
      {
        ...packet,
        files: files.map((file, i) => (i === 0 ? { ...file, path: "../escaped" } : file)),
      },
      {
        ...packet,
        files: files.map((file, i) => (i === 0 ? { ...file, sha256: "f".repeat(64) } : file)),
      },
    ].entries()) {
      const rejected = path.join(parent, `rejected-${index}`);
      await assert.rejects(unpackApplicationContext(invalid, rejected, expected));
      await assert.rejects(access(rejected));
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("native metadata identity binds every record byte independently of the context JSON", () => {
  const versions = {
    targets: "1",
    releases: "9007199254740994",
    preview: "2",
    stable: "2",
    snapshot: "2",
    timestamp: "2",
  };
  const context = `{"schema_version":1,"generated_at":"2026-11-05T00:00:00Z","versions":{${Object.entries(
    versions,
  )
    .map(([role, value]) => `${JSON.stringify(role)}:${value}`)
    .join(",")}}}`;
  const files = new Map([
    ["context.json", Buffer.from(context)],
    ["trusted-root.json", Buffer.from("declared root")],
    ["offline-targets.json", Buffer.from("declared Targets")],
    ["prior/metadata/timestamp.json", Buffer.from("declared prior")],
    ["records/releases/one.json", Buffer.from("first record")],
  ]);
  const before = applicationMetadataContextIdentity(files);
  assert.equal(before.versions.releases, "9007199254740994");
  files.set("records/releases/one.json", Buffer.from("changed record"));
  const changed = applicationMetadataContextIdentity(files);
  assert.equal(changed.context_sha256, before.context_sha256);
  assert.notEqual(changed.context_inventory_sha256, before.context_inventory_sha256);
  assert.notEqual(changed.records_sha256, before.records_sha256);
});
