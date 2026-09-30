import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { URL } from "node:url";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "vite";

import { expect, it } from "vitest";
import config from "../vite.config.ts";
import { frontendEnvironment } from "./build-frontend.mjs";

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
  const fixture = await mkdtemp(new URL("../../../work/env-probe-", import.meta.url));
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
