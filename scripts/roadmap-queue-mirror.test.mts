import assert from "node:assert/strict";
import test from "node:test";
import { mirrorMarker, renderQueueMirror, selectMirrorComment } from "./roadmap-queue-mirror.mts";

const base = { release: "Public beta", generatedAt: "2026-11-09T00:00:00Z", commit: "abc" };

void test("render wraps readiness with the marker and authority notice", () => {
  const body = renderQueueMirror({
    ...base,
    readiness: "# Public beta readiness\n\n- Result: NOT READY\n",
  });
  assert.ok(body.startsWith(mirrorMarker));
  assert.match(body, /Project remains the planning authority/u);
  assert.match(body, /Result: NOT READY/u);
});

void test("render rejects output for another release and marks truncation UNKNOWN", () => {
  assert.throws(() => renderQueueMirror({ ...base, readiness: "# 1.0 readiness\n" }));
  const long = `# Public beta readiness\n${"- item\n".repeat(20000)}`;
  const body = renderQueueMirror({ ...base, readiness: long });
  assert.ok(body.length <= 60000);
  assert.match(body, /remaining items are UNKNOWN/u);
});

void test("selection accepts only the Actions bot's marked comment and rejects duplicates", () => {
  const bot = { type: "Bot", login: "github-actions[bot]" };
  const mine = { id: 1, body: `${mirrorMarker}\nx`, user: bot };
  assert.equal(
    selectMirrorComment([{ id: 2, body: mirrorMarker, user: { type: "User", login: "x" } }, mine]),
    mine,
  );
  assert.throws(() => selectMirrorComment([mine, { ...mine, id: 3 }]));
});
