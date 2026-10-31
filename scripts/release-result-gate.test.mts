import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReleaseResults } from "./release-result-gate.mts";

const success = {
  identity: "success",
  qualification: "success",
  validate: "success",
  build: "success",
  build_intel: "success",
  verify_intel: "success",
};

void test("accepts only the complete successful release dependency set", () => {
  assert.equal(evaluateReleaseResults(success), true);
});

void test("named beta requires every applicable validator/build and explicit inapplicable mac jobs", () => {
  const beta = { ...success, build_intel: "skipped", verify_intel: "skipped" };
  assert.equal(evaluateReleaseResults(beta, "initial-beta-win-linux"), true);
  assert.throws(() => evaluateReleaseResults(beta), /build_intel=success/);
  assert.throws(
    () => evaluateReleaseResults(success, "initial-beta-win-linux"),
    /build_intel=skipped/,
  );
  assert.throws(
    () => evaluateReleaseResults(beta, "windows-only"),
    /unknown trusted release profile/,
  );
  for (const name of ["identity", "qualification", "validate", "build"])
    assert.throws(
      () => evaluateReleaseResults({ ...beta, [name]: "skipped" }, "initial-beta-win-linux"),
      new RegExp(`${name}=success`),
    );
});

void test("Windows first beta still requires every shared and Windows decision", () => {
  const profile = "initial-beta-windows-x86_64-v1";
  const windows = { ...success, build_intel: "skipped", verify_intel: "skipped" };
  assert.equal(evaluateReleaseResults(windows, profile), true);
  for (const name of ["identity", "qualification", "validate", "build"])
    for (const state of ["skipped", "failure", "cancelled", undefined])
      assert.throws(() => evaluateReleaseResults({ ...windows, [name]: state }, profile));
  assert.throws(() => evaluateReleaseResults(success, profile), /build_intel=skipped/);
});

for (const result of ["failure", "cancelled", "timed_out", "skipped"]) {
  void test(`rejects ${result} release dependencies`, () => {
    assert.throws(
      () => evaluateReleaseResults({ ...success, build: result }),
      new RegExp(`build=success, received ${result}`),
    );
  });
}

void test("rejects missing and malformed release result sets", () => {
  const { verify_intel: _omitted, ...missing } = success;
  assert.throws(() => evaluateReleaseResults(missing), /missing verify_intel/);
  assert.throws(() => evaluateReleaseResults([]), /job-result object/);
});
