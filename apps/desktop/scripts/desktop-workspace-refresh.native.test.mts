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
void test("serialized terminal-activity replay and support gate preserve executable callbacks and request custody", async () => {
  const target = "http://ipc.localhost/create_support_bundle";
  const calls: { input: unknown; args: unknown[] }[] = [];
  const original = async (input: unknown, ...args: unknown[]) => {
    calls.push({ input, args });
    return new Response("native result");
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
    __portcoveExternalReconciliationProbe: { originalFetch: original, commands: [] },
  };
  const execute = (callback: unknown, args: unknown[] = []) => {
    assert.ok(typeof callback === "function");
    const result: unknown = runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, args, URL, Response },
      { timeout: 1000 },
    );
    return result;
  };
  const browser = {
    executeAsyncScript: (callback: unknown, activity: unknown) =>
      new Promise<unknown>((done, reject) => {
        try {
          execute(callback, [activity, done]);
        } catch (error) {
          reject(error);
        }
      }),
  };
  const adoptedActivity = {
    id: "owned-terminal",
    operation: "adopt",
    target_kind: "port",
    target_id: "owned-port",
  };
  const offset = source.indexOf("// The preceding commits");
  assert.ok(offset > 0);
  const replay = `browser${segment(".executeAsyncScript", ".then((result)", offset)}`;
  const reply: unknown = await runInNewContext(replay, { browser, adoptedActivity });
  assert.equal(object(reply).ok, true);
  assert.equal(events.length, 1);
  const event = object(events[0]?.[1]);
  const payload = object(event.payload);
  assert.equal(event.event, "portcove://operation");
  assert.equal(payload.operation_id, adoptedActivity.id);
  assert.equal(payload.operation, adoptedActivity.operation);
  assert.equal(payload.type, "progress");
  assert.equal(JSON.stringify(payload.target), JSON.stringify({ kind: "port", id: "owned-port" }));
  const gate = segment("await executeBrowserScript(browser, () => {", "      try {", offset);
  const execution: unknown = runInNewContext(`(async () => {${gate}})()`, {
    browser,
    executeBrowserScript: (_browser: unknown, callback: unknown) => execute(callback),
  });
  await execution;
  const options = { method: "POST", headers: { retained: "yes" } };
  const pending = window.fetch(target, options);
  assert.equal(calls.length, 0);
  assert.equal(Reflect.get(window.__portcoveExternalReconciliationProbe, "supportRequests"), 1);
  const unrelated = "http://ipc.localhost/get_activities";
  assert.equal(await (await window.fetch(unrelated, options)).text(), "native result");
  assert.equal(calls[0]?.input, unrelated);
  const release: unknown = Reflect.get(
    window.__portcoveExternalReconciliationProbe,
    "releaseSupport",
  );
  assert.ok(typeof release === "function");
  Reflect.apply(release, undefined, []);
  assert.equal(await (await pending).text(), "native result");
  assert.equal(calls[1]?.input, target);
  assert.equal(calls[1]?.args[0], options);
});
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

void test("serialized source-format injection preserves unrelated snapshots and restores its exact fetch", async () => {
  const offset = /const sourceFormat\s*=/u.exec(source)?.index ?? -1;
  assert.ok(offset >= 0);
  const installation = segment("await executeBrowserScript(", "        const expected =", offset);
  const target = "http://ipc.localhost/get_workspace_snapshot";
  let payload: unknown = {
    revision: "preserved",
    statuses: [
      {
        port_id: "selected",
        readiness: { launchable: true, retained: 1 },
        port_actions: [{ action: "launch" }, { action: "backup", retained: 2 }],
      },
      { port_id: "other", retained: 3 },
    ],
  };
  const calls: unknown[][] = [];
  const original = async (...args: unknown[]) => {
    calls.push(args);
    return new Response(JSON.stringify(payload), { headers: { "X-Custody": "original" } });
  };
  const window = {
    fetch: original,
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: { convertFileSrc: () => target },
    __portcoveExternalReconciliationProbe: { originalFetch: original, commands: [] },
  };
  const executeBrowserScript = (_browser: unknown, callback: unknown, ...args: unknown[]) => {
    assert.equal(typeof callback, "function");
    assert.ok(typeof callback === "function");
    const result: unknown = runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, args, Response, Event },
      { timeout: 1000 },
    );
    return result;
  };
  await runInNewContext(`(async()=>{${installation}})()`, {
    browser: {},
    executeBrowserScript,
    port: { id: "selected" },
  });
  const init = { method: "POST" };
  const response = await window.fetch(target, init);
  assert.equal(response.headers.get("X-Custody"), "original");
  const modified: unknown = await response.json();
  const result = object(modified);
  assert.equal(result.revision, "preserved");
  assert.ok(Array.isArray(result.statuses));
  assert.deepEqual(JSON.parse(JSON.stringify(result.statuses)), [
    {
      port_id: "selected",
      readiness: {
        launchable: false,
        retained: 1,
        source: "current",
        blockers: ["incompatible_source"],
        required_source_extension: "z64",
      },
      port_actions: [
        { action: "launch", availability: "waiting", reason: "incompatible_source" },
        { action: "backup", retained: 2 },
      ],
    },
    { port_id: "other", retained: 3 },
  ]);
  assert.equal(calls[0]?.[0], target);
  assert.equal(calls[0]?.[1], init);
  payload = { statuses: [{ port_id: "other", preserved: true }] };
  assert.deepEqual(await (await window.fetch(target)).json(), payload);
  payload = { statuses: [{ port_id: "selected", readiness: null, port_actions: [] }] };
  await assert.rejects(window.fetch(target), /Workspace readiness/);
  const restoration = segment(
    "await executeBrowserScript(browser, () => {",
    "        observations.source_format",
    source.indexOf("sourceFormat.restored =", offset),
  );
  const restored: unknown = await runInNewContext(`(async()=>{return ${restoration}})()`, {
    browser: {},
    executeBrowserScript,
  });
  assert.equal(restored, true);
  assert.equal(window.fetch, original);
});
