import { execFileSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import { describe, expect, it } from "vite-plus/test";

describe("Vite configuration boundaries", () => {
  it("omits lazy plugins during metadata resolution and checks production module paths", async () => {
    const moduleUrl = new URL("../vite.config.ts", import.meta.url).href;
    // The test runner already resolved its own config before this worker. A
    // fresh process exercises metadata resolution without that module cache.
    const metadataPlugins = JSON.parse(
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
    expect(
      metadataPlugins.some(
        (name) => name.startsWith("vite:react") || name.startsWith("@tailwindcss/"),
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
    ])
      expect(() => assertScenarioExclusion([module], [])).toThrow("cannot ship");
    expect(() => assertScenarioExclusion([], ["scenarios.html"])).toThrow("cannot ship");
  });
});
