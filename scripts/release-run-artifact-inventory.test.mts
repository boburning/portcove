import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readCompleteRunArtifactInventory,
  readCompleteRunArtifactInventoryAsync,
  inspectCompleteRunArtifactInventory,
} from "./release-run-artifact-inventory.mts";

const rows = (count: number, start = 1) =>
  Array.from({ length: count }, (_, i) => ({ id: start + i }));
void test("complete inventories consume exactly one through four pages including a final empty inventory", () => {
  for (const size of [0, 1, 100, 101, 299, 400]) {
    const seen: number[] = [];
    const result = readCompleteRunArtifactInventory((page) => {
      seen.push(page);
      return { total_count: size, artifacts: rows(size).slice((page - 1) * 100, page * 100) };
    });
    assert.equal(result.total_count, size);
    assert.deepEqual(result.artifacts, rows(size));
    assert.deepEqual(
      seen,
      Array.from({ length: Math.max(1, Math.ceil(size / 100)) }, (_, i) => i + 1),
    );
  }
});
void test("oversize, changing, duplicate and omitted inventory refuse without a partial result", () => {
  for (const pages of [
    [{ total_count: 401, artifacts: rows(100) }],
    [
      { total_count: 101, artifacts: rows(100) },
      { total_count: 102, artifacts: rows(1, 101) },
    ],
    [
      { total_count: 101, artifacts: rows(100) },
      { total_count: 101, artifacts: rows(1) },
    ],
    [
      { total_count: 101, artifacts: rows(100) },
      { total_count: 101, artifacts: [] },
    ],
    Array.from({ length: 4 }, (_, i) => ({ total_count: 400, artifacts: rows(99, i * 99 + 1) })),
    [{ total_count: 1, artifacts: [{ id: 0 }] }],
    [{ total_count: 1, artifacts: rows(2) }],
  ]) {
    let reads = 0;
    assert.throws(() => readCompleteRunArtifactInventory(() => pages[reads++]), /inventory/);
    assert.ok(reads <= 4);
  }
  assert.throws(
    () => inspectCompleteRunArtifactInventory({ total_count: 2, artifacts: rows(1) }),
    /incomplete/,
  );
});
void test("caller deadline refusal interrupts pagination before accepting missing tail", () => {
  let reads = 0;
  assert.throws(
    () =>
      readCompleteRunArtifactInventory(() => {
        if (++reads === 2) throw new Error("phase deadline elapsed");
        return { total_count: 101, artifacts: rows(100) };
      }),
    /phase deadline/,
  );
  assert.equal(reads, 2);
});

void test("async artifact inventory waits for each page and refuses duplicate identities before another read", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: number[] = [];
  const collecting = readCompleteRunArtifactInventoryAsync(async (page) => {
    seen.push(page);
    if (page === 1) {
      await first;
      return { total_count: 101, artifacts: rows(100) };
    }
    return { total_count: 101, artifacts: rows(1, 101) };
  });
  await Promise.resolve();
  assert.deepEqual(seen, [1]);
  release();
  assert.deepEqual((await collecting).artifacts, rows(101));
  assert.deepEqual(seen, [1, 2]);
  let calls = 0;
  await assert.rejects(
    readCompleteRunArtifactInventoryAsync(async () => {
      calls++;
      return { total_count: 101, artifacts: [{ id: 1 }, { id: 1 }] };
    }),
    /duplicates identity/u,
  );
  assert.equal(calls, 1);
});
