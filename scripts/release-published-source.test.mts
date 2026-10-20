import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { inspectPublishedApplicationSource } from "./release-published-source.mts";
import { readSemanticPublicationBaseline } from "./release-semantic-inputs.mts";
import { isRecord } from "./runtime-values.mts";

async function fixture(t: test.TestContext, extraCodeChange = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "published-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
    );
  git(["init", "--quiet"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  for (const [filename, bytes] of Object.entries({
    "Cargo.toml":
      '[workspace]\nmembers = ["crates/example"]\n[workspace.package]\nversion = "0.1.0-alpha.2"\n',
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0-alpha.2"\n',
    "crates/example/Cargo.toml": '[package]\nname = "example"\nversion.workspace = true\n',
    "apps/desktop/package.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "app.rs": "original application\n",
  })) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), bytes);
  }
  git(["add", "."]);
  git(["commit", "-qm", "original source"]);
  const source = git(["rev-parse", "HEAD"]).trim();
  const sourceTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const prepared = await prepareReleaseVersion(
    root,
    {
      source_commit: source,
      reviewed_commit: source,
      source_tree: sourceTree,
      reviewed_tree: sourceTree,
      change_set_sha256: "c".repeat(64),
      base_version: "0.1.0-alpha.2",
      change: "prerelease",
      compatibility: "compatible",
    },
    ["0.1.0-alpha.2"],
  );
  if (extraCodeChange) {
    git(["read-tree", prepared.prepared_tree]);
    await writeFile(path.join(root, "app.rs"), "unreviewed extra prepared code\n");
    git(["add", "app.rs"]);
    const tree = git(["write-tree"]).trim();
    const raw = git(["cat-file", "commit", prepared.prepared_commit]).replace(
      /^tree [a-f0-9]{40}/u,
      `tree ${tree}`,
    );
    const id = execFileSync("git", ["-C", root, "hash-object", "-w", "-t", "commit", "--stdin"], {
      input: raw,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    prepared.prepared_commit = id;
    prepared.prepared_tree = tree;
  }
  const namespace = "portcove-fixture";
  const refs = new Map([
    [`v${prepared.version}`, prepared.prepared_commit],
    [`${namespace}-prepared/v${prepared.version}`, prepared.prepared_commit],
    [`${namespace}-prepared-source/${source}`, prepared.prepared_commit],
  ]);
  let fault = "";
  const calls: string[] = [];
  const commit = (id: string) => {
    const raw = git(["cat-file", "commit", id]);
    const split = raw.indexOf("\n\n");
    const headers = raw.slice(0, split).split("\n");
    const actor = (kind: string) => {
      const match = new RegExp(`^${kind} (.+) <([^>]+)> ([0-9]+) \\+0000$`, "u").exec(
        headers.find((line) => line.startsWith(`${kind} `))!,
      );
      assert.ok(match);
      return {
        name: match[1]!,
        email: match[2]!,
        date: new Date(Number(match[3]) * 1000).toISOString().replace(".000Z", "Z"),
      };
    };
    return {
      sha: id,
      tree: { sha: headers[0]!.slice(5) },
      parents: headers
        .filter((line) => line.startsWith("parent "))
        .map((line) => ({ sha: line.slice(7) })),
      author: actor("author"),
      committer: actor("committer"),
      message: raw.slice(split + 2),
    };
  };
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      const url = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      );
      const route = url.pathname.replace("/repos/boburning/portcove/", "");
      let body: unknown;
      let status = 200;
      if (route === "releases/42")
        body = {
          id: 42,
          tag_name: `v${prepared.version}`,
          draft: false,
          published_at: "2026-10-20T01:00:00Z",
        };
      else if (route.startsWith("git/ref/tags/")) {
        const name = decodeURIComponent(route.slice("git/ref/tags/".length));
        let sha = refs.get(name);
        if (fault === "wrong-source-ref" && name.includes("-prepared-source/")) sha = source;
        if (
          fault === "tag-drift" &&
          name === `v${prepared.version}` &&
          calls.filter((entry) => entry.includes(`/git/ref/tags/v${prepared.version}`)).length > 1
        )
          sha = source;
        if (sha) body = { ref: `refs/tags/${name}`, object: { type: "commit", sha } };
        else {
          status = 404;
          body = { message: "Not Found" };
        }
      } else if (route.startsWith("git/commits/"))
        body = commit(route.slice("git/commits/".length));
      else if (route.startsWith("git/trees/")) {
        const id = route.slice("git/trees/".length);
        const entries = git(["ls-tree", "-r", "-t", "-z", id])
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(line);
            assert.ok(match);
            return { mode: match[1]!, type: match[2]!, sha: match[3]!, path: match[4]! };
          });
        body = { sha: id, tree: entries, truncated: fault === "truncated" };
      } else if (route.startsWith("contents/")) {
        const filename = route.slice("contents/".length);
        const id = url.searchParams.get("ref");
        assert.equal(id, source);
        const bytes = Buffer.from(git(["show", `${id}:${filename}`]));
        body = {
          type: "file",
          path: filename,
          sha: git(["rev-parse", `${id}:${filename}`]).trim(),
          size: bytes.length,
          encoding: "base64",
          content: (fault === "blob-tamper" ? Buffer.alloc(bytes.length, 120) : bytes).toString(
            "base64",
          ),
        };
      } else if (route === `compare/${source}...${prepared.prepared_commit}`) {
        const value = commit(prepared.prepared_commit);
        body = {
          total_commits: 1,
          ahead_by: 1,
          behind_by: 0,
          status: "ahead",
          base_commit: { sha: source },
          merge_base_commit: { sha: source },
          commits: [{ sha: value.sha, commit: value, parents: value.parents }],
        };
      } else assert.fail(`unexpected provider route ${endpoint}`);
      return { status, headers: new Map<string, string>(), body };
    },
  };
  const publication = {
    id: 42,
    version: prepared.version,
    prepared_commit: prepared.prepared_commit,
    prepared_tree: prepared.prepared_tree,
  };
  return {
    root,
    api,
    publication,
    source,
    sourceTree,
    refs,
    namespace,
    calls,
    prepared,
    setFault(value: string) {
      fault = value;
    },
  };
}

void test("actual paired preparation and exact four-file transform preserve distinct published and original source identities", async (t) => {
  const f = await fixture(t);
  const result = inspectPublishedApplicationSource(
    f.api,
    { schema_version: 1, namespace: f.namespace },
    f.publication,
  );
  assert.equal(result.kind, "verified-prepared-publication");
  assert.deepEqual(result.publication, f.publication);
  assert.deepEqual(result.source_baseline, { commit: f.source, tree: f.sourceTree });
  assert.equal(result.preparation?.intent_sha256, f.prepared.intent_sha256);
  assert.equal(result.preparation?.proposal.base_version, "0.1.0-alpha.2");
  assert.equal(result.authority, "none");
  assert.match(result.proof_sha256, /^[a-f0-9]{64}$/u);
  assert.ok(f.calls.some((entry) => entry.includes("/compare/")));
  const semanticApi = {
    request(method: string, endpoint: string) {
      if (endpoint === "repos/boburning/portcove")
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: { id: 1354613114, full_name: "boburning/portcove" },
        };
      if (endpoint === "repos/boburning/portcove/releases?per_page=100")
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: [f.api.request("GET", "repos/boburning/portcove/releases/42").body],
        };
      return f.api.request(method, endpoint);
    },
  };
  assert.throws(
    () => readSemanticPublicationBaseline(semanticApi, f.root, f.publication.version),
    /requires the independently configured/,
  );
  const baseline = readSemanticPublicationBaseline(semanticApi, f.root, f.publication.version, {
    schema_version: 1,
    namespace: f.namespace,
  });
  assert.equal(baseline.commit, f.prepared.prepared_commit);
  assert.equal(baseline.tree, f.prepared.prepared_tree);
  assert.deepEqual(baseline.source_baseline, { commit: f.source, tree: f.sourceTree });
  assert.equal(baseline.published_source?.kind, "verified-prepared-publication");
});
void test("missing/wrong paired receipt, truncated tree, changed blob and tag drift cannot manufacture a source baseline", async (t) => {
  const f = await fixture(t);
  for (const mode of ["wrong-source-ref", "truncated", "blob-tamper", "tag-drift"]) {
    f.calls.length = 0;
    f.setFault(mode);
    assert.throws(() =>
      inspectPublishedApplicationSource(
        f.api,
        { schema_version: 1, namespace: f.namespace },
        f.publication,
      ),
    );
  }
  f.setFault("");
  f.refs.delete(`${f.namespace}-prepared-source/${f.source}`);
  assert.throws(
    () =>
      inspectPublishedApplicationSource(
        f.api,
        { schema_version: 1, namespace: f.namespace },
        f.publication,
      ),
    /receipt missing/,
  );
  f.refs.delete(`${f.namespace}-prepared/v${f.publication.version}`);
  assert.throws(
    () =>
      inspectPublishedApplicationSource(
        f.api,
        { schema_version: 1, namespace: f.namespace },
        f.publication,
      ),
    /receipts absent/,
  );
});
void test("legacy direct publication retains its actual source identity without inventing a prepared receipt", async (t) => {
  const f = await fixture(t);
  f.refs.clear();
  f.refs.set(`v${f.publication.version}`, f.source);
  const publication = { ...f.publication, prepared_commit: f.source, prepared_tree: f.sourceTree };
  const result = inspectPublishedApplicationSource(
    f.api,
    { schema_version: 1, namespace: f.namespace },
    publication,
  );
  assert.equal(result.kind, "legacy-direct-publication");
  assert.deepEqual(result.source_baseline, { commit: f.source, tree: f.sourceTree });
  assert.equal(result.preparation, null);
  assert.equal(
    f.calls.some((entry) => entry.includes("/contents/") || entry.includes("/compare/")),
    false,
  );
  assert.ok(isRecord(result.publication));
});

void test("valid raw intent and receipt pair cannot conceal extra application changes in a prepared publication", async (t) => {
  const f = await fixture(t, true);
  assert.throws(
    () =>
      inspectPublishedApplicationSource(
        f.api,
        { schema_version: 1, namespace: f.namespace },
        f.publication,
      ),
    /changes more than exact existing version authorities/,
  );
});
