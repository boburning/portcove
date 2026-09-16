import assert from "node:assert/strict";
import { test } from "vitest";
import { compareStatusSnapshots, parseCliStatuses } from "./adapter-conformance.mjs";

const status = {
  port_id: "fixture",
  active: null,
  readiness: { launchable: false, blockers: ["not_installed"] },
  definition_operations: [],
};

test("parses a successful CLI status envelope", () => {
  assert.deepEqual(
    parseCliStatuses(
      JSON.stringify({
        schema_version: 48,
        ok: true,
        command: "status",
        data: [status],
        error: null,
      }),
    ),
    [status],
  );
});

test("rejects the wrong CLI response contract", () => {
  assert.throws(
    () =>
      parseCliStatuses(
        JSON.stringify({ schema_version: 48, ok: true, command: "catalog.list", data: [status] }),
      ),
    /CLI must identify the status command/,
  );
});

test("accepts exact status parity and reports adapter drift", () => {
  assert.doesNotThrow(() => compareStatusSnapshots("fresh", [status], [structuredClone(status)]));
  assert.throws(
    () =>
      compareStatusSnapshots(
        "stale",
        [status],
        [{ ...status, readiness: { launchable: true, blockers: [] } }],
      ),
    /stale: CLI and Desktop status adapters diverged/,
  );
});
