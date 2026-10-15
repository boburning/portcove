import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "vite";

import { expect, it } from "vite-plus/test";
import config from "../vite.config.ts";
import { frontendEnvironment, buildFrontend } from "./build-frontend.mjs";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mjs";

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
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";

it.each([false, true])(
  "build entrypoints strip signing inputs before the toolchain (cached=%s)",
  async (cached) => {
    const nativeConfig = JSON.parse(
      await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    expect(nativeConfig.build.beforeBuildCommand).toBe("node scripts/build-frontend.mjs");
    const rootPackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const appPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(rootPackage.scripts.build).toBe("node apps/desktop/scripts/build-frontend.mjs");
    expect(appPackage.scripts.build).toBe("node scripts/build-frontend.mjs");
    expect(rootPackage.scripts["build:cached"]).toBe(`${rootPackage.scripts.build} --cached`);
    expect(appPackage.scripts["build:cached"]).toBe(`${appPackage.scripts.build} --cached`);
    const fixture = await mkdtemp(new URL("../../../work/frontend-child-", import.meta.url));
    const child = path.join(fixture, "observe.mjs");
    const marker = path.join(fixture, "observed.json");
    try {
      await writeFile(
        child,
        `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},JSON.stringify({signing:process.env.TAURI_SIGNING_PRIVATE_KEY??null,native:process.env.TAURI_ENV_PLATFORM,args:process.argv.slice(2)}));`,
      );
      let childResult;
      const status = buildFrontend(
        {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY: "fake-only-child-key",
          TAURI_ENV_PLATFORM: "windows",
        },
        (command, args, options) => {
          expect(command).toBe(process.execPath);
          childResult = spawnSync(process.execPath, [child, ...args], {
            ...options,
            stdio: "pipe",
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
          });
          return childResult;
        },
        cached,
      );
      const result = childResult;
      expect(status).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        signing: null,
        native: "windows",
        args: [
          ...vitePlusCommand(fileURLToPath(new URL("../", import.meta.url))).args,
          ...(cached ? ["run", "bundle:cached"] : ["build"]),
        ],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
