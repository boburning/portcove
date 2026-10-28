import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-artwork-correction-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function segment(from: string, until: string) {
  const start = source.indexOf(from),
    end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function artworkRenderBehavior(subject: (context: unknown) => Promise<unknown>) {
  const color = [241, 7, 3, 255];
  let image: { complete: boolean; naturalWidth: number; src: string } | null = {
    complete: true,
    naturalWidth: 1,
    src: "owned://red.jpg",
  };
  let artworkSource = "igdb_cover";
  const draws: unknown[][] = [];
  const frame = {
    dataset: {
      get artworkSource() {
        return artworkSource;
      },
    },
    querySelector: () => image,
  };
  const document = {
    querySelector: () => frame,
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]) => draws.push(args),
        getImageData: () => ({ data: new Uint8ClampedArray(color) }),
      }),
    }),
  };
  const executeBrowserScript = (
    _browser: unknown,
    callback: unknown,
    ...args: unknown[]
  ): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      { document, args },
      { timeout: 1000 },
    );
  };
  const browser = {
    executeScript: (callback: unknown, ...args: unknown[]) =>
      executeBrowserScript(undefined, callback, ...args),
    wait: async (predicate: (() => unknown) | string) => {
      if (typeof predicate === "function") assert.equal(await predicate(), true);
      return { sendKeys: async () => {} };
    },
  };
  const observation = await subject({
    browser,
    source: "igdb_cover",
    click: async () => {},
    originalName: "Owned",
    portId: "owned",
  });
  assert.equal(
    JSON.stringify(observation),
    JSON.stringify({ source: "igdb_cover", image: "owned://red.jpg", pixel: color }),
  );
  assert.equal(draws.length, 1);
  assert.equal(draws[0]?.[0], image);
  image = null;
  artworkSource = "generated_fallback";
  const fallback = await subject({
    browser,
    source: "generated_fallback",
    click: async () => {},
    originalName: "Owned",
    portId: "owned",
  });
  assert.equal(
    JSON.stringify(fallback),
    JSON.stringify({ source: "generated_fallback", image: null, pixel: null }),
  );
}

void test("serialized artwork correction reads cached pixels and preserves fallback observations", () => {
  const entry = new URL("./desktop-artwork-correction-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      import {runInNewContext} from 'node:vm';
      mock.module('selenium-webdriver',{namedExports:{By:{xpath:()=>"nav",id:()=>"search",css:value=>value},Key:{CONTROL:"control",NULL:"null"},until:{elementLocated:()=>"located"}}});
      const {renderCorrectedArtwork}=await import(entry);
      await (${String(artworkRenderBehavior)})(renderCorrectedArtwork);
    `,
        variant === "original" ? undefined : { exportName: "renderCorrectedArtwork", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

void test("serialized stale catalog intent retains the reviewed identity and unregisters callbacks", async () => {
  const call = segment("await browser.executeAsyncScript", "reviewedPlan.source,");
  for (const outcome of ["success", "failure"] as const) {
    const calls: unknown[][] = [];
    const unregistered: number[] = [];
    const expectedSource = { kind: "file", value: "owned-stale-envelope.json" };
    const rejection = { code: "conflict", message: "catalog candidate or trust changed" };
    const window = {
      __TAURI_INTERNALS__: {
        transformCallback: () => 17,
        unregisterCallback: (id: number) => unregistered.push(id),
        invoke: (...args: unknown[]) => {
          calls.push(args);
          return outcome === "success"
            ? Promise.resolve({ retained: true })
            : Promise.reject(rejection);
        },
      },
    };
    const browser = {
      executeAsyncScript: (callback: unknown, ...args: unknown[]) =>
        new Promise<unknown>((done, reject) => {
          assert.ok(typeof callback === "function");
          try {
            runInNewContext(
              `(${callback.toString()})(...args, done)`,
              { window, args, done },
              { timeout: 1000 },
            );
          } catch (error) {
            reject(error);
          }
        }),
    };
    const serialized: unknown = await runInNewContext(
      `(async () => {return ${call} expectedSource, "reviewed-plan-hash");})()`,
      { browser, expectedSource },
    );
    assert.ok(typeof serialized === "string");
    const result: unknown = JSON.parse(serialized);
    assert.equal(object(result).ok, outcome === "success");
    if (outcome === "failure")
      assert.equal(JSON.stringify(object(result).error), JSON.stringify(rejection));
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.ok(args);
    assert.equal(args[0], "apply_catalog_update");
    const input = object(args[1]);
    assert.equal(input.source, expectedSource);
    assert.equal(input.expectedPlan, "reviewed-plan-hash");
    assert.equal(input.onEvent, "__CHANNEL__:17");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unregistered, [17]);
  }
});
