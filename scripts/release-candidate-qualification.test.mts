import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {
  materializeReleaseQualificationSource,
  finalizeQualifiedReleaseCandidate,
} from "./release-candidate-qualification.mts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-inert-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "controller");
  await mkdir(source);
  const scratch = path.join(root, "scratch");
  await mkdir(scratch);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: source,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  git("config", "user.name", "Inert fixture");
  git("config", "user.email", "fixture@invalid.example");
  await mkdir(path.join(source, ".cargo"));
  await mkdir(path.join(source, ".github"));
  await writeFile(path.join(source, ".cargo", "config.toml"), "[build]\njobs = 1\n");
  await writeFile(path.join(source, "rust-toolchain.toml"), "[toolchain]\nchannel = 'stable'\n");
  await writeFile(
    path.join(source, "Cargo.toml"),
    "[package]\nname = 'inert-fixture'\nversion = '0.1.0'\n",
  );
  const canary = path.join(root, "executed");
  await writeFile(
    path.join(source, "build.rs"),
    `fn main(){std::fs::write(${JSON.stringify(canary)}, "forbidden").unwrap();}`,
  );
  git("add", ".");
  git("commit", "-m", "inert baseline");
  const baseline = git("rev-parse", "HEAD");
  await writeFile(
    path.join(source, ".github", "linux-beta-risk-706.json"),
    JSON.stringify({ reconfirmedHead: baseline }),
  );
  git("add", ".");
  git("commit", "-m", "exact qualification candidate");
  return {
    root,
    source,
    scratch,
    canary,
    git,
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
  };
}

void test("materializes exact raw prepared bytes and baseline without executing candidate build code", async (t) => {
  const f = await fixture(t);
  const result = await materializeReleaseQualificationSource(f.source, f.scratch, f.commit, f.tree);
  assert.equal(result.commit, f.commit);
  assert.equal(result.tree, f.tree);
  assert.equal(result.authority, "none");
  assert.match(result.candidate_execution, /none/u);
  assert.equal(
    await readFile(path.join(result.root, "build.rs"), "utf8"),
    await readFile(path.join(f.source, "build.rs"), "utf8"),
  );
  await assert.rejects(access(f.canary));
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: result.root, encoding: "utf8" }).stdout.trim(),
    f.commit,
  );
});

void test("wrong tree and changed Cargo execution configuration refuse rather than execute candidate aliases", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    materializeReleaseQualificationSource(f.source, f.scratch, f.commit, "f".repeat(40)),
    /tree differs/u,
  );
  await writeFile(
    path.join(f.source, ".cargo", "config.toml"),
    "[alias]\ndeny = '!echo forbidden'\n",
  );
  f.git("add", ".");
  f.git("commit", "-m", "controller configuration changed");
  await assert.rejects(
    materializeReleaseQualificationSource(f.source, f.scratch, f.commit, f.tree),
    /execution configuration differs/u,
  );
  await assert.rejects(access(f.canary));
});

void test("fixed qualification refuses ancestor Cargo aliases before invoking any scanner or candidate code", async (t) => {
  const f = await fixture(t);
  const result = await materializeReleaseQualificationSource(f.source, f.scratch, f.commit, f.tree);
  await mkdir(path.join(f.root, ".cargo"));
  await writeFile(
    path.join(f.root, ".cargo", "config.toml"),
    "[alias]\ndeny = '!echo must-not-run'\n",
  );
  assert.throws(
    () =>
      finalizeQualifiedReleaseCandidate(
        {
          qualification_root: result.root,
          prepared_commit: f.commit,
          version: "0.1.0-beta.1",
          assets: "unused",
          inventory: "unused",
          sbom_subjects: "unused",
        },
        "inert-read-token",
      ),
    /ancestor Cargo/u,
  );
  await assert.rejects(access(f.canary));
});

void test("a missing local promisor blob refuses without contacting its configured local transport", async (t) => {
  const f = await fixture(t);
  const remote = path.join(f.root, "remote.git");
  f.git("clone", "--bare", f.source, remote);
  const marker = path.join(f.root, "lazy-fetch-invoked");
  const upload = path.join(f.root, "upload-canary.sh");
  await writeFile(
    upload,
    `#!/bin/sh\nprintf invoked > '${marker.replaceAll("\\", "/")}'\nexec git-upload-pack "$@"\n`,
  );
  f.git("config", "remote.origin.url", remote);
  f.git("config", "remote.origin.promisor", "true");
  f.git("config", "remote.origin.partialclonefilter", "blob:none");
  f.git("config", "remote.origin.uploadpack", `sh '${upload.replaceAll("\\", "/")}'`);
  f.git("config", "extensions.partialClone", "origin");
  const blob = f.git("rev-parse", "HEAD:build.rs");
  await rm(path.join(f.source, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(
    materializeReleaseQualificationSource(f.source, f.scratch, f.commit, f.tree),
    /raw Git operation refused|source has non-blob/,
  );
  await assert.rejects(access(marker));
  await assert.rejects(
    access(path.join(f.source, ".git", "objects", blob.slice(0, 2), blob.slice(2))),
  );
});
