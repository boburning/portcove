import assert from "node:assert/strict";
import test from "node:test";

import { validateRustTimingHints } from "./windows-rust-tests.mts";
import {
  buildTimingHints,
  parseJunitCases,
  slowTestSummary,
  slowTests,
} from "./rust-timing-hints.mts";

const xml = `<testsuites><testsuite name="a">
<testcase name="m::tests::fast_one" classname="core::bin" time="0.010"></testcase>
<testcase name="m::tests::fast_two" classname="core::bin" time="0.030"></testcase>
<testcase name="m::tests::slow &amp; steady" classname="core::bin" time="5.5"></testcase>
<testcase name="top_level" classname="core::bin" time="0.2"></testcase>
</testsuite></testsuites>`;

void test("JUnit cases are parsed with XML entities decoded", () => {
  const cases = parseJunitCases(xml);
  assert.equal(cases.length, 4);
  assert.equal(cases[2]?.name, "m::tests::slow & steady");
});

void test("generated hints validate and split slow tests from module families", () => {
  const hints = buildTimingHints(parseJunitCases(xml), "run", 2);
  validateRustTimingHints(hints);
  assert.deepEqual(hints.tests, [["core::bin", "m::tests::slow & steady", 5.5]]);
  assert.deepEqual(hints.families, [["core::bin", "m::tests::", 0.02]]);
  assert.throws(() => buildTimingHints([], "run"), /No JUnit/u);
});

void test("slow-test summary flags only tests over the timeout fraction", () => {
  const cases = parseJunitCases(xml);
  assert.equal(slowTests(cases, 5).length, 1);
  assert.match(slowTestSummary(cases, 10), /slow & steady/u);
  assert.match(slowTestSummary(cases, 100), /No Rust test used more than 50%/u);
});
