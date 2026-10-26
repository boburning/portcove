import { portStatus } from "../src/test-fixtures";
import { errorCode } from "../../../scripts/runtime-values.mts";
import type { SpawnSyncReturns, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import assert from "node:assert/strict";
import process from "node:process";
import { test, vi } from "vite-plus/test";
import {
  compareConsumerIdentities,
  compareStatusSnapshots,
  parseCliStatuses,
  runSync,
} from "./adapter-conformance.mts";

const spawnObservation = vi.hoisted<{ error: Error | undefined }>(() => ({ error: undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync(
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> {
      const result = actual.spawnSync(command, args, options);
      spawnObservation.error = result.error;
      return result;
    },
  };
});

test("each compiled consumer keeps its pre-publication identity", () => {
  const before = { cli: "a".repeat(64), desktop: "b".repeat(64) };
  assert.doesNotThrow(() => compareConsumerIdentities(before, structuredClone(before)));
  for (const consumer of ["cli", "desktop"]) {
    assert.throws(
      () => compareConsumerIdentities(before, { ...before, [consumer]: "c".repeat(64) }),
      /compiled consumers changed/,
    );
  }
});

const status = {
  ...portStatus(),
  port_id: "fixture",
  active: null,
  readiness: { launchable: false, pending_setup: false, blockers: [] },
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
      48,
    ),
    [status],
  );
});

test("rejects the wrong CLI response contract", () => {
  assert.throws(
    () =>
      parseCliStatuses(
        JSON.stringify({
          schema_version: 48,
          ok: true,
          command: "catalog.list",
          data: [status],
          error: null,
        }),
        48,
      ),
    /CLI must identify the status command/,
  );
});

const envelope = { schema_version: 48, ok: true, command: "status", data: [status], error: null };
test.each([
  ["wrong schema", { ...envelope, schema_version: 49 }],
  ["missing schema", { ...envelope, schema_version: undefined }],
  ["unsuccessful result", { ...envelope, ok: false }],
  ["success carrying failure", { ...envelope, error: { message: "owned failure" } }],
  ["missing error marker", { ...envelope, error: undefined }],
  ["non-array statuses", { ...envelope, data: {} }],
  ["missing port identity", { ...envelope, data: [{ ...status, port_id: undefined }] }],
  [
    "invalid readiness",
    { ...envelope, data: [{ ...status, readiness: { launchable: "yes", blockers: [] } }] },
  ],
])("rejects serialized %s before comparing adapters", (_name, value) => {
  assert.throws(() => parseCliStatuses(JSON.stringify(value), 48));
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

const timeoutChild = [
  "-e",
  "process.stdout.write('owned-stdout-marker'); process.stderr.write('owned-stderr-marker'); setInterval(() => {}, 1000)",
];

test("synchronous timeout retains both streams and the original failure", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    assert.throws(
      () => runSync(process.execPath, timeoutChild, { timeout: 1000 }),
      (error: unknown) => errorCode(error) === "ETIMEDOUT" && error === spawnObservation.error,
    );
    assert.equal(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""), "owned-stdout-marker");
    assert.equal(stderr.mock.calls.map(([chunk]) => String(chunk)).join(""), "owned-stderr-marker");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("diagnostic write failure still attempts the other stream and retains the timeout", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    throw new Error("owned diagnostic write failure");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    assert.throws(
      () => runSync(process.execPath, timeoutChild, { timeout: 1000 }),
      (error: unknown) => errorCode(error) === "ETIMEDOUT" && error === spawnObservation.error,
    );
    assert.equal(stdout.mock.calls.length, 1);
    assert.equal(stderr.mock.calls.map(([chunk]) => String(chunk)).join(""), "owned-stderr-marker");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
