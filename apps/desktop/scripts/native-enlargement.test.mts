import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  captureNativeEnlargement,
  requireNativeEnlargement,
  retainNativeEnlargement,
} from "./native-enlargement.mts";
import { Capabilities, Session, WebDriver } from "selenium-webdriver";
import type { Command } from "selenium-webdriver/lib/command.js";
import { runInNewContext } from "node:vm";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const observed = () => ({
  width: 240,
  height: 160,
  client: 240,
  scroll: 241,
  zoom: "400",
  dpr: 1,
  theme: "dark",
  userAgent: "synthetic viewport",
  focus: "Recovery",
});

test("synthetic viewport retention preserves complete observations, prefixes and write-once files", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-enlargement-"));
  try {
    for (const prefix of ["selected-setup", "source-removal"] as const) {
      const options = { output, prefix, stage: "review", baselineWidth: 960 };
      const file = await retainNativeEnlargement(observed(), window(), options);
      assert.equal(file, path.join(output, `${prefix}-400-review.json`));
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        width: 240,
        height: 160,
        client: 240,
        scroll: 241,
        zoom: "400",
        dpr: 1,
        theme: "dark",
        userAgent: "synthetic viewport",
        focus: "Recovery",
        nativeWindow: { x: 20, y: 30, width: 960, height: 640 },
        baselineWidth: 960,
      });
      const original = await readFile(file);
      await assert.rejects(
        retainNativeEnlargement({ ...observed(), theme: "light" }, window(), options),
        { code: "EEXIST" },
      );
      assert.deepEqual(await readFile(file), original);
    }
    await assert.rejects(
      retainNativeEnlargement({ ...observed(), scroll: 242 }, window(), {
        output,
        prefix: "source-removal",
        stage: "invalid",
        baselineWidth: 960,
      }),
      /Horizontal overflow at invalid/,
    );
    assert.equal((await readdir(output)).length, 2);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
const window = () => ({ x: 20, y: 30, width: 960, height: 640 });
test("native enlargement assertions retain the independently frozen boundaries", () => {
  assert.doesNotThrow(() => requireNativeEnlargement(observed(), window(), 960, "review"));
  assert.doesNotThrow(() =>
    requireNativeEnlargement({ ...observed(), width: 238 }, window(), 960, "review"),
  );
  for (const patch of [
    { width: 237 },
    { width: 241 },
    { scroll: 242 },
    { zoom: "200" },
    { zoom: null },
  ])
    assert.throws(() =>
      requireNativeEnlargement({ ...observed(), ...patch }, window(), 960, "review"),
    );
  for (const patch of [{ width: 959 }, { height: 639 }])
    assert.throws(() =>
      requireNativeEnlargement(observed(), { ...window(), ...patch }, 960, "review"),
    );
  assert.throws(
    () => requireNativeEnlargement(observed(), window(), 1000, "review"),
    /Native zoom ratio changed at review/,
  );
});

test("actual Selenium serialization observes the viewport without helper closure dependencies", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-enlargement-serialization-"));
  try {
    for (const prefix of ["selected-setup", "source-removal"] as const) {
      const calls: string[] = [];
      const driver = new WebDriver(new Session("viewport-fixture", new Capabilities()), {
        async execute(command: Command): Promise<unknown> {
          calls.push(command.getName());
          if (command.getName() === "getWindowRect") return window();
          assert.equal(command.getName(), "executeScript");
          const script: unknown = command.getParameter("script");
          const args: unknown = command.getParameter("args");
          assert.equal(typeof script, "string");
          assert.ok(Array.isArray(args));
          return runInNewContext(
            `(function(){${String(script)}}).apply(null, args)`,
            {
              args,
              innerWidth: 240,
              innerHeight: 160,
              devicePixelRatio: 1,
              document: {
                documentElement: {
                  clientWidth: 240,
                  scrollWidth: 241,
                  dataset: { theme: "dark" },
                },
                activeElement: { textContent: "  Recovery  " },
              },
              localStorage: {
                getItem(key: string) {
                  assert.equal(key, "portcove.appearance.interface-size");
                  return "400";
                },
              },
              navigator: { userAgent: "synthetic viewport" },
            },
            { timeout: 1000 },
          );
        },
      });
      const file = await captureNativeEnlargement(driver, {
        output,
        prefix,
        stage: "serialized",
        baselineWidth: 960,
      });
      assert.deepEqual(calls, ["executeScript", "getWindowRect"]);
      assert.equal(file, path.join(output, `${prefix}-400-serialized.json`));
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        ...observed(),
        nativeWindow: window(),
        baselineWidth: 960,
      });
    }
    assert.equal((await readdir(output)).length, 2);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
