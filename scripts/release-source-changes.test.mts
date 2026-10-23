import assert from "node:assert/strict";
import test from "node:test";
import { collectReleaseSourceChanges, netTreeDeltaScope } from "./release-source-changes.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { sourceFixtureCommit } from "./fixtures/release-source-fixture.mts";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { isRecord } from "./runtime-values.mts";

void test("complete source comparison uses reconstructed trees rather than GitHub's bounded comparison file list", () => {
  const f = releaseSourceFixture();
  const result = collectReleaseSourceChanges(f.api, f.opportunity);
  const { commits, api_requests, qualification, authority, change_set_sha256, ...delta } = result;
  assert.deepEqual(delta, f.expectedDelta);
  assert.equal(change_set_sha256, f.expectedHash);
  assert.equal(result.scope, netTreeDeltaScope);
  assert.equal(commits.length, 1);
  assert.equal(api_requests, 5);
  assert.equal(authority, "none");
  assert.match(qualification, /no semantic classification/u);
});

void test("retained public signed GitHub commit preserves non-UTC offsets and terminal signature folding only under its exact raw hash", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/github-signed-commit-799da578.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(fixture) && isRecord(fixture.record));
  const record = fixture.record;
  const expected = "799da5783d339b61748de78c372c746f3011164b";
  const result = inspectRemoteCommitObject(record, expected);
  assert.equal(result.object.oid, expected);
  assert.equal(result.object.bytes.length, 1352);
  assert.match(result.object.bytes.toString("utf8"), / -0400\ncommitter /u);
  assert.match(result.object.bytes.toString("utf8"), /-----END PGP SIGNATURE-----\n \n\n/u);
  for (const fault of ["offset", "signature", "message", "actor", "extra-header"]) {
    const changed = structuredClone(record);
    assert.ok(
      isRecord(changed.verification) &&
        typeof changed.verification.payload === "string" &&
        typeof changed.verification.signature === "string" &&
        isRecord(changed.author),
    );
    changed.verification.verified = true;
    const payload = changed.verification.payload;
    if (fault === "offset") changed.verification.payload = payload.replaceAll(" -0400", " +0000");
    if (fault === "signature") changed.verification.signature += "changed";
    if (fault === "message") changed.message = "changed";
    if (fault === "actor") changed.author.date = "2026-10-18T00:00:00Z";
    if (fault === "extra-header")
      changed.verification.payload = payload.replace("\n\n", "\nencoding invented\n\n");
    assert.throws(() => inspectRemoteCommitObject(changed, expected));
  }
});

void test("a real pagination boundary retains all source ancestors without using the truncated comparison file inventory", () => {
  const f = releaseSourceFixture(101);
  const result = collectReleaseSourceChanges(f.api, f.opportunity);
  assert.equal(result.commits.length, 101);
  assert.equal(result.change_set_sha256, f.expectedHash);
  assert.equal(f.calls.filter((call) => call.includes("page=2")).length, 1);
});

void test("complete accumulated history reaches the finite 2048-commit boundary and refuses overflow", () => {
  const full = releaseSourceFixture(2048);
  const result = collectReleaseSourceChanges(full.api, full.opportunity);
  assert.equal(result.commits.length, 2048);
  assert.equal(result.change_set_sha256, full.expectedHash);
  assert.equal(result.api_requests, 25);
  assert.equal(full.calls.filter((call) => call.includes("page=21")).length, 1);
  const overflow = releaseSourceFixture(2049);
  assert.throws(
    () => collectReleaseSourceChanges(overflow.api, overflow.opportunity),
    /completeness/,
  );
  assert.equal(overflow.calls.filter((call) => call.includes("/compare/")).length, 1);
  for (const fault of ["page-overflow", "changed-total"]) {
    const fixture = releaseSourceFixture(2048);
    const api = {
      request(method: string, endpoint: string) {
        const response = fixture.api.request(method, endpoint);
        if (fault === "page-overflow" && endpoint.includes("page=21")) {
          return {
            ...response,
            headers: new Map(response.headers).set(
              "link",
              `<${endpoint.replace("page=21", "page=22")}>; rel="next"`,
            ),
          };
        }
        if (fault === "changed-total" && endpoint.includes("page=2")) {
          assert.ok(isRecord(response.body));
          response.body.total_commits = 2047;
          response.body.ahead_by = 2047;
        }
        return response;
      },
    };
    assert.throws(
      () => collectReleaseSourceChanges(api, fixture.opportunity),
      /pagination|changed/,
    );
    assert.ok(fixture.calls.every((endpoint) => !endpoint.includes("page=22")));
  }
});

void test("truncated/diverged/duplicate/escaping comparisons and forged incomplete trees refuse", () => {
  for (const fault of [
    "truncated",
    "diverged",
    "duplicate",
    "escape",
    "tree-forgery",
    "tree-omission",
    "tree-truncated",
  ]) {
    const f = releaseSourceFixture(101);
    f.faults.value = fault;
    assert.throws(() => collectReleaseSourceChanges(f.api, f.opportunity));
    assert.ok(f.calls.every((call) => !call.includes("/releases")));
  }
});

void test("real Git trees fix directory byte ordering, additions/deletions, executable modes and opaque symlink/gitlink deltas", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-source-git-"));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "portcove-source-git-")));
    return rm(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
  const git = (args: string[], input: string) =>
    execFileSync("git", ["-C", root, ...args], {
      input,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  const oldBlob = git(["hash-object", "-w", "--stdin"], "old\n");
  const newBlob = git(["hash-object", "-w", "--stdin"], "new\n");
  const tree = (entries: { path: string; mode: string; type: string; sha: string }[]) =>
    git(
      ["mktree", "--missing"],
      entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\n`).join(""),
    );
  const oldChild = { path: "old", mode: "100644", type: "blob", sha: oldBlob };
  const newChild = { path: "new", mode: "100644", type: "blob", sha: oldBlob };
  const oldRows = [
    { path: "a", mode: "040000", type: "tree", sha: tree([oldChild]) },
    { path: "a.txt", mode: "100644", type: "blob", sha: oldBlob },
    { path: "link", mode: "120000", type: "blob", sha: oldBlob },
    { path: "module", mode: "160000", type: "commit", sha: "1".repeat(40) },
  ];
  const newRows = [
    { path: "a", mode: "040000", type: "tree", sha: tree([newChild]) },
    { path: "b.sh", mode: "100755", type: "blob", sha: newBlob },
    { path: "link", mode: "120000", type: "blob", sha: newBlob },
    { path: "module", mode: "160000", type: "commit", sha: "2".repeat(40) },
  ];
  const oldTree = tree(oldRows);
  const newTree = tree(newRows);
  const base = sourceFixtureCommit(oldTree, [], "real Git tree base\n");
  const source = sourceFixtureCommit(newTree, [base.sha], "real Git tree source\n");
  const response = (body: unknown) => ({ status: 200, body, headers: new Map<string, string>() });
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      const route = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      ).pathname;
      if (route.endsWith(`/git/commits/${base.sha}`)) return response(base);
      if (route.endsWith(`/git/commits/${source.sha}`)) return response(source);
      if (route.endsWith(`/git/trees/${oldTree}`))
        return response({
          sha: oldTree,
          truncated: false,
          tree: [...oldRows, { ...oldChild, path: "a/old" }],
        });
      if (route.endsWith(`/git/trees/${newTree}`))
        return response({
          sha: newTree,
          truncated: false,
          tree: [...newRows, { ...newChild, path: "a/new" }],
        });
      if (route.includes("/compare/"))
        return response({
          status: "ahead",
          total_commits: 1,
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: base.sha },
          merge_base_commit: { sha: base.sha },
          commits: [{ sha: source.sha, commit: source, parents: source.parents }],
        });
      assert.fail(`unexpected tree fixture route ${route}`);
    },
  };
  const result = collectReleaseSourceChanges(api, {
    base_commit: base.sha,
    source_commit: source.sha,
    source_tree: newTree,
  });
  assert.deepEqual(
    result.changes.map((change) => change.path),
    ["a", "a.txt", "a/new", "a/old", "b.sh", "link", "module"],
  );
  assert.equal(result.changes.find((change) => change.path === "b.sh")?.after?.mode, "100755");
  assert.equal(result.changes.find((change) => change.path === "link")?.after?.mode, "120000");
  assert.equal(result.changes.find((change) => change.path === "module")?.after?.type, "commit");
  assert.equal(result.changes.find((change) => change.path === "a/old")?.after, null);
  assert.equal(result.changes.find((change) => change.path === "a/new")?.before, null);
});
