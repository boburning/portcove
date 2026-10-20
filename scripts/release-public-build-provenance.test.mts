import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectPublicBuildInputBinding,
  selectPublicBuildInputBinding,
  requirePublicBuildInputProviderBinding,
  requireStablePublicBuildInputEvidence,
  verifyReleasePublicBuildInputs,
} from "./release-public-build-provenance.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test("schema3 binds complete exact immutable public inputs through actual package assembly without claiming compiler contents", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const { accepted } = await inspectTrustedAssemblyInput(f.request);
  assert.deepEqual(accepted.public_build_inputs, f.binding);
  const evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
  assert.deepEqual(selectPublicBuildInputBinding(f.configuration, evidence), f.binding);
  const result = await assembleReleaseArtifacts(
    f.root,
    f.request,
    f.archives,
    f.expected,
    f.options,
  );
  assert.equal(result.aggregate.output_files.length, 7);
  assert.deepEqual(result.public_build_inputs?.binding, f.binding);
  assert.equal(result.public_build_inputs?.receipts.length, 2);
  assert.equal(result.original_compiler, null);
  assert.equal(result.authority, "none");
  assert.match(result.public_build_inputs.scope, /no compiler-content or execution claim/);
  for (const receipt of result.public_build_inputs.receipts) {
    assert.equal(receipt.manifest_sha256, f.configuration.manifest_sha256);
    assert.equal(receipt.root_sha256, f.prepared.receipt.root_sha256);
    assert.equal(receipt.tauri_configuration_sha256, f.prepared.receipt.tauri_configuration_sha256);
  }
});

void test("public matrix, numeric identity and attempt names must match independent complete provider evidence", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
  for (const binding of [
    { ...f.binding, artifacts: f.binding.artifacts.slice(1) },
    { ...f.binding, artifacts: [f.binding.artifacts[0], f.binding.artifacts[0]] },
    { ...f.binding, artifacts: f.binding.artifacts.map((a) => ({ ...a, artifact_id: "10" })) },
    { ...f.binding, artifacts: f.binding.artifacts.map((a) => ({ ...a, bytes: 1024 * 1024 + 1 })) },
    {
      ...f.binding,
      artifacts: f.binding.artifacts.map((a) => ({ ...a, platform: "macos-aarch64" })),
    },
  ])
    assert.throws(() => inspectPublicBuildInputBinding(binding));
  for (const patch of [
    { expired: true },
    { name: "release-public-build-inputs-linux-x86_64-12345-2" },
    { bytes: 22 },
    { archive_sha256: "0".repeat(64) },
  ]) {
    const changed = structuredClone(evidence);
    const item = changed.artifacts.find((a) => a.id === f.binding.artifacts[0]!.artifact_id)!;
    Object.assign(item, patch);
    assert.throws(
      () => requirePublicBuildInputProviderBinding(f.binding, changed),
      /provider inventory/,
    );
  }
  const duplicate = structuredClone(evidence);
  duplicate.artifacts.push({ ...duplicate.artifacts.find((a) => a.id === 10)!, id: 12 });
  assert.throws(
    () => requirePublicBuildInputProviderBinding(f.binding, duplicate),
    /provider inventory/,
  );
  await assert.rejects(
    inspectTrustedAssemblyInput({ ...f.request, release_profile: "full" }),
    /schema/,
  );
});

void test("public inputs refuse manifest substitution and altered generated configuration or receipt even with matching ZIP identities", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  let evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
  await assert.rejects(
    verifyReleasePublicBuildInputs(
      f.root,
      { ...f.binding, manifest_sha256: "f".repeat(64) },
      evidence,
      f.options,
    ),
  );
  for (const name of ["tauri.release-public.conf.json", "build-inputs.json"]) {
    const original = f.publicFiles.get(name)!;
    f.publicFiles.set(
      name,
      Buffer.from(
        name === "build-inputs.json"
          ? '{"authority":"accepted"}'
          : '{"bundle":{"createUpdaterArtifacts":false}}',
      ),
    );
    f.replacePublicArchive();
    evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
    await assert.rejects(
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options),
      CoordinatorRemoteError,
    );
    f.publicFiles.set(name, original);
  }
});

void test("ZIP structural and represented-size refusals precede extraction and preserve opaque archive evidence", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  for (const bytes of [
    createAuditZip(
      [...f.publicFiles]
        .filter(([name]) => name !== "root.json")
        .map(([name, content]) => [name, content, { descriptor: true }]),
    ),
    createAuditZip(
      [...f.publicFiles]
        .map(([name, content]) => [name, content, { descriptor: true }] as const)
        .concat([["../escape", Buffer.from("inert"), { descriptor: true }]]),
    ),
    (() => {
      const bytes = Buffer.from(f.blobs.get(10)!);
      const offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(offset >= 0);
      bytes.writeUInt32LE(0xffffffff, offset + 24);
      return bytes;
    })(),
  ]) {
    for (const item of f.binding.artifacts) {
      item.bytes = bytes.length;
      item.sha256 = hash(bytes);
      f.blobs.set(item.artifact_id, bytes);
    }
    const evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
    let failure: unknown;
    try {
      await verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CoordinatorRemoteError && isRecord(failure.evidence));
    assert.equal(failure.evidence.phase, "raw-zip-preflight");
    assert.equal(typeof failure.evidence.directory, "string");
    const directory = String(failure.evidence.directory);
    assert.deepEqual((await readdir(directory)).sort(), ["failure.json", "linux-x86_64.zip"]);
    assert.deepEqual(await readFile(path.join(directory, "linux-x86_64.zip")), bytes);
  }
});

void test("public provider drift refuses the integrated aggregate and preserves prior public collection", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const before = collectReleaseRunEvidence(f.expected, { api: f.api });
  f.state.drift = true;
  const after = collectReleaseRunEvidence(f.expected, { api: f.api });
  assert.throws(
    () => requireStablePublicBuildInputEvidence(f.binding, before, after),
    /provider inventory/,
  );
  f.state.reads = 0;
  await assert.rejects(
    assembleReleaseArtifacts(f.root, f.request, f.archives, f.expected, f.options),
    /retain owned directory/,
  );
  assert.ok((await readdir(f.root)).some((name) => name.startsWith("artifact-assembly-")));
});
