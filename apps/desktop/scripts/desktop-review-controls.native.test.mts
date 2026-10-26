import assert from "node:assert/strict";
import test from "node:test";
import { decodeDiscoverPortIds } from "./desktop-review-controls.mts";

void test("native Discover observations preserve separate exact ports without grouping by display title", () => {
  assert.deepEqual(decodeDiscoverPortIds('["render96ex","super-mario-64-sm64-co-op-dx"]'), [
    "render96ex",
    "super-mario-64-sm64-co-op-dx",
  ]);
  for (const invalid of [
    null,
    "{}",
    '"render96ex"',
    '["render96ex",null]',
    '["render96ex","render96ex"]',
    '[""]',
  ])
    assert.throws(() => decodeDiscoverPortIds(invalid));
});
