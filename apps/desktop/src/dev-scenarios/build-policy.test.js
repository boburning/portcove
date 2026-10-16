import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { expect, it } from "vite-plus/test";
import config, { assertScenarioExclusion } from "../../vite.config";

it("rejects scenario modules and entrypoints from a production bundle", () => {
  expect(() =>
    assertScenarioExclusion(["/repo/src/App.tsx"], ["index.html", "assets/main.js"]),
  ).not.toThrow();
  for (const id of [
    "/repo/src/dev-scenarios/scenarios.tsx",
    "/repo/src/dev-scenarios/interactive/entry.tsx",
    "/repo/src/dev-scenarios/interactive/scenarios.ts",
    "/repo/src/dev-scenarios/interactive/transport.ts",
    "/repo/src/browser/interactive-app.browser.test.tsx",
    "C:\\repo\\src\\dev-scenarios\\entry.ts",
    "/repo/src/test-fixtures.ts",
    "/repo/src/test-fixtures.ts?raw",
    "/repo/src/browser/adoption.browser.test.tsx",
  ])
    expect(() => assertScenarioExclusion([id], ["index.html"])).toThrow("cannot ship");
  expect(() =>
    assertScenarioExclusion(
      ["/repo/src/design-compatibility/DesignCompatibilityFixture.tsx"],
      ["index.html"],
    ),
  ).toThrow("cannot ship");
  expect(() =>
    assertScenarioExclusion(
      ["/repo/src/design-compatibility/DesignCompatibilityFixture.tsx"],
      ["index.html"],
      true,
    ),
  ).not.toThrow();
  expect(() => assertScenarioExclusion([], ["scenarios.html"])).toThrow("cannot ship");
});

it("registers scenario exclusion on production builds", async () => {
  const plugins = (await Promise.all(config.plugins)).flat(Infinity);
  const plugin = plugins.find((candidate) => candidate.name === "exclude-development-scenarios");
  expect(plugin.apply).toBe("build");
  expect(plugin.generateBundle).toMatchObject({ order: "post", handler: expect.any(Function) });
});

it("assembles one reset with explicit production discovery and layer order", async () => {
  const css = await readFile(new URL("../styles/index.css", import.meta.url), "utf8");
  expect(css).toContain("@layer theme, base, components, utilities;");
  expect(css).toContain('@import "tailwindcss" source(none);');
  expect(css).toContain('@source not "../browser";');
  expect(css).not.toContain("legacy.css");
});

it("gives scenario themes their own semantic canvas", async () => {
  const css = await readFile(new URL("./scenarios.css", import.meta.url), "utf8");
  expect(css).toMatch(
    /\[data-development-scenario\]\s*\{[^}]*color:\s*var\(--color-text\);[^}]*background:\s*var\(--color-bg\);/s,
  );
});
