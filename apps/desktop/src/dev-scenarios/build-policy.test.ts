import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import type { PluginOption, Plugin } from "vite-plus";
import { expect, it } from "vite-plus/test";
import config, { assertScenarioExclusion } from "../../vite.config";
import stylelint from "stylelint";

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
    "/repo/test/capture-target.ts",
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
  async function collectPlugins(options: PluginOption): Promise<Plugin[]> {
    const value = await options;
    if (!value) return [];
    return Array.isArray(value) ? (await Promise.all(value.map(collectPlugins))).flat() : [value];
  }
  const plugins = await collectPlugins(config.plugins);
  const plugin = plugins.find((candidate) => candidate.name === "exclude-development-scenarios");
  if (!plugin) throw new Error("Production scenario exclusion plugin was not registered");
  expect(plugin.apply).toBe("build");
  const functionMatcher: unknown = expect.any(Function);
  expect(plugin.generateBundle).toMatchObject({ order: "post", handler: functionMatcher });
});

interface StylesheetObservation {
  atRules: { name: string; parameters: string; block: boolean; global: boolean }[];
  rules: { selectors: string[]; declarations: [string, string, boolean][] }[];
}

type StylesheetRoot = Parameters<ReturnType<stylelint.Rule>>[0];

// CSS comments outside strings do not affect these policy tokens. Preserve
// quoted paths, escaped quotes and comment-looking text inside strings.
function cssPolicyTokens(value: string) {
  let result = "",
    quote = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index] ?? "";
    if (character === "\\") {
      result += character + (value[++index] ?? "");
      continue;
    }
    if (quote) {
      result += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) throw new Error("CSS_CONTRACT closed comment");
      index = end + 1;
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

async function stylesheetObservation(
  code: string,
  transform?: (root: StylesheetRoot) => void,
): Promise<StylesheetObservation> {
  const observed: StylesheetObservation = { atRules: [], rules: [] };
  const capture = () => (root: StylesheetRoot) => {
    transform?.(root);
    root.walkAtRules((rule) => {
      observed.atRules.push({
        name: rule.name,
        parameters: cssPolicyTokens(rule.params),
        block: rule.nodes !== undefined,
        global: rule.parent?.type === "root",
      });
    });
    root.walkRules((rule) => {
      observed.rules.push({
        selectors: rule.selectors,
        declarations: rule.nodes.flatMap((node) =>
          node.type === "decl"
            ? [
                [node.prop.toLowerCase(), cssPolicyTokens(node.value), Boolean(node.important)] as [
                  string,
                  string,
                  boolean,
                ],
              ]
            : [],
        ),
      });
    });
  };
  const plugin = stylelint.createPlugin(
    "portcove/stylesheet-contract",
    Object.assign(capture, { ruleName: "portcove/stylesheet-contract", messages: {} }),
  );
  const result = await stylelint.lint({
    code,
    codeFilename: "contract.css",
    config: { plugins: [plugin], rules: { "portcove/stylesheet-contract": true } },
  });
  expect(result.errored, "CSS_CONTRACT valid stylesheet").toBe(false);
  return observed;
}

function resetContract(observed: StylesheetObservation) {
  const requiredLayers = ["theme", "base", "components", "utilities"];
  const order = new Set<string>();
  for (const rule of observed.atRules.filter((rule) => rule.name === "layer" && rule.global))
    for (const layer of rule.parameters.split(",").map((value) => value.trim()))
      if (requiredLayers.includes(layer)) order.add(layer);
  expect([...order], "CSS_CONTRACT explicit layer order").toEqual(requiredLayers);
  expect(
    observed.atRules.some(
      (rule) =>
        rule.name === "import" &&
        /^(["'])tailwindcss\1\s+source\(\s*none\s*\)$/u.test(rule.parameters.trim()),
    ),
    "CSS_CONTRACT explicit production discovery",
  ).toBe(true);
  expect(
    observed.atRules.some(
      (rule) =>
        rule.name === "source" && /^not\s+(["'])\.\.\/browser\1$/u.test(rule.parameters.trim()),
    ),
    "CSS_CONTRACT excluded browser fixtures",
  ).toBe(true);
  expect(
    observed.atRules.some(
      (rule) => rule.name === "import" && rule.parameters.includes("legacy.css"),
    ),
    "CSS_CONTRACT single reset",
  ).toBe(false);
}

function canvasContract(observed: StylesheetObservation) {
  const matching = observed.rules.filter((rule) =>
    rule.selectors.some(
      (selector) =>
        selector
          .replace(/\/\*[\s\S]*?\*\//gu, " ")
          .replace(/[>+~]/gu, " $& ")
          .trim()
          .split(/\s+/u)
          .at(-1) === "[data-development-scenario]",
    ),
  );
  const bySelector = new Map<string, Map<string, { value: string; important: boolean }>>();
  for (const rule of matching)
    for (const selector of rule.selectors) {
      const key = cssPolicyTokens(selector)
        .trim()
        .replace(/\s+/gu, " ")
        .replace(/\s*([>+~])\s*/gu, "$1");
      const declarations =
        bySelector.get(key) ?? new Map<string, { value: string; important: boolean }>();
      bySelector.set(key, declarations);
      for (const [property, value, important] of rule.declarations)
        if (!declarations.get(property)?.important || important)
          declarations.set(property, { value, important });
    }
  let complete = false,
    valid = true;
  for (const declarations of bySelector.values()) {
    const color = declarations.get("color"),
      background = declarations.get("background");
    valid &&=
      (!color || /^var\(\s*--color-text\s*\)$/u.test(color.value)) &&
      (!background || /^var\(\s*--color-bg\s*\)$/u.test(background.value));
    complete ||= Boolean(color && background);
  }
  expect(valid && complete, "CSS_CONTRACT semantic scenario canvas").toBe(true);
}

it("assembles one reset with explicit production discovery and layer order", async () => {
  const css = await readFile(new URL("../styles/index.css", import.meta.url), "utf8");
  resetContract(await stylesheetObservation(css));
  const equivalents = [
    "/* legacy.css is historical documentation */\n@layer theme,base,components,utilities;\n@import 'tailwindcss' source( none );\n@source not '../browser';",
    '@source not "../browser"; @layer theme, base, components, utilities; @import "tailwindcss" source(none);',
    '@layer theme, /*layer comment*/ base, components, utilities; @import "tailwindcss" /*import comment*/ source(none); @source not /*source comment*/ "../browser";',
  ];
  for (const harmless of equivalents) resetContract(await stylesheetObservation(harmless));
  const mutations: { oracle: string; transform: (root: StylesheetRoot) => void }[] = [
    {
      oracle: "explicit layer order",
      transform: (root) => {
        root.walkAtRules("layer", (rule) => {
          if (!rule.nodes) rule.params = "theme, components, base, utilities";
        });
      },
    },
    {
      oracle: "explicit production discovery",
      transform: (root) => {
        root.walkAtRules("import", (rule) => {
          if (/^(["'])tailwindcss\1(?:\s|$)/u.test(cssPolicyTokens(rule.params).trim()))
            rule.params = '"tailwindcss"';
        });
      },
    },
    {
      oracle: "excluded browser fixtures",
      transform: (root) => {
        root.walkAtRules("source", (rule) => {
          if (/^not\s+(["'])\.\.\/browser\1$/u.test(cssPolicyTokens(rule.params).trim()))
            rule.remove();
        });
      },
    },
    {
      oracle: "single reset",
      transform: (root) => {
        root.append('@import "./legacy.css";');
      },
    },
  ];
  mutations.push({
    oracle: "explicit layer order",
    transform: (root) => {
      root.prepend("@layer base, theme;");
    },
  });
  for (const legacy of ['url("./legacy.css")', "url(./legacy.css)"])
    mutations.push({
      oracle: "single reset",
      transform: (root) => {
        root.append("@import " + legacy + ";");
      },
    });
  for (const input of [css, ...equivalents])
    for (const mutation of mutations) {
      const changed = await stylesheetObservation(input, mutation.transform);
      expect(() => resetContract(changed)).toThrow("CSS_CONTRACT " + mutation.oracle);
    }
});

it("gives scenario themes their own semantic canvas", async () => {
  const css = await readFile(new URL("./scenarios.css", import.meta.url), "utf8");
  canvasContract(await stylesheetObservation(css));
  for (const harmless of [
    "[data-development-scenario] {background: var( --color-bg ); color: var( --color-text );}",
    ".scenario-preview>[data-development-scenario] {color:var(--color-text);background:var(--color-bg)}",
  ])
    canvasContract(await stylesheetObservation(harmless));
  for (const changed of [
    "[data-development-scenario] {color:var(--color-text)}",
    "[data-development-scenario] {background:var(--color-bg)}",
    "[data-development-scenario] {color:var(--color-text);background:var(--color-bg); color:red}",
    ".other {color:var(--color-text);background:var(--color-bg)}",
    "[data-development-scenario]{color:red !important;background:var(--color-bg);color:var(--color-text)}",
    "[data-development-scenario]{color:var(--color-text);background:var(--color-bg)} [data-development-scenario]{color:red}",
  ]) {
    const observed = await stylesheetObservation(changed);
    expect(() => canvasContract(observed)).toThrow("CSS_CONTRACT semantic scenario canvas");
  }
});
