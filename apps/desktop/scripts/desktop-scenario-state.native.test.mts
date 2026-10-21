import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";

const context = { cli: "owned-cli", library: "isolated-library", output: "isolated-output" };

void test("owned adoption gets bounded copy time without changing later observation budgets", () => {
  const budgets: Array<number | undefined> = [];
  const command = ownedFixtureCommand(context, (_cli, _args, options) => {
    budgets.push(options.timeout);
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { id: "owned-result" } }) };
  });
  assert.deepEqual(command(["adopt", "original", "--port", "exact-port", "--yes"]), {
    id: "owned-result",
  });
  command(["status", "exact-port"]);
  command(["catalog", "show", "exact-port"]);
  assert.deepEqual(budgets, [60_000, 15_000, 15_000]);
});

void test("fixture timeout preserves cause and process observations without granting success", () => {
  const failure = Object.assign(new Error("fixture reply timed out"), { code: "ETIMEDOUT" });
  const command = ownedFixtureCommand(context, () => ({
    status: null,
    signal: "SIGTERM",
    error: failure,
    stdout: "partial reply",
    stderr: "retained diagnostic",
  }));
  assert.throws(
    () => command(["adopt", "original"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      assert.match(error.message, /"family":"adopt"/);
      assert.match(error.message, /"timeout_ms":60000/);
      assert.match(error.message, /"signal":"SIGTERM"/);
      assert.match(error.message, /partial reply/);
      return true;
    },
  );
});

void test("throwing spawn adapters keep their original failure as the cause", () => {
  const failure = Object.assign(new Error("launch timed out"), { code: "ETIMEDOUT" });
  const command = ownedFixtureCommand(context, () => {
    throw failure;
  });
  assert.throws(
    () => command(["status", "exact-port"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      assert.match(error.message, /"family":"status"/);
      assert.match(error.message, /"timeout_ms":15000/);
      assert.match(error.message, /"process_result_available":false/);
      return true;
    },
  );
});

void test("a nonzero fixture process still refuses even with a success-shaped reply", () => {
  const command = ownedFixtureCommand(context, () => ({
    status: 1,
    stdout: JSON.stringify({ ok: true, data: { id: "untrusted-result" } }),
  }));
  assert.throws(() => command(["adopt", "original"]), assert.AssertionError);
});
