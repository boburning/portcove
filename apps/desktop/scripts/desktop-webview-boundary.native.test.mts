import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isRecord } from "../../../scripts/runtime-values.mts";

void test("erased boundary reply parser checks every declared optional scalar", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-webview-boundary.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const start = source.indexOf("function reply(");
  const end = source.indexOf("function failureText(", start);
  assert.ok(start >= 0 && end > start);
  const parse = (value: unknown): unknown =>
    runInNewContext(
      `${source.slice(start, end)} reply(value);`,
      { assert, value },
      { timeout: 1000 },
    );
  for (const value of [
    { unavailable: true, ok: 42 },
    { unavailable: true, error: {} },
    { ok: true, error: {} },
    { ok: true, unavailable: 42 },
    { ok: false, error: null },
  ]) {
    assert.throws(() => parse(value));
  }
  for (const value of [
    { unavailable: true },
    { ok: true, value: { retained: true }, metadata: 42 },
    { ok: false, error: "refused" },
  ]) {
    assert.equal(JSON.stringify(parse(value)), JSON.stringify(value));
  }
});

void test("erased boundary owner hook preserves real fetch arguments and releases queued replies", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-webview-boundary.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const call = source.indexOf(
    "return executeBrowserScript(browser,",
    source.indexOf("const armOwner"),
  );
  const start = source.indexOf("() => {", call);
  const end = source.indexOf("\n    });", start) + "\n    }".length;
  assert.ok(call >= 0 && start > call && end > start);
  for (const kind of ["string", "URL", "Request"] as const) {
    const url = "https://ipc.localhost/queue";
    const input = kind === "string" ? url : kind === "URL" ? new URL(url) : new Request(url);
    const calls: { input: RequestInfo | URL; options?: RequestInit | undefined }[] = [];
    const delivery: { callback?: (value: unknown) => void } = {};
    const original: typeof fetch = async (input, options) => {
      calls.push({ input, options });
      return new Response("owned native fetch");
    };
    const host = {
      fetch: original,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => {
          delivery.callback = callback;
          return 7;
        },
      },
    };
    assert.equal(
      runInNewContext(
        `(${source.slice(start, end)})()`,
        { window: host, Headers, URL },
        { timeout: 1000 },
      ),
      7,
    );
    const options = { headers: { "Tauri-Channel-Id": "12" } };
    const queued = host.fetch(input, options);
    assert.equal(calls.length, 0);
    const held: unknown = Reflect.get(host, "__boundaryHeld");
    assert.ok(isRecord(held));
    assert.equal(held.id, "12");
    assert.equal(held.input, url);
    assert.equal(
      await (
        await host.fetch("https://ipc.localhost/foreign", { headers: { "Tauri-Channel-Id": "13" } })
      ).text(),
      "owned native fetch",
    );
    assert.equal(calls.length, 1, "A held owner request must not intercept another channel");
    const release: unknown = Reflect.get(host, "__boundaryRelease");
    assert.ok(typeof release === "function");
    Reflect.apply(release, undefined, []);
    assert.equal(await (await queued).text(), "owned native fetch");
    assert.equal(calls.at(-1)?.input, input);
    assert.equal(calls.at(-1)?.options, options);
    assert.equal(host.fetch, original);
    assert.ok(delivery.callback);
    delivery.callback({ message: "PORTCOVE_SYNTHETIC_QUEUE:owned" });
    assert.equal(Reflect.get(host, "__boundaryDelivery"), "PORTCOVE_SYNTHETIC_QUEUE:owned");
  }
});
