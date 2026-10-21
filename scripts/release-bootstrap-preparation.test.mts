import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicationAuthorities } from "./release-authority-configuration.mts";
import { createHash } from "node:crypto";
import { sourceFixtureCommit } from "./fixtures/release-source-fixture.mts";
import {
  inspectHistoricalBootstrapPreimage,
  readBootstrapPublicSource,
  readConfiguredBootstrapSite,
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
  for (fault of ["mode", "truncated", "blob"])
    assert.throws(() =>
      readBootstrapPublicSource(api, value, "2026-10-20T00:00:00Z", performance.now() + 10000),
    );
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
