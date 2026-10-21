import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicationAuthorities } from "./release-authority-configuration.mts";
import { createHash } from "node:crypto";
import { sourceFixtureCommit } from "./fixtures/release-source-fixture.mts";
import {
  deriveMetadataBootstrapDescriptor,
  metadataBootstrapContextBytes,
  prepareAuthenticatedMetadataBootstrap,
  inspectPreparedMetadataBootstrap,
} from "./release-bootstrap-preparation.mts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectHistoricalBootstrapPreimage,
  readBootstrapPublicSource,
  readConfiguredBootstrapSite,
  readCatalogBootstrapPublicSource,
} from "./release-bootstrap-public-inputs.mts";

function publication() {
  const pin = (path: string) => ({ path, bytes: 123, sha256: "a".repeat(64) });
  return {
    public_source: {
      commit: "b".repeat(40),
      root: pin("public/root.json"),
      offline_targets: pin("public/targets.json"),
      payload_key_registry: pin("public/payload.json"),
      initial_site_preimage: { ...pin("public/initial-site.json"), sha256: "d".repeat(64) },
    },
    setup_plan_sha256: "c".repeat(64),
    initial_site_preimage_sha256: "d".repeat(64),
  };
}
void test("only schema2 can locate the exact historical owner-ratified setup preimage", () => {
  const value = publication();
  assert.deepEqual(inspectPublicationAuthorities(value, 2), value);
  assert.throws(() => inspectPublicationAuthorities(value), /schema2/);
  assert.throws(() => inspectPublicationAuthorities(value, 1), /schema2/);
  for (const pin of [
    { ...value.public_source.initial_site_preimage, sha256: "0".repeat(64) },
    { ...value.public_source.initial_site_preimage, path: value.public_source.root.path },
    { ...value.public_source.initial_site_preimage, path: "../initial.json" },
    { ...value.public_source.initial_site_preimage, bytes: 1048577 },
  ])
    assert.throws(() =>
      inspectPublicationAuthorities(
        { ...value, public_source: { ...value.public_source, initial_site_preimage: pin } },
        2,
      ),
    );
  const { initial_site_preimage: _initial, ...oldSource } = value.public_source;
  const legacy = { ...value, public_source: oldSource };
  assert.deepEqual(inspectPublicationAuthorities(legacy), legacy);
  assert.deepEqual(inspectPublicationAuthorities(legacy, 2), legacy);
});

void test("declared bootstrap context preserves exact u64 version and has no manufactured prior", async () => {
  const files = new Map([
    [
      "root",
      Buffer.from(JSON.stringify({ signed: { version: 1, expires: "2026-12-01T00:00:00Z" } })),
    ],
    [
      "offline_targets",
      Buffer.from('{"signed":{"version":18446744073709551615,"expires":"2026-11-01T00:00:00Z"}}'),
    ],
    ["payload_key_registry", Buffer.from("public registry")],
  ]);
  const value = publication();
  for (const name of ["root", "offline_targets", "payload_key_registry"] as const) {
    const bytes = files.get(name)!;
    value.public_source[name] = {
      ...value.public_source[name],
      bytes: bytes.length,
      sha256: sha(bytes),
    };
  }
  const descriptor = deriveMetadataBootstrapDescriptor(value, files, "2026-10-20T00:00:00Z");
  assert.equal(descriptor.versions.targets, "18446744073709551615");
  const serialized = metadataBootstrapContextBytes(descriptor).toString("utf8");
  assert.match(serialized, /"targets":18446744073709551615/u);
  assert(!serialized.includes("previous_repository"));
  assert.match(serialized, /"initial_bootstrap":"initial-bootstrap.json"/u);
  assert.equal(descriptor.expires.timestamp, "2026-10-22T00:00:00Z");
  files.set("root", Buffer.from("changed"));
  assert.throws(
    () => deriveMetadataBootstrapDescriptor(value, files, "2026-10-20T00:00:00Z"),
    /changed/,
  );
  await assert.rejects(
    inspectPreparedMetadataBootstrap({ kind: "authenticated-initial-metadata-preparation" }),
    /same-process/,
  );
});

void test("signed timestamp projection trims only trailing zeroes and preserves role-ceiling nanoseconds", () => {
  const files = new Map([
    ["root", Buffer.from('{"signed":{"version":1,"expires":"2027-01-01T00:00:00.123456700Z"}}')],
    [
      "offline_targets",
      Buffer.from('{"signed":{"version":1,"expires":"2026-12-01T00:00:00.380381600Z"}}'),
    ],
    ["payload_key_registry", Buffer.from("public registry")],
  ]);
  const original = [...files].map(([name, bytes]) => [name, sha(bytes)]);
  const value = publication();
  for (const name of ["root", "offline_targets", "payload_key_registry"] as const) {
    const bytes = files.get(name)!;
    value.public_source[name] = {
      ...value.public_source[name],
      bytes: bytes.length,
      sha256: sha(bytes),
    };
  }
  const descriptor = deriveMetadataBootstrapDescriptor(
    value,
    files,
    "2026-10-20T00:00:00.3803816Z",
  );
  assert.equal(descriptor.expires.targets, "2026-12-01T00:00:00.3803816Z");
  assert.equal(descriptor.expires.timestamp, "2026-10-22T00:00:00.3803816Z");
  assert.equal(descriptor.expires.preview, "2026-10-27T00:00:00.3803816Z");
  assert.deepEqual(
    [...files].map(([name, bytes]) => [name, sha(bytes)]),
    original,
  );
});

const actualTool = process.env.PORTCOVE_TUF_BOOTSTRAP_VERIFIER;
const actualFixture = process.env.PORTCOVE_TUF_INITIAL_PUBLIC_FIXTURE;
void test(
  "actual maintained keyless verifier authenticates disposable bootstrap and retained bytes",
  { skip: !actualTool || !actualFixture },
  async (t) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "bootstrap-tool-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const files = new Map<string, Buffer>();
    for (const [name, file] of [
      ["root", "trusted-root.json"],
      ["offline_targets", "offline-targets.json"],
      ["payload_key_registry", "payload.json"],
    ] as const)
      files.set(name, await readFile(path.join(actualFixture!, file)));
    const descriptor: unknown = JSON.parse(
      await readFile(path.join(actualFixture!, "initial-bootstrap.json"), "utf8"),
    );
    assert(
      typeof descriptor === "object" &&
        descriptor !== null &&
        "setup_plan_sha256" in descriptor &&
        "initial_site_preimage_sha256" in descriptor,
    );
    const value = publication();
    value.setup_plan_sha256 = String(descriptor.setup_plan_sha256);
    value.initial_site_preimage_sha256 = String(descriptor.initial_site_preimage_sha256);
    value.public_source.initial_site_preimage.sha256 = value.initial_site_preimage_sha256;
    for (const name of ["root", "offline_targets", "payload_key_registry"] as const) {
      const bytes = files.get(name)!;
      value.public_source[name] = {
        ...value.public_source[name],
        bytes: bytes.length,
        sha256: sha(bytes),
      };
    }
    const tool = await readFile(actualTool!);
    const receipt = await prepareAuthenticatedMetadataBootstrap({
      verifier: actualTool!,
      verifier_sha256: sha(tool),
      publication: value,
      public_files: files,
      descriptor,
      output_parent: parent,
      deadline: performance.now() + 60000,
    });
    const verified = await inspectPreparedMetadataBootstrap(receipt);
    assert.equal(verified.files.length, 6);
    assert.equal(verified.descriptor.versions.timestamp, "1");
    await writeFile(verified.context, "changed retained context");
    await assert.rejects(inspectPreparedMetadataBootstrap(receipt), /changed/);
  },
);

function preimage() {
  const origin = "https://boburning.github.io/portcove/";
  const provider = {
    owner_id: 43177418,
    repository_id: 1354613114,
    owner_repository_visibility: "repo-scope-with-admin-readback",
    project_site_status: 404,
    user_site_repository_status: 404,
  };
  return {
    schema_version: 1,
    kind: "unconfigured-application-site-preimage",
    observed_at: "2026-10-18T00:00:00.000Z",
    origin,
    observations: [
      { phase: "provider-before", ...provider },
      ...[
        "",
        "publication.json",
        "application/metadata/timestamp.json",
        "catalog/metadata/timestamp.json",
      ].map((route) => ({ phase: "public-route", url: new URL(route, origin).href, status: 404 })),
      { phase: "provider-after", ...provider },
    ],
    evidence_scope: "github.com",
    authority: "none",
    scope: "initial setup preimage only; no unlisted URL, historical absence or publication claim",
  };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const oid = (type: string, bytes: Buffer) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
void test("bootstrap paths are bound to reconstructed Git trees, exact raw blobs and historical ratified preimage", () => {
  const data = new Map([
    ["root.json", Buffer.from("root public bytes")],
    ["targets.json", Buffer.from("offline public bytes")],
    ["payload.json", Buffer.from("public registry")],
    ["preimage.json", Buffer.from(JSON.stringify(preimage()))],
  ]);
  const rows = [...data]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => ({ path, mode: "100644", type: "blob", sha: oid("blob", bytes) }));
  const tree = oid(
    "tree",
    Buffer.concat(
      rows.flatMap((row) => [Buffer.from(`100644 ${row.path}\0`), Buffer.from(row.sha, "hex")]),
    ),
  );
  const commit = sourceFixtureCommit(tree, [], "public setup\n");
  const pin = (path: string) => ({
    path,
    bytes: data.get(path)!.length,
    sha256: sha(data.get(path)!),
  });
  const value = {
    public_source: {
      commit: commit.sha,
      root: pin("root.json"),
      offline_targets: pin("targets.json"),
      payload_key_registry: pin("payload.json"),
      initial_site_preimage: pin("preimage.json"),
    },
    setup_plan_sha256: "c".repeat(64),
    initial_site_preimage_sha256: sha(data.get("preimage.json")!),
  };
  let fault = "";
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      let body: unknown;
      if (endpoint.endsWith(`/git/commits/${commit.sha}`)) body = commit;
      else if (endpoint.endsWith(`/git/trees/${tree}?recursive=1`))
        body = {
          sha: tree,
          truncated: fault === "truncated",
          tree: rows.map((row) =>
            fault === "mode" && row.path === "root.json" ? { ...row, mode: "120000" } : row,
          ),
        };
      else {
        const row = rows.find((row) => endpoint.endsWith(`/git/blobs/${row.sha}`));
        assert(row);
        const bytes = data.get(row.path)!;
        body = {
          sha: row.sha,
          size: bytes.length,
          encoding: "base64",
          content: (fault === "blob" ? Buffer.from("changed") : bytes).toString("base64"),
        };
      }
      return { status: 200, body, headers: new Map<string, string>() };
    },
  };
  const result = readBootstrapPublicSource(
    api,
    value,
    "2026-10-20T00:00:00Z",
    performance.now() + 10000,
  );
  assert.equal(result.api_reads, 6);
  assert.deepEqual(result.files.get("initial_site_preimage"), data.get("preimage.json"));
  const catalog = {
    schema_version: 1,
    kind: "catalog-publication-authorities",
    repository_id: 1354613114,
    namespace: "portcove-catalog",
    apps: {
      semantic: { app_id: 101, installation_id: 1001 },
      classification: { app_id: 202, installation_id: 1002 },
      protection_observer: { app_id: 303, installation_id: 1003 },
      coordinator_journal: { app_id: 404, installation_id: 1004 },
      dispatch: { app_id: 505, installation_id: 1005, actor_id: "123456" },
    },
    catalog: {
      public_source: {
        commit: commit.sha,
        root: pin("root.json"),
        offline_targets: pin("targets.json"),
        initial_site_preimage: pin("preimage.json"),
      },
      setup_plan_sha256: value.setup_plan_sha256,
      publisher_scope: [
        {
          namespace: "official",
          stable_id: "fixture",
          template: "portable",
          repository_id: null,
          artifact_hosts: [],
          max_redirects: 0,
          operations: [],
          policy_schemas: [1],
        },
      ],
    },
  };
  const catalogResult = readCatalogBootstrapPublicSource(
    api,
    catalog,
    "2026-10-20T00:00:00Z",
    performance.now() + 10000,
  );
  assert.equal(catalogResult.api_reads, 5);
  assert.equal(catalogResult.files.has("payload_key_registry"), false);
  assert.equal(catalogResult.authority, "none");
  assert.deepEqual(catalogResult.files.get("initial_site_preimage"), data.get("preimage.json"));
  const { initial_site_preimage: _catalogPreimage, ...noPreimage } = catalog.catalog.public_source;
  assert.throws(
    () =>
      readCatalogBootstrapPublicSource(
        api,
        { ...catalog, catalog: { ...catalog.catalog, public_source: noPreimage } },
        "2026-10-20T00:00:00Z",
        performance.now() + 10000,
      ),
    /explicit catalog/,
  );
  for (fault of ["mode", "truncated", "blob"]) {
    assert.throws(() =>
      readCatalogBootstrapPublicSource(
        api,
        catalog,
        "2026-10-20T00:00:00Z",
        performance.now() + 10000,
      ),
    );
    assert.throws(() =>
      readBootstrapPublicSource(api, value, "2026-10-20T00:00:00Z", performance.now() + 10000),
    );
  }
  assert.throws(
    () =>
      inspectHistoricalBootstrapPreimage(
        Buffer.from(JSON.stringify({ ...preimage(), evidence_scope: "injected-provider" })),
        "2026-10-20T00:00:00Z",
      ),
    /historical/,
  );
  assert.throws(
    () => inspectHistoricalBootstrapPreimage(data.get("preimage.json")!, "2026-10-17T00:00:00Z"),
    /historical/,
  );
});

void test("fresh bootstrap bracket uses configured Pages plus public404s without owner-wide reads", async () => {
  const repo = {
    id: 1354613114,
    full_name: "boburning/portcove",
    private: false,
    owner: { id: 43177418, login: "boburning" },
  };
  const pages = {
    url: "https://api.github.com/repos/boburning/portcove/pages",
    build_type: "workflow",
    html_url: "https://boburning.github.io/portcove/",
    cname: null,
    https_enforced: true,
    public: true,
  };
  const calls: string[] = [];
  let fault = "";
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      assert(["repos/boburning/portcove", "repos/boburning/portcove/pages"].includes(endpoint));
      const body = endpoint.endsWith("/pages")
        ? {
            ...pages,
            ...(fault === "cname"
              ? { cname: "other.invalid" }
              : fault === "https"
                ? { https_enforced: false }
                : fault === "legacy"
                  ? { build_type: "legacy" }
                  : {}),
          }
        : repo;
      return { status: 200, body, headers: new Map<string, string>() };
    },
  };
  const fakeFetch: typeof fetch = async (url) => {
    const response = new Response(null, { status: fault === "present" ? 200 : 404 });
    Object.defineProperty(response, "url", {
      value: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    });
    return response;
  };
  const result = await readConfiguredBootstrapSite(api, performance.now() + 10000, {
    fetch: fakeFetch,
  });
  assert.equal(result.public_routes.length, 4);
  assert.equal(calls.length, 4);
  assert.match(result.scope, /remains historical/);
  for (fault of ["cname", "https", "legacy", "present"])
    await assert.rejects(
      readConfiguredBootstrapSite(api, performance.now() + 10000, { fetch: fakeFetch }),
    );
  calls.length = 0;
  await assert.rejects(readConfiguredBootstrapSite(api, NaN, { fetch: fakeFetch }), /deadline/);
  assert.equal(calls.length, 0);
});
