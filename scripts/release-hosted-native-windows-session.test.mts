import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import {
  windowsOwnerFiletime,
  windowsOwnerEnvironment,
} from "./release-windows-owner-mechanism.mts";

const source = readFileSync(
  new URL("./release-hosted-native-windows-session.mts", import.meta.url),
  "utf8",
);
function body(begin: string, end: string, text = source) {
  const start = text.indexOf(begin),
    stop = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, "Actual private implementation boundary required");
  return stripTypeScriptTypes(text.slice(start, stop).replace(/^export /gmu, ""));
}
const spawnBody = body(
  "export function captureWindowsOwnerSupervisor(",
  "/** End of shared owner supervisor mechanics. */",
  readFileSync(new URL("./release-windows-owner-mechanism.mts", import.meta.url), "utf8"),
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
  const create = runInNewContext(spawnBody + ";captureWindowsOwnerSupervisor", {
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

void test("shared Windows owner mechanics preserve generation identity and a credential-free environment", () => {
  assert.equal(windowsOwnerFiletime("win32:42:504911232000000123", 42), "123");
  for (const identity of [
    null,
    "win32:43:504911232000000123",
    "win32:42:504911232000000000",
    "linux:42:123",
  ])
    assert.throws(() => windowsOwnerFiletime(identity, 42));
  const source = {
    SystemRoot: "C:\\Windows",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_JOB: "native_windows",
    GITHUB_WORKFLOW_REF: "fixed-held-production-route",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "inert-never-copy",
    TAURI_SIGNING_PRIVATE_KEY: "inert-never-copy",
  };
  const actual = windowsOwnerEnvironment("C:\\owned", source);
  assert.equal(actual.SystemDrive, "C:");
  assert.equal(actual.PATH, "C:\\Windows\\System32");
  assert.equal(actual.GH_TOKEN, undefined);
  assert.equal(actual.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(actual.USERPROFILE, "C:\\owned");
  assert.equal(actual.GITHUB_WORKFLOW_REF, source.GITHUB_WORKFLOW_REF);
  assert.deepEqual(
    Object.keys(actual).sort(),
    [
      "SystemRoot",
      "WINDIR",
      "SystemDrive",
      "PATH",
      "PATHEXT",
      "USERPROFILE",
      "HOME",
      "TEMP",
      "TMP",
      "GITHUB_ACTIONS",
      "RUNNER_ENVIRONMENT",
      "GITHUB_REPOSITORY",
      "GITHUB_JOB",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ].sort(),
  );
  assert.throws(() =>
    windowsOwnerEnvironment("C:\\owned", { ...source, GITHUB_RUN_ID: undefined }),
  );
});

void test("shared Windows owner framing preserves byte and original deadline bounds before invoking the OS", () => {
  const mechanism = readFileSync(
    new URL("./release-windows-owner-mechanism.mts", import.meta.url),
    "utf8",
  );
  const frame = body(
    "export function writeWindowsOwnerFrame(",
    "export function captureWindowsOwnerSupervisor(",
    mechanism,
  );
  let effects = 0;
  const calls: unknown[][] = [];
  const write = runInNewContext(frame + ";writeWindowsOwnerFrame", {
    assert,
    Buffer,
    performance: { now: () => 10 },
    execFileSync: (...args: unknown[]) => {
      effects++;
      calls.push(args);
    },
  }) as (file: string, wire: Record<string, unknown>, options: unknown) => void;
  const options = {
    root: "C:\\owned",
    deadline: 100,
    powershell: "fixed-system-powershell",
    environment: { fixed: "closed" },
  };
  assert.throws(() => write("C:\\owned\\request.json", {}, { ...options, deadline: 10 }));
  assert.throws(() => write("C:\\owned\\request.json", { oversized: "x".repeat(16384) }, options));
  assert.equal(effects, 0);
  write("C:\\owned\\request.json", { binding: "a".repeat(64), sequence: 1 }, options);
  assert.equal(effects, 1);
  const call = calls[0];
  assert.ok(call && Array.isArray(call[1]) && isRecord(call[2]));
  assert.equal(call[0], "fixed-system-powershell");
  assert.equal(call[2].timeout, 90);
  assert.equal(call[2].maxBuffer, 16384);
  const script = Buffer.from(String(call[1].at(-1)), "base64").toString("utf16le");
  assert.match(script, /FileMode\]::CreateNew/u);
  assert.match(script, /FileShare\]::None/u);
  assert.match(script, /Flush\(\$true\)/u);
});
