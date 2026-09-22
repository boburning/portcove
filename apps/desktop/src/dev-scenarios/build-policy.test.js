import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { expect, it } from "vitest";
import config, { assertScenarioExclusion } from "../../vite.config";

it("rejects scenario modules and entrypoints from a production bundle", () => {
  expect(() =>
    assertScenarioExclusion(["/repo/src/App.tsx"], ["index.html", "assets/main.js"]),
  ).not.toThrow();
  for (const id of [
    "/repo/src/dev-scenarios/scenarios.tsx",
    "C:\\repo\\src\\dev-scenarios\\entry.ts",
    "/repo/src/test-fixtures.ts",
    "/repo/src/test-fixtures.ts?raw",
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

it("registers scenario exclusion on production builds", () => {
  const plugin = config.plugins.find(
    (candidate) => candidate.name === "exclude-development-scenarios",
  );
  expect(plugin.apply).toBe("build");
  expect(typeof plugin.generateBundle).toBe("function");
});

it("keeps Tailwind Preflight out of ordinary legacy screens", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  expect(css).toContain('@import "tailwindcss/theme.css" layer(theme);');
  expect(css).toContain('@import "tailwindcss/utilities.css" layer(utilities);');
  expect(css).not.toMatch(/@import\s+["']tailwindcss["']/);
  expect(css).not.toContain("tailwindcss/preflight.css");
});

it("gives scenario themes their own semantic canvas", async () => {
  const css = await readFile(new URL("./scenarios.css", import.meta.url), "utf8");
  expect(css).toMatch(
    /\[data-development-scenario\]\s*\{[^}]*color:\s*var\(--color-text\);[^}]*background:\s*var\(--color-bg\);/s,
  );
});
