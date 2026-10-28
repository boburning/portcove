import {
  parseBoundaryReply,
  invokeBoundary,
  armBoundaryOwner,
} from "./desktop-boundary-invoke.mts";
import type { WebDriver } from "selenium-webdriver";
import assert from "node:assert/strict";
import test from "node:test";
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
