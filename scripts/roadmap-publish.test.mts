import assert from "node:assert/strict";
import test from "node:test";
import { writeMaintainedRoadmapReport } from "./roadmap-publish.mts";
import {
  mergeRoadmapObservations,
  observationFromReceipt,
  renderRoadmapReport,
  reportDigest,
  unavailableRoadmapStateReport,
} from "./roadmap-report.mts";
import type { RoadmapReportState } from "./roadmap-report.mts";
import { isRecord } from "./runtime-values.mts";
import { rateLimitFromResponse } from "./github-api.mts";

void test("production publisher maintains one comment for eight results and rejects stale publication", () => {
  let comment: { id: number; body: string; user: { type: string; login: string } } | undefined;
  let posts = 0,
    patches = 0,
    reads = 0;
  const api = {
    paginateRest: () => (comment ? [comment] : []),
    request: (method: string, _endpoint: string, payload?: unknown) => {
      if (method === "GET") reads++;
      else {
        assert(isRecord(payload) && typeof payload.body === "string");
        if (method === "POST") posts++;
        else patches++;
        comment = {
          id: 1,
          body: payload.body,
          user: { type: "Bot", login: "github-actions[bot]" },
        };
      }
      const response = { status: 200, headers: new Map<string, string>(), body: comment };
      return { ...response, rateLimit: rateLimitFromResponse(response) };
    },
  };
  let state: RoadmapReportState = {
    format_version: 1,
    cursor: "2026-10-24T00:00:00Z",
    observations: {},
    publication_gaps: [],
  };
  const preimage = () => (comment ? { id: comment.id, body: comment.body } : null);
  const render = () =>
    renderRoadmapReport(state, {
      run: 99,
      attempt: 1,
      repository: "boburning/portcove",
      sha256: reportDigest(JSON.stringify(state)),
    });
  for (let issue = 1; issue <= 8; issue++) {
    state = mergeRoadmapObservations(
      state,
      observationFromReceipt(
        {
          status: "failed",
          coverage: "complete",
          scope: { kind: "issues", issues: [issue] },
          errors: ["Missing metadata"],
          observation: { started_at: "2026-10-24T01:00:00Z" },
        },
        issue,
        1,
        "boburning/portcove",
      ),
    );
    writeMaintainedRoadmapReport(render(), preimage(), api);
  }
  assert.equal(posts, 1);
  assert.equal(patches, 7);
  assert.equal(reads, 8);
  assert.equal(Object.keys(state.observations).length, 8);
  const stale = preimage();
  state = mergeRoadmapObservations(
    state,
    observationFromReceipt(
      {
        status: "passed",
        coverage: "complete",
        scope: { kind: "issues", issues: [1], checked_issues: [1] },
        observation: { started_at: "2026-10-24T02:00:00Z" },
      },
      10,
      1,
      "boburning/portcove",
    ),
  );
  writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(state.observations["issue:1"]?.status, "passed");
  assert.equal(state.observations["issue:2"]?.status, "needs_attention");
  assert.throws(() => writeMaintainedRoadmapReport(render(), stale, api), /changed outside/u);
  const before = patches;
  writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(patches, before);
  assert.equal(posts, 1);
  const historical = render();
  const unavailable = unavailableRoadmapStateReport(historical, "Referenced artifact expired");
  writeMaintainedRoadmapReport(unavailable, preimage(), api);
  assert.equal(posts, 1, "Unavailable state updates the same maintained comment");
  assert.equal(comment?.body.split("\n")[0], historical.split("\n")[0]);
  assert.match(comment?.body ?? "", /\*\*Unable to verify\*\*/u);
});
