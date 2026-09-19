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
  expect(() => assertScenarioExclusion([], ["scenarios.html"])).toThrow("cannot ship");
});

it("registers scenario exclusion on production builds", () => {
  const plugin = config.plugins.find(
    (candidate) => candidate.name === "exclude-development-scenarios",
  );
  expect(plugin.apply).toBe("build");
  expect(typeof plugin.generateBundle).toBe("function");
});
