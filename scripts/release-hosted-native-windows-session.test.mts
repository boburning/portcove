import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

const source = readFileSync(
  new URL("./release-hosted-native-windows-session.mts", import.meta.url),
  "utf8",
);
function body(begin: string, end: string) {
  const start = source.indexOf(begin),
    stop = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, "Actual private implementation boundary required");
  return stripTypeScriptTypes(source.slice(start, stop).replace(/^export /gmu, ""));
}
const spawnBody = body(
  "function captureOwnerSupervisor(",
  "export async function startActualHostedWindowsSession",
);
const terminalBody = body(
  "async function recheckTerminalSettlement(",
  "export async function prepareActualHostedWindowsPreSignStage",
);
void test("supervisor callback returns its child to cleanup ownership before fallible identity observation", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let identities = 0,
    spawns = 0,
    retained = 0,
    signals = 0;
  const state: { supervisor?: unknown; error?: unknown; signal: EventEmitter } = {
    signal: new EventEmitter(),
  };
  state.signal.on("SIGTERM", () => {
    signals++;
    child.emit("close", 143);
  });
  const create = runInNewContext(spawnBody + ";captureOwnerSupervisor", {
    assert,
    spawn: () => {
      spawns++;
      return child;
    },
    writeSync: (_fd: number, bytes: Buffer) => {
      retained += bytes.length;
    },
    readProcessIdentity: () => {
      identities++;
      throw new Error("identity refused");
    },
  }) as (
    state: unknown,
    files: number[],
  ) => (command: string, args: string[], options: unknown) => typeof child;
  const callback = create(state, [10, 11]);
  assert.equal(callback("original-prepared-supervisor", [], {}), child);
  assert.equal(identities, 0);
  assert.ok(isRecord(state.supervisor) && state.supervisor.pid === 42);
  // Existing runRustTests can now own close before any later identity refusal.
  let closed = false,
    released = false;
  const close = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  assert.throws(() => callback("second", [], {}));
  assert.equal(spawns, 1);
  child.stderr.emit("data", Buffer.alloc(65537));
  assert.equal(retained, 65536);
  assert.ok(state.error);
  assert.equal(signals, 1);
  await close;
  released = true;
  assert.ok(closed && released);
});

void test("actual final settlement refuses late role or custody changes after independent account readback", async () => {
  for (const scenario of ["success", "late", "role", "custody", "live-owner", "cloned"]) {
    let clock = 10,
      role = true,
      drift = false,
      recovered = 0,
      readbacks = 0;
    const receipt = {},
      pre = {},
      post = {},
      dependencies = {},
      runtime = {};
    const state = {
      phase: "finished",
      stopped: false,
      status: undefined as number | undefined,
      error: undefined,
      deadline: 1000,
      parent: { recheck: () => assert.ok(role && clock < 1000) },
      prepared: { dependencies, runtime, parent: pre },
      postParent: post,
      owner: { pid: 42, created: "1" },
      root: "C:\\owned-session",
      binding: "a".repeat(64),
      files: [],
      custody: new Map(),
      running: Promise.resolve(0),
    };
    const sessions = new WeakMap<object, typeof state>([[receipt, state]]);
    const parents = new WeakSet([pre, post]);
    const finish = runInNewContext(terminalBody + ";finishActualHostedWindowsSession", {
      assert,
      path,
      Buffer,
      isRecord,
      sessions,
      performance: { now: () => clock },
      assertControllerBootstrapEnvironment: () => assert.ok(role, "Original role revoked"),
      recheckNativeRuntimeCustody: () => assert.ok(!drift, "Original custody changed"),
      requireActualHostedWindowsDependencies: async (value: unknown) =>
        assert.equal(value, dependencies),
      requireHostedNativeRuntime: async (value: unknown, parent: unknown) => {
        assert.equal(value, runtime);
        assert.ok(parents.has(parent as object));
        return { deadline: 1000 };
      },
      requireActualHostedNativeParentSource: async (value: object) => assert.ok(parents.has(value)),
      readProcessIdentity: () => (scenario === "live-owner" ? "original-owner" : null),
      filetime: () => "1",
      recheck: async () => assert.ok(!state.stopped && state.status === undefined),
      writeRequest: () => {
        state.status = 0;
      },
      readControllerToolFile: async () =>
        Buffer.from(
          JSON.stringify({
            binding: state.binding,
            owner_pid: 42,
            owner_created_filetime: "1",
            failure: "",
            cleanup_failures: [],
            credential_disposed: true,
          }),
        ),
      inspectOriginalHostedWindowsAccount: async () => {
        readbacks++;
        if (scenario === "late") clock = 1001;
        if (scenario === "role") role = false;
        if (scenario === "custody") drift = true;
      },
      failSession: async () => {
        recovered++;
        state.stopped = true;
      },
    }) as (receipt: object) => Promise<{ authority: string; deadline: number }>;
    if (scenario === "success") {
      const value = await finish(receipt);
      assert.equal(value.authority, "none");
      assert.equal(value.deadline, state.deadline);
      assert.equal(readbacks, 1);
      assert.equal(recovered, 0);
    } else {
      await assert.rejects(finish(scenario === "cloned" ? { ...receipt } : receipt));
      assert.equal(recovered, scenario === "cloned" ? 0 : 1);
    }
  }
});
