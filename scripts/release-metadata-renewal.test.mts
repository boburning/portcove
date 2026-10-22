import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, rm, cp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
void test("fixed verifier preparation refuses expired context deadline before file reads or tool launch", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAuthenticatedMetadataRenewal({ ...f.request, deadline: performance.now() - 1 }),
    /phase deadline/,
  );
  assert.deepEqual(await readdir(f.output), []);
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renewal-tool-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = path.join(root, "public"),
    output = path.join(root, "output");
  await mkdir(path.join(prior, "metadata"), { recursive: true });
  await mkdir(output);
  const bytes = Buffer.from("untrusted public fixture bytes\n");
  await writeFile(path.join(prior, "metadata/timestamp.json"), bytes);
  const trusted = path.join(root, "root.json");
  await writeFile(trusted, bytes);
  const request = {
    verifier: process.execPath,
    verifier_sha256: "0".repeat(64),
    trusted_root: trusted,
    trusted_root_sha256: sha(bytes),
    previous_repository: prior,
    prior_repository_sha256: digest([
      { path: "metadata/timestamp.json", bytes: bytes.length, sha256: sha(bytes) },
    ]),
    generated_at: "2026-10-20T00:00:00Z",
    output_parent: output,
  };
  return { root, prior, output, request };
}
void test("imported JSON cannot stand in for an actual private renewal preparation", async () => {
  await assert.rejects(
    inspectPreparedMetadataRenewal({
      kind: "authenticated-metadata-renewal-preparation",
      descriptor_sha256: "0".repeat(64),
      input_manifest_sha256: "1".repeat(64),
    }),
    /not prepared/,
  );
});
void test("unknown initial Root profile refuses before any output or verifier invocation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAuthenticatedMetadataRenewal({
      ...f.request,
      initial_root_profile: "download-selected" as never,
    }),
    /Root profile/,
  );
  assert.deepEqual(await readdir(f.output), []);
});
void test("unknown Targets mode and online mode without single-owner selection refuse before outputs", async (t) => {
  const f = await fixture(t);
  for (const mode of ["download-selected", "online-unchanged-authority-v1"])
    await assert.rejects(
      prepareAuthenticatedMetadataRenewal({
        ...f.request,
        top_level_targets_profile: mode as never,
      }),
      /Targets|single-owner/,
    );
  assert.deepEqual(await readdir(f.output), []);
});
void test("wrong actual tool or independently ratified root refuses before creating outputs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAuthenticatedMetadataRenewal(f.request),
    /qualified renewal verifier changed/,
  );
  await assert.rejects(
    prepareAuthenticatedMetadataRenewal({ ...f.request, trusted_root_sha256: "0".repeat(64) }),
    /ratified root differs/,
  );
  assert.deepEqual(await readdir(f.output), []);
});
void test("complete public component mismatch and unexpected private paths refuse before executing tool", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAuthenticatedMetadataRenewal({ ...f.request, prior_repository_sha256: "0".repeat(64) }),
    /public component differs/,
  );
  await writeFile(path.join(f.prior, "credential.json"), "fixture sentinel");
  await assert.rejects(prepareAuthenticatedMetadataRenewal(f.request), /non-public/);
  assert.deepEqual(await readdir(f.output), []);
});
const publicFixture = process.env.PORTCOVE_TUF_RENEWAL_ADAPTER_FIXTURE;
const actualTool = process.env.PORTCOVE_TUF_RENEWAL_ADAPTER_TOOL;
void test(
  "qualified actual Rust renewal tool authenticates public fixture and custody refuses later mutation",
  { skip: !publicFixture || !actualTool, timeout: 120000 },
  async (t) => {
    assert.ok(publicFixture && actualTool);
    const f = await fixture(t);
    await rm(f.prior, { recursive: true });
    await cp(path.join(publicFixture, "prior"), f.prior, {
      recursive: true,
      filter: (source) => path.basename(source) !== "repository-manifest.json",
    });
    await cp(path.join(publicFixture, "trusted-root.json"), f.request.trusted_root);
    const files: { path: string; bytes: number; sha256: string }[] = [];
    const walk = async (prefix: string) => {
      for (const entry of await readdir(path.join(f.prior, prefix), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(name);
        else {
          const bytes = await readFile(path.join(f.prior, name));
          files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
        }
      }
    };
    await walk("");
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const session = await prepareAuthenticatedMetadataRenewal({
      ...f.request,
      verifier: actualTool,
      verifier_sha256: sha(await readFile(actualTool)),
      trusted_root_sha256: sha(await readFile(f.request.trusted_root)),
      prior_repository_sha256: digest(files),
      generated_at: new Date()
        .toISOString()
        .replace(/\.([0-9]*?)0+Z$/u, (_all: string, fraction: string) =>
          fraction ? `.${fraction}Z` : "Z",
        ),
    });
    const bound = await inspectPreparedMetadataRenewal(session);
    assert.equal(bound.descriptor_sha256, digest(bound.descriptor));
    assert.equal(bound.descriptor.prior_repository_sha256, digest(files));
    assert.equal(bound.descriptor.current_versions.targets, bound.descriptor.next_versions.targets);
    await writeFile(path.join(bound.prepared_root, "renewal.json"), "changed fixture");
    await assert.rejects(inspectPreparedMetadataRenewal(session), /custody changed/);
  },
);
