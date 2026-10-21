import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { hydrateReleasePreparationSource } from "./release-preparation-source.mts";
import { orderedJsonValue } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import {
  coordinatorCommandTimeout,
  withCoordinatorDeadline,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";

void test("source hydration and four-file preparation stop after a late actual Git reply", async (t) => {
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(
    childProcess,
    "execFileSync",
    (
      _command: string,
      _args: readonly string[],
      options: import("node:child_process").ExecFileSyncOptions,
    ) => {
      calls++;
      assert.equal(options.timeout, 1000);
      clock = 2001;
      return "a".repeat(40);
    },
  );
  syncBuiltinESMExports();
  const classification = {
    source_commit: "a".repeat(40),
    reviewed_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    reviewed_tree: "b".repeat(40),
    change_set_sha256: "c".repeat(64),
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  };
  await assert.rejects(
    withCoordinatorDeadline(2000, () =>
      prepareReleaseVersion("unused-owned-fixture", classification, ["0.1.0-alpha.2"]),
    ),
    /deadline/,
  );
  assert.equal(calls, 1);
  clock = 1000;
  await assert.rejects(
    withCoordinatorDeadline(2000, async () =>
      hydrateReleasePreparationSource(
        "unused-owned-fixture",
        { source_commit: "a".repeat(40), source_tree: "b".repeat(40) },
        {
          request() {
            assert.fail("late local reply must refuse before provider access");
          },
        },
      ),
    ),
    /deadline/,
  );
  assert.equal(calls, 2);
});

void test("one coordinator role deadline survives async calls and nested work cannot extend it", async (t) => {
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  assert.equal(coordinatorCommandTimeout(), 30000);
  await withCoordinatorDeadline(2000, async () => {
    assert.equal(coordinatorCommandTimeout(), 1000);
    await Promise.resolve();
    clock = 1500;
    await withCoordinatorDeadline(5000, async () => assert.equal(coordinatorCommandTimeout(), 500));
    await withCoordinatorDeadline(1600, async () => assert.equal(coordinatorCommandTimeout(), 100));
    assert.equal(coordinatorCommandTimeout(), 500);
    return undefined;
  });
  assert.equal(coordinatorCommandTimeout(), 30000);
});
void test("expired scope refuses before callback and late completion remains refused without retry", async (t) => {
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  for (const deadline of [999, Infinity, NaN])
    await assert.rejects(
      withCoordinatorDeadline(deadline, async () => {
        calls++;
      }),
      /deadline/,
    );
  assert.equal(calls, 0);
  await assert.rejects(
    withCoordinatorDeadline(2000, async () => {
      calls++;
      clock = 2001;
      assert.throws(checkCoordinatorDeadline, /deadline/);
    }),
    /deadline/,
  );
  assert.equal(calls, 1);
  assert.equal(coordinatorCommandTimeout(), 30000);
});
void test("concurrent coordinator scopes keep independent remaining budgets", async (t) => {
  t.mock.method(performance, "now", () => 1000);
  let unblock: () => void = () => {};
  const first = withCoordinatorDeadline(1200, async () => {
    await new Promise<void>((resolve) => {
      unblock = resolve;
    });
    assert.equal(coordinatorCommandTimeout(), 200);
  });
  await withCoordinatorDeadline(1800, async () => {
    assert.equal(coordinatorCommandTimeout(), 800);
    unblock();
    await first;
    assert.equal(coordinatorCommandTimeout(), 800);
  });
  assert.equal(coordinatorCommandTimeout(), 30000);
});

void test("existing sync Git and prepared transaction use the same scope and refuse a late commit response", async (t) => {
  let clock = 1000,
    reads = 0,
    spawns = 0;
  t.mock.method(performance, "now", () => clock);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const fixture: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-coordinator-legacy.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(fixture) && Array.isArray(fixture.rows) && isRecord(fixture.rows[0]));
  const raw = JSON.stringify(
    orderedJsonValue({ schema_version: 1, previous: null, input: fixture.rows[0].input }),
  );
  t.mock.method(
    childProcess,
    "execFileSync",
    (
      _command: string,
      args: readonly string[],
      options: import("node:child_process").ExecFileSyncOptions,
    ) => {
      reads++;
      assert.equal(options.timeout, 1000);
      const at = args.indexOf("cat-file");
      if (args.includes("symbolic-ref"))
        throw Object.assign(new Error("not-symbolic"), { status: 1 });
      if (args.includes("ls-tree"))
        return Buffer.from(`100644 blob ${"c".repeat(40)}\tstate.json\n`);
      if (args[at + 1] === "-t") return Buffer.from("commit\n");
      if (args[at + 1] === "commit") return Buffer.from(`tree ${"b".repeat(40)}\n\nfixture\n`);
      if (args[at + 1] === "-s") return Buffer.from(String(Buffer.byteLength(raw)));
      if (args[at + 1] === "blob") return Buffer.from(raw);
      assert.fail("unexpected Git fixture read");
    },
  );
  t.mock.method(
    childProcess,
    "spawn",
    (
      _command: string,
      _args: readonly string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      spawns++;
      assert.equal(options.timeout, 1000);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      child.stdin.on("data", (chunk: Buffer) => {
        if (chunk.toString().startsWith("start\n"))
          setImmediate(() => child.stdout.write("prepare: ok\n"));
        else if (chunk.toString() === "commit\n")
          setImmediate(() => {
            clock = 2001;
            child.stdout.write("commit: ok\n");
            child.emit("close", 0);
          });
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(
    withCoordinatorDeadline(2000, () =>
      recoverReleaseOpportunity("unused-owned-fixture", "a".repeat(40)),
    ),
    /deadline/,
  );
  assert.ok(reads >= 5);
  assert.equal(spawns, 1);
  assert.equal(coordinatorCommandTimeout(), 30000);
});

void test("a late synchronous Git reply cannot proceed to another command or transaction", async (t) => {
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(
    childProcess,
    "execFileSync",
    (
      _command: string,
      _args: readonly string[],
      options: import("node:child_process").ExecFileSyncOptions,
    ) => {
      calls++;
      assert.equal(options.timeout, 1000);
      clock = 2001;
      return Buffer.from("commit\n");
    },
  );
  t.mock.method(childProcess, "spawn", () =>
    assert.fail("late sync reply must not start transaction"),
  );
  syncBuiltinESMExports();
  await assert.rejects(
    withCoordinatorDeadline(2000, () =>
      recoverReleaseOpportunity("unused-owned-fixture", "a".repeat(40)),
    ),
    /deadline/,
  );
  assert.equal(calls, 1);
});
