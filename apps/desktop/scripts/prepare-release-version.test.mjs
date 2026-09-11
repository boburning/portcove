import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { prepareReleaseVersion } from "./prepare-release-version.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const tool = fileURLToPath(new URL("./prepare-release-version.mjs", import.meta.url));
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-version-fixture-"));
  roots.push(root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  git("init", "-q");
  git("config", "user.name", "Version fixture");
  git("config", "user.email", "fixture@portcove.invalid");
  git("config", "core.autocrlf", "false");
  const files = {
    "Cargo.toml":
      '[workspace]\nmembers = [\n  "crates/example",\n]\n[workspace.package]\nversion = "0.1.0"\n',
    "crates/example/Cargo.toml":
      '[package]\nname = "example"\nversion.workspace = true\n[dependencies]\n',
    "Cargo.lock":
      'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "third-party"\nversion = "0.1.0"\nsource = "registry+https://example.invalid"\n',
    "apps/desktop/package.json": '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json":
      '{\n  "version": "0.1.0",\n  "identifier": "fixture.example"\n}\n',
  };
  for (const [filename, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), contents);
  }
  git("add", ".");
  git("commit", "-qm", "source fixture");
  const source = git("rev-parse", "HEAD").trim();
  const classification = {
    source_commit: source,
    reviewed_commit: source,
    base_version: "0.1.0",
    change: "minor",
    compatibility: "compatible",
  };
  return { root, git, classification, files };
}

test("prepares exact coordinated metadata and retries without changing working files or index", async () => {
  const { root, git, classification, files } = await fixture();
  await writeFile(path.join(root, "staged.txt"), "keep staged user work");
  git("add", "staged.txt");
  await writeFile(path.join(root, "Cargo.toml"), "keep unstaged user work");
  const index = git("write-tree");
  const result = await prepareReleaseVersion(root, classification, ["0.1.0"]);
  assert.deepEqual(await prepareReleaseVersion(root, classification, ["0.1.0"]), result);
  assert.equal(result.version, "0.2.0");
  assert.equal(git("rev-parse", "HEAD").trim(), classification.source_commit);
  assert.equal(git("write-tree"), index);
  assert.equal(await readFile(path.join(root, "Cargo.toml"), "utf8"), "keep unstaged user work");
  assert.equal(
    git("show", `${result.prepared_commit}:Cargo.toml`),
    files["Cargo.toml"].replace('version = "0.1.0"', 'version = "0.2.0"'),
  );
  assert.match(
    git("show", `${result.prepared_commit}:Cargo.lock`),
    /name = "third-party"\nversion = "0.1.0"/,
  );
  assert.equal(
    JSON.parse(git("show", `${result.prepared_commit}:apps/desktop/src-tauri/tauri.conf.json`))
      .version,
    "0.2.0",
  );
  assert.equal(
    git("show", "-s", "--format=%P", result.prepared_commit).trim(),
    classification.source_commit,
  );
  assert.equal(
    git("for-each-ref", "--format=%(refname)", "refs/portcove/").trim().split("\n").length,
    2,
  );
  assert.equal(git("tag", "--list"), "");
}, 30_000);

test("concurrent independent processes allocate one identical preparation", async () => {
  const { root, classification, git } = await fixture();
  const input = path.join(root, "request.json");
  await writeFile(input, JSON.stringify({ classification, published_versions: ["0.1.0"] }));
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map(() =>
      execute(process.execPath, [tool, root, input], {
        windowsHide: true,
        timeout: 30_000,
      }),
    ),
  );
  // Keep the fixture until every process exits, including when one fails.
  for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
  for (const result of results)
    assert.deepEqual(JSON.parse(result.value.stdout), JSON.parse(results[0].value.stdout));
  assert.equal(
    git("for-each-ref", "--format=%(objectname)", "refs/portcove/").trim().split("\n").length,
    2,
  );
}, 40_000);

test("rejects changed intent, reused version, stale history and partial receipts", async () => {
  const { root, classification, git } = await fixture();
  const result = await prepareReleaseVersion(root, classification, ["0.1.0"]);
  await assert.rejects(
    prepareReleaseVersion(root, { ...classification, change: "patch" }, ["0.1.0"]),
    /already allocated/,
  );
  await assert.rejects(
    prepareReleaseVersion(root, classification, ["0.1.0", "0.2.0"]),
    /behind published history/,
  );
  git("commit", "--allow-empty", "-qm", "another frozen source");
  const source = git("rev-parse", "HEAD").trim();
  await assert.rejects(
    prepareReleaseVersion(
      root,
      { ...classification, source_commit: source, reviewed_commit: source },
      ["0.1.0"],
    ),
    /already allocated/,
  );
  assert.equal(
    git("for-each-ref", "--format=%(refname)", `refs/portcove/prepared-commits/${source}`),
    "",
  );
  git("update-ref", "-d", result.allocation_refs[1]);
  await assert.rejects(prepareReleaseVersion(root, classification, ["0.1.0"]), /already allocated/);
  assert.equal(git("for-each-ref", "--format=%(refname)", result.allocation_refs[1]), "");
  git("update-ref", result.allocation_refs[1], result.prepared_commit);
  git("update-ref", "-d", result.allocation_refs[0]);
  await assert.rejects(prepareReleaseVersion(root, classification, ["0.1.0"]), /already allocated/);
  assert.equal(git("for-each-ref", "--format=%(refname)", result.allocation_refs[0]), "");
}, 30_000);

test("receipt lock contention fails within its bound and a retry preserves the allocation", async () => {
  const { root, classification, git } = await fixture();
  const result = await prepareReleaseVersion(root, classification, ["0.1.0"]);
  const lock = path.join(root, ".git", `${result.allocation_refs[1]}.lock`);
  await writeFile(lock, "owned contention fixture", { flag: "wx" });
  try {
    await assert.rejects(prepareReleaseVersion(root, classification, ["0.1.0"]), /locked/);
    assert.equal(await readFile(lock, "utf8"), "owned contention fixture");
    for (const ref of result.allocation_refs)
      assert.equal(git("rev-parse", ref).trim(), result.prepared_commit);
  } finally {
    await rm(lock);
  }
  assert.deepEqual(await prepareReleaseVersion(root, classification, ["0.1.0"]), result);
}, 10_000);

test("version preparation does not execute repository hooks", async () => {
  const { root, classification, git } = await fixture();
  const hooks = path.join(root, "hooks");
  await mkdir(hooks);
  await writeFile(
    path.join(hooks, "reference-transaction"),
    "#!/bin/sh\necho executed > hook-executed\nexit 1\n",
    { mode: 0o755 },
  );
  git("config", "core.hooksPath", hooks);
  await prepareReleaseVersion(root, classification, ["0.1.0"]);
  await assert.rejects(readFile(path.join(root, "hook-executed")), {
    code: "ENOENT",
  });
}, 30_000);

test("invalid source metadata cannot reserve a version or silently update a dependency", async () => {
  const { root, classification, git } = await fixture();
  await writeFile(
    path.join(root, "Cargo.lock"),
    '[[package]]\nname = "example"\nversion = "0.1.0"\nsource = "registry+https://example.invalid"\n',
  );
  git("add", "Cargo.lock");
  git("commit", "-qm", "invalid lock identity");
  const source = git("rev-parse", "HEAD").trim();
  await assert.rejects(
    prepareReleaseVersion(
      root,
      { ...classification, source_commit: source, reviewed_commit: source },
      ["0.1.0"],
    ),
    /ambiguous workspace lock identity/,
  );
  assert.equal(git("for-each-ref", "--format=%(refname)", "refs/portcove/"), "");
}, 30_000);
