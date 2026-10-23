import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, access, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import {
  materializeSemanticSource,
  semanticSourceResourceEnvironment,
} from "./release-semantic-source.mts";

const pins = { git_sha256: "a".repeat(64), python_sha256: "b".repeat(64) };
void test("ordinary hosted source acquisition retains resource routing without credential/reviewer environment", () => {
  const environment = semanticSourceResourceEnvironment("/private/source-home", {
    GITHUB_ACTIONS: "true",
    PATH: "/maintained/toolchain/bin:/usr/bin:/bin",
    HOME: "/home/reviewer",
    GH_TOKEN: "forbidden",
    NODE_OPTIONS: "forbidden",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "forbidden",
    HTTP_PROXY: "forbidden",
  });
  assert.equal(environment.GITHUB_ACTIONS, "true");
  assert.equal(environment.HOME, "/home/reviewer");
  assert.equal(environment.PATH, "/maintained/toolchain/bin:/usr/bin:/bin");
  assert.deepEqual(Object.keys(environment).sort(), ["GITHUB_ACTIONS", "HOME", "LANG", "PATH"]);
  assert.equal(
    semanticSourceResourceEnvironment("/private/source-home", {}).GITHUB_ACTIONS,
    undefined,
  );
});
async function fixture(t: { after: (fn: () => Promise<void>) => void }, oversizedCommit = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "semantic-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const git = (repository: string, args: string[], input?: Buffer) =>
    execFileSync("git", ["-C", repository, ...args], {
      input,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
      },
    });
  git(root, ["init", "--bare", "--quiet", "--template=", origin]);
  git(origin, ["config", "uploadpack.allowFilter", "true"]);
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const blob = (bytes: string) =>
    git(origin, ["hash-object", "-w", "--stdin"], Buffer.from(bytes)).toString().trim();
  const oldBlob = blob("old\0bytes\n");
  const newBlob = blob("new\0bytes\n");
  const tree = (id: string) =>
    git(origin, ["mktree"], Buffer.from(`100644 blob ${id}\tinput.bin\n`))
      .toString()
      .trim();
  const oldTree = tree(oldBlob),
    newTree = tree(newBlob);
  const rawCommit = (tree: string, parent?: string) =>
    Buffer.from(
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author A <a@fixture.invalid> 1792281600 -0430\ncommitter A <a@fixture.invalid> 1792281600 +0545\n\nraw offset fixture\n`,
    );
  const ancestor = git(origin, ["hash-object", "-w", "-t", "commit", "--stdin"], rawCommit(oldTree))
    .toString()
    .trim();
  const oldRaw = rawCommit(oldTree, ancestor);
  const old = git(origin, ["hash-object", "-w", "-t", "commit", "--stdin"], oldRaw)
    .toString()
    .trim();
  const newRaw = Buffer.concat([
    rawCommit(newTree, old),
    Buffer.from(oversizedCommit ? "x".repeat(128 * 1024) : ""),
  ]);
  const current = git(origin, ["hash-object", "-w", "-t", "commit", "--stdin"], newRaw)
    .toString()
    .trim();
  const rawTag = Buffer.from(
    `object ${old}\ntype commit\ntag vfixture\ntagger A <a@fixture.invalid> 1792281600 -0430\n\nannotated fixture\n`,
  );
  const tag = git(origin, ["hash-object", "-w", "-t", "tag", "--stdin"], rawTag).toString().trim();
  const expected = {
    source_commit: current,
    source_tree: newTree,
    base_commit: old,
    published_object: tag,
  };
  let fault = "";
  const response = (tree: string, id: string) => ({
    status: 200,
    headers: new Map<string, string>(),
    body: {
      sha: tree,
      truncated: fault === "truncated",
      tree: [
        {
          path: "input.bin",
          mode: fault === "symlink" ? "120000" : "100644",
          type: "blob",
          sha: id,
          size: fault === "oversize" ? 16 * 1024 * 1024 + 1 : fault === "size-drift" ? 99 : 10,
        },
      ],
    },
  });
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      if (endpoint.endsWith(`${oldTree}?recursive=1`)) return response(oldTree, oldBlob);
      if (endpoint.endsWith(`${newTree}?recursive=1`)) return response(newTree, newBlob);
      throw new Error("unexpected fixture provider route");
    },
  };
  const phases: string[] = [];
  const fetchObjects: NonNullable<
    Parameters<typeof materializeSemanticSource>[4]
  >["fetchObjects"] = async (request) => {
    phases.push(request.phase);
    assert.ok(request.timeout_ms > 0 && request.timeout_ms <= 30000);
    assert.ok(request.expires_at > Date.now());
    git(request.repository, [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      request.phase === "commits" ? "--filter=tree:0" : "--filter=blob:none",
      ...(request.phase === "commits" ? ["--depth=2049"] : []),
      pathToFileURL(origin).href,
      ...request.oids,
    ]);
  };
  const parent = path.join(root, "attempt");
  await mkdir(parent);
  return {
    parent,
    api,
    expected,
    git,
    phases,
    newRaw,
    oldRaw,
    fetchObjects,
    setFault(value: string) {
      fault = value;
    },
  };
}

void test("empty source cache acquires exact raw non-UTC commits, annotated publication and complete binary snapshots without refs/checkout", async (t) => {
  const f = await fixture(t);
  const result = await materializeSemanticSource(f.parent, f.expected, f.api, pins, {
    git: "git",
    fetchObjects: f.fetchObjects,
  });
  assert.equal(result.authority, "none");
  assert.equal(result.evidence_scope, "injected-source-qualification");
  assert.deepEqual(
    f.git(result.repository, ["cat-file", "commit", f.expected.source_commit]),
    f.newRaw,
  );
  assert.deepEqual(
    f.git(result.repository, ["cat-file", "commit", f.expected.base_commit]),
    f.oldRaw,
  );
  assert.equal(
    f.git(result.repository, ["show", `${f.expected.source_commit}:input.bin`]).toString(),
    "new\0bytes\n",
  );
  assert.equal(
    f.git(result.repository, ["show", `${f.expected.base_commit}:input.bin`]).toString(),
    "old\0bytes\n",
  );
  assert.equal(f.git(result.repository, ["for-each-ref"]).length, 0);
  await assert.rejects(access(path.join(result.repository, "FETCH_HEAD")));
  await assert.rejects(access(path.join(result.repository, "objects/info/alternates")));
  await assert.rejects(access(path.join(f.parent, "input.bin")));
  assert.deepEqual(f.phases, ["commits", "blobs"]);
  assert.equal(
    (await readFile(path.join(result.repository, "shallow"), "utf8")).trim(),
    f.expected.base_commit,
  );
  assert.equal(
    f
      .git(result.repository, ["rev-list", f.expected.source_commit, `^${f.expected.base_commit}`])
      .toString()
      .trim(),
    f.expected.source_commit,
  );
  const indexes = (await readdir(path.join(result.repository, "objects/pack"))).filter((name) =>
    name.endsWith(".idx"),
  );
  assert.equal(indexes.length, 1);
  const packed = f
    .git(result.repository, [
      "verify-pack",
      "-v",
      path.join(result.repository, "objects/pack", indexes[0]!),
    ])
    .toString()
    .split("\n")
    .filter((line) => /^[a-f0-9]{40} /u.test(line));
  assert.equal(packed.length, 7);
  assert.ok(
    packed.every((line) =>
      /^[a-f0-9]{40} (?:commit|tree|blob|tag) [0-9]+ [0-9]+ [0-9]+$/u.test(
        line.trim().split(/\s+/u).join(" "),
      ),
    ),
    "handoff pack has no deltas or unrelated network objects",
  );
});

void test("oversized raw intermediate/source commit refuses before snapshots or blob fetch", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(
    materializeSemanticSource(f.parent, f.expected, f.api, pins, {
      git: "git",
      fetchObjects: f.fetchObjects,
    }),
    /raw commit preflight/,
  );
  assert.deepEqual(f.phases, ["commits"]);
});

for (const fault of ["oversize", "truncated", "symlink"])
  void test(`source ${fault} refuses before blob acquisition or candidate execution`, async (t) => {
    const f = await fixture(t);
    f.setFault(fault);
    await assert.rejects(
      materializeSemanticSource(f.parent, f.expected, f.api, pins, {
        git: "git",
        fetchObjects: f.fetchObjects,
      }),
    );
    assert.deepEqual(f.phases, ["commits"]);
  });

void test("declared blob size cannot replace exact materialized bytes; wrong source tree refuses before blobs", async (t) => {
  const f = await fixture(t);
  f.setFault("size-drift");
  await assert.rejects(
    materializeSemanticSource(f.parent, f.expected, f.api, pins, {
      git: "git",
      fetchObjects: f.fetchObjects,
    }),
    /types\/sizes differ/,
  );
  const another = path.join(f.parent, "next");
  await mkdir(another);
  await assert.rejects(
    materializeSemanticSource(
      another,
      { ...f.expected, source_tree: "f".repeat(40) },
      f.api,
      pins,
      { git: "git", fetchObjects: f.fetchObjects },
    ),
    /commit\/tree binding/,
  );
});

void test("fixed source Git policy applies pre-parser limits and rejects injected/expired routes without execution", () => {
  const output = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", "-B", fileURLToPath(new URL("semantic-source-git.test.py", import.meta.url))],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(output, "");
});
