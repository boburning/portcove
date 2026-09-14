import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFastHostPolicy } from "./select-fast-host.mjs";

const sha = (character) => character.repeat(40);
const base = {
  format_version: 1,
  primary_host: "ubuntu-22.04",
  challenger_host: "windows-latest",
  minimum_comparable_heads: 3,
  minimum_median_improvement: 0.2,
  measurements: [],
};

test("retains Linux until three coverage-equivalent heads exist", () => {
  const result = evaluateFastHostPolicy({
    ...base,
    measurements: [
      { head: sha("a"), primary_seconds: 100, challenger_seconds: 50, coverage_equal: true },
      { head: sha("b"), primary_seconds: 100, challenger_seconds: 50, coverage_equal: true },
      { head: sha("c"), primary_seconds: 100, challenger_seconds: 40, coverage_equal: false },
    ],
  });
  assert.equal(result.selected, "ubuntu-22.04");
  assert.equal(result.comparable_heads, 2);
});

test("switches only at a 20 percent or better comparable median improvement", () => {
  const samples = ["a", "b", "c"].map((character, index) => ({
    head: sha(character),
    primary_seconds: [100, 110, 90][index],
    challenger_seconds: [80, 85, 75][index],
    coverage_equal: true,
  }));
  assert.equal(
    evaluateFastHostPolicy({ ...base, measurements: samples }).selected,
    "windows-latest",
  );
  assert.equal(
    evaluateFastHostPolicy({
      ...base,
      measurements: samples.map((sample) => ({ ...sample, challenger_seconds: 81 })),
    }).selected,
    "ubuntu-22.04",
  );
});

test("rejects weakened sample and threshold policy", () => {
  assert.throws(() => evaluateFastHostPolicy({ ...base, minimum_comparable_heads: 2 }), /three/u);
  assert.throws(
    () => evaluateFastHostPolicy({ ...base, minimum_median_improvement: 0.19 }),
    /20 percent/u,
  );
});
