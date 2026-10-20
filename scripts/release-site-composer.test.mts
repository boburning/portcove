import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { capacityDigest } from "./release-capacity.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import {
  composeSiteFiles,
  assembleAuthenticatedApplicationSite,
} from "./release-site-composer.mts";

void test("publication fact parsing retains exact u64 versions and rejects incomplete or authority-bearing reports", () => {
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"];
  const facts = {
    schema_version: 1,
    root_sha256: "a".repeat(64),
    offline_targets_sha256: "b".repeat(64),
    repository_sha256: "c".repeat(64),
    timestamp_sha256: "d".repeat(64),
    snapshot_sha256: "e".repeat(64),
    records_sha256: "f".repeat(64),
    versions: Object.fromEntries(roles.map((role) => [role, "9007199254740993"])),
    expires: Object.fromEntries(roles.map((role) => [role, "2026-10-22T18:18:04.2946935Z"])),
  };
  assert.equal(inspectTufPublicationFacts(facts).versions.snapshot, "9007199254740993");
  assert.throws(() => inspectTufPublicationFacts({ ...facts, accepted: true }));
  assert.throws(() => inspectTufPublicationFacts({ ...facts, repository_sha256: null }));
  assert.throws(() =>
    inspectTufPublicationFacts({
      ...facts,
      versions: { ...facts.versions, snapshot: 9007199254740992 },
    }),
  );
});

const actualTool = process.env.PORTCOVE_TUF_RENEWAL_ADAPTER_TOOL;
const actualFixture = process.env.PORTCOVE_TUF_RENEWAL_ADAPTER_FIXTURE;
void test(
  "actual pinned Rust assembly supplies publication facts bound to complete public site bytes",
  {
    skip: !actualTool || !actualFixture,
    timeout: 120000,
  },
  async (t) => {
    assert.ok(actualTool && actualFixture);
    const f = await fixture(t);
    const input = path.join(f.root, "public");
    await cp(actualFixture, input, { recursive: true });
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const composed = await assembleAuthenticatedApplicationSite({
      input_root: input,
      context: path.join(input, "context.json"),
      signed_roles: path.join(input, "envelopes"),
      trusted_root_sha256: hash(await readFile(path.join(input, "trusted-root.json"))),
      verifier: actualTool,
      verifier_sha256: hash(await readFile(actualTool)),
      previous_site: null,
      expected_previous_generation: null,
      output_parent: f.output,
    });
    assert.ok(composed.publication);
    assert.equal(composed.publication.versions.snapshot, "2");
    assert.equal(
      composed.publication.timestamp_sha256,
      hash(await readFile(path.join(composed.output, "application/metadata/timestamp.json"))),
    );
  },
);

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const output = path.join(root, "out");
  await mkdir(path.join(app, "metadata"), { recursive: true });
  await mkdir(path.join(app, "targets"));
  await mkdir(output);
  for (const [name, text] of [
    ["metadata/timestamp.json", "inert timestamp1"],
    ["metadata/1.root.json", "inert original root"],
    ["metadata/1.snapshot.json", "inert snapshot1"],
    ["targets/abcd.record.json", "immutable inert target"],
    ["repository-manifest.json", "internal inventory"],
  ])
    await writeFile(path.join(app, name!), text!);
  const request = {
    previous: null,
    expected_previous_generation: null,
    application: app,
    application_root_sha256: "a".repeat(64),
    output_parent: output,
  };
  return { root, app, output, request };
}

void test("file composition preserves exact catalog subtree and application history across a new generation", async (t) => {
  // Filesystem protocol test only; these inert bytes are not TUF signatures.
  const f = await fixture(t);
  const initial = await composeSiteFiles(f.request);
  assert.equal(initial.authority, "none");
  await mkdir(path.join(initial.output, "catalog", "metadata"), { recursive: true });
  const catalog = Buffer.from("separately authenticated catalog fixture bytes\n");
  await writeFile(path.join(initial.output, "catalog", "metadata", "root.json"), catalog);
  // Controlled fixture supplies an independently expected prior generation
  // after a separate catalog publisher; no real catalog authority is claimed.
  const { generation: _old, ...base } = initial.generation;
  base.files.push({
    path: "catalog/metadata/root.json",
    bytes: catalog.length,
    sha256: createHash("sha256").update(catalog).digest("hex"),
  });
  base.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const expected = capacityDigest(base);
  await writeFile(
    path.join(initial.output, "publication.json"),
    JSON.stringify({ ...base, generation: expected }),
  );
  await writeFile(path.join(f.app, "metadata", "timestamp.json"), "inert timestamp2");
  await writeFile(path.join(f.app, "metadata", "2.snapshot.json"), "inert snapshot2");
  const next = await composeSiteFiles({
    ...f.request,
    previous: initial.output,
    expected_previous_generation: expected,
  });
  assert.equal(next.generation.previous_generation, expected);
  assert.notEqual(next.generation.generation, expected);
  assert.deepEqual(
    await readFile(path.join(next.output, "catalog", "metadata", "root.json")),
    catalog,
  );
  assert.equal(
    await readFile(path.join(next.output, "application", "metadata", "1.root.json"), "utf8"),
    "inert original root",
  );
  assert.equal(
    await readFile(path.join(next.output, "application", "targets", "abcd.record.json"), "utf8"),
    "immutable inert target",
  );
  assert.equal(
    await readFile(path.join(next.output, "application", "metadata", "timestamp.json"), "utf8"),
    "inert timestamp2",
  );
  assert.ok(
    !next.generation.files.some(
      ({ path: name }) => name === "application/repository-manifest.json",
    ),
  );
});

void test("stale prior generation and changed or missing immutable application bytes refuse before publication", async (t) => {
  const f = await fixture(t);
  const prior = await composeSiteFiles(f.request);
  const request = {
    ...f.request,
    previous: prior.output,
    expected_previous_generation: prior.generation.generation,
  };
  const unchanged = await composeSiteFiles(request);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.output, prior.output);
  assert.equal(unchanged.generation.generation, prior.generation.generation);
  await assert.rejects(
    composeSiteFiles({ ...request, expected_previous_generation: "b".repeat(64) }),
    /prior site generation/u,
  );
  await writeFile(path.join(f.app, "targets", "abcd.record.json"), "changed target");
  await assert.rejects(composeSiteFiles(request), /immutable application history/u);
  await rm(path.join(f.app, "targets", "abcd.record.json"));
  await assert.rejects(composeSiteFiles(request), /immutable application history/u);
  await writeFile(
    path.join(prior.output, "application", "metadata", "1.root.json"),
    "changed retained root",
  );
  await assert.rejects(composeSiteFiles(request), /prior site bytes/u);
  assert.equal((await readdir(f.output)).length, 1);
});

void test("linked inputs, unowned content and output overlap cannot erase or expand the publication", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    composeSiteFiles({ ...f.request, output_parent: f.app }),
    /mutate its input/u,
  );
  const external = path.join(f.root, "external");
  await writeFile(external, "retained external canary");
  await link(external, path.join(f.app, "targets", "linked"));
  await assert.rejects(composeSiteFiles(f.request), /single-link/u);
  await rm(path.join(f.app, "targets", "linked"));
  await writeFile(path.join(f.app, "unexpected.txt"), "preserve unknown component");
  await assert.rejects(composeSiteFiles(f.request), /unexpected publication content/u);
  assert.equal(await readFile(external, "utf8"), "retained external canary");
  assert.deepEqual(await readdir(f.output), []);
});

void test("authenticated entry rejects wrong public root or tool before executing an arbitrary verifier", async (t) => {
  const f = await fixture(t);
  const inputs = path.join(f.root, "public");
  await mkdir(inputs);
  await mkdir(path.join(inputs, "roles"));
  await cp(f.app, path.join(inputs, "previous"), { recursive: true });
  await mkdir(path.join(inputs, "records"));
  const root = Buffer.from("inert public root");
  await writeFile(path.join(inputs, "root.json"), root);
  await writeFile(path.join(inputs, "offline.json"), "{}");
  await writeFile(path.join(inputs, "registry.json"), "{}");
  const context = path.join(inputs, "context.json");
  await writeFile(
    context,
    JSON.stringify({
      schema_version: 1,
      trusted_root: "root.json",
      offline_targets: "offline.json",
      payload_key_registry: "registry.json",
      reconstructed_records: "records",
      previous_repository: "previous",
    }),
  );
  const request = {
    input_root: inputs,
    context,
    signed_roles: path.join(inputs, "roles"),
    trusted_root_sha256: "0".repeat(64),
    verifier: process.execPath,
    verifier_sha256: "0".repeat(64),
    previous_site: null,
    expected_previous_generation: null,
    output_parent: f.output,
  };
  await assert.rejects(
    assembleAuthenticatedApplicationSite(request),
    /independent application root/u,
  );
  await assert.rejects(
    assembleAuthenticatedApplicationSite({
      ...request,
      trusted_root_sha256: createHash("sha256").update(root).digest("hex"),
    }),
    /trusted keyless verifier changed/u,
  );
  assert.deepEqual(await readdir(f.output), []);
});
