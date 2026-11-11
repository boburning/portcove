import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserShardSequence,
  partitionByWeight,
  selectWeightedShard,
  WeightedShardSequencer,
  readBrowserWeights,
  validateBrowserWeights,
  weighItems,
  weightsFromReport,
} from "./browser-shard-balance.mts";

const items = (weights: Record<string, number>) =>
  Object.entries(weights).map(([key, weight]) => ({ item: key, key, weight }));

void test("every item lands in exactly one shard", () => {
  const input = items(
    Object.fromEntries(
      Array.from({ length: 160 }, (_, index) => [`f${index}.ts`, (index % 17) + 1]),
    ),
  );
  for (const count of [1, 2, 3, 4, 16]) {
    const shards = partitionByWeight(input, count);
    assert.equal(shards.length, count);
    const all = shards.flat();
    assert.equal(all.length, input.length);
    assert.deepEqual(new Set(all), new Set(input.map(({ item }) => item)));
  }
});

void test("longest items spread across the lightest shards", () => {
  const shards = partitionByWeight(items({ a: 90, b: 60, c: 50, d: 40, e: 30, f: 20, g: 10 }), 3);
  const loads = shards.map((shard) =>
    shard.reduce((sum, key) => sum + { a: 90, b: 60, c: 50, d: 40, e: 30, f: 20, g: 10 }[key]!, 0),
  );
  // Longest-first: a, b and c open the shards; each later item joins the lightest one.
  assert.deepEqual(shards, [
    ["a", "f"],
    ["b", "e", "g"],
    ["c", "d"],
  ]);
  assert.deepEqual(loads, [110, 100, 90]);
});

void test("the partition depends only on keys and weights, not input order", () => {
  const input = items({ a: 5, b: 5, c: 5, d: 5, e: 3, f: 3 });
  const forward = partitionByWeight(input, 3);
  const reverse = partitionByWeight([...input].reverse(), 3);
  assert.deepEqual(forward, reverse);
});

void test("a single shard keeps every item and invalid counts are refused", () => {
  assert.deepEqual(partitionByWeight(items({ a: 1, b: 2 }), 1)[0]?.sort(), ["a", "b"]);
  assert.throws(() => partitionByWeight(items({ a: 1 }), 0), /at least 1/u);
  assert.deepEqual(partitionByWeight([], 3), [[], [], []]);
});

void test("files without a recorded weight take the median known weight", () => {
  const weighed = weighItems(
    [
      { item: 1, key: "a" },
      { item: 2, key: "b" },
      { item: 3, key: "c" },
      { item: 4, key: "new" },
    ],
    { a: 10, b: 30, c: 20, removed: 999 },
  );
  assert.deepEqual(
    weighed.map(({ key, weight }) => [key, weight]),
    [
      ["a", 10],
      ["b", 30],
      ["c", 20],
      ["new", 20],
    ],
  );
  assert.equal(weighItems([{ item: 1, key: "x" }], {})[0]?.weight, 1);
});

void test("weights come from Vitest JSON report file durations under the root", () => {
  const root = path.join(tmpdir(), "repo");
  const weights = weightsFromReport(
    {
      testResults: [
        { name: path.join(root, "apps/b.browser.test.tsx"), startTime: 1000, endTime: 3500.4 },
        { name: path.join(root, "apps/a.browser.test.tsx"), startTime: 0, endTime: 0.2 },
        { name: path.join(tmpdir(), "outside.test.tsx"), startTime: 0, endTime: 10 },
        { name: 7, startTime: 0, endTime: 10 },
      ],
    },
    root,
  );
  assert.deepEqual(weights, { "apps/a.browser.test.tsx": 1, "apps/b.browser.test.tsx": 2500 });
});

void test("the weights file is validated before use", () => {
  assert.throws(() => validateBrowserWeights(null), /format_version 1/u);
  assert.throws(() => validateBrowserWeights({ format_version: 2, source: "", weights: {} }));
  assert.throws(
    () => validateBrowserWeights({ format_version: 1, source: "", weights: { "/abs.ts": 1 } }),
    /repository-relative/u,
  );
  assert.throws(
    () => validateBrowserWeights({ format_version: 1, source: "", weights: { "a.ts": 0 } }),
    /positive/u,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "browser-weights-"));
  try {
    const file = path.join(directory, "weights.json");
    writeFileSync(
      file,
      JSON.stringify({ format_version: 1, source: "s", purpose: "p", weights: { "a.ts": 3 } }),
    );
    assert.deepEqual(readBrowserWeights(file), { "a.ts": 3 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("the committed weights file is valid", () => {
  const weights = readBrowserWeights();
  assert.ok(Object.keys(weights).length > 0);
  for (const key of Object.keys(weights)) assert.match(key, /\.browser\.test\.tsx?$/u);
});

const root = path.join(tmpdir(), "repo");
const spec = (project: string, file: string) => ({
  project: { name: project },
  moduleId: path.join(root, ...file.split("/")),
});
const ctx = (index: number, count: number) => ({ config: { root, shard: { index, count } } });

void test("each shard process selects a disjoint part and together they cover every spec", () => {
  const files = Array.from({ length: 40 }, (_, index) =>
    spec(index % 7 ? "browser" : "browser-locale", `apps/src/f${index}.browser.test.tsx`),
  );
  const weights = Object.fromEntries(
    files
      .slice(0, 30)
      .map((file, index) => [
        path.relative(root, file.moduleId).split(path.sep).join("/"),
        (index % 9) + 1,
      ]),
  );
  // Each job lists specs independently and possibly in another order.
  const shards = [1, 2, 3].map((index) =>
    selectWeightedShard(index % 2 ? files : [...files].reverse(), ctx(index, 3), weights),
  );
  const seen = shards.flat();
  assert.equal(seen.length, files.length);
  assert.deepEqual(new Set(seen), new Set(files));
});

void test("the same file in two projects is kept as two specs", () => {
  const files = [
    spec("browser", "apps/a.browser.test.tsx"),
    spec("browser-locale", "apps/a.browser.test.tsx"),
  ];
  const weights = { "apps/a.browser.test.tsx": 5 };
  const forward = [1, 2].map((index) => selectWeightedShard(files, ctx(index, 2), weights));
  const reverse = [1, 2].map((index) =>
    selectWeightedShard([...files].reverse(), ctx(index, 2), weights),
  );
  assert.deepEqual(new Set([...forward[0]!, ...reverse[1]!]), new Set(files));
  assert.deepEqual(forward, reverse);
});

void test("shard selection requires a shard and rejects an index outside it", () => {
  const files = [spec("browser", "apps/a.browser.test.tsx")];
  assert.throws(() => selectWeightedShard(files, { config: { root } }, {}), /--shard/u);
  assert.throws(() => selectWeightedShard(files, ctx(3, 2), {}), /outside the partition/u);
});

void test("only hosted shard jobs install the weighted sequencer", () => {
  assert.deepEqual(browserShardSequence({}), {});
  assert.deepEqual(browserShardSequence({ PORTCOVE_BROWSER_SHARD: "2/3" }), {
    sequence: { sequencer: WeightedShardSequencer },
  });
});

void test("the Vitest sequencer shards through its context with the committed weights", async () => {
  const weights = readBrowserWeights();
  const keys = Object.keys(weights).slice(0, 12);
  const files = keys.map((key) => spec("browser", key));
  const shards = await Promise.all(
    [1, 2, 3].map((index) =>
      new WeightedShardSequencer({ config: ctx(index, 3).config } as never).shard(files as never),
    ),
  );
  assert.deepEqual(new Set(shards.flat()), new Set(files));
  assert.equal(shards.flat().length, files.length);
});
