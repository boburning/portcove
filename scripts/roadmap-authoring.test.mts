import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  validateConfig,
  renderPortIssueBody,
  validateDurableIssueBody,
  validatePortStageSemantics,
  renderPortResearchDeclaration,
} from "./roadmap.mts";
import { validateRoadmapReplacement } from "./roadmap-authoring.mts";
import { writeGitHubBody } from "./github-body.mts";
import { editRoadmapBatch } from "./roadmap-edit.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function issue(
  number = 1,
  blocker = "Blocker: Upstream lacks a playable native player.\nResume condition: Upstream publishes a playable native player.",
) {
  const body = renderPortIssueBody({
    title: "Wave Race",
    upstream: "https://example.test/wave",
    portKey: "wave-race",
    blocker,
  });
  const item: RoadmapIssueItem = {
    id: `PVTI_${number}`,
    "Work type": "Port",
    "Port stage": "Blocked",
    Status: "Blocked",
    "Target release": "Unscheduled",
    "Release commitment": "Planned",
    content: {
      type: "Issue",
      number,
      body,
      title: "[Port] Wave Race",
      state: "OPEN",
      url: `https://github.com/${config.repository}/issues/${number}`,
    },
  };
  return { body, item };
}
void test("explicit reconsideration fields pass without incidental resume verbs; placeholders fail", () => {
  for (const label of ["Resume condition", "Reconsideration condition"]) {
    const { item } = issue(
      1,
      `Blocker: Upstream lacks a playable native player.\n${label}: Upstream publishes a playable native player.`,
    );
    assert.deepEqual(validatePortStageSemantics({ ports: [] }, [item]).errors, []);
  }
  for (const blocker of [
    "Blocker: TBD\nResume condition: Upstream publishes a native player.",
    "Blocker: Upstream lacks a native player.\nResume condition: Pending",
    "Resume condition: Upstream publishes a native player.",
    "Blocker: Upstream lacks a native player.",
    "Blocker: Unknown until further research.\nResume condition: Upstream publishes a native player.",
  ]) {
    assert.equal(
      validatePortStageSemantics({ ports: [] }, [issue(1, blocker).item]).errors.length,
      1,
      blocker,
    );
  }
});
void test("production writer rejects lost metadata and identity before PATCH", () => {
  const { item, body } = issue();
  let writes = 0;
  const api = {
    request: (method: string) => {
      if (method !== "GET") writes++;
      return { body: { id: 1, number: 1, title: "[Port] Wave Race", body } };
    },
    validateRoadmapReplacement: (_number: number, previous: string, replacement: string) =>
      validateRoadmapReplacement(config, { ports: [] }, item, previous, replacement),
  };
  const missing = body
    .replace(renderPortResearchDeclaration(), "")
    .replace("Not assigned (researched candidate)", "Unassigned");
  assert.throws(() => validateDurableIssueBody(missing), /research\/watchlist/);
  assert.throws(
    () =>
      writeGitHubBody(
        { operation: "issue-edit", target: 1, previousBody: body, body: missing },
        api,
      ),
    /research\/watchlist/,
  );
  assert.throws(
    () =>
      writeGitHubBody(
        {
          operation: "issue-edit",
          target: 1,
          previousBody: body,
          body: body.replace("portcove-port-key: wave-race", "portcove-port-key: other-game"),
        },
        api,
      ),
    /canonical identity/,
  );
  assert.equal(writes, 0);
  assert.doesNotThrow(() =>
    validateRoadmapReplacement(
      config,
      { ports: [] },
      item,
      body,
      body.replace("Not assigned (researched candidate)", "Unassigned"),
    ),
  );
});
void test("invalid second batch proposal prevents every mutation and final audit", async () => {
  const first = issue(1),
    second = issue(2);
  let writes = 0,
    audits = 0;
  await assert.rejects(
    editRoadmapBatch(
      [first, second].map(({ body }, index) => ({
        operation: "issue-edit",
        target: index + 1,
        previousBody: body,
        body: index
          ? body.replace("portcove-port-key: wave-race", "portcove-port-key: other-game")
          : body,
      })),
      {
        request: (method, endpoint) => {
          if (method !== "GET") writes++;
          const number = Number(endpoint.split("/").at(-1));
          return { body: { id: number, number, title: "[Port] Wave Race", body: first.body } };
        },
        validateRoadmapReplacement: (number, previous, body) =>
          validateRoadmapReplacement(config, { ports: [] }, issue(number).item, previous, body),
      },
      async () => {
        audits++;
      },
    ),
    /canonical identity/,
  );
  assert.equal(writes, 0);
  assert.equal(audits, 0);
});
void test("substantial batch ends with one explicit global check, retaining its failure", async () => {
  const bodies = new Map(
    Array.from({ length: 11 }, (_, index) => [index + 1, issue(index + 1).body]),
  );
  let writes = 0,
    audits = 0;
  await assert.rejects(
    editRoadmapBatch(
      [...bodies].map(([number, body]) => ({
        operation: "issue-edit",
        target: number,
        previousBody: body,
        body: body + "\nAdditional evidence.",
      })),
      {
        request: (method, endpoint, payload) => {
          const number = Number(endpoint.split("/").at(-1));
          if (method === "PATCH") {
            writes++;
            assert(
              payload &&
                typeof payload === "object" &&
                "body" in payload &&
                typeof payload.body === "string",
            );
            bodies.set(number, payload.body);
          }
          return {
            body: { id: number, number, title: "[Port] Wave Race", body: bodies.get(number) },
          };
        },
        validateRoadmapReplacement: (number, previous, body) => {
          const observed = issue(number).item;
          observed.content = { ...observed.content, body: previous };
          validateRoadmapReplacement(config, { ports: [] }, observed, previous, body);
        },
      },
      async (issues, mode) => {
        audits++;
        assert.equal(mode, "global");
        assert.equal(issues.length, 11);
        throw new Error("Inventory changed: Unable to verify");
      },
    ),
    /Unable to verify/,
  );
  assert.equal(writes, 11);
  assert.equal(audits, 1);
});
