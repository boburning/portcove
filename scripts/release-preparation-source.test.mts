import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hydrateReleasePreparationSource } from "./release-preparation-source.mts";
import {
  prepareReleaseVersion,
  exportPreparedReleaseVersion,
} from "../apps/desktop/scripts/prepare-release-version.mts";

async function fixture(t: test.TestContext, mode = "valid") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "preparation-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source"),
    sparse = path.join(parent, "sparse.git"),
    full = path.join(parent, "full.git");
  await mkdir(source);
  const raw = (directory: string, args: string[], input?: string | Buffer) =>
    execFileSync(
      "git",
      ["-C", directory, "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", ...args],
      {
        input,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
        },
      },
    );
  const git = (directory: string, args: string[], input?: string | Buffer) =>
    raw(directory, args, input).toString("utf8").trimEnd();
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "Fixture"]);
  git(source, ["config", "user.email", "fixture@example.invalid"]);
  for (const [filename, contents] of Object.entries({
    "Cargo.toml": `[workspace]\nmembers = ["${mode === "traversal" ? "../escape" : "crates/example"}"]\n[workspace.package]\nversion = "0.1.0-alpha.2"\n`,
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0-alpha.2"\n',
    "crates/example/Cargo.toml": '[package]\nname = "example"\nversion.workspace = true\n',
    "apps/desktop/package.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "runtime/unrelated.exe": "opaque application executable bytes never fetched or executed\n",
  })) {
    await mkdir(path.dirname(path.join(source, filename)), { recursive: true });
    await writeFile(path.join(source, filename), contents);
  }
  git(source, ["add", "."]);
  const link = git(source, ["hash-object", "-w", "--stdin"], "runtime/unrelated.exe");
  git(source, ["update-index", "--add", "--cacheinfo", `120000,${link},opaque-link`]);
  git(source, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${"a".repeat(40)},opaque-submodule`,
  ]);
  if (mode === "symlink") git(source, ["update-index", "--cacheinfo", `120000,${link},Cargo.toml`]);
  git(source, ["commit", "-qm", "source fixture"]);
  git(parent, ["clone", "--bare", "--quiet", source, full]);
  git(parent, ["init", "--bare", "--quiet", sparse]);
  const commit = git(source, ["rev-parse", "HEAD"]),
    tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  const entries = raw(source, ["ls-tree", "-r", "-t", "-z", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(line);
      assert.ok(match);
      return { mode: match[1]!, type: match[2]!, sha: match[3]!, path: match[4]! };
    });
  const person = {
    name: "Fixture",
    email: "fixture@example.invalid",
    date: "2026-10-20T00:00:00Z",
  };
  const calls: string[] = [];
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      const prefix = "repos/boburning/portcove/git/";
      let body: unknown;
      if (endpoint === `${prefix}commits/${commit}`)
        body = {
          sha: commit,
          tree: { sha: tree },
          parents: [],
          author: person,
          committer: person,
          message: "source fixture\n",
        };
      else if (endpoint === `${prefix}trees/${tree}?recursive=1`)
        body = { sha: tree, tree: entries, truncated: mode === "truncated" };
      else if (endpoint.startsWith(`${prefix}blobs/`)) {
        const oid = endpoint.slice(`${prefix}blobs/`.length);
        const contents = raw(source, ["cat-file", "blob", oid]);
        body = {
          sha: oid,
          size: contents.length,
          encoding: "base64",
          content:
            mode === "changed"
              ? Buffer.alloc(contents.length, 120).toString("base64")
              : contents.toString("base64"),
        };
      } else assert.fail(`unexpected provider route ${endpoint}`);
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  const classification = {
    source_commit: commit,
    reviewed_commit: commit,
    source_tree: tree,
    reviewed_tree: tree,
    change_set_sha256: "c".repeat(64),
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  };
  return {
    parent,
    source,
    sparse,
    full,
    git,
    entries,
    api,
    calls,
    classification,
    expected: { source_commit: commit, source_tree: tree },
  };
}

void test("a second off-main publication transforms the actual frozen source version while retaining the published base", async (t) => {
  const f = await fixture(t);
  const first = await prepareReleaseVersion(f.source, f.classification, ["0.1.0-alpha.2"]);
  assert.equal(first.version, "0.1.0-alpha.3");
  await writeFile(path.join(f.source, "next-source.txt"), "next independently reviewed source\n");
  f.git(f.source, ["add", "next-source.txt"]);
  f.git(f.source, ["commit", "-qm", "next application source"]);
  const commit = f.git(f.source, ["rev-parse", "HEAD"]);
  const tree = f.git(f.source, ["rev-parse", "HEAD^{tree}"]);
  const before = f.git(f.source, ["status", "--porcelain=v1"]);
  const second = await prepareReleaseVersion(
    f.source,
    {
      ...f.classification,
      source_commit: commit,
      reviewed_commit: commit,
      source_tree: tree,
      reviewed_tree: tree,
      base_version: first.version,
    },
    ["0.1.0-alpha.2", first.version],
  );
  assert.equal(second.version, "0.1.0-alpha.4");
  assert.equal(second.base_version, first.version);
  assert.equal(
    f.git(f.source, ["show", `${commit}:Cargo.toml`]).includes('version = "0.1.0-alpha.2"'),
    true,
  );
  assert.equal(
    f
      .git(f.source, ["show", `${second.prepared_commit}:Cargo.toml`])
      .includes('version = "0.1.0-alpha.4"'),
    true,
  );
  assert.equal(
    f.git(f.source, ["show", `${second.prepared_commit}:next-source.txt`]),
    "next independently reviewed source",
  );
  assert.equal(f.git(f.source, ["rev-parse", "HEAD"]), commit);
  assert.equal(f.git(f.source, ["status", "--porcelain=v1"]), before);
  assert.deepEqual(
    f
      .git(f.source, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        commit,
        second.prepared_commit,
      ])
      .split("\n")
      .sort(),
    [
      "Cargo.lock",
      "Cargo.toml",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json",
    ],
  );
  const exportedRepository = path.join(f.parent, "second-export.git");
  f.git(f.parent, ["clone", "--quiet", "--bare", f.source, exportedRepository]);
  const exported = exportPreparedReleaseVersion(exportedRepository, {
    source_commit: commit,
    source_tree: tree,
    prepared_commit: second.prepared_commit,
    prepared_tree: second.prepared_tree,
    version: second.version,
    intent_sha256: second.intent_sha256,
  });
  assert.match(exported.raw_commit, /"base_version":"0\.1\.0-alpha\.3"/);
  assert.throws(() =>
    f.git(f.source, ["merge-base", "--is-ancestor", first.prepared_commit, commit]),
  );
});

void test(
  "fresh sparse source custody prepares byte-identical objects without unrelated blobs or Git history",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const full = await prepareReleaseVersion(f.full, f.classification, ["0.1.0-alpha.2"]);
    const report = hydrateReleasePreparationSource(f.sparse, f.expected, f.api);
    assert.equal(report.authority, "none");
    assert.equal(report.paths.length, 5);
    const untouched = f.entries.find((entry) => entry.path === "runtime/unrelated.exe")!;
    assert.throws(() => f.git(f.sparse, ["cat-file", "-e", untouched.sha]));
    assert.equal(f.calls.includes(`repos/boburning/portcove/git/blobs/${untouched.sha}`), false);
    const sparse = await prepareReleaseVersion(f.sparse, f.classification, ["0.1.0-alpha.2"]);
    assert.deepEqual(sparse, full);
    const input = {
      source_commit: f.expected.source_commit,
      source_tree: f.expected.source_tree,
      prepared_commit: sparse.prepared_commit,
      prepared_tree: sparse.prepared_tree,
      version: sparse.version,
      intent_sha256: sparse.intent_sha256,
    };
    assert.deepEqual(
      exportPreparedReleaseVersion(f.sparse, input),
      exportPreparedReleaseVersion(f.full, input),
    );
    assert.equal(
      f.git(f.sparse, ["ls-tree", sparse.prepared_commit, "opaque-link"]),
      f.git(f.full, ["ls-tree", full.prepared_commit, "opaque-link"]),
    );
    assert.equal(
      f.git(f.sparse, ["ls-tree", sparse.prepared_commit, "opaque-submodule"]),
      f.git(f.full, ["ls-tree", full.prepared_commit, "opaque-submodule"]),
    );
  },
);
for (const mode of ["truncated", "changed", "traversal", "symlink"])
  void test(
    `source custody refuses ${mode} before preparation refs or execution`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t, mode);
      assert.throws(() => hydrateReleasePreparationSource(f.sparse, f.expected, f.api));
      assert.equal(f.git(f.sparse, ["for-each-ref", "refs/portcove/"]), "");
      assert.equal(f.calls.filter((endpoint) => endpoint.includes("/blobs/")).length <= 1, true);
    },
  );
