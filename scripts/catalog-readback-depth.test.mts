import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  deepenToPublisher,
  fetchDeeper,
  publisherHistoryPresent,
} from "./catalog-readback-depth.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function temp(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "catalog-readback-depth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function commit(repository: string, file: string, content: string) {
  const target = path.join(repository, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", file);
  return git(repository, "rev-parse", "HEAD");
}

/** An origin with two catalog publications followed by `appOnly` Pages commits,
 * and a depth-1 clone of it, as the publisher fetches it. */
function pages(t: TestContext, appOnly: number) {
  const base = temp(t);
  const origin = path.join(base, "origin");
  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=gh-pages");
  commit(origin, "catalog/metadata/timestamp.json", "1");
  const publisher = commit(origin, "catalog/metadata/timestamp.json", "2");
  for (let index = 0; index < appOnly; index += 1) commit(origin, "index.html", String(index));
  const site = path.join(base, "site");
  git(base, "clone", "--quiet", "--depth=1", "--branch=gh-pages", `file://${origin}`, site);
  git(
    site,
    "fetch",
    "--quiet",
    "--depth=1",
    "origin",
    "refs/heads/gh-pages:refs/remotes/origin/gh-pages",
  );
  return { origin, site, publisher };
}

const blamed = (site: string) =>
  git(
    site,
    "log",
    "--first-parent",
    "-1",
    "--format=%H",
    "HEAD",
    "--",
    "catalog/metadata/timestamp.json",
  );

void test("a shallow boundary is never mistaken for the publisher commit", (t) => {
  const { site, publisher } = pages(t, 3);
  assert.equal(publisherHistoryPresent(site), false);
  assert.notEqual(blamed(site), publisher);
  assert.equal(deepenToPublisher(site, fetchDeeper(site), 2), 5);
  assert.equal(blamed(site), publisher);
});

void test("more than seven application-only Pages commits are deepened past in bounded steps", (t) => {
  const { site, publisher } = pages(t, 20);
  const steps: number[] = [];
  const depth = deepenToPublisher(site, (step) => {
    steps.push(step);
    fetchDeeper(site)(step);
  });
  assert.deepEqual(steps, [8, 8, 8]);
  assert.equal(depth, 25);
  assert.equal(blamed(site), publisher);
  assert.equal(publisherHistoryPresent(site), true);
});

void test("a branch that advances after the depth-1 fetch still reads the checked-out history", (t) => {
  const { origin, site, publisher } = pages(t, 2);
  for (let index = 0; index < 12; index += 1) commit(origin, "app.js", String(index));
  commit(origin, "catalog/metadata/timestamp.json", "3");
  deepenToPublisher(site);
  assert.equal(blamed(site), publisher);
});

void test("a publication deeper than the bound is refused instead of misattributed", (t) => {
  const { site } = pages(t, 70);
  assert.throws(() => deepenToPublisher(site), /more than 64 gh-pages commits deep/u);
});

void test("an unshallow history with a root publisher needs no deepening", (t) => {
  const base = temp(t);
  git(base, "init", "--quiet", "--initial-branch=gh-pages");
  commit(base, "catalog/metadata/timestamp.json", "1");
  let calls = 0;
  assert.equal(
    deepenToPublisher(base, () => (calls += 1)),
    1,
  );
  assert.equal(calls, 0);
});

void test("the late readback deepens with the bounded helper, not a fixed depth", () => {
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/catalog-publish.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { id?: string; run?: string }[] }> };
  const readback = workflow.jobs.prepare!.steps!.find((step) => step.id === "late-readback")!.run!;
  assert.match(readback, /node scripts\/catalog-readback-depth\.mts --site site/u);
  assert.doesNotMatch(readback, /--depth=8/u);
  assert.ok(
    readback.indexOf("catalog-readback-depth") <
      readback.indexOf("catalog-publication-continuation"),
  );
});
