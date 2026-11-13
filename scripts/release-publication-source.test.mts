import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  materializePublicationSourceRepository,
  createPublicationSourceOperations,
} from "./release-publication-source.mts";
import type { PublicationSourceOperations } from "./release-publication-source.mts";
import { isRecord } from "./runtime-values.mts";
import { materializeReleaseQualificationSource } from "./release-candidate-qualification.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { inspectRiskVersionPreparation706 } from "./linux-beta-risk-706-preparation.mts";

async function fixture(t: test.TestContext, prepare = false) {
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
  if (prepare) {
    const files = {
      "Cargo.toml":
        '[workspace]\nmembers = ["apps/desktop/src-tauri"]\n[workspace.package]\nversion = "0.1.0"\n',
      "apps/desktop/src-tauri/Cargo.toml":
        '[package]\nname = "portcove-desktop"\nversion.workspace = true\n',
      "Cargo.lock": 'version = 4\n\n[[package]]\nname = "portcove-desktop"\nversion = "0.1.0"\n',
      "apps/desktop/package.json": '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
      "apps/desktop/src-tauri/tauri.conf.json":
        '{\n  "version": "0.1.0",\n  "identifier": "fixture.example"\n}\n',
    };
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), contents);
    }
  }
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
  const originalSource = git("rev-parse", "HEAD").toString().trim();
  const prepared = prepare
    ? await prepareReleaseVersion(
        source,
        {
          source_commit: originalSource,
          reviewed_commit: originalSource,
          base_version: "0.1.0",
          change: "patch",
          compatibility: "compatible",
        },
        ["0.1.0"],
      )
    : null;
  const candidate = prepared?.prepared_commit ?? originalSource,
    tree = git("rev-parse", `${candidate}^{tree}`).toString().trim();
  let mutate = false,
    truncated = false;
  const readObject = (kind: "commits" | "trees" | "blobs", id: string) => {
    let body: unknown;
    if (kind === "commits") {
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
          date: new Date(Number(match[3]) * 1000).toISOString().replace(".000Z", "Z"),
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
    } else if (kind === "trees") {
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
    } else if (kind === "blobs") {
      const bytes = git("cat-file", "blob", id);
      body = {
        sha: id,
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
      };
    } else assert.fail(kind);
    return body;
  };
  const operations: PublicationSourceOperations = {
    async commit(id) {
      return readObject("commits", id);
    },
    async tree(id) {
      return readObject("trees", id);
    },
    async blob(id) {
      return readObject("blobs", id);
    },
    async blobs(ids) {
      const repository: Record<string, unknown> = { id: "fixture-inert", databaseId: 1354613114 };
      for (const [index, id] of ids.entries()) {
        const bytes = git("cat-file", "blob", id);
        const binary = bytes.includes(0);
        repository[`b${index}`] = {
          __typename: "Blob",
          oid: id,
          byteSize: bytes.length,
          isBinary: binary,
          text: binary ? null : bytes.toString("utf8") + (mutate ? "changed" : ""),
        };
      }
      return { repository };
    },
  };
  return {
    root,
    source,
    scratch,
    baseline,
    originalParent,
    originalSource,
    candidate,
    tree,
    canary,
    operations,
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
      { operations: f.operations },
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
void test("actual prepared source survives bounded provider import and depth-one qualification with its exact original parent", async (t) => {
  const f = await fixture(t, true);
  await withCoordinatorDeadline(performance.now() + 60000, async () => {
    const imported = await materializePublicationSourceRepository(
      f.scratch,
      {
        controller_commit: f.baseline,
        candidate_commit: f.candidate,
        candidate_tree: f.tree,
      },
      { operations: f.operations },
    );
    const result = await materializeReleaseQualificationSource(
      imported.repository,
      f.scratch,
      f.candidate,
      f.tree,
    );
    const read = (args: readonly string[]) => {
      const output = spawnSync("git", [...args], {
        cwd: result.root,
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
      assert.equal(output.status, 0, output.stderr);
      return output.stdout;
    };
    const proof = await inspectRiskVersionPreparation706(f.candidate, read);
    assert.equal(proof?.source_commit, f.originalSource);
    assert.equal(proof?.prepared_tree, f.tree);
    assert.equal(read(["rev-parse", "HEAD"]).trim(), f.candidate);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", f.originalParent], {
        cwd: imported.repository,
        timeout: 10000,
        windowsHide: true,
      }).status,
      0,
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
      { operations: f.operations },
    ),
    /bytes differ|object differs/,
  );
  const g = await fixture(t);
  g.setTruncated();
  await assert.rejects(
    materializePublicationSourceRepository(
      g.scratch,
      { controller_commit: g.baseline, candidate_commit: g.candidate, candidate_tree: g.tree },
      { operations: g.operations },
    ),
    /truncated/,
  );
  await assert.rejects(access(f.canary));
  await assert.rejects(access(g.canary));
});

void test("actual SDK reconstructs inert source through REST and GraphQL with exact wire accounting", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const operations = await createPublicationSourceOperations({
    deadline: performance.now() + 60000,
    environment: { GH_TOKEN: "ghs_SYNTHETIC_SOURCE_ONLY" },
    fetch: async (input, init) => {
      if (typeof input !== "string") assert.fail("SDK must use a fixed URL");
      const url = new URL(input);
      sends++;
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.match(
        headers.get("authorization") ?? "",
        /^(?:token|Bearer) ghs_SYNTHETIC_SOURCE_ONLY$/u,
      );
      assert.equal(headers.get("x-github-api-version"), "2022-11-28");
      if (url.pathname === "/graphql") {
        assert.equal(init?.method, "POST");
        assert.equal(typeof init?.body, "string");
        const payload: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
        assert.ok(isRecord(payload) && typeof payload.query === "string");
        const ids = [...payload.query.matchAll(/b\d+:object\(expression:"([a-f0-9]{40})"\)/gu)].map(
          (match) => match[1]!,
        );
        return Response.json({ data: await f.operations.blobs(ids) });
      }
      assert.equal(init?.method, "GET");
      const match =
        /^\/repos\/boburning\/portcove\/git\/(commits|trees|blobs)\/([a-f0-9]{40})$/u.exec(
          url.pathname,
        );
      assert.ok(match);
      const id = match[2]!;
      const data =
        match[1] === "commits"
          ? await f.operations.commit(id)
          : match[1] === "trees"
            ? await f.operations.tree(id)
            : await f.operations.blob(id);
      return Response.json(data);
    },
  });
  const result = await withCoordinatorDeadline(performance.now() + 60000, () =>
    materializePublicationSourceRepository(
      f.scratch,
      {
        controller_commit: f.baseline,
        candidate_commit: f.candidate,
        candidate_tree: f.tree,
      },
      { operations },
    ),
  );
  assert.equal(result.calls, sends);
  assert.ok(sends > 0 && sends <= 180);
  const imported = spawnSync(
    "git",
    ["--git-dir", result.repository, "cat-file", "blob", `${f.candidate}:binary.dat`],
    { timeout: 10000 },
  );
  assert.equal(imported.status, 0, imported.stderr.toString());
  assert.deepEqual(imported.stdout, Buffer.from([0, 255, 1, 2]));
  await assert.rejects(access(f.canary));
});

void test("publication source refuses missing role credentials, invalid objects and failed streams before retry", async () => {
  await assert.rejects(
    createPublicationSourceOperations({
      deadline: performance.now() + 5000,
      environment: { GITHUB_TOKEN: "unapproved-fallback" },
    }),
    /explicit.*credential/u,
  );
  for (const mode of ["transient", "stream", "oversize"] as const) {
    let sends = 0;
    const operations = await createPublicationSourceOperations({
      deadline: performance.now() + 5000,
      environment: { GH_TOKEN: "fixture-token" },
      fetch: async () => {
        sends++;
        if (mode === "transient") return Response.json({ message: "unavailable" }, { status: 503 });
        if (mode === "oversize") return new Response(new Uint8Array(24 * 1024 ** 2 + 1));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("failed body"));
            },
          }),
        );
      },
    });
    await assert.rejects(operations.commit("../../other"));
    await assert.rejects(operations.blobs([]));
    await assert.rejects(operations.blobs(["invalid"]));
    assert.equal(sends, 0);
    await assert.rejects(operations.commit("a".repeat(40)));
    assert.equal(sends, 1);
  }
});

void test("SDK source reads retain the captured job reader token after its scope exits", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publication-reader-role-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "ghs_SYNTHETIC_READER_ONLY";
    const operations = await withReadOnlyReleaseChildren(directory, async () => {
      process.env.GH_TOKEN = "ghs_SYNTHETIC_OTHER_ROLE";
      return createPublicationSourceOperations({
        deadline: performance.now() + 5000,
        fetch: async (_input, init) => {
          assert.match(
            new Headers(init?.headers).get("authorization") ?? "",
            /^(?:token|Bearer) ghs_SYNTHETIC_READER_ONLY$/u,
          );
          return Response.json({ sha: "a".repeat(40) });
        },
      });
    });
    await operations.commit("a".repeat(40));
  } finally {
    if (prior === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior;
  }
});

void test("actual SDK source operations require HTTP 200 for both REST and GraphQL", async () => {
  for (const kind of ["REST", "GraphQL"] as const) {
    let sends = 0;
    const operations = await createPublicationSourceOperations({
      deadline: performance.now() + 5000,
      environment: { GH_TOKEN: "fixture-token" },
      fetch: async () => {
        sends++;
        return Response.json(
          kind === "REST"
            ? { sha: "a".repeat(40) }
            : {
                data: { repository: { databaseId: 1354613114 } },
              },
          { status: 201 },
        );
      },
    });
    await assert.rejects(
      kind === "REST" ? operations.commit("a".repeat(40)) : operations.blobs(["a".repeat(40)]),
      /HTTP 201/u,
    );
    assert.equal(sends, 1);
  }
});
