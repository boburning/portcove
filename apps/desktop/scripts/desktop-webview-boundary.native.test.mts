import {
  parseBoundaryReply,
  invokeBoundary,
  armBoundaryOwner,
} from "./desktop-boundary-invoke.mts";
import type { WebDriver } from "selenium-webdriver";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isRecord } from "../../../scripts/runtime-values.mts";

void test("erased boundary reply parser checks every declared optional scalar", () => {
  const parse = parseBoundaryReply;
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
    const switched: string[] = [];
    const browser = {
      switchTo: () => ({
        window: async (label: string) => {
          switched.push(label);
        },
      }),
      executeScript: async (script: unknown, ...values: unknown[]) => {
        assert.ok(typeof script === "function");
        assert.deepEqual(switched, ["boundary-secondary"]);
        const result: unknown = runInNewContext(
          `(${script.toString()})(...values)`,
          { window: host, Headers, URL, values },
          { timeout: 1000 },
        );
        return result;
      },
    } as unknown as WebDriver;
    assert.equal(await armBoundaryOwner(browser), 7);
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

void test(
  "actual boundary invocation serializes native arguments and parses the returned reply",
  { timeout: 10_000 },
  async () => {
    for (const outcome of ["success", "failure", "unavailable"] as const) {
      const calls: unknown[][] = [];
      const payload = { retained: true };
      const args = { selected: "owned" };
      const options = { marker: "unchanged" };
      const native =
        outcome === "unavailable"
          ? undefined
          : {
              invoke(...values: unknown[]) {
                calls.push(values);
                return outcome === "success"
                  ? Promise.resolve(payload)
                  : Promise.reject("owned refusal");
              },
            };
      const browser = {
        executeAsyncScript(callback: unknown, ...values: unknown[]) {
          assert.ok(typeof callback === "function");
          // Execute the actual serialized browser callback; host orchestration is imported.
          return new Promise((done) => {
            runInNewContext(
              `(${callback.toString()})(...values, done)`,
              { window: { __TAURI_INTERNALS__: native }, values, done },
              { timeout: 1000 },
            );
          });
        },
      } as unknown as WebDriver;
      const result = await invokeBoundary(browser, "owned-command", args, options);
      if (outcome === "unavailable") {
        assert.deepEqual(result, { unavailable: true });
        assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(calls, [["owned-command", args, options]]);
        assert.deepEqual(
          result,
          outcome === "success"
            ? { ok: true, value: payload }
            : { ok: false, error: "owned refusal" },
        );
      }
    }
    const malformed = {
      executeAsyncScript: () => Promise.resolve({ ok: 17 }),
    } as unknown as WebDriver;
    await assert.rejects(invokeBoundary(malformed, "owned-command"));
  },
);

void test("native boundary entrypoint retains its imported parsed invocation route", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-webview-boundary.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  // Normative wiring only; imported-module and serialized-callback tests own behavior.
  function assertRoute(code: string) {
    const imports = [
      ...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/desktop-boundary-invoke\.mts["']/gu),
    ];
    const bindings = imports.flatMap((entry) => entry[1]!.split(","));
    const imported = bindings
      .map((entry) => /^\s*invokeBoundary(?:\s+as\s+(\w+))?\s*$/u.exec(entry))
      .find(Boolean);
    assert.ok(imported, "Native entrypoint must import the parsed invocation transport");
    const alias = imported[1] ?? "invokeBoundary";
    const call = new RegExp(
      String.raw`await\s+${alias}\s*\(\s*[\w$.]+\s*,\s*["']create_boundary_windows["']\s*\)`,
      "u",
    );
    assert.ok(
      call.test(code),
      "Native boundary fixture creation must use the imported parsed transport",
    );
  }
  assertRoute(source);
  assertRoute(
    source.replace("as invoke", "as renamedInvoke").replace(/\binvoke(?=\s*\()/gu, "renamedInvoke"),
  );
  assert.throws(
    () => assertRoute(source.replace("./desktop-boundary-invoke.mts", "./wrong-transport.mts")),
    /must import/u,
  );
  assert.throws(
    () =>
      assertRoute(
        source.replace(
          'await invoke(browser, "create_boundary_windows")',
          'await wrongTransport(browser, "create_boundary_windows")',
        ),
      ),
    /must use/u,
  );
});
