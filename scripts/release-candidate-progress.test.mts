import assert from "node:assert/strict";
import test from "node:test";
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
