import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import {
  advanceActualCandidateToBuilding,
  advanceActualCandidateToPublishing,
  advanceActualCandidateToPromoting,
  requireActualCandidatePhaseAdvance,
} from "./release-candidate-progress.mts";

void test("imported eligibility and expired deadlines cannot enter candidate phase writes", async () => {
  await assert.rejects(
    advanceActualCandidateToBuilding({
      stage: "candidate-building",
      repository: "missing",
      checkpoint: "a".repeat(40),
      candidate: { phase: "qualifying" },
    }),
    /actual same-process candidate building eligibility/,
  );
  await assert.rejects(advanceActualCandidateToBuilding({}, { deadline: 0 }), /phase deadline/);
  await assert.rejects(
    advanceActualCandidateToPublishing({
      stage: "release-publication",
      checkpoint: "a".repeat(40),
    }),
    /actual same-process/,
  );
  await assert.rejects(
    requireActualCandidatePhaseAdvance(
      { phase: "publishing", checkpoint: "a".repeat(40) },
      "publishing",
    ),
    /actual same-process candidate phase/,
  );
  await assert.rejects(
    advanceActualCandidateToPromoting({ kind: "actual-owned-immutable-release-completion" }),
    /actual owned immutable Release completion custody/,
  );
});

void test("actual phase handoff awaits its fixed-reader snapshot between freshness fences", async () => {
  const source = await readFile(
    new URL("./release-candidate-progress.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function requirePhaseAdvanceWithinDeadline(");
  assert.ok(start > 0);
  const calls: string[] = [];
  const candidate = { phase: "publishing" };
  const checkpoint = "a".repeat(40);
  let remoteCheckpoint = checkpoint;
  const run = runInNewContext(
    stripTypeScriptTypes(source.slice(start)) + "; requirePhaseAdvanceWithinDeadline;",
    {
      structuredClone,
      recoverReleaseOpportunity: async () => ({ input: { active_candidate: candidate } }),
      releaseCanonicalDigest: JSON.stringify,
      fixedReleaseReaderToken: () => "inert-phase-handoff",
      readRemoteCoordinatorSnapshot: async (
        _repository: unknown,
        _configuration: unknown,
        options: unknown,
      ) => {
        assert.equal(
          JSON.stringify(options),
          JSON.stringify({
            transport: { credential: { token: "inert-phase-handoff" }, deadline: 12345 },
          }),
        );
        await Promise.resolve();
        calls.push("snapshot");
        return { checkpoint: remoteCheckpoint };
      },
    },
  ) as (value: unknown) => Promise<{ checkpoint: string }>;
  const value = {
    candidate,
    checkpoint,
    deadline: 12345,
    async recheck() {
      calls.push("recheck");
    },
    fresh() {
      calls.push("fresh");
    },
  };
  assert.equal((await run(value)).checkpoint, checkpoint);
  assert.deepEqual(calls, ["recheck", "fresh", "snapshot", "fresh"]);
  calls.length = 0;
  remoteCheckpoint = "b".repeat(40);
  await assert.rejects(run(value), /remote phase checkpoint changed/u);
  assert.deepEqual(calls, ["recheck", "fresh", "snapshot"]);
});
