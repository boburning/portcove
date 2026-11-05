import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { applicationReleaseTrust as trust } from "./application-release-policy.mts";
import { sha256 } from "./application-release-io.mts";
import type { ReleaseSourceAttestationExpectation } from "./release-source-attestation.mts";
import {
  bootstrapAssetNames,
  applicationDraftProofBytes,
  applicationDraftProofName,
  inspectBootstrapPublicationReceipt,
  inspectHistoricalApplicationPublication,
  readExpiredApplicationDraftAssets,
  readStagedDraftRecoveryBackup,
  verifyApplicationDraftRecoveryBackup,
  removeExpiredApplicationDraftAssets,
  prepareApplicationReleaseDraft,
  publishPreparedApplicationRelease,
  readImmutableApplicationRelease,
  inspectApplicationReleaseAttestation,
  assertApplicationPublicationRecord,
  inspectApplicationWindowsCandidate,
  selectApplicationWindowsPredecessor,
  readApplicationWindowsCandidateAssets,
  readApplicationWindowsPredecessorAssets,
  inspectApplicationPublicationFiles,
  inspectBootstrapSiteArchive,
  publishBootstrapRelease,
  publishApplicationMetadataRelease,
  inspectApplicationMetadataPublicationReceipt,
} from "./application-release-publication.mts";
import type { BootstrapPublicationTransport } from "./application-release-publication.mts";
import type { ApplicationRunCustody } from "./application-release-run.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import {
  inspectApplicationRunCustody,
  readApplicationRunNotes,
} from "./application-release-run.mts";
import { GitHubApiError } from "./github-api.mts";
import { applicationPackageNames } from "./application-release-artifacts.mts";
import {
  readImmutableBootstrapFeed,
  readImmutableApplicationMetadataFeed,
  readImmutableApplicationMetadata,
  readRegisteredImmutableApplicationMetadata,
  discoverPublishedApplicationCohort,
  assertApplicationForwardPreimage,
  readApplicationPendingLineage,
} from "./application-release-feed.mts";

// Inert release bytes and an injected provider: protocol tests, never native,
// detached-signature, assembly-attestation or production qualification.

function fixtureContextExtension(
  custody: ApplicationRunCustody,
  facts: ReturnType<typeof inspectTufPublicationFacts>,
  prior: string,
) {
  const producer = custody.runs[0]!;
  return inspectApplicationRunCustody({
    ...custody,
    schema_version: 3,
    metadata_contexts: [
      {
        opportunity: custody.opportunity,
        run_id: producer.id,
        run_attempt: 1,
        control_commit: producer.control_commit,
        control_ref: producer.control_ref,
        generated_at: "2026-11-05T00:00:00Z",
        root_sha256: facts.root_sha256,
        offline_targets_sha256: facts.offline_targets_sha256,
        prior_repository_sha256: prior,
        versions: facts.versions,
        context_sha256: "e".repeat(64),
        context_inventory_sha256: "f".repeat(64),
        records_sha256: facts.records_sha256,
      },
    ],
  });
}

function ordinaryFixture(mode = "valid") {
  const base = fixture();
  const version = "0.1.0-alpha.3",
    tree = "d".repeat(40),
    intent = "7".repeat(64);
  const actor = { name: "Fixture", email: "fixture@example.test", date: "2026-11-04T12:00:00Z" };
  const seconds = Math.floor(Date.parse(actor.date) / 1000);
  const message = `Mechanical fixture\n\nPortcove-Preparation-SHA256: ${intent}`;
  const rawCommit = `tree ${tree}\nparent ${base.custody.source}\nauthor Fixture <fixture@example.test> ${seconds} +0000\ncommitter Fixture <fixture@example.test> ${seconds} +0000\n\n${message}`;
  const prepared = createHash("sha1")
    .update(`commit ${Buffer.byteLength(rawCommit)}\0${rawCommit}`)
    .digest("hex");
  const custody: ApplicationRunCustody = {
    ...base.custody,
    opportunity: base.custody.source,
    preparation: {
      source_commit: base.custody.source,
      source_tree: base.custody.source_tree,
      prepared_commit: prepared,
      prepared_tree: tree,
      version,
      intent_sha256: intent,
      classification: {
        source_commit: base.custody.source,
        reviewed_commit: base.custody.source,
        base_version: "0.1.0-alpha.2",
        change: "prerelease",
        compatibility: "compatible",
      },
      published_versions: ["0.1.0-alpha.2"],
    },
  };
  const producer = {
    control_commit: base.binding.control_commit,
    control_ref: base.binding.control_ref,
    run_id: "123",
    attempt: 1,
  };
  const expected = { release_id: 60, custody, producer };
  const body = {
    schema_version: 2 as const,
    previous_generation: base.site.generation,
    application_root_sha256: trust.root.sha256,
    catalog_root_sha256: null,
    files: base.site.files,
  };
  const site = { ...body, generation: digest(body) };
  const archive = createAuditZip([
    ...base.contents,
    ["publication.json", Buffer.from(JSON.stringify(site))],
  ]);
  const metadata = {
    ...Object.fromEntries(
      Object.entries(base.raw).filter(([key]) => key !== "bootstrap_descriptor"),
    ),
    kind: "application-metadata-publication",
    purpose: "application-release",
    opportunity: custody.opportunity,
    prior_generation: base.site.generation,
    prior_repository_sha256: base.raw.publication.repository_sha256,
    context_sha256: "e".repeat(64),
    site_generation: site,
    site_archive: {
      filename: "application-site.zip",
      bytes: archive.length,
      sha256: sha256(archive),
    },
  };
  const files = new Map<string, Buffer>(
    applicationPackageNames(version).map((name) => [name, Buffer.from(`inert ${name}`)]),
  );
  const manifest = {
    schema_version: 1,
    repository: "boburning/portcove",
    profile: "initial-beta-windows-x86_64-v1",
    version,
    source_commit: prepared,
    source_tree: tree,
    control_commit: producer.control_commit,
    control_ref: producer.control_ref,
    run_id: producer.run_id,
    package_attempt: 1,
    files: [...files].map(([filename, bytes]) => ({
      filename,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  files.set("application-release.json", Buffer.from(JSON.stringify(manifest)));
  files.set(`Portcove_${version}_x64-setup.exe.sig`, Buffer.from("inert signature"));
  files.set("updater-inventory.json", Buffer.from("inert inventory"));
  files.set("application-site.zip", archive);
  files.set("application-metadata.json", Buffer.from(JSON.stringify(metadata)));
  const release = {
    id: 60,
    tag_name: `portcove-production-candidate-${custody.opportunity}`,
    target_commitish: custody.source,
    prerelease: true,
    draft: true,
    immutable: false,
    body: `<!-- portcove-application-runs-v1\n${JSON.stringify(custody)}\n-->`,
  };
  if (mode === "native-context-extension") {
    const extended = fixtureContextExtension(
      custody,
      inspectTufPublicationFacts(base.raw.publication),
      String(base.raw.publication.repository_sha256),
    );
    release.body = `<!-- portcove-application-runs-v1\n${JSON.stringify(extended)}\n-->`;
  }
  const assets: { id: number; name: string; size: number; digest: string; state: string }[] = [];
  const bytes = new Map<number, Buffer>(),
    writes: string[] = [],
    events: string[] = [];
  let hasTag = mode === "wrong-tag" || mode.startsWith("existing-tag"),
    window = true,
    guarded = false;
  const api = {
    request(method: string, endpoint: string, input?: unknown) {
      events.push(`${method}:${endpoint}`);
      const reply = (body: unknown, status = 200) => ({
        status,
        headers: new Map<string, string>(),
        body: structuredClone(body),
      });
      if (endpoint.endsWith(`/git/ref/tags/v${version}`))
        return hasTag
          ? reply({
              ref: `refs/tags/v${version}`,
              object: { type: "commit", sha: mode === "wrong-tag" ? "f".repeat(40) : prepared },
            })
          : reply({}, 404);
      if (endpoint.endsWith(`/git/commits/${prepared}`))
        return reply({
          sha: prepared,
          tree: { sha: mode === "existing-tag-wrong-tree" ? "f".repeat(40) : tree },
          parents: [
            { sha: mode === "existing-tag-wrong-parent" ? "f".repeat(40) : custody.source },
          ],
          author: actor,
          committer: actor,
          message,
          verification: { verified: false, reason: "unsigned", signature: null, payload: null },
        });
      if (endpoint.endsWith("/git/refs")) {
        assert.equal(method, "POST");
        assert.deepEqual(input, { ref: `refs/tags/v${version}`, sha: prepared });
        writes.push("tag");
        hasTag = true;
        if (mode === "tag-lost") throw new Error("lost tag acknowledgement");
        return reply({}, 201);
      }
      if (endpoint.includes("/assets?")) {
        assert.equal(method, "GET");
        if (guarded && mode === "expired") window = false;
        return reply(assets);
      }
      assert.equal(endpoint, "repos/boburning/portcove/releases/60");
      if (method === "PATCH") {
        writes.push("publish");
        assert.deepEqual(input, {
          tag_name: `v${version}`,
          draft: false,
          prerelease: true,
          make_latest: "false",
          name: `Portcove ${version}`,
        });
        if (mode !== "publish-refused")
          Object.assign(release, { tag_name: `v${version}`, draft: false, immutable: true });
        if (mode === "publish-lost") throw new Error("lost publish acknowledgement");
      } else assert.equal(method, "GET");
      return reply(release);
    },
  };
  const prepareTransport = {
    api,
    async upload(id: number, name: string, value: Buffer) {
      assert.equal(id, 60);
      assert.ok(!assets.some((asset) => asset.name === name));
      writes.push(`upload:${name}`);
      if (mode !== "upload-unknown") {
        const id = assets.length + 1;
        assets.push({
          id,
          name,
          size: value.length,
          digest: `sha256:${sha256(value)}`,
          state: "uploaded",
        });
        bytes.set(id, Buffer.from(value));
      }
      if (mode === "upload-lost" || mode === "upload-unknown")
        throw new Error("lost upload acknowledgement");
    },
    async readAsset(id: number, maximum: number) {
      events.push("physical");
      const value = bytes.get(id);
      assert.ok(value && value.length === maximum);
      return mode === "wrong-bytes" ? Buffer.alloc(value.length) : value;
    },
    async beforeDraftWrite() {
      events.push("draft-guard");
      if (mode === "paused") throw new Error("paused");
    },
  };
  const finalTransport = {
    api,
    async authenticatePreparation(value: Buffer) {
      events.push("attestation");
      assert.ok(JSON.parse(value.toString("utf8")));
      if (mode === "attestation") throw new Error("injected provenance refusal");
    },
    async beforeWrite() {
      events.push("publication-guard");
      guarded = true;
      return () => {
        events.push("fresh");
        assert.ok(window, "original observer expired");
      };
    },
  };
  return {
    expected,
    files,
    manifest,
    assets,
    bytes,
    writes,
    events,
    release,
    prepareTransport,
    finalTransport,
    prepare: () => prepareApplicationReleaseDraft(expected, files, prepareTransport),
    publish: (raw: unknown) =>
      publishPreparedApplicationRelease(expected, Buffer.from(JSON.stringify(raw)), finalTransport),
  };
}

function upstreamReleaseAttestation(
  expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
) {
  const purl = `pkg:github/boburning/portcove@${expected.tag}`;
  return {
    verificationResult: {
      signature: {},
      verifiedTimestamps: [{}],
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://in-toto.io/attestation/release/v0.1",
        subject: [
          { uri: purl, digest: { sha1: expected.prepared_commit } },
          ...expected.assets.map((asset) => ({
            name: asset.name,
            digest: { sha256: asset.sha256 },
          })),
        ],
        predicate: {
          ownerId: "43177418",
          purl,
          releaseId: String(expected.release_id),
          repository: "boburning/portcove",
          repositoryId: "1354613114",
          tag: expected.tag,
        },
      },
    },
  };
}

void test("Windows Preview selects the exact earlier eligible production record and respects bridge rules", () => {
  const records = new Map<string, Buffer>();
  const add = (version: string, withdrawn = false, bridge: object | null = null) => {
    const path = `releases/${version}/windows-x86_64/nsis.json`;
    const release = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        version,
        target: "windows-x86_64",
        os: "windows",
        architecture: "x86_64",
        source_commit: "1".repeat(40),
        source_tree: "2".repeat(40),
        package: { kind: "nsis", owner: "portcove", product_id: "io.github.portcove.portcove" },
        artifact: {
          url: `https://github.com/boburning/portcove/releases/download/v${version}/Portcove_${version}_x64-setup.exe`,
          bytes: 42,
          sha256: "3".repeat(64),
        },
      }),
    );
    const sha = sha256(release);
    records.set(`records/${path}`, release);
    records.set(
      `records/channels/preview/windows-x86_64/nsis/${version}.json`,
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          channel: "preview",
          target: "windows-x86_64",
          package: "nsis",
          version,
          eligible: !withdrawn,
          withdrawn,
          required_bridge: bridge,
          release_path: path,
          release_sha256: sha,
        }),
      ),
    );
    return { path, sha };
  };
  const current = add("0.1.0-beta.3");
  assert.equal(selectApplicationWindowsPredecessor(records, "0.1.0-beta.3", current.sha), null);
  const previous = add("0.1.0-beta.1");
  add("0.1.0-beta.2", true);
  add("0.1.0-beta.3", false, { path: previous.path, sha256: previous.sha });
  const selected = selectApplicationWindowsPredecessor(records, "0.1.0-beta.3", current.sha);
  assert.equal(selected?.version, "0.1.0-beta.1");
  assert.equal(selected.record_sha256, previous.sha);
  assert.throws(
    () => selectApplicationWindowsPredecessor(records, "0.1.0-beta.1", previous.sha),
    /not current/,
  );
  add("0.1.0-beta.2");
  assert.equal(
    selectApplicationWindowsPredecessor(records, "0.1.0-beta.3", current.sha)?.version,
    "0.1.0-beta.1",
  );
  add("0.1.0-beta.3", false, { path: previous.path, sha256: "0".repeat(64) });
  assert.throws(() => selectApplicationWindowsPredecessor(records, "0.1.0-beta.3", current.sha));
});

void test("Windows candidate acquisition authenticates the complete release but downloads only its two exact assets", async () => {
  const f = ordinaryFixture();
  const prep = f.expected.custody.preparation;
  assert.ok(prep);
  const qualification = {
    workflow: ".github/workflows/qualification.yml" as const,
    workflow_commit: f.expected.custody.source,
    run_id: 123,
    attempt: 1,
  };
  prep.qualification = qualification;
  f.release.body = `<!-- portcove-application-runs-v1
${JSON.stringify(f.expected.custody)}
-->`;
  const prepared = await f.prepare();
  await f.publish(prepared);
  const generation = prepared.site_generation;
  const selected = [`Portcove_${prep.version}_x64-setup.exe`, "portcove-desktop.exe"].map((name) =>
    prepared.assets.find((asset) => asset.name === name)!,
  );
  const candidate = {
    schema_version: 1,
    kind: "application-windows-candidate",
    authority: "none",
    generation,
    release_id: f.expected.release_id,
    predecessor: null,
    record_sha256: "4".repeat(64),
    assets: selected,
  };
  const downloaded: number[] = [];
  const transport = {
    api: f.prepareTransport.api,
    async authenticateRelease(
      expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
    ) {
      assert.deepEqual(expected.assets, prepared.assets);
      assert.equal(expected.prepared_commit, prep.prepared_commit);
      assert.equal(downloaded.length, 0);
    },
    async readAsset(id: number, maximum: number) {
      downloaded.push(id);
      return f.prepareTransport.readAsset(id, maximum);
    },
  };
  const verified = await readApplicationWindowsCandidateAssets(
    candidate,
    f.expected,
    generation,
    transport,
  );
  assert.deepEqual(
    downloaded,
    selected.map((asset) => asset.id),
  );
  assert.deepEqual(
    [...verified.files.keys()],
    selected.map((asset) => asset.name),
  );
  downloaded.length = 0;
  const predecessor = {
    version: prep.version,
    source_commit: prep.prepared_commit,
    source_tree: prep.prepared_tree,
    installer_bytes: selected[0]!.bytes,
    installer_sha256: selected[0]!.sha256,
    record_sha256: "4".repeat(64),
    promotion_sha256: "5".repeat(64),
  };
  const predecessorTransport = {
    ...transport,
    api: {
      request(...args: Parameters<typeof transport.api.request>) {
        if (args[1] === `repos/boburning/portcove/releases/tags/v${prep.version}`)
          return { status: 200, headers: new Map(), body: f.release };
        return transport.api.request(...args);
      },
    },
  };
  const previousFiles = await readApplicationWindowsPredecessorAssets(
    predecessor,
    predecessorTransport,
  );
  assert.deepEqual(
    [...previousFiles.keys()],
    selected.map((asset) => asset.name),
  );
  downloaded.length = 0;
  await assert.rejects(
    readApplicationWindowsPredecessorAssets(
      {
        ...predecessor,
        installer_sha256: "9".repeat(64),
      },
      predecessorTransport,
    ),
  );
  downloaded.length = 0;
  await assert.rejects(
    readApplicationWindowsCandidateAssets(
      {
        ...candidate,
        assets: selected.map((asset, index) => (index === 0 ? { ...asset, id: 999 } : asset)),
      },
      f.expected,
      generation,
      transport,
    ),
    /identity changed/,
  );
  await assert.rejects(
    readApplicationWindowsCandidateAssets(candidate, f.expected, generation, {
      ...transport,
      async readAsset(_id, maximum) {
        return Buffer.alloc(maximum);
      },
    }),
    /bytes differ/,
  );
  f.release.immutable = false;
  f.release.draft = true;
  await assert.rejects(
    readApplicationWindowsCandidateAssets(candidate, f.expected, generation, transport),
  );
  assert.deepEqual(downloaded, []);
});

void test("authenticated release record binds source, inventory, both public packages and the detached signature", () => {
  const f = ordinaryFixture();
  const preparation = f.expected.custody.preparation;
  assert.ok(preparation);
  const version = preparation.version,
    key = "c".repeat(64);
  const name = `Portcove_${version}_x64-setup.exe`;
  const signature = f.files.get(`${name}.sig`)!;
  const inventory = Buffer.from(
    JSON.stringify({
      version,
      source_commit: preparation.prepared_commit,
      packages: [name, `portcove-cli-${version}-windows-x86_64.zip`].map((filename) => {
        const bytes = f.files.get(filename)!;
        return { filename, bytes: bytes.length, sha256: sha256(bytes) };
      }),
    }),
  );
  f.files.set("updater-inventory.json", inventory);
  const installer = f.files.get(name)!;
  const qualification = {
    workflow: ".github/workflows/qualification.yml",
    workflow_commit: f.expected.custody.source,
    run_id: 456,
    attempt: 2,
  };
  const record = {
    schema_version: 1,
    version,
    source_commit: preparation.prepared_commit,
    source_tree: preparation.prepared_tree,
    target: "windows-x86_64",
    os: "windows",
    architecture: "x86_64",
    package: { kind: "nsis", owner: "portcove", product_id: "io.github.portcove.portcove" },
    qualified_run: {
      ...qualification,
      inventory_sha256: sha256(inventory),
    },
    artifact: {
      url: `https://github.com/boburning/portcove/releases/download/v${version}/${name}`,
      sha256: sha256(installer),
      bytes: installer.length,
      tauri_signature: signature.toString("utf8"),
      payload_key_id: key,
    },
  };
  assert.doesNotThrow(() =>
    assertApplicationPublicationRecord(record, f.expected, f.files, key, qualification),
  );
  for (const mode of [
    "source",
    "tree",
    "inventory",
    "qualified-source",
    "qualified-workflow",
    "qualified-run",
    "qualified-attempt",
    "url",
    "payload",
    "signature",
    "key",
    "cli",
  ]) {
    const changed = structuredClone(record),
      files = new Map(f.files);
    if (mode === "source") changed.source_commit = "f".repeat(40);
    if (mode === "tree") changed.source_tree = "f".repeat(40);
    if (mode === "inventory") changed.qualified_run.inventory_sha256 = "f".repeat(64);
    if (mode === "qualified-source") changed.qualified_run.workflow_commit = "f".repeat(40);
    if (mode === "qualified-workflow")
      changed.qualified_run.workflow = ".github/workflows/release.yml";
    if (mode === "qualified-run") changed.qualified_run.run_id++;
    if (mode === "qualified-attempt") changed.qualified_run.attempt++;
    if (mode === "url") changed.artifact.url = "https://example.test/wrong.exe";
    if (mode === "payload") changed.artifact.sha256 = "f".repeat(64);
    if (mode === "signature") changed.artifact.tauri_signature = "wrong";
    if (mode === "key") changed.artifact.payload_key_id = "f".repeat(64);
    if (mode === "cli")
      files.set(`portcove-cli-${version}-windows-x86_64.zip`, Buffer.from("substituted CLI"));
    assert.throws(
      () => assertApplicationPublicationRecord(changed, f.expected, files, key, qualification),
      mode,
    );
  }
  const expected = {
    ...f.expected,
    custody: { ...f.expected.custody, preparation: { ...preparation, qualification } },
  };
  const generation = "1".repeat(64);
  const candidate = {
    schema_version: 1,
    kind: "application-windows-candidate",
    authority: "none",
    generation,
    release_id: expected.release_id,
    predecessor: null,
    record_sha256: sha256(Buffer.from(JSON.stringify(record))),
    assets: [name, "portcove-desktop.exe"].map((name, index) => {
      const bytes = f.files.get(name)!;
      return { id: index + 1, name, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  };
  assert.deepEqual(inspectApplicationWindowsCandidate(candidate, expected, generation), candidate);
  assert.throws(() => inspectApplicationWindowsCandidate(candidate, expected, "2".repeat(64)));
  assert.throws(() =>
    inspectApplicationWindowsCandidate(
      {
        ...candidate,
        assets: [...candidate.assets].reverse(),
      },
      expected,
      generation,
    ),
  );
});

void test("ordinary immutable feed authenticates upstream release inclusion before all ten physical bytes without temporary preparation", async () => {
  const f = ordinaryFixture();
  const prepared = await f.prepare();
  await f.publish(prepared);
  f.events.length = 0;
  const writes = [...f.writes];
  const result = await readImmutableApplicationRelease(f.expected, {
    api: f.prepareTransport.api,
    async authenticateRelease(identity) {
      assert.equal(f.events.includes("physical"), false);
      inspectApplicationReleaseAttestation(upstreamReleaseAttestation(identity), identity);
      f.events.push("release-authenticated");
    },
    readAsset: f.prepareTransport.readAsset,
    async authenticateContents(files, inspected) {
      assert.equal(files.size, 10);
      assert.equal(f.events.filter((event) => event === "physical").length, 10);
      assert.equal(inspected.receipt.site.generation, prepared.site_generation);
      f.events.push("contents-authenticated");
    },
  });
  assert.ok(f.events.indexOf("release-authenticated") < f.events.indexOf("physical"));
  assert.equal(result.site.generation, prepared.site_generation);
  assert.equal(result.receipt.assets.length, 10);
  assert.equal(result.receipt.authority, "none");
  assert.deepEqual(f.writes, writes);
});

void test("upstream release attestation interpretation refuses foreign identities, wrong commit or incomplete/duplicate assets", () => {
  const identity = {
    release_id: 60,
    tag: "v0.1.0-alpha.3",
    prepared_commit: "a".repeat(40),
    assets: [{ id: 1, name: "artifact.zip", bytes: 1, sha256: "b".repeat(64) }],
  };
  for (const mode of [
    "tag",
    "repository",
    "release",
    "owner",
    "commit",
    "missing",
    "extra",
    "digest",
    "type",
    "timestamp",
  ]) {
    const raw = upstreamReleaseAttestation(identity);
    const statement = raw.verificationResult.statement;
    if (mode === "tag") statement.predicate.tag = "v1.2.3";
    if (mode === "repository") statement.predicate.repositoryId = "999";
    if (mode === "release") statement.predicate.releaseId = "61";
    if (mode === "owner") statement.predicate.ownerId = "999";
    if (mode === "commit")
      statement.subject[0] = { uri: statement.predicate.purl, digest: { sha1: "f".repeat(40) } };
    if (mode === "missing") statement.subject.pop();
    if (mode === "extra") statement.subject.push(statement.subject[1]!);
    if (mode === "digest")
      statement.subject[1] = { name: "artifact.zip", digest: { sha256: "f".repeat(64) } };
    if (mode === "type") statement.predicateType = "https://slsa.dev/provenance/v1";
    if (mode === "timestamp") raw.verificationResult.verifiedTimestamps = [];
    assert.throws(() => inspectApplicationReleaseAttestation(raw, identity), mode);
  }
});

void test("ordinary feed refuses untrusted release proofs, drafts, substituted objects, corrupt bytes and late changes", async () => {
  for (const mode of ["release-proof", "draft", "asset-id", "bytes", "contents", "late-change"]) {
    const f = ordinaryFixture();
    const prepared = await f.prepare();
    if (mode !== "draft") await f.publish(prepared);
    f.events.length = 0;
    if (mode === "asset-id") f.assets[0]!.id += 100;
    if (mode === "bytes") {
      const id = f.assets[0]!.id;
      f.bytes.set(id, Buffer.alloc(f.bytes.get(id)!.length));
    }
    let authenticated = false;
    const writes = [...f.writes];
    await assert.rejects(
      readImmutableApplicationRelease(f.expected, {
        api: f.prepareTransport.api,
        async authenticateRelease(identity) {
          if (mode === "release-proof") throw new Error("untrusted release inclusion");
          inspectApplicationReleaseAttestation(upstreamReleaseAttestation(identity), identity);
        },
        readAsset: f.prepareTransport.readAsset,
        async authenticateContents() {
          authenticated = true;
          if (mode === "contents") throw new Error("content authentication refused");
          if (mode === "late-change") f.assets[0]!.id += 100;
        },
      }),
      mode,
    );
    if (mode === "release-proof") assert.equal(f.events.includes("physical"), false);
    if (["release-proof", "draft", "asset-id", "bytes"].includes(mode))
      assert.equal(authenticated, false, mode);
    assert.deepEqual(f.writes, writes, mode);
  }
});

void test("draft preparation stops before the first upload if assembly notes cannot be retained", async () => {
  const f = ordinaryFixture();
  await assert.rejects(
    prepareApplicationReleaseDraft(f.expected, f.files, {
      ...f.prepareTransport,
      async retainAssembly(assembly) {
        assert.equal(assembly.release_id, f.expected.release_id);
        assert.deepEqual(
          assembly.subjects,
          bootstrapAssetNames.map((name) => ({
            name,
            bytes: f.files.get(name)!.length,
            sha256: sha256(f.files.get(name)!),
          })),
        );
        assert.deepEqual(f.writes, []);
        throw new Error("assembly notes refused");
      },
    }),
    /assembly notes refused/,
  );
  assert.deepEqual(f.writes, []);
});

void test("ordinary draft preparation verifies all ten remote byte objects and the prepared Git tag before separate publication", async () => {
  const f = ordinaryFixture();
  const prepared = await f.prepare();
  assert.equal(prepared.authority, "none");
  assert.equal(prepared.assets.length, 10);
  assert.equal(f.release.draft, true);
  assert.equal(f.writes.includes("publish"), false);
  assert.equal(f.events.filter((event) => event === "physical").length, 10);
  const physical = f.events.lastIndexOf("physical");
  assert.ok(
    physical <
      f.events.findIndex((event) => event.startsWith("POST:") && event.endsWith("/git/refs")),
  );
  const result = await f.publish(prepared);
  assert.equal(result.authority, "none");
  assert.equal(f.release.immutable, true);
  assert.ok(f.events.indexOf("attestation") < f.events.indexOf("publication-guard"));
  assert.equal(f.writes.filter((write) => write === "publish").length, 1);
  const before = [...f.writes];
  await f.publish(prepared);
  assert.deepEqual(f.writes, before);
});

void test("an existing version tag still requires actual prepared commit tree and sole-parent verification", async () => {
  const valid = ordinaryFixture("existing-tag");
  await valid.prepare();
  assert.ok(valid.events.some((event) => event.includes("/git/commits/")));
  assert.equal(valid.writes.includes("tag"), false);
  for (const mode of ["existing-tag-wrong-tree", "existing-tag-wrong-parent"]) {
    const invalid = ordinaryFixture(mode);
    await assert.rejects(invalid.prepare());
    assert.equal(invalid.writes.length, 0);
  }
});

void test("ordinary publication preserves successful lost acknowledgements and refuses unobserved effects without retries", async () => {
  for (const mode of ["upload-lost", "tag-lost", "publish-lost"]) {
    const f = ordinaryFixture(mode),
      prepared = await f.prepare();
    await f.publish(prepared);
    assert.equal(f.writes.filter((write) => write === "publish").length, 1);
    assert.equal(f.writes.filter((write) => write === "tag").length, 1);
    assert.equal(new Set(f.writes.filter((write) => write.startsWith("upload:"))).size, 10);
  }
  const unknown = ordinaryFixture("upload-unknown");
  await assert.rejects(unknown.prepare());
  assert.equal(unknown.writes.length, 1);
  const refused = ordinaryFixture("publish-refused");
  const prepared = await refused.prepare();
  await assert.rejects(refused.publish(prepared));
  assert.equal(refused.writes.filter((write) => write === "publish").length, 1);
});

void test("ordinary asset substitution, wrong source/tag, missing matrix, failed provenance and expired final observer never publish", async () => {
  for (const mode of ["paused", "wrong-tag", "wrong-bytes"]) {
    const f = ordinaryFixture(mode);
    await assert.rejects(f.prepare());
    assert.equal(f.writes.includes("publish"), false);
  }
  for (const mode of [
    "attestation",
    "expired",
    "changed-id",
    "changed-digest",
    "changed-source",
    "missing",
    "extra",
  ]) {
    const f = ordinaryFixture(mode),
      prepared = await f.prepare();
    if (mode === "changed-id") f.assets[0]!.id += 100;
    if (mode === "changed-digest") f.assets[0]!.digest = `sha256:${"f".repeat(64)}`;
    if (mode === "changed-source") f.release.target_commitish = "f".repeat(40);
    if (mode === "missing") f.assets.pop();
    if (mode === "extra")
      f.assets.push({
        id: 99,
        name: "unexpected.exe",
        size: 1,
        digest: `sha256:${"f".repeat(64)}`,
        state: "uploaded",
      });
    await assert.rejects(f.publish(prepared));
    assert.equal(f.writes.includes("publish"), false);
  }
  const matrix = ordinaryFixture();
  matrix.files.set("portcove-desktop.exe", Buffer.from("substituted installer interior"));
  assert.throws(() => inspectApplicationPublicationFiles(matrix.expected, matrix.files));
  const source = ordinaryFixture();
  source.manifest.source_commit = "f".repeat(40);
  source.files.set("application-release.json", Buffer.from(JSON.stringify(source.manifest)));
  assert.throws(() => inspectApplicationPublicationFiles(source.expected, source.files));
});

function fixture(
  mode = "valid",
  ageDays = 0,
  publicationName = "Portcove application metadata bootstrap",
) {
  const now = Math.floor(Date.now() / 1000) * 1000 - ageDays * 86400000;
  const instant = (days: number) =>
    new Date(now + days * 86400000).toISOString().replace(".000Z", "Z");
  const root = readFileSync(new URL(`../${trust.root.path}`, import.meta.url));
  const targets = readFileSync(new URL(`../${trust.targets.path}`, import.meta.url));
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-initial-bootstrap",
    generated_at: instant(0),
    setup_plan_sha256: "1".repeat(64),
    initial_site_preimage_sha256: "2".repeat(64),
    root_sha256: trust.root.sha256,
    offline_targets_sha256: trust.targets.sha256,
    payload_key_registry_sha256: trust.payload.sha256,
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
      targets: instant(30),
      releases: instant(30),
      preview: instant(6),
      stable: instant(6),
      snapshot: instant(6),
      timestamp: instant(1),
    },
  };
  const contents = new Map<string, Buffer>([
    [".nojekyll", Buffer.alloc(0)],
    ["rehearsal/41788540335-1/application/metadata/retained.json", Buffer.from("retained")],
    ["application/metadata/1.root.json", root],
    ["application/metadata/1.targets.json", targets],
    ["application/metadata/1.snapshot.json", Buffer.from("inert snapshot")],
    ["application/metadata/timestamp.json", Buffer.from("inert timestamp")],
  ]);
  const identities = [...contents]
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const siteBody = {
    schema_version: 2 as const,
    previous_generation: null,
    application_root_sha256: trust.root.sha256,
    catalog_root_sha256: null,
    files: identities,
  };
  const site = { ...siteBody, generation: digest(siteBody) };
  const archive = createAuditZip([
    ...contents,
    ["publication.json", Buffer.from(JSON.stringify(site))],
  ]);
  const publication = {
    schema_version: 1,
    root_sha256: trust.root.sha256,
    offline_targets_sha256: trust.targets.sha256,
    records_sha256: digest([]),
    repository_sha256: digest(
      identities
        .filter((file) => file.path.startsWith("application/"))
        .map((file) => ({ ...file, path: file.path.slice(12) })),
    ),
    timestamp_sha256: sha256(contents.get("application/metadata/timestamp.json")!),
    snapshot_sha256: sha256(contents.get("application/metadata/1.snapshot.json")!),
    versions: descriptor.versions,
    expires: descriptor.expires,
  };
  const binding = {
    control_commit: "c".repeat(40),
    control_ref: "refs/tags/portcove-production-controller-windows-fixture",
    opportunity: digest(descriptor),
    run_id: "123",
    producer_attempt: 1,
    appointment: {
      descriptor_sha256: digest(descriptor),
      setup_plan_sha256: descriptor.setup_plan_sha256,
      site_preimage_sha256: descriptor.initial_site_preimage_sha256,
    },
    retained_inventory_sha256: digest(
      identities.filter((file) => !file.path.startsWith("application/")),
    ),
  };
  const raw = {
    schema_version: 1,
    kind: "application-bootstrap-publication",
    authority: "none",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "appointment")),
    bootstrap_descriptor: descriptor,
    publication,
    site_generation: site,
    site_archive: {
      filename: "application-site.zip",
      bytes: archive.length,
      sha256: sha256(archive),
    },
  };
  const metadata = Buffer.from(JSON.stringify(raw));
  const custody: ApplicationRunCustody = {
    schema_version: 1,
    kind: "application-release-run-custody",
    source: "a".repeat(40),
    source_tree: "b".repeat(40),
    opportunity: binding.opportunity,
    preparation: null,
    runs: [
      {
        id: binding.run_id,
        control_commit: binding.control_commit,
        control_ref: binding.control_ref,
      },
    ],
  };
  const release: Record<string, unknown> = {
    id: 10,
    tag_name: `portcove-production-candidate-${binding.opportunity}`,
    target_commitish: custody.source,
    draft: true,
    immutable: false,
    prerelease: true,
    body: `Human notes\n<!-- portcove-application-runs-v1\n${JSON.stringify(custody)}\n-->\nRetain me`,
  };
  const remoteAssets: { id: number; name: string; state: string; size: number; digest: string }[] =
    [];
  const remoteBytes = new Map<number, Buffer>();
  const mutations: string[] = [];
  let guards = 0,
    reads = 0;
  let writeWindowOpen = true,
    tagReads = 0;
  const transport: BootstrapPublicationTransport = {
    api: {
      request(method, endpoint, body) {
        const reply = (value: unknown, status = 200) => ({
          status,
          body: structuredClone(value),
          headers: new Map<string, string>(),
        });
        if (endpoint.includes("/git/ref/tags/")) {
          tagReads++;
          if (mode === "pending-tag" && release.draft)
            throw new GitHubApiError("http_error", "missing pending ref", { status: 404 });
          if (mode === "tag-forbidden")
            throw new GitHubApiError("http_error", "forbidden", { status: 403 });
          if (mode === "tag-network") throw new Error("connection lost");
          return mode === "wrong-tag" || (mode === "tag-drift" && tagReads > 1)
            ? reply({
                ref: `refs/tags/${String(release.tag_name)}`,
                object: { type: "commit", sha: "f".repeat(40) },
              })
            : reply({
                ref: `refs/tags/${String(release.tag_name)}`,
                object: { type: "commit", sha: custody.source },
              });
        }
        if (endpoint.endsWith("/assets?per_page=100&page=1")) {
          assert.equal(method, "GET");
          if (
            (mode === "expired-upload" && guards > 0) ||
            (mode === "expired-publication" && guards === 3)
          )
            writeWindowOpen = false;
          return reply(remoteAssets);
        }
        assert.equal(endpoint, "repos/boburning/portcove/releases/10");
        if (method === "PATCH") {
          assert.ok(isRecord(body));
          mutations.push("publish");
          assert.deepEqual(body, {
            draft: false,
            prerelease: true,
            make_latest: "false",
            name: publicationName,
          });
          if (mode !== "publish-refused") Object.assign(release, body, { immutable: true });
          if (mode === "publish-lost") throw new Error("lost publication response");
        } else assert.equal(method, "GET");
        return reply(release);
      },
    },
    async beforeWrite() {
      guards++;
      if (mode === "guard-refused") throw new Error("paused");
      return () => assert.ok(writeWindowOpen, "original protection deadline expired");
    },
    async upload(id, name, bytes) {
      assert.equal(id, 10);
      mutations.push(`upload:${name}`);
      if (mode !== "upload-unobserved") {
        const asset = {
          id: remoteAssets.length + 1,
          name,
          state: "uploaded",
          size: bytes.length,
          digest: `sha256:${sha256(bytes)}`,
        };
        remoteAssets.push(asset);
        remoteBytes.set(asset.id, Buffer.from(bytes));
      }
      if (mode.startsWith("upload-")) throw new Error("lost upload response");
    },
    async readAsset(id, maximum) {
      reads++;
      const bytes = remoteBytes.get(id);
      assert.ok(bytes && bytes.length <= maximum);
      return mode === "wrong-bytes" ? Buffer.alloc(bytes.length) : bytes;
    },
  };
  const run = () =>
    publishBootstrapRelease(transport, { release_id: 10, custody, binding }, metadata, archive);
  return {
    custody,
    raw,
    binding,
    archive,
    contents,
    site,
    transport,
    run,
    release,
    remoteAssets,
    remoteBytes,
    mutations,
    counters: () => ({ guards, reads }),
  };
}

function advanceMetadataFixture(
  raw: unknown,
  original: ReadonlyMap<string, Buffer>,
  previous: string,
) {
  const prior = inspectTufPublicationFacts(raw);
  const versions = { ...prior.versions },
    expires = { ...prior.expires };
  for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
    versions[role] = String(BigInt(versions[role]) + 1n);
    expires[role] = new Date(Date.parse(expires[role]) + 1000).toISOString().replace(".000Z", "Z");
  }
  const contents = new Map(original);
  const snapshot = Buffer.from(`inert snapshot ${versions.snapshot}`),
    timestamp = Buffer.from(`inert timestamp ${versions.timestamp}`);
  contents.set(`application/metadata/${versions.snapshot}.snapshot.json`, snapshot);
  contents.set("application/metadata/timestamp.json", timestamp);
  const files = [...contents]
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const publication = {
    ...prior,
    versions,
    expires,
    snapshot_sha256: sha256(snapshot),
    timestamp_sha256: sha256(timestamp),
    repository_sha256: digest(
      files
        .filter((file) => file.path.startsWith("application/"))
        .map((file) => ({ ...file, path: file.path.slice(12) })),
    ),
  };
  const body = {
    schema_version: 2 as const,
    previous_generation: previous,
    application_root_sha256: trust.root.sha256,
    catalog_root_sha256: null,
    files,
  };
  const site = { ...body, generation: digest(body) };
  const archive = createAuditZip([
    ...contents,
    ["publication.json", Buffer.from(JSON.stringify(site))],
  ]);
  return { contents, publication, site, archive };
}

function renewalFixture(mode = "valid", ageDays = 0) {
  const f = fixture(mode, ageDays, "Portcove application metadata renewal");
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: trust.root.sha256,
    repository_sha256: f.raw.publication.repository_sha256,
    site_generation: f.site.generation,
  };
  const opportunity = digest(basis);
  const advanced = advanceMetadataFixture(f.raw.publication, f.contents, f.site.generation);
  const { site, archive } = advanced;
  const { bootstrap_descriptor: ignoredDescriptor, ...common } = f.raw;
  assert.ok(ignoredDescriptor);
  const raw = {
    ...common,
    publication: advanced.publication,
    kind: "application-metadata-publication",
    purpose: "metadata-renewal",
    opportunity,
    prior_generation: basis.site_generation,
    prior_repository_sha256: basis.repository_sha256,
    context_sha256: "e".repeat(64),
    site_generation: site,
    site_archive: {
      filename: "application-site.zip",
      bytes: archive.length,
      sha256: sha256(archive),
    },
  };
  f.custody.opportunity = opportunity;
  f.release.tag_name = `portcove-production-candidate-${opportunity}`;
  f.release.body = `Human notes\n<!-- portcove-application-runs-v1\n${JSON.stringify(f.custody)}\n-->\nRetain me`;
  const binding = {
    purpose: "metadata-renewal" as const,
    control_commit: f.binding.control_commit,
    control_ref: f.binding.control_ref,
    opportunity,
    run_id: f.binding.run_id,
    producer_attempt: f.binding.producer_attempt,
    prior_generation: basis.site_generation,
    prior_repository_sha256: basis.repository_sha256,
  };
  const expected = { release_id: 10, custody: f.custody, binding };
  const metadata = Buffer.from(JSON.stringify(raw));
  return {
    ...f,
    contents: advanced.contents,
    raw,
    site,
    archive,
    binding,
    expected,
    metadata,
    run: () => publishApplicationMetadataRelease(f.transport, expected, metadata, archive),
  };
}

function forwardFixture() {
  const parent = renewalFixture();
  const f = renewalFixture();
  const authority = parent.raw.publication.repository_sha256;
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: trust.root.sha256,
    repository_sha256: authority,
    site_generation: parent.binding.prior_generation,
  };
  const opportunity = digest(basis),
    reference = { release_id: 42, opportunity: parent.custody.opportunity };
  const advanced = advanceMetadataFixture(
    parent.raw.publication,
    parent.contents,
    basis.site_generation,
  );
  const custody = inspectApplicationRunCustody({
    ...f.custody,
    schema_version: 2,
    opportunity,
    runs: [{ ...f.custody.runs[0], id: "124" }],
    budget: { kind: "member", owner_release_id: 42, owner_opportunity: reference.opportunity },
  });
  const binding = {
    ...f.binding,
    opportunity,
    run_id: "124",
    authority_repository_sha256: authority,
    renewal_parent: reference,
    prior_repository_sha256: parent.binding.prior_repository_sha256,
  };
  const raw = {
    ...f.raw,
    schema_version: 2,
    opportunity,
    run_id: "124",
    publication: advanced.publication,
    site_generation: advanced.site,
    prior_repository_sha256: binding.prior_repository_sha256,
    authority_repository_sha256: authority,
    renewal_parent: reference,
    site_archive: {
      filename: "application-site.zip",
      bytes: advanced.archive.length,
      sha256: sha256(advanced.archive),
    },
  };
  const metadata = Buffer.from(JSON.stringify(raw));
  f.release.tag_name = `portcove-production-candidate-${opportunity}`;
  f.release.body = `<!-- portcove-application-runs-v1\n${JSON.stringify(custody)}\n-->`;
  const expected = { release_id: 10, custody, binding };
  return {
    ...f,
    ...advanced,
    parent,
    raw,
    metadata,
    custody,
    binding,
    expected,
    run: () => publishApplicationMetadataRelease(f.transport, expected, metadata, advanced.archive),
  };
}

void test("forward metadata separates the unserved authority from the public preimage and requires retained cost membership", async () => {
  const f = forwardFixture();
  const receipt = inspectApplicationMetadataPublicationReceipt(f.raw, f.binding, f.custody);
  assert.notEqual(f.binding.authority_repository_sha256, f.binding.prior_repository_sha256);
  assert.equal(receipt.publication.records_sha256, f.parent.raw.publication.records_sha256);
  await f.run();
  assert.equal(f.mutations.filter((value) => value === "publish").length, 1);
  for (const patch of [
    { schema_version: 1 },
    { authority_repository_sha256: f.binding.prior_repository_sha256 },
    { renewal_parent: { ...f.binding.renewal_parent, opportunity: f.binding.opportunity } },
    { renewal_parent: { ...f.binding.renewal_parent, release_id: 0 } },
  ])
    assert.throws(() =>
      inspectApplicationMetadataPublicationReceipt({ ...f.raw, ...patch }, f.binding, f.custody),
    );
  const { budget: omitted, ...rest } = f.custody;
  assert.ok(omitted);
  assert.throws(() =>
    inspectHistoricalApplicationPublication(
      f.raw,
      inspectApplicationRunCustody({ ...rest, schema_version: 1 }),
    ),
  );
  const { authority_repository_sha256: missing, ...incomplete } = f.raw;
  assert.ok(missing);
  assert.throws(() =>
    inspectApplicationMetadataPublicationReceipt(incomplete, f.binding, f.custody),
  );
});

void test("forward public-preimage join rejects another base or regressed floors without treating expired public bytes as authority", () => {
  const f = forwardFixture();
  const current = {
    ...f.parent.raw.publication,
    repository_sha256: f.binding.prior_repository_sha256,
    versions: {
      ...f.parent.raw.publication.versions,
      releases: "1",
      preview: "1",
      stable: "1",
      snapshot: "1",
      timestamp: "1",
    },
    expires: { ...f.parent.raw.publication.expires, timestamp: "2026-01-01T00:00:00Z" },
  };
  assert.doesNotThrow(() =>
    assertApplicationForwardPreimage(f.parent.raw, f.parent.raw.publication, current),
  );
  assert.throws(() =>
    assertApplicationForwardPreimage(f.parent.raw, f.parent.raw.publication, {
      ...current,
      repository_sha256: "e".repeat(64),
    }),
  );
  assert.throws(() =>
    assertApplicationForwardPreimage(f.parent.raw, f.parent.raw.publication, {
      ...current,
      versions: f.parent.raw.publication.versions,
    }),
  );
  assert.throws(() =>
    assertApplicationForwardPreimage(
      f.parent.raw,
      { ...f.parent.raw.publication, records_sha256: "e".repeat(64) },
      current,
    ),
  );
});

void test("verified pending lineage retains one cost owner and refuses changed authority, records and cycles", async (t) => {
  const f = forwardFixture();
  const parentCustody = inspectApplicationRunCustody({
    ...f.parent.custody,
    schema_version: 2,
    budget: { kind: "owner", scopes: [{ opportunity: f.custody.opportunity, run_ids: ["124"] }] },
  });
  const states = new Map<number, { raw: unknown; custody: ApplicationRunCustody }>([
    [10, { raw: f.raw, custody: f.custody }],
    [42, { raw: f.parent.raw, custody: parentCustody }],
  ]);
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      const id = Number(endpoint.split("/").at(-1)),
        state = states.get(id);
      assert.ok(state);
      return {
        status: 200,
        headers: new Map<string, string>(),
        body: {
          id,
          target_commitish: state.custody.source,
          body: `<!-- portcove-application-runs-v1\n${JSON.stringify(state.custody)}\n-->`,
        },
      };
    },
  };
  const root = await mkdtemp(path.join(tmpdir(), "forward-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let invocation = 0;
  const inspect = async () => {
    const scratch = path.join(root, `case-${invocation++}`);
    await mkdir(scratch);
    return readApplicationPendingLineage(
      { release_id: 10, opportunity: f.custody.opportunity },
      scratch,
      {
        api,
        async readMetadata(expected) {
          const state = states.get(expected.release_id);
          assert.ok(state);
          return {
            metadata: state.raw,
            receipt: inspectHistoricalApplicationPublication(state.raw, state.custody),
            assets: [],
            authority: "none" as const,
          };
        },
      },
    );
  };
  assert.deepEqual(
    (await inspect()).map((node) => node.release_id),
    [10, 42],
  );
  const authority = f.raw.authority_repository_sha256;
  f.raw.authority_repository_sha256 = "f".repeat(64);
  await assert.rejects(inspect);
  f.raw.authority_repository_sha256 = authority;
  const records = f.raw.publication.records_sha256;
  f.raw.publication.records_sha256 = "f".repeat(64);
  await assert.rejects(inspect, /changed accepted records/u);
  f.raw.publication.records_sha256 = records;
  const version = f.raw.publication.versions.releases;
  f.raw.publication.versions.releases = f.parent.raw.publication.versions.releases;
  await assert.rejects(inspect, /version lineage/u);
  f.raw.publication.versions.releases = version;
  const member = f.custody.budget;
  assert.ok(member?.kind === "member");
  const originalOwner = member.owner_opportunity;
  member.owner_opportunity = "f".repeat(64);
  await assert.rejects(inspect);
  member.owner_opportunity = originalOwner;
  // Declared join coverage only: actual Rust tests separately prove signatures
  // and Safe output with burned floors above the JavaScript safe-integer range.
  const beforeGap = f.raw.publication;
  const advanced = advanceMetadataFixture(beforeGap, f.contents, f.binding.prior_generation);
  Object.assign(f.raw, {
    publication: advanced.publication,
    site_generation: advanced.site,
    site_archive: {
      filename: "application-site.zip",
      bytes: advanced.archive.length,
      sha256: sha256(advanced.archive),
    },
  });
  await assert.rejects(inspect, /version lineage/);
  const reservation = (
    opportunity: string,
    producer: ApplicationRunCustody["runs"][number],
    attempt: number,
    facts: ReturnType<typeof inspectTufPublicationFacts>,
    context: string,
    prior: string,
  ) => ({
    opportunity,
    run_id: producer.id,
    run_attempt: attempt,
    control_commit: producer.control_commit,
    control_ref: producer.control_ref,
    generated_at: "2026-11-05T00:00:00Z",
    root_sha256: facts.root_sha256,
    offline_targets_sha256: facts.offline_targets_sha256,
    prior_repository_sha256: prior,
    versions: facts.versions,
    context_sha256: context,
    context_inventory_sha256: "b".repeat(64),
    records_sha256: facts.records_sha256,
  });
  const burned = reservation(
    parentCustody.opportunity,
    parentCustody.runs[0]!,
    2,
    beforeGap,
    "f".repeat(64),
    f.parent.binding.prior_repository_sha256,
  );
  const current = reservation(
    f.custody.opportunity,
    f.custody.runs[0]!,
    1,
    advanced.publication,
    String(f.raw.context_sha256),
    String(f.parent.raw.publication.repository_sha256),
  );
  const reservedOwner = inspectApplicationRunCustody({
    ...parentCustody,
    schema_version: 3,
    metadata_contexts: [burned, current],
  });
  states.set(42, { raw: f.parent.raw, custody: reservedOwner });
  assert.deepEqual(
    (await inspect()).map((node) => node.release_id),
    [10, 42],
  );
  const missing = inspectApplicationRunCustody({ ...reservedOwner, metadata_contexts: [burned] });
  states.set(42, { raw: f.parent.raw, custody: missing });
  await assert.rejects(inspect, /version lineage/);
  states.set(42, { raw: f.parent.raw, custody: reservedOwner });
  f.raw.renewal_parent = { release_id: 10, opportunity: f.custody.opportunity };
  await assert.rejects(inspect);
});

void test("metadata-only renewal publishes exactly two verified immutable assets once and receives them with the selected basis", async () => {
  for (const mode of ["valid", "publish-lost", "upload-lost"]) {
    const f = renewalFixture(mode);
    const extended = fixtureContextExtension(
      f.custody,
      f.raw.publication,
      f.binding.prior_repository_sha256,
    );
    f.release.body = `Human notes\n<!-- portcove-application-runs-v1\n${JSON.stringify(extended)}\n-->\nRetain me`;
    assert.equal(
      f.expected.custody.metadata_contexts,
      undefined,
      "source artifact remains immutable",
    );
    const first = await f.run();
    assert.equal(first.site_generation, f.site.generation);
    assert.deepEqual(f.mutations, [
      "upload:application-site.zip",
      "upload:application-metadata.json",
      "publish",
    ]);
    await f.run();
    assert.equal(f.mutations.length, 3, "an immutable retry cannot upload or publish again");
    let provenance = 0;
    const read = await readImmutableApplicationMetadataFeed(f.expected, {
      api: f.transport.api,
      readAsset: f.transport.readAsset,
      async authenticateAssembly(assets) {
        assert.equal(assets.size, 2);
        assert.ok(assets.get("application-metadata.json")?.equals(f.metadata));
        provenance++;
      },
    });
    assert.equal(provenance, 1);
    assert.equal(read.site.generation, f.site.generation);
    assert.equal(read.site.previous_generation, f.binding.prior_generation);
    assert.equal(f.mutations.length, 3, "the receiver performs no writes");
  }
});

void test("fresh-run metadata recovery authenticates its original registered assembly without temporary Actions artifacts", async () => {
  const f = renewalFixture();
  await f.run();
  f.custody.runs.push({
    id: "124",
    control_commit: "d".repeat(40),
    control_ref: "refs/tags/portcove-production-controller-windows-recovery",
  });
  f.release.body = `<!-- portcove-application-runs-v1\n${JSON.stringify(f.custody)}\n-->`;
  const {
    control_commit: ignoredCommit,
    control_ref: ignoredRef,
    run_id: ignoredRun,
    producer_attempt: ignoredAttempt,
    ...binding
  } = f.binding;
  assert.ok(ignoredCommit && ignoredRef && ignoredRun && ignoredAttempt);
  const calls: string[] = [];
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      assert.ok(
        !endpoint.includes("actions/artifacts") &&
          !endpoint.includes("pages") &&
          !endpoint.includes("deployments"),
      );
      calls.push(endpoint);
      return f.transport.api.request(method, endpoint);
    },
  };
  const attest = async (
    assets: ReadonlyMap<string, Buffer>,
    producer: { id: string; control_commit: string; control_ref: string },
    attempt: number,
  ) => {
    assert.ok(assets.get("application-metadata.json")?.equals(f.metadata));
    assert.deepEqual(producer, f.custody.runs[0]);
    assert.equal(attempt, 1);
  };
  const facts = await readRegisteredImmutableApplicationMetadata(f.expected, {
    api,
    readAsset: f.transport.readAsset,
    async authenticateAssembly(metadata, subjects, producer, attempt) {
      assert.ok(metadata.equals(f.metadata));
      assert.equal(subjects.length, 2);
      assert.deepEqual(producer, f.custody.runs[0]);
      assert.equal(attempt, 1);
    },
  });
  assert.equal(facts.receipt.producer.id, "123");
  const input = await readImmutableApplicationMetadataFeed(
    { ...f.expected, binding },
    {
      api,
      readAsset: f.transport.readAsset,
      authenticateAssembly: attest,
    },
  );
  assert.equal(input.producer.id, "123");
  assert.equal(input.producer_attempt, 1);
  assert.equal(input.site.generation, f.site.generation);
  await assert.rejects(
    () =>
      readImmutableApplicationMetadataFeed(
        { ...f.expected, binding },
        {
          api,
          readAsset: f.transport.readAsset,
          async authenticateAssembly(_assets, producer) {
            assert.equal(producer.id, "124", "new-run proof cannot replace original producer");
          },
        },
      ),
    /new-run proof/u,
  );
  assert.ok(calls.length > 0);
  assert.equal(f.mutations.length, 3, "recovery only reads preserved immutable objects");
});

void test("renewal rejects changed basis, producer, expiry and incomplete or ambiguous publication without retry", async () => {
  for (const mode of [
    "publish-refused",
    "upload-unobserved",
    "wrong-bytes",
    "wrong-tag",
    "tag-drift",
    "guard-refused",
    "expired-publication",
  ]) {
    const f = renewalFixture(mode);
    await assert.rejects(f.run);
    assert.ok(f.mutations.filter((value) => value === "publish").length <= 1);
  }
  const f = renewalFixture();
  for (const patch of [
    { purpose: "application-release" },
    { opportunity: "f".repeat(64) },
    { run_id: "124" },
    { prior_generation: "f".repeat(64) },
    { prior_repository_sha256: "f".repeat(64) },
  ]) {
    assert.throws(() =>
      inspectApplicationMetadataPublicationReceipt({ ...f.raw, ...patch }, f.binding, f.custody),
    );
  }
  const expired = renewalFixture("valid", 3);
  await assert.rejects(expired.run, /expired metadata/u);
  assert.deepEqual(expired.mutations, []);
});

void test("renewal expiring during physical readback never performs the irreversible publication", async (t) => {
  const f = renewalFixture();
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const read = f.transport.readAsset;
  f.transport.readAsset = async (id, maximum) => {
    const bytes = await read(id, maximum);
    clock += 2 * 86400000;
    return bytes;
  };
  await assert.rejects(f.run, /expired metadata/u);
  assert.deepEqual(f.mutations, [
    "upload:application-site.zip",
    "upload:application-metadata.json",
  ]);
  assert.equal(f.release.draft, true);
  assert.equal(f.release.immutable, false);
});

void test("historical publication data preserves producer and pinned site facts without claiming current freshness", () => {
  const old = fixture("valid", 3);
  assert.throws(() => inspectBootstrapPublicationReceipt(old.raw, old.binding));
  const historical = inspectHistoricalApplicationPublication(old.raw, old.custody);
  assert.deepEqual(historical.producer, old.custody.runs[0]);
  assert.equal(historical.producer_attempt, 1);
  assert.equal(historical.publication.root_sha256, trust.root.sha256);
  const f = fixture();
  const body = {
    schema_version: f.site.schema_version,
    previous_generation: "f".repeat(64),
    application_root_sha256: f.site.application_root_sha256,
    catalog_root_sha256: null,
    files: f.site.files,
  };
  const site = { ...body, generation: digest(body) };
  const archive = createAuditZip([
    ...f.contents,
    ["publication.json", Buffer.from(JSON.stringify(site))],
  ]);
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: trust.root.sha256,
    repository_sha256: "d".repeat(64),
    site_generation: body.previous_generation,
  };
  const raw = {
    ...Object.fromEntries(Object.entries(f.raw).filter(([key]) => key !== "bootstrap_descriptor")),
    kind: "application-metadata-publication",
    purpose: "metadata-renewal",
    opportunity: digest(basis),
    prior_generation: basis.site_generation,
    prior_repository_sha256: basis.repository_sha256,
    context_sha256: "e".repeat(64),
    site_generation: site,
    site_archive: {
      filename: "application-site.zip",
      bytes: archive.length,
      sha256: sha256(archive),
    },
  };
  const metadataCustody = { ...f.custody, opportunity: raw.opportunity };
  const parsed = inspectHistoricalApplicationPublication(raw, metadataCustody);
  assert.equal(parsed.site.previous_generation, body.previous_generation);
  assert.equal(parsed.archive.sha256, sha256(archive));
  assert.deepEqual(inspectBootstrapSiteArchive(archive, parsed), site);
  const appCustody: ApplicationRunCustody = {
    ...f.custody,
    opportunity: f.custody.source,
    preparation: {
      source_commit: f.custody.source,
      source_tree: f.custody.source_tree,
      prepared_commit: "8".repeat(40),
      prepared_tree: "9".repeat(40),
      version: "0.1.0-alpha.3",
      intent_sha256: "7".repeat(64),
      classification: {
        source_commit: f.custody.source,
        reviewed_commit: f.custody.source,
        base_version: "0.1.0-alpha.2",
        change: "prerelease",
        compatibility: "compatible",
      },
      published_versions: ["0.1.0-alpha.2"],
    },
  };
  const app = inspectHistoricalApplicationPublication(
    { ...raw, purpose: "application-release", opportunity: appCustody.opportunity },
    appCustody,
  );
  assert.deepEqual(inspectBootstrapSiteArchive(archive, app), site);
  for (const change of [
    { run_id: "999" },
    { control_commit: "f".repeat(40) },
    { producer_attempt: 0 },
    { purpose: "application-release" },
    { prior_generation: "d".repeat(64) },
    { publication: { ...f.raw.publication, root_sha256: "f".repeat(64) } },
    { unrelated: true },
  ])
    assert.throws(() =>
      inspectHistoricalApplicationPublication({ ...raw, ...change }, metadataCustody),
    );
});

void test("historical metadata reader authenticates both assembly subjects while downloading metadata only", async () => {
  for (const mode of [
    "valid",
    "digest",
    "archive",
    "attestation",
    "mutable",
    "pagination",
    "actor-drift",
  ]) {
    const f = fixture();
    await f.run();
    const writes = f.mutations.length;
    const producer = f.custody.runs[0]!;
    const ref = producer.control_ref.slice("refs/tags/".length);
    const state = {
      deployment_id: 40,
      source_commit: f.site.generation,
      ref,
      environment: "github-pages",
      status_id: 41,
      log_url: "https://github.com/boburning/portcove/actions/runs/123/job/456",
      pages: {
        html_url: "https://boburning.github.io/portcove/",
        build_type: "workflow",
        cname: null,
        https_enforced: true,
      },
    };
    const discovered: ReturnType<typeof discoverPublishedApplicationCohort> = {
      release_id: 10,
      custody: f.custody,
      state,
      execution: {
        run: producer,
        attempt: 1,
        job_id: 456,
        conclusion: "success",
        started_at: "fixture",
        completed_at: "fixture",
        deployment_created_at: "fixture",
        deployed_at: "fixture",
        authority: "none" as const,
      },
      authority: "none" as const,
    };
    const reads: number[] = [];
    let authenticated = 0;
    if (mode === "digest")
      f.remoteAssets.find((asset) => asset.name === "application-metadata.json")!.digest =
        `sha256:${"f".repeat(64)}`;
    if (mode === "archive")
      f.remoteAssets.find((asset) => asset.name === "application-site.zip")!.digest =
        `sha256:${"f".repeat(64)}`;
    if (mode === "mutable") f.release.immutable = false;
    const run = () =>
      readImmutableApplicationMetadata(discovered, {
        api: {
          request(method, endpoint) {
            assert.equal(method, "GET");
            const reply = (body: unknown) => ({
              status: 200,
              headers: new Map<string, string>(),
              body,
            });
            if (endpoint.endsWith("/pages")) return reply(state.pages);
            if (endpoint.includes("deployments?"))
              return reply([{ id: 40, sha: f.site.generation, ref, environment: "github-pages" }]);
            if (endpoint.includes("deployments/40/statuses"))
              return reply([
                { id: mode === "actor-drift" ? 42 : 41, state: "success", log_url: state.log_url },
              ]);
            const response = f.transport.api.request(method, endpoint);
            if (mode === "pagination" && endpoint.includes("/assets?"))
              return {
                ...response,
                headers: new Map([
                  ...response.headers,
                  ["link", '<https://api.github.com/next>; rel="next"'],
                ]),
              };
            return response;
          },
        },
        async readAsset(id, maximum) {
          reads.push(id);
          return f.transport.readAsset(id, maximum);
        },
        async authenticateAssembly(metadata, subjects, actualProducer, attempt) {
          authenticated++;
          assert.deepEqual(JSON.parse(metadata.toString("utf8")), f.raw);
          assert.deepEqual(actualProducer, producer);
          assert.equal(attempt, 1);
          assert.deepEqual(
            subjects,
            f.remoteAssets
              .map((asset) => ({ filename: asset.name, sha256: asset.digest.slice(7) }))
              .sort((a, b) => b.filename.localeCompare(a.filename)),
          );
          if (mode === "attestation") throw new Error("injected provenance refusal");
        },
      });
    if (mode === "valid") {
      const result = await run();
      assert.equal(result.authority, "none");
      assert.equal(authenticated, 1);
      assert.equal(reads.length, 1);
      assert.equal(
        reads[0],
        f.remoteAssets.find((asset) => asset.name === "application-metadata.json")!.id,
      );
    } else await assert.rejects(run());
    assert.equal(f.mutations.length, writes);
  }
});

void test("bootstrap receipt and ZIP bind exact anchors, inventory, marker and producer; no authority inferred", () => {
  const f = fixture();
  const receipt = inspectBootstrapPublicationReceipt(f.raw, f.binding);
  assert.deepEqual(inspectBootstrapSiteArchive(f.archive, receipt), f.site);
  for (const delta of [
    { control_commit: "f".repeat(40) },
    { producer_attempt: 2 },
    { opportunity: "f".repeat(64) },
    { retained_inventory_sha256: "f".repeat(64) },
  ])
    assert.throws(() => inspectBootstrapPublicationReceipt({ ...f.raw, ...delta }, f.binding));
  assert.throws(() =>
    inspectBootstrapPublicationReceipt({ ...f.raw, injected_path: "/tmp/elsewhere" }, f.binding),
  );
  assert.throws(() =>
    inspectBootstrapPublicationReceipt(f.raw, f.binding, Date.now() + 3 * 86400000),
  );
  for (const entries of [
    [...f.contents],
    [
      ...f.contents,
      [
        "publication.json",
        Buffer.from(JSON.stringify({ ...f.site, generation: "f".repeat(64) })),
      ] as const,
    ],
    [
      ...f.contents,
      ["publication.json", Buffer.from(JSON.stringify(f.site))] as const,
      ["unexpected.exe", Buffer.from("inert")] as const,
    ],
    [
      ...f.contents,
      ["publication.json", Buffer.from(JSON.stringify(f.site))] as const,
      [".nojekyll", Buffer.alloc(0)] as const,
    ],
  ]) {
    const zip = createAuditZip(entries);
    assert.throws(() =>
      inspectBootstrapSiteArchive(zip, {
        ...receipt,
        archive: { ...receipt.archive, bytes: zip.length, sha256: sha256(zip) },
      }),
    );
  }
});

void test("feed consumes actual immutable bytes with complete assembly authentication and no mutation route", async () => {
  const f = fixture();
  await f.run();
  const writes = f.mutations.length;
  let authentications = 0;
  const input = await readImmutableBootstrapFeed(
    { release_id: 10, custody: f.custody, binding: f.binding },
    {
      api: {
        request(method, endpoint) {
          assert.equal(method, "GET");
          return f.transport.api.request(method, endpoint);
        },
      },
      readAsset: f.transport.readAsset,
      async authenticateAssembly(assets) {
        authentications++;
        assert.deepEqual([...assets.keys()].sort(), [
          "application-metadata.json",
          "application-site.zip",
        ]);
        assert.ok(assets.get("application-site.zip")?.equals(f.archive));
        assert.deepEqual(
          JSON.parse(assets.get("application-metadata.json")!.toString("utf8")),
          f.raw,
        );
      },
    },
  );
  assert.equal(authentications, 1);
  assert.deepEqual(input.site, f.site);
  for (const [name, bytes] of f.contents) assert.ok(input.files.get(name)?.equals(bytes));
  assert.equal(input.files.get(".nojekyll")?.length, 0);
  assert.equal(input.files.size, f.contents.size + 1);
  assert.equal(f.mutations.length, writes);
});

void test("feed refuses unpublished or mutable input, missing/colliding/corrupt assets and unauthenticated assembly", async () => {
  for (const mode of [
    "draft",
    "mutable",
    "missing",
    "duplicate",
    "incomplete",
    "wrong-bytes",
    "wrong-digest",
    "attestation",
    "producer",
  ]) {
    const f = fixture();
    await f.run();
    if (mode === "draft") {
      f.release.draft = true;
      f.release.immutable = false;
    }
    if (mode === "mutable") f.release.immutable = false;
    if (mode === "missing") f.remoteAssets.pop();
    if (mode === "duplicate") f.remoteAssets[1]!.name = f.remoteAssets[0]!.name;
    if (mode === "incomplete") f.remoteAssets[0]!.state = "starter";
    if (mode === "wrong-bytes")
      f.remoteBytes.set(f.remoteAssets[0]!.id, Buffer.alloc(f.archive.length));
    if (mode === "wrong-digest") f.remoteAssets[0]!.digest = `sha256:${"f".repeat(64)}`;
    const writes = f.mutations.length;
    await assert.rejects(
      readImmutableBootstrapFeed(
        {
          release_id: 10,
          custody: f.custody,
          binding: mode === "producer" ? { ...f.binding, producer_attempt: 2 } : f.binding,
        },
        {
          api: {
            request(method, endpoint) {
              assert.equal(method, "GET");
              return f.transport.api.request(method, endpoint);
            },
          },
          readAsset: f.transport.readAsset,
          async authenticateAssembly() {
            if (mode === "attestation") throw new Error("signature not verified");
          },
        },
      ),
    );
    assert.equal(f.mutations.length, writes);
  }
});

void test("feed brackets asset and provenance reads with immutable release custody and exact tag readback", async () => {
  for (const mode of ["tag", "custody"]) {
    const f = fixture();
    await f.run();
    await assert.rejects(
      readImmutableBootstrapFeed(
        { release_id: 10, custody: f.custody, binding: f.binding },
        {
          api: {
            request(method, endpoint) {
              assert.equal(method, "GET");
              const response = f.transport.api.request(method, endpoint);
              if (mode === "tag" && endpoint.includes("/git/ref/")) {
                assert.ok(isRecord(response.body) && isRecord(response.body.object));
                response.body.object.sha = "f".repeat(40);
              }
              return response;
            },
          },
          readAsset: f.transport.readAsset,
          async authenticateAssembly() {
            if (mode === "custody") f.release.body = "lost custody";
          },
        },
      ),
    );
  }
});

void test("complete draft uploads two assets then reads all bytes before and after immutable publication", async () => {
  const f = fixture();
  const notes = f.release.body;
  const result = await f.run();
  assert.equal(result.release_id, 10);
  assert.equal(f.release.body, notes);
  assert.deepEqual(f.mutations, [
    "upload:application-site.zip",
    "upload:application-metadata.json",
    "publish",
  ]);
  assert.deepEqual(f.counters(), { guards: 3, reads: 4 });
  await f.run();
  assert.equal(f.mutations.length, 3, "immutable retry must be read-only");
  assert.deepEqual(f.counters(), { guards: 3, reads: 6 });
});

void test("lost upload and publication acknowledgments reconcile once without duplicate mutation", async () => {
  for (const mode of ["upload-lost", "publish-lost"]) {
    const f = fixture(mode);
    await f.run();
    assert.equal(f.mutations.length, 3);
  }
  const f = fixture("upload-unobserved");
  await assert.rejects(f.run(), /upload outcome unknown/u);
  assert.deepEqual(f.mutations, ["upload:application-site.zip"]);
});

void test("existing matching partial upload is retained; collisions and incomplete assets hold without writes", async () => {
  const f = fixture();
  f.remoteAssets.push({
    id: 50,
    name: "application-site.zip",
    state: "uploaded",
    size: f.archive.length,
    digest: `sha256:${sha256(f.archive)}`,
  });
  f.remoteBytes.set(50, f.archive);
  await f.run();
  assert.deepEqual(f.mutations, ["upload:application-metadata.json", "publish"]);
  for (const delta of [
    { name: "unexpected.exe" },
    { state: "starter" },
    { digest: `sha256:${"f".repeat(64)}` },
    { size: 1 },
  ]) {
    const g = fixture();
    g.remoteAssets.push({
      id: 50,
      name: "application-site.zip",
      state: "uploaded",
      size: g.archive.length,
      digest: `sha256:${sha256(g.archive)}`,
      ...delta,
    });
    await assert.rejects(g.run());
    assert.equal(g.mutations.length, 0);
  }
});

void test("pause, wrong tag, corrupt asset readback and refused publication cannot become success", async () => {
  for (const mode of ["guard-refused", "wrong-tag", "wrong-bytes", "publish-refused"]) {
    const f = fixture(mode);
    await assert.rejects(f.run());
    assert.equal(
      f.mutations.filter((value) => value === "publish").length,
      mode === "publish-refused" ? 1 : 0,
    );
    if (mode === "guard-refused" || mode === "wrong-tag") assert.equal(f.mutations.length, 0);
  }
});

void test("real-adapter pending-tag404 is allowed only for a draft; other provider errors and pre-publication tag drift hold", async () => {
  const pending = fixture("pending-tag");
  await pending.run();
  assert.equal(pending.mutations.length, 3);
  for (const mode of ["tag-forbidden", "tag-network", "tag-drift"]) {
    const f = fixture(mode);
    await assert.rejects(f.run());
    assert.equal(f.mutations.includes("publish"), false);
    if (mode !== "tag-drift") assert.equal(f.mutations.length, 0);
  }
});

void test("protection expiry during provider preimage reads prevents the following mutation", async () => {
  for (const mode of ["expired-upload", "expired-publication"]) {
    const f = fixture(mode);
    await assert.rejects(f.run(), /original protection deadline expired/u);
    assert.deepEqual(
      f.mutations,
      mode === "expired-upload"
        ? []
        : ["upload:application-site.zip", "upload:application-metadata.json"],
    );
  }
});

void test("two fixed worker process entries on one runner each create a private reader scope", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "application-sequential-entry-"));
  try {
    for (let index = 0; index < 2; index++) {
      // Unknown operation reaches the actual private CLI scope without invoking
      // execution, providers, artifacts or keys. Both entries must get that far.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./application-release-private.mts", import.meta.url)),
          "inert-invalid-operation",
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: parent,
            GH_TOKEN: "inert-fixture-reader-token",
          },
          timeout: 30000,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Fixed application role failed/u);
    }
    const entries = await readdir(parent);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const homes = await readdir(path.join(parent, entry));
      assert.equal(homes.length, 1);
      assert.match(homes[0]!, /^readonly-cli-/u);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("ordinary publication accepts only the native metadata extension after source transfer", async () => {
  const f = ordinaryFixture("native-context-extension");
  assert.equal(f.expected.custody.metadata_contexts, undefined);
  const prepared = await f.prepare();
  await f.publish(prepared);
  assert.equal(f.release.immutable, true);
  assert.equal(readApplicationRunNotes(f.release.body)!.custody.metadata_contexts?.length, 1);
});

void test("expired draft recovery verifies either surviving asset against the complete original assembly", async () => {
  const f = renewalFixture();
  const advanced = advanceMetadataFixture(
    f.raw.publication,
    f.contents,
    f.binding.prior_generation,
  );
  const retained = fixtureContextExtension(
    f.custody,
    f.raw.publication,
    f.binding.prior_repository_sha256,
  );
  const first = retained.metadata_contexts![0]!;
  const oldPublication = {
    ...f.raw.publication,
    expires: { ...f.raw.publication.expires, timestamp: "2000-01-01T00:00:00Z" },
  };
  const oldFiles = [
    f.archive,
    Buffer.from(JSON.stringify({ ...f.raw, publication: oldPublication })),
  ];
  const old = {
    release_id: f.expected.release_id,
    context_sha256: first.context_sha256,
    producer_attempt: first.run_attempt,
    prior_generation: f.binding.prior_generation,
    prior_repository_sha256: f.binding.prior_repository_sha256,
    retained_inventory_sha256: digest(
      f.site.files.filter((file) => !file.path.startsWith("application/")),
    ),
    publication: oldPublication,
    subjects: bootstrapAssetNames.map((name, index) => ({
      name,
      bytes: oldFiles[index]!.length,
      sha256: sha256(oldFiles[index]!),
    })),
  };
  const replacementMetadata = Buffer.from(JSON.stringify(advanced.publication));
  const replacement = {
    ...old,
    context_sha256: "a".repeat(64),
    producer_attempt: 2,
    publication: advanced.publication,
    subjects: bootstrapAssetNames.map((name, index) => ({
      name,
      bytes: index === 0 ? advanced.archive.length : replacementMetadata.length,
      sha256: index === 0 ? sha256(advanced.archive) : sha256(replacementMetadata),
    })),
  };
  const owner = {
    release_id: f.expected.release_id,
    custody: inspectApplicationRunCustody({
      ...retained,
      metadata_contexts: [
        first,
        {
          ...first,
          run_attempt: 2,
          context_sha256: replacement.context_sha256,
          context_inventory_sha256: "b".repeat(64),
          versions: advanced.publication.versions,
        },
      ],
      draft_assemblies: [old, replacement],
    }),
  };
  const retainedAsset = {
    id: 90,
    name: "updater-inventory.json",
    bytes: 2,
    sha256: sha256(Buffer.from("{}")),
  };
  const oldIds = old.subjects.map((subject, index) => ({ id: 70 + index, ...subject }));
  const recovery = {
    release_id: f.expected.release_id,
    old_context_sha256: old.context_sha256,
    replacement_context_sha256: replacement.context_sha256,
    retained_assets_sha256: digest([retainedAsset]),
    assets: oldIds.map(({ id, name }) => ({ id, name })),
    backup: { id: 50, bytes: 128, sha256: "b".repeat(64), run_attempt: 2 },
  };
  let inventory = [oldIds[1]!, retainedAsset];
  const deleted: string[] = [];
  const resumed = await removeExpiredApplicationDraftAssets(recovery, old, replacement, {
    api: {
      request(method, endpoint) {
        assert.equal(method, "DELETE");
        assert.equal(endpoint, "repos/boburning/portcove/releases/assets/71");
        deleted.push(endpoint);
        inventory = [retainedAsset];
        return { status: 204, headers: new Map(), body: null };
      },
    },
    inspectDraft: () => ({
      release_id: recovery.release_id,
      draft: true,
      immutable: false,
      tag: "fixture",
      source: first.control_commit,
      notes: "retained",
      assets: inventory,
    }),
    async claim(assetId, beforeWrite) {
      assert.equal(assetId, 71);
      await beforeWrite();
      return { release_id: recovery.release_id, notes: "retained" };
    },
    async beforeWrite() {
      return () => {};
    },
  });
  assert.deepEqual(resumed.assets, [retainedAsset]);
  assert.equal(deleted.length, 1);
  for (const [index, subject] of old.subjects.entries()) {
    const asset = { id: 23 + index, ...subject };
    const events: string[] = [];
    const transport = {
      async readAsset(id: number, maximum: number) {
        events.push("physical");
        assert.equal(id, asset.id);
        assert.equal(maximum, subject.bytes);
        return oldFiles[index]!;
      },
      async authenticateAssembly(
        filename: string,
        bytes: Buffer,
        expected: ReleaseSourceAttestationExpectation,
      ) {
        events.push(filename);
        const proof = filename === applicationDraftProofName;
        const current = expected.run_attempt === replacement.producer_attempt;
        const assembly = current ? replacement : old;
        assert.equal(
          filename,
          proof ? applicationDraftProofName : current ? bootstrapAssetNames[1] : subject.name,
        );
        assert.deepEqual(
          bytes,
          proof
            ? applicationDraftProofBytes(assembly)
            : current
              ? replacementMetadata
              : oldFiles[index],
        );
        assert.deepEqual(expected, {
          source_commit: first.control_commit,
          ref: first.control_ref,
          run_id: first.run_id,
          run_attempt: assembly.producer_attempt,
          subjects: proof
            ? [{ filename, sha256: sha256(applicationDraftProofBytes(assembly)) }]
            : assembly.subjects.map(({ name, sha256 }) => ({ filename: name, sha256 })),
        });
      },
    };
    const admitted = await readExpiredApplicationDraftAssets(
      f.expected,
      owner,
      replacement,
      replacementMetadata,
      [asset],
      transport,
    );
    assert.equal(admitted.authority, "none");
    assert.deepEqual(admitted.backup, [{ asset, bytes: oldFiles[index] }]);
    assert.deepEqual(events, [
      "physical",
      subject.name,
      applicationDraftProofName,
      bootstrapAssetNames[1],
      applicationDraftProofName,
    ]);
    const staged = readStagedDraftRecoveryBackup(
      {
        release_id: f.expected.release_id,
        assets: [asset],
      },
      owner.custody,
      old.context_sha256,
      replacement.context_sha256,
    );
    assert.deepEqual(staged.preimage, admitted.preimage);
    assert.throws(() =>
      readStagedDraftRecoveryBackup(
        {
          release_id: f.expected.release_id,
          assets: [{ ...asset, bytes: asset.bytes + 1 }],
        },
        owner.custody,
        old.context_sha256,
        replacement.context_sha256,
      ),
    );
    const producer = { run_id: first.run_id, run_attempt: 2, source: first.control_commit };
    const backup = {
      bytes: 128,
      sha256: "b".repeat(64),
      files: new Map([[subject.name, oldFiles[index]!]]),
    };
    const receipt = await verifyApplicationDraftRecoveryBackup(
      staged,
      50,
      producer,
      async (expected) => {
        assert.deepEqual(expected, {
          id: 50,
          name: `application-draft-recovery-${first.run_id}-2`,
          run_id: first.run_id,
          source: first.control_commit,
          files: [subject.name],
        });
        return backup;
      },
    );
    assert.deepEqual(receipt.assets, [{ id: asset.id, name: asset.name }]);
    assert.equal(receipt.retained_assets_sha256, digest([]));
    assert.deepEqual(receipt.backup, {
      id: 50,
      bytes: 128,
      sha256: "b".repeat(64),
      run_attempt: 2,
    });
    await assert.rejects(
      verifyApplicationDraftRecoveryBackup(admitted, 50, producer, async () => ({
        ...backup,
        files: new Map([[subject.name, Buffer.alloc(subject.bytes)]]),
      })),
      /backup bytes differ/,
    );
    await assert.rejects(
      verifyApplicationDraftRecoveryBackup(admitted, 50, producer, async () => ({
        ...backup,
        files: new Map([...backup.files, ["unexpected.json", Buffer.from("{}")]]),
      })),
    );
    for (const mode of ["lost", "refused", "locked", "notes-drift"]) {
      let inventory = [asset];
      let notes = "initial";
      let requested = 0;
      let claimed = false;
      const transport: Parameters<typeof removeExpiredApplicationDraftAssets>[3] = {
        api: {
          request(method, endpoint) {
            assert.equal(method, "DELETE");
            assert.equal(endpoint, `repos/boburning/portcove/releases/assets/${asset.id}`);
            assert.ok(claimed);
            requested++;
            if (mode === "lost") inventory = [];
            throw new Error("DELETE response unavailable");
          },
        },
        inspectDraft: () => ({
          release_id: receipt.release_id,
          draft: true,
          immutable: mode === "locked",
          tag: "fixture",
          source: first.control_commit,
          notes,
          assets: inventory,
        }),
        async claim(id, beforeWrite) {
          assert.equal(id, asset.id);
          if (claimed) return undefined;
          await beforeWrite();
          claimed = true;
          notes = "claimed";
          return {
            release_id: mode === "notes-drift" ? receipt.release_id + 1 : receipt.release_id,
            notes,
          };
        },
        async beforeWrite() {
          return () => {};
        },
      };
      const recover = () =>
        removeExpiredApplicationDraftAssets(receipt, old, replacement, transport);
      if (mode === "lost") {
        assert.deepEqual((await recover()).assets, []);
        assert.deepEqual((await recover()).assets, []);
      } else if (mode === "refused") {
        await assert.rejects(recover(), /outcome unknown/);
        await assert.rejects(recover(), /already claimed/);
      } else {
        await assert.rejects(recover());
      }
      assert.equal(requested, mode === "lost" || mode === "refused" ? 1 : 0);
    }
    const tamperedOwner = {
      ...owner,
      custody: {
        ...owner.custody,
        draft_assemblies: [
          {
            ...old,
            publication: {
              ...old.publication,
              expires: { ...old.publication.expires, timestamp: "2001-01-01T00:00:00Z" },
            },
          },
          replacement,
        ],
      },
    };
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        tamperedOwner,
        replacement,
        replacementMetadata,
        [asset],
        transport,
      ),
    );
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        owner,
        replacement,
        replacementMetadata,
        [asset],
        {
          ...transport,
          async readAsset() {
            return Buffer.alloc(subject.bytes);
          },
        },
      ),
    );
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        owner,
        replacement,
        replacementMetadata,
        [asset],
        {
          ...transport,
          async authenticateAssembly() {
            throw new Error("attestation refused");
          },
        },
      ),
      /attestation refused/,
    );
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        { ...owner, release_id: 100 },
        replacement,
        replacementMetadata,
        [asset],
        transport,
      ),
    );
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        owner,
        replacement,
        replacementMetadata,
        [asset, { id: 90, ...replacement.subjects[1 - index]! }],
        transport,
      ),
      /one retained assembly/,
    );
    await assert.rejects(
      readExpiredApplicationDraftAssets(
        f.expected,
        owner,
        replacement,
        replacementMetadata,
        [asset],
        transport,
        Date.parse("1999-01-01T00:00:00Z"),
      ),
      /still fresh/,
    );
  }
});
