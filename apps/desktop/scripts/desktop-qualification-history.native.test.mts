import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { assertHistoryRestoration } from "./desktop-qualification-history-test.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
const entry = new URL("./desktop-qualification-history-test.mts", import.meta.url);
type Subject = Readonly<Record<string, unknown>>;
async function historyReadOracle(subject: Subject) {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  const original: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("native reply");
  };
  const host = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string, protocol: string) => {
        assert.ok(
          ["get_workspace_snapshot", "inspect_source"].includes(command),
          "HISTORY_IPC_COMMAND",
        );
        assert.equal(protocol, "ipc", "HISTORY_IPC_PROTOCOL");
        return `ipc://${command}`;
      },
      invoke: async () => undefined,
    },
  };
  const fixture = { profile_id: "owned-profile", port_id: "owned-port", report: { owned: true } };
  const browser = {
    executeAsyncScript: (callback: unknown, ...args: unknown[]) =>
      new Promise<unknown>((done, reject) => {
        assert.equal(typeof callback, "function", "HISTORY_WHOLE_BROWSER_CALLBACK");
        try {
          runInNewContext(
            `(${String(callback)})(...args, done)`,
            { window: host, args, done, URL, Response, Error },
            { timeout: 1000 },
          );
        } catch (error) {
          reject(error);
        }
      }),
  };
  const install = subject.installHistoryFixture;
  assert.equal(typeof install, "function", "HISTORY_INSTALL_EXPORT");
  await Reflect.apply(install as (...args: unknown[]) => unknown, undefined, [browser, fixture]);
  assert.notEqual(host.fetch, original, "HISTORY_PROBE_INSTALLED");
  for (const body of ["null", "false", "0", '"text"', "[]", "{}", '{"profileId":"other"}']) {
    const input = "ipc://inspect_source";
    const init = { method: "POST", body };
    assert.equal(await (await host.fetch(input, init)).text(), "native reply");
    assert.equal(calls.at(-1)?.input, input);
    assert.equal(calls.at(-1)?.init, init);
  }
  const count = calls.length;
  const reply = await host.fetch(new URL("ipc://inspect_source"), {
    method: "POST",
    body: JSON.stringify({ profileId: fixture.profile_id }),
  });
  assert.deepEqual(await reply.json(), fixture.report);
  assert.equal(calls.length, count, "Only the matching profile may receive synthetic data");
  const probe: unknown = Reflect.get(host, "__portcoveHistoryProbe");
  assert.ok(isRecord(probe));
  assert.equal(probe.reports, 1);
  assert.equal(probe.original, original);
}

async function historyCleanupOracle(subject: Subject) {
  const restore = subject.restoreHistoryScenario;
  assert.equal(typeof restore, "function", "HISTORY_RESTORE_EXPORT");
  const goodRestoration = { restored: true, snapshots: 1, reports: 1 };
  const noObservationsRestoration = { restored: true, snapshots: 0, reports: 0 };
  const cases: [unknown, unknown][] = [
    [null, { ok: true, value: [] }],
    [false, { ok: true, value: [] }],
    [{ restored: "yes" }, { ok: true, value: [] }],
    [
      { restored: true, snapshots: "bad", reports: 1 },
      { ok: true, value: [] },
    ],
    [goodRestoration, null],
    [goodRestoration, { ok: "yes", value: [] }],
    [goodRestoration, { ok: true, value: { length: 0 } }],
    [goodRestoration, { ok: true, value: [] }],
    [noObservationsRestoration, { ok: true, value: [] }],
  ];
  for (const [restored, nativeReply] of cases) {
    for (const failWrite of [false, true])
      for (const primaryFailure of [
        undefined,
        { error: null },
        { error: false },
        { error: 0 },
        { error: "" },
        { error: undefined },
        { error: new Error("original scenario failure") },
      ]) {
        const actions: string[] = [];
        const records: unknown[] = [];
        const observation = primaryFailure ? { failure: { message: "original" } } : {};
        const artifacts: string[] = [];
        const originalWindow = {};
        const result: unknown = Reflect.apply(
          restore as (...args: unknown[]) => unknown,
          undefined,
          [
            {
              primaryFailure,
              observation,
              browser: {
                executeAsyncScript: async (callback: unknown, font: unknown) => {
                  assert.equal(typeof callback, "function", "HISTORY_RESTORE_CALLBACK");
                  assert.equal(font, "");
                  return restored;
                },
                manage: () => ({
                  window: () => ({
                    setRect: async (rect: unknown) => {
                      assert.equal(rect, originalWindow);
                      actions.push("window");
                    },
                  }),
                }),
              },
              originalFont: "",
              originalWindow,
              output: "/owned-output",
              artifacts,
              invoke: async (command: string) => {
                assert.equal(command, "get_sources");
                actions.push("sources");
                return nativeReply;
              },
              writeEvidence: async (file: string, body: string, options: unknown) => {
                assert.equal(file, path.join("/owned-output", "qualification-history.json"));
                assert.deepEqual(options, { flag: "wx" });
                actions.push("report");
                if (failWrite) throw new Error("retained storage unavailable");
                records.push(JSON.parse(body));
              },
            },
          ],
        );
        await Promise.resolve(result).catch(() => {});
        assert.deepEqual(
          actions.filter((action) => action !== "report"),
          ["window", "sources"],
          "HISTORY_CLEANUP_ORDER",
        );
        assert.equal(actions.includes("report"), true, "HISTORY_EVIDENCE_REQUIRED");
        const positive =
          (restored === goodRestoration ||
            (restored === noObservationsRestoration && primaryFailure !== undefined)) &&
          isRecord(nativeReply) &&
          nativeReply.ok === true &&
          Array.isArray(nativeReply.value);
        if (primaryFailure) {
          let caught: { error: unknown } | undefined;
          try {
            await result;
          } catch (error) {
            caught = { error };
          }
          assert.ok(
            caught && Object.is(caught.error, primaryFailure.error),
            "HISTORY_PRIMARY_ERROR_IDENTITY",
          );
        }
        if (!positive && !primaryFailure) {
          let rejected = false;
          try {
            await result;
          } catch {
            rejected = true;
          }
          assert.equal(rejected, true, "HISTORY_VALIDATION_REQUIRED");
        }
        if (positive && !failWrite && !primaryFailure) await result;
        else
          await assert.rejects(
            async () => {
              await result;
            },
            (error: unknown) =>
              primaryFailure
                ? Object.is(error, primaryFailure.error)
                : positive && failWrite
                  ? errorMessage(error) === "retained storage unavailable"
                  : error !== undefined,
          );
        assert.deepEqual(actions, ["window", "sources", "report"], "HISTORY_CLEANUP_ORDER");
        assert.equal(records.length, failWrite ? 0 : 1, "HISTORY_EVIDENCE_RECORD_COUNT");
        assert.deepEqual(
          artifacts,
          failWrite ? [] : [path.join("/owned-output", "qualification-history.json")],
          "HISTORY_EXCLUSIVE_ARTIFACT",
        );
        if (!failWrite) {
          assert.ok(isRecord(records[0]));
          assert.ok(Object.hasOwn(records[0], "restoration"));
          assert.ok(Object.hasOwn(records[0], "native_source_restoration"));
          if (restored === noObservationsRestoration)
            assert.equal(
              Object.hasOwn(records[0], "restoration_validation_failure"),
              primaryFailure === undefined,
            );
        }
      }
  }
}

function program(
  oracle: (subject: Subject, owned?: Promise<unknown>[]) => Promise<void>,
  mutation = "",
) {
  return `
    import path from 'node:path';import {runInNewContext} from 'node:vm';
    import {errorMessage,isRecord} from ${JSON.stringify(new URL("../../../scripts/runtime-values.mts", import.meta.url).href)};
    const actual=await import(entry);let subject=actual;const owned=[];
    ${mutation}
    console.error=()=>{};
    await (${oracle.toString()})(subject,owned);
  `;
}
function rejected(operation: () => unknown, marker: string) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker),
    marker,
  );
}
void test("serialized historical read hook forwards unmatched bodies and retains original fetch", () => {
  const body = program(historyReadOracle);
  runDesktopModuleFixture(entry, body);
  runDesktopModuleFixture(entry, body, { exportName: "installHistoryFixture", variant: "aliased" });
  rejected(
    () =>
      runDesktopModuleFixture(entry, body, {
        exportName: "installHistoryFixture",
        variant: "wrong-export",
      }),
    "HISTORY_PROBE_INSTALLED",
  );
});
void test("historical cleanup retains malformed replies after all cleanup and preserves primitive primary failure", () => {
  const body = program(historyCleanupOracle);
  runDesktopModuleFixture(entry, body);
  runDesktopModuleFixture(entry, body, {
    exportName: "restoreHistoryScenario",
    variant: "aliased",
  });
  rejected(
    () =>
      runDesktopModuleFixture(entry, body, {
        exportName: "restoreHistoryScenario",
        variant: "wrong-export",
      }),
    "HISTORY_CLEANUP_ORDER",
  );
  for (const [mutation, marker] of [
    [
      "subject={...actual,restoreHistoryScenario:context=>actual.restoreHistoryScenario({...context,writeEvidence:async()=>{}})};",
      "HISTORY_EVIDENCE_REQUIRED",
    ],
    [
      "subject={...actual,restoreHistoryScenario:context=>actual.restoreHistoryScenario({...context,primaryFailure:context.primaryFailure?.error?context.primaryFailure:undefined})};",
      "HISTORY_PRIMARY_ERROR_IDENTITY",
    ],
    [
      "subject={...actual,restoreHistoryScenario:async context=>{try{return await actual.restoreHistoryScenario(context);}catch(error){if(context.primaryFailure||error?.code!=='ERR_ASSERTION')throw error;}}};",
      "HISTORY_VALIDATION_REQUIRED",
    ],
  ] as const)
    rejected(() => runDesktopModuleFixture(entry, program(historyCleanupOracle, mutation)), marker);
});

void test("history restoration validation retains mandatory observations and narrow malformed-reply refusals", () => {
  const good = { restored: true, snapshots: 1, reports: 1 },
    native = { ok: true, value: [] };
  assertHistoryRestoration(good, native, { scenarioFailed: false });
  assertHistoryRestoration({ restored: true, snapshots: 0, reports: 0 }, native, {
    scenarioFailed: true,
  });
  assertHistoryRestoration({ restored: true, installed: false, snapshots: 0, reports: 0 }, native, {
    scenarioFailed: false,
  });
  for (const restored of [
    { ...good, restored: false },
    { ...good, installed: "false" },
    { ...good, snapshots: -1 },
    { ...good, reports: 0 },
    { ...good, snapshots: 0, reports: 0 },
    { ...good, error: false },
  ])
    assert.throws(() => assertHistoryRestoration(restored, native, { scenarioFailed: false }));
  for (const reply of [
    { ok: false, value: [] },
    { ok: true, value: { length: 0 } },
    { ok: true, value: [{}] },
  ])
    assert.throws(() => assertHistoryRestoration(good, reply, { scenarioFailed: false }));
  assert.throws(() =>
    assertHistoryRestoration(good, native, { scenarioFailed: false, windowError: false }),
  );
});

async function historySettlementOracle(subject: Subject, owned: Promise<unknown>[] = []) {
  function deferred() {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      promise,
      release: () => {
        assert.ok(release);
        release();
      },
    };
  }
  const windowEntered = deferred(),
    windowGate = deferred(),
    writeEntered = deferred(),
    writeGate = deferred();
  const artifacts: string[] = [];
  let settled = false,
    writeStarted = false;
  const restore = subject.restoreHistoryScenario;
  assert.equal(typeof restore, "function", "HISTORY_RESTORE_EXPORT");
  const result: unknown = Reflect.apply(restore as (...args: unknown[]) => unknown, undefined, [
    {
      browser: {
        executeAsyncScript: async () => ({ restored: true, snapshots: 1, reports: 1 }),
        manage: () => ({
          window: () => ({
            setRect: async () => {
              windowEntered.release();
              await windowGate.promise;
            },
          }),
        }),
      },
      originalFont: "",
      originalWindow: {},
      output: "/owned-output",
      artifacts,
      observation: {},
      invoke: async (command: string) => {
        assert.equal(command, "get_sources");
        return { ok: true, value: [] };
      },
      writeEvidence: async (file: string, body: string, options: unknown) => {
        assert.equal(file, path.join("/owned-output", "qualification-history.json"));
        assert.deepEqual(options, { flag: "wx" });
        assert.ok(isRecord(JSON.parse(body)));
        writeStarted = true;
        writeEntered.release();
        await writeGate.promise;
      },
    },
  ]);
  const completion = Promise.resolve(result).finally(() => {
    settled = true;
  });
  void completion.catch(() => {});
  try {
    await windowEntered.promise;
    assert.equal(settled, false, "HISTORY_CLEANUP_SETTLEMENT");
    assert.equal(writeStarted, false, "HISTORY_WINDOW_CLEANUP_JOIN");
    windowGate.release();
    await writeEntered.promise;
    assert.equal(settled, false, "HISTORY_EVIDENCE_SETTLEMENT");
    assert.deepEqual(artifacts, [], "HISTORY_ARTIFACT_AFTER_WRITE");
    writeGate.release();
    await completion;
    assert.deepEqual(artifacts, [path.join("/owned-output", "qualification-history.json")]);
  } finally {
    windowGate.release();
    writeGate.release();
    await Promise.allSettled([completion, ...owned]);
  }
}
void test("history cleanup joins independent window restoration and evidence before settlement", () => {
  const body = program(historySettlementOracle);
  runDesktopModuleFixture(entry, body);
  runDesktopModuleFixture(entry, body, {
    exportName: "restoreHistoryScenario",
    variant: "aliased",
  });
  rejected(
    () =>
      runDesktopModuleFixture(
        entry,
        program(
          historySettlementOracle,
          "subject={...actual,restoreHistoryScenario:context=>{const work=actual.restoreHistoryScenario(context);owned.push(work);work.catch(()=>{});}};",
        ),
      ),
    "HISTORY_CLEANUP_SETTLEMENT",
  );
});

async function historyCallerOracle(entry: string) {
  const fsActual = await import("node:fs/promises");
  const { mock } = await import("node:test");
  const os = await import("node:os");
  const root = await fsActual.mkdtemp(path.join(os.tmpdir(), "portcove-history-caller-"));
  const report = path.join(root, "qualification-history.json");
  const catalog = new URL("../../../crates/portcove-core/catalog/catalog.json", entry).href;
  let reads = 0,
    writes = 0,
    browserCalls = 0,
    selected = 0;
  const actualNamed: Record<string, unknown> = {};
  for (const key of Object.keys(fsActual))
    if (key !== "default") actualNamed[key] = Reflect.get(fsActual, key);
  mock.module("node:fs/promises", {
    namedExports: {
      ...actualNamed,
      readFile: async (file: unknown, encoding: unknown) => {
        assert.equal(process.platform, "linux", "HISTORY_PLATFORM_IO_FORBIDDEN");
        assert.ok(file instanceof URL);
        assert.equal(file.href, catalog);
        assert.equal(encoding, "utf8");
        reads++;
        return fsActual.readFile(file, "utf8");
      },
      writeFile: async (file: unknown, bytes: unknown, options: unknown) => {
        assert.equal(process.platform, "linux", "HISTORY_PLATFORM_IO_FORBIDDEN");
        assert.equal(file, report);
        assert.equal(typeof file, "string");
        assert.ok(typeof bytes === "string");
        assert.deepEqual(options, { flag: "wx" });
        writes++;
        return fsActual.writeFile(file, bytes, { flag: "wx" });
      },
    },
  });
  const sentinel = new Error("owned history caller stopped after hook installation");
  const original = async () => new Response("native reply");
  const emissions: string[] = [];
  const window: Record<string, unknown> = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string, protocol: string) => {
        assert.ok(
          ["get_workspace_snapshot", "inspect_source"].includes(command),
          "HISTORY_IPC_COMMAND",
        );
        assert.equal(protocol, "ipc", "HISTORY_IPC_PROTOCOL");
        return `ipc://${command}`;
      },
      invoke: async (command: string, args: unknown) => {
        assert.equal(command, "plugin:event|emit");
        assert.ok(isRecord(args));
        assert.equal(args.event, "portcove://library-changed");
        assert.ok(typeof args.payload === "string");
        emissions.push(args.payload);
      },
    },
  };
  const document = { documentElement: { style: { fontSize: "125%" } } };
  const originalWindow = { width: 800, height: 600, x: 10, y: 20 };
  const browser = {
    manage: () => {
      browserCalls++;
      return {
        window: () => ({
          getRect: async () => originalWindow,
          setRect: async (value: unknown) => assert.equal(value, originalWindow),
        }),
      };
    },
    executeScript: (callback: unknown, ...args: unknown[]): unknown => {
      browserCalls++;
      assert.equal(typeof callback, "function");
      return runInNewContext(
        `(${String(callback)})(...args)`,
        { window, document, args, getComputedStyle: () => ({ fontSize: "20px" }) },
        { timeout: 1000 },
      );
    },
    executeAsyncScript: (callback: unknown, ...args: unknown[]) =>
      new Promise<unknown>((done, reject) => {
        browserCalls++;
        assert.equal(typeof callback, "function");
        try {
          runInNewContext(
            `(${String(callback)})(...args,done)`,
            { window, document, args, done, URL, Response, Error },
            { timeout: 1000 },
          );
        } catch (error) {
          reject(error);
        }
      }),
    wait: async () => {
      assert.ok(window.__portcoveHistoryProbe, "HISTORY_CALLER_INSTALLATION_REQUIRED");
      throw sentinel;
    },
  };
  const artifacts: string[] = [];
  let caught: { error: unknown } | undefined;
  try {
    const imported: unknown = await import(entry);
    assert.ok(isRecord(imported));
    const run = imported.qualificationHistoryScenario;
    assert.equal(typeof run, "function");
    try {
      await Reflect.apply(run as (...args: unknown[]) => unknown, undefined, [
        {
          browser,
          output: root,
          artifacts,
          invoke: async (command: string) => {
            assert.equal(command, "get_sources");
            return { ok: true, value: [] };
          },
          captureScreenshot: async () => assert.fail("HISTORY_UNEXPECTED_NATIVE_ACTION"),
          scenario: async (name: string, work: () => Promise<unknown>) => {
            assert.equal(name, "native-qualification-history");
            selected++;
            await work();
          },
        },
      ]);
    } catch (error) {
      caught = { error };
    }
    if (process.platform !== "linux") {
      assert.ok(
        caught &&
          caught.error instanceof assert.AssertionError &&
          caught.error.message.includes("This bounded fixture is Linux-native evidence only"),
        "HISTORY_PLATFORM_GUARD_REQUIRED",
      );
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      assert.equal(browserCalls, 0);
      assert.equal(selected, 1);
      return;
    }
    assert.ok(caught, "HISTORY_SCENARIO_NOT_INVOKED");
    assert.equal(caught.error, sentinel, "HISTORY_CALLER_FAILURE_IDENTITY");
    assert.equal(selected, 1);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(window.fetch, original, "HISTORY_CALLER_RESTORATION");
    assert.equal(window.__portcoveHistoryProbe, undefined);
    assert.equal(document.documentElement.style.fontSize, "125%");
    assert.deepEqual(emissions, ["history-fixture", "history-restored"]);
    assert.deepEqual(artifacts, [report]);
    const bytes = await fsActual.readFile(report, "utf8");
    const observation: unknown = JSON.parse(bytes);
    assert.ok(isRecord(observation));
    assert.ok(isRecord(observation.failure));
    assert.equal(observation.failure.message, sentinel.message);
    await assert.rejects(fsActual.writeFile(report, "overwrite", { flag: "wx" }), {
      code: "EEXIST",
    });
    assert.equal(await fsActual.readFile(report, "utf8"), bytes);
  } finally {
    await fsActual.rm(root, { recursive: true, force: true });
  }
}
void test("actual history scenario restores after its Linux failure or refuses other platforms before I/O", () => {
  const body = `import path from 'node:path';import {runInNewContext}from'node:vm';
    import {isRecord}from ${JSON.stringify(new URL("../../../scripts/runtime-values.mts", import.meta.url).href)};
    await (${historyCallerOracle.toString()})(entry);`;
  runDesktopModuleFixture(entry, body);
  runDesktopModuleFixture(entry, body, {
    exportName: "qualificationHistoryScenario",
    variant: "aliased",
  });
  rejected(
    () =>
      runDesktopModuleFixture(entry, body, {
        exportName: "qualificationHistoryScenario",
        variant: "wrong-export",
      }),
    process.platform === "linux"
      ? "HISTORY_SCENARIO_NOT_INVOKED"
      : "HISTORY_PLATFORM_GUARD_REQUIRED",
  );
});
