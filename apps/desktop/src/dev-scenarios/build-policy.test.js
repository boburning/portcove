import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "vite";

import { expect, it } from "vitest";
import config, { assertScenarioExclusion } from "../../vite.config";
import { frontendEnvironment } from "../../scripts/build-frontend.mjs";

it("removes signing inputs before frontend children while preserving native inputs", () => {
  const environment = {
    TAURI_SIGNING_PRIVATE_KEY: "fake-key",
    tauri_signing_private_key_password: "fake-password",
    TAURI_ENV_PLATFORM: "windows",
    VITE_PUBLIC_LABEL: "public",
    PATH: "tools",
  };
  expect(frontendEnvironment(environment)).toEqual({
    TAURI_ENV_PLATFORM: "windows",
    VITE_PUBLIC_LABEL: "public",
    PATH: "tools",
  });
  expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBe("fake-key");
});

it("excludes signing sentinels from direct and whole-object frontend access and maps", async () => {
  const names = [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "VITE_PUBLIC_LABEL",
  ];
  const previous = names.map((name) => process.env[name]);
  const fixture = await mkdtemp(new URL("../../../../work/env-probe-", import.meta.url));
  const entry = `${fixture}/entry.js`;
  const sentinels = ["fake-only-key-1279", "fake-only-password-1279"];
  try {
    process.env[names[0]] = sentinels[0];
    process.env[names[1]] = sentinels[1];
    process.env[names[2]] = "public-1279";
    await writeFile(
      entry,
      "globalThis.probe = { direct: import.meta.env.TAURI_SIGNING_PRIVATE_KEY, password: import.meta.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, all: import.meta.env };",
    );
    const result = await build({
      ...config,
      configFile: false,
      logLevel: "silent",
      build: {
        ...config.build,
        write: false,
        lib: { entry, formats: ["iife"], name: "EnvironmentProbe" },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const context = {};
    for (const output of outputs) {
      const contents = output.type === "chunk" ? output.code : String(output.source);
      for (const sentinel of sentinels) expect(contents).not.toContain(sentinel);
      if (output.type === "chunk") runInNewContext(output.code, context);
    }
    expect(outputs.some((output) => output.fileName.endsWith(".map"))).toBe(true);
    expect(context.probe.direct).toBeUndefined();
    expect(context.probe.password).toBeUndefined();
    expect(context.probe.all.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(context.probe.all.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
    expect(context.probe.all.VITE_PUBLIC_LABEL).toBe("public-1279");
  } finally {
    await rm(fixture, { recursive: true, force: true });
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
});

it("rejects scenario modules and entrypoints from a production bundle", () => {
  expect(() =>
    assertScenarioExclusion(["/repo/src/App.tsx"], ["index.html", "assets/main.js"]),
  ).not.toThrow();
  for (const id of [
    "/repo/src/dev-scenarios/scenarios.tsx",
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
