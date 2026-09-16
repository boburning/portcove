import assert from "node:assert/strict";
import { test } from "vitest";
import { compareStatusSnapshots, parseCliStatuses } from "./adapter-conformance.mjs";

const status = {
  port_id: "fixture",
  active: null,
  readiness: { launchable: false, blockers: ["not_installed"] },
  definition_operations: [
    {
      operation: "install",
      eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
      retained: false,
    },
    {
      operation: "launch",
      eligibility: { outcome: "hold", reason: "publisher_revoked" },
      retained: true,
    },
  ],
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
  assert.throws(
    () =>
      compareStatusSnapshots(
        "operation",
        [status],
        [
          {
            ...structuredClone(status),
            definition_operations: status.definition_operations.map((assessment) =>
              assessment.operation === "launch"
                ? {
                    ...assessment,
                    eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
                  }
                : assessment,
            ),
          },
        ],
      ),
    /operation: CLI and Desktop status adapters diverged/,
  );
});
