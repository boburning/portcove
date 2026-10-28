import assert from "node:assert/strict";
import test from "node:test";
import { readMacInstalledProcessField } from "./desktop-installed-update-harness.mts";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Deliberately malformed foreign/subprocess failures must retain their exact identity.
function raiseBoundaryFailure(failure: unknown): never {
  throw failure;
}
const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-macos-installed-update-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function fragment(start: string, end: string): string {
  const from = source.indexOf(start),
    until = source.indexOf(end, from);
  assert.ok(from >= 0 && until > from);
  return source.slice(from, until);
}

void test("macOS frozen child capture retains exact first failure after mandatory process cleanup", async () => {
  const freeze = fragment("async function freezeCaptureAndStop(", "async function stopHelper(");
  for (const primary of [undefined, null, false, 0, "", new Error("primary capture error")]) {
    for (const cleanupFails of [false, true]) {
      const signals: [number, string][] = [];
      let waits = 0;
      const result: unknown = runInNewContext(
        `${freeze} freezeCaptureAndStop(42, "helper", "candidate")`,
        {
          processIdentity: () => ({
            pid: 42,
            started: "exact-start",
            command: "owned helper",
            state: "T",
          }),
          process: {
            kill: (pid: number, signal: string) => {
              signals.push([pid, signal]);
            },
          },
          waitFor: async () => {
            waits += 1;
            if (waits === 1) return Promise.reject(primary);
            if (cleanupFails) throw new Error("secondary cleanup error");
            return true;
          },
        },
      );
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => Object.is(error, primary),
      );
      assert.deepEqual(signals, [
        [42, "SIGSTOP"],
        [42, "SIGKILL"],
      ]);
      assert.equal(waits, 2);
    }
  }
  for (const cleanupFailure of [undefined, null, false, 0, ""]) {
    let waits = 0;
    const result: unknown = runInNewContext(
      `${freeze} freezeCaptureAndStop(42, "helper", "candidate")`,
      {
        processIdentity: () => ({ pid: 42, started: "exact-start", state: "T" }),
        process: { kill: () => {} },
        childPids: () => [],
        matchingChildIdentity: () => null,
        waitFor: async () => {
          waits += 1;
          if (waits === 2) return Promise.reject(cleanupFailure);
          return true;
        },
      },
    );
    await assert.rejects(
      async () => {
        await result;
      },
      (error: unknown) => Object.is(error, cleanupFailure),
    );
  }
});

void test("macOS owned cleanup refuses foreign markers and never signals a changed start identity", async () => {
  const readers = fragment("function object(", "const report");
  const stop = fragment("async function stopOwned(", "async function freezeCaptureAndStop(");
  const app = "/Applications/Portcove.app/Contents/MacOS/portcove";
  const marker = { schema_version: 1, process_id: 42, executable: app };
  for (const input of [
    null,
    undefined,
    false,
    0,
    "",
    { ...marker, executable: "/foreign/app" },
    { ...marker, schema_version: 2 },
  ]) {
    let actions = 0;
    const result: unknown = runInNewContext(`${readers} ${stop} stopOwned(input, "candidate")`, {
      assert,
      app,
      input,
      processIdentity: () => {
        actions += 1;
        throw new Error("must not inspect foreign process");
      },
      process: {
        kill: () => {
          actions += 1;
        },
      },
    });
    await result;
    assert.equal(actions, 0);
  }
  for (const process_id of [0, -1, 1.5, "42", null]) {
    let actions = 0;
    const result: unknown = runInNewContext(`${readers} ${stop} stopOwned(input, "candidate")`, {
      assert,
      app,
      input: { ...marker, process_id },
      processIdentity: () => {
        actions += 1;
      },
      process: {
        kill: () => {
          actions += 1;
        },
      },
    });
    await assert.rejects(async () => {
      await result;
    });
    assert.equal(actions, 0);
  }
  const signals: [number, string][] = [];
  let observations = 0;
  const changed: unknown = runInNewContext(`${readers} ${stop} stopOwned(input, "candidate")`, {
    assert,
    app,
    input: marker,
    processIdentity: () => ({
      pid: 42,
      started: observations++ === 0 ? "owned-start" : "replacement-start",
    }),
    process: {
      kill: (pid: number, signal: string) => {
        signals.push([pid, signal]);
      },
    },
    waitFor: async (predicate: () => Promise<unknown>) => {
      if (observations === 1) throw new Error("cleanup wait expired");
      if (!(await predicate())) throw new Error("replacement process remains live");
      return true;
    },
  });
  await assert.rejects(async () => {
    await changed;
  }, /replacement process remains live/u);
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
});

void test("macOS process inspection treats only subprocess status one as an absent process", () => {
  for (const field of ["lstart", "command", "stat"] as const) {
    assert.equal(
      readMacInstalledProcessField(42, field, (command, args, options) => {
        assert.equal(command, "/bin/ps");
        assert.deepEqual(args, ["-ww", "-p", "42", "-o", `${field}=`]);
        assert.deepEqual(options, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return "  retained observation  ";
      }),
      "retained observation",
    );
  }
  for (const failure of [
    undefined,
    null,
    false,
    0,
    "",
    { status: 2 },
    { status: 1 },
    Object.assign(new Error("absent"), { status: 1 }),
  ]) {
    const invoke = (): unknown =>
      readMacInstalledProcessField(42, "lstart", () => raiseBoundaryFailure(failure));
    if (
      failure !== null &&
      typeof failure === "object" &&
      "status" in failure &&
      failure.status === 1
    )
      assert.equal(invoke(), null);
    else assert.throws(invoke, (error: unknown) => Object.is(error, failure));
  }
});
