import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReleaseResults } from "./release-result-gate.mjs";

const success = {
  identity: "success",
  qualification: "success",
  validate: "success",
  build: "success",
  build_intel: "success",
  verify_intel: "success",
};

test("accepts only the complete successful release dependency set", () => {
  assert.equal(evaluateReleaseResults(success), true);
});

for (const result of ["failure", "cancelled", "timed_out", "skipped"]) {
  test(`rejects ${result} release dependencies`, () => {
    assert.throws(
      () => evaluateReleaseResults({ ...success, build: result }),
      new RegExp(`build=success, received ${result}`),
    );
  });
}

test("rejects missing and malformed release result sets", () => {
  const { verify_intel: _omitted, ...missing } = success;
  assert.throws(() => evaluateReleaseResults(missing), /missing verify_intel/);
  assert.throws(() => evaluateReleaseResults([]), /job-result object/);
});
