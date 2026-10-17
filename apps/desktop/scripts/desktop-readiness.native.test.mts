import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-readiness-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
const target = "https://ipc.example/get_workspace_snapshot";
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function segment(from: string, until: string, offset = 0): string {
  const start = source.indexOf(from, offset),
    end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const actionFunctions = segment(
  "async function injectActionHold(",
  "async function observeHeldLaunch(",
);
const omission = segment(
  ".executeAsyncScript",
  ".then((value)",
  source.indexOf("export async function readinessScenario("),
);

for (const kind of ["action", "readiness"] as const) {
  void test(`serialized ${kind} probe preserves fetch inputs, duplicate-row metadata and restoration`, async () => {
    const inputValues: unknown[] = [
      target,
      new URL(target),
      new Request(target),
      runInNewContext("({toString() { return target; }})", { target }),
      { url: target },
      { url: undefined, toString: () => target },
      { url: null, toString: () => target },
    ];
    const other = {
      port_id: "other",
      readiness: { launchable: true },
      port_actions: [{ action: "launch", availability: "allowed", extra: "other" }],
    };
    const first = {
      port_id: "owned",
      readiness: { launchable: true },
      port_actions: [
        { action: "launch", availability: "allowed", extra: "first" },
        { action: "install", availability: "waiting", extra: "unrelated" },
      ],
    };
    const second = {
      port_id: "owned",
      readiness: { launchable: true },
      port_actions: [
        { action: "launch", availability: "allowed", extra: "second" },
        { action: "backup", availability: "allowed", extra: "second-only" },
      ],
    };
    let payload: unknown = { metadata: { retained: true }, statuses: [first, other, second] };
    const calls: { input: unknown; args: unknown[]; response: Response }[] = [];
    const original = async (input: unknown, ...args: unknown[]) => {
      const response = new Response(JSON.stringify(payload), { headers: { "x-retained": "yes" } });
      calls.push({ input, args, response });
      return response;
    };
    const window: {
      fetch: typeof original;
      __TAURI_INTERNALS__: { convertFileSrc: () => string; invoke: () => Promise<void> };
      __portcoveActionHoldProbe?: unknown;
      __portcoveReadinessProbe?: unknown;
    } = {
      fetch: original,
      __TAURI_INTERNALS__: { convertFileSrc: () => target, invoke: async () => {} },
    };
    const browser = {
      executeAsyncScript: async (callback: unknown, ...args: unknown[]): Promise<unknown> => {
        assert.ok(typeof callback === "function");
        return new Promise<unknown>((done, reject) => {
          try {
            runInNewContext(
              `(${callback.toString()})(...args, done)`,
              { window, args, done, Response, URL, Request, Error },
              { timeout: 1000 },
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    };
    const context = { browser, assert, object: record, port: { id: "owned" } };
    const installed: unknown = runInNewContext(
      kind === "action"
        ? `${actionFunctions} injectActionHold(browser, "owned", "launch")`
        : `(async () => { await browser${omission}; })()`,
      context,
    );
    await installed;
    const options = { method: "POST", headers: { "x-exact": "retained" } };
    for (const input of inputValues) {
      const fetched: unknown = runInNewContext("window.fetch(input, options)", {
        window,
        input,
        options,
      });
      const response = await fetched;
      assert.ok(response instanceof Response);
      assert.equal(response.headers.get("x-retained"), "yes");
      const value = record(await response.json());
      assert.equal(JSON.stringify(value.metadata), JSON.stringify({ retained: true }));
      assert.ok(Array.isArray(value.statuses));
      const statuses: unknown[] = value.statuses;
      assert.equal(JSON.stringify(statuses[1]), JSON.stringify(other));
      for (const [index, expected] of [
        [0, "first"],
        [2, "second"],
      ] as const) {
        const row = record(statuses[index]);
        if (kind === "readiness") {
          assert.equal(row.readiness, null);
          assert.equal(
            JSON.stringify(row.port_actions),
            JSON.stringify(index === 0 ? first.port_actions : second.port_actions),
          );
        } else {
          assert.ok(Array.isArray(row.port_actions));
          const actions: unknown[] = row.port_actions;
          assert.equal(record(actions[0]).availability, "held");
          assert.equal(record(actions[0]).extra, expected);
          assert.equal(
            JSON.stringify(actions[1]),
            JSON.stringify((index === 0 ? first : second).port_actions[1]),
          );
        }
      }
      const call = calls.at(-1);
      assert.ok(call);
      assert.equal(call.input, input);
      assert.equal(call.args[0], options);
    }
    for (const input of [null, undefined, false, 0, {}, "https://foreign.example/"]) {
      const fetched: unknown = runInNewContext("window.fetch(input, options)", {
        window,
        input,
        options,
      });
      const response = await fetched;
      assert.equal(
        response,
        calls.at(-1)?.response,
        "untargeted responses must be forwarded unchanged",
      );
    }
    for (const malformed of [null, [], { statuses: null }, { statuses: [null, {}] }]) {
      payload = malformed;
      const response = await window.fetch(target, options);
      assert.equal(
        response,
        calls.at(-1)?.response,
        "malformed unmatched snapshots must remain unchanged",
      );
    }
    if (kind === "action") {
      const restored: unknown = runInNewContext(
        `${actionFunctions} restoreActionHold(browser, "allowed")`,
        context,
      );
      await restored;
      assert.equal(window.__portcoveActionHoldProbe, undefined);
    } else {
      const restore = segment(
        "observations.probe = await executeBrowserScript(browser, () => {",
        '        assert.ok("restored"',
        source.indexOf("export async function readinessScenario("),
      );
      const observations: { probe?: unknown } = {};
      const restored: unknown = runInNewContext(`(async () => { ${restore} })()`, {
        ...context,
        observations,
        executeBrowserScript: (_browser: unknown, callback: unknown): unknown => {
          assert.ok(typeof callback === "function");
          return runInNewContext(`(${callback.toString()})()`, { window });
        },
      });
      await restored;
      assert.equal(record(observations.probe).restored, true);
      assert.equal(window.__portcoveReadinessProbe, undefined);
    }
    assert.equal(window.fetch, original);
  });
}
