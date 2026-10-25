import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-install-test.mts", import.meta.url), "utf8"),
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
void test("serialized install refresh rejection, explicit retry and restoration preserve real IPC forwarding", async () => {
  const target = "http://ipc.localhost/get_workspace_snapshot";
  const calls: { input: unknown; args: unknown[]; response: Promise<Response> }[] = [];
  const original = (input: unknown, ...args: unknown[]) => {
    const response = Promise.resolve(new Response("native commit result"));
    calls.push({ input, args, response });
    return response;
  };
  const window = { fetch: original, __TAURI_INTERNALS__: { convertFileSrc: () => target } };
  let clicks = 0;
  const document = {
    querySelectorAll: () => [
      {
        textContent: "Retry refresh",
        click: () => {
          clicks++;
        },
      },
    ],
  };
  const execute = (callback: unknown, args: unknown[] = []): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, document, args, Response, URL, location: { href: "https://owned.example/" } },
      { timeout: 1000 },
    );
  };
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
  const executeBrowserScript = (_browser: unknown, callback: unknown) => execute(callback);
  const installation = segment(
    "const installedProbe = await browser.executeAsyncScript",
    "assert.equal(object(installedProbe)",
  );
  const installed: unknown = await runInNewContext(
    `(async () => {${installation} return installedProbe;})()`,
    { browser },
  );
  assert.equal(object(installed).installed, true);
  const inputs: unknown[] = [
    target,
    new URL(target),
    new Request(target),
    runInNewContext("({toString() {return target;}})", { target }),
    { url: target },
    { url: null, toString: () => target },
    { url: undefined, toString: () => target },
  ];
  const options = { method: "POST", headers: { "x-exact": "retained" } };
  for (const input of inputs) {
    const response = await window.fetch(input, options);
    assert.equal(response.headers.get("Tauri-Response"), "error");
    const payload = object(await response.json());
    assert.equal(payload.code, "state");
    assert.equal(payload.message, "synthetic-post-install-refresh-failure");
  }
  assert.equal(calls.length, 0);
  const retry = segment(
    "await executeBrowserScript(browser, () => {",
    "        true,",
    source.indexOf("const retryButton") - 250,
  );
  const retried: unknown = await runInNewContext(
    `(async () => {return ${retry.trim().replace(/,$/u, "")};})()`,
    { browser, executeBrowserScript },
  );
  assert.equal(retried, true);
  assert.equal(clicks, 1);
  for (const input of inputs) {
    const response = window.fetch(input, options);
    const call = calls.at(-1);
    assert.ok(call);
    assert.equal(call.input, input);
    assert.deepEqual(call.args, [options]);
    assert.equal(response, call.response);
    assert.equal(await (await response).text(), "native commit result");
  }
  const restore = segment(
    "await executeBrowserScript(browser, () => {",
    "        assert.ok(observations.probe.installed)",
    source.indexOf("observations.probe ="),
  );
  const restored: unknown = await runInNewContext(`(async () => {return ${restore};})()`, {
    browser,
    executeBrowserScript,
  });
  const probe = object(restored);
  assert.equal(probe.installed, true);
  assert.equal(probe.restored, true);
  assert.equal(probe.failing, false);
  assert.equal(probe.injected, inputs.length);
  assert.ok(Array.isArray(probe.commands));
  assert.equal(probe.commands.length, inputs.length * 2);
  assert.ok(probe.commands.every((command: unknown) => command === "get_workspace_snapshot"));
  assert.equal(window.fetch, original);
  assert.equal(Object.hasOwn(window, "__portcoveInstallRefreshProbe"), false);
});
