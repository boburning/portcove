import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-qualification-history-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);

void test("serialized historical read hook forwards unmatched bodies and retains original fetch", async () => {
  const start = source.indexOf(
    "browser.executeAsyncScript",
    source.indexOf("async function installFixture("),
  );
  const callbackStart = source.indexOf("(", start) + 1;
  const ending = /\},\s*fixture,?\s*\);/u.exec(source.slice(callbackStart));
  assert.ok(ending);
  const end = callbackStart + ending.index + 1;
  assert.ok(start >= 0 && callbackStart > start && end > callbackStart);
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  const original: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("native reply");
  };
  const host = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string) => `ipc://${command}`,
      invoke: async () => undefined,
    },
  };
  const fixture = { profile_id: "owned-profile", port_id: "owned-port", report: { owned: true } };
  await new Promise<void>((resolve, reject) => {
    try {
      runInNewContext(
        `(${source.slice(callbackStart, end)})(fixture, done)`,
        {
          window: host,
          fixture,
          done: resolve,
          URL,
          Response,
        },
        { timeout: 1000 },
      );
    } catch (error) {
      reject(error);
    }
  });
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
});

void test("historical cleanup retains malformed replies after all cleanup and preserves primitive primary failure", async () => {
  const start = source.indexOf(
    "const restored",
    source.indexOf("} finally {", source.indexOf("async function installFixture(")),
  );
  const end = source.lastIndexOf("\n    }\n    if (primaryFailure)");
  const tail = source.slice(end + "\n    }".length, source.lastIndexOf("\n  });"));
  const helpers = source.slice(
    source.indexOf("function object("),
    source.indexOf("// Linux history"),
  );
  assert.ok(start >= 0 && end > start);
  const goodRestoration = { restored: true, snapshots: 1, reports: 1 };
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
        const result: unknown = runInNewContext(
          `${helpers}
        (async () => {
          let validationFailure;
          let evidenceFailure;
          try {}
          finally {${source.slice(start, end)}}
          ${tail}
        })()`,
          {
            assert,
            isRecord,
            errorMessage,
            primaryFailure,
            observation,
            restored,
            browser: {
              executeAsyncScript: async () => restored,
              manage: () => ({
                window: () => ({
                  setRect: async () => {
                    actions.push("window");
                  },
                }),
              }),
            },
            originalFont: "",
            originalWindow: {},
            output: "/owned-output",
            artifacts: [],
            invoke: async () => {
              actions.push("sources");
              return nativeReply;
            },
            path: { join: (...parts: string[]) => parts.join("/") },
            writeFile: async (_file: string, body: string) => {
              actions.push("report");
              if (failWrite) throw new Error("retained storage unavailable");
              records.push(JSON.parse(body));
            },
            console: { error: () => {} },
          },
          { timeout: 1000 },
        );
        const positive =
          restored === goodRestoration &&
          isRecord(nativeReply) &&
          nativeReply.ok === true &&
          Array.isArray(nativeReply.value);
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
        assert.deepEqual(actions, ["window", "sources", "report"]);
        assert.equal(records.length, failWrite ? 0 : 1);
        if (!failWrite) {
          assert.ok(isRecord(records[0]));
          assert.ok(Object.hasOwn(records[0], "restoration"));
          assert.ok(Object.hasOwn(records[0], "native_source_restoration"));
        }
      }
  }
});
