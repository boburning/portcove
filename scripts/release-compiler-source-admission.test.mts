import assert from "node:assert/strict";
import test from "node:test";
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
