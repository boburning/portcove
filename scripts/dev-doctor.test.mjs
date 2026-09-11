import test from "node:test";
import assert from "node:assert/strict";
import { probeTool } from "./dev-doctor.mjs";

const definition = {
  id: "example",
  command: ["example", "--version"],
  version: "1.2.3",
};
test("doctor distinguishes exact, mismatched, failed and absent tools without raw output", () => {
  const run = (stdout) => () => ({ status: 0, stdout });
  assert.equal(probeTool(definition, run("example 1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("v1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("example 1.2.30")).status, "mismatch");
  assert.equal(probeTool(definition, () => ({ status: 1, stdout: "1.2.3" })).status, "unavailable");
  const missing = probeTool(definition, () => {
    throw Object.assign(new Error("SECRET"), { code: "ENOENT" });
  });
  assert.equal(missing.status, "unavailable");
  assert.ok(!JSON.stringify(missing).includes("SECRET"));
});
test("doctor reports a timeout rather than a version pass", () => {
  assert.equal(
    probeTool(definition, () => ({
      status: null,
      error: { code: "ETIMEDOUT" },
      stdout: "1.2.3",
    })).status,
    "timeout",
  );
});
