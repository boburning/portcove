import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, rm, cp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import {
  applicationContextPriorRepositorySha256,
  applicationMetadataContextIdentity,
} from "./application-release-context.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";

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
  // This negative preparation fixture never executes a verifier. Do not use
  // a large Node executable as a stand-in for the independently bounded Rust tool.
  const verifier = path.join(root, "inert-renewal-verifier");
  await writeFile(verifier, "inert verifier fixture\n", { flag: "wx", mode: 0o700 });
  const request = {
    verifier,
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
  {
    skip:
      !publicFixture || !actualTool
        ? "actual renewal tool or public fixture is not appointed"
        : false,
    timeout: 120000,
  },
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
    const actualContext = await readBoundedReleaseContextFiles(bound.prepared_root);
    assert.ok(actualContext.has("prior/repository-manifest.json"));
    assert.equal(
      applicationContextPriorRepositorySha256(actualContext),
      digest(files),
      "the real Rust context joins the public component without its internal manifest",
    );
    assert.equal(bound.descriptor.current_versions.targets, bound.descriptor.next_versions.targets);
    await writeFile(path.join(bound.prepared_root, "renewal.json"), "changed fixture");
    await assert.rejects(inspectPreparedMetadataRenewal(session), /custody changed/);
  },
);

void test("actual Rust adapter authenticates expired online prior only under explicit historical policy", async (t) => {
  const actualTool = process.env.PORTCOVE_TUF_RENEWAL_ADAPTER_TOOL;
  const exported = process.env.PORTCOVE_TUF_HISTORICAL_ADAPTER_FIXTURE;
  if (!actualTool || !exported)
    return t.skip("explicit rebuilt Rust/public historical fixture required");
  const f = await fixture(t);
  // Overwrite the untrusted placeholder with exact public cryptographic bytes.
  // No operational key material is exported.
  await cp(path.join(exported, "prior"), f.prior, { recursive: true });
  await cp(path.join(exported, "trusted-root.json"), f.request.trusted_root);
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
  const request = {
    ...f.request,
    initial_root_profile: "single-owner-one-of-one-v1" as const,
    verifier: actualTool,
    verifier_sha256: sha(await readFile(actualTool)),
    trusted_root_sha256: sha(await readFile(f.request.trusted_root)),
    prior_repository_sha256: digest(files),
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
  await assert.rejects(prepareAuthenticatedMetadataRenewal(request));
  const receipt = await prepareAuthenticatedMetadataRenewal({
    ...request,
    prior_expiration_policy: "historical-online-expired-v1",
  });
  const bound = await inspectPreparedMetadataRenewal(receipt);
  assert.equal(bound.descriptor.schema_version, 3);
  assert.equal(bound.descriptor.prior_repository_sha256, digest(files));
  assert.equal(bound.descriptor.next_versions.timestamp, "2");
  const context = await readBoundedReleaseContextFiles(bound.prepared_root);
  assert.equal(applicationContextPriorRepositorySha256(context), digest(files));
  const parsed: unknown = JSON.parse(context.get("context.json")!.toString());
  assert.ok(isRecord(parsed));
  assert.equal(parsed.prior_expiration_policy, "historical-online-expired-v1");
  const floors = {
    ...bound.descriptor.current_versions,
    releases: "9007199254740993",
    preview: "9007199254740993",
    stable: "9007199254740993",
    snapshot: "9007199254740993",
    timestamp: "9007199254740993",
  };
  const reserved = await prepareAuthenticatedMetadataRenewal({
    ...request,
    prior_expiration_policy: "historical-online-expired-v1",
    previous_reserved_versions: floors,
  });
  const advanced = await inspectPreparedMetadataRenewal(reserved);
  assert.deepEqual(advanced.descriptor.reserved_version_floors, floors);
  assert.equal(advanced.descriptor.next_versions.timestamp, "9007199254740994");
  const advancedContext = applicationMetadataContextIdentity(
    await readBoundedReleaseContextFiles(advanced.prepared_root),
  );
  assert.equal(advancedContext.versions.timestamp, "9007199254740994");
});
