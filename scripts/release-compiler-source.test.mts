import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareReleaseCompilerSource,
  prepareReleaseCompilerSourceClosure,
  inspectReleaseCompilerSourceClosure,
  inspectPreparedCompilerSource,
} from "./release-compiler-source.mts";
import { reproducePreparedReleaseVersionFiles } from "../apps/desktop/scripts/prepare-release-version.mts";
import { sourceFixtureCommit } from "./fixtures/release-source-fixture.mts";
import { createHash } from "node:crypto";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "compiler-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 }).trim();
  git(["init", "--quiet"]);
  git(["config", "core.autocrlf", "false"]);
  for (const filename of [
    "scripts/capture.mts",
    "scripts/indirect-helper.mts",
    ".github/workflows/release.yml",
    ".github/actions/setup-rust/action.yml",
    "apps/desktop/scripts/helper.mts",
    "package.json",
    "Cargo.lock",
  ]) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), `inert ${filename}\n`);
  }
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
  };
  commit();
  const trusted = git(["rev-parse", "HEAD"]);
  let mutate:
    | ((body: {
        sha: string;
        truncated: boolean;
        tree: { mode: string; type: string; sha: string; path: string }[];
      }) => void)
    | undefined;
  let requests = 0;
  const api = {
    request(method: string, endpoint: string) {
      requests++;
      assert.equal(method, "GET");
      const match = /^repos\/boburning\/portcove\/git\/trees\/([a-f0-9]{40})$/u.exec(endpoint);
      assert.ok(match);
      const tree = git(["ls-tree", "-z", match[1]!])
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const parsed = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(entry);
          assert.ok(parsed);
          return { mode: parsed[1]!, type: parsed[2]!, sha: parsed[3]!, path: parsed[4]! };
        });
      const body = { sha: match[1]!, truncated: false, tree };
      mutate?.(body);
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  return {
    root,
    git,
    commit,
    trusted,
    api,
    setMutation(value: typeof mutate) {
      mutate = value;
    },
    requests: () => requests,
  };
}
void test("complete fixed helper/action/workflow tree matches while unrelated candidate application changes stay permitted", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "candidate-rust-source.rs"), "inert candidate\n");
  f.commit();
  const tree = f.git(["rev-parse", "HEAD^{tree}"]);
  f.git(["checkout", "--quiet", f.trusted]);
  const result = await compareReleaseCompilerSource(f.root, tree, { api: f.api });
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.controller_commit, f.trusted);
  assert.ok(f.requests() < 16);
  assert.ok(result.paths.some((entry) => entry.path === ".cargo" && "absent" in entry));
});
void test("indirect helper, action, workflow and previously absent Cargo configuration changes refuse", async (t) => {
  const f = await fixture(t);
  for (const filename of [
    "scripts/indirect-helper.mts",
    ".github/actions/setup-rust/action.yml",
    ".github/workflows/release.yml",
    ".cargo/config.toml",
  ]) {
    f.git(["checkout", "--quiet", f.trusted]);
    await mkdir(path.dirname(path.join(f.root, filename)), { recursive: true });
    await writeFile(path.join(f.root, filename), "changed candidate producer path\n");
    f.commit();
    const tree = f.git(["rev-parse", "HEAD^{tree}"]);
    f.git(["checkout", "--quiet", f.trusted]);
    await assert.rejects(compareReleaseCompilerSource(f.root, tree, { api: f.api }), /differs/);
  }
});
void test("truncated, duplicate, wrong-object and malformed authenticated tree responses refuse", async (t) => {
  const f = await fixture(t);
  const tree = f.git(["rev-parse", "HEAD^{tree}"]);
  for (const mutation of [
    (body: { truncated: boolean }) => {
      body.truncated = true;
    },
    (body: { sha: string }) => {
      body.sha = "f".repeat(40);
    },
    (body: { tree: { path: string; mode: string; type: string; sha: string }[] }) => {
      body.tree.push(body.tree[0]!);
    },
    (body: { tree: { path: string }[] }) => {
      body.tree[0]!.path = "../escape";
    },
  ]) {
    f.setMutation(mutation);
    await assert.rejects(
      compareReleaseCompilerSource(f.root, tree, { api: f.api }),
      /unavailable|malformed/,
    );
  }
});
void test("bootstrap closure binds exact source/tree plus complete explicit absence and rejects dirty/source/omitted inventories", async (t) => {
  const f = await fixture(t);
  const expected = { source_commit: f.trusted, source_tree: f.git(["rev-parse", "HEAD^{tree}"]) };
  const closure = await prepareReleaseCompilerSourceClosure(f.root, expected);
  assert.deepEqual(inspectReleaseCompilerSourceClosure(closure), closure);
  assert.equal(closure.paths.find((entry) => entry.path === ".cargo")?.entry, null);
  await assert.rejects(
    prepareReleaseCompilerSourceClosure(f.root, { ...expected, source_tree: "f".repeat(40) }),
    /changed|dirty/,
  );
  assert.throws(
    () => inspectReleaseCompilerSourceClosure({ ...closure, paths: closure.paths.slice(1) }),
    /complete/,
  );
  await writeFile(path.join(f.root, "scripts/indirect-helper.mts"), "dirty tracked helper");
  await assert.rejects(prepareReleaseCompilerSourceClosure(f.root, expected), /changed|dirty/);
});

void test("actual deterministic four version edits pass while dependencies and extra source changes refuse", async (t) => {
  const f = await fixture(t);
  const files = new Map([
    [
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/example"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n',
    ],
    ["Cargo.lock", 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n'],
    ["crates/example/Cargo.toml", '[package]\nname = "example"\nversion.workspace = true\n'],
    [
      "apps/desktop/package.json",
      '{\n  "version": "0.1.0",\n  "dependencies": {"inert": "fixed"}\n}\n',
    ],
    ["apps/desktop/src-tauri/tauri.conf.json", '{\n  "version": "0.1.0",\n  "app": {}\n}\n'],
  ]);
  for (const [filename, bytes] of files) {
    await mkdir(path.dirname(path.join(f.root, filename)), { recursive: true });
    await writeFile(path.join(f.root, filename), bytes);
  }
  f.commit();
  const sourceTree = f.git(["rev-parse", "HEAD^{tree}"]);
  const source = sourceFixtureCommit(sourceTree, [], "original\n");
  const expected = reproducePreparedReleaseVersionFiles(
    (filename) => {
      const value = files.get(filename);
      assert.notEqual(value, undefined);
      return value!;
    },
    { base_version: "0.1.0", version: "0.2.0" },
  );
  const response = (body: unknown) => ({ status: 200, body, headers: new Map<string, string>() });
  const run = (preparedTree: string) => {
    const prepared = sourceFixtureCommit(preparedTree, [source.sha], "prepared\n");
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        const route = url.pathname.replace("/repos/boburning/portcove", "");
        if (route === `/git/commits/${source.sha}`) return response(source);
        if (route === `/git/commits/${prepared.sha}`) return response(prepared);
        if (route === `/compare/${source.sha}...${prepared.sha}`)
          return response({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            base_commit: { sha: source.sha },
            merge_base_commit: { sha: source.sha },
            commits: [{ sha: prepared.sha, commit: prepared, parents: prepared.parents }],
          });
        const tree = /^\/git\/trees\/([a-f0-9]{40})$/u.exec(route);
        if (tree)
          return response({
            sha: tree[1],
            truncated: false,
            tree: f
              .git(["ls-tree", "-r", "-t", "-z", tree[1]!])
              .split("\0")
              .filter(Boolean)
              .map((entry) => {
                const parsed = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(entry)!;
                return { mode: parsed[1], type: parsed[2], sha: parsed[3], path: parsed[4] };
              }),
          });
        if (route.startsWith("/contents/")) {
          assert.equal(url.searchParams.get("ref"), source.sha);
          const filename = route.slice("/contents/".length);
          const content = files.get(filename);
          assert.notEqual(content, undefined);
          const bytes = Buffer.from(content!);
          return response({
            type: "file",
            path: filename,
            encoding: "base64",
            content: bytes.toString("base64"),
            size: bytes.length,
            sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
          });
        }
        throw new Error(`unexpected route ${route}`);
      },
    };
    return inspectPreparedCompilerSource(api, {
      source_commit: source.sha,
      source_tree: sourceTree,
      prepared_commit: prepared.sha,
      prepared_tree: preparedTree,
      version: "0.2.0",
    });
  };
  for (const [filename, content] of expected) await writeFile(path.join(f.root, filename), content);
  f.commit();
  assert.equal(run(f.git(["rev-parse", "HEAD^{tree}"])).authority, "none");
  await writeFile(
    path.join(f.root, "apps/desktop/package.json"),
    expected.get("apps/desktop/package.json")!.replace('"fixed"', '"changed"'),
  );
  f.commit();
  assert.throws(() => run(f.git(["rev-parse", "HEAD^{tree}"])), /version bytes differ/);
  await writeFile(path.join(f.root, "extra-source.rs"), "unapproved preparation change\n");
  f.commit();
  assert.throws(() => run(f.git(["rev-parse", "HEAD^{tree}"])), /more than exact/);
});
