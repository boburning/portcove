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

void test("production publisher maintains one comment for eight results and rejects stale publication", async () => {
  let comment: { id: number; body: string; user: { type: string; login: string } } | undefined;
  let posts = 0,
    patches = 0,
    reads = 0;
  const write = async (method: "POST" | "PATCH", body: string) => {
    if (method === "POST") posts++;
    else patches++;
    comment = { id: 1, body, user: { type: "Bot", login: "github-actions[bot]" } };
    return comment;
  };
  const api = {
    comments: async () => (comment ? [comment] : []),
    create: (body: string) => write("POST", body),
    replace: (_id: number, body: string) => write("PATCH", body),
    comment: async (_id: number) => {
      reads++;
      return comment;
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
    await writeMaintainedRoadmapReport(render(), preimage(), api);
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
  await writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(state.observations["issue:1"]?.status, "passed");
  assert.equal(state.observations["issue:2"]?.status, "needs_attention");
  await assert.rejects(
    () => writeMaintainedRoadmapReport(render(), stale, api),
    /changed outside/u,
  );
  const before = patches;
  await writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(patches, before);
  assert.equal(posts, 1);
  const historical = render();
  const unavailable = unavailableRoadmapStateReport(historical, "Referenced artifact expired");
  await writeMaintainedRoadmapReport(unavailable, preimage(), api);
  assert.equal(posts, 1, "Unavailable state updates the same maintained comment");
  assert.equal(comment?.body.split("\n")[0], historical.split("\n")[0]);
  assert.match(comment?.body ?? "", /\*\*Unable to verify\*\*/u);
});

void test("publisher SDK adapter traverses real pages, sends one mutation, then verifies readback", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { createPublicationApi } = await import("./roadmap-publish.mts");
  const before = `${"<!-- portcove-roadmap-report:"}{} -->\nold`,
    after = before + "\nupdated";
  const row = (body: string) => ({
    id: 7,
    body,
    user: { type: "Bot", login: "github-actions[bot]" },
  });
  const calls: string[] = [];
  let current = before;
  const sdk = await fixtureGitHub(({ method, endpoint, body }) => {
    calls.push(`${method} ${endpoint}`);
    if (endpoint === "repos/boburning/portcove/issues/2414/comments?per_page=100")
      return Response.json([{ id: 1, user: { type: "User", login: "person" }, body: "ordinary" }], {
        headers: {
          link: '<https://api.github.com/repos/boburning/portcove/issues/2414/comments?per_page=100&page=2>; rel="next"',
        },
      });
    if (endpoint.endsWith("&page=2")) return [row(current)];
    assert.equal(endpoint, "repos/boburning/portcove/issues/comments/7");
    if (method === "PATCH") {
      assert.deepEqual(body, { body: after });
      current = after;
    } else assert.equal(method, "GET");
    return row(current);
  });
  assert.equal(
    await writeMaintainedRoadmapReport(after, { id: 7, body: before }, createPublicationApi(sdk)),
    7,
  );
  assert.deepEqual(
    calls.map((call) => call.split(" ")[0]),
    ["GET", "GET", "PATCH", "GET"],
  );
});

void test("publisher refuses duplicate paginated identities before mutation", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { createPublicationApi } = await import("./roadmap-publish.mts");
  let calls = 0;
  const sdk = await fixtureGitHub(({ method }) => {
    assert.equal(method, "GET");
    calls++;
    return Response.json(
      [{ id: 1 }],
      calls === 1
        ? {
            headers: {
              link: '<https://api.github.com/repos/boburning/portcove/issues/2414/comments?page=2>; rel="next"',
            },
          }
        : {},
    );
  });
  await assert.rejects(createPublicationApi(sdk).comments(), /duplicate identity/u);
  assert.equal(calls, 2);
});

void test("publisher never replays an ambiguous SDK comment write", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { createPublicationApi } = await import("./roadmap-publish.mts");
  let writes = 0;
  const sdk = await fixtureGitHub(({ method }) => {
    if (method === "GET") return [];
    assert.equal(method, "POST");
    writes++;
    return Response.json({ message: "ambiguous write" }, { status: 503 });
  });
  await assert.rejects(
    writeMaintainedRoadmapReport(
      "<!-- portcove-roadmap-report:{} -->",
      null,
      createPublicationApi(sdk),
    ),
    /ambiguous write/u,
  );
  assert.equal(writes, 1);
});
