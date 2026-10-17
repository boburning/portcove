import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-workspace-refresh-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function segment(from: string, until: string, offset = 0) {
  const start = source.indexOf(from, offset),
    end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
for (const kind of ["refresh", "reconciliation"] as const) {
  void test(`serialized workspace ${kind} probe preserves forwarding, injection and restoration`, async () => {
    const target = "http://ipc.localhost/get_workspace_snapshot";
    const calls: { input: unknown; args: unknown[]; response: Promise<Response> }[] = [];
    const original = (input: unknown, ...args: unknown[]) => {
      const response = Promise.resolve(new Response("native result"));
      calls.push({ input, args, response });
      return response;
    };
    const events: unknown[][] = [];
    const window = {
      fetch: original,
      __TAURI_INTERNALS__: {
        convertFileSrc: () => target,
        invoke: async (...args: unknown[]) => {
          events.push(args);
        },
      },
    };
    const execute = (callback: unknown, args: unknown[] = []) => {
      assert.ok(typeof callback === "function");
      const result: unknown = runInNewContext(
        `(${callback.toString()})(...args)`,
        {
          window,
          args,
          Response,
          URL,
          location: { href: "https://app.example/" },
        },
        { timeout: 1000 },
      );
      return result;
    };
    const executeBrowserScript = (_browser: unknown, callback: unknown) => execute(callback);
    const browser = {
      executeAsyncScript: (callback: unknown) =>
        new Promise<unknown>((done, reject) => {
          try {
            execute(callback, [done]);
          } catch (error) {
            reject(error);
          }
        }),
    };
    const install =
      kind === "refresh"
        ? `browser${segment(".executeAsyncScript", ".then((result)")}`
        : segment(
            "await executeBrowserScript(browser, () => {",
            "    try {",
            source.indexOf("mutation_process:"),
          );
    const result: unknown = runInNewContext(`(async () => { return ${install}; })()`, {
      browser,
      executeBrowserScript,
    });
    const installed: unknown = await result;
    if (kind === "refresh") {
      assert.equal(object(installed).ok, true);
      assert.equal(
        JSON.stringify(events),
        JSON.stringify([
          ["plugin:event|emit", { event: "portcove://library-changed", payload: "refresh-probe" }],
        ]),
      );
    }
    const options = { method: "POST", headers: { "x-retained": "yes" } };
    const inputs: unknown[] = [
      target,
      new URL(target),
      new Request(target),
      runInNewContext("({toString() {return target}})", { target }),
      { url: target },
      { url: null, toString: () => target },
      { url: undefined, toString: () => target },
    ];
    for (const [index, input] of inputs.entries()) {
      const before = calls.length;
      const response = window.fetch(input, options);
      if (kind === "refresh" && index === 0) {
        assert.equal(calls.length, before);
        const rejected = await response;
        assert.equal(rejected.headers.get("Tauri-Response"), "error");
        const payload = object(await rejected.json());
        assert.equal(payload.code, "state");
        assert.equal(payload.message, "synthetic-native-refresh-failure");
      } else {
        const call = calls.at(-1);
        assert.ok(call);
        assert.equal(call.input, input);
        assert.deepEqual(call.args, [options]);
        assert.equal(response, call.response);
        assert.equal(await (await response).text(), "native result");
      }
    }
    const restore =
      kind === "refresh"
        ? segment(
            "await executeBrowserScript(browser, () => {",
            '        assert.ok("restored"',
            source.indexOf("observations.probe ="),
          )
        : segment(
            "await executeBrowserScript(browser, () => {",
            "      assert.equal(probe.restored",
            source.indexOf("const probe = await executeBrowserScript"),
          );
    const restored: unknown = await runInNewContext(`(async () => { return ${restore}; })()`, {
      browser,
      executeBrowserScript,
    });
    const observation = object(restored);
    assert.equal(observation.restored, true);
    assert.equal(window.fetch, original);
    const commands: unknown = observation.commands;
    assert.ok(Array.isArray(commands));
    assert.equal(commands.length, inputs.length);
    assert.ok(commands.every((command: unknown) => command === "get_workspace_snapshot"));
    assert.equal(
      Object.hasOwn(
        window,
        kind === "refresh" ? "__portcoveRefreshProbe" : "__portcoveExternalReconciliationProbe",
      ),
      false,
    );
  });
}
