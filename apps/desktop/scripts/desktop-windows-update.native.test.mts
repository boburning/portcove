import assert from "node:assert/strict";
import test from "node:test";
import {
  readWindowsUpdateProcessMarker as processMarker,
  readWindowsUpdateProcessObservation as markedObservation,
  readWindowsUpdateExitObservation,
} from "./desktop-installed-update-harness.mts";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-windows-update-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function fragment(start: string, end: string): string {
  const from = source.indexOf(start),
    until = source.indexOf(end, from);
  assert.ok(from >= 0 && until > from);
  return source.slice(from, until);
}
const readers = fragment("function object(", "const report");
const cleanup = fragment("function workerRelativePath(", "\ntry {");
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
    [worker, "helper", "captured", true],
    [worker, "helper", "exited", false],
    [null, "helper", "captured", false],
  ] as const) {
    const calls: { mode: string; args: string[] }[] = [];
    const result: unknown = runInNewContext(
      `${readers} ${cleanup} cleanupMarkedProcess("marker.json", label)`,
      {
        assert,
        processMarker,
        markedObservation,
        path,
        staging,
        app,
        output,
        label,
        restartStarted: "2026-10-17T09:00:00Z",
        readJson: async (file: string) => (file === "marker.json" ? marker : null),
        markedProcessCommand: (mode: string, args: string[]) => {
          calls.push({ mode, args });
          return { status: mode === "Capture" ? captureStatus : "stopped", pid: 42 };
        },
      },
    );
    await result;
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
      assert.ok(capture.args.includes("-EarliestStart"));
      assert.equal(capture.args.includes("-Helper"), label === "helper");
    }
  }
  for (const marker of [
    { ...worker, executable: `${staging}\\..\\foreign.exe` },
    { ...worker, process_id: 0 },
  ]) {
    let actions = 0;
    const result: unknown = runInNewContext(
      `${readers} ${cleanup} cleanupMarkedProcess("marker.json", "helper")`,
      {
        assert,
        processMarker,
        markedObservation,
        path,
        staging,
        app,
        output,
        restartStarted: "2026-10-17T09:00:00Z",
        readJson: async () => marker,
        markedProcessCommand: () => {
          actions += 1;
          throw new Error("must not act");
        },
      },
    );
    await assert.rejects(async () => {
      await result;
    });
    assert.equal(actions, 0);
  }
});

void test("Windows restart hook serializes as executable JavaScript and preserves invoke results/rejections", async () => {
  const hook = fragment("  await executeBrowserScript(browser, () => {", "  await save();");
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
    const installed: unknown = runInNewContext(`(async () => { ${hook} })()`, {
      browser: {},
      executeBrowserScript: (_browser: unknown, callback: unknown): unknown => {
        assert.ok(typeof callback === "function");
        return runInNewContext(`(${callback.toString()})()`, { window, Error });
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
    }
  }
});
