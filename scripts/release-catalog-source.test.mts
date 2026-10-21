import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { sourceFixtureCommit } from "./fixtures/release-source-fixture.mts";
import { readCatalogPublicationSourceBytes } from "./release-catalog-source.mts";

const oid = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
function fixture(
  options: {
    absent?: boolean;
    extra?: boolean;
    missingRequest?: boolean;
    executable?: boolean;
  } = {},
) {
  const data = new Map<string, Buffer>([["README.md", Buffer.from("inert source\n")]]);
  const prefix = "release/catalog-publication/";
  if (!options.absent) {
    data.set(
      `${prefix}bundle/definitions/index.json`,
      Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}'),
    );
    if (!options.missingRequest)
      data.set(
        `${prefix}request.json`,
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            kind: "catalog-publication",
            compatibility: {
              contract: "official-definition-policy-launch-v1",
              notes: "inert explicit empty bootstrap for contract fixture",
            },
          }),
        ),
      );
    if (options.extra)
      data.set(`${prefix}candidate.mjs`, Buffer.from('throw Error("must never execute")'));
  }
  type Row = { path: string; mode: string; type: string; sha: string };
  const rows: Row[] = [];
  const blobs = new Map<string, Buffer>();
  for (const [name, bytes] of data) {
    const sha = oid("blob", bytes);
    blobs.set(sha, bytes);
    rows.push({
      path: name,
      mode: options.executable && name.endsWith("request.json") ? "100755" : "100644",
      type: "blob",
      sha,
    });
  }
  const directories = new Set<string>([""]);
  for (const name of data.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  let root = "";
  for (const directory of [...directories].sort(
    (a, b) => b.split("/").length - a.split("/").length || b.length - a.length,
  )) {
    const children = rows.filter(
      (row) =>
        row.path.slice(0, row.path.lastIndexOf("/") === -1 ? 0 : row.path.lastIndexOf("/")) ===
        directory,
    );
    children.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.path.split("/").at(-1)! + (a.type === "tree" ? "/" : "")),
        Buffer.from(b.path.split("/").at(-1)! + (b.type === "tree" ? "/" : "")),
      ),
    );
    const bytes = Buffer.concat(
      children.map((row) =>
        Buffer.concat([
          Buffer.from(
            `${row.type === "tree" ? "40000" : row.mode} ${row.path.split("/").at(-1)!}\0`,
          ),
          Buffer.from(row.sha, "hex"),
        ]),
      ),
    );
    const sha = oid("tree", bytes);
    if (directory) rows.push({ path: directory, mode: "040000", type: "tree", sha });
    else root = sha;
  }
  const commit = sourceFixtureCommit(root, [], "inert catalog authoring fixture\n");
  let fault = "";
  const calls: string[] = [];
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      let body: unknown;
      if (endpoint.endsWith(`/git/commits/${commit.sha}`)) body = commit;
      else if (endpoint.endsWith(`/git/trees/${root}?recursive=1`))
        body = { sha: root, truncated: fault === "truncated", tree: rows };
      else {
        const sha = endpoint.split("/").at(-1)!;
        const bytes = blobs.get(sha);
        assert.ok(bytes);
        body = {
          sha,
          encoding: "base64",
          size: bytes.length,
          content: (fault === "blob" ? Buffer.from("forged") : bytes).toString("base64"),
        };
      }
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  return {
    api,
    commit,
    calls,
    fault(value: string) {
      fault = value;
    },
  };
}

void test("catalog authoring source freezes raw Git bundle without executing or admitting it", () => {
  const f = fixture();
  const result = readCatalogPublicationSourceBytes(f.api, f.commit.sha, performance.now() + 10000);
  assert.equal(result.source.tree, f.commit.tree.sha);
  assert.equal(result.authority, "none");
  assert.equal(result.api_reads, 4);
  assert.deepEqual([...result.files.keys()], ["definitions/index.json"]);
  assert.equal(result.request?.compatibility.contract, "official-definition-policy-launch-v1");
  assert.equal(
    f.calls.some((call) => call.includes("contents/")),
    false,
  );
  assert.equal(
    result.files.get("definitions/index.json")?.toString(),
    '{"index_schema":1,"definitions":[],"contents":[]}',
  );
});
void test("missing catalog authoring request is exact-tree absence; partial source and extra/executable files refuse", () => {
  const absent = fixture({ absent: true });
  const result = readCatalogPublicationSourceBytes(
    absent.api,
    absent.commit.sha,
    performance.now() + 10000,
  );
  assert.equal(result.request, null);
  assert.equal(result.api_reads, 2);
  for (const option of [{ missingRequest: true }, { extra: true }, { executable: true }]) {
    const f = fixture(option);
    assert.throws(() =>
      readCatalogPublicationSourceBytes(f.api, f.commit.sha, performance.now() + 10000),
    );
  }
});
void test("catalog source refuses provider truncation, changed raw blobs and expired original deadline", () => {
  for (const fault of ["truncated", "blob"]) {
    const f = fixture();
    f.fault(fault);
    assert.throws(() =>
      readCatalogPublicationSourceBytes(f.api, f.commit.sha, performance.now() + 10000),
    );
  }
  const f = fixture();
  assert.throws(
    () => readCatalogPublicationSourceBytes(f.api, f.commit.sha, performance.now() - 1),
    /original deadline/,
  );
  assert.equal(f.calls.length, 0);
});
