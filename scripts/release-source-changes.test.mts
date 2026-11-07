import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCompilerSourceReader } from "./release-compiler-source.mts";
import {
  collectReleaseSourceChanges,
  collectReleaseSourceChangesWithSdk,
  inspectReleaseSourceTree,
  maximumApplicationSourceCommits,
  maximumApplicationSourceTreeEntries,
  maximumReleaseSourceCommits,
  netTreeDeltaScope,
  releaseSourceChangeRequests,
} from "./release-source-changes.mts";
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

void test("scoped SDK source comparison returns the same exact raw-tree evidence", async (t) => {
  const f = releaseSourceFixture();
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token inert-source-comparison");
      calls.push(url.href);
      const result = f.api.request("GET", url.pathname.slice(1) + url.search);
      return Response.json(result.body, {
        status: result.status ?? 200,
        headers: new Headers([...result.headers]),
      });
    },
  );
  const result = await collectReleaseSourceChangesWithSdk(
    {
      token: "inert-source-comparison",
      deadline: performance.now() + 5000,
      guard() {},
    },
    f.opportunity,
  );
  assert.deepEqual(result, collectReleaseSourceChanges(f.api, f.opportunity));
  assert.equal(calls.length, 5);
});

void test("application comparison refuses a raw merged-side commit omitted by the provider", async (t) => {
  const f = releaseSourceFixture();
  const side = sourceFixtureCommit(f.baseTree, [f.base.sha], "independent side\n");
  const source = sourceFixtureCommit(f.sourceTree, [f.base.sha, side.sha], "merged source\n");
  const applicationCommitObjects = new Map(
    [f.base, source, side].map((value) => [
      value.sha,
      inspectRemoteCommitObject(value, value.sha).object.bytes,
    ]),
  );
  let omitSide = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname, search } = new URL(new Request(input, init).url);
      if (pathname.endsWith(`/git/commits/${source.sha}`)) return Response.json(source);
      if (pathname.includes("/compare/")) {
        const selected = omitSide ? [source] : [side, source];
        return Response.json({
          status: "ahead",
          ahead_by: selected.length,
          behind_by: 0,
          total_commits: selected.length,
          base_commit: { sha: f.base.sha },
          merge_base_commit: { sha: f.base.sha },
          commits: selected.map((commit) => ({ sha: commit.sha, commit, parents: commit.parents })),
        });
      }
      return Response.json(f.api.request("GET", pathname.slice(1) + search).body);
    },
  );
  const collect = () =>
    collectReleaseSourceChangesWithSdk(
      {
        token: "inert-source-comparison",
        deadline: performance.now() + 5000,
        guard() {},
        applicationCommitObjects,
      },
      { ...f.opportunity, source_commit: source.sha },
    );
  assert.equal((await collect()).commits.length, 2);
  omitSide = true;
  await assert.rejects(collect(), /application Git history differs/u);
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

void test("retained public unsigned coordinator seed recovers the one terminal newline omitted by REST", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/github-unsigned-coordinator-seed-8e3f8e1b.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(fixture) && isRecord(fixture.record) && typeof fixture.raw === "string");
  const record = fixture.record;
  const expected = "8e3f8e1b7d2ab2f9e7b199c5bca27d75cc1d5760";
  assert.equal(record.message, "Portcove release coordinator checkpoint");
  assert.ok(fixture.raw.endsWith("checkpoint\n"));
  const result = inspectRemoteCommitObject(record, expected);
  assert.equal(result.object.oid, expected);
  assert.equal(result.object.bytes.toString("utf8"), fixture.raw);
  assert.equal(
    inspectRemoteCommitObject(
      { ...record, message: `${record.message}\n` },
      expected,
    ).object.bytes.toString("utf8"),
    fixture.raw,
  );
  for (const fault of ["message", "actor", "tree", "extra-newline"]) {
    const changed = structuredClone(record);
    assert.ok(isRecord(changed.author) && isRecord(changed.tree));
    if (fault === "message") changed.message = "changed";
    if (fault === "actor") changed.author.name = "changed";
    if (fault === "tree") changed.tree.sha = "f".repeat(40);
    if (fault === "extra-newline") changed.message = `${record.message}\n\n`;
    assert.throws(() => inspectRemoteCommitObject(changed, expected));
  }
  // Neither the extra header nor an unknown original offset is reconstructed.
  for (const raw of [
    fixture.raw.replace("\n\n", "\nencoding UTF-8\n\n"),
    fixture.raw.replaceAll(" +0000", " -0400"),
    `${fixture.raw}\n`,
  ]) {
    const bytes = Buffer.from(raw);
    const sha = createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex");
    assert.throws(() => inspectRemoteCommitObject({ ...record, sha }, sha));
  }
});

void test("unsigned commit reconstruction preserves exact no-newline and parent-order identities", () => {
  const tree = "a".repeat(40),
    parents = ["b".repeat(40), "c".repeat(40)];
  for (const message of ["without a newline", "with one newline\n"]) {
    const record = sourceFixtureCommit(tree, parents, message);
    assert.equal(inspectRemoteCommitObject(record, record.sha).object.oid, record.sha);
    assert.throws(() =>
      inspectRemoteCommitObject({ ...record, parents: [...record.parents].reverse() }, record.sha),
    );
  }
});

void test("a real pagination boundary retains all source ancestors without using the truncated comparison file inventory", () => {
  const f = releaseSourceFixture(101);
  const result = collectReleaseSourceChanges(f.api, f.opportunity);
  assert.equal(result.commits.length, 101);
  assert.equal(result.change_set_sha256, f.expectedHash);
  assert.equal(f.calls.filter((call) => call.includes("page=2")).length, 1);
});

void test("locked SDK source requests follow only the fixed numeric repository alias", async (t) => {
  let fixture = releaseSourceFixture(101);
  let repositoryId = 1354613114;
  const seen: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "token exact-release-source");
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      seen.push(url.pathname);
      const mapped = request.url.replace("/repositories/1354613114/", "/repos/boburning/portcove/");
      const response = fixture.api.request(request.method, mapped);
      const link = response.headers.get("link");
      return Response.json(response.body, {
        headers: link
          ? { link: link.replace("/repos/boburning/portcove/", `/repositories/${repositoryId}/`) }
          : {},
      });
    },
  );
  const run = async () => {
    const deadline = performance.now() + 5_000;
    const read = await createCompilerSourceReader({
      credential: { kind: "explicit", token: "exact-release-source" },
      deadline,
      maxBytes: 4 * 1024 * 1024,
    });
    const requests = releaseSourceChangeRequests(fixture.opportunity, { deadline });
    let step = requests.next();
    while (!step.done) step = requests.next(await read(step.value.endpoint, step.value.deadline));
    return step.value;
  };
  const result = await run();
  assert.equal(result.commits.length, 101);
  assert.equal(result.change_set_sha256, fixture.expectedHash);
  assert.ok(seen.some((route) => route.startsWith("/repositories/1354613114/compare/")));
  repositoryId++;
  fixture = releaseSourceFixture(101);
  seen.length = 0;
  await assert.rejects(run(), /escaped its fixed comparison/u);
  assert.equal(seen.length, 3);
});

void test("complete accumulated history reaches the finite commit boundary and refuses overflow", () => {
  const legacyOverflow = releaseSourceFixture(maximumReleaseSourceCommits + 1);
  assert.throws(
    () => collectReleaseSourceChanges(legacyOverflow.api, legacyOverflow.opportunity),
    /completeness/u,
  );
  const full = releaseSourceFixture(maximumApplicationSourceCommits);
  const result = collectReleaseSourceChanges(full.api, full.opportunity, {
    applicationComparison: true,
  });
  assert.equal(result.commits.length, maximumApplicationSourceCommits);
  assert.equal(result.change_set_sha256, full.expectedHash);
  const lastPage = Math.ceil(maximumApplicationSourceCommits / 100);
  const overflowPage = lastPage + 1;
  assert.equal(result.api_requests, lastPage + 4);
  assert.equal(full.calls.filter((call) => call.includes(`page=${lastPage}`)).length, 1);
  const overflow = releaseSourceFixture(maximumApplicationSourceCommits + 1);
  assert.throws(
    () =>
      collectReleaseSourceChanges(overflow.api, overflow.opportunity, {
        applicationComparison: true,
      }),
    /completeness/,
  );
  assert.equal(overflow.calls.filter((call) => call.includes("/compare/")).length, 1);
  for (const fault of ["page-overflow", "changed-total"]) {
    const fixture = releaseSourceFixture(maximumApplicationSourceCommits);
    const api = {
      request(method: string, endpoint: string) {
        const response = fixture.api.request(method, endpoint);
        if (fault === "page-overflow" && endpoint.includes(`page=${lastPage}`)) {
          return {
            ...response,
            headers: new Map(response.headers).set(
              "link",
              `<${endpoint.replace(`page=${lastPage}`, `page=${overflowPage}`)}>; rel="next"`,
            ),
          };
        }
        if (fault === "changed-total" && endpoint.includes("page=2")) {
          assert.ok(isRecord(response.body));
          response.body.total_commits = maximumApplicationSourceCommits - 1;
          response.body.ahead_by = maximumApplicationSourceCommits - 1;
        }
        return response;
      },
    };
    assert.throws(
      () => collectReleaseSourceChanges(api, fixture.opportunity, { applicationComparison: true }),
      /pagination|changed/,
    );
    assert.ok(fixture.calls.every((endpoint) => !endpoint.includes(`page=${overflowPage}`)));
  }
});

void test("cryptographic tree reconstruction reaches its finite entry boundary and refuses overflow", () => {
  const gitOid = (kind: string, bytes: Buffer) =>
    createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
  const blob = gitOid("blob", Buffer.from("fixture"));
  const paths = Array.from(
    { length: maximumApplicationSourceTreeEntries - 2 },
    (_, index) => `folder${index % 2}/entry${String(index).padStart(4, "0")}`,
  );
  const rows = paths.map((path) => ({ path, mode: "100644", type: "blob", sha: blob }));
  for (const directory of ["folder0", "folder1"]) {
    const bytes = Buffer.concat(
      rows
        .filter((entry) => entry.path.startsWith(`${directory}/`))
        .map((entry) =>
          Buffer.concat([
            Buffer.from(`100644 ${entry.path.split("/")[1]}\0`),
            Buffer.from(blob, "hex"),
          ]),
        ),
    );
    rows.push({ path: directory, mode: "040000", type: "tree", sha: gitOid("tree", bytes) });
  }
  const root = Buffer.concat(
    rows
      .filter((entry) => entry.type === "tree")
      .map((entry) =>
        Buffer.concat([Buffer.from(`40000 ${entry.path}\0`), Buffer.from(entry.sha, "hex")]),
      ),
  );
  const sha = gitOid("tree", root);
  assert.equal(
    inspectReleaseSourceTree({ sha, truncated: false, tree: rows }, sha, true).entries.size,
    maximumApplicationSourceTreeEntries,
  );
  assert.throws(
    () => inspectReleaseSourceTree({ sha, truncated: false, tree: [...rows, rows[0]] }, sha, true),
    /oversized/u,
  );
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
