import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import { describe, expect, it } from "vite-plus/test";

describe("Vite configuration boundaries", () => {
  it("loads production metadata without browser runtime or trace initialization", () => {
    const moduleUrl = new URL("../vite.config.ts", import.meta.url).href;
    const result: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `delete process.env.PLAYWRIGHT_BROWSERS_PATH; const {default: config} = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({test: !!config.test, browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, paths: config.resolve.tsconfigPaths}));`,
        ],
        { env: { ...process.env, VP_RESOLVING_CONFIG_METADATA: "1" }, encoding: "utf8" },
      ),
    );
    expect(result).toEqual({ test: false, browserPath: null, paths: true });
  });
  it("omits lazy plugins during metadata resolution and checks production module paths", async () => {
    const moduleUrl = new URL("../vite.config.ts", import.meta.url).href;
    // The test runner already resolved its own config before this worker. A
    // fresh process exercises metadata resolution without that module cache.
    const rawMetadata: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const {default: config}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify((await Promise.all(config.plugins)).flat(Infinity).filter(Boolean).map(plugin=>plugin.name)));`,
        ],
        { env: { ...process.env, VP_RESOLVING_CONFIG_METADATA: "1" }, encoding: "utf8" },
      ),
    );
    assert.ok(Array.isArray(rawMetadata));
    const values: unknown[] = rawMetadata;
    const metadataPlugins = values.map((name) => {
      assert.ok(typeof name === "string");
      return name;
    });
    expect(
      metadataPlugins.some(
        (name: string) => name.startsWith("vite:react") || name.startsWith("@tailwindcss/"),
      ),
    ).toBe(false);
    const { assertScenarioExclusion } = await import("../vite.config.ts");
    expect(() =>
      assertScenarioExclusion(
        [
          "/checkout/src/App.tsx?query=dev-scenarios",
          "/checkout/src/App.tsx?query\n/src/browser/fixture.tsx",
          "",
        ],
        ["assets/main.js"],
      ),
    ).not.toThrow();
    for (const module of [
      "E:\\checkout\\src\\browser\\fixture.tsx?raw",
      "/checkout/src/dev-scenarios/fixture.tsx?raw",
      "/checkout/src/test-fixtures.ts?raw",
      "/checkout/test/capture-target.ts?raw",
      "/checkout/src/components/control.browser.test.tsx?raw",
      "/checkout/src/domain.test.ts",
    ])
      expect(() => assertScenarioExclusion([module], [])).toThrow("cannot ship");
    expect(() => assertScenarioExclusion([], ["scenarios.html"])).toThrow("cannot ship");
  });
});
