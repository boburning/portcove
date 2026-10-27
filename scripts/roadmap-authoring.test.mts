import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RoadmapBodyJournal, bodyOperationHash } from "./roadmap-body-progress.mts";
import { continueRoadmapCapacity, roadmapQuotaDeferred } from "./roadmap-capacity-continuation.mts";
import type { BodyWriteOptions, BodyApi } from "./github-body.mts";
import {
  validateConfig,
  validateDurableIssueBody,
  validatePortStageSemantics,
} from "./roadmap.mts";
import { renderPortIssueBody, renderPortResearchDeclaration } from "./roadmap-issue.mts";
import { validateRoadmapReplacement } from "./roadmap-authoring.mts";
import { writeGitHubBody } from "./github-body.mts";
import { editRoadmapBatch } from "./roadmap-edit.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import { scopedIssueWithBlockers } from "./roadmap-scoped.mts";
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);

void test("live authoring consumes the same enriched blocker memberships as scoped doctor", () => {
  const { item, body } = issue();
  assert(item.content);
  item.content.blockedBy = { totalCount: 1, nodes: [{ id: "I_blocker", number: 2 }] };
  assert.throws(
    () => validateRoadmapReplacement(config, { ports: [] }, item, body, body),
    /membership is unverified/u,
  );
  const observed = scopedIssueWithBlockers(item, [
    { id: "I_blocker", number: 2, projectItemId: "PVTI_blocker" },
  ]);
  assert.doesNotThrow(() =>
    validateRoadmapReplacement(config, { ports: [] }, observed, body, body),
  );
  assert.throws(
    () =>
      validateRoadmapReplacement(
        config,
        { ports: [] },
        scopedIssueWithBlockers(item, [{ id: "I_blocker", number: 2, projectItemId: null }]),
        body,
        body,
      ),
    /outside the configured active Project/u,
  );
});
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
    "Blocker: Upstream lacks a usable player.\nResume condition:\nReconsideration condition: TBD",
    "Blocker:\nResume condition: Upstream publishes a usable player.",
    "Blocker: Upstream lacks a usable player.\nResume condition:\nAnother unrelated paragraph is substantive text.",
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
void test("larger body batches retain scoped-check failures without a count-triggered global inventory", async () => {
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
        assert.equal(mode, "issues");
        assert.equal(issues.length, 1);
        throw new Error("Inventory changed: Unable to verify");
      },
    ),
    /Unable to verify/,
  );
  assert.equal(writes, 11);
  assert.equal(audits, 1);
});

function durableBodies(count: number) {
  const edits: BodyWriteOptions[] = Array.from({ length: count }, (_, i) => ({
    operation: "issue-edit",
    target: i + 1,
    previousBody: `## User outcome\nOriginal ${i + 1}`,
    body: `## User outcome\nRevised ${i + 1}`,
  }));
  const bodies = new Map(edits.map((edit) => [Number(edit.target), String(edit.previousBody)]));
  const writes = new Map<number, number>();
  const api: BodyApi = {
    request: (method, endpoint, payload) => {
      const number = Number(endpoint.split("/").at(-1));
      if (method === "PATCH") {
        assert(payload && typeof payload === "object" && "body" in payload);
        bodies.set(number, String(payload.body));
        writes.set(number, (writes.get(number) ?? 0) + 1);
      }
      return {
        body: { id: number + 1000, number, title: "Finite task", body: bodies.get(number) },
      };
    },
    validateRoadmapReplacement: () => {},
  };
  const identity = () =>
    bodyOperationHash({
      contract: 1,
      config: JSON.parse(
        readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
      ) as unknown,
      input: edits.map((edit) => ({
        number: Number(edit.target),
        body_sha256: bodyOperationHash(edit.body),
        previous_sha256: bodyOperationHash(edit.previousBody),
      })),
    });
  return { edits, bodies, writes, api, identity };
}
void test("127 issue bodies complete through automatically reset windows with durable preflight, readback and scoped checks", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-bodies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = durableBodies(127),
    file = path.join(root, "journal.json");
  let now = Date.parse("2026-10-27T00:00:00Z"),
    capacity = 30,
    resets = 0,
    requests = 0;
  const api: BodyApi = {
    ...h.api,
    request: (...args) => {
      capacity--;
      requests++;
      return h.api.request(...args);
    },
  };
  const checked: number[] = [];
  const result = await continueRoadmapCapacity(
    () =>
      editRoadmapBatch(
        h.edits,
        api,
        async (issues, mode) => {
          assert.equal(mode, "issues");
          checked.push(...issues);
          return { status: "passed", issues };
        },
        {
          progress: new RoadmapBodyJournal(file, h.identity(), h.edits.length),
          admit: (phase, index) => {
            if (capacity < 5)
              throw roadmapQuotaDeferred(
                phase,
                { index },
                { remaining: capacity, resetAt: new Date(now + 1000).toISOString() },
              );
          },
        },
      ),
    {
      now: () => now,
      wait: async () => {
        resets++;
        assert.ok(resets < 1000);
        now += 1000;
        capacity = 30;
      },
      identity: h.identity,
    },
  );
  assert.equal(result.results.length, 127);
  assert.ok(resets > 5);
  assert.equal(h.writes.size, 127);
  assert.ok([...h.writes.values()].every((count) => count === 1));
  assert.deepEqual(
    checked,
    Array.from({ length: 127 }, (_, i) => i + 1),
  );
  assert.equal(new RoadmapBodyJournal(file, h.identity(), 127).state.phase, "completed");
  assert.equal(result.verification_interval.atomic_global_snapshot, false);
  assert.ok(requests > 127 * 4);
});
void test("a completed body write with a lost response resumes readback without resending, while an unapplied ambiguous write stays held", async (t) => {
  for (const applied of [true, false]) {
    const root = mkdtempSync(path.join(tmpdir(), "roadmap-body-ambiguous-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const h = durableBodies(3),
      file = path.join(root, "journal.json");
    let lost = true;
    const api: BodyApi = {
      ...h.api,
      request: (method, ...args) => {
        if (method === "PATCH" && lost) {
          lost = false;
          if (applied) h.api.request(method, ...args);
          throw new Error("original mutation response lost");
        }
        return h.api.request(method, ...args);
      },
    };
    const run = () =>
      editRoadmapBatch(h.edits, api, async () => ({ status: "passed" }), {
        progress: new RoadmapBodyJournal(file, h.identity(), 3),
      });
    await assert.rejects(run(), /original mutation response lost/u);
    assert.deepEqual(new RoadmapBodyJournal(file, h.identity(), 3).state.uncertain, [0]);
    if (applied) {
      await run();
      assert.equal(h.writes.get(1), 1);
      assert.equal(h.writes.size, 3);
    } else {
      await assert.rejects(run(), /ambiguous prior write/u);
      assert.equal(h.writes.size, 0);
    }
  }
});
void test("resumption detects reversed verified bodies before any new writes and source changes refuse before API access", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-body-conflict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = durableBodies(5),
    file = path.join(root, "journal.json");
  await assert.rejects(
    editRoadmapBatch(h.edits, h.api, async () => {}, {
      progress: new RoadmapBodyJournal(file, h.identity(), 5),
      admit: (phase, index) => {
        if (phase === "body-mutation" && index === 2)
          throw new Error("interrupted after two complete writes");
      },
    }),
    /interrupted/u,
  );
  assert.equal(h.writes.size, 2);
  h.bodies.set(1, "## User outcome\nConcurrent owner edit");
  await assert.rejects(
    editRoadmapBatch(h.edits, h.api, async () => {}, {
      progress: new RoadmapBodyJournal(file, h.identity(), 5),
    }),
    /previously verified body changed/u,
  );
  assert.equal(h.writes.size, 2);
  h.edits[3]!.body = "## User outcome\nChanged source";
  assert.throws(() => new RoadmapBodyJournal(file, h.identity(), 5), /binding or shape changed/u);
});
void test("final read and per-issue doctor positions survive interruption without false completeness", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-body-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = durableBodies(5),
    file = path.join(root, "journal.json");
  let interrupted = true;
  const run = () =>
    editRoadmapBatch(
      h.edits,
      h.api,
      async (issues) => {
        if (interrupted && issues[0] === 3) {
          interrupted = false;
          throw new Error("original scoped check failure");
        }
        return { status: "passed", issues };
      },
      { progress: new RoadmapBodyJournal(file, h.identity(), 5) },
    );
  await assert.rejects(run(), /original scoped check failure/u);
  const partial = new RoadmapBodyJournal(file, h.identity(), 5);
  assert.equal(partial.state.phase, "doctor");
  assert.deepEqual(partial.state.doctors, [0, 1]);
  await run();
  assert.ok([...h.writes.values()].every((count) => count === 1));
  const complete = new RoadmapBodyJournal(file, h.identity(), 5);
  assert.equal(complete.state.phase, "completed");
  complete.state.checked = [];
  complete.save();
  assert.throws(() => new RoadmapBodyJournal(file, h.identity(), 5), /incomplete completion/u);
});

void test("an exact desired body reached after staged preflight resumes without PATCH or journal reset", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-body-desired-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = durableBodies(3),
    file = path.join(root, "journal.json");
  await assert.rejects(
    editRoadmapBatch(h.edits, h.api, async () => {}, {
      progress: new RoadmapBodyJournal(file, h.identity(), 3),
      admit: (phase) => {
        if (phase === "body-mutation") throw new Error("pause after complete preflight");
      },
    }),
    /pause/u,
  );
  assert.equal(h.writes.size, 0);
  h.bodies.set(1, String(h.edits[0]!.body));
  const result = await editRoadmapBatch(h.edits, h.api, async () => ({ status: "passed" }), {
    progress: new RoadmapBodyJournal(file, h.identity(), 3),
  });
  assert.equal(result.results.length, 3);
  assert.equal(h.writes.has(1), false);
  assert.equal(h.writes.size, 2);
});
