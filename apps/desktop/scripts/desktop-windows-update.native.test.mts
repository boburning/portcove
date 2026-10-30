import assert from "node:assert/strict";
import test from "node:test";
import {
  readWindowsUpdateProcessMarker as processMarker,
  readWindowsUpdateProcessObservation as markedObservation,
  readWindowsUpdateExitObservation,
  cleanupWindowsUpdateMarkedProcess,
  installWindowsUpdateRestartHook,
} from "./desktop-installed-update-harness.mts";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-windows-update-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
const valid = {
  schema_version: 1,
  process_id: 42,
  executable: "C:\\owned\\Portcove.exe",
  metadata: { retained: true },
};

void test("Windows helper OS exit evidence refuses missing codes and starts before relaunch waits", () => {
  for (const code of [0, 7, -1]) {
    assert.equal(
      readWindowsUpdateExitObservation({
        status: "exit-observed",
        pid: 42,
        exit_code: code,
        observation: "retained-process-handle",
      }).exit_code,
      code,
    );
  }
  for (const status of ["unobserved", "timeout"]) {
    assert.equal(
      readWindowsUpdateExitObservation({ status, pid: 42, exit_code: null }).exit_code,
      null,
    );
    assert.throws(() => readWindowsUpdateExitObservation({ status, pid: 42, exit_code: 0 }));
  }
  for (const value of [
    { status: "exit-observed", pid: 42, exit_code: null, observation: "retained-process-handle" },
    { status: "exit-observed", pid: 42, exit_code: 0 },
    { status: "exit-observed", pid: 42, exit_code: "0", observation: "retained-process-handle" },
    { status: "exit-observed", pid: 0, exit_code: 0, observation: "retained-process-handle" },
    {
      status: "exit-observed",
      pid: 42,
      exit_code: 2 ** 32,
      observation: "retained-process-handle",
    },
  ])
    assert.throws(() => readWindowsUpdateExitObservation(value));
  const start = source.indexOf("helperExitObserver = startWindowsUpdateExitObservation");
  assert.ok(start > source.indexOf("report.helper_process_marker = helper"));
  assert.ok(start < source.indexOf("const relaunch = processMarker"));
  const cancel = source.indexOf("helperExitObserver.cancel()");
  assert.ok(cancel > 0 && cancel < source.indexOf("if (restartStarted)", cancel));
});

void test("Windows updater marker readers reject malformed identity fields and retain opaque metadata", () => {
  const read = (input: unknown): unknown => processMarker(input);
  assert.equal(JSON.stringify(read(valid)), JSON.stringify(valid));
  for (const input of [
    null,
    [],
    false,
    { ...valid, schema_version: "1" },
    { ...valid, process_id: 0 },
    { ...valid, process_id: 1.5 },
    { ...valid, executable: "relative.exe" },
    { ...valid, executable: 42 },
  ])
    assert.throws(() => read(input));
  const observe = (input: unknown): unknown => markedObservation(input);
  for (const status of ["captured", "exited", "prior-process-exited", "stopped"])
    assert.equal(JSON.stringify(observe({ status, pid: 42 })), JSON.stringify({ status, pid: 42 }));
  for (const input of [
    null,
    { status: "running", pid: 42 },
    { status: "stopped", pid: "42" },
    { status: "captured", pid: 42, path: "relative.exe" },
  ])
    assert.throws(() => observe(input));
});

void test("Windows updater cleanup keeps marker/path validation before identity-bound stop", async () => {
  const staging = "C:\\owned\\staging",
    app = valid.executable,
    output = "C:\\evidence";
  const worker = {
    ...valid,
    executable: `${staging}\\workers\\revision-4\\attempt-owned\\portcove-update-worker.exe`,
  };
  for (const [marker, label, captureStatus, stopExpected] of [
    [valid, "candidate", "captured", true],
    [{ ...valid, executable: "C:\\foreign\\Portcove.exe" }, "candidate", "captured", true],
    [worker, "helper", "captured", true],
    [worker, "helper", "exited", false],
    [worker, "helper", "prior-process-exited", false],
    [worker, "helper", "stopped", false],
    [null, "helper", "captured", false],
  ] as const) {
    const calls: { mode: string; args: string[] }[] = [];
    const result = cleanupWindowsUpdateMarkedProcess({
      markerPath: "marker.json",
      label,
      staging,
      app,
      output,
      restartStarted: "2026-10-17T09:00:00Z",
      readJson: async (file) => (file === "marker.json" ? marker : null),
      command: (mode, args) => {
        calls.push({ mode, args });
        return { status: mode === "Capture" ? captureStatus : "stopped", pid: 42 };
      },
    });
    const observed = await result;
    if (marker) {
      assert.ok("capture" in observed);
      assert.deepEqual(observed.capture, { status: captureStatus, pid: 42 });
      assert.deepEqual(observed.stop, stopExpected ? { status: "stopped", pid: 42 } : null);
    } else assert.deepEqual(observed, { status: "marker-absent" });
    assert.equal(
      calls.some((call) => call.mode === "Stop"),
      stopExpected,
    );
    for (const call of calls.filter((call) => call.mode === "Stop"))
      assert.deepEqual(Array.from(call.args), [
        "-IdentityPath",
        path.join(output, `${label}-process-identity.json`),
      ]);
    if (marker) {
      const capture = calls[0];
      assert.ok(capture);
      assert.deepEqual(capture.args, [
        "-MarkerPath",
        "marker.json",
        "-IdentityPath",
        path.join(output, `${label}-process-identity.json`),
        "-ExpectedPath",
        label === "candidate" ? app : marker.executable,
        "-EarliestStart",
        "2026-10-17T09:00:00Z",
        ...(label === "helper" ? ["-Helper"] : []),
      ]);
    }
  }
  for (const marker of [
    { ...worker, executable: `${staging}\\..\\foreign.exe` },
    { ...worker, process_id: 0 },
  ]) {
    let actions = 0;
    const result = cleanupWindowsUpdateMarkedProcess({
      markerPath: "marker.json",
      label: "helper",
      staging,
      app,
      output,
      restartStarted: "2026-10-17T09:00:00Z",
      readJson: async (file) => (file === "marker.json" ? marker : null),
      command: () => {
        actions += 1;
        throw new Error("must not act");
      },
    });
    await assert.rejects(async () => {
      await result;
    });
    assert.equal(actions, 0);
  }
  const base = {
    markerPath: "marker.json",
    label: "helper" as const,
    staging,
    app,
    output,
    restartStarted: "2026-10-17T09:00:00Z",
  };
  for (const restartStarted of [undefined, ""]) {
    let actions = 0;
    await assert.rejects(
      cleanupWindowsUpdateMarkedProcess({
        ...base,
        restartStarted,
        readJson: async (file) => (file === "marker.json" ? worker : null),
        command: () => {
          actions++;
          throw new Error("must not act");
        },
      }),
      /Restart timestamp required/,
    );
    assert.equal(actions, 0);
  }
  for (const retained of [{ pid: 83 }, { pid: 0 }, { pid: "83" }, {}, false]) {
    const calls: string[] = [];
    const action = cleanupWindowsUpdateMarkedProcess({
      ...base,
      readJson: async (file) => (file === "marker.json" ? worker : retained),
      command: (mode) => {
        calls.push(mode);
        return { status: mode === "Capture" ? "captured" : "stopped", pid: 83 };
      },
    });
    if (typeof retained === "object" && "pid" in retained && retained.pid === 83) {
      assert.deepEqual(await action, {
        capture: { status: "captured", pid: 83 },
        stop: { status: "stopped", pid: 83 },
      });
      assert.deepEqual(calls, ["Stop"], "Retained identity must not be recaptured");
    } else if (retained) {
      await assert.rejects(action, { code: "ERR_ASSERTION" });
      assert.deepEqual(calls, []);
    } else {
      await action;
      assert.deepEqual(calls, ["Capture", "Stop"]);
    }
  }
  for (const mode of ["Capture", "Stop"] as const) {
    const refusal = new Error(`provider-${mode}`),
      calls: string[] = [];
    await assert.rejects(
      cleanupWindowsUpdateMarkedProcess({
        ...base,
        readJson: async (file) => (file === "marker.json" ? worker : null),
        command: (current) => {
          calls.push(current);
          if (current === mode) throw refusal;
          return { status: "captured", pid: 42 };
        },
      }),
      (error) => error === refusal,
    );
    assert.deepEqual(calls, mode === "Capture" ? ["Capture"] : ["Capture", "Stop"]);
  }
  assert.deepEqual(
    await cleanupWindowsUpdateMarkedProcess({
      ...base,
      readJson: async () => {
        throw new Error("missing marker");
      },
      command: () => assert.fail("Missing marker must not act"),
    }),
    { status: "marker-absent" },
  );
});

void test("Windows restart hook serializes as executable JavaScript and preserves invoke results/rejections", async () => {
  for (const failure of [
    undefined,
    null,
    false,
    0,
    "",
    { code: "refused", message: "retained", details: { exact: true } },
    Object.assign(() => {}, { code: "callable-error" }),
  ]) {
    let reject!: (error: unknown) => void;
    const original = new Promise<unknown>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const invocations: unknown[][] = [];
    const window: {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
      };
      __portcoveRestartResult?: unknown;
    } = {
      __TAURI_INTERNALS__: {
        invoke: (...args) => {
          invocations.push(args);
          return original;
        },
      },
    };
    const installed = installWindowsUpdateRestartHook({
      executeScript: async <Result,>(
        callback: string | ((...args: never[]) => unknown),
      ): Promise<Result> => {
        assert.ok(typeof callback === "function");
        return runInNewContext(`(${callback.toString()})()`, { window, Error }) as Result;
      },
    });
    await installed;
    const restartResult = (): unknown => window.__portcoveRestartResult;
    assert.equal(restartResult(), null);
    const args = { exact: true },
      options = { retained: true };
    const returned = window.__TAURI_INTERNALS__.invoke(
      "restart_to_apply_application_update",
      args,
      options,
    );
    assert.equal(returned, original);
    assert.equal(invocations[0]?.[1], args);
    assert.equal(invocations[0]?.[2], options);
    reject(failure);
    await assert.rejects(returned, (error: unknown) => Object.is(error, failure));
    const result = restartResult();
    assert.ok(result !== null && typeof result === "object" && "ok" in result);
    assert.equal(result.ok, false);
    if (
      failure !== null &&
      (typeof failure === "object" || typeof failure === "function") &&
      "code" in failure
    ) {
      assert.ok("code" in result);
      assert.equal(result.code, failure.code);
      for (const key of ["message", "details"] as const) {
        assert.ok(key in result);
        assert.equal(
          Reflect.get(result, key),
          key in failure ? Reflect.get(failure, key) : undefined,
        );
      }
    }
  }
});

void test("Windows restart hook records success only for restart and refuses an absent bridge", async () => {
  const original = Promise.resolve({ retained: true });
  const runtime = {
    __TAURI_INTERNALS__: { invoke: (_command: string) => original },
    __portcoveRestartResult: undefined as unknown,
  };
  const browser = {
    executeScript: async <Result,>(
      callback: string | ((...args: never[]) => unknown),
    ): Promise<Result> => {
      assert.ok(typeof callback === "function");
      return runInNewContext(`(${callback.toString()})()`, { window: runtime, Error }) as Result;
    },
  };
  await installWindowsUpdateRestartHook(browser);
  assert.equal(runtime.__TAURI_INTERNALS__.invoke("get_bootstrap_status"), original);
  await original;
  assert.equal(runtime.__portcoveRestartResult, null);
  assert.equal(runtime.__TAURI_INTERNALS__.invoke("restart_to_apply_application_update"), original);
  await original;
  assert.equal(JSON.stringify(runtime.__portcoveRestartResult), '{"ok":true}');
  await assert.rejects(
    installWindowsUpdateRestartHook({
      executeScript: async <Result,>(
        callback: string | ((...args: never[]) => unknown),
      ): Promise<Result> => {
        assert.ok(typeof callback === "function");
        return runInNewContext(`(${callback.toString()})()`, { window: {}, Error }) as Result;
      },
    }),
    /Native bridge unavailable/,
  );
});
