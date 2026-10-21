import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { materializePublicationSourceRepository } from "./release-publication-source.mts";
import { materializeReleaseQualificationSource } from "./release-candidate-qualification.mts";
import type { GitHubApiClient } from "./github-api.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-source-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    scratch = path.join(root, "scratch");
  await mkdir(source);
  await mkdir(scratch);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: source,
      encoding: null,
      timeout: 10000,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
      },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  git("init");
  git("config", "user.name", "Inert fixture");
  git("config", "user.email", "fixture@invalid.example");
  await mkdir(path.join(source, ".github"));
  await mkdir(path.join(source, ".cargo"));
  await writeFile(path.join(source, ".cargo/config.toml"), "[build]\njobs=1\n");
  await writeFile(path.join(source, "rust-toolchain.toml"), "[toolchain]\nchannel='stable'\n");
  await writeFile(path.join(source, "Cargo.toml"), "[package]\nname='inert'\nversion='0.1.0'\n");
  await writeFile(path.join(source, "binary.dat"), Buffer.from([0, 255, 1, 2]));
  const canary = path.join(root, "executed");
  await writeFile(
    path.join(source, "build.rs"),
    `fn main(){std::fs::write(${JSON.stringify(canary)},"forbidden").unwrap();}`,
  );
  git("add", ".");
  git("commit", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD").toString().trim();
  git("commit", "--allow-empty", "-m", "original prepared source parent");
  const originalParent = git("rev-parse", "HEAD").toString().trim();
  await writeFile(
    path.join(source, ".github/linux-beta-risk-706.json"),
    JSON.stringify({ reconfirmedHead: baseline }),
  );
  git("add", ".");
  git("commit", "-m", "candidate");
  const candidate = git("rev-parse", "HEAD").toString().trim(),
    tree = git("rev-parse", "HEAD^{tree}").toString().trim();
  let mutate = false,
    truncated = false;
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      const id = /\/([a-f0-9]{40})(?:\?recursive=1)?$/u.exec(endpoint)?.[1];
      assert.ok(id);
      let body: unknown;
      if (endpoint.includes("/git/commits/")) {
        const raw = git("cat-file", "commit", id).toString(),
          split = raw.indexOf("\n\n"),
          headers = raw.slice(0, split).split("\n");
        const actor = (role: string) => {
          const match = new RegExp(`^${role} (.+) <([^>]+)> ([0-9]+) \\+0000$`, "u").exec(
            headers.find((line) => line.startsWith(role + " "))!,
          );
          assert.ok(match);
          return {
            name: match[1],
            email: match[2],
            date: new Date(Number(match[3]) * 1000).toISOString(),
          };
        };
        body = {
          sha: id,
          tree: { sha: headers[0]!.slice(5) },
          parents: headers
            .filter((line) => line.startsWith("parent "))
            .map((line) => ({ sha: line.slice(7) })),
          author: actor("author"),
          committer: actor("committer"),
          message: raw.slice(split + 2),
          verification: { payload: null, signature: null },
        };
      } else if (endpoint.includes("/git/trees/")) {
        body = {
          sha: id,
          truncated,
          tree: git("ls-tree", "-r", "-t", "-l", "-z", id)
            .toString()
            .split("\0")
            .filter(Boolean)
            .map((line) => {
              const match = /^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/u.exec(line);
              assert.ok(match);
              return {
                mode: match[1],
                type: match[2],
                sha: match[3],
                path: match[5],
                ...(match[4] === "-" ? {} : { size: Number(match[4]) }),
              };
            }),
        };
      } else if (endpoint.includes("/git/blobs/")) {
        const bytes = git("cat-file", "blob", id);
        body = {
          sha: id,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        };
      } else assert.fail(endpoint);
      return { status: 200, headers: new Map(), body };
    },
    graphql(query: string) {
      const repository: Record<string, unknown> = { id: "fixture-inert", databaseId: 1354613114 };
      for (const match of query.matchAll(/b(\d+):object\(expression:"([a-f0-9]{40})"\)/gu)) {
        const bytes = git("cat-file", "blob", match[2]!);
        const binary = bytes.includes(0);
        repository[`b${match[1]}`] = {
          __typename: "Blob",
          oid: match[2],
          byteSize: bytes.length,
          isBinary: binary,
          text: binary ? null : bytes.toString("utf8") + (mutate ? "changed" : ""),
        };
      }
      return { data: { repository } };
    },
  } as unknown as Pick<GitHubApiClient, "request" | "graphql">;
  return {
    root,
    source,
    scratch,
    baseline,
    originalParent,
    candidate,
    tree,
    canary,
    api,
    git,
    setMutation: () => {
      mutate = true;
    },
    setTruncated: () => {
      truncated = true;
    },
  };
}
void test("bounded provider objects recreate actual Git qualification input including binary source, without executing it", async (t) => {
  const f = await fixture(t);
  await withCoordinatorDeadline(performance.now() + 60000, async () => {
    const imported = await materializePublicationSourceRepository(
      f.scratch,
      { controller_commit: f.baseline, candidate_commit: f.candidate, candidate_tree: f.tree },
      { api: f.api },
    );
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", f.originalParent], {
        cwd: imported.repository,
        timeout: 10000,
        windowsHide: true,
      }).status,
      0,
    );
    const result = await materializeReleaseQualificationSource(
      imported.repository,
      f.scratch,
      f.candidate,
      f.tree,
    );
    assert.deepEqual(
      await readFile(path.join(result.root, "binary.dat")),
      Buffer.from([0, 255, 1, 2]),
    );
    assert.equal(
      await readFile(path.join(result.root, "build.rs"), "utf8"),
      await readFile(path.join(f.source, "build.rs"), "utf8"),
    );
    await assert.rejects(access(f.canary));
  });
});
void test("truncated tree and changed GraphQL source bytes refuse before qualification or candidate execution", async (t) => {
  const f = await fixture(t);
  f.setMutation();
  await assert.rejects(
    materializePublicationSourceRepository(
      f.scratch,
      { controller_commit: f.baseline, candidate_commit: f.candidate, candidate_tree: f.tree },
      { api: f.api },
    ),
    /bytes differ|object differs/,
  );
  const g = await fixture(t);
  g.setTruncated();
  await assert.rejects(
    materializePublicationSourceRepository(
      g.scratch,
      { controller_commit: g.baseline, candidate_commit: g.candidate, candidate_tree: g.tree },
      { api: g.api },
    ),
    /truncated/,
  );
  await assert.rejects(access(f.canary));
  await assert.rejects(access(g.canary));
});
