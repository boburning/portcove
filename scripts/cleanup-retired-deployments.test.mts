import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyBatch,
  deletionDecision,
  repository,
  validateDeployment,
  validateManifest,
  type Candidate,
  type Deployment,
  type Operations,
} from "./cleanup-retired-deployments.mts";

const candidates = validateManifest(
  JSON.parse(
    await readFile(
      new URL("./maintenance/retired-deployments-2026-11-16.json", import.meta.url),
      "utf8",
    ),
  ),
);
const hash = "a".repeat(64);
const marker = `Portcove cleanup 2026-11-16 archive ${hash}`;
function deployment(candidate: Candidate, state = "SUCCESS"): Deployment {
  const status = { id: `status-${candidate.id}`, state, description: "Original job result" };
  return {
    id: candidate.node_id,
    commitOid: candidate.sha,
    environment: candidate.environment,
    createdAt: candidate.created_at,
    repository: { nameWithOwner: repository },
    latestStatus: status,
    statuses: { totalCount: 1, nodes: [status], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}
function append(value: Deployment, state: string, description: string): Deployment {
  const copy = structuredClone(value),
    status = { id: "new-status", state, description };
  copy.latestStatus = status;
  copy.statuses.nodes.push(status);
  copy.statuses.totalCount++;
  return copy;
}
function harness(items: Candidate[], states: string[] = []) {
  const current = new Map(items.map((c, i) => [c.id, deployment(c, states[i] ?? "SUCCESS")]));
  const calls: { operation: string; id: number; description?: string }[] = [];
  const api: Operations = {
    async inventory() {
      return [...current.keys()].map((id) => ({ id }));
    },
    async read(batch) {
      return batch.map((c) => current.get(c.id) ?? null);
    },
    async inactivate(id, description) {
      calls.push({ operation: "inactivate", id, description });
      current.set(id, append(current.get(id)!, "INACTIVE", description));
    },
    async remove(id) {
      calls.push({ operation: "delete", id });
      current.delete(id);
    },
  };
  return { api, current, calls };
}

await test("the fixed manifest contains 382 unique historical non-Pages identities", () => {
  assert.equal(candidates.length, 382);
  for (const change of [
    (values: Candidate[]) => {
      values[0]!.environment = "github-pages";
    },
    (values: Candidate[]) => {
      values[0]!.environment = "new-production-site";
    },
    (values: Candidate[]) => {
      values[0]!.created_at = "2026-11-17T00:00:00Z";
    },
    (values: Candidate[]) => {
      values[0] = values[1]!;
    },
    (values: Candidate[]) => {
      values[0]!.sha = "changed";
    },
  ]) {
    const values = structuredClone(candidates);
    change(values);
    assert.throws(() => validateManifest(values));
  }
  assert.throws(() => validateManifest(candidates.slice(1)));
});

await test("pagination, null nodes, duplicate statuses and missing latest evidence refuse deletion", () => {
  const c = candidates[0]!,
    original = deployment(c);
  const incomplete = structuredClone(original);
  incomplete.statuses.pageInfo.hasNextPage = true;
  assert.throws(() => validateDeployment(incomplete, c), /Incomplete/);
  const duplicate = structuredClone(original);
  duplicate.statuses.nodes.push(duplicate.statuses.nodes[0]!);
  duplicate.statuses.totalCount++;
  assert.throws(() => validateDeployment(duplicate, c), /Invalid status/);
  const missing = structuredClone(original);
  missing.latestStatus = { id: "unarchived", state: "SUCCESS", description: "" };
  assert.throws(() => validateDeployment(missing, c), /Latest status/);
  assert.throws(() =>
    validateDeployment({ ...original, statuses: { ...original.statuses, nodes: [null] } }, c),
  );
});

await test("all unfinished and unknown archived states remain untouched", () => {
  const c = candidates[0]!;
  for (const state of ["PENDING", "QUEUED", "WAITING", "IN_PROGRESS", "UNKNOWN"]) {
    const original = deployment(c, state);
    assert.equal(deletionDecision(c, original, original, marker), "skip-unfinished");
  }
  const empty = deployment(c);
  empty.latestStatus = null;
  empty.statuses.nodes = [];
  empty.statuses.totalCount = 0;
  assert.equal(deletionDecision(c, empty, empty, marker), "skip-unfinished");
});

await test("changed identity or status cannot inherit archival permission", () => {
  const c = candidates[0]!,
    original = deployment(c);
  assert.throws(() =>
    deletionDecision(c, original, { ...original, commitOid: "b".repeat(40) }, marker),
  );
  assert.throws(() =>
    deletionDecision(c, original, { ...original, environment: "github-pages" }, marker),
  );
  assert.throws(() =>
    deletionDecision(
      c,
      original,
      { ...original, repository: { nameWithOwner: "other/repo" } },
      marker,
    ),
  );
  assert.equal(
    deletionDecision(c, original, append(original, "IN_PROGRESS", "Restarted"), marker),
    "skip-changed",
  );
  assert.equal(
    deletionDecision(c, original, append(original, "SUCCESS", "New result"), marker),
    "skip-changed",
  );
  assert.equal(
    deletionDecision(c, original, append(original, "INACTIVE", "Someone else retired it"), marker),
    "skip-changed",
  );
});

await test("only this archive's exact inactivation can resume an interrupted deletion", () => {
  const c = candidates[0]!,
    original = deployment(c);
  assert.equal(
    deletionDecision(c, original, append(original, "INACTIVE", marker), marker),
    "delete",
  );
  const missingHistory = append(original, "INACTIVE", marker);
  missingHistory.statuses.nodes.shift();
  missingHistory.statuses.totalCount--;
  assert.equal(deletionDecision(c, original, missingHistory, marker), "skip-changed");
  assert.equal(deletionDecision(c, original, null, marker), "already-absent");
});

await test("eligible records inactivate individually and inactive records delete directly", async () => {
  const items = candidates.slice(0, 3),
    { api, calls } = harness(items, ["SUCCESS", "ERROR", "INACTIVE"]);
  const archived = items.map((c, i) => deployment(c, ["SUCCESS", "ERROR", "INACTIVE"][i]));
  const removed = await applyBatch(api, items, archived, 1, hash, async () => {});
  assert.deepEqual(
    removed,
    items.map((c) => c.id),
  );
  assert.deepEqual(
    calls.map((c) => c.operation),
    ["inactivate", "delete", "inactivate", "delete", "delete"],
  );
  assert.equal(calls[0]!.description, marker);
});

await test("an ambiguous mutation stops immediately and is never retried", async () => {
  const items = candidates.slice(0, 2),
    { api, calls } = harness(items);
  api.remove = async (id) => {
    calls.push({ operation: "ambiguous-delete", id });
    throw new Error("Disconnected after send");
  };
  await assert.rejects(
    applyBatch(
      api,
      items,
      items.map((c) => deployment(c)),
      1,
      hash,
      async () => {},
    ),
    /Disconnected/,
  );
  assert.deepEqual(
    calls.map((c) => c.operation),
    ["inactivate", "ambiguous-delete"],
  );
});

await test("a failed inactivation cannot fall through to delete", async () => {
  const items = candidates.slice(0, 2),
    { api, calls } = harness(items);
  api.inactivate = async () => {
    throw new Error("Refused");
  };
  await assert.rejects(
    applyBatch(
      api,
      items,
      items.map((c) => deployment(c)),
      1,
      hash,
      async () => {},
    ),
    /Refused/,
  );
  assert.deepEqual(calls, []);
});

await test("readback detects a supposedly deleted record that still exists", async () => {
  const items = candidates.slice(0, 1),
    { api } = harness(items);
  api.remove = async () => {};
  await assert.rejects(
    applyBatch(
      api,
      items,
      items.map((c) => deployment(c)),
      1,
      hash,
      async () => {},
    ),
    /remains in readback/,
  );
});

await test("a batch cannot touch earlier or later candidate IDs", async () => {
  const items = candidates.slice(0, 102),
    { api, current, calls } = harness(
      items,
      items.map(() => "INACTIVE"),
    );
  const archived = items.map((c) => deployment(c, "INACTIVE"));
  await applyBatch(api, items, archived, 2, hash, async () => {});
  assert.deepEqual(
    calls.map((c) => c.id),
    items.slice(50, 100).map((c) => c.id),
  );
  assert.equal(current.size, 52);
  for (const batch of [0, 9, 1.5])
    await assert.rejects(applyBatch(api, items, archived, batch, hash, async () => {}));
  await assert.rejects(applyBatch(api, items, archived, 1, "unverified", async () => {}));
});

await test("unfinished and externally changed candidates produce receipts and no writes", async () => {
  const items = candidates.slice(0, 3),
    { api, current, calls } = harness(items, ["PENDING", "SUCCESS", "SUCCESS"]);
  const archived = items.map((c, i) => deployment(c, i === 0 ? "PENDING" : "SUCCESS"));
  current.set(items[1]!.id, append(archived[1]!, "SUCCESS", "Later publication"));
  current.delete(items[2]!.id);
  const receipts: unknown[] = [];
  await applyBatch(api, items, archived, 1, hash, async (value) => {
    receipts.push(value);
  });
  assert.deepEqual(calls, []);
  assert.equal(receipts.length, 4);
});
