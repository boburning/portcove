import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as compiler from "./release-compiler-source.mts";
import {
  compareVerifiedReleaseCompilerSource,
  requireVerifiedReleaseCompilerSource,
} from "./release-compiler-source-admission.mts";
void test("imported tools, raw generated closures and source summaries cannot establish actual compiler source binding", async () => {
  const candidate = {
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    version: "0.2.0",
  };
  for (const forged of [
    {},
    { compiler_source_closure: "C:\\inert\\compiler-source-closure.json" },
    {
      evidence_scope: "github.com",
      candidate_tree: candidate.prepared_tree,
      controller_commit: "e".repeat(40),
    },
  ]) {
    await assert.rejects(
      compareVerifiedReleaseCompilerSource(forged, candidate, {
        source_commit: "e".repeat(40),
        source_tree: "f".repeat(40),
      }),
      /actual same-process controller tool verification/,
    );
    await assert.rejects(
      requireVerifiedReleaseCompilerSource(forged, candidate.prepared_tree),
      /actual same-process exact compiler/,
    );
  }
});

void test("verified admission reads the exact tree with the appointed reader and rejoins tool custody", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compiler-source-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blob = "b".repeat(40);
  const rawTree = Buffer.concat([Buffer.from("100644 unrelated.txt\0"), Buffer.from(blob, "hex")]);
  const tree = createHash("sha1").update(`tree ${rawTree.length}\0`).update(rawTree).digest("hex");
  const controller = { source_commit: "a".repeat(40), source_tree: tree };
  const candidate = {
    ...controller,
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    version: "0.2.0",
  };
  const closureFile = path.join(root, "compiler-source-closure.json");
  await writeFile(
    closureFile,
    JSON.stringify({
      schema_version: 1,
      ...controller,
      paths: compiler.compilerProducerPaths.map((name) => ({ path: name, entry: null })),
    }),
  );
  const receipt = {};
  const order: string[] = [];
  let changed = false;
  let stalled: "preparation" | "tree" | undefined;
  let enableProxyAfterPreparation = false;
  let cancelled = false;
  t.mock.module("./release-controller-tool-admission.mts", {
    exports: {
      async verifiedControllerToolPaths(value: object) {
        assert.equal(value, receipt);
        order.push("receipt");
        if (changed && order.length > 1) throw new Error("verified tool manifest changed");
        return { compiler_source_closure: closureFile };
      },
    },
  });
  t.mock.module("./release-compiler-source.mts", {
    exports: {
      ...compiler,
      async inspectPreparedCompilerSourceAsync(
        read: Parameters<typeof compiler.inspectPreparedCompilerSourceAsync>[0],
        _candidate: unknown,
        deadline: number,
      ) {
        await read(`repos/boburning/portcove/git/commits/${candidate.prepared_commit}`, deadline);
        if (enableProxyAfterPreparation) process.env.NODE_USE_ENV_PROXY = "1";
        return { authority: "none" };
      },
    },
  });
  const { compareVerifiedReleaseCompilerSource: compare } = (await import(
    new URL("./release-compiler-source-admission.mts?compiler-tree-sdk", import.meta.url).href
  )) as typeof import("./release-compiler-source-admission.mts");
  const ambientToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "different-ambient-compiler-token";
  t.after(() => {
    if (ambientToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = ambientToken;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token appointed-compiler-token");
      const preparation =
        request.url ===
        `https://api.github.com/repos/boburning/portcove/git/commits/${candidate.prepared_commit}`;
      if (!preparation)
        assert.equal(
          request.url,
          `https://api.github.com/repos/boburning/portcove/git/trees/${tree}`,
        );
      const stage = preparation ? "preparation" : "tree";
      order.push(stage);
      if (stalled === stage) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      }
      if (preparation) return Response.json({});
      return Response.json({
        sha: tree,
        truncated: false,
        tree: [{ path: "unrelated.txt", mode: "100644", type: "blob", sha: blob }],
      });
    },
  );
  const result = await compare(receipt, candidate, controller, "appointed-compiler-token");
  assert.equal(result.candidate_tree, candidate.prepared_tree);
  assert.equal(result.evidence_scope, "github.com");
  assert.deepEqual(order, ["receipt", "preparation", "tree", "receipt"]);
  order.length = 0;
  process.env.GH_TOKEN = "appointed-compiler-token";
  await withReadOnlyReleaseChildren(root, async () => {
    process.env.GH_TOKEN = "different-ambient-compiler-token";
    const scoped = await compare(receipt, candidate, controller);
    assert.equal(scoped.evidence_scope, "github.com");
  });
  assert.deepEqual(order, ["receipt", "preparation", "tree", "receipt"]);
  order.length = 0;
  enableProxyAfterPreparation = true;
  const originalProxySetting = process.env.NODE_USE_ENV_PROXY;
  try {
    await assert.rejects(
      compare(receipt, candidate, controller, "appointed-compiler-token"),
      /trusted direct Node runtime/u,
    );
    assert.deepEqual(order, ["receipt", "preparation"]);
  } finally {
    enableProxyAfterPreparation = false;
    if (originalProxySetting === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalProxySetting;
  }
  order.length = 0;
  changed = true;
  await assert.rejects(
    compare(receipt, candidate, controller, "appointed-compiler-token"),
    /manifest changed/,
  );
  assert.deepEqual(order, ["receipt", "preparation", "tree", "receipt"]);
  changed = false;
  for (const stage of ["preparation", "tree"] as const) {
    order.length = 0;
    stalled = stage;
    cancelled = false;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        withCoordinatorDeadline(performance.now() + 100, () =>
          compare(receipt, candidate, controller, "appointed-compiler-token"),
        ),
        { code: "deadline_exceeded" },
      );
      assert.equal(cancelled, true);
      assert.deepEqual(
        order,
        stage === "tree" ? ["receipt", "preparation", "tree"] : ["receipt", "preparation"],
      );
    } finally {
      clearTimeout(keepAlive);
    }
  }
});
